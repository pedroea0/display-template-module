package com.example.simpletagdisplay.gateway.ops;

import java.util.List;
import java.util.Optional;
import java.util.OptionalDouble;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.delegate.PropsSnapshot;
import com.example.simpletagdisplay.gateway.security.AccessRule;
import com.example.simpletagdisplay.gateway.security.FloorPolicy;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.example.simpletagdisplay.gateway.tags.TagMetaReader;
import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.example.simpletagdisplay.gateway.tags.ValueCodec;
import com.example.simpletagdisplay.gateway.tags.WriteCoercer;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonPrimitive;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.tags.model.TagPath;

/**
 * Every gate of the Display Template's gateway actions, as pure functions. The same functions compute the advisory
 * {@code capabilities} of the snapshot and decide the real actions, so the UI greys exactly what the gateway would
 * refuse (the capabilities include the floor-policy results).
 *
 * <h2>Order</h2>
 * enabled flags → binding lint → path rules (+ stale target, checked by the caller) → floor policy → component
 * access rule → Designer mutability → audit requirement → (after the fresh read) tag facts → value checks.
 * Every gate reads security keys from the <b>trusted</b> {@link PropsSnapshot} only.
 */
public final class DisplayGates {

    private DisplayGates() {
    }

    /**
     * Schema defaults of {@code <action>.access.requireLogin} (displaytemplate.props.json). A setpoint does not need a
     * login by default, like a native Perspective write; the tag's write permissions still apply. Tag configuration edit
     * and change history default to {@code true}: they change a tag for every screen / show who changed what, which is
     * more sensitive than a write, and config edit is off by default anyway. See
     * docs/user-guide/security-and-permissions.md.
     */
    public static final boolean SETPOINT_REQUIRE_LOGIN_DEFAULT = false;
    public static final boolean CONFIG_EDIT_REQUIRE_LOGIN_DEFAULT = true;
    public static final boolean CHANGE_HISTORY_REQUIRE_LOGIN_DEFAULT = true;

    /** Outcome of a static gate: a target path or an error. Immutable. */
    public static final class Target {
        private final TagPath path;
        private final ErrorCode error;
        private final String setting;

        Target(TagPath path, ErrorCode error) {
            this(path, error, null);
        }

        private Target(TagPath path, ErrorCode error, String setting) {
            this.path = path;
            this.error = error;
            this.setting = setting;
        }

        public boolean ok() {
            return error == null;
        }

        public TagPath path() {
            return path;
        }

        public ErrorCode error() {
            return error;
        }

        /**
         * The gateway setting that refused an action the component's own access rule allows for this user, e.g.
         * {@code ctg.write.requireAuthenticated}; null otherwise.
         */
        public String setting() {
            return setting;
        }

        /** Reply / capability details for the refusal: {@code {setting}} when a gateway setting refused, else null. */
        public JsonObject details() {
            if (setting == null) {
                return null;
            }
            JsonObject d = new JsonObject();
            d.addProperty("setting", setting);
            return d;
        }

        static Target fail(ErrorCode c) {
            return new Target(null, c);
        }

        static Target fail(ErrorCode c, String setting) {
            return new Target(null, c, setting);
        }
    }

    /**
     * A floor refusal as a Target. The setting is named only when the component itself would let this user act: then
     * the gateway setting is what blocks, and the UI says so ("Writes need a login on this gateway (gateway setting
     * ...)") instead of a generic "Log in". The code (and the evaluation order) is unchanged.
     */
    private static Target floorFail(FloorPolicy.Block b, AccessRule component, UserContext u) {
        return Target.fail(b.code(), component.evaluate(u).isEmpty() ? b.setting() : null);
    }

