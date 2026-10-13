package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import com.example.simpletagdisplay.gateway.GatewayServices;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.inductiveautomation.ignition.common.StreamingDatasetWriter;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.history.AggregationMode;
import com.inductiveautomation.ignition.common.sqltags.history.TagHistoryQueryParams;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.paths.parser.TagPathParser;
import com.inductiveautomation.ignition.gateway.historian.TagHistoryManager;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * The second phase driven through {@link HistoryService} itself — the real {@code FairHistoryExecutor}, the real
 * data/fallback tasks, {@code settle}, {@code collectFallbacks} and the late submission — against a stub historian,
 * instead of only through the pure {@code needsFallback} predicate.
 *
 * <ul>
 *   <li>a re-run whose cache hits alone put it over its cap gets its fallback in the same submission;</li>
 *   <li>a re-run that goes over its cap while re-querying (the live edge grew) gets it in the late submission;</li>
 *   <li>that late fallback never evicts a later pen that already settled with data: previously it took its
 *       points in request order and turned the settled pen into {@code tooManyPoints};</li>
 *   <li>a re-run that fits is answered with its data and gets no fallback.</li>
 * </ul>
 */
class HistorySecondPhaseTest {

    private static final long NOW = 1_791_398_400_000L;
    private static final long SPAN = 100_000L;
    private static final int POINT_COUNT_MAX = 100;     // fallback grid: at most 100 LastValue buckets (+2 slack)
    private static final long PEN_CAP = 40;

    private final ModuleSettings settings;
    private final GatewayServices services;
    private final HistoryService history;
    /** Raw rows the stub historian returns per tag name (aggregated queries return one row per bucket). */
    private final Map<String, Integer> rawRows = new HashMap<>();
    private final List<String> queries = Collections.synchronizedList(new ArrayList<>());

    HistorySecondPhaseTest() {
        Map<String, String> p = new HashMap<>();
        p.put("ctg.history.pointCountMax", Integer.toString(POINT_COUNT_MAX));
        p.put("ctg.history.pointCountDefault", "100");
        settings = new ModuleSettings(p::get);
        services = new GatewayServices(null, null, settings);
        history = services.history();
    }

    @AfterEach
    void close() {
        services.close();
    }

    // ---- fixtures ----------------------------------------------------------------------------------------------

