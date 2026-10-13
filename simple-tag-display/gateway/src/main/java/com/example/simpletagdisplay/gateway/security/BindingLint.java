package com.example.simpletagdisplay.gateway.security;

import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.perspective.common.config.BindingConfig;
import com.inductiveautomation.perspective.common.config.PropertyConfig;

/**
 * Binding lint for security keys.
 *
 * <h2>Why</h2>
 * {@link TrustedProps} reverts values the browser writes into a security key directly ({@code Origin.Browser}).
 * It cannot see values that reach the key <em>through a binding</em>: a bidirectional binding writes a client value
 * through to its source, and a client write to {@code view.params} / {@code view.custom} reaches a one-way-bound
 * gate key with {@code Origin.Binding}. So the lint inspects how each
 * security key is configured and decides, once per view start, whether its gate can be trusted.
 *
 * <h2>Classification of a binding (pure, {@link #classify})</h2>
 * <ul>
 *   <li><b>bidirectional</b>: {@code config.bidirectional == true} (property and tag bindings).</li>
 *   <li><b>user-controlled</b> (every property binding and every property-referencing expression):
 *     <ul>
 *       <li>a {@code property} binding, whatever its path ({@code view.params.*}, {@code view.custom.*},
 *           {@code this.*}, {@code parent.*}, {@code ../Sibling.props.*}, {@code /root/...}, {@code page.*},
 *           {@code session.custom.*} ...);</li>
 *       <li>any other binding whose <em>evaluated</em> text contains a property reference {@code {x.y}}: the
 *           expression of an {@code expr} binding, the expressions of {@code expr-struct} and of query
 *           parameters, the references of an indirect tag binding, the {@code tagPath} expression of an
 *           expression-mode tag binding, an expression transform (its input placeholder {@code {value}} excluded).
 *           Quoted string literals, tag references {@code {[provider]Path}}, indirect placeholders and brace
 *           literals in script code are not property references. Unknown binding types are scanned
 *           conservatively (every string);</li>
 *       <li>a script transform whose code uses the identifier {@code self} anywhere outside comments and string
 *           literals (it can read any client-writable prop).</li>
 *     </ul>
 *     Exception: references into session-owned read-only props, {@code session.props.auth.*} and
 *     {@code session.props.id}, which the client cannot write.</li>
 *   <li>A plain (direct) tag binding is neither; the tag's own Write Permissions protect its value.</li>
 * </ul>
 *
 * <h2>Verdicts</h2>
 * For a <em>gate key</em> (every security key except {@code tagPath} / {@code trendGroup}): bidirectional → the gate
 * fails closed ({@code BOUND_BIDIRECTIONAL}); user-controlled → fails closed when
 * {@code ctg.security.rejectBoundGates} is true (the default), otherwise only warned about. The delegate
 * logs one WARN per view and key ({@code action=security-key-bound}). {@code tagPath}/{@code trendGroup} may be
 * param-bound (faceplates); the write floor policy covers writes to whatever tag they point at.
 *
 * <h2>Lookup</h2>
 * Perspective reports a binding on the key it is configured on only: a binding on a leaf is not
 * visible on its ancestors, and a binding on an object ({@code setpoint}, {@code menu.configEdit}) is not
 * visible on the leaves below it. So every security leaf <em>and every proper ancestor of one</em>, up to the root
 * key, is looked up individually. A binding on an
 * ancestor yields one verdict stored under the ancestor's path; it covers every security leaf below it
 * ({@link LintReport#gate} matches bound ancestors of a gate prefix as well as bound keys below it), and it is a
 * gate key when any security leaf below it is one. If the lookup itself fails (API change), the report is
 * marked not inspected: no verdicts, one INFO from the caller; the floor policy still applies (fail-open for
 * the lint only).
 *
 * <h2>Descendants</h2>
 * Security leaves that hold arrays or objects ({@code roles}, {@code securityLevels}, {@code options},
 * {@code allowedRoots}) can also be bound <em>below</em> the leaf: {@code setpoint.access.roles[0]},
 * {@code setpoint.options[0].value}. Such a binding is reported only on that exact key, so {@link #inspect} also
 * walks the current value of every security leaf (bounded: {@value #WALK_MAX_DEPTH} levels below the leaf,
 * {@value #WALK_MAX_NODES} nodes per component) and looks up every descendant key, spelled the way Perspective's
 * {@code PropertyKey.fromString} normalises it ({@code leaf[i]}, {@code leaf.field}, {@code leaf['odd key']}). A
 * bound descendant gets a verdict under its own path and the gate status of its leaf; {@link LintReport#gate}
 * treats {@code [} like {@code .} as a path separator. A value too large or too deep to walk (or unreadable)
 * yields an {@code unverified} verdict on the leaf that fails its gate closed. A binding on a node that does not
 * exist yet creates it with {@code Origin.Binding}; the delegate re-inspects on every binding write to a security
 * root and {@link LintReport#merge merges} new verdicts in, so such a binding is caught by its first value.
 */
