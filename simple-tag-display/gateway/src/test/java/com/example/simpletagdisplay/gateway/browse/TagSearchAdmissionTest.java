package com.example.simpletagdisplay.gateway.browse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import org.junit.jupiter.api.Test;

/** Search admission: per-session rate and concurrency, the gateway-wide cap, ticket release, eviction. */
class TagSearchAdmissionTest {

    private long now = 1_000_000L;

    private TagSearchAdmission admission() {
        return new TagSearchAdmission(() -> now);
    }

    @Test
    void onePerSessionAndRateLimited() {
        TagSearchAdmission a = admission();
        UUID s = UUID.randomUUID();
        TagSearchAdmission.Admit first = a.tryAcquire(s);                       // token 1 of the burst of 4
        assertNull(first.refusal());
        assertEquals(ErrorCode.BUSY, a.tryAcquire(s).refusal(), "a second search of the same session while one runs (token 2)");
        assertNull(a.tryAcquire(UUID.randomUUID()).refusal(), "another session is not affected");
        first.ticket().release();
        first.ticket().release();
        assertEquals(1, a.running(), "release is idempotent");
        TagSearchAdmission.Admit third = a.tryAcquire(s);                       // token 3
        assertNull(third.refusal());
        third.ticket().release();
        a.tryAcquire(s).ticket().release();                                     // token 4
        assertEquals(ErrorCode.RATE_LIMITED, a.tryAcquire(s).refusal(), "burst of 4 new searches spent");
        now += 1_000;
        assertNull(a.tryAcquire(s).refusal(), "refilled");
    }

    @Test
    void rateRefillsAtOnePerSecond() {
        TagSearchAdmission a = admission();
        UUID s = UUID.randomUUID();
        for (int i = 0; i < TagSearchAdmission.RATE_BURST; i++) {
            TagSearchAdmission.Admit ad = a.tryAcquire(s);
            assertNull(ad.refusal(), "burst " + i);
            ad.ticket().release();
        }
        assertEquals(ErrorCode.RATE_LIMITED, a.tryAcquire(s).refusal());
        now += 1_000;
        TagSearchAdmission.Admit again = a.tryAcquire(s);
        assertNull(again.refusal(), "one token per second");
        assertEquals(ErrorCode.RATE_LIMITED, a.charge(s), "a superseding search is charged to the same bucket");
        now += 1_000;
        assertNull(a.charge(s));
        again.ticket().release();
    }

    @Test
    void gatewayWideCap() {
        TagSearchAdmission a = admission();
        List<TagSearchAdmission.Ticket> held = new ArrayList<>();
        for (int i = 0; i < TagSearchAdmission.MAX_GLOBAL; i++) {
            TagSearchAdmission.Admit ad = a.tryAcquire(UUID.randomUUID());
            assertNull(ad.refusal());
            held.add(ad.ticket());
        }
        UUID fifth = UUID.randomUUID();
        assertEquals(ErrorCode.BUSY, a.tryAcquire(fifth).refusal(), "the gateway runs at most 4 searches");
        held.get(0).release();
        // (fairness: the freed slot goes to the session that was refused, so it is the one that retries here)
        TagSearchAdmission.Admit next = a.tryAcquire(fifth);
        assertNotNull(next.ticket(), "a released slot is reusable");
        assertTrue(next.ticket() != null && !next.ticket().released());
        assertEquals(TagSearchAdmission.MAX_GLOBAL, a.running());
    }

    @Test
    void sessionsAreEvictedAndSwept() {
        TagSearchAdmission a = admission();
        UUID s = UUID.randomUUID();
        TagSearchAdmission.Admit ad = a.tryAcquire(s);
        a.evictSession(s);
        assertEquals(1, a.trackedSessions(), "a session with a running search keeps its entry");
        ad.ticket().release();
        a.evictSession(s);
        assertEquals(0, a.trackedSessions());
        for (int i = 0; i < 50; i++) {
            a.tryAcquire(UUID.randomUUID()).ticket().release();
        }
        assertEquals(50, a.trackedSessions());
        now += TagSearchAdmission.IDLE_MS + 20_000;
        a.tryAcquire(UUID.randomUUID()).ticket().release();
        assertEquals(1, a.trackedSessions(), "idle entries are swept");
        assertFalse(a.running() > 0);
    }

