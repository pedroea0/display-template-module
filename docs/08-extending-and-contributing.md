# 08 — Extending and contributing

This page covers the workflow for changing the module: adding props, adding components, adding routes, plus the conventions for releases and PRs.

## Local dev loop

The fastest iteration is:

1. Edit code.
2. Run `.\simple-tag-display\build-and-sign.ps1` — this builds, signs, uploads, and restarts the gateway.
3. Refresh the Perspective view in your browser. (Hard-refresh — `Ctrl+Shift+R` — to bust any cached JS.)
4. Open the browser DevTools (F12) to see console logs from the JS side.
5. Check the gateway logs (`<IgnitionInstallDir>/logs/wrapper.log`) for Java side errors.

A full build+restart cycle is ~60–90 s on most dev machines. Once the gateway is up, JS-only edits don't need a full rebuild — you can just edit `gateway/src/main/resources/mounted/js/simpletagdisplay.js` in your IDE and copy it into the running gateway's module cache. (But for clean repeatable runs, prefer the full rebuild.)

## Adding a prop to an existing component

Say you want to add a `tooltip` string prop to `SimpleTagDisplay`. Three places to update:

### 1. The JSON schema

[simple-tag-display/common/src/main/resources/simpletagdisplay.props.json](../simple-tag-display/common/src/main/resources/simpletagdisplay.props.json):

```json
"tooltip": {
    "type": "string",
    "description": "Optional tooltip text shown when hovering the value.",
    "default": ""
}
```

This is what the Designer reads to populate the property editor.

### 2. The JS reducer

[simple-tag-display/gateway/src/main/resources/mounted/js/simpletagdisplay.js](../simple-tag-display/gateway/src/main/resources/mounted/js/simpletagdisplay.js), inside `SimpleTagDisplayMeta.getPropsReducer`:

```js
return {
    // ... existing props ...
    tooltip: tree.readString("tooltip", ""),
};
```

This is what the running component reads. **The defaults here and in the JSON should match** — they're the fallback at different times (design-time vs. runtime).

### 3. The render code

Inside `SimpleTagDisplay.render()`:

```js
const { tooltip, /* ... */ } = props;
// ...
const valueDivProps = {
    style: valueStyle,
    title: tooltip || undefined,   // HTML 'title' attr → native browser tooltip
    onContextMenu: this.onValueContextMenu,
};
```

That's it — rebuild, redeploy, refresh.

> **Don't forget:** if you only update one of the three places, the prop will *look* like it works but behave wrong. Schema-only → appears in Designer but ignored at runtime. Reducer-only → no Designer UI to set it. Render-only → never receives a value.

## Adding a new gateway route

Routes are mounted in [SimpleTagDisplayGatewayHook.mountRouteHandlers](../simple-tag-display/gateway/src/main/java/com/example/simpletagdisplay/gateway/SimpleTagDisplayGatewayHook.java):

```java
public void mountRouteHandlers(RouteGroup routes) {
    TagReadRoutes.mountRoutes(routes);
    TrendRoutes.mountRoutes(routes);
    // your new route group here
}
```

Add a new file (e.g. `MyRoutes.java`) following the structure of [TagReadRoutes.java](../simple-tag-display/gateway/src/main/java/com/example/simpletagdisplay/gateway/routes/TagReadRoutes.java):

```java
public class MyRoutes {
    public static void mountRoutes(RouteGroup routes) {
        routes.newRoute("/myRoute")
            .type(RouteGroup.TYPE_JSON)
            .accessControl(Routes.requireSession(EnumSet.of(SessionScope.Client, SessionScope.Designer)))
            .handler((requestContext, response) -> {
                // ... build JsonObject ... return it ...
            })
            .mount();
    }
}
```

Wire it into the hook, rebuild, and the route is live at `/data/simpletagdisplay/myRoute`.

From the JS side, call it via the same dual-URL fallback pattern used elsewhere:

```js
fetch('/data/simpletagdisplay/myRoute')
    .then(r => r.json())
    .then(data => { /* ... */ });
```

## Adding a new Perspective component

If you want a third component alongside `SimpleTagDisplay` and `CtgChart`:

### 1. Java descriptor (common scope)

Copy `CtgChartComponent.java` to `MyComponentComponent.java`:

