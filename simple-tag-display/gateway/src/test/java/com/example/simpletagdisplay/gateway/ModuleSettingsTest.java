package com.example.simpletagdisplay.gateway;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.Test;

/** Module settings: defaults, clamping, live reload. */
class ModuleSettingsTest {

    @Test
    void defaultsMatchTheDesign() {
        ModuleSettings.Settings s = ModuleSettings.Settings.defaults();
        assertEquals(150, s.displayCoalesceMs());
        assertEquals(250_000, s.historyMaxRawPointsPerPen());
        assertEquals(4, s.historyMaxConcurrentPerSession());
        assertEquals(32, s.trendMaxPens());
        assertEquals(900_000L, s.tokenTtlMs());
        assertEquals(300_000L, s.tokenDesignerTtlMs());
        assertFalse(s.writeRequireAuthenticated(), "opt-in floor, native Perspective parity");
        assertTrue(s.securityRejectBoundGates(), "default true");
        assertFalse(s.securityAllowCrossOriginFrames());
        assertEquals(List.of("System"), s.writeDeniedProviders());
        assertEquals(List.of("System"), s.readDeniedProviders());
        assertTrue(s.writeRequiredRoles().isEmpty());
        assertEquals(64, s.historyMaxTasksPerRequest());
        assertEquals(5_000_000L, s.historyMaxInFlightPoints());
        assertEquals(30_000, s.displayHeartbeatMs());
        assertTrue(s.trendClearOnUserChange());
    }

    @Test
    void sessionSweepIntervalIsALiveClampedSetting() {
        // default 10 min, 10 s .. 1 h.
        assertEquals(600_000L, ModuleSettings.Settings.defaults().sessionSweepMs());
        Map<String, String> p = new HashMap<>();
        p.put("ctg.session.sweepMs", "15000");
        assertEquals(15_000L, ModuleSettings.Settings.read(p::get, w -> { }).sessionSweepMs());
        p.put("ctg.session.sweepMs", "5");
        List<String> warnings = new ArrayList<>();
        assertEquals(10_000L, ModuleSettings.Settings.read(p::get, warnings::add).sessionSweepMs());
        assertEquals(1, warnings.size(), warnings.toString());
        p.put("ctg.session.sweepMs", "15000");
        ModuleSettings.Settings a = ModuleSettings.Settings.read(p::get, w -> { });
        p.put("ctg.session.sweepMs", "20000");
        assertFalse(a.equals(ModuleSettings.Settings.read(p::get, w -> { })), "a change is a reload (equals covers it)");
    }

    @Test
    void invalidValuesFallBackOrClampWithOneWarningEach() {
        Map<String, String> p = new HashMap<>();
        p.put("ctg.history.threads", "999");
        p.put("ctg.display.coalesceMs", "fast");
        p.put("ctg.debug", "yes");
        p.put("ctg.write.requiredRoles", " Operator , ,Engineer ");
        List<String> warnings = new ArrayList<>();
        ModuleSettings.Settings s = ModuleSettings.Settings.read(p::get, warnings::add);
        assertEquals(32, s.historyThreads());
        assertEquals(150, s.displayCoalesceMs());
        assertFalse(s.debug());
        assertEquals(List.of("Operator", "Engineer"), s.writeRequiredRoles());
        assertEquals(3, warnings.size(), warnings.toString());
    }

    @Test
    void reloadSwapsTheSnapshotAndNotifiesOnlyOnChange() {
        Map<String, String> p = new HashMap<>();
        ModuleSettings m = new ModuleSettings(p::get);
        AtomicInteger notified = new AtomicInteger();
        m.onReload(s -> notified.incrementAndGet());
        assertFalse(m.reloadIfRevChanged(), "no rev change");
        p.put("ctg.history.threads", "8");
        assertFalse(m.reloadIfRevChanged(), "a value change alone does not trigger the poll");
        p.put(ModuleSettings.REV_PROPERTY, "1");
        assertTrue(m.reloadIfRevChanged());
        assertEquals(8, m.get().historyThreads());
        assertEquals(1, notified.get());
        assertFalse(m.reload(), "nothing changed");
        assertEquals(1, notified.get());
    }
}
