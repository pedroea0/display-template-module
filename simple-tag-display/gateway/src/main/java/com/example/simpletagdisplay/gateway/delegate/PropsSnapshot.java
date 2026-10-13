package com.example.simpletagdisplay.gateway.delegate;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.OptionalDouble;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.security.AccessRule;
import com.example.simpletagdisplay.gateway.security.BindingLint;
import com.example.simpletagdisplay.gateway.security.TrustedProps;
import com.example.simpletagdisplay.gateway.util.Json;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonPrimitive;

/**
 * Immutable view of a component's <b>trusted</b> security props plus the binding-lint verdicts, as of one
 * moment. {@code CtgDelegateBase.props()} returns this snapshot; every gate consults both the props and the lint
 * verdicts, and then {@code FloorPolicy}.
 *
 * Every gate reads security keys from here, never from the live property tree (which may hold a value a browser
 * just wrote and {@code TrustedProps} is about to revert). Paths are the dotted leaf paths of
 * {@link com.example.simpletagdisplay.gateway.security.SecurityKeys}; an absent key yields the caller's default
 * (the schema default of that key). Safe to use from any thread.
 */
public final class PropsSnapshot {

    private final Map<String, JsonElement> values;
    private final BindingLint.LintReport lint;
    private final boolean rejectBoundGates;

    public PropsSnapshot(Map<String, JsonElement> values, BindingLint.LintReport lint, boolean rejectBoundGates) {
        this.values = Map.copyOf(values);
        this.lint = lint == null ? BindingLint.LintReport.clean() : lint;
        this.rejectBoundGates = rejectBoundGates;
    }

    /** An empty snapshot (every getter returns its default). */
    public static PropsSnapshot empty() {
        return new PropsSnapshot(Map.of(), BindingLint.LintReport.clean(), true);
    }

    /** Raw trusted value of a leaf (deep copy), empty when absent. */
    public Optional<JsonElement> json(String path) {
        JsonElement e = values.get(path);
        return e == null || e.isJsonNull() ? Optional.empty() : Optional.of(e.deepCopy());
    }

