package com.example.simpletagdisplay.gateway.history;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.Future;
import java.util.concurrent.FutureTask;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;

/**
 * The {@code ctg-history} executor: a fixed set of worker threads shared fairly between Perspective sessions.
 *
 * <h2>Why not a ThreadPoolExecutor</h2>
 * A plain FIFO pool lets one session that submits 32 pens × 31 days of raw history occupy every thread for
 * seconds while another operator's one-pen refresh waits behind it. Historian queries cannot be
 * cancelled once started ({@code queryHistory} is synchronous and ignores interrupts), so the only defence is
 * to decide well <em>which</em> query starts next.
 *
 * <h2>Scheduling</h2>
 * <ul>
 *   <li>Each session has a lane (FIFO of its queued tasks + a running counter). A free worker serves the
 *       <b>least recently served</b> lane that may run a task: round-robin between busy sessions, and a session
 *       that just arrived is served before one that already got a thread (a newcomer never waits behind more
 *       than the tasks already running).</li>
 *   <li>A lane never has more than {@code maxRunningPerSession} tasks running ({@code max(1, ceil(threads / 2))}
 *       by default), so at least half the threads stay available to other sessions.</li>
 *   <li>The running counter is decremented in the task's {@code finally}: a query that outlived its request's
 *       deadline ("zombie") still counts against <em>its</em> session only.</li>
 * </ul>
 *
 * <h2>Admission ({@link #submitAll})</h2>
 * Atomic: all tasks of one request are queued, or none. A request is refused when its session already has work
 * queued or running and the new total would exceed {@code maxQueuedTasksPerSession}. A request of an
 * <em>idle</em> session is always admitted, whatever its size: applying the cap to it as well
 * ({@code queuedAndRunning + tasks > 16}) would refuse every legitimate chart with more than 16 pens forever.
 * The per-request size is bounded separately by the plan cost
 * cap ({@code ctg.history.maxTasksPerRequest}).
 *
 * <h2>Deadlines</h2>
 * {@link #cancelUnstarted} cancels and dequeues every task of a request that has not started yet (the route calls
 * it at the request deadline), so abandoned work never reaches the historian.
 *
 * Threads are created on demand up to {@link #resize the target} and live until the executor is resized down or
 * closed. Thread-safe.
 */
public final class FairHistoryExecutor implements AutoCloseable {

    /** One session's queue. Guarded by {@link #lock}. */
    private static final class Lane {
        final ArrayDeque<Task<?>> queue = new ArrayDeque<>();
        int running;
        long lastServed;                    // serve sequence number of its last started task (0 = never)
    }

    /** A queued unit of work. {@code started} is guarded by {@link #lock}. */
    private final class Task<T> extends FutureTask<T> {
        final UUID session;
        boolean started;

        Task(UUID session, Callable<T> c) {
            super(c);
            this.session = session;
        }
    }

    private final ReentrantLock lock = new ReentrantLock();
    private final Condition changed = lock.newCondition();
    private final Map<UUID, Lane> lanes = new LinkedHashMap<>();
    private long serveSeq;
    private final List<Thread> threads = new ArrayList<>();
    private final ThreadFactory threadFactory;

    private int targetThreads;
    private int maxQueuedPerSession;
    private int maxRunningPerSession;
    private int workers;
    private int idle;
    private int active;
    private int queued;
    private boolean closed;

    /**
     * @param threads              worker threads ({@code ctg.history.threads})
     * @param maxQueuedPerSession  {@code ctg.history.maxQueuedTasksPerSession}
     * @param maxRunningPerSession at most this many tasks of one session run at once ({@code <= 0}: half the threads)
     */
    public FairHistoryExecutor(int threads, int maxQueuedPerSession, int maxRunningPerSession, ThreadFactory threadFactory) {
        this.threadFactory = threadFactory;
        configure(threads, maxQueuedPerSession, maxRunningPerSession);
    }

