package com.example.simpletagdisplay.gateway.tags;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Date;
import java.util.List;
import java.util.Map;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.model.values.BasicQualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import org.junit.jupiter.api.Test;

/** Config edit validation, result mapping, audit text; meta paths and history availability. */
class TagConfigEditorTest {

    private static TagConfigEditor.Parsed parse(String json) {
        return TagConfigEditor.parse(JsonParser.parseString(json));
    }

    @Test
    void parseChanges() {
        TagConfigEditor.Parsed p = parse("{\"engUnit\":\"degC\",\"engHigh\":150}");
        assertTrue(p.ok());
        assertEquals("degC", p.changes().engUnit());
        assertNull(p.changes().engLow());
        assertEquals(150.0, p.changes().engHigh());
        assertEquals("{\"engUnit\":\"degC\",\"engHigh\":150.0}", p.changes().toJson().toString());
        assertEquals(ErrorCode.INVALID_VALUE, parse("{}").error());
        assertEquals(ErrorCode.BAD_REQUEST, parse("{\"engUnit\":\"a\",\"documentation\":\"x\"}").error());
        assertEquals(ErrorCode.BAD_REQUEST, parse("[1]").error());
        assertEquals(ErrorCode.INVALID_VALUE, parse("{\"engUnit\":\"a\\nb\"}").error());
        assertEquals(ErrorCode.INVALID_VALUE, parse("{\"engUnit\":\"" + "u".repeat(65) + "\"}").error());
        assertEquals(ErrorCode.INVALID_VALUE, parse("{\"engLow\":\"5\"}").error());
        assertEquals(ErrorCode.INVALID_VALUE, parse("{\"engUnit\":5}").error());
        assertEquals(ErrorCode.BAD_REQUEST, TagConfigEditor.parse(null).error());
    }

    @Test
    void rangeUsesCurrentValuesForMissingSides() {
        TagConfigEditor.Changes c = parse("{\"engLow\":200}").changes();
        assertEquals(ErrorCode.INVALID_VALUE, TagConfigEditor.checkRange(c, 0, 100));
        assertNull(TagConfigEditor.checkRange(parse("{\"engHigh\":150}").changes(), 0, 100));
        assertEquals(ErrorCode.INVALID_VALUE, TagConfigEditor.checkRange(parse("{\"engLow\":5,\"engHigh\":5}").changes(), 0, 100));
        assertNull(TagConfigEditor.checkRange(parse("{\"engLow\":5}").changes(), Double.NaN, Double.NaN));
    }

    @Test
    void resultMappingAndDescription() {
        assertNull(TagConfigEditor.mapResult(QualityCode.Good));
        assertEquals(ErrorCode.EDIT_DENIED, TagConfigEditor.mapResult(QualityCode.Bad_AccessDenied));
        assertEquals(ErrorCode.TAG_NOT_FOUND, TagConfigEditor.mapResult(QualityCode.Bad_NotFound));
        assertEquals(ErrorCode.WRITE_FAILED, TagConfigEditor.mapResult(QualityCode.Bad_Failure));
        assertEquals("EngUnit: 'degF' -> 'degC'; EngHigh: 100.0 -> 150.0",
            TagConfigEditor.describe(parse("{\"engUnit\":\"degC\",\"engHigh\":150}").changes(), "degF", 0.0, 100.0));
    }

    @Test
    void derivedPaths() {
        TagPaths.Parsed base = TagPaths.parse("[default]CTG/Temp", null);
        assertEquals("[default]CTG/Temp", TagMetaReader.path(base.path(), TagMetaReader.VALUE, null).toStringFull());
        assertTrue("EngLow".equalsIgnoreCase(TagMetaReader.path(base.path(), TagMetaReader.ENG_LOW, null).getProperty().getName()));
        assertTrue(TagMetaReader.path(base.path(), TagMetaReader.CAN_WRITE, null).toStringFull().endsWith("CanWrite"));
        assertTrue(TagMetaReader.path(base.path(), TagMetaReader.ALARM_ACTIVE, null).toStringFull().contains("Alarms"));
        assertTrue(TagMetaReader.path(base.path(), TagMetaReader.ALARM_LOW_SP, "Low").toStringFull().contains("Low"));
        assertNull(TagMetaReader.path(base.path(), TagMetaReader.ALARM_LOW_SP, "Lo/../x"), "alarm names cannot inject paths");
        assertNull(TagMetaReader.path(base.path(), TagMetaReader.ALARM_HIGH_SP, ""));
        assertNull(TagMetaReader.path(base.path(), "nope", null));
        assertFalse(TagMetaReader.validAlarmName("a.b"));
        assertTrue(TagMetaReader.validAlarmName("Hi Hi (2)"));
    }

    @Test
    void historyAvailability() {
        long[] now = {0};
        HistoryAvailability h = new HistoryAvailability(() -> now[0]);
        int[] calls = {0};
        java.util.function.Supplier<java.util.Collection<String>> src = () -> {
            calls[0]++;
            return List.of("Core Historian");
        };
        assertEquals("ok", h.check(meta(true, "Core Historian", com.inductiveautomation.ignition.common.sqltags.model.types.DataType.Float8), src).reason());
        assertEquals("disabled", h.check(meta(false, "Core Historian", null), src).reason());
        assertEquals("noProvider", h.check(meta(true, " ", null), src).reason());
        assertEquals("providerMissing", h.check(meta(true, "Gone", null), src).reason());
        assertEquals("unsupportedType", h.check(meta(true, "core historian",
            com.inductiveautomation.ignition.common.sqltags.model.types.DataType.String), src).reason());
        assertEquals(1, calls[0], "provider list cached");
        now[0] += HistoryAvailability.TTL_MS;
        h.check(meta(true, "Core Historian", null), src);
        assertEquals(2, calls[0], "refreshed after the TTL");
        assertTrue(h.check(meta(true, "Core Historian", null), src).toJson().get("available").getAsBoolean());
    }

    private static TagMetaReader.Meta meta(Boolean enabled, String provider,
                                           com.inductiveautomation.ignition.common.sqltags.model.types.DataType dt) {
        Map<String, com.inductiveautomation.ignition.common.model.values.QualifiedValue> m = new java.util.HashMap<>();
        m.put(TagMetaReader.HISTORY_ENABLED, new BasicQualifiedValue(enabled, QualityCode.Good, new Date()));
        m.put(TagMetaReader.HISTORY_PROVIDER, new BasicQualifiedValue(provider, QualityCode.Good, new Date()));
        if (dt != null) {
            m.put(TagMetaReader.DATA_TYPE, new BasicQualifiedValue(dt, QualityCode.Good, new Date()));
        }
        return new TagMetaReader.Meta(m);
    }
}
