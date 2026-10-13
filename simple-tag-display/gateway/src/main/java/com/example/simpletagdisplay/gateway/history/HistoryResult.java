package com.example.simpletagdisplay.gateway.history;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The outcome of one history request, before serialization. Holds the per-pen columns as primitive array
 * <em>segments</em>, never as a JSON tree: {@link HistoryJsonWriter} streams them straight to the response, so memory
 * stays bounded by the columns themselves. A pen's data may come from several places — cached chunks and one or more
 * historian queries — so it is a list of sorted, non-overlapping segments in time order; nothing is copied to
 * concatenate them. Immutable after construction.
 */
public final class HistoryResult {

    /** Pen status values of the response ({@code status} field). */
    public static final String OK = "ok";
    public static final String NOT_FOUND = "notFound";
    public static final String ACCESS_DENIED = "accessDenied";
    public static final String UNSUPPORTED_TYPE = "unsupportedType";
    public static final String NO_HISTORY = "noHistory";
    public static final String INVALID_PATH = "invalidPath";
    public static final String OUT_OF_SCOPE = "outOfScope";
    public static final String TOO_MANY_POINTS = "tooManyPoints";
    public static final String TIMEOUT = "timeout";
    public static final String ERROR = "error";

    /** {@code window.bucketTime}: aggregated rows are stamped with their bucket start. */
    public static final String BUCKET_TIME_START = "start";

    /** A slice {@code [from, to)} of sorted columns; {@code v} NaN = bad-quality gap. Arrays are never modified. */
    public static final class Segment {
        final long[] t;
        final double[] v;
        final int from;
        final int to;

        public Segment(long[] t, double[] v, int from, int to) {
            this.t = t;
            this.v = v;
            this.from = from;
            this.to = to;
        }

        public int size() {
            return to - from;
        }
    }

    /** One pen of the response. Build with {@link #data} / {@link #empty} and the {@code with*} methods. */
    public static final class Pen {
        final String key;
        final String tagPath;
        final String status;
        String dataType;
        String aggregation;
        String shape = "points";
        final List<Segment> segments;
        final int count;
        int filtered;
        Integer limit;
        String message;
        AnchorCache.Anchor anchor;
        Long replaceFrom;
        boolean downgraded;
        Long bucketMs;
        String cache;
        /** Null = annotations not asked for (nothing written); else ok | unsupported | error. */
        String annotationsStatus;
        List<com.example.simpletagdisplay.gateway.annotations.AnnotationService.Item> annotations = List.of();
        boolean annotationsTruncated;

        private Pen(String key, String tagPath, String status, List<Segment> segments) {
            this.key = key;
            this.tagPath = tagPath;
            this.status = status;
            this.segments = segments;
            int n = 0;
            for (Segment s : segments) {
                n += s.size();
            }
            this.count = n;
        }

        /** A pen with data (status ok). */
        public static Pen data(String key, String tagPath, List<Segment> segments) {
            return new Pen(key, tagPath, OK, Collections.unmodifiableList(new ArrayList<>(segments)));
        }

        /** A pen without data ({@code status} other than ok). */
        public static Pen empty(String key, String tagPath, String status) {
            return new Pen(key, tagPath, status, Collections.emptyList());
        }

        public Pen withType(String dataType, String aggregation, boolean minMax) {
            this.dataType = dataType;
            this.aggregation = aggregation;
            this.shape = minMax ? "minmax" : "points";
            return this;
        }

        public Pen withDataType(String dataType) {
            this.dataType = dataType;
            return this;
        }

        public Pen withLimit(int limit, String message) {
            this.limit = limit;
            this.message = message;
            return this;
        }

        public Pen withMessage(String message) {
            this.message = message;
            return this;
        }

        public Pen withFiltered(int filtered) {
            this.filtered = filtered;
            return this;
        }

        public Pen withAnchor(AnchorCache.Anchor anchor) {
            this.anchor = anchor == AnchorCache.NONE ? null : anchor;
            return this;
        }

        public Pen withReplaceFrom(Long replaceFrom) {
            this.replaceFrom = replaceFrom;
            return this;
        }

        /** The pen's data was aggregated because its raw data exceeded the cap ({@code onTooManyPoints:"aggregate"}). */
        public Pen withDowngrade(long bucketMs) {
            this.downgraded = true;
            this.bucketMs = bucketMs;
            return this;
        }

        /**
         * Annotations of this pen: {@code status} ok | unsupported | error; {@code items} only with ok.
         */
        public Pen withAnnotations(String status, List<com.example.simpletagdisplay.gateway.annotations.AnnotationService.Item> items,
                                   boolean truncated) {
            this.annotationsStatus = status;
            this.annotations = items == null ? List.of() : items;
            this.annotationsTruncated = truncated;
            return this;
        }

        public String annotationsStatus() {
            return annotationsStatus;
        }

        public List<com.example.simpletagdisplay.gateway.annotations.AnnotationService.Item> annotations() {
            return annotations;
        }

        /** Debug only: {@code hit | miss | partial | none}. */
        public Pen withCache(String cache) {
            this.cache = cache;
            return this;
        }

        public String key() {
            return key;
        }

        public String status() {
            return status;
        }

        public int count() {
            return count;
        }

        public List<Segment> segments() {
            return segments;
        }

        public AnchorCache.Anchor anchor() {
            return anchor;
        }

        public Long replaceFrom() {
            return replaceFrom;
        }

        public boolean downgraded() {
            return downgraded;
        }
    }

    /** Debug-only statistics ({@code ctg.debug}); null otherwise (cache hits would reveal what others looked at). */
    public static final class DebugStats {
        final long cacheHits;
        final long cacheMisses;
        final int queries;
        final long rows;

        public DebugStats(long cacheHits, long cacheMisses, int queries, long rows) {
            this.cacheHits = cacheHits;
            this.cacheMisses = cacheMisses;
            this.queries = queries;
            this.rows = rows;
        }
    }

    final String requestId;
    final long serverNow;
    final long start;
    final long end;
    final String mode;
    final String aggregation;
    final Long bucketMs;
    final boolean aligned;
    final boolean downgraded;
    final List<Pen> pens;
    final long elapsedMs;
    final long points;
    final DebugStats debug;

    public HistoryResult(String requestId, long serverNow, long start, long end, String mode, String aggregation,
                         Long bucketMs, boolean aligned, boolean downgraded, List<Pen> pens, long elapsedMs,
                         DebugStats debug) {
        this.requestId = requestId;
        this.serverNow = serverNow;
        this.start = start;
        this.end = end;
        this.mode = mode;
        this.aggregation = aggregation;
        this.bucketMs = bucketMs;
        this.aligned = aligned;
        this.downgraded = downgraded;
        this.pens = Collections.unmodifiableList(pens);
        this.elapsedMs = elapsedMs;
        this.debug = debug;
        long n = 0;
        for (Pen p : pens) {
            n += p.count;
        }
        this.points = n;
    }

    public List<Pen> pens() {
        return pens;
    }

    /** Total points over all pens. */
    public long points() {
        return points;
    }

    public long start() {
        return start;
    }

    public long end() {
        return end;
    }

    public Long bucketMs() {
        return bucketMs;
    }
}
