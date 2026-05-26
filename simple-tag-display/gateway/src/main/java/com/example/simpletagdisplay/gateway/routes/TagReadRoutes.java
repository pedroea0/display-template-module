package com.example.simpletagdisplay.gateway.routes;

import java.util.Arrays;
import java.util.EnumSet;
import java.util.List;
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
}

