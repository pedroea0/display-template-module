<!-- nav:top -->

[Docs home](../../../README.md) › [User Guide](../../README.md) › [Click To Graph Chart](README.md) › **Panels and tools**

<!-- /nav:top -->

# Panels and tools

Everything around the plot of a Click To Graph Chart: the pen table, the settings panel, the tag browser, the date range
dialog, export, annotations, and how to style it all. Every prop named here is in the
[property reference](properties.md).

**On this page**

- [Toolbar](#toolbar)
- [Pen table and statistics](#pen-table-and-statistics)
- [Range brush statistics](#range-brush-statistics)
- [Settings panel](#settings-panel)
- [Tag browser](#tag-browser)
- [Search all folders](#search-all-folders)
- [Date range dialog](#date-range-dialog)
- [Export](#export)
- [Annotations](#annotations)
- [What `enabled: false` turns off](#what-enabled-false-turns-off)
- [Styling](#styling)

---

## Toolbar

| Button | Prop | Default | Notes |
|---|---|---|---|
| Date range pill | `toolbar.buttons.dateRange` | on | opens the [date range dialog](#date-range-dialog) |
| Tag browser (≡) | `toolbar.buttons.tagBrowser` | on | also needs `tagBrowser.enabled` |
| X-Trace / Pan / Zoom / Range | `toolbar.buttons.xTrace`, `pan`, `zoom`, `rangeBrush` | on | the [interaction modes](interaction.md#interaction-modes) |
| Note | `toolbar.buttons.annotate` | on | also needs `annotations.enabled` |
| Refresh / Reset zoom | `toolbar.buttons.refresh`, `resetZoom` | on | |
| Settings (⚙) | `toolbar.buttons.settings` | on | also needs `settingsPanel.enabled` |
| Export | `toolbar.buttons.export` | on | hidden in the Perspective mobile app |
| Fullscreen | `toolbar.buttons.fullscreen` | on | |
| Refresh rate field | `toolbar.buttons.refreshRate` | off | in the **More** menu |

`toolbar.visible: false` hides the whole toolbar; the badge is `appearance.liveBadge`. Below
`toolbar.responsiveWidth` secondary buttons move into **More** ([narrow layout](interaction.md#narrow-layout)).

## Pen table and statistics

Each row: a show/hide checkbox drawn in the pen colour (`penTable.allowHide`), a colour swatch that opens the colour
picker (`allowColorChange`), the name (full path on hover), the columns, a status cell, and on hover the pencil (opens
Settings at that pen, `allowEdit`) and the trash icon (`allowRemove`, confirmed when `confirmRemove`). On touch screens
the controls are always visible. Rows with a problem get a red or amber edge and the reason as text (*Tag not found*,
*No permission to read this tag*, *History not enabled for this tag*, *Too many pens*, a bad quality name, ...); bad-
quality stretches are hatched in the plot (or drawn as set in the pen's
[bad data state](pens-axes-plots.md#curve-types-and-pen-states)).

Placement: `penTable.position` (`bottom` or `right`), `size` + `sizeUnit` (max height or width), `collapsed` (start as a
header row only), `visible`.

Columns (`penTable.columns`, also in Settings > Columns), computed over the **visible** window:

| Column | Definition |
|---|---|
| Current | the live value while following live; otherwise the value at the right edge (header *End*) |
| Minimum / Maximum | over the samples in the window plus the value held at its start |
| Average | **time-weighted**: each value counts for as long as it held, the last one until the end of the window the historian answered for (now, while following live); bad-quality time is excluded. A MinMax bucket counts once, at the mean of its minimum and maximum |
| X-Trace | the value under the (first pinned or hovered) cursor, linearly interpolated for lines, held for steps |
| Axis / Plot / Units / Status | the pen's axis, plot index, units, history status |

Values computed from aggregated data are prefixed with `≈`.

## Range brush statistics

In Range mode the table switches to the selected brush and shows `penTable.rangeColumns`:

| Column | Definition |
|---|---|
| First / Last / Delta | the value held at the brush start, the last value, and their difference |
| Minimum / Maximum | over the samples in the brush |
| Average | time-weighted |
| Median, Standard deviation, Sum, Count | over the samples, unweighted (standard deviation: population) |
| LCL / UCL | control limits. `stdDev`: mean ± sigma × standard deviation; `movingRange`: mean ± sigma × (average moving range / 1.128). Sigma from `interaction.rangeBrush.controlLimits.sigma` (3) |

With `interaction.rangeBrush.exactStats` the chart fetches raw samples for the brushed range so the statistics are exact
(falling back to aggregated data, with `≈`, when there are too many). Brush header actions: *Zoom to range*, *Copy
stats* (tab-separated, ready for a spreadsheet), *Clear*. Statistics cover every pen, while the brush rectangle is drawn
on its own plot.

## Settings panel

`settingsPanel` (toolbar ⚙) has four tabs (each can be hidden with `settingsPanel.tabs.*`):

| Tab | What users can change |
|---|---|
| **Pens** | add a pen by path (`allowAddPen`), name, tag path (`allowEditTagPath`), visibility, axis, plot, display type, curve, line style, colour, aggregation, units, format, per-state styles; reorder by drag or Move up/down; *Clear list* for the trend list |
| **Axes** | the named axes (`axes[]`) |
| **Plots** | weights, backgrounds, markers (`plots[]`) |
| **Columns** | the pen table's columns |

Edits apply live as prop writes. They last for the page and are not saved into the view (except in a Designer preview).
Runtime pens must be inside the chart's [read scope](README.md#read-scope-which-tags-a-chart-may-read).

## Tag browser

`tagBrowser` (**[S]**) is **on by default** since 2.0.0, like the Power Chart. Open it with the toolbar button or the
*More* menu; `tagBrowser.enabled: false` removes it, `openOnStart: true` opens it when the view starts with no pens.

- It browses on the gateway with the user's permissions, below `tagBrowser.rootPath` when set (`BROWSE_ROOT_VIOLATION`
  otherwise), never into providers in `ctg.read.deniedProviders` (`[System]` by default).
- `tagBrowser.access` limits who may browse (roles, security levels, login).
- Folders load 100 entries at a time (*Load more…*). The filter field filters on the gateway, page by page, inside the
  deepest open folders (their parents stay unfiltered so the path never disappears); empty filtered pages are skipped
  automatically up to 20 pages.
- Tick tags and press **Add selected**. Only numeric and Boolean tags can be ticked. With `addTo: "trendList"` (or
  `auto` with a trend group) the tags go into the session trend list in one request, and the browser reports added,
  rejected (with reason) and duplicate tags; with `pens` they are appended to `pens`.

> **Note** With the default (empty) `tagBrowser.rootPath` and `readScope.allowedRoots`, users can add any tag they are
> allowed to read from every provider except `[System]`. Set `tagBrowser.rootPath` to the area the screen is about.

## Search all folders

Tick *Search all folders* under the filter field and it searches every folder below the browser's root
(`tagBrowser.rootPath`, or every provider the administrator does not deny) instead of filtering the open one.

- A tag matches when the text appears in its **name** or in its **path below the root** (so `pump101` finds every tag
  inside a `Pump101` folder or UDT instance), ignoring case.
- With `*` (any run of characters, also across folders) or `?` (one character) the text is a wildcard pattern that must
  match the whole name or the whole path: `temp*`, `*/pump101/s*`.
- Type at least 2 characters (or 1 with a wildcard); the search starts after a short pause, or at once with Enter.
- Results are a list of tags with their folder, 100 at a time (*Load more…*), with the same tick rules as the tree; a
  tag ticked in the results stays ticked when you switch back to the tree, and **Add selected** adds everything ticked.
- *Cancel* (or Escape in the field) stops a running search. A new search from the same chart replaces the running one.

The search runs on the gateway with the logged-in user's permissions and returns only what the user could add:

| Rule | Effect |
|---|---|
| Browse permissions | the same folder-by-folder browse as the tree; a folder the provider refuses for the user is skipped |
| Tag Read Permissions | every match is read once with the user's context; tags the user may not read are left out (the tree itself still lists their names, like any Ignition browse) |
| `tagBrowser.rootPath`, `tagBrowser.access`, `ctg.read.deniedProviders` | exactly as for browsing (`BROWSE_ROOT_VIOLATION`, `FORBIDDEN_ROLE`, never `[System]`) |
| `readScope` | only tags inside the read scope are returned; folders that cannot contain one are not searched; with `allowRuntimePens: false` the search is refused (`OUT_OF_SCOPE`) |
| Bounds | 16 folder levels, 50 000 entries looked at, 5 000 folder pages, 1 000 matches, 5 s; the status line says when a bound stopped the search, for example "Type more to narrow the search." or "Narrow it to find the rest." |
| Load on the gateway | one running search per session (a second chart gets *busy*), 4 per gateway, 4 new searches per session in a burst then 1 per second; the browser retries once after a short pause. When the 4 gateway slots are taken, a freed slot goes to the session that was refused first (it gets it on its retry), and a chart that starts a new search while another session waits gives its slot back instead of keeping it |

UDT definitions (`_types_`) are not searched. Results show each path as the tag provider spells it (also when
`tagBrowser.rootPath` or the typed start folder uses another case), so pens added from the results carry the same path as
pens added from the tree. A search reports that very deep folders were not searched only for folders inside the read
scope.

## Date range dialog

The toolbar's date pill opens the **date range dialog**:

- **Realtime** tab: "last N units", with quick picks from `timeRange.presets`. The amount must be a whole number ≥ 1.
- **Historical** tab: start and end date-time fields in the chart's time zone, with daylight-saving gaps explained.

Applying writes `timeRange` (and fires `onRangeChange`). Applying the same window again resets the zoom. The span is
limited by the gateway ([time range and refresh](README.md#time-range-and-refresh)).

## Export

The toolbar's export menu (`toolbar.buttons.export`) offers:

- **CSV** (`export.csv`): `layout` `wide` (one time column + one column per pen, blank where a pen has no sample) or
  `tall` (time, pen, value). `source` `visible` (what is drawn), `loaded` (everything held) or `raw` (re-queries raw
  samples for the visible window, subject to the point cap; pens that come back aggregated are exported aggregated and
  you are told). `includeQuality` adds a quality column per pen.
  - A raw export keeps running when the menu closes (Esc, a click elsewhere, switching windows, a scroll): the file is
    saved when the data arrives. **Cancel export** in the menu stops it; leaving the page stops it with an *Export
    cancelled* notice.
  - Aggregated data (an aggregated chart, the default for windows over about an hour) is exported as buckets, not
    samples: each value is stamped with its bucket's start time as the historian returned it (a MinMax bucket gives two
    rows at that time, min and max in historian order), the pen's column (wide) or name (tall) carries the aggregation,
    e.g. `Temp (degF) [MinMax]`, and a notice names the aggregated pens.
  - Times per `timeFormat` (`iso` with offset, `epoch` ms or a pattern). Numbers have a `.` decimal point and no
    thousands separators. Cells that a spreadsheet could run as a formula are prefixed with `'`.
- **PNG** (`export.png`): the plots at `scale` × resolution with an optional legend (names, colours, current values).

The file name comes from `export.fileName` (`{title}`, `{start}`, `{end}`). Export is hidden in the Perspective mobile
app, which cannot save downloads; a download inside the Designer or Workstation may open a new window instead
(not yet verified by hand).

## Annotations

Off by default. With `annotations.enabled` **[S]** the chart reads the historian's annotations for its pens and draws
**notes** (a flag and a vertical line) and **ranges** (a shaded band); hover or tap shows the text, author and time.
They require a historian that supports annotations: the 8.3 **Core Historian** does (verified on 8.3.10); others are
detected at runtime and the chart shows *This historian does not support annotations*. SQL Historian was not tested.

**Adding notes** needs `annotations.edit.enabled` and a user matching `annotations.edit.access` (login required by
default). In **Note** mode click the plot for a note or drag for a range, pick the pen, type the text (and an optional
colour), Save. The note appears at once and is confirmed by the historian about a second later (storage is
asynchronous). Clicking a note opens it for editing or deleting.

**Ownership.** With `annotations.edit.ownOnly` (default) users may change only their own notes (`NOT_OWNER` otherwise).
A note records its author's user name and identity provider (`session.props.auth.idp`, stored as `authorSource`), and
both must match: names compare exactly (case-sensitive), and the same name from another identity provider is another
user. A note without a recorded identity provider belongs only to a user without one. This has two side effects:

- Designer sessions report no identity provider. A note written in the Designer cannot be changed by the same user in a
  client session, and the reverse.
- Notes saved by pre-release 2.0.0 builds recorded no identity provider. Their authors, logged in to a client session
  through an identity provider, no longer own them.

Only moderators can change such notes. `annotations.moderate` grants a role the right to edit or delete anyone's notes;
an edit by a moderator keeps the original author and records who edited it. Notes from other tools (no recorded author)
can be changed only by moderators. An anonymous session owns nothing: a note saved without a login records no author
(every anonymous session has the same name), so only moderators can change it later.

**Limits and audit.**

- Each session may save `ctg.annotations.maxPerSessionPerHour` notes per hour (adds and edits, `RATE_LIMITED` beyond);
  at most `ctg.annotations.maxPerPen` notes per pen are loaded per window. That cap counts distinct notes after
  versions and deletions are resolved and keeps the earliest by start; a cut pen is flagged as truncated.
- A note may not start more than a day from now, a range must end after it starts, and a new, moved or resized range
  may be at most `ctg.history.maxRangeDays` long. A breach answers `INVALID_TIME` with the reason (`future`, `order` or
  `length`; `details.maxRangeDays` with `length`); it is not retryable. A range without an end answers `INVALID_VALUE`
  and a malformed time `BAD_REQUEST`. An edit that keeps a stored range's start and end is exempt from a lowered
  `maxRangeDays`, so its text stays editable.
- An unexpected gateway failure before the historian is called answers `INTERNAL` and gives back the hourly quota slot
  and the note's edit claim; a failure after the historian was called is only logged, and the reply follows the
  historian's answer (a stored note is never reported as failed).
- Every add, edit and delete is audited (`annotation add` / `annotation edit` / `annotation delete`, with an
  `auditId`).
- Notes cannot be moved to another pen (an edit keeps the tag). The historian finds a note by its start time, so the
  chart looks back one window length; a range that started earlier than that is not shown. Realtime charts re-read
  notes every 60 s.

The **Show notes** item in the More menu hides or shows notes for this session only; `annotations.visible` stays the
configured default.

## What `enabled: false` turns off

`enabled: false` disables everything that changes the chart's configuration: settings, adding and removing pens, the
colour picker, notes, trend list changes. Viewing actions stay: zoom, pan, X-Trace, range brush, date range and export.
The tag browser still browses but cannot add.

## Styling

The chart is transparent and follows the Perspective theme (light and dark). Its built-in rules have zero specificity
(`:where(...)`), so `style`, `styles.title`, `styles.toolbar`, `styles.plot`, `title.style`, `penTable.style`,
`toolbar.style` and project CSS always win. Shared overlay tokens (`--ctg-surface`, `--ctg-text`, `--ctg-primary`,
`--ctg-danger`, `--ctg-warn`, `--ctg-border`, `--ctg-radius`, `--ctg-font`, ...) map to the theme's variables and can be
overridden in the project stylesheet. Axis text uses the theme's muted label colour; grid lines use the text colour at
low opacity; `appearance.fontSize` sets the axis and table font size. Useful class names: `ctg-chart` (root),
`ctg-chart--maximised`.

```css
:root { --ctg-primary: #0050A0; --ctg-radius: 2px; }
.ctg-chart { font-family: "Roboto", sans-serif; }
```

<!-- nav:bottom -->

---

← Previous: [Pens, axes and plots](pens-axes-plots.md) · ↑ Up: [Click To Graph Chart](README.md) · [Back to index](../../README.md) · Next: [Recipes](recipes.md) →

<!-- /nav:bottom -->
