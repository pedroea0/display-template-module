# 03 — Backend (Java)

The Java code in this module is small — under 800 lines across nine files — but every class has a specific reason to exist. This document walks through them in roughly load order: shared constants, descriptors, hooks, routes, session store, historian wrapper.

All Java sources are under `simple-tag-display/<scope>/src/main/java/com/example/simpletagdisplay/`.

## File map

| File | Scope | Purpose |
|---|---|---|
| [SimpleTagDisplayModule.java](../simple-tag-display/common/src/main/java/com/example/simpletagdisplay/common/SimpleTagDisplayModule.java) | common | Module-wide constants (ID, URL alias, browser-resource list) |
| [SimpleTagDisplayComponent.java](../simple-tag-display/common/src/main/java/com/example/simpletagdisplay/common/SimpleTagDisplayComponent.java) | common | Java descriptor + prop schema for Tag Display |
| [CtgChartComponent.java](../simple-tag-display/common/src/main/java/com/example/simpletagdisplay/common/CtgChartComponent.java) | common | Java descriptor + prop schema for CTG Chart |
| [SimpleTagDisplayGatewayHook.java](../simple-tag-display/gateway/src/main/java/com/example/simpletagdisplay/gateway/SimpleTagDisplayGatewayHook.java) | gateway | Module lifecycle; registers components and mounts routes |
| [SimpleTagDisplayDesignerHook.java](../simple-tag-display/designer/src/main/java/com/example/simpletagdisplay/designer/SimpleTagDisplayDesignerHook.java) | designer | Module lifecycle; registers components in the Designer's palette with icons |
| [TagReadRoutes.java](../simple-tag-display/gateway/src/main/java/com/example/simpletagdisplay/gateway/routes/TagReadRoutes.java) | gateway | `/readTag`, `/writeTag`, `/isHistorized` HTTP routes |
| [TrendRoutes.java](../simple-tag-display/gateway/src/main/java/com/example/simpletagdisplay/gateway/routes/TrendRoutes.java) | gateway | `/trendList`, `/addToTrendList`, `/removeFromTrendList`, `/tagHistory` |
| [TrendListStore.java](../simple-tag-display/gateway/src/main/java/com/example/simpletagdisplay/gateway/session/TrendListStore.java) | gateway | In-memory, per-HTTP-session list of trended tag paths (singleton) |
| [TagHistoryQuery.java](../simple-tag-display/gateway/src/main/java/com/example/simpletagdisplay/gateway/historian/TagHistoryQuery.java) | gateway | Wraps Ignition's `TagHistoryManager`, shapes the result into JSON |

---

## SimpleTagDisplayModule.java (common)

Just a holder for module-wide constants. Three of them matter:

```java
public static final String MODULE_ID = "com.example.simpletagdisplay.SimpleTagDisplay";
public static final String URL_ALIAS = "simpletagdisplay";
public static final Set<BrowserResource> BROWSER_RESOURCES = Set.of(
    new BrowserResource(
        "simple-tag-display-js",
        String.format("/res/%s/js/simpletagdisplay.js", URL_ALIAS),
        BrowserResource.ResourceType.JS
    )
);
```

- **`MODULE_ID`** — must match the `id` in [build.gradle.kts](../simple-tag-display/build.gradle.kts) **and** the `DEFAULT_MODULE_ID` in [deploy_ignition_module.py](../simple-tag-display/deploy_ignition_module.py). If you change one, change all three.
- **`URL_ALIAS`** — the URL segment used for both static resources (`/res/simpletagdisplay/...`) and data routes (`/data/simpletagdisplay/<route>`). Hardcoded in the frontend at every `fetch` call site.
- **`BROWSER_RESOURCES`** — the JS files Perspective will inject into any session that uses one of this module's components. We declare `simpletagdisplay.js` (which contains both components' code). `uplot.min.js` is **not** declared here because the chart loads it lazily on first mount.

## SimpleTagDisplayComponent.java / CtgChartComponent.java (common)

These two classes follow the same pattern. They build a `ComponentDescriptor` that the gateway and designer pass to their respective `ComponentRegistry`. Three things to notice:

```java
public static final String COMPONENT_ID = "com.example.simpletagdisplay.SimpleTagDisplay";

public static final JsonSchema SCHEMA =
    JsonSchema.parse(SimpleTagDisplayComponent.class.getResourceAsStream("/simpletagdisplay.props.json"));

public static final ComponentDescriptor DESCRIPTOR = ComponentDescriptorImpl.ComponentBuilder.newBuilder()
    .setPaletteCategory("Display")
    .setId(COMPONENT_ID)
    .setModuleId(SimpleTagDisplayModule.MODULE_ID)
    .setSchema(SCHEMA)
    .setName("Tag Display")
    .addPaletteEntry("", "Tag Display", "Displays tag names ...", null, null)
    .setDefaultMetaName("simpleTagDisplay")
    .setResources(SimpleTagDisplayModule.BROWSER_RESOURCES)
    .build();
```

