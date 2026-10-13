package com.example.simpletagdisplay.gateway.history;

import java.util.Arrays;
import java.util.Date;

import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.inductiveautomation.ignition.common.StreamingDatasetWriter;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.history.AggregationMode;

/**
 * Receives the rows of ONE historian query for ONE pen and keeps them as primitive columns. One writer per query;
 * several writers of the same pen (cache chunks) share the pen's {@link PenBudget}.
 *
 * <h2>Row rules</h2>
 * <ul>
 *   <li>timestamp: {@code Date} → ms, {@code Number} → long; anything else → row skipped;</li>
 *   <li>outside the writer's window {@code [lo, hi)} → skipped (chunk boundaries, raw incremental {@code t > since});</li>
 *   <li>value: {@code Number} → double, {@code Boolean} → 1/0; null or non-finite → no point (an empty bucket);</li>
 *   <li>aggregated queries only: quality {@code Bad_NotFound} → no point: Core Historian marks <em>empty aggregate
 *       buckets</em> this way, sometimes with a made-up value (MinMax returns {@code 0.0, Bad_NotFound} before a
 *       tag's first sample). In raw queries a stored {@code Bad_NotFound} sample is a real bad-quality
 *       sample (an OPC item that went missing) and becomes a gap like any other bad quality;</li>
 *   <li>any other non-good quality → a point with value NaN, serialized as {@code null}: a gap the chart draws as a
 *       break;</li>
 *   <li>Boolean pens ({@link ValueFilter}): Core Historian returns garbage for some aggregates in buckets before
 *       the tag's first sample (LastValue 3.4e10, Maximum 2.5e12 observed on 8.3.10). Value aggregates keep only
 *       {@code 0 ≤ v ≤ 1}; count-like aggregates (Sum, Count, CountOn/Off, DurationOn/Off) drop {@code v < 0} and
 *       {@code v > 1e12}. Dropped rows are counted in {@link #filtered()}.</li>
 *   <li><b>Unseeded Boolean buckets</b> ({@link #unseededBefore}): Core Historian does not seed Boolean aggregates
 *       with the last sample before the query start (Float/Integer tags are seeded; MinMax and Count are fine).
 *       Every bucket before the first sample <em>inside the query range</em> carries an uninitialised value — out of
 *       range (filtered above) or a plausible 0/1, varying between identical queries. {@code HistoryService} finds
 *       the first bucket holding a sample (a {@code Count} query on the same grid) and the last sample before the
 *       range; rows before that
 *       bucket take the seed's value, or are dropped (counted in {@link #filtered()}) when there is no seed.</li>
 *   <li><b>MinMax pairs</b> ({@code pairs = true}): the response contract is "two rows per bucket with the same
 *       {@code t}" (the client tells min from max by row parity). Rows are therefore accepted or
 *       dropped <em>per bucket</em>: the two rows sharing a timestamp are buffered and emitted together; when one of them
 *       is dropped by a rule above (Core Historian marks one row of a pair {@code Bad_NotFound} at a restart gap, the
 *       Boolean filter rejects one value) the surviving value is emitted twice; when both are dropped the bucket has no
 *       rows. A lone row (the historian sent one row for a bucket) is likewise doubled. Every bucket thus has 0 or 2
 *       rows, and the client never sees an orphan row that would shift the min/max parity.</li>
 * </ul>
 *
 * <h2>Caps (count and discard)</h2>
 * Every stored point is taken from the pen's {@link PenBudget} (per-pen cap) and from the request's
 * {@code maxPointsPerResponse} remainder. When either runs out the pen is marked over its cap and every further row
 * is only counted. <b>The writer never throws into the historian</b>: a throwing
 * {@code write} does abort the scan early (75 ms instead of 450 ms for 100 k rows) but makes Core Historian log an
 * ERROR with a stack trace ({@code t.h.q.ResultWriter "Error executing historical tag read."}) for every capped
 * query — an operator could fill the log by zooming out. Memory stays bounded either way.
 */
public final class PenSeriesWriter implements StreamingDatasetWriter {

