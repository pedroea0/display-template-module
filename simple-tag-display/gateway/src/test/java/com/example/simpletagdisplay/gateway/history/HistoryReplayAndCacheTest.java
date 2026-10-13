package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Proxy;
import java.util.HashMap;
import java.util.Map;

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

/** Chunk-cache admission, incremental replay depth, the last historical bucket. */
class HistoryReplayAndCacheTest {

    private static final long NOW = 1_791_398_400_000L;
    private static final long MIN = 60_000L;
    private static final long HOUR = 60 * MIN;
    private static final ModuleSettings.Settings S = ModuleSettings.Settings.defaults();

    private final GatewayServices services = new GatewayServices(null, null, new ModuleSettings(new HashMap<String, String>()::get));
    private final HistoryService history = services.history();

    @AfterEach
    void close() {
        services.close();
    }

    // ---- sealed chunk cache: only settled data ------------------------------------------------------------------

    /**
     * Stub Core Historian with analog compression: raw queries return only STORED samples (every 10 s up to
     * {@code storedUntil}); the held newest value is not among them. Count queries count stored samples per bucket.
     */
    private static TagHistoryManager historian(long storedUntil) {
        return (TagHistoryManager) Proxy.newProxyInstance(HistoryReplayAndCacheTest.class.getClassLoader(),
            new Class<?>[] {TagHistoryManager.class}, (proxy, method, args) -> {
                if ("toString".equals(method.getName())) {
                    return "stub historian";
                }
                TagHistoryQueryParams q = (TagHistoryQueryParams) args[0];
                StreamingDatasetWriter w = (StreamingDatasetWriter) args[1];
                long from = q.getStartDate().getTime();
                long to = q.getEndDate().getTime();
                w.initialize(new String[] {"t_stamp", "Step"}, new Class<?>[] {Long.class, Double.class}, true, 0);
                if (q.getReturnSize() < 0) {
                    for (long t = (from + 9_999) / 10_000 * 10_000; t <= Math.min(to, storedUntil); t += 10_000) {
                        w.write(new Object[] {t, 20.0}, new QualityCode[] {QualityCode.Good, QualityCode.Good});
                    }
                } else {
                    long b = Math.max(1, (to - from) / q.getReturnSize());
                    for (long t = from; t < to; t += b) {
                        double count = t <= storedUntil ? Math.max(0, (Math.min(t + b, storedUntil + 1) - t) / 10_000) : 0;
                        w.write(new Object[] {t, count}, new QualityCode[] {QualityCode.Good, QualityCode.Good});
                    }
                }
                w.finish();
                return null;
            });
    }

