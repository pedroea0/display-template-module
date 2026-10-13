package com.example.simpletagdisplay.gateway.tags;

import java.lang.reflect.Array;
import java.math.BigDecimal;
import java.math.BigInteger;
import java.util.Collection;
import java.util.Date;
import java.util.Iterator;

import com.example.simpletagdisplay.gateway.util.Json;
import com.inductiveautomation.ignition.common.Dataset;
import com.inductiveautomation.ignition.common.alarming.AlarmPriority;
import com.inductiveautomation.ignition.common.document.DocumentElement;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonPrimitive;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;

/**
 * Tag values → typed JSON for the Display Template protocol. Pure and total: never throws, whatever the provider
 * hands us.
 *
 * <h2>The {@code value} object</h2>
 * <pre>
 *   {v, t, type?, q:{code, name, level}, bigint?, nonFinite?, truncated?, length?, summary?}
 * </pre>
 * <ul>
 *   <li>Numbers: finite doubles as numbers; NaN/±Infinity → {@code v:null} + {@code nonFinite:"NaN|Infinity|-Infinity"}
 *       (Ignition's Gson would emit bare tokens that break {@code JSON.parse}). Integers beyond ±2^53 → a
 *       JSON <em>string</em> + {@code bigint:true}, so the browser never rounds them.</li>
 *   <li>Boolean → JSON boolean; String → string capped at {@value #MAX_STRING} chars ({@code truncated:true});
 *       Date → epoch ms + {@code type:"DateTime"}.</li>
 *   <li>Arrays → JSON array of at most {@value #MAX_ARRAY_ITEMS} encoded elements + {@code length} (and
 *       {@code truncated:true} when cut); Dataset → {@code {dataset:{rows, cols}}}; Document → its JSON when it
 *       serialises to at most {@value #MAX_DOCUMENT_CHARS} chars, else a summary; enums → {@code name()}.</li>
 *   <li>Push cap: when the encoded {@code v} exceeds {@code maxValueBytes} characters it is replaced by
 *       {@code null} + {@code truncated:true} + {@code summary} (e.g. "String (200000 chars)").</li>
 *   <li>{@code q} is always present ({@code level} = good | uncertain | bad | error), so the client can keep the
 *       last value and draw a quality overlay instead of a "Bad Quality" text.</li>
 * </ul>
 */
public final class ValueCodec {

    /** Longest string value sent (characters). */
    public static final int MAX_STRING = 4096;
    /** Most array elements sent per value (push cap). */
    public static final int MAX_ARRAY_ITEMS = 100;
    /** Largest Document sent as JSON (characters). */
    public static final int MAX_DOCUMENT_CHARS = 16_384;
    /** 2^53 - 1: the largest integer a JavaScript number holds exactly. */
    public static final double MAX_SAFE_INTEGER = 9007199254740991d;

    private ValueCodec() {
    }

    /** {@link #encode(QualifiedValue, String, int)} without a declared data type. */
    public static JsonObject encode(QualifiedValue qv, int maxValueBytes) {
        return encode(qv, null, maxValueBytes);
    }

    /**
     * The {@code value} object of a tag value.
     *
     * @param qv            the value (null → {@code {v:null, q:{}}})
     * @param dataType      the tag's {@code DataType} name when known (sent as {@code type}); null to omit
     * @param maxValueBytes push cap for the encoded {@code v} (characters of its JSON text; ≤ 0 = no cap)
     */
    public static JsonObject encode(QualifiedValue qv, String dataType, int maxValueBytes) {
        JsonObject o = new JsonObject();
        Object v = qv == null ? null : qv.getValue();
        Flags f = new Flags();
        JsonElement enc = element(v, f, true);
        if (maxValueBytes > 0 && !enc.isJsonNull() && enc.toString().length() > maxValueBytes) {
            f.summary = describe(v) + " (" + enc.toString().length() + " chars)";
            f.truncated = true;
            f.length = -1;
            enc = JsonNull.INSTANCE;
        }
        o.add("v", enc);
        Date ts = qv == null ? null : qv.getTimestamp();
        if (ts != null) {
            o.addProperty("t", ts.getTime());
        }
        String type = dataType != null ? dataType : (v instanceof Date ? "DateTime" : null);
        if (type != null) {
            o.addProperty("type", type);
        }
        o.add("q", quality(qv == null ? null : qv.getQuality()));
        if (f.bigint) {
            o.addProperty("bigint", true);
        }
        if (f.nonFinite != null) {
            o.addProperty("nonFinite", f.nonFinite);
        }
        if (f.truncated) {
            o.addProperty("truncated", true);
        }
        if (f.length >= 0) {
            o.addProperty("length", f.length);
        }
        if (f.summary != null) {
            o.addProperty("summary", f.summary);
        }
        return o;
    }

