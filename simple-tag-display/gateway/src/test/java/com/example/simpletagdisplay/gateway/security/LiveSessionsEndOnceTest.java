package com.example.simpletagdisplay.gateway.security;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.Test;

/**
 * A session ends once. The sweep ends a session whose page shows no module
 * component any more; the {@code SessionShutdownEvent} for the same id later must not run the session-end reactions a
 * second time — unless the session registered a delegate again in between.
 */
class LiveSessionsEndOnceTest {

    private final AtomicLong now = new AtomicLong(1_000_000L);
    private final LiveSessions live = new LiveSessions(now::get);

    @Test
    void sweepThenShutdownEventEndsOnce() {
        UUID id = UUID.randomUUID();
        live.register(id, SessionScope.Client, null, "operator");
        live.unregister(id);
        now.addAndGet(LiveSessions.GRACE_MS + 1);
        List<UUID> dead = live.sweep();
        assertEquals(List.of(id), dead);
        assertTrue(live.end(id), "the sweep's end is the first");
        assertFalse(live.end(id), "the later SessionShutdownEvent: already ended");
        assertFalse(live.isAlive(id));
    }

    @Test
    void aSessionThatCameBackEndsAgain() {
        UUID id = UUID.randomUUID();
        assertTrue(live.end(id), "an id never seen: a real end (e.g. a session without module components)");
        live.register(id, SessionScope.Client, null, "operator");   // the page shows a display again
        assertTrue(live.isAlive(id));
        assertTrue(live.end(id), "alive again since: its next end is real");
        assertFalse(live.end(id));
    }

    @Test
    void tombstonesAreBounded() {
        for (int i = 0; i < LiveSessions.MAX_ENDED + 50; i++) {
            live.end(UUID.randomUUID());
            now.incrementAndGet();
        }
        assertTrue(live.endedCount() <= LiveSessions.MAX_ENDED, "bounded: " + live.endedCount());
        UUID old = UUID.randomUUID();
        live.end(old);
        now.addAndGet(LiveSessions.ENDED_TTL_MS + 1);
        for (int i = 0; i < LiveSessions.MAX_ENDED; i++) {
            live.end(UUID.randomUUID());
        }
        assertTrue(live.end(old), "an expired tombstone is forgotten: at worst a second end, the old behaviour");
        live.clear();
        assertEquals(0, live.endedCount());
    }
}