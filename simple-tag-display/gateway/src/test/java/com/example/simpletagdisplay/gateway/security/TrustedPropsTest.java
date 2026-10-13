package com.example.simpletagdisplay.gateway.security;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonNull;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.gson.JsonPrimitive;
import com.inductiveautomation.perspective.common.property.Origin;
import org.junit.jupiter.api.Test;

/** Trusted-props decision logic, Client vs Designer scope. */
class TrustedPropsTest {

    private static final List<String> PATHS = List.of("enabled", "setpoint.enabled", "setpoint.access.roles",
        "setpoint.limits.low", "tagPath");

    /** A property tree stand-in: dotted leaf → value. */
    private final Map<String, JsonElement> tree = new HashMap<>();

    private TrustedProps props(boolean designer) {
        TrustedProps t = new TrustedProps(PATHS, designer, p -> Optional.ofNullable(tree.get(p)));
        t.initialize();
        return t;
    }

    private static JsonArray roles(String... names) {
        JsonArray a = new JsonArray();
        for (String n : names) {
            a.add(n);
        }
        return a;
    }

    @Test
    void decideRevertsBrowserChangesOnlyInClientScope() {
        Map<String, JsonElement> trusted = Map.of("setpoint.enabled", new JsonPrimitive(false));
        Map<String, JsonElement> fresh = Map.of("setpoint.enabled", new JsonPrimitive(true));
        List<String> paths = List.of("setpoint.enabled");
        assertEquals(List.of("setpoint.enabled"), TrustedProps.decide(paths, trusted, fresh, Origin.Browser, false).reverted());
        assertEquals(List.of("setpoint.enabled"), TrustedProps.decide(paths, trusted, fresh, Origin.Browser, true).adopted());
        // (BindingWriteback is reverted like Browser: see SecurityBindingTest)
        for (Origin o : List.of(Origin.Binding, Origin.Script, Origin.Session, Origin.Project)) {
            TrustedProps.Outcome out = TrustedProps.decide(paths, trusted, fresh, o, false);
            assertEquals(List.of("setpoint.enabled"), out.adopted(), o.name());
            assertTrue(out.reverted().isEmpty(), o.name());
        }
    }

    @Test
    void decideIgnoresUnchangedLeavesAndHandlesAbsentKeys() {
        Map<String, JsonElement> same = Map.of("enabled", new JsonPrimitive(true));
        TrustedProps.Outcome o = TrustedProps.decide(List.of("enabled"), same, same, Origin.Browser, false);
        assertTrue(o.adopted().isEmpty() && o.reverted().isEmpty());
        // absent at start, written by the browser → revert (the revert removes the key)
        o = TrustedProps.decide(List.of("enabled"), Map.of(), same, Origin.Browser, false);
        assertEquals(List.of("enabled"), o.reverted());
        // numeric equality across representations (1 vs 1.0) is no change
        o = TrustedProps.decide(List.of("x"), Map.of("x", new JsonPrimitive(1)), Map.of("x", new JsonPrimitive(1.0)),
            Origin.Browser, false);
        assertTrue(o.reverted().isEmpty());
    }

    @Test
    void browserTamperIsRevertedAndTheTrustedValueKept() {
        tree.put("setpoint.enabled", new JsonPrimitive(false));
        tree.put("setpoint.access.roles", roles("Engineer"));
        tree.put("setpoint.limits.low", JsonNull.INSTANCE);
        TrustedProps t = props(false);

        tree.put("setpoint.access.roles", roles("Engineer", "viewer"));
        List<TrustedProps.Revert> r = t.onChange("setpoint", Origin.Browser, "setpoint.access.roles");
        assertEquals(1, r.size());
        assertEquals("setpoint.access.roles", r.get(0).path());
        assertEquals(roles("Engineer"), r.get(0).value());
        assertEquals(roles("Engineer"), t.values().get("setpoint.access.roles"));

        // explicit null at start is restored as null, not removed
        tree.put("setpoint.limits.low", new JsonPrimitive(-1e9));
        r = t.onChange("setpoint", Origin.Browser, "setpoint.limits.low");
        assertEquals(1, r.size());
        assertTrue(r.get(0).value().isJsonNull());
    }

    @Test
    void bindingChangesAreAdopted() {
        tree.put("tagPath", new JsonPrimitive("[default]CTG/Temp"));
        TrustedProps t = props(false);
        tree.put("tagPath", new JsonPrimitive("[default]CTG/Pressure"));
        assertTrue(t.onChange("tagPath", Origin.Binding, "tagPath").isEmpty());
        assertEquals(new JsonPrimitive("[default]CTG/Pressure"), t.values().get("tagPath"));
    }

