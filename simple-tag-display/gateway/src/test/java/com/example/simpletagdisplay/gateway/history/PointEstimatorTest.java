package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.concurrent.atomic.AtomicLong;

import com.inductiveautomation.ignition.common.sqltags.history.AggregationMode;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.paths.parser.TagPathParser;
import org.junit.jupiter.api.Test;

/**
 * Realistic reservations — the density memory ({@link PointEstimator}), the per-plan reservation
 * ({@code HistoryService.reservePoints}) and the response budget's growth / starvation ({@link ResponseBudget}).
 */
class PointEstimatorTest {

    private static final long H = 3_600_000L;
    private static final long CAP = 250_000L;
    private static final double ONE_HZ = 1.0 / 1000d;           // points per ms

    private final AtomicLong clock = new AtomicLong(10_000_000L);
    private final PointEstimator est = new PointEstimator(clock::get);

    // ---- density memory -------------------------------------------------------------------------------------

    @Test
    void unknownTagsGetTheWorstCaseKnownTagsAnEstimate() {
        assertEquals(-1d, est.rate("k"));
        assertEquals(CAP, PointEstimator.estimate(-1d, H, CAP), "unknown: the cap (safe fallback)");
        assertEquals(0.001, PointEstimator.unknownRate(-1d, H), 1e-12, "unknown, up to 1 h: the floor");
        assertEquals(-1d, PointEstimator.unknownRate(-1d, H + 1), "unknown, longer: still unknown");
        assertEquals(0.5, PointEstimator.unknownRate(0.5, 1_000L), "known: as it is");
        // 1 Hz for 1 h: 3 600 × 2 + 256
        assertEquals(7_456L, PointEstimator.estimate(ONE_HZ, H, CAP));
        assertEquals(PointEstimator.SLACK, PointEstimator.estimate(0d, H, CAP), "an empty tag: just the slack");
        assertEquals(CAP, PointEstimator.estimate(ONE_HZ, 31 * 24 * H, CAP), "never above the cap");
        assertEquals(PointEstimator.SLACK + 2, PointEstimator.estimate(ONE_HZ, 1_000L, CAP), "a 1 s realtime tick");
    }

    @Test
    void shortWindowsCountAsOneSecond() {
        assertEquals(0.001, PointEstimator.density(1, 10), 1e-12, "one sample in 10 ms is 1 Hz, not 100 Hz");
        assertEquals(0.002, PointEstimator.density(4_000, 2_000_000L), 1e-12);
        assertEquals(0d, PointEstimator.density(-5, 1_000));
    }

    /** A complete observation of 1 h with enough rows to be strong, and trusted as a first observation. */
    private void strong(String k, double d) {
        est.observe(k, d, true, H, 4_000L);
    }

    @Test
    void onlyCompleteStrongObservationsLowerHalfAtMostOncePerInterval() {
        strong("k", 0.01);
        assertEquals(0.01, est.rate("k"), 1e-12);
        strong("k", 0.001);
        assertEquals(0.005, est.rate("k"), 1e-12, "a quieter window halves the memory, not more");
        strong("k", 0.001);
        assertEquals(0.005, est.rate("k"), 1e-12, "lowered at most once per interval");
        clock.addAndGet(PointEstimator.LOWER_INTERVAL_MS / 2);
        est.observe("k", 0.0, true, 1_000L, 0L);                 // keeps the entry recent
        clock.addAndGet(PointEstimator.LOWER_INTERVAL_MS / 2);
        strong("k", 0.002);
        assertEquals(0.0025, est.rate("k"), 1e-12, "the next interval may halve again");
        est.observe("k", 0.0, true, 24 * H, 0L);
        assertEquals(0.0025, est.rate("k"), 1e-12, "an empty window is weak: it never lowers");
        est.observe("k", 0.001, true, 1_000L, 1L);
        assertEquals(0.0025, est.rate("k"), 1e-12, "a 1 s tick is weak: it never lowers");
        est.observe("k", 0.001, false, H, 3_600L);
        assertEquals(0.0025, est.rate("k"), 1e-12, "a timed-out count is a lower bound: it never lowers");
        est.observe("k", 0.03, false, H, 3_600L);
        assertEquals(0.03, est.rate("k"), 1e-12, "but it raises");
        est.observe("k", 0.05, true, 1_000L, 50L);
        assertEquals(0.05, est.rate("k"), 1e-12, "a weak observation raises too");
        est.observe("k", Double.NaN, true, H, 1L);
        est.observe("k", Double.POSITIVE_INFINITY, true, H, 1L);
        assertEquals(0.05, est.rate("k"), 1e-12, "garbage is ignored");
    }

