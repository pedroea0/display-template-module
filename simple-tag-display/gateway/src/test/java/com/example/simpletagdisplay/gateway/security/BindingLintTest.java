package com.example.simpletagdisplay.gateway.security;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.gson.JsonPrimitive;
import com.inductiveautomation.perspective.common.config.BindingConfig;
import com.inductiveautomation.perspective.common.config.PropertyConfig;
import org.junit.jupiter.api.Test;

/** Binding classification over sample property configs. */
class BindingLintTest {

    private static BindingConfig binding(String type, String configJson) {
        BindingConfig b = new BindingConfig();
        b.type = type;
        b.config = JsonParser.parseString(configJson).getAsJsonObject();
        return b;
    }

    private static BindingLint.Verdict classify(String path, String type, String configJson) {
        return BindingLint.classify(path, binding(type, configJson));
    }

    @Test
    void everyPropertyBindingIsUserControlled() {
        for (String src : List.of("view.params.editable", "view.custom.spEnabled", "this.custom.x", "parent.props.x",
                "../Sibling.props.enabled", "./Child.props.x", "/root.custom.x", "page.props.x", "session.custom.allow")) {
            BindingLint.Verdict v = classify("setpoint.enabled", "property", "{\"path\":\"" + src + "\"}");
            assertTrue(v.userControlled(), src);
            assertFalse(v.bidirectional(), src);
        }
    }

    @Test
    void sessionOwnedReadOnlyPropsAreNotUserControlled() {
        assertFalse(classify("setpoint.enabled", "property", "{\"path\":\"session.props.auth.authenticated\"}").userControlled());
        assertFalse(classify("setpoint.enabled", "property", "{\"path\":\"session.props.id\"}").userControlled());
        assertFalse(classify("setpoint.enabled", "expr",
            "{\"expression\":\"isAuthorized(false, 'Operator') && {session.props.auth.user.userName} != ''\"}").userControlled());
    }

    @Test
    void expressionsAreClassifiedByTheirReferences() {
        assertTrue(classify("enabled", "expr", "{\"expression\":\"{view.params.mode} = 2\"}").userControlled());
        assertTrue(classify("enabled", "expr", "{\"expression\":\"{../Toggle.props.selected}\"}").userControlled());
        assertFalse(classify("enabled", "expr", "{\"expression\":\"{[default]CTG/SpEnabled}\"}").userControlled(),
            "a tag reference is protected by the tag's own permissions");
        assertFalse(classify("enabled", "expr", "{\"expression\":\"dateExtract(now(), 'hour') > 6\"}").userControlled());
    }

    @Test
    void tagBindingsAreBidirectionalOnlyWhenConfiguredAndIndirectReferencesCount() {
        BindingLint.Verdict direct = classify("setpoint.enabled", "tag",
            "{\"mode\":\"direct\",\"tagPath\":\"[default]CTG/SpEnabled\",\"fallbackDelay\":2.5}");
        assertFalse(direct.userControlled());
        assertFalse(direct.bidirectional());
        BindingLint.Verdict bidi = classify("setpoint.enabled", "tag",
            "{\"mode\":\"direct\",\"tagPath\":\"[default]CTG/SpEnabled\",\"bidirectional\":true}");
        assertTrue(bidi.bidirectional());
        BindingLint.Verdict indirect = classify("setpoint.enabled", "tag",
            "{\"mode\":\"indirect\",\"tagPath\":\"[default]{1}/SpEnabled\",\"references\":{\"1\":\"{view.params.area}\"}}");
        assertTrue(indirect.userControlled());
    }

    @Test
    void bidirectionalPropertyBinding() {
        BindingLint.Verdict v = classify("setpoint.enabled", "property", "{\"path\":\"view.custom.spEnabled\",\"bidirectional\":true}");
        assertTrue(v.bidirectional());
        assertTrue(v.failsClosed(false), "bidirectional fails closed even with rejectBoundGates=false");
    }