    /**
     * Designer hint: gateway settings that make the setpoint's own {@code setpoint.access} stricter for its
     * tag, whoever the user is. Empty when writing is off.
     */
    public static List<String> writeOverrides(PropsSnapshot p, FloorPolicy floor, String defaultProvider) {
        if (!p.gateFlag("enabled", true) || !p.gateFlag("setpoint.enabled", false)) {
            return List.of();
        }
        TagPaths.Parsed parsed = TagPaths.parseForWrite(p.string("tagPath", ""), defaultProvider);
        return floor.overrides(p.access("setpoint", SETPOINT_REQUIRE_LOGIN_DEFAULT), parsed.ok() ? parsed.path() : null,
            false);
    }

    /** Designer hint for the Tag Configuration menu item (see {@link #writeOverrides}). */
    public static List<String> configEditOverrides(PropsSnapshot p, FloorPolicy floor, String defaultProvider) {
        if (!p.gateFlag("enabled", true) || !p.gateFlag("menu.enabled", true)
                || !p.gateFlag("menu.configEdit.enabled", false)) {
            return List.of();
        }
        TagPaths.Parsed parsed = TagPaths.parseForWrite(p.string("tagPath", ""), defaultProvider);
        return floor.overrides(p.access("menu.configEdit", CONFIG_EDIT_REQUIRE_LOGIN_DEFAULT),
            parsed.ok() ? parsed.path() : null, true);
    }

    // =========================================================================================================
    // Static gates (no tag I/O)
    // =========================================================================================================

    /**
     * Setpoint write, before the fresh read: DISABLED, WRITE_DISABLED, BOUND_BIDIRECTIONAL,
     * NO_TAG_PATH / INVALID_PATH (write path rules: no {@code _types_}, no array element), floor policy
     * (AUTH_REQUIRED / FORBIDDEN_ROLE / INVALID_PATH / OUT_OF_SCOPE), {@code setpoint.access}, DESIGNER_READ_ONLY,
     * AUDIT_UNAVAILABLE ({@code ctg.audit.required} without a profile, or with an audit writer that cannot take the
     * records now — {@code CtgAudit.refuses}).
     */
    public static Target write(PropsSnapshot p, UserContext u, FloorPolicy floor, String defaultProvider,
                               boolean auditMissingAndRequired) {
        if (!p.gateFlag("enabled", true)) {
            return Target.fail(ErrorCode.DISABLED);
        }
        if (!p.gateFlag("setpoint.enabled", false)) {
            return Target.fail(ErrorCode.WRITE_DISABLED);
        }
        Optional<ErrorCode> lint = p.lintGate("enabled", "setpoint");
        if (lint.isPresent()) {
            return Target.fail(lint.get());
        }
        TagPaths.Parsed parsed = TagPaths.parseForWrite(p.string("tagPath", ""), defaultProvider);
        if (!parsed.ok()) {
            return Target.fail(parsed.error());
        }
        AccessRule rule = p.access("setpoint", SETPOINT_REQUIRE_LOGIN_DEFAULT);
        Optional<FloorPolicy.Block> f = floor.writeBlock(u, parsed.path());
        if (f.isPresent()) {
            return floorFail(f.get(), rule, u);
        }
        Optional<ErrorCode> a = rule.evaluate(u);
        if (a.isPresent()) {
            return Target.fail(a.get());
        }
        if (!u.designerWritable()) {
            return Target.fail(ErrorCode.DESIGNER_READ_ONLY);
        }
        if (auditMissingAndRequired) {
            return Target.fail(ErrorCode.AUDIT_UNAVAILABLE);
        }
        return new Target(parsed.path(), null);
    }

