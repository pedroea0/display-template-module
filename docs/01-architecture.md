# 01 — Architecture

This document explains how the module is shaped before you dive into any individual file. If you've never poked inside an Ignition module before, this is the place to start.

## What an Ignition module is, briefly

A `.modl` file is just a renamed `.zip`. Inside are JAR files, resources, and a manifest that tells the gateway which classes to load. Ignition runs three different "scopes" at three different places, and a module can ship code for any combination of them:

| Scope | Runs where | What it has access to |
|---|---|---|
| **Gateway** | On the Ignition gateway server (the JVM that serves Perspective) | Tags, historian, REST routes, persistent state, the network |
| **Designer** | Inside the Designer desktop app | The component palette, the project resource browser, the Designer UI |
| **Client** (Perspective) | The user's browser, served as JS by the gateway | The DOM, the user, the data the gateway sends down |

For Perspective components you usually need all three:
- **Gateway** code registers the component and serves the JS bundle to browsers.
- **Designer** code registers the component too, so it shows up in the palette and you can drop it on a view at design time.
- **Client** code (JS) is what actually renders in the browser.

There's also a **Common** scope — shared code that gateway and designer can both depend on. We use it for the component descriptors and prop schemas, so we don't have to keep them in two places.

## How that maps to this repo

```
simple-tag-display/
├── common/    src/main/java/.../common/
│              ├── SimpleTagDisplayModule.java       module-wide constants
│              ├── SimpleTagDisplayComponent.java    Java descriptor for tag display
│              └── CtgChartComponent.java            Java descriptor for chart
│              src/main/resources/
│              ├── simpletagdisplay.props.json       prop schema (display)
│              ├── ctgchart.props.json               prop schema (chart)
│              └── icon.svg                          legacy asset (palette icons are now drawn in Java2D, see designer hook)
│
├── gateway/   src/main/java/.../gateway/
│              ├── SimpleTagDisplayGatewayHook.java  lifecycle + route mounting
│              ├── routes/TagReadRoutes.java         /readTag, /readTags, /writeTag, /isHistorized
│              ├── routes/TrendRoutes.java           /trendList + add/remove + /tagHistory
│              ├── historian/TagHistoryQuery.java    wraps Ignition's TagHistoryManager
│              └── session/TrendListStore.java       per-HTTP-session trend list (singleton)
│              src/main/resources/mounted/           served at /res/simpletagdisplay/<path>
│              ├── js/simpletagdisplay.js            ← all frontend logic, both components
│              ├── js/uplot.min.js                   bundled chart library (air-gap safe)
│              └── css/uplot.min.css
│
└── designer/  src/main/java/.../designer/
               └── SimpleTagDisplayDesignerHook.java  designer-scope registration + Java2D palette icons
```

The Gradle build (`build.gradle.kts` at the module root) wires this together via the `io.ia.sdk.modl` plugin from Inductive Automation. We tell it which sub-projects belong to which scope:

```kotlin
projectScopes.putAll(mapOf(
    ":common" to "GD",
    ":designer" to "D",
    ":gateway" to "G"
))
```

The plugin then packages the three JARs (`common-1.0.0.jar`, `gateway-1.0.0.jar`, `designer-1.0.0.jar`) into a `.modl` file with the right manifest entries pointing at the hook classes.

## Lifecycle: what happens when the module loads

1. **Gateway boots** (or you install the module). Ignition reads the `.modl` manifest, sees the gateway hook class is `com.example.simpletagdisplay.gateway.SimpleTagDisplayGatewayHook`, and instantiates it.
2. `setup(context)` is called once. The hook caches the `GatewayContext` for later use.
3. `startup(licenseState)` is called. The hook:
   - Looks up Perspective's `ComponentRegistry`.
   - Registers `SimpleTagDisplayComponent.DESCRIPTOR` and `CtgChartComponent.DESCRIPTOR`.
4. `mountRouteHandlers(routes)` is called. The hook delegates to `TagReadRoutes.mountRoutes()` and `TrendRoutes.mountRoutes()`, which register the HTTP endpoints under `/data/simpletagdisplay/...`.
5. The hook also tells Ignition (`getMountedResourceFolder()`, `getMountPathAlias()`) that the contents of `gateway/src/main/resources/mounted/` should be served as static files under `/res/simpletagdisplay/<path>`.

