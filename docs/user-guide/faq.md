<!-- nav:top -->

[Docs home](../README.md) › [User Guide](README.md) › **FAQ**

<!-- /nav:top -->

# FAQ

Short answers to the questions integrators ask most, with a link to the full explanation.

**On this page**

- [General](#general)
- [Display Template](#display-template)
- [Click To Graph Chart](#click-to-graph-chart)
- [Security](#security)
- [Gateway and upgrades](#gateway-and-upgrades)

---

## General

**Which Ignition versions are supported?**
Ignition 8.3 with Perspective (developed and tested on 8.3.10). Ignition 8.1 is not supported.

**Does it need internet access?**
No. The chart library (uPlot) and every other file are bundled in the module and served by the gateway.

**Do I have to configure anything on the gateway?**
No. Every gateway setting has a safe default. You change them only to tighten security or tune limits:
[Gateway settings](gateway-settings.md).

**Where do I find every property?**
[Display Template properties](components/display-template/properties.md) and
[Click To Graph Chart properties](components/ctg-chart/properties.md). The Designer's property editor shows the same
descriptions as tooltips.

## Display Template

**Why does my value show no decimals?**
The display uses the tag's Format String, and Ignition's default `#,##0.##` drops trailing zeros. Set `value.decimals`
or `value.format` (for example `#,##0.00`).

**Why are the units missing?**
The tag has no Engineering Units, or `units.visible` is off. Units are never shown after Boolean, string or state
labels. Set `units.text` to override.

**Every write says *Must be between 0 and 100*. Why?**
The tag's Engineering Low/High were never set, and they report 0 and 100. Set them on the tag, or
`setpoint.limits.useEngLimits: false`. See [Limits](components/display-template/menu-and-setpoints.md#limits).

**Can I use one faceplate popup for many tags?**
Yes: bind `tagPath` to a view parameter. Keep the setpoint gate (`setpoint.enabled`, `setpoint.access`, limits,
options) static. [Recipe](components/display-template/recipes.md#faceplate-setpoint-one-popup-for-many-tags).

**Can operators write without logging in?**
By default yes, like native Perspective writes, **if the tag's own Write Permissions allow it**. Require a login for one
display with `setpoint.access.requireLogin: true` (or roles), or for the whole gateway with
`-Dctg.write.requireAuthenticated=true`. [Who may write](components/display-template/menu-and-setpoints.md#who-may-write).

**Why is the value red/orange/yellow?**
Those are alarm colours: the tag has an active or unacknowledged alarm of that priority. Limits use neutral slate
borders with ▲/▼, never alarm colours. [Colour policy](components/display-template/README.md#colour-policy).

**How do I see who changed a setpoint?**
Assign an audit profile to the project, then enable **Change History…** in the menu (`menu.changeHistory.enabled`), or
build a table from the audit profile. [Audit trail](components/display-template/menu-and-setpoints.md#audit-trail-who-changed-what).

## Click To Graph Chart

**I trended a tag but the chart stays empty.**
The display and the chart must be in the same session and use the same `trendGroup`. A tag needs history enabled to
draw a line. [Click to graph](components/ctg-chart/README.md#click-to-graph-how-a-tag-gets-onto-the-chart).

**Why do lines look like envelopes?**
The default aggregation `MinMax` returns two values per bucket so short spikes stay visible. Use
`query.aggregation: "LastValue"` for a single line.

**Can I put pens on separate axes or stacked plots?**
Yes: `axes[]` (named axes, left or right) and `plots[]` (stacked plots); pens pick them with `pens[].axis` and
`pens[].plot`. Pens with different units get separate axes automatically.
[Axes and plots](components/ctg-chart/pens-axes-plots.md#axes-and-plots).

**Are the trend lists saved?**
No. A session trend list lives on the gateway for that Perspective session (all its tabs) and is cleared when the
session ends or the user changes. Runtime edits of `pens` last for the page. For permanent pens, configure `pens` in the
Designer.

**How far back can a chart look?**
400 days aggregated and 31 days raw by default (`ctg.history.maxRangeDays`, `ctg.history.maxRawRangeDays`).

**Can users add any tag with the tag browser?**
Any numeric or Boolean tag they may read, from every provider except `[System]`, unless you set `tagBrowser.rootPath`
or `readScope.allowedRoots`. [Read scope](components/ctg-chart/README.md#read-scope-which-tags-a-chart-may-read).

**Does the chart support annotations (notes)?**
Yes, with a historian that supports them (the 8.3 Core Historian does). Turn them on with `annotations.enabled` (show notes);
to let users add notes, also set `annotations.edit.enabled` (a login is required by default).
[Annotations](components/ctg-chart/panels-and-tools.md#annotations).

## Security

**Can a user change a security prop from the browser console?**
They can try; the gateway keeps its own copy of every **[S]** prop, puts the value back and logs a `prop-tamper` line.
[Trusted props](security-and-permissions.md#trusted-props).

**Why does a display say *Editing is turned off: this screen's configuration is not safe*?**
A security prop is bound to something the user can influence (a view parameter, a custom prop) or bound
bidirectionally. Configure it statically.
[Binding lint](security-and-permissions.md#binding-lint-security-props-must-not-depend-on-user-input).

**Can I trust the `onSetpointWrite` event?**
Not as proof: page scripts can fire component events with any payload. Use the audit profile and `auditId`.
[Events are not proof](security-and-permissions.md#events-are-not-proof).

## Gateway and upgrades

**The Designer still shows the old behaviour after an upgrade.**
Close and reopen the view; the script URLs change with every build.

**Are the 1.x HTTP routes still there?**
No. `/data/simpletagdisplay/readTag` and the other seven 1.x routes answer 404 in 2.0.0.
[Upgrading from 1.x](upgrading-from-v1.md).

**The gateway does not start after installing.**
The module was built with a JDK newer than 17.
[Recovering a gateway that does not start](../developer-guide/06-deployment.md#recovering-a-gateway-that-does-not-start).

<!-- nav:bottom -->

---

← Previous: [Known limitations](known-limitations.md) · [Back to index](README.md) · Next: [Glossary](glossary.md) →

<!-- /nav:bottom -->
