package com.example.simpletagdisplay.gateway;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Optional;
import java.util.Set;

import com.example.simpletagdisplay.common.CtgChartComponent;
import com.example.simpletagdisplay.common.DisplayTemplateComponent;
import com.example.simpletagdisplay.common.SimpleTagDisplayModule;
import com.example.simpletagdisplay.gateway.delegate.CtgChartDelegate;
import com.example.simpletagdisplay.gateway.delegate.DisplayTemplateDelegate;
import com.example.simpletagdisplay.gateway.history.HistoryRoute;
import com.inductiveautomation.ignition.common.licensing.LicenseState;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.gateway.dataroutes.RouteGroup;
import com.inductiveautomation.ignition.gateway.model.AbstractGatewayModuleHook;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import com.inductiveautomation.perspective.common.api.ComponentRegistry;
import com.inductiveautomation.perspective.gateway.api.ComponentModelDelegateRegistry;
import com.inductiveautomation.perspective.gateway.api.PerspectiveContext;
import jakarta.servlet.http.HttpServletResponse;

/**
 * Gateway-scope entry point.
 *
 * <h2>Startup</h2>
 * <ol>
 *   <li>Reads the module settings ({@code ctg.*} system properties) and creates the {@link GatewayServices}
 *       (settings, floor policy, live sessions, tokens, trend lists, history service, scheduler) and starts their
 *       background work (session-end subscriber on Perspective's event bus, settings poll, sweeps).</li>
 *   <li>Registers both component descriptors with Perspective.</li>
 *   <li>Registers one {@code ComponentModelDelegate} factory per component: every Display Template / chart
 *       instance on every page (Client and Designer sessions) gets its own gateway delegate. All session-bound work
 *       — live values, writes, trend list, tokens — runs there with the session user's security context.</li>
 *   <li>Logs the documented startup line {@code Display Template / CTG <resourceVersion> started (protocol 2)}
 *       and, on a separate line, the build id.</li>
 * </ol>
 *
 * <h2>Shutdown</h2>
 * Undoes startup in reverse order, each step in its own try/catch: delegate factories and components removed (no
 * new delegates), then {@link GatewayServices#close()} force-stops every live delegate on its session queue
 * (unsubscribes tags, unregisters listeners, revokes tokens), stops the executors and clears every store. A module
 * restart without a gateway restart therefore leaves nothing behind.
 *
 * <h2>Routes</h2>
 * v2 removes every v1 REST route (among them the unauthenticated, CSRF-able GET {@code /writeTag}). The
 * only route is the hardened {@code POST /data/simpletagdisplay/v2/history} ({@link HistoryRoute}); it may be
 * mounted before startup, so it looks the services up per request.
 *
 * <h2>Static resources</h2>
 * {@code gateway/src/main/resources/mounted/} is served at {@code /res/simpletagdisplay/...}. Only the seven
 * versioned files (five module scripts + uPlot JS/CSS — every reference to them carries {@code ?v=<content hash>})
 * are cached {@code immutable} for a year, and only when the request's {@code v} equals the running
 * {@code RESOURCE_VERSION} (a request without {@code ?v=}, or with an old one, must not pin a copy for a year);
 * everything else (e.g. {@code build-id.txt}) is {@code no-cache}.
 */
public class SimpleTagDisplayGatewayHook extends AbstractGatewayModuleHook {

    private static final LoggerEx log = LoggerEx.newBuilder().build("SimpleTagDisplay.Gateway");

    /** Mounted files whose every reference carries {@code ?v=RESOURCE_VERSION}. */
    static final Set<String> IMMUTABLE_RESOURCES = Set.of(
        "js/ctg-common.js", "js/display-template.js", "js/ctg-chart.js", "js/ctg-chart-tools.js",
        "js/ctg-chart-panels.js", "js/uplot.min.js", "css/uplot.min.css");

    private GatewayContext gatewayContext;
    private PerspectiveContext perspectiveContext;
    private GatewayServices services;

    @Override
    public void setup(GatewayContext context) {
        this.gatewayContext = context;
    }

