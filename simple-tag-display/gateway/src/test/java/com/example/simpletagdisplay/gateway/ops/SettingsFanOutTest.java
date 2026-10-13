package com.example.simpletagdisplay.gateway.ops;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * The settings fan-out is module-wide (charts and displays) and runs its callbacks after {@code GatewayServices}
 * rebuilt the floor policy, so a display that recomputes its {@code capabilities} in the callback sees the new floor
 * at once.
 */
class SettingsFanOutTest {

    private final Map<String, String> props = new ConcurrentHashMap<>();
    private final ModuleSettings settings = new ModuleSettings(props::get);
    private final GatewayServices services = new GatewayServices(null, null, settings);

    @AfterEach
    void close() {
        services.close();
    }

    @Test
    void oneInstancePerModuleAndOneCallPerChangingReload() {
        SettingsFanOut f = SettingsFanOut.of(services);
        assertSame(f, SettingsFanOut.of(services), "registered once (onReload listeners cannot be removed)");
        List<String> calls = new ArrayList<>();
        Runnable display = () -> calls.add("display");
        Runnable chart = () -> calls.add("chart");
        f.add(display);
        f.add(chart);

        props.put("ctg.audit.required", "true");
        assertTrue(settings.reload());
        assertEquals(2, calls.size(), "every running delegate, once: " + calls);
        assertTrue(calls.contains("display") && calls.contains("chart"));

        assertFalse(settings.reload(), "nothing changed");
        assertEquals(2, calls.size(), "an unchanged reload calls nobody");

        f.remove(display);
        props.put("ctg.audit.required", "false");
        settings.reload();
        assertEquals(3, calls.size());
        assertEquals("chart", calls.get(2), "a stopped display is not called");
    }

    @Test
    void callbacksSeeTheRebuiltFloorPolicy() {
        // The display's capabilities read services.floorPolicy(): it must already be the new one in the callback.
        List<Boolean> seen = new ArrayList<>();
        SettingsFanOut.of(services).add(() -> seen.add(services.floorPolicy().readProviderDenied("CTG_Edit")));
        assertFalse(services.floorPolicy().readProviderDenied("CTG_Edit"));
        props.put("ctg.read.deniedProviders", "System,CTG_Edit");
        settings.reload();
        assertEquals(List.of(true), seen);
    }

    @Test
    void oneFailingDelegateDoesNotStopTheOthers() {
        SettingsFanOut f = new SettingsFanOut();
        List<String> calls = new ArrayList<>();
        f.add(() -> {
            throw new IllegalStateException("closed session");
        });
        f.add(() -> calls.add("ok"));
        f.changed();
        assertEquals(List.of("ok"), calls);
    }
}
