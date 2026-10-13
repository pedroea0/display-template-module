package com.example.simpletagdisplay.gateway.annotations;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Function;

import com.example.simpletagdisplay.gateway.tags.TagPaths;
import com.inductiveautomation.ignition.common.QualifiedPath;
import com.inductiveautomation.ignition.common.QualifiedPathUtils;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import com.inductiveautomation.ignition.common.model.values.BasicQualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.history.annotations.Annotation;
import com.inductiveautomation.ignition.common.sqltags.history.annotations.AnnotationType;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.gateway.historian.TagHistoryManager;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * Annotation version collapse, the per-pen window, path attribution, the historian capability cache
 * (the {@code annotationsStatus:"unsupported"} path driven by a stub {@link TagHistoryManager}), stores, the quota and
 * the data JSON. Claims settle by token (compare-and-remove); the per-pen cap counts distinct live annotations,
 * earliest by start, after versions are collapsed.
 */
class AnnotationServiceTest {

    private final AnnotationService svc = new AnnotationService();

    @AfterEach
    void close() {
        svc.close();
    }

    private static AnnotationService.Item item(String id, long start, Long end, String data, Long lastUpdated, boolean deleted) {
        return new AnnotationService.Item(id, end == null ? "note" : "range", start, end, data, lastUpdated, deleted);
    }

    private static TagPath path(String s) {
        return TagPaths.parse(s, "default").path();
    }

    /** A historian answering queryAnnotations / storeAnnotations with the given functions (everything else throws). */
    private static TagHistoryManager historian(Function<Object[], Object> query, Function<Object[], Object> store) {
        return (TagHistoryManager) Proxy.newProxyInstance(TagHistoryManager.class.getClassLoader(),
            new Class<?>[] {TagHistoryManager.class}, (proxy, m, args) -> {
                switch (m.getName()) {
                    case "queryAnnotations":
                        return query.apply(args);
                    case "storeAnnotations":
                        return store.apply(args);
                    case "toString":
                        return "stub historian";
                    default:
                        throw new UnsupportedOperationException(m.getName());
                }
            });
    }

    // ---- version collapse ---------------------------------------------------------------------------------------

    @Test
    void sameIdCollapsesToTheLastReturnedVersion() {
        List<AnnotationService.Item> out = AnnotationService.collapse(List.of(
            item("a", 1000, null, "v1", null, false),
            item("b", 2000, 3000L, "range", null, false),
            item("a", 1000, null, "v2", null, false)));
        assertEquals(2, out.size());
        assertEquals("a", out.get(0).id(), "first appearance keeps its place");
        assertEquals("v2", out.get(0).data(), "Core Historian returns versions oldest first: the last one wins");
        assertEquals("b", out.get(1).id());
    }

    @Test
    void lastUpdatedDecidesWhenEveryVersionHasOne() {
        List<AnnotationService.Item> out = AnnotationService.collapse(List.of(
            item("a", 1000, null, "newer", 50L, false),
            item("a", 1000, null, "older", 10L, false)));
        assertEquals("newer", out.get(0).data());
        List<AnnotationService.Item> mixed = AnnotationService.collapse(List.of(
            item("a", 1000, null, "stamped", 50L, false),
            item("a", 1000, null, "unstamped", null, false)));
        assertEquals("unstamped", mixed.get(0).data(), "without both stamps the later one wins");
    }

    @Test
    void deletedWinnerRemovesTheAnnotation() {
        assertTrue(AnnotationService.collapse(List.of(
            item("a", 1000, null, "v1", null, false),
            item("a", 1000, null, "v1", null, true))).isEmpty());
        assertEquals(1, AnnotationService.collapse(List.of(
            item(null, 1000, null, "foreign", null, false),
            item(null, 1000, null, "gone", null, true))).size(), "id-less entries: deleted dropped, others kept");
    }

    // ---- per-pen window -----------------------------------------------------------------------------------------

