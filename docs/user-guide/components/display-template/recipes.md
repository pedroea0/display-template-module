<!-- nav:top -->

[Docs home](../../../README.md) › [User Guide](../../README.md) › [Display Template](README.md) › **Recipes**

<!-- /nav:top -->

# Recipes

Step-by-step setups for common Display Template tasks. Each recipe lists only the props that differ from the defaults;
paste the JSON into the component's props (or set the values in the property editor).

**On this page**

- [Read-only value](#read-only-value)
- [Setpoint for operators](#setpoint-for-operators)
- [Faceplate setpoint (one popup for many tags)](#faceplate-setpoint-one-popup-for-many-tags)
- [Alarm-coloured value](#alarm-coloured-value)
- [Multi-state command with confirmation](#multi-state-command-with-confirmation)
- [On/off value with your own words](#onoff-value-with-your-own-words)
- [Bounds from another tag or from alarm limits](#bounds-from-another-tag-or-from-alarm-limits)
- [Trend popup for one tag](#trend-popup-for-one-tag)
- [Trend page button](#trend-page-button)
- [Custom menu item that opens a view](#custom-menu-item-that-opens-a-view)
- [Compact row layout](#compact-row-layout)

---

## Read-only value

Set `tagPath`. Everything else follows the tag: its Format String, Engineering Units, data type and alarms.

```json
"tagPath": "[default]Area1/Tank1/Level"
```

## Setpoint for operators

Palette entry *Display Template (Setpoint)*, then:

```json
"tagPath": "[default]Area1/Tank1/Level_SP",
"setpoint": {
  "enabled": true,
  "access": { "roles": ["Operator"] },
  "maxStepPercent": 10
}
```

- A role implies a login, so anonymous sessions see the value greyed with *Log in to change this value.*
- `maxStepPercent: 10` refuses (on the gateway) any single change larger than 10 % of the allowed range.
- Give the tag Write Permissions for the same role, so the module's gate and the tag's own rule agree.

Everything the gateway checks: [Who may write](menu-and-setpoints.md#who-may-write).

## Faceplate setpoint (one popup for many tags)

A popup view with a parameter `tagPath` and a Display Template whose `tagPath` is bound to it:

| Prop | Value |
|---|---|
| `tagPath` | property binding `{view.params.tagPath}` |
| `setpoint.enabled` | `true` (static, **not** bound) |
| `setpoint.access.roles` | `["Operator"]` (static, **not** bound) |

Binding `tagPath` to a parameter is allowed: a display can read any tag the user may read, exactly like a Perspective
tag binding. Do **not** bind `setpoint.enabled`, `setpoint.access`, limits or options to parameters: anyone can open a
popup with any parameters, so such bindings make the gate fail closed. If different tags need different rules, derive
them from the user (`session.props.auth.roles`) or use two faceplates. Background:
[Binding lint](../../security-and-permissions.md#binding-lint-security-props-must-not-depend-on-user-input).

## Alarm-coloured value

Tags with alarm configuration need nothing: `alarms.colorMode: "auto"` (default) colours the value by the tag's live
alarm priority and blinks the marker while unacknowledged. To colour by value on a tag **without** alarms, add manual
thresholds:

```json
"alarms": {
  "thresholds": [
    { "priority": "Medium",   "above": 80 },
    { "priority": "Critical", "above": 95 },
    { "priority": "Low",      "below": 10 }
  ]
}
```

The highest matching priority wins; thresholds never blink. To colour the whole tile instead of the value:
`"applyTo": "component"`. To ignore Low and Diagnostic alarms: `"minPriority": "Medium"`.

## Multi-state command with confirmation

A Boolean or an option list is always confirmed before it is written (`setpoint.confirm` defaults to `discrete`):

```json
"setpoint": {
  "enabled": true,
  "options": [ { "value": 0, "label": "Off" }, { "value": 1, "label": "Auto" }, { "value": 2, "label": "Manual" } ]
}
```

`setpoint.options` is the list the operator may pick from; the gateway refuses any other value with `NOT_AN_OPTION`.
When `states.options` is empty, `states.useSetpointOptions` (default on) shows the setpoint labels for the value too,
so in practice you set `setpoint.options` only. Add `states.options` when the display should show labels (or styles)
for values the operator may not pick:

```json
"states": {
  "options": [
    { "value": 0, "label": "Off" }, { "value": 1, "label": "Auto" }, { "value": 2, "label": "Manual" },
    { "value": 9, "label": "Fault", "style": { "backgroundColor": "#B3261E", "color": "#FFFFFF" } }
  ]
}
```

> **Note** A red `style` on a state is your own colour, not an alarm colour: the alarm marker and blink still come from
> the tag's alarms.

## On/off value with your own words

```json
"states": { "boolean": { "trueText": "Running", "falseText": "Stopped" } }
```

With `setpoint.enabled: true` the same texts label the two buttons, and the choice is confirmed before it is written.

## Bounds from another tag or from alarm limits

Mark the value (neutral border plus ▲/▼) when it leaves its normal range.

From the tag's own alarms named *Lo* and *Hi*:

```json
"bounds": { "enabled": true, "lowAlarmName": "Lo", "highAlarmName": "Hi" }
```

From other tags: bind `bounds.low` and `bounds.high` with a tag binding to the limit tags (for example
`[default]Area1/Tank1/Level_LoLimit`). These two props are not security props, so any binding is fine.

| Prop | Binding |
|---|---|
| `bounds.enabled` | `true` |
| `bounds.low` | tag binding `[default]Area1/Tank1/Level_LoLimit` |
| `bounds.high` | tag binding `[default]Area1/Tank1/Level_HiLimit` |

A side that has no finite value falls back to the next source (alarm setpoint, then Engineering Low/High). For the 1.x
coloured background: `"appearance": "background"` plus `lowColor` / `highColor`.

## Trend popup for one tag

1. Install the sample view [TrendPopup.view.json](../../samples/TrendPopup.view.json) as `Popups/TrendPopup`
   (steps in [Samples](../../samples/README.md#trend-popup)).
2. On the display:

```json
"menu": {
  "trendPopup": { "enabled": true, "viewPath": "Popups/TrendPopup", "mode": "singleTag" }
}
```

Right-click → **Open Trend Popup** opens a chart of just this tag. With `"mode": "trendList"` the popup shows the
session trend list of `trendGroup` instead (the tag is added to it first).

## Trend page button

```json
"menu": {
  "trendPage": { "enabled": true, "pagePath": "/trend", "addTag": true }
}
```

**Go to Trend Page** adds the tag to the session trend list and navigates to `/trend`, where a Click To Graph Chart with
the same `trendGroup` shows it. `pagePath` may use `{tagPath}`, `{tagName}` and `{trendGroup}` placeholders.

## Custom menu item that opens a view

```json
"menu": {
  "items": [ { "id": "details", "label": "Details…", "separatorBefore": true } ]
}
```

Then configure the component's **onMenuAction** event (right-click the component > Configure Events...) with a script
action:

```python
def runAction(self, event):
    if event.action == 'details':
        system.perspective.openPopup('details', 'Popups/Details', params={'tagPath': event.tagPath})
```

The item's `access` only hides or greys it. The script runs with the user's own rights, so protect what it does there
too. More: [Events](events.md#onmenuaction).

## Compact row layout

Label and value side by side, each taking half the width, units in the label:

```json
"layout": { "direction": "row", "evenSplit": true },
"units":  { "placement": "label" },
"label":  { "suffix": "" }
```

Shows `Level (%)   72.4`. The text still scales with the component (`layout.autoFontSize`) unless a font size is set
in `style`, `label.style` or `value.style`.

<!-- nav:bottom -->

---

← Previous: [Styling](styling.md) · ↑ Up: [Display Template](README.md) · [Back to index](../../README.md) · Next: [Properties](properties.md) →

<!-- /nav:bottom -->
