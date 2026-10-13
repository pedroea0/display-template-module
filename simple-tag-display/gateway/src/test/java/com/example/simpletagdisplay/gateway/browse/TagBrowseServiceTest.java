package com.example.simpletagdisplay.gateway.browse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.delegate.PropsSnapshot;
import com.example.simpletagdisplay.gateway.security.BindingLint;
import com.example.simpletagdisplay.gateway.security.ReadScope;
import com.example.simpletagdisplay.gateway.security.SecurityKeys;
import com.example.simpletagdisplay.gateway.security.TrustedProps;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.inductiveautomation.ignition.common.browsing.Results;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.tags.browsing.NodeDescription;
import com.inductiveautomation.ignition.common.tags.config.types.TagObjectType;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.Test;

/** chart.browse: gate, root enforcement incl. traversal, access rule, denied providers, opaque paging. */
class TagBrowseServiceTest {

    private static final UserContext ENGINEER = UserContext.of(true, "engineer", List.of("Engineer"), Set.of(),
        SessionScope.Client, true);
    private static final UserContext VIEWER = UserContext.of(true, "viewer", List.of(), Set.of(), SessionScope.Client, true);

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

    private static ReadScope scope(PropsSnapshot p) {
        return ReadScope.build(p, Set.of(), k -> false, List.of("System"), "default", List.of("default", "System"));
    }

    private static TagBrowseService.Target target(String props, UserContext u, String path) {
        PropsSnapshot p = tree(props);
        return TagBrowseService.target(p, u, path, "default", scope(p));
    }

    @Test
    void gateAndRoot() {
        assertEquals(ErrorCode.ACTION_DISABLED, target("{\"tagBrowser\":{\"enabled\":false}}", ENGINEER, "").error);
        assertNull(target("{}", VIEWER, "").error, "the tag browser is on by default (Power Chart parity)");
        assertEquals(ErrorCode.OUT_OF_SCOPE, target("{}", VIEWER, "[System]Gateway").error, "default: [System] still hidden");
        String eng = "{\"tagBrowser\":{\"enabled\":true,\"access\":{\"roles\":[\"Engineer\"]}}}";
        assertEquals(ErrorCode.FORBIDDEN_ROLE, target(eng, VIEWER, "").error, "access rule");
        TagBrowseService.Target providers = target(eng, ENGINEER, "");
        assertNull(providers.error);
        assertNull(providers.path, "no root: the provider list");
        assertEquals("[default]ctg", ReadScope.folderKey(target(eng, ENGINEER, "[default]CTG").path));
        assertEquals("[default]", ReadScope.folderKey(target(eng, ENGINEER, "[default]").path));
        assertEquals(ErrorCode.INVALID_PATH, target(eng, ENGINEER, "[default]CTG/..").error, "no root: plain INVALID_PATH");
        assertEquals(ErrorCode.OUT_OF_SCOPE, target(eng, ENGINEER, "[System]Gateway").error, "ctg.read.deniedProviders");
        assertEquals(ErrorCode.OUT_OF_SCOPE, target(eng, ENGINEER, "[system]").error);
    }

    @Test
    void rootEnforcement() {
        String rooted = "{\"tagBrowser\":{\"enabled\":true,\"rootPath\":\"[default]CTG\"}}";
        assertEquals("[default]ctg", ReadScope.folderKey(target(rooted, VIEWER, "").path), "\"\" = the root");
        assertEquals("[default]ctg/sub", ReadScope.folderKey(target(rooted, VIEWER, "[default]CTG/Sub").path));
        assertEquals("[default]ctg", ReadScope.folderKey(target(rooted, VIEWER, "[DEFAULT]ctg").path), "case-insensitive");
        for (String escape : new String[] {"[default]", "[default]_CTG_research", "[default]CTGX", "[default]CTG/..",
            "[default]CTG/../_CTG_research", "[default]CTG/./x", "[System]Gateway", "histprov:x:/y", "[default]CT\u0000G"}) {
            assertEquals(ErrorCode.BROWSE_ROOT_VIOLATION, target(rooted, VIEWER, escape).error, escape);
        }
        assertEquals("[default]ctg", ReadScope.folderKey(target("{\"tagBrowser\":{\"enabled\":true,\"rootPath\":\"CTG\"}}",
            VIEWER, "").path), "root without provider = project default");
        for (String bad : new String[] {"{\"tagBrowser\":{\"enabled\":true,\"rootPath\":5}}",
            "{\"tagBrowser\":{\"enabled\":true,\"rootPath\":null}}",
            "{\"tagBrowser\":{\"enabled\":true,\"rootPath\":\"[default]CTG/../X\"}}"}) {
            assertEquals(ErrorCode.BROWSE_ROOT_VIOLATION, target(bad, VIEWER, "").error, "malformed root fails closed: " + bad);
        }
    }

