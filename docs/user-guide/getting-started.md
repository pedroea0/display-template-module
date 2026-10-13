<!-- nav:top -->

[Docs home](../README.md) › [User Guide](README.md) › **Getting started**

<!-- /nav:top -->

# Getting started

From a fresh install to a working screen in about fifteen minutes: one value, one setpoint, one trend chart fed by
right-click, and the chart's tag browser.

**On this page**

- [Before you start](#before-you-start)
- [1. Install the module](#1-install-the-module)
- [2. Show a tag value](#2-show-a-tag-value)
- [3. Make a setpoint](#3-make-a-setpoint)
- [4. Add a trend chart](#4-add-a-trend-chart)
- [5. Trend a tag with right-click](#5-trend-a-tag-with-right-click)
- [6. Add tags with the tag browser](#6-add-tags-with-the-tag-browser)
- [What next](#what-next)

---

## Before you start

You need:

| Item | Notes |
|---|---|
| An Ignition **8.3** gateway with Perspective | developed and tested on 8.3.10 |
| A Perspective project and the Designer | any project; a login is not required for these steps |
| A numeric tag **with history enabled** | for example `[default]Area1/Tank1/Level`; history makes it trendable |
| A writable numeric tag | for example `[default]Area1/Tank1/Level_SP`, for the setpoint step |
| The signed module file `Tag-Display.modl` | from the GitHub release, or [build it yourself](../developer-guide/05-building.md) |

## 1. Install the module

1. Open the gateway web interface and go to **Platform > System > Modules**.
2. Choose **Install or Upgrade Module**, pick the `.modl` file and confirm.
3. The release is signed with the repository's self-signed development certificate: accept it when the gateway asks.
   (For production, sign with your own certificate: [Signing](../developer-guide/07-signing.md).)
4. Restart the gateway when asked. The module list then shows **Display Template & Click-to-Graph** as *Running*.

Upgrading from 1.x? Read [Upgrading from 1.x](upgrading-from-v1.md) **before** you open your old views: props changed
shape and a migration script converts them.

## 2. Show a tag value

1. In the Designer, open a view (a Coordinate or Flex container is fine).
2. In the **Perspective Component Palette**, open the *Display* category and drag **Display Template** onto the view.
3. In the Property Editor set `props.tagPath` to the path of your history tag, e.g. `[default]Area1/Tank1/Level` (type
   the path as text; the component subscribes to the tag itself, no tag binding is needed).

The display shows the tag's name, its live value in the tag's own format, and its engineering units. If the tag has
alarms, the value is coloured by the active alarm priority. Nothing else needs configuring.

> **Note** In design mode the display already looks as it will at runtime. Until the first value arrives it shows a
> sample value; *Set tagPath* means `tagPath` is still empty. See [Working in the Designer](designer.md).

## 3. Make a setpoint

1. Drag **Display Template (Setpoint)** from the palette (or set `setpoint.enabled: true` on any display).
2. Set its `tagPath` to your writable tag.
3. Save the project and open a session (the project's URL in a browser, or the Designer's *Launch Perspective*
   menu).
4. Click the value. A dialog shows the current value, the allowed range and an input. Type a new value and press
   **Write**.

By default (like native Perspective writes) no login is needed: the write runs with the session's own security
context, so the **tag's Write Permissions** decide. To require a login or a role for this display:

```json
"setpoint": { "enabled": true, "access": { "roles": ["Operator"] } }
```

> **Important** Tags whose engineering limits were never set report 0 and 100, and the display refuses values outside
> them (*Must be between 0 and 100*). Set the tag's Engineering Low/High, or `setpoint.limits.useEngLimits: false`.

More: [Menu and setpoints](components/display-template/menu-and-setpoints.md).

## 4. Add a trend chart

1. Drag **Click To Graph Chart** from the *Display* category onto the same view (or onto another page of the project).
2. Leave its props at the defaults and give it some room (for example 800 × 400).

An empty chart shows a hint: it has no configured pens and the session trend list is still empty. That is expected.

## 5. Trend a tag with right-click

1. In the session, right-click the value of the first display (long-press on a touch screen).
2. Pick **Trend Tag**.

The tag appears in the chart at once, with its history for the last 8 hours, and keeps updating live. Every chart in
the same session with the same `trendGroup` (`"default"` unless you change it) shows it, in every browser tab of that
session. **Remove from Trend** in the same menu (or the trash icon in the chart's pen table) takes it off again.

> **Note** *No history available* in the menu means the tag has history disabled. *Cannot trend String tags*: only
> numeric and Boolean tags can be trended.

## 6. Add tags with the tag browser

1. In the chart's toolbar, press the **Tags** button (≡) to open the tag browser.
2. Open folders, tick one or more numeric or Boolean tags, and press **Add selected**.
3. To find a tag without knowing its folder, tick **Search all folders** and type part of its name or path
   (`pump101`, or `temp*` with `*` as a wildcard).

The tag browser is on by default and shows every provider except `[System]`, always with the user's own permissions.
To limit it to one area, set `tagBrowser.rootPath` (for example `[default]Area1`). More:
[Tag browser](components/ctg-chart/panels-and-tools.md#tag-browser).

## What next

| I want to... | Read |
|---|---|
| See every prop of the Display Template | [Display Template properties](components/display-template/properties.md) |
| See every prop of the chart | [Click To Graph Chart properties](components/ctg-chart/properties.md) |
| Copy a ready-made setup (faceplate, alarm colours, two axes, ...) | [Display Template recipes](components/display-template/recipes.md), [chart recipes](components/ctg-chart/recipes.md) |
| Decide who may write, browse and trend | [Security and permissions](security-and-permissions.md) |
| Tune or lock down the gateway | [Gateway settings](gateway-settings.md) |
| Explain the screen to operators | [Operator guide](operator-guide.md) |
| Fix something | [Troubleshooting](troubleshooting.md) |

<!-- nav:bottom -->

---

← Previous: [User Guide](README.md) · [Back to index](README.md) · Next: [Display Template](components/display-template/README.md) →

<!-- /nav:bottom -->
