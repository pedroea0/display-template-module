package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/** History tokens. */
class HistoryTokenStoreTest {

    private final AtomicLong now = new AtomicLong(1_000_000L);
    private final Set<UUID> dead = new HashSet<>();
    private HistoryTokenStore store;
    private final UUID s1 = UUID.randomUUID();
    private final UUID s2 = UUID.randomUUID();

    @BeforeEach
    void setUp() {
        store = new HistoryTokenStore(now::get, () -> 900_000L, () -> 300_000L, id -> !dead.contains(id));
    }

    private HistoryTokenStore.TokenInfo issue(UUID session, String owner, SessionScope scope) {
        return store.issue(new HistoryTokenStore.IssueRequest(session, "CTG_Test", scope, owner, "0:1", "engineer",
            "10.0.0.5", null, false));
    }

    @Test
    void tokenIs43Base64UrlCharactersAndValidates() {
        HistoryTokenStore.TokenInfo t = issue(s1, "a", SessionScope.Client);
        assertEquals(43, t.token().length());
        assertTrue(t.token().matches("[A-Za-z0-9_-]{43}"));
        assertEquals(HistoryTokenStore.Status.OK, store.validate(t.token()).status());
        assertEquals(now.get() + 900_000L, t.expiresAt());
        assertNull(t.boundRemoteAddr(), "Client tokens are bound to the cookie session, not to an address");
        assertTrue(t.penGate().allows("[default]ctg/temp"), "these tokens carry the ALL gate");
    }

    @Test
    void unknownMalformedExpiredAndDeadSessionTokensFail() {
        assertEquals(HistoryTokenStore.Status.INVALID, store.validate(null).status());
        assertEquals(HistoryTokenStore.Status.INVALID, store.validate("short").status());
        assertEquals(HistoryTokenStore.Status.INVALID, store.validate("x".repeat(43)).status());
        HistoryTokenStore.TokenInfo t = issue(s1, "a", SessionScope.Client);
        now.addAndGet(900_000L);
        assertEquals(HistoryTokenStore.Status.EXPIRED, store.validate(t.token()).status());
        HistoryTokenStore.TokenInfo u = issue(s2, "b", SessionScope.Client);
        dead.add(s2);
        assertEquals(HistoryTokenStore.Status.INVALID, store.validate(u.token()).status());
    }

    @Test
    void designerTokensAreShortLivedAndBoundToTheRemoteAddress() {
        HistoryTokenStore.TokenInfo t = issue(s1, "d", SessionScope.Designer);
        assertEquals(now.get() + 300_000L, t.expiresAt());
        assertEquals("10.0.0.5", t.boundRemoteAddr());
    }

    @Test
    void rotationKeepsThePreviousTokenForAGraceAndDropsOlderOnes() {
        HistoryTokenStore.TokenInfo t1 = issue(s1, "a", SessionScope.Client);
        now.addAndGet(1_000L);
        HistoryTokenStore.TokenInfo t2 = issue(s1, "a", SessionScope.Client);
        assertEquals(HistoryTokenStore.Status.OK, store.validate(t1.token()).status(), "grace");
        assertEquals(now.get() + HistoryTokenStore.ROTATION_GRACE_MS, t1.expiresAt());
        now.addAndGet(1_000L);
        HistoryTokenStore.TokenInfo t3 = issue(s1, "a", SessionScope.Client);
        assertEquals(HistoryTokenStore.Status.INVALID, store.validate(t1.token()).status(), "at most 2 per owner");
        assertEquals(HistoryTokenStore.Status.OK, store.validate(t2.token()).status());
        assertEquals(HistoryTokenStore.Status.OK, store.validate(t3.token()).status());
        now.addAndGet(HistoryTokenStore.ROTATION_GRACE_MS);
        assertEquals(HistoryTokenStore.Status.EXPIRED, store.validate(t2.token()).status(), "grace over");
        assertEquals(HistoryTokenStore.Status.OK, store.validate(t3.token()).status());
    }