- **`COMPONENT_ID`** must exactly match the string returned by `SimpleTagDisplayMeta.getComponentType()` in the JS. The two halves of a Perspective component are joined by this string.
- **`SCHEMA`** is parsed from a JSON Schema file at module load time. The Designer uses it to build the property editor; the JS side reads the live values via `getPropsReducer`. The two must agree.
- **`DESCRIPTOR`** packages everything Perspective needs: palette category and entry, schema, default node name (what shows up in the project tree when you drop the component), and the list of browser resources to inject.

The palette entry's icon URL is left empty (`""`) here. The Designer hook builds a *second* copy of the descriptor with the icon URL filled in — see below.

## SimpleTagDisplayGatewayHook.java (gateway)

The gateway-scope entry point. Extends `AbstractGatewayModuleHook`, which gives default no-op implementations of the lifecycle methods Ignition calls.

### Lifecycle methods

```java
public void setup(GatewayContext context) {
    this.gatewayContext = context;
}

public void startup(LicenseState activationState) {
    this.perspectiveContext = PerspectiveContext.get(this.gatewayContext);
    this.componentRegistry = this.perspectiveContext.getComponentRegistry();
    if (this.componentRegistry != null) {
        this.componentRegistry.registerComponent(SimpleTagDisplayComponent.DESCRIPTOR);
        this.componentRegistry.registerComponent(CtgChartComponent.DESCRIPTOR);
    }
}

public void shutdown() {
    if (this.componentRegistry != null) {
        this.componentRegistry.removeComponent(SimpleTagDisplayComponent.COMPONENT_ID);
        this.componentRegistry.removeComponent(CtgChartComponent.COMPONENT_ID);
    }
}
```

Order is `setup` → `startup`, and `shutdown` runs on uninstall or gateway shutdown. We cache the context in `setup`, then look up Perspective's `ComponentRegistry` and register both descriptors in `startup`. `shutdown` is the mirror.

### Routes and static resources

```java
public void mountRouteHandlers(RouteGroup routes) {
    TagReadRoutes.mountRoutes(routes);
    TrendRoutes.mountRoutes(routes);
}

public Optional<String> getMountedResourceFolder() { return Optional.of("mounted"); }
public Optional<String> getMountPathAlias()        { return Optional.of(SimpleTagDisplayModule.URL_ALIAS); }
```

`mountRouteHandlers` is called once at startup; we delegate to the two route classes. The two `Optional<String>` getters together tell Ignition: "expose `gateway/src/main/resources/mounted/<anything>` as `/res/simpletagdisplay/<anything>`." That's how the browser pulls `simpletagdisplay.js`, `uplot.min.js`, `uplot.min.css`, and `icon.svg`.

### `isFreeModule`

```java
public boolean isFreeModule() { return true; }
```

Tells Ignition this module needs no license. Together with `freeModule.set(true)` in [build.gradle.kts](../simple-tag-display/build.gradle.kts), this means the module activates with no licensing UI.

## SimpleTagDisplayDesignerHook.java (designer)

Mirror of the gateway hook but for the Designer's separate `DesignerComponentRegistry`. Two interesting differences:

1. **Icons.** The base descriptors in `common/` set the palette-entry icon URL to `null`. The designer hook rebuilds each descriptor with the icon URL filled in:

   ```java
   String iconUrl = String.format("/res/%s/icon.svg", SimpleTagDisplayModule.URL_ALIAS);
   ComponentDescriptor descriptorWithIcons = ComponentDescriptorImpl.ComponentBuilder.newBuilder()
       // ... same as the common one, except:
       .addPaletteEntry(iconUrl, "Tag Display", "...", null, null)
       .build();
   registry.registerComponent(descriptorWithIcons);
   ```

   The icon URL is the same `/res/simpletagdisplay/icon.svg` that the gateway serves from `gateway/src/main/resources/mounted/icon.svg`.

2. **Project browser icon.** `getResourceIcon(ResourcePath)` returns an `Icon` (Swing) that the Designer uses next to nodes in the project resource tree. It's built once at class load via `InteractiveSvgIcon.createIconAll(...)` from `common/src/main/resources/icon.svg`. SVG-to-`BufferedImage` conversion can only happen in the Designer scope, which is why the field is `public static final Icon COMPONENT_ICON` here instead of in `common/`.