    @Test
    void scriptTransformsReadingSelfAreUserControlled() {
        BindingConfig b = binding("expr", "{\"expression\":\"now()\"}");
        JsonObject t = new JsonObject();
        t.addProperty("type", "script");
        t.addProperty("code", "\treturn self.view.custom.allow");
        b.transforms = new JsonObject[] {t};
        assertTrue(BindingLint.classify("setpoint.enabled", b).userControlled());
    }

    @Test
    void disabledOrMissingBindingsAreIgnored() {
        assertNull(BindingLint.classify("enabled", null));
        BindingConfig b = binding("property", "{\"path\":\"view.params.x\"}");
        b.setEnabled(false);
        assertNull(BindingLint.classify("enabled", b));
    }

    @Test
    void gateKeysVersusTagPathAndTrendGroup() {
        BindingLint.Verdict tagPath = classify("tagPath", "property", "{\"path\":\"view.params.tagPath\"}");
        assertFalse(tagPath.isGateKey());
        assertFalse(tagPath.failsClosed(true));
        assertFalse(tagPath.risky());
        BindingLint.Verdict gate = classify("setpoint.access.roles", "property", "{\"path\":\"view.params.roles\"}");
        assertTrue(gate.failsClosed(true));
        assertFalse(gate.failsClosed(false));
        assertTrue(gate.risky());
    }

