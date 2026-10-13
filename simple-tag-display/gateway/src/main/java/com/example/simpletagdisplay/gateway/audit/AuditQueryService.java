package com.example.simpletagdisplay.gateway.audit;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.PriorityQueue;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.FutureTask;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.example.simpletagdisplay.gateway.util.NamedThreadFactory;
import com.inductiveautomation.ignition.common.audit.AuditRecord;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.util.AuditStatus;
import com.inductiveautomation.ignition.gateway.audit.AuditProfile;

/**
 * "Change History…" of the Display Template: the audit records of one tag ({@code dt.auditQuery}).
 *
 * <h2>Query</h2>
 * {@code AuditProfile.QueryRequest.builder()} exists on the 8.3.10 gateway but not in the 8.3.1 SDK the module
 * compiles against, so the 8-argument
 * {@link AuditProfile#query(String, String, String, String, Date, Date, String, Integer)} (actor, action, target,
 * value, start, end, system, context) is used — the 8.3.10 {@code QueryRequest} default method delegates to it. The
 * local and database profiles apply every text filter with SQL {@code LIKE} (verified with javap on
 * {@code LocalAuditProfile.query}): {@code _} in a tag path is a one-character wildcard there and the result order is
 * not specified, and the 8-argument form has no row limit. So the service (1) filters by the exact target, (2) keeps
 * only {@code tag write} / {@code tag edit} records, (3) sorts newest first and (4) cuts to the requested limit
 * itself; the window is the last {@value #WINDOW_DAYS} days.
 *
 * <h2>Bounded memory, newest rows</h2>
 * Breaking off after a fixed number of raw records <em>before</em> sorting would be wrong: with an unspecified result
 * order it can drop the newest records (a busy tag would show stale history), and it bounds nothing because the
 * 8-argument form has already materialised the whole list. So every record is offered to a {@link TopRecords}
 * collector that keeps only the newest {@code limit} matching records in a bounded min-heap (no early break, so
 * nothing newer is ever cut).
 * On gateways that have it (8.3.10: {@code LocalAuditProfile} streams its database cursor) the query runs through the
 * streaming {@code query(QueryRequest, QueryStreamHandler)} form, looked up reflectively because the SDK the module
 * compiles against lacks it: records are then never held as a list, so memory is O(limit). Without it the 8-argument
 * list form is used (memory = the profile's list; the top-N still picks the newest). No
 * {@code setLimit} is passed: the profile's order is unspecified, so a profile-side limit could cut the newest rows.
 *
 * <h2>Threads</h2>
 * A profile query can block on a database: it runs on a small dedicated executor ({@code ctg-audit-query}, 2
 * threads, 16 queued; full → {@code RATE_LIMITED} by the caller), never on the session queue or the module scheduler
 * (which carries the coalesced pushes). One module-wide instance ({@code GatewayServices.shared}), closed with the
 * module.
 *
 * <h2>Abandoned queries</h2>
 * A caller that gave up (its {@code dt.auditQuery} answered TIMEOUT) must not leave its task in the executor: queued
 * tasks would still run against the audit database later, and a slow database plus a few Refresh clicks would fill the
 * 2 + 16 slots, so Change History would be RATE_LIMITED gateway-wide until the backlog drained. So every caller's
 * future times out on its own after the caller's deadline ({@code orTimeout}); when the last caller of a task gave
 * up, the task is cancelled and removed from the queue (a queued task never reaches the database; a running one
 * finishes, unused).
 * Identical queries (same profile, target, limit) still queued or running are shared, and one owner (the Perspective
 * session) may hold at most {@value #PER_OWNER} outstanding queries (more → {@link RejectedExecutionException} →
 * RATE_LIMITED for that session only).
 */
public final class AuditQueryService implements AutoCloseable {

    /** Outstanding (queued or running) queries per owner (session). */
    static final int PER_OWNER = 2;

    /** How far back the change history looks. */
    public static final int WINDOW_DAYS = 90;
    private static final long WINDOW_MS = WINDOW_DAYS * 24L * 3600_000L;
    /**
     * The module's own suffix, anchored at the END of the value: {@code [auditId=<uuid>]} or
     * {@code [auditId=<uuid>, late=true]} as the last characters. A String setpoint may itself contain
     * {@code [auditId=...]} text (it is written verbatim into the head), so an unanchored first match would report an
     * injected id; the module always appends its real suffix last and {@code CtgAudit.fit} never cuts it. The anchor
     * is {@code \z} rather than {@code $}, so a trailing line break cannot slip past it (the module's own values never
     * hold one: control characters become '?').
     */
    static final Pattern AUDIT_ID = Pattern.compile("\\[auditId=([0-9a-fA-F-]{36})(?:, late=true)?\\]\\z");

