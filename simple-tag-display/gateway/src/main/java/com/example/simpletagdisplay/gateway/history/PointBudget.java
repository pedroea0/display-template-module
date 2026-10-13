package com.example.simpletagdisplay.gateway.history;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.LongSupplier;

/**
 * Global reservation of in-flight history points with a per-session fair share.
 *
 * <h2>Why</h2>
 * A history request holds its points as primitive columns (≈ 16 bytes per point: {@code long t} + {@code double v})
 * from the first historian row until the response body is written. Without a global bound, many concurrent large
 * requests could exhaust the gateway heap. Every request reserves points before any query starts; when the sum of
 * reservations would not fit {@code ctg.history.maxInFlightPoints} (5 M ≈ 85 MB) the request is refused with 503
 * {@code BUSY}. The reservation is released after the body was streamed (and its last historian task ended).
 *
 * <h2>Fair share</h2>
 * A first-come, first-served budget is not enough: under a deliberate flood from a few sessions a well-behaved
 * session asking for one pen over one hour would get {@code BUSY} on half of its requests. Admission therefore splits
 * the limit in tiers and shares the largest one per session:
 * <pre>
 *   limit   = ctg.history.maxInFlightPoints (read live)
 *   reserve = limit / {@value #RESERVE_DIVISOR}            (1 M at the default)
 *   pool    = limit − reserve                             (4 M)
 *   light   = reserve / {@value #LIGHT_DIVISOR}            (250 k: one raw pen's worst case at the default cap)
 *   small   = light / {@value #SMALL_DIVISOR}             (15 625: a 1-pen × 1-h chart, raw at 1 Hz or aggregated)
 *   smallReserve = reserve / {@value #SMALL_RESERVE_DIVISOR}  (250 k: the top of the limit only small sessions use)
 * </pre>
 * <ol>
 *   <li><b>Never above the limit.</b> {@code reserved + n > limit} → refused.</li>
 *   <li><b>Small sessions may use the whole limit.</b> A request after which its session holds at most {@code small}
 *       points is admitted whenever it fits the limit.</li>
 *   <li><b>Light sessions may use the limit except the small reserve.</b> A request after which its session holds at
 *       most {@code light} points is admitted whenever {@code reserved + n ≤ limit − smallReserve}. The reserve is
 *       therefore always open to light users: a flood of large requests can never take it, and a flood of light
 *       requests can never take its top {@code smallReserve}, because…</li>
 *   <li><b>…everything else must fit the pool</b> ({@code reserved + n ≤ pool}). The one exception: an idle budget
 *       ({@code reserved == 0}) admits a single request up to the whole limit, so a request larger than the pool
 *       (possible only when the limit was lowered a lot) is not refused forever.</li>
 *   <li><b>Fair share of the pool under contention.</b> While another session is <em>waiting</em> (it was refused in
 *       the last {@value #CONTENTION_TTL_MS} ms), a session that already holds points may grow only up to
 *       {@code pool / contenders} — contenders = sessions holding points ∪ waiting sessions ∪ the requester. A session
 *       holding nothing may always start one request (when it fits the pool), whatever its size, so a large request is
 *       never starved by a stricter share. Without anybody waiting a single session may use the whole pool (the
 *       budget stays work-conserving).</li>
 * </ol>
 * Every refusal of an attributed request marks its session as waiting, which is what turns the share on: the
 * flooding sessions converge to an equal split of the pool while the reserve keeps serving light sessions.
 *
 * <h2>Realistic reservations and growth</h2>
 * {@code HistoryService} reserves an <em>estimate</em> (exact for aggregated pens, the tag's recently observed sample
 * density for raw pens, the worst case for a tag it has not seen; {@link PointEstimator}) instead of every raw pen's
 * worst case. A request whose writers need more than it reserved {@link Reservation#grow grows} its reservation while
 * it runs. <b>Growth follows the same tiers as admission</b>: a request may grow only as far as a
 * request of its new size would have been admitted —
 * <ul>
 *   <li>while its session holds at most {@code small} in total it may use the whole limit (small tier);</li>
 *   <li>while its session holds at most {@code light} in total it may use the reserve except the small reserve
 *       (light tier);</li>
 *   <li>beyond that the budget must stay within the pool (the whole limit when the request is the only reservation,
 *       the idle-budget exception), and while another session waits a session that holds other reservations too may
 *       grow only to its share.</li>
 * </ul>
 * So an estimate that is too small — by accident, or made small on purpose by querying empty windows — can never
 * carry a heavy request into the reserve: the reserve stays open to light sessions whatever the estimates say. When
 * the growth does not fit, the request is ended with 503 {@code BUSY} and retried by the client ({@link ResponseBudget}
 * "Growth"), so the memory bound holds too. When the preferred growth does not fit, a growth takes all the room it may
 * use up to it, so a request near the limit does not come back for every row.
 *
 * <h2>The small reserve: a 1-pen × 1-h chart always fits</h2>
 * Every light session may hold up to {@code light} points of the reserve, so at least
 * {@code (reserve − smallReserve) / light} = 3 light sessions are served from it at once even when the pool is full;
 * more light sessions share it first come, first served (a refused one retries after Retry-After). {@code light} is
 * one raw pen's worst case on purpose: a session asking for one pen over a long window of a tag the gateway has not
 * seen yet reserves that worst case and must still be admitted while a flood fills the pool.
 * <p>
 * Light sessions alone could fill the reserve, though (for example, 5 flooders plus 12 sessions each looping one
 * 100 k-row raw pen would make a 1-pen × 1-h session get {@code BUSY}). The top {@code smallReserve} of the limit
 * is therefore open only to <em>small</em> sessions: neither the pool tier nor the light tier can push the reservations
 * above {@code limit − smallReserve} (with the shipped limits; the idle-budget exception and the only reservation's
 * growth may, see above), so at least {@code smallReserve / small} = 16 small sessions — typically 30 or more, a 1 h
 * raw pen at 1 Hz reserves about 7 500 points and an aggregated pen its bucket grid — are admitted whatever the other
 * sessions do. {@code HistoryService} reserves a short raw window of an unknown tag at the 1 pt/s floor
 * ({@link PointEstimator}) instead of the worst case, so a 1-pen × 1-h raw chart is small even for a tag nobody
 * queried yet; when the tag turns out denser, growth carries it into the light tier like any other estimate.
 *
 * <h2>Small sessions queue for the small reserve</h2>
 * The small tier is bounded per session ({@code small}), and per-session rules alone cannot keep the small reserve
 * for everybody: 17 or more sessions each holding one small request fill it. So the small
 * reserve is shared <b>globally, oldest waiter first</b>: a session refused with a small request <em>waits</em> (for
 * {@value #CONTENTION_TTL_MS} ms after its last refusal, longer than Retry-After); a small request (or growth) is
 * admitted only while the room left after it still holds one {@code small} request for every small session that has
 * waited longer than the requester (a session that is not waiting counts as the newest). Room freed by an ending
 * small request therefore goes to the waiting small sessions in the order they were refused, not to whoever asks
 * first: a session that loops small requests (or many sessions doing so) cannot keep a refused 1-pen x 1-h chart out,
 * it gets the next free room on its retry. What remains is the order itself: under a flood of more small sessions
 * than the small reserve holds, a new session waits behind the ones refused before it (typically one Retry-After).
 *
 * <h2>Unattributed reservations</h2>
 * Every reservation of the product is attributed to a session (there is no session-less {@code tryReserve(long)}:
 * it would skip every tier). {@link #fixtureReserve(long)} keeps the limit-only reservation for JUnit fixtures
 * only; {@code PointBudgetTest} checks that no product source calls it.
 *
 * The limit is read live (settings reload) on every call; a lowered limit affects new reservations and growth only.
 * All state is guarded by this object's monitor (admission runs a few times per second; the request's
 * {@link ResponseBudget} calls {@link Reservation#grow} at most once per {@value #GROW_MIN_STEP} points or so, and
 * near the limit only after other requests released points). Lock order: a {@code ResponseBudget} monitor may be held while this one is taken, never the other way round.
 */