    /** Which values are plausible for the pen (Boolean garbage filter). */
    public enum ValueFilter {
        /** Numeric tags: everything finite. */
        NONE,
        /** Boolean tag, raw or a value aggregate: {@code [0, 1]}. */
        UNIT,
        /** Boolean tag, a count-like aggregate: {@code [0, 1e12]}. */
        COUNT;

        private static final double COUNT_MAX = 1e12;

        /** Filter for a pen of the given data type and aggregation ({@code null} = raw). */
        public static ValueFilter of(boolean booleanTag, AggregationMode aggregation) {
            if (!booleanTag) {
                return NONE;
            }
            if (aggregation == null) {
                return UNIT;
            }
            switch (aggregation) {
                case Sum:
                case Count:
                case CountOn:
                case CountOff:
                case DurationOn:
                case DurationOff:
                    return COUNT;
                default:
                    return UNIT;
            }
        }

        boolean accepts(double d) {
            switch (this) {
                case UNIT:
                    return d >= 0d && d <= 1d;
                case COUNT:
                    return d >= 0d && d <= COUNT_MAX;
                default:
                    return true;
            }
        }
    }

    /**
     * Point allowance of one pen in one request, shared by all of the pen's writers. Takes points from the request's
     * {@link ResponseBudget} (request order, see there); when the pen exceeds its own cap it gives back what it took
     * (its data will not be sent) so other pens can still use the response budget. All accounting runs under the
     * response budget's lock.
     */
    public static final class PenBudget {
        /**
         * Why a pen stopped storing. {@code RETIRED}: the pen already has a final non-data status (timeout/error), or
         * it tried to store after the response budget was frozen ({@link ResponseBudget#retire}, {@code freeze}).
         */
        public enum Overflow { NONE, PEN_CAP, RESPONSE_CAP, RETIRED }

        final long cap;
        final int order;
        private final ResponseBudget response;
        long stored;                            // guarded by response
        long taken;                             // guarded by response
        long wanted;                            // guarded by response: every point the writers tried to store
        volatile Overflow overflow = Overflow.NONE;
        /** Retired zombie still storing for the chunk cache, up to {@link #cacheOnlyLimit} ({@link ResponseBudget#retire}). */
        volatile boolean cacheOnly;
        /** Most points a cache-only zombie may hold in total (≤ cap; what its running chunks can hold). */
        long cacheOnlyLimit;                    // guarded by response
        /** False for a late allowance that must never evict a later pen ({@link ResponseBudget#penWithoutEviction}). */
        boolean mayEvict = true;                // guarded by response

        PenBudget(long cap, ResponseBudget response, int order) {
            this.cap = cap;
            this.response = response;
            this.order = order;
        }

        /** Takes one point; false when the pen is (or just went) over a cap. */
        boolean take() {
            return take(1L);
        }

        /** Takes {@code n} points at once (cache hits); false when they do not fit. */
        boolean take(long n) {
            return response.take(this, n);
        }

        public long cap() {
            return cap;
        }

        public Overflow overflow() {
            return overflow;
        }

        public boolean isOver() {
            return overflow != Overflow.NONE;
        }

        /**
         * Points the pen's writers tried to store so far, including those refused after the pen went over a cap
         * (the writer never stops counting). Once the pen's queries ended this is the pen's exact demand.
         */
        public long wanted() {
            synchronized (response) {
                return wanted;
            }
        }

        /** Points stored so far by the pen's writers (kept also after a retire / eviction). */
        public long stored() {
            synchronized (response) {
                return stored;
            }
        }

        /** True while a retired allowance still stores for the chunk cache (it went over its own cap: false). */
        public boolean cacheOnly() {
            return cacheOnly;
        }

        /** Every point offered was kept: not over a cap, or a cache-only zombie still within its own cap. */
        boolean keptAll() {
            return overflow == Overflow.NONE || cacheOnly;
        }
    }

    private static final int INITIAL = 64;
    /** Largest up-front column size (16 Ki points ≈ 256 KB per writer). */
    static final int PREALLOC_MAX = 16_384;

    private final long lo;
    private final long hi;
    private final ValueFilter filter;
    private final PenBudget budget;

