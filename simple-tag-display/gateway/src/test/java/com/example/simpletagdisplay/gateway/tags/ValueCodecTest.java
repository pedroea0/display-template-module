package com.example.simpletagdisplay.gateway.tags;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Date;
import java.util.List;

import com.inductiveautomation.ignition.common.BasicDataset;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.model.values.BasicQualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import org.junit.jupiter.api.Test;

/** Typed value encoding and push caps. */
class ValueCodecTest {

    private static QualifiedValue qv(Object v) {
        return new BasicQualifiedValue(v, QualityCode.Good, new Date(1_791_398_399_000L));
    }

    private static JsonObject enc(Object v) {
        return ValueCodec.encode(qv(v), 0);
    }

    @Test
    void numbers() {
        JsonObject o = enc(75.0);
        assertEquals(75.0, o.get("v").getAsDouble());
        assertEquals(1_791_398_399_000L, o.get("t").getAsLong());
        assertEquals("good", o.getAsJsonObject("q").get("level").getAsString());
        assertEquals(192, o.getAsJsonObject("q").get("code").getAsInt());
        assertEquals(523, enc(523).get("v").getAsLong());
        assertFalse(enc(523).has("bigint"));
    }

    @Test
    void nonFiniteNumbersBecomeNullWithAFlag() {
        JsonObject nan = enc(Double.NaN);
        assertTrue(nan.get("v").isJsonNull());
        assertEquals("NaN", nan.get("nonFinite").getAsString());
        assertEquals("Infinity", enc(Double.POSITIVE_INFINITY).get("nonFinite").getAsString());
        assertEquals("-Infinity", enc(Float.NEGATIVE_INFINITY).get("nonFinite").getAsString());
        // the whole object must be valid JSON (no bare NaN token)
        assertFalse(nan.toString().contains("NaN,") || nan.toString().contains(":NaN"));
    }

    @Test
    void bigIntegersBecomeStrings() {
        JsonObject o = enc(9007199254740993L);
        assertEquals("9007199254740993", o.get("v").getAsString());
        assertTrue(o.get("bigint").getAsBoolean());
        assertEquals(9007199254740991L, enc(9007199254740991L).get("v").getAsLong(), "2^53-1 stays a number");
        assertTrue(enc(java.math.BigInteger.TEN.pow(30)).get("bigint").getAsBoolean());
    }

    @Test
    void booleansStringsDates() {
        assertTrue(enc(true).get("v").getAsBoolean());
        assertEquals("Pump 101", enc("Pump 101").get("v").getAsString());
        JsonObject longStr = enc("x".repeat(5000));
        assertEquals(ValueCodec.MAX_STRING, longStr.get("v").getAsString().length());
        assertTrue(longStr.get("truncated").getAsBoolean());
        JsonObject d = enc(new Date(1234L));
        assertEquals(1234L, d.get("v").getAsLong());
        assertEquals("DateTime", d.get("type").getAsString());
        assertTrue(enc(null).get("v").isJsonNull());
    }

    @Test
    void arraysAreCappedWithLength() {
        Double[] small = {1.0, 2.0, 3.0};
        JsonObject s = enc(small);
        assertEquals(3, s.getAsJsonArray("v").size());
        assertEquals(3, s.get("length").getAsInt());
        assertFalse(s.has("truncated"));
        double[] big = new double[250];
        JsonObject b = enc(big);
        assertEquals(ValueCodec.MAX_ARRAY_ITEMS, b.getAsJsonArray("v").size());
        assertEquals(250, b.get("length").getAsInt());
        assertTrue(b.get("truncated").getAsBoolean());
        JsonObject withNan = enc(new Double[] {1.0, Double.NaN});
        assertTrue(withNan.getAsJsonArray("v").get(1).isJsonNull());
        assertFalse(withNan.has("nonFinite"), "element flags do not leak to the top level");
        assertEquals(2, enc(List.of("a", "b")).getAsJsonArray("v").size());
    }

    @Test
    void datasetSummary() {
        BasicDataset ds = new BasicDataset(List.of("a", "b"), List.of(Integer.class, Integer.class), new Object[][] {{1, 2, 3}, {4, 5, 6}});
        JsonObject o = enc(ds);
        assertEquals(3, o.getAsJsonObject("v").getAsJsonObject("dataset").get("rows").getAsInt());
        assertEquals(2, o.getAsJsonObject("v").getAsJsonObject("dataset").get("cols").getAsInt());
    }

    @Test
    void pushCapReplacesHugeValues() {
        JsonObject o = ValueCodec.encode(qv("y".repeat(3000)), 1000);
        assertTrue(o.get("v").isJsonNull());
        assertTrue(o.get("truncated").getAsBoolean());
        assertTrue(o.get("summary").getAsString().startsWith("String"));
        assertEquals("y".repeat(3000), ValueCodec.encode(qv("y".repeat(3000)), 65536).get("v").getAsString());
    }

    @Test
    void qualityLevelsAndStatus() {
        assertEquals("good", ValueCodec.level(QualityCode.Good));
        assertEquals("uncertain", ValueCodec.level(QualityCode.Uncertain_LastKnownValue));
        assertEquals("bad", ValueCodec.level(QualityCode.Bad_NotConnected));
        assertEquals("error", ValueCodec.level(QualityCode.Error_Configuration));
        assertEquals("bad", ValueCodec.level(null));
        assertEquals("notFound", ValueCodec.status(QualityCode.Bad_NotFound));
        assertEquals("accessDenied", ValueCodec.status(QualityCode.Bad_AccessDenied));
        assertEquals("accessDenied", ValueCodec.status(QualityCode.Bad_Unauthorized));
        assertEquals("ok", ValueCodec.status(QualityCode.Bad_Stale));
        JsonObject q = ValueCodec.encode(new BasicQualifiedValue(1.0, QualityCode.Bad_Stale, new Date()), 0);
        assertEquals("bad", q.getAsJsonObject("q").get("level").getAsString());
        assertEquals(1.0, q.get("v").getAsDouble(), "the last value is kept with a bad quality");
    }

    @Test
    void alarmPriorityNames() {
        assertEquals("Diagnostic", ValueCodec.alarmPriorityName(0));
        assertEquals("High", ValueCodec.alarmPriorityName(3));
        assertEquals("Critical", ValueCodec.alarmPriorityName(4));
        assertNull(ValueCodec.alarmPriorityName(5));
        assertNull(ValueCodec.alarmPriorityName(-1));
        assertNull(ValueCodec.alarmPriorityName(null));
        assertEquals("Medium", ValueCodec.alarmPriorityName("medium"));
        assertNull(ValueCodec.alarmPriorityName("nope"));
    }

    @Test
    void declaredTypeIsSent() {
        assertEquals("Float8", ValueCodec.encode(qv(1.0), "Float8", 0).get("type").getAsString());
    }
}
