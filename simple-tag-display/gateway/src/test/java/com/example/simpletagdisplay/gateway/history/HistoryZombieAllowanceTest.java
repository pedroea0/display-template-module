package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.concurrent.CompletableFuture;

import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.history.AggregationMode;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.paths.parser.TagPathParser;
import org.junit.jupiter.api.Test;

/**
 * Zombie-query capacity and late allowances at the budget level; {@link HistorySecondPhaseTest} drives the same
 * rules through {@code HistoryService.secondPhase}.
 */
class HistoryZombieAllowanceTest {

    private static final QualityCode[] GOOD = {QualityCode.Good, QualityCode.Good};
    private static final long HOUR = 3_600_000L;

    private static TagPath path() {
        try {
            return TagPathParser.parse("[default]CTG/Temp");
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static HistoryService.Plan rawPlan(long from, long to, long cap, ResponseBudget response) {
        HistoryService.Plan p = new HistoryService.Plan(path(), "[default]ctg/temp",
            new ReadPermissionCache.Check(HistoryResult.OK, "Float8", "Core Historian"), null, null,
            new HistoryRequest.PenWindow(from, to, false, null));
        p.cap = cap;
        p.fallbackAgg = AggregationMode.LastValue;
        p.penBudget = response.pen(cap, 0);
        return p;
    }

    /** A running, timed-out query piece over {@code [from, to)} with one 1-hour cache slot per hour in {@code slotHours}. */
    private static HistoryService.Piece runningPiece(HistoryService.Plan plan, long from, long to, long... slotHours) {
        HistoryService.Piece piece = new HistoryService.Piece(from, to, null);
        for (long h : slotHours) {
            long cs = h * HOUR;
            piece.slots.add(new HistoryService.Slot(new HistoryChunkCache.Key(plan.nk, "core historian", null, 0, HOUR, cs),
                cs, cs + HOUR));
        }
        piece.writer = new PenSeriesWriter(from, to, PenSeriesWriter.ValueFilter.NONE, false, plan.penBudget);
        piece.future = new CompletableFuture<>();
        piece.status = HistoryResult.TIMEOUT;
        plan.pieces.add(piece);
        return piece;
    }

    /** {@code n} rows evenly inside {@code [from, from + HOUR)}. */
    private static void rowsInHour(PenSeriesWriter w, long from, int n) {
        for (int i = 0; i < n; i++) {
            w.write(new Object[] {from + i * (HOUR / n), 1.0}, GOOD);
        }
    }

    // ---- a raw zombie's capacity counts the rows of the piece outside its slots ----------------------------------

    @Test
    void aRawZombieCapacityCountsThePieceOutsideItsSlots() {
        ResponseBudget response = new ResponseBudget(1_000_000);
        HistoryService.Plan p = rawPlan(0, 3 * HOUR, 250_000, response);
        // Two sealed slots plus a 1-hour open tail merged into the same piece (enforcePlanCost).
        HistoryService.Piece merged = runningPiece(p, 0, 3 * HOUR, 0, 1);
        assertEquals(3 * 100, HistoryService.zombieCapacity(p, merged, 100), "2 slots + 1 slot length of tail, 100 each");
        HistoryService.Plan q = rawPlan(0, 2 * HOUR, 250_000, response);
        HistoryService.Piece exact = runningPiece(q, 0, 2 * HOUR, 0, 1);
        assertEquals(2 * 100, HistoryService.zombieCapacity(q, exact, 100), "a piece of slots only: unchanged");
        HistoryService.Plan r = rawPlan(0, 2 * HOUR + HOUR / 4, 250_000, response);
        HistoryService.Piece partial = runningPiece(r, 0, 2 * HOUR + HOUR / 4, 0, 1);
        assertEquals(3 * 100, HistoryService.zombieCapacity(r, partial, 100), "a partial tail rounds up to one slot");
    }

    @Test
    void aZombieNearTheChunkMaximumWithATailStillCompletesItsChunks() {
        // maxChunkPoints 100: two full-ish chunks (90 rows each) and 50 rows in the open tail = 230 rows in the piece.
        // The previous limit was 2 x 100 = 200: the zombie stopped at row 201 and nothing was cached.
        ResponseBudget response = new ResponseBudget(1_000_000);
        HistoryService.Plan p = rawPlan(0, 3 * HOUR, 250_000, response);
        HistoryService.Piece piece = runningPiece(p, 0, 3 * HOUR, 0, 1);
        rowsInHour(piece.writer, 0, 90);
        long limit = HistoryService.cacheOnlyLimit(p, p.penBudget.stored(), 100);
        assertEquals(300, limit);
        response.retire(p.penBudget, limit);
        assertTrue(p.penBudget.cacheOnly());
        rowsInHour(piece.writer, HOUR, 90);
        rowsInHour(piece.writer, 2 * HOUR, 50);
        assertTrue(piece.writer.keptAll(), "every row kept: its chunks may enter the cache");
        assertEquals(230, piece.writer.storedCount());
    }

    @Test
    void theZombieLimitIsStillBoundedByThePenCap() {
        ResponseBudget response = new ResponseBudget(1_000_000);
        HistoryService.Plan p = rawPlan(0, 3 * HOUR, 120, response);
        runningPiece(p, 0, 3 * HOUR, 0, 1);
        assertEquals(120, HistoryService.cacheOnlyLimit(p, 0, 100));
    }

    // ---- a late allowance never evicts -------------------------------------------------------------------------------

    @Test
    void anAllowanceWithoutEvictionRefusesItselfAndTouchesNobody() {
        ResponseBudget response = new ResponseBudget(100);
        PenSeriesWriter.PenBudget settled = response.pen(1_000, 1);
        assertTrue(settled.take(90));
        PenSeriesWriter.PenBudget late = response.penWithoutEviction(1_000, 0);   // earlier in request order
        assertTrue(late.take(10), "what is free is taken");
        assertFalse(late.take(1), "nothing left: refused …");
        assertFalse(settled.isOver(), "… without evicting the later pen");
        assertEquals(PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP, late.overflow());
        assertEquals(10, response.remaining(), "its own points went back");
        assertTrue(response.pen(1_000, 2).take(10), "and no cut was set: a later pen may still take them");
    }

    @Test
    void aNormalAllowanceStillEvictsInRequestOrder() {
        ResponseBudget response = new ResponseBudget(100);
        PenSeriesWriter.PenBudget later = response.pen(1_000, 1);
        assertTrue(later.take(90));
        PenSeriesWriter.PenBudget earlier = response.pen(1_000, 0);
        assertTrue(earlier.take(20), "request order: the later pen is evicted (first-phase rule, unchanged)");
        assertTrue(later.isOver());
    }
}
