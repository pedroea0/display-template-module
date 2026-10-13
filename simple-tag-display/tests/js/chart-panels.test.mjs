// =============================================================================
// chart-panels.test.mjs — ctg-chart-panels.js against the ChartApi stub
// =============================================================================
// The panels talk to the chart ONLY through the frozen ChartApi, so every test
// runs them over tests/js/_chartApiStub.mjs: real reducer / buildPens / i18n,
// recorded writes, requests and events.
//   - pure model (NS.chartPanels): defaults mirror the chart schema, scope
//     mirror, add target, axis / plot edits, number parsing, TagTree, DraftStore
//   - SettingsPanel: whole-object writes of pens / axes / plots / trendPens /
//     penTable, onPensChange add / remove / edit, the design mode /
//     read-only / turned-off states, the pencil entry point
//   - TagBrowser: lazy browse with opaque continuation, keyboard tree,
//     multi-select, ONE chart.trendAdd {tagPaths} with rejected and
//     duplicates shown inline, scope greying, the pens target, stale replies
//     dropped, gates (the UI side)
// The React stub returns plain {type, props, children} nodes; full() renders
// every component in place (as React would) so the handlers can be driven.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChartApiStub } from './_chartApiStub.mjs';

const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** deepEqual across the vm realm (objects built in the stub context have other prototypes). */
const J = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const deq = (a, b, m) => assert.deepEqual(J(a), J(b), m);

/** Stub with setState / forceUpdate on the stub Component (React's are not in the Node env). */
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

/** Renders every component node in place (classes: a fresh instance; functions: called), recursively. */
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
const ev = (extra = {}) => Object.assign({
  preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, defaultPrevented: false,
  currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20 }), querySelector: () => null },
}, extra);
/** The input / select inside the field carrying data-ctg-field="name". */
const field = (tree, name) => byAttr(tree, 'data-ctg-field', name)[0];
/** Picks the option with value v in a SelectField's <select> (options are indexed). */
function pick(tree, name, label) {
  const sel = field(tree, name);
  const opts = find(sel, (n) => n.type === 'option');
  const i = opts.findIndex((o) => text(o) === label);
  assert.ok(i >= 0, `option "${label}" in ${name}: ${opts.map(text).join('|')}`);
  sel.props.onChange({ target: { value: opts[i].props.value } });
}

const T = '[default]CTG/';
function settings(fixture = {}, args = { source: 'toolbar' }) {
  const s = stub(Object.assign({ props: { pens: [{ tagPath: T + 'Temp' }, { tagPath: T + 'Pressure' }] } }, fixture));
  const closed = [];
  const sp = new s.P.SettingsPanel({ api: s.api, args, close: (w) => closed.push(w || true) });
  sp.componentDidMount();
  return Object.assign(s, { sp, closed, view: () => full(sp.render()) });
}

// -----------------------------------------------------------------------------
// pure model
// -----------------------------------------------------------------------------
test('defaults mirror the chart schema item defaults (pens, overrides, axes, plots, markers, aggregations)', () => {
  const s = stub();
  const { C, P } = s;
  const r = C.reduceProps({ pens: [{}], axes: [{}], plots: [{ markers: [{}] }], trendPens: { overrides: [{}] } });
  assert.equal(P.stableJson(P.defaultPen('')), P.stableJson(r.pens[0]));
  assert.equal(P.stableJson(P.defaultOverride('')), P.stableJson(r.trendPens.overrides[0]));
  assert.equal(P.stableJson(P.defaultAxis('Axis 1', 'left')), P.stableJson(r.axes[0]));
  assert.equal(P.stableJson(P.defaultPlot()), P.stableJson(Object.assign({}, r.plots[0], { markers: [] })));
  assert.equal(P.stableJson(P.defaultMarker('')), P.stableJson(r.plots[0].markers[0]));
  assert.equal(P.stableJson(P.defaultDisplay()), P.stableJson(r.trendPens.defaults.display));
  deq(['default'].concat(P.AGGREGATIONS), C.SPEC.p.pens.item.p.aggregation.values);
  deq(P.PEN_COLUMN_IDS, Object.keys(r.penTable.columns));
  deq(P.RANGE_COLUMN_IDS, Object.keys(r.penTable.rangeColumns));
  assert.equal(P.MAX_PLOTS, C.SPEC.p.pens.item.p.plot.max + 1);
});

test('registration: settings docked right, tagBrowser docked left, both with toolbar buttons', () => {
  const s = stub();
  const sp = s.C.panels.get('settings'), tb = s.C.panels.get('tagBrowser');
  assert.equal(sp.dock, 'right');
  assert.equal(tb.dock, 'left');
  assert.equal(sp.button.icon, 'settings');
  assert.equal(tb.button.icon, 'tags');
  assert.equal(sp.render(s.api, {}, () => {}).type, s.P.SettingsPanel);
  assert.equal(tb.render(s.api, {}, () => {}).type, s.P.TagBrowser);
  assert.equal(s.NS.loaded.chartPanels, '2.0.0-stub0000');
  assert.ok(s.styles === undefined || true);
});

test('read-scope mirror: tags, folders, provider roots, unknown provider, runtime pens off', () => {
  const { P } = stub();
  const sc = { runtimePensAllowed: true, roots: ['[default]CTG'] };
  assert.equal(P.scopeOf('[default]CTG/Temp', sc), 'in');
  assert.equal(P.scopeOf('[DEFAULT]ctg/Sub/X', sc), 'in', 'case-insensitive');
  assert.equal(P.scopeOf('[default]CTGX/Temp', sc), 'out', 'segment boundary');
  assert.equal(P.scopeOf('[default]Other/T', sc), 'out');
  assert.equal(P.scopeOf('CTG/Temp', sc), 'unknown', 'no provider: the gateway decides');
  assert.equal(P.scopeOf('[default]CTG/Temp', { runtimePensAllowed: false, roots: ['[default]'] }), 'out');
  assert.equal(P.scopeOf('[default]A/B', { runtimePensAllowed: true, roots: ['[default]'] }), 'in', 'provider root');
  assert.equal(P.scopeOf('[default]A/B', { runtimePensAllowed: true, roots: [] }), 'out');
  assert.equal(P.folderScopeOf('[default]', sc), 'ancestor');
  assert.equal(P.folderScopeOf('[default]CTG', sc), 'in');
  assert.equal(P.folderScopeOf('[default]CTG/Sub', sc), 'in');
  assert.equal(P.folderScopeOf('[default]Other', sc), 'out');
  assert.equal(P.folderScopeOf('[System]', sc), 'out');
});

test('add target: auto = trend list with a trend group, else pens; explicit trendList without a group = pens', () => {
  const { P, C } = stub();
  const r = (o) => C.reduceProps(o);
  assert.equal(P.addTarget(r({})), 'trendList', 'default trendGroup "default"');
  assert.equal(P.addTarget(r({ trendGroup: null })), 'pens');
  assert.equal(P.addTarget(r({ trendGroup: '  ' })), 'pens');
  assert.equal(P.addTarget(r({ tagBrowser: { addTo: 'pens' } })), 'pens');
  assert.equal(P.addTarget(r({ trendGroup: null, tagBrowser: { addTo: 'trendList' } })), 'pens');
  assert.equal(P.addTarget(r({ trendGroup: 'g', tagBrowser: { addTo: 'trendList' } })), 'trendList');
});

test('number parsing, colours, dash names', () => {
  const { P } = stub();
  deq(P.parseNum('2.5', { min: 0.5, max: 8 }), { ok: true, value: 2.5 });
  assert.equal(P.parseNum('9', { min: 0.5, max: 8 }).ok, false);
  assert.equal(P.parseNum('1e2', {}).value, 100);
  assert.equal(P.parseNum('0x10', {}).ok, false, 'strict decimal syntax');
  assert.equal(P.parseNum('1.5', { integer: true }).ok, false);
  deq(P.parseNum('', { nullable: true }), { ok: true, value: null });
  assert.equal(P.parseNum('', {}).ok, false);
  assert.equal(P.validColor(''), true);
  assert.equal(P.validColor('#ff0000'), true);
  assert.equal(P.validColor('red;background:url(x)'), false, 'hygiene');
  assert.equal(P.hexOf('#abc'), '#aabbcc');
  assert.equal(P.dashName([]), 'solid');
  assert.equal(P.dashName([6, 4]), 'dashed');
  assert.equal(P.dashName([9, 1]), 'custom');
});

