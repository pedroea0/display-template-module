// =============================================================================
// chart-panels-raw-patch.test.mjs — ctg-chart-panels.js: raw-value patches, draft flushes and editor identity
// =============================================================================
// Regression tests:
//   - settings edits and the tag browser's pens target write with
//     ChartApi.patch on the RAW root (unknown keys kept, no defaults / clamps
//     of untouched items persisted), incl. axis rename and plot removal
//   - DraftStore onFlush gets `attempted`: an edit changed and reverted inside
//     the debounce leaves no stale onPensChange 'edit'
//   - the plot editor follows its plot by identity (another writer's removal
//     of an earlier plot), and says so when its plot is gone
//   - a tag-path edit moves the editor's identity only once the write is made
//   - the tag browser's identity includes the session user
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChartApiStub } from './_chartApiStub.mjs';

const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const deq = (a, b, m) => assert.deepEqual(J(a), J(b), m);
const T = '[default]CTG/';

function stub(fixture) {
  const s = createChartApiStub(fixture);
  const Comp = s.env.window.PerspectiveClient.Component;
  Comp.prototype.setState = function (patch, cb) {
    this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch);
    if (cb) cb();
  };
  Comp.prototype.forceUpdate = function () {};
  return Object.assign(s, { P: s.NS.chartPanels });
}
function full(node) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(full);
  if (typeof node.type === 'function') {
    const kids = node.children || [];
    const props = Object.assign({}, node.props, kids.length ? { children: kids.length === 1 ? kids[0] : kids } : {});
    if (node.type.prototype && node.type.prototype.render) {
      const inst = new node.type(props);
      inst.props = props;
      if (!inst.state) inst.state = {};
      return full(inst.render());
    }
    return full(node.type(props));
  }
  const out = { type: node.type, props: Object.assign({}, node.props), children: full(node.children || []) };
  if (node.props && node.props.children !== undefined) out.props.children = full(node.props.children);
  return out;
}
function find(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; }
  if (node.props && pred(node)) out.push(node);
  if (node.children) find(node.children, pred, out);
  if (node.props && node.props.children) find(node.props.children, pred, out);
  return out;
}
const byAttr = (tree, k, v) => find(tree, (n) => n.props[k] === v);
const text = (n) => (n == null || n === false ? '' : typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(text).join('')
  : (n.children ? text(n.children) : '') + (n.props && n.props.children ? text(n.props.children) : ''));
const ev = () => ({ preventDefault() {}, stopPropagation() {},
  currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20 }), querySelector: () => null } });
const field = (tree, name) => byAttr(tree, 'data-ctg-field', name)[0];
function settings(fixture = {}, args = { source: 'toolbar' }) {
  const s = stub(Object.assign({ props: { pens: [{ tagPath: T + 'Temp' }, { tagPath: T + 'Pressure' }] } }, fixture));
  const sp = new s.P.SettingsPanel({ api: s.api, args, close: () => {} });
  sp.componentDidMount();
  return Object.assign(s, { sp, view: () => full(sp.render()) });
}
/** Another writer (a binding, the pen table, a script) replaces a root: through the stub's write (raw + reduce). */
const other = (s, k, v) => s.api.write(k, v);

// ---- raw patches ---------------------------------------------------------------------------------------------------------
test('a settings field edit patches the raw pens — other pens and unknown keys stay exactly as stored', async () => {
  const s = settings({ props: { pens: [{ tagPath: T + 'Temp', mine: 1 }, 'junk', { tagPath: T + 'Pressure', display: { width: 20 } }] } });
  byAttr(s.view(), 'data-ctg-act', 'edit-pen')[0].props.onClick(ev());
  field(s.view(), 'name').props.onChange({ target: { value: 'T1' } });
  s.sp.drafts.flush();
  const w = s.writes.pop();
  assert.equal(w.patch, true);
  deq(w.value, [{ tagPath: T + 'Temp', mine: 1, name: 'T1' }, 'junk', { tagPath: T + 'Pressure', display: { width: 20 } }],
    'old: every pen rewritten in the reducer shape, width clamped to 8, "junk" and "mine" dropped');
});

