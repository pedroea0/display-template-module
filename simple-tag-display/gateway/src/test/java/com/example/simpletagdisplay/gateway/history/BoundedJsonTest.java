package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;

import com.inductiveautomation.ignition.common.gson.JsonElement;
import org.junit.jupiter.api.Test;

/** Bounded, depth-limited request parsing. */
class BoundedJsonTest {

    private static String nested(int depth) {
        return "[".repeat(depth) + "]".repeat(depth);
    }

    @Test
    void validBodyParses() throws Exception {
        JsonElement e = BoundedJson.parse("{\"v\":2,\"pens\":[{\"key\":\"p:0\",\"tagPath\":\"[default]CTG/Temp\"}],"
            + "\"start\":1791312000000,\"ok\":true,\"n\":null}", 4096, 8);
        assertEquals(2, e.getAsJsonObject().get("v").getAsInt());
        assertEquals(1791312000000L, e.getAsJsonObject().get("start").getAsLong());
        assertTrue(e.getAsJsonObject().get("n").isJsonNull());
    }

    @Test
    void depthLimitIsExact() throws Exception {
        BoundedJson.parse(nested(8), 4096, 8);
        assertThrows(BoundedJson.BadJson.class, () -> BoundedJson.parse(nested(9), 4096, 8));
        assertThrows(BoundedJson.BadJson.class, () -> BoundedJson.parse(nested(100), 4096, 8));
    }

    @Test
    void depthBombNeverOverflowsTheStack() {
        assertThrows(BoundedJson.BadJson.class, () -> BoundedJson.parse(nested(100_000), 1_000_000, 8));
    }

    @Test
    void duplicateKeysTrailingDataAndBadTokensFail() {
        assertThrows(BoundedJson.BadJson.class, () -> BoundedJson.parse("{\"a\":1,\"a\":2}", 4096, 8));
        assertThrows(BoundedJson.BadJson.class, () -> BoundedJson.parse("{\"a\":1} {}", 4096, 8));
        assertThrows(BoundedJson.BadJson.class, () -> BoundedJson.parse("{a:1}", 4096, 8));
        assertThrows(BoundedJson.BadJson.class, () -> BoundedJson.parse("{\"a\":NaN}", 4096, 8));
        assertThrows(BoundedJson.BadJson.class, () -> BoundedJson.parse("{\"a\":1" + "0".repeat(80) + "}", 4096, 8));
        assertThrows(BoundedJson.BadJson.class, () -> BoundedJson.parse("", 4096, 8));
    }

    @Test
    void sizeLimitHoldsWhateverTheClaimedLength() {
        String big = "{\"a\":\"" + "x".repeat(5000) + "\"}";
        assertThrows(BoundedJson.TooLarge.class, () -> BoundedJson.parse(big, 4096, 8));
    }

    /** A "2 GB" body is never read beyond the limit: the stream would be endless. */
    @Test
    void endlessStreamStopsAtTheLimit() {
        InputStream endless = new InputStream() {
            private boolean first = true;

            @Override
            public int read() {
                if (first) {
                    first = false;
                    return '"';
                }
                return 'x';
            }
        };
        assertThrows(BoundedJson.TooLarge.class, () -> BoundedJson.parse(endless, 64 * 1024, 8));
    }
}
