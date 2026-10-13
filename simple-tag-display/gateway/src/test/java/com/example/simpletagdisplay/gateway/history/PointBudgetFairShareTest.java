package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import org.junit.jupiter.api.Test;

/**
 * Per-session fair share of the history point budget (see the PointBudget class comment). Limits at the shipped
 * default: limit 5 M, reserve 1 M, pool 4 M, light 250 k, small 15 625, small reserve 250 k.
 */
class PointBudgetFairShareTest {

    private static final long LIMIT = 5_000_000L;
    private static final long FLOOD = 500_000L;          // a 4-pen 31-day raw request's worst case (response cap)

    private final AtomicLong clock = new AtomicLong(1_000_000L);
    private final AtomicLong max = new AtomicLong(LIMIT);
    private final PointBudget b = new PointBudget(max::get, clock::get);

    private static UUID s(int i) {
        return new UUID(0L, i);
    }

    /** Session {@code sid} keeps reserving {@code n} until refused; returns what it got. */
    private List<PointBudget.Reservation> fill(UUID sid, long n, int maxTries) {
        List<PointBudget.Reservation> got = new ArrayList<>();
        for (int i = 0; i < maxTries; i++) {
            PointBudget.Reservation r = b.tryReserve(sid, n);
            if (r == null) {
                break;
            }
            got.add(r);
        }
        return got;
    }

    @Test
    void floodNeverTakesTheReserveAndALightSessionIsAlwaysAdmitted() {
        // Stress load: 5 sessions × 4 lanes keep 500 k requests in flight.
        List<PointBudget.Reservation> all = new ArrayList<>();
        for (int round = 0; round < 4; round++) {
            for (int si = 1; si <= 5; si++) {
                PointBudget.Reservation r = b.tryReserve(s(si), FLOOD);
                if (r != null) {
                    all.add(r);
                }
            }
        }
        assertTrue(b.reserved() <= LIMIT - LIMIT / 5, "the flood stays inside the pool: " + b.reserved());
        // The victim: 1 pen × 1 h raw (a realistic estimate) and, when the tag is unknown, the 250 k worst case.
        UUID victim = s(99);
        PointBudget.Reservation small = b.tryReserve(victim, 8_000L);
        assertNotNull(small, "light request admitted during the flood");
        small.close();
        PointBudget.Reservation unknown = b.tryReserve(victim, 250_000L);
        assertNotNull(unknown, "one raw pen's worst case is still light");
        assertEquals(PointBudget.Refusal.NONE, b.lastRefusal());
        unknown.close();
        all.forEach(PointBudget.Reservation::close);
        assertEquals(0L, b.reserved());
    }

    @Test
    void contendingSessionsConvergeToAnEqualSplitOfThePool() {
        UUID a = s(1);
        UUID bb = s(2);
        List<PointBudget.Reservation> aHeld = fill(a, FLOOD, 20);
        assertEquals(8, aHeld.size(), "alone, A may use the whole pool (work-conserving)");
        assertNull(b.tryReserve(bb, FLOOD), "pool full");
        assertEquals(PointBudget.Refusal.FULL, b.lastRefusal());
        // B is waiting now: A frees one slot but may not take it back (share = 4 M / 2).
        aHeld.remove(0).close();
        assertNull(b.tryReserve(a, FLOOD));
        assertEquals(PointBudget.Refusal.SHARE, b.lastRefusal());
        assertNotNull(b.tryReserve(bb, FLOOD), "B gets the freed slot");
        // A drains to its share; then it may grow again up to 2 M.
        while (b.heldBy(a) > 1_500_000L) {
            aHeld.remove(0).close();
        }
        assertNotNull(b.tryReserve(a, FLOOD), "1.5 M + 0.5 M = the 2 M share");
        assertNull(b.tryReserve(a, FLOOD), "above the share while B waits");
        assertEquals(PointBudget.Refusal.SHARE, b.lastRefusal());
    }

    @Test
    void waitingExpiresSoTheBudgetStaysWorkConserving() {
        UUID a = s(1);
        UUID bb = s(2);
        List<PointBudget.Reservation> aHeld = fill(a, FLOOD, 8);
        assertNull(b.tryReserve(bb, FLOOD));                // B waits
        aHeld.remove(0).close();
        assertNull(b.tryReserve(a, FLOOD), "limited to the share while B waits");
        clock.addAndGet(PointBudget.CONTENTION_TTL_MS);     // B gave up (no refusal for 5 s)
        assertNotNull(b.tryReserve(a, FLOOD), "nobody waiting: A may use the whole pool again");
        assertEquals(0, ((Number) b.diagnostics().get("budgetWaiting")).intValue());
    }

