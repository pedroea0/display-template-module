package com.example.simpletagdisplay.gateway.util;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.security.AccessRule;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.Test;

/** Rate buckets, the inbound size/depth walk and the access-rule shape used by every gate. */
class TransportHelpersTest {

    @Test
    void tokenBucketHonoursBurstAndRate() {
        AtomicLong now = new AtomicLong(0);
        TokenBucket b = new TokenBucket(2, 5, now::get);   // MUTATE
        for (int i = 0; i < 5; i++) {
            assertTrue(b.tryAcquire(), "burst " + i);
        }
        assertFalse(b.tryAcquire());
        now.addAndGet(499);
        assertFalse(b.tryAcquire());
        now.addAndGet(1);
        assertTrue(b.tryAcquire(), "one token per 500 ms");
        now.addAndGet(60_000);
        for (int i = 0; i < 5; i++) {
            assertTrue(b.tryAcquire());
        }
        assertFalse(b.tryAcquire(), "refill is capped at the burst");
    }

    @Test
    void messageWalkStopsAtSizeOrDepth() {
        JsonObject small = JsonParser.parseString("{\"v\":2,\"id\":\"a-1\",\"value\":42}").getAsJsonObject();
        assertNull(Json.exceedsLimits(small, 65_536, 16));
        JsonObject big = new JsonObject();
        big.addProperty("value", "x".repeat(70_000));
        assertEquals("size", Json.exceedsLimits(big, 65_536, 16));
        JsonArray deep = new JsonArray();
        JsonArray cur = deep;
        for (int i = 0; i < 100; i++) {
            JsonArray next = new JsonArray();
            cur.add(next);
            cur = next;
        }
        JsonObject nested = new JsonObject();
        nested.add("x", deep);
        assertEquals("depth", Json.exceedsLimits(nested, 65_536, 16));
    }

    @Test
    void sanitizeForLogStripsControlCharactersAndCaps() {
        assertEquals("a?b?c", Json.sanitizeForLog("a\rb\nc"));
        assertEquals(Json.MAX_LOG_CHARS + 3, Json.sanitizeForLog("x".repeat(2000)).length());
    }

    @Test
    void accessRuleIsExactAndLoginFirst() {
        UserContext anon = UserContext.of(false, null, List.of(), Set.of(), SessionScope.Client, true);
        UserContext op = UserContext.of(true, "operator", List.of("Operator"), Set.of("Authenticated", "Authenticated/Roles",
            "Authenticated/Roles/Operator"), SessionScope.Client, true);
        AccessRule roles = AccessRule.parse(JsonParser.parseString("{\"roles\":[\"Operator\"]}"), false);
        assertEquals(ErrorCode.AUTH_REQUIRED, roles.evaluate(anon).orElse(null));
        assertTrue(roles.evaluate(op).isEmpty());
        AccessRule lower = AccessRule.parse(JsonParser.parseString("{\"roles\":[\"operator\"]}"), false);
        assertEquals(ErrorCode.FORBIDDEN_ROLE, lower.evaluate(op).orElse(null));
        AccessRule levels = AccessRule.parse(JsonParser.parseString("{\"securityLevels\":[\"/Authenticated/Roles/\"]}"), false);
        assertTrue(levels.evaluate(op).isEmpty());
        AccessRule open = AccessRule.parse(null, false);
        assertTrue(open.evaluate(anon).isEmpty());
        assertEquals(ErrorCode.AUTH_REQUIRED, AccessRule.parse(null, true).evaluate(anon).orElse(null));
    }
}
