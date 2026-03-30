# ApexCharts Ignition Module

## Purpose
An Ignition Perspective component module that integrates the ApexCharts JavaScript charting library into Inductive Automation's Ignition platform. Provides a configurable, event-driven chart component supporting 16+ chart types with full scripting API support.

## Tech Stack
- **Backend**: Java 17, Ignition SDK 8.3.0+, Jython (Python scripting bridge)
- **Frontend**: TypeScript 4.9.5, React 16.14.0, ApexCharts 3.54.1, MobX 5.15.1
- **Build**: Gradle 7+ (Kotlin DSL), Webpack 5, Lerna 3 monorepo, Yarn 1.22.18, Node 22

## Key Directories

| Path | Purpose |
|------|---------|
| `ignition-apexcharts-module/common/src/main/java/` | Component descriptor, registry metadata |
| `ignition-apexcharts-module/common/src/main/resources/` | JSON property schemas and variant presets |
| `ignition-apexcharts-module/gateway/src/main/java/` | Server-side lifecycle hooks, model delegate, scripting API |
| `ignition-apexcharts-module/designer/src/main/java/` | Designer scope initialization |
| `ignition-apexcharts-module/web/packages/client/` | React component implementation |
| `ignition-apexcharts-module/web/packages/designer/` | Designer-time component registration |

## Entry Points
- Component descriptor: `common/.../component/display/ApexChart.java`
- Server logic / scripting API: `gateway/.../ApexChartModelDelegate.java`
- React component: `web/packages/client/typescript/components/ApexChart.tsx`
- Property schema: `common/src/main/resources/apexchart.props.json`
- Module build config: `ignition-apexcharts-module/build.gradle.kts`

## Build & Run Commands

```bash
# From ignition-apexcharts-module/
./gradlew build          # Full build — outputs .modl file to build/libs/
./gradlew :web:webpack   # Rebuild frontend only
./gradlew clean          # Clean build artifacts
./gradlew deepClean      # Clean including node_modules and .gradle cache

# Web packages only (from ignition-apexcharts-module/web/)
yarn install             # Install all package dependencies via Lerna
yarn build               # Build all packages via Lerna
```

**Module output**: `ignition-apexcharts-module/build/libs/apexcharts-[version].modl`

## Build, Sign & Deploy Pipeline

A full end-to-end pipeline lives in `simple-tag-display/` and handles building, signing, and hot-deploying a module to the local gateway.

### One-command workflow (PowerShell)
```powershell
# From the repo root (or simple-tag-display/)
.\simple-tag-display\build-and-sign.ps1
```

**What it does (in order):**
1. Sets `JAVA_HOME` to `C:\Program Files\Java\jdk-17` and redirects the Gradle cache to `%LOCALAPPDATA%\Gradle\TagDisplayBuild` (avoids OneDrive cloud-file errors)
2. Runs `.\gradlew.bat build` — produces an unsigned `.modl` in `build/`
3. Builds `module-signer-1.0.0-jar-with-dependencies.jar` (skipped if already built) from `../module-signer/`
4. Calls `sign-module.ps1` to sign the `.modl` with the keystore in `module-signer/`
5. If `deploy_ignition_module.py` is present, calls it to push the signed module to the gateway and trigger a restart

### Deploy script (`simple-tag-display/deploy_ignition_module.py`)
Talks to the Ignition 8.3 HTTP API directly. Hardcoded dev config at the top of the file:

| Variable | Default |
|---|---|
| `DEFAULT_GATEWAY_URL` | `http://10.10.20.156:8088` |
| `DEFAULT_API_TOKEN` | Set in file — from Gateway › Config › Security › API Keys |
| `DEFAULT_MODULE_ID` | `com.example.simpletagdisplay.SimpleTagDisplay` |

Steps: uninstall (schedules for next restart) → upload binary `.modl` → install → restart gateway.

**CLI overrides:**
```bash
python deploy_ignition_module.py --gateway-url http://... --api-token ... --module-file path/to/file.modl --module-id com.example.mymodule --no-restart --skip-uninstall
```

**Prerequisite:** `pip install requests`

### Signing only (`simple-tag-display/sign-module.ps1`)
Runs the module-signer JAR standalone — useful if you only need to re-sign without rebuilding.

## Additional Documentation
- `.claude/docs/architectural_patterns.md` — Scope architecture, delegate pattern, event flow, scripting API, schema-driven properties, and data transformation pipeline

---

## Simple Tag Display — CTG Chart Development Tracker

The `simple-tag-display/` module is a WIP Ignition Perspective component that implements "click-to-graph" (CTG) functionality. It has two components: `SimpleTagDisplay` (tag value display with right-click to trend) and `CtgChart` (session trend chart powered by ApexCharts).

### Completed

