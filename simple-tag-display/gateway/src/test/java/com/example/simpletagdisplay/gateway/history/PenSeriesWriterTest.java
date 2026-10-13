package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Date;

import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.history.AggregationMode;
import org.junit.jupiter.api.Test;

/** PenSeriesWriter row rules and caps in every mode. */
class PenSeriesWriterTest {

    private static final String[] NAMES = {"t_stamp", "CTG/Temp"};
    private static final QualityCode[] GOOD = {QualityCode.Good, QualityCode.Good};

    private static PenSeriesWriter writer(long cap, PenSeriesWriter.ValueFilter f) {
        return new PenSeriesWriter(0, Long.MAX_VALUE, f, true, new ResponseBudget(1_000_000).pen(cap, 0));
    }

    private static void row(PenSeriesWriter w, Object t, Object v, QualityCode q) {
        w.write(new Object[] {t, v}, new QualityCode[] {QualityCode.Good, q});
    }

    @Test
    void rowRules() {
        PenSeriesWriter w = writer(100, PenSeriesWriter.ValueFilter.NONE);
        w.initialize(NAMES, new Class<?>[] {Date.class, Double.class}, true, 10);
        row(w, new Date(1000), 1.5, QualityCode.Good);          // Date timestamp
        row(w, 2000L, 2, QualityCode.Good);                      // Number timestamp, Integer value
        row(w, "x", 3.0, QualityCode.Good);                      // not a timestamp -> skipped
        row(w, 3000L, null, QualityCode.Good);                   // empty bucket -> no point
        row(w, 4000L, Double.NaN, QualityCode.Good);             // non-finite -> no point
        row(w, 5000L, Double.POSITIVE_INFINITY, QualityCode.Good);
        row(w, 6000L, 0.0, QualityCode.Bad_NotFound);            // Core Historian empty aggregate bucket -> no point
        row(w, 7000L, 7.0, QualityCode.Bad);                     // bad quality -> gap (NaN)
        row(w, 8000L, Boolean.TRUE, QualityCode.Good);           // Boolean -> 1
        row(w, 9000L, "text", QualityCode.Good);                 // unsupported value -> skipped
        assertEquals(4, w.count());
        assertEquals(1000L, w.t()[0]);
        assertEquals(1.5, w.v()[0]);
        assertEquals(2.0, w.v()[1]);
        assertEquals(7000L, w.t()[2]);
        assertTrue(Double.isNaN(w.v()[2]));
        assertEquals(1.0, w.v()[3]);
        assertEquals(10, w.rows());
        assertEquals(1000L, w.firstTime());
        assertFalse(w.overflowed());
    }

    @Test
    void windowFilterIsHalfOpen() {
        PenSeriesWriter w = new PenSeriesWriter(1000, 3000, PenSeriesWriter.ValueFilter.NONE, true,
            new ResponseBudget(100).pen(100, 0));
        w.initialize(NAMES, null, true, -1);
        for (long t = 0; t <= 4000; t += 500) {
            row(w, t, 1.0, QualityCode.Good);
        }
        assertEquals(4, w.count(), "1000, 1500, 2000, 2500");
        assertEquals(1000L, w.t()[0]);
        assertEquals(2500L, w.t()[3]);
    }

    @Test
    void booleanGarbageFilter() {
        assertEquals(PenSeriesWriter.ValueFilter.NONE, PenSeriesWriter.ValueFilter.of(false, AggregationMode.LastValue));
        assertEquals(PenSeriesWriter.ValueFilter.UNIT, PenSeriesWriter.ValueFilter.of(true, null));
        assertEquals(PenSeriesWriter.ValueFilter.UNIT, PenSeriesWriter.ValueFilter.of(true, AggregationMode.MinMax));
        assertEquals(PenSeriesWriter.ValueFilter.UNIT, PenSeriesWriter.ValueFilter.of(true, AggregationMode.Maximum));
        assertEquals(PenSeriesWriter.ValueFilter.COUNT, PenSeriesWriter.ValueFilter.of(true, AggregationMode.Sum));
        assertEquals(PenSeriesWriter.ValueFilter.COUNT, PenSeriesWriter.ValueFilter.of(true, AggregationMode.DurationOn));

        PenSeriesWriter unit = writer(100, PenSeriesWriter.ValueFilter.UNIT);
        unit.initialize(NAMES, null, true, -1);
        row(unit, 1L, 34_359_739_149.0, QualityCode.Good);       // observed LastValue garbage before the first sample
        row(unit, 2L, 2_526_084_708_688.0, QualityCode.Good);    // observed Maximum garbage
        row(unit, 3L, -1.0, QualityCode.Good);
        row(unit, 4L, 0.0, QualityCode.Good);
        row(unit, 5L, 1.0, QualityCode.Good);
        assertEquals(2, unit.count());
        assertEquals(3, unit.filtered());

        PenSeriesWriter count = writer(100, PenSeriesWriter.ValueFilter.COUNT);
        count.initialize(NAMES, null, true, -1);
        row(count, 1L, 176.0, QualityCode.Good);
        row(count, 2L, 3.3e18, QualityCode.Good);
        row(count, 3L, -5.0, QualityCode.Good);
        assertEquals(1, count.count());
        assertEquals(2, count.filtered());
    }

