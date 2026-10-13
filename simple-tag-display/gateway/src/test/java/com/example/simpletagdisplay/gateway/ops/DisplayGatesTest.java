package com.example.simpletagdisplay.gateway.ops;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.delegate.PropsSnapshot;
import com.example.simpletagdisplay.gateway.security.BindingLint;
import com.example.simpletagdisplay.gateway.security.FloorPolicy;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.example.simpletagdisplay.gateway.tags.TagMetaReader;
import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.model.values.BasicQualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.tags.config.types.TagObjectType;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.Test;

/** Display Template gates: write / configEdit / trend / changeHistory order, limits (fail closed), step guard, options. */
class DisplayGatesTest {

    private static final UserContext OPERATOR = UserContext.of(true, "operator", List.of("Operator"), Set.of(), SessionScope.Client, true);
    private static final UserContext VIEWER = UserContext.of(true, "viewer", List.of(), Set.of(), SessionScope.Client, true);
    private static final UserContext ANON = UserContext.of(false, null, List.of(), Set.of(), SessionScope.Client, true);
    private static final UserContext DESIGNER_RO = UserContext.of(true, "eng", List.of("Engineer"), Set.of(), SessionScope.Designer, false);
    private static final FloorPolicy FLOOR = FloorPolicy.from(ModuleSettings.Settings.defaults(), w -> { });

    private static PropsSnapshot props(String json) {
        Map<String, JsonElement> m = new HashMap<>();
        JsonObject o = JsonParser.parseString(json).getAsJsonObject();
        for (Map.Entry<String, JsonElement> e : o.entrySet()) {
            m.put(e.getKey(), e.getValue());
        }
        return new PropsSnapshot(m, BindingLint.LintReport.clean(), true);
    }

    private static final String WRITABLE = "{\"tagPath\":\"[default]CTG/TempSP\",\"setpoint.enabled\":true,"
        + "\"setpoint.access.roles\":[\"Operator\"],\"setpoint.access.requireLogin\":true}";