public final class BindingLint {

    /** {@code {...}} references inside expression text. */
    private static final Pattern REF = Pattern.compile("\\{([^{}]*)\\}");
    private static final Pattern PLACEHOLDER = Pattern.compile("\\s*\\d+\\s*");
    /**
     * Pseudo reference added for an expression the scanner cannot verify (an unterminated string literal or block
     * comment): never session-owned, so the binding counts as user-controlled.
     */
    static final String UNVERIFIED = "(unverified expression)";
    /** Characters {@code PropertyKey.fromString} quotes as {@code ['name']} instead of {@code .name}. */
    private static final Pattern ILLEGAL_KEY_CHARS = Pattern.compile("[.\\[\\]'\\s]");

    /** Deepest descendant level below a security leaf that is walked. */
    public static final int WALK_MAX_DEPTH = 16;
    /** Most descendant keys walked per component (all leaves together). */
    public static final int WALK_MAX_NODES = 4096;

    private BindingLint() {
    }

    /** Classification of one bound security key. Immutable. */
    public static final class Verdict {
        private final String path;
        private final String type;
        private final boolean bidirectional;
        private final boolean userControlled;
        private final String source;
        private final boolean gateKey;
        private final boolean unverified;

        Verdict(String path, String type, boolean bidirectional, boolean userControlled, String source) {
            this(path, type, bidirectional, userControlled, source, !SecurityKeys.NON_GATE.contains(path), false);
        }

        private Verdict(String path, String type, boolean bidirectional, boolean userControlled, String source,
                boolean gateKey, boolean unverified) {
            this.path = path;
            this.type = type;
            this.bidirectional = bidirectional;
            this.userControlled = userControlled;
            this.source = source;
            this.gateKey = gateKey;
            this.unverified = unverified;
        }

        /**
         * The same verdict with an explicit gate status: a bound ancestor object is a gate when any security leaf
         * below it is one, a bound descendant when its leaf is one.
         */
        Verdict withGateKey(boolean gate) {
            return new Verdict(path, type, bidirectional, userControlled, source, gate, unverified);
        }

        /**
         * The combination of this verdict and {@code other} for the same path with every risk flag OR-ed; returns
         * {@code this} itself when {@code other} adds nothing (identity signals "unchanged" to
         * {@link LintReport#merge}).
         */
        Verdict stricter(Verdict other) {
            if (other == null) {
                return this;
            }
            boolean bidi = bidirectional || other.bidirectional;
            boolean user = userControlled || other.userControlled;
            boolean unver = unverified || other.unverified;
            boolean gate = gateKey || other.gateKey;
            if (bidi == bidirectional && user == userControlled && unver == unverified && gate == gateKey) {
                return this;
            }
            boolean useOther = (other.bidirectional && !bidirectional) || (other.unverified && !unverified)
                || (other.userControlled && !userControlled);
            return new Verdict(path, useOther ? other.type : type, bidi, user, useOther ? other.source : source, gate, unver);
        }

        /** Verdict for a leaf whose value could not be walked completely (too large, too deep, unreadable). */
        static Verdict unverified(String leaf, String reason, boolean gateKey) {
            return new Verdict(leaf, "unverified", false, false, reason, gateKey, true);
        }

        public String path() {
            return path;
        }

        /** Binding type as configured ({@code property}, {@code expr}, {@code tag}, ...). */
        public String type() {
            return type;
        }

        public boolean bidirectional() {
            return bidirectional;
        }

        public boolean userControlled() {
            return userControlled;
        }

        /** Short description of what the binding reads (designer-configured text; sanitise before logging). */
        public String source() {
            return source;
        }

        /**
         * True for every security key except {@code tagPath}/{@code trendGroup}; for a bound ancestor object, true
         * when any security leaf below it is a gate key.
         */
        public boolean isGateKey() {
            return gateKey;
        }

