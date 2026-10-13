package com.example.simpletagdisplay.gateway.history;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;

/**
 * Realistic point estimates for raw history windows: remembers each tag's recently observed raw
 * sample density so {@link PointBudget} reservations can follow what a request will really hold instead of every raw
 * pen's worst case ({@code ctg.history.maxRawPointsPerPen}, 250 000).
 *
 * <h2>Why</h2>
 * A 1-pen, 1-hour raw request on a 1 Hz tag holds about 3 600 points, and a realtime raw tick a handful; reserving the
 * worst case (250 000) for both would let the 5 M budget admit only 10–20 raw requests gateway-wide whatever their
 * real size.
 *
 * <h2>Rules</h2>
 * <ul>
 *   <li><b>Observation</b> ({@link #observe}): after a raw pen's first-phase queries ended, {@code HistoryService}
 *       reports the densest of (all points / window length) and (points / length) of each piece — a piece is a cache
 *       chunk of 1 h, 6 h or 1 d, so a mostly empty 31-day window with one dense day reports that day's density, not
 *       the 31-day average. Lengths below {@value #MIN_OBSERVATION_MS} ms count as that long (one sample in a 10 ms
 *       incremental window is not 100 samples per second).</li>
 *   <li>An observation may <b>raise</b> the remembered density at once. Lowering it is guarded, because an estimate
 *       is easy to make small (a request for an empty past window, a realtime tick of an on-change tag) and a too small
 *       estimate makes the next requests depend on growth:
 *       <ul>
 *         <li>only a <em>complete</em> (the queries finished; a pen over its cap still counted every row) and
 *             <em>strong</em> observation lowers it — strong means at least {@value #STRONG_MIN_ROWS} rows in a window
 *             of at least {@value #STRONG_WINDOW_MS} ms (the smallest cache chunk); a <em>weak</em> one (an empty
 *             window, a window holding only a few rows, a short window such as an incremental tick) and an
 *             <em>incomplete</em> one (timeout, error) only raise it. The row minimum exists because the historian
 *             delivers rows that are not samples of the window: Core Historian answers a 1 h window after the
 *             tag's last sample with 2 boundary rows, and a window holding only the last sample with 1 (without
 *             the minimum, one or two such rows would count as a strong observation of a nearly empty
 *             tag);</li>
 *         <li>to no less than half of it, and at most once per {@value #LOWER_INTERVAL_MS} ms, so a quiet window
 *             does not make the next estimate of a bursty tag too small, and repeated sparse queries cannot halve it
 *             again and again.</li>
 *       </ul></li>
 *   <li>A tag without a remembered density: a complete strong observation of at least {@value #FIRST_TRUST_ROWS}
 *       rows is remembered as it is; any other complete one as at least {@value #WEAK_FLOOR_PER_S} point per second
 *       (a 10-minute chart load or a 1-second tick still gets a small realistic estimate, and neither an empty window
 *       nor a window with a few boundary rows makes the tag look empty: a sparse window cannot reset a tag nobody
 *       queried for {@value #TTL_MS} ms to almost nothing); an incomplete one is not
 *       remembered (a timed-out pen's partial count over the whole window would be an underestimate), so the tag
 *       keeps the worst case until a complete observation.</li>
 *   <li><b>Estimate</b> ({@link #estimate}): {@code ceil(density × length × }{@value #SAFETY}{@code ) + }{@value #SLACK}
 *       points, never above the pen's cap. A tag without a density younger than {@value #TTL_MS} ms is
 *       <b>unknown</b>: the caller reserves the worst case (the safe fallback), except for a queried range of at most
 *       {@value #UNKNOWN_SHORT_MS} ms, which it estimates at the {@value #WEAK_FLOOR_PER_S} pt/s floor
 *       ({@link #unknownRate}) so a 1-pen × 1-h raw chart of a tag nobody queried yet stays a small request
 *       ({@link PointBudget}, "small reserve"). An estimate that turns out too small is covered by growing the
 *       reservation while the request runs ({@link PointBudget.Reservation#grow}).</li>
 *   <li>Memory: at most {@value #MAX_ENTRIES} entries, least recently used dropped first; keys are server-normalized tag
 *       keys plus the history provider ({@link #key}), never client text.</li>
 * </ul>
 * Thread-safe (one monitor; a few calls per request). The clock is injectable for JUnit.
 */
final class PointEstimator {

