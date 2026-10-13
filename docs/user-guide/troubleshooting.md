<!-- nav:top -->

[Docs home](../README.md) › [User Guide](README.md) › **Troubleshooting**

<!-- /nav:top -->

# Troubleshooting

Symptoms first, then the full list of error codes. When something looks wrong, check three places:

1. **What the component says**: hover the value or the greyed menu item; error texts name the reason.
2. **The browser console** (F12): `window.__CTG.loaded` lists the loaded parts; `[CTG]` lines explain load problems.
3. **The gateway log** (**Diagnostics > Logs** in the gateway web interface, filtered on `SimpleTagDisplay`; in
   `<Ignition install>/logs/wrapper.log` the logger names are shortened to `S.Audit`, `S.Gateway`, ...).

**On this page**

- [Display Template](#display-template)
- [Click To Graph Chart](#click-to-graph-chart)
- [Gateway and installation](#gateway-and-installation)
- [Gateway log lines](#gateway-log-lines)
- [Error codes](#error-codes)

---

## Display Template

| Symptom | Cause and fix |
|---|---|
| Value shows `Set tagPath` (Designer) or `—` | `tagPath` is empty. |
| `Invalid tag path` | the path is a property (`.EngUnit`), an alarm path, has `.`/`..` segments or is too long. Use the tag itself. |
| `Tag not found` | wrong path or provider. Paths without `[provider]` use the project's default provider. |
| `No access` | the user lacks Read permission on the tag. |
| Value dimmed and underlined, "disconnected" icon | the connection to the gateway is lost, or the gateway stopped answering (watchdog). It recovers by itself; if it stays, check the gateway and the network. |
| The view shows defaults and the console warns *this view still uses v1 props* (Display Template or CTG Chart; the Designer shows a *v1 props* badge) | the view was not migrated: [Upgrading from 1.x](upgrading-from-v1.md). |
| *This value is too long to edit here* on a String setpoint | the tag holds more than 4096 characters; the browser only receives the first 4096, so editing it there would cut the rest. Write it from a script or the tag editor. |
| *This value has line breaks and cannot be edited here* on a String setpoint | the setpoint editors are single-line fields, which would silently drop the line breaks. Write it from a script or the tag editor. |
| Change History says *Too many requests* | one session may run 2 change-history queries at a time; a query the operator gave up on (timeout) is cancelled, so it clears within `ctg.read.timeoutMs`. |
| Setpoint looks writable but greyed; clicking says *Log in to change this value.* | `setpoint.access.requireLogin: true` (default false) or `setpoint.access.roles` on the display. Log in, or see [Security and permissions](security-and-permissions.md#floor-policy). |
| Setpoint greyed; the reason names a gateway setting (*... (gateway setting ctg.write.requireAuthenticated)*) | a gateway floor setting is stricter than the display (`ctg.write.requireAuthenticated`, `ctg.write.requiredRoles`, `ctg.write.allowedRoots`, `ctg.write.deniedProviders`). The Designer shows a **Gateway rule** badge on such displays. Ask the gateway administrator, see [Gateway settings](gateway-settings.md). |
| Anonymous write refused with *The tag provider denied the change.* (`WRITE_DENIED`) | the tag's own Write Permissions need a role (Ignition enforces them for anonymous sessions too). Log in, or change the tag's Write Permissions. |
| *You don't have permission to change this value.* | the user has none of `setpoint.access.roles` (exact, case-sensitive) or of `ctg.write.requiredRoles`. |
| *Editing is turned off: this screen's configuration is not safe (ask the integrator).* | a gate prop has a bidirectional binding, or a binding to something the user can influence (view parameter, custom prop) while `ctg.security.rejectBoundGates=true`. Configure the gate statically. The gateway log has a `security-key-bound` line naming the view and key. |
| *The allowed range for this value is misconfigured.* (`LIMITS_INVALID`) | `setpoint.limits.low` > `high`, or EngLow > EngHigh. |
| Every write says *Must be between 0 and 100* | the tag's engineering limits were never set (they report 0 and 100). Set EngLow/EngHigh or `setpoint.limits.useEngLimits: false`. |
| *Written, but the tag reads X.* | the tag did not show the written value within `setpoint.verifyMs`; usually PLC logic overrides the setpoint. |
| *No confirmation received. The value may or may not have been written.* | the write took longer than the timeout. Check the current value before trying again; the audit log has the final outcome (`late=true`). |
| *The Designer is in read-only mode.* | switch the Designer's communication mode to Read/Write. |
| Menu does not open on right-click | `enabled: false`, `menu.enabled: false`, Designer design mode, or `meta.contextMenu` is enabled (Perspective's menu wins). |
| *No history available* in the menu | the tag has history disabled, or its history provider does not exist. |
| *Cannot trend String tags* | only numeric and Boolean tags can be trended. |
| *Change History…* says no audit log is configured | the project has no audit profile and `ctg.audit.fallbackProfile` is not set. |
| Change History is empty | no writes or edits recorded yet, or the user cannot read the tag. |
| Alarm colours missing | `alarms.colorMode` is `thresholds`/`off`, the priority is below `alarms.minPriority`, or `value.style` sets a colour (it wins). |
| Dialogs open behind a Perspective popup | a project stylesheet lowered `--ctg-z`; remove that override. |

## Click To Graph Chart

| Symptom | Cause and fix |
|---|---|
| Empty chart with a hint | no configured pens and the trend list of `trendGroup` is empty. Trend a tag from a display with the same `trendGroup`. |
| Trend Tag on a display does not reach the chart | different `trendGroup` values, or different sessions (another browser). Groups are per session. |
| Pen row *not allowed on this chart* | a runtime pen outside `readScope` ([Click To Graph Chart](components/ctg-chart/README.md#read-scope-which-tags-a-chart-may-read)). |
| Pen row *Too many pens* | more than `ctg.trend.maxPens` effective pens. |
| Pen row *Too many points* | a raw query over the point cap. Use aggregated data, narrow the range, or `query.onTooManyPoints: "aggregate"`. |
| Pen row *History not enabled for this tag* | enable history on the tag. The live value still shows in *Current*. |
| Lines look like envelopes (two values per bucket) | `query.aggregation` is `MinMax` (the default, keeps spikes visible). Use `LastValue` or `Average` for a single line. |
| *Showing the last 400 days (gateway limit)* | the realtime window is longer than `ctg.history.maxRangeDays`. |
| Badge **Stale** | no successful refresh for a while; the historian is slow or unavailable. The chart retries by itself. |
| Badge **Disconnected** | the connection to the gateway is lost; refreshing resumes on reconnect. |
| Banner *History query failed (…), retrying.* | the historian threw an error. Check the gateway log (`SimpleTagDisplay.History`) and the historian's status. |
| Banner *Not authorised for history* | the history token could not be renewed (the session ended or the user changed). Reload the page. |
| Banner *Module updated — reload the page* | the gateway runs a newer, protocol-incompatible module. Reload. |
| Requests answered 429 / 503 in the network tab | the per-token, per-session or gateway-wide history limits; the chart backs off and retries. Persistent 503s mean the gateway is overloaded: see the history settings. |
| Settings, tag browser or remove buttons missing | `enabled: false`, `settingsPanel.enabled: false`, `tagBrowser.enabled: false` (the tag browser is on by default), `toolbar.buttons.tagBrowser: false`, or the user fails `trendEdit`/`tagBrowser.access`. In Designer design mode the buttons are drawn but disabled. |
| Tag browser says the folder is outside the area | `tagBrowser.rootPath` limits browsing. |
| Export missing | Perspective mobile app (no downloads), or `toolbar.buttons.export` / `export.*.enabled` is off. |
| Notes: *Notes are not supported by this historian.* | the historian provider has no annotation support (Core Historian has). |
| A new note disappears and comes back | storage is asynchronous; the historian confirms about a second after saving. |
| *You can only change your own notes.* | `annotations.edit.ownOnly`; ask a moderator (`annotations.moderate`). |

## Gateway and installation

| Symptom | Cause and fix |
|---|---|
| Gateway does not start after installing | module built with a JDK newer than 17: [Deployment](../developer-guide/06-deployment.md#recovering-a-gateway-that-does-not-start). |
| Install refused: certificate | accept the certificate in the install dialog; for production sign with your own certificate ([Signing](../developer-guide/07-signing.md)). |
| Deploy script: empty HTTP 401 | the API key requires secure connections and you deploy over HTTP ([Deployment](../developer-guide/06-deployment.md#deploy-with-the-script)). |
| Deploy script exit 17 | the gateway did not restart into the uploaded build; read the listed differences. |
| Designer shows old behaviour after an upgrade | close and reopen the view; the script URLs change with every build. |
| Browser console: `[CTG] … ignored; page runs … - reload` | the page holds two builds of a part after an upgrade. Reload the page. |
| Old 1.x URLs (`/data/simpletagdisplay/readTag` …) return 404 | expected: 2.0.0 removed them. |

## Gateway log lines

| Logger / text | Meaning |
|---|---|
| `Display Template / CTG 2.0.0-<hash> started (protocol 2)` | the module started |
| `Module settings reloaded (rev '…', changed)` | a `ctg.*` change was applied |
| `Setting ctg.x=… is outside …; using …` (WARN) | a setting was clamped |
| `action=prop-tamper user=… key=…` (WARN, `SimpleTagDisplay.Audit`) | a browser tried to change a security prop; the value was restored |
| `action=prop-tamper-unrestored` (WARN) | the restore failed; the gate still uses the trusted value |
| `action=security-key-bound key=… view=… binding=…` (WARN) | a security prop is bound to a user-influenced source |
| `action=audit-unavailable project=…` (WARN) | the project has no audit profile; writes are only in the log |
| `action=audit-overflow dropped=…` (WARN) | the audit profile is too slow; some records were logged but not stored |
| `action=audit-failed auditId=…` (WARN) | the audit profile rejected a record |
| `action=pen-budget …` (WARN, `SimpleTagDisplay.Chart`) | a chart added more new runtime pens per minute than `ctg.chart.maxNewPathsPerMinute` |
| `action=tag-write result=… user=… tag=… auditId=…` (INFO) | one audited write (also `tag-edit`, `annotation-add`, …) |
| `ctg.debug is ON: test hooks enabled` (WARN) | debug hooks are on: switch `ctg.debug` off in production |

## Error codes

Codes appear in replies, in `onSetpointWrite.errorCode` and in the history route's JSON errors. The text is what
operators see. HTTP = status when the code comes from the history route.

| Code | HTTP | Operator text / meaning |
|---|---|---|
| `BAD_REQUEST` | 400 | The request was not valid. |
| `UNKNOWN_MESSAGE` | – | The gateway module does not know this request. Reload the page. (Also: a debug message while `ctg.debug` is off.) |
| `PROTOCOL_MISMATCH` | 409 | The module was updated. Reload the page. |
| `RATE_LIMITED` | 429 | Too many requests. Wait a moment. |
| `MODULE_STOPPING` | 503 | The gateway module is restarting. |
| `INTERNAL` | 500 | Something went wrong on the gateway (details in the gateway log). |
| `DISABLED` / `WRITE_DISABLED` | – | Editing is turned off for this value (`enabled` / `setpoint.enabled`). |
| `ACTION_DISABLED` | – | This action is turned off (menu item disabled in props). |
| `NO_TAG_PATH` | – | No tag is configured. |
| `INVALID_PATH` | 400 | The tag path is not valid (also: provider denied by `ctg.write.deniedProviders`). |
| `STALE_TARGET` | – | The tag changed while this dialog was open. Close it and try again. |
| `AUTH_REQUIRED` | – | Log in to change this value. |
| `FORBIDDEN_ROLE` | – | You don't have permission to change this value. |
| `DESIGNER_READ_ONLY` | – | The Designer is in read-only mode. Switch to Read/Write to write tags. |
| `TAG_NOT_FOUND` | – | Tag not found. |
| `ACCESS_DENIED` | 403 | You don't have access to this tag. |
| `READ_ONLY` | – | This tag is read-only. |
| `WRITE_DENIED` / `EDIT_DENIED` | – | The tag provider denied the change (tag permissions). |
| `INVALID_VALUE` | – | That value is not valid for this tag. |
| `UNSUPPORTED_TYPE` | – | Values of this type can't be written (or trended) here. |
| `NOT_AN_OPTION` | – | Choose one of the listed values. |
| `OUT_OF_RANGE` | – | Must be between {low} and {high}. |
| `TIMEOUT` | 504 | No confirmation received; the value may or may not have been written. |
| `WRITE_FAILED` | – | Write failed (with the quality). For UDT members: edit the UDT definition. |
| `PROVIDER_UNRESOLVED` | – | Could not find the tag provider. |
| `NO_HISTORY` | – | No history available for this tag. |
| `TREND_LIST_FULL` | – | The trend list is full ({max} tags). |
| `BROWSE_ROOT_VIOLATION` | – | This folder is outside the area this chart may browse. |
| `TOKEN_INVALID` / `TOKEN_EXPIRED` | 401 | Chart data access expired. It renews automatically; when a renewal fails (rate limit, timeout, reconnect), the chart retries it after 2, 4, 8 … 60 s and recovers by itself. A session with more than 64 charts holding data access at once refuses further charts: such a chart shows *History paused: this session already runs the maximum number of charts with history* and asks again after 2, 4, 8 … 60 s, so it starts by itself once another chart closes (gateway log, once: *History token refused: this session already runs 64 charts*). |
| `SESSION_MISMATCH` | 403 | The request did not come from this session (another session's cookie, or a cross-site request). Reload the page. |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | The request was not valid (not JSON). |
| `BODY_TOO_LARGE` | 413 | The request is too large. |
| `LENGTH_REQUIRED` | 411 | The request was not valid (no `Content-Length`). |
| `TOO_MANY_PENS` | 400 | Too many pens in one request. |
| `RANGE_INVALID` | 400 | The time range is not valid. |
| `RANGE_TOO_LARGE` | 400 | The time range is too large. Choose a shorter range or aggregated data. |
| `TOO_MANY_REQUESTS` | 429 | Too many requests. Wait a moment (per-token or per-session history limit). |
| `BUSY` | 503 | The gateway is busy. Trying again shortly. |
| `HISTORY_QUERY_FAILED` | 502 | The historian could not answer this query. |
| `OUT_OF_SCOPE` | – | This tag is outside the area this screen may use (read scope, or `ctg.write.allowedRoots`). |
| `LIMITS_INVALID` | – | The allowed range for this value is misconfigured. |
| `LIMITS_UNAVAILABLE` | – | The allowed range for this value is not available right now. Try again later. |
| `AUTH_CHANGED` | – | The logged-in user changed. Try again. |
| `BAD_QUALITY` | – | The tag's quality is bad, so it can't be changed right now. |
| `STEP_TOO_LARGE` | – | Change is larger than allowed (max ±{max}). |
| `AUDIT_UNAVAILABLE` | – | No audit log is configured for this project. |
| `BOUND_BIDIRECTIONAL` | – | Editing is turned off: this screen's configuration is not safe (ask the integrator). |
| `NOT_OWNER` | – | You can only change your own notes. |
| `ANNOTATIONS_UNSUPPORTED` | – | Notes are not supported by this historian. |
| `ANNOTATION_NOT_FOUND` | – | This note no longer exists. |
| `INVALID_TIME` | – | The note's time is not allowed, by reason: "A note cannot start more than a day from now.", "A range must end after it starts." or "A range can be at most {maxRangeDays} days long." (`ctg.history.maxRangeDays`). |

Client-side codes (never sent by the gateway):

| Code | Meaning |
|---|---|
| `CLIENT_TIMEOUT` | no reply within the client timeout (writes and edits: `ctg.read.timeoutMs` + `ctg.write.timeoutMs` + 5 s, at least 15 s; otherwise `ctg.read.timeoutMs` + 3 s, at least 8 s); same text as `TIMEOUT` |
| `DISCONNECTED` | Not connected to the gateway. Nothing was written. |
| `DETACHED` | the component was removed while the request ran (shown nowhere) |
| `NOT_ALLOWED` | a chart panel asked for a message outside the `ChartApi` allow-list (programming error) |

<!-- nav:bottom -->

---

← Previous: [Upgrading from 1.x](upgrading-from-v1.md) · [Back to index](README.md) · Next: [Known limitations](known-limitations.md) →

<!-- /nav:bottom -->
