<!-- nav:top -->

[Docs home](../README.md) › [User Guide](README.md) › **Glossary**

<!-- /nav:top -->

# Glossary

Terms used throughout this documentation, in alphabetical order.

| Term | Meaning |
|---|---|
| **Access object** | the `{ roles, securityLevels, requireLogin }` shape used by every "who may" prop (`setpoint.access`, `menu.trend.access`, `trendEdit.access`, `tagBrowser.access`, ...). `roles`: any one of them (exact, case-sensitive). `securityLevels`: any one of these paths. Empty lists add no requirement. |
| **Aggregated data** | history returned as one or two values per time bucket (see *Bucket*), as opposed to raw samples. Statistics computed from it are prefixed with `≈`. |
| **Aggregation** | how a bucket's samples become one value: `MinMax` (default, keeps spikes), `LastValue`, `Average` (time-weighted), statistics such as `Count` or `DurationOn`. Set by `query.aggregation` or per pen. |
| **Audit profile** | an Ignition audit log (Platform > Security > Audit Profiles) assigned to the project. Every write and tag configuration edit is recorded there with an `auditId`. |
| **`auditId`** | the id that links one write across the audit record, the `SimpleTagDisplay.Audit` log line, the component event and the write reply. |
| **Binding lint** | the gateway's check, at component start, that no security prop is bound to something the user can influence. A failing gate fails closed. |
| **Bounds** | the Display Template's "outside its normal range" marking (`bounds.*`): neutral border plus ▲/▼, never an alarm colour. |
| **Bucket** | one time slice of an aggregated query. The default is one bucket per plot pixel; widths come from a fixed ladder (100 ms to 1 day). |
| **Configured pen** | a pen in the chart's `pens` prop, set in the Designer (or by a binding). Always inside the read scope. |
| **Delegate** | the gateway-side half of a component instance. It subscribes to tags, checks every action, and talks to the browser over Perspective's component channel. |
| **Design mode / preview mode** | the Designer's editing mode and its play mode. See [Working in the Designer](designer.md). |
| **Effective pens** | what a chart actually draws: its configured pens plus the session trend list of its `trendGroup`, at most `ctg.trend.maxPens`. Listed in `outputs.pens`. |
| **Fail closed** | when a check cannot be made (limits unreadable, a gate bound to user input), the action is refused instead of allowed. |
| **Floor policy** | gateway-wide minimum rules for writes and tag configuration edits (`ctg.write.*`, `ctg.configEdit.*`), set by the administrator. No component prop can lower them. |
| **Following live** | a realtime chart whose right edge is "now" and slides with it. Panning into the past pauses it (**Paused**). |
| **Gate** | a security prop that decides whether an action is allowed, e.g. `setpoint.enabled`, `setpoint.access`, `menu.configEdit.access`. |
| **Gateway rule badge** | Designer-only orange badge on a Display Template whose own access config is overridden by a stricter gateway setting. |
| **History token** | the per-chart credential (header `X-CTG-Token`) for the chart's history route; bound to the session, renewed automatically. |
| **Pen** | one tag drawn on a chart, with its colour, axis, plot and display style. |
| **Pen table** | the chart's legend with statistics (Current, Minimum, Maximum, Average, X-Trace, ...). |
| **Plot** | one of the chart's stacked plot areas (`plots[]`); all plots share the time axis. |
| **Point cap** | the most raw points a pen (`query.maxPointsPerPen`, `ctg.history.maxRawPointsPerPen`) or a response (`ctg.history.maxPointsPerResponse`) may carry. A pen over the cap shows *Too many points*. |
| **Range brush** | a selected time range in the chart's Range mode; the pen table then shows statistics for it. |
| **Range selector** | the overview strip under the chart's plots (`rangeSelector`), showing the whole range with the visible part as a window. |
| **Raw data** | every stored sample of a tag, as opposed to aggregated data. |
| **Read scope** | which tags a chart may read for pens added at runtime (`readScope`). Configured pens and the trend list are always allowed; tag Read Permissions always apply. |
| **Realtime / historical** | the chart's two time range modes: a rolling window ending now, or a fixed start and end. |
| **Runtime pen** | a pen added while the chart runs (settings panel, tag browser, or a browser writing `pens`). Must be inside the read scope. |
| **Security prop ([S])** | a prop the gateway reads from its trusted copy and enforces. A browser change is put back and logged as `prop-tamper`. |
| **Session trend list** | the list of tags trended in one Perspective session for one trend group, held by the gateway and shown by every chart of that group, in every tab of the session. |
| **Setpoint** | a Display Template that lets the operator write a new value (`setpoint.enabled`). |
| **Stale** | a chart that has had no successful update for `appearance.staleAfterMs` (default: 3 × the refresh rate, at least 10 s); a display whose connection to the gateway is lost (dimmed and underlined). |
| **Step guard** | the largest change allowed in one write (`setpoint.maxStep`, `setpoint.maxStepPercent`), enforced on the gateway. |
| **Trend group** | the name (`trendGroup`) that ties Display Templates and charts to one session trend list. Default `"default"`. |
| **Trend Tag** | the Display Template's right-click item that adds its tag to the session trend list: "click to graph". |
| **X-Trace** | the chart's default mode: a cursor that shows every pen's value at a time; click to pin it. |

<!-- nav:bottom -->

---

← Previous: [FAQ](faq.md) · [Back to index](README.md) · Next: [Samples](samples/README.md) →

<!-- /nav:bottom -->
