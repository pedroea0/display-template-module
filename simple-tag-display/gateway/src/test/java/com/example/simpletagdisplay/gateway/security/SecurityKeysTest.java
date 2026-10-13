package com.example.simpletagdisplay.gateway.security;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import org.junit.jupiter.api.Test;

/**
 * The security-key lists match the schemas exactly: every listed path exists and is marked {@code [S]},
 * and every {@code [S]} leaf of a schema is listed (a new security key cannot be forgotten by TrustedProps / lint).
 */
class SecurityKeysTest {

    private static JsonObject schema(String name) throws IOException {
        try (InputStream in = SecurityKeysTest.class.getResourceAsStream("/schemas/" + name)) {
            assertNotNull(in, name);
            return JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject();
        }
    }

    /**
     * Dotted paths of the leaves of trust: an [S]-marked property with [S]-marked children contributes those
     * children (recursively); an [S]-marked object without marked children (e.g. an {@code access} object) makes all
     * its leaves security leaves; an [S]-marked scalar or array is a leaf itself.
     */
    private static List<String> markedLeaves(JsonObject node, String prefix) {
        List<String> out = new ArrayList<>();
        JsonObject props = node.has("properties") ? node.getAsJsonObject("properties") : new JsonObject();
        for (Map.Entry<String, JsonElement> e : props.entrySet()) {
            String path = prefix.isEmpty() ? e.getKey() : prefix + "." + e.getKey();
            JsonObject child = e.getValue().getAsJsonObject();
            List<String> below = markedLeaves(child, path);
            if (!below.isEmpty()) {
                out.addAll(below);
            } else if (description(child).contains("[S]")) {
                out.addAll(allLeaves(child, path));
            }
        }
        return out;
    }

    private static List<String> allLeaves(JsonObject node, String path) {
        if (!node.has("properties")) {
            return List.of(path);
        }
        List<String> out = new ArrayList<>();
        for (Map.Entry<String, JsonElement> e : node.getAsJsonObject("properties").entrySet()) {
            out.addAll(allLeaves(e.getValue().getAsJsonObject(), path + "." + e.getKey()));
        }
        return out;
    }

    private static String description(JsonObject o) {
        return o.has("description") ? o.get("description").getAsString() : "";
    }

    private static void check(String schemaFile, List<String> keys, String... notListed) throws IOException {
        TreeSet<String> marked = new TreeSet<>(markedLeaves(schema(schemaFile), ""));
        for (String n : notListed) {
            marked.remove(n);
        }
        assertEquals(marked, new TreeSet<>(keys), schemaFile + ": [S] leaves vs SecurityKeys");
    }

    @Test
    void displayKeysMatchTheSchema() throws IOException {
        check("displaytemplate.props.json", SecurityKeys.DISPLAY);
    }

    @Test
    void chartKeysMatchTheSchema() throws IOException {
        // pens is server-read but filtered by the read scope instead of being trusted.
        check("ctgchart.props.json", SecurityKeys.CHART, "pens");
    }

    @Test
    void rootsAndNonGateKeys() {
        assertTrue(SecurityKeys.roots(SecurityKeys.DISPLAY).containsAll(List.of("tagPath", "enabled", "setpoint", "menu")));
        assertTrue(SecurityKeys.NON_GATE.contains("tagPath"));
        assertTrue(SecurityKeys.NON_GATE.contains("trendGroup"));
    }
}
