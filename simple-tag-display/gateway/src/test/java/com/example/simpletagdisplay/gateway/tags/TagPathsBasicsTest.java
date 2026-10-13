package com.example.simpletagdisplay.gateway.tags;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import org.junit.jupiter.api.Test;

/**
 * Basic read rules of {@link TagPaths} and the shared trendGroup normalisation. The full path rules v2 are covered
 * by {@link TagPathsV2Test}.
 */
class TagPathsBasicsTest {

    @Test
    void emptyIsNoTagPath() {
        assertEquals(ErrorCode.NO_TAG_PATH, TagPaths.parse(null).error());
        assertEquals(ErrorCode.NO_TAG_PATH, TagPaths.parse("   ").error());
    }

    @Test
    void plainTagPathParses() {
        TagPaths.Parsed p = TagPaths.parse(" [default]CTG/Temp ");
        assertTrue(p.ok());
        assertEquals("Temp", TagPaths.tagName(p.path()));
        assertEquals("[default]ctg/temp", TagPaths.normalizedKey(p.path()));
    }

    @Test
    void valuePropertyIsAllowedOtherPropertiesAreNot() {
        assertTrue(TagPaths.parse("[default]CTG/Temp.Value").ok());
        assertEquals(ErrorCode.INVALID_PATH, TagPaths.parse("[default]CTG/Temp.EngUnit").error());
    }

    @Test
    void alarmAndQualifiedAndControlCharPathsAreRejected() {
        assertEquals(ErrorCode.INVALID_PATH, TagPaths.parse("[default]CTG/Temp/Alarms.HighestActivePriority").error());
        assertEquals(ErrorCode.INVALID_PATH, TagPaths.parse("histprov:Core:/drv:x:default:/tag:ctg/temp").error());
        assertEquals(ErrorCode.INVALID_PATH, TagPaths.parse("[default]CTG/Te\nmp").error());
        assertEquals(ErrorCode.INVALID_PATH, TagPaths.parse("[default]" + "a".repeat(1100)).error());
    }

    @Test
    void normalizedKeyIsCaseInsensitive() {
        assertEquals(TagPaths.normalizedKey(TagPaths.parse("[default]CTG/Temp").path()),
            TagPaths.normalizedKey(TagPaths.parse("[DEFAULT]ctg/TEMP").path()));
    }

    @Test
    void trendGroupNormalisation() {
        assertEquals("default", TagPaths.normTrendGroup(null, false));
        assertEquals("default", TagPaths.normTrendGroup("  ", false));
        assertNull(TagPaths.normTrendGroup(null, true));
        assertNull(TagPaths.normTrendGroup("", true));
        assertEquals("Area_1.B-2", TagPaths.normTrendGroup(" Area 1.B-2 ", false));
        assertEquals(64, TagPaths.normTrendGroup("x".repeat(100), true).length());
        assertFalse(TagPaths.normTrendGroup("a/b\\c", false).contains("/"));
    }

    /** The gateway and the browser must agree; the same vectors run in delegate-base.test.mjs. */
    @Test
    void trendGroupMatchesSharedVectors() throws IOException {
        String dir = System.getProperty("ctg.test.vectors", "../tests/vectors");
        String text = Files.readString(Path.of(dir, "trend-group.json"), StandardCharsets.UTF_8);
        JsonArray vectors = JsonParser.parseString(text).getAsJsonObject().getAsJsonArray("vectors");
        assertTrue(vectors.size() >= 15);
        for (JsonElement e : vectors) {
            JsonObject v = e.getAsJsonObject();
            String in = v.get("in").isJsonNull() ? null : v.get("in").getAsString();
            String out = v.get("out").isJsonNull() ? null : v.get("out").getAsString();
            boolean chart = "chart".equals(v.get("kind").getAsString());
            assertEquals(out, TagPaths.normTrendGroup(in, chart), "normTrendGroup(" + v.get("in") + ", " + chart + ")");
        }
    }
}
