package com.example.simpletagdisplay.gateway.browse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeoutException;
import java.util.function.BiConsumer;
import java.util.function.LongSupplier;
import java.util.stream.Collectors;

import com.example.simpletagdisplay.gateway.delegate.PropsSnapshot;
import com.example.simpletagdisplay.gateway.security.BindingLint;
import com.example.simpletagdisplay.gateway.security.ReadScope;
import com.example.simpletagdisplay.gateway.security.SecurityKeys;
import com.example.simpletagdisplay.gateway.security.TrustedProps;
import com.inductiveautomation.ignition.common.browsing.BrowseFilter;
import com.inductiveautomation.ignition.common.browsing.Results;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.tags.browsing.NodeDescription;
import com.inductiveautomation.ignition.common.tags.config.types.TagObjectType;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import org.junit.jupiter.api.Test;

/**
 * The recursive tag search engine: query parsing and the wildcard matcher (no catastrophic
 * backtracking), what matches, and every bound — depth, rows, folder calls, results, time, parallelism — plus the
 * read-scope region, denied / failed folders, provider continuation and cancellation. Driven by a fake tag tree whose
 * "session queue" is a trampoline, like the delegate's.
 */
class TagSearchTest {

    // =========================================================================================================
    // Fake tag tree + queue
    // =========================================================================================================

    /** A fake provider tree: folder key → children; special folders deny, fail or hang. */
    static final class FakeTree implements TagSearch.Port {
        final Map<String, List<NodeDescription>> folders = new HashMap<>();
        final Set<String> deny = new HashSet<>();
        final Set<String> fail = new HashSet<>();
        final Set<String> hang = new HashSet<>();
        final Deque<Runnable> queue = new ArrayDeque<>();
        final List<String> browsed = new ArrayList<>();
        long now;
        long readTimeout = 5_000;
        long costPerCall;                 // clock advance per browse call (simulates a slow provider)
        boolean quirkLastPagePoint = true; // 8.3.10: a continuation point on the last (short) page too
        int inFlight;
        int maxInFlight;

        FakeTree folder(String key, NodeDescription... kids) {
            folders.computeIfAbsent(key, k -> new ArrayList<>()).addAll(List.of(kids));
            return this;
        }

        @Override
        public CompletableFuture<Results<NodeDescription>> browse(TagPath folder, BrowseFilter filter) {
            String key = ReadScope.folderKey(folder);
            browsed.add(key + (filter.getContinuationPoint() == null ? "" : "#" + filter.getContinuationPoint()));
            now += costPerCall;
            if (hang.contains(key)) {
                return new CompletableFuture<>();
            }
            if (fail.contains(key)) {
                return CompletableFuture.failedFuture(new IllegalStateException("provider exploded"));
            }
            if (deny.contains(key)) {
                return CompletableFuture.completedFuture(Results.error(QualityCode.Bad_AccessDenied));
            }
            List<NodeDescription> all = folders.get(key);
            if (all == null) {
                return CompletableFuture.completedFuture(Results.error(QualityCode.Bad_NotFound));
            }
            int from = filter.getContinuationPoint() == null ? 0 : Integer.parseInt(filter.getContinuationPoint());
            int to = Math.min(all.size(), from + filter.getMaxResults());
            Results<NodeDescription> r = new Results<>(new ArrayList<>(all.subList(from, to)));
            r.setResultQuality(QualityCode.Good);
            r.setTotalAvailableResults(all.size());
            if (to < all.size() || quirkLastPagePoint) {
                r.setContinuationPoint(String.valueOf(to));
            }
            return CompletableFuture.completedFuture(r);
        }

        @Override
        public <T> void hop(CompletableFuture<T> f, long timeoutMs, BiConsumer<T, Throwable> cb) {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            queue.add(() -> {
                inFlight--;
                if (f.isDone()) {
                    try {
                        cb.accept(f.join(), null);
                    } catch (CompletionException e) {
                        cb.accept(null, e.getCause());
                    }
                } else {
                    now += timeoutMs;
                    cb.accept(null, new TimeoutException());
                }
            });
        }

        @Override
        public long readTimeoutMs() {
            return readTimeout;
        }

        @Override
        public LongSupplier clock() {
            return () -> now;
        }

        void drain() {
            while (!queue.isEmpty()) {
                queue.poll().run();
            }
        }
    }

    static NodeDescription tag(String name, DataType dt) {
        return NodeDescription.newBuilder().name(name).objectType(TagObjectType.AtomicTag).dataType(dt).hasChildren(false).build();
    }

