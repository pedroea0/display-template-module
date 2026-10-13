// =============================================================================
// _stubs.mjs — browser/Perspective stub environment for Node tests
// =============================================================================
// Loads the module's mounted JS files into an isolated node:vm context that
// imitates just enough of a Perspective page:
//   window / document (currentScript, head, getElementById, createElement)
//   window.PerspectiveClient: Component, ComponentRegistry (first-wins, like
//     the real one), ComponentStoreDelegate (records fireEvent calls)
//   window.React.createElement (returns plain {type, props, children} nodes)
//   window.__client (connection + state) and a minimal window.mobx.reaction
//
// Tests EXTEND an environment through the factory's options or by adding to
// the returned objects; they never edit this file for one test's needs.
//
//   const env = createEnv();
//   env.load('ctg-common.js', '2.0.0-aaaa0000');
//   env.window.__CTG.ready.common === true
// =============================================================================
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const JS_DIR = path.resolve(here, '..', '..', 'gateway', 'src', 'main', 'resources', 'mounted', 'js');
export const FILES = ['ctg-common.js', 'display-template.js', 'ctg-chart.js', 'ctg-chart-tools.js', 'ctg-chart-panels.js'];

/**
 * @param {object} [opts]
 * @param {boolean} [opts.connected=true] initial Perspective connection state
 * @returns {{window, registered: object[], warnings: any[][], errors: any[][], load(file, v?), setConnected(b), timers}}
 */
export function createEnv(opts = {}) {
  const registered = [];
  const warnings = [];
  const errors = [];
  const fired = [];

  // ---- minimal mobx: reactions re-run on every setConnected() ---------------
  const reactions = [];
  const mobx = {
    reaction(expr, effect) {
      let last = JSON.stringify(expr());
      const r = () => { const v = JSON.stringify(expr()); if (v !== last) { last = v; effect(); } };
      reactions.push(r);
      return () => { const i = reactions.indexOf(r); if (i >= 0) reactions.splice(i, 1); };
    },
  };
  const client = {
    connection: { connected: opts.connected !== false },
    state: { state: opts.connected === false ? 'RUNNING_DISCONNECTED' : 'RUNNING_CONNECTED' },
  };

  class ComponentStoreDelegate {
    constructor(store) {
      this.component = store;
      this._subs = [];
      this.subscribe = fn => { this._subs.push(fn); return () => { this._subs = this._subs.filter(f => f !== fn); }; };
      this.notify = () => { this._subs.slice().forEach(f => f()); };
    }
    mapStateToProps() { return {}; }
    fireEvent(name, payload) { fired.push({ store: this.component, name, payload }); }
  }
  const ComponentRegistry = {
    _m: new Map(),
    register(meta) {
      const t = meta.getComponentType();
      if (!this._m.has(t)) { this._m.set(t, meta); registered.push(t); }
    },
    getMeta(t) { return this._m.get(t); },
  };
  class Component { constructor(props) { this.props = props; } }

  const styles = new Map();
  const document = {
    currentScript: null,
    head: { appendChild(el) { styles.set(el.id, el); } },
    getElementById: id => styles.get(id) || null,
    createElement: tag => ({ tag, id: '', attrs: {}, textContent: '', setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k] ?? null; } }),
  };

  const consoleStub = {
    log() {}, info() {}, debug() {},
    warn: (...a) => warnings.push(a),
    error: (...a) => errors.push(a),
  };

  const window = {
    PerspectiveClient: { Component, ComponentRegistry, ComponentStoreDelegate },
    React: { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) },
    mobx,
    __client: client,
    localStorage: { getItem: () => null },
  };
  const context = vm.createContext({
    window, document, console: consoleStub, location: { href: 'http://localhost:8088/data/perspective/client/X' },
    URL, setTimeout, clearTimeout, setInterval, clearInterval, Promise, Map, Set, JSON, Math, Date, Object, Array,
  });
  window.window = window;

  return {
    window: context.window,
    context,
    registered,
    warnings,
    errors,
    fired,
    styles,
    /** Loads one mounted file as if Perspective injected it with ?v=<v>. */
    load(file, v = '2.0.0-test0000') {
      document.currentScript = { src: `http://localhost:8088/res/simpletagdisplay/js/${file}?v=${v}` };
      vm.runInContext(readFileSync(path.join(JS_DIR, file), 'utf8'), context, { filename: file });
      document.currentScript = null;
    },
    /** Flips the Perspective connection and runs the mobx reactions. */
    setConnected(connected) {
      client.connection.connected = connected;
      client.state.state = connected ? 'RUNNING_CONNECTED' : 'RUNNING_DISCONNECTED';
      reactions.slice().forEach(r => r());
    },
  };
}

/** All permutations of an array (small arrays only). */
export function permutations(arr) {
  if (arr.length <= 1) return [arr.slice()];
  const out = [];
  arr.forEach((x, i) => {
    for (const p of permutations([...arr.slice(0, i), ...arr.slice(i + 1)])) out.push([x, ...p]);
  });
  return out;
}
