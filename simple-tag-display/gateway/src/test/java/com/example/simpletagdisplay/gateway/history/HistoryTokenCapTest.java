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

import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.Test;

/**
 * The per-session token cap used to evict the oldest token of the session whatever its
 * owner, so with 64+ charts every renewal evicted another chart's CURRENT token (401, renew, evict the next…).
 */
class HistoryTokenCapTest {

    private final AtomicLong now = new AtomicLong(1_000_000L);
    private final HistoryTokenStore store = new HistoryTokenStore(now::get, () -> 900_000L, () -> 300_000L, id -> true);
    private final UUID s1 = UUID.randomUUID();

    private HistoryTokenStore.TokenInfo issue(String owner) {
        now.incrementAndGet();
        return store.issue(new HistoryTokenStore.IssueRequest(s1, "CTG_Test", SessionScope.Client, owner, "0:1", "engineer",
            null, null, false));
    }

    @Test
    void renewalsOfManyChartsNeverEvictAnotherChartsCurrentToken() {
        // 40 charts, each renewed twice: 40 current tokens + rotated ones in their grace exceed the 64 cap
        Map<String, HistoryTokenStore.TokenInfo> current = new HashMap<>();
        for (int round = 0; round < 3; round++) {
            for (int i = 0; i < 40; i++) {
                current.put("c" + i, issue("c" + i));
            }
        }
        for (Map.Entry<String, HistoryTokenStore.TokenInfo> e : current.entrySet()) {
            assertEquals(HistoryTokenStore.Status.OK, store.validate(e.getValue().token()).status(),
                e.getKey() + "'s current token (was evicted by the cap)");
        }
        assertTrue(store.size() <= HistoryTokenStore.PER_SESSION);
    }

    @Test
    void aFullSessionRefusesANewChartButLetsEveryChartRenew() {
        List<HistoryTokenStore.TokenInfo> first = new ArrayList<>();
        for (int i = 0; i < HistoryTokenStore.PER_SESSION; i++) {
            first.add(issue("c" + i));
        }
        HistoryTokenStore.IssueRefused r = assertThrows(HistoryTokenStore.IssueRefused.class, () -> issue("new-chart"));
        assertTrue(r.sessionFull());
        for (HistoryTokenStore.TokenInfo t : first) {
            assertEquals(HistoryTokenStore.Status.OK, store.validate(t.token()).status(), "nothing evicted or rotated");
        }
        // a chart that holds a token renews (its own previous token makes the room)
        HistoryTokenStore.TokenInfo renewed = issue("c0");
        assertEquals(HistoryTokenStore.Status.OK, store.validate(renewed.token()).status());
        for (int i = 1; i < first.size(); i++) {
            assertEquals(HistoryTokenStore.Status.OK, store.validate(first.get(i).token()).status(), "c" + i);
        }
        // expired tokens go first
        now.addAndGet(900_000L);
        HistoryTokenStore.TokenInfo later = issue("new-chart");
        assertEquals(HistoryTokenStore.Status.OK, store.validate(later.token()).status());
    }
}
