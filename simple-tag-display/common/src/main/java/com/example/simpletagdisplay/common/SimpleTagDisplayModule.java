package com.example.simpletagdisplay.common;

import java.io.IOException;
import java.io.InputStream;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Properties;
import java.util.Set;

import com.inductiveautomation.perspective.common.api.BrowserResource;

/**
 * Module-wide constants shared by the gateway, the Designer and both component descriptors.
 *
 * <h2>Versions</h2>
 * <ul>
 *   <li>{@link #MODULE_VERSION} — the module version from {@code build.gradle.kts} ("2.0.0").</li>
 *   <li>{@link #RESOURCE_VERSION} — "2.0.0-&lt;8 hex&gt;": the module version plus the first 8 hex digits of a
 *       SHA-256 over every file under {@code gateway/src/main/resources/mounted}. Appended as {@code ?v=} to every
 *       browser-resource URL, so a changed JS byte is a changed URL (without it, browsers and above all the
 *       Designer's embedded browser keep running stale JS after an upgrade).
 *       It is also the "build" the browser reports in {@code ctg.hello.clientBuild}; a mismatch tells the
 *       client it runs an older copy of the frontend than the gateway.</li>
 *   <li>{@link #PROTOCOL_VERSION} — version of the delegate protocol and the history route (2). A client that
 *       speaks another protocol is told to reload ({@code ctg.reload}).</li>
 * </ul>
 * All three come from {@code module-version.properties}, which the {@code generateVersionResource} Gradle task
 * writes into the common jar. A missing file is a broken build: class initialisation fails with a clear message
 * instead of silently using a "dev" cache buster that never changes.
 *
 * <h2>Browser resources</h2>
 * Five plain-ES5/ES6 files, all sharing the {@code window.__CTG} namespace. Perspective may inject
 * them in any order (not verified); each file queues its init until the parts it needs are ready, so the
 * order in {@link #BROWSER_RESOURCES} is a preference, not a requirement. uPlot and its CSS are not listed: the
 * chart loads them lazily (with the same {@code ?v=}).
 */
public final class SimpleTagDisplayModule {

    /** Module id. Must match build.gradle.kts and the deploy script. UNCHANGED since v1. */
    public static final String MODULE_ID = "com.example.simpletagdisplay.SimpleTagDisplay";

    /** URL segment of mounted resources ({@code /res/simpletagdisplay/...}) and data routes ({@code /data/simpletagdisplay/...}). */
    public static final String URL_ALIAS = "simpletagdisplay";

    /** Designer palette category of both components. */
    public static final String COMPONENT_CATEGORY = "Display";

    private static final Properties VERSION_PROPS = loadVersionProperties();

    /** Module version, e.g. "2.0.0". */
    public static final String MODULE_VERSION = required("version");

    /** Module version plus a content hash of the mounted resources, e.g. "2.0.0-1a2b3c4d". */
    public static final String RESOURCE_VERSION = required("resourceVersion");

    /** Delegate protocol / history route version. */
    public static final int PROTOCOL_VERSION = Integer.parseInt(required("protocol"));

    /**
     * Frontend files Perspective injects into every page that shows one of our components. Each URL carries
     * {@code ?v=RESOURCE_VERSION}; the mounted-resource servlet ignores the query string (verified in v1.1.5).
     * A {@link LinkedHashSet} keeps the preferred order (common first) in case Perspective honours it.
     */
    public static final Set<BrowserResource> BROWSER_RESOURCES = Collections.unmodifiableSet(new LinkedHashSet<>(List.of(
        js("ctg-common", "js/ctg-common.js"),
        js("ctg-display", "js/display-template.js"),
        js("ctg-chart", "js/ctg-chart.js"),
        js("ctg-chart-tools", "js/ctg-chart-tools.js"),
        js("ctg-chart-panels", "js/ctg-chart-panels.js")
    )));

    private SimpleTagDisplayModule() {
    }

    /** URL of a mounted resource with the cache buster, e.g. {@code /res/simpletagdisplay/js/ctg-common.js?v=2.0.0-1a2b3c4d}. */
    public static String resourceUrl(String relativePath) {
        return String.format("/res/%s/%s?v=%s", URL_ALIAS, relativePath, RESOURCE_VERSION);
    }

    private static BrowserResource js(String name, String relativePath) {
        return new BrowserResource(name, resourceUrl(relativePath), BrowserResource.ResourceType.JS);
    }

    private static Properties loadVersionProperties() {
        Properties props = new Properties();
        try (InputStream in = SimpleTagDisplayModule.class.getResourceAsStream("module-version.properties")) {
            if (in == null) {
                throw new IllegalStateException("missing resource com/example/simpletagdisplay/common/module-version.properties "
                    + "(written by the generateVersionResource Gradle task; build the module with Gradle)");
            }
            props.load(in);
        } catch (IOException e) {
            throw new IllegalStateException("cannot read module-version.properties", e);
        }
        return props;
    }

    private static String required(String key) {
        String v = VERSION_PROPS.getProperty(key);
        if (v == null || v.trim().isEmpty()) {
            throw new IllegalStateException("module-version.properties has no '" + key + "'");
        }
        return v.trim();
    }
}