        /**
         * True when the bindings below this leaf could not all be checked (value larger or deeper than the walk
         * bounds, or unreadable). Such a gate always fails closed.
         */
        public boolean unverified() {
            return unverified;
        }

        /** True when this key's gate must fail closed under the given setting. */
        public boolean failsClosed(boolean rejectBoundGates) {
            return isGateKey() && (bidirectional || unverified || (userControlled && rejectBoundGates));
        }

        /** True when the binding deserves a WARN (risky even if the gate stays open). */
        public boolean risky() {
            return isGateKey() && (bidirectional || unverified || userControlled);
        }
    }

    /** All verdicts of one component at one view start. Immutable. */
    public static final class LintReport {
        private static final LintReport NOT_INSPECTED = new LintReport(Map.of(), false);
        private static final LintReport CLEAN = new LintReport(Map.of(), true);

        private final Map<String, Verdict> verdicts;
        private final boolean inspected;

        LintReport(Map<String, Verdict> verdicts, boolean inspected) {
            this.verdicts = verdicts;
            this.inspected = inspected;
        }

        /** Report of a component with no bound security key. */
        public static LintReport clean() {
            return CLEAN;
        }

        /** Report used when the lookup API failed: no verdicts. */
        public static LintReport notInspected() {
            return NOT_INSPECTED;
        }

        /** False when the binding lookup failed (no verdicts; floor policy still applies). */
        public boolean inspected() {
            return inspected;
        }

        /**
         * Verdicts of bound security keys and bound ancestor objects of security keys, by path (unbound keys are
         * absent).
         */
        public Map<String, Verdict> verdicts() {
            return verdicts;
        }

        /** The verdict for one path, if that exact path is bound (see {@link #gate} for ancestor coverage). */
        public Optional<Verdict> verdict(String path) {
            return Optional.ofNullable(verdicts.get(path));
        }

        /**
         * True when {@code path} itself, one of its ancestor objects or one of its descendants is bound (any binding,
         * risky or not). Tells a bound guard leaf whose binding delivers null apart from the schema
         * default null. False when the lookup failed ({@link #inspected()} false).
         */
        public boolean covers(String path) {
            for (Verdict v : verdicts.values()) {
                if (within(v.path, path) || within(path, v.path)) {
                    return true;
                }
            }
            return false;
        }

        /** Bound gate keys whose binding is risky (to WARN about), in path order. */
        public List<Verdict> risky() {
            List<Verdict> out = new ArrayList<>();
            for (Verdict v : verdicts.values()) {
                if (v.risky()) {
                    out.add(v);
                }
            }
            return out;
        }

        /**
         * Gate check: {@code BOUND_BIDIRECTIONAL} when a bound key that fails closed is equal to one of
         * {@code prefixes}, below it, or an ancestor object of it (a binding on {@code setpoint} covers
         * {@code setpoint.access}; a binding on {@code setpoint.access.roles[0]} covers
         * {@code setpoint.access.roles}). {@code .} and {@code [} both separate path segments.
         * Example: {@code gate(true, "enabled", "setpoint")} for the write gate.
         */
        public Optional<ErrorCode> gate(boolean rejectBoundGates, String... prefixes) {
            for (Verdict v : verdicts.values()) {
                if (!v.failsClosed(rejectBoundGates)) {
                    continue;
                }
                for (String prefix : prefixes) {
                    if (within(v.path, prefix) || within(prefix, v.path)) {
                        return Optional.of(ErrorCode.BOUND_BIDIRECTIONAL);
                    }
                }
            }
            return Optional.empty();
        }

        /**
         * This report plus the verdicts of {@code newer}: new paths are added, and for a path present in both the
         * <em>stricter</em> verdict wins flag by flag (bidirectional, user-controlled, unverified, gate key are
         * OR-ed). Verdicts are never dropped or weakened: bindings do not disappear from a running
         * view, and a re-inspection must not lift a gate that was closed. Returns {@code this} itself when nothing
         * changed, so a caller detects a change by identity.
         */
        public LintReport merge(LintReport newer) {
            if (newer == null || !newer.inspected) {
                return this;
            }
            if (!inspected) {
                return newer;
            }
            Map<String, Verdict> m = null;
            for (Map.Entry<String, Verdict> e : newer.verdicts.entrySet()) {
                Verdict old = verdicts.get(e.getKey());
                Verdict next = old == null ? e.getValue() : old.stricter(e.getValue());
                if (next != old) {
                    if (m == null) {
                        m = new LinkedHashMap<>(verdicts);
                    }
                    m.put(e.getKey(), next);
                }
            }
            return m == null ? this : new LintReport(Collections.unmodifiableMap(m), true);
        }
    }