    /** Default per-session running cap for {@code threads} workers: {@code max(1, ceil(threads / 2))}. */
    public static int defaultMaxRunning(int threads) {
        return Math.max(1, (threads + 1) / 2);
    }

    /** Applies new limits (settings reload). Surplus workers exit once idle; missing ones are started on demand. */
    public void configure(int threads, int maxQueuedPerSession, int maxRunningPerSession) {
        lock.lock();
        try {
            this.targetThreads = Math.max(1, threads);
            this.maxQueuedPerSession = Math.max(1, maxQueuedPerSession);
            this.maxRunningPerSession = maxRunningPerSession > 0 ? maxRunningPerSession : defaultMaxRunning(targetThreads);
            startWorkersLocked();
            changed.signalAll();
        } finally {
            lock.unlock();
        }
    }

    /** {@link #configure} with only the thread count changed. */
    public void resize(int threads) {
        lock.lock();
        int q;
        try {
            q = maxQueuedPerSession;
        } finally {
            lock.unlock();
        }
        configure(threads, q, defaultMaxRunning(Math.max(1, threads)));
    }

    /**
     * Queues every task of one request for {@code session}, or none.
     *
     * @return the futures in task order, or empty when the session's queue is full or the executor is closed
     */
    public <T> Optional<List<Future<T>>> submitAll(UUID session, List<? extends Callable<T>> tasks) {
        if (tasks.isEmpty()) {
            return Optional.of(Collections.emptyList());
        }
        lock.lock();
        try {
            if (closed) {
                return Optional.empty();
            }
            Lane lane = lanes.get(session);
            int load = lane == null ? 0 : lane.queue.size() + lane.running;
            if (load > 0 && load + tasks.size() > maxQueuedPerSession) {
                return Optional.empty();
            }
            if (lane == null) {
                lane = new Lane();
                lanes.put(session, lane);
            }
            List<Future<T>> out = new ArrayList<>(tasks.size());
            for (Callable<T> c : tasks) {
                Task<T> t = new Task<>(session, c);
                lane.queue.addLast(t);
                out.add(t);
            }
            queued += tasks.size();
            startWorkersLocked();
            changed.signalAll();
            return Optional.of(out);
        } finally {
            lock.unlock();
        }
    }

    /**
     * Cancels and dequeues every future of {@code futures} that has not started; started ones keep running
     * (a historian query cannot be stopped) and are left alone.
     *
     * @return how many were cancelled
     */
    public int cancelUnstarted(Collection<? extends Future<?>> futures) {
        int n = 0;
        lock.lock();
        try {
            for (Future<?> f : futures) {
                if (!(f instanceof Task)) {
                    continue;
                }
                Task<?> t = (Task<?>) f;
                if (t.started || t.isDone()) {
                    continue;
                }
                Lane lane = lanes.get(t.session);
                if (lane != null && lane.queue.remove(t)) {
                    queued--;
                    dropIfIdleLocked(t.session, lane);
                }
                t.cancel(false);
                n++;
            }
            if (n > 0) {
                changed.signalAll();
            }
        } finally {
            lock.unlock();
        }
        return n;
    }

    /** Queued plus running tasks of one session. */
    public int queuedAndRunning(UUID session) {
        lock.lock();
        try {
            Lane lane = lanes.get(session);
            return lane == null ? 0 : lane.queue.size() + lane.running;
        } finally {
            lock.unlock();
        }
    }

    /** Tasks running now (all sessions). */
    public int active() {
        lock.lock();
        try {
            return active;
        } finally {
            lock.unlock();
        }
    }

    /** Tasks waiting (all sessions). */
    public int queued() {
        lock.lock();
        try {
            return queued;
        } finally {
            lock.unlock();
        }
    }

    /** Worker threads alive. */
    public int workers() {
        lock.lock();
        try {
            return workers;
        } finally {
            lock.unlock();
        }
    }

    // =========================================================================================================
    // Workers
    // =========================================================================================================

