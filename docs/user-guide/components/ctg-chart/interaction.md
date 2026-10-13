<!-- nav:top -->

[Docs home](../../../README.md) › [User Guide](../../README.md) › [Click To Graph Chart](README.md) › **Interaction**

<!-- /nav:top -->

# Interaction

How users read values, move through time and select ranges on a Click To Graph Chart: with a mouse, a pen, touch or
the keyboard. Every prop named here is in the [property reference](properties.md#interaction).

**On this page**

- [Interaction modes](#interaction-modes)
- [Keyboard](#keyboard)
- [Following live](#following-live)
- [Range selector (overview strip)](#range-selector-overview-strip)
- [Cursor sync between charts](#cursor-sync-between-charts)
- [Fullscreen](#fullscreen)
- [Narrow layout](#narrow-layout)

---

## Interaction modes

The toolbar's mode buttons write `interaction.mode`. Hide a mode with `toolbar.buttons.<mode>: false`.

| Mode | Mouse / pen | Touch | Wheel | Double-click |
|---|---|---|---|---|
| **X-Trace** (default) | hover shows a cursor and an info box with every pen's value; click pins a cursor (up to `interaction.xTrace.maxTraces`), click a pinned line to remove it | tap = cursor; long-press pins; double-tap pins/unpins | page scroll | nothing (the two clicks already pin and unpin) |
| **Pan** | drag to move | one-finger drag; two-finger pinch zooms | zoom around the pointer | reset zoom |
| **Zoom** | drag a box | drag a box; pinch zooms | zoom around the pointer | reset zoom |
| **Range** (brush) | drag to create, drag the body or edges to move/resize, click to select | the same, wider edges | none | remove the brush |
| **Note** | click = note at that time, drag = range note (needs [annotations](panels-and-tools.md#annotations)) | tap / drag | none | edit the note |

- **X-Trace** values are read from the samples (linear between two samples for lines, held for steps), never from a
  smooth curve's bend. The info box (`interaction.xTrace.infoBox`) can hide its time row. Pinned cursors are written to
  `interaction.xTrace.values` and fire `onXTraceChange`.
- **Range brush** switches the pen table to the brush's statistics (first, last, delta, min, max, average, median,
  standard deviation, sum, count, control limits); see
  [Range brush statistics](panels-and-tools.md#range-brush-statistics). Up to `interaction.rangeBrush.max` brushes;
  each change fires `onBrushChange`.
- **Wheel zoom** works in Pan and Zoom modes and on the range selector (`interaction.panAndZoom.wheelZoom`).
- While annotation editing is not offered (annotations off, no edit permission, a historian without annotations),
  `interaction.mode: "annotate"` acts as X-Trace (the prop is left as it is).

## Keyboard

When the plot has focus (`interaction.keyboard`, on by default):

| Key | Effect |
|---|---|
| ← / → | pan 10 % (with Shift: 50 %) |
| + / − | zoom (at the live edge the right edge stays at "now") |
| Home | reset the zoom |
| X / Shift+X | step the X-Trace cursor through the data points |
| Enter | pin the X-Trace cursor |
| Delete | remove the selected brush or the nearest pinned trace |
| Esc | cancel the current gesture |

## Following live

After a zoom or pan that ends at the live edge, the chart keeps following live with the new span (without reloading
the window when the loaded data already covers it). Panned into the past, the badge says **Paused** with a *Return to
live* chip. Cursors pinned while following live (`{ fromEndMs }`) become fixed times (`{ time }`) at that moment, so they
keep pointing at the instant they were pinned.

With `interaction.panAndZoom.freeRange` (default on), the chart re-queries history for the new window when you pan
beyond the loaded data or zoom far enough to need another resolution; off, pan and zoom only magnify what is loaded.
Zoom stops at the gateway's maximum span. Every change of the visible window fires `onRangeChange` (debounced 500 ms)
and updates `outputs.range`.

## Range selector (overview strip)

`rangeSelector.visible` (off by default) shows the Power Chart's range-selector mini chart: an overview strip under the
plots with the chart's whole range, that is, the configured realtime window (sliding with now) or the historical
window, widened when you pan outside it. Its pens (`rangeSelector.pens`: `visible` or `all`) are each scaled to their own
minimum and maximum so they share the strip; Boolean pens are a thin track along the bottom. The part shown in the plots
is a window on the strip:

| Gesture | Effect |
|---|---|
| drag the window | pans the plots (they follow during the drag) |
| drag an edge handle | moves that end; dragging the right end to the right edge returns to live |
| drag elsewhere on the strip | draws a new window |
| click beside the window | centres the window there |
| mouse wheel | zooms around the pointer (`interaction.panAndZoom.wheelZoom`) |
| double-click | resets the zoom |
| touch | the same with one finger; the page still scrolls vertically over the strip |
| keyboard | the window and both handles are sliders (Tab to them): Left/Right move 2 % of the range (Shift: 10 %), Home / End go to the start / the end (End on the window = back to live), Up/Down on the window widen / narrow it |

Other settings: `rangeSelector.height` (64 px) and `rangeSelector.narrowVisible` (also show it in the narrow layout;
very small charts never do). Operators can hide and show it for the session in the **More** menu. It is not part of a
PNG export.

**Where the strip's data comes from.** The strip has its own data: aggregated requests (MinMax, one bucket per pixel)
for every pen with history (up to 16), sent in batches of at most 4 pens at the lowest priority after the plots have
loaded, and refreshed while a realtime chart refreshes (at most every 10 s, or one strip bucket, whichever is longer);
between refreshes the plots' live data extends it to now. A historical strip is fetched again when the window is panned
or zoomed outside what it holds. Any strip is also fetched again when its range shrinks to less than half of what it
holds, or when its data is more than twice as coarse as one bucket per pixel of the current range (for example after a
far pan followed by **Reset zoom**), so it never keeps showing a few coarse points for the window. A request covers at
most the last `ctg.history.maxRangeDays` (400 days by default, the gateway's longest aggregated range) of the strip's
range, so after a pan further back than that the strip shows the newest part of that length and is not fetched again
until that part moves.

**How it shares the gateway with the plots.** The strip loads at the lowest priority: each batch waits until none of
the page's other history requests runs, and the plots' realtime ticks still start between two batches (a batch that has
waited 5 s goes next). A batch usually takes 0.05 to 0.3 s; the first read of a long range is slower (a cold 30-day
strip took about 1.1 s), and other charts' ticks on the page wait that long, once per strip refresh. Charts in another
browser tab of the same session are not coordinated; a request refused for that reason is retried after 250 ms.

## Cursor sync between charts

The hover cursor is synced across the stacked plots of one chart. `interaction.cursorSyncGroup` syncs it across charts
on the same page: give the charts the same non-empty group name.

## Fullscreen

The fullscreen button (`toolbar.buttons.fullscreen`) uses the browser's fullscreen mode and writes
`interaction.fullscreen`; where fullscreen is unavailable (some embedded browsers) the chart fills the window instead
(*maximised*, class `ctg-chart--maximised`). Esc leaves both. Menus, dialogs, the colour picker and messages open inside
the fullscreen chart, on the theme's surface colour (`--ctg-surface`).

## Narrow layout

Below `toolbar.responsiveWidth` (640 px) secondary buttons move into a **More** menu (refresh, reset zoom, export,
settings, fullscreen, refresh rate) and panels open full-size with a *‹ Back* header. Very small charts (under 240 px
high or 320 px wide) start with the pen table collapsed. On touch screens the pen table's row controls are always
visible.

<!-- nav:bottom -->

---

← Previous: [Click To Graph Chart](README.md) · [Back to index](../../README.md) · Next: [Pens, axes and plots](pens-axes-plots.md) →

<!-- /nav:bottom -->
