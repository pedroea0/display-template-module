package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.history.AggregationMode;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.paths.parser.TagPathParser;
import org.junit.jupiter.api.Test;

/**
 * Evictions while the queries run are provisional, the response cut is decided from the final first-phase counts
 * ({@link HistoryService#repairCut}) and pens evicted for nothing are re-queried in the second phase.
 *
 * <p>The original problem, replayed: raw, {@code onTooManyPoints:"aggregate"}, per-pen cap 20 000,
 * {@code maxPointsPerResponse} 30 000; d0 has 21 600 points (over its cap → 4 320-bucket fallback), d1 and d2 have
 * 14 400 each. The request-order prefix is d0 downgraded 4 320, d1 ok 14 400, d2 tooManyPoints (33 120 &gt; 30 000).
 * Before the fix d0's provisional 20 000 points evicted d1 and d2 and both came back tooManyPoints.
 */
class HistoryRepairCutTest {

    private static final QualityCode[] GOOD = {QualityCode.Good, QualityCode.Good};
    private static final int RESPONSE_MAX = 30_000;
    private static final long PEN_CAP = 20_000;
    private static final long SPAN = 100_000;

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

    /** A full raw pen over [0, SPAN) with one query piece and a fresh allowance. */
    private static HistoryService.Plan rawPlan(String name, int order, ResponseBudget response) {
        HistoryService.Plan plan = new HistoryService.Plan(path(name), "[default]ctg/" + name.toLowerCase(),
            new ReadPermissionCache.Check(HistoryResult.OK, "Float8", "Core Historian"), null, null,
            new HistoryRequest.PenWindow(0, SPAN, false, null));
        plan.order = order;
        plan.cap = PEN_CAP;
        plan.fallbackAgg = AggregationMode.LastValue;
        plan.penBudget = response.pen(PEN_CAP, order);
        HistoryService.Piece piece = new HistoryService.Piece(0, SPAN, null);
        piece.writer = new PenSeriesWriter(0, SPAN, PenSeriesWriter.ValueFilter.NONE, false, plan.penBudget);
        plan.pieces.add(piece);
        return plan;
    }

    /** {@code n} rows into the plan's (only) query piece. */
    private static void rows(HistoryService.Plan plan, int n) {
        rows(plan.pieces.get(plan.pieces.size() - 1).writer, n);
    }

    private static void rows(PenSeriesWriter w, int n) {
        for (int i = 0; i < n; i++) {
            w.write(new Object[] {(long) i, 1.0}, GOOD);
        }
        w.finish();
    }

    /** settle() for pens whose queries all finished. */
    private static void settled(HistoryService.Plan... plans) {
        for (HistoryService.Plan plan : plans) {
            plan.finalStatus = plan.penBudget.isOver() ? HistoryResult.TOO_MANY_POINTS : null;
        }
    }

    /** The second phase for one re-run: a fresh allowance and writer, the same rows again. */
    private static void rerun(HistoryService.Plan plan, ResponseBudget response, int n) {
        assertTrue(plan.rerun, plan.path + " is marked for a re-run");
        plan.penBudget = response.pen(plan.cap, plan.order);
        HistoryService.Piece piece = plan.pieces.get(0);
        piece.writer = new PenSeriesWriter(0, SPAN, PenSeriesWriter.ValueFilter.NONE, false, plan.penBudget);
        rows(piece.writer, n);
        settled(plan);
    }

    /** The second phase for one fallback: {@code buckets} aggregated rows in the pen's request order. */
    private static void fallback(HistoryService.Plan plan, ResponseBudget response, int buckets) {
        plan.fallbackBudget = response.pen(buckets + 2L, plan.order);
        HistoryService.Piece fb = new HistoryService.Piece(0, SPAN, null);
        fb.writer = new PenSeriesWriter(0, SPAN, PenSeriesWriter.ValueFilter.NONE, true, false, plan.fallbackBudget);
        plan.fallback = fb;
        plan.fallbackBucket = 20;
        rows(fb.writer, buckets);
        fb.status = null;
    }

    private static List<HistoryResult.Pen> finish(ResponseBudget response, HistoryService.Plan... plans) {
        response.freeze();
        List<HistoryResult.Pen> out = new java.util.ArrayList<>();
        for (int i = 0; i < plans.length; i++) {
            HistoryService.reconcile(plans[i]);
            out.add(HistoryService.assemble("d" + i, plans[i], settings(), false));
        }
        return out;
    }

