package com.example.simpletagdisplay.gateway.trend;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.Test;

/** TrendListStore v2 — bounds, dedupe, 8-thread concurrency, eviction, clear on user change. */
class TrendListStoreTest {

    private final UUID s1 = UUID.randomUUID();
    private final UUID s2 = UUID.randomUUID();

    private static TrendListStore store(int maxPens, int maxGroups) {
        return new TrendListStore(() -> maxPens, () -> maxGroups);
    }

    @Test
    void addIsIdempotentAndDedupesCaseInsensitively() {
        TrendListStore st = store(32, 16);
        assertEquals(TrendListStore.AddResult.ADDED, st.add(s1, "default", "[default]CTG/Temp", "engineer"));
        assertEquals(TrendListStore.AddResult.ALREADY, st.add(s1, "default", "[DEFAULT]ctg/temp", "engineer"));
        List<TrendListStore.Entry> l = st.get(s1, "default");
        assertEquals(1, l.size());
        assertEquals("[default]CTG/Temp", l.get(0).path(), "casing of the first add is kept");
        assertEquals("[default]ctg/temp", l.get(0).key());
        assertEquals("engineer", l.get(0).addedBy());
        assertTrue(st.remove(s1, "default", "[Default]Ctg/TEMP"));
        assertFalse(st.remove(s1, "default", "[default]CTG/Temp"));
        assertEquals(0, st.totalEntries());
    }

    @Test
    void boundsPerListAndGroupsPerSession() {
        TrendListStore st = store(2, 2);
        st.add(s1, "a", "[p]A", "u");
        st.add(s1, "a", "[p]B", "u");
        assertEquals(TrendListStore.AddResult.FULL, st.add(s1, "a", "[p]C", "u"));
        st.add(s1, "b", "[p]A", "u");
        assertEquals(TrendListStore.AddResult.GROUPS_FULL, st.add(s1, "c", "[p]A", "u"));
        assertEquals(TrendListStore.AddResult.ADDED, st.add(s2, "c", "[p]A", "u"), "other sessions are independent");
        // an emptied group frees its slot
        st.remove(s1, "b", "[p]A");
        assertEquals(TrendListStore.AddResult.ADDED, st.add(s1, "c", "[p]A", "u"));
    }

    @Test
    void listenersGetPathsAndIncreasingVersionsAndOnlyTheirKey() {
        TrendListStore st = store(32, 16);
        List<List<String>> seen = Collections.synchronizedList(new ArrayList<>());
        List<Long> versions = Collections.synchronizedList(new ArrayList<>());
        TrendListListener l = (k, paths, v) -> {
            seen.add(paths);
            versions.add(v);
        };
        st.addListener(new TrendKey(s1, "default"), l);
        st.add(s1, "default", "[p]A", "u");
        st.add(s1, "default", "[p]B", "u");
        st.add(s1, "other", "[p]C", "u");          // other group: not notified
        st.add(s2, "default", "[p]D", "u");        // other session: not notified
        st.remove(s1, "default", "[p]A");
        assertEquals(List.of(List.of("[p]A"), List.of("[p]A", "[p]B"), List.of("[p]B")), seen);
        assertTrue(versions.get(0) < versions.get(1) && versions.get(1) < versions.get(2));
        st.removeListener(new TrendKey(s1, "default"), l);
        st.add(s1, "default", "[p]E", "u");
        assertEquals(3, seen.size());
    }

