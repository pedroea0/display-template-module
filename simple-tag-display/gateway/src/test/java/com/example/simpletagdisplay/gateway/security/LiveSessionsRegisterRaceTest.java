package com.example.simpletagdisplay.gateway.security;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.Test;

/**
 * A {@link LiveSessions#register} racing a {@link LiveSessions#end} must never leave a live session with a tombstone.
 * Previously, register cleared the tombstone before its entry existed; an end in between left "alive + tombstone", so
 * the session's next real end returned false and the session-end listeners (per-session caches) never ran for it.
 */
class LiveSessionsRegisterRaceTest {

    private final AtomicLong now = new AtomicLong(1_000_000L);
    private final LiveSessions live = new LiveSessions(now::get);

    /**
     * Register and end race on many fresh ids. Whatever the interleaving, the end state is consistent: either the
     * session ended (no entry; a later end is a repeat) or it is alive — and then its next end must be a real one.
     * Failed on the old code within a few thousand rounds on a multi-core machine (the window is two map calls wide).
     */
    @Test
    void aRegisterRacingAnEndNeverLeavesALiveSessionWithATombstone() throws Exception {
        int rounds = 20_000;
        CyclicBarrier barrier = new CyclicBarrier(2);
        AtomicReference<UUID> current = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        Thread ender = new Thread(() -> {
            try {
                for (int i = 0; i < rounds; i++) {
                    barrier.await();
                    live.end(current.get());
                    barrier.await();
                }
            } catch (Throwable t) {
                failure.compareAndSet(null, t);
            }
        }, "ender");
        ender.start();
        for (int i = 0; i < rounds; i++) {
            UUID id = UUID.randomUUID();
            current.set(id);
            now.incrementAndGet();      // tombstone pruning drops the oldest: this round's must be the newest
            barrier.await();
            live.register(id, SessionScope.Client, null, "operator");
            barrier.await();
            if (live.delegates(id) > 0) {
                assertTrue(live.end(id), "round " + i + ": a live session's next end is a real one");
            }
            assertFalse(live.end(id), "round " + i + ": ended now, a repeat is not");
        }
        ender.join();
        if (failure.get() != null) {
            throw new AssertionError(failure.get());
        }
    }

    /** The racing interleaving, replayed step by step through the public API. */
    @Test
    void anEndBeforeTheEntryExistsIsUndoneByTheRegisterThatFollows() {
        UUID id = UUID.randomUUID();
        assertTrue(live.end(id), "the end lands first (the session has no entry yet)");
        live.register(id, SessionScope.Client, null, "operator");
        assertTrue(live.isAlive(id));
        assertTrue(live.end(id), "the register came after the end: alive, so this end is real");
        assertFalse(live.end(id));
    }

    @Test
    void anEndThatRemovesALiveEntryIsAlwaysAFirstEnd() {
        UUID id = UUID.randomUUID();
        live.register(id, SessionScope.Client, null, "operator");
        assertTrue(live.end(id));
        live.register(id, SessionScope.Client, null, "operator");
        assertTrue(live.end(id), "came back: real end");
        assertEquals(1, live.endedCount());
    }

    @Test
    void theSweepPathStillEndsOnce() {
        UUID id = UUID.randomUUID();
        live.register(id, SessionScope.Client, null, "operator");
        live.unregister(id);
        now.addAndGet(LiveSessions.GRACE_MS + 1);
        assertEquals(List.of(id), live.sweep());
        assertTrue(live.end(id), "the sweep's end");
        assertFalse(live.end(id), "the later SessionShutdownEvent");
    }
}