    private static void assertPrefix(List<HistoryResult.Pen> p) {
        assertEquals(HistoryResult.OK, p.get(0).status());
        assertTrue(p.get(0).downgraded(), "d0: aggregated fallback");
        assertEquals(4_320, p.get(0).count());
        assertEquals(HistoryResult.OK, p.get(1).status(), "d1 fits the request-order prefix");
        assertEquals(14_400, p.get(1).count());
        assertEquals(HistoryResult.TOO_MANY_POINTS, p.get(2).status(), "d2 does not (33 120 > 30 000)");
        assertEquals(Integer.valueOf(RESPONSE_MAX), p.get(2).limit);
    }

    @Test
    void anOverCapPenThatEvictedLaterPensDoesNotCostThemTheirPlace() {
        ResponseBudget response = new ResponseBudget(RESPONSE_MAX);
        HistoryService.Plan d0 = rawPlan("Dense", 0, response);
        HistoryService.Plan d1 = rawPlan("Inc1", 1, response);
        HistoryService.Plan d2 = rawPlan("Inc2", 2, response);
        rows(d1, 14_400);                               // the later pens finished first …
        rows(d2, 14_400);
        rows(d0, 21_600);                               // … d0's provisional points evicted both, then it hit its cap
        assertEquals(PenSeriesWriter.PenBudget.Overflow.PEN_CAP, d0.penBudget.overflow());
        assertEquals(PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP, d1.penBudget.overflow(), "evicted for nothing");
        assertEquals(PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP, d2.penBudget.overflow());
        assertEquals(14_400, d1.penBudget.wanted(), "an evicted writer keeps counting its demand");
        settled(d0, d1, d2);

        int cut = HistoryService.repairCut(List.of(d0, d1, d2), response);
        assertEquals(Integer.MAX_VALUE, cut, "with d0's fallback counted as 0 both fit: no cut yet");
        assertFalse(d0.rerun);
        assertTrue(d1.rerun);
        assertTrue(d2.rerun);

        // Second phase in any order: the fallback evicts d2 in request order, d1 keeps its points.
        rerun(d1, response, 14_400);
        rerun(d2, response, 14_400);
        fallback(d0, response, 4_320);
        assertPrefix(finish(response, d0, d1, d2));
    }

    @Test
    void theSamePrefixWhenTheFallbackRunsFirst() {
        ResponseBudget response = new ResponseBudget(RESPONSE_MAX);
        HistoryService.Plan d0 = rawPlan("Dense", 0, response);
        HistoryService.Plan d1 = rawPlan("Inc1", 1, response);
        HistoryService.Plan d2 = rawPlan("Inc2", 2, response);
        rows(d0, 21_600);                               // d0 first this time: over its cap, gives everything back
        rows(d1, 14_400);
        rows(d2, 14_400);
        settled(d0, d1, d2);
        HistoryService.repairCut(List.of(d0, d1, d2), response);
        fallback(d0, response, 4_320);
        if (d1.rerun) {
            rerun(d1, response, 14_400);
        }
        if (d2.rerun) {
            rerun(d2, response, 14_400);
        }
        assertPrefix(finish(response, d0, d1, d2));
    }

    @Test
    void cacheHitsAboveThePenCapAreNotTakenAndEvictNobody() {
        // With the chunk cache on, step 4 used to take d0's hits first: d1 was refused before any query ran.
        ResponseBudget response = new ResponseBudget(RESPONSE_MAX);
        HistoryService.Plan d0 = rawPlan("Dense", 0, response);
        long[] t = new long[21_600];
        double[] v = new double[t.length];
        for (int i = 0; i < t.length; i++) {
            t[i] = i;
            v[i] = 1;
        }
        d0.pieces.add(0, new HistoryService.Piece(0, SPAN, new HistoryChunkCache.Chunk(t, v, 0)));
        HistoryService.takeCacheHits(d0, response);
        assertEquals(PenSeriesWriter.PenBudget.Overflow.PEN_CAP, d0.penBudget.overflow(), "over its cap at planning");
        assertEquals(RESPONSE_MAX, response.remaining(), "nothing taken");
        HistoryService.Plan d1 = rawPlan("Inc1", 1, response);
        HistoryService.Plan d2 = rawPlan("Inc2", 2, response);
        rows(d1, 14_400);
        rows(d2, 14_400);
        assertFalse(d1.penBudget.isOver());
        assertFalse(d2.penBudget.isOver());
    }