    @Test
    void eightThreadsNeverExceedTheBoundsOrLoseEntries() throws Exception {
        int maxPens = 20;
        TrendListStore st = store(maxPens, 4);
        AtomicInteger added = new AtomicInteger();
        AtomicInteger notified = new AtomicInteger();
        st.addListener(new TrendKey(s1, "g0"), (k, p, v) -> notified.incrementAndGet());
        ExecutorService ex = Executors.newFixedThreadPool(8);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<?>> fs = new ArrayList<>();
        for (int t = 0; t < 8; t++) {
            int thread = t;
            fs.add(ex.submit(() -> {
                go.await();
                for (int i = 0; i < 200; i++) {
                    String group = "g" + (i % 6);   // 6 groups requested, 4 allowed
                    String path = "[p]T" + ((i * 7 + thread) % 40);
                    if (st.add(s1, group, path, "u") == TrendListStore.AddResult.ADDED) {
                        added.incrementAndGet();
                    }
                    if (i % 5 == 0 && st.remove(s1, group, "[p]T" + ((i + thread) % 40))) {
                        added.decrementAndGet();
                    }
                }
                return null;
            }));
        }
        go.countDown();
        for (Future<?> f : fs) {
            f.get(30, TimeUnit.SECONDS);
        }
        ex.shutdown();
        int total = 0;
        int groups = 0;
        for (int g = 0; g < 6; g++) {
            List<TrendListStore.Entry> l = st.get(s1, "g" + g);
            assertTrue(l.size() <= maxPens, "list bound");
            assertEquals(l.size(), l.stream().map(TrendListStore.Entry::key).distinct().count(), "no duplicates");
            total += l.size();
            groups += l.isEmpty() ? 0 : 1;
        }
        assertTrue(groups <= 4, "group bound: " + groups);
        assertEquals(added.get(), total, "every successful add/remove is reflected");
        assertEquals(total, st.totalEntries(), "global counter consistent");
        assertTrue(notified.get() > 0);
    }

    @Test
    void evictSessionDropsListsAndListeners() {
        TrendListStore st = store(32, 16);
        AtomicInteger calls = new AtomicInteger();
        st.addListener(new TrendKey(s1, "default"), (k, p, v) -> calls.incrementAndGet());
        st.add(s1, "default", "[p]A", "u");
        st.add(s1, "x", "[p]B", "u");
        st.add(s2, "default", "[p]C", "u");
        assertEquals(2, st.evictSession(s1));
        assertTrue(st.get(s1, "default").isEmpty());
        assertEquals(1, st.totalEntries());
        assertFalse(st.sessions().contains(s1));
        int before = calls.get();
        st.add(s1, "default", "[p]A", "u");
        assertEquals(before, calls.get(), "listeners of an evicted session are gone");
    }

    @Test
    void clearSessionEmptiesListsKeepsAndNotifiesListeners() {
        TrendListStore st = store(32, 16);
        List<List<String>> seen = Collections.synchronizedList(new ArrayList<>());
        st.addListener(new TrendKey(s1, "default"), (k, p, v) -> seen.add(p));
        st.add(s1, "default", "[p]Secret", "engineer");
        st.add(s1, "other", "[p]B", "engineer");
        st.add(s2, "default", "[p]C", "operator");
        assertEquals(2, st.clearSession(s1));
        assertTrue(st.get(s1, "default").isEmpty());
        assertTrue(st.get(s1, "other").isEmpty());
        assertEquals(List.of(), seen.get(seen.size() - 1), "listener told the list is empty");
        assertEquals(1, st.get(s2, "default").size(), "other sessions untouched");
        st.add(s1, "default", "[p]X", "operator");
        assertEquals(List.of("[p]X"), seen.get(seen.size() - 1), "listener kept after the clear");
    }

    @Test
    void globalCapAndClearAll() {
        TrendListStore st = store(64, 64);
        st.add(s1, "a", "[p]A", "u");
        st.clearAll();
        assertEquals(0, st.totalEntries());
        assertTrue(st.sessions().isEmpty());
    }

    @Test
    void sessionsListsOwnersOfListsAndListeners() {
        TrendListStore st = store(32, 16);
        st.add(s1, "a", "[p]A", "u");
        st.addListener(new TrendKey(s2, "a"), (k, p, v) -> { });
        assertTrue(st.sessions().contains(s1));
        assertTrue(st.sessions().contains(s2));
    }
}
