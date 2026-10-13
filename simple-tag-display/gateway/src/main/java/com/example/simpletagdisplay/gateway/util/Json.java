package com.example.simpletagdisplay.gateway.util;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.List;
import java.util.Map;

import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonPrimitive;

/**
 * Small JSON and logging helpers shared by the delegates, the history route and the security classes.
 *
 * Everything here is total: helpers never throw on unexpected shapes, they return the caller's fallback.
 */
public final class Json {

    /** Longest client-provided string written to a log line. */
    public static final int MAX_LOG_CHARS = 300;

    private Json() {
    }

    /**
     * Makes a client-provided string safe for a single log line: every character {@link #unsafeForLog}
     * reports becomes {@code '?'} and the result is capped at {@link #MAX_LOG_CHARS} characters (never in the middle
     * of a surrogate pair).
     */
    public static String sanitizeForLog(Object value) {
        if (value == null) {
            return "null";
        }
        String s = String.valueOf(value);
        int n = Math.min(s.length(), MAX_LOG_CHARS);
        if (n < s.length() && n > 0 && Character.isHighSurrogate(s.charAt(n - 1))) {
            n--;                                        // keep the pair whole: cut before it
        }
        StringBuilder b = new StringBuilder(n + 3);
        for (int i = 0; i < n; i++) {
            char c = s.charAt(i);
            b.append(unsafeForLog(c) ? '?' : c);
        }
        if (s.length() > n) {
            b.append("...");
        }
        return b.toString();
    }

    /**
     * Characters a client string must not bring into a log line:
     * <ul>
     *   <li>ISO control characters (C0, DEL, C1 — CR, LF and NEL included): they start a forged line;</li>
     *   <li>U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR: Java does not treat them as line ends, but log
     *       viewers, browsers and JSON-based log shippers do, so they could start a forged line just like LF;</li>
     *   <li>the bidirectional embedding, override and isolate controls U+202A–U+202E and U+2066–U+2069: they reorder
     *       the rest of the line on screen, so a value could make the following log text read differently from what
     *       was written ("Trojan Source").</li>
     * </ul>
     */
    static boolean unsafeForLog(char c) {
        return Character.isISOControl(c)
            || c == 0x2028 || c == 0x2029
            || (c >= 0x202A && c <= 0x202E)
            || (c >= 0x2066 && c <= 0x2069);
    }

    /**
     * A JSON number for finite values, JSON null otherwise. Ignition's Gson writes NaN/Infinity as bare tokens,
     * which is invalid JSON and breaks {@code JSON.parse} in the browser.
     */
    public static JsonElement safeNumber(double d) {
        return Double.isFinite(d) ? new JsonPrimitive(d) : JsonNull.INSTANCE;
    }

    /** String member or {@code fallback} when absent / not a string. Never throws. */
    public static String string(JsonObject o, String key, String fallback) {
        if (o == null) {
            return fallback;
        }
        JsonElement e = o.get(key);
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) {
            return fallback;
        }
        return e.getAsString();
    }

    /** Boolean member or {@code fallback}. Never throws. */
    public static boolean bool(JsonObject o, String key, boolean fallback) {
        if (o == null) {
            return fallback;
        }
        JsonElement e = o.get(key);
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isBoolean()) {
            return fallback;
        }
        return e.getAsBoolean();
    }

    /** Integer member or {@code fallback} when absent / not an integral number. Never throws. */
    public static long integer(JsonObject o, String key, long fallback) {
        if (o == null) {
            return fallback;
        }
        JsonElement e = o.get(key);
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) {
            return fallback;
        }
        double d = e.getAsDouble();
        return (Double.isFinite(d) && d == Math.rint(d)) ? (long) d : fallback;
    }

    /** Number member as a finite double, or {@code fallback}. Never throws. */
    public static double number(JsonObject o, String key, double fallback) {
        if (o == null) {
            return fallback;
        }
        JsonElement e = o.get(key);
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) {
            return fallback;
        }
        double d = e.getAsDouble();
        return Double.isFinite(d) ? d : fallback;
    }

    /**
     * The string items of a JSON array (non-strings are skipped), in order. {@code null} / non-array → empty.
     * Strings are returned exactly as given: role and security-level names are compared case-sensitively and
     * without trimming.
     */
    public static List<String> stringList(JsonElement e) {
        if (e == null || !e.isJsonArray()) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (JsonElement item : e.getAsJsonArray()) {
            if (item != null && item.isJsonPrimitive() && item.getAsJsonPrimitive().isString()) {
                out.add(item.getAsString());
            }
        }
        return Collections.unmodifiableList(out);
    }

    /**
     * Cheap upper-bound check of an inbound message: walks the tree iteratively (no
     * recursion, so a deeply nested message cannot overflow the stack here) and stops as soon as the estimated
     * serialized size exceeds {@code maxChars} or the nesting exceeds {@code maxDepth}. Replaces
     * {@code body.toString().length()}, which serialized the whole message just to measure it.
     *
     * @return null when the message is within both limits, otherwise "size" or "depth"
     */
    public static String exceedsLimits(JsonElement root, long maxChars, int maxDepth) {
        if (root == null) {
            return null;
        }
        long chars = 0;
        Deque<Object[]> stack = new ArrayDeque<>();   // {element, depth}
        stack.push(new Object[] {root, 1});
        while (!stack.isEmpty()) {
            Object[] top = stack.pop();
            JsonElement e = (JsonElement) top[0];
            int depth = (Integer) top[1];
            if (depth > maxDepth) {
                return "depth";
            }
            if (e == null || e.isJsonNull()) {
                chars += 4;
            } else if (e.isJsonPrimitive()) {
                JsonPrimitive p = e.getAsJsonPrimitive();
                chars += p.isString() ? p.getAsString().length() + 2 : 8;
            } else if (e.isJsonArray()) {
                JsonArray a = e.getAsJsonArray();
                chars += 2 + a.size();
                for (JsonElement item : a) {
                    stack.push(new Object[] {item, depth + 1});
                }
            } else if (e.isJsonObject()) {
                JsonObject o = e.getAsJsonObject();
                chars += 2;
                for (Map.Entry<String, JsonElement> m : o.entrySet()) {
                    chars += m.getKey().length() + 4;
                    stack.push(new Object[] {m.getValue(), depth + 1});
                }
            }
            if (chars > maxChars) {
                return "size";
            }
        }
        return null;
    }
}