    @Test
    void windowKeepsWhatOverlapsSortedAndCapped() {
        List<AnnotationService.Item> items = new ArrayList<>(List.of(
            item("late", 9000, null, "", null, false),
            item("rangeIn", 500, 1500L, "", null, false),      // began before the window, ends inside
            item("before", 100, null, "", null, false),
            item("after", 20_000, null, "", null, false),
            item("note", 1200, null, "", null, false)));
        AnnotationService.Window w = AnnotationService.forWindow(items, 1000, 10_000, 10);
        assertEquals(List.of("rangeIn", "note", "late"), w.items().stream().map(AnnotationService.Item::id).toList());
        assertFalse(w.truncated());
        AnnotationService.Window capped = AnnotationService.forWindow(items, 1000, 10_000, 2);
        assertEquals(2, capped.items().size());
        assertTrue(capped.truncated());
    }

    @Test
    void queryLooksBackOneWindowBetweenAnHourAnd31Days() {
        long h = 3_600_000L;
        assertEquals(10 * h - h, AnnotationService.queryFrom(10 * h, 10 * h + 60_000), "at least 1 h");
        assertEquals(100 * h - 8 * h, AnnotationService.queryFrom(100 * h, 108 * h), "one window");
        long d = 24 * h;
        assertEquals(1000 * d - 31 * d, AnnotationService.queryFrom(1000 * d, 1100 * d), "at most 31 d");
        assertEquals(0, AnnotationService.queryFrom(1000, 2000), "never negative");
    }

    // ---- attribution -------------------------------------------------------------------------------------------

    @Test
    void keyOfTheBridgeAndModernPaths() throws Exception {
        assertEquals("[default]ctg/temp", AnnotationService.keyOf(QualifiedPath.parse("histprov:default:/tag:CTG/Temp")));
        assertEquals("[default]a/b", AnnotationService.keyOf(QualifiedPath.parse("histprov:Core Historian:/prov:default:/tag:A/B")));
        assertEquals("[default]ctg/temp", AnnotationService.keyOf(QualifiedPathUtils.fromTagPathNew(path("[default]CTG/Temp"))));
        assertNull(AnnotationService.keyOf(QualifiedPath.parse("histprov:default")));
        assertNull(AnnotationService.keyOf(null));
    }

    @Test
    void multiPathResultsGoToTheirPens() {
        TagPath temp = path("[default]CTG/Temp");
        TagPath pres = path("[default]CTG/Pressure");
        Map<String, TagPath> paths = new LinkedHashMap<>();
        paths.put(TagPaths.normalizedKey(temp), temp);
        paths.put(TagPaths.normalizedKey(pres), pres);
        List<Annotation> found = List.of(note(pres, 1000, "p"), note(temp, 2000, "t"), note(path("[default]Other"), 3000, "x"));
        Map<String, List<AnnotationService.Item>> by = AnnotationService.attribute(found, paths);
        assertEquals("t", by.get("[default]ctg/temp").get(0).data());
        assertEquals("p", by.get("[default]ctg/pressure").get(0).data());
        assertEquals(2, by.size(), "an entry of a path that was not asked for is ignored");
        Map<String, TagPath> one = Map.of(TagPaths.normalizedKey(temp), temp);
        assertEquals(3, AnnotationService.attribute(found, one).get("[default]ctg/temp").size(),
            "a single queried path takes every result, whatever spelling the historian echoes");
    }

    private static Annotation note(TagPath p, long t, String data) {
        return Annotation.newBuilder().path(QualifiedPathUtils.fromTagPathNew(p)).type(AnnotationType.NOTE).time(new Date(t))
            .data(data).storageId(UUID.randomUUID()).build();
    }

    // ---- historian capability (the "unsupported" path) -----------------------------------------------------------

