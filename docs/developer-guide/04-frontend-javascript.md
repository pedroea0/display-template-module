<!-- nav:top -->

[Docs home](../README.md) › [Developer Guide](README.md) › **Frontend JavaScript**

<!-- /nav:top -->

# 04 — Frontend JavaScript

A tour of the five browser files under `simple-tag-display/gateway/src/main/resources/mounted/js/`. Read
[JavaScript primer](02-javascript-primer.md) first if JavaScript is new to you. Each file starts with a header
comment (what it does, a section map, the design choices behind it) and is divided into `SECTION n` banners; this page is the map
across files.

**On this page**

- [Files and sizes](#files-and-sizes)
- [`ctg-common.js`: the shared library](#ctg-commonjs-the-shared-library)
- [`display-template.js`](#display-templatejs)
- [`ctg-chart.js`](#ctg-chartjs)
- [`ChartApi`: the facade for panels](#chartapi-the-facade-for-panels)
- [`ctg-chart-tools.js` and `ctg-chart-panels.js`](#ctg-chart-toolsjs-and-ctg-chart-panelsjs)
- [Styles and theming](#styles-and-theming)
- [Tests](#tests)

---

## Files and sizes

| File | Part | Lines | Contents |
|---|---|---|---|
| `ctg-common.js` | `common` | ~3 500 | namespace and load queue, utilities, formatting, time zones, gateway clock, connection watchdog, delegate base class, overlay manager and UI kit, theme tokens, i18n |
| `display-template.js` | `display` | ~3 100 | the Display Template: reducer, pure evaluation, stylesheet, delegate, dialogs, component |
| `ctg-chart.js` | `chart` | ~8 900 | the chart: reducer, query planning, merge, statistics, history client and queue, engine, delegate, plots (uPlot), `ChartApi`, interaction, component |
| `ctg-chart-tools.js` | `chartTools` | ~1 350 | date range dialog, colour picker, export menu (CSV/PNG) |
| `ctg-chart-panels.js` | `chartPanels` | ~3 200 | settings panel (Pens/Axes/Plots/Columns), tag browser, annotation editor |
| `uplot.min.js`, `../css/uplot.min.css` | – | – | uPlot 1.x, loaded lazily by the chart |

The add-on files register panels into the chart when they load; a toolbar button appears once its panel is registered,
so the chart works (without those panels) even if an add-on failed to load.

## `ctg-common.js`: the shared library

Pure helpers (also loaded by the Node tests):

| Namespace | What |
|---|---|
| `NS.util` | `clamp`, `looseEqual` (option matching: `"1"` ≡ `1`, `true` ≡ `1`), `debounce`, `rafThrottle`, `uid`, `shortTagName`, `normKey` (lower-case normalized tag key), `normTrendGroup`, `framedCrossOrigin()` |
| `NS.format` | `number(v, pattern, locale)` (Perspective's own NumberFormat with an `Intl` fallback), `value(enc, opts)` (the value text rules), `parseInput(text, dataType, locale)` (strict setpoint parsing: grouping separators refused, type ranges checked) |
| `NS.time` | `format(ms, pattern, tz)` with tokens `YYYY YY MMMM MMM MM M DD D HH H hh h mm ss SSS A ZZ`, `zonedToEpoch`, `resolveZone`, `subtractCalendar` (months/years in a zone) |
| `NS.quality`, `NS.alarm` | quality level of a pushed quality; alarm priority names ↔ 0..4 |
| `NS.props` | reducer helpers: deep merge over defaults, coercion, `style(tree, path)`, colour hygiene (`CSS.supports`) |
| `NS.i18n` | `register(part, table)`, `t(key, vars, part)`, `errorText(code, details)` |
| `NS.log(name)` | named console logger; `debug` only with `localStorage['ctg.debug'] === '1'`; redacts history tokens |
| `NS.clock` | page-wide gateway clock: `sample`, `now()`, `offset` (median of the last five samples) |

Browser runtime:

| Namespace | What |
|---|---|
| `NS.delegate.CtgDelegateBase` | browser half of the protocol: hello/resync, epoch and seq checks, `request(name, body, {timeoutMs})` that never rejects, idempotent request ids, stale state (`d.stale`, `d.staleReason`) |
| `NS.conn` | Perspective connection state (`get`, `subscribe`) and the page watchdog (`ctg.ping` every 15 s, stale after 8 s) |
| `NS.overlay` | one open overlay per page (opening a menu closes other menus and popovers; a bubble replaces only bubbles) |
| `NS.ui` | `Portal` (to `document.body` inside `.ctg-portal-guard`), `Menu`, `Dialog`, `Popover`, `Confirm`, `Bubble`, `Toast`, `longPress`, `Spinner`, `Choice`, `Field`, `Button`, `FocusTrap` |
| `NS.nav` | `openPopup(store, cfg)` (with `viewParams`), page navigation |
| `NS.theme` | shared `--ctg-*` tokens on `:root`, `ensureStyles(id, css, build)`, `tokens(el)`, `isDark()`, `onChange(store, cb)`, `contrast()` |
| `NS.resize`, `NS.a11y`, `NS.events` | one shared `ResizeObserver`; one screen-reader live region; guarded component-event firing (no-op when events are disabled) |
| `NS.registerComponent(meta)` | guarded `ComponentRegistry.register` |

`ctg-common.js` is a frozen contract shared by both components: add to it only with care, and never change a name.

## `display-template.js`

| Section | Contents |
|---|---|
| 1 | strings (`NS.i18n` part `display`) |
| 2 | `DT_DEFAULTS`, field rules, props reducer, v1 prop detection |
| 3 | pure evaluation (`NS.dt.*`, Node-tested): value text, bounds, alarms, data state, write guards, step guard, menu model |
| 4 | the `ctg-dt-styles` sheet: tokens and `:where()` rules in precedence order |
| 5 | `DisplayTemplateDelegate`: snapshot merge, `write`, `configEdit`, `trendAdd/Remove`, `auditQuery` |
| 6–9 | React pieces, `DtSetpointDialog`, `DtConfigDialog`, `DtHistoryDialog` |
| 10 | `DisplayTemplate`: data state, interaction state machine (idle, menu, dialog, editing, writing), render |
| 11 | component meta and registration |

The **data state** (`NS.dt.resolve`) is derived, never stored: `CONNECTING`, `UNCONFIGURED`, `INVALID_PATH`,
`NOT_FOUND`, `ACCESS_DENIED`, `LOADING`, `LIVE` (with good / uncertain / bad / error quality), plus an orthogonal
**stale** flag (connection lost, no welcome, protocol reload pending, resync pending, watchdog). Menu items and editing
are guarded by `eventsEnabled && enabled && !stale` and the gateway's advisory `capabilities`. In the Designer's design
mode `writeGuard` returns the runtime **look** (`preview: true`): the setpoint colour and style show from the props, and
reasons that depend on the viewer (`LOADING`, `DESIGNER_READ_ONLY`, `AUTH_REQUIRED`, `FORBIDDEN_ROLE`, `WRITE_DENIED`)
do not grey it out, while `_checkGuard` refuses every action. A capability carrying `setting` (a gateway floor setting
refused) is worded with that setting's name (`gatewaySettingText`).

## `ctg-chart.js`

| Sections | Contents |
|---|---|
| 1–2 | strings; schema mirror and `reduceProps` |
| 3 | time windows, the bucket ladder, `planQuery`, the adaptive raw chunk planner |
| 4–5 | series views, k-way merge into uPlot columns, statistics (time-weighted average, held values) |
| 6–7 | `NS.chart.historyQueue` (page-wide, priorities `user` > `chunk` > `tick`, mirrors the gateway's token bucket and concurrency) and `HistoryClient` (POST with the token; the token lives in a module-private `WeakMap`) |
| 8–9 | `SeriesStore` (columnar data per data key + live buffer), `ChartEngine` (full loads, incremental ticks, viewport, follow-live, stale state, retries) |
| 10–11 | panel registry; `CtgChartDelegate` (pens, values, tokens, trend list) |
| 12–14 | render model (pen view-models, colours, automatic axes, y ranges), `NS.chart.loadUPlot()`, `PlotManager` (one uPlot instance per stacked plot) |
| 15 | `ChartApi` (below) |
| 16–17 | `ctg-chart-styles` sheet, small React pieces |
| 18 | `ChartInteraction`: gestures per mode, wheel/pinch, keyboard, X-Trace pins, range brushes, annotation gestures |
| 19–20 | the `CtgChart` component (toolbar, badge, banners, plots, pen table, outputs); meta and registration |

Every timestamp in the engine is **gateway** epoch ms (`NS.clock.now()`), never the browser clock.

## `ChartApi`: the facade for panels

The add-on files never touch engine internals. A panel receives an `api` object in `render(api, args, close)`; its
members are a frozen contract (`NS.chart.CHART_API_MEMBERS`, checked by `tests/js/chart-api.test.mjs` against the real
chart and against the stub `tests/js/_chartApiStub.mjs`):

| Member | Purpose |
|---|---|
| `id`, `props()`, `pens()`, `penInfo(key)`, `axesInUse()`, `limits()`, `timeZone()`, `now()`, `status()` | read the chart (reduced props, pen view-models in gateway order, gateway limits, gateway time) |
| `write(rootKey, value)` | whole-object write of one root prop; refused (returns false) in design mode, for unknown keys, for the security keys (`enabled`, `trendGroup`, `trendEdit`, `readScope`, `tagBrowser`, `annotations`) and for `outputs` |
| `patch(rootKey, fn \| partial)` | the same, but built from the **raw** prop value, so unknown keys survive and untouched defaults are not written into the view |
| `viewport.get()`, `.set({min, max})`, `.reset()` | the visible window |
| `request(name, body, {timeoutMs})` | delegate requests, allow-listed: `chart.browse`, `chart.trendAdd`, `chart.trendRemove`, `chart.trendClear`, `chart.annotationSave`, `chart.annotationDelete` |
| `history.fetchRaw({start, end, penKeys, onProgress, signal})` | raw history through the page queue (`{pens, downgraded, window}`) |
| `series.rows({source, layout, penKeys, includeQuality})` | real samples as rows (CSV export) |
| `plots.snapshot({scale, includeLegend})` | a canvas of the plots (PNG export) |
| `tokens()`, `capabilities()` | theme tokens; what the user may do (`enabled`, `designMode`, `nativeApp`, `user`, `tagBrowser`, `trendEdit`, `readScope`, `annotations`, `settingsPanel`, `export`) |
| `panels.open/close/isOpen(name)`, `fireEvent(name, payload)`, `onChange(cb)`, `t(key, vars, part)` | panel control, the four chart events, change notifications, strings |

After the chart unmounts the members degrade gracefully (empty results, no-ops).

**Registering a panel:**

```js
NS.chart.panels.register('myPanel', {
  dock: 'right',                                   // 'left' | 'right' | 'none' (modals portal themselves)
  button: { label: 'Mine', title: 'My panel' },     // optional toolbar button that toggles it
  render: function (api, args, close) {
    return h('div', { className: 'ctg-chart__panel' }, api.t('my.title'), ' ', api.pens().length);
  },
});
```

Built-in slot names: `tagBrowser`, `dateRange`, `settings`, `export`, `color`, `annotation`.

## `ctg-chart-tools.js` and `ctg-chart-panels.js`

- **Tools** (`chartTools`): `DateRangeModal` (realtime/historical tabs, zone-aware date-time fields, presets),
  `ColorPicker` (palette, hex, native picker, default), `ExportMenu` (CSV model with injection guard, PNG). Export is
  hidden in the mobile app.
- **Panels** (`chartPanels`): `SettingsPanel` (Pens/Axes/Plots/Columns, drafts flushed as whole-object `api.patch`
  writes, editors follow their pen or plot by identity), `TagBrowser` (lazy tree, 100 entries per page, filter, "Search all folders" results list (`TagSearchModel`), multi-
  select, batch add), `AnnotationEditor` (add/edit/delete notes and ranges).

## Styles and theming

Each part injects one stylesheet once per page (`ctg-common-styles`, `ctg-dt-styles`, `ctg-chart-styles`, plus the
panels sheet), versioned by build, with every rule in `:where(...)`. Shared tokens live on `:root` and resolve through
the Perspective theme variables (`--callToAction`, `--label`, `--neutral-*`, ...), so light and dark themes work without
code. Overlays portal to `document.body` at `--ctg-z` (raised to 100000 so dialogs open above Perspective popups).
Display tokens and classes: [Display Template: styling](../user-guide/components/display-template/styling.md).

## Tests

`simple-tag-display/tests/js/*.test.mjs` run the pure parts of every file in Node with a minimal Perspective/React stub
(`_stubs.mjs`, extended per test through its factory). See [Building and testing](05-building.md#tests).

<!-- nav:bottom -->

---

← Previous: [Backend (Java)](03-backend-java.md) · [Back to index](README.md) · Next: [Building and testing](05-building.md) →

<!-- /nav:bottom -->
