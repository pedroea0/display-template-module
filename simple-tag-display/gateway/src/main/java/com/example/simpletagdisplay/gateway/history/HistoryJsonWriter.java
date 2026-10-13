package com.example.simpletagdisplay.gateway.history;

import java.io.IOException;
import java.io.OutputStream;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.common.protocol.Protocol;

/**
 * Streaming JSON writer of history responses.
 *
 * Writes with {@link JsonBytes} straight into a reused 64 KB byte buffer on the response stream, one pen at a time,
 * {@code t}/{@code v} from the primitive segments — no JSON tree and no per-value encoder objects (Gson's
 * {@code JsonWriter} over an {@code OutputStreamWriter} allocates a {@code char[]} + {@code HeapCharBuffer} per
 * number), so the memory of a response is the columns plus one buffer, whatever its size. Every number passes the
 * {@code safeNumber} rule: non-finite values are written as {@code null}, never as a bare {@code NaN} token (which is
 * invalid JSON and breaks the client's parser).
 *
 * <h2>Response (200)</h2>
 * <pre>
 * {v, ok:true, requestId, serverNow,
 *  window:{start, end, mode, aggregation, bucketMs, bucketTime, aligned, downgraded},
 *  pens:[{key, tagPath, status, dataType, aggregation, shape, t[], v[], anchor:{t,v}|null, replaceFrom,
 *         count, filtered, truncated, downgraded, bucketMs?, limit?, message?, cache? (debug),
 *         annotations?:[{id, type, start, end, data}], annotationsStatus?, annotationsTruncated?}],
 *  stats:{ms, points, cacheHits? cacheMisses? queries? rows? (debug)}}
 * </pre>
 * {@code window.bucketTime} is {@code "start"} for aggregated windows (rows are stamped with their bucket start) and
 * null for raw. Per pen, {@code downgraded}/{@code bucketMs} describe a raw pen served aggregated because it exceeded
 * its cap with {@code onTooManyPoints:"aggregate"}.
 * Errors: {@code {v, ok:false, requestId, error:{code, message, retryable}}}.
 */
public final class HistoryJsonWriter {

    private HistoryJsonWriter() {
    }

    /** Writes a successful response. The stream is flushed, not closed. */
    public static void write(HistoryResult r, OutputStream os) throws IOException {
        JsonBytes j = new JsonBytes(os);
        j.beginObject();
        j.name("v").value(Protocol.VERSION);
        j.name("ok").value(true);
        nullableString(j.name("requestId"), r.requestId);
        j.name("serverNow").value(r.serverNow);

        j.name("window").beginObject();
        j.name("start").value(r.start);
        j.name("end").value(r.end);
        j.name("mode").value(r.mode);
        nullableString(j.name("aggregation"), r.aggregation);
        nullableLong(j.name("bucketMs"), r.bucketMs);
        nullableString(j.name("bucketTime"), r.bucketMs == null ? null : HistoryResult.BUCKET_TIME_START);
        j.name("aligned").value(r.aligned);
        j.name("downgraded").value(r.downgraded);
        j.endObject();

        j.name("pens").beginArray();
        for (HistoryResult.Pen p : r.pens) {
            writePen(j, p);
        }
        j.endArray();

        j.name("stats").beginObject();
        j.name("ms").value(r.elapsedMs);
        j.name("points").value(r.points);
        if (r.debug != null) {
            j.name("cacheHits").value(r.debug.cacheHits);
            j.name("cacheMisses").value(r.debug.cacheMisses);
            j.name("queries").value(r.debug.queries);
            j.name("rows").value(r.debug.rows);
        }
        j.endObject();
        j.endObject();
        j.flush();
    }

    private static void writePen(JsonBytes j, HistoryResult.Pen p) throws IOException {
        j.beginObject();
        j.name("key").value(p.key);
        j.name("tagPath").value(p.tagPath);
        j.name("status").value(p.status);
        nullableString(j.name("dataType"), p.dataType);
        nullableString(j.name("aggregation"), p.aggregation);
        j.name("shape").value(p.shape);
        j.name("t").beginArray();
        for (HistoryResult.Segment s : p.segments) {
            for (int i = s.from; i < s.to; i++) {
                j.value(s.t[i]);
            }
        }
        j.endArray();
        j.name("v").beginArray();
        for (HistoryResult.Segment s : p.segments) {
            for (int i = s.from; i < s.to; i++) {
                safeNumber(j, s.v[i]);
            }
        }
        j.endArray();
        if (p.anchor == null) {
            j.name("anchor").nullValue();
        } else {
            j.name("anchor").beginObject();
            j.name("t").value(p.anchor.t());
            safeNumber(j.name("v"), p.anchor.v());
            j.endObject();
        }
        nullableLong(j.name("replaceFrom"), p.replaceFrom);
        j.name("count").value(p.count);
        j.name("filtered").value(p.filtered);
        j.name("truncated").value(false);
        j.name("downgraded").value(p.downgraded);
        if (p.bucketMs != null) {
            j.name("bucketMs").value(p.bucketMs.longValue());
        }
        if (p.limit != null) {
            j.name("limit").value(p.limit.longValue());
        }
        if (p.message != null) {
            j.name("message").value(p.message);
        }
        if (p.cache != null) {
            j.name("cache").value(p.cache);
        }
        if (p.annotationsStatus != null) {
            writeAnnotations(j, p);
        }
        j.endObject();
    }

    /**
     * {@code annotations:[{id, type, start, end, data}], annotationsStatus, annotationsTruncated}.
     * {@code data} is the stored text as is (our JSON, or another tool's plain text): the client parses it and shows
     * it as text only.
     */
    private static void writeAnnotations(JsonBytes j, HistoryResult.Pen p) throws IOException {
        j.name("annotations").beginArray();
        for (com.example.simpletagdisplay.gateway.annotations.AnnotationService.Item a : p.annotations) {
            j.beginObject();
            nullableString(j.name("id"), a.id());
            j.name("type").value(a.type());
            j.name("start").value(a.start());
            nullableLong(j.name("end"), a.end());
            nullableString(j.name("data"), a.data());
            j.endObject();
        }
        j.endArray();
        j.name("annotationsStatus").value(p.annotationsStatus);
        j.name("annotationsTruncated").value(p.annotationsTruncated);
    }

    /** Writes an error response. The stream is flushed, not closed. */
    public static void writeError(String requestId, ErrorCode code, OutputStream os) throws IOException {
        JsonBytes j = new JsonBytes(os, 1024);
        j.beginObject();
        j.name("v").value(Protocol.VERSION);
        j.name("ok").value(false);
        nullableString(j.name("requestId"), requestId);
        j.name("error").beginObject();
        j.name("code").value(code.name());
        j.name("message").value(code.defaultMessage());
        j.name("retryable").value(code.retryable());
        j.endObject();
        j.endObject();
        j.flush();
    }

    /** {@code safeNumber}: finite doubles as numbers, everything else as {@code null} (never a NaN token). */
    private static void safeNumber(JsonBytes j, double d) throws IOException {
        if (Double.isFinite(d)) {
            j.value(d);
        } else {
            j.nullValue();
        }
    }

    private static void nullableString(JsonBytes j, String s) throws IOException {
        if (s == null) {
            j.nullValue();
        } else {
            j.value(s);
        }
    }

    private static void nullableLong(JsonBytes j, Long n) throws IOException {
        if (n == null) {
            j.nullValue();
        } else {
            j.value(n.longValue());
        }
    }
}
