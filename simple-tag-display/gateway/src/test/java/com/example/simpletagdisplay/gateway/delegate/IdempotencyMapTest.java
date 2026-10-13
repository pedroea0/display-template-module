package com.example.simpletagdisplay.gateway.delegate;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.concurrent.atomic.AtomicInteger;

import com.inductiveautomation.ignition.common.gson.JsonObject;
import org.junit.jupiter.api.Test;

/** Request ids recorded at receipt. */
class IdempotencyMapTest {

    @Test
    void duplicatePendingIdExecutesOnceAndSharesTheReply() {
        IdempotencyMap m = new IdempotencyMap();
        AtomicInteger executions = new AtomicInteger();
        IdempotencyMap.Claim first = m.claim("dt-1");
        if (first.fresh()) {
            executions.incrementAndGet();
        }
        IdempotencyMap.Claim dup = m.claim("dt-1");     // replay while the first is still pending
        if (dup.fresh()) {
            executions.incrementAndGet();
        }
        assertEquals(1, executions.get());
        assertSame(first.future(), dup.future());
        JsonObject reply = new JsonObject();
        reply.addProperty("ok", true);
        first.future().complete(reply);
        assertSame(reply, dup.future().join());
        IdempotencyMap.Claim late = m.claim("dt-1");    // replay after completion
        assertFalse(late.fresh());
        assertSame(reply, late.future().join());
    }

    @Test
    void completedEntriesAreBoundedPendingOnesAreKept() {
        IdempotencyMap m = new IdempotencyMap();
        IdempotencyMap.Claim pending = m.claim("p");
        for (int i = 0; i < 100; i++) {
            m.claim("c" + i).future().complete(new JsonObject());
        }
        assertTrue(m.size() <= IdempotencyMap.KEEP_COMPLETED + 2, "size " + m.size());
        assertFalse(m.claim("p").fresh(), "the pending entry survives eviction");
        assertTrue(m.claim("c0").fresh(), "old completed entries are forgotten");
        assertSame(pending.future(), m.claim("p").future());
    }

    @Test
    void tooManyPendingIsRefusedAndStopCancels() {
        IdempotencyMap m = new IdempotencyMap();
        for (int i = 0; i < IdempotencyMap.MAX_PENDING; i++) {
            m.claim("p" + i);
        }
        assertNull(m.claim("one-more"));
        IdempotencyMap.Claim c = m.claim("p0");
        m.cancelPending();
        assertTrue(c.future().isCancelled());
        assertEquals(0, m.pendingCount());
    }
}
