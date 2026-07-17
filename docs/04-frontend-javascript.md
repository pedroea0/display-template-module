# 04 — Frontend (JavaScript)

All frontend logic for both components lives in a single file: [simpletagdisplay.js](../simple-tag-display/gateway/src/main/resources/mounted/js/simpletagdisplay.js) (~2300 lines). No build step, no bundler — Perspective ships it to the browser as-is.

> **If you don't know JavaScript:** read [02-javascript-primer.md](02-javascript-primer.md) first. The rest of this doc assumes those 13 things are in your head.

## File layout

The file is organized top-to-bottom in roughly this order:

1. File header comment + global imports.
2. **`SECTION 0 / TagReadPoller`** — the page-wide, shared, batched tag-value poller (a module-level IIFE). Every `SimpleTagDisplay` and the chart's `fetchCurrentValues` read through it.
3. `SimpleTagDisplayMeta` — Perspective descriptor for the display.
4. `class SimpleTagDisplay extends Component`.
5. Registration: `ComponentRegistry.register(new SimpleTagDisplayMeta())`.
6. Module-level helpers for the chart (`CTG_PALETTE`, `ctgRollingToHours`, etc.).
7. `loadUPlot()` — lazy loader for uPlot CSS+JS.
8. `CtgChartMeta` — Perspective descriptor for the chart.
9. `class CtgChart extends Component`.
10. Registration: `ComponentRegistry.register(new CtgChartMeta())`.

