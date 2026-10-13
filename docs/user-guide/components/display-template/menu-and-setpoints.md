<!-- nav:top -->

[Docs home](../../../README.md) › [User Guide](../../README.md) › [Display Template](README.md) › **Menu and setpoints**

<!-- /nav:top -->

# Menu and setpoints

How operators change a value with a Display Template, what the gateway checks before it writes, and what the
right-click menu offers. Every prop named here is listed with its default and valid values in the
[property reference](properties.md).

**On this page**

- [Turning a display into a setpoint](#turning-a-display-into-a-setpoint)
- [Entry modes](#entry-modes)
- [Inline editing details](#inline-editing-details)
- [Confirmation, step guard and read-back](#confirmation-step-guard-and-read-back)
- [Limits](#limits)
- [Who may write](#who-may-write)
- [When the gateway does not answer](#when-the-gateway-does-not-answer)
- [Strings, dates and other types](#strings-dates-and-other-types)
- [The right-click menu](#the-right-click-menu)
- [Trend groups](#trend-groups)
- [Audit trail (who changed what)](#audit-trail-who-changed-what)

---

## Turning a display into a setpoint

Use the *Display Template (Setpoint)* palette entry, or set `setpoint.enabled: true` on any display. The value then
shows in the theme's call-to-action colour (blue by default) and becomes clickable.

```json
"setpoint": { "enabled": true, "access": { "roles": ["Operator"] } }
```

The gateway checks, in this order: the component is enabled, `setpoint.enabled`, the tag path rules, the gateway floor
policy, `setpoint.access`, the tag's quality, the limits, the step guard, and finally the tag's own Write Permissions.
Details: [Who may write](#who-may-write).

## Entry modes

`setpoint.mode` picks how the operator edits (the same three modes as the Numeric Entry Field):

| Mode | How the operator edits | Notes |
|---|---|---|
| `popup` (default) | click or Enter on the value opens a dialog with the current value, the new value, the allowed range and Write/Cancel | the dialog follows the on-screen keyboard on tablets; `setpoint.popup.*` sets its title, position and behaviour |
| `direct` | the value is an input field; type and press Enter | `setpoint.commitOnBlur` makes leaving the field write (Numeric Entry Field behaviour) |
| `protected` | double-click, double-tap or a 1 s mouse press on the value, then type and press Enter | prevents accidental edits on touch screens |

The context menu's **Set Value…** opens the popup in every mode. Booleans and option lists use buttons (up to five
choices) or a dropdown (`setpoint.optionsControl`). On iPad/iPhone keypads without a minus key the input gets a `±`
button whenever negative values are possible. `setpoint.spinner` adds − / + buttons to numeric inputs.

## Inline editing details

These apply to `direct` and `protected` mode:

- Enter writes whenever the entry differs from the tag's **current** value, also when it is the text the editor opened
  with (after *Current value changed to …*, Enter puts the old value back); an entry equal to the current value writes
  nothing. Leaving the field with `commitOnBlur` writes only when the operator changed something.
- A short guard change (a Bad-quality scan, a capability reload) keeps the typed text: the editor shows why writing is
  off and Enter is refused with that reason until it clears.
- After a write or Esc the field keeps focus: a click on it or a typed character starts the next edit (the character is
  the first one typed), and a closed menu or dialog gives focus back to it.
- In `direct` mode a right-click on the value opens the display menu (the browser's text menu only while typing).
  Shift+F10 / the context-menu key while typing leaves the editor to the browser, like a right-click (it never commits
  the typed text).
- The value keeps its alarm, bounds and `value.style` colour and its stale / not-allowed dimming while idle.
- Integers are edited exactly (no rounding of large Int8 values; the spinner steps them with whole-number arithmetic and
  stops at the nearest whole number inside fractional limits).
- A String longer than 4096 characters cannot be edited here (only its first 4096 characters reach the browser), nor can
  a String that contains line breaks (the single-line editors would drop them).

## Confirmation, step guard and read-back

- **Confirm** (`setpoint.confirm`): `discrete` (default) never writes a Boolean or option on the first tap; the
  operator picks, then confirms. `always` confirms every write; `never` writes on Enter / Write. In an inline option
  list, the arrow keys (and type-ahead) only move the selection; Enter, leaving the field with `commitOnBlur`, or a
  pick from the opened list commits it.
- **Step guard** (`setpoint.maxStep`, `setpoint.maxStepPercent`, **[S]**): the gateway refuses a change larger than the
  limit with `STEP_TOO_LARGE`. If the current value is not a finite number, a configured step guard refuses the write
  (it cannot be checked). A step guard bound to a tag whose binding delivers nothing or a Bad quality (tag deleted or
  renamed, provider down) refuses every write with `LIMITS_UNAVAILABLE` instead of switching itself off.
- **Big-change warning** (`setpoint.confirmAbovePercent`): a screen-only "are you sure?" for large changes. Use the step
  guard when the limit must be enforced.
- **Read-back** (`setpoint.verifyMs`, default 3 s): after a successful write, if the tag does not show the written value
  at the end of that window, the operator sees *Written, but the tag reads X.* This catches PLC logic that overrides
  the setpoint.
- **Option lists** (`setpoint.options`, **[S]**): when not empty, the operator picks from the list and the gateway
  refuses any other value with `NOT_AN_OPTION`.

## Limits

`setpoint.limits` (**[S]**) checks numeric writes against `limits.low`/`limits.high` when set, otherwise against the
tag's Engineering Low/High when `limits.useEngLimits` is on (default). The check **fails closed**:

- a range with low above high gives `LIMITS_INVALID`;
- engineering limits that cannot be read give `LIMITS_UNAVAILABLE`;
- a **bound** `limits.low`/`limits.high` whose binding delivers nothing or a Bad quality (the bound tag was deleted or
  renamed, or its provider is down) refuses the write with `LIMITS_UNAVAILABLE` and greys the setpoint out; an empty
  (unbound) side still means "not set".

Nothing is written in any of these cases.

> **Important** Tags whose limits were never configured report 0 and 100, so every write outside 0–100 is refused. Review
> `EngLow`/`EngHigh` before you rely on them, or set `setpoint.limits.useEngLimits: false`.

With exclusive limits (`limits.inclusive: false`) the spinner and the arrow keys stop inside the range, never on a limit.
The setpoint dialog shows the allowed range (`setpoint.popup.limitsVisible`).

## Who may write

A write goes through only when **all** of these allow it:

1. `enabled` and `setpoint.enabled` are true (both **[S]**).
2. The user matches `setpoint.access`: logged in when `requireLogin` (default **false** since 2.0.0, like native
   Perspective writes), at least one of `roles` (exact, case-sensitive names) and at least one of `securityLevels`, when
   given.
3. The gateway **floor policy** allows it. By default it adds no login requirement
   (`ctg.write.requireAuthenticated=false`); the administrator can require a login for every display, require roles,
   restrict writes to tag folders and deny providers (`[System]` is denied by default). See
   [Gateway settings](../../gateway-settings.md#floor-policy-writes-and-tag-configuration-edits).
4. The tag's **Write Permissions** allow the user (enforced by Ignition itself; a denial is `WRITE_DENIED`). Writes run
   with the session user's security context, so an anonymous session can write only tags whose Write Permissions allow
   it.
5. The value has good quality, unless `setpoint.allowOnBadQuality`.

`setpoint.whenNotAllowed: "disable"` (default) keeps the writable look greyed and explains the reason when clicked
("Log in to change this value.", "You don't have permission to change this value.", ...); `"hide"` shows a plain value.
When a **gateway setting** refuses what `setpoint.access` allows, the reason names it, e.g. *This gateway requires a
login for every write (gateway setting ctg.write.requireAuthenticated).*, and in the Designer a **Gateway rule** badge
on the display lists the settings that override its access config (never shown in a client).

Tag configuration edits (`menu.configEdit.access.requireLogin`) and the change history
(`menu.changeHistory.access.requireLogin`) keep a login as their default: an edit changes the tag for every screen and
user, and the history shows who changed what, so both are more sensitive than writing a value.
In the Designer, writes work only in **Read/Write** communication mode.

The whole model, with every action and the role setup we recommend:
[Security and permissions](../../security-and-permissions.md).

> **Important** Do not bind `setpoint.enabled`, `setpoint.access`, limits or options to view parameters or custom props.
> Anyone can open a popup with any parameters, so such a binding makes the gate fail closed
> (`BOUND_BIDIRECTIONAL` / "Editing is turned off"). See
> [Binding lint](../../security-and-permissions.md#binding-lint-security-props-must-not-depend-on-user-input).

## When the gateway does not answer

The dialog never retries by itself. After `ctg.read.timeoutMs` + `ctg.write.timeoutMs` + 5 s without an answer (20 s
with the default settings, never less than 15 s) it says *No confirmation received. The value may or may not have been
written. Check the current value before trying again.* and re-enables Write only after the operator edits the value.

- Pressing Write again with the same value after a **client** timeout re-sends the same request id, so the gateway
  answers from its idempotency cache instead of writing twice.
- After a gateway `TIMEOUT` reply the next attempt is a new request (the gateway's cached `TIMEOUT` would otherwise be
  replayed forever); the forced edit protects against a reflex double write.
- A refusal the write handler never saw (`RATE_LIMITED`, `MODULE_STOPPING`, `DISCONNECTED`) keeps the request id
  unchanged.

## Strings, dates and other types

String tags accept up to `setpoint.maxStringLength` characters. DateTime, Dataset, Document and array tags cannot be
written from a display ("Cannot write <type> values").

---

## The right-click menu

Open it with a right-click (Ctrl+click on macOS), a long press on touch (`menu.longPressMs`), or Shift+F10 / the
context-menu key on a focused value. The menu opens immediately from state the gateway already pushed; every action is
checked again on the gateway.

| Item | Prop | Default | Notes |
|---|---|---|---|
| Header (label + tag path) | `menu.headerVisible` | on | |
| **Trend Tag** / **Remove from Trend** | `menu.trend` [S] | on | adds the tag to the session trend list `trendGroup`. Greyed *No history available* for tags without history; *Cannot trend String tags* for non-numeric tags; *Trend list full (32)* at `ctg.trend.maxPens`. |
| Go to Trend Page | `menu.trendPage` | off | navigates to `pagePath` (`{tagPath}`, `{tagName}`, `{trendGroup}` placeholders), optionally adding the tag first |
| Open Trend Popup | `menu.trendPopup` | off | opens `viewPath` as a popup with params `tagPath`, `tagName`, `trendGroup`, `mode`; `mode: "singleTag"` shows only this tag. A ready-made view: [Samples](../../samples/README.md#trend-popup) |
| Set Value… | `menu.setValue` | on (when a setpoint) | opens the setpoint dialog |
| Tag Configuration… | `menu.configEdit` [S] | off | edits the tag's Engineering Units, Low and High **for every user and screen**; checked on the gateway, audited as `tag edit` |
| Change History… | `menu.changeHistory` [S] | off | the last `limit` writes and configuration edits of this tag from the audit profile |
| Copy Tag Path | `menu.copyPath` | off | |
| Custom items | `menu.items[]` | none | each fires `onMenuAction` with `action` = the item `id` |

`menu.whenNotAllowed` greys (default) or hides items the user may not use. The `access` of a custom item only hides or
greys it; the action you attach runs with the user's own rights, so protect it there too. When the component's
`meta.contextMenu` is enabled, Perspective's own menu is used instead.

## Trend groups

`trendGroup` (default `"default"`) names a per-session list of tags. **Trend Tag** adds the tag to that list, and every
Click To Graph Chart in the same session with the same `trendGroup` shows the list, in every browser tab of the
session. Use one group per plant area. Lists are cleared when the session ends or the logged-in user changes
(`ctg.trend.clearOnUserChange`). A list holds at most `ctg.trend.maxPens` tags (32 by default).

---

## Audit trail (who changed what)

Every write and tag configuration edit that reaches the tag provider is recorded twice:

1. In the project's **audit profile** (set in the Designer's project properties; profiles are created under
   **Platform > Security > Audit Profiles**; or the gateway fallback
   `-Dctg.audit.fallbackProfile=<profile>`): action `tag write` or `tag edit`, actor = the Perspective user, target =
   the tag path, status GOOD / BAD / UNCERTAIN, value `<new> (was <old>) [ui=<mode>] [auditId=<id>]`.
2. On the gateway logger `SimpleTagDisplay.Audit` (shown as `S.Audit` in `wrapper.log`), one INFO line per attempt:
   `action=tag-write result=Good user=operator host=… project=Plant session=… scope=Client view=Area1/Overview
   component=… tag=[default]Area1/TempSP old=75.0 new=80.0 ui=popup display=80 auditId=… `.

The `auditId` is also in the `onSetpointWrite` / `onTagConfigEdit` event and in the write reply, so the three can be
matched. A write whose result is unknown after `ctg.write.timeoutMs` is recorded as UNCERTAIN and then again with
`late=true` when the provider answers.

Without any audit profile the module logs one WARN per project (`action=audit-unavailable`) and records writes only in
the gateway log. Set `-Dctg.audit.required=true` to refuse writes (`AUDIT_UNAVAILABLE`) when the record cannot reach a
profile; the refusal is atomic, also under concurrent writes.

Ways to read the trail:

- **Change History…** in the context menu (`menu.changeHistory`): the newest `limit` entries for this tag, as a table
  (Time, User, Change, Result). The query runs on the gateway with the user's rights; a user without Read permission on
  the tag gets nothing. A row's tooltip shows its `auditId`, taken only from the module's suffix at the very end of the
  record, so `[auditId=…]` text typed into a String value is never shown as the id.
- **A Perspective view with a table**: [samples/AuditLogView.md](../../samples/AuditLogView.md).
- **Your own log table** from the `onSetpointWrite` event: [samples/setpoint-log-script.md](../../samples/setpoint-log-script.md).
- The gateway's **Audit Logs** page and the **Logs** page filtered on `SimpleTagDisplay.Audit`.

<!-- nav:bottom -->

---

← Previous: [Display Template](README.md) · [Back to index](../../README.md) · Next: [Styling](styling.md) →

<!-- /nav:bottom -->