    @Test
    void providerListIsFilteredAndPaged() {
        TagBrowseService svc = new TagBrowseService();
        ReadScope sc = scope(tree("{\"tagBrowser\":{\"enabled\":true}}"));
        JsonObject all = svc.providers(List.of("default", "System", "beta", "Alpha"), sc, "", 100, 0);
        JsonArray r = all.getAsJsonArray("results");
        assertEquals(3, r.size(), "System is denied");
        assertEquals("Alpha", r.get(0).getAsJsonObject().get("name").getAsString());
        assertEquals("[default]", r.get(2).getAsJsonObject().get("path").getAsString());
        assertEquals("Provider", r.get(2).getAsJsonObject().get("type").getAsString());
        assertTrue(all.get("continuation").isJsonNull());
        JsonObject page = svc.providers(List.of("default", "beta", "Alpha"), sc, "", 2, 0);
        assertEquals(2, page.getAsJsonArray("results").size());
        assertFalse(page.get("continuation").isJsonNull());
        assertEquals(1, svc.providers(List.of("default", "beta", "Alpha"), sc, "def", 100, 0).getAsJsonArray("results").size());
    }

    private static NodeDescription node(String name, TagObjectType type, DataType dt, boolean children, TagPath full) {
        return NodeDescription.newBuilder().name(name).objectType(type).dataType(dt).hasChildren(children).fullPath(full).build();
    }

    @Test
    void pagesAreOpaqueAndLocalPagingWorks() {
        TagBrowseService svc = new TagBrowseService();
        TagPath folder = ReadScope.parseFolder("[default]CTG", "default").get();
        List<NodeDescription> nodes = new ArrayList<>();
        nodes.add(node("Temp", TagObjectType.AtomicTag, DataType.Float8, false, ReadScope.parseFolder("[default]CTG/Temp", null).get()));
        nodes.add(node("Label", TagObjectType.AtomicTag, DataType.String, false, null));
        nodes.add(node("Running", TagObjectType.AtomicTag, DataType.Boolean, false, null));
        nodes.add(node("Sub", TagObjectType.Folder, null, true, null));
        nodes.add(node("Pump", TagObjectType.UdtInstance, null, true, null));
        Results<NodeDescription> res = new Results<>(nodes);
        res.setResultQuality(QualityCode.Good);

        JsonObject p1 = svc.page(folder, "[default]ctg", res, null, 3, "");
        JsonArray r1 = p1.getAsJsonArray("results");
        assertEquals(3, r1.size(), "provider ignored maxResults: paged here");
        assertEquals("[default]CTG/Temp", r1.get(0).getAsJsonObject().get("path").getAsString());
        assertTrue(r1.get(0).getAsJsonObject().get("trendable").getAsBoolean());
        assertFalse(r1.get(1).getAsJsonObject().get("trendable").getAsBoolean(), "String is not trendable");
        assertEquals("[default]CTG/Label", r1.get(1).getAsJsonObject().get("path").getAsString(), "path built from the parent");
        assertTrue(r1.get(2).getAsJsonObject().get("trendable").getAsBoolean(), "Boolean is trendable");
        assertEquals(5, p1.get("totalAvailable").getAsInt());
        String cont = p1.get("continuation").getAsString();
        assertFalse(cont.contains("ctg"), "opaque id");
        assertEquals("[default]ctg", svc.continuationPaths().get(cont));

        TagBrowseService.Continuation c = new TagBrowseService.Continuation("[default]ctg", null, 3);
        JsonObject p2 = svc.page(folder, "[default]ctg", res, c, 3, "");
        JsonArray r2 = p2.getAsJsonArray("results");
        assertEquals(2, r2.size());
        assertEquals("Folder", r2.get(0).getAsJsonObject().get("type").getAsString());
        assertTrue(r2.get(0).getAsJsonObject().get("hasChildren").getAsBoolean());
        assertTrue(p2.get("continuation").isJsonNull());

        JsonObject filtered = svc.page(folder, "[default]ctg", res, null, 100, "un");
        assertEquals(1, filtered.getAsJsonArray("results").size(), "filterText: Running");

        Results<NodeDescription> paged = new Results<>(nodes.subList(0, 2));
        paged.setContinuationPoint("provider-cp-7");
        JsonObject pp = svc.page(folder, "[default]ctg", paged, null, 2, "");
        assertFalse(pp.toString().contains("provider-cp-7"), "provider continuation points never reach the client");
        assertFalse(pp.get("continuation").isJsonNull());

        for (int i = 0; i < 40; i++) {
            svc.remember(new TagBrowseService.Continuation("[default]x", null, i));
        }
        assertEquals(TagBrowseService.MAX_CONTINUATIONS, svc.continuationCount(), "LRU bound");
    }

    @Test
    void qualityMapping() {
        assertEquals(ErrorCode.ACCESS_DENIED, TagBrowseService.mapQuality(QualityCode.Bad_AccessDenied));
        assertEquals(ErrorCode.TAG_NOT_FOUND, TagBrowseService.mapQuality(QualityCode.Bad_NotFound));
        assertEquals(ErrorCode.INTERNAL, TagBrowseService.mapQuality(QualityCode.Bad_Failure));
    }
}