public final class PointBudget {

    /** {@code reserve = limit / RESERVE_DIVISOR}: the part of the limit only light sessions may use. */
    static final int RESERVE_DIVISOR = 5;
    /** {@code light = reserve / LIGHT_DIVISOR}: a session holding at most this much after admission is light. */
    static final int LIGHT_DIVISOR = 4;
    /** {@code small = light / SMALL_DIVISOR}: a session holding at most this much after admission is small. */
    static final int SMALL_DIVISOR = 16;
    /** {@code smallReserve = reserve / SMALL_RESERVE_DIVISOR}: the top of the limit only small sessions may use. */
    static final int SMALL_RESERVE_DIVISOR = 4;
    /** A refused session counts as waiting (contending for the pool) for this long; above Retry-After (2 s). */
    static final long CONTENTION_TTL_MS = 5_000L;
    /** Most waiting sessions remembered (the oldest marks are dropped first). */
    static final int MAX_WAITING = 4_096;
    /** A growing reservation asks for at least this many points more than it needs, so it grows rarely. */
    static final long GROW_MIN_STEP = 16_384L;

    /** Why {@link #tryReserve(UUID, long)} refused (diagnostics, tests). */
    public enum Refusal {
        /** Admitted. */
        NONE,
        /** The limit (or, for a request that is not light, the pool) is full. */
        FULL,
        /** The session already holds its fair share while another session is waiting. */
        SHARE
    }

