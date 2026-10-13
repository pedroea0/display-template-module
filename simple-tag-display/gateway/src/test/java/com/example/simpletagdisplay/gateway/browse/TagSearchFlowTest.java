package com.example.simpletagdisplay.gateway.browse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Constructor;
import java.lang.reflect.Proxy;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeoutException;
import java.util.function.BiConsumer;

import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.delegate.CallContext;
import com.example.simpletagdisplay.gateway.delegate.HandlerRegistry;
import com.example.simpletagdisplay.gateway.delegate.PropsSnapshot;
import com.example.simpletagdisplay.gateway.ops.ChartOps;
import com.example.simpletagdisplay.gateway.security.ReadScope;
import com.example.simpletagdisplay.gateway.security.UserContext;
import com.example.simpletagdisplay.gateway.tags.HistoryAvailability;
import com.example.simpletagdisplay.gateway.tags.TagMetaReader;
import com.example.simpletagdisplay.gateway.util.RateLimitedLog;
import com.inductiveautomation.ignition.common.browsing.BrowseFilter;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.model.values.BasicQualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.tags.model.TagManager;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * The request flow of the recursive search through the real {@link TagBrowseService} with a fake chart host: one
 * search per chart (supersede keeps the admission ticket), cancel, the per-session concurrency cap
 * across two charts, delegate stop / user change, the permission pass failing closed, stored-result expiry and a
 * {@code rootPath} change during the walk. The host's "session queue" is a list drained by the test, so browse pages
 * and the permission read stay in flight until {@link Host#drain}.
 */
class TagSearchFlowTest {

    private static final UserContext ENGINEER = UserContext.of(true, "engineer", List.of("Engineer"), Set.of(),
        SessionScope.Client, true);
    private static final List<String> PROVIDERS = List.of("default", "System");

    private final Map<String, String> settings = new ConcurrentHashMap<>();
    private final GatewayServices services = new GatewayServices(null, null, new ModuleSettings(settings::get));
    private final UUID session = UUID.randomUUID();

    @AfterEach
    void close() {
        services.close();
    }

    // =========================================================================================================
    // Fake host
    // =========================================================================================================

    /** A chart of {@link #session}: fake tag tree (TagSearchTest.plant + System), queue drained by the test. */
    private final class Host implements ChartOps.Host {
        final TagSearchTest.FakeTree tree = TagSearchTest.plant()
            .folder("[system]", TagSearchTest.tag("GatewayTemp", DataType.Float8));
        final Deque<Runnable> queue = new ArrayDeque<>();
        final Set<String> unreadable = new HashSet<>();   // normalized keys whose read comes back access-denied
        volatile boolean readFails;
        volatile PropsSnapshot props;
        volatile UserContext user = ENGINEER;
        final TagBrowseService svc;
        final UUID sid;
        long now;

        Host(String propsJson) {
            this(propsJson, session);
        }

        Host(String propsJson, UUID sid) {
            props = TagSearchTest.props(propsJson);
            svc = new TagBrowseService(TagSearch.DEFAULT_LIMITS, () -> now);
            this.sid = sid;
        }

        @Override public PropsSnapshot props() { return props; }
        @Override public UserContext user() { return user; }
        @Override public String defaultProvider() { return "default"; }
        @Override public GatewayServices services() { return services; }
        @Override public UUID sessionId() { return sid; }

        @Override
        public ReadScope scope() {
            return ReadScope.build(props, Set.of(), k -> false, List.of("System"), "default", PROVIDERS);
        }

        @Override
        public TagManager tagManager() {
            return (TagManager) Proxy.newProxyInstance(TagManager.class.getClassLoader(), new Class<?>[] {TagManager.class},
                (proxy, m, args) -> {
                    if (m.getName().equals("browseAsync") && args.length == 3) {
                        return tree.browse((TagPath) args[0], (BrowseFilter) args[1]);
                    }
                    if (m.getName().equals("readAsync") && args.length == 2) {
                        if (readFails) {
                            return CompletableFuture.failedFuture(new IllegalStateException("read exploded"));
                        }
                        List<QualifiedValue> out = new ArrayList<>();
                        for (Object p : (List<?>) args[0]) {
                            String key = ReadScope.folderKey((TagPath) p);
                            out.add(unreadable.contains(key) ? new BasicQualifiedValue(null, QualityCode.Bad_AccessDenied)
                                : new BasicQualifiedValue(1.0, QualityCode.Good));
                        }
                        return CompletableFuture.completedFuture(out);
                    }
                    throw new UnsupportedOperationException(m.getName());
                });
        }

        @Override
        public <T> void onQueue(CompletableFuture<T> f, long timeoutMs, BiConsumer<T, Throwable> cb) {
            queue.add(() -> {
                if (f.isDone()) {
                    try {
                        cb.accept(f.join(), null);
                    } catch (CompletionException e) {
                        cb.accept(null, e.getCause());
                    }
                } else {
                    cb.accept(null, new TimeoutException());
                }
            });
        }

        void drain() {
            while (!queue.isEmpty()) {
                queue.poll().run();
            }
        }

        @Override public HistoryAvailability.Status history(TagMetaReader.Meta meta) { return null; }
        @Override public RateLimitedLog warnings() { return new RateLimitedLog(logger(), 1000); }
        @Override public LoggerEx logger() { return LoggerEx.newBuilder().build("TagSearchFlowTest"); }
        @Override public String describe() { return "test chart"; }

        /** Sends {@code chart.browse body}; the future completes when the service answers. */
        CompletableFuture<JsonObject> send(String body) {
            CompletableFuture<JsonObject> result = new CompletableFuture<>();
            svc.browse(callContext(this, body, result), this, PROVIDERS);
            return result;
        }
    }

    private static final String OPEN = "{\"tagBrowser\":{\"enabled\":true}}";

    /** CallContext's constructor is package-private to the delegate package (the delegate builds it). */
    private static CallContext callContext(Host h, String body, CompletableFuture<JsonObject> result) {
        try {
            Constructor<CallContext> c = CallContext.class.getDeclaredConstructor(
                com.inductiveautomation.perspective.gateway.api.Component.class,
                com.inductiveautomation.perspective.gateway.api.Session.class, UserContext.class, PropsSnapshot.class,
                String.class, String.class, JsonObject.class, HandlerRegistry.RateClass.class, CompletableFuture.class);
            c.setAccessible(true);
            return c.newInstance(null, null, h.user, h.props, "chart.browse", "1", JsonParser.parseString(body).getAsJsonObject(),
                HandlerRegistry.RateClass.READ, result);
        } catch (ReflectiveOperationException e) {
            throw new IllegalStateException(e);
        }
    }

    private static String code(CompletableFuture<JsonObject> f) {
        assertTrue(f.isDone(), "answered");
        JsonObject r = f.join();
        return r.get("ok").getAsBoolean() ? "ok" : r.getAsJsonObject("error").get("code").getAsString();
    }

    private static JsonObject data(CompletableFuture<JsonObject> f) {
        assertEquals("ok", code(f));
        return f.join().getAsJsonObject("data");
    }

    private static List<String> paths(JsonObject data) {
        List<String> out = new ArrayList<>();
        JsonArray a = data.getAsJsonArray("results");
        a.forEach(x -> out.add(x.getAsJsonObject().get("path").getAsString()));
        return out;
    }

    private static String stopped(JsonObject data) {
        JsonObject s = data.getAsJsonObject("search");
        return s.get("stopped").isJsonNull() ? null : s.get("stopped").getAsString();
    }

    private TagSearchAdmission admission() {
        return TagSearchAdmission.of(services);
    }

    // =========================================================================================================
    // Tests
    // =========================================================================================================

    @Test
    void searchAnswersAfterThePermissionPassAndNeverEntersDeniedProviders() {
        Host h = new Host(OPEN);
        h.unreadable.add("[default]area1/pump101/speed");
        CompletableFuture<JsonObject> f = h.send("{\"path\":\"\",\"search\":\"temp\"}");
        assertFalse(f.isDone(), "pages are in flight");
        assertEquals(1, admission().running(), "the search holds a slot while it runs");
        h.drain();
        JsonObject d = data(f);
        assertEquals(List.of("[default]Area1/Pump101/Temp", "[default]Area2/TempSP"), paths(d),
            "sorted; [System] (ctg.read.deniedProviders) and _types_ never searched");
        assertTrue(h.tree.browsed.stream().noneMatch(k -> k.startsWith("[system]")), "no browse of a denied provider");
        assertEquals(0, admission().running(), "slot returned");

        CompletableFuture<JsonObject> s = h.send("{\"path\":\"\",\"search\":\"speed\"}");
        h.drain();
        assertEquals(List.of(), paths(data(s)), "a tag the user may not read is dropped by the permission pass");
    }

    @Test
    void aNewSearchSupersedesTheRunningOneAndKeepsItsTicket() {
        Host h = new Host(OPEN);
        CompletableFuture<JsonObject> a = h.send("{\"path\":\"\",\"search\":\"temp\"}");
        CompletableFuture<JsonObject> b = h.send("{\"path\":\"\",\"search\":\"level\"}");
        CompletableFuture<JsonObject> c = h.send("{\"path\":\"\",\"search\":\"counter\"}");
        assertEquals("superseded", stopped(data(b)), "a waiting search replaced by a newer one answers at once");
        assertEquals(0, data(b).getAsJsonArray("results").size());
        assertFalse(a.isDone(), "the running walk ends when its pages in flight return");
        assertEquals(1, admission().running(), "retyping never takes a second slot");
        h.drain();
        assertEquals("superseded", stopped(data(a)));
        assertEquals(0, data(a).getAsJsonArray("results").size(), "unchecked matches are never sent");
        assertEquals(List.of("[default]Counter"), paths(data(c)));
        assertEquals(0, admission().running());
    }

    @Test
    void cancelStopsTheSearchAndReturnsTheSlot() {
        Host h = new Host(OPEN);
        CompletableFuture<JsonObject> a = h.send("{\"path\":\"\",\"search\":\"temp\"}");
        CompletableFuture<JsonObject> cancel = h.send("{\"cancelSearch\":true}");
        assertTrue(data(cancel).get("cancelled").getAsBoolean());
        h.drain();
        assertEquals("cancelled", stopped(data(a)));
        assertFalse(data(a).getAsJsonObject("search").get("complete").getAsBoolean());
        assertEquals(0, admission().running());
        CompletableFuture<JsonObject> again = h.send("{\"cancelSearch\":true}");
        assertFalse(data(again).get("cancelled").getAsBoolean(), "nothing running");
    }

    @Test
    void oneRunningSearchPerSessionAcrossCharts() {
        Host chart1 = new Host(OPEN);
        Host chart2 = new Host(OPEN);
        CompletableFuture<JsonObject> a = chart1.send("{\"path\":\"\",\"search\":\"temp\"}");
        CompletableFuture<JsonObject> b = chart2.send("{\"path\":\"\",\"search\":\"temp\"}");
        assertEquals("BUSY", code(b), "a second chart of the same session waits for the first search");
        chart1.drain();
        assertEquals("ok", code(a));
        CompletableFuture<JsonObject> c = chart2.send("{\"path\":\"\",\"search\":\"temp\"}");
        chart2.drain();
        assertEquals("ok", code(c));
    }

    @Test
    void stopAndUserChangeEndTheSearchAndDropTheResults() {
        Host h = new Host(OPEN);
        CompletableFuture<JsonObject> a = h.send("{\"path\":\"\",\"search\":\"temp\"}");
        h.svc.stop();
        assertEquals(0, admission().running(), "delegate teardown returns the slot at once");
        h.drain();
        assertFalse(a.isDone(), "a stopped delegate answers nothing (the page is gone)");

        Host u = new Host(OPEN);
        CompletableFuture<JsonObject> done = u.send("{\"path\":\"\",\"search\":\"temp\",\"limit\":1}");
        u.drain();
        String cont = data(done).get("continuation").getAsString();
        CompletableFuture<JsonObject> b = u.send("{\"path\":\"\",\"search\":\"level\"}");
        u.svc.authChanged();
        assertEquals("AUTH_CHANGED", code(b), "the running search of the previous user is answered AUTH_CHANGED now");
        assertEquals(0, admission().running());
        u.drain();
        CompletableFuture<JsonObject> page = u.send("{\"path\":\"\",\"search\":\"temp\",\"limit\":1,\"continuation\":\"" + cont + "\"}");
        assertEquals("BAD_REQUEST", code(page), "the previous user's stored results are gone");
    }

    @Test
    void permissionPassFailureFailsClosed() {
        Host h = new Host(OPEN);
        h.readFails = true;
        CompletableFuture<JsonObject> a = h.send("{\"path\":\"\",\"search\":\"temp\"}");
        h.drain();
        assertEquals("INTERNAL", code(a), "matches whose permissions could not be checked are never sent");
        assertEquals(0, admission().running());
    }

    @Test
    void storedResultsPageUntilTheyExpire() {
        Host h = new Host(OPEN);
        for (int i = 0; i < 5; i++) {
            h.tree.folder("[default]area2", TagSearchTest.tag("TempX" + i, DataType.Float8));
        }
        CompletableFuture<JsonObject> a = h.send("{\"path\":\"\",\"search\":\"temp\",\"limit\":3}");
        h.drain();
        JsonObject d = data(a);
        assertEquals(3, paths(d).size());
        assertEquals(7, d.get("totalAvailable").getAsInt());
        String cont = d.get("continuation").getAsString();
        CompletableFuture<JsonObject> p2 = h.send("{\"path\":\"\",\"search\":\"temp\",\"limit\":3,\"continuation\":\"" + cont + "\"}");
        assertEquals(3, paths(data(p2)).size(), "a page of the stored matches, no new walk");
        CompletableFuture<JsonObject> other = h.send("{\"path\":\"\",\"search\":\"tempx\",\"continuation\":\"" + cont + "\"}");
        assertEquals("BAD_REQUEST", code(other), "a continuation belongs to its exact text");
        h.now += TagBrowseService.SEARCH_RESULTS_TTL_MS + 1;
        CompletableFuture<JsonObject> late = h.send("{\"path\":\"\",\"search\":\"temp\",\"limit\":3,\"continuation\":\"" + cont + "\"}");
        assertEquals("BAD_REQUEST", code(late), "stored results expire (a permission change must not hide behind Load more)");
    }

    @Test
    void aRootPathChangeDuringTheWalkRefusesTheResults() {
        Host h = new Host("{\"tagBrowser\":{\"enabled\":true,\"rootPath\":\"[default]Area1\"}}");
        CompletableFuture<JsonObject> a = h.send("{\"path\":\"\",\"search\":\"temp\"}");
        h.props = TagSearchTest.props("{\"tagBrowser\":{\"enabled\":true,\"rootPath\":\"[default]Area2\"}}");
        h.drain();
        assertEquals("BROWSE_ROOT_VIOLATION", code(a), "found below the old root: not shown");
        assertEquals(0, admission().running());

        CompletableFuture<JsonObject> b = h.send("{\"path\":\"\",\"search\":\"temp\"}");
        h.drain();
        assertEquals(List.of("[default]Area2/TempSP"), paths(data(b)), "the new root is searched");
        CompletableFuture<JsonObject> out = h.send("{\"path\":\"[default]Area1\",\"search\":\"temp\"}");
        assertEquals("BROWSE_ROOT_VIOLATION", code(out));
        assertTrue(TagBrowseService.below(new TagSearch.Match(TagSearchTest.path("[default]Area2/X"), "X", "[default]Area2",
            DataType.Float8), TagSearchTest.path("[default]Area2")));
        assertFalse(TagBrowseService.below(new TagSearch.Match(TagSearchTest.path("[default]Area20/X"), "X", "[default]Area20",
            DataType.Float8), TagSearchTest.path("[default]Area2")), "a sibling with the same prefix is not below");
    }

    @Test
    void refusalsBeforeAnyWalk() {
        Host h = new Host(OPEN);
        assertEquals("BAD_REQUEST", code(h.send("{\"path\":\"\",\"search\":\"*?\"}")));
        assertEquals("OUT_OF_SCOPE", code(h.send("{\"path\":\"[System]\",\"search\":\"temp\"}")));
        Host off = new Host("{\"tagBrowser\":{\"enabled\":false}}");
        assertEquals("ACTION_DISABLED", code(off.send("{\"path\":\"\",\"search\":\"temp\"}")));
        Host noRt = new Host("{\"tagBrowser\":{\"enabled\":true},\"readScope\":{\"allowRuntimePens\":false}}");
        assertEquals("OUT_OF_SCOPE", code(noRt.send("{\"path\":\"\",\"search\":\"temp\"}")));
        assertTrue(h.tree.browsed.isEmpty() && off.tree.browsed.isEmpty() && noRt.tree.browsed.isEmpty(), "nothing walked");
        assertEquals(0, admission().running());
    }

    // ---- cancel and slot fairness ----

    @Test
    void onlyABooleanTrueAloneCancels() {
        Host h = new Host(OPEN);
        CompletableFuture<JsonObject> a = h.send("{\"path\":\"\",\"search\":\"temp\"}");
        assertEquals("BAD_REQUEST", code(h.send("{\"cancelSearch\":false}")), "old code: {cancelled:false}, treated as a cancel");
        assertEquals("BAD_REQUEST", code(h.send("{\"cancelSearch\":\"true\"}")));
        assertEquals("BAD_REQUEST", code(h.send("{\"cancelSearch\":true,\"path\":\"\",\"search\":\"level\"}")), "ambiguous");
        assertFalse(a.isDone(), "the running search was not cancelled");
        h.drain();
        assertEquals(List.of("[default]Area1/Pump101/Temp", "[default]Area2/TempSP"), paths(data(a)));
        assertEquals(null, stopped(data(a)));
    }

    @Test
    void aChartGivesItsSlotBackOnANewSearchWhileAnotherSessionWaits() {
        List<Host> hogs = new ArrayList<>();
        List<CompletableFuture<JsonObject>> first = new ArrayList<>();
        for (int i = 0; i < TagSearchAdmission.MAX_GLOBAL; i++) {
            Host hog = new Host(OPEN, UUID.randomUUID());
            hogs.add(hog);
            first.add(hog.send("{\"path\":\"\",\"search\":\"temp\"}"));
        }
        assertEquals(TagSearchAdmission.MAX_GLOBAL, admission().running());
        Host victim = new Host(OPEN, UUID.randomUUID());
        assertEquals("BUSY", code(victim.send("{\"path\":\"\",\"search\":\"level\"}")), "the gateway cap is full");
        // hog 0 retypes: its running search is cancelled, the new one is refused BUSY (old code: superseded, slot kept)
        CompletableFuture<JsonObject> retype = hogs.get(0).send("{\"path\":\"\",\"search\":\"counter\"}");
        assertEquals("BUSY", code(retype));
        hogs.get(0).drain();
        assertEquals("superseded", stopped(data(first.get(0))), "the old search ends with no rows");
        assertEquals(TagSearchAdmission.MAX_GLOBAL - 1, admission().running(), "its slot went back");
        assertEquals("BUSY", code(hogs.get(0).send("{\"path\":\"\",\"search\":\"counter\"}")), "and the waiting session goes first");
        CompletableFuture<JsonObject> v = victim.send("{\"path\":\"\",\"search\":\"level\"}");
        victim.drain();
        assertEquals(List.of("[default]Area1/Level"), paths(data(v)), "the waiting session's retry is admitted");
        hogs.forEach(Host::drain);
        assertEquals(0, admission().running());
    }
}
