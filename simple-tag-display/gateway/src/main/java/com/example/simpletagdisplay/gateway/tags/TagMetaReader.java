package com.example.simpletagdisplay.gateway.tags;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.regex.Pattern;

import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonPrimitive;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.tags.config.types.TagObjectType;
import com.inductiveautomation.ignition.common.tags.model.SecurityContext;
import com.inductiveautomation.ignition.common.tags.model.TagManager;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.paths.parser.TagPathParser;

/**
 * Tag metadata for the Display Template: which derived paths exist, one batched
 * {@code readAsync} of them with the <b>user's</b> security context, and the parsed result.
 *
 * <h2>Keys</h2>
 * Every derived path has a logical key shared by the subscriber, the meta reader and the snapshot builder:
 * <pre>
 *   value            base                                  (the tag itself)
 *   dataType ...     base.DataType, .FormatString, .EngUnit, .EngLow, .EngHigh, .CanWrite, .ReadOnly,
 *                    .Documentation, .Tooltip, .HistoryEnabled, .HistoryProvider, .TagType
 *   alarmActive      base/Alarms.HighestActivePriority     (Integer 0..4 or null)
 *   alarmUnacked     base/Alarms.HighestUnackedPriority
 *   alarmLowSp       base/Alarms/&lt;lowAlarmName&gt;.SetpointA
 *   alarmHighSp      base/Alarms/&lt;highAlarmName&gt;.SetpointA
 * </pre>
 * {@code .CanWrite} has no {@code WellKnownTagProps} constant but is a readable runtime property (verified on
 * 8.3.10: {@code true} for a memory tag, {@code false} for a read-only one); all property paths are therefore built
 * from text and parsed by {@code TagPathParser}, exactly as a user would type them.
 *
 * <h2>Alarm summary without two extra subscriptions</h2>
 * {@code hasActive} = {@code alarmActive != null}, {@code hasUnacked} = {@code alarmUnacked != null}: the two
 * priority properties carry all four alarm facts (active, unacknowledged, and the highest priority of each), so the
 * display needs 2 alarm subscriptions instead of 4 (a typical display holds 1–5 subscriptions).
 */
public final class TagMetaReader {

    public static final String VALUE = "value";
    public static final String DATA_TYPE = "dataType";
    public static final String FORMAT_STRING = "formatString";
    public static final String ENG_UNIT = "engUnit";
    public static final String ENG_LOW = "engLow";
    public static final String ENG_HIGH = "engHigh";
    public static final String CAN_WRITE = "canWrite";
    public static final String READ_ONLY = "readOnly";
    public static final String DOCUMENTATION = "documentation";
    public static final String TOOLTIP = "tooltip";
    public static final String HISTORY_ENABLED = "historyEnabled";
    public static final String HISTORY_PROVIDER = "historyProvider";
    public static final String TAG_TYPE = "tagType";
    public static final String ALARM_ACTIVE = "alarmActive";
    public static final String ALARM_UNACKED = "alarmUnacked";
    public static final String ALARM_LOW_SP = "alarmLowSp";
    public static final String ALARM_HIGH_SP = "alarmHighSp";

    /** Meta key → tag property name. */
    private static final Map<String, String> PROPS;

    static {
        Map<String, String> m = new LinkedHashMap<>();
        m.put(DATA_TYPE, "DataType");
        m.put(FORMAT_STRING, "FormatString");
        m.put(ENG_UNIT, "EngUnit");
        m.put(ENG_LOW, "EngLow");
        m.put(ENG_HIGH, "EngHigh");
        m.put(CAN_WRITE, "CanWrite");
        m.put(READ_ONLY, "ReadOnly");
        m.put(DOCUMENTATION, "Documentation");
        m.put(TOOLTIP, "Tooltip");
        m.put(HISTORY_ENABLED, "HistoryEnabled");
        m.put(HISTORY_PROVIDER, "HistoryProvider");
        m.put(TAG_TYPE, "TagType");
        PROPS = Collections.unmodifiableMap(m);
    }

    /** Alarm names allowed in derived paths (tag-name charset): no path injection through bound props. */
    private static final Pattern ALARM_NAME = Pattern.compile("[\\p{L}\\d _()'\\-:]{1,255}");

    private TagMetaReader() {
    }

    /** All meta property keys (without {@link #VALUE} and the alarm keys), in read order. */
    public static List<String> metaKeys() {
        return new ArrayList<>(PROPS.keySet());
    }

    /** True when {@code name} may be used as an alarm name in a derived path. */
    public static boolean validAlarmName(String name) {
        return name != null && ALARM_NAME.matcher(name).matches() && !name.isBlank();
    }