    /**
     * Tag configuration edit, before the fresh read: DISABLED,
     * ACTION_DISABLED (menu / configEdit off), BOUND_BIDIRECTIONAL, write path rules, floor
     * {@code checkConfigEdit}, {@code menu.configEdit.access}, DESIGNER_READ_ONLY, AUDIT_UNAVAILABLE.
     */
    public static Target configEdit(PropsSnapshot p, UserContext u, FloorPolicy floor, String defaultProvider,
                                    boolean auditMissingAndRequired) {
        if (!p.gateFlag("enabled", true)) {
            return Target.fail(ErrorCode.DISABLED);
        }
        if (!p.gateFlag("menu.enabled", true) || !p.gateFlag("menu.configEdit.enabled", false)) {
            return Target.fail(ErrorCode.ACTION_DISABLED);
        }
        Optional<ErrorCode> lint = p.lintGate("enabled", "menu.enabled", "menu.configEdit");
        if (lint.isPresent()) {
            return Target.fail(lint.get());
        }
        TagPaths.Parsed parsed = TagPaths.parseForWrite(p.string("tagPath", ""), defaultProvider);
        if (!parsed.ok()) {
            return Target.fail(parsed.error());
        }
        AccessRule rule = p.access("menu.configEdit", CONFIG_EDIT_REQUIRE_LOGIN_DEFAULT);
        Optional<FloorPolicy.Block> f = floor.configEditBlock(u, parsed.path());
        if (f.isPresent()) {
            return floorFail(f.get(), rule, u);
        }
        Optional<ErrorCode> a = rule.evaluate(u);
        if (a.isPresent()) {
            return Target.fail(a.get());
        }
        if (!u.designerWritable()) {
            return Target.fail(ErrorCode.DESIGNER_READ_ONLY);
        }
        if (auditMissingAndRequired) {
            return Target.fail(ErrorCode.AUDIT_UNAVAILABLE);
        }
        return new Target(parsed.path(), null);
    }

    /**
     * Trend add / remove: DISABLED, ACTION_DISABLED, BOUND_BIDIRECTIONAL, read path rules,
     * {@code menu.trend.access}. No Designer mutability check (the trend list is session state, not a tag write)
     * and no floor policy (not a write).
     */
    public static Target trend(PropsSnapshot p, UserContext u, String defaultProvider) {
        if (!p.gateFlag("enabled", true)) {
            return Target.fail(ErrorCode.DISABLED);
        }
        if (!p.gateFlag("menu.enabled", true) || !p.gateFlag("menu.trend.enabled", true)) {
            return Target.fail(ErrorCode.ACTION_DISABLED);
        }
        Optional<ErrorCode> lint = p.lintGate("enabled", "menu.enabled", "menu.trend");
        if (lint.isPresent()) {
            return Target.fail(lint.get());
        }
        TagPaths.Parsed parsed = TagPaths.parse(p.string("tagPath", ""), defaultProvider);
        if (!parsed.ok()) {
            return Target.fail(parsed.error());
        }
        Optional<ErrorCode> a = p.access("menu.trend", false).evaluate(u);
        return a.map(Target::fail).orElseGet(() -> new Target(parsed.path(), null));
    }

    /**
     * Change history: DISABLED, ACTION_DISABLED, BOUND_BIDIRECTIONAL, read path rules,
     * {@code menu.changeHistory.access}, AUDIT_UNAVAILABLE (no profile).
     */
    public static Target changeHistory(PropsSnapshot p, UserContext u, String defaultProvider, boolean hasProfile) {
        if (!p.gateFlag("enabled", true)) {
            return Target.fail(ErrorCode.DISABLED);
        }
        if (!p.gateFlag("menu.enabled", true) || !p.gateFlag("menu.changeHistory.enabled", false)) {
            return Target.fail(ErrorCode.ACTION_DISABLED);
        }
        Optional<ErrorCode> lint = p.lintGate("enabled", "menu.enabled", "menu.changeHistory");
        if (lint.isPresent()) {
            return Target.fail(lint.get());
        }
        TagPaths.Parsed parsed = TagPaths.parse(p.string("tagPath", ""), defaultProvider);
        if (!parsed.ok()) {
            return Target.fail(parsed.error());
        }
        Optional<ErrorCode> a = p.access("menu.changeHistory", CHANGE_HISTORY_REQUIRE_LOGIN_DEFAULT).evaluate(u);
        if (a.isPresent()) {
            return Target.fail(a.get());
        }
        return hasProfile ? new Target(parsed.path(), null) : Target.fail(ErrorCode.AUDIT_UNAVAILABLE);
    }

