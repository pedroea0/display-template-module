package com.example.simpletagdisplay.gateway.history;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.ByteArrayOutputStream;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.ModuleSettings;
import com.example.simpletagdisplay.gateway.annotations.AnnotationService;
import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.inductiveautomation.ignition.common.QualifiedPathUtils;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.sqltags.history.annotations.Annotation;
import com.inductiveautomation.ignition.common.sqltags.history.annotations.AnnotationType;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.gateway.historian.TagHistoryManager;
import org.junit.jupiter.api.Test;

/**
 * Annotation fields of the history route: the {@code annotations:{types}} / {@code annotationsOnly} request rules and
 * the per-pen {@code annotations[]} / {@code annotationsStatus} / {@code annotationsTruncated} response members.
 */
class HistoryAnnotationsTest {

    private static final ModuleSettings.Settings S = ModuleSettings.Settings.defaults();
    private static final long NOW = 1_791_398_400_000L;

    private static String body(String extra) {
        return "{\"v\":2,\"start\":" + (NOW - 300_000) + ",\"end\":" + NOW + ",\"pens\":[{\"key\":\"p:0\",\"tagPath\":"
            + "\"[default]CTG/Temp\"}]" + extra + "}";
    }

    private static HistoryRequest parse(String extra) throws HistoryRequest.Invalid {
        return HistoryRequest.parse(JsonParser.parseString(body(extra)), S, NOW);
    }

    private static ErrorCode code(String extra) {
        try {
            parse(extra);
            return null;
        } catch (HistoryRequest.Invalid e) {
            return e.code();
        }
    }

    @Test
    void annotationTypesAreOptionalDistinctAndAllowListed() throws Exception {
        assertTrue(parse("").annotationTypes().isEmpty(), "absent = none");
        assertTrue(parse(",\"annotations\":null").annotationTypes().isEmpty());
        assertEquals(List.of("range", "note"), parse(",\"annotations\":{\"types\":[\"range\",\"note\",\"range\"]}").annotationTypes());
        assertTrue(parse(",\"annotations\":{\"types\":[]}").annotationTypes().isEmpty(), "empty list = none");
        assertEquals(ErrorCode.BAD_REQUEST, code(",\"annotations\":{\"types\":[\"marker\"]}"), "MARKER/TRACE are not ours");
        assertEquals(ErrorCode.BAD_REQUEST, code(",\"annotations\":{\"types\":\"note\"}"));
        assertEquals(ErrorCode.BAD_REQUEST, code(",\"annotations\":[\"note\"]"));
        assertEquals(ErrorCode.BAD_REQUEST, code(",\"annotations\":{\"types\":[1]}"));
    }

    @Test
    void annotationsOnlyNeedsAnnotations() throws Exception {
        assertFalse(parse(",\"annotations\":{\"types\":[\"note\"]}").annotationsOnly());
        assertTrue(parse(",\"annotations\":{\"types\":[\"note\"]},\"annotationsOnly\":true").annotationsOnly());
        assertEquals(ErrorCode.BAD_REQUEST, code(",\"annotationsOnly\":true"));
        assertEquals(ErrorCode.BAD_REQUEST, code(",\"annotations\":{\"types\":[]},\"annotationsOnly\":true"));
    }

    @Test
    void responseCarriesAnnotationsOnlyWhenAskedFor() throws Exception {
        HistoryResult.Pen with = HistoryResult.Pen.empty("p:0", "[default]CTG/Temp", HistoryResult.OK).withAnnotations(
            AnnotationService.STATUS_OK, List.of(
                new AnnotationService.Item("069a1c42-0000-4000-8000-000000000001", "range", 100L, 200L,
                    "{\"v\":1,\"text\":\"<img src=x>\",\"author\":\"engineer\"}", null, false),
                new AnnotationService.Item(null, "note", 150L, null, "plain", null, false)), true);
        HistoryResult.Pen unsupported = HistoryResult.Pen.empty("p:1", "[sql]X", HistoryResult.OK)
            .withAnnotations(AnnotationService.STATUS_UNSUPPORTED, List.of(), false);
        HistoryResult.Pen without = HistoryResult.Pen.empty("p:2", "[default]CTG/Other", HistoryResult.NO_HISTORY);
        HistoryResult r = new HistoryResult("h", 10, 0, 300, "raw", null, null, false, false, List.of(with, unsupported, without),
            1, null);
        ByteArrayOutputStream os = new ByteArrayOutputStream();
        HistoryJsonWriter.write(r, os);
        JsonObject o = JsonParser.parseString(os.toString(StandardCharsets.UTF_8)).getAsJsonObject();
        JsonArray pens = o.getAsJsonArray("pens");
        JsonObject p0 = pens.get(0).getAsJsonObject();
        assertEquals("ok", p0.get("annotationsStatus").getAsString());
        assertTrue(p0.get("annotationsTruncated").getAsBoolean());
        JsonArray a = p0.getAsJsonArray("annotations");
        assertEquals(2, a.size());
        JsonObject a0 = a.get(0).getAsJsonObject();
        assertEquals("range", a0.get("type").getAsString());
        assertEquals(100, a0.get("start").getAsLong());
        assertEquals(200, a0.get("end").getAsLong());
        assertTrue(a0.get("data").getAsString().contains("<img src=x>"), "data is passed through as text; the client renders text only");
        assertTrue(a.get(1).getAsJsonObject().get("id").isJsonNull());
        assertTrue(a.get(1).getAsJsonObject().get("end").isJsonNull());
        JsonObject p1 = pens.get(1).getAsJsonObject();
        assertEquals("unsupported", p1.get("annotationsStatus").getAsString());
        assertEquals(0, p1.getAsJsonArray("annotations").size());
        assertFalse(pens.get(2).getAsJsonObject().has("annotationsStatus"), "not asked for: no members at all");
    }

