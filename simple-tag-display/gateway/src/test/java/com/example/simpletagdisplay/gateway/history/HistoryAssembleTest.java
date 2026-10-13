package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.Map;

import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.history.AggregationMode;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.paths.parser.TagPathParser;
import org.junit.jupiter.api.Test;

/**
 * Assembly after the fallback phase (a pen evicted by an earlier pen's aggregated fallback used to come back as ok
 * with no data): a live gateway scenario, replayed against the budget and the assembly.
 * Raw, {@code onTooManyPoints:"aggregate"}, per-pen cap 4 999, {@code maxPointsPerResponse} 10 000:
 * k0 has 6 000 points (over its cap → 3 000-bucket fallback), k1 and k2 have 4 500 each.
 */
class HistoryAssembleTest {

    private static final QualityCode[] GOOD = {QualityCode.Good, QualityCode.Good};
    private static final int RESPONSE_MAX = 10_000;
    private static final long PEN_CAP = 4_999;

    private static ModuleSettings.Settings settings() {
        Map<String, String> p = new HashMap<>();
        p.put("ctg.history.maxPointsPerResponse", Integer.toString(RESPONSE_MAX));
        return ModuleSettings.Settings.read(p::get, w -> { });
    }

    private static TagPath path(String name) {
        try {
            return TagPathParser.parse("[default]CTG/" + name);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    /** A full raw pen over [0, 10 000) with one query piece. */
    private static HistoryService.Plan rawPlan(String name, int order, ResponseBudget response) {
        HistoryService.Plan plan = new HistoryService.Plan(path(name), "[default]ctg/" + name.toLowerCase(),
            new ReadPermissionCache.Check(HistoryResult.OK, "Float8", "Core Historian"), null, null,
            new HistoryRequest.PenWindow(0, 10_000, false, null));
        plan.order = order;
        plan.cap = PEN_CAP;
        plan.fallbackAgg = AggregationMode.LastValue;
        plan.penBudget = response.pen(PEN_CAP, order);
        HistoryService.Piece piece = new HistoryService.Piece(0, 10_000, null);
        piece.writer = new PenSeriesWriter(0, 10_000, PenSeriesWriter.ValueFilter.NONE, false, plan.penBudget);
        plan.pieces.add(piece);
        return plan;
    }

    private static void rows(PenSeriesWriter w, int n) {
        for (int i = 0; i < n; i++) {
            w.write(new Object[] {(long) i, 1.0}, GOOD);
        }
        w.finish();
    }

    /** settle() for pens whose queries all finished. */
    private static void settled(HistoryService.Plan plan) {
        plan.finalStatus = plan.penBudget.isOver() ? HistoryResult.TOO_MANY_POINTS : null;
    }

    /** The fallback phase for k0: a 3 000-bucket aggregated re-query in k0's request order. */
    private static void fallback(HistoryService.Plan plan, ResponseBudget response, int buckets) {
        plan.fallbackBudget = response.pen(buckets + 2L, plan.order);
        HistoryService.Piece fb = new HistoryService.Piece(0, 10_000, null);
        fb.writer = new PenSeriesWriter(0, 10_000, PenSeriesWriter.ValueFilter.NONE, true, false, plan.fallbackBudget);
        plan.fallback = fb;
        plan.fallbackBucket = 2;
        rows(fb.writer, buckets);
        fb.status = null;
    }

    private static HistoryResult.Pen assemble(String key, HistoryService.Plan plan) {
        return HistoryService.assemble(key, plan, settings(), false);
    }

    @Test
    void aLaterPenEvictedByAnEarlierPensFallbackIsTooManyPointsNotAnEmptyOk() {
        ResponseBudget response = new ResponseBudget(RESPONSE_MAX);
        HistoryService.Plan k0 = rawPlan("Bulk01", 0, response);
        HistoryService.Plan k1 = rawPlan("Inc1", 1, response);
        HistoryService.Plan k2 = rawPlan("Inc2", 2, response);
        rows(k0.pieces.get(0).writer, 6_000);           // over its own cap: gives its share back
        rows(k1.pieces.get(0).writer, 4_500);
        rows(k2.pieces.get(0).writer, 4_500);
        settled(k0);
        settled(k1);
        settled(k2);
        assertEquals(HistoryResult.TOO_MANY_POINTS, k0.finalStatus);
        assertEquals(null, k2.finalStatus, "k2 settled as data before the fallback phase");

        fallback(k0, response, 3_000);                  // 3 000 + 4 500 + 4 500 > 10 000 → k2 evicted
        assertEquals(PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP, k2.penBudget.overflow());

        response.freeze();
        HistoryService.reconcile(k0);
        HistoryService.reconcile(k1);
        HistoryService.reconcile(k2);

        HistoryResult.Pen p0 = assemble("k0", k0);
        HistoryResult.Pen p1 = assemble("k1", k1);
        HistoryResult.Pen p2 = assemble("k2", k2);
        assertEquals(HistoryResult.OK, p0.status());
        assertTrue(p0.downgraded());
        assertEquals(3_000, p0.count());
        assertEquals(HistoryResult.OK, p1.status());
        assertEquals(4_500, p1.count());
        assertEquals(HistoryResult.TOO_MANY_POINTS, p2.status(), "evicted pen: never ok with its points missing");
        assertEquals(0, p2.count());
        assertEquals(Integer.valueOf(RESPONSE_MAX), p2.limit, "the response cap refused it");
    }

    @Test
    void assemblyChecksTheAllowanceEvenWithoutReconcile() {
        ResponseBudget response = new ResponseBudget(RESPONSE_MAX);
        HistoryService.Plan k0 = rawPlan("Bulk01", 0, response);
        HistoryService.Plan k1 = rawPlan("Inc1", 1, response);
        HistoryService.Plan k2 = rawPlan("Inc2", 2, response);
        // k2 also has a cache hit: an evicted pen must not come back with only that part of its data.
        k2.pieces.add(0, new HistoryService.Piece(0, 10, new HistoryChunkCache.Chunk(new long[] {5}, new double[] {1}, 0)));
        rows(k0.pieces.get(0).writer, 6_000);
        rows(k1.pieces.get(0).writer, 4_500);
        k2.penBudget.take(1);                           // the cache hit, taken at planning time
        rows(k2.pieces.get(1).writer, 4_500);
        settled(k0);
        settled(k1);
        settled(k2);
        fallback(k0, response, 3_000);
        HistoryResult.Pen p2 = assemble("k2", k2);
        assertEquals(HistoryResult.TOO_MANY_POINTS, p2.status());
        assertEquals(0, p2.count());
    }

    @Test
    void anEvictedFallbackIsRefusedByTheResponseCap() {
        ResponseBudget response = new ResponseBudget(RESPONSE_MAX);
        HistoryService.Plan k0 = rawPlan("Bulk01", 0, response);
        HistoryService.Plan k1 = rawPlan("Bulk02", 1, response);
        rows(k0.pieces.get(0).writer, 6_000);
        rows(k1.pieces.get(0).writer, 6_000);
        settled(k0);
        settled(k1);
        fallback(k1, response, 4_000);                  // k1's fallback finished first …
        fallback(k0, response, 7_000);                  // … and k0's (earlier in request order) evicts it
        response.freeze();
        HistoryService.reconcile(k0);
        HistoryService.reconcile(k1);
        HistoryResult.Pen p0 = assemble("k0", k0);
        HistoryResult.Pen p1 = assemble("k1", k1);
        assertEquals(HistoryResult.OK, p0.status());
        assertEquals(7_000, p0.count());
        assertEquals(HistoryResult.TOO_MANY_POINTS, p1.status());
        assertEquals(Integer.valueOf(RESPONSE_MAX), p1.limit, "refused by the response cap, not its own cap");
    }

    @Test
    void withoutTheCapPressureEveryPenIsServed() {
        ResponseBudget response = new ResponseBudget(500_000);
        HistoryService.Plan k0 = rawPlan("Bulk01", 0, response);
        HistoryService.Plan k2 = rawPlan("Inc2", 2, response);
        rows(k2.pieces.get(0).writer, 4_500);
        rows(k0.pieces.get(0).writer, 6_000);
        settled(k0);
        settled(k2);
        fallback(k0, response, 3_000);
        response.freeze();
        HistoryService.reconcile(k2);
        HistoryResult.Pen p2 = HistoryService.assemble("k2", k2, ModuleSettings.Settings.defaults(), false);
        assertEquals(HistoryResult.OK, p2.status());
        assertEquals(4_500, p2.count());
        assertFalse(k2.penBudget.isOver());
    }
}
