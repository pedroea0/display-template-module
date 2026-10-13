package com.example.simpletagdisplay.gateway.history;

import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.annotations.AnnotationService;
import com.example.simpletagdisplay.gateway.perspective.PerspectiveInternals;
import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.example.simpletagdisplay.gateway.util.Json;
import com.example.simpletagdisplay.gateway.util.NamedThreadFactory;
import com.example.simpletagdisplay.gateway.util.RateLimitedLog;
import com.inductiveautomation.ignition.common.StreamingDatasetWriter;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.history.AggregationMode;
import com.inductiveautomation.ignition.common.sqltags.history.BasicTagHistoryQueryParams;
import com.inductiveautomation.ignition.common.sqltags.history.ReturnFormat;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.tags.config.properties.WellKnownTagProps;
import com.inductiveautomation.ignition.common.tags.model.SecurityContext;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.gateway.historian.TagHistoryManager;
import com.inductiveautomation.perspective.gateway.api.Session;
import com.inductiveautomation.perspective.gateway.api.WebAuthStatus;
import com.google.common.collect.ImmutableSet;

/**
 * History service behind {@code POST /data/simpletagdisplay/v2/history}. Fair, budgeted and cached; every point is
 * held as a primitive column and streamed by the route.
 *
 * <h2>Admission ({@link #admit} before the body is read, {@link #checkInterval} after parsing, the rest inside
 * {@link #execute}; every slot released by {@link Admission#close()} after the body was written)</h2>
 * <ol>
 *   <li>global in-flight requests ≤ {@code min(ctg.history.maxInFlightRequests, }{@value #MAX_IN_FLIGHT_CEILING}{@code )}
 *       → else 503 {@code BUSY} ({@code Retry-After: 2}), and per session at most
 *       {@code ctg.history.maxConcurrentPerSession} requests at once → 429. Both are taken <b>before a byte of the
 *       body is read</b>: together with the body read deadline ({@link #bodyDeadline}) they bound the
 *       Jetty threads this route can park — one session at most {@code maxConcurrentPerSession}, all sessions at
 *       most the global limit, each for at most the deadline;</li>
 *   <li>per token: a token bucket ({@link HistoryRateLimiter}) — up to
 *       {@value HistoryRateLimiter#BURST} request starts back to back, refilled at one per
 *       {@code ctg.history.minIntervalMs} → else 429 {@code TOO_MANY_REQUESTS} ({@code Retry-After} = the wait for the
 *       next request, rounded up to whole seconds);</li>
 *   <li>plan cost: historian queries of the request ≤ {@code ctg.history.maxTasksPerRequest}; above it each pen's
 *       chunk misses are merged into fewer queries, still above → 400 {@code RANGE_TOO_LARGE};</li>
 *   <li>point reservation ({@link PointBudget}, {@code ctg.history.maxInFlightPoints}) of a realistic estimate of the
 *       request's points ({@link #reservePoints}: exact for aggregated pens, the tag's observed density for raw pens,
 *       the worst case for an unknown tag), under the per-session fair share (a reserve for light sessions, an equal
 *       split of the rest while sessions contend) → else 503 {@code BUSY}. The reservation grows while the
 *       queries run when the estimate was too small; when the gateway has no room for that the request is answered
 *       503 {@code BUSY} too;</li>
 *   <li>{@link FairHistoryExecutor#submitAll} (per-session queue cap) → else 429.</li>
 * </ol>
 *
 * <h2>Execution</h2>
 * <ol>
 *   <li><b>Path rules</b> ({@link TagPaths#parse}, provider resolved with the project default) → {@code invalidPath};
 *       <b>read scope</b>: the token's pen gate ({@code ReadScope}) → {@code outOfScope}, before anything else
 *       touches the tag.</li>
 *   <li><b>Permission and type pre-check</b> (the historian never filters by user): one batched
 *       {@code readAsync} of {@code base, .DataType, .HistoryEnabled, .HistoryProvider} with the session user's
 *       <em>current</em> security context → {@code accessDenied}, {@code notFound}, {@code unsupportedType},
 *       {@code noHistory}. Results are cached 30 s per (session, auth generation, path) ({@link ReadPermissionCache}).
 *       Pens failing the check are never queried and never reach the chunk cache.</li>
 *   <li><b>Planning</b> per distinct (path, aggregation, window): the pen window ({@link HistoryRequest#window}) is
 *       cut into epoch-aligned chunks; sealed chunks come from or go to the {@link HistoryChunkCache}, everything else
 *       is one query. Pens asking for the same thing share one plan (fan-out).</li>
 *   <li><b>Queries</b> on {@code ctg-history} ({@link FairHistoryExecutor}): one {@code TagHistoryManager.queryHistory}
 *       per pen piece (never one Wide query for all pens, which would put every pen on the union of all pens'
 *       timestamps), into a {@link PenSeriesWriter}
 *       (Boolean garbage filter, count-and-discard caps).</li>
 *   <li><b>Deadline</b> {@code ctg.history.timeoutMs}: unstarted tasks are cancelled; pens with unfinished pieces get
 *       {@code timeout}. Nothing finished → 504 {@code TIMEOUT}; everything failed → 502
 *       {@code HISTORY_QUERY_FAILED}.</li>
 *   <li><b>Repair the cut</b>: evictions while the queries ran are provisional — an earlier pen can hold points
 *       it gives back later (over its own cap, timed out, failed). With every first-phase count final, the pens are
 *       walked in request order ({@link #repairCut}): an evicted pen that wanted more than its own cap is over its own
 *       cap; an evicted pen that fits the longest request-order prefix is <b>re-queried</b> in the second phase; the
 *       first pen that does not fit is the cut (it and every later pen → {@code tooManyPoints}).</li>
 *   <li><b>Second phase</b> (same deadline): re-runs, and the <b>fallbacks</b> — raw pens over their own cap with
 *       {@code onTooManyPoints:"aggregate"} are re-queried aggregated with the pen's aggregation ({@code pointCountMax}
 *       buckets at most) and returned {@code downgraded:true} with their {@code bucketMs}. A fallback takes points in
 *       its pen's request order, so it can evict a later pen that finished in the first phase: that pen becomes
 *       {@code tooManyPoints} (the late fallback of a re-run that went over its cap evicts nobody). A re-run that
 *       cannot finish before the deadline is {@code timeout} (retryable), not {@code tooManyPoints}: the pen fits, it
 *       only ran out of time.</li>
 *   <li><b>Freeze</b>: pens that timed out or failed gave their points back when settled (their zombie queries can
 *       take nothing more); before assembly the response budget is frozen and every allowance re-read, so a pen is
 *       never answered {@code ok} with its points evicted.</li>
 * </ol>
 *
 * <h2>Annotations</h2>
 * When the request asks for {@code annotations:{types}} and the token's chart has {@code annotations.enabled}, every
 * full pen that passed the pre-check gets {@code annotations[]} + {@code annotationsStatus}: one
 * {@link AnnotationService#query} per historian runs as a task of the same submission as the data queries (so under
 * the same fairness, deadline and in-flight accounting), looking back one window length because the historian
 * matches on the entry's start. {@code annotationsOnly} runs only those tasks.
 *
 * <h2>Anchors (full pens with {@code includeAnchor}; never on incremental pens)</h2>
 * Needed when a pen's data starts after the window start (the chart draws the line entering from the left edge).
 * The task of the pen's first piece looks it up right after its own query (no extra task, no extra queue turn);
 * a pen whose first piece is a cache hit gets a small anchor task. Core Historian ignores
 * {@code BOUNDING_VALUES_YES}, and a one-bucket LastValue query stamps the value with the bucket start (24 h
 * before the window), not the sample time. The anchor is therefore the last raw sample of the 5 minutes before the
 * window start; when there is none, a 24-bucket Count over the previous day finds the last hour holding samples and
 * a raw query of that hour gives the exact sample. Cached 60 s ({@link AnchorCache}).
 *
 * <h2>Test hook</h2>
 * Only while {@code ctg.debug} is on: the system property {@code ctg.debug.historyDelayMs} (0–60000) delays every data
 * query by that many ms on its worker thread, so the timeout and fairness acceptance tests have a deterministic slow
 * historian. Never active in production.
 */
public final class HistoryService implements AutoCloseable {

    private static final LoggerEx LOG = LoggerEx.newBuilder().build("SimpleTagDisplay.History");

    private static final String QUERY_FAILED = "History query failed";
    private static final long MIB = 1024L * 1024L;

    /** Aggregated cache chunk = this many buckets. */
    static final int AGG_CHUNK_BUCKETS = 500;
    /** Raw cache chunk candidates and the most chunks a window may span. */
    static final long[] RAW_CHUNKS = {BucketLadder.HOUR, 6 * BucketLadder.HOUR, BucketLadder.DAY};
    static final int MAX_RAW_CHUNKS = 50;

    private static final long ANCHOR_NEAR_MS = 5 * BucketLadder.MINUTE;
    private static final long ANCHOR_LOOKBACK_MS = BucketLadder.DAY;
    private static final int ANCHOR_BUCKETS = 24;
    private static final String DEBUG_DELAY_PROPERTY = "ctg.debug.historyDelayMs";
    /** A cached anchor is extended forward (one raw query over the gap) only across at most this much time. */
    static final long ANCHOR_EXTEND_MAX_MS = BucketLadder.HOUR;
    /**
     * Upper bound of the effective {@code maxInFlightRequests} (the setting's range goes to 512). Kept below the route's
     * framework concurrency ({@code HistoryRoute.FRAMEWORK_CONCURRENCY}) so the module's JSON 503 stays the limit
     * clients see, and far below Jetty's thread pool (300 on 8.3.10).
     */
    static final int MAX_IN_FLIGHT_CEILING = 64;
    /**
     * History requests one token may start back to back before the {@code ctg.history.minIntervalMs} refill applies
     * ({@link HistoryRateLimiter}). Sent to the chart as {@code limits.historyBurst}.
     */
    public static final int REQUEST_BURST = HistoryRateLimiter.BURST;
    /** A partly covered sealed aggregated chunk is fetched (and cached) whole only when the window covers ≥ 3/4 of it. */
    static final int AGG_OVERFETCH_MIN_COVER_NUM = 3;
    static final int AGG_OVERFETCH_MIN_COVER_DEN = 4;

    private final GatewayServices services;
    private final FairHistoryExecutor executor;
    private final PointBudget budget;
    private final PointEstimator estimator = new PointEstimator(System::currentTimeMillis);
    private final HistoryChunkCache cache;
    private final ReadPermissionCache permissions;
    private final AnchorCache anchors;
    private final RateLimitedLog warnings = new RateLimitedLog(LOG, 60_000L);
    private final AtomicInteger inFlight = new AtomicInteger();
    /** Query tasks of starved requests cancelled before they started (diagnostics). */
    private final AtomicLong starvedCancelled = new AtomicLong();
    private final ConcurrentHashMap<UUID, Integer> perSession = new ConcurrentHashMap<>();
    private final HistoryRateLimiter rateLimiter = new HistoryRateLimiter(System::currentTimeMillis);

    public HistoryService(GatewayServices services) {
        this.services = services;
        ModuleSettings.Settings s = services.settings().get();
        this.executor = new FairHistoryExecutor(s.historyThreads(), s.historyMaxQueuedTasksPerSession(), 0,
            new NamedThreadFactory("ctg-history"));
        this.budget = new PointBudget(() -> services.settings().get().historyMaxInFlightPoints());
        this.cache = new HistoryChunkCache(() -> services.settings().get().historyCacheMb() * MIB, System::currentTimeMillis);
        this.permissions = new ReadPermissionCache(System::currentTimeMillis);
        this.anchors = new AnchorCache(System::currentTimeMillis);
        // Permission entries are keyed by auth generation anyway; dropping them early just frees memory.
        services.onSessionEnd(permissions::removeSession);
        services.onUserChange(permissions::removeSession);
        // An ended session is no longer waiting for the point budget, and its rate buckets go with it; a token revoke
        // drops the bucket of an owner that has no token left (see "Memory" in HistoryRateLimiter).
        services.onSessionEnd(budget::sessionEnded);
        services.onSessionEnd(sid -> rateLimiter.removeSession(sid.toString()));
        services.tokens().onRemoved(this::tokensRemoved);
    }

    /**
     * Tokens were removed from the store (revoke, delegate stop, session end, expiry, eviction): drops the rate bucket
     * of every (session, delegate) that has no token left; otherwise the map would keep one entry per token ever used
     * until it passed {@value HistoryRateLimiter#MAX_ENTRIES} entries. A rotated token never drops its owner's bucket:
     * the store notifies after the new token is in, so the owner still has one and keeps its remaining budget. One
     * scan of the store per notification, whatever was removed.
     */
    void tokensRemoved(java.util.Collection<HistoryTokenStore.TokenInfo> removed) {
        if (removed.isEmpty()) {
            return;
        }
        java.util.Set<String> live = services.tokens().ownerKeys(HistoryService::rateKey);
        for (HistoryTokenStore.TokenInfo t : removed) {
            String key = rateKey(t);
            if (!live.contains(key)) {
                rateLimiter.remove(key);
            }
        }
    }

    /** Settings reload: executor size and per-session caps, cache budget. */
    public void applySettings(ModuleSettings.Settings s) {
        executor.configure(s.historyThreads(), s.historyMaxQueuedTasksPerSession(), 0);
        cache.trim();
    }

    // =========================================================================================================
    // Admission
    // =========================================================================================================

