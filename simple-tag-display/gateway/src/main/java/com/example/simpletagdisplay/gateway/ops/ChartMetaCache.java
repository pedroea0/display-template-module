package com.example.simpletagdisplay.gateway.ops;

import java.util.Collection;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.LongSupplier;

import com.example.simpletagdisplay.gateway.security.UserContext;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;

/**
 * Session-level cache of chart pen metadata, shared by all chart delegates of a session so that several charts
 * showing the same tag read its metadata once per TTL.
 *
 * <h2>Key</h2>
 * {@code (sessionId, identity, normalizedKey)} where {@code identity} is the user's permission identity
 * ({@link #identity(UserContext)}: user name, roles and security-level paths). This is stricter than keying by the
 * session's auth generation: a meta read that a chart delegate started with its <em>previous</em> user's security
 * context while another delegate of the session had already bumped the generation can never be served to the new
 * user (it is filed under the old identity). After a logout / login the new identity misses the cache, so a status
 * such as {@code ok} for a tag the new user may not read is never reused.
 *
 * <h2>Bounds</h2>
 * TTL {@value #TTL_MS} ms, at most {@value #MAX_ENTRIES} entries (LRU). Per-session entries are dropped when the session
 * ends or its user changes ({@code GatewayServices.onSessionEnd / onUserChange}, registered once by the factory of
 * {@link ChartOps#metaCache}). One module-wide instance ({@code GatewayServices.shared}); thread-safe.
 */
public final class ChartMetaCache {

    public static final long TTL_MS = 60_000L;
    public static final int MAX_ENTRIES = 20_000;

    /**
     * Metadata and status of one pen tag for one user. Immutable.
     *
     * {@code status}: ok | notFound | accessDenied | invalidPath (not an AtomicTag) | unsupportedType | noHistory.
     * {@code meta} / {@code history} are null for notFound and accessDenied (nothing about a tag the user may not
     * read leaves the gateway).
     */
    public static final class PenMeta {
        private final String status;
        private final JsonObject meta;
        private final JsonObject history;
        private final DataType dataType;

        public PenMeta(String status, JsonObject meta, JsonObject history, DataType dataType) {
            this.status = Objects.requireNonNull(status);
            this.meta = meta;
            this.history = history;
            this.dataType = dataType;
        }

        public String status() {
            return status;
        }

        /** {@code {dataType, engUnit, engLow, engHigh, formatString, documentation}} (deep copy), or null. */
        public JsonObject meta() {
            return meta == null ? null : meta.deepCopy();
        }

        /** {@code {available, provider}} (deep copy), or null. */
        public JsonObject history() {
            return history == null ? null : history.deepCopy();
        }

        public DataType dataType() {
            return dataType;
        }

        public boolean ok() {
            return "ok".equals(status);
        }
    }

    private static final class Entry {
        final PenMeta meta;
        final long at;

        Entry(PenMeta meta, long at) {
            this.meta = meta;
            this.at = at;
        }
    }

    private final LongSupplier clock;
    private final LinkedHashMap<String, Entry> map = new LinkedHashMap<>(256, 0.75f, true);
    /**
     * Per-session index: session -> (normalized key -> full map keys, one per identity). {@link #invalidate} and
     * {@link #evictSession} touch only that session's entries instead of scanning the module-wide map under the lock.
     */
    private final Map<UUID, Map<String, Set<String>>> bySession = new HashMap<>();

    public ChartMetaCache() {
        this(System::currentTimeMillis);
    }

    ChartMetaCache(LongSupplier clock) {
        this.clock = clock;
    }

    /** Permission identity of a user: name, roles and security levels (sorted), so two users never share entries. */
    public static String identity(UserContext u) {
        List<String> roles = u.roles().stream().sorted().toList();
        List<String> levels = u.levelPaths().stream().sorted().toList();
        return (u.authenticated() ? "a:" : "n:") + u.userName() + "|" + String.join(",", roles) + "|" + String.join(",", levels);
    }

    private static String key(UUID session, String identity, String normalizedKey) {
        return session + "\u0000" + identity + "\u0000" + normalizedKey;
    }

    private static UUID sessionOf(String fullKey) {
        return UUID.fromString(fullKey.substring(0, fullKey.indexOf('\u0000')));
    }

    private static String normalizedKeyOf(String fullKey) {
        return fullKey.substring(fullKey.lastIndexOf('\u0000') + 1);
    }

    private void index(String fullKey) {
        bySession.computeIfAbsent(sessionOf(fullKey), s -> new HashMap<>())
            .computeIfAbsent(normalizedKeyOf(fullKey), k -> new HashSet<>(2)).add(fullKey);
    }

    private void unindex(String fullKey) {
        UUID session = sessionOf(fullKey);
        Map<String, Set<String>> byKey = bySession.get(session);
        if (byKey == null) {
            return;
        }
        String nk = normalizedKeyOf(fullKey);
        Set<String> full = byKey.get(nk);
        if (full != null && full.remove(fullKey) && full.isEmpty()) {
            byKey.remove(nk);
            if (byKey.isEmpty()) {
                bySession.remove(session);
            }
        }
    }

    /** Fresh entry, or null when absent or older than the TTL. */
    public synchronized PenMeta get(UUID session, String identity, String normalizedKey) {
        String k = key(session, identity, normalizedKey);
        Entry e = map.get(k);
        if (e == null) {
            return null;
        }
        if (clock.getAsLong() - e.at >= TTL_MS) {
            map.remove(k);
            unindex(k);
            return null;
        }
        return e.meta;
    }

    public synchronized void put(UUID session, String identity, String normalizedKey, PenMeta meta) {
        String k = key(session, identity, normalizedKey);
        map.put(k, new Entry(meta, clock.getAsLong()));
        index(k);
        while (map.size() > MAX_ENTRIES) {
            Iterator<String> it = map.keySet().iterator();
            String eldest = it.next();
            it.remove();
            unindex(eldest);
        }
    }

    /** Drops the entries of some keys for every identity of the session (tag created / deleted / permission flip). */
    public synchronized void invalidate(UUID session, Collection<String> normalizedKeys) {
        Map<String, Set<String>> byKey = bySession.get(session);
        if (normalizedKeys.isEmpty() || byKey == null) {
            return;
        }
        for (String nk : normalizedKeys) {
            Set<String> full = byKey.remove(nk);
            if (full != null) {
                full.forEach(map::remove);
            }
        }
        if (byKey.isEmpty()) {
            bySession.remove(session);
        }
    }

    /** Drops every entry of a session (session end, user change). */
    public synchronized void evictSession(UUID session) {
        Map<String, Set<String>> byKey = bySession.remove(session);
        if (byKey != null) {
            byKey.values().forEach(full -> full.forEach(map::remove));
        }
    }

    public synchronized int size() {
        return map.size();
    }

    /** Test view: entries reachable through the per-session index (must always equal {@link #size()}). */
    synchronized int indexedSize() {
        int n = 0;
        for (Map<String, Set<String>> byKey : bySession.values()) {
            for (Set<String> full : byKey.values()) {
                n += full.size();
            }
        }
        return n;
    }

    /** Test / diagnostics view. */
    synchronized Map<String, PenMeta> snapshot() {
        Map<String, PenMeta> out = new LinkedHashMap<>();
        map.forEach((k, v) -> out.put(k, v.meta));
        return out;
    }
}
