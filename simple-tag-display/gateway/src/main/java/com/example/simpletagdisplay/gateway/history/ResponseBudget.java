package com.example.simpletagdisplay.gateway.history;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * The points one request may <em>store</em> while its queries run ({@code ctg.history.maxPointsPerResponse}), shared
 * by every pen allowance ({@link PenSeriesWriter.PenBudget}) of the request and assigned in <b>request order</b>
 * (pens beyond the limit, in request order, end {@code tooManyPoints}) — with ONE exception, a
 * refused late fallback (see "Late allowances never evict" below).
 *
 * <h2>Why request order needs more than a shared counter</h2>
 * Pens are queried in parallel, so a plain shared counter refuses whichever pen happens to cross the limit first —
 * the victims change from one identical request to the next. Here every allowance carries its {@code order} (the
 * position of the pen's first appearance in the request). When a pen needs points and none are left, the
 * allowances of <em>later</em> pens are evicted (highest order first; their points come back) until the request
 * fits; if that is not enough the pen itself is refused, and so is every later pen.
 *
 * <h2>Two phases: evictions while querying are provisional</h2>
 * Eviction keeps the memory bound while the queries run, but it is decided before the final counts are known: an
 * earlier pen can hold points it later gives back (it goes over its own per-pen cap, times out or fails), and the
 * pens it evicted on the way would then be refused for nothing. So every allowance keeps counting the points its
 * writers <em>wanted</em> to store, also after it was evicted ({@link PenSeriesWriter.PenBudget#wanted()}). After
 * the first phase {@code HistoryService} walks the pens in request order with those final counts
 * ({@link #reclassify}, {@link #reopen}): a pen that was evicted but fits the longest request-order prefix is
 * <em>re-queried</em> in the second phase (together with the aggregated fallbacks), and the cut is moved to the first
 * pen that really does not fit. Second-phase evictions are final: every second-phase pen's count is known up front
 * (re-runs) or bounded by its bucket grid (fallbacks), so a pen that takes points keeps them.
 *
 * <h2>Late allowances never evict</h2>
 * A re-run can go over its own cap while re-querying (the live edge grew); its fallback then runs in a follow-up
 * submission, <em>after</em> the second phase settled. Such an allowance comes from {@link #penWithoutEviction}: it
 * takes only what is left and, when that is not enough, refuses itself instead of evicting a later pen that already
 * settled with its points: a pen answered with data at the end of the second phase is never
 * evicted afterwards.
 * <p>
 * <b>The one exception to the request-order prefix.</b> When such a late fallback does not
 * fit, ITS pen ends {@code tooManyPoints} ({@code RESPONSE_CAP}, limit {@code maxPointsPerResponse}) while later pens
 * that settled in the second phase keep their data. That is the only way a later pen can be served after an earlier
 * one was refused for the response cap; clients must therefore read every pen's own {@code status} and never infer a
 * pen's result from its position. The trade-off is deliberate:
 * evicting settled pens would throw away answered data to make room for buckets of a pen whose raw data already went
 * over its own cap.
 *
 * <h2>Thread safety</h2>
 * Every allowance operation runs under this object's monitor (one lock per request, so the "taken" accounting and
 * the eviction can never interleave). An evicted pen's writer notices at
 * its next row ({@link PenSeriesWriter.PenBudget#isOver()} is volatile) and drops its columns.
 *
 * <h2>Growth: the global reservation follows what the request holds</h2>
 * {@code HistoryService} reserves a realistic <em>estimate</em> of the request's points in the global
 * {@link PointBudget} instead of every raw pen's worst case ({@link PointEstimator}). The estimate can be too small (a
 * tag got denser, a window has a burst). So every take that would make the points held by the request's allowances
 * exceed what is reserved first grows the reservation ({@link #bindGrowth}; one growth asks for
 * {@link PointBudget#GROW_MIN_STEP} points or half the need more, or all the room it may use when that is less, so it
 * happens rarely). Growth follows the admission tiers of {@link PointBudget} (a session holding more than its light
 * size never grows into the reserve, and never past its share while another session waits). When even the exact need
 * may not be reserved the request is <b>starved</b>: the taking pen is retired, the budget freezes (every later
 * take fails, nobody is evicted) and {@code HistoryService} answers the whole request 503 {@code BUSY} with
 * {@code Retry-After} instead of holding points the gateway does not have. Without a bound growth (unit fixtures)
 * nothing changes. Growth runs under this object's monitor and takes the {@code PointBudget} monitor inside it (never
 * the other way round).
 *
 * The response-level cap on <em>serialized</em> points (several pens asking for the same data share one stored
 * series but are each written out) is applied separately, in request order, when the response is assembled
 * ({@code HistoryService}).
 */
public final class ResponseBudget {

    private final long max;
    private long remaining;
    private int killedFrom = Integer.MAX_VALUE;
    private boolean frozen;
    private final List<PenSeriesWriter.PenBudget> members = new ArrayList<>();
    /** Grows the request's global reservation (null: unbounded, unit fixtures). */
    private Growth growth;
    /** Points the global reservation covers; takes beyond it grow it first. */
    private long covered = Long.MAX_VALUE;
    /** A growth did not fit the global limit: the request ends with 503 BUSY. */
    private boolean starved;
    /** Run once, outside this monitor, when the request starves (cancels its query tasks not started yet). */
    private Runnable onStarve;
    private boolean starveFired;

    /** Grows the request's global point reservation ({@link PointBudget.Reservation#grow}). */
    @FunctionalInterface
    public interface Growth {
        /**
         * @param need      points the request's allowances will hold after the pending take
         * @param preferred what to reserve if it fits (≥ need); when it does not, as much as may be reserved up to it
         * @return the points now reserved (≥ need), or -1 when even {@code need} may not be reserved
         */
        long grow(long need, long preferred);
    }

    /** @param max the request's {@code maxPointsPerResponse} */
    public ResponseBudget(long max) {
        this.max = Math.max(0L, max);
        this.remaining = this.max;
    }

    /**
     * A new allowance for one pen.
     *
     * @param cap   the pen's own cap (per-pen raw cap, or the aggregated row cap)
     * @param order request order of the pen's first appearance (lower = earlier = served first)
     */
    public PenSeriesWriter.PenBudget pen(long cap, int order) {
        PenSeriesWriter.PenBudget b = new PenSeriesWriter.PenBudget(cap, this, order);
        synchronized (this) {
            members.add(b);
        }
        return b;
    }

    /**
     * An allowance that never evicts another pen (see "Late allowances never evict"): it takes points only while they
     * are free; when a take does not fit it is refused ({@code RESPONSE_CAP}) and nobody else is touched — no later
     * pen, no cut. Pen-cap, cut and freeze rules apply as for {@link #pen}.
     */
    public PenSeriesWriter.PenBudget penWithoutEviction(long cap, int order) {
        PenSeriesWriter.PenBudget b = pen(cap, order);
        synchronized (this) {
            b.mayEvict = false;
        }
        return b;
    }

    /**
     * Binds the request's global reservation (see "Growth"): takes that would hold more than {@code covered} points in
     * total grow it first; a growth that does not fit starves the request.
     */
    public synchronized void bindGrowth(Growth g, long coveredPoints) {
        this.growth = g;
        this.covered = Math.max(0L, coveredPoints);
    }

    /** True when a growth did not fit the global point budget (the caller answers 503 BUSY). */
    public synchronized boolean starved() {
        return starved;
    }

    /**
     * {@code hook} runs once when the request starves — on the writer thread whose take
     * starved it, outside this monitor — or at once (on the caller's thread) when it already starved and the hook has
     * not run yet. {@code HistoryService} cancels the request's query tasks that have not started: the request will
     * answer BUSY, so issuing more historian queries would only cost the historian time and worker threads under the
     * very contention that starved it. Started queries still finish (their rows still count in
     * {@link PenSeriesWriter.PenBudget#wanted()}, so the density they saw is still learnt). A later call replaces the
     * hook (one per query phase).
     */
    public void onStarve(Runnable hook) {
        Runnable fire = null;
        synchronized (this) {
            onStarve = hook;
            if (starved && !starveFired && hook != null) {
                starveFired = true;
                fire = hook;
            }
        }
        runHook(fire);
    }

    private static void runHook(Runnable fire) {
        if (fire == null) {
            return;
        }
        try {
            fire.run();
        } catch (RuntimeException e) {
            // best effort: the deadline still cancels whatever has not started
        }
    }

    /** Points the global reservation covers right now ({@code Long.MAX_VALUE}: unbound; tests and diagnostics). */
    public synchronized long covered() {
        return covered;
    }

    /** Points not taken by any allowance. */
    public synchronized long remaining() {
        return remaining;
    }

    public long max() {
        return max;
    }

    // =========================================================================================================
    // Phase transitions (called by HistoryService between the phases)
    // =========================================================================================================

    /**
     * Marks an allowance over its own cap before it took anything: a raw pen whose cache hits alone already
     * exceed its per-pen cap. Taking those hits first would hold points the pen gives back a moment later and evict
     * (or refuse) every later pen on the way — with the chunk cache on, deterministically.
     */
    public synchronized void overOwnCap(PenSeriesWriter.PenBudget b) {
        if (b.overflow == PenSeriesWriter.PenBudget.Overflow.NONE) {
            over(b, PenSeriesWriter.PenBudget.Overflow.PEN_CAP);
        }
    }

    /**
     * Retires an allowance whose pen will not be sent anyway (its query timed out or failed): its
     * points come back <em>without</em> refusing later pens, so its writers — a timed-out query keeps running as a
     * "zombie" — can no longer evict a later pen that already settled. Idempotent; an allowance already over a cap
     * keeps its reason.
     *
     * <p>With {@code cacheOnlyLimit} above what the pen already stored, the zombie may keep storing up to that many
     * points in total (never above its own cap), outside this budget, so its sealed chunks can still warm the chunk
     * cache (bounded to what its running chunks can hold, not its whole cap). The caller has reserved those points in
     * the global {@code PointBudget} first. A limit not above what the pen stored (or 0) retires it plainly.
     */
    public synchronized void retire(PenSeriesWriter.PenBudget b, long cacheOnlyLimit) {
        if (b.overflow == PenSeriesWriter.PenBudget.Overflow.NONE) {
            over(b, PenSeriesWriter.PenBudget.Overflow.RETIRED);
            long limit = Math.min(b.cap, cacheOnlyLimit);
            b.cacheOnly = limit > b.stored;
            b.cacheOnlyLimit = b.cacheOnly ? limit : 0L;
        }
    }

    /** {@link #retire(PenSeriesWriter.PenBudget, long)} without the cache-only allowance. */
    public void retire(PenSeriesWriter.PenBudget b) {
        retire(b, 0L);
    }

    /**
     * After the first phase: an allowance that was evicted (or refused) by the response cap but whose writers wanted
     * more than its own cap is really over its <em>own</em> cap — the eviction only came first. It becomes
     * {@code PEN_CAP} (tooManyPoints with the per-pen limit, or the aggregated fallback). Returns the final reason.
     */
    public synchronized PenSeriesWriter.PenBudget.Overflow reclassify(PenSeriesWriter.PenBudget b) {
        if (b.overflow == PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP && b.wanted > b.cap) {
            b.overflow = PenSeriesWriter.PenBudget.Overflow.PEN_CAP;
        }
        return b.overflow;
    }

    /**
     * Starts the second phase with the cut found from the final first-phase counts: pens from {@code cutOrder} on are
     * refused (also their fallbacks), pens before it may take points again (re-runs and fallbacks get new
     * allowances). Allowances already over a cap keep their reason; the points data pens hold stay taken.
     */
    public synchronized void reopen(int cutOrder) {
        killedFrom = cutOrder;
        for (PenSeriesWriter.PenBudget m : members) {
            if (m.order >= cutOrder && m.overflow == PenSeriesWriter.PenBudget.Overflow.NONE) {
                over(m, PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP);     // a data pen past the cut
            }
        }
    }

    /**
     * Ends the accounting before the response is assembled: every later {@link #take} fails and
     * retires the taker without evicting anybody, so the over/served state the assembly reads cannot change under
     * it. Only a writer whose pen already has a final non-data status can still be running at that point (a
     * cache-only zombie keeps storing outside this budget).
     */
    public synchronized void freeze() {
        frozen = true;
    }

    // =========================================================================================================
    // Taking points (writer threads)
    // =========================================================================================================

    /** See {@link PenSeriesWriter.PenBudget#take(long)}. Runs the starvation hook (outside the monitor) when it starved. */
    boolean take(PenSeriesWriter.PenBudget b, long n) {
        boolean ok;
        Runnable fire = null;
        synchronized (this) {
            ok = takeLocked(b, n);
            if (starved && !starveFired && onStarve != null) {
                starveFired = true;
                fire = onStarve;
            }
        }
        runHook(fire);
        return ok;
    }

    /** Caller holds the lock. */
    private boolean takeLocked(PenSeriesWriter.PenBudget b, long n) {
        b.wanted += n;
        if (b.cacheOnly) {
            // A retired zombie warming the cache: its own limit only, nothing from (or back to) this budget.
            if (b.stored + n > b.cacheOnlyLimit) {
                b.cacheOnly = false;
                return false;
            }
            b.stored += n;
            return true;
        }
        if (b.overflow != PenSeriesWriter.PenBudget.Overflow.NONE) {
            return false;
        }
        if (frozen) {
            over(b, PenSeriesWriter.PenBudget.Overflow.RETIRED);
            return false;
        }
        if (b.stored + n > b.cap) {
            over(b, PenSeriesWriter.PenBudget.Overflow.PEN_CAP);
            return false;
        }
        if (b.order >= killedFrom) {
            over(b, PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP);
            return false;
        }
        if (remaining < n && !b.mayEvict) {
            over(b, PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP);   // late allowance: refuse itself, touch nobody
            return false;
        }
        if (remaining < n) {
            evictAfter(b.order, n);
        }
        if (remaining < n) {
            // Even without every later pen this one does not fit: refuse it and everything after it.
            killedFrom = b.order;
            over(b, PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP);
            evictAfter(b.order, Long.MAX_VALUE);
            return false;
        }
        if (!covers(max - remaining + n)) {
            // Even the exact need does not fit the global point budget: stop storing, answer BUSY (see "Growth").
            starved = true;
            frozen = true;
            over(b, PenSeriesWriter.PenBudget.Overflow.RETIRED);
            return false;
        }
        remaining -= n;
        b.stored += n;
        b.taken += n;
        return true;
    }

    /** Makes the global reservation cover {@code need} points, growing it when bound. Caller holds the lock. */
    private boolean covers(long need) {
        if (need <= covered) {
            return true;
        }
        if (growth == null) {
            return false;
        }
        long preferred = Math.min(max, need + Math.max(PointBudget.GROW_MIN_STEP, need / 2));
        long now = growth.grow(need, Math.max(need, preferred));
        if (now < need) {
            return false;
        }
        covered = now;
        return true;
    }

    /** Marks {@code b} over a cap and returns what it took (its data will not be sent). Caller holds the lock. */
    private void over(PenSeriesWriter.PenBudget b, PenSeriesWriter.PenBudget.Overflow why) {
        b.overflow = why;
        remaining += b.taken;
        b.taken = 0;
    }

    /**
     * Evicts allowances with an order above {@code order}, highest first, until {@code need} points are free
     * ({@code Long.MAX_VALUE}: all of them). Every eviction also refuses everything after the evicted pen, so — among
     * the allowances that may evict — a later pen is never served while an earlier one was refused. The exception is a
     * late allowance ({@link #penWithoutEviction}) that refuses itself: it never calls this, and the pens after it
     * keep what they settled with (class comment, "The one exception"). Caller holds the lock.
     */
    private void evictAfter(int order, long need) {
        List<PenSeriesWriter.PenBudget> desc = new ArrayList<>(members);
        desc.sort(Comparator.comparingInt((PenSeriesWriter.PenBudget m) -> m.order).reversed());
        for (PenSeriesWriter.PenBudget m : desc) {
            if (need != Long.MAX_VALUE && remaining >= need) {
                return;
            }
            if (m.order <= order) {
                return;
            }
            if (m.overflow != PenSeriesWriter.PenBudget.Overflow.NONE) {
                continue;
            }
            if (m.taken > 0 || need == Long.MAX_VALUE) {
                over(m, PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP);
                killedFrom = Math.min(killedFrom, m.order);
            }
        }
    }
}