test('axes: add on the side with fewer axes (tie -> right), rename and delete update every reference', () => {
  const { P, C } = stub();
  const p = C.reduceProps({
    pens: [{ tagPath: 'a', axis: 'T' }, { tagPath: 'b', axis: 'P' }],
    axes: [{ name: 'T' }, { name: 'P', position: 'right' }],
    plots: [{ markers: [{ axis: 'T' }, { axis: 'P' }] }],
    trendPens: { defaults: { axis: 'T' }, overrides: [{ tagPath: 'x', axis: 'T' }] },
  });
  const s = { pens: P.copy(p.pens), axes: P.copy(p.axes), plots: P.copy(p.plots), trendPens: P.copy(p.trendPens) };
  const a1 = P.addAxis(s.axes, [{ plot: 0, side: 'left' }], 0);
  assert.equal(a1.name, 'Axis 1');
  assert.equal(a1.axes[2].position, 'right');
  const a2 = P.addAxis(a1.axes, [{ plot: 0, side: 'right' }], 0);
  assert.equal(a2.name, 'Axis 2');
  assert.equal(a2.axes[3].position, 'left');
  assert.equal(P.addAxis([], [], 0).axes[0].position, 'right', 'tie -> right');
  const rn = P.renameAxis(s, 'T', 'Temperature');
  deq(rn.axes.map((a) => a.name), ['Temperature', 'P']);
  deq(rn.pens.map((x) => x.axis), ['Temperature', 'P']);
  assert.equal(rn.trendPens.defaults.axis, 'Temperature');
  assert.equal(rn.trendPens.overrides[0].axis, 'Temperature');
  deq(rn.plots[0].markers.map((m) => m.axis), ['Temperature', 'P']);
  assert.equal(s.axes[0].name, 'T', 'inputs untouched');
  const del = P.deleteAxis(s, 0);
  deq(del.axes.map((a) => a.name), ['P']);
  deq(del.pens.map((x) => x.axis), ['', 'P'], 'pens fall back to automatic');
  assert.equal(del.trendPens.defaults.axis, '');
  deq(del.plots[0].markers.map((m) => m.axis), ['', 'P']);
});

test('plots: the first add writes two (implicit plot), max 8; remove moves its pens to plot 1 and shifts later ones', () => {
  const { P } = stub();
  const a = P.addPlot([]);
  assert.equal(a.plots.length, 2);
  assert.equal(a.index, 1);
  let pl = [];
  for (let i = 0; i < 10; i++) pl = P.addPlot(pl).index >= 0 ? P.addPlot(pl).plots : pl;
  assert.equal(pl.length, 8);
  assert.equal(P.addPlot(pl).index, -1);
  const s = { plots: [P.defaultPlot(), P.defaultPlot(), P.defaultPlot()],
    pens: [{ plot: 0 }, { plot: 1 }, { plot: 2 }].map((x) => Object.assign(P.defaultPen('x'), x)),
    trendPens: { nameMode: 'auto', defaults: { axis: '', plot: 2, display: P.defaultDisplay() }, overrides: [Object.assign(P.defaultOverride('y'), { plot: 1 })] } };
  const r = P.removePlot(s, 1);
  assert.equal(r.plots.length, 2);
  deq(r.pens.map((x) => x.plot), [0, 0, 1]);
  assert.equal(r.trendPens.defaults.plot, 1);
  assert.equal(r.trendPens.overrides[0].plot, 0);
  assert.equal(P.removePlot({ plots: [P.defaultPlot()], pens: [], trendPens: s.trendPens }, 0), null, 'never the last plot');
});

test('trend overrides: matched on normKey, created when missing, effective values merge trendPens.defaults', () => {
  const { P, C } = stub();
  const tp = C.reduceProps({ trendPens: { defaults: { axis: 'D', plot: 1, display: { type: 'area' } }, overrides: [{ tagPath: '[default]CTG/Temp', color: '#ff0000' }] } }).trendPens;
  assert.equal(P.overrideIndex(tp, '[DEFAULT]ctg/temp'), 0);
  const added = P.setOverride(P.copy(tp), '[default]CTG/Pressure', ['name'], 'P');
  assert.equal(added.overrides.length, 2);
  assert.equal(P.stableJson(added.overrides[1]), P.stableJson(Object.assign(P.defaultOverride('[default]CTG/Pressure'), { name: 'P' })));
  const eff = P.effectiveOverride(tp, '[default]CTG/Temp');
  assert.equal(eff.axis, 'D');
  assert.equal(eff.plot, 1);
  assert.equal(eff.display.type, 'area', 'defaults display when the override has the default one');
  assert.equal(eff.color, '#ff0000');
});

test('add-pen checks: empty, duplicate, out of scope, runtime pens off, full; a provider-less path is left to the gateway', () => {
  const { P } = stub();
  const scope = { runtimePensAllowed: true, roots: ['[default]CTG'] };
  const ctx = { existing: ['[default]CTG/Temp'], scope, max: 3, count: 1 };
  assert.match(P.addPenError('  ', ctx), /Enter a tag path/);
  assert.match(P.addPenError('[DEFAULT]ctg/TEMP', ctx), /already on the chart/);
  assert.match(P.addPenError('[System]Gateway/SystemName', ctx), /Outside/);
  assert.match(P.addPenError('[default]CTG/X', Object.assign({}, ctx, { scope: { runtimePensAllowed: false, roots: [] } })), /while it runs/);
  assert.match(P.addPenError('[default]CTG/X', Object.assign({}, ctx, { count: 3 })), /maximum of 3/);
  assert.equal(P.addPenError('[default]CTG/X', ctx), null);
  assert.equal(P.addPenError('CTG/X', ctx), null);
});

test('TagTree: pages, Load more via the opaque continuation, rows, stale replies dropped, filter targets', () => {
  const { P } = stub();
  const tr = new P.TagTree();
  let g = tr.startLoad('', false);
  deq(tr.rows().map((r) => r.kind), ['loading']);
  assert.ok(tr.applyPage('', g, { path: '', continuation: null, results: [{ name: 'default', path: '[default]', type: 'Provider', hasChildren: true }] }));
  deq(tr.rows().map((r) => r.id), ['n:[default]']);
  tr.setExpanded('[default]', true);
  g = tr.startLoad('[default]', false);
  const stale = g;
  g = tr.startLoad('[default]', false);               // reload while loading: the first reply is stale
  assert.equal(tr.applyPage('[default]', stale, { results: [{ name: 'Old', path: '[default]Old', hasChildren: true }] }), false);
  tr.applyPage('[default]', g, { path: '[default]', continuation: 'c-1', totalAvailable: 2,
    results: [{ name: 'CTG', path: '[default]CTG', type: 'Folder', hasChildren: true }, { name: 'T', path: '[default]T', type: 'AtomicTag', dataType: 'Float8', trendable: true }] });
  deq(tr.rows().map((r) => r.id), ['n:[default]', 'n:[default]ctg', 'n:[default]t', 'more:[default]']);
  assert.equal(tr.get('[default]t').depth, 1);
  g = tr.startLoad('[default]', true);
  tr.applyPage('[default]', g, { continuation: null, results: [{ name: 'U', path: '[default]U', trendable: true }, { name: 'T', path: '[default]T' }] }, true);
  deq(tr.get('[default]').children, ['[default]ctg', '[default]t', '[default]u'], 'appended, de-duplicated');
  assert.equal(tr.get('[default]').continuation, null, 'last page: no more row');
  tr.setExpanded('[default]ctg', true);
  g = tr.startLoad('[default]ctg', false);
  tr.failLoad('[default]ctg', g, { code: 'BROWSE_ROOT_VIOLATION' });
  assert.ok(tr.rows().some((r) => r.id === 'err:[default]ctg'));
  deq(tr.expandedKeys(), ['', '[default]', '[default]ctg']);
  deq(tr.filterTargets(), ['[default]ctg'], 'the deepest open folder');
  g = tr.startLoad('[default]ctg', false);
  tr.applyPage('[default]ctg', g, { results: [] }, false, true);
  assert.ok(tr.rows().some((r) => r.id === 'empty:[default]ctg'));
  // the stub's `rows` spelling is accepted too
  const t2 = new P.TagTree();
  const g2 = t2.startLoad('', false);
  t2.applyPage('', g2, { rows: [{ name: 'A', path: '[p]A' }] });
  deq(t2.root().children, ['[p]a']);
});

// The DraftStore writes with ChartApi.patch — the same operations applied to the RAW root
test('DraftStore: debounced patches of the raw root, echo recognised, TTL fallback, refusals reported', async () => {
  const s = stub({ props: { pens: [{ tagPath: T + 'Temp', custom: 7 }] } });
  let now = 1000;
  const flushed = [];
  const d = new s.P.DraftStore(s.api, { now: () => now, onFlush: (ok, written, attempted) => flushed.push([ok, written, attempted]) });
  d.edit('pens', 'name', s.P.penFieldOp('[default]ctg/temp', 0, ['name'], 'A'));
  d.edit('pens', 'name', s.P.penFieldOp('[default]ctg/temp', 0, ['name'], 'AB'));
  assert.equal(d.get('pens')[0].name, 'AB', 'shown in the reduced shape at once');
  assert.equal(d.get('pens')[0].display.width, 1.5);
  assert.equal(s.writes.length, 0, 'debounced');
  await sleep(s.P.DEBOUNCE_MS + 80);
  assert.equal(s.writes.length, 1, 'one write for the burst');
  assert.equal(s.writes[0].patch, true, 'through ChartApi.patch');
  deq(s.writes[0].value, [{ tagPath: T + 'Temp', custom: 7, name: 'AB' }], 'the raw pen + the edit: unknown keys kept, no defaults written');
  assert.equal(d.get('pens')[0].name, 'AB');
  assert.equal(d.written.pens, undefined, 'the stub echoed synchronously: written entry dropped');
  // no echo (a binding wins): the written value shows until the TTL, then the props
  const api2 = Object.assign({}, s.api, { patch: () => true });
  const d2 = new s.P.DraftStore(api2, { now: () => now });
  d2.edit('penTable', 'c', (x) => Object.assign({}, x, { collapsed: true }), true);
  assert.equal(d2.get('penTable').collapsed, true);
  now += 3500;
  assert.equal(d2.get('penTable').collapsed, false, 'TTL passed: back to the props');
  // design mode: api.patch refuses -> flush reports false
  const dm = stub({ designMode: true });
  const d3 = new dm.P.DraftStore(dm.api, { onFlush: (ok) => flushed.push([ok]) });
  assert.equal(d3.edit('axes', 'a', dm.P.addAxisOp('A', 'left'), true), false);
  assert.equal(dm.writes.length, 0);
  deq(flushed[flushed.length - 1], [false]);
});