    @Test
    void perPenCapCountsAndDiscardsAndReturnsTheResponseBudget() {
        ResponseBudget response = new ResponseBudget(500);
        PenSeriesWriter.PenBudget budget = response.pen(100, 0);
        PenSeriesWriter w = new PenSeriesWriter(0, Long.MAX_VALUE, PenSeriesWriter.ValueFilter.NONE, false, budget);
        w.initialize(NAMES, null, true, 1_000_000);
        for (int i = 0; i < 1_000; i++) {
            w.write(new Object[] {(long) i, (double) i}, GOOD);   // never throws
        }
        assertTrue(w.overflowed());
        assertEquals(PenSeriesWriter.PenBudget.Overflow.PEN_CAP, budget.overflow());
        assertEquals(0, w.count(), "an over-cap pen sends nothing");
        assertEquals(1_000, w.rows(), "the scan was counted to its end");
        assertEquals(500, response.remaining(), "the response budget the pen took is given back");
        assertEquals(0L, w.firstTime());
    }

    @Test
    void responseCapIsSharedByEveryPenOfTheRequest() {
        ResponseBudget response = new ResponseBudget(150);
        PenSeriesWriter a = new PenSeriesWriter(0, Long.MAX_VALUE, PenSeriesWriter.ValueFilter.NONE, false,
            response.pen(100, 0));
        PenSeriesWriter.PenBudget bBudget = response.pen(100, 1);
        PenSeriesWriter b = new PenSeriesWriter(0, Long.MAX_VALUE, PenSeriesWriter.ValueFilter.NONE, false, bBudget);
        a.initialize(NAMES, null, true, -1);
        b.initialize(NAMES, null, true, -1);
        for (int i = 0; i < 100; i++) {
            a.write(new Object[] {(long) i, 1.0}, GOOD);    // A finishes first: 100 of the 150
        }
        for (int i = 0; i < 100; i++) {
            b.write(new Object[] {(long) i, 1.0}, GOOD);    // B runs out after 50
        }
        assertFalse(a.overflowed());
        assertEquals(100, a.count());
        assertTrue(b.overflowed());
        assertEquals(PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP, bBudget.overflow());
        assertEquals(0, b.count());
    }

    @Test
    void aggregatedCapHoldsForMinMax() {
        // 10 buckets of MinMax = 20 rows + 2 slack; a historian sending 30 rows trips the cap.
        PenSeriesWriter.PenBudget budget = new ResponseBudget(1_000).pen(22, 0);
        PenSeriesWriter w = new PenSeriesWriter(0, Long.MAX_VALUE, PenSeriesWriter.ValueFilter.NONE, true, true, budget);
        w.initialize(NAMES, null, true, 10);
        for (int i = 0; i < 22; i++) {
            w.write(new Object[] {(long) (i / 2), 1.0}, GOOD);
        }
        assertFalse(w.overflowed());
        assertEquals(22, w.count());
        for (int i = 0; i < 8; i++) {
            w.write(new Object[] {100L + i, 1.0}, GOOD);
        }
        assertTrue(w.overflowed());
    }

    @Test
    void cacheHitsTakeFromTheBudgetInOneStep() {
        ResponseBudget response = new ResponseBudget(1_000);
        PenSeriesWriter.PenBudget budget = response.pen(300, 0);
        assertTrue(budget.take(200));
        assertEquals(800, response.remaining());
        assertFalse(budget.take(200), "200 + 200 > 300");
        assertEquals(PenSeriesWriter.PenBudget.Overflow.PEN_CAP, budget.overflow());
        assertEquals(1_000, response.remaining());
    }

    @Test
    void preallocationIsBoundedAndColumnsGrow() {
        PenSeriesWriter w = new PenSeriesWriter(0, Long.MAX_VALUE, PenSeriesWriter.ValueFilter.NONE, false,
            new ResponseBudget(1_000_000).pen(250_000, 0));
        w.initialize(NAMES, null, true, 2_600_000);             // a raw estimate far above what arrives
        assertEquals(PenSeriesWriter.PREALLOC_MAX, w.t().length);
        for (int i = 0; i < 40_000; i++) {
            w.write(new Object[] {(long) i, 1.0}, GOOD);
        }
        assertEquals(40_000, w.count());
        assertTrue(w.t().length >= 40_000 && w.t().length <= 2 * 40_000, "doubling growth");
    }

