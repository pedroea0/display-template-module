<!-- nav:top -->

[Docs home](../../../README.md) › [User Guide](../../README.md) › **Display Template**

<!-- /nav:top -->

# Display Template

The **Display Template** shows one tag: its label, live value, units, quality, alarm and limit markers. It can also be a
**setpoint** (the operator writes a new value) and has a right-click menu that feeds the
[Click To Graph Chart](../ctg-chart/README.md).

| | |
|---|---|
| Palette category | **Display** |
| Palette entries | *Display Template*, *Display Template (Setpoint)*, *Display Template (Row)* |
| Default instance name | `DisplayTemplate` |
| Component ID | `com.example.simpletagdisplay.SimpleTagDisplay` (unchanged since 1.x) |
| Minimum configuration | `tagPath`; every other prop has a default |

**On this page**

- [Pages about this component](#pages-about-this-component)
- [What it shows](#what-it-shows)
- [Palette variants](#palette-variants)
- [How it works](#how-it-works)
- [Showing the value](#showing-the-value)
- [Status texts and connection loss](#status-texts-and-connection-loss)
- [Limits, alarms and the colour policy](#limits-alarms-and-the-colour-policy)
- [Designer vs runtime](#designer-vs-runtime)
- [Gateway load](#gateway-load)

## Pages about this component

| Page | What is in it |
|---|---|
| [Menu and setpoints](menu-and-setpoints.md) | the right-click menu, trend groups, setpoint entry modes, confirmation, limits, who may write, the audit trail |
| [Styling](styling.md) | how `style`, classes and project CSS combine, theme tokens, class names, a project-wide look |
| [Recipes](recipes.md) | step-by-step setups: faceplate setpoint, alarm-coloured value, multi-state command, bounds from another tag, trend popup |
| [Properties](properties.md) | **every** prop: path, type, default, valid values, what it does, examples |
| [Events](events.md) | the four component events, their payloads and script examples |

Operators: what every colour and marker means is on the one-page [operator guide](../../operator-guide.md).

---

## What it shows

A simplified sketch of the parts and the props that control them:

```
 ┌──────────────────────────┐
 │ Tank 1 Level             │  ← label (label.*): the tag name, or your text
 │ 72.4 %  ▲2               │  ← value (value.*) + units (units.*) + alarm marker (alarms.*)
 └──────────────────────────┘
```

| Part | Comes from | Props |
|---|---|---|
| Label | the tag's name (last part of `tagPath`) unless you set a text | `label.*` |
| Value | the live tag value, formatted with the tag's own Format String unless you set one | `value.*`, `states.*` |
| Units | the tag's Engineering Units, numbers only | `units.*` |
| Quality cue | magenta outline (plus an icon) for Uncertain and Bad quality | `quality.*` |
| Limit marker | a neutral slate border and ▲/▼ when the value is outside its normal range | `bounds.*` |
| Alarm colour and marker | the tag's live alarm state (priority colour plus a numbered shape) | `alarms.*` |
| Setpoint look | the theme's call-to-action colour, optional pencil icon | `setpoint.*` |

In row layout (`layout.direction: "row"`) the label sits beside the value (`Temp: 72.4 degF`).

## Palette variants

| Palette entry | Starts with |
|---|---|
| Display Template | the defaults (read-only value, label above it) |
| Display Template (Setpoint) | `setpoint.enabled: true` |
| Display Template (Row) | `layout.direction: "row"` (label beside the value) |

The variants differ only in their starting props; you can switch any instance between them by editing those props.

## How it works

Each component opens a channel to a gateway-side **delegate** (one per component instance). The delegate subscribes to
the tag with the logged-in user's security context and pushes the value, quality, metadata (units, format, engineering
limits, data type, history availability) and alarm state to the browser. Writes, tag configuration edits, trend changes
and the change-history query are messages on the same channel, and the gateway checks each one again before it acts.

Props marked **[S]** in the [property reference](properties.md) are read by the gateway, so changing them in the browser
has no effect (the change is put back and logged). See
[Security and permissions](../../security-and-permissions.md#trusted-props).

---

## Showing the value

**Numbers** use, first match wins: `value.decimals` (fixed decimals), `value.format` (a Numeric Entry Field pattern such
as `#,##0.00`, `0.0%` or `0.00E0`), the tag's **Format String**, then `#,##0.##`. Formatting follows the session locale,
so `1234.5` is `1,234.5` in `en-US` and `1.234,5` in `de-DE`. Very large integers (`Int8` beyond 2^53) are shown exactly.

**Booleans** show `states.boolean.trueText` / `falseText` (default `true` / `false`). **Multi-state values** use
`states.options` (value → label, optional per-state style). **Strings** are shown as they are; no number parsing
happens, so `"0x1A"` stays `0x1A`. **DateTime** tags use `value.dateFormat` in the session time zone. **Arrays** show
the first `value.maxArrayItems` elements; **datasets** show their size.

**Units** (`units.*`) are appended to numbers only, never to Boolean, string or state labels. `units.text` overrides the
tag's Engineering Units; `units.placement: "label"` moves them into the label (`Temp (degF)`). With the label hidden
(`label.visible: false`) they stay with the value, so the unit never disappears from the screen.

**Quality** keeps the last value on screen and marks it: a dashed magenta outline for Uncertain, a solid magenta outline
for Bad, plus a small icon (`quality.indicator`). `quality.hideValueOnBad` replaces the value with `quality.badText`
instead; nothing is then derived from the hidden value either (no ▲/▼ bounds and no `alarms.thresholds` colour), while
the tag's live alarm state from the gateway still shows. Quality never uses alarm colours.

## Status texts and connection loss

Status texts replace the value when the display cannot show one:

| Text | Meaning |
|---|---|
| `Set tagPath` | Designer only: no tag is configured |
| `…` (`value.loadingText`) | waiting for the first value |
| `Invalid tag path` | the path is a property (`.EngUnit`), an alarm path, or otherwise not a tag path |
| `Tag not found` | no tag at that path |
| `No access` | the user lacks Read permission on the tag |

While the connection to the gateway is lost, the last value stays, **dimmed and underlined**, with a "disconnected"
icon, until the connection is back. A display that hears nothing for 75 s (with the default heartbeat), or a page whose
watchdog ping is unanswered for 8 s, shows this look.

---

## Limits, alarms and the colour policy

### Bounds (`bounds.*`): is the value outside its normal range?

With `bounds.enabled`, each limit comes from, first match wins:

1. `bounds.low` / `bounds.high` (bindable, for example to a limit on another tag),
2. the `SetpointA` of the tag alarm named in `bounds.lowAlarmName` / `bounds.highAlarmName` (when `bounds.useAlarmLimits`),
3. the tag's Engineering Low / High (when `bounds.useEngLimits`).

A side without a finite value is skipped; if low is above high, both are skipped. The default look is **neutral**: a
slate-blue (low) or slate-indigo (high) border plus a ▼/▲ glyph, so "out of range" is never confused with an alarm.
`bounds.appearance: "background"` with `lowColor`/`highColor` gives the 1.x coloured background.

### Alarm colours (`alarms.*`): is there an alarm?

`alarms.colorMode: "auto"` (default) colours the value by the tag's **live alarm state**. With `alarms.basis:
"activeOrUnacked"` (default) the colour is the higher of the highest active and the highest unacknowledged priority, and
the display blinks while any unacknowledged alarm at or above `alarms.minPriority` remains; `minPriority` applies to
each of the two before the higher one is picked (an active Diagnostic alarm never hides an unacknowledged Critical one).
With `"active"` only active alarms colour, and the display never blinks: the gateway reports only the highest active and
the highest unacknowledged priority, so whether the *active* alarm is acknowledged cannot be told (use the default basis
for the blink). Tags without alarm configuration fall back to the manual `alarms.thresholds`. Each priority has a colour
and a **marker** next to the value, so priority is never shown by colour alone:

| Priority | Marker | Default background |
|---|---|---|
| Critical | ◆ with **1** | dark red `#B3261E` |
| High | ▲ with **2** | orange `#B54700` |
| Medium | ● with **3** | yellow `#F2C200` (dark text) |
| Low | ▼ with **4** | blue `#1F5FA8` |
| Diagnostic | ■ with **D** | grey `#5E5E5E` |

Unacknowledged alarms blink the marker (`alarms.blink: "indicator"`); the value stays readable. `"value"` blinks the
coloured area, `"off"` never blinks, and nothing blinks for users who ask their OS for reduced motion (they get a solid
outline instead).

### Colour policy

- **Alarm hues** (red, orange, yellow, blue, grey above) are reserved for alarms.
- **Limits** use neutral slate colours plus ▲/▼.
- **Quality** uses magenta outlines plus an icon.
- **Connection loss** dims and underlines the value plus an icon.
- **Writable values** use the theme's call-to-action colour (`--dt-setpoint-color`).

When several apply, the order is: your `value.style` > lost connection (combined with the rest) > status texts > quality
> alarm > bounds > setpoint colour. A disabled component keeps its alarm colours. How to change the colours:
[Styling](styling.md).

---

## Designer vs runtime

| Situation | Behaviour |
|---|---|
| Designer, design mode | looks like runtime: live value, quality, alarm and bounds colours, setpoint colour / style / edit icon, auto font size; no menu, no editing, no events. A display without `tagPath` shows *Set tagPath*. Until the first value arrives it shows a sample value formatted like the real one. |
| Designer, preview mode | runtime behaviour. Writes and configuration edits need the Read/Write communication mode (`DESIGNER_READ_ONLY` otherwise). Navigation is skipped. |
| `enabled: false` | the value stays live; no menu, no editing, no trending, not focusable. Alarm colours stay. |
| A view still holding 1.x props | the 1.x props are ignored. The browser console warns once per view, and the Designer shows a small badge *v1 props: run tools/migrate-v1-views.mjs*. See [Upgrading from 1.x](../../upgrading-from-v1.md). |
| A gateway setting is stricter than the display's access config | Designer only: a small orange **Gateway rule** badge in the top-left corner; its tooltip names the settings (for example `ctg.write.requireAuthenticated`). |

The Designer preview and a manual checklist for it are on the [Designer page](../../designer.md#display-template).

## Gateway load

Each display subscribes to its tag, plus the alarm summary only when `alarms.colorMode` is `auto` (and the tag has
alarms) or `live`, plus the named alarm setpoints and the engineering limits only when bounds or setpoint limits use
them: typically one to five subscriptions. Other metadata is re-read every `ctg.display.metaRefreshMs` (60 s) and after
a configuration edit. Value pushes are coalesced every `ctg.display.coalesceMs` (150 ms). When nothing changes, the
gateway sends a heartbeat every `ctg.display.heartbeatMs` (30 s). All three are
[gateway settings](../../gateway-settings.md#display-and-chart-pushes).

<!-- nav:bottom -->

---

← Previous: [Getting started](../../getting-started.md) · [Back to index](../../README.md) · Next: [Menu and setpoints](menu-and-setpoints.md) →

<!-- /nav:bottom -->
