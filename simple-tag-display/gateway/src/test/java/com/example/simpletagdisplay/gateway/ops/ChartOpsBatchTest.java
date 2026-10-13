package com.example.simpletagdisplay.gateway.ops;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import com.example.simpletagdisplay.gateway.delegate.PropsSnapshot;
import com.example.simpletagdisplay.gateway.security.BindingLint;
import com.example.simpletagdisplay.gateway.security.ReadScope;
import com.example.simpletagdisplay.gateway.security.SecurityKeys;
import com.example.simpletagdisplay.gateway.security.TrustedProps;
import com.inductiveautomation.ignition.common.gson.JsonElement;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.gson.JsonParser;
import org.junit.jupiter.api.Test;

/**
 * A batch {@code chart.trendAdd} reports duplicates instead of dropping them silently; settings reloads fan out to the
 * live charts.
 */
class ChartOpsBatchTest {

    private static PropsSnapshot tree(String json) {
        JsonObject root = JsonParser.parseString(json).getAsJsonObject();
        Map<String, JsonElement> m = new HashMap<>();
        for (String leaf : SecurityKeys.CHART) {
            TrustedProps.readTrustForm(leaf, path -> {
                JsonElement cur = root;
                for (String part : path.split("\\.")) {
                    if (cur == null || !cur.isJsonObject() || !cur.getAsJsonObject().has(part)) {
                        return Optional.empty();
                    }
                    cur = cur.getAsJsonObject().get(part);
                }
                return Optional.of(cur);
            }).ifPresent(v -> m.put(leaf, v));
        }
        return new PropsSnapshot(m, BindingLint.LintReport.clean(), true);
    }

    private static ReadScope scope() {
        PropsSnapshot p = tree("{\"readScope\":{\"allowRuntimePens\":true,\"allowedRoots\":[\"[default]CTG\"]}}");
        return ReadScope.build(p, Set.of(), k -> false, List.of("System"), "default", List.of("default", "System"));
    }

    @Test
    void duplicatesInABatchAreReportedOnceEachAndEveryPathIsAccountedFor() {
        List<String> raws = List.of("[default]CTG/Temp", "[DEFAULT]ctg/temp", "CTG/Temp.Value", "[default]CTG/Pressure",
            "[default]Other/X", "[default]other/x", "[default]CTG/..", "[default]CTG/Pressure");
        ChartOps.TrendAddPrecheck pre = ChartOps.trendAddPrecheck(raws, "default", scope());
        assertEquals(List.of("[default]ctg/temp", "[default]ctg/pressure"), new ArrayList<>(pre.candidates.keySet()));
        assertEquals(2, pre.rejected.size(), "out of scope once, invalid once: " + pre.rejected);
        assertEquals("OUT_OF_SCOPE", pre.rejected.get(0).getAsJsonObject().get("code").getAsString());
        assertEquals("INVALID_PATH", pre.rejected.get(1).getAsJsonObject().get("code").getAsString());
        assertEquals(4, pre.duplicates.size(), pre.duplicates.toString());
        JsonObject d0 = pre.duplicates.get(0).getAsJsonObject();
        assertEquals("[DEFAULT]ctg/temp", d0.get("tagPath").getAsString(), "as sent");
        assertEquals("[default]CTG/Temp", d0.get("sameAs").getAsString(), "canonical path of the first entry");
        assertEquals("[default]CTG/Temp", pre.duplicates.get(1).getAsJsonObject().get("sameAs").getAsString(),
            "provider-less + .Value spelling of the same tag");
        assertEquals("[default]Other/X", pre.duplicates.get(2).getAsJsonObject().get("sameAs").getAsString(),
            "a duplicate of a refused tag is reported too (not refused twice)");
        assertEquals(raws.size(), pre.candidates.size() + pre.rejected.size() + pre.duplicates.size(),
            "added + rejected + duplicates = paths sent");
    }

    @Test
    void aBatchWithoutRepeatsHasNoDuplicates() {
        ChartOps.TrendAddPrecheck pre = ChartOps.trendAddPrecheck(List.of("[default]CTG/A", "[default]CTG/B"), "default",
            scope());
        assertEquals(0, pre.duplicates.size());
        assertEquals(2, pre.candidates.size());
    }

    @Test
    void settingsFanOutCallsEveryRegisteredChartUntilRemoved() {
        SettingsFanOut f = new SettingsFanOut();
        AtomicInteger a = new AtomicInteger();
        AtomicInteger b = new AtomicInteger();
        Runnable ra = a::incrementAndGet;
        Runnable rb = () -> {
            b.incrementAndGet();
            throw new IllegalStateException("one failing chart must not stop the others");
        };
        f.add(ra);
        f.add(ra);
        f.add(rb);
        assertEquals(2, f.size(), "idempotent add");
        f.changed();
        f.changed();
        assertEquals(2, a.get());
        assertEquals(2, b.get());
        f.remove(ra);
        f.remove(rb);
        f.changed();
        assertEquals(2, a.get(), "removed on delegate stop");
        assertTrue(f.size() == 0);
    }
}