test('move / add / delete, axis rename and plot removal are raw patches by identity', async () => {
  const s = settings({ props: {
    pens: [{ tagPath: T + 'Temp', axis: 'Left', plot: 1, x: 1 }, 'junk', { tagPath: T + 'Pressure', x: 2 }],
    axes: [{ name: 'Left', custom: true }],
    plots: [{ relativeWeight: 1 }, { relativeWeight: 2, markers: [{ axis: 'Left', value: 5, tag: 'm' }] }],
    trendPens: { overrides: [{ tagPath: T + 'Counter', axis: 'Left' }] } } });
  // reorder: Pressure up (raw entries move; 'junk' stays where it was relative)
  byAttr(s.view(), 'data-ctg-act', 'up')[1].props.onClick(ev());
  deq(s.writes.pop().value, [{ tagPath: T + 'Pressure', x: 2 }, { tagPath: T + 'Temp', axis: 'Left', plot: 1, x: 1 }, 'junk'],
    'Pressure moved to the raw position of Temp; every entry kept exactly');
  // add
  s.sp.setState({ addText: T + 'SmallRange' });
  s.sp._addPen();
  const added = s.writes.pop().value;
  assert.equal(added.length, 4);
  deq(added.slice(0, 3), [{ tagPath: T + 'Pressure', x: 2 }, { tagPath: T + 'Temp', axis: 'Left', plot: 1, x: 1 }, 'junk']);
  // axis rename: every reference, nothing else
  s.sp.setState({ tab: 'axes', view: 'axis', axis: 0, axisName: 'Left' });
  const nm = field(s.view(), 'axisName');
  nm.props.onChange({ target: { value: 'Main' } });
  nm.props.onBlur && nm.props.onBlur({ target: { value: 'Main' } });
  if (!s.writes.some((x) => x.key === 'axes')) nm.props.onKeyDown && nm.props.onKeyDown({ key: 'Enter', preventDefault() {}, target: { value: 'Main' } });
  const byKey = (k) => s.writes.filter((x) => x.key === k).pop();
  deq(byKey('axes').value, [{ name: 'Main', custom: true }]);
  assert.equal(byKey('pens').value[1].axis, 'Main');
  assert.equal(byKey('pens').value[1].x, 1);
  assert.equal(byKey('pens').value[2], 'junk');
  deq(byKey('plots').value[1].markers, [{ axis: 'Main', value: 5, tag: 'm' }]);
  deq(byKey('trendPens').value, { overrides: [{ tagPath: T + 'Counter', axis: 'Main' }] });
  // remove plot 1 (Temp on it -> plot 0); the remaining plot keeps exactly its raw value
  s.writes.length = 0;
  s.sp.setState({ tab: 'plots', view: 'plot', plotRef: s.P.plotRefOf(s.api.props().plots, 1) });
  byAttr(s.view(), 'data-ctg-act', 'remove-plot')[0].props.onClick(ev());
  s.sp.state.confirm.onConfirm();
  deq(byKey('plots').value, [{ relativeWeight: 1 }]);
  assert.equal(byKey('pens').value[1].plot, 0);
});

test('the tag browser pens target appends to the raw pens (existing pens untouched)', async () => {
  const s = stub({ props: { tagBrowser: { enabled: true, addTo: 'pens' }, pens: [{ tagPath: T + 'Temp', mine: 1 }] }, penInfos: [],
    capabilities: { readScope: { runtimePensAllowed: true, roots: ['[default]CTG'] } },
    handlers: { 'chart.browse': () => ({ ok: true, data: { path: '', continuation: null, results: [
      { name: 'Pressure', path: T + 'Pressure', type: 'AtomicTag', dataType: 'Float8', hasChildren: false, trendable: true }] } }) } });
  const tb = new s.P.TagBrowser({ api: s.api, args: {}, close: () => {} });
  tb.componentDidMount();
  await flush();
  const row = byAttr(full(tb.render()), 'role', 'treeitem').find((r) => r.props['data-ctg-path'] === T + 'Pressure');
  row.props.onClick(ev());
  tb._add();
  const w = s.writes.pop();
  assert.equal(w.patch, true);
  deq(w.value[0], { tagPath: T + 'Temp', mine: 1 }, 'old: rewritten in the reducer shape, "mine" dropped');
  assert.equal(w.value[1].tagPath, T + 'Pressure');
});

// ---- draft flushes and editor identity -----------------------------------------------------------------------------------
test('onFlush gets `attempted`: a change reverted inside the debounce leaves no stale "edit" for a later write', async () => {
  const s = settings();
  byAttr(s.view(), 'data-ctg-act', 'edit-pen')[0].props.onClick(ev());     // Temp
  const vis = () => field(s.view(), 'visible');
  vis().props.onChange({ target: { checked: false } });
  vis().props.onChange({ target: { checked: true } });                      // reverted inside the debounce
  s.sp.drafts.flush();
  assert.equal(s.writes.length, 0, 'nothing to write');
  assert.equal(s.events.length, 0);
  // a later, unrelated edit of Pressure fires ONLY Pressure's edit (old: [edit Temp, edit Pressure])
  s.sp.setState({ view: 'list', sel: null });
  byAttr(s.view(), 'data-ctg-act', 'edit-pen')[1].props.onClick(ev());     // Pressure
  field(s.view(), 'name').props.onChange({ target: { value: 'P1' } });
  s.sp.drafts.flush();
  deq(s.events.map((e) => [e.payload.action, e.payload.tagPath]), [['edit', T + 'Pressure']]);
});

