<!-- nav:top -->

[Docs home](../README.md) › **User Guide**

<!-- /nav:top -->

# User Guide

For integrators who build Perspective views with the module and for the gateway administrators who run it. Every
component, property, event and gateway setting is described here.

## Recommended reading path

1. **[Getting started](getting-started.md)**: install the module and build a first screen (15 minutes).
2. **The component you are using**: start at its overview page, then read the guides, and keep the property reference
   open while you configure.
   - [Display Template](components/display-template/README.md)
   - [Click To Graph Chart](components/ctg-chart/README.md)
3. **[Security and permissions](security-and-permissions.md)**: what is allowed by default and how to lock it down,
   before you put setpoints on a production screen.
4. **[Gateway settings](gateway-settings.md)**: only when you need to tighten a rule or tune a limit.
5. Before going to production, read **[Known limitations](known-limitations.md)**.
6. Keep **[Troubleshooting](troubleshooting.md)** and the **[Glossary](glossary.md)** at hand.

## All pages

### Start

| Page | What is in it |
|---|---|
| [Getting started](getting-started.md) | install, first value, first setpoint, first chart, trend with right-click, tag browser |

### Display Template

| Page | What is in it |
|---|---|
| [Overview](components/display-template/README.md) | what it shows, palette variants, how the value is formatted, status texts, alarm and limit colours, Designer vs runtime |
| [Menu and setpoints](components/display-template/menu-and-setpoints.md) | entry modes, confirmation, limits, step guard, who may write, the right-click menu, trend groups, the audit trail |
| [Styling](components/display-template/styling.md) | the style cascade, project-wide CSS, style classes, theme tokens, class names, state colours |
| [Recipes](components/display-template/recipes.md) | faceplate setpoint, alarm-coloured value, multi-state command, bounds from another tag, trend popup, custom menu item |
| [Properties](components/display-template/properties.md) | every property, grouped, with type, default, valid values and examples |
| [Events](components/display-template/events.md) | `onSetpointWrite`, `onTagConfigEdit`, `onTrendChange`, `onMenuAction`: when they fire, payloads, scripts |

### Click To Graph Chart

| Page | What is in it |
|---|---|
| [Overview](components/ctg-chart/README.md) | what it shows, click to graph, pens from props vs the trend list, read scope, time range, states and badge, outputs |
| [Interaction](components/ctg-chart/interaction.md) | X-Trace, pan, zoom, range brush, notes, keyboard and touch, following live, range selector, fullscreen |
| [Pens, axes and plots](components/ctg-chart/pens-axes-plots.md) | pen options, curve types, per-state styles, axes, stacked plots, aggregation, raw vs aggregated, point caps |
| [Panels and tools](components/ctg-chart/panels-and-tools.md) | toolbar, pen table and statistics, settings panel, tag browser and search, date range, export, annotations, styling |
| [Recipes](components/ctg-chart/recipes.md) | trend page, one list per area, fixed pens, two axes, stacked plots, limit lines, historical report, scoped tag browser |
| [Properties](components/ctg-chart/properties.md) | every property, grouped, with type, default, valid values and examples |
| [Events](components/ctg-chart/events.md) | `onPensChange`, `onRangeChange`, `onXTraceChange`, `onBrushChange`: when they fire, payloads, scripts |

### Styling and themes

Both components take their colours from CSS custom properties (theme tokens) and expose stable class names, so one rule
in the project's advanced stylesheet (Designer › Perspective › Styles) changes every instance in the project.

| I want to... | Go to |
|---|---|
| Change a colour or font for every display (e.g. `--dt-setpoint-color` for writable values) | [Project stylesheet and theme](components/display-template/styling.md#every-display-project-stylesheet-and-theme) |
| See every display colour token and CSS class | [Theme tokens](components/display-template/styling.md#theme-tokens), [Class names](components/display-template/styling.md#class-names) |
| Know which style wins (component props, style classes, stylesheet, state colours) | [The cascade](components/display-template/styling.md#the-cascade-what-wins) |
| Style the chart, its menus and dialogs (`--ctg-*` tokens) | [Chart styling](components/ctg-chart/panels-and-tools.md#styling) |

### Gateway, security and operations

| Page | What is in it |
|---|---|
| [Gateway settings](gateway-settings.md) | every `-Dctg.*` setting: default, range, effect, when to change it; how to set it permanently or live |
| [Security and permissions](security-and-permissions.md) | how writes, reads, browsing and history are authorized; defaults; trusted props; binding lint; recommended setup |
| [Working in the Designer](designer.md) | design mode vs preview mode, what is intentionally different, Designer-only badges, a manual checklist |
| [Operator guide](operator-guide.md) | one page for operators: colours, markers, setpoint feedback, the chart's badge and tools |
| [Upgrading from 1.x](upgrading-from-v1.md) | breaking changes, rename tables, the migration script, manual steps, rollback |

### Reference and help

| Page | What is in it |
|---|---|
| [Troubleshooting](troubleshooting.md) | symptoms with causes and fixes, gateway log lines, every error code with its message |
| [Known limitations](known-limitations.md) | what is not supported or not yet tested, deliberate behaviours, their impact and workarounds |
| [FAQ](faq.md) | short answers to common questions |
| [Glossary](glossary.md) | pen, trend list, trend group, floor policy, read scope and the other terms |
| [Samples](samples/README.md) | a trend popup view, an audit log table, setpoint logging scripts |

<!-- nav:bottom -->

---

[Back to index](../README.md) · Next: [Getting started](getting-started.md) →

<!-- /nav:bottom -->
