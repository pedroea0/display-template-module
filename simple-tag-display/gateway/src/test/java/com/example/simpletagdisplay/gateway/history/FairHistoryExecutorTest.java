package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** FairHistoryExecutor fairness, atomic admission, per-session caps, cancellation. */
class FairHistoryExecutorTest {

    private static final UUID A = UUID.fromString("00000000-0000-0000-0000-00000000000a");
    private static final UUID B = UUID.fromString("00000000-0000-0000-0000-00000000000b");

    private final List<FairHistoryExecutor> created = new ArrayList<>();

    private FairHistoryExecutor executor(int threads, int maxQueued) {
        FairHistoryExecutor e = new FairHistoryExecutor(threads, maxQueued, 0, r -> {
            Thread t = new Thread(r, "test-history");
            t.setDaemon(true);
            return t;
        });
        created.add(e);
        return e;
    }

    @AfterEach
    void closeAll() {
        created.forEach(FairHistoryExecutor::close);
    }

    private static Callable<String> recording(List<String> order, String name, CountDownLatch gate) {
        return () -> {
            order.add(name);
            if (gate != null) {
                gate.await(5, TimeUnit.SECONDS);
            }
            return name;
        };
    }

    @Test
    void newcomerIsServedBeforeTheBusySessionsNextTask() throws Exception {
        FairHistoryExecutor e = executor(1, 100);
        List<String> order = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch gate = new CountDownLatch(1);
        List<Callable<String>> a = new ArrayList<>();
        a.add(recording(order, "a1", gate));
        for (int i = 2; i <= 5; i++) {
            a.add(recording(order, "a" + i, null));
        }
        List<Future<String>> fa = e.submitAll(A, a).orElseThrow();
        waitUntil(() -> order.size() == 1);
        List<Future<String>> fb = e.submitAll(B, List.of(recording(order, "b1", null))).orElseThrow();
        gate.countDown();
        for (Future<String> f : fa) {
            f.get(5, TimeUnit.SECONDS);
        }
        fb.get(0).get(5, TimeUnit.SECONDS);
        assertEquals(List.of("a1", "b1", "a2", "a3", "a4", "a5"), order);
    }

    @Test
    void roundRobinBetweenBusySessions() throws Exception {
        FairHistoryExecutor e = executor(1, 100);
        List<String> order = Collections.synchronizedList(new ArrayList<>());
        CountDownLatch gate = new CountDownLatch(1);
        UUID blocker = UUID.randomUUID();
        Future<String> block = e.submitAll(blocker, List.of(recording(order, "x", gate))).orElseThrow().get(0);
        waitUntil(() -> order.size() == 1);
        List<Callable<String>> a = new ArrayList<>();
        List<Callable<String>> b = new ArrayList<>();
        for (int i = 1; i <= 3; i++) {
            a.add(recording(order, "a" + i, null));
            b.add(recording(order, "b" + i, null));
        }
        List<Future<String>> fa = e.submitAll(A, a).orElseThrow();
        List<Future<String>> fb = e.submitAll(B, b).orElseThrow();
        gate.countDown();
        block.get(5, TimeUnit.SECONDS);
        for (int i = 0; i < 3; i++) {
            fa.get(i).get(5, TimeUnit.SECONDS);
            fb.get(i).get(5, TimeUnit.SECONDS);
        }
        assertEquals(List.of("x", "a1", "b1", "a2", "b2", "a3", "b3"), order);
    }