    private static FloorPolicy floor(String... kv) {
        Map<String, String> m = new HashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put(kv[i], kv[i + 1]);
        }
        return FloorPolicy.from(ModuleSettings.Settings.read(m::get, w -> { }), w -> { });
    }

    @Test
    void writeGateOrder() {
        assertTrue(DisplayGates.write(props(WRITABLE), OPERATOR, FLOOR, "default", false).ok());
        assertEquals(ErrorCode.DISABLED, DisplayGates.write(props("{\"enabled\":false,\"setpoint.enabled\":true}"), OPERATOR,
            FLOOR, "default", false).error());
        assertEquals(ErrorCode.WRITE_DISABLED, DisplayGates.write(props("{\"tagPath\":\"[default]X\"}"), OPERATOR, FLOOR,
            "default", false).error());
        assertEquals(ErrorCode.NO_TAG_PATH, DisplayGates.write(props("{\"setpoint.enabled\":true}"), OPERATOR, FLOOR,
            "default", false).error());
        assertEquals(ErrorCode.INVALID_PATH, DisplayGates.write(props("{\"setpoint.enabled\":true,\"tagPath\":\"[default]_types_/U/M\"}"),
            OPERATOR, FLOOR, "default", false).error(), "_types_ folder");
        assertEquals(ErrorCode.INVALID_PATH, DisplayGates.write(props("{\"setpoint.enabled\":true,\"tagPath\":\"[System]Gateway/SystemName\"}"),
            OPERATOR, FLOOR, "default", false).error(), "denied provider");
        assertEquals(ErrorCode.INVALID_PATH, DisplayGates.write(props("{\"setpoint.enabled\":true,\"tagPath\":\"[default]CTG/Temp.EngUnit\"}"),
            OPERATOR, FLOOR, "default", false).error(), "property path");
        assertEquals(ErrorCode.AUTH_REQUIRED, DisplayGates.write(props(WRITABLE), ANON, FLOOR, "default", false).error(),
            "component roles need a login (floor off by default)");
        assertEquals(ErrorCode.FORBIDDEN_ROLE, DisplayGates.write(props(WRITABLE), VIEWER, FLOOR, "default", false).error());
        PropsSnapshot wrongCase = props(WRITABLE.replace("\"Operator\"", "\"operator\""));
        assertEquals(ErrorCode.FORBIDDEN_ROLE, DisplayGates.write(wrongCase, OPERATOR, FLOOR, "default", false).error(),
            "exact role case");
        assertEquals(ErrorCode.DESIGNER_READ_ONLY, DisplayGates.write(props(WRITABLE.replace("[\"Operator\"]", "[]")), DESIGNER_RO,
            FLOOR, "default", false).error());
        assertEquals(ErrorCode.AUDIT_UNAVAILABLE, DisplayGates.write(props(WRITABLE), OPERATOR, FLOOR, "default", true).error());
    }

    @Test
    void floorPolicyIsStricterThanProps() {
        PropsSnapshot open = props("{\"tagPath\":\"[default]CTG/Mode\",\"setpoint.enabled\":true,\"setpoint.access.requireLogin\":false}");
        assertTrue(DisplayGates.write(open, ANON, FLOOR, "default", false).ok(),
            "default floor lets anonymous write (native Perspective parity; tag permissions still apply)");
        assertTrue(DisplayGates.write(open, VIEWER, FLOOR, "default", false).ok(), "residual risk at default floors");
        DisplayGates.Target floorOn = DisplayGates.write(open, ANON, floor("ctg.write.requireAuthenticated", "true"),
            "default", false);
        assertEquals(ErrorCode.AUTH_REQUIRED, floorOn.error(), "opt-in floor: login required");
        assertEquals("ctg.write.requireAuthenticated", floorOn.setting(), "the component allows it: name the setting");
        assertEquals("{\"setting\":\"ctg.write.requireAuthenticated\"}", floorOn.details().toString());
        DisplayGates.Target roles = DisplayGates.write(open, VIEWER, floor("ctg.write.requiredRoles", "Operator"), "default", false);
        assertEquals(ErrorCode.FORBIDDEN_ROLE, roles.error());
        assertEquals("ctg.write.requiredRoles", roles.setting());
        DisplayGates.Target rolesAnon = DisplayGates.write(open, ANON, floor("ctg.write.requiredRoles", "Operator"), "default", false);
        assertEquals(ErrorCode.AUTH_REQUIRED, rolesAnon.error(), "a role floor asks anonymous users to log in first");
        assertEquals("ctg.write.requiredRoles", rolesAnon.setting());
        DisplayGates.Target roots = DisplayGates.write(open, OPERATOR, floor("ctg.write.allowedRoots", "[default]Other"),
            "default", false);
        assertEquals(ErrorCode.OUT_OF_SCOPE, roots.error());
        assertEquals("ctg.write.allowedRoots", roots.setting());
    }

    @Test
    void floorSettingIsNamedOnlyWhenTheComponentWouldAllow() {
        // component requires a login itself → the refusal is the component's, no gateway setting is named
        DisplayGates.Target both = DisplayGates.write(props(WRITABLE), ANON, floor("ctg.write.requireAuthenticated", "true"),
            "default", false);
        assertEquals(ErrorCode.AUTH_REQUIRED, both.error());
        assertNull(both.setting());
        assertNull(both.details());
        // component refusals never carry a setting
        DisplayGates.Target comp = DisplayGates.write(props(WRITABLE), VIEWER, FLOOR, "default", false);
        assertEquals(ErrorCode.FORBIDDEN_ROLE, comp.error());
        assertNull(comp.setting());
        // config edit: component access default requireLogin TRUE (kept), so the floor is not "the" reason for anonymous
        PropsSnapshot ce = props("{\"tagPath\":\"[default]CTG/TempSP\",\"menu.configEdit.enabled\":true}");
        DisplayGates.Target ceAnon = DisplayGates.configEdit(ce, ANON, floor("ctg.write.requireAuthenticated", "true"),
            "default", false);
        assertEquals(ErrorCode.AUTH_REQUIRED, ceAnon.error());
        assertNull(ceAnon.setting());
        DisplayGates.Target ceRoles = DisplayGates.configEdit(ce, VIEWER, floor("ctg.configEdit.requiredRoles", "Engineer"),
            "default", false);
        assertEquals(ErrorCode.FORBIDDEN_ROLE, ceRoles.error());
        assertEquals("ctg.configEdit.requiredRoles", ceRoles.setting());
    }

    @Test
    void setpointAccessDefaultsNoLoginButConfigEditAndHistoryKeepIt() {
        // setpoint.access.requireLogin absent → false; configEdit / changeHistory absent → true
        PropsSnapshot sp = props("{\"tagPath\":\"[default]CTG/TempSP\",\"setpoint.enabled\":true}");
        assertTrue(DisplayGates.write(sp, ANON, FLOOR, "default", false).ok());
        PropsSnapshot menu = props("{\"tagPath\":\"[default]CTG/TempSP\",\"menu.configEdit.enabled\":true,"
            + "\"menu.changeHistory.enabled\":true}");
        assertEquals(ErrorCode.AUTH_REQUIRED, DisplayGates.configEdit(menu, ANON, FLOOR, "default", false).error());
        assertEquals(ErrorCode.AUTH_REQUIRED, DisplayGates.changeHistory(menu, ANON, "default", true).error());
        assertTrue(DisplayGates.configEdit(menu, VIEWER, FLOOR, "default", false).ok());
        // a present but malformed requireLogin still fails closed (needs a login)
        PropsSnapshot bad = props("{\"tagPath\":\"[default]CTG/TempSP\",\"setpoint.enabled\":true,"
            + "\"setpoint.access.requireLogin\":\"no\"}");
        assertEquals(ErrorCode.AUTH_REQUIRED, DisplayGates.write(bad, ANON, FLOOR, "default", false).error());
    }

    @Test
    void designerOverridesListTheSettingsThatNarrowTheComponent() {
        PropsSnapshot open = props("{\"tagPath\":\"[default]CTG/Mode\",\"setpoint.enabled\":true}");
        assertEquals(List.of(), DisplayGates.writeOverrides(open, FLOOR, "default"), "defaults: nothing overrides");
        assertEquals(List.of("ctg.write.requireAuthenticated"), DisplayGates.writeOverrides(open,
            floor("ctg.write.requireAuthenticated", "true"), "default"));
        assertEquals(List.of(), DisplayGates.writeOverrides(props(WRITABLE), floor("ctg.write.requireAuthenticated", "true"),
            "default"), "the component already needs a login (roles)");
        assertEquals(List.of("ctg.write.requiredRoles"), DisplayGates.writeOverrides(props(WRITABLE),
            floor("ctg.write.requiredRoles", "Engineer"), "default"), "floor role not accepted by the component");
        assertEquals(List.of(), DisplayGates.writeOverrides(props(WRITABLE), floor("ctg.write.requiredRoles", "Operator,Engineer"),
            "default"), "every component role is a floor role: the floor adds nothing");
        assertEquals(List.of("ctg.write.allowedRoots"), DisplayGates.writeOverrides(open,
            floor("ctg.write.allowedRoots", "[default]Other"), "default"));
        assertEquals(List.of("ctg.write.deniedProviders"), DisplayGates.writeOverrides(props(
            "{\"tagPath\":\"[System]Gateway/SystemName\",\"setpoint.enabled\":true}"), FLOOR, "default"));
        assertEquals(List.of(), DisplayGates.writeOverrides(props("{\"tagPath\":\"[default]CTG/Mode\"}"),
            floor("ctg.write.requireAuthenticated", "true"), "default"), "setpoint off: no hint");
        PropsSnapshot ce = props("{\"tagPath\":\"[default]CTG/TempSP\",\"menu.configEdit.enabled\":true}");
        assertEquals(List.of("ctg.configEdit.requiredRoles"), DisplayGates.configEditOverrides(ce,
            floor("ctg.configEdit.requiredRoles", "Engineer", "ctg.write.requireAuthenticated", "true"), "default"),
            "config edit keeps requireLogin true, so only the role floor narrows it");
    }

    @Test
    void lintFailsTheGateClosed() {
        BindingLint.LintReport r = BindingLint.inspect(p -> {
            if (!p.equals("setpoint.enabled")) {
                return java.util.Optional.empty();
            }
            com.inductiveautomation.perspective.common.config.PropertyConfig pc = new com.inductiveautomation.perspective.common.config.PropertyConfig();
            pc.binding = new com.inductiveautomation.perspective.common.config.BindingConfig();
            pc.binding.type = "property";
            pc.binding.config = JsonParser.parseString("{\"path\":\"view.custom.x\",\"bidirectional\":true}").getAsJsonObject();
            return java.util.Optional.of(pc);
        }, com.example.simpletagdisplay.gateway.security.SecurityKeys.DISPLAY);
        Map<String, JsonElement> m = new HashMap<>();
        JsonParser.parseString(WRITABLE).getAsJsonObject().entrySet().forEach(e -> m.put(e.getKey(), e.getValue()));
        PropsSnapshot p = new PropsSnapshot(m, r, false);
        assertEquals(ErrorCode.BOUND_BIDIRECTIONAL, DisplayGates.write(p, OPERATOR, FLOOR, "default", false).error());
        assertTrue(DisplayGates.trend(p, OPERATOR, "default").ok(), "the trend gate is not covered by setpoint bindings");
    }

    @Test
    void configEditTrendAndHistoryGates() {
        PropsSnapshot p = props("{\"tagPath\":\"[default]CTG/TempSP\",\"menu.configEdit.enabled\":true,"
            + "\"menu.configEdit.access.roles\":[\"Engineer\"],\"menu.changeHistory.enabled\":true}");
        assertEquals(ErrorCode.FORBIDDEN_ROLE, DisplayGates.configEdit(p, VIEWER, FLOOR, "default", false).error());
        assertEquals(ErrorCode.AUTH_REQUIRED, DisplayGates.configEdit(p, ANON, FLOOR, "default", false).error());
        assertEquals(ErrorCode.ACTION_DISABLED, DisplayGates.configEdit(props("{\"tagPath\":\"[default]X\"}"), OPERATOR, FLOOR,
            "default", false).error());
        assertTrue(DisplayGates.trend(p, ANON, "default").ok(), "trend access default: no login");
        assertEquals(ErrorCode.ACTION_DISABLED, DisplayGates.trend(props("{\"tagPath\":\"[default]X\",\"menu.enabled\":false}"),
            OPERATOR, "default").error());
        assertEquals(ErrorCode.AUDIT_UNAVAILABLE, DisplayGates.changeHistory(p, OPERATOR, "default", false).error());
        assertTrue(DisplayGates.changeHistory(p, OPERATOR, "default", true).ok());
        assertEquals(ErrorCode.AUTH_REQUIRED, DisplayGates.changeHistory(p, ANON, "default", true).error());
        assertEquals(ErrorCode.ACTION_DISABLED, DisplayGates.changeHistory(props("{\"tagPath\":\"[default]X\"}"), OPERATOR,
            "default", true).error());
    }

    @Test
    void nonBooleanGateFlagsFailClosed() {
        // A binding delivering 0 / "false" / null must not count as "enabled".
        for (String bad : new String[] {"0", "1", "\"false\"", "\"true\"", "null", "{}", "[]"}) {
            assertEquals(ErrorCode.DISABLED, DisplayGates.write(props(WRITABLE.replace("{", "{\"enabled\":" + bad + ",")),
                OPERATOR, FLOOR, "default", false).error(), "enabled=" + bad);
            assertEquals(ErrorCode.WRITE_DISABLED, DisplayGates.write(props(WRITABLE.replace("\"setpoint.enabled\":true",
                "\"setpoint.enabled\":" + bad)), OPERATOR, FLOOR, "default", false).error(), "setpoint.enabled=" + bad);
            String trend = "{\"tagPath\":\"[default]CTG/Temp\",\"menu.trend.enabled\":" + bad + "}";
            assertEquals(ErrorCode.ACTION_DISABLED, DisplayGates.trend(props(trend), OPERATOR, "default").error(), trend);
            String menu = "{\"tagPath\":\"[default]CTG/Temp\",\"menu.enabled\":" + bad + "}";
            assertEquals(ErrorCode.ACTION_DISABLED, DisplayGates.trend(props(menu), OPERATOR, "default").error(), menu);
            String hist = "{\"tagPath\":\"[default]CTG/Temp\",\"menu.changeHistory.enabled\":true,\"menu.enabled\":" + bad + "}";
            assertEquals(ErrorCode.ACTION_DISABLED, DisplayGates.changeHistory(props(hist), OPERATOR, "default", true).error());
        }
        // absent keys keep their schema defaults
        assertTrue(DisplayGates.trend(props("{\"tagPath\":\"[default]CTG/Temp\"}"), OPERATOR, "default").ok());
        assertTrue(DisplayGates.write(props(WRITABLE), OPERATOR, FLOOR, "default", false).ok());
    }

    @Test
    void malformedAccessRulesFailClosed() {
        // roles bound to a string (or an array with non-strings) must not mean "no role restriction"
        PropsSnapshot strRoles = props(WRITABLE.replace("[\"Operator\"]", "\"Operator\""));
        assertEquals(ErrorCode.FORBIDDEN_ROLE, DisplayGates.write(strRoles, OPERATOR, FLOOR, "default", false).error());
        PropsSnapshot numRoles = props(WRITABLE.replace("[\"Operator\"]", "[\"Operator\",5]"));
        assertEquals(ErrorCode.FORBIDDEN_ROLE, DisplayGates.write(numRoles, OPERATOR, FLOOR, "default", false).error());
        String trend = "{\"tagPath\":\"[default]CTG/Temp\",\"menu.trend.access.securityLevels\":\"Authenticated\"}";
        assertEquals(ErrorCode.AUTH_REQUIRED, DisplayGates.trend(props(trend), ANON, "default").error());
        assertEquals(ErrorCode.FORBIDDEN_ROLE, DisplayGates.trend(props(trend), OPERATOR, "default").error());
        // requireLogin bound to a non-Boolean requires a login
        String login = "{\"tagPath\":\"[default]CTG/Temp\",\"menu.trend.access.requireLogin\":0}";
        assertEquals(ErrorCode.AUTH_REQUIRED, DisplayGates.trend(props(login), ANON, "default").error());
        // A PRESENT null list (binding to a missing tag / provider down) matches nobody;
        // only an ABSENT list means "no restriction" (schema default []).
        String nul = "{\"tagPath\":\"[default]CTG/Temp\",\"menu.trend.access.roles\":null}";
        assertEquals(ErrorCode.AUTH_REQUIRED, DisplayGates.trend(props(nul), ANON, "default").error());
        assertEquals(ErrorCode.FORBIDDEN_ROLE, DisplayGates.trend(props(nul), OPERATOR, "default").error());
        PropsSnapshot nullRoles = props(WRITABLE.replace("[\"Operator\"]", "null"));
        assertEquals(ErrorCode.FORBIDDEN_ROLE, DisplayGates.write(nullRoles, OPERATOR, FLOOR, "default", false).error());
        PropsSnapshot nullLevels = props(WRITABLE.replace("[\"Operator\"]", "[]").replace("}",
            ",\"setpoint.access.securityLevels\":null}"));
        assertEquals(ErrorCode.FORBIDDEN_ROLE, DisplayGates.write(nullLevels, OPERATOR, FLOOR, "default", false).error());
        assertTrue(DisplayGates.write(props(WRITABLE.replace("[\"Operator\"]", "[]")), OPERATOR, FLOOR, "default", false).ok(),
            "control: an empty (present) list is no restriction");
        assertTrue(DisplayGates.trend(props("{\"tagPath\":\"[default]CTG/Temp\"}"), ANON, "default").ok(),
            "control: absent lists keep the schema default");
    }

    /** Snapshot as the delegate builds it: trusted leaves read from a props tree through TrustedProps. */
    private static PropsSnapshot fromTree(String propsJson) {
        JsonObject tree = JsonParser.parseString(propsJson).getAsJsonObject();
        Map<String, JsonElement> m = new HashMap<>();
        for (String leaf : com.example.simpletagdisplay.gateway.security.SecurityKeys.DISPLAY) {
            com.example.simpletagdisplay.gateway.security.TrustedProps.readTrustForm(leaf, path -> {
                JsonElement cur = tree;
                for (String part : path.split("\\.")) {
                    if (cur == null || !cur.isJsonObject() || !cur.getAsJsonObject().has(part)) {
                        return java.util.Optional.empty();
                    }
                    cur = cur.getAsJsonObject().get(part);
                }
                return java.util.Optional.of(cur);
            }).ifPresent(v -> m.put(leaf, v));
        }
        return new PropsSnapshot(m, BindingLint.LintReport.clean(), true);
    }

    @Test
    void accessContainerThatIsNotAnObjectFailsClosed() {
        // access:"Engineer" / access:null used to hide all three leaves -> schema default -> open.
        String base = "{\"tagPath\":\"[default]CTG/TempSP\",\"setpoint\":{\"enabled\":true,\"access\":%s}}";
        assertTrue(DisplayGates.write(fromTree(String.format(base, "{\"roles\":[\"Operator\"]}")), OPERATOR, FLOOR, "default",
            false).ok(), "control");
        assertEquals(ErrorCode.FORBIDDEN_ROLE, DisplayGates.write(fromTree(String.format(base, "{\"roles\":[\"Engineer\"]}")),
            OPERATOR, FLOOR, "default", false).error(), "control");
        for (String bad : new String[] {"\"Operator\"", "null", "5", "[\"Operator\"]", "true"}) {
            PropsSnapshot p = fromTree(String.format(base, bad));
            assertTrue(p.shadowed("setpoint.access.roles"), bad);
            assertEquals(ErrorCode.FORBIDDEN_ROLE, DisplayGates.write(p, OPERATOR, FLOOR, "default", false).error(),
                "access=" + bad);
            assertEquals(ErrorCode.AUTH_REQUIRED, DisplayGates.write(p, ANON, FLOOR, "default", false).error(), "access=" + bad);
        }
        // absent access keeps the schema default (no roles, login required)
        PropsSnapshot absent = fromTree("{\"tagPath\":\"[default]CTG/TempSP\",\"setpoint\":{\"enabled\":true}}");
        assertFalse(absent.shadowed("setpoint.access.roles"));
        assertTrue(DisplayGates.write(absent, OPERATOR, FLOOR, "default", false).ok());
        // the same for the menu rules, one level higher, and for gate flags below a non-object container
        String menu = "{\"tagPath\":\"[default]CTG/Temp\",\"menu\":{\"trend\":%s}}";
        assertTrue(DisplayGates.trend(fromTree(String.format(menu, "{\"enabled\":true}")), ANON, "default").ok(), "control");
        assertEquals(ErrorCode.ACTION_DISABLED, DisplayGates.trend(fromTree(String.format(menu, "null")), ANON, "default").error(),
            "menu.trend:null -> enabled shadowed -> off");
        assertEquals(ErrorCode.ACTION_DISABLED, DisplayGates.trend(fromTree("{\"tagPath\":\"[default]CTG/Temp\",\"menu\":\"x\"}"),
            ANON, "default").error());
        String hist = "{\"tagPath\":\"[default]CTG/Temp\",\"menu\":{\"changeHistory\":{\"enabled\":true,\"access\":\"Operator\"}}}";
        assertEquals(ErrorCode.FORBIDDEN_ROLE, DisplayGates.changeHistory(fromTree(hist), OPERATOR, "default", true).error());
        String cfg = "{\"tagPath\":\"[default]CTG/Temp\",\"menu\":{\"configEdit\":{\"enabled\":true,\"access\":null}}}";
        assertEquals(ErrorCode.FORBIDDEN_ROLE, DisplayGates.configEdit(fromTree(cfg), OPERATOR, FLOOR, "default", false).error());
        // a non-object limits container: explicit sides shadowed -> LIMITS_INVALID, not "open"
        TagMetaReader.Meta eng = meta(0.0, 100.0, DataType.Float8, true, TagObjectType.AtomicTag);
        assertEquals(ErrorCode.LIMITS_INVALID, DisplayGates.limits(fromTree("{\"setpoint\":{\"limits\":null}}"), DataType.Float8,
            eng).error());
    }

    @Test
    void staleTargetComparesNormalizedKeys() {
        TagPaths.Parsed p = TagPaths.parse("[default]CTG/TempSP", "default");
        assertTrue(DisplayGates.sameTarget("[DEFAULT]ctg/tempsp", p.path(), "default"));
        assertTrue(DisplayGates.sameTarget("[~]CTG/TempSP", p.path(), "default"));
        assertFalse(DisplayGates.sameTarget("[default]CTG/Temp", p.path(), "default"));
        assertFalse(DisplayGates.sameTarget(null, p.path(), "default"));
    }

    // ---- tag facts, limits, step guard, options ----

    private static QualifiedValue qv(Object v, QualityCode q) {
        return new BasicQualifiedValue(v, q, new Date());
    }

    private static TagMetaReader.Meta meta(Object low, Object high, DataType dt, Boolean canWrite, TagObjectType type) {
        Map<String, QualifiedValue> m = new HashMap<>();
        m.put(TagMetaReader.ENG_LOW, qv(low, low == null ? QualityCode.Bad_NotFound : QualityCode.Good));
        m.put(TagMetaReader.ENG_HIGH, qv(high, high == null ? QualityCode.Bad_NotFound : QualityCode.Good));
        m.put(TagMetaReader.DATA_TYPE, qv(dt, QualityCode.Good));
        m.put(TagMetaReader.CAN_WRITE, qv(canWrite, QualityCode.Good));
        m.put(TagMetaReader.TAG_TYPE, qv(type, QualityCode.Good));
        return new TagMetaReader.Meta(m);
    }

    @Test
    void tagFacts() {
        TagMetaReader.Meta ok = meta(0.0, 100.0, DataType.Float8, true, TagObjectType.AtomicTag);
        assertNull(DisplayGates.tagFacts(qv(75.0, QualityCode.Good), ok, false, true, true));
        assertEquals(ErrorCode.TAG_NOT_FOUND, DisplayGates.tagFacts(qv(null, QualityCode.Bad_NotFound), ok, false, true, true));
        assertEquals(ErrorCode.ACCESS_DENIED, DisplayGates.tagFacts(qv(null, QualityCode.Bad_AccessDenied), ok, false, true, true));
        assertEquals(ErrorCode.INVALID_PATH, DisplayGates.tagFacts(qv(null, QualityCode.Good),
            meta(0.0, 1.0, DataType.Float8, true, TagObjectType.Folder), false, true, true), "folder named Alarms etc.");
        assertEquals(ErrorCode.READ_ONLY, DisplayGates.tagFacts(qv(1.0, QualityCode.Good),
            meta(0.0, 1.0, DataType.Float8, false, TagObjectType.AtomicTag), false, true, true));
        Map<String, QualifiedValue> perm = new HashMap<>();
        perm.put(TagMetaReader.CAN_WRITE, qv(false, QualityCode.Good));
        perm.put(TagMetaReader.READ_ONLY, qv(false, QualityCode.Good));
        perm.put(TagMetaReader.DATA_TYPE, qv(DataType.Float8, QualityCode.Good));
        perm.put(TagMetaReader.TAG_TYPE, qv(TagObjectType.AtomicTag, QualityCode.Good));
        assertNull(DisplayGates.tagFacts(qv(1.0, QualityCode.Good), new TagMetaReader.Meta(perm), false, true, true),
            "CanWrite false for this user but not read-only: left to the provider (WRITE_DENIED, audited)");
        perm.put(TagMetaReader.READ_ONLY, qv(true, QualityCode.Good));
        assertEquals(ErrorCode.READ_ONLY, DisplayGates.tagFacts(qv(1.0, QualityCode.Good), new TagMetaReader.Meta(perm), false, true, true));
        assertEquals(ErrorCode.UNSUPPORTED_TYPE, DisplayGates.tagFacts(qv(1.0, QualityCode.Good),
            meta(null, null, DataType.DateTime, true, TagObjectType.AtomicTag), false, true, true));
        assertEquals(ErrorCode.BAD_QUALITY, DisplayGates.tagFacts(qv(1.0, QualityCode.Bad_NotConnected), ok, false, true, true));
        assertNull(DisplayGates.tagFacts(qv(1.0, QualityCode.Bad_NotConnected), ok, true, true, true), "allowOnBadQuality");
        assertNull(DisplayGates.tagFacts(qv(1.0, QualityCode.Bad_NotConnected), ok, false, false, false), "config edit");
    }

    @Test
    void limitsFailClosed() {
        TagMetaReader.Meta eng = meta(0.0, 100.0, DataType.Float8, true, TagObjectType.AtomicTag);
        DisplayGates.Limits l = DisplayGates.limits(props("{}"), DataType.Float8, eng);
        assertTrue(l.applies());
        assertNull(l.error());
        assertTrue(l.contains(0) && l.contains(100) && !l.contains(100.001) && !l.contains(-1));
        assertEquals("eng", l.toJson().getAsJsonObject().get("source").getAsString());
        DisplayGates.Limits exclusive = DisplayGates.limits(props("{\"setpoint.limits.inclusive\":false}"), DataType.Float8, eng);
        assertFalse(exclusive.contains(100));
        DisplayGates.Limits mixed = DisplayGates.limits(props("{\"setpoint.limits.high\":50}"), DataType.Float8, eng);
        assertEquals(50.0, mixed.high());
        assertEquals("mixed", mixed.toJson().getAsJsonObject().get("source").getAsString());
        assertEquals(ErrorCode.LIMITS_UNAVAILABLE, DisplayGates.limits(props("{}"), DataType.Float8,
            meta(null, 100.0, DataType.Float8, true, TagObjectType.AtomicTag)).error());
        assertEquals(ErrorCode.LIMITS_UNAVAILABLE, DisplayGates.limits(props("{}"), DataType.Float8,
            meta(Double.NaN, 100.0, DataType.Float8, true, TagObjectType.AtomicTag)).error());
        assertNull(DisplayGates.limits(props("{\"setpoint.limits.low\":0,\"setpoint.limits.high\":10}"), DataType.Float8,
            meta(null, null, DataType.Float8, true, TagObjectType.AtomicTag)).error(), "explicit limits need no eng values");
        assertEquals(ErrorCode.LIMITS_INVALID, DisplayGates.limits(props("{\"setpoint.limits.low\":\"x\"}"), DataType.Float8, eng).error());
        assertEquals(ErrorCode.LIMITS_INVALID, DisplayGates.limits(props("{\"setpoint.limits.low\":200}"), DataType.Float8, eng).error(),
            "low > high");
        DisplayGates.Limits open = DisplayGates.limits(props("{\"setpoint.limits.useEngLimits\":false}"), DataType.Float8,
            meta(null, null, DataType.Float8, true, TagObjectType.AtomicTag));
        assertNull(open.error());
        assertTrue(open.contains(1e9));
        assertEquals("none", open.toJson().getAsJsonObject().get("source").getAsString());
        assertFalse(DisplayGates.limits(props("{\"setpoint.options\":[{\"value\":1}]}"), DataType.Int4, eng).applies(),
            "options-only setpoints skip limits");
        assertFalse(DisplayGates.limits(props("{}"), DataType.String, eng).applies());
        assertTrue(DisplayGates.limits(props("{}"), DataType.String, eng).toJson().isJsonNull());
        JsonObject d = l.details();
        assertEquals(0.0, d.get("low").getAsDouble());
        assertEquals(100.0, d.get("high").getAsDouble());
    }

    @Test
    void stepGuard() {
        TagMetaReader.Meta eng = meta(0.0, 100.0, DataType.Float8, true, TagObjectType.AtomicTag);
        PropsSnapshot abs = props("{\"setpoint.maxStep\":10}");
        DisplayGates.Limits l = DisplayGates.limits(abs, DataType.Float8, eng);
        assertNull(DisplayGates.stepViolation(abs, 75, 85, l));
        JsonObject v = DisplayGates.stepViolation(abs, 75, 85.5, l);
        assertEquals(10.0, v.get("max").getAsDouble());
        assertEquals(10.5, v.get("delta").getAsDouble());
        PropsSnapshot pct = props("{\"setpoint.maxStepPercent\":5}");
        assertEquals(5.0, DisplayGates.stepViolation(pct, 50, 56, DisplayGates.limits(pct, DataType.Float8, eng))
            .get("max").getAsDouble());
        assertNull(DisplayGates.stepViolation(pct, 50, 55, DisplayGates.limits(pct, DataType.Float8, eng)));
        JsonObject nf = DisplayGates.stepViolation(abs, Double.NaN, 50, l);
        assertEquals(10.0, nf.get("max").getAsDouble(), "guard configured + no finite previous value: fail closed");
        assertTrue(nf.get("delta").isJsonNull());
        assertEquals("notFinite", nf.get("previous").getAsString());
        assertEquals("notFinite", DisplayGates.stepViolation(pct, Double.NaN, 50,
            DisplayGates.limits(pct, DataType.Float8, eng)).get("previous").getAsString());
        assertNull(DisplayGates.stepViolation(props("{}"), Double.NaN, 50, l), "no guard configured: not-finite is fine");
        assertNull(DisplayGates.stepViolation(props("{}"), 0, 1000, l), "no guard configured");
        assertEquals(ErrorCode.LIMITS_INVALID, DisplayGates.stepConfigError(props("{\"setpoint.maxStep\":-1}")));
        assertEquals(ErrorCode.LIMITS_INVALID, DisplayGates.stepConfigError(props("{\"setpoint.maxStepPercent\":\"5\"}")));
        assertNull(DisplayGates.stepConfigError(props("{\"setpoint.maxStep\":null}")));
    }

    @Test
    void options() {
        PropsSnapshot p = props("{\"setpoint.options\":[{\"value\":0},{\"value\":1,\"label\":\"Auto\"},{\"value\":\"2\"},"
            + "{\"value\":3,\"isDisabled\":true}]}");
        assertTrue(DisplayGates.isAllowedOption(p, 1, DataType.Int4, 255));
        assertTrue(DisplayGates.isAllowedOption(p, 2, DataType.Int4, 255), "option values are coerced too");
        assertFalse(DisplayGates.isAllowedOption(p, 3, DataType.Int4, 255), "disabled option");
        assertFalse(DisplayGates.isAllowedOption(p, 7, DataType.Int4, 255));
        assertTrue(DisplayGates.isAllowedOption(props("{}"), 7, DataType.Int4, 255), "no options: anything");
        PropsSnapshot bools = props("{\"setpoint.options\":[{\"value\":true,\"label\":\"Run\"}]}");
        assertTrue(DisplayGates.isAllowedOption(bools, true, DataType.Boolean, 255));
        assertFalse(DisplayGates.isAllowedOption(bools, false, DataType.Boolean, 255));
        // Only an absent or Boolean-false isDisabled leaves an option selectable.
        for (String bad : new String[] {"\"true\"", "\"false\"", "0", "1", "null", "{}"}) {
            PropsSnapshot o = props("{\"setpoint.options\":[{\"value\":50},{\"value\":51,\"isDisabled\":" + bad + "}]}");
            assertFalse(DisplayGates.isAllowedOption(o, 51, DataType.Int4, 255), "isDisabled=" + bad);
            assertTrue(DisplayGates.isAllowedOption(o, 50, DataType.Int4, 255));
        }
        assertTrue(DisplayGates.isAllowedOption(props("{\"setpoint.options\":[{\"value\":51,\"isDisabled\":false}]}"), 51,
            DataType.Int4, 255));
        // malformed options (null / not an array) refuse everything instead of becoming free entry
        for (String bad : new String[] {"null", "\"50,51\"", "{}", "5"}) {
            PropsSnapshot o = props("{\"setpoint.options\":" + bad + "}");
            assertTrue(DisplayGates.hasOptions(o), bad);
            assertFalse(DisplayGates.isAllowedOption(o, 51, DataType.Int4, 255), "options=" + bad);
        }
        assertFalse(DisplayGates.hasOptions(props("{\"setpoint.options\":[]}")));
        assertTrue(DisplayGates.isAllowedOption(props("{\"setpoint.options\":[]}"), 7, DataType.Int4, 255));
    }

    @Test
    void nonBooleanInclusiveIsExclusive() {
        TagMetaReader.Meta eng = meta(0.0, 100.0, DataType.Float8, true, TagObjectType.AtomicTag);
        for (String bad : new String[] {"\"true\"", "1", "null"}) {
            DisplayGates.Limits l = DisplayGates.limits(props("{\"setpoint.limits.inclusive\":" + bad + "}"), DataType.Float8, eng);
            assertFalse(l.inclusive(), bad);
            assertFalse(l.contains(100), bad);
        }
        assertTrue(DisplayGates.limits(props("{}"), DataType.Float8, eng).inclusive(), "absent: schema default inclusive");
        assertTrue(DisplayGates.limits(props("{\"setpoint.limits.useEngLimits\":\"false\"}"), DataType.Float8,
            meta(null, null, DataType.Float8, true, TagObjectType.AtomicTag)).error() == ErrorCode.LIMITS_UNAVAILABLE,
            "non-Boolean useEngLimits keeps the stricter true");
    }

    @Test
    void writeResultMapping() {
        assertNull(DisplayOps.mapWrite(QualityCode.Good));
        assertEquals(ErrorCode.WRITE_DENIED, DisplayOps.mapWrite(QualityCode.Bad_AccessDenied));
        assertEquals(ErrorCode.READ_ONLY, DisplayOps.mapWrite(QualityCode.Bad_ReadOnly));
        assertEquals(ErrorCode.TAG_NOT_FOUND, DisplayOps.mapWrite(QualityCode.Bad_NotFound));
        assertEquals(ErrorCode.WRITE_FAILED, DisplayOps.mapWrite(QualityCode.Bad_NotConnected));
        assertEquals(ErrorCode.WRITE_FAILED, DisplayOps.mapWrite(null));
        assertEquals("popup", DisplayOps.editMode("popup"));
        assertEquals("unknown", DisplayOps.editMode("inline"));
        assertEquals("unknown", DisplayOps.editMode(null));
    }
}
