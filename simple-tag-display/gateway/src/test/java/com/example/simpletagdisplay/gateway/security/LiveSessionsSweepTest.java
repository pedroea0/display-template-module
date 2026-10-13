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
 * The session sweep must not end a session that came back to life between the sweep's
 * snapshot and the end. Before, sweep() removed the dead entry and returned the id, and the caller ended it later; a
 * register in between created a fresh live entry that end() then removed, which stranded a running chart with no
 * session entry (every renewed token failed validation: "Not authorised for history" until reload).
 */
class LiveSessionsSweepTest {

    private final AtomicLong now = new AtomicLong(1_000_000L);
    private final LiveSessions live = new LiveSessions(now::get);

    private UUID deadSession() {
        UUID id = UUID.randomUUID();
        live.register(id, SessionScope.Client, null, "operator");
        live.unregister(id);
        now.addAndGet(LiveSessions.GRACE_MS + 1);
        return id;
    }

    @Test
    void aSessionThatRegistersAfterTheSnapshotIsNotEnded() {
        UUID id = deadSession();
        List<UUID> dead = live.deadIds();
        assertEquals(List.of(id), dead, "the snapshot sees it dead");
        assertTrue(live.delegates(id) == 0 && !live.isAlive(id));
        // the user navigates back to a page with a chart before the sweep reaches this id
        live.register(id, SessionScope.Client, null, "operator");
        assertEquals(LiveSessions.SweepEnd.ALIVE, live.endIfDead(id), "re-checked: alive, nothing ended");
        assertTrue(live.isAlive(id), "the running chart keeps its session entry");
        assertEquals(1, live.delegates(id));
        assertEquals(0, live.endedCount(), "no tombstone either");
        // its next real end is a first end
        assertTrue(live.end(id));
    }

    @Test
    void aStillDeadSessionIsEndedOnceAndAnIdWithoutEntryLikeEnd() {
        UUID id = deadSession();
        assertEquals(List.of(id), live.deadIds());
        assertEquals(1, live.size(), "deadIds removes nothing");
        assertEquals(LiveSessions.SweepEnd.FIRST, live.endIfDead(id));
        assertEquals(0, live.size());
        assertFalse(live.isAlive(id));
        assertEquals(LiveSessions.SweepEnd.REPEAT, live.endIfDead(id), "already ended");
        assertFalse(live.end(id), "a later SessionShutdownEvent is a repeat");
        UUID unknown = UUID.randomUUID();
        assertEquals(LiveSessions.SweepEnd.FIRST, live.endIfDead(unknown), "a trend-only session without entry");
        assertEquals(LiveSessions.SweepEnd.REPEAT, live.endIfDead(unknown));
        assertEquals(LiveSessions.SweepEnd.ALIVE, live.endIfDead(null));
    }

    @Test
    void inGraceIsNotDead() {
        UUID id = UUID.randomUUID();
        live.register(id, SessionScope.Client, null, "operator");
        live.unregister(id);
        now.addAndGet(LiveSessions.GRACE_MS - 1);
        assertTrue(live.deadIds().isEmpty());
        assertEquals(LiveSessions.SweepEnd.ALIVE, live.endIfDead(id), "still in grace");
        assertTrue(live.isAlive(id));
    }
}