    @Test
    void cacheHitsWithinThePenCapAreTakenAsOneAmount() {
        ResponseBudget response = new ResponseBudget(RESPONSE_MAX);
        HistoryService.Plan d0 = rawPlan("Dense", 0, response);
        d0.pieces.add(0, new HistoryService.Piece(0, 10, new HistoryChunkCache.Chunk(new long[] {1, 2, 3},
            new double[] {1, 2, 3}, 0)));
        HistoryService.takeCacheHits(d0, response);
        assertFalse(d0.penBudget.isOver());
        assertEquals(RESPONSE_MAX - 3, response.remaining());
    }

    @Test
    void anEvictedPenThatWantedMoreThanItsCapIsOverItsOwnCap() {
        ResponseBudget response = new ResponseBudget(RESPONSE_MAX);
        HistoryService.Plan d0 = rawPlan("Big0", 0, response);
        HistoryService.Plan d1 = rawPlan("Big1", 1, response);
        rows(d1, 15_000);                               // d1 holds 15 000 …
        rows(d0, 19_000);                               // … d0 (fits its cap) evicts it …
        rows(d1.pieces.get(0).writer, 6_000);           // … and d1's query goes on: 21 000 wanted > 20 000
        assertEquals(PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP, d1.penBudget.overflow());
        settled(d0, d1);
        HistoryService.repairCut(List.of(d0, d1), response);
        assertEquals(PenSeriesWriter.PenBudget.Overflow.PEN_CAP, d1.penBudget.overflow(), "reclassified");
        assertFalse(d1.rerun, "no re-run: its fallback (or its own tooManyPoints) applies");
        assertFalse(d1.cutOff);
    }

    @Test
    void aPenEvictedByAPenThatThenTimedOutIsReRunNotRefused() {
        // k0 evicts k1, then k0 times out (sends nothing). k1 must not stay tooManyPoints.
        ResponseBudget response = new ResponseBudget(RESPONSE_MAX);
        HistoryService.Plan k0 = rawPlan("Slow", 0, response);
        HistoryService.Plan k1 = rawPlan("Fast", 1, response);
        rows(k1, 15_000);
        rows(k0.pieces.get(0).writer, 16_000);          // still running at the deadline
        assertTrue(k1.penBudget.isOver());
        k0.finalStatus = HistoryResult.TIMEOUT;
        response.retire(k0.penBudget);
        settled(k1);
        HistoryService.repairCut(List.of(k0, k1), response);
        assertTrue(k1.rerun, "k0 sends nothing: k1 fits and is queried again (or timeout when no time is left)");
        rerun(k1, response, 15_000);
        List<HistoryResult.Pen> p = finish(response, k0, k1);
        assertEquals(HistoryResult.TIMEOUT, p.get(0).status());
        assertEquals(HistoryResult.OK, p.get(1).status());
        assertEquals(15_000, p.get(1).count());
    }

    @Test
    void theFirstEvictedPenThatDoesNotFitIsTheCut() {
        ResponseBudget response = new ResponseBudget(RESPONSE_MAX);
        HistoryService.Plan a = rawPlan("A", 0, response);
        HistoryService.Plan b = rawPlan("B", 1, response);
        HistoryService.Plan c = rawPlan("C", 2, response);
        rows(c, 5_000);
        rows(b, 18_000);
        rows(a, 19_000);                                // evicts c, then b
        settled(a, b, c);
        int cut = HistoryService.repairCut(List.of(a, b, c), response);
        assertEquals(1, cut, "19 000 + 18 000 > 30 000: b is the cut");
        assertFalse(b.rerun);
        assertTrue(b.cutOff);
        assertTrue(c.cutOff, "everything after the cut is refused, although c alone would fit");
        assertFalse(c.rerun);
        List<HistoryResult.Pen> p = finish(response, a, b, c);
        assertEquals(HistoryResult.OK, p.get(0).status());
        assertEquals(HistoryResult.TOO_MANY_POINTS, p.get(1).status());
        assertEquals(HistoryResult.TOO_MANY_POINTS, p.get(2).status());
        assertEquals(Integer.valueOf(RESPONSE_MAX), p.get(2).limit);
    }