    /** {@code STALE_TARGET} unless {@code expected} names the same tag as {@code current} (case-insensitive). */
    public static boolean sameTarget(String expected, TagPath current, String defaultProvider) {
        if (expected == null || current == null) {
            return false;
        }
        TagPaths.Parsed e = TagPaths.parse(expected, defaultProvider);
        return e.ok() && TagPaths.normalizedKey(e.path()).equals(TagPaths.normalizedKey(current));
    }

    // =========================================================================================================
    // Tag facts (after the fresh read, or from the snapshot's meta for capabilities)
    // =========================================================================================================

    /**
     * Facts of the target tag: TAG_NOT_FOUND, ACCESS_DENIED, INVALID_PATH (not an AtomicTag:
     * folder, UDT instance, alarm node), READ_ONLY ({@code .ReadOnly} true; {@code .CanWrite} false only counts when
     * {@code .ReadOnly} is unknown), UNSUPPORTED_TYPE (not writable from a
     * setpoint), BAD_QUALITY ({@code !allowOnBadQuality} and the value is Bad/Error).
     *
     * @param value  the tag value (base path) as read
     * @param meta   meta incl. DataType, CanWrite, TagType
     * @param checkQuality false for config edits (bad quality does not block an edit)
     */
    public static ErrorCode tagFacts(QualifiedValue value, TagMetaReader.Meta meta, boolean allowOnBadQuality,
                                     boolean checkWritable, boolean checkQuality) {
        QualityCode q = value == null ? null : value.getQuality();
        if (TagPaths.isNotFound(q)) {
            return ErrorCode.TAG_NOT_FOUND;
        }
        if (TagPaths.isAccessDenied(q)) {
            return ErrorCode.ACCESS_DENIED;
        }
        if (!meta.isAtomicTag()) {
            return meta.tagType() == null ? ErrorCode.TAG_NOT_FOUND : ErrorCode.INVALID_PATH;
        }
        if (checkWritable) {
            // .CanWrite is evaluated for the CALLING user: false means read-only OR "this user lacks the tag's Write
            // Permissions". Only a read-only tag stops here (.ReadOnly); a permission denial is left to the provider,
            // which enforces the tag's Write Permissions, so it is audited (BAD), fires onSetpointWrite(success=false)
            // and answers WRITE_DENIED.
            Boolean readOnly = meta.bool(TagMetaReader.READ_ONLY);
            if (Boolean.TRUE.equals(readOnly) || (readOnly == null && Boolean.FALSE.equals(meta.canWrite()))) {
                return ErrorCode.READ_ONLY;
            }
            if (!WriteCoercer.isWritableType(meta.dataType())) {
                return ErrorCode.UNSUPPORTED_TYPE;
            }
        }
        if (checkQuality && !allowOnBadQuality && q != null && q.isBadOrError()) {
            return ErrorCode.BAD_QUALITY;
        }
        return null;
    }

    // =========================================================================================================
    // Limits and step guard
    // =========================================================================================================

    /** Effective write limits. Immutable. Either {@link #error} or the sides (NaN = open side). */
    public static final class Limits {
        private final double low;
        private final double high;
        private final boolean inclusive;
        private final String source;
        private final ErrorCode error;
        private final boolean applies;

        Limits(double low, double high, boolean inclusive, String source, ErrorCode error, boolean applies) {
            this.low = low;
            this.high = high;
            this.inclusive = inclusive;
            this.source = source;
            this.error = error;
            this.applies = applies;
        }

        static Limits none() {
            return new Limits(Double.NaN, Double.NaN, true, "none", null, false);
        }

        static Limits fail(ErrorCode c) {
            return new Limits(Double.NaN, Double.NaN, true, "none", c, true);
        }