test('the plot editor follows its plot by identity; a removed plot is reported, not edited', async () => {
  const s = settings({ props: { pens: [{ tagPath: T + 'Temp' }], plots: [{ relativeWeight: 1 }, { relativeWeight: 2 }, { relativeWeight: 3 }] } },
    { source: 'toolbar', tab: 'plots' });
  s.sp.setState({ tab: 'plots' });
  byAttr(s.view(), 'data-ctg-act', 'edit-plot')[1].props.onClick(ev());     // the plot with weight 2
  assert.match(text(s.view()), /Plot 2/);
  other(s, 'plots', [{ relativeWeight: 2 }, { relativeWeight: 3 }]);        // another writer removes plot 1
  const v = s.view();
  assert.match(text(v), /Plot 1/, 'the editor moved with its plot');
  field(v, 'weight').props.onChange({ target: { value: '9' } });
  field(s.view(), 'weight').props.onBlur && field(s.view(), 'weight').props.onBlur({ target: { value: '9' } });
  s.sp.drafts.flush();
  deq(s.raw().plots.map((p) => p.relativeWeight), [9, 3], 'old: [2, 9] (the edit landed on the former plot 3)');
  // its plot is removed by another writer: the editor says so and writes nothing
  other(s, 'plots', [{ relativeWeight: 3 }]);
  const n = s.writes.length;
  const g = s.view();
  assert.ok(byAttr(g, 'data-ctg', 'plot-gone')[0], 'old: showed and edited another plot');
  assert.equal(field(g, 'weight'), undefined);
  assert.equal(s.writes.length, n);
});

test('a tag-path edit becomes the editor identity only once written; a refused write keeps the pen', async () => {
  let refuse = true;
  const s = settings({ props: { pens: [{ tagPath: T + 'Temp' }, { tagPath: T + 'Pressure' }], settingsPanel: { allowEditTagPath: true } } });
  const api = Object.freeze(Object.assign({}, s.api, { patch: (k, f) => (refuse ? false : s.api.patch(k, f)) }));
  const sp = new s.P.SettingsPanel({ api, args: { tab: 'pens', penKey: 'p:0' }, close: () => {} });
  sp.componentDidMount();
  const view = () => full(sp.render());
  const edit = (value) => { const tp = field(view(), 'tagPath'); tp.props.onChange({ target: { value } }); tp.props.onBlur(); };
  edit(T + 'SmallRange');
  assert.ok(sp.drafts.has('pens'), 'the tag-path edit is queued');
  assert.equal(sp.state.sel.next, '[default]ctg/smallrange', 'pending identity');
  assert.equal(sp.state.sel.key, '[default]ctg/temp', 'not yet the identity');
  sp.drafts.flush();                                                         // refused
  assert.equal(sp.state.sel.next, null);
  assert.equal(sp.state.sel.key, '[default]ctg/temp');
  const v = view();
  assert.ok(byAttr(v, 'data-ctg', 'pen-editor')[0], 'old: "This pen is no longer on the chart"');
  assert.equal(field(v, 'tagPath').props.value, T + 'Temp', 'still the pen it was (the write was refused)');
  // a write that is made: the new path is the identity
  refuse = false;
  edit(T + 'SmallRange');
  sp.drafts.flush();
  assert.equal(s.api.props().pens[0].tagPath, T + 'SmallRange');
  assert.equal(sp.state.sel.key, '[default]ctg/smallrange');
  assert.ok(byAttr(view(), 'data-ctg', 'pen-editor')[0]);
});

test('the tag browser identity includes the session user: a user switch resets the tree and the selection', async () => {
  const caps = { readScope: { runtimePensAllowed: true, roots: ['[default]CTG'] }, user: 'operator' };
  const s = stub({ props: { tagBrowser: { enabled: true }, pens: [] }, penInfos: [], capabilities: caps,
    handlers: { 'chart.browse': (b) => ({ ok: true, data: { path: b.path, continuation: null, results: b.path ? [] : [
      { name: 'Temp', path: T + 'Temp', type: 'AtomicTag', dataType: 'Float8', hasChildren: false, trendable: true }] } }) } });
  const tb = new s.P.TagBrowser({ api: s.api, args: {}, close: () => {} });
  tb.componentDidMount();
  await flush();
  byAttr(full(tb.render()), 'role', 'treeitem')[0].props.onClick(ev());
  assert.equal(Object.keys(tb.state.selected).length, 1);
  const n = s.requests.length;
  caps.user = 'engineer';                                                    // same gate, same scope, another user
  tb.componentDidUpdate();
  deq(tb.state.selected, {}, 'old: the previous user\'s selection stayed');
  tb.componentDidUpdate();
  await flush();
  assert.ok(s.requests.length > n, 'browsed again for the new user');
});