// -----------------------------------------------------------------------------
// SettingsPanel
// -----------------------------------------------------------------------------
test('settings: tabs per settingsPanel.tabs, pens list with all static pens (disabled ones too) and the trend list', () => {
  const s = settings({
    props: { pens: [{ tagPath: T + 'Temp' }, { tagPath: T + 'Pressure', enabled: false }], settingsPanel: { tabs: { plots: false } } },
    penInfos: [
      { key: 'p:0', source: 'pens', index: 0, tagPath: T + 'Temp', name: 'Temp', status: 'ok', meta: { dataType: 'Float8', engUnit: 'degF' }, trendable: true },
      { key: 't:[default]ctg/counter', source: 'trend', index: null, tagPath: T + 'Counter', name: 'Counter', status: 'ok', meta: { dataType: 'Int4' }, trendable: true },
    ],
  });
  const v = s.view();
  deq(byAttr(v, 'role', 'tab').map((x) => x.props['data-ctg-tab']), ['pens', 'axes', 'columns']);
  assert.equal(byAttr(v, 'role', 'tab')[0].props['aria-selected'], 'true');
  assert.equal(byAttr(v, 'role', 'dialog').length, 1);
  const pens = byAttr(v, 'data-ctg', 'settings-pens')[0];
  deq(find(pens, (n) => n.type === 'li').map((li) => li.props['data-ctg-pen']), ['p:0', 'p:1']);
  assert.match(text(pens), /disabled/);
  const trend = byAttr(v, 'data-ctg', 'settings-trend')[0];
  assert.match(text(trend), /Counter/);
  assert.match(text(v), /Session trend list .default. \(1\)/);
});

test('settings write shapes: colour, new axis (right), new plot, display type area -> whole-object writes + onPensChange edit', async () => {
  const s = settings();
  byAttr(s.view(), 'data-ctg-act', 'edit-pen')[0].props.onClick(ev());
  let v = s.view();
  assert.ok(byAttr(v, 'data-ctg', 'pen-editor')[0], 'editor open');
  // colour (live text field, debounced)
  field(v, 'color').props.onChange({ target: { value: '#ff0000' } });
  s.sp.drafts.flush();
  let w = s.writes.pop();
  assert.equal(w.key, 'pens');
  assert.equal(w.value.length, 2, 'whole array');
  assert.equal(w.value[0].color, '#ff0000');
  deq(w.value[1], { tagPath: T + 'Pressure' }, 'other pens exactly as the view stores them (was: the reducer\'s full shape)');
  deq(s.events.pop(), { name: 'onPensChange', payload: { action: 'edit', tagPath: T + 'Temp', source: 'pens' } });
  // new axis -> axes + pens written at once
  v = s.view();
  pick(v, 'axis', 'New axis…');
  const wa = s.writes.find((x) => x.key === 'axes');
  assert.equal(wa.value.length, 1);
  assert.equal(wa.value[0].name, 'Axis 1');
  assert.equal(wa.value[0].position, 'right', 'stub axesInUse: one auto axis on the left -> right');
  assert.equal(s.api.props().pens[0].axis, 'Axis 1');
  // new plot
  s.writes.length = 0;
  v = s.view();
  pick(v, 'plot', 'New plot');
  deq(s.writes.map((x) => x.key).sort(), ['pens', 'plots']);
  assert.equal(s.api.props().plots.length, 2);
  assert.equal(s.api.props().pens[0].plot, 1);
  // display type area (whole display object)
  v = s.view();
  pick(v, 'type', 'Area');
  s.sp.drafts.flush();
  w = s.writes.pop();
  assert.equal(w.value[0].display.type, 'area');
  deq(Object.keys(w.value[0].display), ['type'], 'only the edited field is written into the raw display');
  assert.equal(s.api.props().pens[0].display.width, 1.5, 'the rest of display kept (the reducer default)');
  assert.equal(s.api.props().pens[0].display.type, 'area');
  // the editor now shows the fill opacity field (area)
  assert.ok(field(s.view(), 'fillOpacity'));
  // line width validation: out of range never writes
  s.writes.length = 0;
  const vv = s.view();
  field(vv, 'width').props.onChange({ target: { value: '12' } });
  s.sp.drafts.flush();
  assert.equal(s.writes.length, 0, 'invalid width not written');
});

test('settings: add pen (scope-checked), reorder, delete with confirm; events add / remove', () => {
  const s = settings({ capabilities: { readScope: { runtimePensAllowed: true, roots: ['[default]CTG'] } } });
  s.sp.setState({ addText: '[System]Gateway/SystemName' });
  s.sp._addPen();
  assert.match(s.sp.state.addError, /Outside/);
  assert.equal(s.writes.length, 0);
  s.sp.setState({ addText: T + 'Temp' });
  s.sp._addPen();
  assert.match(s.sp.state.addError, /already/);
  s.sp.setState({ addText: T + 'SmallRange' });
  find(s.view(), (n) => n.type === 'form')[0].props.onSubmit(ev());
  let w = s.writes.pop();
  assert.equal(w.key, 'pens');
  assert.equal(s.P.stableJson(w.value[2]), s.P.stableJson(s.P.defaultPen(T + 'SmallRange')));
  deq(s.events.pop().payload, { action: 'add', tagPath: T + 'SmallRange', source: 'pens' });
  assert.equal(s.sp.state.addText, '');
  // reorder: move Pressure up
  const downs = byAttr(s.view(), 'data-ctg-act', 'up');
  assert.equal(downs[0].props.disabled, true, 'first row cannot move up');
  downs[1].props.onClick(ev());
  deq(s.writes.pop().value.map((p) => p.tagPath), [T + 'Pressure', T + 'Temp', T + 'SmallRange']);
  // delete the 2nd pen through the editor's confirm
  byAttr(s.view(), 'data-ctg-act', 'edit-pen')[1].props.onClick(ev());
  byAttr(s.view(), 'data-ctg-act', 'delete-pen')[0].props.onClick(ev());
  assert.ok(s.sp.state.confirm, 'confirm first');
  assert.equal(s.writes.length, 0);
  s.sp.state.confirm.onConfirm();
  w = s.writes.pop();
  deq(w.value.map((p) => p.tagPath), [T + 'Pressure', T + 'SmallRange']);
  deq(s.events.pop().payload, { action: 'remove', tagPath: T + 'Temp', source: 'pens' });
  assert.equal(s.sp.state.view, 'list');
});

test('settings: trend pen edits go to trendPens.overrides (whole trendPens); remove + clear use the gateway', async () => {
  const s = settings({
    props: { pens: [], trendPens: { defaults: { axis: '', plot: 0, display: { type: 'line' } } } },
    penInfos: [
      { key: 't:[default]ctg/temp', source: 'trend', index: null, tagPath: T + 'Temp', name: 'Temp', status: 'ok', meta: {}, trendable: true },
      { key: 't:[default]ctg/pressure', source: 'trend', index: null, tagPath: T + 'Pressure', name: 'Pressure', status: 'ok', meta: {}, trendable: true },
    ],
  }, { tab: 'pens', penKey: 't:[default]ctg/temp' });
  let v = s.view();
  assert.ok(byAttr(v, 'data-ctg', 'pen-editor')[0], 'pencil entry point opens the editor');
  assert.equal(field(v, 'tagPath'), undefined, 'no tag path for a trend pen');
  assert.equal(field(v, 'aggregation'), undefined, 'no aggregation for a trend pen');
  field(v, 'name').props.onChange({ target: { value: 'Temperature' } });
  s.sp.drafts.flush();
  const w = s.writes.pop();
  assert.equal(w.key, 'trendPens');
  deq(w.value.defaults, { axis: '', plot: 0, display: { type: 'line' } }, 'the raw trendPens: defaults as stored');
  assert.ok(!('nameMode' in w.value), 'no reducer default written');
  assert.equal(w.value.overrides.length, 1);
  assert.equal(w.value.overrides[0].tagPath, T + 'Temp');
  assert.equal(w.value.overrides[0].name, 'Temperature');
  deq(s.events.pop().payload, { action: 'edit', tagPath: T + 'Temp', source: 'trend' });
  // remove from the trend list
  v = s.view();
  byAttr(v, 'data-ctg-act', 'remove-trend')[0].props.onClick(ev());
  s.sp.state.confirm.onConfirm();
  await flush();
  deq(s.requests.pop(), { name: 'chart.trendRemove', body: { tagPath: T + 'Temp' }, opts: {} });
  deq(s.events.pop().payload, { action: 'remove', tagPath: T + 'Temp', source: 'trend' });
  // clear the list
  v = s.view();
  byAttr(v, 'data-ctg-act', 'clear-trend')[0].props.onClick(ev());
  s.sp.state.confirm.onConfirm();
  await flush();
  assert.equal(s.requests.pop().name, 'chart.trendClear');
  assert.equal(s.events.filter((e) => e.payload.action === 'remove').length, 2, 'one remove per listed trend pen');
});

