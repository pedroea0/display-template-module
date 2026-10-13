<!-- nav:top -->

[Docs home](../README.md) › [User Guide](README.md) › **Upgrading from 1.x**

<!-- /nav:top -->

# Upgrading from 1.x

Version 2.0.0 keeps the module ID and both component IDs, so every existing view still finds its components after the
upgrade. The **props are a clean break**, though: both components moved from flat v1 props to grouped v2 props, and a
v1 view that is not migrated renders with v2 defaults (wrong units, lost setpoint, lost toolbar settings). Perspective
has no migration hook for third-party components, so v2 ships an offline migration script:
[`simple-tag-display/tools/migrate-v1-views.mjs`](../../simple-tag-display/tools/migrate-v1-views.mjs).

This page covers the prop renames, how to run the script, what it can and cannot convert, and the manual steps that
are left afterwards.

**On this page**

- [Breaking changes at a glance](#breaking-changes-at-a-glance)
- [Before you start](#before-you-start)
- [Rename tables](#rename-tables)
- [Running the migration script](#running-the-migration-script)
- [Reading the output](#reading-the-output)
- [What the script does not do: manual steps](#what-the-script-does-not-do-manual-steps)
- [Writes in projects without a login (floor policy)](#writes-in-projects-without-a-login-floor-policy)
- [Rolling back](#rolling-back)

---

## Breaking changes at a glance

| Area | 1.x | 2.0.0 | What to do |
|---|---|---|---|
| Props | flat (`showTagName`, `rangeHours`, `setpoint: true`, ...) | grouped (`label.visible`, `timeRange.realtime`, `setpoint.enabled`, ...); 1.x props are ignored | run the migration script (this page) |
| HTTP routes | `/data/simpletagdisplay/readTag`, `readTags`, `writeTag`, `isHistorized`, `trendList`, `addToTrendList`, `removeFromTrendList`, `tagHistory` | **removed** (404); one `POST .../v2/history` for the chart, everything else over the Perspective session | scripts or other pages that called the 1.x routes must use tag bindings or `system.tag.*` instead |
| Who may write | anyone with a session, with an empty security context | the session user's own security context (anonymous included, like native Perspective writes): the tag's Write Permissions now apply; `setpoint.access` and the gateway floor can require a login or roles | give setpoint tags Write Permissions that match who should write; see [the floor policy](#writes-in-projects-without-a-login-floor-policy) |
| Bound gates | n/a | security props bound to view parameters or custom props make the gate fail closed (`ctg.security.rejectBoundGates=true`) | configure gates statically ([Security and permissions](security-and-permissions.md#binding-lint-security-props-must-not-depend-on-user-input)) |
| Units | hidden by default | shown by default | the script keeps 1.x views as they were |
| History aggregation | `LastValue` | `MinMax` | `--keep-aggregation`, or set `query.aggregation` |
| Tag browser and runtime pens | none | the chart has a tag browser, **on by default** (`tagBrowser.enabled: true`): every user, anonymous included, can browse and add tags they may read from every provider except `ctg.read.deniedProviders` (`[System]`) | migrated charts get it too; set `tagBrowser.enabled: false`, or `tagBrowser.rootPath` / `readScope.allowedRoots`, on charts that should not browse ([read scope](components/ctg-chart/README.md#read-scope-which-tags-a-chart-may-read)) |
| Trend list | per HTTP session | per Perspective session and `trendGroup`; cleared on logout or user change | – |
| Look | coloured bounds background | neutral border + ▲/▼ for bounds; alarm colours by live alarm priority | the script keeps 1.x bounds colours |
| Events and audit | none | four component events per component, audit records with `auditId` | assign an audit profile to the project |

## Before you start

- **Node.js 18 or newer** on any machine (the gateway is not needed). The script has no dependencies.
- **A backup.** For folders, the script keeps one `view.json.v1.bak` next to every file it changes. A gateway backup
  (`.gwbk`) or a project export is still the safer net.
- **The repository checkout.** The script reads the v2 prop schemas from
  `simple-tag-display/common/src/main/resources/schemas/`, so run it from a checkout of the same version you install.
  (`--schemas <dir>` points it at another copy.)
- **Run it once, right after installing v2.** At that point every Display Template and CTG Chart in your projects is
  still v1, which is the case the script is built for. Running it again later is safe (see
  [idempotence](#idempotence-and-v2-views)).

---

## Rename tables

"Not written" means the value equals the v2 default, so the migrated view does not store it and follows future default
changes. Values that differ from the v2 default, and keys that are bound, are always written.

### Display Template (`com.example.simpletagdisplay.SimpleTagDisplay`)

| v1 prop | v2 prop | Notes |
|---|---|---|
| `tagPath` | `tagPath` | unchanged |
| `showTagName` | `label.visible` | |
| `tagNameLabel` | `label.text` | |
| `tagNameStyle` | `label.style` | style objects are copied as they are |
| `showTagValue` | `value.visible` | |
| `valuePrecision` | `value.decimals` | written only when the v1 view stored it. v1 applied 1 decimal to every tag; v2 `null` means "the tag's own format". Clamped to 0–15. |
| `tagValueStyle` | `value.style` | |
| `showUnits` | `units.visible` | v1 default `false`, v2 default `true`: a v1 view that never set it gets `units.visible: false`, so the look does not change |
| `boolean.textOnTrue` / `textOnFalse` | `states.boolean.trueText` / `falseText` | |
| `row` (boolean) | `layout.direction` (`"row"` / `"column"`) | |
| `evenRow` | `layout.evenSplit` | |
| `verticalAlign` | `layout.verticalAlign` | v1 default `top`, v2 default `center`: written as `top` when the v1 view never set it |
| `bounds.enabled` | `bounds.enabled` | when `true`, the v1 look is kept: `bounds.appearance: "background"` plus the v1 colours |
| `bounds.minColor` / `maxColor` | `bounds.lowColor` / `highColor` | only written when bounds are enabled (or `bounds.enabled` is bound) |
| `bounds.minInclusive` + `maxInclusive` | `bounds.inclusive` | v2 has one flag: `minInclusive && maxInclusive`. A **warning** is printed when the two differed. |
| `bounds.min` / `bounds.max` (1.0.0 only) | dropped | Manual limits of the 1.0.0 schema (defaults 0 / 100), still stored by views created under 1.0.0. 1.1.x already ignored them (it used the tag's EngLow / EngHigh); a **warning** names the values. For fixed limits set `bounds.low` / `bounds.high`. |
| `tagNameFont`, `tagValueFont`, `tagNameJustify`, `tagValueJustify` (pre-1.0 builds) | dropped | No v2 counterpart (a **warning** per key); style the label and value with the v2 label / value styles instead. |
| `setpoint: true` | `setpoint.enabled: true` + `setpoint.access.requireLogin: false` + `setpoint.limits.useEngLimits: false` | keeps v1 behaviour (no login check, no limit check; `requireLogin: false` is also the v2 default). Two **warnings**: see the [floor policy](#writes-in-projects-without-a-login-floor-policy) and review the limits. |
| `setpoint: false` | — | v2 default |
| `style` | `style` | unchanged |

### CTG Chart (`com.example.simpletagdisplay.CtgChart`)

| v1 prop | v2 prop | Notes |
|---|---|---|
| `mode` | `timeRange.mode` | |
| `rangeHours` | `timeRange.realtime` `{value, unit}` | largest whole unit: 24 → 1 day, 168 → 1 week, 0.25 → 15 minutes, 1.5 → 90 minutes. Months and years are never used (not fixed lengths). |
| `refreshRate` | `timeRange.refreshRate` | v2 accepts 0 (off) or 250–3 600 000 ms; 1–249 becomes 250 (**warning**) |
| `startDate` / `endDate` | `timeRange.historical.startDate` / `endDate` | ISO strings become epoch ms (v2 date props). A string without a time zone is read in the time zone of the machine running the script (noted in the output). |
| `pointCount` | `query.pointCount` | 0 stays 0 (= auto); other values are clamped to 10–5000 (**warning**) |
| `rawHistory: true` | `query.mode: "raw"` | `false` → v2 `"auto"` (aggregates, raw for short ranges) |
| *(v1 always used LastValue)* | `query.aggregation` | **v2 default is `MinMax`**, which keeps short spikes visible. `--keep-aggregation` writes `"LastValue"` instead. |
| `freeRangePanZoom` | `interaction.panAndZoom.freeRange` | |
| `visibility.showRangePresets` + `showModeToggle` | `toolbar.buttons.dateRange` | v1 hid the date pill only when both were `false`; the script keeps that rule |
| `visibility.showRefreshButton` | `toolbar.buttons.refresh` | |
| `visibility.showZoomButton` | `toolbar.buttons.resetZoom` | |
| `visibility.showFullscreenButton` | `toolbar.buttons.fullscreen` | v1 had no fullscreen button; a stored `false` is carried over |
| `visibility.showRefreshRateControl` | `toolbar.buttons.refreshRate` | v1 showed the refresh-rate input unless this was `false`; v2 hides it by default. So a v1 chart that never stored the flag gets `toolbar.buttons.refreshRate: true` (written). |
| `visibility.showLegend` | `penTable.visible` | |
| `visibility.showDateRangeSelector` / `showPenControlDisplay` | — | declared in the v1 schema but **never read by v1**: the date pill and the legend stayed visible. A stored `false` is not carried over (**warning**); set `toolbar.buttons.dateRange` / `penTable.visible` to `false` if you want them hidden in v2. A binding on them is `MANUAL`. |
| `dateFormat` / `timeFormat` | `timeAxis.format` | v1 never applied them. A customised pair becomes one fixed axis pattern (**warning**: the axis no longer adapts to the zoom level; clear the prop for `"auto"`). Default values are dropped. |
| `interaction.mode` / `interaction.xTraceVisible` | — | dropped; v2 starts in X-Trace and the toolbar picks Pan / Zoom / Range. Non-default values give a **warning**. |
| `style` | `style` | unchanged |

v1 charts had no pens of their own: they showed the session trend list. Migrated charts keep doing that through the v2
default `trendGroup: "default"`, the same group the Display Template's "Trend Tag" uses.

---

## Running the migration script

```
node simple-tag-display/tools/migrate-v1-views.mjs <input> [options]
```

`<input>` can be any of these:

| Input | Example |
|---|---|
| the gateway's projects folder (every project) | `"C:\Program Files\Inductive Automation\Ignition\data\projects"` |
| one project folder | `.../data/projects/MyProject` |
| a views folder or a single view | `.../MyProject/com.inductiveautomation.perspective/views/Area1` |
| a **project export `.zip`** | `MyProject.zip` (the gateway's project export, or `GET /data/api/v1/projects/export/<name>` with an API key) |

| Option | Meaning |
|---|---|
| `--dry-run` | the default: print every change, write nothing |
| `--write` | folders: rewrite changed `view.json` files in place; the original is kept once as `view.json.v1.bak` (never overwritten by later runs). Zips: write a new archive; the input archive is never changed. |
| `--out <file.zip>` | output archive for a zip input (default `<input>-v2.zip`) |
| `--report <file.json>` | also write the full report as JSON (every change, warning, manual item and external reference) |
| `--keep-aggregation` | keep v1's `LastValue` history aggregation instead of the v2 default `MinMax` |
| `--bare auto\|v1\|skip` | how to treat components that store no version-specific prop at all (see [below](#idempotence-and-v2-views); default `auto`) |
| `--verbose` | also list the values that were dropped because they equal the v2 default |

Exit codes: `0` done, `1` usage or fatal error, `2` done, but some files could not be read or parsed (listed as `ERROR`
lines and in the report; every other file was processed).

### Folder workflow (you can write to `data/projects`)

1. `node .../migrate-v1-views.mjs "<data>/projects/MyProject"`. This is a dry run, so read the output first.
2. `node .../migrate-v1-views.mjs "<data>/projects/MyProject" --write --report migrate-report.json`
3. Make the gateway pick up the change: trigger a project scan with `POST /data/api/v1/scan/projects` (API key) or
   `system.project.requestScan()` from a gateway script. The gateway does not watch the projects folder, so without
   the scan it keeps serving the old v1 views from memory. Then reload the Perspective sessions and update the project
   in the Designer. Close every Designer that has the project open **before** `--write`: a Designer save would
   otherwise write its in-memory v1 copy over the migrated files.
4. Work through the [manual steps](#what-the-script-does-not-do-manual-steps).

### Zip workflow (no file-system access to the gateway)

1. Export the project to `MyProject.zip`.
2. `node .../migrate-v1-views.mjs MyProject.zip --write --out MyProject-v2.zip --report migrate-report.json`
3. Import `MyProject-v2.zip` over the project (the gateway's project import with "overwrite", or
   `POST /data/api/v1/projects/import/<name>?overwrite=true` with an API key).

Unchanged entries are copied byte-for-byte; changed `view.json` entries are re-compressed. The script reads ordinary
deflate/stored archives (including the ones the gateway and the Designer produce); ZIP64 and encrypted archives are
refused with a message. For those, unzip, run the folder workflow on the folder, and zip it again.

---

## Reading the output

For each view that holds a Display Template or a CTG Chart, the dry run lists every component with its status and
changes:

```
com.inductiveautomation.perspective/views/Area1/Overview/view.json
  Display Template "root/Cards/TempSP": migrated
    ~ showTagName → label.visible = false
    ~ verticalAlign → layout.verticalAlign = "top"  (v1 default)
    ⇢ props.showUnits → props.units.visible  [binding (property)]
    ! setpoint: written with access.requireLogin=false ...
    MANUAL props.row [binding (property)]: boolean row → layout.direction "row"/"column": ...
```

| Mark | Meaning |
|---|---|
| `~` | a v1 value written under its v2 name; `(v1 default)` = the view did not store it, the v1 default was used |
| `⇢` | a property config (binding, persistence, access, `onChange` script) moved to the v2 key as a whole |
| `!` | a warning: the conversion changed behaviour or needs a decision |
| `i` | a note (for example the aggregation change) |
| `MANUAL` | left in place; you have to fix it (next section) |
| `=` / `-` (`--verbose`) | dropped because it equals the v2 default / has no v2 equivalent |

Component statuses: `migrated`, `migrated (mixed)` (the component already had some v2 props; those win, and only the
stored v1 props are mapped), `migrated (bindings only)`, `already v2`, `already v2 (v1 bindings left)` (manual items
from an earlier run, listed again so they are not forgotten), `skipped (bare, …)`.

An `already v2` component with a binding on `props.setpoint`, `props.bounds`, `props.interaction` or
`props.interaction.mode` gets an `i check by hand: …` note on every run: these names exist in v1 and v2 with different
shapes, so the script cannot tell whether the binding returns the v2 object or a v1 value left over from before the
migration (which would overwrite the v2 object at runtime).

The summary line at the end counts views changed, components migrated, components already v2, bare components skipped,
warnings, manual bindings, external references and errors. Bare components that were skipped as ambiguous are also
listed in an `AMBIGUOUS:` block above it.

### Idempotence and v2 views

Every migrated component keeps at least one v2 prop. When all of its values equal the v2 defaults, the script still
writes one of them as a marker (`units.visible` or `layout.verticalAlign` for a display, `timeRange.mode` or
`query.pointCount` for a chart; shown as `(kept as v2 marker)`). So a second run recognises it as v2, skips it and
changes no byte. Bindings left on v1 keys (`MANUAL` lines) are reported again on that run and stay where they are; a
`props.rangeHours` binding moves only when the chart's realtime unit is `hours`, on the first run and on any later one.
You can run the script on a project that already mixes migrated and new v2 views.

A **bare** component stores no version-specific prop at all (for example `{"tagPath": "…"}` only, which is also what a
v2 display built by a script or by hand can look like). It could be either version, so it follows its view:

| `--bare` | A bare component is migrated as v1 (with v1 defaults) when… |
|---|---|
| `auto` (default) | its view also holds a v1 component. Otherwise it is skipped and listed as `AMBIGUOUS`. |
| `v1` | its view holds no v2 component and no v1 one either, or holds a v1 one. Use it on views listed as `AMBIGUOUS` that you know are v1. |
| `skip` | never |

A view that holds v2 components and no v1 ones is never touched, whatever `--bare` says.

---

## What the script does not do: manual steps

### 1. Bindings that are not 1:1 (`MANUAL` lines)

A binding moves only when the v1 key has exactly one v2 key with the same meaning and type. These stay on the v1 key,
where the v2 component ignores them:

| Component | v1 binding | What to do |
|---|---|---|
| Display | `props.row` (boolean) | bind `props.layout.direction` to an expression such as `if({…}, "row", "column")` |
| Display | `props.boolean`, `props.bounds` (whole objects) | bind the v2 leaves (`states.boolean.trueText`, `bounds.lowColor`, …) |
| Display | `props.bounds.minInclusive` / `maxInclusive` | bind `props.bounds.inclusive` |
| Display | `props.setpoint` **without a static value** | the script cannot tell a v1 boolean binding from a v2 binding that returns the whole setpoint object. Rebind `props.setpoint.enabled` if it returned a boolean. |
| Chart | `props.rawHistory` | bind `props.query.mode` to `if({…}, "raw", "auto")` |
| Chart | `props.dateFormat` / `timeFormat` | bind `props.timeAxis.format` |
| Chart | `props.visibility` (whole object), `visibility.showRangePresets` / `showModeToggle` | bind the `toolbar.buttons.*` / `penTable.visible` leaves |
| Chart | `visibility.showDateRangeSelector` / `showPenControlDisplay` | v1 ignored these flags: remove the binding, or bind `toolbar.buttons.dateRange` / `penTable.visible` if it should now take effect |
| Chart | `props.rangeHours` when the chart's `timeRange.realtime.unit` is not `hours` | a v1 static value below 1 is converted to a smaller unit (0.25 → 15 minutes), and a mixed chart can already store another unit. The binding still produces hours, so it cannot sit next to that unit: bind `props.timeRange.realtime` with the unit you want. The binding stays on `props.rangeHours` on every later run as well. |
| Chart | `props.rangeHours` with an `onChange` script, persistence or access config and **no binding**, when the unit is not `hours` | the value now lives in `timeRange.realtime` with another unit; move the config to `props.timeRange.realtime` by hand (next to unit `hours` it moves like a binding) |
| Chart | `props.interaction`, `interaction.mode`, `interaction.xTraceVisible` | no v2 equivalent: remove the binding |
| Both | a v1 key whose v2 target already has a property config | merge the two by hand |
| Both | a v1 key whose v2 target sits under a **bound** parent or above a **bound** child (e.g. `props.showTagName` when `props.label` is bound), and `props.rangeHours` when `props.timeRange.realtime.unit` is bound | two bindings would write the same value: merge them by hand |

Moved bindings can still need a look; the script warns about these:

- `props.setpoint` → `props.setpoint.enabled`: this is a **security key**. With `ctg.security.rejectBoundGates=true` (the
  default) the gateway fails a bound gate closed, so writes stay disabled while the binding exists, and the gateway logs
  `action=security-key-bound`. Prefer a static value, or see [Security and permissions](security-and-permissions.md) for the opt-out.
- `props.rangeHours` → `props.timeRange.realtime.value` with `unit: "hours"`: v2 needs a value ≥ 1, so a binding that
  produced fractions of an hour must switch to minutes.
- `props.refreshRate` and `props.pointCount`: v2 rejects 1–249 ms and point counts outside 10–5000 (0 = auto).

### 2. External references (the "External references to v1 props" list)

The script searches every string in every `view.json` (bindings of *other* components, event scripts, message handlers,
custom methods, `onChange` scripts) and every project library script (`ignition/script-python/**/code.py`) for
`props.<v1 key>` (also `props['<v1 key>']`) and lists each hit with file, location and line. It never rewrites code.
Typical hits:

```
{../CTG-Chart.props.rangeHours}                        → {../CTG-Chart.props.timeRange.realtime.value} (unit hours)
self.getSibling('DisplayTemplate').props.setpoint = True → ….props.setpoint.enabled = True
chart.props['rangeHours'] = payload['hours']           → see the rename table
```

Hits marked `low` are generic names (`mode`, `row`, `setpoint`, `boolean`, `verticalAlign`, `pointCount`, `refreshRate`,
`startDate`, `endDate`, `dateFormat`, `timeFormat`) that other component types may also have. The script cannot know
which component a path points to, so check whether the target is a Display Template or a CTG Chart before you change it.
Static prop values (label texts and similar) are data and are not searched. Neither are tag event scripts, gateway event
scripts and Vision windows, which live outside the project's Perspective and library folders.

### 3. Review the behaviour changes

- **Units are shown by default in v2.** The script writes `units.visible: false` where v1 hid them; new components show
  units.
- **History aggregation is `MinMax`** unless you used `--keep-aggregation`.
- **Bounds look**: migrated components keep the v1 background colours. New v2 components use the neutral border plus a
  ▲/▼ glyph and can also take their limits from alarm setpoints (`bounds.useAlarmLimits` with `lowAlarmName` /
  `highAlarmName`).
- **Setpoint limits**: v1 never checked limits, so migrated setpoints have `limits.useEngLimits: false`. Turn it on once
  the tags' engineering limits are right. Boolean and option writes now ask for confirmation (`setpoint.confirm` default
  `discrete`).
- **Designer check**: open each migrated view in the Designer. The property editor must not flag invalid props, and the
  components must look like they did in v1 (see also the [Designer checklist](designer.md#manual-checklist)).
- **Tag browser is on by default.** Migrated charts (no `tagBrowser` key in v1) now show the tag browser and accept
  runtime pens from every provider except `ctg.read.deniedProviders` (`[System]` by default), for every user
  including anonymous ones; tag Read Permissions still apply. Set `tagBrowser.enabled: false`, or narrow it with
  `tagBrowser.rootPath` / `readScope.allowedRoots`, on charts that should not browse.

---

## Writes in projects without a login (floor policy)

v1 let anyone who could open a view write a setpoint, with an empty security context (tag Write Permissions were
bypassed). v2 checks every write on the gateway with the **session user's own security context**, under a gateway-wide
**floor policy** that component props cannot weaken. The defaults follow native Perspective (decided for 2.0.0):

- `setpoint.access.requireLogin` (component prop; default **`false`**). The script also writes `false` explicitly for
  migrated setpoints.
- `ctg.write.requireAuthenticated` (gateway setting; default **`false`**). Anonymous sessions can write after the
  migration **as long as the tag's Write Permissions allow it**. A tag whose Write Permissions need a role now refuses
  anonymous writes (it did not in v1). To require a login everywhere, an administrator sets
  `-Dctg.write.requireAuthenticated=true` in `ignition.conf`
  (`wrapper.java.additional.<n>=-Dctg.write.requireAuthenticated=true`) and restarts the gateway. See
  [Gateway settings](gateway-settings.md) and [Security and permissions](security-and-permissions.md).

**Pre-release builds** of 2.0.0 defaulted both to `true`; views saved with an explicit `requireLogin: true` keep it.

Decide this deliberately. A login with roles (`setpoint.access.roles`) is the recommended setup for HMI writes. Related
floor settings: `ctg.write.requiredRoles`, `ctg.write.allowedRoots` (restrict writes to tag folders) and
`ctg.write.deniedProviders` (default `System`).

---

## Rolling back

- **Folders:** every changed file has a `view.json.v1.bak` next to it, holding the bytes from before the first
  migration. To roll back a view, copy the `.bak` over `view.json` and rescan. Once you are satisfied, delete the `.bak`
  files when you no longer need them. The gateway ignores them (they are not project resources, so a project
  export does not contain them).
- **Zips:** import the original export again.
- **Module:** reinstalling v1.x restores the v1 components, but migrated views then need their `.bak` files (v1 does
  not read v2 props).

<!-- nav:bottom -->

---

← Previous: [Operator guide](operator-guide.md) · [Back to index](README.md) · Next: [Troubleshooting](troubleshooting.md) →

<!-- /nav:bottom -->