    static NodeDescription folder(String name) {
        return NodeDescription.newBuilder().name(name).objectType(TagObjectType.Folder).hasChildren(true).build();
    }

    static NodeDescription udt(String name) {
        return NodeDescription.newBuilder().name(name).objectType(TagObjectType.UdtInstance).hasChildren(true).build();
    }

    static final TagSearch.Region EVERYTHING = new TagSearch.Region() {
        @Override
        public boolean descend(String folderKey) {
            return true;
        }

        @Override
        public boolean include(String tagKey) {
            return true;
        }
    };

    static TagPath path(String s) {
        return ReadScope.parseFolder(s, "default").get();
    }

    static TagSearch.Query q(String text) {
        return TagSearch.Query.parse(text).orElseThrow();
    }

    /** Runs a search to completion and returns its outcome. */
    static TagSearch.Outcome run(FakeTree t, String query, TagSearch.Region region, TagSearch.Limits limits, String... starts) {
        TagSearch.Outcome[] out = new TagSearch.Outcome[1];
        List<TagPath> s = new ArrayList<>();
        for (String x : starts) {
            s.add(path(x));
        }
        TagSearch.Run.start(t, q(query), region, limits, s, o -> {
            assertNull(out[0], "done exactly once");
            out[0] = o;
        });
        t.drain();
        assertNotNull(out[0], "the search finished");
        return out[0];
    }

    static List<String> labels(TagSearch.Outcome o) {
        return o.matches().stream().map(TagSearch.Match::label).collect(Collectors.toList());
    }

    /** [default] → Area1 (Pump101 udt: Speed, Temp) / Area2 (TempSP, Label) / _types_ (Motor: Temp) + Counter. */
    static FakeTree plant() {
        return new FakeTree()
            .folder("[default]", folder("Area1"), folder("Area2"), folder("_types_"), tag("Counter", DataType.Int4))
            .folder("[default]area1", udt("Pump101"), tag("Level", DataType.Float8))
            .folder("[default]area1/pump101", tag("Speed", DataType.Float8), tag("Temp", DataType.Float8))
            .folder("[default]area2", tag("TempSP", DataType.Float8), tag("Label", DataType.String))
            .folder("[default]_types_", folder("Motor"))
            .folder("[default]_types_/motor", tag("Temp", DataType.Float8));
    }

    // =========================================================================================================
    // Query + matcher
    // =========================================================================================================

    @Test
    void queryParsing() {
        assertEquals("pump", q("  PUMP ").text());
        assertFalse(q("pump").wildcard());
        assertTrue(q("pump*").wildcard());
        assertTrue(q("p?mp").wildcard());
        for (String bad : new String[] {null, "", "   ", "*", "**?", " * ", "x".repeat(65), "a\u0000b", "a\nb", "a" + (char) 0x2028 + "b", "a" + (char) 0x2029 + "b"}) {
            assertEquals(Optional.empty(), TagSearch.Query.parse(bad), String.valueOf(bad));
        }
        assertTrue(TagSearch.Query.parse("x".repeat(64)).isPresent(), "64 characters is the limit");
    }

    @Test
    void containsMatchesNameOrRelativePath() {
        TagSearch.Query temp = q("temp");
        assertTrue(temp.matches("temp", "area1/temp"));
        assertTrue(temp.matches("x", "temperatures/x"), "a folder name in the path finds the tags inside it");
        assertFalse(temp.matches("speed", "area1/pump101/speed"));
        assertTrue(q("pump101/sp").matches("speed", "area1/pump101/speed"), "path fragments with '/'");
    }

    @Test
    void wildcardMatchesTheWholeNameOrPath() {
        assertTrue(TagSearch.glob("temp*", "tempsp"));
        assertFalse(TagSearch.glob("temp", "tempsp"), "no star: whole text");
        assertTrue(TagSearch.glob("*sp", "tempsp"));
        assertTrue(TagSearch.glob("t?mp", "temp"));
        assertFalse(TagSearch.glob("t?mp", "tmp"));
        assertTrue(TagSearch.glob("area*/speed", "area1/pump101/speed"), "* crosses folders");
        assertTrue(TagSearch.glob("*", ""));
        assertFalse(TagSearch.glob("?", ""));
        assertTrue(TagSearch.glob("a*b*c", "axxbyyc"));
        assertFalse(TagSearch.glob("a*b*c", "axxbyy"));
        TagSearch.Query w = q("pump*/s*");
        assertTrue(w.matches("speed", "pump101/speed"));
        assertFalse(w.matches("speed", "area1/pump101/speed"), "anchored at the start of the relative path");
        assertTrue(q("*pump*/s*").matches("speed", "area1/pump101/speed"));
    }