    public boolean bool(String path, boolean fallback) {
        JsonElement e = values.get(path);
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isBoolean()) {
            return fallback;
        }
        return e.getAsBoolean();
    }

    /**
     * A security gate flag ({@code enabled}, {@code menu.enabled}, {@code setpoint.enabled}, ...): the schema default
     * {@code absentDefault} only when the key is absent; a present Boolean is used as is; any other present value
     * (null, a number, a string such as {@code "false"} — e.g. a binding on an Int tag or a string expression) is a
     * misconfiguration and fails CLOSED ({@code false}). Contrast {@link #bool}, which falls back for non-Booleans and
     * is meant for non-security options.
     */
    public boolean gateFlag(String path, boolean absentDefault) {
        if (!values.containsKey(path)) {
            return absentDefault;
        }
        JsonElement e = values.get(path);
        if (e != null && e.isJsonPrimitive() && e.getAsJsonPrimitive().isBoolean()) {
            return e.getAsBoolean();
        }
        return false;
    }

    public String string(String path, String fallback) {
        JsonElement e = values.get(path);
        if (e == null || !e.isJsonPrimitive()) {
            return fallback;
        }
        JsonPrimitive p = e.getAsJsonPrimitive();
        return p.isString() ? p.getAsString() : fallback;
    }

    /** Finite number, empty when absent / null / not a number / non-finite. */
    public OptionalDouble number(String path) {
        JsonElement e = values.get(path);
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) {
            return OptionalDouble.empty();
        }
        double d = e.getAsDouble();
        return Double.isFinite(d) ? OptionalDouble.of(d) : OptionalDouble.empty();
    }

    /** String items of an array leaf (exact, untrimmed). */
    public List<String> strings(String path) {
        return Json.stringList(values.get(path));
    }

    /**
     * True when the key is present in the trusted snapshot, JSON null included, or is shadowed (absent because an
     * ancestor is present but not an object; {@link TrustedProps#isShadow}).
     */
    public boolean isPresent(String path) {
        return values.get(path) != null;
    }

    /**
     * True when the leaf is absent only because one of its ancestors is present but not an object (e.g.
     * {@code setpoint.access: "Engineer"} or {@code null}). Such a leaf is a misconfiguration: gate flags read it as
     * {@code false}, access rules as "nobody", {@link #json} returns the marker (so number/array checks fail closed).
     * Chart gates treat a shadowed list such as {@code readScope.allowedRoots} as "nothing allowed".
     */
    public boolean shadowed(String path) {
        return TrustedProps.isShadow(values.get(path));
    }

    /**
     * The access rule under {@code prefix} ({@code "setpoint"} reads {@code setpoint.access.roles},
     * {@code .securityLevels}, {@code .requireLogin}).
     * <p>
     * Fails CLOSED on a malformed rule: a role/level list that is present but not an array
     * of strings — including JSON {@code null} (a binding whose tag is missing or whose provider is down delivers null)
     * — matches nobody; a present {@code requireLogin} that is not a Boolean requires a login; and when
     * {@code <prefix>.access} itself (or any ancestor) is present but not an object ({@code access: "Engineer"},
     * {@code access: null}) the whole rule matches nobody. Only an <em>absent</em> list means "no restriction" (the
     * schema default {@code []}). Shared by the Display gates and the chart's access rules.
     */
    public AccessRule access(String prefix, boolean defaultRequireLogin) {
        JsonObject o = new JsonObject();
        JsonElement roles = values.get(prefix + ".access.roles");
        JsonElement levels = values.get(prefix + ".access.securityLevels");
        JsonElement login = values.get(prefix + ".access.requireLogin");
        if (TrustedProps.isShadow(roles) || TrustedProps.isShadow(levels) || TrustedProps.isShadow(login)) {
            o.add("roles", nobody());
            o.add("securityLevels", nobody());
            o.addProperty("requireLogin", true);
            return AccessRule.parse(o, true);
        }
        o.add("roles", malformedList(roles) ? nobody() : roles == null ? JsonNull.INSTANCE : roles);
        o.add("securityLevels", malformedList(levels) ? nobody() : levels == null ? JsonNull.INSTANCE : levels);
        if (login != null) {
            boolean isBool = login.isJsonPrimitive() && login.getAsJsonPrimitive().isBoolean();
            o.add("requireLogin", isBool ? login : new JsonPrimitive(true));
        }
        return AccessRule.parse(o, defaultRequireLogin);
    }

    /** A role / level list no user can satisfy (a malformed access list fails closed). */
    private static JsonArray nobody() {
        JsonArray a = new JsonArray();
        a.add("\u0000ctg-malformed-access-list");
        return a;
    }

    /** Present (null included) and not an array of strings. Absent ({@code e == null}) is not malformed. */
    private static boolean malformedList(JsonElement e) {
        if (e == null) {
            return false;
        }
        if (!e.isJsonArray()) {
            return true;   // null, a string, a number, an object (incl. a shadow marker)
        }
        for (JsonElement item : e.getAsJsonArray()) {
            if (item == null || !item.isJsonPrimitive() || !item.getAsJsonPrimitive().isString()) {
                return true;
            }
        }
        return false;
    }

    /**
     * Binding-lint gate: {@code BOUND_BIDIRECTIONAL} when a key at or under one of {@code prefixes} is bound in a
     * way that fails its gate closed (bidirectional; or user-controlled with {@code ctg.security.rejectBoundGates}).
     */
    public Optional<ErrorCode> lintGate(String... prefixes) {
        return lint.gate(rejectBoundGates, prefixes);
    }

    public BindingLint.LintReport lint() {
        return lint;
    }

    public boolean rejectBoundGates() {
        return rejectBoundGates;
    }

    /** Leaf paths present in the snapshot. */
    public java.util.Set<String> paths() {
        return values.keySet();
    }
}
