package com.example.simpletagdisplay.gateway.tags;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CompletableFuture;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonPrimitive;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.tags.config.BasicTagConfiguration;
import com.inductiveautomation.ignition.common.tags.config.CollisionPolicy;
import com.inductiveautomation.ignition.common.tags.config.TagConfiguration;
import com.inductiveautomation.ignition.common.tags.config.properties.WellKnownTagProps;
import com.inductiveautomation.ignition.common.tags.model.SecurityContext;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.model.TagProvider;

/**
 * Tag configuration edit of the Display Template's "Tag Configuration…" item:
 * Engineering Units, Engineering Low and High of one tag.
 *
 * The edit goes through the explicit configuration API ({@code TagProvider.saveTagConfigsAsync} with
 * {@link CollisionPolicy#MergeOverwrite} and the <b>user's</b> security context, so the provider's Edit permission
 * applies; the context-less overload is never used). A property write such as {@code writeAsync("Tag.EngUnit")} is
 * exactly what the path rules forbid on the write path. {@code MergeOverwrite} with an edit configuration that only
 * carries the changed properties leaves every other property (alarms, history, documentation …) untouched.
 */
public final class TagConfigEditor {

    /** Longest Engineering Units text accepted. */
    public static final int MAX_UNIT_CHARS = 64;

    private TagConfigEditor() {
    }

    /** Validated {@code changes} of a {@code dt.configEdit}: null fields are not changed. Immutable. */
    public static final class Changes {
        private final String engUnit;
        private final Double engLow;
        private final Double engHigh;

        Changes(String engUnit, Double engLow, Double engHigh) {
            this.engUnit = engUnit;
            this.engLow = engLow;
            this.engHigh = engHigh;
        }

        public String engUnit() {
            return engUnit;
        }

        public Double engLow() {
            return engLow;
        }

        public Double engHigh() {
            return engHigh;
        }

        /** {@code {engUnit?, engLow?, engHigh?}} of the changed fields only. */
        public JsonObject toJson() {
            JsonObject o = new JsonObject();
            if (engUnit != null) {
                o.addProperty("engUnit", engUnit);
            }
            if (engLow != null) {
                o.addProperty("engLow", engLow);
            }
            if (engHigh != null) {
                o.addProperty("engHigh", engHigh);
            }
            return o;
        }
    }

    /** A parse outcome: changes or an error code. */
    public static final class Parsed {
        private final Changes changes;
        private final ErrorCode error;

        Parsed(Changes changes, ErrorCode error) {
            this.changes = changes;
            this.error = error;
        }

        public boolean ok() {
            return changes != null;
        }

        public Changes changes() {
            return changes;
        }

        public ErrorCode error() {
            return error;
        }
    }

    /**
     * Validates {@code changes}: an object with only {@code engUnit} (string ≤
     * {@value #MAX_UNIT_CHARS} chars, no control characters), {@code engLow}, {@code engHigh} (finite numbers), at
     * least one of them. A malformed body is {@code BAD_REQUEST}; a bad value {@code INVALID_VALUE}.
     */
    public static Parsed parse(JsonElement changes) {
        if (changes == null || !changes.isJsonObject()) {
            return new Parsed(null, ErrorCode.BAD_REQUEST);
        }
        JsonObject o = changes.getAsJsonObject();
        if (o.size() == 0) {
            return new Parsed(null, ErrorCode.INVALID_VALUE);
        }
        String unit = null;
        Double low = null;
        Double high = null;
        for (Map.Entry<String, JsonElement> e : o.entrySet()) {
            JsonElement v = e.getValue();
            switch (e.getKey()) {
                case "engUnit":
                    if (v == null || !v.isJsonPrimitive() || !v.getAsJsonPrimitive().isString()) {
                        return new Parsed(null, ErrorCode.INVALID_VALUE);
                    }
                    unit = v.getAsString();
                    if (unit.length() > MAX_UNIT_CHARS || unit.chars().anyMatch(Character::isISOControl)) {
                        return new Parsed(null, ErrorCode.INVALID_VALUE);
                    }
                    break;
                case "engLow":
                case "engHigh":
                    if (v == null || !v.isJsonPrimitive() || !v.getAsJsonPrimitive().isNumber()) {
                        return new Parsed(null, ErrorCode.INVALID_VALUE);
                    }
                    double d;
                    try {
                        d = Double.parseDouble(v.getAsString());
                    } catch (NumberFormatException ex) {
                        return new Parsed(null, ErrorCode.INVALID_VALUE);
                    }
                    if (!Double.isFinite(d)) {
                        return new Parsed(null, ErrorCode.INVALID_VALUE);
                    }
                    if ("engLow".equals(e.getKey())) {
                        low = d;
                    } else {
                        high = d;
                    }
                    break;
                default:
                    return new Parsed(null, ErrorCode.BAD_REQUEST);
            }
        }
        return new Parsed(new Changes(unit, low, high), null);
    }

