package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.inductiveautomation.ignition.common.sqltags.history.AggregationMode;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.paths.parser.TagPathParser;
import org.junit.jupiter.api.Test;

/** Planning helpers of HistoryService: plan cost cap, chunk geometry and caps. */
class HistoryPlanTest {

    private static final long H = 3_600_000L;
    private static final long D = 24 * H;

    private static TagPath path() {
        try {
            return TagPathParser.parse("[default]CTG/Temp");
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    private static HistoryService.Plan plan(AggregationMode agg, Long bucketMs, long from, long to) {
        return new HistoryService.Plan(path(), "[default]ctg/temp",
            new ReadPermissionCache.Check(HistoryResult.OK, "Float8", "Core Historian"), agg, bucketMs,
            new HistoryRequest.PenWindow(from, to, false, null));
    }

    private static HistoryService.Piece miss(long from, long to) {
        HistoryService.Piece p = new HistoryService.Piece(from, to, null);
        p.slots.add(new HistoryService.Slot(new HistoryChunkCache.Key("k", "h", null, 0, to - from, from), from, to));
        return p;
    }

    private static HistoryService.Piece hit(long from, long to) {
        return new HistoryService.Piece(from, to, new HistoryChunkCache.Chunk(new long[] {from}, new double[] {1}, 0));
    }

    private static HistoryService.Plan fiveQueryPlan() {
        HistoryService.Plan p = plan(null, null, 0, 50);
        p.pieces.add(miss(0, 10));
        p.pieces.add(miss(10, 20));
        p.pieces.add(hit(20, 30));
        p.cacheHits = 1;
        p.pieces.add(miss(30, 40));
        p.pieces.add(new HistoryService.Piece(40, 45, null));   // open live edge
        p.pieces.add(miss(45, 50));
        return p;
    }

    @Test
    void planCostUnderTheCapChangesNothing() throws Exception {
        HistoryService.Plan p = fiveQueryPlan();
        HistoryService.enforcePlanCost(List.of(p), 5);
        assertEquals(6, p.pieces.size());
        assertEquals(5, HistoryService.countQueries(List.of(p)));
    }

    @Test
    void firstAdjacentMissesAreMerged() throws Exception {
        HistoryService.Plan p = fiveQueryPlan();
        HistoryService.enforcePlanCost(List.of(p), 2);
        assertEquals(2, HistoryService.countQueries(List.of(p)));
        assertEquals(3, p.pieces.size(), "[0,20) query, [20,30) hit, [30,50) query");
        assertEquals(0, p.pieces.get(0).from);
        assertEquals(20, p.pieces.get(0).to);
        assertEquals(2, p.pieces.get(0).slots.size(), "both chunks are still admitted to the cache");
        assertTrue(p.pieces.get(1).cached != null);
        assertEquals(2, p.pieces.get(2).slots.size(), "[30,40) and [45,50); the open edge [40,45) has none");
        assertEquals(1, p.cacheHits);
    }

    @Test
    void thenTheWholeSpanIsOneQuery() throws Exception {
        HistoryService.Plan p = fiveQueryPlan();
        HistoryService.Plan q = plan(null, null, 0, 10);
        q.pieces.add(miss(0, 10));
        HistoryService.enforcePlanCost(List.of(p, q), 2);
        assertEquals(2, HistoryService.countQueries(List.of(p, q)));
        assertEquals(1, p.pieces.size(), "the hit inside the span is re-fetched");
        assertEquals(0, p.pieces.get(0).from);
        assertEquals(50, p.pieces.get(0).to);
        assertEquals(0, p.cacheHits);
    }

    @Test
    void stillTooManyQueriesIsRangeTooLarge() {
        HistoryService.Plan p = fiveQueryPlan();
        HistoryService.Plan q = plan(null, null, 0, 10);
        q.pieces.add(miss(0, 10));
        HistoryService.Failed f = assertThrows(HistoryService.Failed.class,
            () -> HistoryService.enforcePlanCost(List.of(p, q), 1));
        assertEquals(ErrorCode.RANGE_TOO_LARGE, f.code());
    }

    @Test
    void rawChunkGeometry() {
        assertEquals(H, HistoryService.rawChunkMs(H));
        assertEquals(H, HistoryService.rawChunkMs(50 * H));
        assertEquals(6 * H, HistoryService.rawChunkMs(51 * H));
        assertEquals(D, HistoryService.rawChunkMs(31 * D));
        assertEquals(D, HistoryService.rawChunkMs(400 * D), "never more than the largest chunk");
    }

    @Test
    void aggregatedCapCountsBucketsOfEveryPiece() {
        HistoryService.Plan p = plan(AggregationMode.MinMax, 1_000L, 0, 20_000);
        p.pieces.add(new HistoryService.Piece(0, 10_000, null));
        p.pieces.add(hit(10_000, 20_000));
        assertEquals(20 * 2 + 2, HistoryService.aggregatedCap(p));
        HistoryService.Plan lv = plan(AggregationMode.LastValue, 1_000L, 0, 20_000);
        lv.pieces.add(new HistoryService.Piece(0, 20_000, null));
        assertEquals(20 + 2, HistoryService.aggregatedCap(lv));
    }

    /** Over-fetch: partly covered sealed chunks are fetched whole only when ≥ 3/4 covered. */
    @Test
    void aggregatedOverFetchIsBounded() {
        HistoryChunkCache cache = new HistoryChunkCache(() -> 64L << 20, System::currentTimeMillis);
        long b = 1_000L;
        long chunk = b * HistoryService.AGG_CHUNK_BUCKETS;
        long sealed = 100 * chunk;
        // 10 buckets inside one sealed chunk: only those 10 buckets are queried (not the 500-bucket chunk).
        HistoryService.Plan small = plan(AggregationMode.LastValue, b, 3 * chunk + 100 * b, 3 * chunk + 110 * b);
        HistoryService.planAggregatedChunks(small, sealed, cache);
        assertEquals(1, small.pieces.size());
        assertEquals(3 * chunk + 100 * b, small.pieces.get(0).from);
        assertEquals(3 * chunk + 110 * b, small.pieces.get(0).to);
        assertEquals(1, small.pieces.get(0).slots.size(), "the covered part is cached under its own key");
        assertEquals(new HistoryChunkCache.Key("[default]ctg/temp", "Core Historian", "LastValue", b, 10 * b,
            3 * chunk + 100 * b), small.pieces.get(0).slots.get(0).key, "exact-range key, never a whole-chunk key");
        assertEquals(10 + 2, HistoryService.aggregatedCap(small));
        // 300 buckets across two chunks (150 + 150): both edges queried as covered, nothing over-fetched.
        HistoryService.Plan mid = plan(AggregationMode.LastValue, b, 4 * chunk - 150 * b, 4 * chunk + 150 * b);
        HistoryService.planAggregatedChunks(mid, sealed, cache);
        long fetched = 0;
        for (HistoryService.Piece p : mid.pieces) {
            fetched += p.to - p.from;
        }
        assertEquals(300 * b, fetched);
        // 400 of 500 buckets covered (≥ 3/4): the whole chunk is fetched and cached (100 buckets over-fetched).
        HistoryService.Plan big = plan(AggregationMode.LastValue, b, 6 * chunk + 100 * b, 7 * chunk);
        HistoryService.planAggregatedChunks(big, sealed, cache);
        assertEquals(1, big.pieces.size());
        assertEquals(6 * chunk, big.pieces.get(0).from);
        assertEquals(1, big.pieces.get(0).slots.size());
    }

    @Test
    void lowerBound() {
        long[] t = {10, 20, 20, 30};
        assertEquals(0, HistoryService.lowerBound(t, 0, 4, 5));
        assertEquals(1, HistoryService.lowerBound(t, 0, 4, 20));
        assertEquals(3, HistoryService.lowerBound(t, 0, 4, 25));
        assertEquals(4, HistoryService.lowerBound(t, 0, 4, 31));
        assertEquals(2, HistoryService.lowerBound(t, 2, 4, 15));
    }
}
