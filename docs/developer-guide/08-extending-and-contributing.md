<!-- nav:top -->

[Docs home](../README.md) › [Developer Guide](README.md) › **Extending and contributing**

<!-- /nav:top -->

# 08 — Extending and contributing

How to change the module without breaking its contracts. Read [Architecture](01-architecture.md) first.

**On this page**

- [Ground rules](#ground-rules)
- [Adding a prop](#adding-a-prop)
- [Adding a security prop](#adding-a-security-prop)
- [Adding a delegate message](#adding-a-delegate-message)
- [Adding a chart panel](#adding-a-chart-panel)
- [Adding a gateway setting](#adding-a-gateway-setting)
- [Adding an error code](#adding-an-error-code)
- [Changing the history route](#changing-the-history-route)
- [Before you commit](#before-you-commit)
- [Releasing](#releasing)

---

## Ground rules

- **The gateway decides.** Anything that writes, edits, reads tags or changes shared state is checked in Java with the
  user's `SecurityContext`. Browser checks only grey out the UI.
- **Contracts are shared.** Component and module IDs, prop names (the schemas), the message catalogue, error codes,
  `ctg.*` setting names, `ChartApi` and the public CSS classes and tokens are used by views, scripts and stylesheets in
  the field. Add; do not rename or remove without a migration story.
- **Follow the code rules** in [Backend (Java)](03-backend-java.md#rules-for-gateway-code) and
  [JavaScript primer](02-javascript-primer.md#rules-the-code-follows): no `innerHTML`, no empty security
  contexts, no `setInterval` for data, every async continuation checks liveness, client strings sanitised in logs.
- Keep the file style: a header comment per file, `SECTION` banners, comments that explain *why*.

## Adding a prop

Example: a `label.tooltip` string on the Display Template.

1. **Schema**: `common/src/main/resources/schemas/displaytemplate.props.json`. Add the property with `type`,
   `default` and a `description` written for the Designer user. Also add it to the parent object's `default`
   (every object carries the full default of its leaves, `additionalProperties: false` everywhere).
2. **Reducer**: `display-template.js` SECTION 2 (`DT_DEFAULTS`, and a `DT_RULES` entry for enums, ranges or nullable
   numbers). For the chart: the `SPEC` mirror in `ctg-chart.js` SECTION 2.
3. **Use it** in the render code; add a Node test (`tests/js/dt-*.test.mjs` or `chart-*.test.mjs`).
4. **Docs**: `node simple-tag-display/tools/gen-prop-docs.mjs` regenerates the property tables in
   `docs/user-guide/components/<component>/properties.md`. A new **top-level** prop must be added to one of the
   page's `BEGIN GENERATED` blocks (the generator refuses otherwise); explain anything non-obvious in that group's
   intro or on the component's guide pages.
5. **Tests**: `schema-defaults.test.mjs` checks the object defaults, `chart-reducer.test.mjs` checks the chart's key
   set against the schema, `docs-coverage.test.mjs` checks the docs.
6. If the prop replaces a 1.x prop, teach `tools/migrate-v1-views.mjs` the mapping and add a migration test.

## Adding a security prop

A prop that decides who may do something must be read on the gateway:

1. Mark the description with `[S]` (the docs and `SecurityKeysTest` rely on it).
2. Add the path to `SecurityKeys.DISPLAY` or `SecurityKeys.CHART` (gateway). `TrustedProps` then keeps a trusted copy
   and `BindingLint` checks its bindings; if the key may legitimately be bound to a view parameter, it belongs in
   `NON_GATE` (only `tagPath` and `trendGroup` today).
3. Read it in the gate (`ops/DisplayGates`, `ops/ChartOps`) from `cc.props()` (the trusted snapshot), never from the
   message body.
4. Reflect the decision in the snapshot's `capabilities` so the browser can grey the UI, and add the refusal to the
   JUnit gate tests.
5. If the chart's `ChartApi.write` should refuse it, add it to the chart's security key list as well.

## Adding a delegate message

1. **Name** in `common/.../protocol/Protocol.java` (`dt.*`, `chart.*` or `ctg.*`).
2. **Handler** in the delegate's `registerHandlers`:

   ```java
   r.on(Protocol.DT_MY_ACTION, RateClass.MUTATE, cc -> DisplayOps.myAction(cc, host));
   ```

   Pick the rate class: `READ` for queries, `MUTATE` for anything that changes state (also de-duplicated by request
   id), `CONTROL` for protocol housekeeping.
3. **Ops method** (`ops/…`): parse the body with `Json` helpers (bounded strings, explicit types), check the gates from
   `cc.props()` and `cc.user()`, check `expectedTagPath` when the message targets the component's tag, run tag
   operations with the user's context, then `cc.reply(data)` or `cc.fail(ErrorCode.X, details)`. Never put exception
   messages into replies; log them rate-limited.
4. **Client**: a method on the component's delegate class that calls
   `this.request('dt.myAction', body, {timeoutMs})` and handles `{ok, data | error}`. The body keys `v`, `id` and
   `build` are reserved by the envelope.
5. **Audit** anything that changes a tag or shared state (`CtgAudit`).
6. **Tests**: JUnit for the ops logic, a Node test for the client side, and the message name in
   `docs/developer-guide/01-architecture.md` (the docs coverage test checks it).

## Adding a chart panel

Panels use only `ChartApi` ([Frontend JavaScript](04-frontend-javascript.md#chartapi-the-facade-for-panels)), so
they can live in an add-on file. Register with `NS.chart.panels.register(name, {render, dock, button})`, register your
strings with `NS.i18n.register(part, table)`, and write whole-object prop changes with `api.patch(rootKey, fn)`.
Develop and test against `tests/js/_chartApiStub.mjs`. A new add-on file must use the standard bootstrap (part id,
`needs: ['common', 'chart']`) and be added to `SimpleTagDisplayModule.BROWSER_RESOURCES`, to the immutable-resource
list in the gateway hook and to `resource-urls.test.mjs`.

## Adding a gateway setting

1. Add the property to `ModuleSettings` (name `ctg.<area>.<name>`, default, clamping range) and its getter.
2. Read it at the moment of use (`services.settings().get()`), never cache the number; settings reload live.
3. If running components must react, register through `ModuleSettings.onReload` or `SettingsFanOut`.
4. Document it in `docs/user-guide/gateway-settings.md` (the coverage test fails otherwise) and test it in
   `ModuleSettingsTest`.

## Adding an error code

Add it to `ErrorCode` (retryable flag, HTTP status for the route, a short safe default sentence), give it an operator
text in the owning part's `NS.i18n` table, and list it in `docs/user-guide/troubleshooting.md#error-codes` (checked by the docs
coverage test, including the HTTP status). Shared codes get their text in `ctg-common.js`. A code that only one part
answers may keep its text in that part's own table, as `INVALID_TIME` does in `ctg-chart.js` (the text can then use
the part's `details`); list it in `PART_OWNED` in `tests/js/util.test.mjs`, which checks that every code has a text
once all parts are loaded and that a part-owned text is in its part.

## Changing the history route

The route is the only HTTP surface. Keep the validation order (cheap refusals first; nothing is read before the size
check), keep every new field bounded in `BoundedJson`/`HistoryRequest`, keep the response streaming (no Gson trees for
point arrays), and make every new cost count against the admission budgets. Bump `PROTOCOL_VERSION` only for an
incompatible change; old pages then get the reload banner.

## Before you commit

```powershell
.\simple-tag-display\build-and-sign.ps1                          # Java build, JUnit, .modl verification
node --test "simple-tag-display/tests/js/*.test.mjs"             # Node tests (Node 22+), including docs coverage
python -m unittest discover -s simple-tag-display/tests/py -v    # deploy script tests
```

Then deploy to a **test** gateway and try the change in a browser, with a user that has the roles your screens expect
and with one that does not. Check `wrapper.log` for new WARN/ERROR lines from `SimpleTagDisplay.*`.

## Releasing

1. Set `version` in `simple-tag-display/build.gradle.kts` for a release (2.0.1, 2.1.0, ...). Between builds you do not
   need to bump it: the resource version is a content hash.
2. Build and sign with the release certificate ([Signing](07-signing.md)).
3. Update the docs: the pages the change affects, and [Known limitations](../user-guide/known-limitations.md) when
   a limitation is added or lifted. Reference the GitHub issues the release resolves.
4. Tag the commit (`v2.0.0`) and attach `Tag-Display.modl` to a GitHub release with short notes (what changed, upgrade
   steps, known limitations).

<!-- nav:bottom -->

---

← Previous: [Signing](07-signing.md) · [Back to index](README.md)

<!-- /nav:bottom -->
