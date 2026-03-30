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
 * Queries tag history via TagHistoryManager and returns JSON in the format
 * expected by the CTG Chart: { "series": [ { "tagPath": "...", "points": [ { "t": ms, "v": value }, ... ] } ] }.
 */
public final class TagHistoryQuery {

    private TagHistoryQuery() {}

    /**
     * Query historian for the given tag paths and time range. Returns JSON object with "success" and "series".
     * If Tag History is not available or query fails, returns success true with empty series.
     */
    public static JsonObject query(GatewayContext gatewayContext, List<String> tagPathStrings,
            double rangeHours, int pointCount) {
        JsonObject out = new JsonObject();
        out.addProperty("success", true);
        JsonArray seriesArray = new JsonArray();

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
        long rangeMs = (long) (rangeHours * 3600 * 1000);
        int returnSize = pointCount <= 0 ? 0 : pointCount;

        // Align the end time to a bucket boundary so the query window is stable
        // between refresh ticks. Without this, shifting bucket edges cause a spike
        // to alternately appear/disappear depending on whether it happens to be the
        // "last value" in its bucket on any given tick.
        long alignedNow = now;
        if (returnSize > 0 && rangeMs > 0) {
            long bucketMs = rangeMs / returnSize;
            if (bucketMs > 0) alignedNow = (now / bucketMs) * bucketMs;
        }

        Date endDate = new Date(alignedNow);
        Date startDate = new Date(alignedNow - rangeMs);

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