For the **Designer**, the same dance happens with `SimpleTagDisplayDesignerHook`. It re-registers the components with the designer-side `DesignerComponentRegistry`, this time attaching a palette/tree icon via `ComponentBuilder.setIcon(...)`. The icons are `javax.swing.Icon` instances drawn directly in Java2D (no SVG parsing or resource loading), so they always render — see [03-backend-java.md](03-backend-java.md) for why an icon URL doesn't work in this SDK.

## What "registering a component" actually does

Perspective components have **two halves**:

1. **The Java descriptor.** A `ComponentDescriptor` object with an ID, a name, a palette category, a JSON schema describing every prop the component accepts, and a list of browser resources (JS/CSS) that need to be sent to a session whenever this component appears on a view. See [SimpleTagDisplayComponent.java](../simple-tag-display/common/src/main/java/com/example/simpletagdisplay/common/SimpleTagDisplayComponent.java).
2. **The JS class.** A class with `getComponentType()` matching the descriptor's ID, plus the actual render logic. Registered in the browser via `window.PerspectiveClient.ComponentRegistry.register(...)`. See [simpletagdisplay.js:983](../simple-tag-display/gateway/src/main/resources/mounted/js/simpletagdisplay.js#L983).

The two halves are linked **by string ID**. If the IDs don't match, Perspective silently won't know what to render and the component slot stays blank.

For us:
- `com.example.simpletagdisplay.SimpleTagDisplay` ↔ `class SimpleTagDisplayMeta`
- `com.example.simpletagdisplay.CtgChart` ↔ `class CtgChartMeta`

The browser resources tell Perspective: "any session that has this component on a view, please send the browser this JS file." Both components share the same JS bundle (`simpletagdisplay.js`), so the `BROWSER_RESOURCES` constant in [SimpleTagDisplayModule.java](../simple-tag-display/common/src/main/java/com/example/simpletagdisplay/common/SimpleTagDisplayModule.java) declares it once and both component descriptors reference it.

## End-to-end data flow: "user right-clicks → tag appears on chart"

