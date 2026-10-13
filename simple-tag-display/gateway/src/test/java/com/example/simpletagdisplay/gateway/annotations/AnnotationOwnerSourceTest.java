package com.example.simpletagdisplay.gateway.annotations;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Set;

import com.example.simpletagdisplay.gateway.security.UserContext;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.Test;

/**
 * Annotation ownership used to compare bare user names. It now compares the user source (the identity provider,
 * {@code session.props.auth.idp}) AND the user name, so the same name from two user sources is two owners.
 */
class AnnotationOwnerSourceTest {

    private static UserContext user(String name, String source) {
        return UserContext.of(true, name, source, List.of("Engineer"), Set.of(), SessionScope.Client, true);
    }

    private static AnnotationService.Note saved(UserContext by) {
        return AnnotationService.parseData(AnnotationService.dataJson("pump tripped", AnnotationService.authorOf(by),
            AnnotationService.authorSourceOf(by), null, 1L, null, null));
    }

    @Test
    void theSameNameFromAnotherUserSourceIsAnotherOwner() {
        UserContext corp = user("jsmith", "corp-ad");
        UserContext local = user("jsmith", "default");
        AnnotationService.Note n = saved(corp);
        assertEquals("jsmith", n.author());
        assertEquals("corp-ad", n.authorSource());
        assertTrue(AnnotationService.isOwn(n, corp));
        assertFalse(AnnotationService.isOwn(n, local), "same name, other identity provider: not the owner");
        assertFalse(AnnotationService.isOwn(n, user("jsmith", null)), "a user without a source is not corp-ad's jsmith");
        assertFalse(AnnotationService.isOwn(n, user("JSmith", "corp-ad")), "names still compare exactly");
    }

    @Test
    void theDataJsonCarriesTheSourceOnlyWhenThereIsOne() {
        JsonObject withSource = JsonParser.parseString(AnnotationService.dataJson("t", "eng", "default", null, 5L, null, null))
            .getAsJsonObject();
        assertEquals("default", withSource.get("authorSource").getAsString());
        JsonObject designer = JsonParser.parseString(AnnotationService.dataJson("t", "eng", null, null, 5L, null, null))
            .getAsJsonObject();
        assertFalse(designer.has("authorSource"), "no source (Designer): the key is left out");
        JsonObject anonymous = JsonParser.parseString(AnnotationService.dataJson("t", null, "default", null, 5L, null, null))
            .getAsJsonObject();
        assertFalse(anonymous.has("authorSource"), "no author, no source");
        assertNull(AnnotationService.authorSourceOf(UserContext.of(false, null, "default", List.of(), Set.of(),
            SessionScope.Client, true)), "an anonymous save records neither");
    }

    @Test
    void entriesWithoutASourceBelongOnlyToUsersWithoutOne() {
        // An entry written before user sources were recorded (or by a Designer session): no authorSource key.
        AnnotationService.Note legacy = AnnotationService.parseData(
            "{\"v\":1,\"text\":\"t\",\"author\":\"engineer\",\"color\":null,\"created\":1}");
        assertNull(legacy.authorSource());
        assertTrue(AnnotationService.isOwn(legacy, user("engineer", null)), "Designer user without a source");
        assertFalse(AnnotationService.isOwn(legacy, user("engineer", "default")),
            "a session user from an identity provider does not inherit a source-less entry (moderators can change it)");
        // An empty source counts as none, both in the data and for the user.
        AnnotationService.Note empty = AnnotationService.parseData(
            "{\"v\":1,\"text\":\"t\",\"author\":\"engineer\",\"authorSource\":\"\",\"created\":1}");
        assertNull(empty.authorSource());
        assertTrue(AnnotationService.isOwn(empty, user("engineer", "")));
        // A source without an author is ignored (anonymous notes are nobody's).
        AnnotationService.Note orphan = AnnotationService.parseData(
            "{\"v\":1,\"text\":\"t\",\"author\":null,\"authorSource\":\"default\",\"created\":1}");
        assertNull(orphan.author());
        assertNull(orphan.authorSource());
    }

    @Test
    void anEditKeepsTheOriginalAuthorAndSource() {
        UserContext corp = user("jsmith", "corp-ad");
        AnnotationService.Note n = saved(corp);
        String edited = AnnotationService.dataJson("new text", n.author(), n.authorSource(), null, 1L, "moderator", 9L);
        AnnotationService.Note e = AnnotationService.parseData(edited);
        assertEquals("jsmith", e.author());
        assertEquals("corp-ad", e.authorSource());
        assertTrue(AnnotationService.isOwn(e, corp));
    }
}