```java
public class MyComponentComponent {
    public static final String COMPONENT_ID = "com.example.simpletagdisplay.MyComponent";
    public static final JsonSchema SCHEMA =
        JsonSchema.parse(MyComponentComponent.class.getResourceAsStream("/mycomponent.props.json"));
    public static final ComponentDescriptor DESCRIPTOR = ComponentDescriptorImpl.ComponentBuilder.newBuilder()
        .setPaletteCategory("Display")
        .setId(COMPONENT_ID)
        .setModuleId(SimpleTagDisplayModule.MODULE_ID)
        .setSchema(SCHEMA)
        .setName("My Component")
        .addPaletteEntry("", "My Component", "Description.", null, null)
        .setDefaultMetaName("myComponent")
        .setResources(SimpleTagDisplayModule.BROWSER_RESOURCES)
        .build();
}
```

### 2. Props schema (common scope)

Add `simple-tag-display/common/src/main/resources/mycomponent.props.json` with your prop definitions.

### 3. Register in both hooks

In [SimpleTagDisplayGatewayHook.startup](../simple-tag-display/gateway/src/main/java/com/example/simpletagdisplay/gateway/SimpleTagDisplayGatewayHook.java):

```java
this.componentRegistry.registerComponent(MyComponentComponent.DESCRIPTOR);
```

And the matching `removeComponent(MyComponentComponent.COMPONENT_ID)` in `shutdown`.

In [SimpleTagDisplayDesignerHook.init](../simple-tag-display/designer/src/main/java/com/example/simpletagdisplay/designer/SimpleTagDisplayDesignerHook.java), build a `descriptorWithIcons` for it with the same icon URL pattern, and register it with `registry.registerComponent`. Mirror the unregistration in `removeComponents`.

### 4. JS implementation

In [simpletagdisplay.js](../simple-tag-display/gateway/src/main/resources/mounted/js/simpletagdisplay.js), add a `MyComponentMeta` class and a `MyComponent` class following the existing patterns. Register at the bottom of the file:

```js
ComponentRegistry.register(new MyComponentMeta());
```

If your component is a lot of code, consider splitting it into its own JS file and declaring a second `BrowserResource` in [SimpleTagDisplayModule.BROWSER_RESOURCES](../simple-tag-display/common/src/main/java/com/example/simpletagdisplay/common/SimpleTagDisplayModule.java). Otherwise, the single bundle pattern works fine.

## Editing the chart's behavior

Areas you might want to touch in `CtgChart`, and what to look for:

| Want to change | Look at |
|---|---|
| Default colors | `CTG_PALETTE` constant |
| Available rolling-window units | `CTG_ROLLING_UNITS` constant |
| Default refresh rate | `refreshRate` prop default in JSON schema and `getRefreshRate` getter |
| X-axis label format | `axes[0].values` in `buildUPlotOpts` |
| Y-axis tick format / decimals | `axes[1].values` in `buildUPlotOpts` |
| Tooltip layout | `_updateTooltip` |
| Legend columns | `renderLegend` |
| Pan sensitivity | `_onPanMouseMove` (`dSec = -(dx / plotW) * span`) |
| Wheel-zoom step | `_onPanWheel` (`const step = 0.12 * ...`) |
| Series-count change detection | `silentRefresh` (`this.uplot.series.length - 1 !== series.length`) |
| Live "now" point appending | `_mergeLiveEndpoint` and `_shouldAppendLiveReadToSeries` |

Be wary of changing anything around `_suppressScaleHook`. The flag exists because uPlot's `setScale` hook can't tell user gestures from internal recalculations. Tearing out the flag tends to break the live slide in subtle ways.

## Conventions

A few things we've settled on. Stick with them unless you have a good reason:

- **Single JS bundle.** Both components live in one file. Don't split unless the file gets significantly larger or you add a fundamentally different component.
- **Dual-URL fallback for fetches.** Every `fetch` tries `/data/...` then `/main/data/...`. Don't remove this until you've verified your gateway routes one consistently.
- **`window.dispatchEvent` for cross-component messaging.** Don't try to share state through Perspective bindings between our two components — the event pattern is cleaner.
- **HTTP-session-scoped trend list.** Don't add persistence to `TrendListStore` without thinking hard about it. The "ephemeral, per-tab" UX is intentional.
- **Inline comments over external docs for tricky bits.** uPlot quirks, bytecode gotchas — note them next to the code, not in a separate doc. The CLAUDE.md and these docs are the high-level map; the code is the source of truth.
- **No emojis in code or commit messages** unless the change is specifically about emojis. Plain text only.
- **No `console.log` left in committed code.** Use `console.error` for real errors and remove debug logs before pushing.

