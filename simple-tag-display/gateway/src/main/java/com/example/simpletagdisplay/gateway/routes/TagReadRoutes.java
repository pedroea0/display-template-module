package com.example.simpletagdisplay.gateway.routes;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.common.model.values.BasicQualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualifiedValue;
import com.inductiveautomation.ignition.common.model.values.QualityCode;
import com.inductiveautomation.ignition.common.tags.model.SecurityContext;
import com.inductiveautomation.ignition.common.tags.model.TagPath;
import com.inductiveautomation.ignition.common.tags.model.TagProvider;
import com.inductiveautomation.ignition.common.tags.paths.parser.TagPathParser;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.dataroutes.RouteGroup;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import com.inductiveautomation.ignition.gateway.tags.model.GatewayTagManager;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import com.inductiveautomation.perspective.gateway.comm.Routes;

import jakarta.servlet.http.HttpServletResponse;

/**
 * REST routes for reading + writing single tag values, and checking whether a
 * tag is historized.
 *
 * Endpoints (all GET, all under /data/simpletagdisplay/):
 *
 *   /readTag?tagPath=...          → { success, value, quality, isGood }
 *     Used by SimpleTagDisplay to poll its tag (~every 250 ms), by the chart
 *     legend's "Current" column, and to read the .EngUnit property when the
 *     tag display has showUnits enabled.
 *
 *   /writeTag?tagPath=...&value=  → { success } | { success:false, error }
 *     Powers the optional setpoint write modal in SimpleTagDisplay.
 *
 *   /isHistorized?tagPath=...     → { historized: bool }
 *     Read on right-click. Determines whether the "Trend Tag" / "Remove Tag"
 *     context-menu entries should appear at all.
 *
 * Path parsing is a little involved because users may pass paths with or
 * without a "[provider]" prefix and may include a property after a "."
 * (e.g. "[default]Foo/Bar.HistoryEnabled"). The same algorithm is applied
 * in all three handlers:
 *   1. Parse the full path (TagPathParser).
 *   2. Read getSource() → provider name (default "default").
 *   3. Strip the "[provider]" prefix textually (so trailing "." property is preserved).
 *   4. Re-parse the remainder.
 */
public class TagReadRoutes {

    private static final LoggerEx log = LoggerEx.newBuilder().build("com.example.simpletagdisplay.gateway.routes.TagReadRoutes");
    private static final String READ_TAG_ROUTE = "/readTag";
    private static final String READ_TAGS_ROUTE = "/readTags";
    private static final String WRITE_TAG_ROUTE = "/writeTag";
    private static final String IS_HISTORIZED_ROUTE = "/isHistorized";

