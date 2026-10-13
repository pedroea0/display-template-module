package com.example.simpletagdisplay.gateway.annotations;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Set;

import com.example.simpletagdisplay.gateway.security.UserContext;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.Test;

/**
 * Previously annotations.edit.ownOnly did not separate anonymous users — every anonymous session is named
 * "Unauthenticated", so any anonymous visitor could edit and delete every other anonymous visitor's notes.
 */
class AnonymousAnnotationOwnerTest {

    private static UserContext user(boolean authenticated, String name) {
        return UserContext.of(authenticated, name, List.of(), Set.of(), SessionScope.Client, false);
    }

    @Test
    void anAnonymousSessionOwnsNothing() {
        UserContext anonA = user(false, null);
        UserContext anonB = user(false, null);
        assertEquals(UserContext.ANONYMOUS, anonB.userName());
        // a note written anonymously before the fix carries the shared name
        AnnotationService.Note legacy = AnnotationService.parseData(
            AnnotationService.dataJson("pump tripped", UserContext.ANONYMOUS, null, 1L, null, null));
        assertFalse(AnnotationService.isOwn(legacy, anonB), "was true: B rewrote and deleted A's note");
        assertFalse(AnnotationService.isOwn(legacy, anonA));
        assertFalse(AnnotationService.isOwn(legacy, user(true, UserContext.ANONYMOUS)),
            "a real account named 'Unauthenticated' does not own the anonymous notes either");
    }

    @Test
    void anonymousSavesRecordNoAuthorAndLoggedInUsersKeepOwnership() {
        assertNull(AnnotationService.authorOf(user(false, null)), "only moderators can change an anonymous note");
        assertNull(AnnotationService.authorOf(null));
        assertEquals("engineer", AnnotationService.authorOf(user(true, "engineer")));
        AnnotationService.Note mine = AnnotationService.parseData(
            AnnotationService.dataJson("t", AnnotationService.authorOf(user(true, "engineer")), null, 1L, null, null));
        assertTrue(AnnotationService.isOwn(mine, user(true, "engineer")));
        assertFalse(AnnotationService.isOwn(mine, user(true, "operator")));
        assertFalse(AnnotationService.isOwn(mine, user(false, "engineer")), "an unauthenticated caller owns nothing");
        AnnotationService.Note anon = AnnotationService.parseData(
            AnnotationService.dataJson("t", AnnotationService.authorOf(user(false, null)), null, 1L, null, null));
        assertNull(anon.author());
        assertFalse(AnnotationService.isOwn(anon, user(false, null)));
    }
}
