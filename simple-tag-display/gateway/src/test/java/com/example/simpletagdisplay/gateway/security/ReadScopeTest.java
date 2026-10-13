package com.example.simpletagdisplay.gateway.security;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import com.example.simpletagdisplay.gateway.delegate.PropsSnapshot;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.perspective.common.config.BindingConfig;
import com.inductiveautomation.perspective.common.config.PropertyConfig;
import org.junit.jupiter.api.Test;

/** Chart read scope, incl. its fail-closed rules. */
class ReadScopeTest {

    private static final List<String> DENIED = List.of("System");
    private static final List<String> PROVIDERS = List.of("default", "System", "Other");

    /** Snapshot as the delegate builds it: trusted leaves read from a props tree through TrustedProps (shadow markers). */
    static PropsSnapshot tree(String propsJson) {
        return tree(propsJson, BindingLint.LintReport.clean());
    }

    static PropsSnapshot tree(String propsJson, BindingLint.LintReport lint) {
        JsonObject root = JsonParser.parseString(propsJson).getAsJsonObject();
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
        return new PropsSnapshot(m, lint, true);
    }

    private static ReadScope scope(String props, Set<String> design, Set<String> trend) {
        return ReadScope.build(tree(props), design, trend::contains, DENIED, "default", PROVIDERS);
    }

    @Test
    void defaultBrowserOnReadsEveryProviderButTheDeniedOnes() {
        // tagBrowser.enabled defaults to true, rootPath "" = all providers
        ReadScope s = scope("{}", Set.of(), Set.of());
        assertTrue(s.allows("[default]ctg/counter", true));
        assertFalse(s.allows("[system]gateway/x", true), "ctg.read.deniedProviders still applies");
    }

    @Test
    void browserOffAllowsOnlyDesignerPensAndTheTrendList() {
        ReadScope s = scope("{\"tagBrowser\":{\"enabled\":false}}", Set.of("[default]ctg/temp"), Set.of("[default]ctg/pressure"));
        assertTrue(s.allows("[default]ctg/temp", true), "Designer key");
        assertTrue(s.allows("[default]ctg/pressure", true), "trend list entry");
        assertTrue(s.allows("[default]anything", false), "a pen the Designer configured (runtime=false)");
        assertFalse(s.allows("[default]ctg/counter", true), "runtime pen with the tag browser off: no roots");
        assertFalse(s.runtimePensAllowed());
        assertEquals(List.of(), s.rootLabels());
        assertTrue(s.allows("[default]ctg/temp"), "PenGate = allows(key, true)");
        assertFalse(s.allows("[default]ctg/counter"));
    }

    @Test
    void explicitRootsLimitRuntimePens() {
        ReadScope s = scope("{\"readScope\":{\"allowedRoots\":[\"[default]CTG\", \"[default]Other/\"],\"allowRuntimePens\":true}}",
            Set.of(), Set.of());
        assertTrue(s.allows("[default]ctg/temp", true));
        assertTrue(s.allows("[default]ctg", true), "the root itself");
        assertFalse(s.allows("[default]ctgx/temp", true), "prefix of a name is not a folder");
        assertFalse(s.allows("[default]_ctg_research/x", true), "outside the root");
        assertTrue(s.allows("[default]other/a", true), "trailing slash tolerated");
        assertEquals(List.of("[default]CTG", "[default]Other"), s.rootLabels());
        assertTrue(s.runtimePensAllowed());
    }

    @Test
    void providerRootAndDeniedProviders() {
        ReadScope s = scope("{\"readScope\":{\"allowedRoots\":[\"[default]\",\"[System]\"]}}", Set.of(), Set.of());
        assertTrue(s.allows("[default]ctg/temp", true));
        assertTrue(s.allows("[default]x", true));
        assertFalse(s.allows("[other]x", true));
        assertFalse(s.allows("[system]gateway/systemname", true), "ctg.read.deniedProviders wins over a root");
        assertTrue(s.allows("[system]gateway/systemname", false), "a Designer pen is allowed");
        assertTrue(ReadScope.build(tree("{}"), Set.of("[system]gateway/systemname"), k -> false, DENIED, "default", PROVIDERS)
            .allows("[system]gateway/systemname", true), "Designer key on a denied provider");
    }

    @Test
    void tagBrowserFallback() {
        ReadScope all = scope("{\"tagBrowser\":{\"enabled\":true,\"rootPath\":\"\"}}", Set.of(), Set.of());
        assertTrue(all.allRoots());
        assertTrue(all.allows("[default]x/y", true));
        assertTrue(all.allows("[other]x", true));
        assertFalse(all.allows("[system]gateway/systemname", true), "System denied even with ALL");
        assertEquals(List.of("[default]", "[Other]"), all.rootLabels(), "ALL lists every non-denied provider");

        ReadScope rooted = scope("{\"tagBrowser\":{\"enabled\":true,\"rootPath\":\"[default]CTG\"}}", Set.of(), Set.of());
        assertTrue(rooted.allows("[default]ctg/temp", true));
        assertFalse(rooted.allows("[default]other", true));
        assertEquals(List.of("[default]CTG"), rooted.rootLabels());

        ReadScope noProvider = scope("{\"tagBrowser\":{\"enabled\":true,\"rootPath\":\"CTG\"}}", Set.of(), Set.of());
        assertTrue(noProvider.allows("[default]ctg/temp", true), "a root without provider resolves to the project default");

        ReadScope explicitWins = scope("{\"readScope\":{\"allowedRoots\":[\"[default]A\"]},\"tagBrowser\":{\"enabled\":true}}",
            Set.of(), Set.of());
        assertFalse(explicitWins.allows("[default]b", true), "allowedRoots wins over the browser root");
    }

