<!-- nav:top -->

[Docs home](../README.md) › [Developer Guide](README.md) › **JavaScript primer**

<!-- /nav:top -->

# 02 — JavaScript primer

For Ignition engineers who are comfortable with Python and Java but not with browser JavaScript. It explains the
patterns you meet in the five module files under `simple-tag-display/gateway/src/main/resources/mounted/js/`. The file
tour is in [Frontend JavaScript](04-frontend-javascript.md).

**On this page**

- [No build step, no JSX](#no-build-step-no-jsx)
- [One global: `window.__CTG`](#one-global-window__ctg)
- [Load order does not matter: the part queue](#load-order-does-not-matter-the-part-queue)
- [How a Perspective component is declared](#how-a-perspective-component-is-declared)
- [React without JSX](#react-without-jsx)
- [Props, the reducer and prop writes](#props-the-reducer-and-prop-writes)
- [The delegate: talking to the gateway](#the-delegate-talking-to-the-gateway)
- [Promises and `async`](#promises-and-async)
- [Rules the code follows](#rules-the-code-follows)
- [Debugging in the browser](#debugging-in-the-browser)

---

## No build step, no JSX

The files are served to the browser exactly as they are in the repository. There is no bundler, no TypeScript and no
JSX, so what you read is what runs. The price is some verbosity (`h('div', {...}, child)` instead of `<div>`). The
language level is ES2017+ (classes, arrow functions, `const`/`let` inside functions, template literals), which every
browser Perspective supports.

## One global: `window.__CTG`

Every file is wrapped in an **IIFE** (immediately invoked function expression):

```js
(function () {
  'use strict';
  var NS = window.__CTG = window.__CTG || {};
  // ... everything else is local to this function ...
})();
```

Nothing leaks into the page except `window.__CTG` (called `NS`, "namespace", in the code). Shared code hangs off it:
`NS.util`, `NS.format`, `NS.ui`, `NS.dt`, `NS.chart`, ... A `class` or `const` at the top level of a classic script would
be a page-wide name, and a second copy of the file (old and new version on one page after an upgrade) would crash with
"Identifier has already been declared". The IIFE avoids that.

Each file also records its **part id** and build: `NS.loaded.display = '2.0.0-ecf4cbc1'`. If the same part is loaded a
second time with another build, the second copy only logs `[CTG] display ... ignored; page runs ... - reload` and does
nothing.

## Load order does not matter: the part queue

Perspective injects the five scripts in an order it chooses. So no file runs its real code at load time; it queues an
initialiser:

```js
NS._queue.push({ part: 'display', needs: ['common'], init: function (NS) {
  // define NS.dt, register strings, register the component
}});
if (NS._drain) NS._drain();
```

`NS._drain()` (defined in `ctg-common.js`) runs every queued `init` whose `needs` are all ready, marks the part ready
(`NS.ready.display = true`) and repeats until nothing more can run. A part that arrives before its dependencies simply
waits. An `init` that throws is logged and marked failed; the other parts keep working.

| Part id | File | Needs |
|---|---|---|
| `common` | `ctg-common.js` | – |
| `display` | `display-template.js` | `common` |
| `chart` | `ctg-chart.js` | `common` |
| `chartTools` | `ctg-chart-tools.js` | `common`, `chart` |
| `chartPanels` | `ctg-chart-panels.js` | `common`, `chart` |

## How a Perspective component is declared

Perspective's browser runtime is `window.PerspectiveClient`. A component is a **meta** object registered with
`ComponentRegistry`:

```js
class DisplayTemplateMeta {
  getComponentType() { return 'com.example.simpletagdisplay.SimpleTagDisplay'; }  // must match the Java descriptor
  getViewComponent() { return DisplayTemplate; }          // the React component class
  getDefaultSize()   { return { width: 160, height: 64 }; }
  createDelegate(store) { return new DisplayTemplateDelegate(store); }   // browser half of the channel
  getPropsReducer(tree) { return reduce(tree); }          // raw prop tree -> plain object
}
NS.registerComponent(new DisplayTemplateMeta());          // guarded ComponentRegistry.register
```

The view component is a React class component (`class DisplayTemplate extends PerspectiveClient.Component`). React
calls `render()` whenever props or state change; `componentDidMount` / `componentWillUnmount` set up and tear down
listeners. Perspective passes `this.props.props` (the reduced props), `this.props.store` (the component store, with
`delegate`), `this.props.emit()` (root element attributes: position, style, classes, events) and `this.props.eventsEnabled`
(false in the Designer's design mode).

## React without JSX

`h` is React's `createElement`:

```js
var h = React.createElement;
return h('div', this.props.emit({ classes: ['dt-root'] }),
  h('div', { className: 'dt-label' }, label),
  h('div', { className: 'dt-value', title: fullText }, valueText));
```

Text is always passed as a child, so React escapes it: a tag value or a label can never inject HTML. Icons are SVG built
the same way (`h('svg', ..., h('path', {d: '...'}))`).

## Props, the reducer and prop writes

The prop tree Perspective holds is raw JSON as stored in the view (missing keys, wrong types, bindings that returned
strange values). Each component's **props reducer** turns it into a frozen plain object with every key present: defaults
filled in from the schema defaults, numbers clamped, enums checked, dates turned into epoch ms. The rest of the code only
reads the reduced object, so it never needs `if (props.setpoint && props.setpoint.limits && ...)`.

Writes go the other way: `store.props.write('timeRange', wholeObject)`. The chart writes whole objects (never a nested key
whose parent might be missing, which throws in Perspective) and tags its own writes so their echo does not trigger a
reload. Writes from the browser to **[S]** props are pointless: the gateway reverts them.

## The delegate: talking to the gateway

`NS.delegate.CtgDelegateBase` (in `ctg-common.js`) extends Perspective's `ComponentStoreDelegate` and implements the
protocol from [Architecture](01-architecture.md#the-component-channel-delegates): hello and resync, epochs and
sequence numbers, the gateway clock, timeouts and the page watchdog. Components subclass it:

```js
class DisplayTemplateDelegate extends NS.delegate.CtgDelegateBase {
  onMessage(name, payload) { /* dt.snapshot, dt.values -> this.snap; this.changed() */ }
  write(expectedTagPath, value, ui) {
    return this.request('dt.write', { expectedTagPath: expectedTagPath, value: value, ui: ui }, { timeoutMs: 15000 });
  }
}
```

`request()` **never rejects**: it resolves `{ok: true, data}` or `{ok: false, error: {code, message, ...}}`, including the
client-side codes `CLIENT_TIMEOUT`, `DISCONNECTED` and `DETACHED`. The component re-renders when the delegate calls
`changed()`.

## Promises and `async`

A `Promise` is a value that arrives later, like a Java `CompletableFuture`. `await p` (inside an `async` function) waits
for it without blocking the page. Because the user may close the view while a request runs, every continuation checks
that the component is still mounted before it touches state:

```js
const r = await this.delegate.write(path, value, 'popup');
if (!this._mounted) return;          // the view went away meanwhile
this.setState({ busy: false, error: r.ok ? null : r.error });
```

## Rules the code follows

- No `innerHTML`, `outerHTML` or `insertAdjacentHTML`: text goes in as React children or `textContent`.
- No `setInterval` for data: the chart schedules each refresh with `setTimeout` after the previous one finished.
- Colours from props reach CSS only through style objects after `CSS.supports('color', v)`.
- The built-in stylesheet is injected once per page (`NS.theme.ensureStyles(id, css, build)`), every rule wrapped in
  `:where(...)` so it has zero specificity.
- Every user-visible string is registered per part with `NS.i18n.register(part, table)` and read with `NS.i18n.t(key)`.

## Debugging in the browser

Open the browser's developer tools on a Perspective session:

```js
window.__CTG.loaded                        // which parts and builds are on the page
localStorage['ctg.debug'] = '1'            // enable debug logging (reload); history tokens stay redacted
delete localStorage['ctg.debug']           // and off again
```

Each component root carries data attributes for inspection: a Display Template's value element has the live state in
its classes (`dt--q-bad`, `dt--alarm-high`, ...); a chart root has `data-ctg-state` (`live`, `paused`, `stale`, ...).

<!-- nav:bottom -->

---

← Previous: [Architecture](01-architecture.md) · [Back to index](README.md) · Next: [Backend (Java)](03-backend-java.md) →

<!-- /nav:bottom -->