    /** True when {@code path} equals {@code prefix} or lies below it ({@code prefix.x}, {@code prefix[0]}). */
    static boolean within(String path, String prefix) {
        if (!path.startsWith(prefix)) {
            return false;
        }
        if (path.length() == prefix.length()) {
            return true;
        }
        char c = path.charAt(prefix.length());
        return c == '.' || c == '[';
    }

    /** {@link #inspect(Function, Function, List)} without leaf values (no descendant walk). */
    public static LintReport inspect(Function<String, Optional<PropertyConfig>> lookup, List<String> paths) {
        return inspect(lookup, p -> Optional.empty(), paths);
    }

    /**
     * Inspects every security leaf, every proper ancestor of one ({@code setpoint}, {@code setpoint.access}, ...)
     * and every descendant of one in its current value ({@code setpoint.access.roles[0]}, ...), each once.
     * {@code lookup} returns the property config of a {@code props.<path>} key
     * ({@code component.getPropertyConfig(new PropertyKey(PropertyType.props, path))}); {@code valueOf} returns the
     * current value of a security leaf (empty when absent).
     */
    public static LintReport inspect(Function<String, Optional<PropertyConfig>> lookup,
                                     Function<String, Optional<JsonElement>> valueOf, List<String> paths) {
        // Every path to look up -> whether a gate leaf sits at, below or above it. Ancestors first, in path order.
        Map<String, Boolean> keys = new LinkedHashMap<>();
        for (String leaf : paths) {
            boolean gateLeaf = !SecurityKeys.NON_GATE.contains(leaf);
            int dot = leaf.indexOf('.');
            while (dot > 0) {
                keys.merge(leaf.substring(0, dot), gateLeaf, Boolean::logicalOr);
                dot = leaf.indexOf('.', dot + 1);
            }
            keys.merge(leaf, gateLeaf, Boolean::logicalOr);
        }
        Map<String, Verdict> out = new LinkedHashMap<>();
        // Descendants of each leaf's current value (bounded). A leaf that cannot be walked fails closed.
        int[] budget = {WALK_MAX_NODES};
        for (String leaf : paths) {
            boolean gateLeaf = !SecurityKeys.NON_GATE.contains(leaf);
            Optional<JsonElement> value;
            try {
                value = valueOf.apply(leaf);
            } catch (RuntimeException | LinkageError e) {
                out.put(leaf, Verdict.unverified(leaf, "value unreadable", gateLeaf));
                continue;
            }
            if (value != null && value.isPresent() && !walk(value.get(), leaf, 0, gateLeaf, keys, budget)) {
                out.put(leaf, Verdict.unverified(leaf, "value exceeds the lint walk bounds (depth " + WALK_MAX_DEPTH
                    + ", " + WALK_MAX_NODES + " nodes)", gateLeaf));
            }
        }
        try {
            for (Map.Entry<String, Boolean> k : keys.entrySet()) {
                if (out.containsKey(k.getKey())) {
                    continue;   // unverified leaf: already fails closed
                }
                Optional<PropertyConfig> cfg = lookup.apply(k.getKey());
                if (cfg == null || cfg.isEmpty()) {
                    continue;
                }
                Verdict v = classify(k.getKey(), cfg.get().binding);
                if (v != null) {
                    out.put(k.getKey(), v.gateKey == k.getValue() ? v : v.withGateKey(k.getValue()));
                }
            }
        } catch (RuntimeException | LinkageError e) {
            return LintReport.notInspected();
        }
        return out.isEmpty() ? LintReport.clean() : new LintReport(Collections.unmodifiableMap(out), true);
    }

