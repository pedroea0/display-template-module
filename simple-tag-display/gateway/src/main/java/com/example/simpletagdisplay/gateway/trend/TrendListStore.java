package com.example.simpletagdisplay.gateway.trend;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArraySet;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.IntSupplier;

import com.inductiveautomation.ignition.common.util.LoggerEx;

/**
 * Session trend lists v2: which tags each Perspective session has added with "Trend Tag", per
 * trend group. Replaces v1's JSESSIONID-keyed, never-evicted store.
 *
 * <h2>API (used by the display and chart delegates)</h2>
 * {@link #add}, {@link #remove}, {@link #clear}, {@link #get}, listeners per {@link TrendKey}, and the session
 * lifecycle: {@link #evictSession} (session ended: lists and listeners dropped), {@link #clearSession} (logged-in
 * user changed: lists emptied, listeners kept and notified), {@link #clearAll} (module shutdown).
 *
 * <h2>Keys and casing</h2>
 * Callers pass the canonical full path ({@code TagPath.toStringFull()} of a parsed, provider-resolved path).
 * Entries are de-duplicated by its lower-cased form (= {@code TagPaths.normalizedKey}); the casing of
 * the first add is kept for display.
 *
 * <h2>Bounds</h2>
 * {@code ctg.trend.maxPens} entries per list ({@code FULL}), {@code ctg.trend.maxGroupsPerSession} non-empty lists
 * per session ({@code GROUPS_FULL}), {@value #GLOBAL_MAX_ENTRIES} entries in the whole store ({@code FULL}).
 *
 * <h2>Concurrency</h2>
 * Every mutation of a list happens under that list's monitor; {@code computeIfAbsent} results are used directly
 * (never re-read from the map). Listener notification copies {@code (paths, version)} under the lock and calls
 * listeners <em>outside</em> it, so a listener can never deadlock the store.
 */
public final class TrendListStore {

    private static final LoggerEx LOG = LoggerEx.newBuilder().build("SimpleTagDisplay.Trend");

    /** Hard cap on entries across all sessions. */
    public static final int GLOBAL_MAX_ENTRIES = 100_000;

    /** Outcome of {@link #add}. */
    public enum AddResult { ADDED, ALREADY, FULL, GROUPS_FULL }

    /** One trended tag. */
    public static final class Entry {
        private final String path;
        private final String key;
        private final long addedAt;
        private final String addedBy;

        Entry(String path, String key, long addedAt, String addedBy) {
            this.path = path;
            this.key = key;
            this.addedAt = addedAt;
            this.addedBy = addedBy;
        }

        /** Full path as first added (display casing). */
        public String path() {
            return path;
        }

        /** Lower-cased key ({@code TagPaths.normalizedKey}). */
        public String key() {
            return key;
        }

        public long addedAt() {
            return addedAt;
        }

        public String addedBy() {
            return addedBy;
        }
    }

    private static final class TrendList {
        final LinkedHashMap<String, Entry> entries = new LinkedHashMap<>();
    }

    private final IntSupplier maxPens;
    private final IntSupplier maxGroupsPerSession;
    private final ConcurrentHashMap<TrendKey, TrendList> lists = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<TrendKey, Set<TrendListListener>> listeners = new ConcurrentHashMap<>();
    private final AtomicInteger total = new AtomicInteger();
    private final AtomicLong version = new AtomicLong();
    /** Guards list creation (the per-session group bound). Never held while a list monitor is taken. */
    private final Object groupLock = new Object();

    /**
     * @param maxPens             live {@code ctg.trend.maxPens}
     * @param maxGroupsPerSession live {@code ctg.trend.maxGroupsPerSession}
     */
    public TrendListStore(IntSupplier maxPens, IntSupplier maxGroupsPerSession) {
        this.maxPens = maxPens;
        this.maxGroupsPerSession = maxGroupsPerSession;
    }

    // =========================================================================================================
    // Mutations
    // =========================================================================================================

    /** Adds {@code path} (canonical full path) to the session's list of {@code group}. */
    public AddResult add(UUID session, String group, String path, String user) {
        TrendKey k = new TrendKey(session, group);
        String key = path.toLowerCase(Locale.ROOT);
        TrendList list = lists.get(k);
        if (list == null) {
            // Creating a list is rare: one module-wide lock makes the per-session group bound exact even when
            // several tabs of a session add to new groups at the same moment.
            synchronized (groupLock) {
                list = lists.get(k);
                if (list == null) {
                    if (groupCount(session) >= maxGroupsPerSession.getAsInt()) {
                        return AddResult.GROUPS_FULL;
                    }
                    list = new TrendList();
                    lists.put(k, list);
                }
            }
        }
        List<String> paths;
        long v;
        synchronized (list) {
            if (lists.get(k) != list) {
                return add(session, group, path, user);   // the list was evicted meanwhile: start over
            }
            if (list.entries.containsKey(key)) {
                return AddResult.ALREADY;
            }
            if (list.entries.size() >= maxPens.getAsInt()) {
                return AddResult.FULL;
            }
            if (total.incrementAndGet() > GLOBAL_MAX_ENTRIES) {
                total.decrementAndGet();
                if (list.entries.isEmpty()) {
                    lists.remove(k, list);   // do not let a refused add occupy a group slot
                }
                return AddResult.FULL;
            }
            list.entries.put(key, new Entry(path, key, System.currentTimeMillis(), user));
            paths = pathsOf(list);
            v = version.incrementAndGet();
        }
        LOG.debugf("trend add session=%s group=%s count=%d", session, group, paths.size());
        notify(k, paths, v);
        return AddResult.ADDED;
    }