    private final LongSupplier max;
    private final LongSupplier clock;

    private long reserved;                                              // guarded by this
    private final Map<UUID, Long> held = new HashMap<>();               // guarded by this; session → points (> 0)
    private final LinkedHashMap<UUID, Long> waiting = new LinkedHashMap<>();  // guarded by this; session → last refusal
    /** Small sessions waiting for the small reserve: session → {first refusal, last refusal} (guarded by this). */
    private final LinkedHashMap<UUID, long[]> smallWaiting = new LinkedHashMap<>();
    private long refusedSmallQueue;                                     // guarded by this
    private Refusal lastRefusal = Refusal.NONE;                         // guarded by this (tests)
    private long refusedFull;                                           // guarded by this
    private long refusedShare;                                          // guarded by this
    private long admittedSmall;                                         // guarded by this
    private long admittedLight;                                         // guarded by this
    private long grown;                                                 // guarded by this
    private long growRefused;                                           // guarded by this

    /** @param max live {@code ctg.history.maxInFlightPoints} */
    public PointBudget(LongSupplier max) {
        this(max, System::currentTimeMillis);
    }

    /** @param clock epoch ms (the contention memory; injectable for JUnit) */
    public PointBudget(LongSupplier max, LongSupplier clock) {
        this.max = max;
        this.clock = clock;
    }

    /** Points reserved by one request; {@link #close()} returns them (idempotent). */
    public final class Reservation implements AutoCloseable {
        private final UUID session;                     // null = unattributed
        private long points;                            // guarded by PointBudget.this
        private boolean released;                       // guarded by PointBudget.this

        Reservation(UUID session, long points) {
            this.session = session;
            this.points = points;
        }

        /** Points currently reserved (grows with {@link #grow}). */
        public long points() {
            synchronized (PointBudget.this) {
                return points;
            }
        }

