<!-- nav:top -->

[Docs home](../../../README.md) › [User Guide](../../README.md) › [Click To Graph Chart](README.md) › **Pens, axes and plots**

<!-- /nav:top -->

# Pens, axes and plots

What a pen is, how it is drawn, which axis and plot it uses, and how its history is queried. Every prop named here is
in the [property reference](properties.md).

**On this page**

- [Pens](#pens)
- [Curve types and pen states](#curve-types-and-pen-states)
- [Axes and plots](#axes-and-plots)
- [Colours](#colours)
- [History queries: aggregation, caps and chunked loading](#history-queries-aggregation-caps-and-chunked-loading)
- [Gateway fairness](#gateway-fairness)

---

## Pens

A **pen** is one tag drawn on the chart. Configured pens live in `pens[]`; trend-list pens come from the session trend
list and are styled by `trendPens` ([where pens come from](README.md#where-pens-come-from)).

```json
"pens": [
  { "tagPath": "[default]Area1/Tank1/Level", "name": "Level", "color": "#1F77B4" },
  { "tagPath": "[default]Area1/Pump1/Running", "display": { "type": "step" }, "plot": 1 }
]
```

| Option | Props | Notes |
|---|---|---|
| Name, units, format | `pens[].name`, `units`, `format` | empty = the tag's name, EngUnit and FormatString |
| On / off | `pens[].enabled`, `visible` | a disabled pen is not queried at all; a hidden pen is queried and listed (greyed) so it can be switched back on instantly |
| Where | `pens[].axis`, `plot` | an axis name from `axes[]` (empty = automatic) and a plot index from `plots[]` |
| How | `pens[].display.*` | type, curve, width, dash, fill, point radius, per-state styles (below) |
| Aggregation | `pens[].aggregation` | overrides `query.aggregation` for this pen ([below](#history-queries-aggregation-caps-and-chunked-loading)) |

**Boolean pens.** A Boolean pen is drawn as a step line on its own 0/1 axis while its values are 0/1: raw data, or the
aggregations LastValue, Minimum, Maximum and MinMax. A Boolean pen with a statistic aggregation (DurationOn/Off,
CountOn/Off, Count, Sum, Average…) is a number: it gets a normal axis and a line.

**Statistic aggregations.** `pens[].aggregation` applies while the chart is aggregated. A statistic aggregation (Range,
Count, Sum, StdDev, Variance, DurationOn/Off, CountOn/Off, PctGood/Bad) keeps `query.mode: "auto"` aggregated even when
zoomed in, takes no live tag values (its *Current* is the newest bucket), and stays approximate in the exact brush
statistics; with `query.mode: "raw"` it does not apply.

## Curve types and pen states

**Display types** (`pens[].display.type`): `line`, `area`, `bar`, `scatter` and `step` (a line that holds each value until
the next sample). Boolean pens are drawn as steps on a 0/1 axis unless they choose a curve.

**Curve types** (`display.interpolation`, line and area pens) cover all 13 curves of the Power Chart, plus `spline`:

| Power Chart | `interpolation` | Shape |
|---|---|---|
| `curveLinear` | `linear` | straight lines between samples (default; fastest) |
| (none) | `spline` | smooth, never overshoots the samples (uPlot's monotone spline) |
| `curveMonotoneX` | `monotoneX` | smooth through every sample, never overshoots (d3's method) |
| `curveStepAfter` | `stepAfter` | holds each value until the next sample |
| `curveStepBefore` | `stepBefore` | shows each value from the previous sample on |
| `curveStep` | `stepCenter` | changes half-way between two samples |
| `curveCatmullRom` | `catmullRom` | smooth through every sample (centripetal, no loops) |
| `curveCardinal` | `cardinal` | smooth through every sample (tension 0) |
| `curveNatural` | `natural` | natural cubic spline through every sample |
| `curveBasis` | `basis` | smoothest; starts and ends at the first and last sample but does not pass through the others |
| `curveMonotoneY` | `monotoneY` | monotone in the value direction (meant for curves that run vertically; rarely useful over time) |
| `curveCatmullRomOpen`, `curveCardinalOpen`, `curveBasisOpen` | `catmullRomOpen`, `cardinalOpen`, `basisOpen` | as above without the first and last segment |

The smooth curves bend between samples, so a value read off the curve between two samples is a drawing, not data: the
X-Trace box and the statistics always use the samples (linear between them, or held for the step curves). With more of
a pen's own samples in view than pixels across the plot, its smooth curve is drawn as straight lines (it would look the
same and cost frame time); the other pens of the plot do not count, so a sparse pen next to a dense one keeps its curve.
`breakLine` breaks every curve at bad data the same way.

**Pen states** (`display.states`, Power Chart-style styles by data state; in Settings > Pens > *States*):

| State | Props | Look |
|---|---|---|
| Bad data | `states.bad.style`, `states.bad.color` | `hatch` (default): diagonal hatching over the bad stretch; `hold`: the last good value as a dashed line across it; `none`: only the gap. The colour defaults to the pen colour |
| Outside the limits | `states.outOfBounds.{enabled, source, low, high, color, width}` | the parts of the line above the high or below the low limit in the warning colour (or `color`), optionally wider (`width` above the pen's width; a narrower width or 0 draws them at the pen's width). `source: "engineering"` takes the tag's Engineering Low/High (a `low` / `high` set here overrides that side); `"manual"` only uses `low` / `high`. Not for Boolean pens |
| Boolean on / off | `states.boolean.{enabled, onColor, offColor, fillOpacity}` | the line in `onColor` while true and `offColor` while false (defaults: the pen colour and the theme's muted text colour), and the "on" periods shaded between 0 and 1 (`fillOpacity`, 0 = none). Only for pens drawn as a 0/1 signal |

The colours change exactly where the line crosses a limit (or the 0.5 threshold), for every curve type. Out-of-bounds
colouring compares the drawn values: with aggregated data a short excursion inside a bucket shows as far as the bucket's
minimum / maximum reaches (keep the default MinMax aggregation to see spikes). The colour follows the drawn curve, not
the samples: `cardinal`, `catmullRom` and `natural` can overshoot past a limit between two samples that are inside it,
and that bend is coloured although no sample is out of bounds; `basis` may not reach a sample that is out of bounds, so
that sample shows little or no warning colour. Use `linear`, a step curve, `spline` or `monotoneX` (they never overshoot
and pass through every sample) when the warning colour must match the data exactly.

**Gaps.** `appearance.breakOnGapMs` breaks lines where two samples are further apart than that (drawing only), and
`appearance.extendToNow` continues each line from its last sample to "now" in realtime while the live value is good.

## Axes and plots

**Automatic axes** (pens with an empty `axis`): pens share an axis when they have the same engineering units **and**
similar ranges; pens without units get their own axis; at most two automatic axes per side, after that pens share the
closest one. Auto ranges fit the visible data of the shown pens with a little padding and nicely rounded ends (0–100 data
→ −10…110), with hysteresis so the axis does not jitter. Hiding a pen re-fits its axis.

**Named axes** (`axes[]`): pens refer to them by name.

```json
"axes": [
  { "name": "Level", "position": "left",  "range": { "mode": "manual", "min": 0, "max": 100 } },
  { "name": "Flow",  "position": "right", "range": { "mode": "engineering" } }
],
"pens": [
  { "tagPath": "[default]Area1/Tank1/Level", "axis": "Level" },
  { "tagPath": "[default]Area1/Tank1/Outflow", "axis": "Flow" }
]
```

`range.mode` is `auto`, `manual` (a null side stays automatic) or `engineering` (EngLow/EngHigh of the axis's first
pen). `scale: "log"` ignores values ≤ 0; on a log axis `manual` and `engineering` ranges apply too, and a side that is
not above 0 falls back to whole decades. Grid lines are drawn by the innermost axis on each side, except that an
automatic right axis draws none when the left side already has a grid.

**Plots** (`plots[]`): stacked plots sharing one time axis, sized by `relativeWeight`, each with optional background and
horizontal reference `markers` (lines or bands). Pens pick a plot with `pens[].plot` (index; out-of-range values use the
last plot). The hover cursor is synced across plots.

```json
"plots": [
  { "relativeWeight": 3, "markers": [ { "type": "line", "value": 90, "color": "#B54700", "label": { "text": "High" } } ] },
  { "relativeWeight": 1 }
]
```

**Time axis**: labels adapt to the zoom level (24-hour clock, the date on a second line where the day changes) unless
`timeAxis.format` sets a pattern (`MM/DD HH:mm`, tokens `YYYY YY MMMM MMM MM M DD D HH H hh h mm ss SSS A ZZ`).

## Colours

Pens without a colour take one from `appearance.palette`. A trend pen's colour is derived from its tag path, so a tag
keeps its colour across charts and reloads. Palette colours with too little contrast against the current plot
background (light or dark theme) are adjusted automatically. Users can change a pen's colour with the swatch in the pen
table (`penTable.allowColorChange`).

---

## History queries: aggregation, caps and chunked loading

**Mode** (`query.mode`): `auto` (default) queries aggregated buckets and switches to raw samples when zoomed in so far
that a bucket would be shorter than `query.autoRawBelowBucketMs` (2 s). `aggregated` and `raw` force one mode.

| | Aggregated | Raw |
|---|---|---|
| What comes back | one (or, for MinMax, two) values per time bucket | every stored sample |
| Size | bounded by the bucket count | grows with the window and the tag's change rate |
| Longest window (default) | 400 days (`ctg.history.maxRangeDays`) | 31 days (`ctg.history.maxRawRangeDays`) |
| Statistics in the pen table | prefixed with `≈` | exact |

**Aggregation** (`query.aggregation`, per pen `pens[].aggregation`): default **`MinMax`**, which returns the minimum and
maximum of every bucket so a 3-second spike in an 8-hour window stays visible after the live edge moves on. Use
`LastValue` for slow signals, `Average` for a time-weighted mean. 1.x always used `LastValue`.

**Buckets** (`query.pointCount`): 0 (default) = one bucket per plot pixel (100 to 2000). Bucket widths come from a fixed
ladder (100 ms ... 1 day) so refreshes and the gateway cache line up. The grid is anchored at the UTC epoch, not at
the chart's time zone: 1-day buckets start at 00:00 UTC (19:00 the previous day in Chicago, 02:00 in Berlin), and
hourly buckets in half-hour zones such as India start at :30 local. Per-day or per-shift counting charts
(`DurationOn`, `CountOn` per day) outside UTC therefore split each local day across two buckets.

**Point caps.** Raw queries stop at `query.maxPointsPerPen` (100 000) or the gateway's `ctg.history.maxRawPointsPerPen`
(250 000), whichever is smaller, plus a per-response cap (`ctg.history.maxPointsPerResponse`, 500 000). A pen over the
cap is not drawn: its row says *Too many points* and a banner offers **Use aggregated data** and **Narrow the range**.
`query.onTooManyPoints: "aggregate"` falls back to aggregated data automatically (the pen shows an *Aggregated* chip and
`≈` statistics); in a realtime chart such a pen keeps refreshing on its own aggregated grid. The browser also refuses
further raw loads above 2 000 000 points held in total.

**Anchor.** `query.includeAnchor` (default on) also fetches the last value before the window start, so lines start at
the left edge.

**Per-pen failures.** A pen whose own part of an answer timed out or failed (a normal outcome when the historian is
busy) is loaded again by itself: after 5 s for a timeout, then with a 2, 4, 8 … 60 s backoff, until it succeeds.

**Chunked loading** (`query.chunking`): long raw loads arrive in pieces, newest first, with a progress bar and
**Cancel** (keeps what was loaded: *Partially loaded*). With `rawChunk: "auto"` the chart first probes the newest hour,
then sizes each piece from the measured sample density so that a piece fills about 80 % of the per-pen cap and the
per-response cap; piece edges follow the gateway's cache geometry (1-hour, 6-hour or 1-day units). In the 2.0.0 tests a
raw window of about 100 000 points loaded in two requests. Explicit `1h` / `6h` / `1d` use fixed pieces. Closed ranges
are cached on the gateway (`ctg.history.cacheMb`), so reopening a view is fast.

## Gateway fairness

Each chart token may start 8 history requests back to back, then one per `ctg.history.minIntervalMs` (200 ms); each
session may run `ctg.history.maxConcurrentPerSession` (4) at a time. The chart mirrors both limits, so it does not
normally hit them. A refused request (HTTP 429/503) is retried after the `Retry-After` time; the header `X-CTG-Limit`
says which limit applied (`rate`, `concurrency`, `queue`, `capacity`). A `concurrency` or `queue` refusal is retried
after 250 ms instead: it clears as soon as the session's other requests finish (for example when two charts on one view
load at the same time and together exceed `ctg.history.maxQueuedTasksPerSession`). The browser console still shows that
429.

The gateway's point budget keeps a reserve for light requests and shares the rest fairly between sessions, so a chart
asking for a normal window keeps loading while another session floods the gateway; a `503 BUSY` (`capacity`) means the
gateway has no memory to spare right now and is retried after `Retry-After`
([the history point budget](../../gateway-settings.md#the-history-point-budget)). A running chart picks up changed
gateway limits at its next snapshot (reconnect or page reload).

<!-- nav:bottom -->

---

← Previous: [Interaction](interaction.md) · ↑ Up: [Click To Graph Chart](README.md) · [Back to index](../../README.md) · Next: [Panels and tools](panels-and-tools.md) →

<!-- /nav:bottom -->
