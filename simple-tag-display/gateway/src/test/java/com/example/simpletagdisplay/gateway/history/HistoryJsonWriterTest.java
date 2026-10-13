package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.gson.stream.JsonReader;
import org.junit.jupiter.api.Test;

/**
 * Streaming response writer: strict JSON whatever the values (no NaN / Infinity token, a v1 bug), segments
 * concatenated in order, anchor / replaceFrom / downgrade fields, debug-only statistics.
 */
class HistoryJsonWriterTest {

    private static JsonObject parseStrict(String json) {
        JsonReader r = new JsonReader(new java.io.StringReader(json));
        r.setLenient(false);
        return JsonParser.parseReader(r).getAsJsonObject();
    }

    @Test
    void nonFiniteValuesAreNullAndSegmentsAreConcatenated() throws Exception {
        long[] t1 = {1, 2, 3, 99};
        double[] v1 = {1.5, Double.NaN, Double.POSITIVE_INFINITY, 7};
        long[] t2 = {4, 5};
        double[] v2 = {Double.NEGATIVE_INFINITY, 5.25};
        HistoryResult.Pen pen = HistoryResult.Pen.data("k0", "[default]CTG/Fuzz",
                List.of(new HistoryResult.Segment(t1, v1, 0, 3), new HistoryResult.Segment(t2, v2, 0, 2)))
            .withType("Float8", "MinMax", true).withAnchor(new AnchorCache.Anchor(0, Double.NaN)).withReplaceFrom(3L)
            .withDowngrade(60_000);
        HistoryResult.Pen denied = HistoryResult.Pen.empty("k1", "[default]CTG/Secret", HistoryResult.ACCESS_DENIED);
        HistoryResult r = new HistoryResult("h-1", 10, 0, 100, "aggregated", "MinMax", 1_000L, true, false,
            List.of(pen, denied), 5, null);
        ByteArrayOutputStream os = new ByteArrayOutputStream();
        HistoryJsonWriter.write(r, os);
        String json = os.toString(StandardCharsets.UTF_8);
        assertFalse(json.contains("NaN") || json.contains("Infinity"), json);
        JsonObject o = parseStrict(json);
        assertEquals("start", o.getAsJsonObject("window").get("bucketTime").getAsString());
        JsonObject p = o.getAsJsonArray("pens").get(0).getAsJsonObject();
        JsonArray t = p.getAsJsonArray("t");
        JsonArray v = p.getAsJsonArray("v");
        assertEquals(5, t.size(), "only [from, to) of each segment");
        assertEquals(5, p.get("count").getAsInt());
        assertEquals(4, t.get(3).getAsLong());
        assertTrue(v.get(1).isJsonNull());
        assertTrue(v.get(2).isJsonNull());
        assertTrue(v.get(3).isJsonNull());
        assertEquals(5.25, v.get(4).getAsDouble());
        assertTrue(p.getAsJsonObject("anchor").get("v").isJsonNull());
        assertEquals(3, p.get("replaceFrom").getAsLong());
        assertTrue(p.get("downgraded").getAsBoolean());
        assertEquals(60_000, p.get("bucketMs").getAsLong());
        assertEquals("minmax", p.get("shape").getAsString());
        JsonObject d = o.getAsJsonArray("pens").get(1).getAsJsonObject();
        assertEquals("accessDenied", d.get("status").getAsString());
        assertEquals(0, d.getAsJsonArray("t").size());
        assertFalse(o.getAsJsonObject("stats").has("cacheHits"), "cache statistics only with ctg.debug");
        assertFalse(p.has("cache"));
    }

    @Test
    void debugStatisticsAndErrors() throws Exception {
        HistoryResult r = new HistoryResult(null, 10, 0, 100, "raw", null, null, false, false, List.of(), 1,
            new HistoryResult.DebugStats(3, 1, 2, 40));
        ByteArrayOutputStream os = new ByteArrayOutputStream();
        HistoryJsonWriter.write(r, os);
        JsonObject o = parseStrict(os.toString(StandardCharsets.UTF_8));
        assertTrue(o.getAsJsonObject("window").get("bucketTime").isJsonNull());
        assertEquals(3, o.getAsJsonObject("stats").get("cacheHits").getAsInt());
        ByteArrayOutputStream es = new ByteArrayOutputStream();
        HistoryJsonWriter.writeError("h-2", ErrorCode.BUSY, es);
        JsonObject e = parseStrict(es.toString(StandardCharsets.UTF_8));
        assertFalse(e.get("ok").getAsBoolean());
        assertEquals("BUSY", e.getAsJsonObject("error").get("code").getAsString());
        assertTrue(e.getAsJsonObject("error").get("retryable").getAsBoolean());
    }
}
