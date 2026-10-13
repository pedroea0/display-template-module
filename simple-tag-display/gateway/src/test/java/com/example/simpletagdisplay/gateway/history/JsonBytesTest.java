package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.Random;

import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.gson.stream.JsonReader;
import org.junit.jupiter.api.Test;

/** The byte-level JSON writer behind history responses: strict JSON, exact numbers, UTF-8. */
class JsonBytesTest {

    private static JsonObject strict(ByteArrayOutputStream os) {
        JsonReader r = new JsonReader(new StringReader(os.toString(StandardCharsets.UTF_8)));
        r.setLenient(false);
        return JsonParser.parseReader(r).getAsJsonObject();
    }

    @Test
    void numbersRoundTripExactlyAcrossBufferBoundaries() throws Exception {
        Random rnd = new Random(42);
        int n = 20_000;
        long[] longs = new long[n];
        double[] doubles = new double[n];
        for (int i = 0; i < n; i++) {
            longs[i] = i % 7 == 0 ? Long.MIN_VALUE + i : i % 5 == 0 ? Long.MAX_VALUE - i : rnd.nextLong() >> (i % 40);
            switch (i % 6) {
                case 0: doubles[i] = rnd.nextDouble() * 1e3; break;
                case 1: doubles[i] = Math.rint(rnd.nextGaussian() * 1e6); break;          // integral fast path
                case 2: doubles[i] = rnd.nextGaussian() * 1e-7; break;
                case 3: doubles[i] = (rnd.nextBoolean() ? 1 : -1) * 1e15 * (1 + rnd.nextInt(1000)); break;
                case 4: doubles[i] = i % 12 == 4 ? -0.0 : 0.0; break;
                default: doubles[i] = Double.longBitsToDouble(rnd.nextLong() & 0x7FEFFFFFFFFFFFFFL); break;
            }
        }
        ByteArrayOutputStream os = new ByteArrayOutputStream();
        JsonBytes j = new JsonBytes(os, 100);                  // tiny buffer: every value crosses a flush
        j.beginObject();
        j.name("l").beginArray();
        for (long l : longs) {
            j.value(l);
        }
        j.endArray();
        j.name("d").beginArray();
        for (double d : doubles) {
            j.value(d);
        }
        j.endArray();
        j.endObject();
        j.flush();
        JsonObject o = strict(os);
        JsonArray l = o.getAsJsonArray("l");
        JsonArray d = o.getAsJsonArray("d");
        for (int i = 0; i < n; i++) {
            assertEquals(longs[i], l.get(i).getAsLong(), "long " + i);
            assertEquals(Double.doubleToLongBits(doubles[i]), Double.doubleToLongBits(d.get(i).getAsDouble()),
                "double " + i + " = " + doubles[i]);
        }
    }

    @Test
    void stringsAreEscapedAndUtf8() throws Exception {
        String s = "a\"b\\c\n\r\t" + (char) 1 + (char) 0x1f + " é € 😀 " + (char) 0x2028 + (char) 0x2029 + " "
            + (char) 0xD800 + "x";
        ByteArrayOutputStream os = new ByteArrayOutputStream();
        JsonBytes j = new JsonBytes(os, 64);
        j.beginObject().name("s").value(s).name("n").nullValue().name("b").value(true).name("e").beginArray().endArray()
            .name("o").beginObject().endObject().endObject();
        j.flush();
        JsonObject o = strict(os);
        assertEquals(s.replace((char) 0xD800, (char) 0xFFFD), o.get("s").getAsString());
        assertTrue(o.get("n").isJsonNull());
        assertTrue(o.get("b").getAsBoolean());
        assertEquals(0, o.getAsJsonArray("e").size());
        assertEquals(0, o.getAsJsonObject("o").size());
    }

    @Test
    void nonFiniteIsRefused() {
        JsonBytes j = new JsonBytes(new ByteArrayOutputStream());
        assertThrows(IllegalArgumentException.class, () -> j.value(Double.NaN));
        assertThrows(IllegalArgumentException.class, () -> j.value(Double.POSITIVE_INFINITY));
    }
}