        /**
         * Grows the reservation so it covers at least {@code need} points, asking for {@code preferred} (≥ need) first
         * so a growing request does not come back for every row. Growth follows the admission tiers (class comment,
         * "Growth"): the request may grow as if it had been admitted at its new size, never into the reserve once its
         * session holds more than {@code light}, and never past its fair share while another session waits (unless
         * it is the session's only reservation). When {@code preferred} does not fit, it takes all the room it may use
         * up to {@code preferred}, so near the limit it does not come back for every row either.
         *
         * @return the points now reserved (≥ need), or -1 when even {@code need} may not be reserved or the
         *         reservation was already released (the caller ends the request with {@code BUSY})
         */
        public long grow(long need, long preferred) {
            synchronized (PointBudget.this) {
                if (released) {
                    return -1L;
                }
                if (need <= points) {
                    return points;
                }
                long room = growthRoom(this, clock.getAsLong());
                long most = points + Math.max(0L, room);            // room ≤ limit − reserved: no overflow
                long target = Math.min(Math.max(need, preferred), most);
                if (target < need) {
                    growRefused++;
                    if (session != null) {
                        markWaiting(session, clock.getAsLong());
                    }
                    return -1L;
                }
                long delta = target - points;
                reserved += delta;
                points = target;
                if (session != null) {
                    held.merge(session, delta, Long::sum);
                }
                grown++;
                return points;
            }
        }

        @Override
        public void close() {
            synchronized (PointBudget.this) {
                if (released) {
                    return;
                }
                released = true;
                reserved -= points;
                if (session != null) {
                    held.computeIfPresent(session, (k, v) -> v - points <= 0L ? null : v - points);
                }
            }
        }
    }

    // =========================================================================================================
    // Admission
    // =========================================================================================================

    /**
     * Reserves {@code points} for a request of {@code session} under the fair-share rules (class comment).
     *
     * @return the reservation, or null when it may not run now (the caller answers 503 {@code BUSY}); a refusal marks
     *         the session as waiting
     */
    public synchronized Reservation tryReserve(UUID session, long points) {
        return admit(session, points, false);
    }

    /**
     * Reserves {@code points} that the request could do without (a timed-out pen's zombie query that keeps storing
     * for the chunk cache): only from the pool and within the session's share, never from the reserve, never as the
     * idle-budget exception, and a refusal does not mark the session as waiting.
     */
    public synchronized Reservation tryReserveOptional(UUID session, long points) {
        return admit(session, points, true);
    }

    /**
     * JUnit fixture only, never call from product code: reserves {@code points} without a session, the limit being
     * the only rule (it skips every tier and never counts towards a share). Product reservations are always attributed
     * ({@link #tryReserve(UUID, long)}); {@code PointBudgetTest} fails when a product source calls this.
     */
    synchronized Reservation fixtureReserve(long points) {
        long n = Math.max(0L, points);
        if (!fits(n, Math.max(0L, max.getAsLong()))) {
            lastRefusal = Refusal.FULL;
            refusedFull++;
            return null;
        }
        lastRefusal = Refusal.NONE;
        reserved += n;
        return new Reservation(null, n);
    }

    /** Caller holds the lock. */
    private Reservation admit(UUID session, long points, boolean optional) {
        long n = Math.max(0L, points);
        long now = clock.getAsLong();
        expireWaiting(now);
        boolean smallRequest = !optional && session != null && held.getOrDefault(session, 0L) + n <= small();
        Refusal why = decide(session, n, optional, now);
        lastRefusal = why;
        if (why != Refusal.NONE) {
            if (why == Refusal.FULL) {
                refusedFull++;
            } else {
                refusedShare++;
            }
            if (!optional && session != null) {
                markWaiting(session, now);
            }
            if (smallRequest) {
                markSmallWaiting(session, now);
            }
            return null;
        }
        if (session != null) {
            smallWaiting.remove(session);
        }
        reserved += n;
        if (session != null && n > 0L) {
            held.merge(session, n, Long::sum);
        }
        return new Reservation(session, n);
    }

