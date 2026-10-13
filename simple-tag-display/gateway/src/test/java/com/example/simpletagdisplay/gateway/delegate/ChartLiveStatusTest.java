package com.example.simpletagdisplay.gateway.delegate;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

/**
 * {@code noHistory} pens get {@code chart.values} like {@code ok} pens (they have a current value; only their history
 * is unavailable). No other status ever receives a value.
 */
class ChartLiveStatusTest {

    @Test
    void okAndNoHistoryAreLiveEverythingElseIsNot() {
        assertEquals(true, CtgChartDelegate.liveStatus("ok"));
        assertEquals(true, CtgChartDelegate.liveStatus("noHistory"));
        for (String s : new String[] {"notFound", "accessDenied", "unsupportedType", "invalidPath", "outOfScope",
            "overLimit", "loading", null, "", "OK"}) {
            assertEquals(false, CtgChartDelegate.liveStatus(s), String.valueOf(s));
        }
    }
}