    /** Removes {@code path} (any casing) from the list; true when it was there. */
    public boolean remove(UUID session, String group, String path) {
        TrendKey k = new TrendKey(session, group);
        TrendList list = lists.get(k);
        if (list == null) {
            return false;
        }
        List<String> paths;
        long v;
        synchronized (list) {
            if (list.entries.remove(path.toLowerCase(Locale.ROOT)) == null) {
                return false;
            }
            total.decrementAndGet();
            paths = pathsOf(list);
            v = version.incrementAndGet();
            if (list.entries.isEmpty()) {
                lists.remove(k, list);
            }
        }
        LOG.debugf("trend remove session=%s group=%s count=%d", session, group, paths.size());
        notify(k, paths, v);
        return true;
    }

    /** Empties one list. */
    public void clear(UUID session, String group) {
        TrendKey k = new TrendKey(session, group);
        TrendList list = lists.remove(k);
        if (list == null) {
            return;
        }
        long v;
        synchronized (list) {
            total.addAndGet(-list.entries.size());
            list.entries.clear();
            v = version.incrementAndGet();
        }
        notify(k, List.of(), v);
    }

    /** Paths of a list (immutable copy, insertion order). */
    public List<Entry> get(UUID session, String group) {
        TrendList list = lists.get(new TrendKey(session, group));
        if (list == null) {
            return List.of();
        }
        synchronized (list) {
            return List.copyOf(list.entries.values());
        }
    }

    // =========================================================================================================
    // Listeners
    // =========================================================================================================

    public void addListener(TrendKey k, TrendListListener l) {
        listeners.computeIfAbsent(k, x -> new CopyOnWriteArraySet<>()).add(l);
    }

    public void removeListener(TrendKey k, TrendListListener l) {
        Set<TrendListListener> set = listeners.get(k);
        if (set != null) {
            set.remove(l);
            if (set.isEmpty()) {
                listeners.remove(k, set);
            }
        }
    }

    private void notify(TrendKey k, List<String> paths, long v) {
        Set<TrendListListener> set = listeners.get(k);
        if (set == null) {
            return;
        }
        for (TrendListListener l : set) {
            try {
                l.onTrendListChanged(k, paths, v);
            } catch (RuntimeException e) {
                LOG.warn("Trend list listener failed", e);
            }
        }
    }

    // =========================================================================================================
    // Session lifecycle
    // =========================================================================================================

    /** The session ended: drop its lists and listeners. Returns the number of entries removed. */
    public int evictSession(UUID session) {
        int removed = 0;
        for (TrendKey k : new ArrayList<>(lists.keySet())) {
            if (k.sessionId().equals(session)) {
                TrendList list = lists.remove(k);
                if (list != null) {
                    synchronized (list) {
                        removed += list.entries.size();
                        total.addAndGet(-list.entries.size());
                        list.entries.clear();
                    }
                }
            }
        }
        listeners.keySet().removeIf(k -> k.sessionId().equals(session));
        if (removed > 0) {
            LOG.debugf("trend evict session=%s entries=%d", session, removed);
        }
        return removed;
    }

    /** The logged-in user changed: empty every list of the session, keep and notify listeners. */
    public int clearSession(UUID session) {
        int removed = 0;
        for (TrendKey k : new ArrayList<>(lists.keySet())) {
            if (k.sessionId().equals(session)) {
                TrendList list = lists.get(k);
                if (list != null) {
                    synchronized (list) {
                        removed += list.entries.size();
                    }
                }
                clear(session, k.group());
            }
        }
        return removed;
    }

    /** Sessions that currently own at least one list (for the liveness sweep). */
    public Set<UUID> sessions() {
        Set<UUID> out = ConcurrentHashMap.newKeySet();
        for (TrendKey k : lists.keySet()) {
            out.add(k.sessionId());
        }
        for (TrendKey k : listeners.keySet()) {
            out.add(k.sessionId());
        }
        return Collections.unmodifiableSet(out);
    }

    /** Module shutdown. */
    public void clearAll() {
        int n = total.get();
        lists.clear();
        listeners.clear();
        total.set(0);
        if (n > 0) {
            LOG.infof("Trend lists cleared on shutdown (%d entries)", n);
        }
    }

    public int totalEntries() {
        return total.get();
    }

    private int groupCount(UUID session) {
        int n = 0;
        for (TrendKey k : lists.keySet()) {
            if (k.sessionId().equals(session)) {
                n++;
            }
        }
        return n;
    }

    private static List<String> pathsOf(TrendList list) {
        List<String> out = new ArrayList<>(list.entries.size());
        for (Map.Entry<String, Entry> e : list.entries.entrySet()) {
            out.add(e.getValue().path());
        }
        return Collections.unmodifiableList(out);
    }
}
