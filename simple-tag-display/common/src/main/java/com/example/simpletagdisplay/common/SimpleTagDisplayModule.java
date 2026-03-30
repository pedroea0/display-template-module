package com.example.simpletagdisplay.common;

import java.util.Set;
import com.inductiveautomation.perspective.common.api.BrowserResource;

/**
 * This class acts as a central location to hold module and component metadata.
 */
public class SimpleTagDisplayModule {
    public static final String MODULE_ID = "com.example.simpletagdisplay.SimpleTagDisplay";
    
    // URL alias for mounted resources
    public static final String URL_ALIAS = "simpletagdisplay";
    public static final String COMPONENT_CATEGORY = "Display";
    
    /**
     * The client-side (browser) dependencies that are required for our components to function in the browser.
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
