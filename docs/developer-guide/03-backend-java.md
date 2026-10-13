<!-- nav:top -->

[Docs home](../README.md) › [Developer Guide](README.md) › **Backend (Java)**

<!-- /nav:top -->

# 03 — Backend (Java)

The gateway and Designer code under `simple-tag-display/{common,gateway,designer}/src/main/java`. Every class starts
with a Javadoc that explains its job, its threads and the design decisions behind it; this page is the map.

**On this page**

- [Packages](#packages)
- [Lifecycle](#lifecycle)
- [`GatewayServices`](#gatewayservices)
- [Delegates](#delegates)
- [Threads](#threads)
- [Tags](#tags)
- [History](#history)
- [Security classes](#security-classes)
- [Audit](#audit)
- [Logging](#logging)
- [Rules for gateway code](#rules-for-gateway-code)

---

## Packages

| Package (`com.example.simpletagdisplay.…`) | Classes | Job |
|---|---|---|
| `common` | `SimpleTagDisplayModule`, `DisplayTemplateComponent`, `CtgChartComponent`, `SchemaLoader` | IDs, versions, `BROWSER_RESOURCES`, component descriptors (schema, events, palette variants) |
| `common.protocol` | `Protocol`, `ErrorCode` | message names, route and header names; error codes with HTTP status, retryable flag and default text |
| `designer` | `SimpleTagDisplayDesignerHook`, `DisplayTemplateIcon`, `CtgChartIcon` | Designer palette registration; icons drawn in Java2D |
| `gateway` | `SimpleTagDisplayGatewayHook`, `GatewayServices`, `ModuleSettings` | lifecycle, the service container, settings |
| `gateway.delegate` | `CtgDelegateBase`, `DisplayTemplateDelegate`, `CtgChartDelegate`, `HandlerRegistry`, `CallContext`, `PropsSnapshot`, `IdempotencyMap` | the component channel |
| `gateway.ops` | `DisplayOps`, `DisplayGates`, `ChartOps`, `ChartMetaCache`, `DesignPens`, `AnnotationOps`, `SettingsFanOut` | the work behind each message, kept free of Perspective types where possible so JUnit can test it |
| `gateway.security` | `UserContext`, `AccessRule`, `TrustedProps`, `BindingLint`, `SecurityKeys`, `FloorPolicy`, `ReadScope`, `LiveSessions` | see [Security and permissions](../user-guide/security-and-permissions.md) |
| `gateway.tags` | `TagPaths`, `TagSubscriber`, `TagMetaReader`, `ValueCodec`, `WriteCoercer`, `TagConfigEditor`, `HistoryAvailability` | tag paths, subscriptions, metadata, value encoding, write coercion, config edits |
| `gateway.history` | `HistoryRoute`, `HistoryService`, `HistoryRequest`, `HistoryResult`, `FairHistoryExecutor`, `HistoryRateLimiter`, `PointBudget`, `PointEstimator`, `ResponseBudget`, `HistoryChunkCache`, `AnchorCache`, `BucketLadder`, `ReadPermissionCache`, `HistoryTokenStore`, `BoundedJson`, `HistoryJsonWriter`, `PenSeriesWriter`, `JsonBytes` | the history route |
| `gateway.trend` | `TrendListStore`, `TrendKey`, `TrendListListener`, `SessionEvictionSubscriber` | session trend lists and session-end eviction |
| `gateway.audit` | `CtgAudit`, `AuditQueryService` | audit records and the change-history query |
| `gateway.browse` | `TagBrowseService`, `TagSearch`, `TagSearchAdmission` | chart tag browser; recursive search ("Search all folders": bounded walk of ordinary browses with the user's context, read-scope region, permission pass, per-session and gateway-wide admission) |
| `gateway.annotations` | `AnnotationService` | historian annotations |
| `gateway.perspective` | `PerspectiveInternals` | the only place that touches Perspective internals; every method has a safe fallback |
| `gateway.util` | `Json`, `RateLimitedLog`, `TokenBucket`, `NamedThreadFactory` | helpers |

## Lifecycle

`SimpleTagDisplayGatewayHook.startup()`:

1. Reads the `ctg.*` settings and builds `GatewayServices` (settings, floor policy, live sessions, tokens, trend lists,
   history service, scheduler); starts the session-end subscriber, the settings poll and the sweeps.
2. Registers both component descriptors with Perspective's `ComponentRegistry`.
3. Registers one `ComponentModelDelegate` factory per component. Every component instance on every page, in client
   **and** Designer sessions, gets its own delegate.
4. Mounts `POST /v2/history` and the static resources (`mounted/` → `/res/simpletagdisplay/`), with cache headers per
   file (`onMountedResourceRequest`).
5. Logs `Display Template / CTG <resourceVersion> started (protocol 2)` and `Display Template / CTG build id <id>`.

`shutdown()` undoes this in reverse, each step in its own try/catch: factories and components are unregistered,
`GatewayServices.close()` marks the module closed (delegates answer `MODULE_STOPPING`), force-stops every live delegate
on its session queue (unsubscribes tags, revokes tokens), stops the executors and clears every store. Nothing is left
behind after a module restart.

The Designer hook registers the same descriptors with icons (`setIcon`); Perspective shows `ComponentDescriptor.getIcon()`
in the palette and project browser. The icons are drawn in Java2D and wrapped as multi-resolution images
(`PaletteIcons`: 16, 20, 24, 28, 32, 40 and 48 px for display scales 100–300 %), so they stay sharp on HiDPI screens.

## `GatewayServices`

The module-scoped container, created in `startup()` and closed in `shutdown()`. Delegates receive it at construction;
the history route looks it up per request (`GatewayServices.current()`), because Perspective may mount routes before
startup. It owns `settings()`, `floorPolicy()`, `liveSessions()`, `tokens()`, `trendStore()`, `history()` and
`scheduler()`.

Extension points (the class itself is a frozen contract):

- `shared(Class<T>, Supplier<T>)`: one module-wide instance of a cache or service, closed with the module when it is
  `AutoCloseable` (audit, meta caches, chunk cache, permission cache, annotation service).
- `onSessionEnd(Consumer<UUID>)`, `onUserChange(Consumer<UUID>)`: per-session eviction. A session ends on
  Perspective's `SessionShutdownEvent` or, as a safety net, when the sweep (`ctg.session.sweepMs`) finds it dead. The
  sweep re-checks each session at the moment it ends it (`LiveSessions.endIfDead`), so a session that came back to life
  meanwhile keeps its state.
- `ModuleSettings.onReload(listener)` and `ops.SettingsFanOut.of(services)`: react to a settings reload (delegates
  re-push capabilities at once; running charts reconcile their pens).

## Delegates

`CtgDelegateBase extends ComponentModelDelegate` implements the protocol once for both components:

- **Dispatch** (`handleEvent`, on the session queue): module closed → `MODULE_STOPPING`; body size ≤ 64 KB; `v == 2`
  (else `ctg.reload`); id format; handler lookup (`UNKNOWN_MESSAGE`); rate class bucket (`RATE_LIMITED`); then the
  handler, with any `RuntimeException` turned into `INTERNAL` plus a rate-limited WARN.
- **Pushes** (`push`): only after the client's hello, only while the page is connected (otherwise a resync is marked);
  each push gets `v`, `epoch`, `seq`, `serverNow`. A heartbeat goes out after `ctg.display.heartbeatMs` of silence.
- **Props**: `props()` returns the trusted `PropsSnapshot` (built by `TrustedProps`) plus the lint verdicts.
- **Auth changes**: `Session.WebAuthStatusChangeEvent` → new `UserContext`, resubscribe with the new user, revoke and
  reissue tokens, push a full snapshot.
- **Idempotency**: mutating requests are stored by id **at receipt**; a duplicate id waits for and returns the first
  reply.

`DisplayTemplateDelegate` adds subscriptions (conditional: value always; alarm summary, alarm setpoints and engineering
limits only when used), the 60-s metadata refresh, a 60-s subscription self-check and the handlers `dt.write`,
`dt.configEdit`, `dt.trendAdd`, `dt.trendRemove`, `dt.auditQuery`. The write flow is in
[Architecture](01-architecture.md#sequences).

`CtgChartDelegate` keeps the effective pen list (configured pens adopted by `DesignPens`, plus the trend list), applies
the read scope, reads metadata through a per-session `ChartMetaCache`, subscribes live values, issues history tokens,
and handles `chart.trendAdd/Remove/Clear`, `chart.browse`, `chart.token`, `chart.annotationSave/Delete`.

`AnnotationOps` commits an annotation change in a fixed order. An edit or delete first **claims** the note's id:
`AnnotationService.claim` returns a ticket with a token, a second change of the same id answers `BUSY` while the first
is in flight and `ANNOTATION_NOT_FOUND` once it succeeded, and the claim is settled with its token when the historian
answers (compare-and-remove, so a late answer never frees or overwrites a newer claim). Then come the hourly quota, the
audit attempt and the store call. Until the store call has returned, every way out gives back the claim and the quota
slot: a refusal answers its own code, and any exception or `Error` closes a begun audit attempt as failed and answers
`INTERNAL`. A failure **after** the store call returned is only logged: the note may be stored, so the reply, the claim
and the audit record follow the historian's real answer and never say `INTERNAL`.

## Threads

| Work | Thread |
|---|---|
| Message handling, prop reads and writes | the Perspective session queue (never blocked) |
| Tag reads, writes, subscriptions, browse, config saves | the tag system's threads; results hop back to the session queue only if the delegate still runs |
| Tag change callbacks | tag subsystem thread: O(1), store the newest value and schedule a flush |
| Coalesced pushes, timeouts, heartbeats, sweeps, settings poll | `ctg-sched` (2 threads) |
| Historian queries | `ctg-history` (`ctg.history.threads`), fed by `FairHistoryExecutor` (round-robin per session, per-session caps, unstarted tasks cancelled at the deadline) |
| HTTP route | Jetty worker, waits on the history futures with the request deadline |
| Audit profile records | `ctg-audit-write` (1 thread, keeps decision order; a full queue drops the profile record and logs `audit-overflow`) |
| Change-history queries | `ctg-audit-query` (2 threads, 16 queued; full → `RATE_LIMITED`) |
| Annotation stores and id look-ups | `ctg-annotations` (1 thread, bounded; full → `BUSY`) |

The module never uses Perspective's shared executors, so its shutdown stops only its own threads.

## Tags

- `TagPaths`: parsing and the path rules ([Security and permissions](../user-guide/security-and-permissions.md#gates-per-action)); `normalizedKey` (lower-case,
  provider-qualified) is the identity used for equality, `expectedTagPath`, trend dedupe and chart pen keys; the project's
  default provider fills in `[...]`-less paths.
- `TagSubscriber`: subscriptions whose listeners carry the user's `SecurityContext`; a fallback to the gateway tag
  manager covers sessions of a project that is being deleted.
- `TagMetaReader`: one batched read of `.EngUnit`, `.EngLow`, `.EngHigh`, `.FormatString`, `.DataType`, `.TagType`,
  history properties and the alarm configuration.
- `ValueCodec`: JSON encoding of values (Int8 beyond 2^53 as a digit string, non-finite as `null` + flag, arrays capped
  at 100 elements, encoded values capped at `ctg.push.maxValueBytes`).
- `WriteCoercer`: converts the browser's JSON to the tag's data type (strict: no silent truncation, type ranges).
- `TagConfigEditor`: edits `EngUnit`/`EngLow`/`EngHigh` with `MergeOverwrite`; UDT members report "edit the UDT definition".

## History

`HistoryRoute` validates the request in a fixed order (see [Architecture](01-architecture.md#the-history-route))
and hands it to `HistoryService`, which plans per pen (bucket width from `BucketLadder`, sealed chunks from
`HistoryChunkCache`, anchors from `AnchorCache`), reserves points (`PointBudget`, `ResponseBudget`), runs the tasks on
`FairHistoryExecutor` and streams the result with `HistoryJsonWriter` / `PenSeriesWriter` (no Gson tree).
`PointBudget` is the gateway-wide point reservation with a reserve for light sessions (its top quarter kept for small
sessions and shared among them oldest waiter first, so a one-pen, one-hour chart of a tag with up to about 2 samples per
second, or any one-pen aggregated chart, is admitted at the latest on its retry) and a per-session fair share of the rest;
every reservation is attributed to a session; `PointEstimator` remembers each tag's raw sample density so a request reserves a realistic estimate, and the
request's `ResponseBudget` grows the reservation while the queries run (or ends the request with `BUSY` when the gateway
has no room, cancelling its queries that have not started yet).
`HistoryRateLimiter` is the per-token bucket (burst 8, refill every `ctg.history.minIntervalMs`); a bucket is dropped when
its chart has no token left (`HistoryTokenStore.onRemoved`) or its session ends.
`ReadPermissionCache` caches per-session Read checks, keyed by the session's auth generation. `BoundedJson` parses the
body with size and depth limits.

Point-cap rule: pens are admitted in request order. A pen over its own cap is refused (`tooManyPoints`) without evicting
later pens that fit. The one exception: a late aggregated fallback of a re-run pen takes only points still free and
never evicts a pen that already settled; if it does not fit, that pen is `tooManyPoints`.

The route is mounted with a framework concurrency of 80; the module's own `ctg.history.maxInFlightRequests` is the
effective limit, and values above 64 have no effect.

## Security classes

| Class | Job |
|---|---|
| `UserContext` | the session user (name, roles, security levels, authenticated flag, `SecurityContext`) |
| `AccessRule` | evaluates `{roles, securityLevels, requireLogin}`; exact role names; present-but-null lists mean "nobody" (fail closed) |
| `SecurityKeys` | the list of `[S]` paths per component |
| `TrustedProps` | trusted copy of the security keys; reverts browser changes in client sessions |
| `BindingLint` | classifies bindings on security keys and their ancestors / descendants |
| `FloorPolicy` | the `ctg.write.*` / `ctg.configEdit.*` minimums, rebuilt on reload; `writeBlock` / `configEditBlock` also return the setting that refused (sent as `details.setting` / `capabilities.<action>.setting` when the component itself allows the action), `overrides` lists the settings stricter than a component's access rule (Designer sessions only: `capabilities.<action>.overrides`) |
| `ReadScope` | which runtime chart pens may be read |
| `LiveSessions` | the module's registry of live sessions, delegate counts, a 60-s grace period and auth generations (used by tokens and sweeps) |

## Audit

`CtgAudit` records each write, configuration edit and annotation change twice: in the audit profile (on
`ctg-audit-write`) and as one `SimpleTagDisplay.Audit` INFO line (on the deciding thread). The record is attached to the
**raw** provider future, so it is written even when the page goes away; a write that times out gets an UNCERTAIN record
and later a `late=true` one. With `ctg.audit.required` a slot is reserved atomically before the provider is called.
`AuditQueryService` serves the change history: an 8-argument profile query (the `QueryRequest` builder is not in the
8.3.1 SDK), exact target match, newest first, cut to the limit, with a fresh Read check for the user. A row's
`auditId` comes only from the module's suffix at the **end** of the value (`[auditId=<uuid>]` or
`[auditId=<uuid>, late=true]`), never from `[auditId=…]` text inside a written String value.

## Logging

| Logger | Content |
|---|---|
| `SimpleTagDisplay.Gateway` | lifecycle INFO, settings reload, startup failure ERROR, the `ctg.debug is ON` WARN |
| `SimpleTagDisplay.Display` / `SimpleTagDisplay.Chart` | DEBUG per message; rate-limited WARN for unexpected exceptions; chart WARN `pen-budget` (too many new runtime paths per minute) |
| `SimpleTagDisplay.History` | DEBUG per request (pens, span, mode, ms, points); rate-limited WARN for historian failures |
| `SimpleTagDisplay.Trend` | trend list add / remove / evict (DEBUG) |
| `SimpleTagDisplay.Audit` | one INFO line per audited attempt; WARN `prop-tamper`, `prop-tamper-unrestored`, `security-key-bound`, `audit-unavailable`, `audit-overflow`, `audit-failed` |
| `SimpleTagDisplay.Annotations` | annotation store failures (rate-limited) |
| `SimpleTagDisplay.Probe` | DEBUG: every watched prop change with its `Origin` (diagnosing tamper and binding questions) |

Set levels in the gateway web interface under **Diagnostics > Logs** (logger levels). Every client-supplied string
in a log line is sanitised (control characters, the Unicode line and paragraph separators U+2028/U+2029 and the
bidirectional override and isolate controls become `?`; 300 characters max); validation failures never log above DEBUG
and never with a stack trace; error replies never carry exception messages.

## Rules for gateway code

- Never `SecurityContext.emptyContext()`, never the context-less `readAsync(paths)` / `writeAsync(paths, values)`.
  `subscribeAsync(paths, listeners)` is allowed only with listeners that return the user's context.
- No GET routes with side effects (there are no GET routes at all).
- Every async continuation checks that the delegate or module is still running.
- Rate-limit keys never contain client text; role names compare exactly.
- JDK 17 bytecode only (the build fails otherwise); Kotlin build files use `//` comments only.

`SourceHygieneTest` (JUnit) enforces several of these by scanning the sources.

<!-- nav:bottom -->

---

← Previous: [JavaScript primer](02-javascript-primer.md) · [Back to index](README.md) · Next: [Frontend JavaScript](04-frontend-javascript.md) →

<!-- /nav:bottom -->