    @Test
    void onlyLeavesAffectedByTheChangedPathAreDecided() {
        tree.put("setpoint.enabled", new JsonPrimitive(false));
        tree.put("setpoint.access.roles", roles("Engineer"));
        TrustedProps t = props(false);
        // A binding legitimately changed setpoint.enabled AND the browser changed the roles at the same time: the
        // binding event must not adopt the browser's roles.
        tree.put("setpoint.enabled", new JsonPrimitive(true));
        tree.put("setpoint.access.roles", roles());
        assertTrue(t.onChange("setpoint", Origin.Binding, "setpoint.enabled").isEmpty());
        assertEquals(new JsonPrimitive(true), t.values().get("setpoint.enabled"));
        assertEquals(roles("Engineer"), t.values().get("setpoint.access.roles"));
        List<TrustedProps.Revert> r = t.onChange("setpoint", Origin.Browser, "setpoint.access.roles");
        assertEquals("setpoint.access.roles", r.get(0).path());
    }

    @Test
    void wholeObjectReplacementAffectsEveryLeafBelow() {
        tree.put("setpoint.enabled", new JsonPrimitive(false));
        tree.put("setpoint.access.roles", roles("Engineer"));
        TrustedProps t = props(false);
        tree.put("setpoint.enabled", new JsonPrimitive(true));
        tree.put("setpoint.access.roles", roles());
        assertEquals(2, t.onChange("setpoint", Origin.Browser, "setpoint").size());
    }

    @Test
    void designerScopeAdoptsEveryOrigin() {
        tree.put("enabled", new JsonPrimitive(true));
        TrustedProps t = props(true);
        tree.put("enabled", new JsonPrimitive(false));
        assertTrue(t.onChange("enabled", Origin.Browser, "enabled").isEmpty());
        assertEquals(new JsonPrimitive(false), t.values().get("enabled"));
    }

    @Test
    void affectsMatchesLeafDescendantsAndAncestors() {
        assertTrue(TrustedProps.affects("setpoint.access.roles", "setpoint.access.roles"));
        assertTrue(TrustedProps.affects("setpoint.access.roles[0]", "setpoint.access.roles"));
        assertTrue(TrustedProps.affects("setpoint.access.roles.0", "setpoint.access.roles"));
        assertTrue(TrustedProps.affects("setpoint", "setpoint.access.roles"));
        assertTrue(TrustedProps.affects("props.setpoint.access", "setpoint.access.roles"));
        assertTrue(TrustedProps.affects(null, "setpoint.enabled"));
        assertFalse(TrustedProps.affects("setpoint.enabledX", "setpoint.enabled"));
        assertFalse(TrustedProps.affects("setpoint.limits.low", "setpoint.enabled"));
    }

    @Test
    void tamperLogIsRateLimitedPerKeyAndCountsSuppressedLines() {
        List<String> lines = new ArrayList<>();
        long[] clock = {0L};
        TrustedProps.TamperLog log = new TrustedProps.TamperLog(() -> 2, lines::add, () -> clock[0]);
        for (int i = 0; i < 10; i++) {
            log.report("setpoint.enabled", "tamper enabled");
        }
        log.report("tagPath", "tamper tagPath");
        assertEquals(List.of("tamper enabled", "tamper enabled", "tamper tagPath"), lines);
        clock[0] = 60_000L;
        log.report("setpoint.enabled", "tamper enabled");
        assertEquals("tamper enabled (8 similar suppressed)", lines.get(3));
    }

    @Test
    void valuesArePublishedCopyOnWrite() {
        tree.put("tagPath", new JsonPrimitive("[default]CTG/Temp"));
        TrustedProps t = props(false);
        Map<String, JsonElement> before = t.current();
        assertThrows(UnsupportedOperationException.class, () -> before.put("x", new JsonPrimitive(1)));
        // A reverted browser write publishes nothing new.
        tree.put("tagPath", new JsonPrimitive("[default]CTG/Secret"));
        t.onChange("tagPath", Origin.Browser, "tagPath");
        assertSame(before, t.current());
        // An adopted change publishes a new map; the old one is untouched (a reader on another thread keeps a
        // consistent view).
        tree.put("tagPath", new JsonPrimitive("[default]CTG/Pressure"));
        t.onChange("tagPath", Origin.Binding, "tagPath");
        assertNotSame(before, t.current());
        assertEquals(new JsonPrimitive("[default]CTG/Temp"), before.get("tagPath"));
        assertEquals(new JsonPrimitive("[default]CTG/Pressure"), t.current().get("tagPath"));
    }

    // ---- restore when the client removed the parent object; re-lint scope --------------------------

