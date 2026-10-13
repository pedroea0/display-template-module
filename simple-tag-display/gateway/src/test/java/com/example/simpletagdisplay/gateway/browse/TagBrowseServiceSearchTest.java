package com.example.simpletagdisplay.gateway.browse;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Set;

import com.example.simpletagdisplay.gateway.delegate.PropsSnapshot;
import com.example.simpletagdisplay.gateway.security.ReadScope;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.model.values.BasicQualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.sqltags.model.types.DataType;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import org.junit.jupiter.api.Test;

/**
 * The service side of the recursive search: the permission pass (access-denied / not-found reads are dropped), the
 * stored-result pages (opaque continuation bound to the exact search, scope re-applied per page) and the reply shape.
 */
class TagBrowseServiceSearchTest {

    private static TagSearch.Match match(String path, DataType dt) {
        TagPath p = ReadScope.parseFolder(path, "default").get();
        String folder = path.substring(0, path.lastIndexOf('/'));
        return new TagSearch.Match(p, p.getItemName(), folder, dt);
    }

    private static ReadScope scope(String json) {
        PropsSnapshot p = TagSearchTest.props(json);
        return ReadScope.build(p, Set.of(), k -> false, List.of("System"), "default", List.of("default", "System"));
    }

    @Test
    void permissionPassDropsDeniedAndMissingTags() {
        List<TagSearch.Match> m = List.of(match("[default]A/Ok", DataType.Float8), match("[default]A/Secret", DataType.Float8),
            match("[default]A/Gone", DataType.Float8), match("[default]A/Unauth", DataType.Float8), match("[default]A/Null", DataType.Float8),
            match("[default]A/Uncertain", DataType.Float8));
        List<QualifiedValue> v = Arrays.asList(new BasicQualifiedValue(1.0, QualityCode.Good),
            new BasicQualifiedValue(null, QualityCode.Bad_AccessDenied), new BasicQualifiedValue(null, QualityCode.Bad_NotFound),
            new BasicQualifiedValue(null, QualityCode.Bad_Unauthorized), null, new BasicQualifiedValue(1.0, QualityCode.Uncertain));
        List<String> kept = new ArrayList<>();
        TagBrowseService.readable(m, v).forEach(x -> kept.add(x.name()));
        assertEquals(List.of("Ok", "Uncertain"), kept, "a readable tag stays whatever its value quality; denied/missing/unknown go");
    }

    @Test
    void pagesAreBoundToTheSearchAndRefilteredByScope() {
        TagBrowseService svc = new TagBrowseService();
        List<TagSearch.Match> all = new ArrayList<>();
        for (int i = 0; i < 5; i++) {
            all.add(match("[default]Area1/T" + i, DataType.Float8));
        }
        all.add(match("[default]Area2/X", DataType.String));
        TagSearch.Query q = TagSearch.Query.parse("t*").get();
        TagPath start = ReadScope.parseFolder("[default]", "default").get();
        String key = TagBrowseService.searchKeyPrefix(start, q) + 1;
        TagSearch.Outcome outcome = new TagSearch.Outcome(List.copyOf(all), null, 3, 9, 0, 0, 12);
        TagBrowseService.SearchResults r = new TagBrowseService.SearchResults(key, 7, start, List.copyOf(all), outcome, true, 0L);

        ReadScope everything = scope("{\"tagBrowser\":{\"enabled\":true}}");
        JsonObject p1 = svc.resultsPage(r, 0, 4, everything);
        JsonArray rows = p1.getAsJsonArray("results");
        assertEquals(4, rows.size());
        assertEquals(6, p1.get("totalAvailable").getAsInt());
        assertEquals("[default]", p1.get("path").getAsString());
        JsonObject row = rows.get(0).getAsJsonObject();
        assertEquals("[default]Area1/T0", row.get("path").getAsString());
        assertEquals("T0", row.get("name").getAsString());
        assertEquals("AtomicTag", row.get("type").getAsString());
        assertEquals("Float8", row.get("dataType").getAsString());
        assertFalse(row.get("hasChildren").getAsBoolean());
        assertTrue(row.get("trendable").getAsBoolean());
        assertEquals("[default]Area1", row.get("folder").getAsString());
        String cont = p1.get("continuation").getAsString();
        assertFalse(cont.contains("search") || cont.contains("t*") || cont.contains("default"), "opaque id");
        assertTrue(svc.continuationPaths().get(cont).startsWith("search\u0000[default]\u0000t*\u0000"),
            "the id stands for this exact search (path + text + sequence), so a browse or another search cannot use it");
        JsonObject s = p1.getAsJsonObject("search");
        assertTrue(s.get("complete").getAsBoolean());
        assertTrue(s.get("stopped").isJsonNull());
        assertTrue(s.get("wildcard").getAsBoolean());
        assertEquals(TagSearch.DEFAULT_LIMITS.maxResults(), s.get("maxResults").getAsInt());
        assertEquals(3, s.get("folders").getAsInt());

        JsonObject p2 = svc.resultsPage(r, 4, 4, everything);
        assertEquals(2, p2.getAsJsonArray("results").size());
        assertTrue(p2.get("continuation").isJsonNull());
        assertFalse(p2.getAsJsonArray("results").get(1).getAsJsonObject().get("trendable").getAsBoolean(), "String: not trendable");

        // the scope narrowed after the search ran: later pages are filtered by the scope of the moment
        ReadScope narrow = scope("{\"tagBrowser\":{\"enabled\":true},\"readScope\":{\"allowedRoots\":[\"[default]Area2\"]}}");
        JsonObject p3 = svc.resultsPage(r, 4, 4, narrow);
        assertEquals(1, p3.getAsJsonArray("results").size());
        assertEquals("[default]Area2/X", p3.getAsJsonArray("results").get(0).getAsJsonObject().get("path").getAsString());
        ReadScope none = scope("{\"tagBrowser\":{\"enabled\":true},\"readScope\":{\"allowRuntimePens\":false}}");
        assertEquals(0, svc.resultsPage(r, 0, 100, none).getAsJsonArray("results").size(), "no runtime pens: nothing");
    }

    @Test
    void stoppedSearchInfo() {
        TagSearch.Outcome cut = new TagSearch.Outcome(List.of(), TagSearch.STOP_TIME, 40, 900, 1, 2, 5003);
        JsonObject s = TagBrowseService.searchInfo(cut, 0, false, TagSearch.DEFAULT_LIMITS);
        assertFalse(s.get("complete").getAsBoolean());
        assertEquals("time", s.get("stopped").getAsString());
        assertEquals(1, s.get("denied").getAsInt());
        assertEquals(2, s.get("failed").getAsInt());
        assertEquals(5003, s.get("elapsedMs").getAsLong());
        assertEquals(5000, s.get("timeBudgetMs").getAsLong());
        assertFalse(TagBrowseService.searchInfo(null, 0, false, TagSearch.DEFAULT_LIMITS).get("complete").getAsBoolean(),
            "a search answered without a walk (cancelled) is never complete");
    }
}