    @Test
    void unsupportedHistorianIsRememberedAndNotAskedAgain() {
        AtomicInteger calls = new AtomicInteger();
        TagHistoryManager mgr = historian(a -> {
            calls.incrementAndGet();
            throw new UnsupportedOperationException("annotations");
        }, a -> null);
        TagPath temp = path("[default]CTG/Temp");
        Map<String, TagPath> paths = Map.of(TagPaths.normalizedKey(temp), temp);
        AnnotationService.QueryResult r = svc.query(mgr, "SQL Hist", paths, 0, 1000, AnnotationService.TYPES);
        assertEquals(AnnotationService.STATUS_UNSUPPORTED, r.status());
        assertTrue(r.of("[default]ctg/temp").isEmpty());
        assertTrue(svc.unsupported("sql hist"), "provider names compare case-insensitively");
        assertEquals(AnnotationService.STATUS_UNSUPPORTED, svc.query(mgr, "SQL Hist", paths, 0, 1000, AnnotationService.TYPES).status());
        assertEquals(1, calls.get(), "cached for 10 minutes");
        assertEquals(AnnotationService.STATUS_OK, svc.query(historian(a -> List.of(), a -> null), "Core Historian", paths, 0, 1000,
            AnnotationService.TYPES).status(), "another historian is unaffected");
    }

    @Test
    void messageSayingNotSupportedCountsAsUnsupportedOtherFailuresAsErrors() {
        assertTrue(AnnotationService.looksUnsupported(new IllegalStateException("Annotations are not supported by this provider")));
        assertTrue(AnnotationService.looksUnsupported(new RuntimeException(new UnsupportedOperationException())));
        assertTrue(AnnotationService.looksUnsupported(new RuntimeException("wrapped", new IllegalStateException(
            "storeAnnotations not implemented"))));
        assertFalse(AnnotationService.looksUnsupported(new RuntimeException("connection refused")));
        // a message match that is not about annotations is an ordinary (30 s) error
        assertFalse(AnnotationService.looksUnsupported(new RuntimeException("SQLException: Unsupported data type 1111")));
        assertFalse(AnnotationService.looksUnsupported(new IllegalStateException("Feature not implemented: MERGE")));
        TagPath sqlPath = path("[default]CTG/Temp");
        assertEquals(AnnotationService.STATUS_ERROR, svc.query(historian(a -> {
            throw new RuntimeException("Unsupported data type");
        }, a -> null), "SQL", Map.of(TagPaths.normalizedKey(sqlPath), sqlPath), 0, 1000, AnnotationService.TYPES).status());
        assertFalse(svc.unsupported("SQL"), "not hidden for 10 minutes");
        TagPath temp = path("[default]CTG/Temp");
        AnnotationService.QueryResult r = svc.query(historian(a -> {
            throw new RuntimeException("connection refused");
        }, a -> null), "Remote", Map.of(TagPaths.normalizedKey(temp), temp), 0, 1000, AnnotationService.TYPES);
        assertEquals(AnnotationService.STATUS_ERROR, r.status());
        assertFalse(svc.unsupported("Remote"), "a transient error is not 'unsupported'");
        assertEquals(AnnotationService.STATUS_ERROR, svc.status("Remote", System.currentTimeMillis()));
        assertNull(svc.status("Remote", System.currentTimeMillis() + AnnotationService.ERROR_TTL_MS + 1), "errors expire after 30 s");
    }

    @Test
    void queryPassesTheTypeFilterAndWindow() {
        Object[][] seen = new Object[1][];
        TagPath temp = path("[default]CTG/Temp");
        svc.query(historian(a -> {
            seen[0] = a;
            return List.of();
        }, a -> null), "Core Historian", Map.of(TagPaths.normalizedKey(temp), temp), 5_000, 9_000, List.of("range"));
        assertEquals(5_000L, ((Date) seen[0][1]).getTime());
        assertEquals(9_000L, ((Date) seen[0][2]).getTime());
        assertEquals("range", String.join(",", ((com.inductiveautomation.ignition.common.sqltags.history.annotations.TypeFilter)
            seen[0][3]).getAllowedFilters()));
    }

