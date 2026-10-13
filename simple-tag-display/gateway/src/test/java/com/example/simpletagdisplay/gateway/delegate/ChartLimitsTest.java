package com.example.simpletagdisplay.gateway.delegate;

import static org.junit.jupiter.api.Assertions.assertEquals;

import java.util.Map;

import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.history.HistoryService;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import org.junit.jupiter.api.Test;

/**
 * {@code chart.snapshot.limits} carries the gateway's history query deadline ({@code historyTimeoutMs}, the client's
 * fetch deadline is derived from it) and the request burst ({@code historyBurst}) next to {@code minIntervalMs}.
 */
class ChartLimitsTest {

    @Test
    void limitsCarryTheHistoryDeadlineAndBurst() {
        JsonObject d = CtgChartDelegate.limits(ModuleSettings.Settings.defaults());
        assertEquals(15_000, d.get("historyTimeoutMs").getAsInt(), "ctg.history.timeoutMs default");
        assertEquals(8, d.get("historyBurst").getAsInt());
        assertEquals(HistoryService.REQUEST_BURST, d.get("historyBurst").getAsInt());
        assertEquals(200, d.get("minIntervalMs").getAsInt(), "unchanged member");

        Map<String, String> p = Map.of("ctg.history.timeoutMs", "42000");
        JsonObject l = CtgChartDelegate.limits(ModuleSettings.Settings.read(p::get, w -> { }));
        assertEquals(42_000, l.get("historyTimeoutMs").getAsInt(), "the live setting");
    }
}
