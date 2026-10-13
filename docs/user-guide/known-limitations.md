<!-- nav:top -->

[Docs home](../README.md) › [User Guide](README.md) › **Known limitations**

<!-- /nav:top -->

# Known limitations

What version 2.0.0 does not do, what has not been tested, and the deliberate behaviours that may surprise you. Each
entry says what the limitation is, what it means for your project, and what you can do about it. Read this page before
you put the module on a production gateway.

**On this page**

- [Test coverage](#test-coverage)
- [Platforms and clients](#platforms-and-clients)
- [Display Template](#display-template)
- [Click To Graph Chart](#click-to-graph-chart)
- [Performance and gateway load](#performance-and-gateway-load)
- [Security behaviour by design](#security-behaviour-by-design)
- [Signing](#signing)
- [Reporting a limitation](#reporting-a-limitation)

---

## Test coverage

| Limitation | Impact | What to do |
|---|---|---|
| **Historian providers.** Every history, aggregation and annotation test ran against the 8.3 built-in **Core Historian**. The **SQL Historian** and third-party historian providers have not been tested. | Query results, aggregation, raw sample density and annotation support can differ on other providers. A provider without annotation support is detected at runtime: the chart shows *This historian does not support annotations*. | Test the chart against your historian on a test gateway first, with the aggregation modes, raw ranges and chunked loading you plan to use. |
| **Release verification.** 2.0.0 was released after its automated unit tests (JUnit, Node and Python) and a focused set of live browser checks on the release build. The complete live browser regression, including the security and load tests, ran on an earlier 2.0.0 build; the features added after it were verified by their own live tests. | A late regression that the unit tests and the focused checks did not cover is possible. | Treat the first installation as a pilot: install on a test gateway, open your real views, and exercise writes, menus and charts before production. |
| **Long-running operation.** Continuous operation was measured for 2 hours (two users, each with 60 displays and 2 realtime charts): gateway heap, threads and browser memory stayed flat. Longer runs have not been measured. | Slow resource growth that shows only after many hours would not have been detected. | Watch the gateway's heap and thread count during the first days in production. |
| **Designer preview.** Design mode and preview mode are covered by automated render tests and a browser emulation of the Designer, not by hand in the 8.3 Designer itself. | Small differences between the Designer and a client session are possible. | Run the [manual checklist](designer.md#manual-checklist) once on your Designer version. |
| **Rare timing cases.** A few fixes for very short race windows (for example a module restart while a write waits for its tag provider, or an audit profile query that times out) are covered by unit tests only and were not reproduced on a live gateway. | None expected. Listed for completeness. | None. |

## Platforms and clients

| Limitation | Impact | What to do |
|---|---|---|
| **Ignition 8.3 only.** The module needs Ignition 8.3.1 or newer with Perspective (developed and tested on 8.3.10). Ignition 8.1 is not supported. | The module does not run on 8.1 or earlier 8.x releases. | Upgrade the gateway to 8.3. |
| **Browsers and clients.** Automated browser tests run on current Chrome only. Edge, Firefox, Safari, Perspective Workstation, the Perspective mobile app and iPad have not been checked by hand. | They are expected to work (the components use standard DOM and Canvas APIs only), but touch gestures, the long-press menu, on-screen keyboards, native date pickers, downloads and fullscreen differ between clients. | Try your screens on every client type you deploy to before production. |
| **Remote (Gateway Network) tag providers.** Permission handling for tags on remote providers has not been verified. | Whether a remote provider enforces the requesting user's Read and Write Permissions is unknown. | Until you have checked it on your system, keep writes away from remote providers with `ctg.write.allowedRoots` or `ctg.write.deniedProviders`, and limit chart reads with `ctg.read.deniedProviders` or `readScope.allowedRoots`. See [Tag permissions](security-and-permissions.md#tag-permissions). |
| **Export in the Perspective mobile app.** The app cannot save browser downloads, so the chart hides CSV and PNG export there. In the Designer and in Workstation a download may open in a new window instead of being saved. | Operators on the mobile app cannot export. | Export from a browser or Workstation session. See [Export](components/ctg-chart/panels-and-tools.md#export). |
| **Narrow settings sheet without CSS `:has()`.** The chart's narrow layout uses the `:has()` selector to hide a duplicate *Back* button. | In a web view without `:has()` support, the narrow settings sheet shows two *Back* buttons. Nothing else is affected. | None needed; the difference is cosmetic. |
| **Chart gestures at a Designer canvas zoom other than 100 %.** The chart maps the pointer with the element's on-screen rectangle, which the Designer's canvas zoom scales. | In Designer preview mode at another zoom level, the X-Trace cursor and drag boxes may be offset from the pointer. Design mode has no gestures, and client sessions are not affected. | Preview chart gestures at 100 % canvas zoom, or in a client session. |

## Display Template

| Limitation | Impact | What to do |
|---|---|---|
| **Long and multi-line String setpoints.** A String value longer than 4096 characters, or one that contains line breaks, cannot be edited in the display; the display says why (*This value is too long to edit here*). | Only the first 4096 characters reach the browser, and the single-line editors would drop line breaks, so an edit would silently cut the value. The display refuses instead. | Write such values from a script (`system.tag.writeBlocking`) or the tag editor. |
| **No blink with `alarms.basis: "active"`.** With the `"active"` basis only active alarms colour the value, and the display never blinks. | The gateway reports the highest active and the highest unacknowledged priority separately, so the display cannot tell whether the active alarm itself is unacknowledged. | Use the default basis, `"activeOrUnacked"`, when operators need the unacknowledged blink. See [Alarm colours](components/display-template/README.md#alarm-colours-alarms-is-there-an-alarm). |
| **Change History queries run to the end.** When the operator closes the dialog or the request times out, the display stops waiting and queued queries are cancelled, but a query that already runs on the gateway is not interrupted (its result is discarded). | A slow audit profile can keep working on a query nobody is waiting for. Each session may run 2 Change History queries at a time. | Keep the audit profile's database responsive and `menu.changeHistory.limit` modest. |
| **Views with 1.x props are flagged in the Designer and the browser only.** A view that still holds 1.x props shows a *v1 props* badge in the Designer and a warning in the browser console; the gateway writes no log line for it. | An unmigrated view on a production gateway can go unnoticed until someone opens it. | Run the migration script over every project during the upgrade; its dry run lists every view that still needs it. See [Running the migration script](upgrading-from-v1.md#running-the-migration-script). |

## Click To Graph Chart

| Limitation | Impact | What to do |
|---|---|---|
| **No scripting functions.** The chart has no `system.*`-style scripting functions. | A script cannot, for example, add a pen or start an export with a function call. | Drive the chart through its props (`pens`, `timeRange`, ...), and react to its [events](components/ctg-chart/events.md) and [outputs](components/ctg-chart/README.md#outputs-for-bindings-and-scripts). |
| **Trend lists are not persisted.** The session trend list (tags added with **Trend Tag** or the tag browser) is held in gateway memory per Perspective session and `trendGroup`. | The list is cleared when the session ends, when the user logs out or changes, and when the gateway restarts. | Put pens that must always be shown in the chart's `pens` prop. See [Where pens come from](components/ctg-chart/README.md#where-pens-come-from). |
| **Trend pen defaults win over some overrides.** While `trendPens.defaults.axis`, `.plot` or `.display` is set, a trend pen cannot be put back on the automatic axis, the first plot or the built-in line style. | The Settings pen editor greys those choices out and says why. | Change `trendPens.defaults` instead. |
| **Aggregation buckets are aligned to UTC.** The bucket grid is anchored at the UTC epoch, not at the chart's time zone. | 1-day buckets start at 00:00 UTC, not at local midnight, so per-day aggregates (`DurationOn`, `CountOn`) outside UTC split each local day across two buckets. | Use raw data or shorter buckets for per-local-day figures, or compute them in a report or script. See [History queries](components/ctg-chart/pens-axes-plots.md#history-queries-aggregation-caps-and-chunked-loading). |
| **At most 64 charts with history per session.** | The 65th chart shows *History paused: this session already runs the maximum number of charts with history*. It retries after 2, 4, 8 ... 60 s, so it can take up to a minute to start after another chart closes. | Keep the number of charts per session well below the limit; every embedded view that holds a chart counts. |
| **Long bad-quality stretches on aggregated realtime charts.** To keep a stretch of bad-quality data drawn as bad, realtime refreshes re-read it from its start for up to 10 minutes or 20 buckets after it began, whichever is longer. | A bad stretch that keeps growing beyond that may be drawn as a line across the gap until the next full load. | Click **Refresh** or change the date range: a full load draws it correctly. |
| **Range selector on first load.** Occasionally the overview strip's first request is answered before the chart's pens are ready. | The strip may show no data until its next refresh. | None needed; the strip fills in on its next refresh. |
| **Tag search bounds are fixed.** The *Search all folders* bounds (16 folder levels, 50 000 entries looked at, 5 000 folder pages, 1 000 matches, 5 s; one running search per session and 4 per gateway) are built in and cannot be changed with a gateway setting. | In very large tag trees a broad search stops at a bound and asks for a narrower one. | Type a more specific text or wildcard path, or set `tagBrowser.rootPath` to the relevant subtree. See [Search all folders](components/ctg-chart/panels-and-tools.md#search-all-folders). |
| **`ctg.read.deniedProviders` applies to every pen.** The denied providers (`System` by default) apply to the history of pens configured in the Designer too, not only to pens users add at runtime. | A chart cannot show `[System]` tags, even as a configured pen. | Remove `System` from `ctg.read.deniedProviders` if you need it ([Gateway settings](gateway-settings.md)). |
| **`enabled: false` keeps viewing actions.** It turns off everything that changes the chart's configuration, but zoom, pan, X-Trace, the range brush, the date range and export still work. | Users of a disabled chart can still export its data. | Also turn off `toolbar.buttons.export` (or `export.csv.enabled` / `export.png.enabled`) when export must be blocked. See [What `enabled: false` turns off](components/ctg-chart/panels-and-tools.md#what-enabled-false-turns-off). |
| **Annotations.** Annotations were verified on the Core Historian only. A note cannot be moved to another pen, and a range that started more than one window length before the visible window is not shown. | See the rows above for other historians. | See [Annotations](components/ctg-chart/panels-and-tools.md#annotations). |

## Performance and gateway load

| Limitation | Impact | What to do |
|---|---|---|
| **Many pens over a long realtime window.** An 8-pen realtime chart refreshing every second over an 8-hour window took about 100 to 150 ms per refresh on the Core Historian. Almost all of that is the historian answering the query; the browser's part is under 10 ms. | Many such charts add up on the historian. | Raise `timeRange.refreshRate`, shorten the realtime window, or spread the pens over more focused charts. |
| **The range selector shares the page's history queue.** The overview strip loads at the lowest priority, but its requests and the plots' realtime refreshes go through the same per-session queue on the gateway. | The first read of a long range (about 1 s for 30 days on a cold historian) can delay the page's realtime refreshes once per strip refresh. | Leave `rangeSelector.visible` off on pages where refresh latency matters, or keep their realtime window moderate. See [Range selector](components/ctg-chart/interaction.md#range-selector-overview-strip). |
| **First heavy history load after a gateway restart.** The first heavy load after a restart is slower and leaves the gateway heap about 100 to 150 MB larger, and that memory stays. Most of it is the Core Historian warming up its query engine; the rest is the module's bounded caches (`ctg.history.cacheMb`). It happens once per restart. | Higher latency right after a restart; a permanent heap step. | Size the gateway heap with this headroom. See [The history point budget](gateway-settings.md#the-history-point-budget). |

## Security behaviour by design

These follow from the platform or are deliberate choices. The complete list, with mitigations, is under
[Residual risks](security-and-permissions.md#residual-risks).

| Behaviour | Impact | What to do |
|---|---|---|
| **Anonymous users can read `[System]` tags in a display.** This is the platform's provider permission. The module still refuses writes to `[System]` and keeps it out of charts. | A Display Template pointed at a `[System]` tag shows its value to anonymous sessions. | Do not put `[System]` tags on screens that anonymous users can open, or require a login for the project. |
| **Refusals name the gateway setting.** A refusal caused by a gateway setting tells the user (anonymous included) the setting's name, never its value. | The setting names are visible to operators. | None needed; this lets operators know whom to ask. The names are public in these docs. |
| **Event payloads can be forged.** A modified browser can send a component event that never happened, and a gateway event script still runs (platform behaviour). | A script that trusts an event payload can be misled. | Check the event's `auditId` against the audit profile. See [Events are not proof](security-and-permissions.md#events-are-not-proof). |
| **Scripts are trusted.** A script that copies user input into a security prop is trusted like any other script; the gateway cannot tell such scripts apart. | A script can unlock what the security props were meant to lock. | Never build unlock switches with scripts; use roles. |
| **Session cookie without `SameSite`.** Ignition sets its session cookie without a `SameSite` attribute, so cross-site websocket protection relies on the browser's cookie handling. | Older or unusual browsers may send the cookie cross-site. | Serve Perspective over HTTPS with an explicit `SameSite` cookie. See [Cross-site requests](security-and-permissions.md#cross-site-requests-websockets-and-framing). |

## Signing

| Limitation | Impact | What to do |
|---|---|---|
| **The release is signed with the development certificate.** The published `.modl` is signed with the repository's public, self-signed development certificate, which expires on **2027-01-07**. | Anyone with the repository can sign with this key, so the signature does not prove who built the module. It is fine for test gateways, not for production. | Sign production builds with your own certificate. See [The development certificate](../developer-guide/07-signing.md#the-development-certificate). |
| **The purchased-certificate steps have not been tried.** The documented steps for a code-signing certificate from a public certificate authority (hardware token, PKCS#11) have not yet been tried with a real certificate. | The steps may need small adjustments for your certificate authority. | Follow [Signing with a purchased certificate](../developer-guide/07-signing.md#signing-with-a-purchased-certificate) and check the result on a test gateway. |

## Reporting a limitation

Found something that is not listed here, or a limitation that blocks your project? Open an issue on the project's
GitHub repository. Include the Ignition version, the historian provider, the client (browser, Workstation, mobile app)
and, if you can, the related gateway log lines (see [Gateway log lines](troubleshooting.md#gateway-log-lines)).

<!-- nav:bottom -->

---

← Previous: [Troubleshooting](troubleshooting.md) · [Back to index](README.md) · Next: [FAQ](faq.md) →

<!-- /nav:bottom -->