    public static void mountRoutes(RouteGroup routes) {
        // ------------------------------------------------------------------
        // /readTag — single async read with 30s timeout, returns value+quality
        // ------------------------------------------------------------------
        routes.newRoute(READ_TAG_ROUTE)
            .type(RouteGroup.TYPE_JSON)
            .accessControl(Routes.requireSession(EnumSet.of(SessionScope.Client, SessionScope.Designer)))
            .handler((RequestContext requestContext, HttpServletResponse response) -> {
                try {
                    // Get the gateway context from the request
                    GatewayContext gatewayContext = requestContext.getGatewayContext();
                    GatewayTagManager tagManager = gatewayContext.getTagManager();
                    
                    // Get the tag path from query parameters
                    String tagPathStr = requestContext.getParameter("tagPath");
                    
                    if (tagPathStr == null || tagPathStr.trim().isEmpty()) {
                        return errorResponse("No tag path provided");
                    }
                    
                    // Parse the full tag path (e.g., "[default]MyTag" or "[default]MyTag.Property" format)
                    TagPath fullPath = TagPathParser.parse(tagPathStr);
                    String providerName = fullPath.getSource();
                    
                    // Default to "default" provider if not specified
                    if (providerName == null || providerName.isEmpty()) {
                        providerName = "default";
                    }
                    
                    // Get the specific tag provider
                    TagProvider provider = tagManager.getTagProvider(providerName);
                    if (provider == null) {
                        return errorResponse("Tag provider not found: " + providerName);
                    }
                    
                    // Extract the tag path without the provider prefix, preserving any property (e.g., ".ValueSource")
                    // Check if the original path contains a property (has a "." after the tag name)
                    String tagPathWithoutProvider;
                    if (tagPathStr.contains("]")) {
                        // Extract everything after the provider bracket, preserving properties
                        int bracketIndex = tagPathStr.indexOf(']');
                        tagPathWithoutProvider = tagPathStr.substring(bracketIndex + 1);
                    } else {
                        // No provider prefix, use toStringPartial() which should preserve properties
                        tagPathWithoutProvider = fullPath.toStringPartial();
                    }
                    
                    TagPath tPath = TagPathParser.parse(tagPathWithoutProvider);
                    
                    // Read the tag value using the provider directly (following official SDK pattern)
                    List<QualifiedValue> values = provider.readAsync(
                        Arrays.asList(tPath),
                        SecurityContext.emptyContext()
                    ).get(30, TimeUnit.SECONDS);
                    
                    if (values != null && !values.isEmpty()) {
                        QualifiedValue qv = values.get(0);
                        String tagId = qv.getValue() != null ? qv.getValue().toString() : "null";
                        JsonObject jsonResponse = new JsonObject();
                        jsonResponse.addProperty("success", true);
                        jsonResponse.addProperty("value", tagId);
                        jsonResponse.addProperty("quality", qv.getQuality().toString());
                        jsonResponse.addProperty("isGood", qv.getQuality().isGood());
                        
                        return jsonResponse;
                    } else {
                        return errorResponse("No results from tag read");
                    }
                    
                } catch (Exception e) {
                    log.error("Error reading tag: " + e.getMessage(), e);
                    return errorResponse("Error reading tag: " + e.getMessage());
                }
            })
            .mount();

        // ------------------------------------------------------------------
        // /readTags — BATCH read of many tags in a single request.
        //
        // Query:   tagPaths=csv  (each path percent-encoded, comma-joined —
        //          same convention as /tagHistory and the client batched poller).
        // Returns: { success:true, values: { "<originalPath>": { value, quality, isGood }, ... } }
        //          Missing/failed paths get { isGood:false }.
        //
        // Why: a view with 30+ SimpleTagDisplay components used to fire 30+
        // separate /readTag requests every poll tick, saturating the browser's
        // ~6-connection-per-origin limit and the gateway thread pool. Here we
        // group the requested paths by provider and issue ONE
        // provider.readAsync(list) per provider — N blocking reads become one
        // bulk read (per provider), on one HTTP request.
        // ------------------------------------------------------------------
        routes.newRoute(READ_TAGS_ROUTE)
            .type(RouteGroup.TYPE_JSON)
            .accessControl(Routes.requireSession(EnumSet.of(SessionScope.Client, SessionScope.Designer)))
            .handler((RequestContext requestContext, HttpServletResponse response) -> {
                try {
                    String tagPathsParam = requestContext.getParameter("tagPaths");
                    if (tagPathsParam == null || tagPathsParam.trim().isEmpty()) {
                        return errorResponse("No tag paths provided");
                    }

                    GatewayContext gatewayContext = requestContext.getGatewayContext();
                    GatewayTagManager tagManager = gatewayContext.getTagManager();

                    // Preserve the original request strings — they are the keys the client looks up by.
                    List<String> originals = new ArrayList<>();
                    List<ParsedPath> parsed = new ArrayList<>();
                    for (String piece : tagPathsParam.split(",")) {
                        String s = piece.trim();
                        if (s.isEmpty()) continue;
                        originals.add(s);
                        ParsedPath pp;
                        try {
                            pp = parseProviderAndPath(s);
                        } catch (Exception e) {
                            pp = null; // recorded as bad-quality below
                        }
                        parsed.add(pp);
                    }

                    JsonObject values = new JsonObject();

                    // Group indices by provider so we do one bulk readAsync per provider.
                    Map<String, List<Integer>> byProvider = new LinkedHashMap<>();
                    for (int i = 0; i < parsed.size(); i++) {
                        ParsedPath pp = parsed.get(i);
                        if (pp == null) {
                            values.add(originals.get(i), badEntry());
                            continue;
                        }
                        byProvider.computeIfAbsent(pp.provider, k -> new ArrayList<>()).add(i);
                    }

                    // Phase 1 — kick off one bulk read per provider. readAsync returns immediately,
                    // so all providers' reads run CONCURRENTLY rather than sequentially.
                    Map<String, Future<List<QualifiedValue>>> futures = new LinkedHashMap<>();
                    for (Map.Entry<String, List<Integer>> entry : byProvider.entrySet()) {
                        String providerName = entry.getKey();
                        List<Integer> indices = entry.getValue();
                        TagProvider provider = tagManager.getTagProvider(providerName);
                        if (provider == null) {
                            for (int idx : indices) values.add(originals.get(idx), badEntry());
                            continue;
                        }
                        List<TagPath> paths = new ArrayList<>(indices.size());
                        for (int idx : indices) paths.add(parsed.get(idx).path);
                        try {
                            futures.put(providerName, provider.readAsync(paths, SecurityContext.emptyContext()));
                        } catch (Exception e) {
                            log.warn("Batch read dispatch failed for provider '" + providerName + "': " + e.getMessage());
                            for (int idx : indices) values.add(originals.get(idx), badEntry());
                        }
                    }

                    // Phase 2 — collect results against ONE shared 30s deadline, so a request that
                    // spans several providers waits ~one timeout total, not 30s per provider.
                    long deadlineNanos = System.nanoTime() + TimeUnit.SECONDS.toNanos(30);
                    for (Map.Entry<String, Future<List<QualifiedValue>>> fe : futures.entrySet()) {
                        String providerName = fe.getKey();
                        List<Integer> indices = byProvider.get(providerName);
                        try {
                            long remaining = deadlineNanos - System.nanoTime();
                            if (remaining < 0) remaining = 0;
                            List<QualifiedValue> results = fe.getValue().get(remaining, TimeUnit.NANOSECONDS);
                            for (int k = 0; k < indices.size(); k++) {
                                int idx = indices.get(k);
                                QualifiedValue qv = (results != null && k < results.size()) ? results.get(k) : null;
                                values.add(originals.get(idx), toEntry(qv));
                            }
                        } catch (Exception e) {
                            log.warn("Batch read failed for provider '" + providerName + "': " + e.getMessage());
                            for (int idx : indices) values.add(originals.get(idx), badEntry());
                        }
                    }

                    JsonObject out = new JsonObject();
                    out.addProperty("success", true);
                    out.add("values", values);
                    return out;
                } catch (Exception e) {
                    log.error("Error batch-reading tags: " + e.getMessage(), e);
                    return errorResponse("Error batch-reading tags: " + e.getMessage());
                }
            })
            .mount();

        // ------------------------------------------------------------------
        // /writeTag — setpoint write (numeric only)
        //
        // GET with query params (Ignition data routes don't take POST bodies easily).
        // Value is parsed as Double; non-numeric input → 400-style error response.
        // Bad-quality writes (read-only tag, unknown path) are surfaced as
        // { success:false, error: "Write failed: <quality>" } so the modal can
        // show a meaningful message instead of silently succeeding.
        // ------------------------------------------------------------------
        routes.newRoute(WRITE_TAG_ROUTE)
            .type(RouteGroup.TYPE_JSON)
            .accessControl(Routes.requireSession(EnumSet.of(SessionScope.Client, SessionScope.Designer)))
            .handler((RequestContext requestContext, HttpServletResponse response) -> {
                try {
                    String tagPathStr = requestContext.getParameter("tagPath");
                    String valueStr = requestContext.getParameter("value");

                    if (tagPathStr == null || tagPathStr.trim().isEmpty()) {
                        return errorResponse("No tag path provided");
                    }
                    if (valueStr == null || valueStr.trim().isEmpty()) {
                        return errorResponse("No value provided");
                    }

                    tagPathStr = tagPathStr.trim();
                    valueStr = valueStr.trim();

                    double valueToWrite;
                    try {
                        valueToWrite = Double.parseDouble(valueStr);
                    } catch (NumberFormatException e) {
                        return errorResponse("Value must be a number: " + valueStr);
                    }

                    GatewayContext gatewayContext = requestContext.getGatewayContext();
                    GatewayTagManager tagManager = gatewayContext.getTagManager();

                    // Same path parsing as read route: parse full path, get provider, then path within provider
                    TagPath fullPath = TagPathParser.parse(tagPathStr);
                    String providerName = fullPath.getSource();
                    if (providerName == null || providerName.isEmpty()) {
                        providerName = "default";
                    }

                    String tagPathWithoutProvider;
                    if (tagPathStr.contains("]")) {
                        int bracketIndex = tagPathStr.indexOf(']');
                        tagPathWithoutProvider = tagPathStr.substring(bracketIndex + 1).trim();
                    } else {
                        tagPathWithoutProvider = fullPath.toStringPartial();
                    }
                    if (tagPathWithoutProvider == null || tagPathWithoutProvider.isEmpty()) {
                        return errorResponse("Tag path is empty after provider");
                    }

                    TagProvider provider = tagManager.getTagProvider(providerName);
                    if (provider == null) {
                        return errorResponse("Tag provider not found: " + providerName);
                    }

                    TagPath tPath = TagPathParser.parse(tagPathWithoutProvider);
                    QualifiedValue newQv = new BasicQualifiedValue(valueToWrite);

                    List<QualityCode> results = provider.writeAsync(
                        Arrays.asList(tPath),
                        Arrays.asList(newQv),
                        SecurityContext.emptyContext()
                    ).get(30, TimeUnit.SECONDS);

                    if (results == null || results.isEmpty()) {
                        return errorResponse("No result from tag write");
                    }

                    QualityCode qc = results.get(0);
                    if (qc.isNotGood()) {
                        String errMsg = "Write failed: " + qc.toString() + " (tag may be read-only or path invalid)";
                        log.warn("Write tag bad quality: path=" + tagPathStr + ", quality=" + qc);
                        return errorResponse(errMsg);
                    }

                    JsonObject jsonResponse = new JsonObject();
                    jsonResponse.addProperty("success", true);
                    return jsonResponse;
                } catch (Exception e) {
                    log.error("Error writing tag: " + e.getMessage(), e);
                    return errorResponse("Error writing tag: " + e.getMessage());
                }
            })
            .mount();

        // ------------------------------------------------------------------
        // /isHistorized — read the tag's .HistoryEnabled boolean property.
        //
        // Result drives whether SimpleTagDisplay's right-click menu shows the
        // "Trend Tag" / "Remove Tag" entries at all (we don't want those
        // entries on tags the historian wouldn't return data for).
        //
        // Failures are silently turned into { historized: false } — same UX:
        // the menu just doesn't show. We don't surface errors here because
        // the user didn't take an action that requires feedback.
        // ------------------------------------------------------------------
        routes.newRoute(IS_HISTORIZED_ROUTE)
            .type(RouteGroup.TYPE_JSON)
            .accessControl(Routes.requireSession(EnumSet.of(SessionScope.Client, SessionScope.Designer)))
            .handler((RequestContext requestContext, HttpServletResponse response) -> {
                try {
                    String tagPathStr = requestContext.getParameter("tagPath");
                    if (tagPathStr == null || tagPathStr.trim().isEmpty()) {
                        return errorResponse("No tag path provided");
                    }
                    String historyEnabledPath = tagPathStr.trim().endsWith(".HistoryEnabled")
                        ? tagPathStr.trim()
                        : tagPathStr.trim() + ".HistoryEnabled";
                    GatewayContext gatewayContext = requestContext.getGatewayContext();
                    GatewayTagManager tagManager = gatewayContext.getTagManager();
                    TagPath fullPath = TagPathParser.parse(historyEnabledPath);
                    String providerName = fullPath.getSource();
                    if (providerName == null || providerName.isEmpty()) {
                        providerName = "default";
                    }
                    String pathWithoutProvider;
                    if (historyEnabledPath.contains("]")) {
                        int bracketIndex = historyEnabledPath.indexOf(']');
                        pathWithoutProvider = historyEnabledPath.substring(bracketIndex + 1);
                    } else {
                        pathWithoutProvider = fullPath.toStringPartial();
                    }
                    TagProvider provider = tagManager.getTagProvider(providerName);
                    if (provider == null) {
                        JsonObject out = new JsonObject();
                        out.addProperty("historized", false);
                        return out;
                    }
                    TagPath tPath = TagPathParser.parse(pathWithoutProvider);
                    List<QualifiedValue> values = provider.readAsync(
                        Arrays.asList(tPath),
                        SecurityContext.emptyContext()
                    ).get(10, TimeUnit.SECONDS);
                    boolean historized = false;
                    if (values != null && !values.isEmpty()) {
                        QualifiedValue qv = values.get(0);
                        if (qv.getQuality().isGood() && qv.getValue() != null) {
                            String v = qv.getValue().toString().toLowerCase();
                            historized = "true".equals(v) || "1".equals(v);
                        }
                    }
                    JsonObject out = new JsonObject();
                    out.addProperty("historized", historized);
                    return out;
                } catch (Exception e) {
                    log.error("Error checking historized: " + e.getMessage(), e);
                    JsonObject out = new JsonObject();
                    out.addProperty("historized", false);
                    return out;
                }
            })
            .mount();
    }