    // ---- stores --------------------------------------------------------------------------------------------------

    @Test
    void storeMapsQualitiesAndRemembersAThrowingHistorian() throws Exception {
        TagPath temp = path("[default]CTG/Temp");
        TagHistoryManager good = historian(a -> List.of(), a -> {
            List<QualifiedValue> out = new ArrayList<>();
            out.add(new BasicQualifiedValue(null, QualityCode.Good, new Date()));
            out.add(new BasicQualifiedValue(null, QualityCode.Error_Configuration, new Date()));
            return out;
        });
        List<QualityCode> q = svc.store(good, "Core Historian", List.of(note(temp, 1, "a"), note(temp, 2, "b")))
            .get(5, TimeUnit.SECONDS);
        assertEquals(List.of(QualityCode.Good, QualityCode.Error_Configuration), q);
        TagHistoryManager throwing = historian(a -> List.of(), a -> {
            throw new UnsupportedOperationException("no");
        });
        ExecutionException e = assertThrows(ExecutionException.class,
            () -> svc.store(throwing, "Other", List.of(note(temp, 1, "a"))).get(5, TimeUnit.SECONDS));
        assertEquals(AnnotationService.STATUS_UNSUPPORTED, ((AnnotationService.StoreFailed) e.getCause()).status());
        assertTrue(svc.unsupported("Other"));
    }

    @Test
    void versionsFindsEveryVersionOfTheId() throws Exception {
        TagPath temp = path("[default]CTG/Temp");
        UUID id = UUID.randomUUID();
        Annotation v1 = Annotation.newBuilder().path(QualifiedPathUtils.fromTagPathNew(temp)).type("note").time(new Date(5))
            .data("v1").storageId(id).build();
        Annotation v2 = v1.toBuilder().data("v2").build();
        Annotation other = note(temp, 6, "other");
        List<Annotation> found = svc.versions(historian(a -> List.of(v1, other, v2), a -> null), "Core Historian", temp, id,
            0, 10).get(5, TimeUnit.SECONDS);
        assertEquals(2, found.size());
        assertEquals("v2", AnnotationService.current(found).getData());
        assertNull(AnnotationService.current(List.of(v1, v2.toBuilder().delete().build())), "a deleted last version = gone");
    }

    // ---- the query is bounded per pen before versions are collapsed -----------------------------------------------

    @Test
    void queryKeepsOnlyWindowEntriesAndCapsEachPen() {
        TagPath temp = path("[default]CTG/Temp");
        TagPath pres = path("[default]CTG/Pressure");
        Map<String, TagPath> paths = new LinkedHashMap<>();
        paths.put(TagPaths.normalizedKey(temp), temp);
        paths.put(TagPaths.normalizedKey(pres), pres);
        List<Annotation> found = new ArrayList<>();
        for (int i = 0; i < 50; i++) {
            found.add(note(temp, 100 + i, "before the window " + i));          // look-back entries outside the window
        }
        for (int i = 0; i < 30; i++) {
            found.add(note(temp, 1_000 + i, "in " + i));
        }
        found.add(note(pres, 1_500, "p"));
        Annotation range = Annotation.newBuilder().path(QualifiedPathUtils.fromTagPathNew(pres)).type(AnnotationType.RANGE)
            .start(new Date(500)).end(new Date(1_200)).data("overlaps").storageId(UUID.randomUUID()).build();
        found.add(range);
        AnnotationService.QueryResult r = svc.query(historian(a -> found, a -> null), "Core Historian", paths, 0, 2_000,
            AnnotationService.TYPES, 1_000, 2_000, 10);
        assertEquals(AnnotationService.STATUS_OK, r.status());
        List<AnnotationService.Item> t = r.of("[default]ctg/temp");
        assertEquals(10, t.size(), "maxPerPen annotations kept, none from before the window");
        for (int i = 0; i < 10; i++) {
            assertEquals("in " + i, t.get(i).data(), "the earliest by start");
        }
        assertTrue(r.truncated("[default]ctg/temp"));
        assertEquals(2, r.of("[default]ctg/pressure").size(), "a range that began before the window but overlaps it is kept");
        assertFalse(r.truncated("[default]ctg/pressure"));
    }

