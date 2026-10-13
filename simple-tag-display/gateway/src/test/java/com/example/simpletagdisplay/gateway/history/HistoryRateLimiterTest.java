package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import org.junit.jupiter.api.Test;

/**
 * The history route's per-token rate limit is a token bucket — burst 8, refilled at one
 * request per {@code ctg.history.minIntervalMs} — instead of a fixed 200 ms interval that serialised a chunked load.
 */
class HistoryRateLimiterTest {

    private static final long INTERVAL = 200;

    private final AtomicLong now = new AtomicLong(1_000_000L);
    private final HistoryRateLimiter limiter = new HistoryRateLimiter(now::get);

    @Test
    void aBurstOfEightStartsAtOnceThenTheRefillRateApplies() {
        for (int i = 0; i < HistoryRateLimiter.BURST; i++) {
            assertEquals(0, limiter.acquire("t", INTERVAL), "request " + (i + 1) + " of the burst");
        }
        long wait = limiter.acquire("t", INTERVAL);
        assertEquals(INTERVAL, wait, "the ninth waits one refill interval");
        now.addAndGet(INTERVAL - 1);
        assertEquals(1, limiter.acquire("t", INTERVAL), "1 ms short");
        now.addAndGet(1);
        assertEquals(0, limiter.acquire("t", INTERVAL), "one refilled");
        assertTrue(limiter.acquire("t", INTERVAL) > 0, "and only one");
    }

    @Test
    void theSustainedRateIsUnchanged() {
        // 49 chunk requests sent as fast as the bucket allows: 8 at once, then one per interval.
        int admitted = 0;
        long start = now.get();
        while (admitted < 49) {
            long wait = limiter.acquire("t", INTERVAL);
            if (wait == 0) {
                admitted++;
            } else {
                now.addAndGet(wait);
            }
        }
        assertEquals((49 - HistoryRateLimiter.BURST) * INTERVAL, now.get() - start,
            "49 requests take (49 - 8) x 200 ms; the fixed interval took 48 x 200 ms + the client's margins");
    }

    @Test
    void aRefusedRequestChangesNoState() {
        for (int i = 0; i < HistoryRateLimiter.BURST; i++) {
            limiter.acquire("t", INTERVAL);
        }
        now.addAndGet(INTERVAL / 2);
        long w1 = limiter.acquire("t", INTERVAL);
        long w2 = limiter.acquire("t", INTERVAL);
        assertEquals(INTERVAL / 2, w1);
        assertEquals(w1, w2, "refusals do not push the next request further out");
        now.addAndGet(w1);
        assertEquals(0, limiter.acquire("t", INTERVAL), "a client that honours the wait is admitted");
    }

    @Test
    void tokensAreIndependentAndTheBucketRefillsToItsBurstOnly() {
        for (int i = 0; i < HistoryRateLimiter.BURST; i++) {
            limiter.acquire("a", INTERVAL);
        }
        assertEquals(0, limiter.acquire("b", INTERVAL), "another token has its own bucket");
        now.addAndGet(INTERVAL * 1_000);
        assertEquals(HistoryRateLimiter.BURST, limiter.available("a", INTERVAL), 1e-9, "idle: refilled up to the burst only");
    }

    @Test
    void intervalZeroDisablesTheLimit() {
        for (int i = 0; i < 100; i++) {
            assertEquals(0, limiter.acquire("t", 0));
        }
        assertEquals(0, limiter.size(), "nothing is kept");
    }

    @Test
    void aChangedIntervalChangesTheRefillSpeedOnly() {
        for (int i = 0; i < HistoryRateLimiter.BURST; i++) {
            limiter.acquire("t", INTERVAL);
        }
        assertEquals(1_000, limiter.acquire("t", 1_000), "live setting: 1 s refill now");
        now.addAndGet(50);
        assertEquals(0, limiter.acquire("t", 50), "and back to 50 ms");
    }

    @Test
    void idleEntriesArePrunedAboveTheBound() {
        for (int i = 0; i <= HistoryRateLimiter.MAX_ENTRIES; i++) {
            limiter.acquire("t" + i, INTERVAL);
        }
        now.addAndGet(HistoryRateLimiter.IDLE_MS + 1);
        limiter.acquire("fresh", INTERVAL);
        assertEquals(1, limiter.size(), "idle entries (full buckets again) dropped");
    }

    @Test
    void concurrentRequestsOfOneTokenNeverTakeMoreThanTheBurst() throws Exception {
        int threads = 32;
        AtomicInteger admitted = new AtomicInteger();
        CountDownLatch go = new CountDownLatch(1);
        List<Thread> all = new ArrayList<>();
        for (int i = 0; i < threads; i++) {
            Thread t = new Thread(() -> {
                try {
                    go.await();
                } catch (InterruptedException e) {
                    return;
                }
                if (limiter.acquire("t", INTERVAL) == 0) {
                    admitted.incrementAndGet();
                }
            });
            t.start();
            all.add(t);
        }
        go.countDown();
        for (Thread t : all) {
            t.join();
        }
        assertEquals(HistoryRateLimiter.BURST, admitted.get(), "the clock stands still: exactly the burst");
    }
}