    /**
     * The resulting limits must satisfy {@code low < high} (current values fill the fields that are not changed;
     * a side unknown before and not changed is not checked). Null = valid, else {@code INVALID_VALUE}.
     */
    public static ErrorCode checkRange(Changes c, double currentLow, double currentHigh) {
        double low = c.engLow() != null ? c.engLow() : currentLow;
        double high = c.engHigh() != null ? c.engHigh() : currentHigh;
        if (Double.isFinite(low) && Double.isFinite(high) && !(low < high)) {
            return ErrorCode.INVALID_VALUE;
        }
        return null;
    }

    /** Saves the changes with {@code MergeOverwrite} and the user's context. */
    public static CompletableFuture<List<QualityCode>> save(TagProvider provider, TagPath path, Changes c,
                                                             SecurityContext ctx) {
        TagConfiguration edit = BasicTagConfiguration.createEdit(path);
        if (c.engUnit() != null) {
            edit.set(WellKnownTagProps.EngUnit, c.engUnit());
        }
        if (c.engLow() != null) {
            edit.set(WellKnownTagProps.EngLow, c.engLow());
        }
        if (c.engHigh() != null) {
            edit.set(WellKnownTagProps.EngHigh, c.engHigh());
        }
        return provider.saveTagConfigsAsync(List.of(edit), CollisionPolicy.MergeOverwrite, ctx);
    }

    /**
     * Error code of a save result: Good → null; provider edit permission denied
     * ({@code Bad_AccessDenied}/{@code Bad_Unauthorized}, or a quality whose name or diagnostic says "denied") →
     * {@code EDIT_DENIED}; not found → {@code TAG_NOT_FOUND}; anything else → {@code WRITE_FAILED}.
     */
    public static ErrorCode mapResult(QualityCode q) {
        if (q == null) {
            return ErrorCode.WRITE_FAILED;
        }
        if (q.isGood()) {
            return null;
        }
        if (TagPaths.isNotFound(q)) {
            return ErrorCode.TAG_NOT_FOUND;
        }
        if (TagPaths.isAccessDenied(q) || mentionsDenied(q)) {
            return ErrorCode.EDIT_DENIED;
        }
        return ErrorCode.WRITE_FAILED;
    }

    static boolean mentionsDenied(QualityCode q) {
        String n = (q.getName() + " " + q.getDiagnosticMessage()).toLowerCase(Locale.ROOT);
        return n.contains("denied") || n.contains("unauthorized") || n.contains("permission");
    }

    /**
     * Audit value of an edit: {@code EngUnit: 'degF' -> 'degC'; EngHigh: 100.0 -> 150.0}
     * (only changed fields, in the order unit, low, high).
     */
    public static String describe(Changes c, String prevUnit, Double prevLow, Double prevHigh) {
        StringBuilder b = new StringBuilder();
        if (c.engUnit() != null) {
            b.append("EngUnit: '").append(prevUnit == null ? "" : prevUnit).append("' -> '").append(c.engUnit()).append('\'');
        }
        if (c.engLow() != null) {
            sep(b).append("EngLow: ").append(prevLow).append(" -> ").append(c.engLow());
        }
        if (c.engHigh() != null) {
            sep(b).append("EngHigh: ").append(prevHigh).append(" -> ").append(c.engHigh());
        }
        return b.toString();
    }

    private static StringBuilder sep(StringBuilder b) {
        return b.length() == 0 ? b : b.append("; ");
    }

    /** JSON number or null. */
    public static JsonElement num(Double d) {
        return d == null || !Double.isFinite(d) ? JsonNull.INSTANCE : new JsonPrimitive(d);
    }
}