    /**
     * Which limit refused a request. The route
     * sends it as {@code X-CTG-Limit} next to the frozen error body, so a client that mirrors the token bucket can tell
     * an empty bucket ({@link #RATE}: drain the mirror, wait the exact refill time) from a session that already runs
     * {@code maxConcurrentPerSession} requests ({@link #CONCURRENCY}: the bucket is untouched, retry when a slot frees).
     */
    public enum Limit {
        /** The token bucket: {@code X-CTG-Retry-After-Ms} is the exact wait for the next request. */
        RATE("rate"),
        /** Per-session concurrency ({@code ctg.history.maxConcurrentPerSession}); the bucket is not consumed. */
        CONCURRENCY("concurrency"),
        /** The per-session queue cap of the fair executor. */
        QUEUE("queue"),
        /** The global in-flight limit or the point budget (503 BUSY). */
        CAPACITY("capacity");

        private final String header;

        Limit(String header) {
            this.header = header;
        }

        /** The {@code X-CTG-Limit} header value. */
        public String header() {
            return header;
        }
    }

    /** A request that may not run now. */
    public static final class Refused extends Exception {
        private static final long serialVersionUID = 1L;
        private final ErrorCode code;
        private final int retryAfterS;
        private final Limit limit;
        private final long retryAfterMs;

        Refused(ErrorCode code, int retryAfterS, Limit limit, long retryAfterMs) {
            super(code.name(), null, false, false);
            this.code = code;
            this.retryAfterS = retryAfterS;
            this.limit = limit;
            this.retryAfterMs = retryAfterMs;
        }

        public ErrorCode code() {
            return code;
        }

        /** Seconds for the {@code Retry-After} header (HTTP: whole seconds, at least 1). */
        public int retryAfterS() {
            return retryAfterS;
        }

        /** The limit that refused the request ({@code X-CTG-Limit}). */
        public Limit limit() {
            return limit;
        }

        /** The exact wait in ms when known ({@code X-CTG-Retry-After-Ms}; the bucket's refill time), else 0. */
        public long retryAfterMs() {
            return retryAfterMs;
        }
    }

    /**
     * Admission slots and the point reservation of one request. {@link #close()} (after the body was written) releases
     * the slots at once; the point reservation is released when the request is closed <em>and</em> its last running
     * historian task has finished — a query that outlived the deadline ("zombie") keeps filling its writer, so its
     * points stay reserved until it really ends. Tasks that had not started when the request closed
     * never run their query.
     */
    public final class Admission implements AutoCloseable {
        private final UUID sessionId;
        private boolean released;
        private int runningTasks;
        private PointBudget.Reservation reservation;
        private final List<PointBudget.Reservation> extras = new ArrayList<>();

        Admission(UUID sessionId) {
            this.sessionId = sessionId;
        }

        synchronized void attach(PointBudget.Reservation r) {
            if (released && runningTasks == 0) {
                r.close();
            } else {
                reservation = r;
            }
        }

        /**
         * An extra reservation released together with the main one: the cap of a timed-out pen whose zombie query
         * keeps storing for the chunk cache. Points it holds are outside the response budget, so they are
         * reserved globally on their own.
         */
        synchronized void attachExtra(PointBudget.Reservation r) {
            if (released && runningTasks == 0) {
                r.close();
            } else {
                extras.add(r);
            }
        }

        /** Releases the point reservations (caller holds the lock; released and no task running). */
        private void releasePoints() {
            if (reservation != null) {
                reservation.close();
            }
            for (PointBudget.Reservation r : extras) {
                r.close();
            }
            extras.clear();
        }

        /** A task of this request starts; false when the request is already closed (skip the query). */
        synchronized boolean enterTask() {
            if (released) {
                return false;
            }
            runningTasks++;
            return true;
        }

        /** A task of this request ended (normally, with an error, or interrupted). */
        synchronized void exitTask() {
            runningTasks--;
            if (released && runningTasks == 0) {
                releasePoints();
            }
        }

        /** Tasks of this request running right now (diagnostics and tests). */
        synchronized int runningTasks() {
            return runningTasks;
        }

        @Override
        public void close() {
            synchronized (this) {
                if (released) {
                    return;
                }
                released = true;
                if (runningTasks == 0) {
                    releasePoints();
                }
            }
            inFlight.decrementAndGet();
            releaseSessionSlot(sessionId);
        }
    }

    /** Effective global in-flight limit (live setting, capped by {@link #MAX_IN_FLIGHT_CEILING}). */
    static int maxInFlight(ModuleSettings.Settings s) {
        return Math.max(1, Math.min(s.historyMaxInFlightRequests(), MAX_IN_FLIGHT_CEILING));
    }

    /**
     * Takes the global in-flight slot and the per-session slot for one request of {@code token}, or refuses it. Runs
     * <b>before the body is read</b>, so a refusal costs no read and a slow body can only hold a slot it was given.
     */
    public Admission admit(HistoryTokenStore.TokenInfo token) throws Refused {
        ModuleSettings.Settings s = services.settings().get();
        if (inFlight.incrementAndGet() > maxInFlight(s)) {
            inFlight.decrementAndGet();
            throw new Refused(ErrorCode.BUSY, 2, Limit.CAPACITY, 0L);
        }
        // Per-session concurrency: increment-with-limit atomically (no detached counters).
        UUID sid = token.sessionId();
        int max = s.historyMaxConcurrentPerSession();
        boolean[] taken = {false};
        perSession.compute(sid, (k, v) -> {
            int n = v == null ? 0 : v;
            if (n >= max) {
                return v;
            }
            taken[0] = true;
            return n + 1;
        });
        if (!taken[0]) {
            inFlight.decrementAndGet();
            // not the bucket: nothing of the token's bucket was taken, and the slot frees when one of the session's
            // running requests ends (the client retries after a short pause, without draining its bucket mirror)
            throw new Refused(ErrorCode.TOO_MANY_REQUESTS, 1, Limit.CONCURRENCY, 0L);
        }
        return new Admission(sid);
    }

    /**
     * Per-token rate limit, checked after the body was parsed: a token bucket of {@value HistoryRateLimiter#BURST}
     * request starts refilled at one per {@code ctg.history.minIntervalMs} ({@link HistoryRateLimiter}; a plain
     * minimum interval would serialise a chunked load at one request per interval). A refused request changes no state:
     * a client that honours {@code Retry-After} is admitted on its retry; the exact wait (usually well under the
     * 1 s minimum of {@code Retry-After}) is also sent as {@code X-CTG-Retry-After-Ms}. The caller closes the admission
     * on refusal.
     */
    public void checkInterval(HistoryTokenStore.TokenInfo token) throws Refused {
        long wait = rateLimiter.acquire(rateKey(token), services.settings().get().historyMinIntervalMs());
        if (wait > 0) {
            throw new Refused(ErrorCode.TOO_MANY_REQUESTS, retryAfterSeconds(wait), Limit.RATE, wait);
        }
    }

    /**
     * The rate bucket of a token: its session and owning delegate, NOT the token string. Every {@code chart.token}
     * mints a new token, and a fresh key would start with a full burst, so a client rotating tokens would get about
     * {@value HistoryRateLimiter#BURST} extra requests per rotation; keyed this way, a rotated token inherits its
     * predecessor's remaining budget. Both parts are server-issued (the session id and the delegate's random owner
     * id), never client text.
     */
    static String rateKey(HistoryTokenStore.TokenInfo token) {
        return token.sessionId() + "/" + token.ownerId();
    }

    /**
     * A total deadline for reading one request body on the calling (Jetty) thread. Jetty's blocking
     * read has no deadline of its own (only the connection idle timeout, which a client trickling bytes never
     * reaches). When the deadline passes while the read is still running, the reading thread is interrupted: Jetty
     * 12's blocking content producer turns the interrupt into a failed read (an {@code IOException}), the parse
     * fails, and {@link Deadline#expired()} tells the route to answer 400 and close the connection.
     * {@link Deadline#close()} must be called on the reading thread right after the read; it clears an interrupt
     * that arrived after the read ended, so the thread goes back to Jetty's pool clean.
     */
    public Deadline bodyDeadline(long ms) {
        return new Deadline(Thread.currentThread(), ms);
    }

    /** See {@link #bodyDeadline}. */
    public final class Deadline implements AutoCloseable {
        private final Thread reader;
        private final ScheduledFuture<?> timer;
        private boolean closed;
        private boolean fired;

        private Deadline(Thread reader, long ms) {
            this.reader = reader;
            ScheduledFuture<?> f = null;
            try {
                f = services.scheduler().schedule(this::fire, Math.max(1L, ms), TimeUnit.MILLISECONDS);
            } catch (RuntimeException e) {
                // scheduler shut down (module stopping): no deadline; the read is bounded by Jetty's idle timeout
            }
            this.timer = f;
        }

        private synchronized void fire() {
            if (!closed) {
                fired = true;
                reader.interrupt();
            }
        }

        /** True when the deadline passed before {@link #close()}. */
        public synchronized boolean expired() {
            return fired;
        }

        @Override
        public void close() {
            boolean clear;
            synchronized (this) {
                closed = true;
                clear = fired;
            }
            if (timer != null) {
                timer.cancel(false);
            }
            if (clear) {
                Thread.interrupted();           // no stray interrupt on a pooled Jetty thread
            }
        }
    }

    /** Releases one per-session slot; the entry is removed atomically when it reaches 0. */
    private void releaseSessionSlot(UUID sessionId) {
        perSession.computeIfPresent(sessionId, (k, v) -> v <= 1 ? null : v - 1);
    }

    /** {@code Retry-After} seconds for a wait of {@code waitMs}: rounded up, at least 1. */
    static int retryAfterSeconds(long waitMs) {
        return (int) Math.max(1L, Math.min(3600L, (waitMs + 999L) / 1000L));
    }

    // =========================================================================================================
    // Plan model
    // =========================================================================================================

    /** The whole request failed. */
    public static final class Failed extends Exception {
        private static final long serialVersionUID = 1L;
        private final ErrorCode code;

        Failed(ErrorCode code) {
            super(code.name(), null, false, false);
            this.code = code;
        }

        public ErrorCode code() {
            return code;
        }
    }

    /** A sealed chunk a query fills (cache admission after the query). */
    static final class Slot {
        final HistoryChunkCache.Key key;
        final long from;
        final long to;

        Slot(HistoryChunkCache.Key key, long from, long to) {
            this.key = key;
            this.from = from;
            this.to = to;
        }
    }

    /** One time range {@code [from, to)} of one plan: a cache hit, or one historian query. */
    static final class Piece {
        final long from;
        final long to;
        final HistoryChunkCache.Chunk cached;
        final List<Slot> slots = new ArrayList<>();
        PenSeriesWriter writer;
        Future<Object> future;
        String status;                      // after settling: null = ok; TIMEOUT / ERROR

        Piece(long from, long to, HistoryChunkCache.Chunk cached) {
            this.from = from;
            this.to = to;
            this.cached = cached;
        }

        boolean isQuery() {
            return cached == null;
        }
    }

    /** Everything needed to answer one distinct (path, aggregation, window). */
    static final class Plan {
        final TagPath path;
        final String nk;
        final ReadPermissionCache.Check check;
        final AggregationMode agg;              // null = raw
        final Long bucketMs;                    // aggregated only
        final HistoryRequest.PenWindow window;
        final PenSeriesWriter.ValueFilter filter;
        final List<Piece> pieces = new ArrayList<>();
        PenSeriesWriter.PenBudget penBudget;
        int order;                              // request order (ResponseBudget)
        long cap;
        int cacheHits;
        int cacheMisses;
        boolean anchorWanted;
        volatile AnchorCache.Anchor anchor;
        Piece fallback;                         // aggregated re-query of an over-cap raw pen
        PenSeriesWriter.PenBudget fallbackBudget;   // the fallback's allowance (same request order as the pen)
        long fallbackBucket;
        AggregationMode fallbackAgg;            // raw: the pen's aggregation for the fallback
        String finalStatus;                     // null = data; TIMEOUT / ERROR / TOO_MANY_POINTS
        boolean queriesSkipped;                 // over its own cap at planning (cache hits alone): no data query
        boolean rerun;                          // re-queried in the second phase (repairCut)
        boolean cutOff;                         // at or after the response cut: refused by maxPointsPerResponse
        long serverNow;                         // the request's server time (settled check; 0 in unit fixtures)
        Long lastStored;                        // newest stored raw sample (admitSettled); guarded by this plan

        Plan(TagPath path, String nk, ReadPermissionCache.Check check, AggregationMode agg, Long bucketMs,
             HistoryRequest.PenWindow window) {
            this.path = path;
            this.nk = nk;
            this.check = check;
            this.agg = agg;
            this.bucketMs = bucketMs;
            this.window = window;
            this.filter = PenSeriesWriter.ValueFilter.of(check.isBoolean(), agg);
        }

        boolean raw() {
            return agg == null;
        }

        boolean hasQueries() {
            for (Piece p : pieces) {
                if (p.isQuery()) {
                    return true;
                }
            }
            return fallback != null;
        }
    }

    // =========================================================================================================
    // Execution
    // =========================================================================================================

