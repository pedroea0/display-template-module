package com.example.simpletagdisplay.gateway.browse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.Test;

/**
 * Provider names in browse paths: an unknown provider is {@code TAG_NOT_FOUND} (DEBUG, no WARN with a stack
 * trace); a padded provider spelling is {@code INVALID_PATH} like everywhere else ({@code [ System]Gateway} used to
 * reach the provider and fail with {@code INTERNAL} + a WARN, while {@code [ System]} said {@code OUT_OF_SCOPE}).
 */
class TagBrowseProviderNameTest {

    private static final UserContext ENGINEER = UserContext.of(true, "engineer", List.of("Engineer"), Set.of(),
        SessionScope.Client, true);

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

    private static TagBrowseService.Target target(String props, String path) {
        PropsSnapshot p = tree(props);
        ReadScope sc = ReadScope.build(p, Set.of(), k -> false, List.of("System"), "default", List.of("default", "System"));
        return TagBrowseService.target(p, ENGINEER, path, "default", sc);
    }

    @Test
    void paddedProviderSpellingsAreInvalidPathNotAProviderCall() {
        String open = "{\"tagBrowser\":{\"enabled\":true}}";
        for (String p : new String[] {"[ System]Gateway", "[System ]Gateway", "[ System]", "[System ]", "[ default]CTG"}) {
            assertEquals(ErrorCode.INVALID_PATH, target(open, p).error, p);
        }
        String rooted = "{\"tagBrowser\":{\"enabled\":true,\"rootPath\":\"[default]CTG\"}}";
        assertEquals(ErrorCode.BROWSE_ROOT_VIOLATION, target(rooted, "[ default]CTG").error,
            "with a root, a path that does not parse is a traversal attempt");
        assertEquals(ErrorCode.OUT_OF_SCOPE, target(open, "[System]Gateway").error, "the real spelling: denied provider");
    }

    @Test
    void unknownProvidersAreRecognisedCaseInsensitively() {
        List<String> names = List.of("default", "System", "Edge");
        assertTrue(TagBrowseService.providerKnown(names, "default"));
        assertTrue(TagBrowseService.providerKnown(names, "DEFAULT"));
        assertTrue(TagBrowseService.providerKnown(names, "edge"));
        assertFalse(TagBrowseService.providerKnown(names, "NoSuchProvider"));
        assertFalse(TagBrowseService.providerKnown(names, ""));
        assertFalse(TagBrowseService.providerKnown(names, null));
        assertTrue(TagBrowseService.providerKnown(List.of(), "anything"), "unknown provider list: the browse decides");
        assertTrue(TagBrowseService.providerKnown(null, "anything"));
    }

    @Test
    void unicodeCaseFoldTwinsAreNotKnownProviders() {
        // equalsIgnoreCase folds the long s and the dotless i onto S / I, but Ignition looks providers
        // up by their lower-cased name, finds nothing and the browse failed with INTERNAL plus a stack WARN. The
        // characters are built at run time: the build compiles with the platform encoding.
        String longS = String.valueOf((char) 0x017F);
        String dotlessI = String.valueOf((char) 0x0131);
        List<String> names = List.of("default", "System", "Simulator");
        assertTrue((longS + "ystem").equalsIgnoreCase("System"), "precondition: the JDK folds the long s");
        assertFalse(TagBrowseService.providerKnown(names, longS + "ystem"), "long s");
        assertFalse(TagBrowseService.providerKnown(names, "S" + dotlessI + "mulator"), "dotless i");
        assertFalse(TagBrowseService.providerKnown(names, "SYSTE" + longS));
        TagBrowseService.Target t = target("{\"tagBrowser\":{\"enabled\":true}}", "[" + longS + "ystem]");
        assertFalse(TagBrowseService.providerKnown(names, t.path.getSource()), "as parsed from a browse path");
        assertTrue(TagBrowseService.providerKnown(names, "SIMULATOR"), "plain case differences still match");
        assertTrue(TagBrowseService.providerKnown(names, "system"));
    }

    @Test
    void anUnknownProviderParsesAndPassesTheGate() {
        // The gate cannot know the provider list; browse() then answers TAG_NOT_FOUND before calling the provider.
        TagBrowseService.Target t = target("{\"tagBrowser\":{\"enabled\":true}}", "[NoSuchProvider]Folder");
        assertEquals(null, t.error);
        assertFalse(TagBrowseService.providerKnown(List.of("default", "System"), t.path.getSource()));
    }
}