    @Test
    void wildcardMatcherHasNoCatastrophicBacktracking() {
        String pattern = "*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b";
        String text = "a".repeat(1024);
        long t0 = System.nanoTime();
        for (int i = 0; i < 20; i++) {
            assertFalse(TagSearch.glob(pattern, text));
        }
        long ms = (System.nanoTime() - t0) / 1_000_000;
        assertTrue(ms < 2_000, "20 worst-case matches of a 1024-char path took " + ms + " ms");
    }

    // =========================================================================================================
    // Walk
    // =========================================================================================================

    @Test
    void walkFindsTagsByNameAndPathSortedAndSkipsTypes() {
        TagSearch.Outcome o = run(plant(), "temp", EVERYTHING, TagSearch.DEFAULT_LIMITS, "[default]");
        assertEquals(List.of("[default]Area1/Pump101/Temp", "[default]Area2/TempSP"), labels(o),
            "sorted; the UDT definition under _types_ is never searched");
        assertTrue(o.complete());
        assertNull(o.stopped());
        assertEquals("[default]Area1/Pump101", o.matches().get(0).folderLabel());
        assertTrue(o.matches().get(0).trendable());
        assertEquals("[default]area1/pump101/temp", o.matches().get(0).key());

        assertEquals(List.of("[default]Area1/Pump101/Speed", "[default]Area1/Pump101/Temp"),
            labels(run(plant(), "pump101", EVERYTHING, TagSearch.DEFAULT_LIMITS, "[default]")), "a UDT instance name finds its members");
        assertEquals(List.of("[default]Area2/Label"), labels(run(plant(), "LABEL", EVERYTHING, TagSearch.DEFAULT_LIMITS, "[default]")),
            "case-insensitive; non-trendable tags are results too (the browser greys them)");
        assertFalse(run(plant(), "label", EVERYTHING, TagSearch.DEFAULT_LIMITS, "[default]").matches().get(0).trendable());
        assertEquals(List.of("[default]Area2/TempSP"), labels(run(plant(), "temp*", EVERYTHING, TagSearch.DEFAULT_LIMITS, "[default]Area2")),
            "the path is relative to the start folder");
        assertEquals(List.of(), labels(run(plant(), "area1", EVERYTHING, TagSearch.DEFAULT_LIMITS, "[default]Area1")),
            "the start folder's own name is not part of the relative path");
        assertEquals(List.of("[default]Area1/Pump101/Speed", "[default]Area1/Pump101/Temp"),
            labels(run(plant(), "*/pump101/*", EVERYTHING, TagSearch.DEFAULT_LIMITS, "[default]")));
    }

    @Test
    void depthIsBounded() {
        FakeTree t = new FakeTree();
        String key = "[default]";
        for (int i = 0; i < 25; i++) {
            t.folder(key, folder("L" + i), tag("T" + i, DataType.Float8));
            key = (key.endsWith("]") ? key : key + "/") + "l" + i;
        }
        t.folder(key, tag("T25", DataType.Float8));
        TagSearch.Limits limits = new TagSearch.Limits(5, 50_000, 5_000, 1_000, 5_000, 4, 500);
        TagSearch.Outcome o = run(t, "t", EVERYTHING, limits, "[default]");
        assertEquals(6, o.matches().size(), "levels 0..5 searched: " + labels(o));
        assertEquals(TagSearch.STOP_DEPTH, o.stopped());
        assertFalse(o.complete());
        assertEquals(6, t.browsed.size(), "folders below the depth limit are never browsed");
    }

