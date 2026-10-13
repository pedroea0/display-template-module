package com.example.simpletagdisplay.gateway.security;

import java.util.List;
import java.util.Optional;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.util.Json;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;

/**
 * One component access rule: the {@code access:{roles, securityLevels, requireLogin}} shape every gated feature
 * shares ({@code setpoint.access}, {@code menu.trend.access}, {@code menu.configEdit.access},
 * {@code menu.changeHistory.access}, {@code trendEdit.access}, {@code tagBrowser.access},
 * {@code annotations.edit.access}, {@code annotations.moderate.access}).
 *
 * <h2>Semantics</h2>
 * <pre>
 *   (requireLogin || roles non-empty || securityLevels non-empty) and not logged in  → AUTH_REQUIRED
 *   roles non-empty and the user holds none of them                                 → FORBIDDEN_ROLE
 *   securityLevels non-empty and the user holds none of them (or a descendant)      → FORBIDDEN_ROLE
 *   otherwise                                                                       → allowed
 * </pre>
 * Role and level names are compared <b>exactly</b> (case-sensitive, untrimmed): {@code "operator"} does not
 * match the role {@code "Operator"}. A level entry may be written with leading/trailing slashes; they are ignored.
 *
 * The rule is a component-level gate only. The gateway floor policy ({@link FloorPolicy}) is evaluated in
 * addition and can only make it stricter, and tag Read/Write Permissions still apply to the actual tag operation.
 */
public final class AccessRule {

    private final List<String> roles;
    private final List<String> securityLevels;
    private final boolean requireLogin;

    public AccessRule(List<String> roles, List<String> securityLevels, boolean requireLogin) {
        this.roles = List.copyOf(roles);
        this.securityLevels = List.copyOf(securityLevels);
        this.requireLogin = requireLogin;
    }

    /**
     * Parses an {@code access} object. Missing or malformed members fall back to "no roles", "no levels" and
     * {@code defaultRequireLogin} (the schema default of that particular rule: true for configEdit /
     * changeHistory / annotation editing, false for setpoint / trend / trendEdit / tagBrowser).
     */
    public static AccessRule parse(JsonElement access, boolean defaultRequireLogin) {
        if (access == null || !access.isJsonObject()) {
            return new AccessRule(List.of(), List.of(), defaultRequireLogin);
        }
        JsonObject o = access.getAsJsonObject();
        return new AccessRule(Json.stringList(o.get("roles")), Json.stringList(o.get("securityLevels")),
            Json.bool(o, "requireLogin", defaultRequireLogin));
    }

    /** Empty when allowed, else {@code AUTH_REQUIRED} or {@code FORBIDDEN_ROLE}. */
    public Optional<ErrorCode> evaluate(UserContext user) {
        boolean needsLogin = requireLogin || !roles.isEmpty() || !securityLevels.isEmpty();
        if (needsLogin && !user.authenticated()) {
            return Optional.of(ErrorCode.AUTH_REQUIRED);
        }
        if (!roles.isEmpty() && roles.stream().noneMatch(user.roles()::contains)) {
            return Optional.of(ErrorCode.FORBIDDEN_ROLE);
        }
        if (!securityLevels.isEmpty() && securityLevels.stream().map(AccessRule::normalizeLevel)
                .noneMatch(user.levelPaths()::contains)) {
            return Optional.of(ErrorCode.FORBIDDEN_ROLE);
        }
        return Optional.empty();
    }

    /** {@code "/Authenticated/Roles/Operator/"} → {@code "Authenticated/Roles/Operator"} (case kept). */
    static String normalizeLevel(String level) {
        int b = 0;
        int e = level.length();
        while (b < e && level.charAt(b) == '/') {
            b++;
        }
        while (e > b && level.charAt(e - 1) == '/') {
            e--;
        }
        return level.substring(b, e);
    }

    public List<String> roles() {
        return roles;
    }

    public List<String> securityLevels() {
        return securityLevels;
    }

    public boolean requireLogin() {
        return requireLogin;
    }

    @Override
    public String toString() {
        return "AccessRule{roles=" + roles + ", securityLevels=" + securityLevels + ", requireLogin=" + requireLogin + "}";
    }
}