        public double low() {
            return low;
        }

        public double high() {
            return high;
        }

        public boolean inclusive() {
            return inclusive;
        }

        /** {@code LIMITS_INVALID} / {@code LIMITS_UNAVAILABLE}, or null. */
        public ErrorCode error() {
            return error;
        }

        /** False for non-numeric types and options-only setpoints (limits not applicable). */
        public boolean applies() {
            return applies;
        }

        /** True when {@code v} lies inside (open sides always pass). */
        public boolean contains(double v) {
            boolean lowOk = Double.isNaN(low) || (inclusive ? v >= low : v > low);
            boolean highOk = Double.isNaN(high) || (inclusive ? v <= high : v < high);
            return lowOk && highOk;
        }

        /** {@code {low, high}} for an {@code OUT_OF_RANGE} reply (null = open side). */
        public JsonObject details() {
            JsonObject d = new JsonObject();
            d.add("low", num(low));
            d.add("high", num(high));
            return d;
        }

        /**
         * The snapshot's {@code writeLimits}: {@code {low, high, inclusive, source}} ({@code source} = eng | props |
         * mixed | none), or JSON null when limits do not apply (options / non-numeric) or are
         * misconfigured/unavailable (then the capability carries the reason).
         */
        public JsonElement toJson() {
            if (!applies || error != null) {
                return JsonNull.INSTANCE;
            }
            JsonObject o = new JsonObject();
            o.add("low", num(low));
            o.add("high", num(high));
            o.addProperty("inclusive", inclusive);
            o.addProperty("source", source);
            return o;
        }
    }

    /**
     * Effective limits of a numeric setpoint:
     * <pre>
     *   explicit setpoint.limits.low/high present but not a finite number      → LIMITS_INVALID
     *   side without an explicit value and useEngLimits: EngLow/EngHigh not Good
     *     or not finite                                                        → LIMITS_UNAVAILABLE
     *   effective low > high                                                   → LIMITS_INVALID
     * </pre>
     * Options-only setpoints and non-numeric types → {@link Limits#applies()} false.
     */
    public static Limits limits(PropsSnapshot p, DataType type, TagMetaReader.Meta meta) {
        if (!WriteCoercer.isNumeric(type) || hasOptions(p)) {
            return Limits.none();
        }
        // Security ([S]) leaves fall back to the STRICTER value when present but not a Boolean:
        // useEngLimits → true (bounded by the tag's limits), inclusive → false (gateFlag: limits exclusive).
        boolean useEng = p.bool("setpoint.limits.useEngLimits", true);
        boolean inclusive = p.gateFlag("setpoint.limits.inclusive", true);
        double low;
        double high;
        boolean lowFromProps = p.json("setpoint.limits.low").isPresent();
        boolean highFromProps = p.json("setpoint.limits.high").isPresent();
        // A BOUND limit whose binding delivers null (tag missing / renamed / provider down; a bad
        // quality is mapped to null when the leaf is read) is "configured but unavailable", not "not configured":
        // it must not open that side of the range (fail closed, as the docs promise).
        if (brokenBinding(p, "setpoint.limits.low") || brokenBinding(p, "setpoint.limits.high")) {
            return Limits.fail(ErrorCode.LIMITS_UNAVAILABLE);
        }
        if (lowFromProps) {
            OptionalDouble d = p.number("setpoint.limits.low");
            if (d.isEmpty()) {
                return Limits.fail(ErrorCode.LIMITS_INVALID);
            }
            low = d.getAsDouble();
        } else if (useEng) {
            low = engSide(meta, TagMetaReader.ENG_LOW);
            if (Double.isNaN(low)) {
                return Limits.fail(ErrorCode.LIMITS_UNAVAILABLE);
            }
        } else {
            low = Double.NaN;
        }
        if (highFromProps) {
            OptionalDouble d = p.number("setpoint.limits.high");
            if (d.isEmpty()) {
                return Limits.fail(ErrorCode.LIMITS_INVALID);
            }
            high = d.getAsDouble();
        } else if (useEng) {
            high = engSide(meta, TagMetaReader.ENG_HIGH);
            if (Double.isNaN(high)) {
                return Limits.fail(ErrorCode.LIMITS_UNAVAILABLE);
            }
        } else {
            high = Double.NaN;
        }
        if (!Double.isNaN(low) && !Double.isNaN(high) && low > high) {
            return Limits.fail(ErrorCode.LIMITS_INVALID);
        }
        String source;
        boolean anyProps = lowFromProps || highFromProps;
        boolean anyEng = useEng && (!lowFromProps || !highFromProps);
        if (Double.isNaN(low) && Double.isNaN(high)) {
            source = "none";
        } else if (anyProps && anyEng) {
            source = "mixed";
        } else {
            source = anyProps ? "props" : "eng";
        }
        return new Limits(low, high, inclusive, source, null, true);
    }

