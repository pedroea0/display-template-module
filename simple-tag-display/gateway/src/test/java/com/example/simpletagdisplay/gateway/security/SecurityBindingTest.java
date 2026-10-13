package com.example.simpletagdisplay.gateway.security;

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
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.gson.JsonPrimitive;
import com.inductiveautomation.perspective.common.config.BindingConfig;
import com.inductiveautomation.perspective.common.property.Origin;
import org.junit.jupiter.api.Test;

/**
 * Bindings that reach security keys: (1) a bidirectional binding configured on ANOTHER prop that targets a security key
 * relays a client value as {@code Origin.BindingWriteback} — adopted before, now reverted like a browser write;
 * (2) the binding lint's expression scanner skips comments, so a quote inside a {@code //} comment no longer hides
 * every later reference, and an unverifiable expression (unterminated literal / block comment) fails closed.
 */
class SecurityBindingTest {

    // ---- (1) BindingWriteback -----------------------------------------------------------------------------------

    @Test
    void aBindingWritebackIntoASecurityKeyIsRevertedInClientScope() {
        Map<String, JsonElement> trusted = Map.of("setpoint.access.roles", roles("Engineer"));
        Map<String, JsonElement> fresh = Map.of("setpoint.access.roles", roles("Operator"));
        List<String> paths = List.of("setpoint.access.roles");
        TrustedProps.Outcome client = TrustedProps.decide(paths, trusted, fresh, Origin.BindingWriteback, false);
        assertEquals(List.of("setpoint.access.roles"), client.reverted(),
            "was adopted: custom.unlock -> setpoint.access.roles let the operator write");
        assertTrue(client.adopted().isEmpty());
        TrustedProps.Outcome designer = TrustedProps.decide(paths, trusted, fresh, Origin.BindingWriteback, true);
        assertEquals(List.of("setpoint.access.roles"), designer.adopted(), "the Designer adopts every origin");
        assertTrue(TrustedProps.clientControlled(Origin.Browser));
        assertTrue(TrustedProps.clientControlled(Origin.BindingWriteback));
        for (Origin o : List.of(Origin.Binding, Origin.Script, Origin.Session, Origin.Project, Origin.Delegate)) {
            assertFalse(TrustedProps.clientControlled(o), o.name());
        }
    }

    @Test
    void theSiblingCheckboxUnlockIsRestoredWithTheTrustedValue() {
        // the 'Unlock editing' checkbox whose props.selected is bound bidirectionally to dtSib.props.setpoint.enabled
        Map<String, JsonElement> tree = new HashMap<>();
        tree.put("setpoint.enabled", new JsonPrimitive(false));
        TrustedProps t = new TrustedProps(List.of("setpoint.enabled"), false, p -> Optional.ofNullable(tree.get(p)));
        t.initialize();
        tree.put("setpoint.enabled", new JsonPrimitive(true));
        List<TrustedProps.Revert> r = t.onChange("setpoint", Origin.BindingWriteback, "setpoint.enabled");
        assertEquals(1, r.size());
        assertEquals("setpoint.enabled", r.get(0).path());
        assertEquals(new JsonPrimitive(false), r.get(0).value());
        assertEquals(new JsonPrimitive(false), t.values().get("setpoint.enabled"), "gates keep the trusted false");
    }

    private static JsonArray roles(String... names) {
        JsonArray a = new JsonArray();
        for (String n : names) {
            a.add(n);
        }
        return a;
    }

    // ---- (2) comments in expressions ----------------------------------------------------------------------------

    private static BindingLint.Verdict expr(String expression) {
        BindingConfig b = new BindingConfig();
        b.type = "expr";
        b.config = JsonParser.parseString("{\"expression\":" + new JsonPrimitive(expression) + "}").getAsJsonObject();
        return BindingLint.classify("setpoint.enabled", b);
    }

    @Test
    void aQuoteInsideALineCommentNoLongerHidesTheReference() {
        BindingLint.Verdict v = expr("// the faceplate's edit switch\n{view.custom.editable}");
        assertTrue(v.userControlled(), "was false: the apostrophe opened a literal that blanked {view.custom.editable}");
        assertTrue(v.failsClosed(true));
        assertTrue(expr("// 12\" display\n{view.params.edit}").userControlled(), "a double quote in a comment");
        assertTrue(expr("{view.custom.x} // the operator's switch").userControlled(), "a comment after the reference");
        assertTrue(expr("/* don't */ {page.props.path} = 'x'").userControlled(), "a block comment");
        assertFalse(expr("// {view.custom.x} is not used any more\n{[default]CTG/SpEnabled}").userControlled(),
            "a reference inside a comment is not evaluated");
    }

    @Test
    void anUnverifiableExpressionFailsClosed() {
        assertTrue(expr("'abc + {view.custom.x}").userControlled(), "an unterminated literal");
        assertTrue(expr("{[default]CTG/SpEnabled} /* never closed").userControlled(), "an unterminated block comment");
        List<String> refs = new ArrayList<>();
        BindingLint.expressionRefs("'abc", java.util.Set.of(), refs);
        assertEquals(List.of(BindingLint.UNVERIFIED), refs);
        assertFalse(BindingLint.sessionOwned(BindingLint.UNVERIFIED));
    }

    @Test
    void literalsWithSlashesAndSessionReferencesStayTrusted() {
        assertFalse(expr("'http://x/' + {session.props.auth.user.userName} != ''").userControlled(),
            "// inside a literal is text, not a comment");
        assertFalse(expr("{[default]CTG/SpEnabled} && 2 / 1 = 2").userControlled(), "division is not a comment");
        BindingConfig http = new BindingConfig();
        http.type = "http";
        http.config = JsonParser.parseString("{\"url\":\"https://x/it's/{view.params.id}\"}").getAsJsonObject();
        assertTrue(BindingLint.classify("enabled", http).userControlled(),
            "unknown types are scanned raw: neither // nor an apostrophe hides a reference");
    }
}