    @Test
    void restorePlanWritesLeavesWhoseParentExists() {
        Map<String, JsonElement> current = new HashMap<>();
        current.put("setpoint", JsonParser.parseString("{\"enabled\":true,\"access\":{\"roles\":[\"Anyone\"]}}"));
        current.put("setpoint.access", JsonParser.parseString("{\"roles\":[\"Anyone\"]}"));
        List<TrustedProps.Revert> reverts = List.of(new TrustedProps.Revert("setpoint.enabled", new JsonPrimitive(false)),
            new TrustedProps.Revert("setpoint.access.roles", roles("Engineer")));
        List<TrustedProps.Write> plan = TrustedProps.restorePlan(reverts, p -> Optional.ofNullable(current.get(p)), Map.of());
        assertEquals(2, plan.size());
        assertEquals("setpoint.enabled", plan.get(0).path());
        assertEquals(new JsonPrimitive(false), plan.get(0).value());
        assertEquals("setpoint.access.roles", plan.get(1).path());
    }

    @Test
    void restorePlanRebuildsTheHighestRemovedParentFromTrustedLeaves() {
        // The client removed `setpoint` entirely: every security leaf below it is restored by ONE object write.
        Map<String, JsonElement> trusted = new HashMap<>();
        trusted.put("setpoint.enabled", new JsonPrimitive(false));
        trusted.put("setpoint.access.roles", roles("Engineer"));
        trusted.put("setpoint.access.requireLogin", new JsonPrimitive(true));
        trusted.put("enabled", new JsonPrimitive(true));
        List<TrustedProps.Revert> reverts = List.of(new TrustedProps.Revert("setpoint.access.roles", roles("Engineer")),
            new TrustedProps.Revert("setpoint.enabled", new JsonPrimitive(false)),
            new TrustedProps.Revert("setpoint.access.requireLogin", new JsonPrimitive(true)));
        List<TrustedProps.Write> plan = TrustedProps.restorePlan(reverts, p -> Optional.empty(), trusted);
        assertEquals(1, plan.size());
        TrustedProps.Write w = plan.get(0);
        assertEquals("setpoint", w.path());
        assertEquals(JsonParser.parseString("{\"enabled\":false,\"access\":{\"roles\":[\"Engineer\"],\"requireLogin\":true}}"),
            w.value());
        assertEquals(3, w.covers().size());
    }

    @Test
    void restorePlanTreatsAParentReplacedByAScalarAsMissing() {
        Map<String, JsonElement> current = new HashMap<>();
        current.put("setpoint", JsonParser.parseString("{\"enabled\":true}"));
        current.put("setpoint.access", new JsonPrimitive(5));   // replaced by a scalar
        Map<String, JsonElement> trusted = Map.of("setpoint.access.roles", roles("Engineer"));
        List<TrustedProps.Write> plan = TrustedProps.restorePlan(
            List.of(new TrustedProps.Revert("setpoint.access.roles", roles("Engineer")),
                new TrustedProps.Revert("setpoint.enabled", new JsonPrimitive(false))),
            p -> Optional.ofNullable(current.get(p)), trusted);
        assertEquals(2, plan.size());
        assertEquals("setpoint.access", plan.get(0).path());
        assertEquals(JsonParser.parseString("{\"roles\":[\"Engineer\"]}"), plan.get(0).value());
        assertEquals("setpoint.enabled", plan.get(1).path());
    }

    @Test
    void restorePlanRemovesKeysThatWereAbsent() {
        List<TrustedProps.Write> plan = TrustedProps.restorePlan(List.of(new TrustedProps.Revert("setpoint.limits.low", null)),
            p -> Optional.empty(), Map.of());
        assertEquals(1, plan.size());
        assertEquals("setpoint.limits.low", plan.get(0).path());
        assertEquals(null, plan.get(0).value());
    }

    // ---- a container that is present but not an object shadows its leaves --------------------------

    /** Nested props object as a tree reader (like the delegate's PropertyTree reads). */
    private static java.util.function.Function<String, Optional<JsonElement>> nested(JsonElement[] root) {
        return path -> {
            JsonElement cur = root[0];
            for (String part : path.split("\\.")) {
                if (cur == null || !cur.isJsonObject() || !cur.getAsJsonObject().has(part)) {
                    return Optional.empty();
                }
                cur = cur.getAsJsonObject().get(part);
            }
            return Optional.of(cur);
        };
    }

