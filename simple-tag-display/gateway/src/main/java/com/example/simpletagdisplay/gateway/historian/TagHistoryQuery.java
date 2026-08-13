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

        // Wide-format dataset layout from TagHistoryManager:
        //   col 0  = timestamp (Date)
        //   col 1+ = one column per tag path, in the same order we passed in
        //
        // Output transformation:
        //   - timestamps → epoch ms (long) under "t"
        //   - values → double under "v"
        //   - NaN/Infinite values are SKIPPED (Gson would emit literal `NaN` which is
        //     invalid JSON and would crash the JS parser — historian returns NaN for
        //     points where the tag had bad quality, and for empty aggregation buckets).
        int tagCount = validPathStrings.size();
        List<JsonArray> pointsPerTag = new ArrayList<>(tagCount);
        long[] firstTs = new long[tagCount];
        for (int i = 0; i < tagCount; i++) {
            pointsPerTag.add(new JsonArray());
            firstTs[i] = Long.MAX_VALUE;
        }

        Dataset ds = writer;
        int rows = ds.getRowCount();
        int cols = ds.getColumnCount();
        int timestampCol = 0;
        if (cols >= 2 && rows > 0) {
            for (int c = 1; c < cols && c - 1 < tagCount; c++) {
                JsonArray points = pointsPerTag.get(c - 1);
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
                    if (t < firstTs[c - 1]) firstTs[c - 1] = t;
                }
            }
        }

        // -- CARRY-IN ANCHOR ---------------------------------------------------------
        // A window narrower than the tag's logging interval contains no stored sample,
        // so every aggregation bucket comes back NaN, every point is skipped above, and
        // the series is empty. The chart then has nothing to draw a line between — the
        // user sees only the live "now" point the frontend appends. That is what made
        // the line "disappear" both when zoomed in and on short realtime ranges like
        // "Last 30 seconds".
        //
        // Fix: for any tag whose data does not already start at the window start, look
        // up its last known value BEFORE the window and emit it at resolvedStart. That
        // is standard last-known-value carry-forward — the same thing Power Chart does
        // — and it guarantees a left-hand anchor to draw from at any window width.
        //
        // Cost control: this runs ONE extra historian query, and only when at least one
        // tag actually needs an anchor. Dense tags whose data already covers the window
        // skip it entirely.
        // ----------------------------------------------------------------------------
        boolean needAnchor = false;
        for (int i = 0; i < tagCount; i++) {
            if (firstTs[i] > resolvedStart) { needAnchor = true; break; }
        }
        if (needAnchor) {
            double[] anchors = lastValuesBefore(thm, pathList, resolvedStart, tagCount);
            for (int i = 0; i < tagCount; i++) {
                if (firstTs[i] <= resolvedStart) continue;             // already covered
                double av = anchors[i];
                if (Double.isNaN(av) || Double.isInfinite(av)) continue;
                JsonObject pt = new JsonObject();
                pt.addProperty("t", resolvedStart);
                pt.addProperty("v", av);
                // prepend — the frontend builds its timestamp spine by sorting, but
                // keeping the array ordered costs nothing and keeps the JSON readable
                JsonArray existing = pointsPerTag.get(i);
                JsonArray merged = new JsonArray();
                merged.add(pt);
                merged.addAll(existing);
                pointsPerTag.set(i, merged);
            }
        }

        for (int i = 0; i < tagCount; i++) {
            JsonObject series = new JsonObject();
            series.addProperty("tagPath", validPathStrings.get(i));
            series.add("points", pointsPerTag.get(i));
            seriesArray.add(series);
        }
        out.add("series", seriesArray);
        return out;
    }

    /** How far back to hunt for a carry-in value. Bounded so a tag that has never been
     *  logged can't turn into an unbounded historian scan. */
    private static final long ANCHOR_LOOKBACK_MS = 24L * 60 * 60 * 1000;

    /**
     * Last stored value per tag strictly before {@code beforeMs}, as a parallel array
     * aligned to {@code pathList}. Entries are NaN where no prior value exists.
     *
     * Uses returnSize=1 + LastValue over [beforeMs - ANCHOR_LOOKBACK_MS, beforeMs], which
     * asks the historian for exactly one aggregated row: the most recent value in that
     * lookback. Any failure degrades to all-NaN, which simply means no anchor is added.
     */
    private static double[] lastValuesBefore(
            com.inductiveautomation.ignition.gateway.historian.TagHistoryManager thm,
            List<com.inductiveautomation.ignition.common.Path> pathList,
            long beforeMs, int tagCount) {

        double[] result = new double[tagCount];
        for (int i = 0; i < tagCount; i++) result[i] = Double.NaN;

        long lookbackStart = beforeMs - ANCHOR_LOOKBACK_MS;
        if (lookbackStart < 0) lookbackStart = 0;
        if (beforeMs <= lookbackStart) return result;

        try {
            BasicTagHistoryQueryParams params = new BasicTagHistoryQueryParams(
                    pathList, new Date(lookbackStart), new Date(beforeMs), 1,
                    AggregationMode.LastValue, ReturnFormat.Wide, null, null);
            BasicStreamingDataset writer = new BasicStreamingDataset();
            thm.queryHistory(params, writer);
            writer.finish();

            Dataset ds = writer;
            int rows = ds.getRowCount();
            int cols = ds.getColumnCount();
            if (cols < 2 || rows == 0) return result;
            // Walk every row and keep the last finite value per column — returnSize=1
            // normally yields a single row, but don't depend on that.
            for (int c = 1; c < cols && c - 1 < tagCount; c++) {
                for (int r = 0; r < rows; r++) {
                    Object valObj = ds.getValueAt(r, c);
                    double v = valObj instanceof Number ? ((Number) valObj).doubleValue() : Double.NaN;
                    if (!Double.isNaN(v) && !Double.isInfinite(v)) result[c - 1] = v;
                }
            }
        } catch (Exception e) {
            // no anchor available — chart degrades to what it did before
        }
        return result;
    }
}