    private long[] t;
    private double[] v;
    private int count;
    private int filtered;
    private long rows;
    private long firstTime = Long.MAX_VALUE;
    private int valueCol = 1;
    private volatile Exception error;
    private final boolean aggregated;
    private final boolean pairs;
    private long unseededBefore = Long.MIN_VALUE;
    private boolean hasSeed;
    private double seed;
    private volatile boolean cacheable = true;
    // MinMax pairing: the first row of the current bucket, waiting for its partner.
    private boolean pending;
    private long pendingT;
    private double pendingV;
    private boolean pendingOk;
    // Result of the last evaluate(): accepted (value in lastV, NaN = gap) or dropped.
    private boolean lastOk;
    private double lastV;

    /**
     * @param lo     first timestamp kept (inclusive)
     * @param hi     first timestamp dropped (exclusive)
     * @param filter     plausibility filter for the pen
     * @param aggregated true for an aggregated query ({@code Bad_NotFound} rows are empty buckets), false for raw
     * @param budget     the pen's shared allowance
     */
    public PenSeriesWriter(long lo, long hi, ValueFilter filter, boolean aggregated, PenBudget budget) {
        this(lo, hi, filter, aggregated, false, budget);
    }

    /**
     * @param pairs true for a MinMax query: rows are kept or dropped per bucket, two at a time (see the class comment)
     */
    public PenSeriesWriter(long lo, long hi, ValueFilter filter, boolean aggregated, boolean pairs, PenBudget budget) {
        this.lo = lo;
        this.hi = hi;
        this.filter = filter;
        this.aggregated = aggregated;
        this.pairs = pairs;
        this.budget = budget;
        this.t = new long[INITIAL];
        this.v = new double[INITIAL];
    }

    /**
     * Marks the result as not cacheable (it is correct for this response but must not be served to later requests,
     * e.g. unseeded Boolean buckets dropped because the seed look-up failed).
     */
    public void notCacheable() {
        cacheable = false;
    }

    /** False when the result must not enter the chunk cache. */
    public boolean cacheable() {
        return cacheable;
    }

    /**
     * Rows stamped before {@code firstSampleBucket} are unseeded Boolean buckets (see the class comment): they take
     * {@code seedValue} (NaN = the seed sample had bad quality → gap) when {@code hasSeed}, else they are dropped.
     * Call before the query starts.
     */
    public void unseededBefore(long firstSampleBucket, boolean hasSeed, double seedValue) {
        this.unseededBefore = firstSampleBucket;
        this.hasSeed = hasSeed;
        this.seed = seedValue;
    }

    @Override
    public void initialize(String[] names, Class<?>[] types, boolean qualityColumns, int expectedRows) {
        valueCol = names != null && names.length > 1 ? 1 : 0;
        // Pre-size from the historian's estimate, but never beyond PREALLOC_MAX: the estimate is often far above
        // the rows actually delivered (a raw window's estimate is not its sample count), and memory taken here is
        // not covered by the point budget. Beyond it the columns grow by doubling as rows arrive.
        if (expectedRows > 0) {
            int n = (int) Math.min(Math.min(expectedRows, budget.cap()) + 1L, PREALLOC_MAX);
            if (n > t.length) {
                t = Arrays.copyOf(t, n);
                v = Arrays.copyOf(v, n);
            }
        }
    }

    @Override
    public void write(Object[] row, QualityCode[] qualities) {
        rows++;
        if (row == null || row.length <= valueCol) {
            return;
        }
        long ts;
        Object tv = row[0];
        if (tv instanceof Date) {
            ts = ((Date) tv).getTime();
        } else if (tv instanceof Number) {
            ts = ((Number) tv).longValue();
        } else {
            return;
        }
        if (ts < lo || ts >= hi) {
            return;
        }
        evaluate(ts, row, qualities);
        if (!pairs) {
            if (lastOk) {
                store(ts, lastV);
            }
            return;
        }
        if (pending && pendingT == ts) {
            // Second row of the bucket: emit the pair (a dropped partner is replaced by the surviving value).
            pending = false;
            if (pendingOk && lastOk) {
                store(ts, pendingV);
                store(ts, lastV);
            } else if (pendingOk || lastOk) {
                double only = pendingOk ? pendingV : lastV;
                store(ts, only);
                store(ts, only);
            }
            return;
        }
        flushPending();
        pending = true;
        pendingT = ts;
        pendingV = lastV;
        pendingOk = lastOk;
    }