    /**
     * Adds every descendant key of {@code e} (below {@code prefix}) to {@code keys} with the leaf's gate status.
     * False when the depth or the node budget is exceeded.
     */
    private static boolean walk(JsonElement e, String prefix, int depth, boolean gateLeaf, Map<String, Boolean> keys,
                                int[] budget) {
        if (e == null || !(e.isJsonArray() || e.isJsonObject())) {
            return true;
        }
        if (depth >= WALK_MAX_DEPTH) {
            return false;
        }
        if (e.isJsonArray()) {
            int i = 0;
            for (JsonElement item : e.getAsJsonArray()) {
                String child = prefix + "[" + i++ + "]";
                if (--budget[0] < 0) {
                    return false;
                }
                keys.merge(child, gateLeaf, Boolean::logicalOr);
                if (!walk(item, child, depth + 1, gateLeaf, keys, budget)) {
                    return false;
                }
            }
        } else {
            for (Map.Entry<String, JsonElement> m : e.getAsJsonObject().entrySet()) {
                String child = childKey(prefix, m.getKey());
                if (--budget[0] < 0) {
                    return false;
                }
                keys.merge(child, gateLeaf, Boolean::logicalOr);
                if (!walk(m.getValue(), child, depth + 1, gateLeaf, keys, budget)) {
                    return false;
                }
            }
        }
        return true;
    }

    /**
     * Key of field {@code name} below {@code prefix}, spelled the way {@code PropertyKey.fromString} normalises it:
     * {@code prefix.name}, or {@code prefix['name']} when the name contains {@code . [ ] '} or whitespace.
     */
    static String childKey(String prefix, String name) {
        return ILLEGAL_KEY_CHARS.matcher(name).find() ? prefix + "['" + name + "']" : prefix + "." + name;
    }

    // =========================================================================================================
    // Classification (pure). Only text that Perspective evaluates as an expression or a property path is
    // scanned for property references. Transform input placeholders ({value}), indirect-tag placeholders
    // ({1}, {area}) and brace literals in script code or inside quoted expression strings are not references,
    // so a legitimate tag-driven gate does not fail closed.
    // Script transforms are classified by whether their code uses `self` at all.
    // =========================================================================================================

    /** Input placeholder of a transform ({@code {value}}, {@code {value.x}}, {@code {value[0]}}). */
    private static final Set<String> VALUE_PLACEHOLDER = Set.of("value");
    /** The identifier {@code self} (not an attribute {@code x.self}, not part of a longer name). */
    private static final Pattern SELF = Pattern.compile("(?<![\\w.])self\\b");

    /** Classifies one binding; null when there is no enabled binding. */
    public static Verdict classify(String path, BindingConfig b) {
        if (b == null || !b.isEnabled()) {
            return null;
        }
        String type = b.type == null ? "" : b.type;
        JsonObject config = b.config == null ? new JsonObject() : b.config;
        boolean bidirectional = config.has("bidirectional") && config.get("bidirectional").isJsonPrimitive()
            && config.get("bidirectional").getAsJsonPrimitive().isBoolean() && config.get("bidirectional").getAsBoolean();

        List<String> refs = new ArrayList<>();
        boolean userControlled;
        String source;
        if ("property".equals(type)) {
            String p = str(config, "path");
            source = p;
            userControlled = !sessionOwned(p);
        } else {
            bindingRefs(type, config, refs);
            source = refs.isEmpty() ? type : String.join(",", refs);
            userControlled = refs.stream().anyMatch(r -> !sessionOwned(r));
        }
        if (b.transforms != null) {
            for (JsonObject t : b.transforms) {
                if (t != null && transformIsUserControlled(t)) {
                    userControlled = true;
                }
            }
        }
        return new Verdict(path, type, bidirectional, userControlled, source);
    }

