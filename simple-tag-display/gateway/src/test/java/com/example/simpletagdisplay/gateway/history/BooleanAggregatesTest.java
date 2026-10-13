package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import com.inductiveautomation.ignition.common.sqltags.history.AggregationMode;
import org.junit.jupiter.api.Test;

/**
 * A Boolean pen with DurationOn / CountOn / PctGood used to be blank whenever the Boolean
 * did not change inside the query range — the unseeded-bucket workaround dropped every bucket before the first
 * in-range sample, although Core Historian answers those aggregates correctly (DurationOn 10 per 10 s bucket of a
 * steady ON pump, CountOn 0, PctGood 0.9999, stable on repeated queries). Sum dropped its buckets as well.
 */
class BooleanAggregatesTest {

    @Test
    void stateAndQualityAggregatesOfABooleanAreTheHistoriansOwn() {
        for (AggregationMode a : List.of(AggregationMode.DurationOn, AggregationMode.DurationOff, AggregationMode.CountOn,
                AggregationMode.CountOff, AggregationMode.PctGood, AggregationMode.PctBad)) {
            assertFalse(HistoryService.unseededForBoolean(a), a + " was dropped before the first in-range sample");
        }
        // still seeded / still trusted as before
        assertFalse(HistoryService.unseededForBoolean(AggregationMode.Count));
        assertFalse(HistoryService.unseededForBoolean(AggregationMode.MinMax));
        for (AggregationMode a : List.of(AggregationMode.LastValue, AggregationMode.Maximum, AggregationMode.Minimum,
                AggregationMode.Average, AggregationMode.SimpleAverage, AggregationMode.Sum)) {
            assertTrue(HistoryService.unseededForBoolean(a), a + ": garbage was seen before the first sample");
        }
    }

    @Test
    void aSumBucketWithoutASampleIsZero() {
        assertEquals(0.0, HistoryService.probeValue(AggregationMode.Sum), "was dropped (a blank Boolean Sum pen)");
        assertNull(HistoryService.probeValue(AggregationMode.LastValue), "value aggregates take the seed sample");
        assertNull(HistoryService.probeValue(AggregationMode.Range));
    }

    @Test
    void theZeroSeedKeepsTheUnseededRowsOfASumPiece() {
        // the writer side: rows before the first sample bucket take the probe value instead of being filtered
        PenSeriesWriter w = new PenSeriesWriter(0, 40_000, PenSeriesWriter.ValueFilter.COUNT, true,
            new ResponseBudget(1_000).pen(100, 0));
        w.unseededBefore(30_000, true, HistoryService.probeValue(AggregationMode.Sum));
        w.initialize(new String[] {"t_stamp", "CTG/Pump"}, new Class<?>[] {java.util.Date.class, Double.class}, true, 4);
        for (long t = 0; t < 40_000; t += 10_000) {
            // garbage (Good quality) before the first sample bucket at 30 s
            w.write(new Object[] {new java.util.Date(t), t < 30_000 ? 3.0e9 : 2.0},
                new com.inductiveautomation.ignition.common.model.values.QualityCode[] {
                    com.inductiveautomation.ignition.common.model.values.QualityCode.Good,
                    com.inductiveautomation.ignition.common.model.values.QualityCode.Good});
        }
        assertEquals(4, w.count());
        assertEquals(0.0, w.v()[0]);
        assertEquals(0.0, w.v()[2]);
        assertEquals(2.0, w.v()[3]);
    }
}
