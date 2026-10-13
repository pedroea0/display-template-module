package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * A request that starves (a growth of its point reservation did not fit) answers
 * 503 BUSY, so it stops issuing historian queries at once — its query tasks that have not started are cancelled when
 * it starves, not when the deadline passes. Started queries still finish (their rows still teach the density).
 */
class HistoryStarveTest {

    private final GatewayServices services;
    private final HistoryService history;

    HistoryStarveTest() {
        Map<String, String> p = new HashMap<>();
        p.put("ctg.history.threads", "2");
        services = new GatewayServices(null, null, new ModuleSettings(p::get));
        history = services.history();
    }

    @AfterEach
    void close() {
        services.close();
    }

    @Test
    void theHookRunsOnceOutsideTheMonitorAndAtOnceWhenAlreadyStarved() {
        ResponseBudget resp = new ResponseBudget(1_000L);
        resp.bindGrowth((need, preferred) -> -1L, 0L);       // nothing may be reserved beyond the admission
        AtomicInteger runs = new AtomicInteger();
        AtomicBoolean heldLock = new AtomicBoolean();
        resp.onStarve(() -> {
            runs.incrementAndGet();
            heldLock.set(Thread.holdsLock(resp));
        });
        PenSeriesWriter.PenBudget pen = resp.pen(1_000L, 0);
        assertFalse(pen.take(), "the first row does not fit: starved");
        assertTrue(resp.starved());
        assertFalse(pen.take());
        assertEquals(1, runs.get(), "once");
        assertFalse(heldLock.get(), "outside the ResponseBudget monitor (it takes the executor lock)");
        resp.onStarve(runs::incrementAndGet);
        assertEquals(1, runs.get(), "fired already: a later hook does not run again");

        ResponseBudget late = new ResponseBudget(1_000L);
        late.bindGrowth((need, preferred) -> -1L, 0L);
        late.pen(1_000L, 0).take();                          // starves before any hook is registered
        AtomicInteger lateRuns = new AtomicInteger();
        late.onStarve(lateRuns::incrementAndGet);
        assertEquals(1, lateRuns.get(), "registered after the starvation: runs at once");
    }

    @Test
    void aStarvedRequestCancelsItsQueriesThatHaveNotStarted() throws Exception {
        Field ef = HistoryService.class.getDeclaredField("executor");
        ef.setAccessible(true);
        FairHistoryExecutor executor = (FairHistoryExecutor) ef.get(history);
        Field hook = ResponseBudget.class.getDeclaredField("onStarve");
        hook.setAccessible(true);

        ResponseBudget resp = new ResponseBudget(1_000_000L);
        resp.bindGrowth((need, preferred) -> -1L, 10L);     // 10 points reserved; the 11th starves the request
        PenSeriesWriter.PenBudget pen = resp.pen(1_000_000L, 0);
        CountDownLatch release = new CountDownLatch(1);
        AtomicInteger laterRan = new AtomicInteger();
        List<Callable<Object>> tasks = new ArrayList<>();
        // task 0: the query whose rows starve the request (once awaitAll is waiting, i.e. the hook is registered)
        tasks.add(() -> {
            long until = System.currentTimeMillis() + 5_000L;
            while (hook.get(resp) == null && System.currentTimeMillis() < until) {
                Thread.sleep(5);
            }
            while (pen.take()) {
                // rows
            }
            release.countDown();
            return null;
        });
        // task 1: another started query (2 workers), still running when the request starves
        tasks.add(() -> {
            release.await(5, TimeUnit.SECONDS);
            return null;
        });
        // tasks 2..9: queued behind them, not started yet when the request starves
        for (int i = 0; i < 8; i++) {
            tasks.add(() -> {
                laterRan.incrementAndGet();
                return null;
            });
        }
        List<Future<Object>> futures = executor.submitAll(UUID.randomUUID(), tasks).orElseThrow();
        Method await = HistoryService.class.getDeclaredMethod("awaitAll", List.class, long.class, ResponseBudget.class);
        await.setAccessible(true);
        long t0 = System.currentTimeMillis();
        await.invoke(history, futures, t0 + 10_000L, resp);
        assertTrue(resp.starved());
        assertEquals(0, laterRan.get(), "no query of the starved request started after it starved (old code: all 8 ran)");
        assertTrue(futures.subList(2, 10).stream().allMatch(Future::isCancelled));
        assertTrue(System.currentTimeMillis() - t0 < 5_000L, "answered without waiting for the deadline");
        assertTrue(((Number) history.diagnostics().get("budgetStarvedCancelled")).longValue() >= 8L, "counted");
    }
}
