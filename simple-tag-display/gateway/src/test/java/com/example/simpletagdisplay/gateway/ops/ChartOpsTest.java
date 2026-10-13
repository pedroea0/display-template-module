package com.example.simpletagdisplay.gateway.ops;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.delegate.PropsSnapshot;
import com.example.simpletagdisplay.gateway.security.BindingLint;
import com.example.simpletagdisplay.gateway.security.SecurityKeys;
import com.example.simpletagdisplay.gateway.security.TrustedProps;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.example.simpletagdisplay.gateway.tags.HistoryAvailability;
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
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.Test;

/** Pen naming + keys, the chart gates (trendEdit, browse, annotations), pen classification, live values, meta cache. */
class ChartOpsTest {

    private static final UserContext ENGINEER = UserContext.of(true, "engineer", List.of("Engineer", "Operator"), Set.of(),
        SessionScope.Client, true);
    private static final UserContext VIEWER = UserContext.of(true, "viewer", List.of(), Set.of(), SessionScope.Client, true);
    private static final UserContext ANON = UserContext.of(false, null, List.of(), Set.of(), SessionScope.Client, true);
    private static final UserContext DESIGNER_RO = UserContext.of(true, "eng", List.of("Engineer"), Set.of(),
        SessionScope.Designer, false);

    /** Trusted snapshot from a props tree (TrustedProps trust form: shadow markers for non-object ancestors). */
    private static PropsSnapshot tree(String json) {
        JsonObject root = JsonParser.parseString(json).getAsJsonObject();
        Map<String, JsonElement> m = new HashMap<>();
        for (String leaf : SecurityKeys.CHART) {
            TrustedProps.readTrustForm(leaf, path -> {
                JsonElement cur = root;
                for (String part : path.split("\\.")) {
                    if (cur == null || !cur.isJsonObject() || !cur.getAsJsonObject().has(part)) {
                        return Optional.empty();
                    }
                    cur = cur.getAsJsonObject().get(part);
                }
                return Optional.of(cur);
            }).ifPresent(v -> m.put(leaf, v));
        }
        return new PropsSnapshot(m, BindingLint.LintReport.clean(), true);
    }

    private static TagPath path(String s) {
        return TagPaths.parse(s, "default").path();
    }

    // ---- names and keys ------------------------------------------------------------------------------------------

    @Test
    void shortestUniqueSuffix() {
        List<ChartOps.NameInput> in = new ArrayList<>();
        in.add(new ChartOps.NameInput("", path("[default]Area1/Tank/Temp"), null));
        in.add(new ChartOps.NameInput("", path("[default]Area2/Tank/Temp"), null));
        in.add(new ChartOps.NameInput("", path("[default]CTG/Pressure"), null));
        in.add(new ChartOps.NameInput("My pen", path("[default]CTG/Counter"), null));
        in.add(new ChartOps.NameInput("", path("[default]X/Counter"), null));
        in.add(new ChartOps.NameInput("", null, "[default]CTG/.."));
        in.add(new ChartOps.NameInput("", path("[default]B/Level"), null));
        in.add(new ChartOps.NameInput("", path("[default]A/b/Level"), null));
        assertEquals(List.of("Area1/Tank/Temp", "Area2/Tank/Temp", "Pressure", "My pen", "Counter", "[default]CTG/..",
            "[default]B/Level", "A/b/Level"), ChartOps.penNames(in), "suffixes compare case-insensitively");
    }

    @Test
    void namesCollideWithExplicitNamesAndDuplicatesUseTheFullPath() {
        List<ChartOps.NameInput> in = new ArrayList<>();
        in.add(new ChartOps.NameInput("temp", path("[default]CTG/Pressure"), null));
        in.add(new ChartOps.NameInput("", path("[default]CTG/Temp"), null));
        in.add(new ChartOps.NameInput("", path("[default]Temp"), null));
        in.add(new ChartOps.NameInput("", path("[default]Temp"), null));
        List<String> names = ChartOps.penNames(in);
        assertEquals("temp", names.get(0));
        assertEquals("CTG/Temp", names.get(1), "'Temp' is taken by an explicit name (case-insensitive)");
        assertEquals("[default]Temp", names.get(2), "no longer suffix exists: the full path");
        assertEquals("[default]Temp", names.get(3), "the same tag twice keeps the full path");
    }