    /**
     * Runs one admitted request. Blocks the calling (Jetty) thread until every query finished or {@code deadlineAt}.
     *
     * @param session    the live Perspective session of the token (its current user is evaluated)
     * @param deadlineAt absolute deadline (epoch ms)
     * @param admission  this request's admission; the point reservation is attached to it
     */
    public HistoryResult execute(HistoryRequest req, HistoryTokenStore.TokenInfo token, Session session, long deadlineAt,
                                 Admission admission) throws Failed, Refused {
        long t0 = System.currentTimeMillis();
        ModuleSettings.Settings s = services.settings().get();
        boolean debug = services.debugEnabled();
        String defaultProvider = PerspectiveInternals.projectDefaultTagProvider(services.gatewayContext(), token.project());
        UUID sid = token.sessionId();

        // 1. Path rules + read scope.
        Map<String, HistoryResult.Pen> fixed = new HashMap<>();         // pen key -> final result (no query)
        Map<String, TagPath> pathByPen = new LinkedHashMap<>();
        Map<String, TagPath> unique = new LinkedHashMap<>();            // normalized key -> canonical path
        for (HistoryRequest.Pen p : req.pens()) {
            TagPaths.Parsed parsed = TagPaths.parse(p.tagPath(), defaultProvider);
            if (!parsed.ok()) {
                fixed.put(p.key(), HistoryResult.Pen.empty(p.key(), p.tagPath(), HistoryResult.INVALID_PATH));
                continue;
            }
            String nk = TagPaths.normalizedKey(parsed.path());
            // ctg.read.deniedProviders (default System) applies to history for EVERY pen, also a Designer pen that the
            // token's pen gate (ReadScope, which applies the denied providers to runtime pens only) would allow:
            // such a pen gets live values and metadata but history outOfScope. The stricter rule is deliberate:
            // history of a denied provider is never served, whatever the component scope; [System] tags are not
            // trended. The pen gate adds the component's own scope on top.
            if (services.floorPolicy().readProviderDenied(parsed.path().getSource()) || !token.penGate().allows(nk)) {
                fixed.put(p.key(), HistoryResult.Pen.empty(p.key(), parsed.path().toStringFull(), HistoryResult.OUT_OF_SCOPE));
                continue;
            }
            pathByPen.put(p.key(), parsed.path());
            unique.putIfAbsent(nk, parsed.path());
        }

        // 2. Permission + type pre-check (cached per session and auth generation).
        Map<String, ReadPermissionCache.Check> checks = precheck(unique, sid, session, s, deadlineAt);

        // 2b. Annotations: only when the token's chart has annotations.enabled (the route has no props) and
        //     only for full pens that passed the pre-check; one query per historian (paths of all its pens).
        TagHistoryManager mgr = session.getTagHistoryManager();
        Map<String, String> annProviderByPen = new LinkedHashMap<>();      // pen key -> historian
        Map<String, String> annKeyByPen = new HashMap<>();                 // pen key -> normalized key
        Map<String, Map<String, TagPath>> annPaths = new LinkedHashMap<>(); // historian -> nk -> path
        if (!req.annotationTypes().isEmpty() && token.annotationsEnabled()) {
            for (HistoryRequest.Pen p : req.pens()) {
                TagPath path = pathByPen.get(p.key());
                ReadPermissionCache.Check c = path == null ? null : checks.get(TagPaths.normalizedKey(path));
                if (c == null || !c.ok() || c.historyProvider() == null || req.window(p).incremental()) {
                    continue;
                }
                String nk = TagPaths.normalizedKey(path);
                annProviderByPen.put(p.key(), c.historyProvider());
                annKeyByPen.put(p.key(), nk);
                annPaths.computeIfAbsent(c.historyProvider(), k -> new LinkedHashMap<>()).putIfAbsent(nk, path);
            }
        }
        Map<String, AnnotationService.QueryResult> annResults = new ConcurrentHashMap<>();
        List<Callable<Object>> annTasks = new ArrayList<>();
        long annFrom = AnnotationService.queryFrom(req.start(), req.end());
        for (Map.Entry<String, Map<String, TagPath>> e : annPaths.entrySet()) {
            annTasks.add(tracked(admission, annotationTask(AnnotationService.of(services), mgr, e.getKey(), e.getValue(),
                annFrom, req, s.annotationsMaxPerPen(), annResults)));
        }
        if (req.annotationsOnly()) {
            return annotationsOnly(req, t0, fixed, pathByPen, checks, annTasks, annProviderByPen, annKeyByPen,
                annResults, sid, deadlineAt, s);
        }

        // 3. Plans (deduplicated: identical pens are queried once and fanned out).
        Map<String, Plan> plans = new LinkedHashMap<>();
        Map<String, Plan> planByPen = new HashMap<>();
        for (HistoryRequest.Pen p : req.pens()) {
            TagPath path = pathByPen.get(p.key());
            if (path == null) {
                continue;
            }
            String nk = TagPaths.normalizedKey(path);
            ReadPermissionCache.Check c = checks.get(nk);
            if (c == null || !c.ok()) {
                fixed.put(p.key(), HistoryResult.Pen.empty(p.key(), path.toStringFull(),
                    c == null ? HistoryResult.TIMEOUT : c.status()).withDataType(c == null ? null : c.dataType()));
                continue;
            }
            AggregationMode agg = req.raw() ? null : p.aggregation();
            HistoryRequest.PenWindow w = req.window(p);
            // Raw pens keep their own aggregation for the onTooManyPoints:"aggregate" fallback, so it is part of the key.
            String dk = nk + '|' + (agg == null ? "raw:" + p.aggregation().name() : agg.name()) + '|' + w.from() + '|' + w.to() + '|'
                + w.incremental();
            Plan plan = plans.get(dk);
            if (plan == null) {
                plan = newPlan(path, nk, c, agg, req, w, s);
                plan.order = plans.size();          // request order of the plan's first pen
                plans.put(dk, plan);
            }
            plan.fallbackAgg = p.aggregation();
            planByPen.put(p.key(), plan);
        }

        // 4. Plan cost, budgets (cache hits are taken from them now) and the point reservation: a realistic estimate,
        //    under the per-session fair share; the response budget grows it while the queries run.
        enforcePlanCost(plans.values(), s.historyMaxTasksPerRequest());
        ResponseBudget response = new ResponseBudget(s.historyMaxPointsPerResponse());
        long estimate = 0;
        for (Plan plan : plans.values()) {
            if (plan.agg != null) {
                plan.cap = aggregatedCap(plan);
            }
            plan.penBudget = response.pen(plan.cap, plan.order);
            takeCacheHits(plan, response);
            plan.queriesSkipped = plan.penBudget.overflow() == PenSeriesWriter.PenBudget.Overflow.PEN_CAP;
            boolean fallback = plan.raw() && req.aggregateOnTooManyPoints() && !plan.window.incremental();
            estimate += reservePoints(plan, plan.raw() ? estimator.rate(densityKey(plan)) : -1d,
                fallback ? 2L * s.historyPointCountMax() + 2 : 0L);
        }
        estimate = Math.min(estimate, s.historyMaxPointsPerResponse());
        PointBudget.Reservation reservation = budget.tryReserve(sid, estimate);
        if (reservation == null) {
            throw new Refused(ErrorCode.BUSY, 2, Limit.CAPACITY, 0L);
        }
        admission.attach(reservation);
        response.bindGrowth(reservation::grow, reservation.points());

        // 5. Data queries on the fair executor. The first piece of a full pen also looks up the anchor when the
        //    pen's data starts after the window start; a pen whose first piece is a cache hit gets its own task.
        //    The annotation queries (2b) run in the same submission, in parallel with the data.
        List<Callable<Object>> tasks = new ArrayList<>();
        List<Piece> taskPieces = new ArrayList<>();
        for (Callable<Object> a : annTasks) {
            tasks.add(a);
            taskPieces.add(null);
        }
        for (Plan plan : plans.values()) {
            Piece anchorPiece = null;
            if (req.includeAnchor() && !plan.window.incremental() && !plan.window.isEmpty() && !plan.pieces.isEmpty()) {
                plan.anchorWanted = true;
                plan.anchor = anchors.get(plan.nk, plan.check.historyProvider(), plan.window.from());
                Piece first = plan.pieces.get(0);
                if (plan.anchor == null && first.isQuery()) {
                    anchorPiece = first;
                } else if (plan.anchor == null
                    && anchorNeeded(plan.agg, firstIn(first.cached.t, first.cached.count(), plan.window), plan.window.from())) {
                    tasks.add(tracked(admission, anchorTask(mgr, plan)));
                    taskPieces.add(null);
                }
                if (plan.queriesSkipped && anchorPiece != null) {
                    // No data query runs for this pen, but its fallback still wants the anchor.
                    tasks.add(tracked(admission, anchorTask(mgr, plan)));
                    taskPieces.add(null);
                }
            }
            if (plan.queriesSkipped) {
                continue;
            }
            for (Piece piece : plan.pieces) {
                if (piece.isQuery()) {
                    tasks.add(tracked(admission, dataTask(mgr, plan, piece, piece == anchorPiece)));
                    taskPieces.add(piece);
                }
            }
        }
        Optional<List<Future<Object>>> submitted = executor.submitAll(sid, tasks);
        if (submitted.isEmpty()) {
            throw new Refused(ErrorCode.TOO_MANY_REQUESTS, 1, Limit.QUEUE, 0L);
        }
        List<Future<Object>> futures = submitted.get();
        for (int i = 0; i < futures.size(); i++) {
            if (taskPieces.get(i) != null) {
                taskPieces.get(i).future = futures.get(i);
            }
        }
        awaitAll(futures, deadlineAt, response);
        for (Plan plan : plans.values()) {
            settle(plan, response, admission);
            observeDensity(plan);
        }
        refuseIfStarved(response);

        // 6. Repair the cut with the final first-phase counts, then the second phase (same deadline): re-runs of pens
        //    evicted for nothing, and the aggregated fallback of raw pens over their cap (onTooManyPoints:"aggregate").
        repairCut(plans.values(), response);
        secondPhase(req, plans.values(), mgr, sid, response, admission, deadlineAt, s);
        refuseIfStarved(response);

        // 6b. Freeze the response budget, then re-read every allowance. A fallback takes points in
        //     its pen's request order, so it can evict a later pen that settled as data in step 5; such a pen is
        //     tooManyPoints (limit = maxPointsPerResponse), never "ok" with its points missing. Once frozen, a zombie
        //     query (timed out above, still running) can take nothing and evict nobody, so the state read here is
        //     the state assembled below.
        response.freeze();
        for (Plan plan : plans.values()) {
            reconcile(plan);
        }

        // 7. Nothing finished → 504 / 502 (a pen whose pre-check timed out has not finished either).
        boolean finished = req.pens().isEmpty();
        boolean anyTimeout = false;
        for (HistoryResult.Pen f : fixed.values()) {
            boolean timedOut = HistoryResult.TIMEOUT.equals(f.status());
            finished |= !timedOut;
            anyTimeout |= timedOut;
        }
        for (Plan plan : plans.values()) {
            finished |= plan.finalStatus == null || HistoryResult.TOO_MANY_POINTS.equals(plan.finalStatus);
            anyTimeout |= HistoryResult.TIMEOUT.equals(plan.finalStatus);
        }
        if (!finished) {
            throw new Failed(anyTimeout ? ErrorCode.TIMEOUT : ErrorCode.HISTORY_QUERY_FAILED);
        }

        // 8. Assemble in request order. Pens asking for the same data share one stored series but are each written
        //    out, so the response cap (maxPointsPerResponse) is charged per pen here, in request order: the first pen
        //    that does not fit and every data pen after it → tooManyPoints.
        List<HistoryResult.Pen> pens = new ArrayList<>(req.pens().size());
        long served = 0;
        boolean capped = false;
        long maxResponse = s.historyMaxPointsPerResponse();
        for (HistoryRequest.Pen p : req.pens()) {
            HistoryResult.Pen f = fixed.get(p.key());
            if (f != null) {
                pens.add(f);
                continue;
            }
            Plan plan = planByPen.get(p.key());
            HistoryResult.Pen out = assemble(p.key(), plan, s, debug);
            if (HistoryResult.OK.equals(out.status()) && out.count() > 0) {
                if (capped || served + out.count() > maxResponse) {
                    capped = true;
                    out = responseCapped(p.key(), plan, s);
                } else {
                    served += out.count();
                }
            }
            pens.add(out);
        }

        attachAnnotations(pens, annProviderByPen, annKeyByPen, annResults, req, s);

        long hits = 0;
        long misses = 0;
        int queries = 0;
        long rows = 0;
        for (Plan plan : plans.values()) {
            hits += plan.cacheHits;
            misses += plan.cacheMisses;
            for (Piece piece : plan.pieces) {
                if (piece.isQuery()) {
                    queries++;
                    rows += piece.writer == null ? 0 : piece.writer.rows();
                }
            }
        }
        long elapsed = System.currentTimeMillis() - t0;
        HistoryResult.DebugStats ds = debug ? new HistoryResult.DebugStats(hits, misses, queries, rows) : null;
        HistoryResult r = req.raw()
            ? new HistoryResult(req.requestId(), System.currentTimeMillis(), req.start(), req.dataEnd(), req.mode(), null,
                null, false, false, pens, elapsed, ds)
            : new HistoryResult(req.requestId(), System.currentTimeMillis(), req.alignedStart(), req.alignedEnd(), req.mode(),
                req.aggregation().name(), req.bucketMs(), true, req.downgraded(), pens, elapsed, ds);
        LOG.debugf("history session=%s pens=%d span=%d mode=%s ms=%d points=%d queries=%d cacheHits=%d cacheMisses=%d",
            sid, pens.size(), req.end() - req.start(), req.mode(), elapsed, r.points(), queries, hits, misses);
        return r;
    }

    // ---- annotations -----------------------------------------------------------------------------------------

    /**
     * One historian's annotation query for the paths of all its pens, from {@code from} (the look-back) to the
     * request's end, bounded per pen to the request window and {@code maxPerPen}; the result lands in
     * {@code out}. Package-private for the stub-historian unit test.
     */
    static Callable<Object> annotationTask(AnnotationService svc, TagHistoryManager mgr, String provider,
                                           Map<String, TagPath> paths, long from, HistoryRequest req, int maxPerPen,
                                           Map<String, AnnotationService.QueryResult> out) {
        return () -> {
            out.put(provider, svc.query(mgr, provider, paths, from, req.end(), req.annotationTypes(), req.start(),
                req.end(), maxPerPen));
            return null;
        };
    }