    /** Starts workers while there is queued work, nobody idle to take it, and the target allows (lock held). */
    private void startWorkersLocked() {
        while (!closed && workers < targetThreads && idle < queued) {
            Thread th = threadFactory.newThread(this::workLoop);
            workers++;
            idle++;          // counts as idle until it picks a task
            threads.add(th);
            th.start();
        }
    }

    private void workLoop() {
        boolean registered = true;
        try {
            for (;;) {
                Task<?> task;
                lock.lock();
                try {
                    task = null;
                    while (task == null) {
                        if (closed || workers > targetThreads) {
                            // Unregister under the same lock hold as the check, so several surplus workers can
                            // never all see "too many" and leave fewer than the target behind.
                            unregisterLocked();
                            registered = false;
                            return;
                        }
                        task = pickLocked();
                        if (task == null) {
                            changed.await();
                        }
                    }
                    idle--;
                    active++;
                } finally {
                    lock.unlock();
                }
                try {
                    task.run();          // FutureTask: captures the callable's exceptions; no-op when cancelled
                } finally {
                    lock.lock();
                    try {
                        active--;
                        idle++;
                        Lane lane = lanes.get(task.session);
                        if (lane != null) {
                            lane.running--;
                            dropIfIdleLocked(task.session, lane);
                        }
                        changed.signalAll();
                    } finally {
                        lock.unlock();
                    }
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } finally {
            if (registered) {
                lock.lock();
                try {
                    unregisterLocked();
                } finally {
                    lock.unlock();
                }
            }
        }
    }

    /** An idle worker leaves (lock held). */
    private void unregisterLocked() {
        workers--;
        idle--;
        threads.remove(Thread.currentThread());
        changed.signalAll();
    }

    /**
     * Next task: the head of the least recently served lane that has queued work and is below the per-session
     * running cap (lock held); null if none may start now. Cancelled tasks found at a lane's head are discarded.
     */
    private Task<?> pickLocked() {
        for (;;) {
            UUID bestId = null;
            Lane best = null;
            for (Map.Entry<UUID, Lane> e : lanes.entrySet()) {
                Lane lane = e.getValue();
                if (lane.queue.isEmpty() || lane.running >= maxRunningPerSession) {
                    continue;
                }
                if (best == null || lane.lastServed < best.lastServed) {
                    best = lane;
                    bestId = e.getKey();
                }
            }
            if (best == null) {
                return null;
            }
            Task<?> t = best.queue.pollFirst();
            queued--;
            if (t.isCancelled()) {
                dropIfIdleLocked(bestId, best);
                continue;
            }
            t.started = true;
            best.running++;
            best.lastServed = ++serveSeq;
            return t;
        }
    }

    private void dropIfIdleLocked(UUID id, Lane lane) {
        if (lane.queue.isEmpty() && lane.running <= 0) {
            lanes.remove(id);
        }
    }

    // =========================================================================================================
    // Shutdown
    // =========================================================================================================

    /**
     * Cancels every queued task and stops the workers (interrupting them; a running historian query finishes on
     * its own). Waits at most 5 s.
     *
     * @return true when every worker stopped within the wait
     */
    public boolean shutdown() {
        List<Thread> toJoin;
        lock.lock();
        try {
            closed = true;
            for (Lane lane : lanes.values()) {
                for (Task<?> t : lane.queue) {
                    t.cancel(false);
                }
                lane.queue.clear();
            }
            lanes.clear();
            queued = 0;
            changed.signalAll();
            toJoin = new ArrayList<>(threads);
        } finally {
            lock.unlock();
        }
        for (Thread t : toJoin) {
            t.interrupt();
        }
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(5);
        for (Thread t : toJoin) {
            long left = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime());
            if (left <= 0) {
                break;
            }
            try {
                t.join(left);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        for (Thread t : toJoin) {
            if (t.isAlive()) {
                return false;
            }
        }
        return true;
    }

    @Override
    public void close() {
        shutdown();
    }
}