    @Test
    void penKeysAreNormalized() {
        // "t:" + normalizedKey: every spelling of one tag gives the same trend pen key.
        assertEquals(TagPaths.normalizedKey(path("[default]CTG/Temp")), TagPaths.normalizedKey(path("[DEFAULT]ctg/TEMP")));
        assertEquals("[default]ctg/temp", TagPaths.normalizedKey(path("CTG/Temp.Value")));
    }

    // ---- gates ---------------------------------------------------------------------------------------------------

    @Test
    void trendEditGate() {
        assertEquals(Optional.empty(), ChartOps.trendEditGate(tree("{}"), ANON, "default"), "defaults: anyone");
        assertEquals(Optional.of(ErrorCode.DISABLED), ChartOps.trendEditGate(tree("{\"enabled\":false}"), ENGINEER, "default"));
        assertEquals(Optional.of(ErrorCode.ACTION_DISABLED),
            ChartOps.trendEditGate(tree("{\"trendEdit\":{\"enabled\":false}}"), ENGINEER, "default"));
        assertEquals(Optional.of(ErrorCode.ACTION_DISABLED), ChartOps.trendEditGate(tree("{}"), ENGINEER, null),
            "a chart that ignores the trend list cannot edit it");
        PropsSnapshot eng = tree("{\"trendEdit\":{\"access\":{\"roles\":[\"Engineer\"]}}}");
        assertEquals(Optional.of(ErrorCode.FORBIDDEN_ROLE), ChartOps.trendEditGate(eng, VIEWER, "default"));
        assertEquals(Optional.of(ErrorCode.AUTH_REQUIRED), ChartOps.trendEditGate(eng, ANON, "default"));
        assertEquals(Optional.empty(), ChartOps.trendEditGate(eng, ENGINEER, "default"));
        // fail closed
        for (String bad : new String[] {"{\"enabled\":\"true\"}", "{\"enabled\":null}", "{\"trendEdit\":{\"enabled\":1}}"}) {
            assertTrue(ChartOps.trendEditGate(tree(bad), ENGINEER, "default").isPresent(), bad);
        }
        for (String bad : new String[] {"{\"trendEdit\":{\"access\":\"Engineer\"}}", "{\"trendEdit\":{\"access\":null}}",
            "{\"trendEdit\":{\"access\":{\"roles\":null}}}", "{\"trendEdit\":{\"access\":{\"roles\":\"Engineer\"}}}"}) {
            assertEquals(Optional.of(ErrorCode.FORBIDDEN_ROLE), ChartOps.trendEditGate(tree(bad), ENGINEER, "default"), bad);
        }
        assertEquals(Optional.of(ErrorCode.ACTION_DISABLED), ChartOps.trendEditGate(tree("{\"trendEdit\":null}"), ENGINEER,
            "default"), "shadowed enabled flag reads false");
    }

    @Test
    void browseGate() {
        assertEquals(Optional.empty(), ChartOps.browseGate(tree("{}"), ANON), "default on (Power Chart parity)");
        assertEquals(Optional.of(ErrorCode.ACTION_DISABLED), ChartOps.browseGate(tree("{\"tagBrowser\":{\"enabled\":false}}"),
            ENGINEER), "explicitly off");
        PropsSnapshot on = tree("{\"tagBrowser\":{\"enabled\":true}}");
        assertEquals(Optional.empty(), ChartOps.browseGate(on, ANON));
        assertEquals(Optional.empty(), ChartOps.browseGate(tree("{\"enabled\":false,\"tagBrowser\":{\"enabled\":true}}"),
            ANON), "root enabled:false still allows browsing");
        PropsSnapshot eng = tree("{\"tagBrowser\":{\"enabled\":true,\"access\":{\"roles\":[\"Engineer\"]}}}");
        assertEquals(Optional.of(ErrorCode.FORBIDDEN_ROLE), ChartOps.browseGate(eng, VIEWER), "browse roles");
        assertEquals(Optional.empty(), ChartOps.browseGate(eng, ENGINEER));
        assertEquals(Optional.of(ErrorCode.FORBIDDEN_ROLE),
            ChartOps.browseGate(tree("{\"tagBrowser\":{\"enabled\":true,\"access\":[\"Engineer\"]}}"), ENGINEER));
    }