    /**
     * A plain value as JSON (no quality, no flags): used for meta fields, {@code previous}/{@code written} in replies
     * and event payloads. Same rules as {@link #encode} for the element itself (big integers become strings,
     * non-finite numbers null, strings capped, arrays capped).
     */
    public static JsonElement plain(Object v) {
        return element(v, new Flags(), true);
    }

    /** {@code {code, name, level}}; {@code {}} for a null quality. */
    public static JsonObject quality(QualityCode q) {
        JsonObject o = new JsonObject();
        if (q != null) {
            o.addProperty("code", q.getCode());
            o.addProperty("name", q.getName());
            o.addProperty("level", level(q));
        }
        return o;
    }

    /** good | uncertain | bad | error (null → bad). */
    public static String level(QualityCode q) {
        if (q == null) {
            return "bad";
        }
        if (q.isGood()) {
            return "good";
        }
        if (q.isUncertain()) {
            return "uncertain";
        }
        return q.isError() ? "error" : "bad";
    }

    /**
     * Display status of a value's quality: {@code notFound}, {@code accessDenied}
     * ({@code Bad_AccessDenied}, alias {@code Bad_Unauthorized}) or {@code ok} (every other quality — bad or not —
     * still shows the value with an overlay).
     */
    public static String status(QualityCode q) {
        if (TagPaths.isNotFound(q)) {
            return "notFound";
        }
        if (TagPaths.isAccessDenied(q)) {
            return "accessDenied";
        }
        return "ok";
    }

