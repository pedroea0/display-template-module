package com.example.simpletagdisplay.gateway.security;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * The security keys of both components: every {@code [S]} leaf of the two props
 * schemas. Leaves are the unit of trust: {@code TrustedProps} keeps one trusted value per path, and
 * {@code BindingLint} looks up each path, its ancestors and its value's descendants (Perspective reports a binding
 * only on its exact key). Arrays ({@code roles}, {@code options}, ...) are trust leaves; element bindings lint under
 * their gate.
 *
 * {@link #NON_GATE} lists the keys that may legitimately be bound to view params ({@code tagPath},
 * {@code trendGroup}: a faceplate is parameterised by its tag); every other key is a <em>gate key</em>, whose
 * binding fails the gate closed when it is bidirectional, or when it is user-controlled and
 * {@code ctg.security.rejectBoundGates} is true.
 *
 * The lists are checked against the schemas by {@code SecurityKeysTest} (every path exists and carries
 * {@code [S]} in its description, or sits under a {@code [S]} access object).
 */
public final class SecurityKeys {

    private SecurityKeys() {
    }

    /** Display Template ({@code com.example.simpletagdisplay.SimpleTagDisplay}). */
    public static final List<String> DISPLAY = List.of(
        "tagPath",
        "enabled",
        "trendGroup",
        "bounds.lowAlarmName",
        "bounds.highAlarmName",
        "alarms.colorMode",
        "setpoint.enabled",
        "setpoint.access.roles",
        "setpoint.access.securityLevels",
        "setpoint.access.requireLogin",
        "setpoint.limits.useEngLimits",
        "setpoint.limits.low",
        "setpoint.limits.high",
        "setpoint.limits.inclusive",
        "setpoint.maxStep",
        "setpoint.maxStepPercent",
        "setpoint.options",
        "setpoint.maxStringLength",
        "setpoint.allowOnBadQuality",
        "menu.enabled",
        "menu.trend.enabled",
        "menu.trend.access.roles",
        "menu.trend.access.securityLevels",
        "menu.trend.access.requireLogin",
        "menu.configEdit.enabled",
        "menu.configEdit.access.roles",
        "menu.configEdit.access.securityLevels",
        "menu.configEdit.access.requireLogin",
        "menu.changeHistory.enabled",
        "menu.changeHistory.access.roles",
        "menu.changeHistory.access.securityLevels",
        "menu.changeHistory.access.requireLogin",
        "menu.changeHistory.limit");

    /** Click To Graph Chart ({@code com.example.simpletagdisplay.CtgChart}). {@code pens} is filtered by the read scope instead. */
    public static final List<String> CHART = List.of(
        "enabled",
        "trendGroup",
        "trendEdit.enabled",
        "trendEdit.access.roles",
        "trendEdit.access.securityLevels",
        "trendEdit.access.requireLogin",
        "readScope.allowedRoots",
        "readScope.allowRuntimePens",
        "tagBrowser.enabled",
        "tagBrowser.rootPath",
        "tagBrowser.access.roles",
        "tagBrowser.access.securityLevels",
        "tagBrowser.access.requireLogin",
        "annotations.enabled",
        "annotations.edit.enabled",
        "annotations.edit.ownOnly",
        "annotations.edit.access.roles",
        "annotations.edit.access.securityLevels",
        "annotations.edit.access.requireLogin",
        "annotations.moderate.enabled",
        "annotations.moderate.access.roles",
        "annotations.moderate.access.securityLevels",
        "annotations.moderate.access.requireLogin");

    /** Security keys that are not gates (may be bound to view params). */
    public static final Set<String> NON_GATE = Set.of("tagPath", "trendGroup");

    /** Root keys ({@code "setpoint"} for {@code "setpoint.access.roles"}) of a path list, in order, without duplicates. */
    public static Set<String> roots(List<String> paths) {
        Set<String> out = new LinkedHashSet<>();
        for (String p : paths) {
            int dot = p.indexOf('.');
            out.add(dot < 0 ? p : p.substring(0, dot));
        }
        return out;
    }
}