    @Override
    public void startup(LicenseState activationState) {
        try {
            PerspectiveContext pctx = PerspectiveContext.get(gatewayContext);
            if (pctx == null) {
                throw new IllegalStateException("Perspective module not available; Display Template / CTG disabled");
            }
            perspectiveContext = pctx;
            services = new GatewayServices(gatewayContext, pctx, ModuleSettings.fromSystemProperties());
            services.start();
            GatewayServices.install(services);

            ComponentRegistry registry = pctx.getComponentRegistry();
            registry.registerComponent(DisplayTemplateComponent.DESCRIPTOR);
            registry.registerComponent(CtgChartComponent.DESCRIPTOR);

            GatewayServices s = services;
            ComponentModelDelegateRegistry delegates = pctx.getComponentModelDelegateRegistry();
            delegates.register(DisplayTemplateComponent.COMPONENT_ID, c -> new DisplayTemplateDelegate(c, s));
            delegates.register(CtgChartComponent.COMPONENT_ID, c -> new CtgChartDelegate(c, s));

            // Documented startup line (user and developer guides): keep exactly this text; the build id gets its
            // own line.
            log.infof("Display Template / CTG %s started (protocol %d)",
                SimpleTagDisplayModule.RESOURCE_VERSION, SimpleTagDisplayModule.PROTOCOL_VERSION);
            log.infof("Display Template / CTG build id %s", buildId());
        } catch (Throwable t) {
            log.error("Display Template / CTG startup failed", t);
            safeTeardown();
            // Rethrown so the gateway marks the module Faulted. Swallowed, the module would stay ACTIVE with no
            // component registered and a deploy check would report the build RUNNING.
            if (t instanceof Error) {
                throw (Error) t;
            }
            throw t instanceof RuntimeException ? (RuntimeException) t : new IllegalStateException(t);
        }
    }

    /**
     * Build id generated by gateway/build.gradle.kts (SHA-256 over every entry of the common, designer and gateway
     * jars; also served at /res/simpletagdisplay/build-id.txt). Logged so the gateway log names the exact build.
     */
    private static String buildId() {
        try (InputStream in = SimpleTagDisplayGatewayHook.class.getResourceAsStream("/mounted/build-id.txt")) {
            if (in == null) {
                return "unknown";
            }
            String id = new String(in.readNBytes(128), StandardCharsets.US_ASCII).trim();
            return id.isEmpty() ? "unknown" : id;
        } catch (Exception e) {
            return "unknown";
        }
    }

    @Override
    public void shutdown() {
        safeTeardown();
        log.info("Display Template / CTG stopped");
    }

    /** Undo startup in reverse order; each step is independent so one failure never skips the rest. */
    private void safeTeardown() {
        PerspectiveContext pctx = perspectiveContext;
        if (pctx != null) {
            try {
                ComponentModelDelegateRegistry delegates = pctx.getComponentModelDelegateRegistry();
                delegates.remove(DisplayTemplateComponent.COMPONENT_ID);
                delegates.remove(CtgChartComponent.COMPONENT_ID);
            } catch (Throwable t) {
                log.warn("Could not unregister component delegates", t);
            }
            try {
                ComponentRegistry registry = pctx.getComponentRegistry();
                registry.removeComponent(DisplayTemplateComponent.COMPONENT_ID);
                registry.removeComponent(CtgChartComponent.COMPONENT_ID);
            } catch (Throwable t) {
                log.warn("Could not unregister components", t);
            }
        }
        GatewayServices s = services;
        GatewayServices.install(null);
        services = null;
        if (s != null) {
            try {
                s.close();
            } catch (Throwable t) {
                log.warn("Could not close module services", t);
            }
        }
        perspectiveContext = null;
    }

    /** {@code POST /data/simpletagdisplay/v2/history}; resolves the services per request (may run before startup). */
    @Override
    public void mountRouteHandlers(RouteGroup routes) {
        HistoryRoute.mount(routes);
    }

    @Override
    public Optional<String> getMountedResourceFolder() {
        return Optional.of("mounted");
    }

    @Override
    public Optional<String> getMountPathAlias() {
        return Optional.of(SimpleTagDisplayModule.URL_ALIAS);
    }