test('settings: trendEdit not allowed greys Clear list / Remove with the reason', () => {
  const s = settings({
    props: { pens: [] }, capabilities: { trendEdit: { allowed: false, reason: 'FORBIDDEN_ROLE' } },
    penInfos: [{ key: 't:[default]ctg/temp', source: 'trend', index: null, tagPath: T + 'Temp', name: 'Temp', status: 'ok', meta: {}, trendable: true }],
  });
  const clear = byAttr(s.view(), 'data-ctg-act', 'clear-trend')[0];
  assert.equal(clear.props.disabled, true);
  assert.match(clear.props.title, /permission/);
});

test('settings: axes tab add / rename (references follow) / delete; plots tab markers; columns write penTable whole', () => {
  const s = settings({ props: { pens: [{ tagPath: T + 'Temp', axis: 'Temp axis' }], axes: [{ name: 'Temp axis' }] } }, { tab: 'axes' });
  let v = s.view();
  assert.equal(byAttr(v, 'role', 'tab').find((x) => x.props['aria-selected'] === 'true').props['data-ctg-tab'], 'axes');
  byAttr(v, 'data-ctg-act', 'edit-axis')[0].props.onClick(ev());
  v = s.view();
  // rename: commit on Enter only (not per keystroke)
  const nm = field(v, 'axisName');
  assert.equal(nm.props.value, 'Temp axis');
  s.writes.length = 0;
  // drive the DraftInput instance: rebuild it from the tree and type + Enter
  const di = new s.P.DraftInput(findDraft(s.sp.render(), 'axisName'));
  di.props = findDraft(s.sp.render(), 'axisName');
  di._edit('Temperature');
  assert.equal(s.writes.length, 0, 'not live');
  di._commit();
  deq(s.writes.map((x) => x.key).sort(), ['axes', 'pens'], 'only the roots that reference the axis change (unchanged roots are not written)');
  assert.equal(s.api.props().axes[0].name, 'Temperature');
  assert.equal(s.api.props().pens[0].axis, 'Temperature');
  // a duplicate name is refused
  const di2 = new s.P.DraftInput(findDraft(s.sp.render(), 'axisName'));
  di2.props = findDraft(s.sp.render(), 'axisName');
  s.api.write('axes', s.api.props().axes.concat([s.P.defaultAxis('Other')]));
  di2.props = findDraft(s.sp.render(), 'axisName');
  di2._edit('Other');
  assert.match(di2.state.error, /already has this name/);
  // manual range: min / max nullable numbers
  pick(s.view(), 'rangeMode', 'Manual');
  s.sp.drafts.flush();
  assert.equal(s.api.props().axes[0].range.mode, 'manual');
  field(s.view(), 'rangeMin').props.onChange({ target: { value: '-5' } });
  s.sp.drafts.flush();
  assert.equal(s.api.props().axes[0].range.min, -5);
  // delete -> pens fall back to automatic
  byAttr(s.view(), 'data-ctg-act', 'delete-axis')[0].props.onClick(ev());
  s.sp.state.confirm.onConfirm();
  deq(s.api.props().axes.map((a) => a.name), ['Other']);
  assert.equal(s.api.props().pens[0].axis, '');
  // plots: implicit plot materialised on the first marker
  s.sp.setState({ tab: 'plots', view: 'list' });
  byAttr(s.view(), 'data-ctg-act', 'edit-plot')[0].props.onClick(ev());
  byAttr(s.view(), 'data-ctg-act', 'add-marker')[0].props.onClick(ev());
  assert.equal(s.api.props().plots.length, 1);
  assert.equal(s.api.props().plots[0].markers.length, 1);
  assert.equal(byAttr(s.view(), 'data-ctg-act', 'remove-plot')[0].props.disabled, true, 'last plot');
  // columns
  s.sp.setState({ tab: 'columns', view: 'list' });
  v = s.view();
  field(v, 'columns.axis').props.onChange({ target: { checked: true } });
  field(v, 'rangeColumns.count').props.onChange({ target: { checked: true } });
  s.sp.drafts.flush();
  const pt = s.writes.filter((x) => x.key === 'penTable').pop();
  assert.equal(pt.value.columns.axis, true);
  assert.equal(pt.value.rangeColumns.count, true);
  assert.ok('allowHide' in pt.value && 'style' in pt.value, 'whole penTable');
});
/** Props of the DraftInput carrying data-ctg-field === name (searched before rendering it). */
function findDraft(node, name) {
  let found = null;
  (function walk(n) {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (n.props && n.props.field === name && n.type && n.type.name === 'DraftInput') { found = n.props; return; }
    if (typeof n.type === 'function') {
      const kids = n.children || [];
      const props = Object.assign({}, n.props, kids.length ? { children: kids.length === 1 ? kids[0] : kids } : {});
      if (n.type.prototype && n.type.prototype.render) { const i = new n.type(props); i.props = props; if (!i.state) i.state = {}; walk(i.render()); } else walk(n.type(props));
      return;
    }
    walk(n.children);
    if (n.props) walk(n.props.children);
  })(node);
  return found;
}

test('settings: design mode / read-only chart / settings off -> a notice and no edit controls, no writes', () => {
  for (const [fixture, re] of [
    [{ designMode: true }, /design mode/],
    [{ props: { enabled: false, pens: [{ tagPath: T + 'Temp' }] } }, /turned off for this chart/],
    [{ props: { settingsPanel: { enabled: false }, pens: [{ tagPath: T + 'Temp' }] } }, /settings panel is turned off/],
  ]) {
    const s = settings(fixture);
    const v = s.view();
    assert.match(text(byAttr(v, 'role', 'note')[0]), re);
    assert.equal(byAttr(v, 'role', 'tab').length, 0);
    assert.equal(byAttr(v, 'data-ctg-act', 'edit-pen').length, 0);
    byAttr(v, 'data-ctg-act', 'done')[0].props.onClick(ev());
    assert.equal(s.writes.length, 0);
    assert.equal(s.closed.length, 1);
  }
  // and the chart (stub) refuses to open any panel in design mode
  const dm = stub({ designMode: true });
  assert.equal(dm.api.panels.open('settings', {}), false);
});

test('settings: Done flushes pending edits, then closes; Esc closes', () => {
  const s = settings();
  byAttr(s.view(), 'data-ctg-act', 'edit-pen')[0].props.onClick(ev());
  field(s.view(), 'name').props.onChange({ target: { value: 'T1' } });
  assert.equal(s.writes.length, 0);
  byAttr(s.view(), 'data-ctg-act', 'done')[0].props.onClick(ev());
  assert.equal(s.writes.pop().value[0].name, 'T1');
  deq(s.closed, ['done']);
  // Esc on the frame
  const frame = new s.P.PanelFrame({ panel: 'settings', title: 'x', width: 340, onClose: (w) => s.closed.push(w), children: null });
  const out = frame.render();
  const e = ev({ key: 'Escape' });
  out.props.onKeyDown(e);
  assert.equal(s.closed.pop(), 'escape');
  assert.equal(out.props.role, 'dialog');
  assert.equal(out.props['aria-labelledby'], frame.titleId);
  assert.equal(out.props.style.width, '340px');
  assert.equal(out.props.style.flex, undefined, 'no flex-basis in the column dock');
});

