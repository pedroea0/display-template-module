package com.example.simpletagdisplay.gateway.delegate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Date;

import com.inductiveautomation.ignition.common.model.values.BasicQualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import org.junit.jupiter.api.Test;

/**
 * A bound numeric write guard whose binding has a bad quality (the stale last value of a faulted or missing tag) is
 * read as JSON null, so DisplayGates refuses the write instead of trusting the stale number.
 */
class GuardLeafQualityTest {

    @Test
    void badQualityGuardLeafReadsAsNull() {
        for (String k : new String[] {"setpoint.limits.low", "setpoint.limits.high", "setpoint.maxStep",
                "setpoint.maxStepPercent"}) {
            assertTrue(CtgDelegateBase.guardLeafJson(k, new BasicQualifiedValue(100.0, QualityCode.Bad_NotFound,
                new Date())).isJsonNull(), k);
            assertTrue(CtgDelegateBase.guardLeafJson(k, new BasicQualifiedValue(100.0, QualityCode.Bad_Stale,
                new Date())).isJsonNull(), k);
            assertEquals(100.0, CtgDelegateBase.guardLeafJson(k, new BasicQualifiedValue(100.0, QualityCode.Good,
                new Date())).getAsDouble(), k);
        }
        // other leaves keep their value (their own gates already fail closed on null or wrong types)
        assertTrue(CtgDelegateBase.guardLeafJson("setpoint.enabled", new BasicQualifiedValue(true,
            QualityCode.Bad_Stale, new Date())).getAsBoolean());
    }
}
