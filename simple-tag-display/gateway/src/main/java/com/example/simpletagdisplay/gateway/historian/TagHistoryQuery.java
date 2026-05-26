package com.example.simpletagdisplay.gateway.historian;

import java.util.ArrayList;
import java.util.Date;
import java.util.List;

import com.inductiveautomation.ignition.common.Dataset;
import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.sqltags.history.AggregationMode;
import com.inductiveautomation.ignition.common.sqltags.history.BasicTagHistoryQueryParams;
import com.inductiveautomation.ignition.common.sqltags.history.ReturnFormat;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.paths.parser.TagPathParser;
import com.inductiveautomation.ignition.gateway.datasource.BasicStreamingDataset;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;

/**
 * Wraps Ignition's TagHistoryManager and shapes the result into the JSON the
 * CTG Chart frontend expects:
 *
 *   {
 *     "success": true,
 *     "series": [
 *       { "tagPath": "[default]Foo", "points": [ { "t": 1700000000000, "v": 42.5 }, ... ] },
 *       ...
 *     ]
 *   }
 *
 * Notes:
 *   - Aggregated mode uses AggregationMode.LastValue across `pointCount` buckets.
 *     End time is bucket-aligned so the window is stable between refresh ticks
 *     (without alignment, a spike alternately appears/disappears as buckets shift).
 *   - Raw mode uses returnSize=-1 (Ignition's "on-change" mode) and returns one
 *     row per stored value change in the window. `pointCount` is ignored.
 *   - NaN/Infinite values are filtered out — Ignition's Gson would emit a literal
 *     `NaN` token, which is invalid JSON and crashes the JS parser.
 *   - On any historian failure (TagHistoryManager null, query throws, empty rows),
 *     we return success=true with empty per-tag points arrays so the chart degrades
 *     gracefully instead of erroring.
 */
public final class TagHistoryQuery {

    private TagHistoryQuery() {}

    /** Convenience overload kept for any callers that want defaults (no custom range, aggregated). */
    public static JsonObject query(GatewayContext gatewayContext, List<String> tagPathStrings,
            double rangeHours, int pointCount) {
        return query(gatewayContext, tagPathStrings, rangeHours, pointCount, 0, 0, false);
    }