    /**
     * Adds each pen's annotations (those overlapping the request window, at most {@code ctg.annotations.maxPerPen})
     * and {@code annotationsStatus}. A historian whose query did not finish before the deadline is {@code error}.
     * Package-private for the stub-historian unit test.
     */
    static void attachAnnotations(List<HistoryResult.Pen> pens, Map<String, String> providerByPen,
                                  Map<String, String> keyByPen, Map<String, AnnotationService.QueryResult> results,
                                  HistoryRequest req, ModuleSettings.Settings s) {
        if (providerByPen.isEmpty()) {
            return;
        }
        for (HistoryResult.Pen pen : pens) {
            String provider = providerByPen.get(pen.key());
            if (provider == null) {
                continue;
            }
            AnnotationService.QueryResult r = results.get(provider);
            if (r == null) {
                pen.withAnnotations(AnnotationService.STATUS_ERROR, List.of(), false);
            } else if (!AnnotationService.STATUS_OK.equals(r.status())) {
                pen.withAnnotations(r.status(), List.of(), false);
            } else {
                String nk = keyByPen.get(pen.key());
                AnnotationService.Window w = AnnotationService.forWindow(r.of(nk), req.start(), req.end(),
                    s.annotationsMaxPerPen());
                pen.withAnnotations(AnnotationService.STATUS_OK, w.items(), w.truncated() || r.truncated(nk));
            }
        }
    }

    /**
     * {@code annotationsOnly:true}: the pens' statuses from steps 1–2, the annotation queries alone
     * (no plans, no point reservation, no data), status {@code ok} with no points for every pen that passed the
     * pre-check.
     */
    private HistoryResult annotationsOnly(HistoryRequest req, long t0, Map<String, HistoryResult.Pen> fixed,
                                          Map<String, TagPath> pathByPen, Map<String, ReadPermissionCache.Check> checks,
                                          List<Callable<Object>> annTasks, Map<String, String> providerByPen,
                                          Map<String, String> keyByPen, Map<String, AnnotationService.QueryResult> results,
                                          UUID sid, long deadlineAt, ModuleSettings.Settings s) throws Failed, Refused {
        Optional<List<Future<Object>>> submitted = executor.submitAll(sid, annTasks);
        if (submitted.isEmpty()) {
            throw new Refused(ErrorCode.TOO_MANY_REQUESTS, 1, Limit.QUEUE, 0L);
        }
        awaitAll(submitted.get(), deadlineAt);
        List<HistoryResult.Pen> pens = new ArrayList<>(req.pens().size());
        for (HistoryRequest.Pen p : req.pens()) {
            HistoryResult.Pen f = fixed.get(p.key());
            if (f != null) {
                pens.add(f);
                continue;
            }
            TagPath path = pathByPen.get(p.key());
            ReadPermissionCache.Check c = checks.get(TagPaths.normalizedKey(path));
            if (c == null) {
                pens.add(HistoryResult.Pen.empty(p.key(), path.toStringFull(), HistoryResult.TIMEOUT));
            } else if (!c.ok()) {
                pens.add(HistoryResult.Pen.empty(p.key(), path.toStringFull(), c.status()).withDataType(c.dataType()));
            } else {
                pens.add(HistoryResult.Pen.empty(p.key(), path.toStringFull(), HistoryResult.OK).withDataType(c.dataType()));
            }
        }
        attachAnnotations(pens, providerByPen, keyByPen, results, req, s);
        long elapsed = System.currentTimeMillis() - t0;
        LOG.debugf("history annotationsOnly session=%s pens=%d historians=%d ms=%d", sid, pens.size(), annTasks.size(),
            elapsed);
        return new HistoryResult(req.requestId(), System.currentTimeMillis(), req.start(), req.dataEnd(), req.mode(), null,
            null, false, false, pens, elapsed, null);
    }

    // ---- planning --------------------------------------------------------------------------------------------

    private Plan newPlan(TagPath path, String nk, ReadPermissionCache.Check c, AggregationMode agg, HistoryRequest req,
                         HistoryRequest.PenWindow w, ModuleSettings.Settings s) {
        Plan plan = new Plan(path, nk, c, agg, agg == null ? null : req.bucketMs(), w);
        plan.serverNow = req.serverNow();
        plan.cap = agg == null ? req.rawCapPerPen() : 0;
        if (w.isEmpty()) {
            return plan;
        }
        long sealedBefore = req.serverNow() - s.historySealMarginMs();
        if (!cache.enabled() || w.from() >= sealedBefore) {
            plan.pieces.add(new Piece(w.from(), w.to(), null));
        } else if (agg != null) {
            planAggregatedChunks(plan, sealedBefore, cache);
        } else {
            planRawChunks(plan, sealedBefore, cache);
        }
        return plan;
    }

    /**
     * Aggregated windows: chunks of {@value #AGG_CHUNK_BUCKETS} buckets. A sealed chunk inside the window is served from
     * or admitted to the cache. A sealed chunk the window covers only partly is taken from the cache when it is there;
     * otherwise it is fetched (and cached) whole only when the window covers at least 3/4 of it, so pans at the same
     * zoom level reuse it — else only the covered part is queried (and cached under an exact-range key, so an identical
     * repeat still hits). That bounds the over-fetch to 1/4 chunk per edge (≤ 250 buckets per window; always fetching
     * whole chunks could cost up to 1300 buckets for a 300-bucket window). The rest of the window (live edge) is one
     * query.
     */
    static void planAggregatedChunks(Plan plan, long sealedBefore, HistoryChunkCache cache) {
        long b = plan.bucketMs;
        long chunkMs = b * AGG_CHUNK_BUCKETS;
        long from = plan.window.from();
        long to = plan.window.to();
        for (long cs = BucketLadder.alignDown(from, chunkMs); cs < to; cs += chunkMs) {
            long ce = cs + chunkMs;
            if (ce <= sealedBefore) {
                HistoryChunkCache.Key key = new HistoryChunkCache.Key(plan.nk, plan.check.historyProvider(), plan.agg.name(),
                    b, chunkMs, cs);
                long covered = Math.min(ce, to) - Math.max(cs, from);
                if (covered >= chunkMs || covered * AGG_OVERFETCH_MIN_COVER_DEN >= chunkMs * AGG_OVERFETCH_MIN_COVER_NUM) {
                    addChunk(plan, cs, ce, key, cache);
                } else {
                    HistoryChunkCache.Chunk hit = cache.get(key);
                    if (hit != null) {
                        plan.cacheHits++;
                        plan.pieces.add(new Piece(cs, ce, hit));
                    } else {
                        // Only the covered part is queried; it is cached under its own exact-range key (chunkMs =
                        // the part's length, always < a whole chunk, so it never collides with a whole-chunk key):
                        // an identical repeat is a full hit, a pan at the same zoom falls back to a query.
                        long ps = Math.max(cs, from);
                        long pe = Math.min(ce, to);
                        addChunk(plan, ps, pe, new HistoryChunkCache.Key(plan.nk, plan.check.historyProvider(),
                            plan.agg.name(), b, pe - ps, ps), cache);
                    }
                }
            } else {
                addOpenRange(plan, Math.max(cs, from), to);
                break;
            }
        }
    }

    /**
     * Raw windows: the smallest chunk of {1 h, 6 h, 1 d} giving ≤ {@value #MAX_RAW_CHUNKS} chunks. Only sealed chunks
     * lying entirely inside the window are cached (raw chunks are small against the window, so the edges are cheap
     * to query; over-fetching raw data would count against the per-pen cap).
     */
    static void planRawChunks(Plan plan, long sealedBefore, HistoryChunkCache cache) {
        long from = plan.window.from();
        long to = plan.window.to();
        long chunkMs = rawChunkMs(to - from);
        for (long cs = BucketLadder.alignDown(from, chunkMs); cs < to; cs += chunkMs) {
            long ce = cs + chunkMs;
            if (cs >= from && ce <= to && ce <= sealedBefore) {
                addChunk(plan, cs, ce, new HistoryChunkCache.Key(plan.nk, plan.check.historyProvider(), null, 0, chunkMs, cs),
                    cache);
            } else {
                addOpenRange(plan, Math.max(cs, from), Math.min(ce, to));
            }
        }
    }

    /** Raw chunk size for a window of {@code span} ms. */
    static long rawChunkMs(long span) {
        for (long c : RAW_CHUNKS) {
            if (BucketLadder.ceilDiv(span, c) <= MAX_RAW_CHUNKS) {
                return c;
            }
        }
        return RAW_CHUNKS[RAW_CHUNKS.length - 1];
    }

    private static void addChunk(Plan plan, long cs, long ce, HistoryChunkCache.Key key, HistoryChunkCache cache) {
        HistoryChunkCache.Chunk hit = cache.get(key);
        if (hit != null) {
            plan.cacheHits++;
            plan.pieces.add(new Piece(cs, ce, hit));
            return;
        }
        plan.cacheMisses++;
        Piece miss = new Piece(cs, ce, null);
        miss.slots.add(new Slot(key, cs, ce));
        plan.pieces.add(miss);
    }

    /** Appends a not-cacheable range, merged into the previous piece when that is a plain query ending at {@code from}. */
    private static void addOpenRange(Plan plan, long from, long to) {
        if (to <= from) {
            return;
        }
        Piece last = plan.pieces.isEmpty() ? null : plan.pieces.get(plan.pieces.size() - 1);
        if (last != null && last.isQuery() && last.slots.isEmpty() && last.to == from) {
            plan.pieces.set(plan.pieces.size() - 1, new Piece(last.from, to, null));
        } else {
            plan.pieces.add(new Piece(from, to, null));
        }
    }

    /**
     * Rows an aggregated plan may hold: one per bucket of every piece (two for MinMax; over-fetched cache chunks
     * included) + 2 slack per query. A historian that returns more trips the cap ({@code tooManyPoints}).
     */
    static long aggregatedCap(Plan plan) {
        long buckets = 0;
        long queries = 0;
        for (Piece p : plan.pieces) {
            buckets += (p.to - p.from) / plan.bucketMs;
            queries += p.isQuery() ? 1 : 0;
        }
        return buckets * (plan.agg == AggregationMode.MinMax ? 2 : 1) + 2 * Math.max(1, queries);
    }

    /**
     * Plan cost cap ({@code ctg.history.maxTasksPerRequest}): first merge each plan's adjacent query pieces, then each
     * plan's whole query span into one query (cache hits inside it are re-fetched), then refuse.
     */
    static void enforcePlanCost(Iterable<Plan> plans, int maxTasks) throws Failed {
        if (countQueries(plans) <= maxTasks) {
            return;
        }
        for (Plan plan : plans) {
            List<Piece> merged = new ArrayList<>();
            for (Piece p : plan.pieces) {
                Piece last = merged.isEmpty() ? null : merged.get(merged.size() - 1);
                if (last != null && last.isQuery() && p.isQuery() && last.to == p.from) {
                    Piece m = new Piece(last.from, p.to, null);
                    m.slots.addAll(last.slots);
                    m.slots.addAll(p.slots);
                    merged.set(merged.size() - 1, m);
                } else {
                    merged.add(p);
                }
            }
            plan.pieces.clear();
            plan.pieces.addAll(merged);
        }
        if (countQueries(plans) <= maxTasks) {
            return;
        }
        for (Plan plan : plans) {
            Piece first = null;
            Piece last = null;
            for (Piece p : plan.pieces) {
                if (p.isQuery()) {
                    first = first == null ? p : first;
                    last = p;
                }
            }
            if (first == null || first == last) {
                continue;
            }
            Piece span = new Piece(first.from, last.to, null);
            List<Piece> kept = new ArrayList<>();
            for (Piece p : plan.pieces) {
                if (p.isQuery()) {
                    span.slots.addAll(p.slots);
                } else if (p.to <= span.from || p.from >= span.to) {
                    kept.add(p);                    // hits outside the merged span stay hits
                } else {
                    plan.cacheHits--;               // re-fetched inside the span
                }
            }
            kept.add(span);
            kept.sort((a, b) -> Long.compare(a.from, b.from));
            plan.pieces.clear();
            plan.pieces.addAll(kept);
        }
        if (countQueries(plans) > maxTasks) {
            throw new Failed(ErrorCode.RANGE_TOO_LARGE);
        }
    }

    static int countQueries(Iterable<Plan> plans) {
        int n = 0;
        for (Plan plan : plans) {
            for (Piece p : plan.pieces) {
                n += p.isQuery() ? 1 : 0;
            }
        }
        return n;
    }

    // ---- tasks -----------------------------------------------------------------------------------------------

    /**
     * One historian query for one piece: fills the piece's writer, admits its sealed chunks to the cache and, for the
     * first piece of a full pen, looks up the anchor when the data starts after the window start.
     */
    private Callable<Object> dataTask(TagHistoryManager mgr, Plan plan, Piece piece, boolean anchorHere) {
        piece.writer = new PenSeriesWriter(piece.from, piece.to, plan.filter, !plan.raw(), plan.agg == AggregationMode.MinMax,
            plan.penBudget);
        return () -> {
            if (debugDelay()) {
                return null;                    // interrupted while delayed (test hook)
            }
            PenSeriesWriter w = piece.writer;
            if (plan.raw()) {
                rawQuery(mgr, plan.path, piece.from, piece.to, w);
            } else {
                aggregatedPiece(mgr, plan, piece.from, piece.to, plan.bucketMs, plan.agg, w);
            }
            w.finish();                         // idempotent: a lone buffered MinMax row is emitted
            if (w.error() != null) {
                throw w.error();
            }
            if (w.keptAll() && w.cacheable()) {
                admitSettled(mgr, plan, piece, w);
            }
            if (anchorHere && anchorNeeded(plan.agg, w.firstTime(), plan.window.from())) {
                plan.anchor = safeAnchor(mgr, plan.path, plan.nk, plan.check.historyProvider(), plan.window.from(),
                    plan.check.isBoolean());
            }
            return null;
        };
    }

