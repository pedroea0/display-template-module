package com.example.simpletagdisplay.gateway;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

import com.example.simpletagdisplay.gateway.history.HistoryTokenStore;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * The session sweep used to count a session dead after 60 s without a module component, so a live Perspective
 * session that showed an alarm or home page for a few minutes lost its trend lists, its tokens and its annotation
 * quota (session-end listeners). A session Perspective still has is never swept now.
 */
class SessionSweepLivenessTest {

    private final Map<String, String> props = new HashMap<>();
    private final GatewayServices services = new GatewayServices(null, null, new ModuleSettings(props::get));

    @AfterEach
    void close() {
        services.close();
    }

    private HistoryTokenStore.TokenInfo issue(UUID id) {
        return services.tokens().issue(new HistoryTokenStore.IssueRequest(id, "P", SessionScope.Client, "chart",
            "root/chart", "operator", null, HistoryTokenStore.PenGate.ALL, false));
    }

    @Test
    void aSessionPerspectiveStillHasKeepsItsTrendListTokensAndQuota() {
        UUID id = UUID.randomUUID();
        services.trendStore().add(id, "default", "[default]CTG/DT_SP", "operator");
        AtomicInteger ended = new AtomicInteger();
        services.onSessionEnd(x -> ended.incrementAndGet());
        services.perspectiveSessionOpen = x -> Optional.of(true);       // the user is on a blank page for 85 s
        services.sweepEnd(id);
        assertEquals(1, services.trendStore().get(id, "default").size(),
            "was []: back on /dt/write the display showed trending=false");
        // (its tokens validate only while a chart of the session is alive anyway; nothing was revoked or evicted here)
        assertEquals(0, ended.get(), "no session-end listener (annotation quota, caches) ran");
    }

    @Test
    void aSessionPerspectiveNoLongerHasOrCannotBeLookedUpIsStillSwept() {
        for (Optional<Boolean> open : List.of(Optional.of(false), Optional.<Boolean>empty())) {
            UUID id = UUID.randomUUID();
            HistoryTokenStore.TokenInfo t = issue(id);
            services.trendStore().add(id, "default", "[default]CTG/Temp", "operator");
            services.perspectiveSessionOpen = x -> open;
            services.sweepEnd(id);
            assertEquals(HistoryTokenStore.Status.INVALID, services.tokens().validate(t.token()).status(), open.toString());
            assertTrue(services.trendStore().get(id, "default").isEmpty(), open.toString());
        }
    }

    @Test
    void theRealShutdownStillEndsAnOpenLookingSession() {
        UUID id = UUID.randomUUID();
        services.trendStore().add(id, "default", "[default]CTG/Temp", "operator");
        services.perspectiveSessionOpen = x -> Optional.of(true);
        services.sessionEnded(id);                                     // SessionShutdownEvent
        assertFalse(services.trendStore().sessions().contains(id));
    }
}