    /**
     * Query historian for the given tag paths and time range.
     *
     * @param gatewayContext  Ignition gateway context (provides TagHistoryManager)
     * @param tagPathStrings  fully-qualified tag paths e.g. "[default]Folder/Tag"
     * @param rangeHours      window size in hours from "now" (used only when start/end ms are 0)
     * @param pointCount      bucket count for aggregated queries (ignored when rawHistory)
     * @param startTimeMs     absolute window start in epoch ms (overrides rangeHours when > 0)
     * @param endTimeMs       absolute window end in epoch ms   (overrides rangeHours when > 0)
     * @param rawHistory      true → on-change samples (returnSize=-1, no downsampling)
     * @return                { success, series } JSON object (always success=true; empty series on failure)
     */
    public static JsonObject query(GatewayContext gatewayContext, List<String> tagPathStrings,
            double rangeHours, int pointCount, long startTimeMs, long endTimeMs, boolean rawHistory) {
        JsonObject out = new JsonObject();
        out.addProperty("success", true);
        JsonArray seriesArray = new JsonArray();

        // -- TagHistoryManager unavailable: degrade to empty per-tag points --
        com.inductiveautomation.ignition.gateway.historian.TagHistoryManager thm = gatewayContext.getTagHistoryManager();
        if (thm == null) {
            for (String p : tagPathStrings) {
                if (p == null || p.trim().isEmpty()) continue;
                JsonObject series = new JsonObject();
                series.addProperty("tagPath", p.trim());
                series.add("points", new JsonArray());
                seriesArray.add(series);
            }
            out.add("series", seriesArray);
            return out;
        }

        List<TagPath> paths = new ArrayList<>();
        List<String> validPathStrings = new ArrayList<>();
        for (String s : tagPathStrings) {
            if (s == null || s.trim().isEmpty()) continue;
            try {
                paths.add(TagPathParser.parse(s.trim()));
                validPathStrings.add(s.trim());
            } catch (Exception e) {
                // skip invalid path
            }
        }
        if (paths.isEmpty()) {
            out.add("series", seriesArray);
            return out;
        }

        long now = System.currentTimeMillis();
        // Aggregated mode: ~pointCount samples with LastValue per interval.
        // Raw / on-change: returnSize -1 (Ignition) — one row per stored change in range; pointCount unused.
        int returnSize = rawHistory ? -1 : (pointCount <= 0 ? 0 : pointCount);

        long resolvedEnd;
        long resolvedStart;
        if (startTimeMs > 0 && endTimeMs > 0) {
            resolvedStart = startTimeMs;
            resolvedEnd   = endTimeMs;
        } else {
            long rangeMs = (long) (rangeHours * 3600 * 1000);
            resolvedEnd = now;
            // Bucket-aligned end only for fixed-size aggregated queries (stable historian windows).
            if (!rawHistory && returnSize > 0 && rangeMs > 0) {
                long bucketMs = rangeMs / returnSize;
                if (bucketMs > 0) {
                    resolvedEnd = (now / bucketMs) * bucketMs;
                }
            }
            resolvedStart = resolvedEnd - rangeMs;
        }

        Date endDate   = new Date(resolvedEnd);
        Date startDate = new Date(resolvedStart);

        @SuppressWarnings("unchecked")
        List<com.inductiveautomation.ignition.common.Path> pathList = (List) paths;
        BasicTagHistoryQueryParams params = new BasicTagHistoryQueryParams(
                pathList, startDate, endDate, returnSize,
                AggregationMode.LastValue, ReturnFormat.Wide, null, null);

        BasicStreamingDataset writer = new BasicStreamingDataset();
        try {
            thm.queryHistory(params, writer);
            writer.finish();
        } catch (Exception e) {
            for (String p : tagPathStrings) {
                if (p == null || p.trim().isEmpty()) continue;
                JsonObject series = new JsonObject();
                series.addProperty("tagPath", p.trim());
                series.add("points", new JsonArray());
                seriesArray.add(series);
            }
            out.add("series", seriesArray);
            return out;
        }

        // Wide format: first column is timestamp, then one column per tag (same order as paths)
        Dataset ds = writer;
        int rows = ds.getRowCount();
        int cols = ds.getColumnCount();
        if (cols < 2 || rows == 0) {
            for (String p : validPathStrings) {
                JsonObject series = new JsonObject();
                series.addProperty("tagPath", p);
                series.add("points", new JsonArray());
                seriesArray.add(series);
            }
            out.add("series", seriesArray);
            return out;
        }

        // Wide-format dataset layout from TagHistoryManager:
        //   col 0  = timestamp (Date)
        //   col 1+ = one column per tag path, in the same order we passed in
        //
        // Output transformation:
        //   - timestamps → epoch ms (long) under "t"
        //   - values → double under "v"
        //   - NaN/Infinite values are SKIPPED (Gson would emit literal `NaN` which is
        //     invalid JSON and would crash the JS parser — historian returns NaN for
        //     points where the tag had bad quality).
        int timestampCol = 0;
        for (int c = 1; c < cols && c - 1 < validPathStrings.size(); c++) {
            JsonObject series = new JsonObject();
            series.addProperty("tagPath", validPathStrings.get(c - 1));
            JsonArray points = new JsonArray();
            for (int r = 0; r < rows; r++) {
                Object tsObj = ds.getValueAt(r, timestampCol);
                Object valObj = ds.getValueAt(r, c);
                if (tsObj == null) continue;
                long t = tsObj instanceof Date ? ((Date) tsObj).getTime()
                        : (tsObj instanceof Number ? ((Number) tsObj).longValue() : 0);
                double v = valObj instanceof Number ? ((Number) valObj).doubleValue() : Double.NaN;
                if (Double.isNaN(v) || Double.isInfinite(v)) continue;
                JsonObject pt = new JsonObject();
                pt.addProperty("t", t);
                pt.addProperty("v", v);
                points.add(pt);
            }
            series.add("points", points);
            seriesArray.add(series);
        }
        out.add("series", seriesArray);
        return out;
    }
}