    @Test
    void rowsFoldersAndResultsAreBounded() {
        FakeTree wide = new FakeTree();
        List<NodeDescription> kids = new ArrayList<>();
        for (int i = 0; i < 3_000; i++) {
            kids.add(tag("Tag" + i, DataType.Float8));
        }
        wide.folder("[default]big", kids.toArray(new NodeDescription[0]));
        TagSearch.Outcome nodes = run(wide, "nomatch", EVERYTHING, new TagSearch.Limits(16, 1_200, 5_000, 1_000, 5_000, 4, 500),
            "[default]big");
        assertEquals(TagSearch.STOP_NODES, nodes.stopped());
        assertEquals(1_200, nodes.nodes());

        TagSearch.Outcome results = run(wide, "tag", EVERYTHING, new TagSearch.Limits(16, 50_000, 5_000, 250, 5_000, 4, 500),
            "[default]big");
        assertEquals(TagSearch.STOP_RESULTS, results.stopped());
        assertEquals(250, results.matches().size());

        FakeTree many = new FakeTree();
        List<NodeDescription> dirs = new ArrayList<>();
        for (int i = 0; i < 100; i++) {
            dirs.add(folder("F" + i));
            many.folder("[default]f" + i, tag("X", DataType.Float8));
        }
        many.folder("[default]", dirs.toArray(new NodeDescription[0]));
        TagSearch.Outcome calls = run(many, "x", EVERYTHING, new TagSearch.Limits(16, 50_000, 10, 1_000, 5_000, 4, 500), "[default]");
        assertEquals(TagSearch.STOP_FOLDERS, calls.stopped());
        assertEquals(10, many.browsed.size(), "no more than maxFolders browse calls");
        assertEquals(9, calls.matches().size());
    }

    @Test
    void providerContinuationIsFollowedOnlyForFullPages() {
        FakeTree t = new FakeTree();
        List<NodeDescription> kids = new ArrayList<>();
        for (int i = 0; i < 25; i++) {
            kids.add(tag("Tag" + i, DataType.Float8));
        }
        t.folder("[default]f", kids.toArray(new NodeDescription[0]));
        TagSearch.Outcome o = run(t, "tag", EVERYTHING, new TagSearch.Limits(16, 50_000, 5_000, 1_000, 5_000, 4, 10), "[default]f");
        assertEquals(25, o.matches().size());
        assertTrue(o.complete());
        assertEquals(List.of("[default]f", "[default]f#10", "[default]f#20"), t.browsed,
            "pages of 10; the last (short) page's continuation point is not followed (8.3.10 quirk)");
    }

    @Test
    void parallelBrowsesAreBounded() {
        FakeTree t = new FakeTree();
        List<NodeDescription> dirs = new ArrayList<>();
        for (int i = 0; i < 40; i++) {
            dirs.add(folder("F" + i));
            t.folder("[default]f" + i, tag("X" + i, DataType.Float8));
        }
        t.folder("[default]", dirs.toArray(new NodeDescription[0]));
        TagSearch.Outcome o = run(t, "x", EVERYTHING, new TagSearch.Limits(16, 50_000, 5_000, 1_000, 5_000, 3, 500), "[default]");
        assertEquals(40, o.matches().size());
        assertEquals(3, t.maxInFlight, "never more than `parallel` browse calls in flight");
    }

    @Test
    void timeBudgetStopsTheWalk() {
        FakeTree slow = new FakeTree();
        List<NodeDescription> dirs = new ArrayList<>();
        for (int i = 0; i < 50; i++) {
            dirs.add(folder("F" + i));
            slow.folder("[default]f" + i, tag("X" + i, DataType.Float8));
        }
        slow.folder("[default]", dirs.toArray(new NodeDescription[0]));
        slow.costPerCall = 300;   // each call "takes" 300 ms of the 2 s budget
        TagSearch.Outcome o = run(slow, "x", EVERYTHING, new TagSearch.Limits(16, 50_000, 5_000, 1_000, 2_000, 1, 500), "[default]");
        assertEquals(TagSearch.STOP_TIME, o.stopped());
        assertTrue(slow.browsed.size() <= 8, "the walk stopped at the budget: " + slow.browsed.size() + " calls");

        FakeTree hung = plant();
        hung.hang.add("[default]area1");
        hung.readTimeout = 10_000;
        TagSearch.Outcome h = run(hung, "temp", EVERYTHING, new TagSearch.Limits(16, 50_000, 5_000, 1_000, 3_000, 4, 500), "[default]");
        assertEquals(TagSearch.STOP_TIME, h.stopped(), "a hung folder times out at the budget's end, not after ctg.read.timeoutMs");
        assertEquals(1, h.failed());
        assertTrue(hung.now <= 3_000, "finished within the budget: " + hung.now);
        assertEquals(List.of("[default]Area2/TempSP"), labels(h), "what was found before the budget ran out");
    }