    // ---- the "unsupported" / "error" / deadline paths through HistoryService -------------------------------------

    /** A historian whose queryAnnotations is {@code query} (everything else throws). */
    private static TagHistoryManager historian(Function<Object[], Object> query) {
        return (TagHistoryManager) Proxy.newProxyInstance(TagHistoryManager.class.getClassLoader(),
            new Class<?>[] {TagHistoryManager.class}, (proxy, m, args) -> {
                if ("queryAnnotations".equals(m.getName())) {
                    return query.apply(args);
                }
                if ("toString".equals(m.getName())) {
                    return "stub historian";
                }
                throw new UnsupportedOperationException(m.getName());
            });
    }

    /** Runs HistoryService's annotation task for one pen on {@code provider} and attaches the result to that pen. */
    private static HistoryResult.Pen run(AnnotationService svc, TagHistoryManager mgr, String provider, boolean runTask)
            throws Exception {
        HistoryRequest req = parse(",\"annotations\":{\"types\":[\"note\",\"range\"]},\"annotationsOnly\":true");
        TagPath temp = TagPaths.parse("[default]CTG/Temp", "default").path();
        String nk = TagPaths.normalizedKey(temp);
        Map<String, AnnotationService.QueryResult> out = new ConcurrentHashMap<>();
        if (runTask) {
            HistoryService.annotationTask(svc, mgr, provider, Map.of(nk, temp),
                AnnotationService.queryFrom(req.start(), req.end()), req, S.annotationsMaxPerPen(), out).call();
        }
        HistoryResult.Pen pen = HistoryResult.Pen.empty("p:0", "[default]CTG/Temp", HistoryResult.OK);
        Map<String, String> providerByPen = new HashMap<>();
        providerByPen.put("p:0", provider);
        HistoryService.attachAnnotations(List.of(pen), providerByPen, Map.of("p:0", nk), out, req, S);
        return pen;
    }

    @Test
    void unsupportedHistorianGivesUnsupportedPensThroughTheRoute() throws Exception {
        AnnotationService svc = new AnnotationService();
        try {
            int[] calls = {0};
            TagHistoryManager sql = historian(a -> {
                calls[0]++;
                throw new UnsupportedOperationException("queryAnnotations");
            });
            HistoryResult.Pen pen = run(svc, sql, "SQL Hist", true);
            assertEquals(AnnotationService.STATUS_UNSUPPORTED, pen.annotationsStatus());
            assertTrue(pen.annotations().isEmpty());
            assertEquals(AnnotationService.STATUS_UNSUPPORTED, run(svc, sql, "SQL Hist", true).annotationsStatus());
            assertEquals(1, calls[0], "remembered: the historian is not asked again");

            HistoryResult.Pen err = run(svc, historian(a -> {
                throw new IllegalStateException("connection refused");
            }), "Remote", true);
            assertEquals(AnnotationService.STATUS_ERROR, err.annotationsStatus(), "a transient failure is an error");

            HistoryResult.Pen late = run(svc, historian(a -> List.of()), "Core Historian", false);
            assertEquals(AnnotationService.STATUS_ERROR, late.annotationsStatus(), "no result before the deadline = error");

            TagPath temp = TagPaths.parse("[default]CTG/Temp", "default").path();
            List<Annotation> many = new ArrayList<>();
            for (int i = 0; i < 2 * S.annotationsMaxPerPen() + 5; i++) {
                many.add(Annotation.newBuilder().path(QualifiedPathUtils.fromTagPathNew(temp)).type(AnnotationType.NOTE)
                    .time(new Date(NOW - 200_000 + i)).data("n" + i).storageId(UUID.randomUUID()).build());
            }
            HistoryResult.Pen ok = run(svc, historian(a -> many), "Core Historian", true);
            assertEquals(AnnotationService.STATUS_OK, ok.annotationsStatus());
            assertEquals(S.annotationsMaxPerPen(), ok.annotations().size());
            assertTrue(ok.annotationsTruncated, "cut at the per-pen bound");
        } finally {
            svc.close();
        }
    }
}
