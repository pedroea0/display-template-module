package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.inductiveautomation.perspective.gateway.api.SessionScope;

/**
 * Rate-bucket cleanup of the history route: the token store reports every removal, and the history
 * service drops the rate bucket of a (session, delegate) that has no token left — never the bucket of a chart that
 * just rotated its token (a rotated token keeps its predecessor's remaining budget).
 */
class HistoryRateBucketCleanupTest {

    private final GatewayServices services;
    private final HistoryService history;

    HistoryRateBucketCleanupTest() {
        Map<String, String> p = new HashMap<>();
        p.put("ctg.history.minIntervalMs", "200");
        services = new GatewayServices(null, null, new ModuleSettings(p::get));
        history = services.history();
    }

    @AfterEach
    void close() {
        services.close();
    }

    private HistoryTokenStore.TokenInfo issue(UUID session, String owner) {
        return services.tokens().issue(new HistoryTokenStore.IssueRequest(session, "CTG_Test", SessionScope.Client, owner,
            "0:1", "engineer", "10.0.0.5", null, false));
    }

    private int entries() {
        return ((Number) history.diagnostics().get("rateLimiterEntries")).intValue();
    }

    @Test
    void theTokenStoreReportsEveryRemoval() {
        AtomicLong now = new AtomicLong(1_000_000L);
        java.util.Set<UUID> dead = new java.util.HashSet<>();
        HistoryTokenStore store = new HistoryTokenStore(now::get, () -> 900_000L, () -> 300_000L, id -> !dead.contains(id));
        List<String> log = new ArrayList<>();
        store.onRemoved((Collection<HistoryTokenStore.TokenInfo> removed) -> removed.forEach(t -> log.add(t.ownerId())));
        UUID s1 = UUID.randomUUID();
        UUID s2 = UUID.randomUUID();
        HistoryTokenStore.IssueRequest a = new HistoryTokenStore.IssueRequest(s1, "P", SessionScope.Client, "a", "0:1", "u",
            "h", null, false);
        store.issue(a);
        now.incrementAndGet();
        store.issue(a);                                     // rotation: the first stays for its grace
        assertTrue(log.isEmpty(), "a rotation within PER_OWNER removes nothing");
        now.incrementAndGet();
        store.issue(a);                                     // the oldest is dropped
        assertEquals(List.of("a"), log);
        HistoryTokenStore.TokenInfo b = store.issue(new HistoryTokenStore.IssueRequest(s1, "P", SessionScope.Client, "b",
            "0:1", "u", "h", null, false));
        store.revoke(b.token());
        assertEquals(List.of("a", "b"), log);
        store.revoke(b.token());
        assertEquals(2, log.size(), "an unknown token reports nothing");
        assertEquals(2, store.revokeOwner("a"));
        assertEquals(4, log.size());
        store.issue(new HistoryTokenStore.IssueRequest(s2, "P", SessionScope.Client, "c", "0:1", "u", "h", null, false));
        dead.add(s2);
        assertEquals(1, store.sweep());
        assertEquals(List.of("a", "b", "a", "a", "c"), log);
        // A failing listener does not stop the others.
        List<String> second = new ArrayList<>();
        store.onRemoved(x -> second.add("ok"));
        store.onRemoved(x -> {
            throw new IllegalStateException("listener bug");
        });
        HistoryTokenStore.TokenInfo d = store.issue(new HistoryTokenStore.IssueRequest(s1, "P", SessionScope.Client, "d",
            "0:1", "u", "h", null, false));
        store.revoke(d.token());
        assertEquals(List.of("ok"), second);
    }

    @Test
    void aDelegateStopDropsItsRateBucketButARotationKeepsIt() throws Exception {
        UUID sid = UUID.randomUUID();
        HistoryTokenStore.TokenInfo t1 = issue(sid, "chart-1");
        HistoryTokenStore.TokenInfo other = issue(sid, "chart-2");
        for (int i = 0; i < 3; i++) {
            history.checkInterval(t1);
        }
        history.checkInterval(other);
        assertEquals(2, entries());
        // Rotation (chart.token): the owner gets a new token, the old one drops later — the bucket stays.
        issue(sid, "chart-1");
        issue(sid, "chart-1");                              // third issue: the first token is removed and reported
        assertEquals(2, entries(), "rotated: the owner still has a token, so it keeps its remaining budget");
        HistoryTokenStore.TokenInfo t3 = issue(sid, "chart-1");
        double left = 0;
        for (int i = 0; i < HistoryRateLimiter.BURST; i++) {
            try {
                history.checkInterval(t3);
                left++;
            } catch (HistoryService.Refused e) {
                break;
            }
        }
        assertTrue(left < HistoryRateLimiter.BURST, "no fresh burst after a rotation: " + left);
        // Delegate stop: every token of the owner is revoked → its bucket goes, the other chart's stays.
        services.tokens().revokeOwner("chart-1");
        assertEquals(1, entries());
        // Session end: everything of the session goes.
        services.tokens().revokeSession(sid);
        assertEquals(0, entries());
    }

    @Test
    void theSessionEndListenerDropsBucketsWithoutTokenEvents() throws Exception {
        UUID sid = UUID.randomUUID();
        UUID keep = UUID.randomUUID();
        HistoryTokenStore.TokenInfo t = issue(sid, "c1");
        HistoryTokenStore.TokenInfo k = issue(keep, "c2");
        history.checkInterval(t);
        history.checkInterval(k);
        assertEquals(2, entries());
        services.sessionEnded(sid);
        assertEquals(1, entries(), "only the ended session's bucket");
        assertEquals(0L, ((Number) history.diagnostics().get("budgetWaiting")).longValue());
    }
}