// -----------------------------------------------------------------------------
// TagBrowser
// -----------------------------------------------------------------------------
const TREE = {
  '': { path: '', continuation: null, results: [{ name: 'default', path: '[default]', type: 'Provider', dataType: null, hasChildren: true, trendable: false }] },
  '[default]': { path: '[default]', continuation: null, results: [
    { name: 'CTG', path: '[default]CTG', type: 'Folder', dataType: null, hasChildren: true, trendable: false },
    { name: 'Other', path: '[default]Other', type: 'Folder', dataType: null, hasChildren: true, trendable: false }] },
  '[default]CTG': { path: '[default]CTG', continuation: 'opaque-1', results: [
    { name: 'Temp', path: '[default]CTG/Temp', type: 'AtomicTag', dataType: 'Float8', hasChildren: false, trendable: true },
    { name: 'Pressure', path: '[default]CTG/Pressure', type: 'AtomicTag', dataType: 'Float8', hasChildren: false, trendable: true },
    { name: 'Label', path: '[default]CTG/Label', type: 'AtomicTag', dataType: 'String', hasChildren: false, trendable: false }] },
  '[default]CTG#opaque-1': { path: '[default]CTG', continuation: null, results: [
    { name: 'NoHistory', path: '[default]CTG/NoHistory', type: 'AtomicTag', dataType: 'Float8', hasChildren: false, trendable: true }] },
  '[default]Other': { path: '[default]Other', continuation: null, results: [
    { name: 'X', path: '[default]Other/X', type: 'AtomicTag', dataType: 'Float8', hasChildren: false, trendable: true }] },
};
function browser(fixture = {}, args = { source: 'toolbar' }) {
  const handlers = Object.assign({
    'chart.browse': (b) => {
      const k = b.continuation ? b.path + '#' + b.continuation : b.path;
      const page = TREE[k];
      if (!page) return { ok: false, error: { code: 'TAG_NOT_FOUND', message: 'Tag not found.' } };
      const f = (b.filterText || '').toLowerCase();
      return { ok: true, data: Object.assign({}, page, { results: page.results.filter((r) => !f || r.name.toLowerCase().includes(f)) }) };
    },
    'chart.trendAdd': (b) => ({ ok: true, data: { group: 'default',
      added: b.tagPaths.filter((p) => !/NoHistory/.test(p)),
      rejected: b.tagPaths.filter((p) => /NoHistory/.test(p)).map((p) => ({ tagPath: p, code: 'NO_HISTORY', message: 'No history.' })),
      count: 2, max: 32 } }),
  }, fixture.handlers || {});
  const s = stub(Object.assign({ props: { tagBrowser: { enabled: true }, pens: [] }, penInfos: [],
    capabilities: { readScope: { runtimePensAllowed: true, roots: ['[default]CTG'] } } }, fixture, { handlers }));
  const closed = [];
  const tb = new s.P.TagBrowser({ api: s.api, args, close: (w) => closed.push(w || true) });
  tb.componentDidMount();
  return Object.assign(s, { tb, closed, view: () => full(tb.render()) });
}
const rowsOf = (v) => byAttr(v, 'role', 'treeitem');
const rowByPath = (v, p) => rowsOf(v).find((r) => r.props['data-ctg-path'] === p);
const key = (s, k) => { const tree = byAttr(s.view(), 'role', 'tree')[0]; tree.props.onKeyDown(ev({ key: k })); };

test('browser: expand [default] -> CTG, multi-select Temp + Pressure, Label greyed, NoHistory rejected inline; ONE chart.trendAdd', async () => {
  const s = browser();
  await flush();
  deq(s.requests[0], { name: 'chart.browse', body: { path: '', limit: 100 }, opts: {} });
  let v = s.view();
  assert.equal(byAttr(v, 'role', 'tree')[0].props['aria-multiselectable'], 'true');
  assert.equal(rowsOf(v).length, 1);
  assert.equal(rowsOf(v)[0].props['aria-expanded'], 'false');
  assert.equal(rowsOf(v)[0].props.tabIndex, 0, 'roving tab stop on the first row');
  // keyboard: → expands [default]
  key(s, 'ArrowRight');
  await flush();
  deq(s.requests[1].body, { path: '[default]', limit: 100 });
  key(s, 'ArrowDown');                         // -> CTG
  key(s, 'ArrowRight');                        // expand CTG
  await flush();
  v = s.view();
  assert.equal(rowByPath(v, '[default]CTG').props['aria-expanded'], 'true');
  assert.equal(rowByPath(v, '[default]CTG').props['aria-level'], 2);
  const label = rowByPath(v, '[default]CTG/Label');
  assert.equal(label.props['aria-disabled'], 'true');
  assert.equal(label.props['aria-selected'], undefined);
  assert.match(label.props.title, /numeric and Boolean/);
  assert.match(label.props.className, /muted/);
  // "Load more…" follows the opaque continuation (not totalAvailable)
  const more = rowsOf(v).find((r) => r.props['data-ctg-row'] === 'more');
  more.props.onClick(ev());
  await flush();
  deq(s.requests[3].body, { path: '[default]CTG', limit: 100, continuation: 'opaque-1' });
  v = s.view();
  assert.ok(rowByPath(v, '[default]CTG/NoHistory'));
  assert.equal(rowsOf(v).filter((r) => r.props['data-ctg-row'] === 'more').length, 0, 'last page');
  // select Temp (click), Pressure (Space), NoHistory (click); Label click does nothing
  rowByPath(v, '[default]CTG/Temp').props.onClick(ev());
  rowByPath(s.view(), '[default]CTG/Label').props.onClick(ev());
  s.tb.setState({ focus: 'n:[default]ctg/pressure' });
  key(s, ' ');
  rowByPath(s.view(), '[default]CTG/NoHistory').props.onClick(ev());
  v = s.view();
  assert.equal(rowByPath(v, '[default]CTG/Temp').props['aria-selected'], 'true');
  assert.equal(rowByPath(v, '[default]CTG/Pressure').props['aria-selected'], 'true');
  const add = byAttr(v, 'data-ctg-act', 'add-selected')[0];
  assert.match(text(add), /Add selected \(3\)/);
  assert.match(text(v), /session trend list .default./);
  // Enter adds the selection: exactly one batch message
  key(s, 'Enter');
  await flush();
  const adds = s.requests.filter((r) => r.name === 'chart.trendAdd');
  assert.equal(adds.length, 1);
  deq(adds[0].body, { tagPaths: [T + 'Temp', T + 'Pressure', T + 'NoHistory'] });
  deq(s.events.map((e) => e.payload), [
    { action: 'add', tagPath: T + 'Temp', source: 'trend' }, { action: 'add', tagPath: T + 'Pressure', source: 'trend' }]);
  v = s.view();
  const rej = byAttr(v, 'data-ctg', 'browser-rejected')[0];
  assert.match(text(rej), /NoHistory — No history available for this tag\./);
  assert.match(text(byAttr(v, 'data-ctg', 'browser-result')[0]), /Added 2 tags/);
  assert.match(text(byAttr(v, 'data-ctg-act', 'add-selected')[0]), /\(0\)/, 'sent tags deselected');
});

test('browser: duplicates counted, a failed request keeps the selection and shows the reason', async () => {
  const s = browser({ handlers: { 'chart.trendAdd': (b) => ({ ok: true, data: { group: 'default', added: [b.tagPaths[0]], rejected: [],
    duplicates: [{ tagPath: b.tagPaths[0].toLowerCase(), sameAs: b.tagPaths[0] }], count: 1, max: 32 } }) } });
  await flush();
  s.tb._toggle('[default]', true); await flush();
  s.tb._toggle('[default]ctg', true); await flush();
  rowByPath(s.view(), T + 'Temp').props.onClick(ev());
  byAttr(s.view(), 'data-ctg-act', 'add-selected')[0].props.onClick(ev());
  await flush();
  assert.match(text(byAttr(s.view(), 'data-ctg', 'browser-result')[0]), /1 duplicates ignored/);
  const f = browser({ handlers: { 'chart.trendAdd': () => ({ ok: false, error: { code: 'FORBIDDEN_ROLE', message: 'x' } }) } });
  await flush();
  f.tb._toggle('[default]', true); await flush();
  f.tb._toggle('[default]ctg', true); await flush();
  rowByPath(f.view(), T + 'Temp').props.onClick(ev());
  byAttr(f.view(), 'data-ctg-act', 'add-selected')[0].props.onClick(ev());
  await flush();
  const v = f.view();
  assert.match(text(byAttr(v, 'role', 'alert')[0]), /Adding failed: You don.t have permission/);
  assert.equal(rowByPath(v, T + 'Temp').props['aria-selected'], 'true', 'selection kept');
});

test('browser: scope greying (folder + tag), charted tags marked and not selectable', async () => {
  const s = browser({ penInfos: [{ key: 't:[default]ctg/temp', source: 'trend', index: null, tagPath: T + 'Temp', name: 'Temp', status: 'ok', meta: {}, trendable: true }] });
  await flush();
  s.tb._toggle('[default]', true); await flush();
  s.tb._toggle('[default]other', true); await flush();
  s.tb._toggle('[default]ctg', true); await flush();
  const v = s.view();
  assert.match(rowByPath(v, '[default]Other').props.className, /muted/);
  assert.match(rowByPath(v, '[default]Other').props.title, /cannot be added/);
  assert.equal(rowByPath(v, '[default]Other').props['aria-expanded'], 'true', 'still browsable');
  const x = rowByPath(v, '[default]Other/X');
  assert.equal(x.props['aria-disabled'], 'true');
  assert.match(x.props.title, /Outside/);
  const temp = rowByPath(v, T + 'Temp');
  assert.equal(temp.props['aria-disabled'], 'true');
  assert.match(text(temp), /Already on this chart/);
  temp.props.onClick(ev());
  deq(s.tb.state.selected, {});
});

test('browser: pens target (no trend group) -> ONE whole `pens` write with full default items + onPensChange source pens', async () => {
  const s = browser({ props: { trendGroup: null, tagBrowser: { enabled: true }, pens: [{ tagPath: T + 'Counter' }] } });
  await flush();
  s.tb._toggle('[default]', true); await flush();
  s.tb._toggle('[default]ctg', true); await flush();
  let v = s.view();
  assert.match(text(v), /Adds to this chart.s pens/);
  rowByPath(v, T + 'Temp').props.onClick(ev());
  rowByPath(s.view(), T + 'Pressure').props.onClick(ev());
  byAttr(s.view(), 'data-ctg-act', 'add-selected')[0].props.onClick(ev());
  assert.equal(s.requests.filter((r) => r.name === 'chart.trendAdd').length, 0);
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].key, 'pens');
  deq(s.writes[0].value.map((p) => p.tagPath), [T + 'Counter', T + 'Temp', T + 'Pressure']);
  assert.equal(s.P.stableJson(s.writes[0].value[1]), s.P.stableJson(s.P.defaultPen(T + 'Temp')));
  deq(s.events.map((e) => e.payload.source), ['pens', 'pens']);
});

