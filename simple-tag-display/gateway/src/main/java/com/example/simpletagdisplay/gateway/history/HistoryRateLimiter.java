package com.example.simpletagdisplay.gateway.history;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.LongSupplier;

/**
 * Per-token request rate limit of the history route: a token bucket per history token.
 * The bucket key is the token's session plus owning delegate ({@code HistoryService.rateKey}), so a rotated token
 * keeps its predecessor's budget; the parameter is still called {@code token} below.
 *
 * <h2>Why a bucket instead of a fixed interval</h2>
 * A fixed minimum interval ({@code ctg.history.minIntervalMs}, 200 ms) between two requests of a token is too slow
 * for chunked loads. A chunked raw load is a <em>sequence</em> of requests (newest chunk first), so a 49-chunk window
 * would take 49 × ~220 ms ≈ 10.7 s however fast the historian answered. A bucket keeps the same sustained
 * rate — one request per {@code minIntervalMs} — but lets a short sequence through at once: {@value #BURST} requests
 * may start back to back, after which requests are admitted at the refill rate again. The realtime tick (one request
 * per second at most) never notices the difference.
 *
 * <h2>Rules</h2>
 * <ul>
 *   <li>A token unknown to the limiter starts with a full bucket ({@value #BURST} requests).</li>
 *   <li>Every admitted request takes one; the bucket refills continuously at 1 per {@code intervalMs}, up to
 *       {@value #BURST}. {@code intervalMs} is read live at every call (the setting is live-reloadable); the bucket
 *       state is in requests, so a changed interval only changes the refill speed.</li>
 *   <li>{@code intervalMs} 0 disables the limit.</li>
 *   <li>A refused request changes no state: a client that waits the returned time is admitted.</li>
 *   <li>Each call is one atomic {@link ConcurrentHashMap#compute} per token, so two concurrent requests of one token
 *       can never both take the last request.</li>
 *   <li>Memory: one small entry per token used in the last minute; above {@value #MAX_ENTRIES} entries the idle ones
 *       are dropped (an entry idle that long has a full bucket again — {@code BURST × 5 000 ms} at most — so dropping
 *       it changes nothing). Keys are server-issued tokens, never client text. The prune scans the whole map, so it
 *       runs at most once per {@value #PRUNE_EVERY_MS} ms: with more than {@value #MAX_ENTRIES} tokens all active,
 *       a per-request scan would visit them all and remove nothing; the scan cost is amortised over every request
 *       of that second instead (O(1) per request on average).</li>
 *   <li>An entry also goes as soon as its owner has no token left ({@link #remove}, called by
 *       {@code HistoryService} when the token store reports a revoke, a delegate stop or an expiry) and when its
 *       session ends ({@link #removeSession}), so the map tracks the live charts instead of sitting near
 *       {@value #MAX_ENTRIES} entries on a busy gateway. Removing an entry early is as safe as the
 *       prune: the worst case is one fresh burst for an owner that gets a token again (an idle owner's bucket is full
 *       anyway); a rotating chart keeps its entry because its new token is in the store before the old one is
 *       reported.</li>
 * </ul>
 * The clock is injectable for JUnit.
 */
final class HistoryRateLimiter {

    /** Requests one token may start back to back. */
    static final int BURST = 8;
    /** Entries kept before idle ones are pruned. */
    static final int MAX_ENTRIES = 4_096;
    /** An entry idle this long is pruned (its bucket is full again). */
    static final long IDLE_MS = 60_000L;
    /** At most one prune scan per this many ms (amortised). */
    static final long PRUNE_EVERY_MS = 1_000L;
    /** Rounding slack for the fractional request count. */
    private static final double EPSILON = 1e-6;

    /** Immutable bucket state (replaced, never mutated, inside {@code compute}). */
    private static final class State {
        final double requests;
        final long at;

        State(double requests, long at) {
            this.requests = requests;
            this.at = at;
        }
    }

    private final LongSupplier clock;
    private final ConcurrentHashMap<String, State> byToken = new ConcurrentHashMap<>();
    /** Clock time of the last prune scan; {@code Long.MIN_VALUE / 2} = never (no overflow in the subtraction). */
    private final AtomicLong lastPruneAt = new AtomicLong(Long.MIN_VALUE / 2);
    /** Prune scans run so far (tests: the scan is amortised, not per request). */
    private final AtomicLong pruneScans = new AtomicLong();

    HistoryRateLimiter(LongSupplier clockMs) {
        this.clock = clockMs;
    }

    /**
     * Takes one request from {@code token}'s bucket.
     *
     * @param intervalMs the refill interval ({@code ctg.history.minIntervalMs}); 0 = unlimited
     * @return 0 when the request may start now, else the milliseconds until one request is available again (&gt; 0)
     */
    long acquire(String token, long intervalMs) {
        if (intervalMs <= 0) {
            return 0L;
        }
        long now = clock.getAsLong();
        pruneIfDue(now);
        long[] wait = {0L};
        byToken.compute(token, (k, st) -> {
            double available = st == null ? BURST
                : Math.min(BURST, st.requests + Math.max(0L, now - st.at) / (double) intervalMs);
            if (available >= 1.0 - EPSILON) {
                return new State(Math.max(0.0, available - 1.0), now);
            }
            // EPSILON: 199 ms of a 200 ms refill must read "1 ms", not 2 (binary fractions of a request).
            wait[0] = Math.max(1L, (long) Math.ceil((1.0 - available) * intervalMs - EPSILON));
            return st;                              // refused: no state change
        });
        return wait[0];
    }

    /**
     * Drops idle entries when the map is over {@link #MAX_ENTRIES} — at most once per {@link #PRUNE_EVERY_MS} (the
     * compare-and-set elects one caller per period; the others skip the scan). Pruning is safe at any time: an entry
     * idle for {@link #IDLE_MS} has a full bucket, which is also what an unknown token starts with.
     */
    private void pruneIfDue(long now) {
        if (byToken.size() <= MAX_ENTRIES) {
            return;
        }
        long last = lastPruneAt.get();
        if (now - last < PRUNE_EVERY_MS || !lastPruneAt.compareAndSet(last, now)) {
            return;
        }
        pruneScans.incrementAndGet();
        byToken.entrySet().removeIf(e -> now - e.getValue().at > IDLE_MS);
    }

    /** Drops the bucket of one key (its owner has no token left). */
    void remove(String key) {
        byToken.remove(key);
    }

    /**
     * Drops every bucket of one session: keys are {@code <session id>/<owner id>} ({@code HistoryService.rateKey}),
     * both server-issued, so the prefix is exact.
     */
    void removeSession(String sessionId) {
        String prefix = sessionId + "/";
        byToken.keySet().removeIf(k -> k.startsWith(prefix));
    }

    /** Prune scans so far (tests). */
    long pruneScans() {
        return pruneScans.get();
    }

    /** Requests {@code token} could start right now (diagnostics and tests). */
    double available(String token, long intervalMs) {
        State st = byToken.get(token);
        if (st == null) {
            return BURST;
        }
        return Math.min(BURST, st.requests + Math.max(0L, clock.getAsLong() - st.at) / (double) Math.max(1L, intervalMs));
    }

    int size() {
        return byToken.size();
    }

    void clear() {
        byToken.clear();
    }
}