    @Test
    void aSessionHoldingNothingMayAlwaysStartOneRequest() {
        // Ten heavy sessions contend; a new session's single request is above the share (4 M / 11) but it holds nothing.
        for (int si = 1; si <= 10; si++) {
            assertNotNull(b.tryReserve(s(si), 300_000L));
        }
        assertNull(b.tryReserve(s(1), 3_000_000L), "does not fit the pool");   // s1 now waiting
        PointBudget.Reservation big = b.tryReserve(s(42), 900_000L);
        assertNotNull(big, "first request of a session: admitted when it fits the pool, whatever the share");
        assertNull(b.tryReserve(s(42), 50_000L), "but not a second one above the share (4 M / 11)");
        assertEquals(PointBudget.Refusal.SHARE, b.lastRefusal());
    }

    @Test
    void anIdleBudgetAdmitsOneRequestLargerThanThePool() {
        max.set(300_000L);                                  // lowered live; pool 240 k, light 15 k
        PointBudget.Reservation r = b.tryReserve(s(1), 250_000L);
        assertNotNull(r, "idle budget: up to the whole limit");
        assertNull(b.tryReserve(s(2), 250_000L));
        assertNotNull(b.tryReserve(s(3), 10_000L), "a light request still fits the rest of the limit");
        assertNull(b.tryReserve(s(4), 500_000L), "never above the limit");
    }

    @Test
    void optionalReservationsNeverUseTheReserveNorMarkWaiting() {
        UUID a = s(1);
        fill(a, FLOOD, 8);                                  // pool full
        assertNull(b.tryReserveOptional(a, 10_000L), "a zombie's cache-only points do not come from the reserve");
        assertEquals(0, ((Number) b.diagnostics().get("budgetWaiting")).intValue(), "optional refusals do not mark waiting");
        PointBudget.Reservation r = b.tryReserveOptional(s(2), 10_000L);
        assertNull(r, "not even for a light session");
        assertNotNull(b.tryReserve(s(2), 10_000L), "the same points as a request: light, admitted");
    }

    @Test
    void growthFollowsTheAdmissionTiersAndNeverEatsTheReserve() {
        // A request admitted light on a small estimate used to grow into the reserve.
        UUID a = s(1);
        PointBudget.Reservation r = b.tryReserve(a, 10_000L);
        assertEquals(30_000L, r.grow(20_000L, 30_000L), "preferred size when it fits");
        assertEquals(30_000L, r.points());
        assertEquals(30_000L, b.heldBy(a));
        assertEquals(30_000L, r.grow(25_000L, 40_000L), "already covered: unchanged");
        // Fill the pool exactly with other sessions.
        assertEquals(7, fill(s(2), FLOOD, 7).size());
        PointBudget.Reservation third = b.tryReserve(s(3), 470_000L);
        assertNotNull(third);
        assertEquals(LIMIT - LIMIT / 5, b.reserved(), "the pool is full");
        assertEquals(250_000L, r.grow(200_000L, 300_000L), "up to light the reserve is open to it");
        assertEquals(-1L, r.grow(250_001L, 300_000L), "beyond light: never into the reserve, though the limit has room");
        assertEquals(1L, ((Number) b.diagnostics().get("budgetGrowRefused")).longValue());
        PointBudget.Reservation light = b.tryReserve(s(4), 250_000L);
        assertNotNull(light, "the reserve still serves a light session");
        third.close();
        light.close();
        long poolRoom = (LIMIT - LIMIT / 5) - b.reserved();
        assertEquals(250_000L + poolRoom, r.grow(260_000L, 1_000_000L),
            "pool room again: all the room it may use, up to preferred");
        assertTrue(b.reserved() <= LIMIT - LIMIT / 5);
        r.close();
        assertEquals(0L, b.heldBy(a));
        assertEquals(-1L, r.grow(1L, 1L), "a released reservation never grows");
    }