    @Test
    void historianErrorIsRecorded() {
        PenSeriesWriter w = writer(10, PenSeriesWriter.ValueFilter.NONE);
        w.finishWithError(new IllegalStateException("boom"));
        assertNotNull(w.error());
        PenSeriesWriter n = writer(10, PenSeriesWriter.ValueFilter.NONE);
        n.finishWithError(null);
        assertNotNull(n.error(), "a null cause still marks the query failed");
    }

    // ---- MinMax pairs: no orphan rows ------------------------------------------------------------------------

    private static PenSeriesWriter minMax(PenSeriesWriter.ValueFilter f) {
        PenSeriesWriter w = new PenSeriesWriter(0, Long.MAX_VALUE, f, true, true, new ResponseBudget(1_000).pen(100, 0));
        w.initialize(NAMES, null, true, -1);
        return w;
    }

    @Test
    void minMaxKeepsTwoRowsPerBucket() {
        PenSeriesWriter w = minMax(PenSeriesWriter.ValueFilter.NONE);
        row(w, 0L, 1.0, QualityCode.Good);
        row(w, 0L, 5.0, QualityCode.Good);                       // complete pair
        row(w, 10L, 0.0, QualityCode.Bad_NotFound);              // restart gap: one row of the pair is "not found"
        row(w, 10L, 7.0, QualityCode.Good);                      // -> survivor doubled
        row(w, 20L, 0.0, QualityCode.Bad_NotFound);
        row(w, 20L, 0.0, QualityCode.Bad_NotFound);              // empty bucket -> no rows
        row(w, 30L, 3.0, QualityCode.Good);                      // lone row, next bucket follows -> doubled
        row(w, 40L, 2.0, QualityCode.Bad);                       // bad quality: a gap row, still a pair
        row(w, 40L, 4.0, QualityCode.Good);
        row(w, 50L, 9.0, QualityCode.Good);                      // lone last row -> doubled at finish()
        w.finish();
        w.finish();                                             // idempotent
        assertEquals(10, w.count());
        long[] t = w.t();
        double[] v = w.v();
        for (int i = 0; i < w.count(); i += 2) {
            assertEquals(t[i], t[i + 1], "rows " + i + "/" + (i + 1) + " share t");
        }
        assertEquals(1.0, v[0]);
        assertEquals(5.0, v[1]);
        assertEquals(7.0, v[2]);
        assertEquals(7.0, v[3]);
        assertEquals(30L, t[4]);
        assertEquals(3.0, v[5]);
        assertTrue(Double.isNaN(v[6]));
        assertEquals(4.0, v[7]);
        assertEquals(50L, t[8]);
        assertEquals(9.0, v[9]);
    }

    @Test
    void minMaxBooleanFilterDropsOrDoublesPerBucket() {
        PenSeriesWriter w = minMax(PenSeriesWriter.ValueFilter.UNIT);
        row(w, 0L, 0.0, QualityCode.Good);
        row(w, 0L, 3.4e10, QualityCode.Good);                    // garbage max -> min doubled
        row(w, 10L, 2.5e12, QualityCode.Good);
        row(w, 10L, 2.5e12, QualityCode.Good);                   // both garbage -> bucket dropped
        w.finish();
        assertEquals(2, w.count());
        assertEquals(0L, w.t()[1]);
        assertEquals(0.0, w.v()[1]);
        assertEquals(3, w.filtered());
    }

    @Test
    void minMaxRowsOutsideTheWindowGoAsAPair() {
        PenSeriesWriter w = new PenSeriesWriter(10, 30, PenSeriesWriter.ValueFilter.NONE, true, true,
            new ResponseBudget(1_000).pen(100, 0));
        w.initialize(NAMES, null, true, -1);
        for (long t = 0; t < 40; t += 10) {
            row(w, t, 1.0, QualityCode.Good);
            row(w, t, 2.0, QualityCode.Good);
        }
        w.finish();
        assertEquals(4, w.count(), "buckets 10 and 20, two rows each");
    }

    @Test
    void notCacheableIsSticky() {
        PenSeriesWriter w = writer(10, PenSeriesWriter.ValueFilter.NONE);
        assertTrue(w.cacheable());
        w.notCacheable();
        assertFalse(w.cacheable());
    }
}