    @Test
    void emptyWindowsAndTicksCannotPoisonTheMemory() {
        // Empty past windows and realtime ticks used to halve the density each time.
        strong("bulk", 0.01);
        for (int i = 0; i < 14; i++) {
            est.observe("bulk", 0.0, true, 24 * H, 0L);        // an empty raw window
            est.observe("bulk", 0.0, true, 1_000L, 0L);        // an on-change tick without a row
        }
        assertEquals(0.01, est.rate("bulk"), 1e-12);
    }

    @Test
    void firstObservationsOfAnUnknownTag() {
        est.observe("t", 1e-9, false, 31 * 24 * H, 100L);
        assertEquals(-1d, est.rate("t"), "an incomplete first observation is not remembered: still the worst case");
        est.observe("t", 0.0, true, 24 * H, 0L);
        assertEquals(PointEstimator.WEAK_FLOOR_PER_S / 1000d, est.rate("t"), 1e-12,
            "a weak first observation: at least the floor");
        est.observe("u", 0.004, true, 600_000L, 2_400L);
        assertEquals(0.004, est.rate("u"), 1e-12, "a weak first observation above the floor is kept as it is");
        est.observe("v", 1e-6, true, 24 * H, 86L);
        assertEquals(0.001, est.rate("v"), 1e-12, "a strong first observation of few rows: at least the floor");
        est.observe("w", 2.5e-5, true, 24 * H, 2_160L);
        assertEquals(2.5e-5, est.rate("w"), 1e-12, "a strong first observation of many rows is remembered as it is");
    }

    @Test
    void boundaryRowsAreNotAStrongObservation() {
        // Measured on Core Historian for a 1 Hz tag: a 1 h window holding only the
        // tag's last sample delivers 1 row, a 1 h window after the data ended delivers 2 boundary rows.
        est.observe("unknown1", PointEstimator.density(1, H), true, H, 1L);
        assertEquals(0.001, est.rate("unknown1"), 1e-12, "1 row: the 1 pt/s floor, not 1/3600 pt/s");
        est.observe("unknown2", PointEstimator.density(2, H), true, H, 2L);
        assertEquals(0.001, est.rate("unknown2"), 1e-12, "2 boundary rows: the floor");
        strong("known", ONE_HZ);
        est.observe("known", PointEstimator.density(2, H), true, H, 2L);
        est.observe("known", PointEstimator.density(15, H), true, H, 15L);
        assertEquals(ONE_HZ, est.rate("known"), 1e-12, "fewer than 16 rows are weak: never lower a known tag");
        est.observe("known", PointEstimator.density(16, H), true, H, 16L);
        assertEquals(ONE_HZ / 2, est.rate("known"), 1e-12, "16 rows over 1 h are strong: halved, no more");
    }

    @Test
    void densitiesExpireAndTheMemoryIsBounded() {
        strong("k", 0.01);
        clock.addAndGet(PointEstimator.TTL_MS - 1);
        assertEquals(0.01, est.rate("k"), 1e-12);
        clock.addAndGet(1);
        assertEquals(-1d, est.rate("k"), "expired: unknown again (worst case)");
        strong("k", 0.004);
        assertEquals(0.004, est.rate("k"), 1e-12, "an expired entry is not halved against");
        for (int i = 0; i < PointEstimator.MAX_ENTRIES + 100; i++) {
            strong("t" + i, 0.001);
        }
        assertEquals(PointEstimator.MAX_ENTRIES, est.size());
        assertEquals(-1d, est.rate("t0"), "least recently used dropped first");
        assertEquals("[default]ctg/temp|Core Historian", PointEstimator.key("[default]ctg/temp", "Core Historian"));
        assertEquals("[default]ctg/temp|", PointEstimator.key("[default]ctg/temp", null));
    }

    // ---- per-plan reservation -------------------------------------------------------------------------------

