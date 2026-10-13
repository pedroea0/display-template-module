package com.example.simpletagdisplay.gateway.history;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.common.protocol.Protocol;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonPrimitive;
import com.inductiveautomation.ignition.common.sqltags.history.AggregationMode;

/**
 * A parsed, validated and clamped history request with its query windows. Immutable; every rule is a pure function
 * of the body, the settings and {@code serverNow}, so the whole class is unit-testable.
 *
 * <h2>Field rules</h2>
 * <ul>
 *   <li>{@code v} must be 2 ({@code PROTOCOL_MISMATCH}); {@code requestId} optional, {@code [A-Za-z0-9_.:-]{1,64}}.</li>
 *   <li>{@code start}/{@code end}: whole epoch ms, {@code 0 <= start < end} ({@code RANGE_INVALID}); {@code end} clamped
 *       to {@code serverNow + 60 s}; a span under 1 s is {@code RANGE_INVALID}.</li>
 *   <li>{@code mode} {@code aggregated|raw}; {@code aggregation} an {@code AggregationMode} name (case-insensitive,
 *       ad-hoc Python aggregates rejected), per pen too ({@code "default"} = request level).</li>
 *   <li>{@code pointCount} clamped to {@code [pointCountMin, pointCountMax]}; aggregated spans above
 *       {@code maxRangeDays} and raw spans above {@code maxRawRangeDays} are {@code RANGE_TOO_LARGE} — a raw request
 *       with {@code onTooManyPoints:"aggregate"} is served aggregated instead ({@link #downgraded()}).</li>
 *   <li>{@code pens}: 1..{@code ctg.history.maxPens} ({@code TOO_MANY_PENS}); {@code key} (≤ 200 chars, echoed,
 *       unique) and {@code tagPath} (≤ 1024) required; {@code since} epoch ms or null.</li>
 *   <li>{@code maxPointsPerPen} can only lower the raw per-pen cap.</li>
 *   <li>{@code annotations}: absent = none, else {@code {types:[…]}} with types from {note, range}
 *       ({@code BAD_REQUEST} otherwise; an empty list = none). {@code annotationsOnly:true} (optional, additive)
 *       asks for the annotations alone: the pens are checked as usual (path rules, scope,
 *       permission, history) but no data query runs — the chart re-reads annotations every minute and after each
 *       save without re-loading its series. It needs {@code annotations} ({@code BAD_REQUEST}).</li>
 * </ul>
 *
 * <h2>Aggregated grid</h2>
 * The bucket width is a {@link BucketLadder} step and the grid is anchored at epoch 0:
 * {@code alignedStart = floor(start / b) * b}, {@code alignedEnd = floor(min(end, serverNow) / b) * b} — the bucket that
 * is still filling is never returned (the chart draws the live edge from {@code chart.values}). A window ending in the
 * past gets its last bucket whole once that bucket is complete ({@link #alignedEnd}). A client
 * {@code bucketMs} is accepted only when it is a ladder step ≥ {@code minBucketMs} and the aligned window holds at
 * most {@code pointCountMax} buckets. Otherwise a full request gets a width recomputed from {@code pointCount}
 * ({@link #bucketRecomputed()}), and an incremental request (any pen with {@code since}) is refused with
 * {@code RANGE_INVALID} — an incremental tick on another grid than its coverage would corrupt the client's data.
 *
 * <h2>Per-pen windows ({@link #window(Pen)})</h2>
 * <ul>
 *   <li>raw, full: {@code [start, min(end, now)]}; raw, incremental: only {@code t > since};</li>
 *   <li>aggregated, full: {@code [alignedStart, alignedEnd)}; aggregated, incremental: from one bucket before the
 *       bucket of {@code since}, or {@link #INCREMENTAL_REPLAY_MS} before {@code since} when that is earlier
 *       ({@code replaceFrom}), so the bucket that was still filling on the previous tick and every bucket the historian
 *       may still have been storing are re-sent; the client drops its points {@code t >= replaceFrom} and appends;</li>
 *   <li>a {@code since} older than {@code start} makes that pen a full request.</li>
 * </ul>
 * Every window is half-open {@code [from, to)} in epoch ms.
 */