    @Test
    void deniedFoldersAreSkippedFailedOnesMakeItIncomplete() {
        FakeTree t = plant();
        t.deny.add("[default]area1");
        TagSearch.Outcome d = run(t, "temp", EVERYTHING, TagSearch.DEFAULT_LIMITS, "[default]");
        assertEquals(List.of("[default]Area2/TempSP"), labels(d), "nothing below a folder the provider denies");
        assertTrue(d.complete(), "a denied folder does not make the search incomplete");
        assertEquals(1, d.denied());

        FakeTree f = plant();
        f.fail.add("[default]area2");
        TagSearch.Outcome e = run(f, "temp", EVERYTHING, TagSearch.DEFAULT_LIMITS, "[default]");
        assertEquals(List.of("[default]Area1/Pump101/Temp"), labels(e));
        assertEquals(TagSearch.STOP_ERRORS, e.stopped());
        assertEquals(1, e.failed());
    }

    @Test
    void regionPrunesFoldersAndFiltersTags() {
        // read scope: allowedRoots [default]Area1/Pump101 — Area2 is never opened, the root's ancestors are
        PropsSnapshot p = props("{\"tagBrowser\":{\"enabled\":true},\"readScope\":{\"allowedRoots\":[\"[default]Area1/Pump101\"]}}");
        ReadScope scope = ReadScope.build(p, Set.of(), k -> false, List.of("System"), "default", List.of("default", "System"));
        FakeTree t = plant();
        TagSearch.Outcome o = run(t, "e", TagSearch.Region.of(scope), TagSearch.DEFAULT_LIMITS, "[default]");
        assertEquals(List.of("[default]Area1/Pump101/Speed", "[default]Area1/Pump101/Temp"), labels(o),
            "Area1/Level matches 'e' but lies outside the scope; Area2 is outside too");
        assertFalse(t.browsed.contains("[default]area2"), "folders that cannot contain a scope tag are not browsed: " + t.browsed);
        assertTrue(t.browsed.contains("[default]area1"), "ancestors of a root are browsed");

        // denied provider: never walked
        PropsSnapshot all = props("{\"tagBrowser\":{\"enabled\":true}}");
        ReadScope sys = ReadScope.build(all, Set.of(), k -> false, List.of("System"), "default", List.of("default", "System"));
        FakeTree s = new FakeTree().folder("[system]", tag("Uptime", DataType.Int8)).folder("[default]", tag("Uptime", DataType.Int8));
        List<String> found = labels(run(s, "uptime", TagSearch.Region.of(sys), TagSearch.DEFAULT_LIMITS, "[System]", "[default]"));
        assertEquals(List.of("[default]Uptime"), found);
        assertFalse(s.browsed.contains("[system]"));
    }

    @Test
    void cancelStopsLaunchingAndFinishesOnce() {
        FakeTree t = new FakeTree();
        List<NodeDescription> dirs = new ArrayList<>();
        for (int i = 0; i < 30; i++) {
            dirs.add(folder("F" + i));
            t.folder("[default]f" + i, tag("X" + i, DataType.Float8));
        }
        t.folder("[default]", dirs.toArray(new NodeDescription[0]));
        TagSearch.Outcome[] out = new TagSearch.Outcome[1];
        int[] calls = new int[1];
        TagSearch.Run r = TagSearch.Run.start(t, q("x"), EVERYTHING, new TagSearch.Limits(16, 50_000, 5_000, 1_000, 5_000, 2, 500),
            List.of(path("[default]")), o -> {
                calls[0]++;
                out[0] = o;
            });
        t.queue.poll().run();   // root page → 30 folders queued, 2 in flight
        r.cancel(TagSearch.STOP_CANCELLED);
        assertNull(out[0], "the outcome waits for the calls in flight");
        t.drain();
        assertEquals(1, calls[0]);
        assertEquals(TagSearch.STOP_CANCELLED, out[0].stopped());
        assertTrue(t.browsed.size() <= 3, "nothing launched after the cancel: " + t.browsed);
        r.cancel(TagSearch.STOP_CANCELLED);
        assertEquals(1, calls[0], "cancel after the end is a no-op");
    }

    @Test
    void noStartFinishesAtOnce() {
        TagSearch.Outcome[] out = new TagSearch.Outcome[1];
        TagSearch.Run r = TagSearch.Run.start(new FakeTree(), q("x"), EVERYTHING, TagSearch.DEFAULT_LIMITS, List.of(), o -> out[0] = o);
        assertTrue(r.finished());
        assertNotNull(out[0]);
        assertTrue(out[0].matches().isEmpty());
    }

    // =========================================================================================================
    // Result spelling and depth stops
    // =========================================================================================================