    // ---- the cap counts distinct live annotations, after the collapse ----------------------------------------------

    @Test
    void capCountsDistinctAnnotationsAndNeverCutsANewerVersionOrADeletion() {
        TagPath temp = path("[default]CTG/Temp");
        String key = TagPaths.normalizedKey(temp);
        Map<String, TagPath> paths = Map.of(key, temp);
        Annotation a = note(temp, 1_100, "a v1");
        Annotation b = note(temp, 1_050, "b");
        // A historian that returns deleted entries and version chains oldest first (not Core Historian, which returns
        // neither): with the old raw cap (2 x maxPerPen = 4 entries in historian order) "a v4" and b's deletion were
        // cut, so a stale text was shown and a deleted note came back.
        List<Annotation> found = new ArrayList<>(List.of(
            a, a.toBuilder().data("a v2").build(), a.toBuilder().data("a v3").build(),
            b, b.toBuilder().delete().build(),
            note(temp, 1_300, "c"),
            note(temp, 1_200, "d"),
            a.toBuilder().data("a v4").build()));
        Function<Integer, AnnotationService.QueryResult> q = cap -> svc.query(historian(x -> found, x -> null),
            "Core Historian", paths, 0, 2_000, AnnotationService.TYPES, 1_000, 2_000, cap);

        AnnotationService.QueryResult two = q.apply(2);
        assertEquals(List.of("a v4", "d"), two.of(key).stream().map(AnnotationService.Item::data).toList(),
            "newest version of a, deletion of b honoured, then the earliest by start (c is later than d)");
        assertTrue(two.truncated(key));

        AnnotationService.QueryResult three = q.apply(3);
        assertEquals(List.of("a v4", "d", "c"), three.of(key).stream().map(AnnotationService.Item::data).toList());
        assertFalse(three.truncated(key), "older versions and the deleted note take no place");

        // exactly forWindow(collapse(everything)): the per-pen window of the route cuts nothing more
        List<AnnotationService.Item> all = new ArrayList<>();
        for (Annotation x : found) {
            all.add(AnnotationService.Item.of(x));
        }
        AnnotationService.Window w = AnnotationService.forWindow(AnnotationService.collapse(all), 1_000, 2_000, 2);
        assertEquals(w.items().stream().map(AnnotationService.Item::id).toList(),
            two.of(key).stream().map(AnnotationService.Item::id).toList());
    }

    @Test
    void capCollapsesBeforeTheWindowSoAMovedVersionIsNotShownAtItsOldTime() {
        TagPath temp = path("[default]CTG/Temp");
        String key = TagPaths.normalizedKey(temp);
        Annotation old = note(temp, 1_500, "inside");
        // another tool stored a newer version of the same id at a time outside the window
        List<Annotation> found = List.of(old, old.toBuilder().time(new Date(5_000)).data("moved out").build());
        AnnotationService.QueryResult r = svc.query(historian(x -> found, x -> null), "Core Historian",
            Map.of(key, temp), 0, 6_000, AnnotationService.TYPES, 1_000, 2_000, 10);
        assertTrue(r.of(key).isEmpty(), "the winning version decides whether the note is in the window");
    }

    // ---- one change per entry at a time -------------------------------------------------------------------------

    private AnnotationService.ClaimResult claim(UUID id, long now) {
        return svc.claim(id, now).result();
    }