    @Test
    void annotationsCapability() {
        JsonObject off = ChartOps.annotationsCapability(tree("{}"), ENGINEER);
        assertFalse(off.get("allowed").getAsBoolean());
        assertEquals("ACTION_DISABLED", off.get("reason").getAsString());
        JsonObject view = ChartOps.annotationsCapability(tree("{\"annotations\":{\"enabled\":true}}"), ENGINEER);
        assertTrue(view.get("allowed").getAsBoolean());
        assertFalse(view.get("editAllowed").getAsBoolean());
        String edit = "{\"annotations\":{\"enabled\":true,\"edit\":{\"enabled\":true,\"access\":{\"roles\":[\"Engineer\"]}},"
            + "\"moderate\":{\"enabled\":true,\"access\":{\"roles\":[\"Engineer\"]}}}}";
        JsonObject eng = ChartOps.annotationsCapability(tree(edit), ENGINEER);
        assertTrue(eng.get("editAllowed").getAsBoolean());
        assertTrue(eng.get("moderateAllowed").getAsBoolean());
        assertTrue(eng.get("reason").isJsonNull());
        JsonObject viewer = ChartOps.annotationsCapability(tree(edit), VIEWER);
        assertFalse(viewer.get("editAllowed").getAsBoolean());
        assertEquals("FORBIDDEN_ROLE", viewer.get("reason").getAsString());
        assertEquals("DESIGNER_READ_ONLY", ChartOps.annotationsCapability(tree(edit), DESIGNER_RO).get("reason").getAsString());
    }

    @Test
    void trendGroupOfTheChart() {
        assertEquals("default", ChartOps.trendGroup(tree("{}")), "absent = schema default");
        assertNull(ChartOps.trendGroup(tree("{\"trendGroup\":null}")));
        assertNull(ChartOps.trendGroup(tree("{\"trendGroup\":\"  \"}")));
        assertNull(ChartOps.trendGroup(tree("{\"trendGroup\":5}")), "non-string ignores the list");
        assertEquals("Line_1", ChartOps.trendGroup(tree("{\"trendGroup\":\"Line 1\"}")));
    }

    // ---- classification ------------------------------------------------------------------------------------------

    private static QualifiedValue good(Object v) {
        return new BasicQualifiedValue(v, QualityCode.Good, new Date(1000));
    }

    private static Map<String, QualifiedValue> read(Object value, QualityCode q, TagObjectType type, DataType dt,
                                                    Boolean history, String provider) {
        Map<String, QualifiedValue> m = new HashMap<>();
        m.put(TagMetaReader.VALUE, new BasicQualifiedValue(value, q, new Date(1000)));
        if (type != null) {
            m.put(TagMetaReader.TAG_TYPE, good(type));
        }
        if (dt != null) {
            m.put(TagMetaReader.DATA_TYPE, good(dt));
        }
        m.put(TagMetaReader.ENG_UNIT, good("degF"));
        m.put(TagMetaReader.ENG_LOW, good(0.0));
        m.put(TagMetaReader.ENG_HIGH, good(100.0));
        if (history != null) {
            m.put(TagMetaReader.HISTORY_ENABLED, good(history));
        }
        if (provider != null) {
            m.put(TagMetaReader.HISTORY_PROVIDER, good(provider));
        }
        return m;
    }

    private static ChartMetaCache.PenMeta classify(Map<String, QualifiedValue> m) {
        HistoryAvailability ha = new HistoryAvailability();
        return ChartOps.classify(m, meta -> ha.check(meta, () -> List.of("Core Historian")));
    }

