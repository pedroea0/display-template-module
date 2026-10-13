package com.example.simpletagdisplay.gateway.history;

import java.util.Arrays;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;

/**
 * LRU cache of <b>sealed</b> history chunks.
 *
 * <h2>What is cached</h2>
 * Only chunks that end before {@code serverNow - ctg.history.sealMarginMs} (5 min) <b>and</b> are settled: the
 * historian has a stored raw sample at or after the chunk end ({@code HistoryService.admitSettled}).
 * The time rule alone is not enough: under analog compression (the default for Float tags) Core Historian holds the
 * newest value back until the next change and interpolates later buckets toward the live value, so the answer for a
 * past chunk changes when the held value is finally stored. Settled data changes only by late backfills, which the
 * 30-minute TTL covers. Live-edge chunks are always queried.
 * Geometry (chosen by {@link HistoryService}; aligned to epoch 0 so pans and zooms at the same level reuse them):
 * <ul>
 *   <li>aggregated: {@code chunkMs = bucketMs × 500};</li>
 *   <li>raw: the smallest of {1 h, 6 h, 1 d} giving at most 50 chunks over the window.</li>
 * </ul>
 *
 * <h2>Key and security</h2>
 * {@code normalizedPath | historyProvider | mode | aggregation | bucketMs | chunkMs | chunkStart}. There is no user in
 * the key: the read-permission pre-check runs for every pen <em>before</em> any cache lookup, so sealed data is
 * only shared between users who are all allowed to read the tag (a user who lost access gets
 * {@code accessDenied} and never reaches the cache). Cache statistics are only exposed with {@code ctg.debug}
 * (hit/miss timing would tell a user what others looked at).
 *
 * <h2>Bounds</h2>
 * Total bytes ≤ {@code ctg.history.cacheMb} (read live; 0 disables the cache and drops its content), LRU eviction,
 * entry TTL 30 min, a single chunk larger than 1/8 of the budget is not cached. Values are immutable copies trimmed
 * to their exact length. Thread-safe (one lock; every operation is O(1) amortized apart from eviction).
 */
public final class HistoryChunkCache implements AutoCloseable {

    /** Entry lifetime: covers late backfills / historian edits of sealed data. */
    public static final long TTL_MS = 30 * 60_000L;
    /** Rough per-entry overhead (key, entry, array headers) in bytes. */
    static final long ENTRY_OVERHEAD = 160L;

    /** Cache key (immutable value object). */
    public static final class Key {
        private final String path;
        private final String provider;
        private final String mode;
        private final String aggregation;
        private final long bucketMs;
        private final long chunkMs;
        private final long chunkStart;
        private final int hash;

        /**
         * @param normalizedPath {@code TagPaths.normalizedKey}
         * @param provider       history provider name as configured on the tag (case-insensitive)
         * @param aggregation    aggregate name, or null for raw
         * @param bucketMs       bucket width (0 for raw)
         */
        public Key(String normalizedPath, String provider, String aggregation, long bucketMs, long chunkMs, long chunkStart) {
            this.path = normalizedPath;
            this.provider = provider == null ? "" : provider.toLowerCase(java.util.Locale.ROOT);
            this.mode = aggregation == null ? HistoryRequest.MODE_RAW : HistoryRequest.MODE_AGGREGATED;
            this.aggregation = aggregation;
            this.bucketMs = bucketMs;
            this.chunkMs = chunkMs;
            this.chunkStart = chunkStart;
            this.hash = Objects.hash(path, this.provider, mode, aggregation, bucketMs, chunkMs, chunkStart);
        }

        @Override
        public boolean equals(Object o) {
            if (this == o) {
                return true;
            }
            if (!(o instanceof Key)) {
                return false;
            }
            Key k = (Key) o;
            return hash == k.hash && bucketMs == k.bucketMs && chunkMs == k.chunkMs && chunkStart == k.chunkStart
                && path.equals(k.path) && provider.equals(k.provider) && mode.equals(k.mode)
                && Objects.equals(aggregation, k.aggregation);
        }

        @Override
        public int hashCode() {
            return hash;
        }
    }

    /** One cached chunk: sorted columns, NaN values are bad-quality gaps. Never modify the arrays. */
    public static final class Chunk {
        final long[] t;
        final double[] v;
        final long createdAt;
        final long bytes;

