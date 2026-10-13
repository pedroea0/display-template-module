package com.example.simpletagdisplay.gateway;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import com.example.simpletagdisplay.gateway.delegate.CtgDelegateBase;
import com.example.simpletagdisplay.gateway.history.HistoryTokenStore;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/** GatewayServices-level checks (sweep end of a live session; timing sent to clients). */
class GatewayServicesTest {

    private final Map<String, String> props = new HashMap<>();
    private final GatewayServices services = new GatewayServices(null, null, new ModuleSettings(props::get));

    @AfterEach
    void close() {
        services.close();
    }

    @Test
    void theSweepNeverEndsALiveSession() {
        UUID id = UUID.randomUUID();
        services.liveSessions().register(id, SessionScope.Client, null, "operator");
        HistoryTokenStore.TokenInfo t = services.tokens().issue(new HistoryTokenStore.IssueRequest(id, "P",
            SessionScope.Client, "owner", "root/chart", "operator", null, HistoryTokenStore.PenGate.ALL, false));
        services.sweepEnd(id);
        assertTrue(services.liveSessions().isAlive(id), "a live session keeps its entry");
        assertEquals(HistoryTokenStore.Status.OK, services.tokens().validate(t.token()).status(),
            "and its tokens");
    }

    @Test
    void timingCarriesTheHeartbeatAndTheTagOperationTimeouts() {
        props.put("ctg.display.heartbeatMs", "120000");
        props.put("ctg.write.timeoutMs", "20000");
        props.put("ctg.read.timeoutMs", "7000");
        JsonObject t = CtgDelegateBase.timing(new ModuleSettings(props::get).get());
        assertEquals(120_000, t.get("heartbeatMs").getAsInt());
        assertEquals(5_000, t.get("heartbeatCheckMs").getAsInt());
        assertEquals(20_000, t.get("writeTimeoutMs").getAsInt());
        assertEquals(7_000, t.get("readTimeoutMs").getAsInt());
    }
}
