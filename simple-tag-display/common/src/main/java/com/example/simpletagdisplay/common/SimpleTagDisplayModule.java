package com.example.simpletagdisplay.common;

import java.util.Set;
import com.inductiveautomation.perspective.common.api.BrowserResource;

/**
 * Module-wide constants shared by gateway, designer, and component descriptors.
 *
 * Lives in the "common" scope so both `gateway/` and `designer/` modules can
 * reference these without duplication.
 *
 * Key constants:
 *   MODULE_ID          — must match the Module ID in build.gradle.kts and the
 *                        deploy script (DEFAULT_MODULE_ID in deploy_ignition_module.py).
 *   URL_ALIAS          — segment used in mounted resource URLs:
 *                          /res/simpletagdisplay/js/...
 *                          /data/simpletagdisplay/<route>
 *                        Both the JS frontend and the gateway hook use this prefix.
 *   BROWSER_RESOURCES  — JS files Perspective must inject into every session that
 *                        renders one of this module's components. We register
 *                        simpletagdisplay.js (which contains BOTH SimpleTagDisplay
 *                        and CtgChart). uPlot is loaded lazily by the JS itself
 *                        when the chart first mounts (see loadUPlot() there).
 */
public class SimpleTagDisplayModule {
    public static final String MODULE_ID = "com.example.simpletagdisplay.SimpleTagDisplay";

    /** URL prefix for mounted gateway resources (JS, CSS) and data routes. */
    public static final String URL_ALIAS = "simpletagdisplay";
    public static final String COMPONENT_CATEGORY = "Display";

    /**
     * Frontend JS that Perspective must inject when this module's components are on a view.
     * The gateway hook calls getMountedResourceFolder() → "mounted", so anything under
     * gateway/src/main/resources/mounted/ is served at /res/simpletagdisplay/<path>.
     */
    public static final Set<BrowserResource> BROWSER_RESOURCES =
        Set.of(
            new BrowserResource(
                "simple-tag-display-js",
                String.format("/res/%s/js/simpletagdisplay.js", URL_ALIAS),
                BrowserResource.ResourceType.JS
            )
        );
}