    /** A node as a provider returns it: with its full path in the provider's own spelling. */
    static NodeDescription withPath(NodeDescription n, String full) {
        return NodeDescription.newBuilder().name(n.getName()).objectType(n.getObjectType()).dataType(n.getDataType())
            .hasChildren(n.hasChildren()).fullPath(ReadScope.parseFolder(full, "default").get()).build();
    }

    @Test
    void resultsUseTheProvidersSpellingNotTheClients() {
        // the client typed the start folder in other case; the provider's NodeDescription carries the real spelling
        FakeTree t = new FakeTree()
            .folder("[default]ctg_search", withPath(folder("Area1"), "[default]CTG_Search/Area1"))
            .folder("[default]ctg_search/area1", withPath(udt("Pump101"), "[default]CTG_Search/Area1/Pump101"))
            .folder("[default]ctg_search/area1/pump101", withPath(tag("Speed", DataType.Float8), "[default]CTG_Search/Area1/Pump101/Speed"),
                tag("Temp", DataType.Float8));   // (no full path: built from the canonical parent)
        TagSearch.Outcome o = run(t, "pump101", EVERYTHING, TagSearch.DEFAULT_LIMITS, "[DEFAULT]ctg_search");
        assertEquals(List.of("[default]CTG_Search/Area1/Pump101/Speed", "[default]CTG_Search/Area1/Pump101/Temp"), labels(o),
            "old code: [DEFAULT]ctg_search/Area1/Pump101/Speed");
        assertEquals("[default]CTG_Search/Area1/Pump101", o.matches().get(0).folderLabel(), "the folder label too");
        // a full path naming ANOTHER tag (not the same key) is never adopted: the place cannot change, only the case
        FakeTree odd = new FakeTree().folder("[default]a", withPath(tag("X", DataType.Float8), "[default]Elsewhere/X"));
        assertEquals(List.of("[default]a/X"), labels(run(odd, "x", EVERYTHING, TagSearch.DEFAULT_LIMITS, "[default]a")));
    }

    @Test
    void depthIsNotReportedForFoldersTheReadScopePrunes() {
        // read scope = one tag, [default]Area1/Temp; depth limit 1. Area1 (depth 1) is opened on the way to it; its
        // folder Deep (depth 2) is too deep AND outside the scope: the scope prunes it, so nothing in scope was cut
        FakeTree t = new FakeTree()
            .folder("[default]", folder("Area1"), folder("Other"))
            .folder("[default]area1", tag("Temp", DataType.Float8), folder("Deep"))
            .folder("[default]area1/deep", tag("Temp", DataType.Float8))
            .folder("[default]other", tag("Temp", DataType.Float8));
        PropsSnapshot p = props("{\"tagBrowser\":{\"enabled\":true},\"readScope\":{\"allowedRoots\":[\"[default]Area1/Temp\"]}}");
        ReadScope scope = ReadScope.build(p, Set.of(), k -> false, List.of("System"), "default", List.of("default", "System"));
        TagSearch.Limits limits = new TagSearch.Limits(1, 50_000, 5_000, 1_000, 5_000, 4, 500);
        TagSearch.Outcome o = run(t, "temp", TagSearch.Region.of(scope), limits, "[default]");
        assertEquals(List.of("[default]Area1/Temp"), labels(o));
        assertNull(o.stopped(), "everything in scope was searched: no 'depth' stop (old code: depth)");
        assertTrue(o.complete());
        // the same tree without a scope: Deep really is cut by the depth limit -> depth
        TagSearch.Outcome all = run(t, "temp", EVERYTHING, limits, "[default]");
        assertEquals(TagSearch.STOP_DEPTH, all.stopped());
    }

    // =========================================================================================================
    // Helpers
    // =========================================================================================================

    static PropsSnapshot props(String json) {
        JsonObject root = JsonParser.parseString(json).getAsJsonObject();
        Map<String, JsonElement> m = new HashMap<>();
        for (String leaf : SecurityKeys.CHART) {
            TrustedProps.readTrustForm(leaf, p -> {
                JsonElement cur = root;
                for (String part : p.split("\\.")) {
                    if (cur == null || !cur.isJsonObject() || !cur.getAsJsonObject().has(part)) {
                        return Optional.empty();
                    }
                    cur = cur.getAsJsonObject().get(part);
                }
                return Optional.of(cur);
            }).ifPresent(v -> m.put(leaf, v));
        }
        return new PropsSnapshot(m, BindingLint.LintReport.clean(), true);
    }
}