    private static TagPath path() {
        try {
            return TagPathParser.parse("[default]CTG/_SealProbe/Step");
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    /** One aggregated sealed chunk [cs, ce) answered with interpolated rows, admitted (or not) like dataTask does. */
    private static final long B = 5_000L;
    private static final long CE = BucketLadder.alignDown(NOW - 20 * MIN, B * 500);   // sealed: ends > 5 min ago
    private static final long CS = CE - B * 500;

    private HistoryChunkCache.Key admitAggregatedChunk(long storedUntil) {
        long b = B;
        long ce = CE;
        long cs = CS;
        HistoryService.Plan plan = new HistoryService.Plan(path(), "[default]ctg/_sealprobe/step",
            new ReadPermissionCache.Check(HistoryResult.OK, "Float8", "Core Historian"), AggregationMode.Average, b,
            new HistoryRequest.PenWindow(cs, ce, false, null));
        plan.serverNow = NOW;
        HistoryService.Piece piece = new HistoryService.Piece(cs, ce, null);
        HistoryChunkCache.Key key = new HistoryChunkCache.Key(plan.nk, "Core Historian", "Average", b, b * 500, cs);
        piece.slots.add(new HistoryService.Slot(key, cs, ce));
        PenSeriesWriter w = new PenSeriesWriter(cs, ce, plan.filter, true, false, new ResponseBudget(1_000_000).pen(10_000, 0));
        w.initialize(new String[] {"t_stamp", "Step"}, new Class<?>[] {Long.class, Double.class}, true, 500);
        for (long t = cs; t < ce; t += b) {
            // the historian interpolates toward the held live value: a ramp that changes once the value is stored
            w.write(new Object[] {t, 20.0 + (t - cs) / 1_000.0}, new QualityCode[] {QualityCode.Good, QualityCode.Good});
        }
        w.finish();
        history.admitSettled(historian(storedUntil), plan, piece, w);
        return key;
    }

    @Test
    void aSealedChunkIsCachedOnlyWhenAStoredSampleFollowsIt() {
        // The value changed inside the chunk and has been held since: Core Historian has not stored it yet (the last
        // stored sample is the one before the change), so the sealed chunk is still interpolated toward the live
        // value and must not be cached (it was, for 30 min).
        assertTrue(CE <= NOW - 5 * MIN);
        HistoryChunkCache.Key held = admitAggregatedChunk(CS + 10 * MIN);
        assertNull(history.chunkCache().get(held), "not provably settled: answered but not cached");
        services.history().chunkCache().clear();
        // A stored sample 1 min ago proves everything before it settled: cached.
        HistoryChunkCache.Key settled = admitAggregatedChunk(NOW - MIN);
        assertNotNull(history.chunkCache().get(settled), "settled: cached as before");
    }

    // ---- incremental replay depth -------------------------------------------------------------------------------

    private static HistoryRequest parse(long start, long end, String extra, String penExtra, long now) throws Exception {
        return HistoryRequest.parse(JsonParser.parseString("{\"v\":2,\"start\":" + start + ",\"end\":" + end + extra
            + ",\"pens\":[{\"key\":\"p\",\"tagPath\":\"t\"" + penExtra + "}]}"), S, now);
    }

    @Test
    void anAggregatedTickReplaysAtLeastTheStorageLatency() throws Exception {
        long since = BucketLadder.alignDown(NOW, 500) - 500;      // the client's last bucket (500 ms grid)
        HistoryRequest inc = parse(NOW - 10 * MIN, NOW, ",\"bucketMs\":500", ",\"since\":" + since, NOW);
        HistoryRequest.PenWindow w = inc.window(inc.pens().get(0));
        assertEquals(BucketLadder.alignDown(since - HistoryRequest.INCREMENTAL_REPLAY_MS, 500), w.from(),
            "5 s re-sent, not only the last 2 buckets (1 s)");
        assertEquals(w.from(), w.replaceFrom().longValue());
        assertTrue(since - w.from() >= HistoryRequest.INCREMENTAL_REPLAY_MS);
        // a coarse grid keeps its two buckets (already longer than the margin)
        HistoryRequest coarse = parse(NOW - HOUR, NOW, ",\"bucketMs\":10000",
            ",\"since\":" + (BucketLadder.alignDown(NOW, 10_000) - 10_000), NOW);
        HistoryRequest.PenWindow c = coarse.window(coarse.pens().get(0));
        assertEquals(BucketLadder.alignDown(NOW, 10_000) - 20_000, c.from());
    }

    // ---- last partial bucket of a past window -------------------------------------------------------------------

    @Test
    void aWindowEndingInThePastKeepsItsLastBucket() throws Exception {
        long start = BucketLadder.alignDown(NOW - 9 * HOUR, HOUR);         // 06:00-like
        long end = start + 8 * HOUR + 30 * MIN;                              // 14:30-like, well before now
        HistoryRequest r = parse(start, end, ",\"pointCount\":10", "", NOW);
        assertEquals(HOUR, r.bucketMs());
        assertEquals(start + 9 * HOUR, r.alignedEnd(), "the 14:00-15:00 bucket is complete: returned, not dropped");
        // live edge: the bucket still filling is never returned
        HistoryRequest live = parse(NOW - 8 * HOUR, NOW + 7_000, "", "", NOW + 7_000);
        assertEquals(2 * MIN, live.bucketMs());
        assertEquals(NOW, live.alignedEnd(), "the filling bucket [NOW, NOW + 2 min) is never returned");
        // a past end whose bucket is not complete yet stays aligned down
        assertEquals(start + 8 * HOUR, HistoryRequest.alignedEnd(start, end, HOUR, start + 8 * HOUR + 50 * MIN, 5_000));
        // and the extra bucket never exceeds pointCountMax
        assertEquals(start + 8 * HOUR, HistoryRequest.alignedEnd(start, end, HOUR, NOW, 8));
        assertEquals(start + 9 * HOUR, HistoryRequest.alignedEnd(start, end, HOUR, NOW, 9));
    }
}
