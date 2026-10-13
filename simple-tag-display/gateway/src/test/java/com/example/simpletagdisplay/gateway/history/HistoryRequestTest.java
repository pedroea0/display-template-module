package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.sqltags.history.AggregationMode;
import org.junit.jupiter.api.Test;

/** History request validation and clamps. */
class HistoryRequestTest {

    private static final ModuleSettings.Settings S = ModuleSettings.Settings.defaults();
    private static final long NOW = 1_791_398_400_000L;
    private static final long DAY = 86_400_000L;

    private static HistoryRequest parse(String json) throws HistoryRequest.Invalid {
        return HistoryRequest.parse(JsonParser.parseString(json), S, NOW);
    }

    private static ErrorCode code(String json) {
        return assertThrows(HistoryRequest.Invalid.class, () -> parse(json)).code();
    }

    private static String body(String extra) {
        return "{\"v\":2,\"start\":" + (NOW - 300_000) + ",\"end\":" + NOW + ",\"pens\":[{\"key\":\"p:0\",\"tagPath\":"
            + "\"[default]CTG/Temp\"}]" + extra + "}";
    }

    @Test
    void minimalRequestUsesTheDefaults() throws Exception {
        HistoryRequest r = parse(body(""));
        assertFalse(r.raw());
        assertEquals(AggregationMode.LastValue, r.aggregation());
        assertEquals(300, r.pointCount());
        assertNull(r.requestId());
        assertEquals(1, r.pens().size());
        assertEquals(AggregationMode.LastValue, r.pens().get(0).aggregation());
        assertEquals(250_000, r.rawCapPerPen());
    }

    @Test
    void fieldsAreParsedAndClamped() throws Exception {
        HistoryRequest r = parse(body(",\"requestId\":\"h-42\",\"mode\":\"raw\",\"pointCount\":999999,"
            + "\"maxPointsPerPen\":1000,\"aggregation\":\"minmax\""));
        assertTrue(r.raw());
        assertEquals("h-42", r.requestId());
        assertEquals(5_000, r.pointCount());
        assertEquals(1_000, r.rawCapPerPen());
        assertEquals(AggregationMode.MinMax, r.aggregation());
        HistoryRequest future = parse("{\"v\":2,\"start\":" + (NOW - 1000) + ",\"end\":" + (NOW + DAY)
            + ",\"pens\":[{\"key\":\"k\",\"tagPath\":\"x\",\"aggregation\":\"Maximum\",\"since\":null}]}");
        assertEquals(NOW + 60_000L, future.end(), "end clamped to now + 60 s");
        assertEquals(AggregationMode.Maximum, future.pens().get(0).aggregation());
    }

    @Test
    void invalidRequests() {
        assertEquals(ErrorCode.PROTOCOL_MISMATCH, code("{\"v\":1}"));
        assertEquals(ErrorCode.BAD_REQUEST, code("[]"));
        assertEquals(ErrorCode.RANGE_INVALID, code("{\"v\":2,\"start\":10,\"end\":5,\"pens\":[]}"));
        assertEquals(ErrorCode.RANGE_INVALID, code("{\"v\":2,\"start\":1000,\"end\":1500,\"pens\":[]}"));
        assertEquals(ErrorCode.BAD_REQUEST, code("{\"v\":2,\"start\":1.5,\"end\":5000,\"pens\":[]}"));
        assertEquals(ErrorCode.BAD_REQUEST, code(body(",\"mode\":\"wide\"")));
        assertEquals(ErrorCode.BAD_REQUEST, code(body(",\"aggregation\":\"AD-HOC-PYTHON\"")));
        assertEquals(ErrorCode.BAD_REQUEST, code(body(",\"aggregation\":\"Bogus\"")));
        assertEquals(ErrorCode.BAD_REQUEST, code(body(",\"requestId\":\"bad id\"")));
        assertEquals(ErrorCode.BAD_REQUEST, code(body(",\"bucketMs\":0")));
        assertEquals(ErrorCode.BAD_REQUEST, code(body(",\"bucketMs\":-5")));
        assertEquals(ErrorCode.BAD_REQUEST, code("{\"v\":2,\"start\":0,\"end\":5000,\"pens\":[]}"));
        StringBuilder many = new StringBuilder("{\"v\":2,\"start\":0,\"end\":5000,\"pens\":[");
        for (int i = 0; i < 33; i++) {
            many.append(i == 0 ? "" : ",").append("{\"key\":\"k").append(i).append("\",\"tagPath\":\"t\"}");
        }
        assertEquals(ErrorCode.TOO_MANY_PENS, code(many.append("]}").toString()));
        assertEquals(ErrorCode.BAD_REQUEST, code("{\"v\":2,\"start\":0,\"end\":5000,\"pens\":[{\"key\":\"\",\"tagPath\":\"t\"}]}"));
    }

