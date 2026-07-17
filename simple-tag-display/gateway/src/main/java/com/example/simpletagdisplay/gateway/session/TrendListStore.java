package com.example.simpletagdisplay.gateway.session;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * In-memory, per-HTTP-session list of trended tag paths.
 *
 * Singleton — one instance lives in the gateway JVM for the life of the module.
 * Storage is a ConcurrentHashMap keyed by HTTP session ID; each value is a
 * synchronized ArrayList of tag paths the user added via "Trend Tag".
 *
 * Why session-scoped (and not user- or project-scoped):
 *   The CTG behavior is intentionally ephemeral — like a Power Chart you build
 *   on the fly. Closing the browser drops the list. Each tab gets its own list.
 *
 * Why no persistence:
 *   Same reason. If we ever need durable trend lists, write them to the project's
 *   tag history store or a custom resource — not here.
 *
 * Concurrency:
 *   - sessionToPaths is a ConcurrentHashMap → safe to look up / put concurrently.
 *   - Per-list reads/writes are synchronized on the inner List instance to
 *     prevent two add()s racing and inserting the same path twice.
 *   - getList() returns a defensive copy so callers can iterate without holding
 *     the lock.
 */
public final class TrendListStore {

    private static final TrendListStore INSTANCE = new TrendListStore();

    /** sessionId → tag-path list. Inner lists are guarded by `synchronized(list)`. */
    private final Map<String, List<String>> sessionToPaths = new ConcurrentHashMap<>();

    public static TrendListStore getInstance() {
        return INSTANCE;
    }

    private TrendListStore() {}

    /** @return defensive copy of the session's list (or empty list if session unknown).
     *  The copy is taken under the same monitor add()/remove() use — copying an ArrayList
     *  that another thread is concurrently mutating can otherwise yield a torn snapshot
     *  (e.g. a trailing null) that would serialize into the /trendList response. */
    public List<String> getList(String sessionId) {
        if (sessionId == null || sessionId.isEmpty()) {
            return new ArrayList<>();
        }
        List<String> list = sessionToPaths.get(sessionId);
        if (list == null) {
            return new ArrayList<>();
        }
        synchronized (list) {
            return new ArrayList<>(list);
        }
    }

    /** Add `tagPath` (trimmed) to the session's list if not already present. No-op on bad input. */
    public void add(String sessionId, String tagPath) {
        if (sessionId == null || sessionId.isEmpty() || tagPath == null || tagPath.trim().isEmpty()) {
            return;
        }
        sessionToPaths.computeIfAbsent(sessionId, k -> new ArrayList<>());
        List<String> list = sessionToPaths.get(sessionId);
        synchronized (list) {
            if (!list.contains(tagPath.trim())) {
                list.add(tagPath.trim());
            }
        }
    }

    /** Remove `tagPath` from the session's list (if present). Safe no-op otherwise. */
    public void remove(String sessionId, String tagPath) {
        if (sessionId == null || sessionId.isEmpty() || tagPath == null || tagPath.trim().isEmpty()) {
            return;
        }
        List<String> list = sessionToPaths.get(sessionId);
        if (list != null) {
            synchronized (list) {
                list.remove(tagPath.trim());
            }
        }
    }

    /** Drop the session's entire list (currently unused — kept for completeness / future cleanup hook). */
    public void clear(String sessionId) {
        if (sessionId != null && !sessionId.isEmpty()) {
            sessionToPaths.remove(sessionId);
        }
    }
}
