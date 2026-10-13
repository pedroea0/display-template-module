<!-- nav:top -->

[Docs home](../README.md) › [User Guide](README.md) › **Working in the Designer**

<!-- /nav:top -->

# Working in the Designer

How the two components behave in the Ignition Designer, what is intentionally different from a client session, and a
short manual checklist to confirm the Designer preview on your own gateway.

**On this page**

- [Design mode and preview mode](#design-mode-and-preview-mode)
- [Display Template](#display-template)
- [Click To Graph Chart](#click-to-graph-chart)
- [What is intentionally different](#what-is-intentionally-different)
- [Designer-only badges](#designer-only-badges)
- [Manual checklist](#manual-checklist)

---

## Design mode and preview mode

| Designer mode | What the components do |
|---|---|
| **Design mode** (editing the view) | they draw what an operator would see: live values, colours, the chart's data, toolbar and pen table. Nothing that changes something happens: no menus, no editing, no writes, no prop writes from the chart, no events. |
| **Preview mode** (the play button) | runtime behaviour, with the Designer's own rules: writes and tag configuration edits need the **Read/Write** communication mode, navigation is skipped, and the chart does not write its runtime-only props (see below). |

Both components read and write as the **Designer user**, with that user's tag permissions, exactly like a client
session of that user.

## Display Template

In design mode the display looks the way an operator sees it at runtime, so styling can be judged without preview mode:

- **Setpoint look from the props alone**: `setpoint.color`, `setpoint.style`, the edit icon and the direct-mode field
  show as soon as `setpoint.enabled` is on. Reasons that depend on who is looking (the Designer user, a read-only
  Designer, a capability reply still on its way) do not grey it out in design mode; data problems (bad quality, a
  missing tag, a lost connection) still do, as at runtime. Nothing can be written in design mode.
- **Auto font size** (`layout.autoFontSize`) is measured from the component's layout box, so the Designer's canvas zoom
  does not change it, and it is recomputed at once when `valueScale`, `labelScale`, `min`, `max` or the root `style`
  change.
- **Placeholder value**: until the gateway sends the tag's first value, design mode shows a sample value formatted like
  the real one (`123.4` with the configured format / decimals, or the first state label). Its tooltip says it is a
  preview. Runtime and preview mode show `value.loadingText` instead.
- **No tag yet**: a display without `tagPath` shows *Set tagPath*.
- **Preview mode** follows the runtime rules exactly, including the Designer's communication mode for writes
  (`DESIGNER_READ_ONLY` in Read-Only mode).

## Click To Graph Chart

Design mode draws the chart as an operator sees it, so layout and colours can be judged without preview mode:

- data loads and refreshes; the toolbar, badge and pen table are drawn;
- the plot is sized from the layout box (not the zoomed canvas);
- the pen table keeps its colour, edit and remove buttons, drawn disabled;
- a chart whose tag browser opens on start (`tagBrowser.openOnStart`) shows the browser frame at its runtime width, with
  a note that panels need preview mode;
- no gestures, menus, panels or prop writes, and no events.

In **preview mode** the chart behaves as at runtime, but it does not write `outputs`, pinned traces, brushes or
`interaction.fullscreen`, so previewing does not change the view. Edits you make on purpose (settings panel, date
range, pens) **are** written, and you can save them into the view. Notes (annotations) need the Read/Write
communication mode.

## What is intentionally different

| Difference | Why |
|---|---|
| No menus, editing or events in design mode | a click in design mode selects the component; nothing may change a tag while you edit a view |
| Permission-dependent greying is skipped in design mode (Display Template) | you design for the operator, not for the Designer user; preview mode shows the real rules |
| The chart writes no `outputs`, traces, brushes or fullscreen state in preview | so that previewing does not leave runtime state in the saved view |
| Designer history tokens live 5 minutes (`ctg.token.designerTtlMs`) and are bound to the Designer's address | a Designer is a long-lived, single-user session |
| Annotations written in the Designer record no identity provider | Designer sessions report none; see [Annotations](components/ctg-chart/panels-and-tools.md#annotations) |
| Security props are adopted from the Designer as you type | Designer users can edit and save the view anyway; the gateway guards client sessions |

## Designer-only badges

| Badge | Shown on | Meaning |
|---|---|---|
| **v1 props: run tools/migrate-v1-views.mjs** | either component | the view still holds 1.x props, which are ignored; see [Upgrading from 1.x](upgrading-from-v1.md) |
| **Gateway rule** (orange, top-left) | Display Template | a gateway setting is stricter than the display's own access config (for example `ctg.write.requireAuthenticated=true` while `setpoint.access.requireLogin` is false). The tooltip names the settings. Never shown in a client. |

## Manual checklist

Run these once on your gateway after installing or upgrading the module. They need a writable numeric tag with history.

**Display Template**

| # | Step | Expected |
|---|---|---|
| D1 | Drop a *Display Template (Setpoint)*, set `tagPath` to a writable numeric tag, stay in design mode, Designer communication mode **Read-Only** | the value is drawn in the setpoint colour (blue by default) with the pencil icon, not greyed |
| D2 | Set `setpoint.color` to `#D500F9` | the value turns magenta at once, in design mode |
| D3 | Set `setpoint.style.backgroundColor` to `#FFF59D` | the value gets the yellow background at once |
| D4 | Set `setpoint.mode` to `direct` | the value becomes an input-looking field; clicking it in design mode does not start an edit |
| D5 | Leave `layout.autoFontSize.enabled` on (default) and no font size in `style`, then resize the component on the canvas | the value and label grow and shrink with the box |
| D6 | With D5 on, change `layout.autoFontSize.valueScale` from 0.15 (default) to 0.3 (no resize) | the value text gets larger at once |
| D7 | Zoom the Designer canvas to 50 % and 200 % | the text keeps the same size relative to the component (the zoom scales both) |
| D8 | Open a client (or Designer preview mode) on the same view | value colour, background, icon and font sizes match the Designer |
| D9 | Change `tagPath` to a tag that does not exist yet, then back | design mode shows *Tag not found*, then the live value; a sample value shows only until the first value arrives |
| D10 | On a test gateway, set `-Dctg.write.requireAuthenticated=true` (see [Gateway settings](gateway-settings.md)) | the Designer shows the orange **Gateway rule** badge on the setpoint display; in an anonymous client the value is greyed and its tooltip names `ctg.write.requireAuthenticated` |

**Click To Graph Chart**

| # | Step | Expected |
|---|---|---|
| C1 | Drop a *Click To Graph Chart* on a view, add one pen in `pens`, stay in design mode | the plot draws data; the pen row shows the colour swatch button and the edit / remove buttons, greyed |
| C2 | Zoom the Designer canvas to 50 % and to 200 % | the plot keeps filling the component; axes and text scale with the canvas, nothing is cut off or drawn twice as small |
| C3 | Clear `pens`, set `tagBrowser.openOnStart: true` | the tag browser frame is docked beside the empty plot with the note that panels need preview mode |
| C4 | Switch to preview mode | the tag browser opens and works (browse, search, add); remove / colour buttons act |

<!-- nav:bottom -->

---

← Previous: [Security and permissions](security-and-permissions.md) · [Back to index](README.md) · Next: [Operator guide](operator-guide.md) →

<!-- /nav:bottom -->
