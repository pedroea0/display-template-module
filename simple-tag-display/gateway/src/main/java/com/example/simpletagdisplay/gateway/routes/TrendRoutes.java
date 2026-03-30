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
 * Session trend list (GET/POST) and tag history (GET) routes.
 */
public class TrendRoutes {

    private static final String TREND_LIST_ROUTE = "/trendList";
    private static final String ADD_TO_TREND_LIST_ROUTE = "/addToTrendList";
    private static final String REMOVE_FROM_TREND_LIST_ROUTE = "/removeFromTrendList";
    private static final String TAG_HISTORY_ROUTE = "/tagHistory";

    public static void mountRoutes(RouteGroup routes) {
        // GET: return session trend list. GET-only so it works with Ignition data routes.
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

        // GET: add one tag to session trend list (data routes only accept GET).
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

        // GET: remove one tag from session trend list.
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

        // Tag history: query via TagHistoryManager when available; returns JSON for chart.
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
                return com.example.simpletagdisplay.gateway.historian.TagHistoryQuery.query(
                    requestContext.getGatewayContext(), tagPaths, rangeHours, pointCount);
            })
            .mount();
    }
}