    /** Applies the row rules to one in-window row; sets {@link #lastOk} / {@link #lastV}. */
    private void evaluate(long ts, Object[] row, QualityCode[] qualities) {
        lastOk = false;
        if (ts < unseededBefore) {
            if (!hasSeed) {
                filtered++;                 // unseeded bucket and nothing to seed it with: no point
                return;
            }
            lastV = seed;                   // the value the tag held (NaN: bad quality -> gap)
            lastOk = true;
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
        if (!Double.isFinite(d)) {
            return;
        }
        QualityCode q = qualities != null && qualities.length > valueCol ? qualities[valueCol] : null;
        if (aggregated && TagPaths.isNotFound(q)) {
            return;                         // empty aggregate bucket
        }
        if (!filter.accepts(d)) {
            filtered++;
            return;
        }
        lastV = q != null && !q.isGood() ? Double.NaN : d;
        lastOk = true;
    }

    /** A lone buffered MinMax row: emitted twice (0 or 2 rows per bucket). */
    private void flushPending() {
        if (pending) {
            pending = false;
            if (pendingOk) {
                store(pendingT, pendingV);
                store(pendingT, pendingV);
            }
        }
    }

    private void store(long ts, double d) {
        if (ts < firstTime) {
            firstTime = ts;
        }
        if (!budget.take()) {
            if (t.length > INITIAL) {       // over a cap: this pen's data will not be sent, free it now
                t = new long[0];
                v = new double[0];
                count = 0;
            }
            return;
        }
        if (count == t.length) {
            // Doubling up to PREALLOC_MAX, then 1.5x: capacity stays within 1.5x of the points counted against the
            // budget (plus the old array for the moment of the copy).
            long grown = t.length < PREALLOC_MAX ? t.length * 2L : t.length + (t.length >> 1);
            int n = (int) Math.min(Math.max(16L, grown), Math.max(budget.cap() + 1L, 16L));
            t = Arrays.copyOf(t, n);
            v = Arrays.copyOf(v, n);
        }
        t[count] = ts;
        v[count] = d;
        count++;
    }

    /** End of the rows: a buffered lone MinMax row is emitted. Idempotent (the service calls it again after the query). */
    @Override
    public void finish() {
        flushPending();
    }

    @Override
    public void finishWithError(Exception e) {
        error = e == null ? new IllegalStateException("history query failed") : e;
    }

    // =========================================================================================================
    // Results
    // =========================================================================================================

    /** Timestamps (only the first {@link #count()} entries are valid). */
    public long[] t() {
        return t;
    }

    /** Values; NaN = bad-quality gap. */
    public double[] v() {
        return v;
    }

    /** Points kept (0 once the pen went over a cap). */
    public int count() {
        return budget.isOver() ? 0 : count;
    }

    /**
     * Points stored, ignoring a later eviction. Only for filling the chunk cache right after the query ended and
     * {@link #overflowed()} was false: an eviction after that point (another pen's fallback in request order) does not
     * touch the columns any more, but {@link #count()} would already read 0 and an empty chunk would be cached for a
     * range that holds data.
     */
    int storedCount() {
        return count;
    }

    /** Rows dropped by the Boolean garbage filter. */
    public int filtered() {
        return filtered;
    }

    /**
     * Earliest timestamp of an accepted row, also when the row was discarded by a cap ({@code Long.MAX_VALUE}: none).
     * Decides whether the pen needs an anchor.
     */
    public long firstTime() {
        return firstTime;
    }

    /** Rows the historian delivered (diagnostics). */
    public long rows() {
        return rows;
    }

    /** True when the pen went over its cap or the response cap (its data must not be sent). */
    public boolean overflowed() {
        return budget.isOver();
    }

    /**
     * True when the columns hold every in-window point of the rows seen (nothing was refused): the pen is not over a
     * cap, or it is a retired zombie still storing within its own cap for the chunk cache. Decides whether the
     * query's sealed chunks may enter the cache.
     */
    boolean keptAll() {
        return budget.keptAll();
    }

    /** The historian's error, or null. */
    public Exception error() {
        return error;
    }
}