    @Test
    void spanLimitsAndDowngrade() throws Exception {
        String rawLong = "{\"v\":2,\"mode\":\"raw\",\"start\":" + (NOW - 40 * DAY) + ",\"end\":" + NOW
            + ",\"pens\":[{\"key\":\"k\",\"tagPath\":\"t\"}]";
        assertEquals(ErrorCode.RANGE_TOO_LARGE, code(rawLong + "}"));
        HistoryRequest r = parse(rawLong + ",\"onTooManyPoints\":\"aggregate\"}");
        assertFalse(r.raw());
        assertTrue(r.downgraded());
        assertEquals(ErrorCode.RANGE_TOO_LARGE, code("{\"v\":2,\"start\":" + (NOW - 401 * DAY) + ",\"end\":" + NOW
            + ",\"pens\":[{\"key\":\"k\",\"tagPath\":\"t\"}]}"));
    }

    @Test
    void requestIdIsPeekedOnlyWhenWellFormed() {
        assertEquals("h-1", HistoryRequest.peekRequestId(JsonParser.parseString("{\"requestId\":\"h-1\"}")));
        assertNull(HistoryRequest.peekRequestId(JsonParser.parseString("{\"requestId\":\"x\\ny\"}")));
        assertNull(HistoryRequest.peekRequestId(JsonParser.parseString("[1]")));
    }

    @Test
    void duplicatePenKeysAreRejected() {
        assertEquals(ErrorCode.BAD_REQUEST, code("{\"v\":2,\"start\":" + (NOW - 300_000) + ",\"end\":" + NOW
            + ",\"pens\":[{\"key\":\"a\",\"tagPath\":\"[default]CTG/Secret\"},"
            + "{\"key\":\"a\",\"tagPath\":\"[default]CTG/Temp\"}]}"));
    }

    // ---- bucketMs rule, alignment, incremental windows ----------------------------------------------------------

    private static final long MIN = 60_000L;
    private static final long HOUR = 60 * MIN;

    private static String agg(long start, long end, String extra, String penExtra) {
        return "{\"v\":2,\"start\":" + start + ",\"end\":" + end + extra + ",\"pens\":[{\"key\":\"p\",\"tagPath\":\"t\"" + penExtra + "}]}";
    }

    @Test
    void computedBucketIsALadderStepOnAnEpochGrid() throws Exception {
        HistoryRequest r = parse(agg(NOW - 8 * HOUR, NOW, "", ""));
        assertEquals(2 * MIN, r.bucketMs(), "8 h / 300 points = 96 s -> 2 min");
        assertEquals(0, r.alignedStart() % r.bucketMs());
        assertEquals(0, r.alignedEnd() % r.bucketMs());
        assertTrue(r.alignedStart() <= r.start());
        assertTrue(r.alignedEnd() <= NOW, "the bucket still filling is never returned");
        assertFalse(r.bucketRecomputed());
        // A second request 3 s later shares the grid.
        HistoryRequest r2 = HistoryRequest.parse(JsonParser.parseString(agg(NOW + 3_000 - 8 * HOUR, NOW + 3_000, "", "")), S,
            NOW + 3_000);
        assertEquals(r.bucketMs(), r2.bucketMs());
        assertEquals(0, (r2.alignedStart() - r.alignedStart()) % r.bucketMs());
    }

    @Test
    void acceptableClientBucketIsKept() throws Exception {
        HistoryRequest r = parse(agg(NOW - 8 * HOUR, NOW, ",\"bucketMs\":60000", ""));
        assertEquals(MIN, r.bucketMs());
        assertFalse(r.bucketRecomputed());
        assertEquals(BucketLadder.alignDown(NOW - 8 * HOUR, MIN), r.alignedStart());
        assertEquals(BucketLadder.alignDown(NOW, MIN), r.alignedEnd());
    }

    @Test
    void unacceptableClientBucketIsRecomputedForFullAndRefusedForIncremental() throws Exception {
        // bucketMs 100 over 400 days -> 345 M buckets.
        String full = agg(NOW - 400 * DAY, NOW, ",\"bucketMs\":100", "");
        HistoryRequest r = parse(full);
        assertTrue(r.bucketRecomputed());
        assertTrue(BucketLadder.isStep(r.bucketMs()));
        assertTrue((r.alignedEnd() - r.alignedStart()) / r.bucketMs() <= S.historyPointCountMax());
        assertEquals(ErrorCode.RANGE_INVALID, code(agg(NOW - 400 * DAY, NOW, ",\"bucketMs\":100", ",\"since\":" + (NOW - MIN))));
        // Not on the ladder / below minBucketMs.
        assertTrue(parse(agg(NOW - HOUR, NOW, ",\"bucketMs\":7000", "")).bucketRecomputed());
        assertTrue(parse(agg(NOW - HOUR, NOW, ",\"bucketMs\":5", "")).bucketRecomputed());
        assertEquals(ErrorCode.RANGE_INVALID, code(agg(NOW - HOUR, NOW, ",\"bucketMs\":7000", ",\"since\":" + (NOW - MIN))));
        // A raw request ignores bucketMs entirely.
        assertNull(parse(agg(NOW - HOUR, NOW, ",\"mode\":\"raw\",\"bucketMs\":7", ",\"since\":" + (NOW - MIN))).bucketMs());
    }

