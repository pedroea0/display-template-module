package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.concurrent.atomic.AtomicLong;

import org.junit.jupiter.api.Test;

/** Chunk cache bounds, LRU, TTL, disable. */
class HistoryChunkCacheTest {

    private final AtomicLong clock = new AtomicLong(1_000_000L);
    private final AtomicLong maxBytes = new AtomicLong(HistoryChunkCache.bytesFor(1_000) * 8);

    private HistoryChunkCache cache() {
        return new HistoryChunkCache(maxBytes::get, clock::get);
    }

    private static HistoryChunkCache.Key key(long chunkStart) {
        return new HistoryChunkCache.Key("[default]ctg/temp", "Core Historian", "MinMax", 60_000, 30_000_000, chunkStart);
    }

    private static long[] times(int n) {
        long[] t = new long[n];
        for (int i = 0; i < n; i++) {
            t[i] = i * 1000L;
        }
        return t;
    }

    @Test
    void keyEquality() {
        assertEquals(key(0), key(0));
        assertEquals(key(0).hashCode(), key(0).hashCode());
        assertEquals(new HistoryChunkCache.Key("p", "Core Historian", null, 0, 3_600_000, 0),
            new HistoryChunkCache.Key("p", "core historian", null, 0, 3_600_000, 0), "provider is case-insensitive");
        assertNotEquals(key(0), key(1));
        assertNotEquals(new HistoryChunkCache.Key("p", "h", "MinMax", 60_000, 30_000_000, 0),
            new HistoryChunkCache.Key("p", "h", "LastValue", 60_000, 30_000_000, 0));
        assertNotEquals(new HistoryChunkCache.Key("p", "h", null, 0, 3_600_000, 0),
            new HistoryChunkCache.Key("p", "h", null, 0, 21_600_000, 0), "raw chunk size is part of the key");
    }

    @Test
    void putCopiesTheSliceAndGetReturnsIt() {
        HistoryChunkCache c = cache();
        long[] t = times(100);
        double[] v = new double[100];
        v[20] = Double.NaN;
        assertTrue(c.put(key(0), t, v, 10, 30));
        t[10] = -1;                                               // later changes to the source do not leak in
        HistoryChunkCache.Chunk got = c.get(key(0));
        assertNotNull(got);
        assertEquals(20, got.count());
        assertEquals(10_000L, got.t[0]);
        assertTrue(Double.isNaN(got.v[10]), "bad-quality gaps survive");
        assertEquals(1, c.hits());
        assertNull(c.get(key(5)));
        assertEquals(1, c.misses());
    }

    @Test
    void entriesExpireAfterTheTtl() {
        HistoryChunkCache c = cache();
        c.put(key(0), times(10), new double[10], 0, 10);
        clock.addAndGet(HistoryChunkCache.TTL_MS);
        assertNotNull(c.get(key(0)));
        clock.addAndGet(1);
        assertNull(c.get(key(0)));
        assertEquals(0, c.size());
        assertEquals(0, c.bytes());
    }

    @Test
    void lruEvictionKeepsTheBudget() {
        maxBytes.set(HistoryChunkCache.bytesFor(30) * 8);         // room for exactly 8 chunks of 30 points
        HistoryChunkCache c = cache();
        for (int i = 0; i < 4; i++) {
            assertTrue(c.put(key(i), times(30), new double[30], 0, 30));
        }
        c.get(key(0));                                            // key 0 becomes most recently used
        for (int i = 4; i < 10; i++) {
            assertTrue(c.put(key(i), times(30), new double[30], 0, 30));
        }
        assertTrue(c.bytes() <= maxBytes.get());
        assertEquals(8, c.size());
        assertNotNull(c.get(key(9)));
        assertNotNull(c.get(key(0)), "recently used survives");
        assertNull(c.get(key(1)), "least recently used evicted first");
        assertNull(c.get(key(2)));
    }

    @Test
    void chunkLargerThanAnEighthIsNotCached() {
        maxBytes.set(HistoryChunkCache.bytesFor(1_000) * 8);
        HistoryChunkCache c = cache();
        assertFalse(c.put(key(0), times(1_100), new double[1_100], 0, 1_100));
        assertTrue(c.put(key(1), times(900), new double[900], 0, 900));
    }

    @Test
    void zeroBudgetDisablesAndTrimClears() {
        HistoryChunkCache c = cache();
        c.put(key(0), times(10), new double[10], 0, 10);
        assertTrue(c.enabled());
        maxBytes.set(0);
        assertFalse(c.enabled());
        assertNull(c.get(key(0)));
        assertFalse(c.put(key(1), times(10), new double[10], 0, 10));
        c.trim();
        assertEquals(0, c.size());
        maxBytes.set(HistoryChunkCache.bytesFor(10) * 8);
        assertTrue(c.put(key(2), times(10), new double[10], 0, 10));
        c.close();
        assertEquals(0, c.size());
    }
}