    private final ThreadPoolExecutor executor = new ThreadPoolExecutor(2, 2, 60, TimeUnit.SECONDS,
        new ArrayBlockingQueue<>(16), new NamedThreadFactory("ctg-audit-query"));

    /** Owner -> outstanding caller futures; dedupe key -> the shared task. Guarded by {@code this}. */
    private final Map<Object, Integer> outstanding = new HashMap<>();
    private final Map<Object, Shared> shared = new HashMap<>();

    /** One task and the callers waiting for it. */
    private static final class Shared {
        final CompletableFuture<JsonArray> result = new CompletableFuture<>();
        FutureTask<Void> task;
        int waiters;
    }

    public AuditQueryService() {
        executor.allowCoreThreadTimeOut(true);
    }

    /**
     * Queries the change history of {@code target} (full tag path as audited) for {@code owner} (the session). The
     * future completes with the rows array, or exceptionally: {@link RejectedExecutionException} is THROWN when the
     * executor is full or the owner already has {@value #PER_OWNER} queries outstanding; a
     * {@link java.util.concurrent.TimeoutException} after {@code timeoutMs} (the task is then cancelled unless
     * another caller still waits for it); or the profile's exception. Cancelling the future gives up the same way.
     */
    public CompletableFuture<JsonArray> query(AuditProfile profile, String target, int limit, Object owner, long timeoutMs) {
        long now = System.currentTimeMillis();
        Object key = List.of(new Identity(profile), String.valueOf(target).toLowerCase(Locale.ROOT), limit);
        return submit(key, owner, timeoutMs, () -> run(profile, target, limit, now));
    }

    private static JsonArray run(AuditProfile profile, String target, int limit, long now) {
        TopRecords top = new TopRecords(target, limit);
        Date start = new Date(now - WINDOW_MS);
        Date end = new Date(now);
        try {
            if (!Streaming.query(profile, target, start, end, top)) {
                List<AuditRecord> records = profile.query(null, null, target, null, start, end, null, null);
                if (records != null) {
                    records.forEach(top::offer);
                }
            }
        } catch (Exception e) {
            throw new IllegalStateException("audit profile query failed", e);
        }
        return top.rows();
    }

    /** Reference identity as a map key element (an AuditProfile need not define equals). */
    private static final class Identity {
        private final Object o;

        Identity(Object o) {
            this.o = o;
        }

        @Override
        public boolean equals(Object x) {
            return x instanceof Identity && ((Identity) x).o == o;
        }

        @Override
        public int hashCode() {
            return System.identityHashCode(o);
        }
    }

    /** The executor part of {@link #query} (package-private for JUnit: any work, any key). */
    CompletableFuture<JsonArray> submit(Object key, Object owner, long timeoutMs, Callable<JsonArray> work) {
        Shared s;
        synchronized (this) {
            if (executor.isShutdown()) {
                throw new RejectedExecutionException("audit query service closed");
            }
            int n = outstanding.getOrDefault(owner, 0);
            if (n >= PER_OWNER) {
                throw new RejectedExecutionException("too many change-history queries of this session");
            }
            s = shared.get(key);
            if (s == null) {
                Shared ns = new Shared();
                ns.task = new FutureTask<>(() -> {
                    try {
                        ns.result.complete(work.call());
                    } catch (Throwable t) {
                        ns.result.completeExceptionally(t);
                    }
                    return null;
                });
                executor.execute(ns.task);                 // full: RejectedExecutionException, nothing recorded
                shared.put(key, ns);
                ns.result.whenComplete((v, e) -> {
                    synchronized (AuditQueryService.this) {
                        shared.remove(key, ns);
                    }
                });
                s = ns;
            }
            s.waiters++;
            outstanding.merge(owner, 1, Integer::sum);
        }
        Shared fs = s;
        CompletableFuture<JsonArray> mine = new CompletableFuture<>();
        fs.result.whenComplete((v, e) -> {
            if (e != null) {
                mine.completeExceptionally(e);
            } else {
                mine.complete(v);
            }
        });
        if (timeoutMs > 0) {
            mine.orTimeout(timeoutMs, TimeUnit.MILLISECONDS);
        }
        AtomicBoolean released = new AtomicBoolean();
        mine.whenComplete((v, e) -> {
            if (!released.compareAndSet(false, true)) {
                return;
            }
            boolean abandon = false;
            synchronized (AuditQueryService.this) {
                outstanding.computeIfPresent(owner, (k, c) -> c <= 1 ? null : c - 1);
                fs.waiters--;
                if (fs.waiters <= 0 && !fs.result.isDone()) {
                    abandon = true;
                    shared.remove(key, fs);
                }
            }
            if (abandon) {
                // queued: never starts. A running one is NOT interrupted (an interrupt can close the file channel of an
                // embedded audit database); it finishes and its result is dropped (at most the 2 executor threads).
                fs.task.cancel(false);
                executor.remove(fs.task);                  // its queue slot is free at once
                fs.result.cancel(false);
            }
        });
        return mine;
    }