    /** The admission rules of the class comment. Caller holds the lock; {@link #expireWaiting} ran. */
    private Refusal decide(UUID session, long n, boolean optional, long now) {
        long limit = Math.max(0L, max.getAsLong());
        if (!fits(n, limit)) {
            return Refusal.FULL;
        }
        long reserve = limit / RESERVE_DIVISOR;
        long pool = limit - reserve;
        long light = reserve / LIGHT_DIVISOR;
        long mine = session == null ? 0L : held.getOrDefault(session, 0L);
        long small = light / SMALL_DIVISOR;
        if (!optional && mine + n <= small) {
            // small: the whole limit (fits, checked above), but the room the small sessions refused before this one
            // wait for stays theirs (the small reserve is shared globally, oldest waiter first)
            if (limit - reserved - n < smallWaitersAhead(session, now) * small) {
                refusedSmallQueue++;
                return Refusal.FULL;
            }
            admittedSmall++;
            return Refusal.NONE;
        }
        if (!optional && mine + n <= light && reserved + n <= limit - reserve / SMALL_RESERVE_DIVISOR) {
            admittedLight++;
            return Refusal.NONE;
        }
        if (reserved + n > pool) {
            return !optional && reserved == 0L ? Refusal.NONE : Refusal.FULL;
        }
        if (session == null || (mine == 0L && !optional) || !othersWaiting(session)) {
            return Refusal.NONE;
        }
        long share = pool / contenders(session);
        return mine + n <= share ? Refusal.NONE : Refusal.SHARE;
    }

    /**
     * The most points {@code r} may grow by now (class comment, "Growth"): the union of the tiers a request of its new
     * size would be admitted under, all within the hard limit —
     * <ul>
     *   <li>small: its session may hold up to {@code small} in total (the whole limit is open to it);</li>
     *   <li>light: its session may hold up to {@code light} in total (the reserve is open to it, except the small
     *       reserve);</li>
     *   <li>pool: up to {@code pool} in total; the whole limit when {@code r} is the only reservation (the idle-budget
     *       exception); while another session waits, a session holding more than {@code r} only up to its share;</li>
     *   <li>unattributed: the hard limit only.</li>
     * </ul>
     * Caller holds the lock; {@link #expireWaiting} need not have run (it runs here).
     */
    private long growthRoom(Reservation r, long now) {
        long limit = Math.max(0L, max.getAsLong());
        long room = limit - reserved;
        if (room <= 0L || r.session == null) {
            return room;
        }
        expireWaiting(now);
        long reserve = limit / RESERVE_DIVISOR;
        long pool = limit - reserve;
        long light = reserve / LIGHT_DIVISOR;
        long mine = held.getOrDefault(r.session, 0L);
        long small = light / SMALL_DIVISOR;
        // within room (the limit), less one small request for each small session waiting (oldest first)
        long smallRoom = Math.min(small - mine, room - smallWaitersAhead(r.session, now) * small);
        long lightRoom = Math.min(light - mine, limit - reserve / SMALL_RESERVE_DIVISOR - reserved);
        long poolRoom = (reserved == r.points ? limit : pool) - reserved;
        if (mine > r.points && othersWaiting(r.session)) {
            poolRoom = Math.min(poolRoom, pool / contenders(r.session) - mine);
        }
        return Math.min(room, Math.max(smallRoom, Math.max(lightRoom, poolRoom)));
    }

    /** {@code reserved + n} stays within {@code limit} (and does not overflow). Caller holds the lock. */
    private boolean fits(long n, long limit) {
        long sum = reserved + n;
        return n >= 0L && sum >= reserved && sum <= limit;
    }

    private boolean othersWaiting(UUID session) {
        for (UUID s : waiting.keySet()) {
            if (!s.equals(session)) {
                return true;
            }
        }
        return false;
    }

    /** Sessions holding points ∪ waiting sessions ∪ {@code session}. Caller holds the lock. */
    private int contenders(UUID session) {
        Set<UUID> all = new HashSet<>(held.keySet());
        all.addAll(waiting.keySet());
        all.add(session);
        return all.size();
    }

