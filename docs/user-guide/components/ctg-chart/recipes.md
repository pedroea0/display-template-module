<!-- nav:top -->

[Docs home](../../../README.md) › [User Guide](../../README.md) › [Click To Graph Chart](README.md) › **Recipes**

<!-- /nav:top -->

# Recipes

Step-by-step setups for common Click To Graph Chart tasks. Each recipe lists only the props that differ from the
defaults.

**On this page**

- [Click-to-graph trend page](#click-to-graph-trend-page)
- [One trend list per plant area](#one-trend-list-per-plant-area)
- [Fixed pens only (no trend list)](#fixed-pens-only-no-trend-list)
- [Two pens on two axes](#two-pens-on-two-axes)
- [Stacked plots: analog values over on/off signals](#stacked-plots-analog-values-over-onoff-signals)
- [High limit line and out-of-limit colouring](#high-limit-line-and-out-of-limit-colouring)
- [Historical report window from bindings](#historical-report-window-from-bindings)
- [Tag browser limited to one area](#tag-browser-limited-to-one-area)
- [A viewing-only chart](#a-viewing-only-chart)
- [Exact values instead of aggregated envelopes](#exact-values-instead-of-aggregated-envelopes)
- [Show the chart state elsewhere on the view](#show-the-chart-state-elsewhere-on-the-view)

---

## Click-to-graph trend page

1. Create a page `/trend` with a Click To Graph Chart. Leave its props at the defaults.
2. On the overview screens, use Display Templates (default `trendGroup: "default"`). Optionally add the menu item
   **Go to Trend Page**:

   ```json
   "menu": { "trendPage": { "enabled": true, "pagePath": "/trend" } }
   ```

3. Operators right-click values, pick **Trend Tag** (or **Go to Trend Page**), and the chart shows every tag they
   picked, in every tab of their session.

## One trend list per plant area

Give the displays and the chart of each area the same group, and different areas different groups:

```json
"trendGroup": "area1"
```

Each group is its own list per session (at most `ctg.trend.maxGroupsPerSession`, 16 by default). A chart only sees the
list of its own group.

## Fixed pens only (no trend list)

```json
"trendGroup": null,
"pens": [
  { "tagPath": "[default]Area1/Tank1/Level" },
  { "tagPath": "[default]Area1/Tank1/Temperature" }
],
"tagBrowser": { "enabled": false }
```

`trendGroup: null` ignores the session trend list; turning the tag browser off (with no `readScope.allowedRoots`) also
stops runtime pens, so the chart shows exactly these pens.

## Two pens on two axes

Pens with different engineering units already get separate automatic axes. To control the axes yourself:

```json
"axes": [
  { "name": "Level", "position": "left",  "range": { "mode": "manual", "min": 0, "max": 100 } },
  { "name": "Temp",  "position": "right", "range": { "mode": "engineering" } }
],
"pens": [
  { "tagPath": "[default]Area1/Tank1/Level",       "axis": "Level" },
  { "tagPath": "[default]Area1/Tank1/Temperature", "axis": "Temp" }
]
```

To put trend-list pens on a named axis: `trendPens.defaults.axis`.

## Stacked plots: analog values over on/off signals

```json
"plots": [ { "relativeWeight": 3 }, { "relativeWeight": 1 } ],
"pens": [
  { "tagPath": "[default]Area1/Tank1/Level" },
  { "tagPath": "[default]Area1/Pump1/Running", "plot": 1,
    "display": { "states": { "boolean": { "enabled": true, "onColor": "#2E7D32" } } } }
]
```

The top plot is three times as tall as the bottom one. The pump's running periods are shaded green.

## High limit line and out-of-limit colouring

```json
"plots": [
  { "markers": [ { "type": "line", "value": 90, "color": "#B54700", "label": { "text": "High 90" } } ] }
],
"pens": [
  { "tagPath": "[default]Area1/Tank1/Level",
    "display": { "states": { "outOfBounds": { "enabled": true, "source": "manual", "high": 90, "width": 3 } } } }
]
```

The line turns the warning colour (and 3 px wide) above 90. Keep `query.aggregation: "MinMax"` (the default) so short
spikes inside a bucket still show.

## Historical report window from bindings

```json
"timeRange": { "mode": "historical" },
"toolbar":   { "buttons": { "dateRange": false } }
```

Bind `timeRange.historical.startDate` and `endDate` to the report's parameters (epoch ms, a date, or an ISO-8601
string). An end in the future is clamped to now; a historical chart does not refresh.

## Tag browser limited to one area

```json
"tagBrowser": { "rootPath": "[default]Area1", "openOnStart": true }
```

Users browse and search only below `[default]Area1`, and runtime pens are limited to that folder too (the read scope
follows `rootPath` while `readScope.allowedRoots` is empty). To restrict who may browse:
`"access": { "roles": ["Engineer"] }`.

## A viewing-only chart

```json
"enabled": false
```

Zoom, pan, X-Trace, range brush, date range and export still work; settings, adding and removing pens, colours, notes
and trend list changes do not. For finer control, hide single buttons with `toolbar.buttons.*`, or limit trend list
changes with `trendEdit.access`.

## Exact values instead of aggregated envelopes

The default `MinMax` aggregation draws two values per bucket, which can look like an envelope. For a single line:

```json
"query": { "aggregation": "LastValue" }
```

For every stored sample (short windows only, up to the point caps): `"query": { "mode": "raw" }`, and
`"onTooManyPoints": "aggregate"` to fall back to aggregated data instead of an error when a pen has too many points.

## Show the chart state elsewhere on the view

Bind a Label's text to `{../CTG-Chart.props.outputs.status.state}` (`live`, `paused`, `historical`, `stale`, ...), or
`outputs.range.start` / `end` to drive another component with the visible window. The chart writes `outputs` only at
runtime and only when something changes.

<!-- nav:bottom -->

---

← Previous: [Panels and tools](panels-and-tools.md) · ↑ Up: [Click To Graph Chart](README.md) · [Back to index](../../README.md) · Next: [Properties](properties.md) →

<!-- /nav:bottom -->