    @Test
    void anOverCapPenAfterTheCutIsRefusedByTheResponseCap() {
        ResponseBudget response = new ResponseBudget(RESPONSE_MAX);
        HistoryService.Plan a = rawPlan("A", 0, response);
        HistoryService.Plan b = rawPlan("B", 1, response);
        HistoryService.Plan c = rawPlan("C", 2, response);
        rows(b, 18_000);
        rows(a, 19_000);                                // b evicted, c refused at its first row
        rows(c, 25_000);                                // c is over its own cap as well
        settled(a, b, c);
        HistoryService.repairCut(List.of(a, b, c), response);
        assertTrue(c.cutOff);
        HistoryResult.Pen pc = finish(response, a, b, c).get(2);
        assertEquals(HistoryResult.TOO_MANY_POINTS, pc.status());
        assertEquals(Integer.valueOf(RESPONSE_MAX), pc.limit, "no fallback after the cut");
    }

    @Test
    void noEvictionMeansNoReRunAndNoCut() {
        ResponseBudget response = new ResponseBudget(RESPONSE_MAX);
        HistoryService.Plan a = rawPlan("A", 0, response);
        HistoryService.Plan b = rawPlan("B", 1, response);
        rows(a, 10_000);
        rows(b, 10_000);
        settled(a, b);
        assertEquals(Integer.MAX_VALUE, HistoryService.repairCut(List.of(a, b), response));
        assertFalse(a.rerun || b.rerun || a.cutOff || b.cutOff);
        assertNull(b.finalStatus);
        assertEquals(10_000, finish(response, a, b).get(1).count());
    }

    @Test
    void aCacheOnlyZombieKeepsStoringWithinItsCapOutsideTheResponseBudget() {
        // A timed-out pen's zombie query may still warm the chunk cache.
        ResponseBudget response = new ResponseBudget(100);
        PenSeriesWriter.PenBudget zombie = response.pen(1_000, 0);
        PenSeriesWriter.PenBudget later = response.pen(1_000, 1);
        PenSeriesWriter w = new PenSeriesWriter(0, Long.MAX_VALUE, PenSeriesWriter.ValueFilter.NONE, false, zombie);
        rows(w, 60);
        response.retire(zombie, zombie.cap());          // cache-only up to its whole cap
        assertEquals(100, response.remaining(), "its points went back");
        assertTrue(later.take(100), "a later pen can use them");
        rows(w, 500);                                   // the zombie goes on: within its own cap, nothing evicted
        assertFalse(later.isOver());
        assertTrue(w.keptAll(), "every row kept: its chunks may enter the cache");
        assertEquals(0, w.count(), "but nothing of it is sent");
        response.freeze();
        rows(w, 100);
        assertTrue(w.keptAll(), "the freeze does not concern a cache-only zombie");
        rows(w, 1_000);                                 // over its own cap: stops, not cacheable
        assertFalse(w.keptAll());
        assertFalse(zombie.cacheOnly());
        assertEquals(0, response.remaining());
    }

    @Test
    void reopenRefusesEveryPenFromTheCutOnAndFreesTheirPoints() {
        ResponseBudget response = new ResponseBudget(100);
        PenSeriesWriter.PenBudget a = response.pen(1_000, 0);
        PenSeriesWriter.PenBudget b = response.pen(1_000, 1);
        assertTrue(a.take(30));
        assertTrue(b.take(30));
        response.reopen(1);
        assertFalse(a.isOver());
        assertEquals(PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP, b.overflow(), "a data pen past the cut");
        assertEquals(70, response.remaining());
        assertFalse(response.pen(1_000, 2).take(1), "a new allowance past the cut is refused");
        assertTrue(response.pen(1_000, 0).take(70), "one before it is not");
    }

    @Test
    void aPlainRetiredZombieKeepsNothing() {
        ResponseBudget response = new ResponseBudget(100);
        PenSeriesWriter.PenBudget zombie = response.pen(1_000, 0);
        PenSeriesWriter w = new PenSeriesWriter(0, Long.MAX_VALUE, PenSeriesWriter.ValueFilter.NONE, false, zombie);
        rows(w, 10);
        response.retire(zombie);
        rows(w, 10);
        assertFalse(w.keptAll());
    }
}