## TagReadRoutes.java (gateway routes)

Three GET endpoints. All three live under `/data/simpletagdisplay/` (the prefix is set by Perspective from `URL_ALIAS`).

### `/readTag?tagPath=...`

Reads one tag value. Used by:
- `SimpleTagDisplay` polling every 250 ms.
- `SimpleTagDisplay` reading `<tagPath>.EngUnit` every 5 s when `showUnits` is on.
- `CtgChart` reading "now" values in parallel for the legend's *Current* column.

The path-parsing dance is the same across all three routes in this file:

```java
// 1. Parse the full path; getSource() yields the provider name (e.g. "default").
TagPath fullPath = TagPathParser.parse(tagPathStr);
String providerName = fullPath.getSource();
if (providerName == null || providerName.isEmpty()) providerName = "default";

// 2. Strip the "[provider]" prefix TEXTUALLY (not via TagPath methods)
//    because TagPath#toStringPartial drops trailing properties like ".EngUnit".
String tagPathWithoutProvider;
if (tagPathStr.contains("]")) {
    int bracketIndex = tagPathStr.indexOf(']');
    tagPathWithoutProvider = tagPathStr.substring(bracketIndex + 1);
} else {
    tagPathWithoutProvider = fullPath.toStringPartial();
}

// 3. Re-parse the remainder against the chosen provider.
TagProvider provider = tagManager.getTagProvider(providerName);
TagPath tPath = TagPathParser.parse(tagPathWithoutProvider);
```

The actual read uses `provider.readAsync(...)` with a 30-second timeout:

```java
List<QualifiedValue> values = provider.readAsync(
    Arrays.asList(tPath),
    SecurityContext.emptyContext()
).get(30, TimeUnit.SECONDS);
```

Response shape:

```json
{ "success": true, "value": "42.5", "quality": "Good", "isGood": true }
```

### `/writeTag?tagPath=...&value=...`

Powers the optional setpoint write modal in SimpleTagDisplay. Same path-parsing dance, then:

```java
double valueToWrite = Double.parseDouble(valueStr);  // numeric only
QualifiedValue newQv = new BasicQualifiedValue(valueToWrite);
List<QualityCode> results = provider.writeAsync(
    Arrays.asList(tPath),
    Arrays.asList(newQv),
    SecurityContext.emptyContext()
).get(30, TimeUnit.SECONDS);
```

A `QualityCode.isNotGood()` result becomes:

```json
{ "success": false, "error": "Write failed: <quality> (tag may be read-only or path invalid)" }
```

— so the modal can show a meaningful message instead of silently succeeding.

### `/isHistorized?tagPath=...`

Reads `<tagPath>.HistoryEnabled` and returns `{ "historized": true|false }`. Drives whether SimpleTagDisplay's right-click menu shows the *Trend Tag* / *Remove Tag* entries at all. Failures are quietly converted to `{ historized: false }` — the same UX: the menu just doesn't appear.

### `errorResponse` helper

```java
private static JsonObject errorResponse(String message) {
    JsonObject response = new JsonObject();
    response.addProperty("success", false);
    response.addProperty("error", message);
    return response;
}
```

Used by every error path so the JS can reliably check `data.success`.

## TrendRoutes.java (gateway routes)

Four endpoints, all GET. The first three are thin wrappers over `TrendListStore`; the fourth dispatches to `TagHistoryQuery`.

### `/trendList`

Returns the current session's tag list:

```json
{ "tagPaths": ["[default]Foo", "[default]Bar"] }
```

Looks up the session ID and asks the store for its list:

```java
String sessionId = request.getSession(false) != null ? request.getSession().getId() : null;
List<String> list = TrendListStore.getInstance().getList(sessionId);
```

### `/addToTrendList?tagPath=...` and `/removeFromTrendList?tagPath=...`

Both validate the parameter, get the session ID the same way, and call `TrendListStore.add(...)` / `remove(...)`. Both return `{ "success": true }`. `add` is idempotent — adding a path twice does nothing.

### `/tagHistory?...`

The complex one. Parses query parameters with sane defaults, then delegates to `TagHistoryQuery.query(...)`:

| Param | Type | Default | Purpose |
|---|---|---|---|
| `tagPaths` | csv (required) | — | Tags to fetch |
| `pointCount` | int | 300 | Bucket count for aggregated queries |
| `rangeHours` | double | 24 | Sliding window from now |
| `startTimeMs` | long | (unset) | Absolute start (overrides `rangeHours`) |
| `endTimeMs` | long | (unset) | Absolute end (overrides `rangeHours`) |
| `rawHistory` | bool | false | When true, on-change samples instead of buckets |

