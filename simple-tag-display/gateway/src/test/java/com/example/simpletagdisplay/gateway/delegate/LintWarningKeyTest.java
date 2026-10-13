package com.example.simpletagdisplay.gateway.delegate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotEquals;

import org.junit.jupiter.api.Test;

/**
 * The {@code security-key-bound} WARN is deduplicated per project, view, component and key, so the same view path in
 * a second project (a migrated copy) gets its own WARN.
 */
class LintWarningKeyTest {

    @Test
    void theProjectIsPartOfTheKey() {
        String a = CtgDelegateBase.lintWarningKey("Plant_A", "V1Bindings", "root/DT", "setpoint.enabled");
        String b = CtgDelegateBase.lintWarningKey("Plant_B", "V1Bindings", "root/DT", "setpoint.enabled");
        assertNotEquals(a, b);
        assertEquals(a, CtgDelegateBase.lintWarningKey("Plant_A", "V1Bindings", "root/DT", "setpoint.enabled"));
        assertNotEquals(a, CtgDelegateBase.lintWarningKey("Plant_A", "V1Bindings", "root/DT", "setpoint.access"));
    }
}
