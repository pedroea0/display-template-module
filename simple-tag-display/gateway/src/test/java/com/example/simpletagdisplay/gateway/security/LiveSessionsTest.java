package com.example.simpletagdisplay.gateway.security;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.Test;

/** Session liveness with grace, auth generations and user-change detection. */
class LiveSessionsTest {

    private final AtomicLong now = new AtomicLong(10_000_000L);
    private final LiveSessions live = new LiveSessions(now::get);
    private final UUID s = UUID.randomUUID();

    @Test
    void aliveWhileDelegatesExistAndForTheGraceAfterTheLastOne() {
        assertFalse(live.isAlive(s));
        live.register(s, SessionScope.Client, null, "engineer");
        live.register(s, SessionScope.Client, null, "engineer");
        assertEquals(2, live.delegates(s));
        live.unregister(s);
        assertTrue(live.isAlive(s));
        live.unregister(s);
        now.addAndGet(LiveSessions.GRACE_MS);
        assertTrue(live.isAlive(s), "within the grace (navigation / reload)");
        now.addAndGet(1);
        assertFalse(live.isAlive(s));
        assertEquals(List.of(s), live.sweep());
        assertEquals(0, live.size());
    }

    @Test
    void aReturningDelegateWithinTheGraceKeepsTheSession() {
        live.register(s, SessionScope.Designer, null, "designer");
        live.unregister(s);
        now.addAndGet(30_000L);
        live.register(s, SessionScope.Designer, null, "designer");
        now.addAndGet(10 * LiveSessions.GRACE_MS);
        assertTrue(live.isAlive(s));
        assertTrue(live.sweep().isEmpty());
        assertEquals(SessionScope.Designer, live.scope(s));
    }

    @Test
    void removeEndsTheSessionAtOnceAndARacingRegisterStartsFresh() {
        live.register(s, SessionScope.Client, null, "a");
        live.remove(s);
        assertFalse(live.isAlive(s));
        live.register(s, SessionScope.Client, null, "a");
        assertTrue(live.isAlive(s));
        assertEquals(1, live.delegates(s));
    }

    @Test
    void authEventsBumpTheGenerationOncePerEvent() {
        live.register(s, SessionScope.Client, null, "Unauthenticated");
        Object event = new Object();
        LiveSessions.AuthChange a = live.bumpAuth(s, event, "engineer");
        LiveSessions.AuthChange b = live.bumpAuth(s, event, "engineer");   // second delegate, same event object
        assertTrue(a.firstObserver());
        assertTrue(a.userChanged());
        assertFalse(b.firstObserver());
        assertEquals(1, live.authGeneration(s));
        LiveSessions.AuthChange c = live.bumpAuth(s, new Object(), "engineer");   // re-auth, same user
        assertTrue(c.firstObserver());
        assertFalse(c.userChanged());
        assertEquals(2, live.authGeneration(s));
    }

    @Test
    void registerDetectsAUserChangeNoDelegateSawAsAnEvent() {
        assertFalse(live.register(s, SessionScope.Client, null, "engineer").userChanged());
        live.unregister(s);
        LiveSessions.AuthChange c = live.register(s, SessionScope.Client, null, "operator");   // after a login navigation
        assertTrue(c.userChanged());
        assertTrue(c.firstObserver());
        assertEquals(1, live.authGeneration(s));
        assertFalse(live.register(s, SessionScope.Client, null, "operator").userChanged());
    }
}