## Releasing a new version

Two parts: bumping the version, and shipping the `.modl`.

### Bumping the version

1. Edit [simple-tag-display/build.gradle.kts](../simple-tag-display/build.gradle.kts):

   ```kotlin
   allprojects {
       version = "1.1.0"   // ← bump here
   }
   ```

   The module's `moduleVersion` reads from `project.version`, so this single change propagates.

2. Commit on `main` with a tag:

   ```powershell
   git add simple-tag-display/build.gradle.kts
   git commit -m "Release 1.1.0"
   git tag v1.1.0
   git push origin main --tags
   ```

### Creating the release on GitHub

Manual:
1. Build locally: `.\simple-tag-display\build-and-sign.ps1` (you can pass `--no-restart` to the deploy step or rename the deploy script to skip deployment).
2. Find `simple-tag-display/build/Tag-Display.modl`.
3. Go to the repo on GitHub → **Releases** → **Draft a new release**.
4. Choose tag `v1.1.0`, title "1.1.0", and write a short changelog.
5. Drag `Tag-Display.modl` into the **Attach binaries** area.
6. Publish.

Automated (recommended once the workflow is set up):

```yaml
name: release
on:
  push:
    tags: ['v*']
jobs:
  release:
    runs-on: windows-latest
    permissions:
      contents: write
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-java@v4
        with: { java-version: '17', distribution: 'temurin' }
      - name: Build module
        run: |
          cd simple-tag-display
          .\gradlew.bat build
      - name: Build signer
        run: |
          cd module-signer
          ..\simple-tag-display\gradlew.bat build
      - name: Sign
        run: |
          cd simple-tag-display
          .\sign-module.ps1
      - uses: softprops/action-gh-release@v2
        with:
          files: simple-tag-display/build/Tag-Display.modl
```

This builds and attaches the signed `.modl` to whatever tag triggered the workflow. For signing with a production keystore, store the JKS + password as GitHub Actions secrets and inject them at build time (see [07-signing.md](07-signing.md)).

## PR conventions

Keep changes scoped:

- One feature or fix per PR.
- Update the relevant doc(s) in the same PR — don't leave docs lagging.
- If you change a prop, schema, or route shape, mention it in the PR description so reviewers know what's user-visible.
- If a change affects the gateway lifecycle (hook methods, route mounting, component registration), say so explicitly and include a manual restart test in the PR description.

For reviewers:

- Test the change in a Designer **and** in a published Perspective session — they sometimes behave differently due to the URL routing differences.
- Check the gateway logs for new warnings during install/restart.
- If JS changed, hard-refresh the browser to avoid cached old code masking regressions.

## Roadmap / wishlist

These are listed in the **Pending** table at the bottom of [CLAUDE.md](../CLAUDE.md) and are good candidates for first PRs:

| Priority | Feature |
|---|---|
| High | Per-pen color picker (currently auto-cycles `CTG_PALETTE`) |
| High | Click legend row to toggle that series visible/hidden (uPlot supports natively via `setSeries`) |
| Medium | Multiple Y-axes with per-pen axis assignment (Power Chart parity) |
| Low | Annotate mode (toolbar button is shown but disabled) |
| Low | Export data (CSV / PNG) from the toolbar |

If you pick one up, open an issue first to discuss the approach.

---

That's the whole doc set. Glossary of cross-doc shortcuts:

- [README](../README.md) — top-level entry point
- [01 Architecture](01-architecture.md) — how the module is shaped
- [02 JavaScript primer](02-javascript-primer.md) — JS concepts you'll need
- [03 Backend Java](03-backend-java.md) — every Java class
- [04 Frontend JavaScript](04-frontend-javascript.md) — both components in depth
- [05 Building](05-building.md) — prereqs and the build script
- [06 Deployment](06-deployment.md) — gateway install via UI or API
- [07 Signing](07-signing.md) — keystore management
- [08 Extending and contributing](08-extending-and-contributing.md) — you are here
