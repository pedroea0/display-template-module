package com.example.simpletagdisplay.gateway.history;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.LongSupplier;

/**
 * Cache of "last sample before time T" anchors.
 *
 * The anchor lets the chart draw the line entering the plot from the left edge when the first sample inside the
 * window comes later; Boolean aggregated pieces also use it as the seed of their unseeded buckets
 * ({@link PenSeriesWriter}). Looking it up costs one to five historian queries, so answers are shared for
 * {@value #TTL_MS} ms.
 *
 * <h2>Extension</h2>
 * Realtime windows start a little later on every full load, so an exact {@code (path, T)} key is almost never reused
 * (a burst of loads would otherwise fill the cache with dead entries). {@link #lookup} therefore also returns the
 * latest cached answer for an earlier time {@code T0} of the same tag (at most {@code maxExtendMs} earlier): the
 * caller queries only the raw gap {@code [T0, T)} — if it holds no sample the cached anchor is still the last one
 * before {@code T}. The extended entry <em>replaces</em> the base entry and inherits its age, so a chain of extensions
 * still expires {@value #TTL_MS} ms after the full look-up it started from (late backfills are picked up).
 * {@link #NONE} ("no sample within the look-back") extends the same way.
 *
 * Key: {@code normalizedPath | historyProvider}, then T. Bounded: {@value #MAX_KEYS} tags (LRU), {@value #MAX_PER_KEY}
 * times per tag (oldest T dropped). Thread-safe.
 */
public final class AnchorCache {

    public static final long TTL_MS = 60_000L;
    public static final int MAX_KEYS = 4_096;
    public static final int MAX_PER_KEY = 16;

    /** A point before the window ({@code v} NaN = bad quality). Immutable. */
    public static final class Anchor {
        final long t;
        final double v;

        public Anchor(long t, double v) {
            this.t = t;
            this.v = v;
        }

        public long t() {
            return t;
        }

        public double v() {
            return v;
        }
    }

    /** "There is no sample within the look-back": cached like an answer. */
    public static final Anchor NONE = new Anchor(Long.MIN_VALUE, Double.NaN);

    private static final class Entry {
        final Anchor anchor;
        final long at;

        Entry(Anchor anchor, long at) {
            this.anchor = anchor;
            this.at = at;
        }
    }

    /**
     * Result of {@link #lookup}: {@link #exact()} non-null = a cached answer for T itself; else {@link #base()} non-null
     * = the answer for the earlier {@link #baseBefore()}, to be extended over {@code [baseBefore, T)}; else nothing.
     */
    public static final class Lookup {
        private final Anchor exact;
        private final Anchor base;
        private final long baseBefore;
        private final long baseAt;

        Lookup(Anchor exact, Anchor base, long baseBefore, long baseAt) {
            this.exact = exact;
            this.base = base;
            this.baseBefore = baseBefore;
            this.baseAt = baseAt;
        }

        public Anchor exact() {
            return exact;
        }

        public Anchor base() {
            return base;
        }

        public long baseBefore() {
            return baseBefore;
        }
    }

    private static final Lookup MISS = new Lookup(null, null, 0L, 0L);

    private final LongSupplier clock;
    private final LinkedHashMap<String, TreeMap<Long, Entry>> map = new LinkedHashMap<>(256, 0.75f, true) {
        private static final long serialVersionUID = 1L;

        @Override
        protected boolean removeEldestEntry(Map.Entry<String, TreeMap<Long, Entry>> eldest) {
            if (size() > MAX_KEYS) {
                entries -= eldest.getValue().size();
                return true;
            }
            return false;
        }
    };
    private int entries;

    public AnchorCache(LongSupplier clockMs) {
        this.clock = clockMs;
    }

    static String key(String normalizedPath, String provider) {
        return normalizedPath + '|' + (provider == null ? "" : provider.toLowerCase(Locale.ROOT));
    }

    /** The cached anchor for exactly {@code before} ({@link #NONE} included), or null when unknown or expired. */
    public Anchor get(String normalizedPath, String provider, long before) {
        Lookup l = lookup(normalizedPath, provider, before, 0L);
        return l.exact;
    }

    /** Exact answer, or an earlier answer of the same tag at most {@code maxExtendMs} before {@code before}. */
    public Lookup lookup(String normalizedPath, String provider, long before, long maxExtendMs) {
        long now = clock.getAsLong();
        synchronized (map) {
            TreeMap<Long, Entry> times = map.get(key(normalizedPath, provider));
            if (times == null) {
                return MISS;
            }
            Entry e = times.get(before);
            if (e != null && now - e.at <= TTL_MS) {
                return new Lookup(e.anchor, null, 0L, 0L);
            }
            Map.Entry<Long, Entry> floor = times.lowerEntry(before);
            if (floor != null && before - floor.getKey() <= maxExtendMs && now - floor.getValue().at <= TTL_MS) {
                return new Lookup(null, floor.getValue().anchor, floor.getKey(), floor.getValue().at);
            }
            return MISS;
        }
    }

    /** Caches a fresh look-up for {@code before}. */
    public void put(String normalizedPath, String provider, long before, Anchor anchor) {
        store(key(normalizedPath, provider), before, new Entry(anchor, clock.getAsLong()), null);
    }

    /** Caches an extension of {@code base} to {@code before}; the base entry is replaced and its age kept. */
    public void putExtended(String normalizedPath, String provider, long before, Anchor anchor, Lookup base) {
        store(key(normalizedPath, provider), before, new Entry(anchor, base.baseAt), base.baseBefore);
    }

    private void store(String k, long before, Entry e, Long replaces) {
        synchronized (map) {
            TreeMap<Long, Entry> times = map.get(k);
            if (times == null) {
                times = new TreeMap<>();
                map.put(k, times);
            }
            if (replaces != null && times.remove(replaces) != null) {
                entries--;
            }
            if (times.put(before, e) == null) {
                entries++;
            }
            while (times.size() > MAX_PER_KEY) {
                times.pollFirstEntry();
                entries--;
            }
        }
    }

    /** Cached answers over all tags. */
    public int size() {
        synchronized (map) {
            return entries;
        }
    }

    public void clear() {
        synchronized (map) {
            map.clear();
            entries = 0;
        }
    }
}
