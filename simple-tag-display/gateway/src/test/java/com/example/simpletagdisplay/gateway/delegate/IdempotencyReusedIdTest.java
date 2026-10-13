package com.example.simpletagdisplay.gateway.delegate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotSame;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import org.junit.jupiter.api.Test;

/**
 * Previously, after a page reload the gateway delegate survived with its cache of the last 32 MUTATE replies, the new
 * client delegate restarted its id counter, and a new write that reused 'dt0:2:0-1' was answered with the first
 * write's reply ("Written", an old auditId) — the tag never changed.
 */
class IdempotencyReusedIdTest {

    private static JsonObject body(String json) {
        return JsonParser.parseString(json).getAsJsonObject();
    }

    private static JsonObject reply(int written) {
        JsonObject r = new JsonObject();
        r.addProperty("ok", true);
        r.addProperty("written", written);
        return r;
    }

    @Test
    void aReusedIdWithADifferentBodyIsExecutedNotAnsweredFromTheCache() {
        IdempotencyMap m = new IdempotencyMap();
        String w11 = IdempotencyMap.fingerprint("dt.write",
            body("{\"v\":2,\"id\":\"dt0:2:0-1\",\"build\":\"x\",\"expectedTagPath\":\"[default]CTG/DT_SP\",\"value\":11,\"ui\":\"popup\"}"));
        IdempotencyMap.Claim first = m.claim("dt0:2:0-1", w11);
        assertTrue(first.fresh());
        first.future().complete(reply(11));
        // the reloaded page's first write: same id, another value
        String w44 = IdempotencyMap.fingerprint("dt.write",
            body("{\"v\":2,\"id\":\"dt0:2:0-1\",\"build\":\"x\",\"expectedTagPath\":\"[default]CTG/DT_SP\",\"value\":44,\"ui\":\"popup\"}"));
        IdempotencyMap.Claim reused = m.claim("dt0:2:0-1", w44);
        assertTrue(reused.fresh(), "was false: the write of 44 got {written:11} and was never executed");
        assertFalse(reused.conflict());
        assertNotSame(first.future(), reused.future());
        // a genuine retry of that new write still attaches to it
        IdempotencyMap.Claim retry = m.claim("dt0:2:0-1", w44);
        assertFalse(retry.fresh());
        assertSame(reused.future(), retry.future());
    }

    @Test
    void aRetryIsTheSameRequestWhateverTheEnvelopeOrTheDisplayText() {
        String a = IdempotencyMap.fingerprint("dt.write",
            body("{\"v\":2,\"id\":\"a-1\",\"build\":\"b1\",\"value\":50,\"display\":\"50\",\"ui\":\"popup\",\"expectedTagPath\":\"T\"}"));
        String b = IdempotencyMap.fingerprint("dt.write",
            body("{\"expectedTagPath\":\"T\",\"ui\":\"popup\",\"value\":50,\"display\":\"50.00\",\"build\":\"b2\",\"id\":\"a-1\",\"v\":2}"));
        assertEquals(a, b, "key order, envelope fields and the cosmetic display text are not identity");
        assertNotEquals(a, IdempotencyMap.fingerprint("dt.configEdit",
            body("{\"value\":50,\"ui\":\"popup\",\"expectedTagPath\":\"T\"}")), "another message is another request");
        assertNotEquals(IdempotencyMap.fingerprint("x", body("{\"c\":{\"a\":1,\"b\":[1,2]}}")),
            IdempotencyMap.fingerprint("x", body("{\"c\":{\"a\":1,\"b\":[2,1]}}")), "array order matters");
        assertEquals(IdempotencyMap.fingerprint("x", body("{\"c\":{\"a\":1,\"b\":2}}")),
            IdempotencyMap.fingerprint("x", body("{\"c\":{\"b\":2,\"a\":1}}")), "nested key order does not");
    }

    @Test
    void aReusedIdWhileTheFirstIsPendingIsAConflict() {
        IdempotencyMap m = new IdempotencyMap();
        IdempotencyMap.Claim first = m.claim("c-1", "dt.write/11");
        assertTrue(first.fresh());
        IdempotencyMap.Claim other = m.claim("c-1", "dt.write/44");
        assertTrue(other.conflict(), "two different replies must never go out under one id");
        assertFalse(other.fresh());
        assertSame(first.future(), m.claim("c-1", "dt.write/11").future(), "the first request keeps its slot");
    }

    @Test
    void aFreshHelloForgetsCompletedRepliesButKeepsPendingOnes() {
        IdempotencyMap m = new IdempotencyMap();
        IdempotencyMap.Claim done = m.claim("d-1", "f1");
        done.future().complete(reply(1));
        IdempotencyMap.Claim pending = m.claim("d-2", "f2");
        m.clearCompleted();
        assertEquals(1, m.size());
        assertTrue(m.claim("d-1", "f1").fresh(), "a completed reply no longer answers a reused id");
        assertSame(pending.future(), m.claim("d-2", "f2").future());
        assertEquals(2, m.pendingCount(), "the new d-1 and the kept d-2");
    }
}