    /**
     * True when a numeric guard leaf ({@code setpoint.limits.low/high}, {@code setpoint.maxStep},
     * {@code setpoint.maxStepPercent}) is bound (the leaf itself or an ancestor object; {@link
     * com.example.simpletagdisplay.gateway.security.BindingLint.LintReport#covers}) and its trusted value is present but
     * JSON null. The delegate reads a guard leaf whose quality is not Good as null, so a binding to a missing,
     * renamed or faulted tag lands here. An unbound null is the schema default ("not configured").
     */
    static boolean brokenBinding(PropsSnapshot p, String leaf) {
        return p.isPresent(leaf) && p.json(leaf).isEmpty() && !p.shadowed(leaf) && p.lint().covers(leaf);
    }

    private static double engSide(TagMetaReader.Meta meta, String key) {
        double d = ValueCodec.toDouble(meta.good(key));
        return Double.isFinite(d) ? d : Double.NaN;
    }

    /**
     * True when {@code setpoint.options} has at least one entry, or is present but malformed (null, not an array, or
     * an ancestor that is not an object): a broken options binding must not turn an options-only setpoint into free
     * entry, so it stays in options mode with nothing selectable.
     */
    public static boolean hasOptions(PropsSnapshot p) {
        if (optionsMalformed(p)) {
            return true;
        }
        Optional<JsonElement> o = p.json("setpoint.options");
        return o.isPresent() && o.get().isJsonArray() && o.get().getAsJsonArray().size() > 0;
    }

    /** {@code setpoint.options} present but not an array (null included; the schema type is array, default []). */
    private static boolean optionsMalformed(PropsSnapshot p) {
        if (!p.isPresent("setpoint.options")) {
            return false;
        }
        Optional<JsonElement> o = p.json("setpoint.options");
        return o.isEmpty() || !o.get().isJsonArray();
    }

    /**
     * Options check: the coerced value must equal an option (each option value coerced the same way)
     * that is not disabled. True when allowed or when no options are configured; false for every value when the
     * options are malformed. An option is selectable only when {@code isDisabled} is absent or the Boolean
     * {@code false}: any other value ({@code true}, {@code "true"}, {@code "false"}, 0, null ...) disables it — a
     * string or number from a binding must not re-enable an option (fail closed, like the gate flags).
     */
    public static boolean isAllowedOption(PropsSnapshot p, Object coerced, DataType type, int maxStringLength) {
        if (optionsMalformed(p)) {
            return false;
        }
        Optional<JsonElement> o = p.json("setpoint.options");
        if (o.isEmpty() || !o.get().isJsonArray() || o.get().getAsJsonArray().size() == 0) {
            return true;
        }
        for (JsonElement item : o.get().getAsJsonArray()) {
            if (item == null || !item.isJsonObject()) {
                continue;
            }
            JsonObject opt = item.getAsJsonObject();
            if (optionDisabled(opt)) {
                continue;
            }
            WriteCoercer.Result r = WriteCoercer.coerce(opt.get("value"), type, maxStringLength);
            if (r.ok() && WriteCoercer.sameValue(r.value(), coerced)) {
                return true;
            }
        }
        return false;
    }