        Chunk(long[] t, double[] v, long createdAt) {
            this.t = t;
            this.v = v;
            this.createdAt = createdAt;
            this.bytes = bytesFor(t.length);
        }

        public int count() {
            return t.length;
        }
    }

    private final LongSupplier maxBytes;
    private final LongSupplier clock;
    private final LinkedHashMap<Key, Chunk> map = new LinkedHashMap<>(256, 0.75f, true);
    private long bytes;
    private final AtomicLong hits = new AtomicLong();
    private final AtomicLong misses = new AtomicLong();

    /**
     * @param maxBytes live budget in bytes ({@code ctg.history.cacheMb × 1 MiB}; ≤ 0 disables)
     * @param clockMs  time source (tests)
     */
    public HistoryChunkCache(LongSupplier maxBytes, LongSupplier clockMs) {
        this.maxBytes = maxBytes;
        this.clock = clockMs;
    }

    /** Estimated heap size of a chunk with {@code points} points. */
    static long bytesFor(long points) {
        return ENTRY_OVERHEAD + points * 16L;
    }

    /**
     * Largest chunk {@link #put} accepts now, in points (a chunk over 1/8 of the budget is not cached); 0 when the
     * cache is disabled. A timed-out query that keeps running only to fill chunks never needs to hold more per
     * chunk.
     */
    public long maxChunkPoints() {
        long budget = maxBytes.getAsLong();
        return budget <= 0 ? 0L : Math.max(0L, (budget / 8 - ENTRY_OVERHEAD) / 16L);
    }

    /** True when the cache is enabled ({@code cacheMb > 0}). */
    public boolean enabled() {
        return maxBytes.getAsLong() > 0;
    }

    /** The chunk, or null (absent, expired or cache disabled). Counts a hit or a miss. */
    public Chunk get(Key key) {
        if (!enabled()) {
            return null;
        }
        Chunk c;
        synchronized (map) {
            c = map.get(key);
            if (c != null && clock.getAsLong() - c.createdAt > TTL_MS) {
                map.remove(key);
                bytes -= c.bytes;
                c = null;
            }
        }
        (c == null ? misses : hits).incrementAndGet();
        return c;
    }

    /**
     * Stores a copy of {@code t[from..to)} / {@code v[from..to)} (sorted) as the content of {@code key}.
     *
     * @return true when stored (false: disabled or the chunk is larger than 1/8 of the budget)
     */
    public boolean put(Key key, long[] t, double[] v, int from, int to) {
        long budget = maxBytes.getAsLong();
        int n = Math.max(0, to - from);
        if (budget <= 0 || bytesFor(n) > budget / 8) {
            return false;
        }
        Chunk c = new Chunk(Arrays.copyOfRange(t, from, from + n), Arrays.copyOfRange(v, from, from + n), clock.getAsLong());
        synchronized (map) {
            Chunk old = map.put(key, c);
            if (old != null) {
                bytes -= old.bytes;
            }
            bytes += c.bytes;
            evictLocked(budget);
        }
        return true;
    }

    /** Re-applies the live budget (settings reload): evicts down to it, clears everything when disabled. */
    public void trim() {
        long budget = maxBytes.getAsLong();
        synchronized (map) {
            if (budget <= 0) {
                map.clear();
                bytes = 0;
            } else {
                evictLocked(budget);
            }
        }
    }

    private void evictLocked(long budget) {
        Iterator<Map.Entry<Key, Chunk>> it = map.entrySet().iterator();
        while (bytes > budget && it.hasNext()) {
            Chunk c = it.next().getValue();
            it.remove();
            bytes -= c.bytes;
        }
    }

    /** Entries (diagnostics, tests). */
    public int size() {
        synchronized (map) {
            return map.size();
        }
    }

    /** Estimated bytes held (diagnostics, tests). */
    public long bytes() {
        synchronized (map) {
            return bytes;
        }
    }

    public long hits() {
        return hits.get();
    }

    public long misses() {
        return misses.get();
    }

    public void clear() {
        synchronized (map) {
            map.clear();
            bytes = 0;
        }
    }

    @Override
    public void close() {
        clear();
    }
}