    /**
     * Cache headers of mounted resources. {@code resourcePath} may arrive with or
     * without a leading slash or the mount folder; it is normalised before the allow-list lookup.
     */
    @Override
    public void onMountedResourceRequest(String resourcePath, HttpServletResponse response) {
        try {
            String p = normalizeResourcePath(resourcePath);
            // Ignition passes the servlet path info (no query string), so the version comes from the request.
            String v = queryParam(resourcePath, "v");
            if (v == null && IMMUTABLE_RESOURCES.contains(p)) {
                v = requestVersion(response);
            }
            response.setHeader("Cache-Control", cacheControl(p, v, SimpleTagDisplayModule.RESOURCE_VERSION));
            response.setHeader("X-Content-Type-Options", "nosniff");
        } catch (RuntimeException e) {
            log.debug("Could not set cache headers for a mounted resource", e);
        }
    }

    /**
     * {@code Cache-Control} for a normalised mounted path requested with version {@code v}: {@code immutable} for a
     * year only for an allow-listed file requested with the current version, else {@code no-cache}.
     */
    static String cacheControl(String path, String v, String currentVersion) {
        if (IMMUTABLE_RESOURCES.contains(path) && v != null && v.equals(currentVersion)) {
            return "public, max-age=31536000, immutable";
        }
        return "no-cache";
    }

    /** Value of query parameter {@code name} after the {@code ?} of {@code pathOrQuery} ({@code "a/b.js?v=1&x=2"}, {@code "?v=1"}). */
    static String queryParam(String pathOrQuery, String name) {
        if (pathOrQuery == null) {
            return null;
        }
        int q = pathOrQuery.indexOf('?');
        if (q < 0) {
            return null;
        }
        String query = pathOrQuery.substring(q + 1);
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0 && pair.substring(0, eq).equals(name)) {
                return java.net.URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
            }
        }
        return null;
    }

    private static final java.util.concurrent.atomic.AtomicBoolean VERSION_LOOKUP_WARNED =
        new java.util.concurrent.atomic.AtomicBoolean(false);

    /**
     * The {@code v} query parameter of the request behind {@code response}. The hook only receives the response;
     * Jetty 12 (ee10) reaches the request through {@code ServletApiResponse.getServletChannel()
     * .getServletContextRequest().getServletApiRequest()}. Looked up reflectively (Jetty is not on the module's
     * compile classpath); on any failure this returns null and the resource is served {@code no-cache} — stricter,
     * never stale (logged once at INFO).
     */
    static String requestVersion(HttpServletResponse response) {
        try {
            Object r = response;
            while (r instanceof jakarta.servlet.ServletResponseWrapper) {
                r = ((jakarta.servlet.ServletResponseWrapper) r).getResponse();
            }
            Object channel = r.getClass().getMethod("getServletChannel").invoke(r);
            Object ctxRequest = channel.getClass().getMethod("getServletContextRequest").invoke(channel);
            Object apiRequest = ctxRequest.getClass().getMethod("getServletApiRequest").invoke(ctxRequest);
            if (apiRequest instanceof jakarta.servlet.http.HttpServletRequest) {
                return queryParam("?" + nullToEmpty(((jakarta.servlet.http.HttpServletRequest) apiRequest).getQueryString()), "v");
            }
            throw new IllegalStateException("unexpected request type " + apiRequest);
        } catch (ReflectiveOperationException | RuntimeException | LinkageError e) {
            if (VERSION_LOOKUP_WARNED.compareAndSet(false, true)) {
                log.infof("Mounted resources: cannot read the request's ?v= (%s); serving them no-cache", e.toString());
            }
            return null;
        }
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }

    /** {@code "/mounted/js/ctg-common.js?v=…"} → {@code "js/ctg-common.js"}. */
    static String normalizeResourcePath(String resourcePath) {
        String p = resourcePath == null ? "" : resourcePath;
        int q = p.indexOf('?');
        if (q >= 0) {
            p = p.substring(0, q);
        }
        p = p.replace('\\', '/');
        while (p.startsWith("/")) {
            p = p.substring(1);
        }
        if (p.startsWith("mounted/")) {
            p = p.substring("mounted/".length());
        }
        if (p.startsWith(SimpleTagDisplayModule.URL_ALIAS + "/")) {
            p = p.substring(SimpleTagDisplayModule.URL_ALIAS.length() + 1);
        }
        return p;
    }

    @Override
    public boolean isFreeModule() {
        return true;
    }
}
