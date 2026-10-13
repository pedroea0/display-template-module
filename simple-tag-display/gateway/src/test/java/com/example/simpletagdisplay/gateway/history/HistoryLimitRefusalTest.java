package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.inductiveautomation.perspective.gateway.api.SessionScope;

/**
 * Two problems the history route's limits used to have:
 * <ul>
 *   <li>"A burst wider than maxConcurrentPerSession gets 429 + Retry-After: 1 s, not the bucket refusal": a refusal
 *       now says which limit refused it ({@link HistoryService.Limit}, sent as {@code X-CTG-Limit}); a concurrency
 *       refusal takes nothing from the token's bucket, and a bucket refusal carries its exact wait
 *       ({@code X-CTG-Retry-After-Ms}) so a client is not held for the 1 s minimum of {@code Retry-After}.</li>
 *   <li>"The rate-limiter prune is O(n) per request once there are more than 4096 active tokens": the scan runs at
 *       most once per {@link HistoryRateLimiter#PRUNE_EVERY_MS}.</li>
 * </ul>
 */
class HistoryLimitRefusalTest {

    private final ModuleSettings settings;
    private final GatewayServices services;
    private final HistoryService history;

    HistoryLimitRefusalTest() {
        Map<String, String> p = new HashMap<>();
        p.put("ctg.history.maxConcurrentPerSession", "2");
        p.put("ctg.history.minIntervalMs", "200");
        settings = new ModuleSettings(p::get);
        services = new GatewayServices(null, null, settings);
        history = services.history();
    }

    @AfterEach
    void close() {
        services.close();
    }

    private static HistoryTokenStore.TokenInfo token(String t, UUID session) {
        long now = System.currentTimeMillis();
        return new HistoryTokenStore.TokenInfo(t, session, "P", SessionScope.Client, "owner", "root/chart", "u", now,
            now + 600_000L, null, HistoryTokenStore.PenGate.ALL, false);
    }

    @Test
    void aConcurrencyRefusalSaysSoAndTakesNothingFromTheBucket() throws Exception {
        UUID session = UUID.randomUUID();
        HistoryTokenStore.TokenInfo tok = token("tok-a", session);
        List<HistoryService.Admission> open = new ArrayList<>();
        open.add(history.admit(tok));
        open.add(history.admit(tok));
        HistoryService.Refused r = assertThrows(HistoryService.Refused.class, () -> history.admit(tok),
            "a third request of a session limited to 2 at once");
        assertEquals(ErrorCode.TOO_MANY_REQUESTS, r.code());
        assertEquals(HistoryService.Limit.CONCURRENCY, r.limit(), "named: X-CTG-Limit: concurrency");
        assertEquals(0L, r.retryAfterMs(), "no exact wait: the slot frees when a running request ends");
        // the two admitted requests passed the bucket; the refused one never reached it: 6 of the burst are left
        history.checkInterval(tok);
        history.checkInterval(tok);
        open.forEach(HistoryService.Admission::close);
        for (int i = 0; i < HistoryRateLimiter.BURST - 2; i++) {
            history.checkInterval(tok);
        }
        HistoryService.Refused rate = assertThrows(HistoryService.Refused.class, () -> history.checkInterval(tok));
        assertEquals(HistoryService.Limit.RATE, rate.limit(), "named: X-CTG-Limit: rate");
        assertTrue(rate.retryAfterMs() > 0 && rate.retryAfterMs() <= 200,
            "the exact refill wait (<= minIntervalMs), not the 1 s of Retry-After: " + rate.retryAfterMs());
        assertEquals(1, rate.retryAfterS(), "Retry-After stays whole seconds (HTTP), at least 1");
    }

    @Test
    void theLimiterPruneScanIsAmortisedNotPerRequest() {
        AtomicLong now = new AtomicLong(1_000_000L);
        HistoryRateLimiter limiter = new HistoryRateLimiter(now::get);
        // more than MAX_ENTRIES tokens, all active (none idle): a scan removes nothing
        for (int i = 0; i <= HistoryRateLimiter.MAX_ENTRIES + 10; i++) {
            limiter.acquire("t" + i, 200);
        }
        long before = limiter.pruneScans();
        for (int i = 0; i < 2_000; i++) {
            limiter.acquire("t" + (i % 50), 200);       // 2 000 requests within the same millisecond
        }
        assertTrue(limiter.pruneScans() - before <= 1, "at most one scan per period, not one per request: "
            + (limiter.pruneScans() - before));
        now.addAndGet(HistoryRateLimiter.PRUNE_EVERY_MS);
        limiter.acquire("t1", 200);
        assertEquals(before + 1, limiter.pruneScans(), "the next period scans again");
        // and pruning still works once entries are idle
        now.addAndGet(HistoryRateLimiter.IDLE_MS + HistoryRateLimiter.PRUNE_EVERY_MS);
        limiter.acquire("fresh", 200);
        assertEquals(1, limiter.size(), "idle entries dropped");
    }

    private static HistoryTokenStore.TokenInfo token(String t, UUID session, String owner) {
        long now = System.currentTimeMillis();
        return new HistoryTokenStore.TokenInfo(t, session, "P", SessionScope.Client, owner, "root/chart", "u", now,
            now + 600_000L, null, HistoryTokenStore.PenGate.ALL, false);
    }

    /**
     * The bucket belongs to the session and the owning chart, not to the token string. Rotating the
     * token with chart.token (every call mints a new one) used to start a fresh full burst each time: 18 x 200 instead
     * of 9 on a live gateway.
     */
    @Test
    void aRotatedTokenInheritsTheRemainingBudget() throws Exception {
        UUID session = UUID.randomUUID();
        HistoryTokenStore.TokenInfo first = token("tok-1", session, "chart-A");
        for (int i = 0; i < HistoryRateLimiter.BURST; i++) {
            history.checkInterval(first);
        }
        assertThrows(HistoryService.Refused.class, () -> history.checkInterval(first), "burst used up");
        HistoryTokenStore.TokenInfo rotated = token("tok-2", session, "chart-A");
        HistoryService.Refused r = assertThrows(HistoryService.Refused.class, () -> history.checkInterval(rotated),
            "a rotated token of the same chart has no fresh burst");
        assertEquals(HistoryService.Limit.RATE, r.limit());
        // another chart of the same session, and the same owner id in another session, have their own buckets
        history.checkInterval(token("tok-3", session, "chart-B"));
        history.checkInterval(token("tok-4", UUID.randomUUID(), "chart-A"));
        assertEquals(HistoryService.rateKey(first), HistoryService.rateKey(rotated));
        assertTrue(!HistoryService.rateKey(first).contains("tok-"), "the key holds no token text");
    }
}
