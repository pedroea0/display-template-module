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
 * Web routes for reading tag values.
 * This provides a REST endpoint that the JavaScript component can call to read tag values.
 */
public class TagReadRoutes {

    private static final LoggerEx log = LoggerEx.newBuilder().build("com.example.simpletagdisplay.gateway.routes.TagReadRoutes");
    private static final String READ_TAG_ROUTE = "/readTag";
    private static final String WRITE_TAG_ROUTE = "/writeTag";
    private static final String IS_HISTORIZED_ROUTE = "/isHistorized";

    public static void mountRoutes(RouteGroup routes) {
        // Create a GET endpoint that reads a tag value
        // Route will be accessible at /data/simpletagdisplay/readTag (or /main/data/simpletagdisplay/readTag)
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

        // Write tag value endpoint (for setpoint feature). Uses GET with query params so the route is invoked.
        // Path extraction matches the read route exactly; write follows IA docs (writeAsync with BasicQualifiedValue).
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

        // Check if a tag is historized by reading TagPath.HistoryEnabled
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

    private static JsonObject errorResponse(String message) {
        JsonObject response = new JsonObject();
        response.addProperty("success", false);
        response.addProperty("error", message);
        return response;
    }
}

