<!-- nav:top -->

[Docs home](../../../README.md) › [User Guide](../../README.md) › **Click To Graph Chart**

<!-- /nav:top -->

# Click To Graph Chart

The **Click To Graph Chart** is a trend chart in the style of the Power Chart. It shows the pens you configure **plus**
every tag users trend with a [Display Template](../display-template/README.md)'s **Trend Tag** ("click to graph"). It
is built on the bundled uPlot library, so it needs no internet access.

| | |
|---|---|
| Palette category | **Display** |
| Palette entries | *Click To Graph Chart*, *Click To Graph Chart (Tag browser open)* |
| Default instance name | `CTG-Chart` |
| Component ID | `com.example.simpletagdisplay.CtgChart` (unchanged since 1.x) |
| Minimum configuration | none: with the defaults it shows the session trend list `"default"`, last 8 hours, live |

**On this page**

- [Pages about this component](#pages-about-this-component)
- [What it shows](#what-it-shows)
- [Palette variants](#palette-variants)
- [Click to graph: how a tag gets onto the chart](#click-to-graph-how-a-tag-gets-onto-the-chart)
- [Where pens come from](#where-pens-come-from)
- [Read scope: which tags a chart may read](#read-scope-which-tags-a-chart-may-read)
- [Time range and refresh](#time-range-and-refresh)
- [States, errors and the badge](#states-errors-and-the-badge)
- [Outputs for bindings and scripts](#outputs-for-bindings-and-scripts)
- [Designer vs runtime](#designer-vs-runtime)

## Pages about this component

| Page | What is in it |
|---|---|
| [Interaction](interaction.md) | X-Trace, pan, zoom, range brush, notes, the range selector strip, keyboard and touch, following live, fullscreen |
| [Pens, axes and plots](pens-axes-plots.md) | pen options, curve types, per-state styles, automatic and named axes, stacked plots, aggregation, raw vs aggregated data, point caps, chunked loading |
| [Panels and tools](panels-and-tools.md) | pen table and statistics, settings panel, tag browser and *Search all folders*, date range dialog, export, annotations, styling |
| [Recipes](recipes.md) | step-by-step setups: trend page, fixed pens, two axes, stacked plots, historical report, scoped tag browser |
| [Properties](properties.md) | **every** prop: path, type, default, valid values, what it does, examples |
| [Events](events.md) | the four component events, their payloads and script examples |

---

## What it shows

A simplified sketch of the parts and the props that control them:

```
 ┌───────────────────────────────────────────────────────────────┐
 │ [Last 8 hours ▾]  X-Trace Pan Zoom Range  ⟳ ⤢ ⚙ ≡     ● Live  │  ← toolbar (toolbar.*) and badge
 │ ┌───┬─────────────────────────────────────────────────────┐   │
 │ │ 80│        ╱╲      ╱╲                                    │   │  ← plots (plots[]), pens (pens[]),
 │ │ 40│ ──────╱  ╲────╱  ╲──────────                         │   │    axes (axes[]), time axis (timeAxis)
 │ └───┴─────────────────────────────────────────────────────┘   │
 │ [ overview strip ]                                            │  ← range selector (rangeSelector, off by default)
 │ ☑ ■ Tank1/Level   72.4 %   min 12.0  max 80.1  avg 45.3       │  ← pen table (penTable)
 └───────────────────────────────────────────────────────────────┘
```

## Palette variants

| Palette entry | Starts with |
|---|---|
| Click To Graph Chart | the defaults: no configured pens, shows the session trend list `"default"`, last 8 hours, live, tag browser available from the toolbar |
| Click To Graph Chart (Tag browser open) | `tagBrowser.openOnStart: true`: the tag browser opens when the view starts with an empty chart |

## Click to graph: how a tag gets onto the chart

1. A Display Template and the chart sit in the same Perspective session (any view, any browser tab of that session)
   and share a `trendGroup` (both default to `"default"`).
2. The operator right-clicks the display and picks **Trend Tag**.
3. The gateway adds the tag to that session's trend list and pushes the change to every chart of the group: the pen
   appears with its history and live value. No polling, no page reload.
4. **Remove from Trend** on the display, or the trash icon in the chart's pen table, takes it off again.

The operator can also add tags from the chart itself with the **tag browser** (≡), see
[Panels and tools](panels-and-tools.md#tag-browser).

## Where pens come from

A chart shows the union of two sources, configured pens first:

| Source | Configured in | Stored in | Removed by |
|---|---|---|---|
| **Pens** | the Designer (`pens[]`), or at runtime through the settings panel or tag browser (`tagBrowser.addTo: "pens"`) | the `pens` prop of this component | editing `pens`, or the pen table's trash icon |
| **Session trend list** | **Trend Tag** on a Display Template, or the chart's tag browser with `tagBrowser.addTo: "trendList"` / `"auto"` | the gateway, per Perspective session and `trendGroup` | **Remove from Trend**, the pen table's trash icon, Settings > Pens > Clear list |

- Every chart and display with the same `trendGroup` in the same session shares one list, in every browser tab of the
  session. `trendGroup: ""` or `null` makes a chart ignore the trend list. A list holds at most `ctg.trend.maxPens`
  tags (32).
- Trend pens are styled by `trendPens.defaults`; a user who restyles one at runtime writes an entry in
  `trendPens.overrides` (matched on the tag path, case-insensitive). Limitation: while `trendPens.defaults.axis`,
  `.plot` or `.display` is set, a trend pen cannot be put back on the automatic axis, the first plot or the built-in
  line style (an override that stores those reads as "not set", so the defaults apply). The Settings pen editor greys
  those choices out and says why; change `trendPens.defaults` instead.
- Edits made at runtime (settings panel, tag browser, date range, pen colours) are prop writes: they last for the page
  and are **not** saved into the view, except when made in a Designer preview.
- Who may change the trend list *from the chart* is `trendEdit` **[S]**. The display's own **Trend Tag** is governed
  by its `menu.trend` rule.
- Only numeric and Boolean tags with history can be trended. A tag without history shows its live value in the pen
  table's **Current** column (while the chart follows live) but draws no line. String tags show *Only numeric and
  Boolean tags can be trended*.
- A view still holding v1 chart props (`rangeHours`, `rawHistory`, `refreshRate`, `visibility`, …) shows v2 defaults; the
  browser console warns once per view and the Designer shows a small badge *v1 props: run tools/migrate-v1-views.mjs*
  ([Upgrading from 1.x](../../upgrading-from-v1.md)).

## Read scope: which tags a chart may read

Configured pens and the session trend list are always allowed. **Runtime pens** (added in the settings panel or tag
browser, or written into `pens` by a browser) must pass `readScope` **[S]**, checked on the gateway for the pen
list, live values and history:

1. `readScope.allowRuntimePens` must be true (default).
2. The provider must not be in `ctg.read.deniedProviders` (default `System`).
3. The path must be under one of `readScope.allowedRoots`. Empty roots mean: `tagBrowser.rootPath` when the tag browser
   is enabled (all providers when that is empty too); with the tag browser off, **no** runtime pens. The tag browser is
   **on by default** (Power Chart parity), so a default chart may add runtime pens from every provider except
   `ctg.read.deniedProviders`, always with the user's own Read Permissions. Set `tagBrowser.rootPath` or
   `readScope.allowedRoots` to narrow it, or `tagBrowser.enabled: false` to turn both off.

A pen outside the scope shows *not allowed on this chart* and gets no subscription, metadata or history. Tag Read
Permissions apply to every pen in every case.

Two consequences to know:

- **A pens binding is configuration.** `pens` bound to a view parameter or a custom prop is adopted as configured pens,
  so it is outside the read scope, the same as a Perspective tag binding on that parameter would be. Tag Read
  Permissions still apply. The same is true for a Designer script that rewrites `pens` from its current value.
- **The scope is shared through the trend group.** Each tag in a session trend list was admitted by the scope of the
  chart or display that added it, and every chart of the group shows the whole list. A chart's effective scope is the
  union over its trend group. To isolate a narrowly scoped chart, give it its own `trendGroup` (or `null`).

See [Security and permissions](../../security-and-permissions.md#chart-read-scope).

## Time range and refresh

`timeRange.mode: "realtime"` (default) shows the last `timeRange.realtime` (default 8 hours) and refreshes every
`timeRange.refreshRate` ms (default 1000; 0 = off; 1–249 → 250). Each refresh asks only for samples newer than the last
one held: one small request per chart per tick, skipped while the previous one runs or the browser tab is hidden. Months
and years are calendar months and years in the chart's time zone.

`"historical"` shows `timeRange.historical.startDate` to `endDate` (bindings may supply epoch ms or ISO-8601 strings;
an end in the future is clamped to now). No refresh.

The toolbar's date pill opens the [date range dialog](panels-and-tools.md#date-range-dialog); applying it writes
`timeRange`.

The chart's time zone is `timeAxis.timeZone`: `session` (default, `session.props.timeZoneId`, followed live), `browser`,
`gateway` or an IANA name. The chart uses the **gateway's clock**, so a client whose clock is off by minutes still shows
the right window.

The gateway limits the span: 400 days aggregated and 31 days raw by default (`ctg.history.maxRangeDays`,
`ctg.history.maxRawRangeDays`). A longer realtime window is clamped with a notice.

## States, errors and the badge

The toolbar badge (`appearance.liveBadge`) shows:

| Badge | Meaning |
|---|---|
| **Live** (green) | following the current time |
| **Paused** | panned into the past; a *Return to live* chip brings it back |
| **Historical** | a fixed time range |
| **Loading** | the first data is on its way |
| **Stale since hh:mm:ss** (amber) | no successful update for `appearance.staleAfterMs` (default 3 × the refresh rate, at least 10 s) |
| **Disconnected** (grey) | the connection to the gateway is lost; refreshing resumes by itself |

Errors appear as a banner above the plot (*History query failed (HISTORY_QUERY_FAILED), retrying.*, *Not authorised
for history*, *Module updated — reload the page*) or in the affected pen's row. Failed loads retry by themselves with a growing
delay (2 s, or 5 s after a timeout, doubling up to 60 s; up to 30 s after a network error); a realtime chart never
stops retrying. See [Troubleshooting](../../troubleshooting.md#click-to-graph-chart).

## Outputs for bindings and scripts

`outputs` is written by the chart (never in the Designer) and only when something changes:

| Output | Content |
|---|---|
| `outputs.range` | `{start, end, followLive}` of the visible window after a gesture ends |
| `outputs.status` | `{state, message, lastUpdate}`; state is `loading`, `live`, `paused`, `historical`, `stale`, `error` or `empty`; `lastUpdate` at most every 10 s |
| `outputs.pens` | `[{key, tagPath, name, source, visible, status}]` for every effective pen |

Example: a label bound to `{../CTG-Chart.props.outputs.status.state}` shows the chart state.

## Designer vs runtime

| Situation | Behaviour |
|---|---|
| Designer, design mode | looks like runtime: data loads and refreshes, the toolbar, badge, pen table (with its colour, edit and remove buttons, shown disabled) and a tag browser that opens on start (its frame, with a design-mode notice) are all drawn; no gestures, menus, panels or prop writes, no events. |
| Designer, preview | runtime behaviour, but the chart does not write `outputs`, pinned traces, brushes or `interaction.fullscreen` (so previewing does not change the view). Edits you make on purpose (settings, date range, pens) are written. Notes need the Read/Write communication mode. |
| Runtime | everything |
| `enabled: false` | viewing only: zoom, pan, X-Trace, range brush, date range and export work; settings, adding and removing pens, the colour picker, notes and trend list changes do not. The tag browser still browses but cannot add. |

The Designer preview and a manual checklist for it are on the [Designer page](../../designer.md#click-to-graph-chart).

<!-- nav:bottom -->

---

← Previous: [Events](../display-template/events.md) · [Back to index](../../README.md) · Next: [Interaction](interaction.md) →

<!-- /nav:bottom -->
