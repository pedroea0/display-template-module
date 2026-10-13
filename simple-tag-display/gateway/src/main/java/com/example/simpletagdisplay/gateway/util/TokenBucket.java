package com.example.simpletagdisplay.gateway.util;

import java.util.function.LongSupplier;

/**
 * Classic token bucket: {@code burst} tokens at most, refilled continuously at {@code perSecond}.
 *
 * Used per delegate and per rate class (CONTROL 5/s burst 10, READ 10/s burst 20, MUTATE 2/s burst 5,
 * TOKEN 1/s burst 3) so one page cannot flood the gateway with model events. Thread-safe (the
 * delegate calls it on the session queue only, but the lock is cheap and keeps the class safe to reuse).
 */
public final class TokenBucket {

    private final double perSecond;
    private final double burst;
    private final LongSupplier clockMs;

    private double tokens;
    private long lastRefillMs;

    public TokenBucket(double perSecond, int burst) {
        this(perSecond, burst, System::currentTimeMillis);
    }

    /** @param clockMs millisecond clock (injectable for tests) */
    public TokenBucket(double perSecond, int burst, LongSupplier clockMs) {
        if (perSecond <= 0 || burst < 1) {
            throw new IllegalArgumentException("perSecond must be > 0 and burst >= 1");
        }
        this.perSecond = perSecond;
        this.burst = burst;
        this.clockMs = clockMs;
        this.tokens = burst;
        this.lastRefillMs = clockMs.getAsLong();
    }

    /** Takes one token if available. */
    public synchronized boolean tryAcquire() {
        long now = clockMs.getAsLong();
        long elapsed = Math.max(0L, now - lastRefillMs);
        lastRefillMs = now;
        tokens = Math.min(burst, tokens + elapsed * perSecond / 1000.0);
        if (tokens >= 1.0) {
            tokens -= 1.0;
            return true;
        }
        return false;
    }
}
