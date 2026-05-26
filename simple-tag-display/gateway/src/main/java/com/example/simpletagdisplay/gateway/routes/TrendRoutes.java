package com.example.simpletagdisplay.gateway.routes;

import java.util.ArrayList;
import java.util.List;

import com.inductiveautomation.ignition.common.gson.JsonArray;
import com.inductiveautomation.ignition.common.gson.JsonObject;
import com.inductiveautomation.ignition.gateway.dataroutes.RequestContext;
import com.inductiveautomation.ignition.gateway.dataroutes.RouteGroup;
import com.inductiveautomation.perspective.gateway.api.SessionScope;
import com.inductiveautomation.perspective.gateway.comm.Routes;

import com.example.simpletagdisplay.gateway.session.TrendListStore;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.EnumSet;

/**
 * REST routes for the CTG chart's session trend list + historian queries.
 *
 * All routes:
 *   - Are GET-only (Ignition's data routes don't accept POST/PUT for these).
 *   - Require an authenticated Perspective Client or Designer session
 *     (so the JS gets a session cookie via fetch with credentials:'same-origin').
 *   - Return JSON: { success: bool, error?: string, ... payload ... }.
 *
 * URL prefix is the module's URL_ALIAS:  /data/simpletagdisplay/<route>
 *                              or         /main/data/simpletagdisplay/<route>
 *
 * Routes:
 *   /trendList               (GET)   → { tagPaths: ["[default]A", "[default]B"] }
 *   /addToTrendList          (?tagPath=...) → { success: true }
 *   /removeFromTrendList     (?tagPath=...) → { success: true }
 *   /tagHistory              (?tagPaths=csv&rangeHours=N|startTimeMs+endTimeMs
 *                              &pointCount=N&rawHistory=0|1)
 *                            → { success, series:[{ tagPath, points:[{t,v}, ...] }] }
 *
 * Sessions:
 *   The trend list is keyed by HTTP session ID (request.getSession()) — see
 *   TrendListStore. One browser tab = one trend list.
 */
public class TrendRoutes {

    private static final String TREND_LIST_ROUTE = "/trendList";
    private static final String ADD_TO_TREND_LIST_ROUTE = "/addToTrendList";
    private static final String REMOVE_FROM_TREND_LIST_ROUTE = "/removeFromTrendList";
    private static final String TAG_HISTORY_ROUTE = "/tagHistory";