    /** Build a uniform { success:false, error:<msg> } payload. JS callers check `success`. */
    private static JsonObject errorResponse(String message) {
        JsonObject response = new JsonObject();
        response.addProperty("success", false);
        response.addProperty("error", message);
        return response;
    }

    /* ====================================================================
     *  Helpers shared by the batch /readTags route
     * ==================================================================== */

    /** Holder for a tag path split into its provider name + the provider-relative TagPath. */
    private static final class ParsedPath {
        final String provider;
        final TagPath path;
        ParsedPath(String provider, TagPath path) { this.provider = provider; this.path = path; }
    }

    /**
     * Split a full tag path string into (providerName, provider-relative TagPath),
     * mirroring the logic used by /readTag: parse the full path for the provider,
     * then strip the "[provider]" prefix textually so a trailing ".Property" is preserved.
     */
    private static ParsedPath parseProviderAndPath(String tagPathStr) throws Exception {
        TagPath fullPath = TagPathParser.parse(tagPathStr);
        String providerName = fullPath.getSource();
        if (providerName == null || providerName.isEmpty()) {
            providerName = "default";
        }
        String withoutProvider;
        if (tagPathStr.contains("]")) {
            withoutProvider = tagPathStr.substring(tagPathStr.indexOf(']') + 1);
        } else {
            withoutProvider = fullPath.toStringPartial();
        }
        return new ParsedPath(providerName, TagPathParser.parse(withoutProvider));
    }

    /** JSON for one tag read result: { value, quality, isGood }. Matches /readTag: a
     *  good-quality null value is emitted as the string "null" (not omitted) so the two
     *  routes behave identically and the client never sees an undefined value. */
    private static JsonObject toEntry(QualifiedValue qv) {
        JsonObject e = new JsonObject();
        if (qv == null) {
            e.addProperty("isGood", false);
            return e;
        }
        e.addProperty("value", qv.getValue() != null ? qv.getValue().toString() : "null");
        e.addProperty("quality", qv.getQuality().toString());
        e.addProperty("isGood", qv.getQuality().isGood());
        return e;
    }

    /** JSON for a path we could not read (parse failure, missing provider, read exception). */
    private static JsonObject badEntry() {
        JsonObject e = new JsonObject();
        e.addProperty("isGood", false);
        return e;
    }
}