    @Test
    void perSessionRunningCapLeavesThreadsForOthers() throws Exception {
        FairHistoryExecutor e = executor(4, 100);            // max running per session = 2
        AtomicInteger runningA = new AtomicInteger();
        AtomicInteger maxA = new AtomicInteger();
        CountDownLatch gate = new CountDownLatch(1);
        List<Callable<Integer>> a = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            a.add(() -> {
                int n = runningA.incrementAndGet();
                maxA.accumulateAndGet(n, Math::max);
                gate.await(5, TimeUnit.SECONDS);
                runningA.decrementAndGet();
                return 0;
            });
        }
        List<Future<Integer>> fa = e.submitAll(A, a).orElseThrow();
        waitUntil(() -> e.active() == 2);
        Thread.sleep(50);
        assertEquals(2, e.active(), "session A never holds more than half the threads");
        // B still gets a thread at once.
        CountDownLatch bRan = new CountDownLatch(1);
        e.submitAll(B, List.<Callable<Integer>>of(() -> {
            bRan.countDown();
            return 1;
        })).orElseThrow();
        assertTrue(bRan.await(2, TimeUnit.SECONDS));
        gate.countDown();
        for (Future<Integer> f : fa) {
            f.get(5, TimeUnit.SECONDS);
        }
        assertEquals(2, maxA.get());
        waitUntil(() -> e.active() == 0 && e.queued() == 0);
    }

    @Test
    void admissionIsAtomicAndIdleSessionsAreNeverRefused() throws Exception {
        FairHistoryExecutor e = executor(1, 4);
        CountDownLatch gate = new CountDownLatch(1);
        List<Callable<Integer>> big = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            big.add(() -> {
                gate.await(5, TimeUnit.SECONDS);
                return 0;
            });
        }
        // An idle session's request is admitted whatever its size (deviation, see the class comment).
        Optional<List<Future<Integer>>> first = e.submitAll(A, big);
        assertTrue(first.isPresent());
        assertEquals(10, e.queuedAndRunning(A));
        // A busy session over its cap: refused, and nothing of the refused request was queued.
        assertFalse(e.submitAll(A, List.<Callable<Integer>>of(() -> 1)).isPresent());
        assertEquals(10, e.queuedAndRunning(A));
        // Another session is unaffected.
        assertTrue(e.submitAll(B, List.<Callable<Integer>>of(() -> 1, () -> 2)).isPresent());
        gate.countDown();
        for (Future<Integer> f : first.get()) {
            f.get(5, TimeUnit.SECONDS);
        }
        waitUntil(() -> e.queuedAndRunning(A) == 0 && e.queuedAndRunning(B) == 0);
        assertTrue(e.submitAll(A, List.<Callable<Integer>>of(() -> 1, () -> 2, () -> 3)).isPresent());
    }

    @Test
    void cancelUnstartedDequeuesWithoutTouchingRunningTasks() throws Exception {
        FairHistoryExecutor e = executor(1, 100);
        CountDownLatch started = new CountDownLatch(1);
        CountDownLatch gate = new CountDownLatch(1);
        AtomicInteger ran = new AtomicInteger();
        List<Callable<Integer>> tasks = new ArrayList<>();
        tasks.add(() -> {
            started.countDown();
            gate.await(5, TimeUnit.SECONDS);
            ran.incrementAndGet();
            return 0;
        });
        for (int i = 0; i < 5; i++) {
            tasks.add(() -> ran.incrementAndGet());
        }
        List<Future<Integer>> fs = e.submitAll(A, tasks).orElseThrow();
        assertTrue(started.await(2, TimeUnit.SECONDS));
        assertEquals(5, e.cancelUnstarted(fs), "only the 5 queued ones");
        assertEquals(1, e.queuedAndRunning(A), "the running one still counts against its session");
        assertFalse(fs.get(0).isCancelled());
        gate.countDown();
        assertEquals(0, fs.get(0).get(5, TimeUnit.SECONDS));
        waitUntil(() -> e.active() == 0);
        Thread.sleep(50);
        assertEquals(1, ran.get(), "cancelled tasks never ran");
        assertTrue(fs.get(3).isCancelled());
        assertEquals(0, e.queuedAndRunning(A));
    }

    @Test
    void resizeAndShutdown() throws Exception {
        FairHistoryExecutor e = executor(1, 100);
        CountDownLatch gate = new CountDownLatch(1);
        AtomicInteger concurrent = new AtomicInteger();
        AtomicInteger peak = new AtomicInteger();
        List<Callable<Integer>> tasks = new ArrayList<>();
        for (int i = 0; i < 4; i++) {
            tasks.add(() -> {
                peak.accumulateAndGet(concurrent.incrementAndGet(), Math::max);
                gate.await(5, TimeUnit.SECONDS);
                concurrent.decrementAndGet();
                return 0;
            });
        }
        e.configure(4, 100, 4);                                // more threads, no per-session limit below 4
        List<Future<Integer>> fs = e.submitAll(A, tasks).orElseThrow();
        waitUntil(() -> e.active() == 4);
        gate.countDown();
        for (Future<Integer> f : fs) {
            f.get(5, TimeUnit.SECONDS);
        }
        assertEquals(4, peak.get());
        e.resize(1);
        waitUntil(() -> e.workers() <= 1);
        assertTrue(e.shutdown());
        assertFalse(e.submitAll(A, List.<Callable<Integer>>of(() -> 1)).isPresent(), "closed executor refuses");
    }

    @Test
    void defaultRunningCapIsHalfTheThreads() {
        assertEquals(1, FairHistoryExecutor.defaultMaxRunning(1));
        assertEquals(1, FairHistoryExecutor.defaultMaxRunning(2));
        assertEquals(2, FairHistoryExecutor.defaultMaxRunning(3));
        assertEquals(2, FairHistoryExecutor.defaultMaxRunning(4));
        assertEquals(16, FairHistoryExecutor.defaultMaxRunning(32));
    }

    private static void waitUntil(java.util.function.BooleanSupplier c) throws InterruptedException {
        long end = System.currentTimeMillis() + 5_000;
        while (!c.getAsBoolean()) {
            if (System.currentTimeMillis() > end) {
                throw new AssertionError("condition not met within 5 s");
            }
            Thread.sleep(5);
        }
    }
}