    /**
     * The derived path of {@code key} below {@code base} (null when the key is unknown, the alarm name is invalid
     * or the path cannot be parsed).
     *
     * @param alarmName alarm name for {@link #ALARM_LOW_SP} / {@link #ALARM_HIGH_SP}, else ignored
     */
    public static TagPath path(TagPath base, String key, String alarmName) {
        String full = base.toStringFull();
        String text;
        switch (key) {
            case VALUE:
                return base;
            case ALARM_ACTIVE:
                text = full + "/Alarms.HighestActivePriority";
                break;
            case ALARM_UNACKED:
                text = full + "/Alarms.HighestUnackedPriority";
                break;
            case ALARM_LOW_SP:
            case ALARM_HIGH_SP:
                if (!validAlarmName(alarmName)) {
                    return null;
                }
                text = full + "/Alarms/" + alarmName.trim() + ".SetpointA";
                break;
            default:
                String prop = PROPS.get(key);
                if (prop == null) {
                    return null;
                }
                text = full + "." + prop;
        }
        try {
            return TagPathParser.parse(text);
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    /**
     * One batched read of {@code paths} (key → path) with {@code ctx} (never the empty context). The future
     * completes with key → value (a key whose path is null maps to no entry).
     */
    public static CompletableFuture<Map<String, QualifiedValue>> read(TagManager tm, Map<String, TagPath> paths,
                                                                      SecurityContext ctx) {
        List<String> keys = new ArrayList<>();
        List<TagPath> list = new ArrayList<>();
        for (Map.Entry<String, TagPath> e : paths.entrySet()) {
            if (e.getValue() != null) {
                keys.add(e.getKey());
                list.add(e.getValue());
            }
        }
        if (list.isEmpty()) {
            return CompletableFuture.completedFuture(Map.of());
        }
        return tm.readAsync(list, ctx).thenApply(values -> {
            Map<String, QualifiedValue> out = new LinkedHashMap<>();
            for (int i = 0; i < keys.size() && values != null && i < values.size(); i++) {
                out.put(keys.get(i), values.get(i));
            }
            return out;
        });
    }

    // =========================================================================================================
    // Parsed metadata
    // =========================================================================================================

    /** Immutable metadata of one tag at one moment. Fields are null when the property was not Good. */
    public static final class Meta {
        private final Map<String, QualifiedValue> raw;

        public Meta(Map<String, QualifiedValue> raw) {
            this.raw = raw == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(raw));
        }

        public static Meta empty() {
            return new Meta(Map.of());
        }

        /** The same metadata with {@code key} replaced (subscription updates). */
        public Meta with(String key, QualifiedValue qv) {
            Map<String, QualifiedValue> m = new LinkedHashMap<>(raw);
            m.put(key, qv);
            return new Meta(m);
        }

        /** Raw value of a key when its quality is Good, else null. */
        public Object good(String key) {
            QualifiedValue q = raw.get(key);
            return q != null && q.getQuality() != null && q.getQuality().isGood() ? q.getValue() : null;
        }

        public QualifiedValue raw(String key) {
            return raw.get(key);
        }

        public boolean has(String key) {
            return raw.containsKey(key);
        }

        public DataType dataType() {
            Object v = good(DATA_TYPE);
            if (v instanceof DataType) {
                return (DataType) v;
            }
            if (v != null) {
                try {
                    return DataType.valueOf(String.valueOf(v));
                } catch (IllegalArgumentException e) {
                    return null;
                }
            }
            return null;
        }

        /** {@code TagType} name ("AtomicTag", "Folder", "UdtInstance" ...) or null. */
        public String tagType() {
            Object v = good(TAG_TYPE);
            if (v instanceof TagObjectType) {
                return ((TagObjectType) v).name();
            }
            return v == null ? null : String.valueOf(v);
        }

        public boolean isAtomicTag() {
            return "AtomicTag".equals(tagType());
        }

        /** Finite EngLow / EngHigh, or NaN when not Good / not finite. */
        public double engLow() {
            return ValueCodec.toDouble(good(ENG_LOW));
        }

        public double engHigh() {
            return ValueCodec.toDouble(good(ENG_HIGH));
        }

        /** {@code .CanWrite}: TRUE / FALSE, null when unknown. */
        public Boolean canWrite() {
            Object v = good(CAN_WRITE);
            return v instanceof Boolean ? (Boolean) v : null;
        }

        public String string(String key) {
            Object v = good(key);
            return v == null ? null : String.valueOf(v);
        }

        public Boolean bool(String key) {
            Object v = good(key);
            return v instanceof Boolean ? (Boolean) v : null;
        }

        /** Highest active / unacknowledged alarm priority name, null when none (or the tag has no alarms). */
        public String alarmPriority(String key) {
            return ValueCodec.alarmPriorityName(good(key));
        }

        /**
         * True when the tag has an alarm configuration: the alarm summary properties answer Good (null value =
         * no alarm active) instead of {@code Bad_NotFound} (no alarms configured).
         */
        public boolean hasAlarms() {
            QualifiedValue q = raw.get(ALARM_ACTIVE);
            QualityCode c = q == null ? null : q.getQuality();
            return c != null && c.isGood();
        }

        /**
         * The snapshot's {@code meta} object: engUnit, engLow, engHigh, formatString, dataType,
         * canWrite, readOnly, documentation, tooltip, tagType. Unknown fields are JSON null.
         */
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            o.add("engUnit", jsonOf(good(ENG_UNIT)));
            o.add("engLow", jsonOf(good(ENG_LOW)));
            o.add("engHigh", jsonOf(good(ENG_HIGH)));
            o.add("formatString", jsonOf(good(FORMAT_STRING)));
            DataType dt = dataType();
            o.add("dataType", dt == null ? JsonNull.INSTANCE : new JsonPrimitive(dt.name()));
            o.add("canWrite", jsonOf(good(CAN_WRITE)));
            o.add("readOnly", jsonOf(good(READ_ONLY)));
            o.add("documentation", jsonOf(good(DOCUMENTATION)));
            o.add("tooltip", jsonOf(good(TOOLTIP)));
            String tt = tagType();
            o.add("tagType", tt == null ? JsonNull.INSTANCE : new JsonPrimitive(tt));
            return o;
        }

        private static JsonElement jsonOf(Object v) {
            return v == null ? JsonNull.INSTANCE : ValueCodec.plain(v);
        }
    }
}