public final class HistoryRequest {

    public static final String MODE_AGGREGATED = "aggregated";
    public static final String MODE_RAW = "raw";

    private static final Pattern REQUEST_ID = Pattern.compile(Protocol.ID_PATTERN);
    private static final long MIN_SPAN_MS = 1_000L;
    private static final long FUTURE_SLACK_MS = 60_000L;
    private static final long DAY_MS = 86_400_000L;
    private static final int MAX_KEY_CHARS = 200;
    /**
     * An aggregated incremental tick re-sends at least this much before {@code since}: longer than the historian's
     * storage latency, so a bucket answered before its samples were stored is answered again.
     */
    static final long INCREMENTAL_REPLAY_MS = 5_000L;
    private static final int MAX_PATH_CHARS = 1024;
    /** Annotation types a request may ask for (= {@code AnnotationService.TYPES}). */
    static final List<String> ANNOTATION_TYPES = List.of("note", "range");

    /** A request that must be refused with {@code code}. */
    public static final class Invalid extends Exception {
        private static final long serialVersionUID = 1L;
        private final ErrorCode code;

        Invalid(ErrorCode code, String detail) {
            super(detail, null, false, false);
            this.code = code;
        }

        public ErrorCode code() {
            return code;
        }
    }

    /** One requested pen. */
    public static final class Pen {
        private final String key;
        private final String tagPath;
        private final AggregationMode aggregation;
        private final Long since;

        Pen(String key, String tagPath, AggregationMode aggregation, Long since) {
            this.key = key;
            this.tagPath = tagPath;
            this.aggregation = aggregation;
            this.since = since;
        }

        /** Client key, echoed in the response. */
        public String key() {
            return key;
        }

        /** Raw tag path as sent (parsed and permission-checked by the service). */
        public String tagPath() {
            return tagPath;
        }

        /** Effective aggregation of this pen (request level when the pen says "default"). */
        public AggregationMode aggregation() {
            return aggregation;
        }

        /** Incremental marker (epoch ms) or null. */
        public Long since() {
            return since;
        }
    }

    /** The data window of one pen (half-open, epoch ms). */
    public static final class PenWindow {
        private final long from;
        private final long to;
        private final boolean incremental;
        private final Long replaceFrom;

        PenWindow(long from, long to, boolean incremental, Long replaceFrom) {
            this.from = from;
            this.to = Math.max(from, to);
            this.incremental = incremental;
            this.replaceFrom = replaceFrom;
        }

        /** First instant included. */
        public long from() {
            return from;
        }

        /** First instant excluded ({@code from == to}: nothing to query). */
        public long to() {
            return to;
        }

        public boolean isEmpty() {
            return to <= from;
        }

        /** True when the pen sent a usable {@code since} (no anchor, incremental semantics). */
        public boolean incremental() {
            return incremental;
        }

        /** Aggregated incremental only: the client replaces its points {@code t >= replaceFrom}; else null. */
        public Long replaceFrom() {
            return replaceFrom;
        }
    }

    private final String requestId;
    private final long serverNow;
    private final long start;
    private final long end;
    private final long dataEnd;
    private final String mode;
    private final AggregationMode aggregation;
    private final int pointCount;
    private final Long bucketMs;
    private final boolean bucketRecomputed;
    private final long alignedStart;
    private final long alignedEnd;
    private final boolean aggregateOnTooManyPoints;
    private final boolean includeAnchor;
    private final int rawCapPerPen;
    private final boolean downgraded;
    private final List<Pen> pens;
    private final List<String> annotationTypes;
    private final boolean annotationsOnly;

