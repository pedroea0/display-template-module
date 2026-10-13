package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.inductiveautomation.ignition.common.sqltags.history.AggregationMode;
import org.junit.jupiter.api.Test;

/** The anchor of aggregated pens. */
class AggregatedAnchorTest {

    private static final long FROM = 1_791_398_400_000L;

    @Test
    void anAggregatedValuePenGetsTheAnchorAlthoughItsFirstBucketStartsAtTheWindowStart() {
        // the first bucket is stamped at the window start but drawn at its end (LastValue) or middle: without the
        // anchor the series never reached the left edge (was: only when the data started after the window start)
        for (AggregationMode a : new AggregationMode[] {AggregationMode.LastValue, AggregationMode.MinMax,
            AggregationMode.Average, AggregationMode.SimpleAverage, AggregationMode.Minimum, AggregationMode.Maximum}) {
            assertTrue(HistoryService.anchorNeeded(a, FROM, FROM), a.name());
            assertTrue(HistoryService.anchorNeeded(a, FROM + 60_000, FROM), a.name());
        }
    }

    @Test
    void rawPensAreUnchangedAndStatisticAggregationsNeverTakeARawAnchor() {
        assertTrue(HistoryService.anchorNeeded(null, FROM + 1, FROM), "raw: data after the window start");
        assertFalse(HistoryService.anchorNeeded(null, FROM, FROM), "raw: a sample at the window start needs none");
        for (AggregationMode a : new AggregationMode[] {AggregationMode.Count, AggregationMode.DurationOn,
            AggregationMode.Range, AggregationMode.Sum}) {
            assertFalse(HistoryService.anchorNeeded(a, FROM, FROM), a.name());
            assertFalse(HistoryService.anchorNeeded(a, FROM + 60_000, FROM), a.name() + ": a raw value is not a " + a.name());
        }
    }
}