    @Test
    void claimsSerializeChangesOfOneId() {
        UUID id = UUID.randomUUID();
        long t = 1_000_000L;
        AnnotationService.Ticket first = svc.claim(id, t);
        assertEquals(AnnotationService.ClaimResult.OK, first.result());
        assertEquals(AnnotationService.ClaimResult.BUSY, claim(id, t + 1), "store still in flight");
        assertEquals(AnnotationService.ClaimResult.OK, claim(UUID.randomUUID(), t + 1), "other ids are independent");
        assertTrue(svc.settle(id, first.token(), false, t + 2));
        AnnotationService.Ticket second = svc.claim(id, t + 3);
        assertEquals(AnnotationService.ClaimResult.OK, second.result(), "a failed change frees the id");
        assertTrue(svc.settle(id, second.token(), true, t + 4));
        assertEquals(AnnotationService.ClaimResult.GONE, claim(id, t + 5), "replaced: answers not found");
        assertEquals(AnnotationService.ClaimResult.GONE, claim(id, t + 4 + AnnotationService.REPLACED_TTL_MS - 1));
        assertEquals(AnnotationService.ClaimResult.OK, claim(id, t + 4 + AnnotationService.REPLACED_TTL_MS),
            "forgotten after the TTL (the historian shows the deletion long before)");
        UUID stuck = UUID.randomUUID();
        svc.claim(stuck, t);
        assertEquals(AnnotationService.ClaimResult.OK, claim(stuck, t + AnnotationService.CLAIM_MAX_MS),
            "a store that never answers cannot lock an id for ever");
        for (int i = 0; i < AnnotationService.CLAIMS_PRUNE_AT + 10; i++) {
            svc.claim(UUID.randomUUID(), t);
        }
        svc.claim(UUID.randomUUID(), t + AnnotationService.CLAIM_MAX_MS + 1);
        assertTrue(svc.claimCount() < 10, "expired claims are pruned: " + svc.claimCount());
    }

    // ---- settle is compare-and-remove by the claim's token ---------------------------------------------------------

    @Test
    void aStaleSettleNeverTouchesANewerClaim() {
        UUID id = UUID.randomUUID();
        long t = 5_000_000L;
        AnnotationService.Ticket slow = svc.claim(id, t);
        // the slow store outlives the safety bound; another change claims the id meanwhile
        AnnotationService.Ticket next = svc.claim(id, t + AnnotationService.CLAIM_MAX_MS);
        assertEquals(AnnotationService.ClaimResult.OK, next.result());
        assertTrue(next.token() != slow.token(), "every claim has its own token");

        assertFalse(svc.settle(id, slow.token(), false, t + AnnotationService.CLAIM_MAX_MS + 1),
            "the slow store's failure does not free the newer claim");
        assertEquals(AnnotationService.ClaimResult.BUSY, claim(id, t + AnnotationService.CLAIM_MAX_MS + 2));
        assertFalse(svc.settle(id, slow.token(), true, t + AnnotationService.CLAIM_MAX_MS + 3),
            "nor does its success overwrite it");
        assertEquals(AnnotationService.ClaimResult.BUSY, claim(id, t + AnnotationService.CLAIM_MAX_MS + 4),
            "still in flight, not GONE");

        assertTrue(svc.settle(id, next.token(), true, t + AnnotationService.CLAIM_MAX_MS + 5));
        assertEquals(AnnotationService.ClaimResult.GONE, claim(id, t + AnnotationService.CLAIM_MAX_MS + 6));
        assertFalse(svc.settle(id, next.token(), false, t + AnnotationService.CLAIM_MAX_MS + 7),
            "a settled claim is not settled twice (the GONE marker stays)");
        assertEquals(AnnotationService.ClaimResult.GONE, claim(id, t + AnnotationService.CLAIM_MAX_MS + 8));
        assertFalse(svc.settle(UUID.randomUUID(), next.token(), false, t), "unknown id");
    }

    // ---- quota ---------------------------------------------------------------------------------------------------