This is the core feature. Walk through it to understand how all the pieces interact.

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  Browser                                                                        │
│                                                                                 │
│   SimpleTagDisplay     ──right-click──►   onValueContextMenu()                 │
│   (a Perspective                              │                                │
│    view in a session)                         ├── fetch /isHistorized?         │
│                                               └── fetch /trendList             │
│                                                                                 │
│                                          (decides menu shows "Trend Tag")      │
│                                                                                 │
│                          ──click "Trend Tag"──►  onTrendTagClick()             │
│                                                       │                        │
│                                                       └── fetch /addToTrendList│
│                                                       └── window.dispatchEvent │
│                                                            'ctg-trend-list-    │
│                                                             changed'           │
│                                                                                 │
│   CtgChart                                                                     │
│   (any other place                                                             │
│    on the same page)  ──listener for 'ctg-trend-list-changed'──►              │
│                                  initialLoad()                                 │
│                                       │                                        │
│                                       ├── fetch /trendList                    │
│                                       ├── fetch /tagHistory  (parallel)       │
│                                       └── fetch /readTags (one batched         │
│                                            request for all tags' "Current")    │
│                                                                                 │
│                                  createChart(uPlot)                            │
│                                                                                 │
└────────────────────────────────────────────────────────────────────────────────┘
                                       ▲
                                       │  HTTP (fetch) — every JS call below
                                       │  hits one of these gateway routes
┌──────────────────────────────────────┴────────────────────────────────────────┐
│  Gateway (one JVM, one TrendListStore singleton)                              │
│                                                                                │
│   TagReadRoutes:                                                              │
│     GET /readTag        ──► provider.readAsync(...)  (legacy single read)     │
│     GET /readTags       ──► group by provider → one readAsync per provider    │
│     GET /writeTag       ──► provider.writeAsync(...)                          │
│     GET /isHistorized   ──► read <tagPath>.HistoryEnabled                     │
│                                                                                │
│   TrendRoutes:                                                                │
│     GET /trendList                                                            │
│     GET /addToTrendList         ──►  TrendListStore (in-memory)              │
│     GET /removeFromTrendList    ──►  keyed by HTTP session ID                │
│     GET /tagHistory             ──►  TagHistoryQuery.query(...)               │
│                                              │                                │
│                                              └── TagHistoryManager + Gson     │
└────────────────────────────────────────────────────────────────────────────────┘
```

The two interesting things about that diagram:

- **Cross-component event.** SimpleTagDisplay and CtgChart don't share React state or talk through a binding. They communicate by firing a browser DOM event on `window`. Every CtgChart on the page hears it and reloads immediately. No polling delay between click and chart update.
- **Trend list is HTTP-session scoped.** The store is in [TrendListStore.java](../simple-tag-display/gateway/src/main/java/com/example/simpletagdisplay/gateway/session/TrendListStore.java), keyed by `request.getSession().getId()`. One browser tab = one trend list. Closing the browser drops it. This is intentional — the feature is "click to graph", not "save a permanent trend".

## Realtime chart refresh

Once the chart is mounted, a `setInterval` ticks every `refreshRate` ms (default 5000) and calls `silentRefresh()`. That:
- Re-queries the historian via `/tagHistory`.
- Re-reads "now" values via `/readTags` in parallel (one batched request for all pens, chunked at 40 paths).
- Either calls `setData` on the existing uPlot instance (same series count) or rebuilds the chart from scratch (series count changed because a pen was added/removed).

The tricky bit is the **x-axis sliding window**. The visible window is driven by **explicit `setScale` calls** in the chart code, not by uPlot's auto-fit. That gives us one code path that covers four cases:

| Case | x window source |
|---|---|
| Live realtime, not zoomed | `[now − rangeHours, now]` recomputed every tick |
| Live realtime, user has zoomed/panned | Held at the user's `_zoomedMin / _zoomedMax`; historian is *also* re-queried for that window if `freeRangePanZoom` is on |
| Custom historical date range | Held at `_customStartMs / _customEndMs` |
| User clicks Reset Zoom | Goes back to the appropriate case above |

Details on each case are in [docs/04-frontend-javascript.md](04-frontend-javascript.md).

## Batched tag-value polling

Every `SimpleTagDisplay` reads its value through **one page-wide shared poller** (`TagReadPoller`, SECTION 0 at the top of `simpletagdisplay.js`) rather than its own timer. Each display subscribes the paths it needs (its value, and optionally `.EngUnit` / `.EngLow` / `.EngHigh`); the poller dedupes across all subscribers and issues a single `/readTags` request per tick (default 1000 ms, override with `window.__CTG_TAG_POLL_MS`), chunked at 40 paths. On the gateway, `/readTags` groups the requested paths by provider and does one `provider.readAsync(list)` per provider.

This replaced the old design where each display ran its own `setInterval` hitting `/readTag` every 250 ms — with 30+ displays on a view that saturated the browser's ~6-connection-per-origin limit and the gateway's HTTP worker pool, causing components to fail to load. The legacy single-read `/readTag` route is kept for back-compat.

## The "common" scope: descriptors and prop schemas

The component descriptors and their JSON Schema prop definitions live in `common/` so both the gateway hook and the designer hook can reference them. Each component has a `.props.json` file describing every prop the designer should expose:

- [simpletagdisplay.props.json](../simple-tag-display/common/src/main/resources/simpletagdisplay.props.json)
- [ctgchart.props.json](../simple-tag-display/common/src/main/resources/ctgchart.props.json)

These are read at JVM startup by `JsonSchema.parse(...)` in [SimpleTagDisplayComponent.java](../simple-tag-display/common/src/main/java/com/example/simpletagdisplay/common/SimpleTagDisplayComponent.java) and [CtgChartComponent.java](../simple-tag-display/common/src/main/java/com/example/simpletagdisplay/common/CtgChartComponent.java). The Designer uses them to build the property-editor UI; the JS side reads the same props at runtime via `getPropsReducer(tree)`.

**The schema and the JS reducer must agree.** If you add a prop in the schema but forget to read it in `getPropsReducer`, the prop will appear in the Designer but your component will never see it. If you change a default in the JSON, also change the default in the reducer (the reducer's defaults are used when a prop has never been touched).

## Next

- Want to read the JS? Start with [02-javascript-primer.md](02-javascript-primer.md), then [04-frontend-javascript.md](04-frontend-javascript.md).
- Want to read the Java? [03-backend-java.md](03-backend-java.md).
- Want to build it? [05-building.md](05-building.md).