    // ---- fairness of the gateway-wide cap -----------------------------

    private List<TagSearchAdmission.Ticket> fill(TagSearchAdmission a, List<UUID> hogs) {
        List<TagSearchAdmission.Ticket> held = new ArrayList<>();
        for (int i = 0; i < TagSearchAdmission.MAX_GLOBAL; i++) {
            UUID h = UUID.randomUUID();
            hogs.add(h);
            held.add(a.tryAcquire(h).ticket());
        }
        return held;
    }

    @Test
    void freedSlotsGoToWaitingSessionsFirstOldestFirst() {
        TagSearchAdmission a = admission();
        List<UUID> hogs = new ArrayList<>();
        List<TagSearchAdmission.Ticket> held = fill(a, hogs);
        UUID victim = UUID.randomUUID();
        UUID second = UUID.randomUUID();
        assertEquals(ErrorCode.BUSY, a.tryAcquire(victim).refusal(), "cap full: the victim waits");
        now += 100;
        assertEquals(ErrorCode.BUSY, a.tryAcquire(second).refusal(), "a second session waits behind it");
        assertEquals(2, a.waitingSessions());
        held.get(0).release();                                  // a hog's search ends ...
        now += 10;
        assertEquals(ErrorCode.BUSY, a.tryAcquire(hogs.get(0)).refusal(),
            "... and it searches again at once: the freed slot is kept for the waiting sessions (old code: admitted)");
        assertEquals(ErrorCode.BUSY, a.tryAcquire(second).refusal(), "the newer waiter goes after the older one");
        TagSearchAdmission.Admit v = a.tryAcquire(victim);
        assertNull(v.refusal(), "the oldest waiter gets the slot on its retry");
        held.get(1).release();
        assertNull(a.tryAcquire(second).refusal(), "then the next waiter");
        assertEquals(TagSearchAdmission.MAX_GLOBAL, a.running());
        // the hog that was refused waits too now (behind nobody else): it gets the next free slot
        held.get(2).release();
        UUID late = UUID.randomUUID();
        assertEquals(ErrorCode.BUSY, a.tryAcquire(late).refusal(), "the refused hog waits longer than a newcomer");
        now += 1_000;
        assertNull(a.tryAcquire(hogs.get(0)).refusal());
    }

    @Test
    void aWaiterThatDoesNotRetryHoldsAFreeSlotBackOnlyBriefly() {
        TagSearchAdmission a = admission();
        List<UUID> hogs = new ArrayList<>();
        List<TagSearchAdmission.Ticket> held = fill(a, hogs);
        UUID gone = UUID.randomUUID();
        assertEquals(ErrorCode.BUSY, a.tryAcquire(gone).refusal());     // refused at T, never retries
        held.get(0).release();
        now += 3_000;
        UUID other = UUID.randomUUID();
        assertEquals(ErrorCode.BUSY, a.tryAcquire(other).refusal(), "the slot is kept for the waiter for a while");
        now += 2_001;                                                   // T + 5 001: gone's wait expired, other's not
        assertEquals(ErrorCode.BUSY, a.tryAcquire(UUID.randomUUID()).refusal(), "other (refused 2 s ago) is still ahead");
        now += TagSearchAdmission.WAIT_MS + 1;
        assertNull(a.tryAcquire(UUID.randomUUID()).refusal(), "expired waiters no longer hold the slot back");
        assertEquals(0, a.waitingSessions(), "expired entries are dropped");
    }

    @Test
    void aSupersedeDoesNotKeepTheSlotWhileAnotherSessionWaits() {
        TagSearchAdmission a = admission();
        List<UUID> hogs = new ArrayList<>();
        fill(a, hogs);
        assertNull(a.charge(hogs.get(0)), "nobody waits: replacing a search keeps the slot");
        assertEquals(ErrorCode.BUSY, a.tryAcquire(UUID.randomUUID()).refusal());
        assertEquals(ErrorCode.BUSY, a.charge(hogs.get(1)), "someone waits: the replacing chart gives its slot back (old code: kept)");
        assertEquals(2, a.waitingSessions(), "and it waits behind the session that was refused first");
    }
}
