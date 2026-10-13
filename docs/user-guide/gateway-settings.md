<!-- nav:top -->

[Docs home](../README.md) › [User Guide](README.md) › **Gateway settings**

<!-- /nav:top -->

# Gateway settings (`-Dctg.*`)

The module has no settings page. Every setting is a JVM system property named `ctg.*`, read by the gateway module.
Components cannot change them; only someone who can edit the gateway's JVM options (or run a gateway-scope script) can.
All have safe defaults, so most installations set none.

Each table lists the setting, its default, its valid range and its effect; a short **When to change** note under each
table says when touching the group makes sense.

**On this page**

- [Common changes](#common-changes)
- [How to set them](#how-to-set-them)
- [Floor policy: writes and tag configuration edits](#floor-policy-writes-and-tag-configuration-edits)
- [Security](#security)
- [Audit](#audit)
- [Display and chart pushes](#display-and-chart-pushes)
- [Tag operations and trend lists](#tag-operations-and-trend-lists)
- [History route](#history-route)
- [Tokens and sessions](#tokens-and-sessions)
- [Annotations](#annotations)
- [Debug and test hooks](#debug-and-test-hooks)

---

## Common changes

| I want to... | Setting |
|---|---|
| require a login for every setpoint write and tag configuration edit | `ctg.write.requireAuthenticated=true` |
| let only certain roles write, on every display | `ctg.write.requiredRoles=Operator,Engineer` |
| allow writes only in some tag folders | `ctg.write.allowedRoots=[default]Setpoints` |
| keep charts and the tag browser away from a provider | `ctg.read.deniedProviders=System,Remote` |
| record writes for projects without their own audit profile | `ctg.audit.fallbackProfile=PlantAudit` |
| refuse writes that cannot be audited | `ctg.audit.required=true` |
| allow more pens per trend list and chart | `ctg.trend.maxPens` together with `ctg.history.maxPens` (pens per history request) |
| allow longer chart windows | `ctg.history.maxRangeDays`, `ctg.history.maxRawRangeDays` |
| give a slow historian more time | `ctg.history.timeoutMs` |
| apply a change without restarting the gateway | bump `ctg.settings.rev` ([below](#how-to-set-them)) |

## How to set them

**Permanently**: add a line per setting to `<Ignition install>/data/ignition.conf` in the `wrapper.java.additional`
block, numbering after the last existing entry, and restart the gateway:

```properties
wrapper.java.additional.20=-Dctg.write.requiredRoles=Operator,Engineer
wrapper.java.additional.21=-Dctg.write.allowedRoots=[default]Setpoints,[default]Area1/SP
wrapper.java.additional.22=-Dctg.audit.fallbackProfile=PlantAudit
```

**Without a restart**: the module re-reads every setting when the property `ctg.settings.rev` changes (checked every 10
seconds). A gateway-scope script (for example a gateway message handler, or a tag event script; the Designer's script
console runs in the Designer, not the gateway) can set properties and bump the revision:

```python
from java.lang import System
import time
System.setProperty('ctg.write.requiredRoles', 'Operator,Engineer')
System.clearProperty('ctg.audit.required')                  # back to the default
System.setProperty('ctg.settings.rev', str(int(time.time() * 1000)))
```

Values set that way are lost at the next gateway restart; put permanent values in `ignition.conf`. The gateway log
shows `Module settings reloaded (rev '…', changed)`. Components pick up the change at once (displays re-push their
write capabilities; running charts reconcile their pens); a running chart's history **limits** follow at its next
snapshot (reconnect or page reload).

**Validation**: a number outside its range is clamped to the nearest bound, an unparsable value falls back to the
default, each with one WARN on `SimpleTagDisplay.Gateway` per load. Lists are comma-separated; role names compare
exactly (case-sensitive).

## Floor policy: writes and tag configuration edits

Minimums that no component prop can lower ([Security and permissions](security-and-permissions.md#floor-policy)).

| Setting | Default | Range | Effect |
|---|---|---|---|
| `ctg.write.requireAuthenticated` | `false` | boolean | `true` = refuse setpoint writes and configuration edits from anonymous users (`AUTH_REQUIRED`) on every display, whatever the display's own `setpoint.access` says. Off by default since 2.0.0 (like native Perspective writes: an anonymous session may write unless the tag's Write Permissions or project security forbid it). |
| `ctg.write.requiredRoles` | empty | role list | every write also needs one of these roles (`FORBIDDEN_ROLE`; anonymous: `AUTH_REQUIRED`) |
| `ctg.configEdit.requiredRoles` | empty | role list | every tag configuration edit also needs one of these roles |
| `ctg.write.allowedRoots` | empty = anywhere | list of `[provider]Folder` | writes and edits only below these folders (`OUT_OF_SCOPE`) |
| `ctg.write.deniedProviders` | `System` | provider list | no writes or edits on these providers (`INVALID_PATH`) |
| `ctg.read.deniedProviders` | `System` | provider list | no chart runtime pens, chart trend adds, browsing, or history on these providers |

**When a floor setting is what blocks.** If a display's own `setpoint.access` (or `menu.configEdit.access`) would let
the user act but one of the settings above refuses, the operator sees a message that names the setting, in the hover
text of the value, in the menu and in the bubble after a refused write, for example *This gateway requires a login for
every write (gateway setting ctg.write.requireAuthenticated).* A refusal by the display's own access rule keeps the
short text (*Log in to change this value.*). In the **Designer** a small orange **Gateway rule** badge appears on a
display whose access settings are made stricter by a floor setting; its tooltip lists the settings. The badge is never
shown in a client session.

**When to change:** set the login and role rules (they add nothing by default) when screens are reachable by users you
do not trust to write. `ctg.write.requireAuthenticated=true` is the single most useful hardening switch for a
production gateway; the role and folder rules narrow it further. Keep `ctg.write.deniedProviders` and `ctg.read.deniedProviders` at least at
`System`.

## Security

| Setting | Default | Range | Effect |
|---|---|---|---|
| `ctg.security.rejectBoundGates` | `true` | boolean | a gate prop bound to a user-influenced source fails closed. `false` only warns ([Security and permissions](security-and-permissions.md#binding-lint-security-props-must-not-depend-on-user-input)). |
| `ctg.security.allowCrossOriginFrames` | `false` | boolean | `true` allows editing inside a frame from another site |
| `ctg.security.tamperLogPerMin` | 6 | 1–600 | maximum `prop-tamper` WARN lines per minute per key |
| `ctg.chart.maxNewPathsPerMinute` | 200 | 10–10 000 | new runtime pen paths per chart per minute; beyond: pens `overLimit` and one `pen-budget` WARN |

**When to change:** `ctg.security.rejectBoundGates=false` only as a last resort when a gate must stay bound to
something a user can influence ([binding lint](security-and-permissions.md#binding-lint-security-props-must-not-depend-on-user-input));
`allowCrossOriginFrames` only when your own portal on another site frames Perspective and needs editing there;
`tamperLogPerMin` and `maxNewPathsPerMinute` when the log is too noisy or legitimate screens hit the limit.

## Audit

| Setting | Default | Range | Effect |
|---|---|---|---|
| `ctg.audit.fallbackProfile` | empty | audit profile name | used for projects that have no audit profile of their own |
| `ctg.audit.required` | `false` | boolean | refuse writes and edits (`AUDIT_UNAVAILABLE`) when no profile is configured or the audit writer cannot take the record (atomic, also under concurrent writes) |

**When to change:** set `ctg.audit.fallbackProfile` when some projects have no audit profile of their own; set
`ctg.audit.required=true` when an unaudited write is worse than no write (regulated processes).

## Display and chart pushes

| Setting | Default | Range | Effect |
|---|---|---|---|
| `ctg.display.coalesceMs` | 150 | 50–2 000 | display value pushes are collected for this long |
| `ctg.chart.liveCoalesceMs` | 250 | 100–5 000 | chart live-value pushes are collected for this long |
| `ctg.display.metaRefreshMs` | 60 000 | 10 000–3 600 000 | how often a display re-reads metadata it does not subscribe to |
| `ctg.display.heartbeatMs` | 30 000 | 5 000–300 000 | a delegate that pushed nothing for this long sends a heartbeat (`ctg.hb`). Displays derive the silence after which they show *No updates from the gateway* from it: 2 × heartbeat + 15 s, at least 75 s |
| `ctg.push.maxValueBytes` | 65 536 | 4 096–1 048 576 | an encoded value larger than this is truncated (`truncated: true`) |
| `ctg.push.maxBytes` | 262 144 | 16 384–4 194 304 | maximum size of one push |

**When to change:** rarely. Raise the coalesce intervals to cut network traffic on screens with hundreds of displays
over slow links; lower the heartbeat when a firewall or proxy drops idle websockets sooner than 30 s. Raise the push
size limits only for tags with very large values (long strings, big arrays).

## Tag operations and trend lists

| Setting | Default | Range | Effect |
|---|---|---|---|
| `ctg.write.timeoutMs` | 10 000 | 1 000–30 000 | writes and configuration edits: after this the result is reported as unknown (`TIMEOUT`, audited UNCERTAIN). A write first re-reads the tag (`ctg.read.timeoutMs`), so the display waits read + write + 5 s (at least 15 s) before it gives up itself (`CLIENT_TIMEOUT`) |
| `ctg.read.timeoutMs` | 5 000 | 1 000–30 000 | metadata reads and permission checks; the display's own deadline for trend list and Change History requests is this + 3 s (at least 8 s) |
| `ctg.trend.maxPens` | 32 | 1–64 | tags per session trend list (`TREND_LIST_FULL`), and effective pens per chart |
| `ctg.trend.maxGroupsPerSession` | 16 | 1–64 | trend groups per session |
| `ctg.trend.clearOnUserChange` | `true` | boolean | clear a session's trend lists when the logged-in user changes |

**When to change:** raise the timeouts for slow tag providers or remote networks; raise `ctg.trend.maxPens` when
operators need more than 32 pens per trend list (charts slow down with many pens); lower
`ctg.trend.maxGroupsPerSession` to cap memory per session; turn `ctg.trend.clearOnUserChange` off only on shared
kiosks where a user change should keep the trend list.

## History route

| Setting | Default | Range | Effect |
|---|---|---|---|
| `ctg.history.threads` | 4 | 1–32 | historian query threads (`ctg-history`) |
| `ctg.history.timeoutMs` | 15 000 | 2 000–60 000 | deadline per request (`504 TIMEOUT`); the chart's client deadline follows it |
| `ctg.history.maxConcurrentPerSession` | 4 | 1–8 | requests running at once per session (`429`) |
| `ctg.history.minIntervalMs` | 200 | 0–5 000 | refill interval of the request bucket of each chart (session and chart, so a renewed token keeps the budget of the one it replaces). Each chart may start **8** requests back to back (fixed burst), then one per interval; a refusal changes no state (`429`, `X-CTG-Limit: rate`). |
| `ctg.history.maxPens` | 32 | 1–64 | pens per request (`TOO_MANY_PENS`) |
| `ctg.history.maxRangeDays` | 400 | 1–3 650 | longest aggregated window |
| `ctg.history.maxRawRangeDays` | 31 | 1–3 650 | longest raw window |
| `ctg.history.pointCountMin` | 10 | 1–1 000 | fewest buckets per pen for aggregated queries |
| `ctg.history.pointCountMax` | 5 000 | 100–20 000 (at least `pointCountMin`) | most buckets per pen; with the bucket ladder it also bounds `span / bucketMs` |
| `ctg.history.pointCountDefault` | 300 | `pointCountMin`–`pointCountMax` | buckets per pen when a request names none |
| `ctg.history.minBucketMs` | 100 | 10–60 000 | smallest aggregation bucket |
| `ctg.history.maxRawPointsPerPen` | 250 000 | 1 000–2 000 000 | raw point cap per pen (the chart's `query.maxPointsPerPen` can only lower it) |
| `ctg.history.maxPointsPerResponse` | 500 000 | 10 000–5 000 000 | point cap per response |
| `ctg.history.cacheMb` | 64 | 0–1 024 | gateway cache for sealed history chunks (0 = off) |
| `ctg.history.sealMarginMs` | 300 000 | 0–86 400 000 | only chunks that ended at least this long ago are cached, and only when the historian has stored a sample at or after the chunk's end (Core Historian holds a changed float value back until the next change, so newer data can still change) |
| `ctg.history.bodyMaxKb` | 256 | 16–2 048 | largest request body (`413`) |
| `ctg.history.maxTasksPerRequest` | 64 | 1–1 024 | plan cost cap per request |
| `ctg.history.maxQueuedTasksPerSession` | 16 | 1–256 | queued plus running query tasks per session (`429`) |
| `ctg.history.maxInFlightRequests` | 32 | 1–512 | requests in progress gateway-wide (`503`). The route itself admits at most 64 at a time, so values above 64 have no effect. |
| `ctg.history.maxInFlightPoints` | 5 000 000 | 100 000–50 000 000 | points reserved in memory gateway-wide (about 85 MB at the default; `503`). A fifth of it is kept for light sessions (the top quarter of that fifth for small ones), and the rest is shared fairly between sessions while they contend; see [the point budget](#the-history-point-budget) |
| `ctg.history.queue` | 64 | 8–1 024 | **obsolete**: no longer used since the fair executor has per-session limits (kept so existing configurations stay valid) |

Refused requests carry `Retry-After` (seconds) and `X-CTG-Retry-After-Ms`, plus `X-CTG-Limit` (`rate`, `concurrency`,
`queue` or `capacity`) saying which limit applied.

**When to change:** `maxRangeDays` / `maxRawRangeDays` when users need longer windows (raw windows grow with the tag's
change rate, so raise raw carefully); `timeoutMs` and `threads` for a slow or busy historian; `maxRawPointsPerPen`,
`maxPointsPerResponse` and `maxInFlightPoints` together with the gateway heap (about 17 bytes per point in flight);
`cacheMb` to trade memory for faster reopening of closed ranges. The per-session limits rarely need changing: the chart
already paces itself to them.

### The history point budget

`ctg.history.maxInFlightPoints` bounds the points that all running history requests may hold in gateway memory. One
setting drives three parts:

| Part | At the default | Who may use it |
|---|---|---|
| limit | 5 000 000 | nobody goes above it |
| reserve = limit / 5 | 1 000 000 | only **light** sessions: a session that holds at most reserve / 4 (250 000) points once its request is admitted |
| small reserve = reserve / 4 (the top of the reserve) | 250 000 | only **small** sessions: a session that holds at most light / 16 (15 625) points once its request is admitted, enough for one request of one pen over an hour of a tag with up to about 2 samples per second (raw), or one aggregated pen |
| pool = limit − reserve | 4 000 000 | every request. While another session is waiting (it was refused in the last 5 s), a session that already holds points may grow only to its **fair share**: the pool divided by the sessions that hold or want points. A session that holds nothing may always start one request that fits the pool. |

So a few sessions that flood the route with large raw requests can fill the pool, and they end up sharing it equally.
Beyond its light size a session never uses the reserve, neither when a request is admitted nor when it grows while it
runs (see below). A chart asking for one pen over an hour is small (see below). With nobody waiting, a single
session may use the whole pool. When the budget is idle, one request may use the whole limit (this matters only when the
limit is lowered a lot).

The reserve is shared **first come, first served** among light sessions, except its top quarter, the **small
reserve**. Each light session holds at most 250 000 points, so at least three light sessions are served from the reserve
at once even while the pool is full; more light sessions wait for `Retry-After`. The light size is one raw pen's worst
case on purpose: a chart's first request for a long window of a tag the gateway has not seen yet reserves that worst
case, and it must still be admitted during a flood.

Light sessions can fill the reserve, though, so neither they nor the pool may use the small reserve. It serves only
small sessions, which may use every point up to the limit. With the shipped limits at least 16 small sessions (typically
30 or more: one raw pen over an hour of a 1 Hz tag reserves about 7 500 points) are admitted whatever the light and pool
sessions do. (When the budget is idle, a single request may still use the whole limit, as above.)

**What exactly is guaranteed.** A session is small only while *everything* it holds stays within 15 625 points, so the
guarantee covers a chart whose one history request at a time is one aggregated pen, or one raw pen over an hour of a tag
with up to about 2 samples per second (a raw estimate is twice the observed density times the window, plus a margin). A
5 Hz tag over an hour reserves about 36 000 points: that chart is light, not small, and shares the light part of the
reserve first come, first served. A second request in flight of the same session counts too.

The small reserve is shared **globally, oldest waiter first**. Many sessions that each loop small requests
could otherwise fill it and win every race for the room their ending requests free. A session refused with a small
request waits (for 5 s after its last refusal, longer than `Retry-After`), and a small request is admitted only while
the room left after it still holds one small request for every small session that has waited longer. So the room an
ending small request frees goes to the waiting sessions in the order they were refused, and a refused one-pen,
one-hour chart is admitted on its retry. With more small sessions than the small reserve holds at once, a new session
waits behind the ones refused before it, usually one `Retry-After`. The counters are `budgetSmallWaiting` and
`budgetRefusedSmallQueue`.

Requests reserve a **realistic estimate**, not their worst case:
- aggregated pens: their bucket count (exact);
- raw pens: the tag's raw sample density observed by recent queries on this gateway (the densest piece, times 2, plus a
  margin);
- a raw tag the gateway has not seen in the last 15 minutes: the worst case, `maxRawPointsPerPen` per pen, unless the
  queried window is at most an hour long: then it is estimated at 1 point per second (about 7 500 points for an hour),
  so a one-hour chart stays small. A denser tag grows its reservation while the request runs (below).

A newer observation raises the remembered density at once. Only a finished query with at least 16 rows over at least an
hour lowers it, to no less than half, and at most once every 15 minutes. Empty windows, windows with fewer than 16 rows,
short windows (realtime ticks) and timed-out queries never lower it, and a timed-out query of an unknown tag is not
remembered at all. The row minimum matters because the historian returns rows that are not samples of the window: Core
Historian answers an hour after a tag's data ended with 2 boundary rows. The first observation of a tag the gateway does
not know is remembered as at least 1 point per second unless it has at least 1 024 rows, so a request for an empty or
almost empty window cannot make a tag look empty for later requests. Repeated requests for sparse windows (16 rows or
more) can still halve a known tag's density once every 15 minutes; that costs only the requests that grow and do not fit
(below), never the small reserve.

When a request needs more than it reserved, its reservation grows while it runs, under the same rules as admission: up
to the small size it may use every point up to the limit, up to the light size the reserve except the small reserve,
beyond it the pool (and its fair share while another session waits). A growth
takes all the room it may use up to the step it asked for, so near the limit it does not come back for every row. If
even the exact need does not fit, the request is answered `503 BUSY` (with `Retry-After`) instead of holding memory the
gateway does not have. Once a request knows it will answer `BUSY`, its queries that have not started yet are cancelled
at once (they would only add historian load under the contention that refused it); queries that already
run finish, and their rows still teach the density (`budgetStarvedCancelled` counts the cancelled queries). Its retry
reserves the density that was just observed. A too small estimate therefore costs the session that made the request,
never the reserve of the others. Refusals by the point budget say `X-CTG-Limit: capacity`. The counters
are in the history diagnostics (`budgetWaiting`, `budgetAdmittedSmall`, `budgetRefusedShare`, `budgetGrown`, …).

**Memory right after a restart (measured).** The first heavy history load after a gateway restart leaves
the heap about 100 to 150 MB larger than before, and that memory stays. On a test gateway (Core Historian, the
5-session raw flood of the stress tests, about a minute after a restart, two runs) the retained heap was +126 and +144 MB
at the end of the run. About 40 MB of it are the module's own caches, bounded by `ctg.history.cacheMb` and fixed entry
limits (chunk cache, anchors, read checks, density memory). The rest, 86 to 103 MB, is the Core Historian warming up its
embedded query engine: a class histogram before and after the run shows the growth in the historian's SQL parser and
query-model objects and their arrays, and none in module classes. It happens once. The same flood on a warm gateway (50
minutes of tests later) retained +29 MB at the end, all of it the module caches: after clearing them the heap was below
the run's starting point. During a cold flood the history route is slower too: the polite session stayed at 30 of 30
answers with 0 busy, but its p95 was 0.5 to 1.5 s (warm: 0.4 s) and `/StatusPing` peaked at 0.3 to 0.6 s (warm:
0.17 s). Plan the gateway heap with this one-time growth in mind.

## Tokens and sessions

| Setting | Default | Range | Effect |
|---|---|---|---|
| `ctg.token.ttlMs` | 900 000 | 60 000–86 400 000 | lifetime of a chart's history token (renewed automatically, 2 min before it expires or at half its lifetime, whichever comes first) |
| `ctg.token.designerTtlMs` | 300 000 | 60 000–900 000 | lifetime of tokens issued to Designer sessions |
| `ctg.session.sweepMs` | 600 000 | 10 000–3 600 000 | interval of the safety-net sweep that removes state of sessions whose end was not reported (a session Perspective still has is never swept, even when it shows no module component) |

**When to change:** rarely. A shorter `ctg.token.ttlMs` limits how long a leaked token stays valid; a longer one
saves a renewal round-trip on very long-lived screens. `ctg.session.sweepMs` is a safety net only.

## Annotations

| Setting | Default | Range | Effect |
|---|---|---|---|
| `ctg.annotations.maxPerPen` | 500 | 1–5 000 | distinct notes loaded per pen and window (after versions and deletions are resolved; earliest by start) |
| `ctg.annotations.maxPerSessionPerHour` | 60 | 1–10 000 | note saves (adds and edits) per session per hour (`RATE_LIMITED`) |

**When to change:** raise `maxPerPen` when pens carry many notes per window (charts then draw more markers); lower
`maxPerSessionPerHour` to limit note spam.

## Debug and test hooks

**Never enable these in production.**

| Setting | Default | Effect |
|---|---|---|
| `ctg.debug` | `false` | enables the test messages `ctg.debug.fire` (fires a component event with a gateway-built payload) and `ctg.debug.reloadSettings`, the display's `dt.debug.*` messages, cache statistics in history responses, and the delay hooks below. Logs `ctg.debug is ON: test hooks enabled …` (WARN) when switched on. |
| `ctg.debug.historyDelayMs` | unset | only while `ctg.debug`: delays every history query by 0–60 000 ms (timeout tests) |
| `ctg.debug.dt.readDelayMs`, `ctg.debug.dt.writeDelayMs` | unset | only while `ctg.debug`: delays a display's fresh read / the completion of its write by 0–30 000 ms |
| `ctg.settings.rev` | unset | any change triggers a reload of all settings (see above); not a setting itself |

In the browser, `localStorage['ctg.debug'] = '1'` enables the module's debug console logging for that browser only.

<!-- nav:bottom -->

---

← Previous: [Events](components/ctg-chart/events.md) · [Back to index](README.md) · Next: [Security and permissions](security-and-permissions.md) →

<!-- /nav:bottom -->
