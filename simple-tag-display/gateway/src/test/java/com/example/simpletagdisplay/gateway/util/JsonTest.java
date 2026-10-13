package com.example.simpletagdisplay.gateway.util;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.regex.Pattern;

import com.example.simpletagdisplay.common.protocol.Protocol;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import org.junit.jupiter.api.Test;

class JsonTest {

    @Test
    void sanitizeForLogStripsControlCharsAndCaps() {
        assertEquals("a?b?c", Json.sanitizeForLog("a\rb\nc"));
        String long1 = Json.sanitizeForLog("x".repeat(2000));
        assertEquals(Json.MAX_LOG_CHARS + 3, long1.length());
        assertTrue(long1.endsWith("..."));
        assertEquals("null", Json.sanitizeForLog(null));
    }

    /** Unicode line/paragraph separators and bidi controls never reach a log line. */
    @Test
    void sanitizeForLogMapsUnicodeLineBreaksAndBidiControls() {
        assertEquals("a?b?c", Json.sanitizeForLog("a\u2028b\u2029c"));
        assertEquals("x?y", Json.sanitizeForLog("x\u0085y"), "NEL (C1 control)");
        for (char c : new char[] {0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x2066, 0x2067, 0x2068, 0x2069}) {
            assertEquals("p?q", Json.sanitizeForLog("p" + c + "q"), Integer.toHexString(c));
        }
        // ordinary non-ASCII text, emoji and the zero-width joiner of emoji sequences stay as they are
        assertEquals("Temp \u00b0C \u6e29\u5ea6 \ud83d\udc68\u200d\ud83d\udd27", Json.sanitizeForLog("Temp \u00b0C \u6e29\u5ea6 \ud83d\udc68\u200d\ud83d\udd27"));
        // the cap never splits a surrogate pair
        String pairAtCap = "x".repeat(Json.MAX_LOG_CHARS - 1) + "\ud83d\ude00tail";
        String cut = Json.sanitizeForLog(pairAtCap);
        assertEquals("x".repeat(Json.MAX_LOG_CHARS - 1) + "...", cut);
        assertFalse(Character.isHighSurrogate(cut.charAt(cut.length() - 4)));
        assertEquals("x".repeat(Json.MAX_LOG_CHARS), Json.sanitizeForLog("x".repeat(Json.MAX_LOG_CHARS)), "exactly at the cap: no ellipsis");
    }

    @Test
    void safeNumberNeverEmitsNaN() {
        assertTrue(Json.safeNumber(Double.NaN).isJsonNull());
        assertTrue(Json.safeNumber(Double.POSITIVE_INFINITY).isJsonNull());
        assertEquals(1.5, Json.safeNumber(1.5).getAsDouble());
    }

    @Test
    void typedGettersNeverThrow() {
        JsonObject o = JsonParser.parseString("{\"v\":2,\"s\":\"x\",\"b\":true,\"f\":2.5,\"o\":{}}").getAsJsonObject();
        assertEquals(2, Json.integer(o, "v", -1));
        assertEquals(-1, Json.integer(o, "f", -1));
        assertEquals(-1, Json.integer(o, "s", -1));
        assertEquals("x", Json.string(o, "s", null));
        assertEquals("d", Json.string(o, "o", "d"));
        assertTrue(Json.bool(o, "b", false));
        assertFalse(Json.bool(o, "s", false));
        assertEquals("d", Json.string(null, "s", "d"));
    }

    @Test
    void requestIdPattern() {
        Pattern id = Pattern.compile(Protocol.ID_PATTERN);
        assertTrue(id.matcher("dt0:2-17").matches());
        assertFalse(id.matcher("").matches());
        assertFalse(id.matcher("a b").matches());
        assertFalse(id.matcher("x".repeat(65)).matches());
    }
}
