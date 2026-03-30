package com.example.simpletagdisplay.gateway.session;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Session-scoped store of tag paths to trend. Keyed by HTTP session ID.
 */
public final class TrendListStore {

    private static final TrendListStore INSTANCE = new TrendListStore();

    private final Map<String, List<String>> sessionToPaths = new ConcurrentHashMap<>();

    public static TrendListStore getInstance() {
        return INSTANCE;
    }

    private TrendListStore() {}

    public List<String> getList(String sessionId) {
        if (sessionId == null || sessionId.isEmpty()) {
            return new ArrayList<>();
        }
        List<String> list = sessionToPaths.get(sessionId);
        return list == null ? new ArrayList<>() : new ArrayList<>(list);
    }

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

    public void clear(String sessionId) {
        if (sessionId != null && !sessionId.isEmpty()) {
            sessionToPaths.remove(sessionId);
        }
    }
}