    /** True unless {@code isDisabled} is absent or exactly the Boolean {@code false}. */
    public static boolean optionDisabled(JsonObject option) {
        if (!option.has("isDisabled")) {
            return false;
        }
        JsonElement d = option.get("isDisabled");
        boolean isFalse = d != null && d.isJsonPrimitive() && d.getAsJsonPrimitive().isBoolean() && !d.getAsBoolean();
        return !isFalse;
    }

    /**
     * Step guard: null when allowed, else {@code {max, delta}} details for
     * {@code STEP_TOO_LARGE}. A negative {@code maxStep}/{@code maxStepPercent} is a misconfiguration
     * ({@code LIMITS_INVALID} is returned through {@link #stepConfigError}).
     * <p>
     * Fail closed: when a step guard applies and the current value is not finite (null tag,
     * NaN, a non-numeric value written under {@code allowOnBadQuality}), no step can be measured, so the write is
     * refused {@code STEP_TOO_LARGE} with {@code {max, delta:null, previous:"notFinite"}} instead of letting any
     * in-limits value through in one step. Without a configured guard nothing changes.
     */
    public static JsonObject stepViolation(PropsSnapshot p, double previous, double next, Limits limits) {
        double max = stepMax(p, limits);
        if (max == Double.POSITIVE_INFINITY) {
            return null;   // no guard applies
        }
        if (!Double.isFinite(previous) || !Double.isFinite(next)) {
            JsonObject d = new JsonObject();
            d.add("max", num(max));
            d.add("delta", JsonNull.INSTANCE);
            d.addProperty("previous", "notFinite");
            return d;
        }
        double delta = Math.abs(next - previous);
        if (delta > max) {
            JsonObject d = new JsonObject();
            d.add("max", num(max));
            d.add("delta", num(delta));
            return d;
        }
        return null;
    }

    /** Largest allowed step ({@code +Infinity} when no guard applies). */
    private static double stepMax(PropsSnapshot p, Limits limits) {
        OptionalDouble maxStep = p.number("setpoint.maxStep");
        double max = Double.POSITIVE_INFINITY;
        if (maxStep.isPresent() && maxStep.getAsDouble() >= 0) {
            max = maxStep.getAsDouble();
        }
        OptionalDouble pct = p.number("setpoint.maxStepPercent");
        if (pct.isPresent() && pct.getAsDouble() >= 0 && limits != null && limits.applies() && limits.error() == null
                && !Double.isNaN(limits.low()) && !Double.isNaN(limits.high())) {
            max = Math.min(max, pct.getAsDouble() / 100.0 * (limits.high() - limits.low()));
        }
        return max;
    }

    /**
     * {@code LIMITS_INVALID} when {@code maxStep} / {@code maxStepPercent} is present but not a number ≥ 0;
     * {@code LIMITS_UNAVAILABLE} when one is bound and its binding delivers null or a bad quality (a
     * broken binding must not switch the step guard off).
     */
    public static ErrorCode stepConfigError(PropsSnapshot p) {
        for (String k : new String[] {"setpoint.maxStep", "setpoint.maxStepPercent"}) {
            if (brokenBinding(p, k)) {
                return ErrorCode.LIMITS_UNAVAILABLE;
            }
            if (p.json(k).isPresent()) {
                OptionalDouble d = p.number(k);
                if (d.isEmpty() || d.getAsDouble() < 0) {
                    return ErrorCode.LIMITS_INVALID;
                }
            }
        }
        return null;
    }

    static JsonElement num(double d) {
        return Double.isFinite(d) ? new JsonPrimitive(d) : JsonNull.INSTANCE;
    }
}