    private HistoryRequest(Builder b) {
        this.requestId = b.requestId;
        this.serverNow = b.serverNow;
        this.start = b.start;
        this.end = b.end;
        this.dataEnd = b.dataEnd;
        this.mode = b.mode;
        this.aggregation = b.aggregation;
        this.pointCount = b.pointCount;
        this.bucketMs = b.bucketMs;
        this.bucketRecomputed = b.bucketRecomputed;
        this.alignedStart = b.alignedStart;
        this.alignedEnd = b.alignedEnd;
        this.aggregateOnTooManyPoints = b.aggregateOnTooManyPoints;
        this.includeAnchor = b.includeAnchor;
        this.rawCapPerPen = b.rawCapPerPen;
        this.downgraded = b.downgraded;
        this.pens = b.pens;
        this.annotationTypes = b.annotationTypes;
        this.annotationsOnly = b.annotationsOnly;
    }

    /** Mutable scratch state of {@link #parse}. */
    private static final class Builder {
        String requestId;
        long serverNow;
        long start;
        long end;
        long dataEnd;
        String mode;
        AggregationMode aggregation;
        int pointCount;
        Long bucketMs;
        boolean bucketRecomputed;
        long alignedStart;
        long alignedEnd;
        boolean aggregateOnTooManyPoints;
        boolean includeAnchor;
        int rawCapPerPen;
        boolean downgraded;
        List<Pen> pens;
        List<String> annotationTypes = List.of();
        boolean annotationsOnly;
    }