test('browser: trend target refused by trendEdit / read-only chart -> Add disabled with the reason; capacity checks', async () => {
  const s = browser({ capabilities: { trendEdit: { allowed: false, reason: 'AUTH_REQUIRED' }, readScope: { runtimePensAllowed: true, roots: ['[default]'] } } });
  await flush();
  s.tb._toggle('[default]', true); await flush();
  s.tb._toggle('[default]ctg', true); await flush();
  let v = s.view();
  const temp = rowByPath(v, T + 'Temp');
  assert.match(temp.props.title, /trend list here \(Log in/);
  assert.equal(temp.props['aria-disabled'], 'true');
  assert.equal(byAttr(v, 'data-ctg-act', 'add-selected')[0].props.disabled, true);
  const ro = browser({ props: { enabled: false, tagBrowser: { enabled: true } } });
  await flush();
  assert.equal(ro.requests[0].name, 'chart.browse', 'browsing still works on a read-only chart (gateway browse gate)');
  ro.tb._toggle('[default]', true); await flush();
  ro.tb._toggle('[default]ctg', true); await flush();
  assert.match(rowByPath(ro.view(), T + 'Temp').props.title, /Changes are turned off/);
  // pens target with 1 slot left: two selected -> refused before sending
  const full2 = browser({ props: { trendGroup: null, tagBrowser: { enabled: true }, pens: [{ tagPath: T + 'Counter' }] }, penInfos: undefined, limits: { maxPens: 2 } });
  await flush();
  full2.tb._toggle('[default]', true); await flush();
  full2.tb._toggle('[default]ctg', true); await flush();
  rowByPath(full2.view(), T + 'Temp').props.onClick(ev());
  rowByPath(full2.view(), T + 'Pressure').props.onClick(ev());
  v = full2.view();
  assert.match(text(v), /room for 1 more pens/);
  assert.equal(byAttr(v, 'data-ctg-act', 'add-selected')[0].props.disabled, true);
});

test('browser: filter (debounced 300 ms) applies to the open folder only; errors shown per folder with retry', async () => {
  const s = browser();
  await flush();
  s.tb._toggle('[default]', true); await flush();
  s.tb._toggle('[default]ctg', true); await flush();
  const n = s.requests.length;
  const input = find(s.view(), (x) => x.type === 'input' && x.props.type === 'search')[0];
  input.props.onChange({ target: { value: 'pre' } });
  input.props.onChange({ target: { value: 'pres' } });
  assert.equal(s.requests.length, n, 'debounced');
  await sleep(380);
  await flush();
  const sent = s.requests.slice(n);
  deq(sent.map((r) => r.body), [{ path: '[default]CTG', limit: 100, filterText: 'pres' }], 'only the deepest open folder');
  const v = s.view();
  assert.ok(rowByPath(v, T + 'Pressure'));
  assert.equal(rowByPath(v, T + 'Temp'), undefined);
  assert.ok(rowByPath(v, '[default]CTG'), 'ancestors unfiltered');
  // clearing the filter browses the filtered folder again without filterText
  find(s.view(), (x) => x.type === 'input' && x.props.type === 'search')[0].props.onChange({ target: { value: '' } });
  await sleep(380);
  await flush();
  deq(s.requests[s.requests.length - 1].body, { path: '[default]CTG', limit: 100 });
  // an error folder
  const e = browser({ handlers: { 'chart.browse': (b) => (b.path === '' ? { ok: true, data: TREE[''] } : { ok: false, error: { code: 'BROWSE_ROOT_VIOLATION' } }) } });
  await flush();
  e.tb._toggle('[default]', true); await flush();
  const err = rowsOf(e.view()).find((r) => r.props['data-ctg-row'] === 'error');
  assert.equal(err.props['data-code'], 'BROWSE_ROOT_VIOLATION');
  assert.match(text(err), /outside the area this chart may browse/);
  const before = e.requests.length;
  err.props.onClick(ev());
  await flush();
  assert.equal(e.requests.length, before + 1, 'retry');
});

test('browser: a reply for an older request is dropped (reload while loading); after unmount nothing updates', async () => {
  const s = browser();
  await flush();
  // from here on every chart.browse stays pending until the test answers it
  const pending = [];
  const api = Object.assign({}, s.api, { request: (name, body) => new Promise((res) => pending.push({ name, body, res })) });
  s.tb.props = Object.assign({}, s.tb.props, { api });
  s.tb._toggle('[default]', true);
  s.tb._reload();                                  // browses root + [default] again: the first [default] reply is stale
  const forDefault = pending.filter((p) => p.body.path === '[default]');
  assert.equal(forDefault.length, 2);
  forDefault[1].res({ ok: true, data: TREE['[default]'] });
  await flush();
  forDefault[0].res({ ok: true, data: { path: '[default]', continuation: null, results: [{ name: 'Stale', path: '[default]Stale', hasChildren: true }] } });
  await flush();
  const v = s.view();
  assert.equal(rowByPath(v, '[default]Stale'), undefined, 'stale page ignored');
  assert.ok(rowByPath(v, '[default]CTG'));
  // unmounted: the root reply arrives and changes nothing
  s.tb.componentWillUnmount();
  const state = s.tb.state;
  pending.filter((p) => p.body.path === '').forEach((p) => p.res({ ok: true, data: { path: '', continuation: null, results: [] } }));
  await flush();
  assert.equal(s.tb.state, state, 'no setState after unmount');
  assert.equal(s.tb.tree.root().loading, true, 'the reply was not applied');
});

test('browser gates: not allowed -> notice per reason, no browse; design mode notice', async () => {
  for (const [reason, re] of [['FORBIDDEN_ROLE', /permission to browse/], ['AUTH_REQUIRED', /Log in to browse/], ['ACTION_DISABLED', /turned off/],
    ['BROWSE_ROOT_VIOLATION', /not available \(BROWSE_ROOT_VIOLATION\)/]]) {
    const s = browser({ capabilities: { tagBrowser: { allowed: false, reason } } });
    await flush();
    assert.equal(s.requests.length, 0);
    assert.match(text(byAttr(s.view(), 'role', 'note')[0]), re);
  }
  const d = browser({ designMode: true });
  await flush();
  assert.equal(d.requests.length, 0);
  assert.match(text(byAttr(d.view(), 'role', 'note')[0]), /design mode/);
});

test('browser: a filtered page that comes back empty with a continuation fetches the next page automatically (bounded)', async () => {
  const pages = {
    '': { path: '', continuation: null, results: [{ name: 'Many', path: '[default]Many', type: 'Folder', hasChildren: true }] },
    '[default]Many': (b) => {
      const n = b.continuation ? Number(b.continuation) : 0;
      const names = [];
      for (let i = n * 10; i < n * 10 + 10; i++) names.push('M' + String(i).padStart(3, '0'));
      const f = (b.filterText || '').toLowerCase();
      return { path: '[default]Many', continuation: n < 30 ? String(n + 1) : null,
        results: names.filter((x) => !f || x.toLowerCase().includes(f)).map((x) => ({ name: x, path: '[default]Many/' + x, type: 'AtomicTag', dataType: 'Float8', trendable: true })) };
    },
  };
  const s = browser({ capabilities: { readScope: { runtimePensAllowed: true, roots: ['[default]'] } },
    handlers: { 'chart.browse': (b) => ({ ok: true, data: typeof pages[b.path] === 'function' ? pages[b.path](b) : pages[b.path] }) } });
  await flush();
  s.tb._toggle('[default]many', true);
  await flush();
  s.tb.setState({ filter: 'm05' });
  s.tb._applyFilter();
  await flush(80);
  const many = s.requests.filter((r) => r.body.path === '[default]Many' && r.body.filterText === 'm05');
  deq(many.map((r) => r.body.continuation || null), [null, '1', '2', '3', '4', '5'], 'pages 0..4 empty, page 5 has M050..M059');
  const v = s.view();
  deq(rowsOf(v).filter((r) => r.props['data-ctg-path']).map((r) => r.props['data-ctg-path'].split('/').pop()).slice(1),
    ['M050', 'M051', 'M052', 'M053', 'M054', 'M055', 'M056', 'M057', 'M058', 'M059']);
  // nothing matches at all: stops after AUTO_PAGES pages, "Load more…" stays
  s.requests.length = 0;
  s.tb.setState({ filter: 'zzz' });
  s.tb._applyFilter();
  await flush(150);
  assert.equal(s.requests.filter((r) => r.body.filterText === 'zzz').length, 21, 'first page + 20 automatic pages');
  assert.ok(rowsOf(s.view()).some((r) => r.props['data-ctg-row'] === 'more'));
});

test('panels re-render only when what they show changed (the chart renders them on every live tick)', () => {
  const s = settings();
  s.sp.render();
  const same = { api: s.api, args: s.sp.props.args, close: () => {} };
  assert.equal(s.sp.shouldComponentUpdate(same, s.sp.state), false, 'a chart tick with nothing new: no render');
  assert.equal(s.sp.shouldComponentUpdate(same, Object.assign({}, s.sp.state)), true, 'own state change');
  s.api.write('axes', [s.P.defaultAxis('A', 'left')]);
  assert.equal(s.sp.shouldComponentUpdate(same, s.sp.state), true, 'props changed');
  const tb = browser();
  tb.tb.render();
  const tsame = { api: tb.api, args: tb.tb.props.args, close: () => {} };
  assert.equal(tb.tb.shouldComponentUpdate(tsame, tb.tb.state), false);
  tb.api.write('pens', [{ tagPath: T + 'Temp' }]);
  assert.equal(tb.tb.shouldComponentUpdate(tsame, tb.tb.state), true, 'charted set changed');
});

test('colour validation never warns per keystroke', () => {
  const s = stub();
  const before = s.env.warnings.length;
  ['#', '#0', '#00a', 'rgb(1,2', 'reddish'].forEach((v) => s.P.validColor(v));
  assert.equal(s.env.warnings.length, before);
});

// -----------------------------------------------------------------------------
// other writers, late replies and tree state
// -----------------------------------------------------------------------------
const subheadPath = (v) => { const n = find(v, (x) => x.props.className === 'ctg-sp-subhead__name')[0]; return n ? n.props.title : null; };

test('the pen editor follows its pen by tag path when another writer removes / reorders pens', async () => {
  const s = settings({ props: { pens: [{ tagPath: T + 'Temp' }, { tagPath: T + 'Pressure' }, { tagPath: T + 'SmallRange' }] } });
  let v = s.view();
  byAttr(v, 'data-ctg-act', 'edit-pen')[1].props.onClick(ev());          // Pressure
  assert.equal(subheadPath(s.view()), T + 'Pressure');
  // another writer (pen table remove, a binding, a script) removes pens[0]
  s.api.write('pens', s.api.props().pens.slice(1));
  v = s.view();
  assert.equal(subheadPath(v), T + 'Pressure', 'still Pressure, not the pen now at its old position');
  field(v, 'name').props.onChange({ target: { value: 'EditedHere' } });
  s.sp.drafts.flush();
  deq(s.api.props().pens.map((p) => [p.tagPath, p.name]), [[T + 'Pressure', 'EditedHere'], [T + 'SmallRange', '']]);
  deq(s.events.pop().payload, { action: 'edit', tagPath: T + 'Pressure', source: 'pens' });
  // reordered: still follows it
  s.api.write('pens', s.api.props().pens.slice().reverse());
  assert.equal(subheadPath(s.view()), T + 'Pressure');
  // removed by someone else: "no longer on the chart", edits change nothing
  const fieldName = field(s.view(), 'name');
  s.api.write('pens', s.api.props().pens.filter((p) => p.tagPath !== T + 'Pressure'));
  v = s.view();
  assert.match(text(v), /This pen is no longer on the chart/);
  assert.equal(byAttr(v, 'data-ctg', 'pen-editor').length, 0);
  const n = s.writes.length, ne = s.events.length;
  fieldName.props.onChange({ target: { value: 'Ghost' } });              // a late keystroke from the old field
  s.sp.drafts.flush();
  assert.equal(s.writes.length, n, 'nothing written');
  assert.equal(s.events.length, ne, 'no edit event');
  deq(s.api.props().pens.map((p) => [p.tagPath, p.name]), [[T + 'SmallRange', '']]);
  // the editor is keyed by the selection, not by the position
  const s2 = settings({ props: { pens: [{ tagPath: T + 'Temp' }, { tagPath: T + 'Pressure' }] } });
  byAttr(s2.view(), 'data-ctg-act', 'edit-pen')[0].props.onClick(ev());
  const k1 = s2.sp.render();
  const keyOf = (node) => find(full(node), (x) => x.props['data-ctg'] === 'pen-editor')[0];
  assert.ok(keyOf(k1));
  s2.sp.set({ view: 'list', sel: null });
  byAttr(s2.view(), 'data-ctg-act', 'edit-pen')[1].props.onClick(ev());
  assert.equal(subheadPath(s2.view()), T + 'Pressure');
  // the pencil entry point resolves p:<raw index> to the pen's identity
  const s3 = settings({ props: { pens: [{ tagPath: T + 'Temp' }, { tagPath: T + 'Pressure' }] } }, { tab: 'pens', penKey: 'p:1' });
  assert.equal(subheadPath(s3.view()), T + 'Pressure');
  s3.api.write('pens', [s3.api.props().pens[1]]);
  assert.equal(subheadPath(s3.view()), T + 'Pressure');
});

test('pending field edits are patches applied at write time; other writers\' changes to the same root survive', async () => {
  // pens: a pending name edit + the tag browser (pens target) adding Pressure in the debounce window
  const s = settings({ props: { pens: [{ tagPath: T + 'Temp' }] } });
  byAttr(s.view(), 'data-ctg-act', 'edit-pen')[0].props.onClick(ev());
  field(s.view(), 'name').props.onChange({ target: { value: 'T1' } });
  s.api.write('pens', s.api.props().pens.concat([s.P.defaultPen(T + 'Pressure')]));
  deq(s.sp.drafts.get('pens').map((p) => [p.tagPath, p.name]), [[T + 'Temp', 'T1'], [T + 'Pressure', '']], 'the panel shows both meanwhile');
  await sleep(s.P.DEBOUNCE_MS + 80);
  deq(s.api.props().pens.map((p) => [p.tagPath, p.name]), [[T + 'Temp', 'T1'], [T + 'Pressure', '']], 'Pressure kept');
  deq(s.events.pop().payload, { action: 'edit', tagPath: T + 'Temp', source: 'pens' });
  // static display fields patch the field only (another writer's colour change on the same pen survives)
  field(s.view(), 'width').props.onChange({ target: { value: '3' } });
  s.api.write('pens', s.api.props().pens.map((p, i) => (i === 0 ? Object.assign({}, p, { color: '#123456' }) : p)));
  s.sp.drafts.flush();
  const temp = s.api.props().pens[0];
  assert.equal(temp.color, '#123456', 'the colour another writer set is kept');
  assert.equal(temp.display.width, 3, 'and the width edit landed');
  // trendPens: a pending override edit + another writer adding an override for another tag
  const t = settings({
    props: { pens: [], trendPens: { defaults: { axis: '', plot: 0, display: { type: 'line' } } } },
    penInfos: [{ key: 't:[default]ctg/temp', source: 'trend', index: null, tagPath: T + 'Temp', name: 'Temp', status: 'ok', meta: {}, trendable: true }],
  }, { tab: 'pens', penKey: 't:[default]ctg/temp' });
  field(t.view(), 'name').props.onChange({ target: { value: 'Temperature' } });
  pick(t.view(), 'type', 'Area');
  const tp = t.api.props().trendPens;
  t.api.write('trendPens', Object.assign({}, tp, { overrides: tp.overrides.concat([Object.assign(t.P.defaultOverride(T + 'Pressure'), { color: '#ff0000' })]) }));
  t.sp.drafts.flush();
  const ov = t.api.props().trendPens.overrides;
  deq(ov.map((o) => [o.tagPath, o.name, o.color]), [[T + 'Pressure', '', '#ff0000'], [T + 'Temp', 'Temperature', '']]);
  assert.equal(ov[1].display.type, 'area', 'display computed at write time from the effective display');
  // axes: a pending label edit + another writer appending an axis (and moving ours)
  const a = settings({ props: { axes: [{ name: 'A1' }] } }, { tab: 'axes' });
  byAttr(a.view(), 'data-ctg-act', 'edit-axis')[0].props.onClick(ev());
  field(a.view(), 'labelText').props.onChange({ target: { value: 'Degrees' } });
  a.api.write('axes', [a.P.defaultAxis('B0', 'left')].concat(a.api.props().axes));
  assert.equal(field(a.view(), 'axisName').props.value, 'A1', 'the axis editor follows its axis by name');
  a.sp.drafts.flush();
  deq(a.api.props().axes.map((x) => [x.name, x.label.text]), [['B0', ''], ['A1', 'Degrees']]);
  // columns: a field patch, not a snapshot of penTable
  const c = settings({}, { tab: 'columns' });
  byAttr(c.view(), 'data-ctg-field', 'columns.units')[0].props.onChange({ target: { checked: false } });
  c.api.write('penTable', Object.assign({}, c.api.props().penTable, { collapsed: true }));
  c.sp.drafts.flush();
  assert.equal(c.api.props().penTable.collapsed, true);
  assert.equal(c.api.props().penTable.columns.units, false);
});

test('DraftStore patches: same id coalesces, gone item = no write, props changed since the write win', async () => {
  const s = stub({ props: { pens: [{ tagPath: T + 'Temp' }] } });
  let now = 1000;
  const flushed = [];
  const d = new s.P.DraftStore(s.api, { now: () => now, onFlush: (ok, w, a) => flushed.push([ok, w, a]) });
  const setName = (v) => (list) => list.map((p) => (p.tagPath === T + 'Temp' ? Object.assign({}, p, { name: v }) : p));
  d.edit('pens', 'n', setName('A'));
  d.edit('pens', 'n', setName('AB'));
  assert.equal(d.ops.pens.length, 1, 'coalesced');
  assert.equal(d.get('pens')[0].name, 'AB');
  d.flush();
  assert.equal(s.writes.length, 1);
  // a patch whose item is gone changes nothing -> no write
  d.edit('pens', 'x', (list) => list.map((p) => (p.tagPath === T + 'Gone' ? Object.assign({}, p, { name: 'x' }) : p)));
  d.flush();
  assert.equal(s.writes.length, 1, 'no-op write skipped');
  deq(flushed[flushed.length - 1], [true, [], ['pens']]);
  // no echo yet (lagging props): the written value is the base; once the props change (another writer) they win
  let props = s.api.props();
  const api2 = { props: () => props, patch: () => true };
  const d2 = new s.P.DraftStore(api2, { now: () => now });
  d2.edit('pens', 'n', setName('Mine'), true);
  assert.equal(d2.get('pens')[0].name, 'Mine', 'echo pending: shows the written value');
  props = s.C.reduceProps({ pens: [{ tagPath: T + 'Temp', name: 'Theirs' }, { tagPath: T + 'Pressure' }] });
  deq(d2.get('pens').map((p) => p.name), ['Theirs', ''], 'the props changed since the write: they win');
});

test('a folder collapsed while filtered is browsed again when the filter changed; Load more keeps its filter', async () => {
  const pages = {
    '': { path: '', continuation: null, results: [{ name: 'Many', path: '[default]Many', type: 'Folder', hasChildren: true }] },
    '[default]Many': (b) => {
      const n = b.continuation ? Number(b.continuation) : 0;
      const names = [];
      for (let i = n * 10; i < n * 10 + 10; i++) names.push('M' + String(i).padStart(3, '0'));
      const f = (b.filterText || '').toLowerCase();
      return { path: '[default]Many', continuation: n < 11 ? String(n + 1) : null,
        results: names.filter((x) => !f || x.toLowerCase().includes(f)).map((x) => ({ name: x, path: '[default]Many/' + x, type: 'AtomicTag', dataType: 'Float8', trendable: true })) };
    },
  };
  const s = browser({ capabilities: { readScope: { runtimePensAllowed: true, roots: ['[default]'] } },
    handlers: { 'chart.browse': (b) => ({ ok: true, data: typeof pages[b.path] === 'function' ? pages[b.path](b) : pages[b.path] }) } });
  await flush();
  s.tb._toggle('[default]many', true);
  await flush();
  s.tb.setState({ filter: 'm05' });
  s.tb._applyFilter();
  await flush(80);
  const tagRows = () => rowsOf(s.view()).filter((r) => r.props['data-ctg-type'] === 'AtomicTag').length;
  assert.equal(tagRows(), 10);
  // "Load more…" with a changed (not yet applied) filter continues the folder's own (filtered) query
  s.tb.setState({ filter: 'zzz' });
  s.requests.length = 0;
  s.tb._load('[default]many', true);
  await flush();
  deq(s.requests[0].body, { path: '[default]Many', limit: 100, continuation: '6', filterText: 'm05' });
  // collapse while filtered, clear the filter, reopen -> browsed again without filterText (all pages again)
  s.tb.setState({ filter: 'm05' });
  s.tb._applyFilter();
  await flush(80);
  s.tb._toggle('[default]many', false);
  s.tb.setState({ filter: '' });
  s.tb._applyFilter();
  await flush();
  s.requests.length = 0;
  s.tb._toggle('[default]many', true);
  await flush();
  deq(s.requests.map((r) => r.body), [{ path: '[default]Many', limit: 100 }]);
  assert.equal(tagRows(), 10, 'first unfiltered page M000..M009');
  assert.ok(rowsOf(s.view()).some((r) => r.props['data-ctg-row'] === 'more'));
  // opening a folder loaded without a filter while a filter is set browses it filtered
  s.tb._toggle('[default]many', false);
  s.tb.setState({ filter: 'm00' });
  s.requests.length = 0;
  s.tb._toggle('[default]many', true);
  await flush();
  deq(s.requests[0].body, { path: '[default]Many', limit: 100, filterText: 'm00' });
});

test('onPensChange fires even when the panel closed before the gateway replied', async () => {
  const s = browser({ props: { tagBrowser: { enabled: true }, pens: [], trendGroup: 'default' } });
  await flush();
  s.tb._toggle('[default]', true); await flush();
  s.tb._toggle('[default]ctg', true); await flush();
  const pending = [];
  const api = Object.assign({}, s.api, { request: (name, body) => (name === 'chart.trendAdd' ? new Promise((res) => pending.push(res)) : s.api.request(name, body)) });
  s.tb.props = Object.assign({}, s.tb.props, { api });
  rowByPath(s.view(), T + 'Temp').props.onClick(ev());
  s.tb._add();
  assert.equal(pending.length, 1);
  s.tb.componentWillUnmount();
  pending[0]({ ok: true, data: { added: [T + 'Temp'], rejected: [], duplicates: [] } });
  await flush();
  deq(s.events.map((e) => e.payload), [{ action: 'add', tagPath: T + 'Temp', source: 'trend' }]);
  // settings: remove from the trend list, panel closed before the reply
  const t = settings({
    props: { pens: [], trendGroup: 'default' },
    penInfos: [{ key: 't:[default]ctg/temp', source: 'trend', index: null, tagPath: T + 'Temp', name: 'Temp', status: 'ok', meta: {}, trendable: true }],
  });
  const pend2 = [];
  t.sp.props = Object.assign({}, t.sp.props, { api: Object.assign({}, t.api, { request: () => new Promise((res) => pend2.push(res)) }) });
  t.sp._removeTrend(T + 'Temp');
  t.sp.componentWillUnmount();
  pend2[0]({ ok: true, data: {} });
  await flush();
  deq(t.events.map((e) => e.payload), [{ action: 'remove', tagPath: T + 'Temp', source: 'trend' }]);
});

test('a new browse identity (gate off -> on, read scope) resets the tree and the selection', async () => {
  const fx = { capabilities: { readScope: { runtimePensAllowed: true, roots: ['[default]CTG'] } } };
  const s = browser(fx);
  await flush();
  s.tb._toggle('[default]', true); await flush();
  s.tb._toggle('[default]ctg', true); await flush();
  rowByPath(s.view(), T + 'Temp').props.onClick(ev());
  assert.equal(Object.keys(s.tb.state.selected).length, 1);
  s.tb.componentDidUpdate();
  assert.ok(rowByPath(s.view(), T + 'Temp'), 'same identity: nothing reset');
  // logout: the gate goes false
  fx.capabilities.tagBrowser = { allowed: false, reason: 'AUTH_REQUIRED' };
  s.tb.componentDidUpdate();
  deq(s.tb.state.selected, {});
  assert.equal(s.tb.tree.root().loaded, false);
  // login again (maybe another user): a fresh root browse, nothing of the previous tree
  fx.capabilities.tagBrowser = { allowed: true, reason: null };
  s.requests.length = 0;
  s.tb.componentDidUpdate();
  s.tb.componentDidUpdate();
  await flush();
  deq(s.requests.map((r) => r.body), [{ path: '', limit: 100 }]);
  assert.equal(rowByPath(s.view(), T + 'Temp'), undefined);
  assert.ok(rowByPath(s.view(), '[default]'));
  // a read-scope change resets too; a reply for the old tree is dropped
  const pending = [];
  s.tb.props = Object.assign({}, s.tb.props, { api: Object.assign({}, s.api, { request: (n, b) => new Promise((res) => pending.push({ b, res })) }) });
  s.tb._toggle('[default]', true);
  fx.capabilities.readScope = { runtimePensAllowed: true, roots: ['[default]Other'] };
  s.tb.componentDidUpdate();
  const tree = s.tb.tree;
  pending[0].res({ ok: true, data: TREE['[default]'] });
  await flush();
  assert.equal(s.tb.tree, tree);
  assert.equal(tree.get('[default]ctg'), null, 'the old reply did not land in the new tree');
});

test('TagTree forgets sub-trees no longer listed (selected nodes kept); row refs bounded', async () => {
  const { P } = stub();
  const tr = new P.TagTree();
  let g = tr.startLoad('', false);
  tr.applyPage('', g, { results: [{ name: 'A', path: '[p]A' }, { name: 'B', path: '[p]B', hasChildren: true }] });
  tr.setExpanded('[p]b', true);
  g = tr.startLoad('[p]b', false);
  tr.applyPage('[p]b', g, { results: [{ name: 'x', path: '[p]B/x' }, { name: 'y', path: '[p]B/y' }] });
  tr.keep = (k) => k === '[p]b/y';
  g = tr.startLoad('', false);
  tr.applyPage('', g, { results: [{ name: 'A', path: '[p]A' }] });
  deq(Object.keys(tr.nodes).sort(), ['', '[p]a', '[p]b/y']);
  // the browser's ref callbacks follow the rows shown
  const s = browser();
  await flush();
  s.tb._toggle('[default]', true); await flush();
  s.tb._toggle('[default]ctg', true); await flush();
  s.view();
  s.tb._rowRef('n:[default]ctg/temp');
  s.tb._toggle('[default]', false);
  s.view();
  assert.equal(s.tb._refFns['n:[default]ctg/temp'], undefined);
});