    @Test
    void classification() {
        ChartMetaCache.PenMeta ok = classify(read(1.5, QualityCode.Good, TagObjectType.AtomicTag, DataType.Float8, true,
            "Core Historian"));
        assertEquals("ok", ok.status());
        assertEquals("degF", ok.meta().get("engUnit").getAsString());
        assertEquals("Float8", ok.meta().get("dataType").getAsString());
        assertTrue(ok.history().get("available").getAsBoolean());
        assertEquals("ok", classify(read(true, QualityCode.Good, TagObjectType.AtomicTag, DataType.Boolean, true,
            "Core Historian")).status(), "Boolean is trendable");
        assertEquals("noHistory", classify(read(1.0, QualityCode.Good, TagObjectType.AtomicTag, DataType.Float8, false,
            "Core Historian")).status());
        assertEquals("noHistory", classify(read(1.0, QualityCode.Good, TagObjectType.AtomicTag, DataType.Float8, true,
            "Gone Historian")).status(), "provider missing");
        assertEquals("unsupportedType", classify(read("Pump", QualityCode.Good, TagObjectType.AtomicTag, DataType.String, true,
            "Core Historian")).status());
        assertEquals("unsupportedType", classify(read(null, QualityCode.Good, TagObjectType.AtomicTag, DataType.Float8Array,
            true, "Core Historian")).status());
        assertEquals("invalidPath", classify(read(null, QualityCode.Good, TagObjectType.Folder, null, null, null)).status());
        ChartMetaCache.PenMeta nf = classify(read(null, QualityCode.Bad_NotFound, null, null, null, null));
        assertEquals("notFound", nf.status());
        assertNull(nf.meta());
        ChartMetaCache.PenMeta denied = classify(read(42.0, QualityCode.Bad_AccessDenied, TagObjectType.AtomicTag,
            DataType.Float8, true, "Core Historian"));
        assertEquals("accessDenied", denied.status());
        assertNull(denied.meta(), "no metadata of a tag the user may not read");
        assertNull(denied.history());
        assertEquals("notFound", ChartOps.classify(new HashMap<>(), m -> null).status(), "missing read");
    }

    // ---- live values ---------------------------------------------------------------------------------------------

    @Test
    void liveValues() {
        JsonObject b = ChartOps.liveValue(new BasicQualifiedValue(true, QualityCode.Good, new Date(1234)), 9);
        assertEquals(1, b.get("v").getAsInt(), "Boolean as 1");
        assertEquals(1234, b.get("t").getAsLong(), "tag timestamp");
        assertEquals("good", b.getAsJsonObject("q").get("level").getAsString());
        assertEquals(0, ChartOps.liveValue(new BasicQualifiedValue(false, QualityCode.Good, new Date(1)), 9).get("v").getAsInt());
        assertEquals(2.5, ChartOps.liveValue(new BasicQualifiedValue(2.5f, QualityCode.Good, new Date(1)), 9).get("v")
            .getAsDouble(), 1e-9);
        assertTrue(ChartOps.liveValue(new BasicQualifiedValue(Double.NaN, QualityCode.Good, new Date(1)), 9).get("v")
            .isJsonNull());
        assertTrue(ChartOps.liveValue(new BasicQualifiedValue("x", QualityCode.Good, new Date(1)), 9).get("v").isJsonNull());
        JsonObject denied = ChartOps.liveValue(new BasicQualifiedValue(424242.4242, QualityCode.Bad_AccessDenied, new Date(1)), 9);
        assertTrue(denied.get("v").isJsonNull(), "never the value of a denied tag");
        assertFalse(denied.toString().contains("424242"));
    }

    // ---- meta cache ----------------------------------------------------------------------------------------------

    @Test
    void metaCacheTtlIdentityAndEviction() {
        AtomicLong now = new AtomicLong(0);
        ChartMetaCache c = new ChartMetaCache(now::get);
        UUID s1 = UUID.randomUUID();
        UUID s2 = UUID.randomUUID();
        String eng = ChartMetaCache.identity(ENGINEER);
        String viewer = ChartMetaCache.identity(VIEWER);
        ChartMetaCache.PenMeta okMeta = new ChartMetaCache.PenMeta("ok", null, null, DataType.Float8);
        c.put(s1, eng, "[default]ctg/secret", okMeta);
        assertEquals("ok", c.get(s1, eng, "[default]ctg/secret").status());
        assertNull(c.get(s1, viewer, "[default]ctg/secret"), "another user never hits the previous user's entry");
        assertNull(c.get(s2, eng, "[default]ctg/secret"), "per session");
        now.set(ChartMetaCache.TTL_MS);
        assertNull(c.get(s1, eng, "[default]ctg/secret"), "TTL");
        c.put(s1, eng, "[default]a", okMeta);
        c.put(s1, viewer, "[default]a", okMeta);
        c.put(s1, eng, "[default]b", okMeta);
        c.put(s2, eng, "[default]a", okMeta);
        c.invalidate(s1, Set.of("[default]a"));
        assertNull(c.get(s1, eng, "[default]a"));
        assertNull(c.get(s1, viewer, "[default]a"));
        assertEquals("ok", c.get(s1, eng, "[default]b").status());
        assertEquals("ok", c.get(s2, eng, "[default]a").status());
        c.evictSession(s1);
        assertNull(c.get(s1, eng, "[default]b"));
        assertEquals(1, c.size());
        assertFalse(ChartMetaCache.identity(ENGINEER).equals(ChartMetaCache.identity(UserContext.of(true, "engineer",
            List.of("Engineer"), Set.of(), SessionScope.Client, true))), "roles are part of the identity");
    }

