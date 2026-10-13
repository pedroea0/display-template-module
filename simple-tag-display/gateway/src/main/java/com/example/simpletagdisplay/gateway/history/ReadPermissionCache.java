package com.example.simpletagdisplay.gateway.history;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.LongSupplier;

/**
 * Short-lived cache of the history permission/type pre-check.
 *
 * The historian never filters by user, so every history request reads {@code base, .DataType,
 * .HistoryEnabled, .HistoryProvider} of each pen with the session user's security context first. A realtime chart
 * repeats that for the same pens every tick; this cache spares those reads for {@value #TTL_MS} ms.
 *
 * <h2>Key = (session, auth generation, normalized path)</h2>
 * The auth generation ({@code LiveSessions.authGeneration}) is bumped on every login/logout/user switch, so an entry
 * of the previous user is never found again — no sweep needed (an engineer logs out, an operator logs in within
 * 30 s → fresh check → {@code accessDenied}). Entries of ended sessions are dropped by {@link #removeSession}.
 * A changed tag permission takes effect within the TTL.
 *
 * Bounded (LRU, {@value #MAX_ENTRIES} entries); thread-safe.
 */
public final class ReadPermissionCache {

    public static final long TTL_MS = 30_000L;
    public static final int MAX_ENTRIES = 50_000;

    /** Outcome of the pre-check for one path. Immutable. */
    public static final class Check {
        private final String status;
        private final String dataType;
        private final String historyProvider;

        public Check(String status, String dataType, String historyProvider) {
            this.status = status;
            this.dataType = dataType;
            this.historyProvider = historyProvider;
        }

        /** {@code HistoryResult} pen status ({@code ok} = may be queried). */
        public String status() {
            return status;
        }

        /** {@code DataType} name, or null when unknown. */
        public String dataType() {
            return dataType;
        }

        /** The tag's history provider (status ok only). */
        public String historyProvider() {
            return historyProvider;
        }

        public boolean ok() {
            return HistoryResult.OK.equals(status);
        }

        public boolean isBoolean() {
            return "Boolean".equals(dataType);
        }
    }

    private static final class Key {
        final UUID session;
        final long generation;
        final String path;
        final int hash;

        Key(UUID session, long generation, String path) {
            this.session = session;
            this.generation = generation;
            this.path = path;
            this.hash = Objects.hash(session, generation, path);
        }

        @Override
        public boolean equals(Object o) {
            if (!(o instanceof Key)) {
                return false;
            }
            Key k = (Key) o;
            return hash == k.hash && generation == k.generation && session.equals(k.session) && path.equals(k.path);
        }

        @Override
        public int hashCode() {
            return hash;
        }
    }

    private static final class Entry {
        final Check check;
        final long at;

        Entry(Check check, long at) {
            this.check = check;
            this.at = at;
        }
    }

    private final LongSupplier clock;
    private final LinkedHashMap<Key, Entry> map = new LinkedHashMap<>(256, 0.75f, true) {
        private static final long serialVersionUID = 1L;

        @Override
        protected boolean removeEldestEntry(Map.Entry<Key, Entry> eldest) {
            return size() > MAX_ENTRIES;
        }
    };

    public ReadPermissionCache(LongSupplier clockMs) {
        this.clock = clockMs;
    }

    /** The cached check, or null (absent or older than the TTL). */
    public Check get(UUID session, long authGeneration, String normalizedPath) {
        Key k = new Key(session, authGeneration, normalizedPath);
        synchronized (map) {
            Entry e = map.get(k);
            if (e == null) {
                return null;
            }
            if (clock.getAsLong() - e.at > TTL_MS) {
                map.remove(k);
                return null;
            }
            return e.check;
        }
    }

    public void put(UUID session, long authGeneration, String normalizedPath, Check check) {
        synchronized (map) {
            map.put(new Key(session, authGeneration, normalizedPath), new Entry(check, clock.getAsLong()));
        }
    }

    /** Drops every entry of a session (session ended or user changed). */
    public void removeSession(UUID session) {
        synchronized (map) {
            map.keySet().removeIf(k -> k.session.equals(session));
        }
    }

    public int size() {
        synchronized (map) {
            return map.size();
        }
    }

    public void clear() {
        synchronized (map) {
            map.clear();
        }
    }
}
