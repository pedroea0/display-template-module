package com.example.simpletagdisplay.common;

import java.io.IOException;
import java.io.InputStream;
import java.util.Properties;
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
     * Module version, written into the common jar at build time by the
     * generateVersionResource task in common/build.gradle.kts.
     *
     * Used only as a cache-buster on the browser resource URL below. Falls back to "dev"
     * if the properties file is missing (e.g. running from an IDE without the Gradle task),
     * which is harmless — it just means the URL stops changing between builds.
     *
     * NOTE: must be declared ABOVE BROWSER_RESOURCES. Static initializers run in textual
     * order, so declaring it after would leave RESOURCE_VERSION null inside the URL.
     */
    private static final String RESOURCE_VERSION = loadResourceVersion();

    private static String loadResourceVersion() {
        try (InputStream in = SimpleTagDisplayModule.class
                .getResourceAsStream("module-version.properties")) {
            if (in != null) {
                Properties props = new Properties();
                props.load(in);
                String version = props.getProperty("version");
                if (version != null && !version.trim().isEmpty()) {
                    return version.trim();
                }
            }
        } catch (IOException ignored) {
            // fall through to the default below
        }
        return "dev";
    }

    /**
     * Frontend JS that Perspective must inject when this module's components are on a view.
     * The gateway hook calls getMountedResourceFolder() → "mounted", so anything under
     * gateway/src/main/resources/mounted/ is served at /res/simpletagdisplay/<path>.
     *
     * The "?v=<module version>" suffix is a cache-buster, NOT a route parameter — the
     * mounted-resource servlet matches on path alone and ignores the query string
     * (verified: the URL returns an identical 200 with and without it).
     *
     * It is there because /res/** is served with no Cache-Control, ETag or Last-Modified
     * header, so browsers cache it heuristically and may never ask the gateway again. A
     * Perspective session can be hard-refreshed out of that; the Designer's embedded
     * browser cannot, so before this it would keep rendering whichever build of the JS it
     * first cached while the client showed the new one. Bumping the module version now
     * changes the URL, which no cache can serve from a previous build.
     */
    public static final Set<BrowserResource> BROWSER_RESOURCES =
        Set.of(
            new BrowserResource(
                "simple-tag-display-js",
                String.format("/res/%s/js/simpletagdisplay.js?v=%s", URL_ALIAS, RESOURCE_VERSION),
                BrowserResource.ResourceType.JS
            )
        );
}
