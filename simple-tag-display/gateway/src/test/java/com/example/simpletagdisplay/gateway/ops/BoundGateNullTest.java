package com.example.simpletagdisplay.gateway.ops;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Date;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.delegate.PropsSnapshot;
import com.example.simpletagdisplay.gateway.security.BindingLint;
import com.example.simpletagdisplay.gateway.security.SecurityKeys;
import com.example.simpletagdisplay.gateway.tags.TagMetaReader;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.model.values.BasicQualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.tags.config.types.TagObjectType;
import com.inductiveautomation.perspective.common.config.BindingConfig;
import com.inductiveautomation.perspective.common.config.PropertyConfig;
import org.junit.jupiter.api.Test;

/**
 * A write limit or step guard whose (lint-allowed) tag binding delivers null (tag missing, renamed, provider down)
 * must fail CLOSED with LIMITS_UNAVAILABLE, not open the range or drop the guard. An unbound null stays the schema
 * default ("not configured").
 */
class BoundGateNullTest {

    /** A direct tag binding (the lint allows it: not user-controlled) on each path of {@code bound}. */
    private static BindingLint.LintReport tagBound(Set<String> bound) {
        return BindingLint.inspect(p -> {
            if (!bound.contains(p)) {
                return Optional.empty();
            }
            PropertyConfig pc = new PropertyConfig();
            pc.binding = new BindingConfig();
            pc.binding.type = "tag";
            pc.binding.config = JsonParser.parseString("{\"mode\":\"direct\",\"tagPath\":\"[default]Missing/Tag\"}")
                .getAsJsonObject();
            return Optional.of(pc);
        }, SecurityKeys.DISPLAY);
    }

    private static PropsSnapshot snap(String json, BindingLint.LintReport lint) {
        Map<String, JsonElement> m = new HashMap<>();
        JsonObject o = JsonParser.parseString(json).getAsJsonObject();
        o.entrySet().forEach(e -> m.put(e.getKey(), e.getValue()));
        return new PropsSnapshot(m, lint, true);
    }

    private static TagMetaReader.Meta eng() {
        Map<String, QualifiedValue> m = new HashMap<>();
        m.put(TagMetaReader.ENG_LOW, new BasicQualifiedValue(0.0, QualityCode.Good, new Date()));
        m.put(TagMetaReader.ENG_HIGH, new BasicQualifiedValue(100.0, QualityCode.Good, new Date()));
        m.put(TagMetaReader.DATA_TYPE, new BasicQualifiedValue(DataType.Float8, QualityCode.Good, new Date()));
        m.put(TagMetaReader.CAN_WRITE, new BasicQualifiedValue(true, QualityCode.Good, new Date()));
        m.put(TagMetaReader.TAG_TYPE, new BasicQualifiedValue(TagObjectType.AtomicTag, QualityCode.Good, new Date()));
        return new TagMetaReader.Meta(m);
    }

    @Test
    void lintRecordsTheTagBindingAsAllowed() {
        BindingLint.LintReport r = tagBound(Set.of("setpoint.limits.high"));
        assertTrue(r.covers("setpoint.limits.high"));
        assertTrue(r.gate(true, "setpoint").isEmpty(), "a direct tag binding does not fail the gate closed by itself");
        assertFalse(r.covers("setpoint.limits.low"));
    }

    @Test
    void boundLimitDeliveringNullFailsClosed() {
        String json = "{\"setpoint.limits.useEngLimits\":false,\"setpoint.limits.low\":0,\"setpoint.limits.high\":null}";
        // control: unbound null = not configured, so that side is open
        DisplayGates.Limits open = DisplayGates.limits(snap(json, BindingLint.LintReport.clean()), DataType.Float8, eng());
        assertNull(open.error());
        assertTrue(open.contains(5000));
        // bound null = configured but unavailable: refuse (before the fix: open, and 5000 was written)
        DisplayGates.Limits l = DisplayGates.limits(snap(json, tagBound(Set.of("setpoint.limits.high"))), DataType.Float8,
            eng());
        assertEquals(ErrorCode.LIMITS_UNAVAILABLE, l.error());
        // a binding on the whole limits object whose result has high null: the same
        assertEquals(ErrorCode.LIMITS_UNAVAILABLE, DisplayGates.limits(snap(json, tagBound(Set.of("setpoint.limits"))),
            DataType.Float8, eng()).error());
        // useEngLimits:true does not hide it either (a bound side never silently falls back to EngLow)
        String withEng = "{\"setpoint.limits.low\":null,\"setpoint.limits.high\":50}";
        assertEquals(ErrorCode.LIMITS_UNAVAILABLE, DisplayGates.limits(snap(withEng,
            tagBound(Set.of("setpoint.limits.low"))), DataType.Float8, eng()).error());
        // a bound limit that delivers a number is used as usual
        DisplayGates.Limits ok = DisplayGates.limits(snap("{\"setpoint.limits.useEngLimits\":false,"
            + "\"setpoint.limits.high\":100}", tagBound(Set.of("setpoint.limits.high"))), DataType.Float8, eng());
        assertNull(ok.error());
        assertFalse(ok.contains(5000));
    }

    @Test
    void boundStepGuardDeliveringNullFailsClosed() {
        for (String k : new String[] {"setpoint.maxStep", "setpoint.maxStepPercent"}) {
            String json = "{\"" + k + "\":null}";
            assertNull(DisplayGates.stepConfigError(snap(json, BindingLint.LintReport.clean())), "unbound null: no guard");
            assertEquals(ErrorCode.LIMITS_UNAVAILABLE, DisplayGates.stepConfigError(snap(json, tagBound(Set.of(k)))), k);
        }
        assertNull(DisplayGates.stepConfigError(snap("{\"setpoint.maxStep\":1}", tagBound(Set.of("setpoint.maxStep")))),
            "bound and delivering a number");
        // a bound key that is absent from the tree is still "not configured"
        assertNull(DisplayGates.stepConfigError(snap("{}", tagBound(Set.of("setpoint.maxStep")))));
    }
}
