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
 * History budget limits for zombie (abandoned) queries and second-phase re-runs:
 * <ul>
 *   <li>a cache-only zombie keeps (and reserves) only what its still-running cacheable pieces can hold, not its whole
 *       per-pen cap;</li>
 *   <li>a phase-2 re-run that ends over its own cap gets the aggregated fallback like any other over-cap raw pen.</li>
 * </ul>
 */
class HistoryZombieCapTest {

    private static final QualityCode[] GOOD = {QualityCode.Good, QualityCode.Good};
    private static final long HOUR = 3_600_000L;

    private static TagPath path() {
        try {
            return TagPathParser.parse("[default]CTG/Temp");
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static HistoryService.Plan plan(AggregationMode agg, Long bucketMs, long from, long to, long cap,
                                            ResponseBudget response) {
        HistoryService.Plan p = new HistoryService.Plan(path(), "[default]ctg/temp",
            new ReadPermissionCache.Check(HistoryResult.OK, "Float8", "Core Historian"), agg, bucketMs,
            new HistoryRequest.PenWindow(from, to, false, null));
        p.cap = cap;
        p.fallbackAgg = AggregationMode.LastValue;
        p.penBudget = response.pen(cap, 0);
        return p;
    }

    /** A query piece with {@code chunks} cache slots that timed out while its query still runs. */
    private static HistoryService.Piece runningPiece(HistoryService.Plan plan, long from, long to, int chunks) {
        HistoryService.Piece piece = new HistoryService.Piece(from, to, null);
        long step = (to - from) / chunks;
        for (int i = 0; i < chunks; i++) {
            piece.slots.add(new HistoryService.Slot(new HistoryChunkCache.Key(plan.nk, "core historian", null, 0, step,
                from + i * step), from + i * step, from + (i + 1) * step));
        }
        piece.writer = new PenSeriesWriter(from, to, PenSeriesWriter.ValueFilter.NONE, false, plan.penBudget);
        piece.future = new CompletableFuture<>();     // still running
        piece.status = HistoryResult.TIMEOUT;
        plan.pieces.add(piece);
        return piece;
    }

    private static void rows(PenSeriesWriter w, int n) {
        for (int i = 0; i < n; i++) {
            w.write(new Object[] {(long) i, 1.0}, GOOD);
        }
    }

    // ---- cache-only zombie limit -------------------------------------------------------------------------------

    @Test
    void aRawZombieKeepsWhatItsRunningChunksCanHoldNotItsCap() {
        ResponseBudget response = new ResponseBudget(1_000_000);
        HistoryService.Plan p = plan(null, null, 0, 6 * HOUR, 250_000, response);
        HistoryService.Piece running = runningPiece(p, 0, 2 * HOUR, 2);   // 2 chunks still being filled
        rows(running.writer, 300);
        HistoryService.Piece done = new HistoryService.Piece(2 * HOUR, 6 * HOUR, null);
        done.slots.add(new HistoryService.Slot(null, 2 * HOUR, 6 * HOUR));
        done.future = CompletableFuture.completedFuture(null);            // finished: holds nothing more
        done.status = null;
        p.pieces.add(done);
        long stored = p.penBudget.stored();
        assertEquals(300, stored);
        long limit = HistoryService.cacheOnlyLimit(p, stored, 1_000);
        assertEquals(300 + (2 * 1_000 - 300), limit, "stored + what is left of 2 chunks x 1000 points");
        assertTrue(limit < p.cap, "far below the 250 000 cap it used to reserve");
        assertEquals(p.cap, HistoryService.cacheOnlyLimit(p, stored, 10_000_000), "never above the cap");
        assertEquals(stored, HistoryService.cacheOnlyLimit(p, stored, 0), "cache disabled: nothing more to keep");
    }

    @Test
    void anAggregatedZombieIsBoundedByItsBucketRows() {
        ResponseBudget response = new ResponseBudget(1_000_000);
        long bucket = 60_000L;
        HistoryService.Plan p = plan(AggregationMode.MinMax, bucket, 0, 500 * bucket, 100_000, response);
        runningPiece(p, 0, 500 * bucket, 1);
        assertEquals(500 * 2 + 2, HistoryService.cacheOnlyLimit(p, 0, 1_000_000), "500 MinMax buckets + slack");
    }

    @Test
    void retireWithALimitStopsTheZombieAtThatLimit() {
        ResponseBudget response = new ResponseBudget(100);
        PenSeriesWriter.PenBudget zombie = response.pen(1_000, 0);
        PenSeriesWriter w = new PenSeriesWriter(0, Long.MAX_VALUE, PenSeriesWriter.ValueFilter.NONE, false, zombie);
        rows(w, 40);
        response.retire(zombie, 100L);
        assertTrue(zombie.cacheOnly());
        assertEquals(100, response.remaining(), "its points went back to the request");
        rows(w, 60);
        assertTrue(w.keptAll(), "up to the limit");
        rows(w, 1);
        assertFalse(w.keptAll(), "one past the limit: stops, not cacheable");
        PenSeriesWriter.PenBudget plain = response.pen(1_000, 1);
        new PenSeriesWriter(0, Long.MAX_VALUE, PenSeriesWriter.ValueFilter.NONE, false, plain);
        response.retire(plain, 0L);
        assertFalse(plain.cacheOnly(), "limit 0: a plain retire");
    }

    // ---- fallback for a re-run over its own cap ------------------------------------------------------------------

    @Test
    void aReRunThatWentOverItsOwnCapGetsTheFallback() {
        ResponseBudget response = new ResponseBudget(30_000);
        HistoryService.Plan p = plan(null, null, 0, 100_000, 20_000, response);
        p.rerun = true;
        // second phase: fresh allowance, the live edge grew since the first phase → over its own cap
        p.penBudget = response.pen(p.cap, p.order);
        PenSeriesWriter w = new PenSeriesWriter(0, 100_000, PenSeriesWriter.ValueFilter.NONE, false, p.penBudget);
        rows(w, 20_001);
        p.finalStatus = p.penBudget.isOver() ? HistoryResult.TOO_MANY_POINTS : null;
        assertEquals(PenSeriesWriter.PenBudget.Overflow.PEN_CAP, p.penBudget.overflow());
        assertTrue(HistoryService.needsFallback(p, true, true), "previously a re-run never got one");
        assertFalse(HistoryService.needsFallback(p, false, true), "onTooManyPoints is not aggregate");
        assertFalse(HistoryService.needsFallback(p, true, false), "no time left");
        p.cutOff = true;
        assertFalse(HistoryService.needsFallback(p, true, true), "at or after the cut");
    }

    @Test
    void aReRunRefusedByTheResponseCapGetsNoFallback() {
        ResponseBudget response = new ResponseBudget(100);
        HistoryService.Plan p = plan(null, null, 0, 100_000, 20_000, response);
        p.penBudget = response.pen(p.cap, 0);
        assertTrue(response.pen(1_000, 0).take(100));
        PenSeriesWriter w = new PenSeriesWriter(0, 100_000, PenSeriesWriter.ValueFilter.NONE, false, p.penBudget);
        rows(w, 10);
        p.finalStatus = p.penBudget.isOver() ? HistoryResult.TOO_MANY_POINTS : null;
        assertEquals(PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP, p.penBudget.overflow());
        assertFalse(HistoryService.needsFallback(p, true, true), "refused by the response, not over its own cap");
    }
}