    /** {@code small} at the current limit. Caller holds the lock. */
    private long small() {
        return Math.max(0L, max.getAsLong()) / RESERVE_DIVISOR / LIGHT_DIVISOR / SMALL_DIVISOR;
    }

    /**
     * Small sessions waiting longer than {@code session} (all of them when it is not waiting); expired ones are
     * dropped. Ties (same millisecond) go by refusal order. Caller holds the lock.
     */
    private long smallWaitersAhead(UUID session, long now) {
        long[] me = session == null ? null : smallWaiting.get(session);
        long ahead = 0L;
        boolean seenMe = false;
        Iterator<Map.Entry<UUID, long[]>> it = smallWaiting.entrySet().iterator();
        while (it.hasNext()) {
            long[] w = it.next().getValue();
            if (now - w[1] >= CONTENTION_TTL_MS) {
                it.remove();
                if (w == me) {
                    me = null;            // its own wait expired: it queues again as the newest
                }
                continue;
            }
            if (w == me) {
                seenMe = true;
                continue;
            }
            if (me == null || w[0] < me[0] || (w[0] == me[0] && !seenMe)) {
                ahead++;
            }
        }
        return ahead;
    }

    private void markSmallWaiting(UUID session, long now) {
        long[] w = smallWaiting.get(session);
        if (w != null && now - w[1] < CONTENTION_TTL_MS) {
            w[1] = now;                    // still queued: keeps its place
            return;
        }
        smallWaiting.remove(session);
        smallWaiting.put(session, new long[] {now, now});
        while (smallWaiting.size() > MAX_WAITING) {
            Iterator<UUID> it = smallWaiting.keySet().iterator();
            it.next();
            it.remove();
        }
    }

    private void markWaiting(UUID session, long now) {
        waiting.remove(session);                       // re-insert: insertion order = refusal order (oldest first)
        waiting.put(session, now);
        while (waiting.size() > MAX_WAITING) {
            Iterator<UUID> it = waiting.keySet().iterator();
            it.next();
            it.remove();
        }
    }

    private void expireWaiting(long now) {
        Iterator<Map.Entry<UUID, Long>> it = waiting.entrySet().iterator();
        while (it.hasNext()) {
            if (now - it.next().getValue() < CONTENTION_TTL_MS) {
                return;                                // insertion order: every later mark is newer
            }
            it.remove();
        }
    }

    /** The session ended: forget that it was waiting (its reservations end with their requests). */
    public synchronized void sessionEnded(UUID session) {
        waiting.remove(session);
        smallWaiting.remove(session);
    }

    // =========================================================================================================
    // Diagnostics
    // =========================================================================================================

    /** Points currently reserved (diagnostics). */
    public synchronized long reserved() {
        return reserved;
    }

    /** Points {@code session} holds right now (tests, diagnostics). */
    public synchronized long heldBy(UUID session) {
        return held.getOrDefault(session, 0L);
    }

    /** The reason of the last admission decision (tests). */
    synchronized Refusal lastRefusal() {
        return lastRefusal;
    }

    /** Counters for {@code HistoryService.diagnostics()}. */
    public synchronized Map<String, Object> diagnostics() {
        expireWaiting(clock.getAsLong());
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("budgetSessions", held.size());
        m.put("budgetWaiting", waiting.size());
        m.put("budgetSmallWaiting", smallWaiting.size());
        m.put("budgetRefusedSmallQueue", refusedSmallQueue);
        m.put("budgetAdmittedSmall", admittedSmall);
        m.put("budgetAdmittedLight", admittedLight);
        m.put("budgetRefusedFull", refusedFull);
        m.put("budgetRefusedShare", refusedShare);
        m.put("budgetGrown", grown);
        m.put("budgetGrowRefused", growRefused);
        return m;
    }
}