    @Test
    void growthStopsAtTheShareWhileAnotherSessionWaits() {
        UUID a = s(1);
        PointBudget.Reservation r1 = b.tryReserve(a, FLOOD);
        PointBudget.Reservation r2 = b.tryReserve(a, 300_000L);
        assertNotNull(r1);
        assertNotNull(r2);
        assertEquals(2, fill(s(2), FLOOD, 2).size());
        assertNull(b.tryReserve(s(2), LIMIT), "refused: s2 is waiting");
        long share = (LIMIT - LIMIT / 5) / 2;                          // contenders: a, s2
        long mostForR2 = 300_000L + share - 800_000L;
        assertEquals(-1L, r2.grow(mostForR2 + 1, mostForR2 + 100_000L), "past the share while s2 waits");
        assertEquals(mostForR2, r2.grow(mostForR2 - 1, mostForR2 + 100_000L), "up to the share");
        assertEquals(share, b.heldBy(a));
        // The session's only reservation is not held to the share (like admission of a session holding nothing).
        r1.close();
        long poolRoom = (LIMIT - LIMIT / 5) - b.reserved();
        assertEquals(mostForR2 + poolRoom, r2.grow(mostForR2 + 1, mostForR2 + poolRoom));
        r2.close();
    }

    @Test
    void theOnlyReservationMayGrowToTheWholeLimit() {
        max.set(300_000L);                                             // pool 240 k, reserve 60 k, light 15 k
        PointBudget.Reservation r = b.tryReserve(s(1), 10_000L);
        assertEquals(290_000L, r.grow(290_000L, 290_000L), "idle-budget exception, as at admission");
        assertEquals(-1L, r.grow(300_001L, 300_001L), "the limit is hard");
        r.close();
    }

    @Test
    void nearTheLimitTheReservationDoesNotGrowPerRow() {
        // When the preferred step did not fit, the reservation used to grow by the exact need
        // and come back for every row under both monitors.
        // Light tier: the request may use everything up to limit − smallReserve (4.75 M); 20 k are left there.
        PointBudget.Reservation filler = b.fixtureReserve(LIMIT - LIMIT / 5 / 4 - 20_000L);
        assertNotNull(filler);
        PointBudget.Reservation r = b.tryReserve(s(1), 1_000L);
        ResponseBudget resp = new ResponseBudget(500_000L);
        resp.bindGrowth(r::grow, r.points());
        PenSeriesWriter.PenBudget pen = resp.pen(250_000L, 0);
        int stored = 0;
        while (pen.take()) {
            stored++;
        }
        assertEquals(20_000, stored, "every free point is used");
        assertEquals(2L, ((Number) b.diagnostics().get("budgetGrown")).longValue(), "one step, then all the room");
        assertTrue(resp.starved(), "the next row did not fit: BUSY");
        assertNotNull(b.tryReserve(s(2), 10_000L), "the small reserve above it is still open to a small session");
        r.close();
        filler.close();
    }

    @Test
    void lightSessionsCannotFillTheSmallReserve() {
        // 5 flooders fill the pool and 12+ sessions each loop one ~100 k-row raw pen
        // that reserves its 250 k worst case (light); a 1-pen × 1-h session must still be admitted.
        for (int si = 1; si <= 5; si++) {
            fill(s(si), FLOOD, 20);
        }
        assertEquals(LIMIT - LIMIT / 5, b.reserved(), "the pool is full");
        int lights = 0;
        for (int si = 100; si < 112; si++) {
            if (b.tryReserve(s(si), 250_000L) != null) {
                lights++;
            }
        }
        assertEquals(3, lights, "light sessions get the reserve except its small part");
        assertEquals(LIMIT - LIMIT / 5 / 4, b.reserved());
        // 1 pen × 1 h raw at 1 Hz (or an unknown tag at the 1 pt/s floor): 7 456 points, small.
        List<PointBudget.Reservation> smalls = new ArrayList<>();
        for (int si = 200; si < 260; si++) {
            PointBudget.Reservation r = b.tryReserve(s(si), 7_456L);
            if (r == null) {
                break;
            }
            smalls.add(r);
        }
        assertEquals(33, smalls.size(), "250 k / 7 456: at least 33 one-hour charts at once whatever the others do");
        assertEquals(1L * 33, ((Number) b.diagnostics().get("budgetAdmittedSmall")).longValue());
        for (int i = 0; i < 3; i++) {
            smalls.remove(0).close();
        }
        // (the 34th small session, refused above, gives up: after its wait expired the room is not held for it)
        clock.addAndGet(PointBudget.CONTENTION_TTL_MS);
        // A small session's request grows within the small tier (to 15 625 in total), not further.
        UUID v = s(300);
        PointBudget.Reservation victim = b.tryReserve(v, 7_456L);
        assertNotNull(victim);
        assertEquals(LIMIT / 5 / 4 / 16, victim.grow(10_000L, 30_000L), "all the room it may use, up to small");
        assertEquals(-1L, victim.grow(LIMIT / 5 / 4 / 16 + 1, 30_000L), "beyond small it is light: the light tier is full");
        // A second request makes the session light: it no longer fits the small reserve.
        assertNull(b.tryReserve(v, 1_000L));
        // A light reservation cannot grow into the small reserve either.
        victim.close();
        smalls.forEach(PointBudget.Reservation::close);
        PointBudget.Reservation l = b.tryReserve(s(400), 10_000L);
        assertNotNull(l, "small");
        assertEquals(-1L, l.grow(20_000L, 20_000L), "light from 15 626 on, and the light tier is full");
    }