    /** Tasks waiting in the executor queue (JUnit). */
    int queued() {
        return executor.getQueue().size();
    }

    /** Outstanding queries of {@code owner} (JUnit). */
    synchronized int outstanding(Object owner) {
        return outstanding.getOrDefault(owner, 0);
    }

    /**
     * Pure part: exact target (case-insensitive: tag paths are), action {@code tag write}/{@code tag edit},
     * newest first, at most {@code limit} rows of {@code {t, user, action, value, status, auditId?}}. Every record is
     * looked at; only the newest {@code limit} matching ones are kept.
     */
    static JsonArray rows(List<AuditRecord> records, String target, int limit) {
        TopRecords top = new TopRecords(target, limit);
        if (records != null) {
            records.forEach(top::offer);
        }
        return top.rows();
    }

    private static long time(AuditRecord r) {
        return r.getTimestamp() == null ? 0L : r.getTimestamp().getTime();
    }

    /**
     * The newest {@code limit} matching records of a stream of any length, in O(limit) memory: a min-heap by
     * timestamp whose oldest entry is replaced when a newer matching record arrives. Not thread-safe (one query).
     */
    static final class TopRecords {
        private final String target;
        private final int limit;
        private final PriorityQueue<AuditRecord> heap;
        private long seen;

        TopRecords(String target, int limit) {
            this.target = target;
            this.limit = Math.max(1, limit);
            this.heap = new PriorityQueue<>(this.limit + 1, Comparator.comparingLong(AuditQueryService::time));
        }

        /** Offers one record of the profile's result (any order). */
        void offer(AuditRecord r) {
            seen++;
            if (r == null || r.getActionTarget() == null || !r.getActionTarget().equalsIgnoreCase(target)) {
                return;
            }
            String action = r.getAction() == null ? "" : r.getAction().toLowerCase(Locale.ROOT);
            if (!action.equals(CtgAudit.ACTION_WRITE) && !action.equals(CtgAudit.ACTION_EDIT)) {
                return;
            }
            if (heap.size() < limit) {
                heap.add(r);
            } else if (time(heap.peek()) < time(r)) {
                heap.poll();
                heap.add(r);
            }
        }

        /** Records looked at (tests). */
        long seen() {
            return seen;
        }

        /** Records currently held (≤ limit; tests). */
        int held() {
            return heap.size();
        }

        /** The kept records as rows, newest first. */
        JsonArray rows() {
            List<AuditRecord> kept = new ArrayList<>(heap);
            kept.sort(Comparator.comparingLong(AuditQueryService::time).reversed());
            return toRows(kept);
        }
    }

    /** Rows of already filtered, sorted and cut records. */
    private static JsonArray toRows(List<AuditRecord> kept) {
        JsonArray out = new JsonArray();
        for (AuditRecord r : kept) {
            JsonObject o = new JsonObject();
            o.addProperty("t", r.getTimestamp() == null ? 0L : r.getTimestamp().getTime());
            o.addProperty("user", r.getActor());
            o.addProperty("action", r.getAction());
            o.addProperty("value", r.getActionValue());
            o.addProperty("status", status(r.getStatusCode()));
            String id = auditIdOf(r.getActionValue());
            if (id != null) {
                o.addProperty("auditId", id);
            }
            out.add(o);
        }
        return out;
    }