(Exact line numbers drift as the file changes — search for the anchor names listed in the file's own header comment.)

The split between "what's a class field vs. what's a free function" follows one rule: things specific to a component instance go on the class; things that are pure data transforms or stateless helpers go as module-level functions.

---

## SECTION 0: the shared tag poller (`TagReadPoller`)

At the very top of the file, above both components, is a module-level IIFE that exposes a small `TagReadPoller` object. **There is exactly one of these per page.** It is the single most important thing to understand about how values get read now.

Every `SimpleTagDisplay` subscribes the paths it cares about and gets a callback whenever a fresh value arrives:

```js
this._unsubValue = TagReadPoller.subscribe(path, this.handleTagValue);
// ...later, on unmount / prop change:
this._unsubValue();   // the subscribe() call returns its own unsubscribe fn
```

What the poller does each tick:

- **Dedupes** paths across all subscribers (the same tag shown five times is read once).
- Issues **one `/readTags` request per tick** carrying every distinct path, **chunked at 40 paths** per request.
- **Guards against overlap** with a self-rescheduling `setTimeout` loop (not `setInterval`): the next tick is armed only after the current poll resolves, so a slow gateway throttles the cadence instead of piling up requests. The in-flight flag is reset reliably in a `finally`, and a request timeout aborts a stuck poll so it can never wedge the loop.
- Reads its cadence fresh each tick from `window.__CTG_TAG_POLL_MS` (default **1000 ms**), so you can retune it live from the browser console.
- Delivers the last known value to a new subscriber immediately, and does a debounced "poll soon" so a freshly-mounted component doesn't wait a whole interval for its first value.
- Only caches values for paths that currently have subscribers (no unbounded growth).
- On a transport/HTTP failure it delivers `{ isGood:false, error:'Disconnected' }` rather than hanging — so a display that never got a first value shows **"Disconnected"** instead of a permanent "Loading…".

**Why:** the old design gave each `SimpleTagDisplay` its own `setInterval` hitting `/readTag` every 250 ms. Thirty displays = 120 requests/second, well past the browser's ~6-connection-per-origin limit, so requests queued, timed out, and components failed to render. Coalescing to one batched request per second fixed it. See the gateway side (`/readTags`) in [03-backend-java.md](03-backend-java.md).

---

## Part 1: SimpleTagDisplay

A one-tag value label with optional setpoint write and a right-click "trend this tag" menu.

### Registration: `SimpleTagDisplayMeta`

Perspective requires a small "meta" class per component:

```js
class SimpleTagDisplayMeta {
    getComponentType() { return "com.example.simpletagdisplay.SimpleTagDisplay"; }
    getViewComponent() { return SimpleTagDisplay; }
    getDefaultSize()   { return { width: 250, height: 70 }; }
    getPropsReducer(tree) { /* see below */ }
}
```

- **`getComponentType()`** must match `SimpleTagDisplayComponent.COMPONENT_ID` in Java exactly.
- **`getViewComponent()`** returns the React class.
- **`getDefaultSize()`** is the W×H Perspective uses when you drop the component on a view.
- **`getPropsReducer(tree)`** receives Perspective's prop tree and returns a flat JS object. Each `tree.readString/Number/Boolean(key, default)` corresponds to a property in [simpletagdisplay.props.json](../simple-tag-display/common/src/main/resources/simpletagdisplay.props.json).

The defaults in the reducer are the *runtime* defaults — they apply when a prop is bound to something that hasn't produced a value yet. The defaults in the JSON schema apply at design time. **Keep them in sync.**

### `class SimpleTagDisplay extends Component`

#### State

```js
this.state = {
    tagValue: 'Loading...',
    isConnected: false,
    componentWidth: 0, componentHeight: 0,
    showSetpointModal: false, setpointInputValue: '', setpointSubmitError: null,
    contextMenuVisible: false, contextMenuX: 0, contextMenuY: 0,
    contextMenuHistorized: false, contextMenuIsTrending: false
};
```

| Field | Purpose |
|---|---|
| `tagValue`, `isConnected` | Last value from the poller (or a sentinel string like `'Loading…'`, `'Bad Quality'`, `'Disconnected'`) |
| `engUnit` | Set by `handleEngUnit` when `showUnits` is on |
| `engLow`, `engHigh` | The tag's Engineering Low/High limits, set by `handleEngLow` / `handleEngHigh` when `bounds.enabled` is on (drive bounds highlighting) |
| `componentWidth/Height` | Observed by `ResizeObserver`, used for auto-font-sizing |
| `showSetpointModal`, … | State for the setpoint write modal |
| `contextMenuVisible`, … | State for the right-click menu |

Instance variables that **don't** drive re-renders go directly on `this` rather than in `state`:

| Instance var | Purpose |
|---|---|
| `_unsubValue` | `TagReadPoller` unsubscribe fn for the tag's value |
| `_unsubUnit` | Unsubscribe fn for the `.EngUnit` subscription (when `showUnits` is on) |
| `_unsubLow` / `_unsubHigh` | Unsubscribe fns for `.EngLow` / `.EngHigh` (when `bounds.enabled` is on) |
| `_isMounted` | Guard flag; async callbacks bail out if the component unmounted mid-flight |
| `componentRef` | The root DOM node (set in `setupSizeTracking`) |
| `resizeObserver` | The `ResizeObserver` instance |
| `boundCloseContextMenu` | Document-level click listener that closes the menu |

There are **no per-instance timers for tag reads** any more — value, unit, and bounds limits all come through the shared `TagReadPoller` (SECTION 0). Subscribing/unsubscribing is centralized in `subscribeTag()` / `unsubscribeTag()`.

#### Lifecycle

```js
componentDidMount() {
    this._isMounted = true;
    this.boundCloseContextMenu = () => this.closeContextMenu();
    this.subscribeTag();
    this._sizeInitTimer = setTimeout(() => { this._sizeInitTimer = null; this.setupSizeTracking(); }, 0);
}
```

- `subscribeTag()` registers this tag's value with the shared `TagReadPoller` (plus `.EngUnit` when `showUnits` is on, and `.EngLow` / `.EngHigh` when `bounds.enabled` is on). No per-instance interval — the page-wide poller does the fetching.
- `setupSizeTracking()` attaches a `ResizeObserver` (or falls back to a 100 ms polling interval if the browser lacks `ResizeObserver`). The `setTimeout(..., 0)` defers it one tick so `this.props.store.element` (Perspective's reference to the root DOM node) is populated. Its handle is stored in `_sizeInitTimer` and its callback checks `_isMounted`, so a fast unmount cancels it (otherwise it would attach an observer to a dead component).

```js
componentDidUpdate(prevProps, prevState) {
    if (this.state.contextMenuVisible && !prevState.contextMenuVisible) {
        setTimeout(() => document.addEventListener('click', this.boundCloseContextMenu), 0);
    }
    if (!this.state.contextMenuVisible && prevState.contextMenuVisible) {
        document.removeEventListener('click', this.boundCloseContextMenu);
    }
    // Re-subscribe when tagPath, showUnits, or bounds.enabled changes
    // (bounds toggles the .EngLow/.EngHigh subscriptions).
    if (prevProps.props.tagPath !== this.props.props.tagPath ||
        prevProps.props.showUnits !== this.props.props.showUnits ||
        prevBoundsEnabled !== curBoundsEnabled) {
        this.subscribeTag();
    }
    // ... font-property handling
}
```

Two things this method does on every re-render:
1. Attach/detach a `document`-level click listener so clicking anywhere outside the context menu closes it. The `setTimeout(..., 0)` (tracked in `_ctxMenuTimer` and cancelled on unmount) is so the *same* click that opened the menu isn't immediately re-caught here.
2. Re-subscribe to the poller if `tagPath`, `showUnits`, or `bounds.enabled` changed. `subscribeTag()` unsubscribes the previous set first, so it's safe to call repeatedly.

```js
componentWillUnmount() {
    this._isMounted = false;
    if (this._sizeInitTimer) clearTimeout(this._sizeInitTimer);
    if (this._ctxMenuTimer) clearTimeout(this._ctxMenuTimer);
    document.removeEventListener('click', this.boundCloseContextMenu);
    this.unsubscribeTag();
    if (this.resizeObserver && this.componentRef) {
        this.resizeObserver.unobserve(this.componentRef);
    }
    if (this.sizeCheckInterval) clearInterval(this.sizeCheckInterval);
}
```

Mirror of mount — clear `_isMounted`, cancel the tracked `setTimeout(0)` timers, unsubscribe from the poller, and tear down the observer. Forgetting any of this leaks (poller callbacks keep firing, observers stay attached, listeners pile up).

#### Reading the tag: poller callbacks

Values no longer come from a per-instance `fetch`. `subscribeTag()` registers callbacks with the shared `TagReadPoller`, and each callback just moves the delivered result into `state`:

```js
handleTagValue = (res) => {          // res = { value?, quality?, isGood } from /readTags
    if (res && res.isGood) {
        if (this.state.tagValue !== res.value || !this.state.isConnected)
            this.setState({ tagValue: res.value, isConnected: true });
    } else {
        const msg = (res && res.error) || 'Bad Quality';   // 'Disconnected' on transport failure
        if (this.state.isConnected || this.state.tagValue !== msg)
            this.setState({ tagValue: msg, isConnected: false });
    }
};
handleEngUnit = (res) => { /* '' unless good-quality, else String(res.value).trim() */ };
handleEngLow  = (res) => { /* parseFloat; null unless finite → state.engLow  */ };
handleEngHigh = (res) => { /* parseFloat; null unless finite → state.engHigh */ };
```

Each callback **only calls `setState` when the value actually changed**, so a static tag never triggers a re-render on a poll tick — important with dozens of these on one view. The dual-URL (`/data/...` vs `/main/data/...`) fallback that used to live in each component now lives **once**, inside the poller: it tries the best-guess base first and remembers whichever one answers. (`/main/...` is used when the session view is served under `/main/`, e.g. a Designer-launched session.)

#### Setpoint modal

The modal only renders when `setpoint=true` AND `state.showSetpointModal=true`. Five methods drive it:

```js
openSetpointModal  = () => { /* pre-fill with current value, show */ };
closeSetpointModal = () => { /* clear + hide */ };
onSetpointInputChange = (e) => { /* update setpointInputValue */ };
submitSetpoint = () => { /* validate, fetch /writeTag, close on success */ };
```

`submitSetpoint` validates that the value is non-empty and parses as a finite number, then `fetch`es `/writeTag?...&value=...`. The dual-URL fallback applies here too. On success it closes the modal and calls `TagReadPoller.pollSoon()` so the shared poller refreshes the displayed value promptly instead of waiting for the next poll tick.

#### Right-click context menu

The big feature. `onValueContextMenu` is wired to the value `div`'s `onContextMenu` attribute:

```js
onValueContextMenu = (e) => {
    e.preventDefault();
    e.stopPropagation();
    // ...
    Promise.all([
        fetchWithFallback(historizedUrls),   // GET /isHistorized
        fetchWithFallback(trendListUrls)     // GET /trendList
    ]).then(([histData, trendData]) => {
        const historized = !!(histData && histData.historized);
        const trendPaths = (trendData && trendData.tagPaths) || [];
        const isTrending = trendPaths.includes(trimmedPath);
        this.setState({
            contextMenuVisible: true,
            contextMenuX: e.clientX, contextMenuY: e.clientY,
            contextMenuHistorized: historized,
            contextMenuIsTrending: isTrending
        });
    });
};
```

The two `fetch` calls fire in **parallel** via `Promise.all`. Both have to return before the menu shows. The menu element is only rendered when `contextMenuVisible && contextMenuHistorized` — if the tag isn't historized, no menu appears. If it *is* historized but already on the chart, the menu label is *Remove Tag*; otherwise it's *Trend Tag*.

`onTrendTagClick` and `onRemoveTagClick` are nearly identical:

```js
onTrendTagClick = () => {
    // ... fetch /addToTrendList?tagPath=... ...
    .then(() => {
        this.closeContextMenu();
        window.dispatchEvent(new CustomEvent('ctg-trend-list-changed'));
    });
};
```

The `window.dispatchEvent` is the *only* coupling between this component and the chart. Every `CtgChart` on the page listens for `'ctg-trend-list-changed'` and reloads.

#### `render()`

The render method is long but mechanical. Five things in order:

1. **Tag name extraction** (lines 617–627). Uses `tagNameLabel` if set, otherwise strips the `[provider]` prefix and takes the last path segment.
2. **Value formatting** (lines 632–667). Three branches: boolean (with optional textOnTrue/textOnFalse), numeric (with `valuePrecision` and optional unit), or string.
3. **Layout** (lines 681–744). `row` chooses flex direction; `verticalAlign` becomes `flex-start/center/flex-end`; `evenRow` forces 50/50 column widths.
4. **Font auto-sizing** (lines 715–733). `calculateFontSize(styleObj, isValue)` returns the user's explicit `fontSize` if set, otherwise derives one from `min(componentWidth, componentHeight) * 0.12` (name) or `* 0.15` (value), clamped to ≥ 8 px.
5. **Bounds highlighting.** When `bounds.enabled` and the value is numeric, paints `backgroundColor: minColor` when the value is below the tag's **Engineering Low Limit** or `maxColor` when it's above the tag's **Engineering High Limit**. Those limits are read from the tag itself (`.EngLow` / `.EngHigh`) through the shared poller and held in `state.engLow` / `state.engHigh` — there are **no manual `min`/`max` props any more**. `minInclusive` / `maxInclusive` still decide whether a value sitting exactly on a limit counts as in-range. A missing/bad limit (`null`) simply isn't applied.

Then it assembles three optional React elements (tag-name div, tag-value div, setpoint modal, context menu) and returns them inside a root flex `<div>`. One subtle bit:

```js
const emittedProps = emit({ classes: ['simple-tag-display-component'] });
// ...
const containerStyle = {
    ...(emittedProps.style || {}),
    display: emittedDisplay === 'none' ? 'none' : 'flex',
    // ... our overrides
};
```

`emit()` is what Perspective gives us to provide flex container properties, the `ref`, the `display` toggle (for `display: false` prop), and so on. We spread it first then add our own styles on top — but we preserve `display: 'none'` from emit so the component hides when its Perspective `display` is false.

---

## Part 2: CtgChart

The chart. Much bigger than the display because it manages a uPlot instance, three interaction modes, a refresh timer, a date-range modal, and a legend.

### Helpers above the class

```js
const CTG_PALETTE = ['#2196F3', '#FF5722', '#4CAF50', '#FF9800',
                     '#9C27B0', '#00BCD4', '#F44336', '#8BC34A'];
const CTG_ROLLING_UNITS = ['seconds', 'minutes', 'hours', 'days',
                           'weeks', 'months', 'years'];

function ctgRollingToHours(value, unit) { /* convert N + unit → hours */ }
function ctgToDatetimeLocal(ms)         { /* epoch → "YYYY-MM-DDTHH:MM" */ }
function ctgPluralUnit(n, unit)         { /* "1 hour" vs "2 hours" */ }
```

These are pure functions — no state, no side effects. They live outside the class because they're reused by both `getDateRangePreviewText` and the modal apply logic.

```js
let uPlotLoaded = null;
function loadUPlot() {
    if (uPlotLoaded) return uPlotLoaded;
    uPlotLoaded = new Promise((resolve, reject) => {
        if (window.uPlot) { resolve(window.uPlot); return; }
        // inject <link rel="stylesheet"> and <script> tags
    });
    return uPlotLoaded;
}
```

The first time any `CtgChart` mounts, this injects the `<link>` for `uplot.min.css` and the `<script>` for `uplot.min.js`. The Promise is cached in `uPlotLoaded` so subsequent `CtgChart` instances reuse it without re-loading. Both files are served from `/res/simpletagdisplay/` — bundled with the module so the gateway works air-gapped.

### Registration: `CtgChartMeta`

Same pattern as `SimpleTagDisplayMeta`. Props correspond to [ctgchart.props.json](../simple-tag-display/common/src/main/resources/ctgchart.props.json):

```js
return {
    mode: tree.readString('mode', 'realtime'),
    rangeHours: tree.readNumber('rangeHours', 24),
    pointCount: tree.readNumber('pointCount', 300),
    rawHistory: tree.readBoolean('rawHistory', false),
    refreshRate: tree.readNumber('refreshRate', 5000),
    visibility: { /* ... toolbar control toggles ... */ },
    interaction: { mode: ..., xTraceVisible: ... }
};
```

### `class CtgChart extends Component`

#### State and instance variables

React `state` holds anything that drives a re-render: chart status, the last series we got back, the legend stats, modal state, runtime toolbar overrides. Things mutated *during* a drag or wheel-zoom (which would re-render too slowly through `setState`) live as plain instance properties:

| Instance var | Type | Purpose |
|---|---|---|
| `chartEl`, `uplot`, `_wrapEl`, `_tooltipEl` | DOM / uPlot handles | The actual chart |
| `refreshTimer` | number | `setInterval` handle |
| `_zoomedMin`, `_zoomedMax` | number \| null (seconds) | User's current x viewport; `null` = follow live "now" |
| `_yMin`, `_yMax` | number \| null | Persistent Y range; grows, reset on `initialLoad` |
| `_customStartMs`, `_customEndMs` | number \| null (ms) | Applied historical date range |
| `_panState` | object \| null | `{ startX, scaleMin, scaleMax }` while drag-panning |
| `_suppressScaleHook` | bool | True around programmatic `setScale`/`setData`/`setSize` |

`_suppressScaleHook` is the most important one to understand. Several uPlot APIs internally fire the `setScale` hook — `setSize`, `setData(data, true)`, the constructor itself. The hook is how we record *user* zoom/pan into `_zoomedMin/Max`. Without the suppress flag, our own programmatic scale changes would be misread as user gestures, freezing the live view.

#### Effective-value getters

```js
getMode()        { return this.state.runtimeMode || (this.props.props || {}).mode || 'realtime'; }
getRangeHours()  { const r = this.state.runtimeRangeHours;  return r != null ? r : ((this.props.props || {}).rangeHours  || 24); }
getRefreshRate() { /* similar */ }
getPointCount()  { return (this.props.props || {}).pointCount || 300; }
```

These exist to encode one precedence rule once: **toolbar runtime override > Perspective prop > hardcoded default**. The rest of the code calls these getters and doesn't have to think about precedence.

#### Backend I/O

```js
fetchJson(url) {
    return fetch(url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
}

fetchCurrentValues(tagPaths) {
    // batched GET /readTags (chunked at 40 paths) → Map<path, number | null>
}

fetchData() {
    return this.fetchJson(base + '/trendList').then(data => {
        // build /tagHistory URL with the right time window
        // return { tagPaths, series }
    });
}
```

The window selection in `fetchData` has three branches:

1. **`_customStartMs/EndMs` set** → use that absolute window (historical mode).
2. **`freeRangePanZoom + zoomed + realtime`** → use the zoomed window. If the right edge is at "now", stretch it to `Date.now()` so live data keeps appending into the viewport.
3. **Otherwise** → use `rangeHours` rolling window.

#### Data transformation

```js
toUPlotData(series) {
    // [{tagPath, points:[{t,v}]}] → [tsSec[], vals0[], vals1[], ...]
    // All arrays aligned to a single timestamp spine (union of timestamps).
}

_mergeLiveEndpoint(series, liveValues) {
    // Append { t: Date.now(), v: liveVal } to each series so the line moves
    // even when the historian bucket hasn't shifted yet.
}

expandYRange(series) {
    // Grow _yMin/_yMax to cover any new values. Never shrinks.
}

computeStats(series, liveValues) {
    // Per-series Current/Min/Max/Avg for the legend table.
}
```

uPlot's data format is one big rectangular array: `[timestamps, valuesSeries0, valuesSeries1, ...]`. All series share one timestamp axis, with `null` for missing points. `toUPlotData` does the conversion from our per-series shape.

`_mergeLiveEndpoint` is a polish trick. Historian buckets are aligned to round time boundaries — between two refresh ticks the historian often returns the same points and the line looks frozen. Appending one synthetic point at `Date.now()` per tag (with the live value from `/readTags`) makes the line move every tick. It's skipped in historical mode, where there is no live "now" to append.

#### Lifecycle: load + refresh

```js
initialLoad() {
    this.stopTimer();
    this._yMin = null; this._yMax = null;
    // sync _zoomedMin/Max with custom range, or clear
    this.setState({ status: 'loading', error: null });
    this.fetchData()
        .then(result => Promise.all([result, this.fetchCurrentValues(result.tagPaths)]))
        .then(([{ tagPaths, series }, liveValues]) => {
            this.setState({
                status: tagPaths.length === 0 ? 'empty' : 'ready',
                trendListPaths: tagPaths,
                lastSeries: series,
                seriesStats: this.computeStats(series, liveValues),
            }, () => this.startTimer());
        })
        .catch(err => this.setState({ status: 'error', error: ... }));
}

silentRefresh() {
    if (this.getMode() !== 'realtime') return;
    this.fetchData().then(/* parallel with fetchCurrentValues */)
        .then(([{ tagPaths, series }, liveValues]) => {
            // Update stats. If series count changed, recreate the chart.
            // Otherwise call _applyDataAndSlide.
        });
}
```

`silentRefresh` has one critical guard:

```js
if (this.uplot.series.length - 1 !== series.length) {
    this.createChart(this._mergeLiveEndpoint(series, liveValues));
    return;
}
```

uPlot silently breaks (and stops all future updates) if `setData` gets a different number of arrays than the chart was built with. Series count changed = recreate the chart instead. This is what makes "add a pen → see it on the chart" work.

#### `_applyDataAndSlide` — the heart of realtime mode

```js
_applyDataAndSlide(series) {
    if (!this.uplot) return;
    const uData = this.toUPlotData(series);
    this._suppressScaleHook = true;
    this.uplot.batch((u) => {
        u.setData(uData, false);     // 'false' = skip auto-fit
        if (this._zoomedMin != null) {
            u.setScale('x', { min: this._zoomedMin, max: this._zoomedMax });
        } else {
            const nowSec = Date.now() / 1000;
            u.setScale('x', { min: nowSec - this.getRangeHours() * 3600, max: nowSec });
        }
    });
    this._suppressScaleHook = false;
}
```

This shape exists because of three uPlot quirks. `setData(data, false)` updates buffers *without* committing or redrawing. `setScale` outside a batch commits immediately. Wrapping both in `batch` produces one commit and one redraw — and `setData(false)` skips the auto-fit pass that would otherwise fight our explicit `setScale`. The suppress flag ensures the user-gesture hook doesn't capture this as zoom.

#### uPlot configuration (`buildUPlotOpts`)

Constructed fresh on each `createChart`. Key bits:

- `scales.x.auto: false` — disable uPlot's auto-fit so it doesn't fight our `setScale`.
- `scales.y.range` — returns `[_yMin - pad, _yMax + pad]` with 5% padding when our grow-only range is set.
- `cursor.drag` — `{ x: iMode === 'zoom', y: false, setScale: iMode === 'zoom', dist: 0, uni: null }`. **`dist: 0` is non-negotiable** — uPlot does a partial-merge on the default `drag` object, and without it the rawDX check never fires and drag-to-zoom doesn't arm.
- `hooks.setCursor` → `_updateTooltip` — moves the floating X-Trace tooltip.
- `hooks.setScale` → captures user-initiated zoom/pan into `_zoomedMin/Max` (but only when `_suppressScaleHook` is false).

#### `createChart` — mounting uPlot

```js
createChart(series, opts) {
    this._destroyChart();
    // ... maybe clear _zoomedMin/Max ...
    loadUPlot().then(UPlot => {
        // ... build wrapper div, build opts, build data ...
        this._suppressScaleHook = true;
        this.uplot = new UPlot(opts, data, wrap);
        // ... attach tooltip overlay, set cursor style, attach pan listeners ...
        if (this._zoomedMin != null) {
            this.uplot.setScale('x', { min: this._zoomedMin, max: this._zoomedMax });
        } else {
            const nowSec = Date.now() / 1000;
            this.uplot.setScale('x', { min: nowSec - this.getRangeHours() * 3600, max: nowSec });
        }
        this._suppressScaleHook = false;
    });
}
```

The `_suppressScaleHook` flag wraps both the **constructor** and the **first explicit `setScale`**. If we lift the suppress between them, the constructor's own `setScale` commit gets captured as a user gesture and `_zoomedMin/Max` get pinned to the auto-derived range — the chart then never slides.

#### Interaction modes

Drag-to-zoom is handled natively by uPlot (`cursor.drag.x` + `setScale: true`). The other two modes are custom DOM listeners attached to the wrapper div:

```js
_setupPanListeners(wrap) {
    this._onPanMouseDown = (e) => {
        if (this.state.interactionMode !== 'pan') return;
        this._panState = { startX: e.clientX, scaleMin: xs.min, scaleMax: xs.max };
    };
    this._onPanMouseMove = (e) => {
        if (!this._panState) return;
        const dx = e.clientX - this._panState.startX;
        const span = this._panState.scaleMax - this._panState.scaleMin;
        const dSec = -(dx / plotW) * span;
        // ... compute new min/max, suppress hook, setScale ...
    };
    this._onPanWheel = (e) => {
        // ... cursor-focal zoom with clamped span ...
    };
    // ... addEventListener ...
}
```

Pan-drag computes a time-delta from pixel-delta and shifts the x scale. Wheel-zoom uses the cursor's x position as the focal point. Both wrap `setScale` in the suppress flag.

#### Interaction-mode switching

```js
handleInteractionModeChange = (iMode) => {
    // capture current x viewport so we can restore it after the chart is recreated
    let xMin = null, xMax = null;
    if (this.uplot && this.uplot.scales.x) { /* read x.min, x.max */ }
    this.setState({ interactionMode: iMode }, () => {
        if (xMin != null) { this._zoomedMin = xMin; this._zoomedMax = xMax; }
        this.createChart(/* series */, { preserveXViewport: !!xMin });
    });
};
```

We have to recreate the chart because `cursor.drag` is baked in at construction time. To keep the user from losing their zoom when switching modes, we capture the current x viewport before the recreate and restore it after.

#### `_syncChartSize`

```js
_syncChartSize() {
    if (!this.uplot || !this.chartEl) return;
    const w = this.chartEl.clientWidth;
    const h = this.chartEl.clientHeight;
    if (w > 0 && h > 0 && (w !== this.uplot.width || h !== this.uplot.height)) {
        const prevSuppress = this._suppressScaleHook;
        this._suppressScaleHook = true;
        try { this.uplot.setSize({ width: w, height: h }); }
        finally { this._suppressScaleHook = prevSuppress; }
    }
}
```

Called by a `ResizeObserver`. `setSize` internally fires `setScale`, so we wrap it in suppress to avoid capturing the resize as a user gesture. The `try/finally` restores the previous suppress value, which matters if we're already inside another suppressed section.

#### React lifecycle

```js
componentDidMount() {
    this.initialLoad();
    this._onTrendListChanged = () => this.initialLoad();
    window.addEventListener('ctg-trend-list-changed', this._onTrendListChanged);
    if (window.ResizeObserver) {
        this._resizeObserver = new ResizeObserver(() => this._syncChartSize());
    }
}

componentDidUpdate(prevProps, prevState) {
    // Restart timer if mode or refreshRate changed
    // Mount chart after loading/empty → ready transition
    // Attach ResizeObserver once chartEl exists
}

componentWillUnmount() {
    this.stopTimer();
    this._destroyChart();
    window.removeEventListener('ctg-trend-list-changed', this._onTrendListChanged);
    if (this._resizeObserver) this._resizeObserver.disconnect();
}
```

Two-stage mount: `componentDidMount` kicks off `initialLoad`, which eventually sets `status: 'ready'`. The render then produces the chart container `<div>` with `ref={this.setChartEl}`, which fires `setChartEl(el)`. Then `componentDidUpdate` sees `prevState.status !== 'ready' && this.state.status === 'ready' && this.chartEl && !this.uplot` and calls `createChart`.

**Async robustness.** Like `SimpleTagDisplay`, the chart sets an `_isMounted` flag in `componentDidMount` and clears it in `componentWillUnmount`; every `.then()` in `initialLoad` / `silentRefresh` / `fetchCurrentValues` bails out early when `_isMounted === false`, so a fetch that resolves after unmount can't call `setState` on a dead component. A transient failure during `initialLoad` schedules an auto-retry (guarded by `_isMounted`) rather than leaving the chart stuck on an error, and the `ResizeObserver` is re-attached after a chart reload so resizing keeps working once a pen is added/removed and the chart is rebuilt.

#### Toolbar and modal

`renderToolbar` builds the toolbar pills programmatically: the date-range pill (`getDateRangePreviewText()` builds its label), refresh-rate input, X-Trace / Pan / Zoom buttons, ↺ Refresh, Reset zoom. Each respects the matching `visibility.*` prop.

`renderDateRangeModal` is the two-tab modal:
- **Realtime tab** — number input + unit dropdown. Apply calls `ctgRollingToHours()`, clears `_customStartMs/EndMs`, sets `runtimeRangeHours`, calls `initialLoad()`.
- **Historical tab** — two `<input type="datetime-local">`. Apply sets `_customStartMs/EndMs`, switches `runtimeMode` to historical, calls `initialLoad()`.

`renderLegend` is the stats table. Each row has a colored dot (matching `CTG_PALETTE[i]`), the tag name, formatted Current/Min/Max/Avg, and an `×` button that calls `handleRemovePen` → `/removeFromTrendList` → `initialLoad`.

#### The render output

```js
render() {
    // ... toolbar always, body based on status, legend only when 'ready', modal if open ...
    return React.createElement('div', { ...emittedProps, style: containerStyle },
        this.renderToolbar(),
        body,
        status === 'ready' ? this.renderLegend() : null,
        this.renderDateRangeModal(),
    );
}
```

`body` is one of: `Loading…` div, error message, "No tags in trend list" placeholder, or the chart container with `ref={this.setChartEl}`. The chart container is the only place uPlot mounts; everything else is plain React.

---

## Cross-cutting bits

### The `ctg-trend-list-changed` event

This is the **only** runtime coupling between the two components. It's a plain DOM `CustomEvent` on `window`:

```js
// In SimpleTagDisplay (onTrendTagClick / onRemoveTagClick):
window.dispatchEvent(new CustomEvent('ctg-trend-list-changed'));

// In CtgChart.componentDidMount:
window.addEventListener('ctg-trend-list-changed', () => this.initialLoad());
```

Every `CtgChart` on the same page receives the event and reloads — no polling delay between the click and the chart updating.

### The dual-URL fallback

Every `fetch` call has the same pattern:

```js
const urlsToTry = [
    '/data/simpletagdisplay/...',
    '/main/data/simpletagdisplay/...'
];
```

Some Perspective session contexts route data routes under `/main/...`, some don't. Trying both in sequence is uglier than figuring out the right one per environment, but it's robust against deployment differences. If you ever want to clean this up, log which one wins in your environments first.

### Why so much `_suppressScaleHook` plumbing?

uPlot has a unified `setScale` hook that fires on:
- User drag-zoom (good — we want to capture this)
- User pan (good — we want to capture this)
- `setSize` calls (bad — internal mechanism, not user)
- `setData(data, true)` (bad — internal auto-fit)
- The constructor's first commit (bad)
- Our own explicit `setScale` in `_applyDataAndSlide` (bad — we *just* told it where to go)

The flag is the cheapest way to distinguish them. The pattern is always: set true, do the programmatic call(s), set false. The `_syncChartSize` `try/finally` exists because that method can be called inside another suppressed section.

---

Next: [05-building.md](05-building.md) for how to compile this into a `.modl`.
