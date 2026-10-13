package com.example.simpletagdisplay.gateway.delegate;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Map;

import com.example.simpletagdisplay.gateway.ModuleSettings;
import org.junit.jupiter.api.Test;

/**
 * A changed limits object used to reach running charts only at their next snapshot. Now, on a settings reload, the
 * chart delegate compares the {@code limits} its client has with the current ones and re-publishes the snapshot when
 * they differ. The decision is {@link CtgChartDelegate#limitsOutdated}; the push itself is checked against a live
 * gateway.
 */
class ChartLimitsRepublishTest {

    private static ModuleSettings.Settings settings(Map<String, String> p) {
        return ModuleSettings.Settings.read(p::get, w -> { });
    }

    @Test
    void aChangedLimitIsOutdatedForAClientThatHasTheOldOne() {
        String sent = CtgChartDelegate.limits(ModuleSettings.Settings.defaults()).toString();
        assertFalse(CtgChartDelegate.limitsOutdated(true, sent, ModuleSettings.Settings.defaults()), "unchanged: nothing to push");
        assertTrue(CtgChartDelegate.limitsOutdated(true, sent, settings(Map.of("ctg.history.timeoutMs", "42000"))),
            "historyTimeoutMs changed");
        assertTrue(CtgChartDelegate.limitsOutdated(true, sent, settings(Map.of("ctg.history.minIntervalMs", "500"))),
            "minIntervalMs changed (the client's bucket mirror refill)");
        assertTrue(CtgChartDelegate.limitsOutdated(true, sent, settings(Map.of("ctg.history.maxConcurrentPerSession", "2"))),
            "maxConcurrentPerSession changed (the client's in-flight cap)");
    }

    @Test
    void nothingIsPushedBeforeTheClientHasASnapshot() {
        ModuleSettings.Settings changed = settings(Map.of("ctg.history.timeoutMs", "42000"));
        assertFalse(CtgChartDelegate.limitsOutdated(false, "{}", changed), "no hello yet: the hello snapshot carries them");
        assertFalse(CtgChartDelegate.limitsOutdated(true, null, changed), "no snapshot sent yet");
    }
}