The route doesn't validate the values further; that's `TagHistoryQuery`'s job.

## TrendListStore.java (gateway session)

A simple singleton: one instance per JVM, holding a `ConcurrentHashMap<String, List<String>>` keyed by HTTP session ID.

```java
private static final TrendListStore INSTANCE = new TrendListStore();
public static TrendListStore getInstance() { return INSTANCE; }

private final Map<String, List<String>> sessionToPaths = new ConcurrentHashMap<>();
```

Three operations:

```java
public List<String> getList(String sessionId);              // defensive copy
public void add(String sessionId, String tagPath);          // idempotent
public void remove(String sessionId, String tagPath);
```

Two concurrency notes:

1. **`ConcurrentHashMap`** is safe for concurrent `get`/`put` from multiple HTTP-handler threads.
2. **Per-list mutations are `synchronized(list)`** — without that, two simultaneous `add` calls for the same session could both pass the `contains` check and insert a duplicate. `getList` returns a *copy* so callers can iterate without holding the lock.

There's a `clear(sessionId)` method we don't currently call. The trend list is intended to be tab-scoped and short-lived; if the session expires Ignition reclaims the entry naturally when the next access for that ID fails to find one. If we ever add a *cleanup-on-disconnect* hook, that's where it'd go.

## TagHistoryQuery.java (gateway historian wrapper)

Wraps Ignition's `TagHistoryManager` and converts the result to the JSON shape the chart expects:

```json
{
  "success": true,
  "series": [
    { "tagPath": "[default]Foo", "points": [ { "t": 1700000000000, "v": 42.5 } ] },
    { "tagPath": "[default]Bar", "points": [ /* ... */ ] }
  ]
}
```

Three behaviors worth understanding:

### Mode selection

```java
int returnSize = rawHistory ? -1 : (pointCount <= 0 ? 0 : pointCount);
```

- `returnSize = -1` is Ignition's "on-change" mode: one row per stored sample in the range. `pointCount` is ignored.
- `returnSize > 0` is aggregated mode: that many evenly-spaced buckets with `AggregationMode.LastValue`.

### Bucket-aligned end time (stable windows)

For aggregated queries, we don't pass `now` directly as the end time. We round it *down* to the nearest bucket boundary:

```java
long bucketMs = rangeMs / returnSize;
if (bucketMs > 0) {
    resolvedEnd = (now / bucketMs) * bucketMs;
}
resolvedStart = resolvedEnd - rangeMs;
```

Without this alignment, the bucket boundaries shift slightly every refresh tick, and a spike that landed in one bucket may end up in a neighbouring bucket on the next refresh — making it appear and disappear visually. Aligning gives stable buckets.

### NaN/Infinite filtering

```java
double v = valObj instanceof Number ? ((Number) valObj).doubleValue() : Double.NaN;
if (Double.isNaN(v) || Double.isInfinite(v)) continue;
```

If we let `NaN` through, Ignition's Gson would emit a literal `NaN` token. That's not valid JSON, and the JS `JSON.parse` on the browser side would crash. The historian returns `NaN` for bad-quality points, so we skip them. The chart treats a missing point as a gap in the line (which is what we want).

### Graceful degradation

`TagHistoryManager` is `null`, the query throws, or no rows come back — in all three cases we return `success: true` with empty `points` arrays per tag, instead of failing. The chart will draw nothing for that tag but won't error out, and the next refresh tick will try again.

---

## Cross-cutting: how a single right-click traces through the Java

For reference, here's the full call chain when a user right-clicks a `SimpleTagDisplay` value and picks *Trend Tag*:

1. Browser fires `GET /data/simpletagdisplay/addToTrendList?tagPath=...`
2. Perspective routes that to `TrendRoutes.ADD_TO_TREND_LIST_ROUTE`'s handler.
3. Handler pulls `sessionId` from `request.getSession()`.
4. `TrendListStore.getInstance().add(sessionId, tagPath)` — locks the list, checks for dup, appends.
5. Handler returns `{ "success": true }`.
6. Browser then fires `window.dispatchEvent(new CustomEvent('ctg-trend-list-changed'))` on success.
7. Every `CtgChart` on the page hears it and calls `initialLoad()`, which in turn fires `GET /trendList` and `GET /tagHistory?...` — both into the same gateway, both eventually returning to the JS to feed uPlot.

The whole loop completes in under a few hundred milliseconds on a local gateway.

---

Next: [04-frontend-javascript.md](04-frontend-javascript.md) for the JS side.