    @Test
    void sessionEndForgetsTheWaitingMark() {
        fill(s(1), FLOOD, 8);
        assertNull(b.tryReserve(s(2), FLOOD));
        b.sessionEnded(s(2));
        assertEquals(0, ((Number) b.diagnostics().get("budgetWaiting")).intValue());
    }

    /**
     * Previously the small reserve was bounded only per session, so 17+ sessions each
     * looping a small request filled it and a refused 1-pen x 1-h chart lost every race for the room they freed. Now
     * the small reserve is shared globally, oldest waiter first.
     */
    @Test
    void manySmallSessionsCannotKeepAWaitingSmallSessionOut() {
        for (int si = 1; si <= 5; si++) {
            fill(s(si), FLOOD, 20);                        // pool full
        }
        for (int si = 100; si < 103; si++) {
            assertNotNull(b.tryReserve(s(si), 250_000L));  // light tier full
        }
        // 34 "sybil" sessions, one 7 456-point request each: the small reserve is full
        List<PointBudget.Reservation> sybils = new ArrayList<>();
        List<UUID> sybilIds = new ArrayList<>();
        for (int si = 200; si < 260; si++) {
            PointBudget.Reservation r = b.tryReserve(s(si), 7_456L);
            if (r == null) {
                break;
            }
            sybils.add(r);
            sybilIds.add(s(si));
        }
        assertEquals(33, sybils.size());
        UUID victim = s(999);
        clock.addAndGet(PointBudget.CONTENTION_TTL_MS);     // the 34th sybil's refusal has expired: only the victim waits
        assertNull(b.tryReserve(victim, 7_456L), "full: the victim waits");
        // the sybils loop: one request ends, its session asks again at once (before the victim's Retry-After)
        for (int round = 0; round < 3; round++) {
            clock.addAndGet(300L);
            sybils.remove(0).close();
            UUID again = sybilIds.remove(0);
            assertNull(b.tryReserve(again, 7_456L), "round " + round + ": the freed room is the victim's (old code: the sybil got it back)");
            sybilIds.add(again);
        }
        clock.addAndGet(1_100L);                           // the victim's Retry-After (2 s)
        PointBudget.Reservation v = b.tryReserve(victim, 7_456L);
        assertNotNull(v, "the waiting small session is admitted on its retry");
        assertTrue(((Number) b.diagnostics().get("budgetRefusedSmallQueue")).longValue() >= 3L, "the sybils were refused for the queue");
        // and the sybils refused meanwhile queue in their refusal order behind it
        PointBudget.Reservation next = b.tryReserve(sybilIds.get(sybilIds.size() - 3), 7_456L);
        assertNotNull(next, "the oldest refused sybil is next (room for 2 more after the victim)");
        v.close();
        next.close();
        sybils.forEach(PointBudget.Reservation::close);
    }

    @Test
    void aWaitingSmallSessionKeepsGrowthOfOthersOutOfItsRoom() {
        for (int si = 1; si <= 5; si++) {
            fill(s(si), FLOOD, 20);
        }
        for (int si = 100; si < 103; si++) {
            assertNotNull(b.tryReserve(s(si), 250_000L));
        }
        List<PointBudget.Reservation> smalls = new ArrayList<>();
        for (int si = 200; si < 260; si++) {
            PointBudget.Reservation r = b.tryReserve(s(si), 7_456L);
            if (r == null) {
                break;
            }
            smalls.add(r);
        }
        clock.addAndGet(PointBudget.CONTENTION_TTL_MS);
        UUID victim = s(999);
        assertNull(b.tryReserve(victim, 7_456L));
        smalls.remove(0).close();
        smalls.remove(0).close();                          // 2 x 7 456 + 3 952 free = 18 864
        PointBudget.Reservation grower = smalls.get(0);
        long most = grower.grow(12_000L, 15_625L);
        assertEquals(-1L, most, "growing to 12 000 would leave less than one small request for the waiter (old code: grew to 15 625)");
        assertNotNull(b.tryReserve(victim, 7_456L), "the waiter gets its room");
        smalls.forEach(PointBudget.Reservation::close);
    }
}