    /**
     * Admits the piece's sealed slots to the chunk cache — only those the historian has <b>settled</b>.
     * <p>
     * "Sealed" is a time rule ({@code ce <= serverNow - sealMarginMs}), but Core Historian's analog compression (the
     * default for Float tags) holds the newest value back until the next change and meanwhile interpolates later
     * buckets toward the live value; when the next value arrives, the held one is stored at its original time and the
     * past answers change. A chunk cached before that would serve the old line to every session for up to 30 min. A
     * chunk is therefore admitted only when a <em>stored</em> raw sample exists at or after its end: from this piece's
     * own raw rows when it has one there, else from one look-up per plan of the newest stored sample before now
     * ({@link #lastStored}). Without such proof the chunk is answered but not cached.
     * <p>
     * The query has ended, so the columns are final; storedCount() rather than count(): this pen can still be evicted
     * by an earlier pen right now, and the cache must get the data, not an empty chunk. A timed-out pen's zombie that
     * kept everything within its own cap (cache-only, see settle) fills it too. Package-private for JUnit.
     */
    void admitSettled(TagHistoryManager mgr, Plan plan, Piece piece, PenSeriesWriter w) {
        if (piece.slots.isEmpty()) {
            return;
        }
        int n = w.storedCount();
        long ownLast = plan.raw() && n > 0 ? w.t()[n - 1] : Long.MIN_VALUE;
        long settledUntil = ownLast;
        for (Slot slot : piece.slots) {
            if (slot.to > settledUntil) {
                settledUntil = Math.max(ownLast, lastStored(mgr, plan));
                break;
            }
        }
        for (Slot slot : piece.slots) {
            if (slot.to > settledUntil) {
                continue;                       // not provably settled: right for now, never cached
            }
            int a = lowerBound(w.t(), 0, n, slot.from);
            int b = lowerBound(w.t(), a, n, slot.to);
            cache.put(slot.key, w.t(), w.v(), a, b);
        }
    }

    /** The chunk cache (JUnit). */
    HistoryChunkCache chunkCache() {
        return cache;
    }