    /**
     * Property references of a binding's configuration, by binding type:
     * <ul>
     *   <li>{@code expr}: the {@code expression};</li>
     *   <li>{@code expr-struct}: every expression of {@code struct};</li>
     *   <li>{@code tag}: {@code direct} → none (the tag's own permissions protect it); {@code indirect} → every
     *       value of {@code references} (a braced or bare property path; the {@code {name}} placeholders in
     *       {@code tagPath} are reference names, not properties); {@code expression} → the {@code tagPath}
     *       expression;</li>
     *   <li>{@code query}: every parameter expression;</li>
     *   <li>any other type: every string anywhere in the config (unknown structure → conservative).</li>
     * </ul>
     */
    static void bindingRefs(String type, JsonObject config, List<String> out) {
        switch (type) {
            case "expr":
                expressionRefs(str(config, "expression"), Set.of(), out);
                break;
            case "expr-struct": {
                JsonElement struct = config.get("struct");
                if (struct != null && struct.isJsonObject()) {
                    for (Map.Entry<String, JsonElement> e : struct.getAsJsonObject().entrySet()) {
                        collectRefs(e.getValue(), Set.of(), out);
                    }
                }
                break;
            }
            case "tag": {
                String mode = str(config, "mode");
                if ("indirect".equals(mode)) {
                    JsonElement refsObj = config.get("references");
                    if (refsObj != null && refsObj.isJsonObject()) {
                        for (Map.Entry<String, JsonElement> e : refsObj.getAsJsonObject().entrySet()) {
                            String v = e.getValue().isJsonPrimitive() ? e.getValue().getAsString().trim() : "";
                            int before = out.size();
                            expressionRefs(v, Set.of(), out);
                            if (out.size() == before && !v.isEmpty() && !v.startsWith("[") && !v.startsWith("{")) {
                                out.add(v);   // bare property path ("view.params.area")
                            }
                        }
                    }
                } else if ("expression".equals(mode)) {
                    expressionRefs(str(config, "tagPath"), Set.of(), out);
                }
                break;
            }
            case "query": {
                JsonElement params = config.get("parameters");
                if (params != null && params.isJsonObject()) {
                    for (Map.Entry<String, JsonElement> e : params.getAsJsonObject().entrySet()) {
                        collectRefs(e.getValue(), Set.of(), out);
                    }
                }
                break;
            }
            default:
                collectRawRefs(config, Set.of(), out);
        }
    }

    /**
     * True when a transform can bring client-writable data into the value: an {@code expression} transform that
     * references a property other than its input placeholder {@code {value}}, a {@code script} transform that
     * uses {@code self} anywhere in its code (outside comments and string literals), or an unknown transform type
     * with a property reference in its strings or {@code self} in its code. {@code map} and {@code format}
     * transforms hold literals only.
     */
    static boolean transformIsUserControlled(JsonObject t) {
        String type = str(t, "type");
        List<String> refs = new ArrayList<>();
        switch (type) {
            case "map":
            case "format":
                return false;
            case "expression":
                expressionRefs(str(t, "expression"), VALUE_PLACEHOLDER, refs);
                break;
            case "script":
                return scriptUsesSelf(str(t, "code"));
            default:
                if (scriptUsesSelf(str(t, "code"))) {
                    return true;
                }
                JsonObject rest = t.deepCopy();
                rest.remove("code");
                collectRawRefs(rest, VALUE_PLACEHOLDER, refs);
        }
        return refs.stream().anyMatch(r -> !sessionOwned(r));
    }

    /**
     * Property references ({@code {view.params.x}}) in one Perspective expression. Quoted string literals
     * ({@code "..."} / {@code '...'}, backslash escapes honoured) are skipped, so {@code "{literal}"} is not a
     * reference; {@code {[provider]Tag}} tag references and pure-digit placeholders are not references; a
     * reference whose first segment is in {@code placeholders} ({@code value} inside a transform) is not one.
     * <p>
     * Comments ({@code // …} to the end of the line, {@code /* … *}{@code /}) are skipped outside
     * literals, so a quote character inside a comment ({@code // the faceplate's switch}) does not open a
     * literal that blanks every later reference. An unterminated literal or block comment cannot be verified: it
     * adds the non-session reference {@link #UNVERIFIED}, which classifies the binding as user-controlled (fail
     * closed under {@code rejectBoundGates}).
     */
    static void expressionRefs(String expr, Set<String> placeholders, List<String> out) {
        if (expr == null || expr.isEmpty()) {
            return;
        }
        StringBuilder code = new StringBuilder(expr.length());
        char quote = 0;
        int n = expr.length();
        for (int i = 0; i < n; i++) {
            char c = expr.charAt(i);
            if (quote != 0) {
                if (c == '\\' && i + 1 < n) {
                    i++;
                    code.append(' ');
                } else if (c == quote) {
                    quote = 0;
                }
                code.append(' ');
            } else if (c == '/' && i + 1 < n && expr.charAt(i + 1) == '/') {
                while (i < n && expr.charAt(i) != '\n') {
                    code.append(' ');
                    i++;
                }
                if (i < n) {
                    code.append('\n');
                }
            } else if (c == '/' && i + 1 < n && expr.charAt(i + 1) == '*') {
                int end = expr.indexOf("*/", i + 2);
                if (end < 0) {
                    out.add(UNVERIFIED);
                    i = n;
                } else {
                    code.append(" ".repeat(end + 2 - i));
                    i = end + 1;
                }
            } else if (c == '"' || c == '\'') {
                quote = c;
                code.append(' ');
            } else {
                code.append(c);
            }
        }
        if (quote != 0 && !out.contains(UNVERIFIED)) {
            out.add(UNVERIFIED);
        }
        matchRefs(code, placeholders, out);
    }