    @Test
    void inspectBuildsAReportAndGatesByPrefix() {
        Map<String, PropertyConfig> configs = new HashMap<>();
        PropertyConfig pc = new PropertyConfig();
        pc.binding = binding("property", "{\"path\":\"view.params.editable\"}");
        configs.put("setpoint.enabled", pc);
        PropertyConfig tp = new PropertyConfig();
        tp.binding = binding("property", "{\"path\":\"view.params.tagPath\"}");
        configs.put("tagPath", tp);
        BindingLint.LintReport r = BindingLint.inspect(p -> Optional.ofNullable(configs.get(p)), SecurityKeys.DISPLAY);
        assertTrue(r.inspected());
        assertEquals(2, r.verdicts().size());
        assertEquals(1, r.risky().size());
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), r.gate(true, "enabled", "setpoint"));
        assertEquals(Optional.empty(), r.gate(false, "enabled", "setpoint"));
        assertEquals(Optional.empty(), r.gate(true, "menu"));
        assertEquals(Optional.empty(), r.gate(true, "tagPath"));
    }

    @Test
    void lookupFailureMeansNotInspected() {
        BindingLint.LintReport r = BindingLint.inspect(p -> {
            throw new NoSuchMethodError("changed API");
        }, SecurityKeys.CHART);
        assertFalse(r.inspected());
        assertEquals(Optional.empty(), r.gate(true, "enabled"));
    }

    /** Records every looked-up path; answers from {@code configs}. */
    private static BindingLint.LintReport inspect(Map<String, PropertyConfig> configs, List<String> paths,
                                                  List<String> looked) {
        return BindingLint.inspect(p -> {
            looked.add(p);
            return Optional.ofNullable(configs.get(p));
        }, paths);
    }

    private static PropertyConfig config(String type, String json) {
        PropertyConfig pc = new PropertyConfig();
        pc.binding = binding(type, json);
        return pc;
    }

    @Test
    void everyAncestorOfASecurityLeafIsLookedUpOnce() {
        List<String> looked = new java.util.ArrayList<>();
        inspect(Map.of(), SecurityKeys.DISPLAY, looked);
        for (String p : List.of("setpoint", "setpoint.access", "setpoint.limits", "menu", "menu.trend",
                "menu.trend.access", "menu.configEdit", "menu.configEdit.access", "menu.changeHistory", "bounds",
                "alarms", "setpoint.access.roles", "tagPath")) {
            assertTrue(looked.contains(p), p);
        }
        assertEquals(new java.util.HashSet<>(looked).size(), looked.size(), "no path is looked up twice");
    }

    @Test
    void propertyBindingOnAnObjectClosesEveryGateBelowIt() {
        // props.setpoint bound to view.custom.sp.
        Map<String, PropertyConfig> configs = Map.of("setpoint", config("property", "{\"path\":\"view.custom.sp\"}"));
        BindingLint.LintReport r = inspect(configs, SecurityKeys.DISPLAY, new java.util.ArrayList<>());
        assertEquals(1, r.verdicts().size());
        BindingLint.Verdict v = r.verdict("setpoint").orElseThrow();
        assertTrue(v.isGateKey());
        assertTrue(v.userControlled());
        assertEquals(List.of(v), r.risky(), "one WARN for the ancestor");
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), r.gate(true, "enabled", "setpoint"));
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), r.gate(true, "setpoint.access"));
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), r.gate(true, "setpoint.enabled"));
        assertEquals(Optional.empty(), r.gate(false, "setpoint"), "one-way bindings only warn when opted out");
        assertEquals(Optional.empty(), r.gate(true, "menu", "enabled"));
        assertEquals(Optional.empty(), r.gate(true, "setpointX"), "prefix match is per path segment");
    }

    @Test
    void expressionBindingOnAnObjectClosesTheGatesBelowIt() {
        // props.menu bound to the expression {view.custom.menu}.
        Map<String, PropertyConfig> configs = Map.of("menu", config("expr", "{\"expression\":\"{view.custom.menu}\"}"));
        BindingLint.LintReport r = inspect(configs, SecurityKeys.DISPLAY, new java.util.ArrayList<>());
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), r.gate(true, "menu.configEdit"));
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), r.gate(true, "menu.trend.access"));
        assertEquals(Optional.empty(), r.gate(true, "setpoint"));
        // An object bound at a deeper level: menu.configEdit.access bound bidirectionally.
        Map<String, PropertyConfig> deep = Map.of("menu.configEdit.access",
            config("property", "{\"path\":\"session.custom.acl\",\"bidirectional\":true}"));
        BindingLint.LintReport d = inspect(deep, SecurityKeys.DISPLAY, new java.util.ArrayList<>());
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), d.gate(false, "menu.configEdit"));
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), d.gate(false, "menu"));
        assertEquals(Optional.empty(), d.gate(true, "menu.trend"));
    }

    @Test
    void sessionOwnedObjectBindingAndTagBindingOnObjectsStayOpen() {
        Map<String, PropertyConfig> configs = Map.of(
            "setpoint", config("tag", "{\"mode\":\"direct\",\"tagPath\":\"[default]CTG/SpConfig\"}"),
            "menu", config("property", "{\"path\":\"session.props.auth\"}"));
        BindingLint.LintReport r = inspect(configs, SecurityKeys.DISPLAY, new java.util.ArrayList<>());
        assertEquals(2, r.verdicts().size());
        assertTrue(r.risky().isEmpty());
        assertEquals(Optional.empty(), r.gate(true, "setpoint", "menu"));
    }

    // ---- bindings below a security leaf (array elements, fields of elements) -----------------

    /** Inspects {@code paths} with leaf values taken from {@code valuesJson} (an object leaf path -> JSON value). */
    private static BindingLint.LintReport inspectWithValues(Map<String, PropertyConfig> configs, List<String> paths,
                                                            String valuesJson, List<String> looked) {
        JsonObject values = JsonParser.parseString(valuesJson).getAsJsonObject();
        return BindingLint.inspect(p -> {
            looked.add(p);
            return Optional.ofNullable(configs.get(p));
        }, p -> Optional.ofNullable(values.get(p)), paths);
    }

    @Test
    void bindingOnAnArrayElementOfRolesClosesTheGate() {
        // props.setpoint.access.roles[0] -> view.custom.r (one-way),
        // props.menu.configEdit.access.roles[0] -> view.custom.r2 (bidirectional).
        Map<String, PropertyConfig> configs = Map.of(
            "setpoint.access.roles[0]", config("property", "{\"path\":\"view.custom.r\"}"),
            "menu.configEdit.access.roles[0]", config("property", "{\"path\":\"view.custom.r2\",\"bidirectional\":true}"));
        List<String> looked = new java.util.ArrayList<>();
        BindingLint.LintReport r = inspectWithValues(configs, SecurityKeys.DISPLAY,
            "{\"setpoint.access.roles\":[\"Engineer\"],\"menu.configEdit.access.roles\":[\"Engineer\"]}", looked);
        assertTrue(looked.contains("setpoint.access.roles[0]"));
        assertTrue(looked.contains("menu.configEdit.access.roles[0]"));
        assertEquals(2, r.verdicts().size());
        BindingLint.Verdict one = r.verdict("setpoint.access.roles[0]").orElseThrow();
        assertTrue(one.isGateKey());
        assertTrue(one.userControlled());
        BindingLint.Verdict bidi = r.verdict("menu.configEdit.access.roles[0]").orElseThrow();
        assertTrue(bidi.bidirectional());
        assertEquals(2, r.risky().size(), "one WARN per bound element");
        // Write gate (one-way, default true), and every prefix that reaches the element.
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), r.gate(true, "enabled", "setpoint"));
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), r.gate(true, "setpoint.access.roles"));
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), r.gate(true, "setpoint.access"));
        assertEquals(Optional.empty(), r.gate(false, "setpoint"), "one-way: only warned when opted out");
        // Bidirectional fails closed whatever the setting.
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), r.gate(false, "menu.configEdit"));
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), r.gate(false, "menu"));
        assertEquals(Optional.empty(), r.gate(true, "menu.trend"));
    }

    @Test
    void expressionBindingOnAChartRoleElementClosesTrendEdit() {
        Map<String, PropertyConfig> configs = Map.of(
            "trendEdit.access.roles[0]", config("expr", "{\"expression\":\"{view.custom.r}\"}"),
            "readScope.allowedRoots[1]", config("property", "{\"path\":\"page.props.path\"}"));
        BindingLint.LintReport r = inspectWithValues(configs, SecurityKeys.CHART,
            "{\"trendEdit.access.roles\":[\"Engineer\"],\"readScope.allowedRoots\":[\"[default]A\",\"[default]B\"]}",
            new java.util.ArrayList<>());
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), r.gate(true, "trendEdit"));
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), r.gate(true, "readScope.allowedRoots"));
        assertEquals(Optional.empty(), r.gate(true, "tagBrowser", "annotations"));
    }

    @Test
    void fieldsOfOptionElementsAndOddKeysAreLookedUp() {
        List<String> looked = new java.util.ArrayList<>();
        Map<String, PropertyConfig> configs = Map.of(
            "setpoint.options[1].value", config("property", "{\"path\":\"view.params.v\"}"));
        BindingLint.LintReport r = inspectWithValues(configs, SecurityKeys.DISPLAY,
            "{\"setpoint.options\":[{\"value\":1,\"label\":\"A\"},{\"value\":2,\"odd key\":{\"x.y\":[3]}}]}", looked);
        for (String p : List.of("setpoint.options[0]", "setpoint.options[0].value", "setpoint.options[0].label",
                "setpoint.options[1].value", "setpoint.options[1]['odd key']", "setpoint.options[1]['odd key']['x.y']",
                "setpoint.options[1]['odd key']['x.y'][0]")) {
            assertTrue(looked.contains(p), p);
        }
        assertEquals(new java.util.HashSet<>(looked).size(), looked.size(), "no path is looked up twice");
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), r.gate(true, "setpoint.options"));
        assertTrue(r.verdict("setpoint.options[1].value").orElseThrow().isGateKey());
    }

    @Test
    void scalarLeavesHaveNoDescendantLookups() {
        List<String> looked = new java.util.ArrayList<>();
        inspectWithValues(Map.of(), SecurityKeys.DISPLAY,
            "{\"tagPath\":\"[default]CTG/TempSP\",\"setpoint.enabled\":true,\"setpoint.access.roles\":[]}", looked);
        assertTrue(looked.stream().noneMatch(p -> p.startsWith("tagPath[") || p.startsWith("tagPath.")));
        assertTrue(looked.stream().noneMatch(p -> p.startsWith("setpoint.enabled[") || p.startsWith("setpoint.enabled.")));
        assertTrue(looked.stream().noneMatch(p -> p.startsWith("setpoint.access.roles[")));
    }

    @Test
    void aValueTooLargeOrTooDeepToWalkFailsItsGateClosed() {
        StringBuilder big = new StringBuilder("{\"setpoint.options\":[");
        for (int i = 0; i <= BindingLint.WALK_MAX_NODES; i++) {
            big.append(i == 0 ? "" : ",").append(i);
        }
        big.append("]}");
        BindingLint.LintReport r = inspectWithValues(Map.of(), SecurityKeys.DISPLAY, big.toString(),
            new java.util.ArrayList<>());
        BindingLint.Verdict v = r.verdict("setpoint.options").orElseThrow();
        assertTrue(v.unverified());
        assertTrue(v.failsClosed(false), "unverifiable fails closed whatever rejectBoundGates says");
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), r.gate(false, "setpoint"));

        String deep = "[".repeat(BindingLint.WALK_MAX_DEPTH + 1) + "]".repeat(BindingLint.WALK_MAX_DEPTH + 1);
        BindingLint.LintReport d = inspectWithValues(Map.of(), SecurityKeys.CHART,
            "{\"readScope.allowedRoots\":" + deep + "}", new java.util.ArrayList<>());
        assertTrue(d.verdict("readScope.allowedRoots").orElseThrow().unverified());
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), d.gate(false, "readScope"));

        // Exactly at the depth bound is still walked completely.
        String ok = "[".repeat(BindingLint.WALK_MAX_DEPTH) + "]".repeat(BindingLint.WALK_MAX_DEPTH);
        BindingLint.LintReport o = inspectWithValues(Map.of(), SecurityKeys.CHART,
            "{\"readScope.allowedRoots\":" + ok + "}", new java.util.ArrayList<>());
        assertEquals(Optional.empty(), o.gate(false, "readScope"));
    }

    @Test
    void anUnreadableLeafValueFailsItsGateClosed() {
        BindingLint.LintReport r = BindingLint.inspect(p -> Optional.empty(), p -> {
            if (p.equals("menu.trend.access.roles")) {
                throw new IllegalStateException("tree disposed");
            }
            return Optional.empty();
        }, SecurityKeys.DISPLAY);
        assertTrue(r.inspected());
        assertTrue(r.verdict("menu.trend.access.roles").orElseThrow().unverified());
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), r.gate(false, "menu.trend"));
        assertEquals(Optional.empty(), r.gate(false, "setpoint"));
    }

    @Test
    void mergeAddsNewVerdictsAndKeepsIdentityWhenNothingIsNew() {
        Map<String, PropertyConfig> start = Map.of("setpoint.enabled", config("property", "{\"path\":\"view.params.e\"}"));
        BindingLint.LintReport a = inspect(start, SecurityKeys.DISPLAY, new java.util.ArrayList<>());
        assertSame(a, a.merge(inspect(start, SecurityKeys.DISPLAY, new java.util.ArrayList<>())));
        assertSame(a, a.merge(BindingLint.LintReport.notInspected()));
        // A binding on roles[3] creates the element with its first value; the re-inspection then sees it.
        Map<String, PropertyConfig> later = new HashMap<>(start);
        later.put("setpoint.access.roles[3]", config("property", "{\"path\":\"view.custom.r\"}"));
        BindingLint.LintReport b = BindingLint.inspect(p -> Optional.ofNullable(later.get(p)),
            p -> p.equals("setpoint.access.roles")
                ? Optional.of(JsonParser.parseString("[\"a\",\"b\",\"c\",\"x\"]")) : Optional.empty(),
            SecurityKeys.DISPLAY);
        BindingLint.LintReport m = a.merge(b);
        assertEquals(2, m.verdicts().size());
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), m.gate(true, "setpoint.access.roles"));
        assertSame(m, m.merge(a), "verdicts are never dropped");
    }

    @Test
    void withinTreatsDotAndBracketAsSeparators() {
        assertTrue(BindingLint.within("setpoint.access.roles[0]", "setpoint.access.roles"));
        assertTrue(BindingLint.within("setpoint.access.roles", "setpoint.access.roles"));
        assertTrue(BindingLint.within("setpoint.options[1]['odd key']", "setpoint.options[1]"));
        assertFalse(BindingLint.within("setpoint.access.rolesX", "setpoint.access.roles"));
        assertFalse(BindingLint.within("setpoint", "setpoint.access"));
        assertEquals("a.b", BindingLint.childKey("a", "b"));
        assertEquals("a['b c']", BindingLint.childKey("a", "b c"));
        assertEquals("a['x.y']", BindingLint.childKey("a", "x.y"));
    }

    // ---- only evaluated text is scanned; robust self detection; stricter merge --------------------------

    private static BindingConfig withTransforms(BindingConfig b, String... transformsJson) {
        b.transforms = new JsonObject[transformsJson.length];
        for (int i = 0; i < transformsJson.length; i++) {
            b.transforms[i] = JsonParser.parseString(transformsJson[i]).getAsJsonObject();
        }
        return b;
    }

    @Test
    void tagDrivenGateWithValueTransformStaysOpen() {
        // A legitimate gate: setpoint.enabled from a tag, mapped by an expression transform on its input {value}.
        BindingConfig b = withTransforms(binding("tag", "{\"mode\":\"direct\",\"tagPath\":\"[default]CTG/SpEnabled\"}"),
            "{\"type\":\"expression\",\"expression\":\"{value} = 1 && {value.x} != 2 || {value[0]}\"}",
            "{\"type\":\"map\",\"inputType\":\"scalar\",\"outputType\":\"scalar\",\"mappings\":[{\"input\":\"{a}\",\"output\":true}],\"fallback\":false}",
            "{\"type\":\"format\",\"formatType\":\"numeric\",\"formatValue\":\"{0}\"}");
        BindingLint.Verdict v = BindingLint.classify("setpoint.enabled", b);
        assertFalse(v.userControlled());
        assertFalse(v.failsClosed(true));
    }

    @Test
    void expressionTransformReferencingAPropertyIsUserControlled() {
        BindingConfig b = withTransforms(binding("tag", "{\"mode\":\"direct\",\"tagPath\":\"[default]CTG/SpEnabled\"}"),
            "{\"type\":\"expression\",\"expression\":\"{value} && {view.params.allow}\"}");
        assertTrue(BindingLint.classify("setpoint.enabled", b).userControlled());
    }

    @Test
    void braceLiteralsInScriptsAndQuotedStringsAreNotReferences() {
        BindingConfig script = withTransforms(binding("tag", "{\"mode\":\"direct\",\"tagPath\":\"[default]CTG/Mode\"}"),
            "{\"type\":\"script\",\"code\":\"\tlookup = {1: True, 2: False}\n\t# self.view would be bad\n\treturn lookup.get(value, '{view.params.x}' == 'self')\"}");
        assertFalse(BindingLint.classify("setpoint.enabled", script).userControlled(), "dict literal, comment, string");
        assertFalse(classify("enabled", "expr", "{\"expression\":\"'{view.params.x}' = \\\"{page.props.y}\\\" || {[default]CTG/SpEnabled}\"}")
            .userControlled(), "references inside string literals are text");
        assertTrue(classify("enabled", "expr", "{\"expression\":\"'x' + {view.params.mode} = 'x2'\"}").userControlled());
    }

    @Test
    void selfIsDetectedInEverySpelling() {
        for (String code : new String[] {"return self.view.custom.x", "return self .view.params.x",
                "s = self\nreturn s.view.params.x", "return getattr(self, 'view').params.x", "return self['view']",
                "return (self\n  .session.custom.x)", "x = [self]\nreturn x[0].page.props.path"}) {
            BindingConfig b = withTransforms(binding("expr", "{\"expression\":\"now()\"}"),
                "{\"type\":\"script\",\"code\":" + new JsonPrimitive(code) + "}");
            assertTrue(BindingLint.classify("setpoint.enabled", b).userControlled(), code);
        }
        for (String code : new String[] {"return value", "myself = 1\nreturn value", "return value.self",
                "# self\nreturn 1", "return 'self.view'", "return \"\"\"self.view\"\"\"", "selfish = value\nreturn selfish"}) {
            BindingConfig b = withTransforms(binding("expr", "{\"expression\":\"now()\"}"),
                "{\"type\":\"script\",\"code\":" + new JsonPrimitive(code) + "}");
            assertFalse(BindingLint.classify("setpoint.enabled", b).userControlled(), code);
        }
    }

    @Test
    void indirectTagPlaceholdersAreNotReferences() {
        BindingLint.Verdict named = classify("setpoint.enabled", "tag",
            "{\"mode\":\"indirect\",\"tagPath\":\"[default]{area}/SpEnabled\",\"references\":{\"area\":\"Plant1\"}}");
        assertTrue(named.userControlled(), "a bare reference value is treated as a property path (fail closed)");
        BindingLint.Verdict tagRef = classify("setpoint.enabled", "tag",
            "{\"mode\":\"indirect\",\"tagPath\":\"[default]{area}/SpEnabled\",\"references\":{\"area\":\"{[default]CTG/Area}\"}}");
        assertFalse(tagRef.userControlled(), "placeholder {area} in tagPath is a name; the reference is a tag");
        BindingLint.Verdict exprMode = classify("setpoint.enabled", "tag",
            "{\"mode\":\"expression\",\"tagPath\":\"'[default]CTG/' + {session.custom.tag}\"}");
        assertTrue(exprMode.userControlled());
    }

    @Test
    void structAndQueryAndUnknownTypes() {
        assertTrue(classify("enabled", "expr-struct", "{\"struct\":{\"a\":\"{view.params.a}\",\"b\":\"1\"}}").userControlled());
        assertFalse(classify("enabled", "expr-struct", "{\"struct\":{\"a\":\"{session.props.auth.user.userName}\"}}").userControlled());
        assertTrue(classify("enabled", "query", "{\"queryPath\":\"Q/x\",\"parameters\":{\"p\":\"{page.props.path}\"}}").userControlled());
        assertFalse(classify("enabled", "query", "{\"queryPath\":\"Q/{weird}\",\"parameters\":{\"p\":\"42\"}}").userControlled(),
            "query path text is not evaluated");
        assertTrue(classify("enabled", "http", "{\"url\":\"https://x/{view.params.id}\"}").userControlled(),
            "unknown type: conservative scan");
    }

    @Test
    void mergeKeepsTheStricterVerdictForAnExistingPath() {
        Map<String, PropertyConfig> oneWay = Map.of("setpoint.enabled", config("property", "{\"path\":\"view.params.e\"}"));
        Map<String, PropertyConfig> bidi = Map.of("setpoint.enabled",
            config("property", "{\"path\":\"view.params.e\",\"bidirectional\":true}"));
        BindingLint.LintReport a = inspect(oneWay, SecurityKeys.DISPLAY, new java.util.ArrayList<>());
        BindingLint.LintReport b = inspect(bidi, SecurityKeys.DISPLAY, new java.util.ArrayList<>());
        assertEquals(Optional.empty(), a.gate(false, "setpoint"));
        BindingLint.LintReport m = a.merge(b);
        assertTrue(m.verdict("setpoint.enabled").orElseThrow().bidirectional());
        assertEquals(Optional.of(ErrorCode.BOUND_BIDIRECTIONAL), m.gate(false, "setpoint"));
        // the reverse direction never weakens
        BindingLint.LintReport back = m.merge(a);
        assertSame(m, back);
        assertTrue(back.verdict("setpoint.enabled").orElseThrow().bidirectional());
        // an unverified newer verdict also wins
        BindingLint.LintReport unver = BindingLint.inspect(p -> Optional.empty(), p -> {
            throw new IllegalStateException("x");
        }, List.of("setpoint.enabled"));
        assertTrue(a.merge(unver).verdict("setpoint.enabled").orElseThrow().unverified());
    }
}