    /**
     * Time of the newest stored raw sample of the plan's tag before the request's server time ({@code Long.MIN_VALUE}
     * when there is none within a day or the look-up failed), looked up once per plan. Raw queries return stored samples
     * only — a value Core Historian still holds back under analog compression is not among them.
     */
    private long lastStored(TagHistoryManager mgr, Plan plan) {
        synchronized (plan) {
            if (plan.lastStored == null) {
                long t = Long.MIN_VALUE;
                boolean known = true;
                try {
                    AnchorCache.Anchor a = findAnchor(mgr, plan.path, plan.serverNow + 1,
                        PenSeriesWriter.ValueFilter.of(plan.check.isBoolean(), null));
                    if (a != null && a != AnchorCache.NONE) {
                        t = a.t();
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    known = false;
                } catch (Exception | LinkageError e) {
                    LOG.debugf("history settled-check failed for %s: %s", Json.sanitizeForLog(plan.nk), e.toString());
                    known = false;
                }
                if (!known) {
                    return Long.MIN_VALUE;          // not remembered: a later piece may try again
                }
                plan.lastStored = t;
            }
            return plan.lastStored;
        }
    }

    /** Anchor-only task (the pen's first piece is a cache hit that starts after the window start). */
    private Callable<Object> anchorTask(TagHistoryManager mgr, Plan plan) {
        return () -> {
            plan.anchor = safeAnchor(mgr, plan.path, plan.nk, plan.check.historyProvider(), plan.window.from(),
                plan.check.isBoolean());
            return null;
        };
    }

    /**
     * Wraps a task so the request's point reservation stays until the task really ended ({@link Admission}); a task
     * that starts after the request was closed skips its query.
     */
    private static Callable<Object> tracked(Admission admission, Callable<Object> task) {
        return () -> {
            if (!admission.enterTask()) {
                return null;
            }
            try {
                return task.call();
            } finally {
                admission.exitTask();
            }
        };
    }

    /**
     * The anchor for a window starting at {@code before}, never failing the pen: a failed look-up is "no anchor"
     * (not cached) with a rate-limited WARN — the pen's own data query succeeded.
     */
    private AnchorCache.Anchor safeAnchor(TagHistoryManager mgr, TagPath path, String nk, String provider, long before,
                                          boolean isBoolean) {
        try {
            return anchorBefore(mgr, path, nk, provider, before, isBoolean);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        } catch (Exception | LinkageError e) {
            warnings.warn("history.anchor", "History anchor look-up failed (" + e.getClass().getSimpleName() + ")", e);
            return null;
        }
    }

    /**
     * The last raw sample before {@code before} ({@link AnchorCache#NONE}: none within a day), cached. A cached answer
     * for an earlier time of the same tag (up to {@link #ANCHOR_EXTEND_MAX_MS} before) is extended with one raw query
     * over the gap instead of a full look-up — realtime windows start a little later on every full load, so exact
     * look-ups alone would fill the anchor cache with one entry per realtime start.
     */
    AnchorCache.Anchor anchorBefore(TagHistoryManager mgr, TagPath path, String nk, String provider, long before,
                                    boolean isBoolean) throws Exception {
        AnchorCache.Lookup l = anchors.lookup(nk, provider, before, ANCHOR_EXTEND_MAX_MS);
        if (l.exact() != null) {
            return l.exact();
        }
        PenSeriesWriter.ValueFilter rawFilter = PenSeriesWriter.ValueFilter.of(isBoolean, null);
        if (l.base() != null) {
            LastRowWriter gap = new LastRowWriter(l.baseBefore(), before, rawFilter);
            rawQuery(mgr, path, l.baseBefore(), before, gap);
            AnchorCache.Anchor a = gap.found() ? gap.anchor() : l.base();
            anchors.putExtended(nk, provider, before, a, l);
            return a;
        }
        AnchorCache.Anchor a = findAnchor(mgr, path, before, rawFilter);
        anchors.put(nk, provider, before, a);
        return a;
    }

    /**
     * Whether a full pen gets the anchor (the last raw sample before the window). Raw: when its data starts after the
     * window start (the line enters from the left edge). Aggregated, value aggregations: always — the first bucket
     * starts at the window start but the chart draws it at the bucket end (LastValue) or middle, so without the anchor
     * the series would never reach the left edge (up to one bucket blank) and the value held at the window start would
     * be missing from the statistics. Statistic aggregations (Count, DurationOn, Range…) never take a
     * raw value as their anchor: it is not in their domain.
     */
    static boolean anchorNeeded(AggregationMode agg, long firstTime, long from) {
        if (firstTime > from) {
            return agg == null || valueAggregation(agg);
        }
        return agg != null && valueAggregation(agg);
    }

    /** Aggregations whose buckets carry the tag's own values (LastValue, averages, Minimum, Maximum, MinMax). */
    static boolean valueAggregation(AggregationMode agg) {
        switch (agg) {
            case LastValue:
            case SimpleAverage:
            case Average:
            case Minimum:
            case Maximum:
            case MinMax:
                return true;
            default:
                return false;
        }
    }

    /**
     * Boolean aggregates Core Historian leaves unseeded in buckets before the first sample of the query range
     * (LastValue / Maximum / Sum return garbage or a varying 0/1 there). Not Count and MinMax (seeded), and not the
     * state and quality aggregates DurationOn/Off, CountOn/Off, PctGood/Bad: the historian computes those from the
     * state it carries into the range — stable and correct on repeated identical queries (a steady ON pump gives
     * DurationOn = bucket seconds, CountOn 0, PctGood 0.9999 every time) — and dropping them would blank a pump that
     * ran all shift. Their rows still pass the count-like range filter.
     */
    static boolean unseededForBoolean(AggregationMode agg) {
        switch (agg) {
            case Count:
            case MinMax:
            case DurationOn:
            case DurationOff:
            case CountOn:
            case CountOff:
            case PctGood:
            case PctBad:
                return false;
            default:
                return true;
        }
    }

    /**
     * The value of an unseeded bucket that follows from the Count probe alone, null when there is none: a bucket
     * with no sample has {@code Sum} 0 (dropping those buckets instead would cost a Boolean Sum pen every bucket before
     * its first in-range sample).
     */
    static Double probeValue(AggregationMode agg) {
        return agg == AggregationMode.Sum ? 0.0 : null;
    }

    /** Aggregates whose value for a bucket without samples is the value the tag held (the seed). */
    static boolean seedFills(AggregationMode agg) {
        switch (agg) {
            case LastValue:
            case Minimum:
            case Maximum:
            case Average:
            case SimpleAverage:
                return true;
            default:
                return false;
        }
    }

    /**
     * One aggregated query for a pen piece. Boolean pens (see {@link PenSeriesWriter}, "Unseeded Boolean buckets"): a
     * {@code Count} query on the same grid finds the first bucket holding a sample; the buckets before it take the
     * value of the last sample before {@code from} (value aggregates) or are dropped (other aggregates, or no sample
     * within a day). Deterministic, so the chunk cache only ever holds clean data.
     */
    private void aggregatedPiece(TagHistoryManager mgr, Plan plan, long from, long to, long bucketMs, AggregationMode agg,
                                 PenSeriesWriter w) throws Exception {
        if (plan.check.isBoolean() && unseededForBoolean(agg)) {
            long first = firstSampleBucket(mgr, plan.path, from, to, bucketMs);
            Double fixed = probeValue(agg);
            if (first > from && fixed != null) {
                w.unseededBefore(first, true, fixed);
            } else if (first > from) {
                // A failed seed look-up drops the unseeded buckets (no made-up values either way).
                AnchorCache.Anchor seed = seedFills(agg)
                    ? safeAnchor(mgr, plan.path, plan.nk, plan.check.historyProvider(), from, true) : null;
                boolean hasSeed = seed != null && seed != AnchorCache.NONE;
                w.unseededBefore(first, hasSeed, hasSeed ? seed.v() : Double.NaN);
                if (seedFills(agg) && seed == null) {
                    w.notCacheable();               // look-up failed: right for now, but never cached for 30 min
                }
            }
        }
        aggregatedQuery(mgr, plan.path, from, to, bucketMs, agg, w);
    }

    /**
     * Start of the first bucket of {@code [from, to)} (grid {@code bucketMs}) holding at least one sample, from a
     * {@code Count} query (reliable for Boolean tags: empty buckets read 0); {@code to} when there is none.
     */
    private static long firstSampleBucket(TagHistoryManager mgr, TagPath path, long from, long to, long bucketMs)
            throws Exception {
        FirstCountWriter fc = new FirstCountWriter(from, to);
        aggregatedQuery(mgr, path, from, to, bucketMs, AggregationMode.Count, fc);
        return fc.first();
    }

    /** Keeps the earliest bucket start with a plausible count &gt; 0 (O(1) memory). */
    static final class FirstCountWriter implements StreamingDatasetWriter {
        private final long lo;
        private final long hi;
        private int valueCol = 1;
        private long first;
        private Exception error;

        FirstCountWriter(long lo, long hi) {
            this.lo = lo;
            this.hi = hi;
            this.first = hi;
        }

        @Override
        public void initialize(String[] names, Class<?>[] types, boolean qualityColumns, int expectedRows) {
            valueCol = names != null && names.length > 1 ? 1 : 0;
        }

        @Override
        public void write(Object[] row, QualityCode[] qualities) {
            if (row == null || row.length <= valueCol) {
                return;
            }
            Object tv = row[0];
            long ts = tv instanceof Date ? ((Date) tv).getTime() : tv instanceof Number ? ((Number) tv).longValue() : Long.MIN_VALUE;
            if (ts < lo || ts >= hi || ts >= first) {
                return;
            }
            Object raw = row[valueCol];
            double d = raw instanceof Number ? ((Number) raw).doubleValue() : Double.NaN;
            QualityCode q = qualities != null && qualities.length > valueCol ? qualities[valueCol] : null;
            if (d > 0 && d <= 1e12 && !TagPaths.isNotFound(q)) {
                first = ts;
            }
        }

        @Override
        public void finish() {
        }

        @Override
        public void finishWithError(Exception e) {
            error = e == null ? new IllegalStateException("history query failed") : e;
        }

        long first() throws Exception {
            if (error != null) {
                throw error;
            }
            return first;
        }
    }

    /**
     * Test hook: sleeps {@code ctg.debug.historyDelayMs} while {@code ctg.debug} is on.
     *
     * @return true when the task was interrupted while sleeping (module stopping): skip the query
     */
    private boolean debugDelay() {
        if (!services.debugEnabled()) {
            return false;
        }
        long ms;
        try {
            ms = Long.parseLong(System.getProperty(DEBUG_DELAY_PROPERTY, "0").trim());
        } catch (NumberFormatException e) {
            return false;
        }
        if (ms <= 0) {
            return false;
        }
        try {
            Thread.sleep(Math.min(ms, 60_000L));
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return true;
        }
    }

    /**
     * {@link #awaitAll(List, long)} for a data phase: once the request starves ({@link ResponseBudget#onStarve}) its
     * tasks that have not started are cancelled at once, not at the deadline (a starved request answers BUSY anyway;
     * its remaining historian queries would only add load to a contended gateway). A
     * cancelled piece settles as timed out, so the pen's density observation is incomplete (raise only).
     */
    private void awaitAll(List<? extends Future<?>> futures, long deadlineAt, ResponseBudget response) throws Failed {
        response.onStarve(() -> {
            int n = executor.cancelUnstarted(futures);
            if (n > 0) {
                starvedCancelled.addAndGet(n);
            }
        });
        try {
            awaitAll(futures, deadlineAt);
        } finally {
            response.onStarve(null);
        }
    }

    /** Waits for every future until the deadline, then cancels what has not started. */
    private void awaitAll(List<? extends Future<?>> futures, long deadlineAt) throws Failed {
        for (Future<?> f : futures) {
            long remaining = deadlineAt - System.currentTimeMillis();
            if (remaining <= 0) {
                break;
            }
            try {
                f.get(remaining, TimeUnit.MILLISECONDS);
            } catch (TimeoutException e) {
                break;
            } catch (ExecutionException | CancellationException e) {
                // recorded per piece by settle()
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                executor.cancelUnstarted(futures);
                throw new Failed(ErrorCode.MODULE_STOPPING);
            }
        }
        executor.cancelUnstarted(futures);
    }

    /**
     * Records each query piece's outcome and derives the plan's status. A pen that timed out or failed sends no data,
     * so its allowance is retired: its points go back to the request and its zombie queries can no longer evict a
     * later pen.
     *
     * <p>A timed-out pen whose query is still running and would fill sealed cache chunks becomes a <em>cache-only</em>
     * zombie when the global point budget can hold what it may keep: it keeps storing outside the
     * response budget, and its chunks enter the cache when the query ends, so the client's retry of a slow sealed
     * range is a cache hit instead of the same slow query again. The extra reservation stays with the request's
     * admission until its last task ended. What it may keep is {@link #cacheOnlyLimit} — what it stored so far plus
     * what its still-running cacheable pieces can hold — not its whole per-pen cap (reserving the whole cap, a zombie
     * filling one 1-hour chunk would hold 250 000 points globally and could turn other sessions' requests into
     * {@code BUSY}).
     */
    private void settle(Plan plan, ResponseBudget response, Admission admission) {
        if (plan.queriesSkipped) {
            plan.finalStatus = HistoryResult.TOO_MANY_POINTS;
            return;
        }
        boolean timeout = false;
        boolean error = false;
        boolean warmsCache = false;
        for (Piece piece : plan.pieces) {
            if (!piece.isQuery()) {
                continue;
            }
            piece.status = outcome(piece.future, "history.query");
            timeout |= HistoryResult.TIMEOUT.equals(piece.status);
            error |= HistoryResult.ERROR.equals(piece.status);
            warmsCache |= HistoryResult.TIMEOUT.equals(piece.status) && !piece.slots.isEmpty() && piece.future != null
                && !piece.future.isDone();
        }
        plan.finalStatus = timeout ? HistoryResult.TIMEOUT : error ? HistoryResult.ERROR
            : plan.penBudget.isOver() ? HistoryResult.TOO_MANY_POINTS : null;
        if (plan.finalStatus != null && !HistoryResult.TOO_MANY_POINTS.equals(plan.finalStatus)) {
            long keep = 0L;
            if (warmsCache && !error && !plan.penBudget.isOver() && cache.enabled()) {
                long limit = cacheOnlyLimit(plan, plan.penBudget.stored(), cache.maxChunkPoints());
                if (limit > plan.penBudget.stored()) {
                    PointBudget.Reservation extra = budget.tryReserveOptional(admission.sessionId, limit);
                    if (extra != null) {
                        admission.attachExtra(extra);
                        keep = limit;
                    }
                }
            }
            response.retire(plan.penBudget, keep);
        }
    }

    /**
     * Points a cache-only zombie of {@code plan} may hold in total (pure; JUnit): {@code stored} (what its writers
     * already hold) plus, for every query piece that timed out while still running and fills cache chunks, what is
     * left of that piece's capacity ({@link #zombieCapacity}) minus what the piece already stored. Never above the
     * pen's own cap.
     */
    static long cacheOnlyLimit(Plan plan, long stored, long maxChunkPoints) {
        long room = 0L;
        for (Piece p : plan.pieces) {
            if (!p.isQuery() || p.slots.isEmpty() || !HistoryResult.TIMEOUT.equals(p.status) || p.future == null
                    || p.future.isDone()) {
                continue;
            }
            long held = p.writer == null ? 0L : p.writer.storedCount();
            room += Math.max(0L, zombieCapacity(plan, p, maxChunkPoints) - held);
        }
        return Math.min(plan.cap, stored + room);
    }

    /**
     * Rows one still-running query piece with cache slots (never none) may store so its chunks can still be cached.
     * <ul>
     *   <li>aggregated: its bucket rows (×2 for MinMax, +2 slack) — the whole piece, slots or not;</li>
     *   <li>raw: {@code maxChunkPoints} per cache slot (a larger chunk is never cached: {@code HistoryChunkCache.put}
     *       refuses it), <b>plus the rows of the piece outside its slots</b>. The writer stores every row of
     *       {@code [from, to)} — an open live-edge tail or a re-fetched hit merged into the piece by
     *       {@link #enforcePlanCost} included — so a capacity of the slots alone would make a zombie near the chunk
     *       maximum stop before its chunks were complete (and then nothing would be cached). Those rows are unknown up
     *       front; they are bounded at the same density, {@code maxChunkPoints} per slot length, which is the most a
     *       cacheable chunk of this piece can have anyway.</li>
     * </ul>
     */
    static long zombieCapacity(Plan plan, Piece p, long maxChunkPoints) {
        if (!plan.raw()) {
            return BucketLadder.ceilDiv(p.to - p.from, plan.bucketMs) * (plan.agg == AggregationMode.MinMax ? 2 : 1) + 2;
        }
        long perChunk = Math.max(0L, maxChunkPoints);
        long slotMs = 0L;
        for (Slot slot : p.slots) {
            slotMs += Math.max(0L, slot.to - slot.from);
        }
        long outsideMs = Math.max(0L, (p.to - p.from) - slotMs);
        long slotLen = slotMs / p.slots.size();             // raw slots of one plan share one chunk size
        long outside = outsideMs == 0L || slotLen <= 0L ? 0L : BucketLadder.ceilDiv(outsideMs, slotLen) * perChunk;
        return p.slots.size() * perChunk + outside;
    }

    /**
     * Takes a plan's cache hits from its allowance as one amount. When the hits alone exceed the pen's own cap
     * the pen is over its cap before any query: nothing is taken (holding those points would evict later pens for a
     * pen that gives them back anyway) and its data queries are skipped.
     */
    static void takeCacheHits(Plan plan, ResponseBudget response) {
        long hits = 0;
        for (Piece piece : plan.pieces) {
            if (!piece.isQuery()) {
                hits += inWindow(piece.cached.t, piece.cached.count(), plan.window);
            }
        }
        if (hits > plan.cap) {
            response.overOwnCap(plan.penBudget);
        } else if (hits > 0) {
            plan.penBudget.take(hits);
        }
    }

    // =========================================================================================================
    // Realistic reservations
    // =========================================================================================================

    /**
     * Points to reserve in the global {@link PointBudget} for one plan (pure; JUnit), realistic instead of worst case
     * ({@link PointEstimator}):
     * <ul>
     *   <li>aggregated: the plan's row cap — its bucket grid is known exactly ({@link #aggregatedCap});</li>
     *   <li>raw, over its own cap from cache hits alone ({@code queriesSkipped}): only what its aggregated fallback may
     *       hold ({@code fallbackPoints}, 0 without {@code onTooManyPoints:"aggregate"});</li>
     *   <li>raw, density unknown ({@code rate < 0}): the worst case, {@code max(cap, fallbackPoints)} — the safe
     *       fallback — unless the queried ranges add up to at most 1 h: then the estimate at the 1 pt/s floor
     *       ({@link PointEstimator#unknownRate}, so a 1-pen × 1-h raw chart is a small request in
     *       {@link PointBudget} even for a tag nobody queried yet);</li>
     *   <li>raw, density known: the cache hits in the window (exact) plus the estimate for the queried ranges
     *       ({@link PointEstimator#estimate}); an estimate reaching the cap expects the fallback, so it reserves
     *       {@code max(cap, fallbackPoints)} like an unknown tag.</li>
     * </ul>
     * A too small estimate is not a correctness problem: the request's {@link ResponseBudget} grows the reservation
     * while it runs, or ends the request with {@code BUSY} when the gateway has no room.
     *
     * @param rate           the tag's remembered density (points per ms), -1 when unknown
     * @param fallbackPoints the most points the pen's aggregated fallback may hold (0: no fallback)
     */
    static long reservePoints(Plan plan, double rate, long fallbackPoints) {
        if (!plan.raw()) {
            return Math.max(0L, plan.cap);
        }
        if (plan.queriesSkipped) {
            return fallbackPoints;
        }
        long worst = Math.max(plan.cap, fallbackPoints);
        long hits = 0L;
        long queryMs = 0L;
        for (Piece p : plan.pieces) {
            if (p.isQuery()) {
                queryMs += Math.max(0L, Math.min(p.to, plan.window.to()) - Math.max(p.from, plan.window.from()));
            } else {
                hits += inWindow(p.cached.t, p.cached.count(), plan.window);
            }
        }
        double r = PointEstimator.unknownRate(rate, queryMs);
        if (r < 0d) {
            return worst;
        }
        long expected = queryMs == 0L ? hits : hits + PointEstimator.estimate(r, queryMs, plan.cap);
        return expected >= plan.cap ? worst : expected;
    }

    /** The density memory key of a plan's tag on its historian. */
    static String densityKey(Plan plan) {
        return PointEstimator.key(plan.nk, plan.check.historyProvider());
    }

    /**
     * Remembers the raw sample density a plan's first phase observed ({@link PointEstimator#observe}): the
     * densest of the whole window (every point the writers were offered, over-cap rows included) and of each piece
     * (a query's delivered rows, a cache hit's chunk). Complete when the queries finished — a pen over its cap still
     * counted every row. The estimator decides whether the observation may lower the remembered density (only a
     * complete one of at least 16 rows over at least a chunk's length, at most halving, at most once per 15 min),
     * floors a first observation of fewer than 1 024 rows at 1 pt/s, and ignores an incomplete one of a tag it does
     * not know.
     */
    private void observeDensity(Plan plan) {
        if (!plan.raw() || plan.queriesSkipped || plan.window.isEmpty()) {
            return;
        }
        boolean complete = plan.finalStatus == null || HistoryResult.TOO_MANY_POINTS.equals(plan.finalStatus);
        long windowMs = plan.window.to() - plan.window.from();
        long rows = plan.penBudget.wanted();
        double d = PointEstimator.density(rows, windowMs);
        for (Piece p : plan.pieces) {
            if (p.isQuery()) {
                if (p.writer != null) {
                    d = Math.max(d, PointEstimator.density(p.writer.rows(), p.to - p.from));
                }
            } else {
                d = Math.max(d, PointEstimator.density(p.cached.count(), p.to - p.from));
            }
        }
        estimator.observe(densityKey(plan), d, complete, windowMs, rows);
    }

    /**
     * A growth of the request's reservation did not fit the global point budget ({@link ResponseBudget} "Growth"):
     * the request stopped storing, so it is answered 503 {@code BUSY} with {@code Retry-After} like a refused
     * admission. Its running queries keep the reservation until they end (the {@link Admission}).
     */
    private static void refuseIfStarved(ResponseBudget response) throws Refused {
        if (response.starved()) {
            throw new Refused(ErrorCode.BUSY, 2, Limit.CAPACITY, 0L);
        }
    }

    /**
     * Decides the response cut from the final first-phase counts (the first pen that does not fit and every pen after
     * it, in request order, → tooManyPoints). Walks the plans in request order with {@code maxPointsPerResponse} as
     * room:
     * <ul>
     *   <li>timed out / failed: sends nothing, skipped;</li>
     *   <li>data: its stored points are final and take room;</li>
     *   <li>over its own cap (also an evicted pen whose writers wanted more than its cap, {@link
     *       ResponseBudget#reclassify}): its fallback (if any) runs in the second phase, bounded by its bucket grid and
     *       charged there in request order — counted as 0 here (optimistic: at worst a re-run is wasted, never a pen
     *       refused that fits);</li>
     *   <li>evicted by the response cap: its exact demand is known ({@link PenSeriesWriter.PenBudget#wanted()}); when it
     *       fits it is marked for a re-run, else it is the cut.</li>
     * </ul>
     * The budget is reopened with the cut ({@link ResponseBudget#reopen}); plans at or after the cut are marked
     * {@code cutOff}. Touches only the plans and the budget, so JUnit replays it.
     *
     * @return the request order of the cut ({@code Integer.MAX_VALUE}: none)
     */
    static int repairCut(Iterable<Plan> plans, ResponseBudget response) {
        List<Plan> ordered = new ArrayList<>();
        for (Plan plan : plans) {
            ordered.add(plan);
        }
        ordered.sort((a, b) -> Integer.compare(a.order, b.order));
        long room = response.max();
        int cut = Integer.MAX_VALUE;
        for (Plan plan : ordered) {
            plan.rerun = false;
            if (cut != Integer.MAX_VALUE) {
                plan.cutOff = true;
                continue;
            }
            if (HistoryResult.TIMEOUT.equals(plan.finalStatus) || HistoryResult.ERROR.equals(plan.finalStatus)) {
                continue;
            }
            PenSeriesWriter.PenBudget b = plan.penBudget;
            if (plan.finalStatus == null) {
                long n = b.wanted();
                if (n > room) {
                    cut = plan.order;
                    plan.cutOff = true;
                    continue;
                }
                room -= n;
                continue;
            }
            if (response.reclassify(b) == PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP) {
                long n = b.wanted();
                if (n > room) {
                    cut = plan.order;
                    plan.cutOff = true;
                    continue;
                }
                room -= n;
                plan.rerun = true;
            }
        }
        response.reopen(cut);
        return cut;
    }

    /**
     * After the response budget is frozen: a data pen whose allowance was evicted since {@link #settle} (by an
     * earlier pen's fallback, or a zombie before it was retired) becomes {@code tooManyPoints}.
     */
    static void reconcile(Plan plan) {
        if (plan.finalStatus == null && plan.penBudget.isOver()) {
            plan.finalStatus = HistoryResult.TOO_MANY_POINTS;
        }
    }

    /** null = finished normally; TIMEOUT = not finished (or cancelled); ERROR = the task threw (rate-limited WARN). */
    private String outcome(Future<?> f, String warnKey) {
        if (f == null || !f.isDone() || f.isCancelled()) {
            return HistoryResult.TIMEOUT;
        }
        try {
            f.get();
            return null;
        } catch (ExecutionException e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            warnings.warn(warnKey, "History query failed (" + cause.getClass().getSimpleName() + ")", cause);
            return HistoryResult.ERROR;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return HistoryResult.TIMEOUT;
        } catch (CancellationException e) {
            return HistoryResult.TIMEOUT;
        }
    }

    // ---- second phase: re-runs and fallbacks -----------------------------------------------------------------

    /**
     * The second phase, on the same deadline and in one atomic submission:
     * <ul>
     *   <li><b>re-runs</b> ({@link #repairCut}): a pen evicted in the first phase that fits the request-order prefix is
     *       queried again with a fresh allowance (its cache hits re-taken, new writers; its anchor was already looked
     *       up — {@link PenSeriesWriter#firstTime()} is kept for discarded rows too). Not finished in time, or refused
     *       by the session queue → {@code timeout};</li>
     *   <li><b>fallbacks</b>: raw pens that went over their own cap with {@code onTooManyPoints:"aggregate"} are
     *       re-queried aggregated over the same window ({@code pointCountMax} buckets, the pen's aggregation) and
     *       returned {@code downgraded}. Refused by the session queue or not finished in time → they stay
     *       {@code tooManyPoints}. Pens at or after the cut get no fallback (it would be refused).</li>
     * </ul>
     * A re-run can itself end over its own cap — its cache hits alone at re-planning, or a live edge that grew since the
     * first phase. It then gets its fallback like any other over-cap raw pen instead of staying {@code tooManyPoints}:
     * at once when the hits decide it, else in one follow-up submission after the re-runs, while the deadline allows.
     * That late fallback takes only points still free — it never evicts a later pen that already settled
     * ({@link ResponseBudget#penWithoutEviction}). When the deadline has already passed nothing is
     * submitted (re-runs → {@code timeout}).
     *
     * <p>Package-private for JUnit ({@code HistorySecondPhaseTest} drives it with a stub historian and the real
     * executor).
     */
    void secondPhase(HistoryRequest req, Iterable<Plan> plans, TagHistoryManager mgr, UUID sid,
                             ResponseBudget response, Admission admission, long deadlineAt, ModuleSettings.Settings s)
            throws Failed {
        boolean fallbacksOn = req.raw() && req.aggregateOnTooManyPoints();
        boolean inTime = deadlineAt - System.currentTimeMillis() > 0;
        List<Callable<Object>> tasks = new ArrayList<>();
        List<Plan> fbOwners = new ArrayList<>();
        List<Callable<Object>> fbTasks = new ArrayList<>();
        List<Plan> reruns = new ArrayList<>();
        List<Piece> rerunPieces = new ArrayList<>();
        for (Plan plan : plans) {
            if (plan.rerun) {
                if (!inTime) {
                    plan.finalStatus = HistoryResult.TIMEOUT;   // fits, but no time left: the client retries
                    continue;
                }
                plan.penBudget = response.pen(plan.cap, plan.order);
                takeCacheHits(plan, response);
                if (!plan.penBudget.isOver()) {
                    reruns.add(plan);
                    for (Piece piece : plan.pieces) {
                        if (piece.isQuery()) {
                            piece.future = null;
                            piece.status = null;
                            tasks.add(tracked(admission, dataTask(mgr, plan, piece, false)));
                            rerunPieces.add(piece);
                        }
                    }
                    continue;
                }
                // Refused again by its own cache hits (over its cap: falls through to the fallback below) or by an
                // earlier pen's hits (response cap: stays tooManyPoints).
                plan.finalStatus = HistoryResult.TOO_MANY_POINTS;
            }
            if (needsFallback(plan, fallbacksOn, inTime)) {
                fbOwners.add(plan);
                fbTasks.add(fallbackTask(plan, mgr, response, admission, s, true));
            }
        }
        tasks.addAll(fbTasks);                  // re-run pieces first, then the fallbacks (indexes below)
        if (tasks.isEmpty()) {
            return;
        }
        Optional<List<Future<Object>>> submitted = executor.submitAll(sid, tasks);
        if (submitted.isEmpty()) {
            dropFallbacks(fbOwners, response);
            for (Plan plan : reruns) {
                plan.finalStatus = HistoryResult.TIMEOUT;   // fits, but the session queue is full: the client retries
                response.retire(plan.penBudget);
            }
            return;
        }
        List<Future<Object>> futures = submitted.get();
        for (int i = 0; i < rerunPieces.size(); i++) {
            rerunPieces.get(i).future = futures.get(i);
        }
        awaitAll(futures, deadlineAt, response);
        for (Plan plan : reruns) {
            settle(plan, response, admission);
        }
        collectFallbacks(fbOwners, futures, rerunPieces.size(), response);

        // Re-runs that went over their own cap while re-querying: their fallbacks, if time is left. Everything above
        // has settled, so these allowances take only what is free and never evict a later pen: a fallback that does
        // not fit leaves its pen tooManyPoints (limit maxPointsPerResponse).
        boolean stillInTime = deadlineAt - System.currentTimeMillis() > 0;
        List<Plan> lateOwners = new ArrayList<>();
        List<Callable<Object>> lateTasks = new ArrayList<>();
        for (Plan plan : reruns) {
            if (needsFallback(plan, fallbacksOn, stillInTime)) {
                lateOwners.add(plan);
                lateTasks.add(fallbackTask(plan, mgr, response, admission, s, false));
            }
        }
        if (lateTasks.isEmpty()) {
            return;
        }
        Optional<List<Future<Object>>> late = executor.submitAll(sid, lateTasks);
        if (late.isEmpty()) {
            dropFallbacks(lateOwners, response);
            return;
        }
        awaitAll(late.get(), deadlineAt, response);
        collectFallbacks(lateOwners, late.get(), 0, response);
    }

    /**
     * True when {@code plan} gets the aggregated fallback (pure; JUnit): fallbacks on for the request, time left, a
     * full (not incremental) window before the response cut, and the pen is {@code tooManyPoints} over its <em>own</em>
     * cap — not refused by the response cap — with no fallback yet. Re-runs that went over their cap qualify too.
     */
    static boolean needsFallback(Plan plan, boolean fallbacksOn, boolean inTime) {
        return fallbacksOn && inTime && !plan.cutOff && !plan.window.incremental() && plan.fallback == null
            && HistoryResult.TOO_MANY_POINTS.equals(plan.finalStatus)
            && plan.penBudget.overflow() == PenSeriesWriter.PenBudget.Overflow.PEN_CAP;
    }

    /**
     * Prepares {@code plan}'s aggregated fallback (allowance in the pen's request order, writer) and returns its task.
     *
     * @param mayEvict false for a late fallback (after the re-runs settled): its allowance takes only free points
     *                 ({@link ResponseBudget#penWithoutEviction})
     */
    private Callable<Object> fallbackTask(Plan plan, TagHistoryManager mgr, ResponseBudget response, Admission admission,
                                          ModuleSettings.Settings s, boolean mayEvict) {
        long[] grid = HistoryRequest.fallbackGrid(plan.window, s);
        long bucket = grid[0];
        AggregationMode agg = plan.fallbackAgg;
        long cap = BucketLadder.ceilDiv(grid[2] - grid[1], bucket) * (agg == AggregationMode.MinMax ? 2 : 1) + 2;
        Piece piece = new Piece(grid[1], grid[2], null);
        plan.fallbackBudget = mayEvict ? response.pen(cap, plan.order) : response.penWithoutEviction(cap, plan.order);
        piece.writer = new PenSeriesWriter(grid[1], grid[2], PenSeriesWriter.ValueFilter.of(plan.check.isBoolean(), agg),
            true, agg == AggregationMode.MinMax, plan.fallbackBudget);
        plan.fallback = piece;
        plan.fallbackBucket = bucket;
        return tracked(admission, () -> {
            aggregatedPiece(mgr, plan, piece.from, piece.to, bucket, agg, piece.writer);
            piece.writer.finish();
            if (piece.writer.error() != null) {
                throw piece.writer.error();
            }
            return null;
        });
    }

    /** Fallbacks refused by the session queue: no fallback, the pens stay {@code tooManyPoints}. */
    private static void dropFallbacks(List<Plan> owners, ResponseBudget response) {
        for (Plan plan : owners) {
            plan.fallback = null;
            response.retire(plan.fallbackBudget);
        }
    }

    /** Records the fallbacks' outcomes ({@code futures} from {@code offset} on, in {@code owners} order). */
    private void collectFallbacks(List<Plan> owners, List<Future<Object>> futures, int offset, ResponseBudget response) {
        for (int i = 0; i < owners.size(); i++) {
            Piece fb = owners.get(i).fallback;
            fb.future = futures.get(offset + i);
            fb.status = outcome(fb.future, "history.fallback");
            if (fb.status != null) {
                response.retire(owners.get(i).fallbackBudget);     // timed out / failed: its zombie takes nothing more
            }
        }
    }
    // ---- assembly --------------------------------------------------------------------------------------------

    static HistoryResult.Pen assemble(String key, Plan plan, ModuleSettings.Settings s, boolean debug) {
        String display = plan.path.toStringFull();
        String dataType = plan.check.dataType();
        HistoryResult.Pen out;
        if (HistoryResult.TIMEOUT.equals(plan.finalStatus)) {
            out = HistoryResult.Pen.empty(key, display, HistoryResult.TIMEOUT).withDataType(dataType);
        } else if (HistoryResult.ERROR.equals(plan.finalStatus)) {
            out = HistoryResult.Pen.empty(key, display, HistoryResult.ERROR).withDataType(dataType).withMessage(QUERY_FAILED);
        } else if (HistoryResult.TOO_MANY_POINTS.equals(plan.finalStatus) || plan.penBudget.isOver()) {
            // isOver(): defensive — reconcile() already turned an evicted data pen into tooManyPoints.
            out = overCap(key, display, plan, s);
        } else {
            List<HistoryResult.Segment> segs = new ArrayList<>();
            int filtered = 0;
            for (Piece p : plan.pieces) {
                long[] t = p.cached != null ? p.cached.t : p.writer.t();
                double[] v = p.cached != null ? p.cached.v : p.writer.v();
                int n = p.cached != null ? p.cached.count() : p.writer.count();
                filtered += p.cached != null ? 0 : p.writer.filtered();
                int a = lowerBound(t, 0, n, plan.window.from());
                int b = lowerBound(t, a, n, plan.window.to());
                if (b > a) {
                    segs.add(new HistoryResult.Segment(t, v, a, b));
                }
            }
            out = HistoryResult.Pen.data(key, display, segs).withType(dataType, plan.agg == null ? null : plan.agg.name(),
                plan.agg == AggregationMode.MinMax).withFiltered(filtered).withReplaceFrom(plan.window.replaceFrom());
            AnchorCache.Anchor a = plan.anchor;
            if (plan.anchorWanted && a != null && a != AnchorCache.NONE && a.t() < plan.window.from()
                && anchorNeeded(plan.agg, firstTimeOf(segs), plan.window.from())) {
                out.withAnchor(a);
            }
        }
        if (debug) {
            out.withCache(plan.cacheHits > 0 && !plan.hasQueries() ? "hit" : plan.cacheHits > 0 ? "partial"
                : plan.cacheMisses > 0 ? "miss" : "none");
        }
        return out;
    }

    /** A pen refused by the response cap ({@code maxPointsPerResponse}). */
    private static HistoryResult.Pen responseCapped(String key, Plan plan, ModuleSettings.Settings s) {
        return HistoryResult.Pen.empty(key, plan.path.toStringFull(), HistoryResult.TOO_MANY_POINTS)
            .withDataType(plan.check.dataType())
            .withLimit(s.historyMaxPointsPerResponse(), "Too many points in this response.");
    }

    private static HistoryResult.Pen overCap(String key, String display, Plan plan, ModuleSettings.Settings s) {
        String dataType = plan.check.dataType();
        if (plan.penBudget.overflow() != PenSeriesWriter.PenBudget.Overflow.PEN_CAP || plan.cutOff) {
            // evicted (RESPONSE_CAP), at or after the response cut (no fallback ran), or, defensively, RETIRED
            return responseCapped(key, plan, s);
        }
        Piece fb = plan.fallback;
        if (fb != null && fb.status == null && !fb.writer.overflowed()) {
            List<HistoryResult.Segment> segs = new ArrayList<>();
            if (fb.writer.count() > 0) {
                segs.add(new HistoryResult.Segment(fb.writer.t(), fb.writer.v(), 0, fb.writer.count()));
            }
            HistoryResult.Pen out = HistoryResult.Pen.data(key, display, segs)
                .withType(dataType, plan.fallbackAgg.name(), plan.fallbackAgg == AggregationMode.MinMax)
                .withFiltered(fb.writer.filtered()).withDowngrade(plan.fallbackBucket);
            AnchorCache.Anchor a = plan.anchor;
            long first = firstTimeOf(segs);
            if (a != null && a != AnchorCache.NONE && first > fb.from && a.t() < first) {
                out.withAnchor(a);
            }
            return out;
        }
        if (fb != null && fb.status == null && plan.fallbackBudget != null
            && plan.fallbackBudget.overflow() != PenSeriesWriter.PenBudget.Overflow.PEN_CAP) {
            // The fallback itself was evicted by an earlier pen (or its fallback): the response cap refused it.
            return responseCapped(key, plan, s);
        }
        long cap = plan.penBudget.cap();
        return HistoryResult.Pen.empty(key, display, HistoryResult.TOO_MANY_POINTS).withDataType(dataType)
            .withLimit((int) Math.min(Integer.MAX_VALUE, cap),
                "More than " + cap + " points in range. Narrow the range or use an aggregated mode.");
    }

    private static long firstTimeOf(List<HistoryResult.Segment> segs) {
        return segs.isEmpty() ? Long.MAX_VALUE : segs.get(0).t[segs.get(0).from];
    }

    /** Points of sorted {@code t[0..n)} inside the pen window. */
    private static long inWindow(long[] t, int n, HistoryRequest.PenWindow w) {
        int a = lowerBound(t, 0, n, w.from());
        return lowerBound(t, a, n, w.to()) - a;
    }

    /** First timestamp of sorted {@code t[0..n)} inside the pen window ({@code Long.MAX_VALUE}: none). */
    private static long firstIn(long[] t, int n, HistoryRequest.PenWindow w) {
        int a = lowerBound(t, 0, n, w.from());
        return a < n && t[a] < w.to() ? t[a] : Long.MAX_VALUE;
    }

    /** First index in {@code t[from..to)} with {@code t[i] >= x} (t sorted ascending). */
    static int lowerBound(long[] t, int from, int to, long x) {
        int lo = from;
        int hi = to;
        while (lo < hi) {
            int mid = (lo + hi) >>> 1;
            if (t[mid] < x) {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        return lo;
    }

    // =========================================================================================================
    // Permission + type pre-check
    // =========================================================================================================

    /**
     * Pre-check of every path with the user's current security context; key = normalized key. A path missing from
     * the result could not be checked before the deadline (→ {@code timeout}).
     */
    private Map<String, ReadPermissionCache.Check> precheck(Map<String, TagPath> unique, UUID sessionId, Session session,
                                                             ModuleSettings.Settings s, long deadlineAt) throws Failed {
        Map<String, ReadPermissionCache.Check> out = new HashMap<>();
        long generation = services.liveSessions().authGeneration(sessionId);
        List<TagPath> paths = new ArrayList<>();
        for (Map.Entry<String, TagPath> e : unique.entrySet()) {
            ReadPermissionCache.Check c = permissions.get(sessionId, generation, e.getKey());
            if (c != null) {
                out.put(e.getKey(), c);
            } else {
                paths.add(e.getValue());
            }
        }
        if (paths.isEmpty()) {
            return out;
        }
        List<TagPath> reads = new ArrayList<>(paths.size() * 4);
        for (TagPath p : paths) {
            reads.add(p);
            reads.add(p.getChildPath(WellKnownTagProps.DataType));
            reads.add(p.getChildPath(WellKnownTagProps.HistoryEnabled));
            reads.add(p.getChildPath(WellKnownTagProps.HistoryProvider));
        }
        WebAuthStatus status = session.getWebAuthStatus();
        SecurityContext ctx = SecurityContext.fromSecurityLevels(status == null ? ImmutableSet.of() : status.getSecurityLevels());
        List<QualifiedValue> values;
        long wait = Math.min(s.readTimeoutMs(), Math.max(1, deadlineAt - System.currentTimeMillis()));
        CompletableFuture<List<QualifiedValue>> f = session.getTagManager().readAsync(reads, ctx);
        try {
            values = f.get(wait, TimeUnit.MILLISECONDS);
        } catch (TimeoutException e) {
            return out;
        } catch (ExecutionException e) {
            warnings.warn("history.precheck", "History permission pre-check failed",
                e.getCause() == null ? e : e.getCause());
            throw new Failed(ErrorCode.HISTORY_QUERY_FAILED);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new Failed(ErrorCode.MODULE_STOPPING);
        }
        Set<String> providers = Set.copyOf(lower(session.getTagHistoryManager().getTagHistoryProviders()));
        for (int i = 0; i < paths.size(); i++) {
            String key = TagPaths.normalizedKey(paths.get(i));
            ReadPermissionCache.Check c = classify(at(values, i * 4), at(values, i * 4 + 1), at(values, i * 4 + 2),
                at(values, i * 4 + 3), providers);
            out.put(key, c);
            permissions.put(sessionId, generation, key, c);
        }
        return out;
    }

    static ReadPermissionCache.Check classify(QualifiedValue base, QualifiedValue dt, QualifiedValue enabled,
                                              QualifiedValue provider, Set<String> providers) {
        QualityCode q = base == null ? null : base.getQuality();
        if (q == null || TagPaths.isAccessDenied(q) || nameMentionsAccess(q)) {
            return new ReadPermissionCache.Check(HistoryResult.ACCESS_DENIED, null, null);
        }
        if (TagPaths.isNotFound(q)) {
            return new ReadPermissionCache.Check(HistoryResult.NOT_FOUND, null, null);
        }
        DataType type = dataType(dt == null ? null : dt.getValue());
        String typeName = type == null ? null : type.name();
        if (type == null || type.isArray() || !(type.isNumeric() || type == DataType.Boolean)) {
            return new ReadPermissionCache.Check(HistoryResult.UNSUPPORTED_TYPE, typeName, null);
        }
        Object en = enabled == null ? null : enabled.getValue();
        if (!(en instanceof Boolean) || !((Boolean) en)) {
            return new ReadPermissionCache.Check(HistoryResult.NO_HISTORY, typeName, null);
        }
        Object prov = provider == null ? null : provider.getValue();
        String provName = prov == null ? "" : String.valueOf(prov).trim();
        if (provName.isEmpty() || !providers.contains(provName.toLowerCase(Locale.ROOT))) {
            return new ReadPermissionCache.Check(HistoryResult.NO_HISTORY, typeName, null);
        }
        return new ReadPermissionCache.Check(HistoryResult.OK, typeName, provName);
    }

    private static boolean nameMentionsAccess(QualityCode q) {
        String n = q.getName();
        return n != null && !q.isGood() && (n.contains("Access") || n.contains("Auth"));
    }

    /** {@code .DataType} reads back as the enum, its name or its int value depending on the provider. */
    static DataType dataType(Object v) {
        if (v instanceof DataType) {
            return (DataType) v;
        }
        if (v instanceof Number) {
            try {
                return DataType.fromIntValue(((Number) v).intValue());
            } catch (RuntimeException e) {
                return null;
            }
        }
        if (v instanceof String) {
            try {
                return DataType.valueOf((String) v);
            } catch (RuntimeException e) {
                return null;
            }
        }
        return null;
    }

    private static QualifiedValue at(List<QualifiedValue> values, int i) {
        return values != null && i < values.size() ? values.get(i) : null;
    }

    private static List<String> lower(List<String> names) {
        List<String> out = new ArrayList<>();
        if (names != null) {
            for (String n : names) {
                if (n != null) {
                    out.add(n.toLowerCase(Locale.ROOT));
                }
            }
        }
        return out;
    }

    // =========================================================================================================
    // Historian calls (worker threads)
    // =========================================================================================================

    /** Raw samples in {@code [from, to)}: the historian's raw end is inclusive, so the query ends at {@code to - 1}. */
    private static void rawQuery(TagHistoryManager mgr, TagPath path, long from, long to, StreamingDatasetWriter w)
            throws Exception {
        BasicTagHistoryQueryParams params = new BasicTagHistoryQueryParams(List.of(path), new Date(from),
            new Date(Math.max(from, to - 1)), -1, AggregationMode.LastValue, ReturnFormat.Wide, null, null);
        mgr.queryHistory(params, w);
    }

    /** {@code (to - from) / bucketMs} buckets over the aligned range {@code [from, to)}, one row (MinMax: two) each. */
    private static void aggregatedQuery(TagHistoryManager mgr, TagPath path, long from, long to, long bucketMs,
                                        AggregationMode agg, StreamingDatasetWriter w) throws Exception {
        int buckets = (int) Math.max(1L, (to - from) / bucketMs);
        BasicTagHistoryQueryParams params = new BasicTagHistoryQueryParams(List.of(path), new Date(from), new Date(to),
            buckets, agg, ReturnFormat.Wide, null, null);
        mgr.queryHistory(params, w);
    }

    /**
     * The last sample before {@code before} (see the class comment, "Anchors"); {@link AnchorCache#NONE} when there is
     * none within a day.
     */
    static AnchorCache.Anchor findAnchor(TagHistoryManager mgr, TagPath path, long before,
                                         PenSeriesWriter.ValueFilter filter) throws Exception {
        LastRowWriter near = new LastRowWriter(before - ANCHOR_NEAR_MS, before, filter);
        rawQuery(mgr, path, before - ANCHOR_NEAR_MS, before, near);
        if (near.found()) {
            return near.anchor();
        }
        long from = before - ANCHOR_LOOKBACK_MS;
        long bucket = ANCHOR_LOOKBACK_MS / ANCHOR_BUCKETS;
        PenSeriesWriter counts = new PenSeriesWriter(from, before, PenSeriesWriter.ValueFilter.COUNT, true,
            new ResponseBudget(Long.MAX_VALUE / 4).pen(4L * ANCHOR_BUCKETS, 0));
        BasicTagHistoryQueryParams params = new BasicTagHistoryQueryParams(List.of(path), new Date(from), new Date(before),
            ANCHOR_BUCKETS, AggregationMode.Count, ReturnFormat.Wide, null, null);
        mgr.queryHistory(params, counts);
        int tries = 0;
        for (int i = counts.count() - 1; i >= 0 && tries < 3; i--) {
            if (!(counts.v()[i] > 0)) {
                continue;
            }
            tries++;
            long bs = counts.t()[i];
            LastRowWriter w = new LastRowWriter(bs, Math.min(bs + bucket, before), filter);
            rawQuery(mgr, path, bs, Math.min(bs + bucket, before), w);
            if (w.found()) {
                return w.anchor();
            }
        }
        return AnchorCache.NONE;
    }

    /** Keeps only the last plausible row of a raw query in {@code [lo, hi)} (anchor look-up; O(1) memory). */
    static final class LastRowWriter implements StreamingDatasetWriter {
        private final long lo;
        private final long hi;
        private final PenSeriesWriter.ValueFilter filter;
        private int valueCol = 1;
        private boolean found;
        private long t;
        private double v;
        private Exception error;

        LastRowWriter(long lo, long hi, PenSeriesWriter.ValueFilter filter) {
            this.lo = lo;
            this.hi = hi;
            this.filter = filter;
        }

        @Override
        public void initialize(String[] names, Class<?>[] types, boolean qualityColumns, int expectedRows) {
            valueCol = names != null && names.length > 1 ? 1 : 0;
        }

        @Override
        public void write(Object[] row, QualityCode[] qualities) {
            if (row == null || row.length <= valueCol) {
                return;
            }
            Object tv = row[0];
            long ts;
            if (tv instanceof Date) {
                ts = ((Date) tv).getTime();
            } else if (tv instanceof Number) {
                ts = ((Number) tv).longValue();
            } else {
                return;
            }
            if (ts < lo || ts >= hi || (found && ts < t)) {
                return;
            }
            Object raw = row[valueCol];
            double d;
            if (raw instanceof Number) {
                d = ((Number) raw).doubleValue();
            } else if (raw instanceof Boolean) {
                d = ((Boolean) raw) ? 1d : 0d;
            } else {
                return;
            }
            QualityCode q = qualities != null && qualities.length > valueCol ? qualities[valueCol] : null;
            // Raw rows: a stored Bad_NotFound sample is a real bad-quality sample (anchor value NaN = gap), not an
            // empty bucket.
            if (!Double.isFinite(d) || !filter.accepts(d)) {
                return;
            }
            found = true;
            t = ts;
            v = q != null && !q.isGood() ? Double.NaN : d;
        }

        @Override
        public void finish() {
        }

        @Override
        public void finishWithError(Exception e) {
            error = e;
        }

        boolean found() throws Exception {
            if (error != null) {
                throw error;
            }
            return found;
        }

        AnchorCache.Anchor anchor() {
            return new AnchorCache.Anchor(t, v);
        }
    }

    // =========================================================================================================
    // Diagnostics and shutdown
    // =========================================================================================================

    /** Counters for tests and support (read through a gateway script; never sent to clients). */
    public Map<String, Object> diagnostics() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("inFlightRequests", inFlight.get());
        m.put("executorActive", executor.active());
        m.put("executorQueued", executor.queued());
        m.put("executorWorkers", executor.workers());
        m.put("reservedPoints", budget.reserved());
        m.putAll(budget.diagnostics());
        m.put("budgetStarvedCancelled", starvedCancelled.get());
        m.put("densityEntries", estimator.size());
        m.put("rateLimiterEntries", rateLimiter.size());
        m.put("cacheEntries", cache.size());
        m.put("cacheBytes", cache.bytes());
        m.put("cacheHits", cache.hits());
        m.put("cacheMisses", cache.misses());
        m.put("permissionEntries", permissions.size());
        m.put("anchorEntries", anchors.size());
        return m;
    }

    @Override
    public void close() {
        if (!executor.shutdown()) {
            LOG.warn("ctg-history did not stop within 5 s (a historian query is still running)");
        }
        perSession.clear();
        rateLimiter.clear();
        estimator.clear();
        cache.clear();
        permissions.clear();
        anchors.clear();
        LOG.debug("history service closed");
    }

}
