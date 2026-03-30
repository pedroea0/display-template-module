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
 * Gateway-scope module hook for Tag Display module.
 * This module provides a component for displaying tag names and values.
 */
public class SimpleTagDisplayGatewayHook extends AbstractGatewayModuleHook {
    
    private static final LoggerEx log = LoggerEx.newBuilder().build("com.example.simpletagdisplay.gateway.SimpleTagDisplayGatewayHook");
    
    private GatewayContext gatewayContext;
    private PerspectiveContext perspectiveContext;
    private ComponentRegistry componentRegistry;
    
    @Override
    public void setup(GatewayContext context) {
        this.gatewayContext = context;
        log.info("Setting up Tag Display module.");
    }

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

    @Override
    public void mountRouteHandlers(RouteGroup routes) {
        TagReadRoutes.mountRoutes(routes);
        TrendRoutes.mountRoutes(routes);
    }

    @Override
    public Optional<String> getMountedResourceFolder() {
        return Optional.of("mounted");
    }

    @Override
    public Optional<String> getMountPathAlias() {
        return Optional.of(SimpleTagDisplayModule.URL_ALIAS);
    }

    @Override
    public boolean isFreeModule() {
        return true; // This is a free module
    }
}