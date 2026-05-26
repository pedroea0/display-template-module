package com.example.simpletagdisplay.gateway;

import java.util.Optional;
import com.inductiveautomation.ignition.common.licensing.LicenseState;
import com.inductiveautomation.ignition.common.util.LoggerEx;
import com.inductiveautomation.ignition.gateway.dataroutes.RouteGroup;
import com.inductiveautomation.ignition.gateway.model.AbstractGatewayModuleHook;
import com.inductiveautomation.ignition.gateway.model.GatewayContext;
import com.inductiveautomation.perspective.common.api.ComponentRegistry;
import com.inductiveautomation.perspective.gateway.api.PerspectiveContext;
import com.example.simpletagdisplay.common.SimpleTagDisplayModule;
import com.example.simpletagdisplay.common.SimpleTagDisplayComponent;
import com.example.simpletagdisplay.common.CtgChartComponent;
import com.example.simpletagdisplay.gateway.routes.TagReadRoutes;
import com.example.simpletagdisplay.gateway.routes.TrendRoutes;

/**
 * Gateway-scope entry point for the Tag Display module.
 *
 * Ignition calls these methods at module lifecycle events:
 *   setup(context)        — once after install. Cache the GatewayContext.
 *   startup(licenseState) — once on gateway startup or module install.
 *                           Register both Perspective components and mount routes.
 *   shutdown()            — on gateway shutdown or module uninstall. Unregister.
 *   mountRouteHandlers()  — declares the HTTP routes our JS calls.
 *   getMountedResourceFolder() / getMountPathAlias() — make
 *     gateway/src/main/resources/mounted/  visible at  /res/simpletagdisplay/.
 *
 * Two components are registered, both backed by simpletagdisplay.js:
 *   - SimpleTagDisplayComponent (one-tag value display)
 *   - CtgChartComponent         (session trend chart, uPlot)
 *
 * Two route groups are mounted (paths under /data/simpletagdisplay/):
 *   - TagReadRoutes   → /readTag, /writeTag, /isHistorized
 *   - TrendRoutes     → /trendList, /addToTrendList,
 *                       /removeFromTrendList, /tagHistory
 */
public class SimpleTagDisplayGatewayHook extends AbstractGatewayModuleHook {

    private static final LoggerEx log = LoggerEx.newBuilder().build("com.example.simpletagdisplay.gateway.SimpleTagDisplayGatewayHook");

    private GatewayContext gatewayContext;
    private PerspectiveContext perspectiveContext;
    private ComponentRegistry componentRegistry;

    /** Called once when the module is installed. Just cache context for startup(). */
    @Override
    public void setup(GatewayContext context) {
        this.gatewayContext = context;
        log.info("Setting up Tag Display module.");
    }

    /**
     * Called when the gateway starts (or this module is enabled). Pulls the
     * Perspective ComponentRegistry and registers our two component descriptors.
     * If the registry is missing the module is effectively dead — log loudly.
     */
    @Override
    public void startup(LicenseState activationState) {
        log.info("Starting up Tag Display module!");

        this.perspectiveContext = PerspectiveContext.get(this.gatewayContext);
        this.componentRegistry = this.perspectiveContext.getComponentRegistry();

        if (this.componentRegistry != null) {
            log.info("Registering Tag Display and CTG Chart components.");
            this.componentRegistry.registerComponent(SimpleTagDisplayComponent.DESCRIPTOR);
            this.componentRegistry.registerComponent(CtgChartComponent.DESCRIPTOR);
        } else {
            log.error("Reference to component registry not found, Tag Display module will fail to function!");
        }
    }

    /** Mirror of startup(): un-register the components so they vanish from existing sessions. */
    @Override
    public void shutdown() {
        log.info("Shutting down Tag Display module and removing registered components.");
        if (this.componentRegistry != null) {
            this.componentRegistry.removeComponent(SimpleTagDisplayComponent.COMPONENT_ID);
            this.componentRegistry.removeComponent(CtgChartComponent.COMPONENT_ID);
        } else {
            log.warn("Component registry was null, could not unregister Tag Display component.");
        }
    }

    /**
     * Mount the REST-ish data routes the JS calls. Both groups attach themselves
     * under the /data/simpletagdisplay/ prefix (or /main/data/simpletagdisplay/ in
     * the gateway's Designer-launched session view).
     */
    @Override
    public void mountRouteHandlers(RouteGroup routes) {
        TagReadRoutes.mountRoutes(routes);
        TrendRoutes.mountRoutes(routes);
    }

    /** Folder name (under gateway/src/main/resources/) whose contents are served as static files. */
    @Override
    public Optional<String> getMountedResourceFolder() {
        return Optional.of("mounted");
    }

    /** URL-alias prefix for the mounted folder above. Together they yield /res/simpletagdisplay/<file>. */
    @Override
    public Optional<String> getMountPathAlias() {
        return Optional.of(SimpleTagDisplayModule.URL_ALIAS);
    }

    /** No license check — this module is open. */
    @Override
    public boolean isFreeModule() {
        return true;
    }
}