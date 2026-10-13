<!-- nav:top -->

[Docs home](../README.md) › [User Guide](README.md) › **Security and permissions**

<!-- /nav:top -->

# Security and permissions

This page is for integrators and gateway administrators. It explains what the module protects, how, where the limits
are, and how to set up roles. Settings named here are JVM properties, see [Gateway settings](gateway-settings.md).

**On this page**

- [Defaults at a glance](#defaults-at-a-glance)
- [What changed in 2.0.0](#what-changed-in-200)
- [Threat model](#threat-model)
- [Gates per action](#gates-per-action)
- [Trusted props](#trusted-props)
- [Binding lint: security props must not depend on user input](#binding-lint-security-props-must-not-depend-on-user-input)
- [Floor policy](#floor-policy)
- [Chart read scope](#chart-read-scope)
- [Tag permissions](#tag-permissions)
- [History tokens](#history-tokens)
- [Cross-site requests, websockets and framing](#cross-site-requests-websockets-and-framing)
- [Events are not proof](#events-are-not-proof)
- [Audit](#audit)
- [Residual risks](#residual-risks)
- [Recommended setup](#recommended-setup)

---

## Defaults at a glance

The 2.0.0 defaults follow native Perspective and the Power Chart: a new screen works without a login, and the **tag's
own permissions** decide what a user may read and write. Tighten from there.

| Action | Allowed by default | Needs a login by default? | What still protects the tag |
|---|---|---|---|
| See a value (Display Template) | yes, for any tag in `tagPath` | no | the tag's **Read** Permissions (*No access* otherwise) |
| Write a setpoint | only where `setpoint.enabled: true` | **no** (`setpoint.access.requireLogin: false`, `ctg.write.requireAuthenticated=false`) | the tag's **Write** Permissions (checked with the session's own security context, anonymous included), limits (Engineering Low/High), the step guard, option lists, Bad-quality refusal, `[System]` denied, the audit trail |
| Trend a tag (Trend Tag, tag browser) | yes, numeric and Boolean tags with history | no | Read Permissions; at most `ctg.trend.maxPens` tags per list |
| Browse and search tags in the chart | **yes** (`tagBrowser.enabled: true`), every provider except `[System]` | no | the user's browse permissions and Read Permissions (tags the user may not read are left out of search results); `ctg.read.deniedProviders` |
| Add runtime pens to a chart | yes, inside the read scope (by default: the tag browser's root, i.e. everything except `[System]`) | no | Read Permissions; `readScope`; `ctg.chart.maxNewPathsPerMinute` |
| Load chart history | for the chart's effective pens | no | Read Permissions; per-chart history token bound to the session; rate and memory limits |
| Edit tag configuration (units, limits) | **no** (`menu.configEdit.enabled: false`) | **yes** when enabled | the provider's edit permissions; floor policy; audit |
| See the change history | **no** (`menu.changeHistory.enabled: false`) | **yes** when enabled | Read Permissions; an audit profile must exist |
| Add chart notes | **no** (`annotations.enabled: false`) | **yes** when enabled | ownership rules, quota, audit |

In every case the gateway, not the browser, makes the decision: the props that grant access are **security props**
(**[S]**) that a browser cannot change, and bindings that would let a user influence them fail closed.

To require a login:

- for one display: `setpoint.access.requireLogin: true`, or `setpoint.access.roles` (a role implies a login);
- for the whole gateway: `-Dctg.write.requireAuthenticated=true` ([Gateway settings](gateway-settings.md#floor-policy-writes-and-tag-configuration-edits)).

To narrow the tag browser and runtime pens: `tagBrowser.rootPath` or `readScope.allowedRoots` per chart, or
`tagBrowser.enabled: false`.

## What changed in 2.0.0

Version 1.x exposed eight HTTP routes (`/readTag`, `/writeTag`, ...) that ran with an **empty security context**: any
browser with a session cookie could write any tag by calling a URL, tag permissions were never checked per user, and the
audit log had no user. All eight routes are **gone** in 2.0.0 (they answer 404). Every action now runs inside the
Perspective session, as the logged-in user.

## Threat model

Protected against:

- a user of a Perspective session (anonymous or logged in) who edits props, sends crafted messages or calls the history
  route from the browser console, trying to write, edit or read tags they may not;
- a user who opens a popup or page with crafted parameters (faceplates);
- another web site that tries to use the user's session (cross-site requests, websockets, framing);
- one session exhausting the gateway (flooding writes, history queries, browse, trend changes).

Not protected against (outside the module's reach): a Designer user (who can change the view itself), a gateway
administrator, scripts that you attach to component events, and tags whose own permissions allow too much.

## Gates per action

Every action is checked **on the gateway**, after the message arrives, with values from the trusted props snapshot. The
browser greys menu items from the same rules, but that is only for display.

| Action | Component rules (**[S]** props) | Gateway rules | Tag rules |
|---|---|---|---|
| Setpoint write (`dt.write`) | `enabled`, `setpoint.enabled`, `setpoint.access`, `setpoint.limits` (fail closed), `setpoint.maxStep*`, `setpoint.options`, `setpoint.maxStringLength`, `setpoint.allowOnBadQuality` | path rules, floor policy, Designer Read/Write mode, re-check after the tag read | Write Permissions, read-only flag |
| Tag configuration edit (`dt.configEdit`) | `enabled`, `menu.configEdit.enabled` + `access` | path rules, floor policy (`ctg.configEdit.requiredRoles`) | the provider's edit permissions |
| Trend Tag (display) | `enabled`, `menu.trend.enabled` + `access` | trend list size, tag type | Read permission, history enabled |
| Change history (`dt.auditQuery`) | `menu.changeHistory.enabled` + `access` + `limit` | an audit profile exists | Read permission (checked again with the user's context) |
| Chart pens, live values, history | `readScope` (runtime pens only) | `ctg.read.deniedProviders`, history token | Read permission |
| Chart trend changes | `enabled`, `trendEdit` | `readScope` for added tags | Read permission, history enabled |
| Tag browser (on by default) | `tagBrowser.enabled`, `rootPath`, `access` | `ctg.read.deniedProviders` | browse runs with the user's context |
| Tag search ("Search all folders") | as the tag browser, plus `readScope` (results and searched folders) | `ctg.read.deniedProviders`; bounds (depth 16, 50 000 entries, 5 000 folder pages, 1 000 matches, 5 s); one search per session, 4 per gateway, 1/s per session (burst 4) | browse with the user's context; every match is read with the user's context and dropped when Read Permissions deny it |
| Annotations | `annotations.enabled`, `edit`, `moderate`, `ownOnly` | per-session quota | history provider |

**Path rules** (writes, edits, trends): the path must be a tag, not a property (`.EngUnit`), an alarm path or a folder;
`.` and `..` segments, `:/`, control characters and paths over 1024 characters are refused; writes and edits also
refuse `_types_` (UDT definitions) and array elements. Role names compare **exactly** (case-sensitive).

`access` objects share one shape everywhere: `roles` (any one of them), `securityLevels` (any one of these paths, for
example `Authenticated/Roles/Operator` or `SecurityZones/ControlRoom`) and `requireLogin`. Empty lists add no
requirement.

## Trusted props

Every prop marked **[S]** in [Display Template: properties](components/display-template/properties.md) and
[Chart: properties](components/ctg-chart/properties.md) is a **security key**. The gateway keeps a trusted copy:

- In a **client session**, a change that comes from the browser (`Origin.Browser`) is not adopted. The gateway writes the
  trusted value back, keeps using it, and logs one rate-limited WARN on `SimpleTagDisplay.Audit`:
  `action=prop-tamper user=… key=setpoint.enabled`. (`ctg.security.tamperLogPerMin` limits the lines.)
- The same applies to a **binding writeback** (`Origin.BindingWriteback`): a bidirectional binding configured on
  *another* prop that targets a security key (an "Unlock editing" checkbox whose `props.selected` is bound
  bidirectionally to the display's `setpoint.enabled`, or the component's own `custom.unlock` bound to
  `setpoint.access.roles`) relays a client value, so it is reverted and reported as `prop-tamper` too. Chart `pens`
  written that way do not become Designer pens.
- Changes by bindings, scripts, session and project are adopted. A component event script or message handler that
  copies client input into a security key is trusted like any other script: **never use one as an unlock switch**.
- In the **Designer**, every change is adopted: Designer users can edit and save the view anyway.
- Values present when the view starts (static values, popup and page parameters) are adopted. They are covered by the
  binding lint and the floor policy below.

**Hardening knob:** set the property's **access** to `PROTECTED` in the property editor for gate props. Perspective then
never sends browser writes for that prop to the gateway at all (verified on 8.3.10).

## Binding lint: security props must not depend on user input

Users can open popups and pages with any parameters, and can write view and component custom props from the browser. A
security prop **bound** to such a source would hand the gate to the user, because a binding result is indistinguishable
from a configured value. So, when a component starts, the gateway inspects the bindings on every security prop and on its
parent objects:

| Binding on a security prop | Result |
|---|---|
| **bidirectional** binding (any source) | that gate **fails closed** (`BOUND_BIDIRECTIONAL`: "Editing is turned off: this screen's configuration is not safe (ask the integrator).") |
| any **property** binding (`view.params.*`, `view.custom.*`, `this.*`, `parent.*`, other components, `page.*`, `session.custom.*`, ...), any expression, expression structure, query parameter or indirect tag reference that contains a property reference `{x.y}` (comments `// …` and `/* … */` are skipped; an expression the lint cannot read to the end, such as an unterminated string, counts as user-controlled), or a script transform that uses `self` | WARN `action=security-key-bound` once per view and project; with `ctg.security.rejectBoundGates=true` (**default**) the gate also **fails closed** |
| a direct tag binding, or references only to `session.props.auth.*` / `session.props.id` (the browser cannot write those) | allowed |

`tagPath` and `trendGroup` may be bound to parameters (reading is governed by tag permissions; trending by the read
scope and the trend rules).

Rules of thumb:

- **Never bind a security prop bidirectionally.** A bidirectional binding turns a browser prop write into a write of the
  bound source (a tag, a custom prop).
- **Parameter-bound gates are user-controlled.** Configure `setpoint.enabled`, `setpoint.access`, limits and options
  statically in the faceplate, or derive them from the user (`session.props.auth.roles`), never from `view.params`.
- If you must bind a gate to something the user could influence, an administrator can set
  `-Dctg.security.rejectBoundGates=false`. The gate then works, the WARN stays, and the floor policy plus tag
  permissions are the only authority. Prefer `PROTECTED` access on such props.

## Floor policy

Gateway-wide minimums, evaluated **in addition to** every component rule and never weaker. Only an administrator can set
them (JVM properties; reloaded live, see [Gateway settings](gateway-settings.md)).

| Setting | Default | Effect |
|---|---|---|
| `ctg.write.requireAuthenticated` | `false` | `true`: anonymous users can never write or edit tag configuration (`AUTH_REQUIRED`), whatever the component says |
| `ctg.write.requiredRoles` | empty | every write also needs one of these roles (`FORBIDDEN_ROLE`; anonymous: `AUTH_REQUIRED`) |
| `ctg.configEdit.requiredRoles` | empty | every configuration edit also needs one of these roles |
| `ctg.write.allowedRoots` | empty (no restriction) | writes and edits only below these folders, e.g. `[default]Setpoints` (`OUT_OF_SCOPE`) |
| `ctg.write.deniedProviders` | `System` | no writes or edits on these providers (`INVALID_PATH`) |
| `ctg.read.deniedProviders` | `System` | no runtime chart pens, chart trend adds or browsing on these providers, and no chart history from them (configured pens included) |

Components show the floor's effect (greyed setpoints, menu reasons) as soon as the settings reload. When a floor
setting refuses an action the component itself allows, the reason names the setting (*... (gateway setting
ctg.write.requireAuthenticated)*), and the Designer shows a **Gateway rule** badge on that display.

**Anonymous writes (default, Ignition parity).** Since 2.0.0 the defaults follow native Perspective: an anonymous
session may write a setpoint (`setpoint.access.requireLogin` defaults to `false`, `ctg.write.requireAuthenticated` to
`false`) **unless the tag's own Write Permissions or the project's security forbid it**. Writes always run with the
session user's security context, so a tag whose Write Permissions need a role refuses an anonymous session
(`WRITE_DENIED`). To require a login:

- for one display: `setpoint.access.requireLogin: true` (or `roles` / `securityLevels`);
- for the whole gateway: `-Dctg.write.requireAuthenticated=true`.

Tag configuration edits (`menu.configEdit.access.requireLogin`) and change history
(`menu.changeHistory.access.requireLogin`) keep **`true`** as their default: a configuration edit changes the tag for
every screen and user, and the change history shows who changed what. Both are more sensitive than a value write, and
configuration editing is also off by default.

## Chart read scope

Display reads are not scope-limited: a display's `tagPath` is configured or parameter-bound exactly like a Perspective
tag binding, and the tag's Read permission applies. Charts can add pens at runtime, so they have a **read scope**:
configured pens and session trend-list entries are allowed; runtime pens need `readScope.allowRuntimePens`, a provider
not in `ctg.read.deniedProviders`, and a path below `readScope.allowedRoots` (empty: `tagBrowser.rootPath` when the tag
browser is enabled, else no runtime pens). The history route checks each pen against the scope of the chart that issued
the token. Details: [Click To Graph Chart](components/ctg-chart/README.md#read-scope-which-tags-a-chart-may-read).

Two documented limits:

- **`pens` bound to a client-writable source** (`view.params`, `view.custom`) is adopted as configured pens, so it is
  outside the read scope, the same as a tag binding on that parameter would be. A Designer script that rewrites `pens`
  from its current value adopts runtime additions the same way. Tag Read permissions still apply.
- **The trend group widens the scope.** Every chart of a trend group shows the whole list, and each entry was admitted by
  the scope of whichever chart or display added it. The effective scope is the union over the group. Give a narrowly
  scoped chart its own `trendGroup` (or `null`).

Runtime pen churn is limited: `ctg.chart.maxNewPathsPerMinute` new paths per chart (over: `overLimit` + one WARN).

## Tag permissions

Everything runs with the session user's security context, so the tag's **Read** and **Write Permissions** (and the
provider's own rules) always apply on top of the module's gates:

- a user without Read permission sees *No access* and gets no history (`accessDenied`), and the value never reaches the
  browser, not even in websocket frames;
- a user who passes the component gate but not the tag's Write Permissions gets `WRITE_DENIED`, audited as BAD.

**Remote (Gateway Network) tag providers** were not tested. Whether a remote provider enforces the passed user's
permissions is not verified; until you have checked it on your system, keep writes away from remote providers with
`ctg.write.allowedRoots` or `ctg.write.deniedProviders`.

## History tokens

Chart history uses one HTTP route, `POST /data/simpletagdisplay/v2/history`, authenticated by a per-chart token
(header `X-CTG-Token`) delivered over the component channel:

- bound to the Perspective session and its HTTP session cookie; a token used with another session's cookie gets 403;
- valid for `ctg.token.ttlMs` (15 min, renewed automatically), invalid at once after logout or a user change;
- at most two live tokens per chart; Designer tokens live 5 minutes (`ctg.token.designerTtlMs`) and are bound to the
  Designer's address;
- the route refuses cross-site requests (`Sec-Fetch-Site: cross-site` → 403), anything but `application/json` (415),
  missing `Content-Length` (411) and bodies over `ctg.history.bodyMaxKb` (413) before reading them.

Token values are never written to logs (also not by the browser's debug logger).

## Cross-site requests, websockets and framing

Results measured on 8.3.10 (Chrome):

- **Cross-site websocket hijacking:** a page on another site could not open the session's websocket. Chrome does not
  send the session cookie cross-site because Ignition sets it **without a `SameSite` attribute** (Chrome treats that as
  `Lax`), and the websocket handshake token comes from a POST that cross-site pages cannot read (CORS). Whether the
  gateway itself checks the websocket `Origin` could not be shown. Recommendation: serve Perspective over **HTTPS** and
  set an explicit `SameSite=Lax` (or `Strict`) session cookie in the gateway's web server settings or reverse proxy, so
  protection does not depend on a browser default.
- **Framing:** Perspective pages send `X-Frame-Options: SAMEORIGIN`, so another site cannot frame them. As defence in
  depth the components disable setpoint editing, configuration edits and change history inside a frame from another site
  ("Editing is disabled inside a frame from another site."), unless `-Dctg.security.allowCrossOriginFrames=true`.
- **History route:** refuses cross-site requests and has no CORS headers.

## Events are not proof

Any page script can fire a component event with any payload (`fireComponentEvent`), and the actions attached to the
event run. So `onSetpointWrite` and the other events are notifications, not evidence: never grant something in an event
script that the user could not do directly, and do not use events as the audit record. Reconcile with `auditId` against
the audit profile, and treat the id as untrusted input too: accept only a UUID (the profile's filters are `LIKE`
patterns, so `%` would match every record), take the id only from the module's suffix at the end of the record's value
(a String setpoint value can contain `[auditId=…]` text), and require the record's action, tag, user and values to match
the event. [samples/setpoint-log-script.md](samples/setpoint-log-script.md#reconciling-with-the-audit-profile) has a
helper that does all of this.

## Audit

Every write, configuration edit and annotation change that passed validation is recorded in the project's audit profile
(or `ctg.audit.fallbackProfile`) and on the `SimpleTagDisplay.Audit` logger, with the real user, host, project, view,
component and an `auditId`. Writes with an unknown outcome are recorded as UNCERTAIN and again when the provider
answers. `ctg.audit.required=true` refuses writes when the record cannot reach a profile. Security events on the same
logger: `prop-tamper`, `security-key-bound`, `audit-unavailable`, `audit-overflow`. Details:
[Display Template: menu and setpoints](components/display-template/menu-and-setpoints.md#audit-trail-who-changed-what).

## Residual risks

| Risk | Mitigation |
|---|---|
| With `rejectBoundGates=false`, a gate bound to a view parameter is user-controlled: an anonymous user is stopped only by the tag's Write Permissions or by `ctg.write.requireAuthenticated=true` (off by default since 2.0.0), and a logged-in user **without the intended role** can open a faceplate with `editable=true` and write (measured). | keep the default `rejectBoundGates=true`; or set `ctg.write.requiredRoles`; configure gates statically |
| Event payloads are forgeable. | use `auditId` and the audit profile |
| A refusal caused by a gateway floor setting tells the user (anonymous included) the **name** of that setting, for example *... (gateway setting ctg.write.allowedRoots)*, so operators know whom to ask. It never shows the setting's value. | accepted by design; the names are public in these docs |
| `pens` bound to a client-writable source bypasses the read scope; the trend group shares the scope. | bind pens only to trusted sources; separate trend groups |
| Cross-site websocket protection relies on the browser's cookie handling. | HTTPS + explicit `SameSite` |
| Remote tag providers' permission handling is unverified. | `ctg.write.allowedRoots` / `deniedProviders` |
| Custom menu items and event scripts run with the user's rights. | protect the attached actions themselves |
| A script (event, message handler) that copies client input into a security key is adopted like any script. | never build unlock switches with scripts; use roles |
| History point budget under a multi-session flood: the small reserve guarantees a one-pen, one-hour chart (tag up to about 2 samples/s, or aggregated) only among small sessions, shared oldest waiter first. A client that opens many Perspective sessions is many sessions: beyond about 16 small and 3 light sessions in flight at once, a new small session waits behind the ones refused before it (usually one `Retry-After`), and a light session (a denser tag, a longer raw window) is served first come, first served. | authentication; Perspective session limits; `ctg.history.maxInFlightPoints` sized for the expected number of concurrent charts |
| Tag search fairness is per Perspective session: a freed search slot goes to the session that was refused first, and a chart that retypes while another session waits gives its slot back. Many sessions of one client are many waiters, so a client with many sessions can still keep the 4 gateway-wide search slots busy (the gateway itself stays responsive; only searching is slowed). | `tagBrowser.access` roles; authentication; Perspective session limits |
| Annotation ownership compares the identity provider (`session.props.auth.idp`) and the user name. Notes saved in a Designer session record no identity provider, so they belong to every Designer user of that name. The rule fails closed, with two side effects: a note written in the Designer cannot be changed by the same user in a client session (and the reverse), and notes saved by pre-release 2.0.0 builds (no identity provider recorded) are no longer owned by their client-session authors. | annotate from client sessions; moderators only (`ownOnly` plus `moderate`) for shared Designer accounts; give a moderator role to whoever maintains older notes or moves between Designer and client |

## Recommended setup

1. Projects with HMI writes require a login (identity provider) and define roles such as `Operator` and `Engineer`.
2. Setpoints: `setpoint.access.roles: ["Operator"]` (a role implies a login). Tag configuration and moderation:
   `["Engineer"]`; leave `menu.configEdit.access.requireLogin` and `annotations.moderate.access.requireLogin` at
   their default (`true`).
3. Gateway: set `ctg.write.requireAuthenticated=true` (default `false`), keep `ctg.security.rejectBoundGates=true`; set
   `ctg.write.requiredRoles=Operator,Engineer` and `ctg.write.allowedRoots` to your setpoint folders when you can.
4. Give setpoint tags Write Permissions for the same roles: the module's gates and the tag's own rules then agree.
5. Assign an audit profile to every project (or `ctg.audit.fallbackProfile`) and consider `ctg.audit.required=true`.
6. Configure gate props statically (or with `PROTECTED` access); bind only `tagPath` and `trendGroup` to parameters.
7. Charts with a tag browser: set `tagBrowser.rootPath` (or `readScope.allowedRoots`) to the area the screen is about.
8. Serve Perspective over HTTPS with an explicit `SameSite` cookie; never enable `ctg.debug` in production.

<!-- nav:bottom -->

---

← Previous: [Gateway settings](gateway-settings.md) · [Back to index](README.md) · Next: [Working in the Designer](designer.md) →

<!-- /nav:bottom -->
