package com.example.simpletagdisplay.gateway.ops;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.Date;
import java.util.UUID;

import com.example.simpletagdisplay.common.protocol.ErrorCode;
import com.example.simpletagdisplay.gateway.annotations.AnnotationService;
import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.inductiveautomation.ignition.common.QualifiedPathUtils;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.sqltags.history.annotations.Annotation;
import com.inductiveautomation.ignition.common.sqltags.history.annotations.AnnotationType;
import org.junit.jupiter.api.Test;

/**
 * The pure time rules of {@code chart.annotationSave} — {@link AnnotationOps#checkTimes}
 * reasons ({@code INVALID_TIME} details), {@link AnnotationOps#keepsStoredRange} (edits that keep a stored range skip
 * the length bound) and the parse step leaving the order check to {@code checkTimes}. The end-to-end paths are in
 * {@code delegate/AnnotationOpsTest}.
 */
class AnnotationTimesTest {

    private static final long DAY = AnnotationService.ID_SEARCH_MS;
    private static final long NOW = 10_000_000_000L;

    private static AnnotationOps.SaveBody body(long start, Long end) {
        AnnotationOps.SaveBody b = new AnnotationOps.SaveBody();
        b.start = start;
        b.end = end;
        return b;
    }

    @Test
    void reasons() {
        assertNull(AnnotationOps.checkTimes(body(NOW + DAY, null), NOW, 400, true), "exactly a day ahead is allowed");
        assertEquals(AnnotationOps.TIME_FUTURE, AnnotationOps.checkTimes(body(NOW + DAY + 1, null), NOW, 400, true));
        assertEquals(AnnotationOps.TIME_ORDER, AnnotationOps.checkTimes(body(NOW, NOW), NOW, 400, false),
            "order is checked for edits too");
        AnnotationOps.SaveBody threeDays = body(NOW, NOW + 3 * DAY);
        assertEquals(AnnotationOps.TIME_LENGTH, AnnotationOps.checkTimes(threeDays, NOW, 2, true));
        assertNull(AnnotationOps.checkTimes(threeDays, NOW, 2, false), "an edit's length waits for the stored entry");
        assertNull(AnnotationOps.checkTimes(threeDays, NOW, 3, true), "the bound is inclusive");
        assertEquals(AnnotationOps.TIME_LENGTH, AnnotationOps.checkTimes(threeDays, NOW, 0, true), "below 1 counts as 1");
        assertNull(AnnotationOps.checkTimes(body(0, 1L), NOW, 400, true), "the past is not bounded");
    }

    @Test
    void keepsStoredRangeOnlyForTheSameStartAndEnd() {
        Annotation stored = Annotation.newBuilder()
            .path(QualifiedPathUtils.fromTagPathNew(TagPaths.parse("[default]CTG/Temp", "default").path()))
            .type(AnnotationType.RANGE).start(new Date(NOW)).end(new Date(NOW + 5 * DAY)).data("x")
            .storageId(UUID.randomUUID()).build();
        assertTrue(AnnotationOps.keepsStoredRange(body(NOW, NOW + 5 * DAY), stored));
        assertFalse(AnnotationOps.keepsStoredRange(body(NOW, NOW + 5 * DAY + 1), stored), "resized");
        assertFalse(AnnotationOps.keepsStoredRange(body(NOW - 1, NOW + 5 * DAY), stored), "moved");
        assertFalse(AnnotationOps.keepsStoredRange(body(NOW, null), stored), "turned into a note");
        assertFalse(AnnotationOps.keepsStoredRange(body(NOW, NOW + 5 * DAY), null));
    }

    @Test
    void parseLeavesTheOrderToCheckTimes() {
        AnnotationOps.SaveBody b = new AnnotationOps.SaveBody();
        assertNull(AnnotationOps.parseSave(JsonParser.parseString(
            "{\"tagPath\":\"[default]CTG/Temp\",\"type\":\"range\",\"start\":9,\"end\":5,\"text\":\"x\"}")
            .getAsJsonObject(), b));
        assertEquals(AnnotationOps.TIME_ORDER, AnnotationOps.checkTimes(b, NOW, 400, true));
        assertEquals(ErrorCode.INVALID_VALUE, AnnotationOps.parseSave(JsonParser.parseString(
            "{\"tagPath\":\"[default]CTG/Temp\",\"type\":\"range\",\"start\":9,\"text\":\"x\"}").getAsJsonObject(),
            new AnnotationOps.SaveBody()), "a range without an end is still a body error");
        assertFalse(ErrorCode.INVALID_TIME.retryable());
        assertEquals(0, ErrorCode.INVALID_TIME.httpStatus(), "delegate-only code");
    }
}