    @Test
    void failsClosedOnMalformedValues() {
        for (String bad : new String[] {
            "{\"readScope\":{\"allowedRoots\":null}}",
            "{\"readScope\":{\"allowedRoots\":\"[default]CTG\"}}",
            "{\"readScope\":{\"allowedRoots\":[5]}}",
            "{\"readScope\":{\"allowedRoots\":[\"[default]CTG/../X\", \"histprov:x:/y\"]}}",
            "{\"readScope\":null,\"tagBrowser\":{\"enabled\":true}}",
            "{\"readScope\":\"all\",\"tagBrowser\":{\"enabled\":true}}",
            "{\"readScope\":{\"allowRuntimePens\":\"true\"},\"tagBrowser\":{\"enabled\":true}}",
            "{\"readScope\":{\"allowRuntimePens\":null},\"tagBrowser\":{\"enabled\":true}}",
            "{\"tagBrowser\":{\"enabled\":\"true\"}}",
            "{\"tagBrowser\":{\"enabled\":true,\"rootPath\":5}}",
            "{\"tagBrowser\":{\"enabled\":true,\"rootPath\":null}}",
            "{\"tagBrowser\":{\"enabled\":true,\"rootPath\":\"[default]A/../B\"}}",
        }) {
            ReadScope s = scope(bad, Set.of("[default]ctg/temp"), Set.of("[default]ctg/pressure"));
            assertFalse(s.allows("[default]ctg/counter", true), bad);
            assertFalse(s.runtimePensAllowed(), bad);
            assertTrue(s.allows("[default]ctg/temp", true), "Designer pens keep working: " + bad);
            assertTrue(s.allows("[default]ctg/pressure", true), "trend list keeps working: " + bad);
        }
    }

    @Test
    void runtimePensSwitch() {
        ReadScope off = scope("{\"readScope\":{\"allowedRoots\":[\"[default]\"],\"allowRuntimePens\":false}}", Set.of(),
            Set.of());
        assertFalse(off.allows("[default]ctg/temp", true));
        assertFalse(off.runtimePensAllowed());
    }

    @Test
    void boundScopeKeysFailClosed() {
        BindingLint.LintReport r = BindingLint.inspect(p -> {
            if (!p.equals("readScope.allowedRoots")) {
                return Optional.empty();
            }
            PropertyConfig pc = new PropertyConfig();
            pc.binding = new BindingConfig();
            pc.binding.type = "property";
            pc.binding.config = JsonParser.parseString("{\"path\":\"view.params.roots\",\"bidirectional\":true}")
                .getAsJsonObject();
            return Optional.of(pc);
        }, SecurityKeys.CHART);
        PropsSnapshot p = tree("{\"readScope\":{\"allowedRoots\":[\"[default]\"]}}", r);
        ReadScope s = ReadScope.build(p, Set.of(), k -> false, DENIED, "default", PROVIDERS);
        assertFalse(s.allows("[default]ctg/temp", true), "a bidirectionally bound scope key disables runtime pens");
    }

    @Test
    void folderParsing() {
        assertEquals("[default]", ReadScope.folderKey(ReadScope.parseFolder("[default]", "default").get()));
        assertEquals("[default]", ReadScope.folderKey(ReadScope.parseFolder("[default]/", "default").get()));
        assertEquals("[default]ctg", ReadScope.folderKey(ReadScope.parseFolder("[default]CTG", "default").get()));
        assertEquals("[default]CTG/Sub", ReadScope.folderLabel(ReadScope.parseFolder(" [default]CTG/Sub ", null).get()));
        assertEquals("[default]", ReadScope.folderKey(ReadScope.parseFolder("[~]", "default").get()));
        for (String bad : new String[] {"", "[default]CTG/..", "[default]CTG/../X", "[default]./X", "[.]X", "[]",
            "histprov:a:/b", "[default]CT\u0007G", "CTG"}) {
            assertTrue(ReadScope.parseFolder(bad, null).isEmpty(), bad);
        }
        assertTrue(ReadScope.isUnder("[default]ctg/temp", "[default]"));
        assertFalse(ReadScope.isUnder("[defaultx]ctg", "[default]"));
        assertTrue(ReadScope.isUnder("[default]ctg", "[default]ctg"));
        assertFalse(ReadScope.isUnder("[default]ctgx", "[default]ctg"));
        assertEquals("system", ReadScope.providerOf("[system]gateway/x"));
    }

    @Test
    void liveTrendMembership() {
        java.util.Set<String> list = new java.util.HashSet<>();
        ReadScope s = ReadScope.build(tree("{\"tagBrowser\":{\"enabled\":false}}"), Set.of(), list::contains, DENIED,
            "default", PROVIDERS);
        assertFalse(s.allows("[default]ctg/temp", true));
        list.add("[default]ctg/temp");
        assertTrue(s.allows("[default]ctg/temp", true), "tokens see trend-list changes without a rebuild");
    }
}