    /** The per-session index stays consistent through LRU eviction, TTL, invalidate, evict. */
    @Test
    void metaCacheSessionIndex() {
        AtomicLong now = new AtomicLong(0);
        ChartMetaCache c = new ChartMetaCache(now::get);
        String eng = ChartMetaCache.identity(ENGINEER);
        String viewer = ChartMetaCache.identity(VIEWER);
        ChartMetaCache.PenMeta okMeta = new ChartMetaCache.PenMeta("ok", null, null, DataType.Float8);
        UUID s1 = UUID.randomUUID();
        UUID s2 = UUID.randomUUID();
        for (int i = 0; i < ChartMetaCache.MAX_ENTRIES + 50; i++) {
            c.put(i % 2 == 0 ? s1 : s2, i % 3 == 0 ? viewer : eng, "[default]t" + i, okMeta);
        }
        assertEquals(ChartMetaCache.MAX_ENTRIES, c.size(), "LRU bound");
        assertEquals(c.size(), c.indexedSize(), "LRU eviction unindexes");
        assertNull(c.get(s1, viewer, "[default]t0"), "eldest evicted");
        c.put(s1, eng, "[default]t100", okMeta);   // same key again (overwrite, no duplicate index entry)
        assertEquals(c.size(), c.indexedSize());
        c.invalidate(s1, new java.util.HashSet<>(List.of("[default]t100", "[default]t102", "[default]nope")));
        assertNull(c.get(s1, eng, "[default]t100"));
        assertEquals("ok", c.get(s2, eng, "[default]t101").status(), "other session untouched");
        assertEquals(c.size(), c.indexedSize());
        now.set(ChartMetaCache.TTL_MS);
        assertNull(c.get(s2, eng, "[default]t101"), "TTL");
        assertEquals(c.size(), c.indexedSize(), "TTL removal unindexes");
        c.evictSession(s1);
        assertEquals(c.size(), c.indexedSize());
        assertTrue(c.size() > 0);
        c.evictSession(s2);
        assertEquals(0, c.size());
        assertEquals(0, c.indexedSize());
    }

    /** chart.trendAdd checks the data type before history, like the pen status. */
    @Test
    void trendAddFactsAgreeWithClassification() {
        HistoryAvailability ha = new HistoryAvailability();
        java.util.function.Function<TagMetaReader.Meta, HistoryAvailability.Status> hist =
            meta -> ha.check(meta, () -> List.of("Core Historian"));
        Map<String, QualifiedValue> stringNoHistory = read("Pump", QualityCode.Good, TagObjectType.AtomicTag, DataType.String,
            false, null);
        assertEquals("unsupportedType", classify(stringNoHistory).status());
        assertEquals(ErrorCode.UNSUPPORTED_TYPE, ChartOps.trendAddFacts(stringNoHistory, hist));
        Map<String, QualifiedValue> dateNoHistory = read(new Date(5), QualityCode.Good, TagObjectType.AtomicTag,
            DataType.DateTime, false, null);
        assertEquals("unsupportedType", classify(dateNoHistory).status());
        assertEquals(ErrorCode.UNSUPPORTED_TYPE, ChartOps.trendAddFacts(dateNoHistory, hist));
        Map<String, QualifiedValue> floatNoHistory = read(1.0, QualityCode.Good, TagObjectType.AtomicTag, DataType.Float8,
            false, null);
        assertEquals("noHistory", classify(floatNoHistory).status());
        assertEquals(ErrorCode.NO_HISTORY, ChartOps.trendAddFacts(floatNoHistory, hist));
        Map<String, QualifiedValue> ok = read(1.0, QualityCode.Good, TagObjectType.AtomicTag, DataType.Float8, true,
            "Core Historian");
        assertEquals("ok", classify(ok).status());
        assertNull(ChartOps.trendAddFacts(ok, hist));
    }
}