    /**
     * Alarm priority as its name: {@code /Alarms.HighestActivePriority} returns an Integer 0..4;
     * an {@link AlarmPriority} or a name string are accepted too. Null / out of range → null.
     * {@code name()} is used, never {@code toString()} (localised).
     */
    public static String alarmPriorityName(Object v) {
        if (v == null) {
            return null;
        }
        if (v instanceof AlarmPriority) {
            return ((AlarmPriority) v).name();
        }
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            int i = (int) d;
            if (d != i || i < 0 || i >= AlarmPriority.values().length) {
                return null;
            }
            return AlarmPriority.values()[i].name();
        }
        String s = String.valueOf(v).trim();
        for (AlarmPriority p : AlarmPriority.values()) {
            if (p.name().equalsIgnoreCase(s)) {
                return p.name();
            }
        }
        return null;
    }

    /** Finite double of a numeric value (Number or numeric string), else NaN. */
    public static double toDouble(Object v) {
        if (v instanceof Number) {
            return ((Number) v).doubleValue();
        }
        if (v instanceof String) {
            try {
                return Double.parseDouble(((String) v).trim());
            } catch (NumberFormatException e) {
                return Double.NaN;
            }
        }
        return Double.NaN;
    }

    // =========================================================================================================
    // Element encoding
    // =========================================================================================================

    /** Flags collected while encoding the top-level value. */
    private static final class Flags {
        boolean bigint;
        String nonFinite;
        boolean truncated;
        int length = -1;
        String summary;
    }

    private static JsonElement element(Object v, Flags f, boolean top) {
        if (v == null) {
            return JsonNull.INSTANCE;
        }
        if (v instanceof QualifiedValue) {
            return element(((QualifiedValue) v).getValue(), f, top);
        }
        if (v instanceof Boolean) {
            return new JsonPrimitive((Boolean) v);
        }
        if (v instanceof Double || v instanceof Float || v instanceof BigDecimal) {
            double d = ((Number) v).doubleValue();
            if (!Double.isFinite(d)) {
                if (top) {
                    f.nonFinite = Double.isNaN(d) ? "NaN" : (d > 0 ? "Infinity" : "-Infinity");
                }
                return JsonNull.INSTANCE;
            }
            return Json.safeNumber(d);
        }
        if (v instanceof BigInteger) {
            BigInteger b = (BigInteger) v;
            if (b.abs().compareTo(BigInteger.valueOf((long) MAX_SAFE_INTEGER)) > 0) {
                if (top) {
                    f.bigint = true;
                }
                return new JsonPrimitive(b.toString());
            }
            return new JsonPrimitive(b.longValue());
        }
        if (v instanceof Byte || v instanceof Short || v instanceof Integer || v instanceof Long) {
            long l = ((Number) v).longValue();
            if (Math.abs((double) l) > MAX_SAFE_INTEGER) {
                if (top) {
                    f.bigint = true;
                }
                return new JsonPrimitive(Long.toString(l));
            }
            return new JsonPrimitive(l);
        }
        if (v instanceof Number) {
            return Json.safeNumber(((Number) v).doubleValue());
        }
        if (v instanceof Date) {
            return new JsonPrimitive(((Date) v).getTime());
        }
        if (v instanceof CharSequence || v instanceof Character) {
            String s = v.toString();
            if (s.length() > MAX_STRING) {
                if (top) {
                    f.truncated = true;
                }
                return new JsonPrimitive(s.substring(0, MAX_STRING));
            }
            return new JsonPrimitive(s);
        }
        if (v instanceof Enum) {
            return new JsonPrimitive(((Enum<?>) v).name());
        }
        if (v instanceof Dataset) {
            Dataset ds = (Dataset) v;
            JsonObject d = new JsonObject();
            d.addProperty("rows", safeCount(ds, true));
            d.addProperty("cols", safeCount(ds, false));
            JsonObject o = new JsonObject();
            o.add("dataset", d);
            return o;
        }
        if (v instanceof DocumentElement || v instanceof JsonElement) {
            JsonElement j;
            try {
                j = v instanceof JsonElement ? ((JsonElement) v).deepCopy() : ((DocumentElement) v).toJsonElement();
            } catch (RuntimeException e) {
                return new JsonPrimitive("Document");
            }
            String text = j == null ? "null" : j.toString();
            if (text.length() > MAX_DOCUMENT_CHARS) {
                if (top) {
                    f.truncated = true;
                    f.summary = "Document (" + text.length() + " chars)";
                }
                return JsonNull.INSTANCE;
            }
            return j == null ? JsonNull.INSTANCE : j;
        }
        if (v.getClass().isArray()) {
            int n = Array.getLength(v);
            JsonArray a = new JsonArray();
            for (int i = 0; i < n && i < MAX_ARRAY_ITEMS; i++) {
                a.add(element(Array.get(v, i), f, false));
            }
            if (top) {
                f.length = n;
                f.truncated |= n > MAX_ARRAY_ITEMS;
            }
            return a;
        }
        if (v instanceof Collection) {
            Collection<?> c = (Collection<?>) v;
            JsonArray a = new JsonArray();
            Iterator<?> it = c.iterator();
            for (int i = 0; it.hasNext() && i < MAX_ARRAY_ITEMS; i++) {
                a.add(element(it.next(), f, false));
            }
            if (top) {
                f.length = c.size();
                f.truncated |= c.size() > MAX_ARRAY_ITEMS;
            }
            return a;
        }
        String s = String.valueOf(v);
        return new JsonPrimitive(s.length() > MAX_STRING ? s.substring(0, MAX_STRING) : s);
    }

    private static int safeCount(Dataset ds, boolean rows) {
        try {
            return rows ? ds.getRowCount() : ds.getColumnCount();
        } catch (RuntimeException e) {
            return -1;
        }
    }

    /** Short type description for summaries ("String", "Float8[]", ...). */
    private static String describe(Object v) {
        if (v == null) {
            return "null";
        }
        if (v instanceof CharSequence) {
            return "String";
        }
        if (v.getClass().isArray()) {
            return v.getClass().getComponentType().getSimpleName() + "[" + Array.getLength(v) + "]";
        }
        return v.getClass().getSimpleName();
    }
}