    /** Estimates are this many times the remembered density. */
    static final double SAFETY = 2.0;
    /** Points added to every estimate (bounding rows, a sample on the window edge, rounding). */
    static final long SLACK = 256L;
    /** Observation windows shorter than this count as this long. */
    static final long MIN_OBSERVATION_MS = 1_000L;
    /** A complete observation lowers the density only when its window is at least this long (the smallest chunk). */
    static final long STRONG_WINDOW_MS = 3_600_000L;
    /** A complete observation lowers the density only when the window delivered at least this many rows. */
    static final long STRONG_MIN_ROWS = 16L;
    /** A first observation is remembered below the floor only when the window delivered at least this many rows. */
    static final long FIRST_TRUST_ROWS = 1_024L;
    /** A first observation that is not trusted is remembered as at least this many points per second. */
    static final long WEAK_FLOOR_PER_S = 1L;
    /** An unknown tag's queried range up to this long is estimated at the floor instead of the worst case. */
    static final long UNKNOWN_SHORT_MS = 3_600_000L;
    /** The density is lowered at most once per this interval. */
    static final long LOWER_INTERVAL_MS = 15 * 60_000L;
    /** A density older than this is forgotten (the tag is unknown again). */
    static final long TTL_MS = 15 * 60_000L;
    /** Most tags remembered. */
    static final int MAX_ENTRIES = 8_192;

    private static final class Entry {
        final double pointsPerMs;
        final long at;
        /** When the density was last lowered ({@code Long.MIN_VALUE}: never). */
        final long loweredAt;

        Entry(double pointsPerMs, long at, long loweredAt) {
            this.pointsPerMs = pointsPerMs;
            this.at = at;
            this.loweredAt = loweredAt;
        }
    }

    private final LongSupplier clock;
    private final LinkedHashMap<String, Entry> rates = new LinkedHashMap<>(256, 0.75f, true) {
        private static final long serialVersionUID = 1L;

        @Override
        protected boolean removeEldestEntry(Map.Entry<String, Entry> eldest) {
            return size() > MAX_ENTRIES;
        }
    };

    PointEstimator(LongSupplier clockMs) {
        this.clock = clockMs;
    }

    /** The memory key of a tag on one historian. */
    static String key(String normalizedKey, String historyProvider) {
        return normalizedKey + '|' + (historyProvider == null ? "" : historyProvider);
    }

    /** Points per ms of {@code points} over {@code ms} (at least {@link #MIN_OBSERVATION_MS}). */
    static double density(long points, long ms) {
        return Math.max(0L, points) / (double) Math.max(MIN_OBSERVATION_MS, ms);
    }

    /** The remembered density of {@code key} in points per ms, or -1 when unknown (never seen, or expired). */
    synchronized double rate(String key) {
        Entry e = rates.get(key);
        if (e == null) {
            return -1d;
        }
        if (clock.getAsLong() - e.at >= TTL_MS) {
            rates.remove(key);
            return -1d;
        }
        return e.pointsPerMs;
    }

    /**
     * Records an observed density (class comment, "Rules").
     *
     * @param pointsPerMs the observed density ({@link #density}; the densest piece)
     * @param complete    the pen's queries finished (a pen over its cap counts as complete)
     * @param windowMs    the length of the observed window
     * @param rows        the rows the whole window delivered
     */
    synchronized void observe(String key, double pointsPerMs, boolean complete, long windowMs, long rows) {
        if (!(pointsPerMs >= 0d) || Double.isInfinite(pointsPerMs)) {
            return;
        }
        long now = clock.getAsLong();
        boolean strong = rows >= STRONG_MIN_ROWS && windowMs >= STRONG_WINDOW_MS;
        Entry old = rates.get(key);
        if (old == null || now - old.at >= TTL_MS) {
            if (!complete) {
                return;                                         // unknown stays unknown: the worst case
            }
            boolean trusted = strong && rows >= FIRST_TRUST_ROWS;
            double first = trusted ? pointsPerMs : Math.max(pointsPerMs, WEAK_FLOOR_PER_S / 1000d);
            rates.put(key, new Entry(first, now, Long.MIN_VALUE));
            return;
        }
        double prev = old.pointsPerMs;
        if (pointsPerMs >= prev) {
            rates.put(key, new Entry(pointsPerMs, now, old.loweredAt));
        } else if (complete && strong && (old.loweredAt == Long.MIN_VALUE || now - old.loweredAt >= LOWER_INTERVAL_MS)) {
            rates.put(key, new Entry(Math.max(pointsPerMs, prev / 2d), now, now));
        } else {
            rates.put(key, new Entry(prev, now, old.loweredAt));     // kept (and still recent)
        }
    }

    /**
     * The density to estimate a queried range of {@code queryMs} with when the tag is {@code rate} (-1: unknown): the
     * floor for a short range of an unknown tag (class comment, "Estimate"), else {@code rate} as it is.
     */
    static double unknownRate(double rate, long queryMs) {
        return rate < 0d && queryMs <= UNKNOWN_SHORT_MS ? WEAK_FLOOR_PER_S / 1000d : rate;
    }

    /**
     * Points expected in {@code ms} of a tag with density {@code pointsPerMs}, capped at {@code cap}; the cap itself
     * when the density is unknown ({@code < 0}).
     */
    static long estimate(double pointsPerMs, long ms, long cap) {
        if (pointsPerMs < 0d) {
            return cap;
        }
        double expected = Math.ceil(pointsPerMs * Math.max(0L, ms) * SAFETY) + SLACK;
        return expected >= cap ? cap : (long) expected;
    }

    synchronized int size() {
        return rates.size();
    }

    synchronized void clear() {
        rates.clear();
    }
}