    /**
     * The requestId of a body that may otherwise be invalid (for echoing in error responses); null when absent or
     * not well-formed.
     */
    public static String peekRequestId(JsonElement root) {
        if (root == null || !root.isJsonObject()) {
            return null;
        }
        JsonElement e = root.getAsJsonObject().get("requestId");
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) {
            return null;
        }
        String s = e.getAsString();
        return REQUEST_ID.matcher(s).matches() ? s : null;
    }

    /** Validates and clamps a parsed body and computes its windows. */
    public static HistoryRequest parse(JsonElement root, ModuleSettings.Settings s, long serverNow) throws Invalid {
        if (root == null || !root.isJsonObject()) {
            throw new Invalid(ErrorCode.BAD_REQUEST, "body is not an object");
        }
        JsonObject o = root.getAsJsonObject();
        if (wholeNumber(o.get("v"), "v") != Protocol.VERSION) {
            throw new Invalid(ErrorCode.PROTOCOL_MISMATCH, "v");
        }
        Builder b = new Builder();
        b.serverNow = serverNow;
        if (o.has("requestId") && !o.get("requestId").isJsonNull()) {
            b.requestId = string(o.get("requestId"), "requestId");
            if (!REQUEST_ID.matcher(b.requestId).matches()) {
                throw new Invalid(ErrorCode.BAD_REQUEST, "requestId");
            }
        }

        // ---- window ------------------------------------------------------------------------------------------
        b.start = wholeNumber(o.get("start"), "start");
        long end = wholeNumber(o.get("end"), "end");
        if (b.start < 0 || b.start >= end) {
            throw new Invalid(ErrorCode.RANGE_INVALID, "start/end");
        }
        b.end = Math.min(end, serverNow + FUTURE_SLACK_MS);
        if (b.end - b.start < MIN_SPAN_MS) {
            throw new Invalid(ErrorCode.RANGE_INVALID, "span");
        }
        b.dataEnd = Math.max(b.start, Math.min(b.end, serverNow));

        // ---- mode, aggregation, sizes -------------------------------------------------------------------------
        b.mode = optString(o, "mode", MODE_AGGREGATED).toLowerCase(Locale.ROOT);
        if (!b.mode.equals(MODE_AGGREGATED) && !b.mode.equals(MODE_RAW)) {
            throw new Invalid(ErrorCode.BAD_REQUEST, "mode");
        }
        b.aggregation = aggregation(optString(o, "aggregation", "LastValue"));

        b.pointCount = s.historyPointCountDefault();
        if (o.has("pointCount") && !o.get("pointCount").isJsonNull()) {
            long pc = wholeNumber(o.get("pointCount"), "pointCount");
            b.pointCount = (int) Math.max(s.historyPointCountMin(), Math.min(s.historyPointCountMax(), pc));
        }

        Long clientBucket = null;
        if (o.has("bucketMs") && !o.get("bucketMs").isJsonNull()) {
            long cb = wholeNumber(o.get("bucketMs"), "bucketMs");
            if (cb <= 0) {
                throw new Invalid(ErrorCode.BAD_REQUEST, "bucketMs");
            }
            clientBucket = cb;
        }

        String onTooMany = optString(o, "onTooManyPoints", "error");
        if (!onTooMany.equals("error") && !onTooMany.equals("aggregate")) {
            throw new Invalid(ErrorCode.BAD_REQUEST, "onTooManyPoints");
        }
        b.aggregateOnTooManyPoints = onTooMany.equals("aggregate");
        b.includeAnchor = optBool(o, "includeAnchor", true);

        b.rawCapPerPen = s.historyMaxRawPointsPerPen();
        if (o.has("maxPointsPerPen") && !o.get("maxPointsPerPen").isJsonNull()) {
            long m = wholeNumber(o.get("maxPointsPerPen"), "maxPointsPerPen");
            if (m < 1) {
                throw new Invalid(ErrorCode.BAD_REQUEST, "maxPointsPerPen");
            }
            b.rawCapPerPen = (int) Math.min(b.rawCapPerPen, m);
        }

        long span = b.end - b.start;
        if (b.mode.equals(MODE_RAW) && span > s.historyMaxRawRangeDays() * DAY_MS) {
            if (!b.aggregateOnTooManyPoints) {
                throw new Invalid(ErrorCode.RANGE_TOO_LARGE, "raw span");
            }
            b.mode = MODE_AGGREGATED;
            b.downgraded = true;
            clientBucket = null;          // a raw request's bucketMs means nothing for the aggregated fallback
        }
        if (b.mode.equals(MODE_AGGREGATED) && span > s.historyMaxRangeDays() * DAY_MS) {
            throw new Invalid(ErrorCode.RANGE_TOO_LARGE, "aggregated span");
        }

        // ---- annotations ------------------------------------------------------------------------------------
        b.annotationTypes = annotationTypes(o.get("annotations"));
        b.annotationsOnly = optBool(o, "annotationsOnly", false);
        if (b.annotationsOnly && b.annotationTypes.isEmpty()) {
            throw new Invalid(ErrorCode.BAD_REQUEST, "annotationsOnly without annotations");
        }

        // ---- pens -------------------------------------------------------------------------------------------
        b.pens = pens(o, s, b.aggregation);
        boolean incremental = false;
        for (Pen p : b.pens) {
            incremental |= p.since != null;
        }

        // ---- aggregated grid (bucketMs rule) ------------------------------------------------------------------
        if (b.mode.equals(MODE_AGGREGATED)) {
            long minBucket = s.historyMinBucketMs();
            int maxBuckets = s.historyPointCountMax();
            long bucket;
            if (clientBucket != null && bucketAcceptable(clientBucket, b.start, b.dataEnd, minBucket, maxBuckets)) {
                bucket = clientBucket;
            } else if (clientBucket != null && incremental) {
                throw new Invalid(ErrorCode.RANGE_INVALID, "bucketMs");
            } else {
                bucket = computeBucket(b.start, b.end, b.dataEnd, b.pointCount, minBucket, maxBuckets);
                b.bucketRecomputed = clientBucket != null;
            }
            b.bucketMs = bucket;
            b.alignedStart = BucketLadder.alignDown(b.start, bucket);
            b.alignedEnd = alignedEnd(b.alignedStart, b.dataEnd, bucket, serverNow, maxBuckets);
        }
        return new HistoryRequest(b);
    }

    /**
     * End of the aggregated grid. At the live edge the bucket that is still filling is never returned
     * ({@code alignDown(dataEnd)}). A window that ends in the past (historical, or a paused realtime chart) would lose
     * its last partial bucket the same way, so the end of the range would be neither plotted nor counted (a
     * 06:00-14:30 window on 1 h buckets would stop at 14:00). When the bucket holding {@code dataEnd} is complete
     * ({@code alignUp(dataEnd) <= serverNow}) and one more bucket stays within {@code maxBuckets}, the grid ends at
     * {@code alignUp(dataEnd)} so that bucket is returned whole. Package-private for JUnit.
     */
    static long alignedEnd(long alignedStart, long dataEnd, long bucket, long serverNow, int maxBuckets) {
        long down = Math.max(alignedStart, BucketLadder.alignDown(dataEnd, bucket));
        if (down == dataEnd || dataEnd <= alignedStart) {
            return down;                                    // already on the grid (or an empty window)
        }
        long up = down + bucket;
        if (up <= serverNow && (up - alignedStart) / bucket <= maxBuckets) {
            return up;
        }
        return down;
    }

    /**
     * Whether a client {@code bucketMs} is usable: a ladder step of at least {@code minBucket} whose aligned data
     * window holds at most {@code maxBuckets} buckets.
     */
    static boolean bucketAcceptable(long bucket, long start, long dataEnd, long minBucket, int maxBuckets) {
        if (bucket < minBucket || !BucketLadder.isStep(bucket)) {
            return false;
        }
        long aS = BucketLadder.alignDown(start, bucket);
        long aE = BucketLadder.alignDown(dataEnd, bucket);
        return BucketLadder.ceilDiv(Math.max(0, aE - aS), bucket) <= maxBuckets;
    }

    /**
     * Width for {@code pointCount} buckets over the requested span, rounded up to the ladder; widened further
     * (next step) while the aligned data window would still hold more than {@code maxBuckets} buckets.
     */
    static long computeBucket(long start, long end, long dataEnd, int pointCount, long minBucket, int maxBuckets) {
        long bucket = BucketLadder.niceAtLeast(BucketLadder.ceilDiv(end - start, Math.max(1, pointCount)), minBucket);
        while (BucketLadder.ceilDiv(Math.max(0, BucketLadder.alignDown(dataEnd, bucket) - BucketLadder.alignDown(start, bucket)),
            bucket) > maxBuckets) {
            bucket = BucketLadder.next(bucket);
        }
        return bucket;
    }

    /** {@code annotations: {types:[…]}} → the distinct allowed types in request order; absent / null = none. */
    static List<String> annotationTypes(JsonElement e) throws Invalid {
        if (e == null || e.isJsonNull()) {
            return List.of();
        }
        if (!e.isJsonObject()) {
            throw new Invalid(ErrorCode.BAD_REQUEST, "annotations");
        }
        JsonElement types = e.getAsJsonObject().get("types");
        if (types == null || !types.isJsonArray() || types.getAsJsonArray().size() > 8) {
            throw new Invalid(ErrorCode.BAD_REQUEST, "annotations.types");
        }
        List<String> out = new ArrayList<>(2);
        for (JsonElement t : types.getAsJsonArray()) {
            String name = string(t, "annotations.types");
            if (!ANNOTATION_TYPES.contains(name)) {
                throw new Invalid(ErrorCode.BAD_REQUEST, "annotations.types");
            }
            if (!out.contains(name)) {
                out.add(name);
            }
        }
        return Collections.unmodifiableList(out);
    }

    private static List<Pen> pens(JsonObject o, ModuleSettings.Settings s, AggregationMode requestAgg) throws Invalid {
        JsonElement pensEl = o.get("pens");
        if (pensEl == null || !pensEl.isJsonArray() || pensEl.getAsJsonArray().size() == 0) {
            throw new Invalid(ErrorCode.BAD_REQUEST, "pens");
        }
        JsonArray arr = pensEl.getAsJsonArray();
        if (arr.size() > s.historyMaxPens()) {
            throw new Invalid(ErrorCode.TOO_MANY_PENS, "pens");
        }
        List<Pen> pens = new ArrayList<>(arr.size());
        Set<String> keys = new HashSet<>();
        for (JsonElement pe : arr) {
            if (pe == null || !pe.isJsonObject()) {
                throw new Invalid(ErrorCode.BAD_REQUEST, "pen");
            }
            JsonObject p = pe.getAsJsonObject();
            String key = string(p.get("key"), "pen.key");
            String tagPath = string(p.get("tagPath"), "pen.tagPath");
            if (key.isEmpty() || key.length() > MAX_KEY_CHARS || tagPath.length() > MAX_PATH_CHARS) {
                throw new Invalid(ErrorCode.BAD_REQUEST, "pen.key/tagPath");
            }
            if (!keys.add(key)) {
                // Results are keyed by pen key: a duplicate would mix up the answers of two pens.
                throw new Invalid(ErrorCode.BAD_REQUEST, "pen.key duplicate");
            }
            String agg = optString(p, "aggregation", "default");
            AggregationMode penAgg = agg.equalsIgnoreCase("default") ? requestAgg : aggregation(agg);
            Long since = null;
            if (p.has("since") && !p.get("since").isJsonNull()) {
                long sv = wholeNumber(p.get("since"), "pen.since");
                if (sv < 0) {
                    throw new Invalid(ErrorCode.BAD_REQUEST, "pen.since");
                }
                since = sv;
            }
            pens.add(new Pen(key, tagPath, penAgg, since));
        }
        return Collections.unmodifiableList(pens);
    }

    // =========================================================================================================
    // Windows
    // =========================================================================================================

    /** The data window of {@code pen} (see the class comment). */
    public PenWindow window(Pen pen) {
        // A since beyond the window means "nothing new yet" (empty window). It is clamped to end + 1 day first, so
        // since + 1 and the bucket alignment can never overflow (unclamped, since = Long.MAX_VALUE would wrap the raw
        // window to Long.MIN_VALUE and send an invalid date to the historian, which logs ERRORs).
        Long since = pen.since() == null ? null : Math.min(pen.since(), end + BucketLadder.DAY);
        boolean incremental = since != null && since >= start;
        if (raw()) {
            long to = dataEnd + 1;                           // raw windows include a sample at exactly min(end, now)
            return incremental ? new PenWindow(since + 1, to, true, null) : new PenWindow(start, to, false, null);
        }
        long b = bucketMs;
        if (!incremental) {
            return new PenWindow(alignedStart, alignedEnd, false, null);
        }
        // Re-send at least INCREMENTAL_REPLAY_MS before since, not only two buckets: Core Historian stores
        // samples 0.5-2.4 s late (measured), so on a sub-second grid the buckets older than two were answered before
        // their samples were stored and never re-checked.
        long from = Math.max(alignedStart, Math.min(BucketLadder.alignDown(since, b) - b,
            BucketLadder.alignDown(since - INCREMENTAL_REPLAY_MS, b)));
        return from < alignedEnd ? new PenWindow(from, alignedEnd, true, from) : new PenWindow(alignedEnd, alignedEnd, true, null);
    }

    /**
     * The aggregated fallback grid for a raw pen over {@code w} that exceeded its point cap
     * ({@code onTooManyPoints:"aggregate"}): {@code pointCountMax} buckets at most. Returns {bucketMs, from, to}.
     */
    public static long[] fallbackGrid(PenWindow w, ModuleSettings.Settings s) {
        long span = Math.max(1, w.to() - w.from());
        long bucket = computeBucket(w.from(), w.from() + span, w.to(), s.historyPointCountMax(), s.historyMinBucketMs(),
            s.historyPointCountMax());
        long from = BucketLadder.alignDown(w.from(), bucket);
        long to = Math.max(from, BucketLadder.alignDown(w.to(), bucket));
        return new long[] {bucket, from, to};
    }

    // =========================================================================================================
    // JSON helpers
    // =========================================================================================================

    private static AggregationMode aggregation(String name) throws Invalid {
        if (name == null || name.isEmpty() || name.toUpperCase(Locale.ROOT).contains("PYTHON")) {
            throw new Invalid(ErrorCode.BAD_REQUEST, "aggregation");
        }
        AggregationMode m;
        try {
            m = AggregationMode.valueOfCaseInsensitive(name);
        } catch (RuntimeException e) {
            m = null;
        }
        if (m == null) {
            throw new Invalid(ErrorCode.BAD_REQUEST, "aggregation");
        }
        return m;
    }

    private static long wholeNumber(JsonElement e, String field) throws Invalid {
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isNumber()) {
            throw new Invalid(ErrorCode.BAD_REQUEST, field);
        }
        JsonPrimitive p = e.getAsJsonPrimitive();
        try {
            return p.getAsBigDecimal().longValueExact();
        } catch (ArithmeticException | NumberFormatException ex) {
            throw new Invalid(ErrorCode.BAD_REQUEST, field);
        }
    }

    private static String string(JsonElement e, String field) throws Invalid {
        if (e == null || !e.isJsonPrimitive() || !e.getAsJsonPrimitive().isString()) {
            throw new Invalid(ErrorCode.BAD_REQUEST, field);
        }
        return e.getAsString();
    }

    private static String optString(JsonObject o, String key, String fallback) throws Invalid {
        JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? fallback : string(e, key);
    }

    private static boolean optBool(JsonObject o, String key, boolean fallback) throws Invalid {
        JsonElement e = o.get(key);
        if (e == null || e.isJsonNull()) {
            return fallback;
        }
        if (!e.isJsonPrimitive() || !e.getAsJsonPrimitive().isBoolean()) {
            throw new Invalid(ErrorCode.BAD_REQUEST, key);
        }
        return e.getAsBoolean();
    }

    // =========================================================================================================
    // Accessors
    // =========================================================================================================

    public String requestId() {
        return requestId;
    }

    /** The gateway time the request was evaluated against. */
    public long serverNow() {
        return serverNow;
    }

    public long start() {
        return start;
    }

    /** End, already clamped to {@code serverNow + 60 s}. */
    public long end() {
        return end;
    }

    /** {@code min(end, serverNow)} (never before {@code start}): no data exists after it. */
    public long dataEnd() {
        return dataEnd;
    }

    public boolean raw() {
        return MODE_RAW.equals(mode);
    }

    public String mode() {
        return mode;
    }

    public AggregationMode aggregation() {
        return aggregation;
    }

    public int pointCount() {
        return pointCount;
    }

    /** Effective bucket width (aggregated; a ladder step), or null for raw requests. */
    public Long bucketMs() {
        return bucketMs;
    }

    /** True when the client's {@code bucketMs} was not acceptable and a width was recomputed (full requests only). */
    public boolean bucketRecomputed() {
        return bucketRecomputed;
    }

    /** Aggregated: first bucket start. */
    public long alignedStart() {
        return alignedStart;
    }

    /** Aggregated: end of the last complete bucket (exclusive). */
    public long alignedEnd() {
        return alignedEnd;
    }

    public boolean aggregateOnTooManyPoints() {
        return aggregateOnTooManyPoints;
    }

    public boolean includeAnchor() {
        return includeAnchor;
    }

    /** Raw per-pen point cap ({@code maxRawPointsPerPen}, possibly lowered by the request). */
    public int rawCapPerPen() {
        return rawCapPerPen;
    }

    /** True when a raw request was served aggregated because its span exceeded {@code maxRawRangeDays}. */
    public boolean downgraded() {
        return downgraded;
    }

    /** Annotation types asked for (empty = none). The route honours them only when the token allows it. */
    public List<String> annotationTypes() {
        return annotationTypes;
    }

    /** Annotations only, no data queries. */
    public boolean annotationsOnly() {
        return annotationsOnly;
    }

    public List<Pen> pens() {
        return pens;
    }
}