    private static TagPath path() {
        try {
            return TagPathParser.parse("[default]CTG/Temp");
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static HistoryService.Plan rawPlan(long from, long to) {
        HistoryService.Plan p = new HistoryService.Plan(path(), "[default]ctg/temp",
            new ReadPermissionCache.Check(HistoryResult.OK, "Float8", "Core Historian"), null, null,
            new HistoryRequest.PenWindow(from, to, false, null));
        p.cap = CAP;
        return p;
    }

    @Test
    void reservePointsFollowsTheDensityAndFallsBackToTheWorstCase() {
        long fb = 2L * 5_000 + 2;
        HistoryService.Plan p = rawPlan(0, H);
        p.pieces.add(new HistoryService.Piece(0, H, null));
        assertEquals(7_456L, HistoryService.reservePoints(p, -1d, fb),
            "unknown tag, 1 h queried: the 1 pt/s floor (a small request; growth covers a denser tag)");
        assertEquals(7_456L, HistoryService.reservePoints(p, ONE_HZ, fb), "1 pen x 1 h at 1 Hz");
        HistoryService.Plan longer = rawPlan(0, H + 1);
        longer.pieces.add(new HistoryService.Piece(0, H + 1, null));
        assertEquals(CAP, HistoryService.reservePoints(longer, -1d, 0L), "unknown tag beyond 1 h: worst case");
        assertEquals(Math.max(CAP, 2L * 5_000 + 2), HistoryService.reservePoints(longer, -1d, 2L * 5_000 + 2),
            "max(cap, fallback)");

        // Cache hits count exactly; only the queried range is estimated.
        HistoryService.Plan c = rawPlan(0, 2 * H);
        long[] t = new long[1000];
        for (int i = 0; i < t.length; i++) {
            t[i] = i * 3_600L;                               // 1000 samples inside [0, 1 h)
        }
        c.pieces.add(new HistoryService.Piece(0, H, new HistoryChunkCache.Chunk(t, new double[t.length], 0)));
        c.pieces.add(new HistoryService.Piece(H, 2 * H, null));
        assertEquals(1_000L + 7_456L, HistoryService.reservePoints(c, ONE_HZ, 0L));

        // An estimate reaching the cap expects the fallback: reserve like an unknown tag.
        assertEquals(Math.max(CAP, fb), HistoryService.reservePoints(p, 1.0, fb));
        // Over its cap from cache hits alone: only the fallback's buckets.
        p.queriesSkipped = true;
        assertEquals(fb, HistoryService.reservePoints(p, ONE_HZ, fb));
        assertEquals(0L, HistoryService.reservePoints(p, ONE_HZ, 0L));
    }

    @Test
    void aggregatedPlansReserveTheirGridAndEmptyWindowsNothing() {
        HistoryService.Plan agg = new HistoryService.Plan(path(), "[default]ctg/temp",
            new ReadPermissionCache.Check(HistoryResult.OK, "Float8", "Core Historian"), AggregationMode.MinMax, 1_000L,
            new HistoryRequest.PenWindow(0, 300_000L, false, null));
        agg.pieces.add(new HistoryService.Piece(0, 300_000L, null));
        agg.cap = HistoryService.aggregatedCap(agg);
        assertEquals(602L, HistoryService.reservePoints(agg, 123d, 0L), "300 buckets x 2 + 2, density ignored");
        HistoryService.Plan empty = rawPlan(5, 5);
        assertEquals(0L, HistoryService.reservePoints(empty, ONE_HZ, 0L), "nothing queried, nothing cached");
    }

    // ---- response budget growth ----------------------------------------------------------------------------

    @Test
    void takesBeyondTheReservationGrowItAndAFailedGrowthStarvesTheRequest() {
        ResponseBudget r = new ResponseBudget(500_000L);
        long[] reserved = {100L};
        int[] calls = {0};
        long[] room = {100_000L};
        r.bindGrowth((need, preferred) -> {
            calls[0]++;
            long target = preferred <= room[0] ? preferred : need <= room[0] ? need : -1L;
            if (target > 0) {
                reserved[0] = target;
            }
            return target;
        }, 100L);
        PenSeriesWriter.PenBudget a = r.pen(250_000L, 0);
        PenSeriesWriter.PenBudget b = r.pen(250_000L, 1);
        for (int i = 0; i < 100; i++) {
            assertTrue(a.take());
        }
        assertEquals(0, calls[0], "within the reservation: no growth");
        assertTrue(a.take());
        assertEquals(1, calls[0]);
        assertEquals(101L + PointBudget.GROW_MIN_STEP, r.covered(), "grows by a step, not per point");
        for (int i = 0; i < 1_000; i++) {
            assertTrue(b.take());
        }
        assertEquals(1, calls[0], "the step covers the next rows");
        assertTrue(a.take(60_000L));
        assertTrue(r.covered() >= 61_101L && r.covered() <= 100_000L, "preferred, or the exact need: " + r.covered());
        assertTrue(!a.take(50_000L), "beyond what the gateway can hold");
        assertTrue(r.starved());
        assertEquals(PenSeriesWriter.PenBudget.Overflow.RETIRED, a.overflow(), "the taker stops storing");
        assertTrue(!b.take(), "the budget is frozen: nobody stores any more");
        assertEquals(PenSeriesWriter.PenBudget.Overflow.RETIRED, b.overflow());
    }

    @Test
    void anUnboundBudgetNeverStarves() {
        ResponseBudget r = new ResponseBudget(10_000L);
        PenSeriesWriter.PenBudget a = r.pen(10_000L, 0);
        assertTrue(a.take(10_000L));
        assertEquals(Long.MAX_VALUE, r.covered());
        assertTrue(!r.starved());
    }
}