    /**
     * The auditId of the module's trailing suffix, or null when the value does not END with one (an id
     * inside the value, for example typed into a String setpoint, is never taken).
     */
    static String auditIdOf(String value) {
        if (value == null) {
            return null;
        }
        Matcher m = AUDIT_ID.matcher(value);
        return m.find() ? m.group(1) : null;
    }

    /**
     * The streaming query form of 8.3.10 ({@code AuditProfile.query(QueryRequest, QueryStreamHandler)}), reached by
     * reflection because the 8.3.1 SDK the module compiles against does not declare it. Resolved once; when the
     * types are missing (an older gateway) {@link #query} returns false and the caller uses the 8-argument form.
     */
    static final class Streaming {
        private static final String REQUEST = "com.inductiveautomation.ignition.gateway.audit.AuditProfile$QueryRequest";
        private static final String HANDLER = "com.inductiveautomation.ignition.gateway.audit.AuditProfile$QueryStreamHandler";
        private static volatile Api api;
        private static volatile boolean resolved;

        /** The reflected methods. */
        private static final class Api {
            final Class<?> handlerType;
            final Method builder;
            final Method target;
            final Method startTime;
            final Method endTime;
            final Method build;
            final Method query;

            Api(ClassLoader cl) throws ReflectiveOperationException {
                Class<?> request = Class.forName(REQUEST, false, cl);
                handlerType = Class.forName(HANDLER, false, cl);
                builder = request.getMethod("builder");
                Class<?> b = builder.getReturnType();
                target = b.getMethod("setActionTargetFilter", String.class);
                startTime = b.getMethod("setStartTime", Date.class);
                endTime = b.getMethod("setEndTime", Date.class);
                build = b.getMethod("build");
                query = AuditProfile.class.getMethod("query", request, handlerType);
            }
        }

        private Streaming() {
        }

        private static Api api() {
            if (!resolved) {
                synchronized (Streaming.class) {
                    if (!resolved) {
                        try {
                            api = new Api(AuditProfile.class.getClassLoader());
                        } catch (ReflectiveOperationException | LinkageError e) {
                            api = null;         // older gateway: the 8-argument form
                        }
                        resolved = true;
                    }
                }
            }
            return api;
        }

        /**
         * Runs the streaming query into {@code top}.
         *
         * @return false when the streaming form is not available (nothing was queried)
         */
        static boolean query(AuditProfile profile, String target, Date start, Date end, TopRecords top) throws Exception {
            Api a = api();
            if (a == null) {
                return false;
            }
            Object b = a.builder.invoke(null);
            a.target.invoke(b, target);
            a.startTime.invoke(b, start);
            a.endTime.invoke(b, end);
            Object request = a.build.invoke(b);
            InvocationHandler h = (proxy, m, args) -> {
                switch (m.getName()) {
                    case "handleRecord":
                        if (args != null && args.length == 1 && args[0] instanceof AuditRecord) {
                            top.offer((AuditRecord) args[0]);
                        }
                        return null;
                    case "onAfterRecords":
                        return null;
                    case "hashCode":
                        return System.identityHashCode(proxy);
                    case "equals":
                        return args != null && args.length == 1 && proxy == args[0];
                    case "toString":
                        return "ctg-audit-query-handler";
                    default:
                        return null;
                }
            };
            Object handler = Proxy.newProxyInstance(a.handlerType.getClassLoader(), new Class<?>[] {a.handlerType}, h);
            try {
                a.query.invoke(profile, request, handler);
            } catch (InvocationTargetException e) {
                Throwable c = e.getCause();
                if (c instanceof Exception) {
                    throw (Exception) c;
                }
                throw e;
            }
            return true;
        }
    }

    /** good | uncertain | bad from an audit status code. */
    static String status(int code) {
        if (code == AuditStatus.GOOD.getRawValue()) {
            return "good";
        }
        if (code == AuditStatus.UNCERTAIN.getRawValue()) {
            return "uncertain";
        }
        try {
            AuditStatus s = new AuditStatus(code);
            if (s.isGood()) {
                return "good";
            }
        } catch (RuntimeException e) {
            // unknown code: bad
        }
        return "bad";
    }

    @Override
    public void close() {
        executor.shutdownNow();
    }
}