    private static TagPath path(String name) {
        try {
            return TagPathParser.parse("[default]CTG/" + name);
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    /** A raw request with {@code onTooManyPoints:"aggregate"} (only raw() and the fallback switch are read here). */
    private HistoryRequest rawAggregateRequest() throws Exception {
        String body = "{\"v\":2,\"start\":" + (NOW - 300_000) + ",\"end\":" + NOW + ",\"mode\":\"raw\","
            + "\"onTooManyPoints\":\"aggregate\",\"pens\":[{\"key\":\"a\",\"tagPath\":\"[default]CTG/A\"}]}";
        return HistoryRequest.parse(JsonParser.parseString(body), settings.get(), NOW);
    }

    private static HistoryService.Plan rawPlan(String name, int order, ResponseBudget response) {
        HistoryService.Plan plan = new HistoryService.Plan(path(name), "[default]ctg/" + name.toLowerCase(),
            new ReadPermissionCache.Check(HistoryResult.OK, "Float8", "Core Historian"), null, null,
            new HistoryRequest.PenWindow(0, SPAN, false, null));
        plan.order = order;
        plan.cap = PEN_CAP;
        plan.fallbackAgg = AggregationMode.LastValue;
        plan.penBudget = response.pen(PEN_CAP, order);
        return plan;
    }

    /** A plan marked for a re-run (repairCut's verdict) with one query piece over the whole window. */
    private static HistoryService.Plan rerunPlan(String name, int order, ResponseBudget response) {
        HistoryService.Plan plan = rawPlan(name, order, response);
        plan.pieces.add(new HistoryService.Piece(0, SPAN, null));
        plan.rerun = true;
        plan.finalStatus = HistoryResult.TOO_MANY_POINTS;   // evicted in the first phase
        return plan;
    }

    /** A pen that settled with {@code n} points in the first phase (served from one cache chunk, no query). */
    private static HistoryService.Plan settledPlan(String name, int order, long cap, int n, ResponseBudget response) {
        HistoryService.Plan plan = new HistoryService.Plan(path(name), "[default]ctg/" + name.toLowerCase(),
            new ReadPermissionCache.Check(HistoryResult.OK, "Float8", "Core Historian"), null, null,
            new HistoryRequest.PenWindow(0, SPAN, false, null));
        plan.order = order;
        plan.cap = cap;
        plan.penBudget = response.pen(cap, order);
        plan.pieces.add(new HistoryService.Piece(0, SPAN, chunk(n)));
        HistoryService.takeCacheHits(plan, response);
        assertFalse(plan.penBudget.isOver(), name + " holds its points");
        plan.finalStatus = null;
        return plan;
    }

    private static HistoryChunkCache.Chunk chunk(int n) {
        long[] t = new long[n];
        double[] v = new double[n];
        for (int i = 0; i < n; i++) {
            t[i] = i * (SPAN / Math.max(1, n));
            v[i] = i;
        }
        return new HistoryChunkCache.Chunk(t, v, 0);
    }

    /** Stub historian: raw → {@link #rawRows} rows spread over the range; aggregated → one row per bucket. */
    private TagHistoryManager historian() {
        return (TagHistoryManager) Proxy.newProxyInstance(getClass().getClassLoader(), new Class<?>[] {TagHistoryManager.class},
            (proxy, method, args) -> {
                if (!"queryHistory".equals(method.getName()) || args == null || args.length != 2
                        || !(args[0] instanceof TagHistoryQueryParams)) {
                    if ("toString".equals(method.getName())) {
                        return "stub historian";
                    }
                    throw new UnsupportedOperationException(method.getName());
                }
                TagHistoryQueryParams q = (TagHistoryQueryParams) args[0];
                StreamingDatasetWriter w = (StreamingDatasetWriter) args[1];
                String tag = q.getPaths().get(0).toString();
                String name = tag.substring(tag.lastIndexOf('/') + 1);
                long from = q.getStartDate().getTime();
                long to = q.getEndDate().getTime();
                boolean raw = q.getReturnSize() < 0;
                int n = raw ? rawRows.getOrDefault(name, 0) : q.getReturnSize();
                queries.add(name + (raw ? ":raw" : ":agg") + ":" + n);
                w.initialize(new String[] {"t_stamp", name}, new Class<?>[] {Long.class, Double.class}, true, n);
                long step = Math.max(1L, (to - from) / Math.max(1, n));
                for (int i = 0; i < n; i++) {
                    w.write(new Object[] {from + i * step, (double) i}, new QualityCode[] {QualityCode.Good, QualityCode.Good});
                }
                w.finish();
                return null;
            });
    }

    /** Runs the second phase with a generous deadline, then freezes and assembles like {@code execute} does. */
    private List<HistoryResult.Pen> runSecondPhase(ResponseBudget response, HistoryService.Plan... plans) throws Exception {
        UUID sid = UUID.randomUUID();
        HistoryService.Admission admission = history.new Admission(sid);
        try {
            history.secondPhase(rawAggregateRequest(), List.of(plans), historian(), sid, response, admission,
                System.currentTimeMillis() + 10_000L, settings.get());
        } finally {
            admission.close();
        }
        response.freeze();
        List<HistoryResult.Pen> out = new ArrayList<>();
        for (HistoryService.Plan plan : plans) {
            HistoryService.reconcile(plan);
            out.add(HistoryService.assemble(plan.path.toString(), plan, settings.get(), false));
        }
        return out;
    }

    // ---- tests ---------------------------------------------------------------------------------------------------

    @Test
    void aReRunThatGrewOverItsCapGetsItsFallbackInTheLateSubmission() throws Exception {
        ResponseBudget response = new ResponseBudget(10_000);
        HistoryService.Plan a = rerunPlan("A", 0, response);
        rawRows.put("A", 50);                              // the live edge grew: 50 > its cap of 40
        HistoryResult.Pen pa = runSecondPhase(response, a).get(0);
        assertEquals(PenSeriesWriter.PenBudget.Overflow.PEN_CAP, a.penBudget.overflow(), "over its own cap while re-querying");
        assertEquals(HistoryResult.OK, pa.status());
        assertTrue(pa.downgraded(), "the late fallback answered it");
        assertTrue(pa.count() > 0 && pa.count() <= POINT_COUNT_MAX + 2, "bounded by the fallback grid: " + pa.count());
        assertEquals(2, queries.size(), "re-run first, then the late fallback: " + queries);
        assertEquals("A:raw:50", queries.get(0));
        assertTrue(queries.get(1).startsWith("A:agg:"), queries.get(1));
    }

    @Test
    void theLateFallbackNeverEvictsALaterPenThatAlreadySettled() throws Exception {
        // B settled with 1 950 of the 2 000 points; A's re-run gives its points back when it goes over its cap, which
        // leaves 50 free — fewer than A's 100-bucket fallback. Previously the fallback took its points in A's request
        // order and evicted B (B: tooManyPoints, its data dropped).
        ResponseBudget response = new ResponseBudget(2_000);
        HistoryService.Plan a = rerunPlan("A", 0, response);
        HistoryService.Plan b = settledPlan("B", 1, 5_000, 1_950, response);
        rawRows.put("A", 50);
        List<HistoryResult.Pen> out = runSecondPhase(response, a, b);
        assertEquals(HistoryResult.OK, out.get(1).status(), "B keeps its data");
        assertEquals(1_950, out.get(1).count());
        assertFalse(b.penBudget.isOver());
        assertEquals(HistoryResult.TOO_MANY_POINTS, out.get(0).status(), "A's fallback did not fit what was left");
        assertEquals(Integer.valueOf(settings.get().historyMaxPointsPerResponse()), out.get(0).limit,
            "refused by the response cap, not by its own cap");
        assertEquals(PenSeriesWriter.PenBudget.Overflow.RESPONSE_CAP, a.fallbackBudget.overflow());
    }

    @Test
    void theLateFallbackStillUsesWhatIsFree() throws Exception {
        ResponseBudget response = new ResponseBudget(2_000);
        HistoryService.Plan a = rerunPlan("A", 0, response);
        HistoryService.Plan b = settledPlan("B", 1, 5_000, 1_500, response);
        rawRows.put("A", 50);
        List<HistoryResult.Pen> out = runSecondPhase(response, a, b);
        assertEquals(HistoryResult.OK, out.get(0).status());
        assertTrue(out.get(0).downgraded(), "500 free: the fallback fits without touching B");
        assertEquals(HistoryResult.OK, out.get(1).status());
        assertEquals(1_500, out.get(1).count());
    }

    @Test
    void aReRunOverItsCapByItsCacheHitsGetsTheFallbackInTheSameSubmission() throws Exception {
        ResponseBudget response = new ResponseBudget(10_000);
        HistoryService.Plan a = rawPlan("A", 0, response);
        a.pieces.add(new HistoryService.Piece(0, SPAN, chunk(60)));   // the chunk filled since: 60 hits > cap 40
        a.rerun = true;
        a.finalStatus = HistoryResult.TOO_MANY_POINTS;
        HistoryResult.Pen pa = runSecondPhase(response, a).get(0);
        assertEquals(PenSeriesWriter.PenBudget.Overflow.PEN_CAP, a.penBudget.overflow(), "over its cap at re-planning");
        assertEquals(HistoryResult.OK, pa.status());
        assertTrue(pa.downgraded());
        assertEquals(1, queries.size(), "no raw re-query, only the fallback: " + queries);
        assertTrue(queries.get(0).startsWith("A:agg:"));
    }

    @Test
    void aReRunThatFitsIsAnsweredWithItsDataAndNoFallback() throws Exception {
        ResponseBudget response = new ResponseBudget(10_000);
        HistoryService.Plan a = rerunPlan("A", 0, response);
        rawRows.put("A", 30);
        HistoryResult.Pen pa = runSecondPhase(response, a).get(0);
        assertEquals(HistoryResult.OK, pa.status());
        assertFalse(pa.downgraded());
        assertEquals(30, pa.count());
        assertEquals(List.of("A:raw:30"), queries);
    }
}