| # | Feature / Fix | Notes |
|---|---|---|
| 1 | Document build/sign/deploy pipeline in CLAUDE.md | `build-and-sign.ps1`, `deploy_ignition_module.py`, `sign-module.ps1` |
| 2 | Fix NaN JSON parse error crashing CTG chart | Historian returns `Double.NaN` for bad-quality points; Gson emits literal `NaN` (invalid JSON). Fixed in `TagHistoryQuery.java` by filtering NaN/Infinite points before serialization. |
| 3 | Bundle ApexCharts locally (air-gap support) | Extracted `apexcharts@3.45.1` via `npm pack`, placed in `mounted/js/apexcharts.min.js`. CDN reference replaced with local `/res/simpletagdisplay/js/apexcharts.min.js`. |
| 4 | Fix auto-refresh (timer lifecycle) | Timer was only started inside `createChart()`, so the empty-state path never started it. Moved `startTimer()` to `initialLoad()`'s setState callback so it always fires regardless of data. |
| 5 | Fix reset zoom | Was calling `resetSeries()` (ApexCharts default). Changed to `updateOptions()` with explicit xaxis min/max from actual data extent. |
| 6 | Remove fullscreen | Was getting visually cut off with no exit path. Removed entirely — state, methods, button, Escape listener, styles. |
| 7 | Runtime controls in toolbar | Mode toggle (Realtime / Historical), range preset buttons (1h / 4h / 8h / 24h / 3d / 7d), refresh rate input (ms), Refresh button, Reset Zoom button. |
| 8 | Stats table legend | Replaced ApexCharts built-in legend with an HTML table: colored dot, tag name, Current, Min, Max, Avg per pen. Updates on every silent refresh. |
| 9 | Fix Y-axis flickering | ApexCharts auto-scaled on every tick. Implemented persistent session-wide `_yMin`/`_yMax` that only grows — axis range never shrinks between ticks. |
| 10 | Fix spike appearing/disappearing on alternating ticks | `AggregationMode.LastValue` bucket boundaries shifted ~1 s per tick as `now` advanced, causing a spike to alternately fall inside/outside a bucket. Fixed in `TagHistoryQuery.java` by aligning `alignedNow = (now / bucketMs) * bucketMs`. |
| 11 | Fix Y-axis not recalculating on time range / mode change | `_yMin`/`_yMax` never reset between context switches. Fixed by clearing both (plus `_zoomedMin`/`_zoomedMax`) at the top of `initialLoad()` so each new time window starts with a fresh scale. |
| 12 | Fix tooltip double-blink per tick | Two sequential calls (`updateSeries` then `updateOptions`) caused two SVG redraws per tick, blinking the crosshair twice. Collapsed into a single `updateOptions({ ...opts, series })` call. |
| 13 | Fix tooltip clipping at chart bottom | ApexCharts hard-codes `overflow: hidden` on its canvas. Setting `overflow: visible` on container caused scrollbar jitter. Fixed by adding `grid.padding.bottom: 20` so chart plot area stops short of the container edge, giving the tooltip room to render within bounds. |
| 14 | Interaction mode buttons: X-Trace / Pan / Zoom / Annotate | Added toolbar button group. X-Trace (default): crosshair with persistent tooltip. Pan: ApexCharts pan tool. Zoom: drag-select range brush. Annotate: disabled placeholder (backburner). |
| 15 | Persistent X-Trace tooltip across refresh ticks | ApexCharts clears hover state on every `updateOptions`. Fixed by storing the last `mousemove` DOM event and re-dispatching a synthetic `mousemove` at the same screen coordinates after each `updateOptions` resolves — ApexCharts re-renders the tooltip at the pinned position with fresh values. Mouse-leave no longer clears the stored position so the trace stays visible when cursor exits the chart. |

### Architecture Notes — CTG Chart

- **`simpletagdisplay.js`** is a plain ES6 class file (no build step) registered via `ComponentRegistry`. All CTG logic lives here.
- **`_yMin` / `_yMax`**: session-persistent Y-range; grows but never shrinks during silent refreshes. Reset on `initialLoad()` (range change, mode switch, manual refresh).
- **`_zoomedMin` / `_zoomedMax`**: last zoom/pan extent; prevents `silentRefresh` from resetting the x-axis while user has a custom view. Also captured on `scrolled` event so panning persists across ticks.
- **`_lastMouseEvent`**: last `mousemove` DOM event captured inside `chart.events.mouseMove`. Used by `_retriggerXTrace()` to re-show the tooltip after each data update without requiring mouse movement. Cleared on `initialLoad()` and on interaction mode switch.
- **Timer ownership**: `startTimer()` is called from `initialLoad()`'s setState callback — never from `createChart()`. This ensures the refresh timer runs even in the empty-state (no tags added yet), so the chart auto-populates the moment the first tag is trended.
- **Single-call updates**: `silentRefresh` uses one `updateOptions({ ...opts, series })` call (not `updateSeries` + `updateOptions`) to produce one SVG redraw per tick instead of two.
- **CSS injection**: `injectCtgStyles()` runs once at module load and adds `.apexcharts-tooltip { z-index: 9999 }` to keep tooltips above other Perspective components.

### Pending

| Priority | Feature | Notes |
|---|---|---|
| High | X-Trace tooltip fully persistent (in progress) | Synthetic mousemove re-trigger is working but not yet perfect — tooltip still disappears in some edge cases. Under active investigation. |
| High | Per-pen color picker | Let users assign a custom color to each trending tag |
| High | Show/hide individual pens via legend | Clicking a legend row toggles that series on/off |
| Medium | Multiple Y-axes with per-pen axis assignment | Left/right axis selection per tag, like Power Chart |
| Medium | Historical mode date/time range picker | Explicit start/end time inputs instead of only "last N hours" |
| Low | Annotate mode | Select a point in time and add a comment — backburner |
| Low | Export data (CSV / PNG) | Snapshot or raw-data export from the toolbar |