    @Test
    void bucketIsWidenedWhenTheAlignedWindowHoldsTooManyBuckets() {
        // 5000 points over a span that is an exact ladder multiple except for alignment: never more than pointCountMax.
        for (long span : new long[] {5_000 * 1_000L, 5_000 * 2_000L + 1, 4 * HOUR + 17, 31 * DAY}) {
            long b = HistoryRequest.computeBucket(NOW - span, NOW, NOW, 5_000, 100, 5_000);
            long buckets = (BucketLadder.alignDown(NOW, b) - BucketLadder.alignDown(NOW - span, b)) / b;
            assertTrue(buckets <= 5_000, "span " + span + " -> " + buckets + " buckets of " + b);
            assertTrue(BucketLadder.isStep(b));
        }
    }

    @Test
    void penWindows() throws Exception {
        long start = NOW - HOUR;
        // raw full: [start, now] (the end sample included)
        HistoryRequest raw = parse(agg(start, NOW, ",\"mode\":\"raw\"", ""));
        HistoryRequest.PenWindow w = raw.window(raw.pens().get(0));
        assertEquals(start, w.from());
        assertEquals(NOW + 1, w.to());
        assertFalse(w.incremental());
        assertNull(w.replaceFrom());
        // raw incremental: only t > since
        HistoryRequest rawInc = parse(agg(start, NOW, ",\"mode\":\"raw\"", ",\"since\":" + (NOW - 10_000)));
        w = rawInc.window(rawInc.pens().get(0));
        assertEquals(NOW - 10_000 + 1, w.from());
        assertTrue(w.incremental());
        assertNull(w.replaceFrom());
        // aggregated incremental: re-send from one bucket before the bucket of `since`
        HistoryRequest a = parse(agg(start, NOW, ",\"bucketMs\":10000", ""));
        long since = a.alignedEnd() - 10_000;           // the client's last bucket start
        HistoryRequest inc = parse(agg(start, NOW, ",\"bucketMs\":10000", ",\"since\":" + since));
        w = inc.window(inc.pens().get(0));
        assertEquals(since - 10_000, w.from());
        assertEquals(since - 10_000, w.replaceFrom().longValue());
        assertEquals(inc.alignedEnd(), w.to());
        // since older than start -> full request for that pen
        HistoryRequest old = parse(agg(start, NOW, ",\"bucketMs\":10000", ",\"since\":" + (start - DAY)));
        w = old.window(old.pens().get(0));
        assertFalse(w.incremental());
        assertEquals(old.alignedStart(), w.from());
        // nothing new yet
        HistoryRequest none = parse(agg(start, NOW, ",\"bucketMs\":10000", ",\"since\":" + (NOW + 30_000)));
        w = none.window(none.pens().get(0));
        assertTrue(w.isEmpty());
        assertNull(w.replaceFrom());
    }

    /** since = Long.MAX_VALUE used to wrap the raw window to Long.MIN_VALUE (historian ERROR lines). */
    @Test
    void hugeSinceIsAnEmptyWindowWithoutOverflow() throws Exception {
        long start = NOW - HOUR;
        for (String mode : new String[] {",\"mode\":\"raw\"", ",\"bucketMs\":10000"}) {
            HistoryRequest r = parse(agg(start, NOW, mode, ",\"since\":" + Long.MAX_VALUE));
            HistoryRequest.PenWindow w = r.window(r.pens().get(0));
            assertTrue(w.isEmpty(), mode);
            assertTrue(w.from() > 0 && w.to() > 0, mode + ": no wrap-around");
            assertTrue(w.incremental(), mode);
        }
    }

    @Test
    void fallbackGridStaysWithinPointCountMax() throws Exception {
        HistoryRequest raw = parse(agg(NOW - 27 * HOUR, NOW, ",\"mode\":\"raw\",\"onTooManyPoints\":\"aggregate\"", ""));
        long[] g = HistoryRequest.fallbackGrid(raw.window(raw.pens().get(0)), S);
        assertTrue(BucketLadder.isStep(g[0]));
        assertEquals(0, g[1] % g[0]);
        assertTrue((g[2] - g[1]) / g[0] <= S.historyPointCountMax());
        assertTrue(g[1] <= NOW - 27 * HOUR);
    }

    @Test
    void retryAfterIsTheRemainingWaitRoundedUp() {
        assertEquals(1, HistoryService.retryAfterSeconds(0));
        assertEquals(1, HistoryService.retryAfterSeconds(1));
        assertEquals(1, HistoryService.retryAfterSeconds(1000));
        assertEquals(2, HistoryService.retryAfterSeconds(1001));
        assertEquals(5, HistoryService.retryAfterSeconds(4999));
    }
}