    /** Every {@code {ref}} in {@code text} that is a property reference (no literal / comment handling). */
    private static void matchRefs(CharSequence text, Set<String> placeholders, List<String> out) {
        Matcher m = REF.matcher(text);
        while (m.find()) {
            String ref = m.group(1).trim();
            if (ref.isEmpty() || ref.startsWith("[") || PLACEHOLDER.matcher(ref).matches()) {
                continue;
            }
            String first = ref.split("[.\\[]", 2)[0].trim();
            if (!placeholders.contains(first)) {
                out.add(ref);
            }
        }
    }

    /**
     * Property references in every string anywhere inside {@code e}, each string scanned as an expression
     * (expression-struct members, query parameters).
     */
    static void collectRefs(JsonElement e, Set<String> placeholders, List<String> out) {
        collectRefs(e, placeholders, out, false);
    }

    /**
     * Property references in every string anywhere inside {@code e}, without literal or comment handling: for
     * configurations whose structure is unknown (conservative). A URL's {@code //} or an apostrophe
     * in such a string is not expression syntax, so it must not hide the references after it.
     */
    static void collectRawRefs(JsonElement e, Set<String> placeholders, List<String> out) {
        collectRefs(e, placeholders, out, true);
    }

    private static void collectRefs(JsonElement e, Set<String> placeholders, List<String> out, boolean raw) {
        if (e == null || e.isJsonNull()) {
            return;
        }
        if (e.isJsonPrimitive()) {
            if (e.getAsJsonPrimitive().isString()) {
                if (raw) {
                    matchRefs(e.getAsString(), placeholders, out);
                } else {
                    expressionRefs(e.getAsString(), placeholders, out);
                }
            }
        } else if (e.isJsonArray()) {
            for (JsonElement item : e.getAsJsonArray()) {
                collectRefs(item, placeholders, out, raw);
            }
        } else if (e.isJsonObject()) {
            for (Map.Entry<String, JsonElement> m : e.getAsJsonObject().entrySet()) {
                collectRefs(m.getValue(), placeholders, out, raw);
            }
        }
    }

    /**
     * True when Python {@code code} uses the identifier {@code self} outside comments and string literals
     * ({@code self.view}, {@code self .view}, {@code self\n.view}, {@code getattr(self, 'view')},
     * {@code s = self}, {@code self['x']} …). The transform's own parameter list is not part of the stored code,
     * so any use means the script can read client-writable props. An
     * unterminated string literal blanks the rest of its line only, so it cannot hide a later {@code self}.
     */
    static boolean scriptUsesSelf(String code) {
        if (code == null || code.isEmpty()) {
            return false;
        }
        StringBuilder b = new StringBuilder(code.length());
        int i = 0;
        int n = code.length();
        while (i < n) {
            char c = code.charAt(i);
            if (c == '#') {
                while (i < n && code.charAt(i) != '\n') {
                    i++;
                }
                continue;
            }
            if (c == '"' || c == '\'') {
                boolean triple = i + 2 < n && code.charAt(i + 1) == c && code.charAt(i + 2) == c;
                if (triple) {
                    int end = code.indexOf(String.valueOf(c).repeat(3), i + 3);
                    i = end < 0 ? n : end + 3;
                } else {
                    i++;
                    while (i < n && code.charAt(i) != c && code.charAt(i) != '\n') {
                        if (code.charAt(i) == '\\') {
                            i++;
                        }
                        i++;
                    }
                    if (i < n && code.charAt(i) == c) {
                        i++;
                    }
                }
                b.append(' ');
                continue;
            }
            b.append(c);
            i++;
        }
        return SELF.matcher(b).find();
    }

    private static String str(JsonObject o, String key) {
        JsonElement e = o == null ? null : o.get(key);
        return e != null && e.isJsonPrimitive() ? e.getAsString() : "";
    }

    /** Session-owned read-only props a client cannot write (the exception to the user-controlled rule). */
    static boolean sessionOwned(String ref) {
        String r = ref == null ? "" : ref.trim();
        return r.equals("session.props.id") || r.equals("session.props.auth") || r.startsWith("session.props.auth.");
    }
}
