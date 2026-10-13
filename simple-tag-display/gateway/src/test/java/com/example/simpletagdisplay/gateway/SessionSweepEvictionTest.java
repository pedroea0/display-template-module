package com.example.simpletagdisplay.gateway;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import com.example.simpletagdisplay.gateway.history.HistoryTokenStore;
import com.example.simpletagdisplay.gateway.trend.TrendKey;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * The session sweep and a chart that registers while the sweep evicts. The sweep used to re-check liveness but then
 * evict without a lock: a delegate that registered in between lost its trend listener and its new token.
 */
class SessionSweepEvictionTest {

    private final Map<String, String> props = new HashMap<>();
    private final GatewayServices services = new GatewayServices(null, null, new ModuleSettings(props::get));

    @AfterEach
    void close() {
        services.close();
    }

    private HistoryTokenStore.TokenInfo issue(UUID id, String owner) {
        return services.tokens().issue(new HistoryTokenStore.IssueRequest(id, "P", SessionScope.Client, owner,
            "root/chart", "operator", null, HistoryTokenStore.PenGate.ALL, false));
    }

    @Test
    void aChartThatRegistersWhileTheSweepEvictsKeepsItsListenerAndToken() throws Exception {
        UUID id = UUID.randomUUID();
        // the ended session's own state (it was idle on CTG components for longer than the grace period)
        HistoryTokenStore.TokenInfo old = issue(id, "old-chart");
        services.trendStore().add(id, "default", "[default]CTG/Temp", "operator");

        AtomicInteger notified = new AtomicInteger();
        AtomicReference<HistoryTokenStore.TokenInfo> fresh = new AtomicReference<>();
        CountDownLatch registered = new CountDownLatch(1);
        CountDownLatch done = new CountDownLatch(1);
        TrendKey key = new TrendKey(id, "default");
        // The user navigates back to a chart page exactly while the sweep is between its re-check and the eviction:
        // the new delegate registers, then adds its trend listener and gets its snapshot token (delegate order).
        Thread chart = new Thread(() -> {
            services.liveSessions().register(id, SessionScope.Client, null, "operator");
            registered.countDown();
            services.trendStore().addListener(key, (k, paths, v) -> notified.incrementAndGet());
            fresh.set(issue(id, "new-chart"));
            done.countDown();
        });
        services.beforeSweepEvict = () -> {
            chart.start();
            try {
                // not serialised, the new chart would finish its start here and lose everything to the eviction
                assertFalse(done.await(300, TimeUnit.MILLISECONDS), "the register waits for the eviction");
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        };
        services.sweepEnd(id);
        services.beforeSweepEvict = null;
        assertTrue(done.await(5, TimeUnit.SECONDS));
        assertTrue(registered.getCount() == 0);

        assertEquals(HistoryTokenStore.Status.INVALID, services.tokens().validate(old.token()).status(),
            "the ended session's own token is revoked");
        assertEquals(HistoryTokenStore.Status.OK, services.tokens().validate(fresh.get().token()).status(),
            "the new chart's token survives the sweep");
        services.trendStore().add(id, "default", "[default]CTG/Pressure", "operator");
        assertEquals(1, notified.get(), "Trend Tag still reaches the new chart's listener");
        assertTrue(services.liveSessions().isAlive(id));
    }

    @Test
    void aFailedStartupIsRethrownSoTheGatewayFaultsTheModule() {
        // startup() used to log and swallow every failure, so Ignition listed the module ACTIVE (no component, no
        // delegate) and the deploy check reported the build RUNNING
        SimpleTagDisplayGatewayHook hook = new SimpleTagDisplayGatewayHook();
        hook.setup(null);                               // no gateway context: PerspectiveContext.get fails
        assertThrows(Throwable.class, () -> hook.startup(null), "propagated (was: swallowed)");
        assertEquals(null, GatewayServices.current(), "torn down before rethrowing");
    }

    @Test
    void aSessionThatIsReallyDeadIsStillEvicted() {
        UUID id = UUID.randomUUID();
        HistoryTokenStore.TokenInfo t = issue(id, "chart");
        services.trendStore().add(id, "default", "[default]CTG/Temp", "operator");
        services.sweepEnd(id);
        assertEquals(HistoryTokenStore.Status.INVALID, services.tokens().validate(t.token()).status());
        assertTrue(services.trendStore().sessions().isEmpty(), "lists dropped");
    }
}