    public static void mountRoutes(RouteGroup routes) {
        // ------------------------------------------------------------------
        // /trendList  →  current session's tag list as { tagPaths: [...] }
        // ------------------------------------------------------------------
        routes.newRoute(TREND_LIST_ROUTE)
            .type(RouteGroup.TYPE_JSON)
            .accessControl(Routes.requireSession(EnumSet.of(SessionScope.Client, SessionScope.Designer)))
            .handler((RequestContext requestContext, HttpServletResponse response) -> {
                HttpServletRequest request = requestContext.getRequest();
                String sessionId = request.getSession(false) != null ? request.getSession().getId() : null;
                List<String> list = TrendListStore.getInstance().getList(sessionId);
                JsonArray arr = new JsonArray();
                for (String path : list) {
                    arr.add(path);
                }
                JsonObject out = new JsonObject();
                out.add("tagPaths", arr);
                return out;
            })
            .mount();

        // ------------------------------------------------------------------
        // /addToTrendList?tagPath=...  →  { success } (idempotent — no dup adds)
        // ------------------------------------------------------------------
        routes.newRoute(ADD_TO_TREND_LIST_ROUTE)
            .type(RouteGroup.TYPE_JSON)
            .accessControl(Routes.requireSession(EnumSet.of(SessionScope.Client, SessionScope.Designer)))
            .handler((RequestContext requestContext, HttpServletResponse response) -> {
                String tagPath = requestContext.getParameter("tagPath");
                if (tagPath == null || tagPath.trim().isEmpty()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", "tagPath required");
                    return err;
                }
                HttpServletRequest request = requestContext.getRequest();
                String sessionId = request.getSession(false) != null ? request.getSession().getId() : null;
                TrendListStore.getInstance().add(sessionId, tagPath.trim());
                JsonObject out = new JsonObject();
                out.addProperty("success", true);
                return out;
            })
            .mount();

        // ------------------------------------------------------------------
        // /removeFromTrendList?tagPath=...  →  { success }
        // ------------------------------------------------------------------
        routes.newRoute(REMOVE_FROM_TREND_LIST_ROUTE)
            .type(RouteGroup.TYPE_JSON)
            .accessControl(Routes.requireSession(EnumSet.of(SessionScope.Client, SessionScope.Designer)))
            .handler((RequestContext requestContext, HttpServletResponse response) -> {
                String tagPath = requestContext.getParameter("tagPath");
                if (tagPath == null || tagPath.trim().isEmpty()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", "tagPath required");
                    return err;
                }
                HttpServletRequest request = requestContext.getRequest();
                String sessionId = request.getSession(false) != null ? request.getSession().getId() : null;
                TrendListStore.getInstance().remove(sessionId, tagPath.trim());
                JsonObject out = new JsonObject();
                out.addProperty("success", true);
                return out;
            })
            .mount();

        // ------------------------------------------------------------------
        // /tagHistory  → bucket-aggregated (or raw) historian data for chart
        //
        // Params:
        //   tagPaths      (req)  — comma-separated tag paths
        //   pointCount    (opt)  — bucket count, default 300
        //   rangeHours    (opt)  — sliding window from now, default 24
        //   startTimeMs   (opt)  — absolute window start (overrides rangeHours)
        //   endTimeMs     (opt)  — absolute window end   (overrides rangeHours)
        //   rawHistory    (opt)  — "1" / "true" / "yes" → no aggregation
        // ------------------------------------------------------------------
        routes.newRoute(TAG_HISTORY_ROUTE)
            .type(RouteGroup.TYPE_JSON)
            .accessControl(Routes.requireSession(EnumSet.of(SessionScope.Client, SessionScope.Designer)))
            .handler((RequestContext requestContext, HttpServletResponse response) -> {
                String tagPathsParam = requestContext.getParameter("tagPaths");
                if (tagPathsParam == null || tagPathsParam.trim().isEmpty()) {
                    JsonObject err = new JsonObject();
                    err.addProperty("success", false);
                    err.addProperty("error", "tagPaths required");
                    return err;
                }
                List<String> tagPaths = new ArrayList<>();
                for (String p : tagPathsParam.split(",")) {
                    String t = p.trim();
                    if (!t.isEmpty()) tagPaths.add(t);
                }
                double rangeHours = 24;
                String rh = requestContext.getParameter("rangeHours");
                if (rh != null && !rh.isEmpty()) {
                    try {
                        rangeHours = Double.parseDouble(rh);
                    } catch (NumberFormatException e) { /* use default */ }
                }
                int pointCount = 300;
                String pc = requestContext.getParameter("pointCount");
                if (pc != null && !pc.isEmpty()) {
                    try {
                        pointCount = Integer.parseInt(pc);
                    } catch (NumberFormatException e) { /* use default */ }
                }
                long startTimeMs = 0;
                long endTimeMs   = 0;
                String stParam = requestContext.getParameter("startTimeMs");
                String etParam = requestContext.getParameter("endTimeMs");
                if (stParam != null && !stParam.isEmpty() && etParam != null && !etParam.isEmpty()) {
                    try {
                        startTimeMs = Long.parseLong(stParam);
                        endTimeMs   = Long.parseLong(etParam);
                    } catch (NumberFormatException e) { /* fall back to rangeHours */ }
                }
                boolean rawHistory = false;
                String rawParam = requestContext.getParameter("rawHistory");
                if (rawParam != null && !rawParam.isEmpty()) {
                    rawHistory = rawParam.equalsIgnoreCase("true")
                            || rawParam.equals("1")
                            || rawParam.equalsIgnoreCase("yes");
                }
                return com.example.simpletagdisplay.gateway.historian.TagHistoryQuery.query(
                    requestContext.getGatewayContext(), tagPaths, rangeHours, pointCount,
                    startTimeMs, endTimeMs, rawHistory);
            })
            .mount();
    }
}
