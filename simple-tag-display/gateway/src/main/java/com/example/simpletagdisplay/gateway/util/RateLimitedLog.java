package com.example.simpletagdisplay.gateway.util;

import java.util.concurrent.ConcurrentHashMap;

import com.inductiveautomation.ignition.common.util.LoggerEx;

/**
 * WARN lines that a client could otherwise trigger in a loop are written at most once per interval per key, so
 * no client can flood the gateway log.
 *
 * Keys are chosen by the caller from fixed strings (class + error code / fixed id); they never contain client
 * text, so a client cannot create unbounded keys. Suppressed occurrences are counted and reported
 * with the next line that gets through.
 */
public final class RateLimitedLog {

    private static final int MAX_KEYS = 1024;

    private final LoggerEx log;
    private final long intervalMs;
    private final ConcurrentHashMap<String, long[]> state = new ConcurrentHashMap<>();   // key -> {lastMs, suppressed}

    public RateLimitedLog(LoggerEx log, long intervalMs) {
        this.log = log;
        this.intervalMs = intervalMs;
    }

    /** WARN {@code message} (already sanitised) unless the same key logged within the interval. */
    public void warn(String key, String message) {
        warn(key, message, null);
    }

    /** WARN {@code message} (already sanitised) unless the same key logged within the interval. */
    public void warn(String key, String message, Throwable t) {
        long now = System.currentTimeMillis();
        if (state.size() > MAX_KEYS) {
            state.clear();
        }
        long[] s = state.computeIfAbsent(key, k -> new long[] {0L, 0L});
        long suppressed;
        synchronized (s) {
            if (now - s[0] < intervalMs) {
                s[1]++;
                return;
            }
            suppressed = s[1];
            s[0] = now;
            s[1] = 0;
        }
        String line = suppressed > 0 ? message + " (" + suppressed + " similar suppressed)" : message;
        if (t != null) {
            log.warn(line, t);
        } else {
            log.warn(line);
        }
    }
}