    @Test
    void perSessionCapRefusesANewChartInsteadOfEvictingAnotherChartsCurrentToken() {
        // The cap used to revoke the session's oldest token whatever its owner (another live chart's)
        HistoryTokenStore.TokenInfo first = issue(s1, "o0", SessionScope.Client);
        int refused = 0;
        for (int i = 1; i < HistoryTokenStore.PER_SESSION + 5; i++) {
            now.incrementAndGet();
            try {
                issue(s1, "o" + i, SessionScope.Client);
            } catch (HistoryTokenStore.IssueRefused e) {
                assertTrue(e.sessionFull());
                refused++;
            }
        }
        assertEquals(HistoryTokenStore.PER_SESSION, store.size());
        assertEquals(5, refused);
        assertEquals(HistoryTokenStore.Status.OK, store.validate(first.token()).status());
    }

    @Test
    void globalCapEvictsTheOldestInsteadOfRefusing() {
        HistoryTokenStore.TokenInfo first = null;
        for (int i = 0; i < HistoryTokenStore.GLOBAL_MAX + 3; i++) {
            now.incrementAndGet();
            HistoryTokenStore.TokenInfo t = issue(UUID.randomUUID(), "o" + i, SessionScope.Client);
            if (first == null) {
                first = t;
            }
        }
        assertEquals(HistoryTokenStore.GLOBAL_MAX, store.size());
        assertEquals(HistoryTokenStore.Status.INVALID, store.validate(first.token()).status());
    }

    @Test
    void revokeByOwnerSessionAndSweep() {
        HistoryTokenStore.TokenInfo a = issue(s1, "a", SessionScope.Client);
        HistoryTokenStore.TokenInfo b = issue(s1, "b", SessionScope.Client);
        HistoryTokenStore.TokenInfo c = issue(s2, "c", SessionScope.Client);
        assertEquals(1, store.revokeOwner("a"));
        assertEquals(HistoryTokenStore.Status.INVALID, store.validate(a.token()).status());
        assertEquals(1, store.revokeSession(s1));
        assertEquals(HistoryTokenStore.Status.INVALID, store.validate(b.token()).status());
        dead.add(s2);
        assertEquals(1, store.sweep());
        assertEquals(HistoryTokenStore.Status.INVALID, store.validate(c.token()).status());
        assertEquals(0, store.size());
    }

    @Test
    void tokensAreUnique() {
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 500; i++) {
            assertTrue(seen.add(issue(UUID.randomUUID(), "o" + i, SessionScope.Client).token()));
        }
        assertNotEquals(seen.iterator().next(), issue(s1, "x", SessionScope.Client).token());
        assertFalse(seen.isEmpty());
    }

    @Test
    void designerTokensAreNeverIssuedWithoutARemoteAddress() {
        for (String addr : new String[] {null, "", "  "}) {
            org.junit.jupiter.api.Assertions.assertThrows(HistoryTokenStore.IssueRefused.class,
                () -> store.issue(new HistoryTokenStore.IssueRequest(s1, "CTG_Test", SessionScope.Designer, "d", "0:1",
                    "engineer", addr, null, false)), String.valueOf(addr));
        }
        // A refused issue rotates nothing: the owner's current token stays valid.
        HistoryTokenStore.TokenInfo ok = issue(s1, "d", SessionScope.Designer);
        org.junit.jupiter.api.Assertions.assertThrows(HistoryTokenStore.IssueRefused.class,
            () -> store.issue(new HistoryTokenStore.IssueRequest(s1, "CTG_Test", SessionScope.Designer, "d", "0:1",
                "engineer", null, null, false)));
        assertEquals(now.get() + 300_000L, store.validate(ok.token()).info().orElseThrow().expiresAt());
        // Client tokens do not need an address (they are bound to the cookie session).
        assertNull(store.issue(new HistoryTokenStore.IssueRequest(s2, "CTG_Test", SessionScope.Client, "c", "0:1",
            "engineer", null, null, false)).boundRemoteAddr());
    }
}