    @Test
    void readTrustFormMarksLeavesShadowedByANonObjectAncestor() {
        JsonElement[] root = {JsonParser.parseString("{\"setpoint\":{\"enabled\":true,\"access\":\"Engineer\"}}")};
        Optional<JsonElement> roles = TrustedProps.readTrustForm("setpoint.access.roles", nested(root));
        assertTrue(roles.isPresent() && TrustedProps.isShadow(roles.get()));
        assertEquals("setpoint.access", TrustedProps.shadowPath(roles.get()));
        assertEquals(new JsonPrimitive("Engineer"), TrustedProps.shadowValue(roles.get()));
        assertEquals(new JsonPrimitive(true), TrustedProps.readTrustForm("setpoint.enabled", nested(root)).get());
        root[0] = JsonParser.parseString("{\"setpoint\":{\"access\":null}}");
        assertTrue(TrustedProps.isShadow(TrustedProps.readTrustForm("setpoint.access.requireLogin", nested(root)).get()));
        root[0] = JsonParser.parseString("{\"setpoint\":{\"access\":{\"roles\":null}}}");
        assertTrue(TrustedProps.readTrustForm("setpoint.access.roles", nested(root)).get().isJsonNull(), "present null leaf");
        assertTrue(TrustedProps.readTrustForm("setpoint.access.securityLevels", nested(root)).isEmpty(), "absent leaf");
        root[0] = JsonParser.parseString("{}");
        assertTrue(TrustedProps.readTrustForm("setpoint.access.roles", nested(root)).isEmpty(), "absent ancestors");
    }

    @Test
    void browserChangeOfAShadowingContainerIsRevertedToTheContainerValue() {
        JsonElement[] root = {JsonParser.parseString("{\"setpoint\":{\"enabled\":true,\"access\":\"Engineer\"}}")};
        List<String> paths = List.of("setpoint.enabled", "setpoint.access.roles", "setpoint.access.requireLogin");
        TrustedProps t = new TrustedProps(paths, false, p -> nested(root).apply(p));
        t.initialize();
        assertTrue(TrustedProps.isShadow(t.values().get("setpoint.access.roles")));
        // the browser replaces the string with an open rule
        root[0] = JsonParser.parseString("{\"setpoint\":{\"enabled\":true,\"access\":{\"roles\":[]}}}");
        List<TrustedProps.Revert> reverts = t.onChange("setpoint", Origin.Browser, "setpoint.access");
        assertEquals(2, reverts.size());
        assertTrue(TrustedProps.isShadow(t.values().get("setpoint.access.roles")), "trusted stays shadowed");
        List<TrustedProps.Write> plan = TrustedProps.restorePlan(reverts, nested(root), t.values());
        assertEquals(1, plan.size(), "one write at the container");
        assertEquals("setpoint.access", plan.get(0).path());
        assertEquals(new JsonPrimitive("Engineer"), plan.get(0).value());
        assertEquals(List.of("setpoint.access.roles", "setpoint.access.requireLogin"), plan.get(0).covers());
        // apply the write -> restored
        root[0].getAsJsonObject().getAsJsonObject("setpoint").add("access", plan.get(0).value());
        assertTrue(TrustedProps.isRestored("setpoint.access.roles", t.values().get("setpoint.access.roles"), nested(root)));
        // a binding (not the browser) fixing the container is adopted
        root[0] = JsonParser.parseString("{\"setpoint\":{\"enabled\":true,\"access\":{\"roles\":[\"Engineer\"]}}}");
        assertTrue(t.onChange("setpoint", Origin.Binding, "setpoint.access").isEmpty());
        assertEquals(roles("Engineer"), t.values().get("setpoint.access.roles"));
        assertFalse(t.values().containsKey("setpoint.access.requireLogin"));
    }

    @Test
    void rebuildingAParentRestoresAShadowingContainerBelowIt() {
        // trusted: setpoint = {enabled:true, access:null}; the browser removed `setpoint`
        Map<String, JsonElement> trusted = new HashMap<>();
        trusted.put("setpoint.enabled", new JsonPrimitive(true));
        JsonElement marker = TrustedProps.shadow("setpoint.access", JsonNull.INSTANCE);
        trusted.put("setpoint.access.roles", marker);
        List<TrustedProps.Write> plan = TrustedProps.restorePlan(List.of(new TrustedProps.Revert("setpoint.access.roles", marker),
            new TrustedProps.Revert("setpoint.enabled", new JsonPrimitive(true))), p -> Optional.empty(), trusted);
        assertEquals(1, plan.size());
        assertEquals("setpoint", plan.get(0).path());
        assertEquals(JsonParser.parseString("{\"enabled\":true,\"access\":null}"), plan.get(0).value());
        assertEquals(2, plan.get(0).covers().size());
    }

    @Test
    void affectsAnyLimitsReLintToSecurityPaths() {
        List<String> keys = SecurityKeys.DISPLAY;
        assertTrue(TrustedProps.affectsAny("setpoint.enabled", keys));
        assertTrue(TrustedProps.affectsAny("props.setpoint.access.roles[3]", keys), "descendant");
        assertTrue(TrustedProps.affectsAny("menu", keys), "ancestor");
        assertTrue(TrustedProps.affectsAny(null, keys), "unknown path");
        assertFalse(TrustedProps.affectsAny("menu.trend.addLabel", keys));
        assertFalse(TrustedProps.affectsAny("setpoint.mode", keys));
        assertFalse(TrustedProps.affectsAny("bounds.lowColor", keys));
    }
}