    @Test
    void quotaIsASlidingHourPerSession() {
        UUID a = UUID.randomUUID();
        UUID b = UUID.randomUUID();
        long t = 1_000_000_000L;
        for (int i = 0; i < 3; i++) {
            assertTrue(svc.takeQuota(a, 3, t + i));
        }
        assertFalse(svc.takeQuota(a, 3, t + 10), "4th save within the hour");
        assertTrue(svc.takeQuota(b, 3, t + 10), "per session");
        svc.refund(a, t + 2);
        assertTrue(svc.takeQuota(a, 3, t + 11), "a refunded save frees its slot");
        assertFalse(svc.takeQuota(a, 3, t + 12));
        assertTrue(svc.takeQuota(a, 3, t + AnnotationService.QUOTA_WINDOW_MS + 1), "the oldest left the hour");
        svc.evict(a);
        svc.evict(b);
        assertEquals(0, svc.quotaSessions());
    }

    // ---- data JSON -----------------------------------------------------------------------------------------------

    @Test
    void textIsCleaned() {
        assertEquals("a\nb\tc", AnnotationService.cleanText("  a\r\nb\tc\u0000\u0007 "));
        assertEquals("x", AnnotationService.cleanText("x" + (char) 0x2028 + (char) 0x2029 + (char) 0x1b));
        String longText = "y".repeat(1500);
        assertEquals(AnnotationService.MAX_TEXT_CHARS, AnnotationService.cleanText(longText).length());
        String pair = "z".repeat(AnnotationService.MAX_TEXT_CHARS - 1) + "😀";
        String cut = AnnotationService.cleanText(pair);
        assertFalse(Character.isHighSurrogate(cut.charAt(cut.length() - 1)), "never half a surrogate pair");
        assertEquals("", AnnotationService.cleanText(null));
    }

    @Test
    void dataJsonRoundTripAndForeignData() {
        String json = AnnotationService.dataJson("Pump <b>tripped</b>", "engineer", "#FF0000", 123L, null, null);
        JsonObject o = JsonParser.parseString(json).getAsJsonObject();
        assertEquals(1, o.get("v").getAsInt());
        assertTrue(o.get("color").getAsString().equals("#FF0000"));
        AnnotationService.Note n = AnnotationService.parseData(json);
        assertTrue(n.ours());
        assertEquals("Pump <b>tripped</b>", n.text());
        assertEquals("engineer", n.author());
        assertEquals(123L, n.created());
        assertTrue(AnnotationService.isOwn(n, "engineer"));
        assertFalse(AnnotationService.isOwn(n, "Engineer"), "user names compare exactly");
        AnnotationService.Note edited = AnnotationService.parseData(
            AnnotationService.dataJson("t", null, null, 5L, "operator", 9L));
        assertNull(edited.author());
        assertFalse(AnnotationService.isOwn(edited, "operator"), "an unknown author is nobody's");
        AnnotationService.Note foreign = AnnotationService.parseData("written by a script");
        assertFalse(foreign.ours());
        assertEquals("written by a script", foreign.text());
        assertNull(foreign.author());
        assertFalse(AnnotationService.parseData("{\"v\":2,\"author\":\"engineer\"}").ours(), "other versions are foreign");
        assertNull(AnnotationService.parseData(AnnotationService.dataJson("t", "a", "red", 1L, null, null)).color(),
            "a stored colour that is not #RRGGBB is ignored");
    }

    @Test
    void colourRule() {
        assertTrue(AnnotationService.COLOR.matcher("").matches());
        assertTrue(AnnotationService.COLOR.matcher("#00ff7A").matches());
        assertFalse(AnnotationService.COLOR.matcher("#00ff7").matches());
        assertFalse(AnnotationService.COLOR.matcher("red").matches());
        assertFalse(AnnotationService.COLOR.matcher("#00ff7a;background:url(x)").matches());
    }
}
