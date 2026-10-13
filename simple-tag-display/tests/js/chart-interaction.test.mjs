// =============================================================================
// chart-interaction.test.mjs — interaction layer without a browser
// =============================================================================
// The CtgChart component over the _stubs.mjs React stub (as chart-ui.test.mjs),
// a real ChartEngine behind a fake delegate and a fake /v2/history:
//   - pinned X-Trace cursors: whole `interaction` writes, {fromEndMs} while
//     following live, maxTraces, onXTraceChange; never written in the Designer
//   - range brushes: add / change / remove / clear, ids, max, onBrushChange,
//     the pen-table brush view (range columns, statsFor values, exact raw
//     statistics for aggregated data, synchronous Copy stats TSV)
//   - external interaction.* values adopted, the chart's own echo ignored
//   - keyboard pan / zoom / reset; engine.clampView (span kept, no future)
//   - pen-table actions: remove static (confirm) / trend (chart.trendRemove),
//     trendEdit greying, pencil -> settings, colour dot -> color panel;
//     X-Trace / Axis / Plot columns; collapse
//   - fullscreen fallback (maximised) + interaction.fullscreen; narrow toolbar
//     (mode menu, More) and the refresh-rate field
//   - ChartApi after unmount; a stale panel close() never closes a
//     re-opened panel
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, FILES } from './_stubs.mjs';

async function flush(n = 40) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }
const plain = (x) => JSON.parse(JSON.stringify(x));

function setup(opts = {}) {
  const env = createEnv();
  const winListeners = {};
  env.window.addEventListener = (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); };
  env.window.removeEventListener = (t, f) => { winListeners[t] = (winListeners[t] || []).filter((x) => x !== f); };
  env.window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 1);
  env.window.cancelAnimationFrame = (id) => clearTimeout(id);
  const fetches = [];
  env.window.fetch = (url, init) => {
    const body = JSON.parse(init.body);
    fetches.push(body);
    const step = body.mode === 'raw' ? 1000 : (body.bucketMs || 5000);
    const t = [];
    for (let x = Math.ceil(body.start / step) * step; x < Math.min(body.end, Date.now()); x += step) t.push(x);
    return Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify({
      v: 2, ok: true, requestId: body.requestId, serverNow: Date.now(),
      window: { start: body.start, end: Math.min(body.end, Date.now()), mode: body.mode, aggregation: body.aggregation, bucketMs: body.bucketMs, bucketTime: body.bucketMs ? 'start' : null },
      pens: body.pens.map((p) => ({ key: p.key, tagPath: p.tagPath, status: 'ok', t, v: t.map((x) => (opts.valueFn ? opts.valueFn(x, p.tagPath) : 50 + Math.sin(x / 60000) * 40)),
        anchor: body.includeAnchor ? { t: body.start - 500, v: 7 } : null })),
    })) });
  };
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  const NS = env.window.__CTG, C = NS.chart;
  const raw = opts.raw || { pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Pressure' }],
    timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } };
  let tree = JSON.parse(JSON.stringify(raw));
  const writes = [];
  const store = {
    name: 'chart', addressPathString: '0:0', view: { page: { sessionProps: { read: (k) => (k === 'locale' ? 'en-US' : k === 'timeZoneId' ? 'UTC' : k === 'device.type' ? 'browser' : null) } } },
    props: { read: (k) => (k in tree ? JSON.parse(JSON.stringify(tree[k])) : undefined), write: (k, v) => { writes.push({ key: k, value: JSON.parse(JSON.stringify(v)) }); tree[k] = v; } },
  };
  const ls = [];
  const requests = [];
  const source = {
    snap: { pens: opts.penInfos || [
      { key: 'p:0', source: 'pens', index: 0, tagPath: '[default]CTG/Temp', name: 'Temp', status: 'ok', meta: { dataType: 'Float8', engUnit: 'degF', engLow: 0, engHigh: 100 }, trendable: true },
      { key: 'p:1', source: 'pens', index: 1, tagPath: '[default]CTG/Pressure', name: 'Pressure', status: 'ok', meta: { dataType: 'Float8', engUnit: 'psi', engLow: 0, engHigh: 300 }, trendable: true },
    ], trend: { group: 'default', paths: [], max: 32 }, limits: { maxPens: 32 }, trendEdit: opts.trendEdit || { allowed: true },
    readScope: { runtimePensAllowed: true, roots: [] }, tagBrowser: { allowed: false, reason: 'ACTION_DISABLED' }, annotations: { allowed: false, editAllowed: false } },
    state: { connected: true }, staleReason: () => null, values: {},
    getCreds: () => ({ url: '/data/simpletagdisplay/v2/history', token: 't', expiresAt: 4102444800000 }),
    renewToken: () => Promise.resolve(true),
    request: (name, body) => { requests.push({ name, body }); return Promise.resolve(opts.reply ? opts.reply(name, body) : { ok: true, data: {} }); },
    on(fn) { ls.push(fn); return () => {}; }, emit(t, p) { ls.forEach((f) => f(t, p)); }, attach() {}, detach() {},
  };
  store.delegate = source;
  const fired = [];
  const mk = () => ({
    store, props: C.reduceProps(tree), delegate: { phase: 'ready', connected: true }, eventsEnabled: opts.design ? false : true,
    componentEvents: { fireComponentEvent: (n, p) => fired.push({ name: n, payload: JSON.parse(JSON.stringify(p)) }) },
    emit: (o) => ({ className: (o.classes || []).join(' '), style: {} }),
  });
  const comp = new C.CtgChart(mk());
  comp.setState = function (patch, cb) { this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch); if (cb) cb(); };
  comp.forceUpdate = () => {};
  const rerender = () => { const prev = comp.props; comp.props = mk(); comp.componentDidUpdate({ props: prev.props }); return comp.render(); };
  const setTree = (k, v) => { tree[k] = v; };
  return { env, NS, C, comp, store, writes, fired, source, rerender, requests, fetches, setTree, tree: () => tree, winListeners };
}
async function mounted(opts) {
  const s = setup(opts);
  s.comp.componentDidMount();
  await flush();
  s.comp.render();
  return s;
}

/** React-stub helpers (as chart-ui.test.mjs): components render in place. */
function expand(node) {
  while (node && typeof node === 'object' && typeof node.type === 'function' && node.type.prototype && node.type.prototype.render) {
    const kids = node.children || [];
    const props = Object.assign({}, node.props, { children: kids.length <= 1 ? kids[0] : kids });
    const inst = new node.type(props);
    inst.props = props;
    if (!inst.state) inst.state = {};
    node = inst.render();
  }
  return node;
}
function find(node, pred, out = []) {
  node = expand(node);
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; }
  if (node.props && pred(node)) out.push(node);
  if (node.children) find(node.children, pred, out);
  if (node.props && node.props.children) find(node.props.children, pred, out);
  return out;
}
/** Search WITHOUT rendering components (to find NS.ui.Menu / Confirm / Popover elements themselves). */
function findRaw(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => findRaw(n, pred, out)); return out; }
  if (node.props && pred(node)) out.push(node);
  if (node.children) findRaw(node.children, pred, out);
  if (node.props && node.props.children) findRaw(node.props.children, pred, out);
  if (typeof node.type === 'function' && node.type.prototype && node.type.prototype.render && !pred(node)) {
    // guarded parts (ChartErrorBoundary / RenderPart): look inside their render output
    const kids = node.children || [];
    const props = Object.assign({}, node.props, { children: kids.length <= 1 ? kids[0] : kids });
    if (node.type.name === 'RenderPart' || node.type.name === 'ChartErrorBoundary') {
      const inst = new node.type(props); inst.props = props; if (!inst.state) inst.state = {};
      findRaw(inst.render(), pred, out);
    }
  }
  return out;
}
const byAttr = (tree, k, v) => find(tree, (n) => n.props[k] === v);
const text = (n) => { const node = expand(n); return (node == null ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') :
  (node.children ? text(node.children) : '') + (node.props && node.props.children ? text(node.props.children) : '')); };
const lastWrite = (s, k) => s.writes.filter((w) => w.key === k).pop();

// ---- X-Trace pins ------------------------------------------------------------------------------------------------
test('X-Trace pins: whole interaction writes, {fromEndMs} while following live, maxTraces, onXTraceChange', async () => {
  const s = await mounted();
  const ix = s.comp.ix;
  const vp = s.comp.engine.viewport.get();
  assert.equal(vp.followLive, true);
  const t1 = vp.max - 60000;
  assert.equal(ix.pin(t1), true);
  const w = lastWrite(s, 'interaction').value;
  assert.ok('mode' in w && 'rangeBrush' in w && 'panAndZoom' in w, 'the whole interaction object');
  assert.equal(w.xTrace.values.length, 1);
  assert.ok(Math.abs(w.xTrace.values[0].fromEndMs - 60000) < 50, 'live: relative to the right edge');
  assert.equal(w.xTrace.values[0].time, undefined);
  const ev = s.fired.filter((f) => f.name === 'onXTraceChange').pop();
  assert.equal(ev.payload.count, 1);
  assert.equal(typeof ev.payload.times, 'string');
  assert.ok(Math.abs(Number(ev.payload.times) - t1) < 50);
  // max 4 by default
  for (let i = 2; i <= 5; i++) ix.pin(vp.max - i * 60000);
  assert.equal(ix.traces.length, 4);
  // a paused (historical-like) view stores absolute times
  s.comp.engine.viewport.set({ min: vp.min - 3600000, max: vp.max - 3000000 });
  ix.removeTrace(0);
  const before = ix.traces.length;
  ix.pin(vp.max - 3100000);
  assert.equal(ix.traces.length, before + 1);
  assert.ok(ix.traces[ix.traces.length - 1].time != null, 'not following live: {time}');
  assert.equal(lastWrite(s, 'interaction').value.xTrace.values.length, 4);
  s.comp.componentWillUnmount();
});

test('X-Trace pins and brushes are never written in the Designer (local state only)', async () => {
  const s = await mounted();
  s.env.window.__client.isDesigner = true;
  const n = s.writes.length;
  const vp = s.comp.engine.viewport.get();
  s.comp.ix.pin(vp.max - 1000);
  s.comp.ix.addBrush({ start: vp.min, end: vp.min + 60000, plot: 0 });
  assert.equal(s.writes.length, n, 'no prop writes in the Designer');
  assert.equal(s.comp.ix.traces.length, 1);
  assert.equal(s.comp.ix.brushes.length, 1);
  s.comp.componentWillUnmount();
});

test('external interaction values are adopted; the chart\'s own echo is not re-applied', async () => {
  const s = await mounted();
  const ix = s.comp.ix;
  const vp = s.comp.engine.viewport.get();
  ix.pin(vp.max - 30000);
  const own = ix.traces.slice();
  s.rerender();                                            // the echo of the chart's own write
  assert.deepEqual(plain(ix.traces), plain(own));
  const it = s.store.props.read('interaction');
  it.xTrace.values = [{ time: vp.min + 1000 }, { time: vp.min + 2000 }];
  it.rangeBrush.values = [{ id: 'b7', start: vp.min, end: vp.min + 5000, plot: 0 }, { start: vp.min + 6000, end: vp.min + 9000 }];
  s.setTree('interaction', it);
  s.rerender();
  assert.deepEqual(plain(ix.traces.map((x) => x.time)), [Math.round(vp.min + 1000), Math.round(vp.min + 2000)]);
  assert.deepEqual(plain(ix.brushes.map((b) => b.id)), ['b7', 'b8'], 'a missing id is generated');
  s.comp.componentWillUnmount();
});

// ---- brushes + brush view --------------------------------------------------------------------------------------------
test('range brushes: add / change / remove / clear, ids, max, onBrushChange, whole writes', async () => {
  const s = await mounted({ raw: { pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Pressure' }], interaction: { mode: 'rangeBrush', rangeBrush: { max: 2 } },
    timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } } });
  const ix = s.comp.ix;
  const vp = s.comp.engine.viewport.get();
  const b1 = ix.addBrush({ start: vp.min + 60000, end: vp.min + 180000, plot: 0 });
  assert.equal(b1.id, 'b1');
  const b2 = ix.addBrush({ start: vp.min + 200000, end: vp.min + 260000, plot: 0 });
  assert.equal(b2.id, 'b2');
  assert.equal(ix.addBrush({ start: vp.min, end: vp.min + 1000, plot: 0 }), null, 'max 2');
  ix.updateBrush({ id: 'b1', start: vp.min + 70000, end: vp.min + 190000 });
  ix.removeBrush('b2');
  assert.deepEqual(plain(s.fired.filter((f) => f.name === 'onBrushChange').map((f) => [f.payload.id, f.payload.action])), [['b1', 'add'], ['b2', 'add'], ['b1', 'change'], ['b2', 'remove']]);
  const w = lastWrite(s, 'interaction').value;
  assert.deepEqual(w.rangeBrush.values, [{ id: 'b1', start: Math.round(vp.min + 70000), end: Math.round(vp.min + 190000), plot: 0 }]);
  assert.equal(w.rangeBrush.max, 2, 'the whole rangeBrush object');
  ix.clearBrushes();
  assert.equal(lastWrite(s, 'interaction').value.rangeBrush.values.length, 0);
  assert.equal(s.fired.filter((f) => f.name === 'onBrushChange').pop().payload.action, 'remove');
  s.comp.componentWillUnmount();
});

test('brush view: range columns replace the window stats; values = statsFor over the brushed range; Copy stats TSV', async () => {
  const s = await mounted({ raw: { pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Pressure', name: '=SUM(A1)' }],
    query: { mode: 'raw' }, interaction: { mode: 'rangeBrush', rangeBrush: { exactStats: true } }, penTable: { rangeColumns: { count: true } },
    timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } } });
  await flush();
  const ix = s.comp.ix;
  const vp = s.comp.engine.viewport.get();
  const a = Math.round(vp.min + 120000), b = Math.round(vp.min + 420000);
  ix.addBrush({ start: a, end: b, plot: 0 });
  let r = s.comp.render();
  const bar = byAttr(r, 'data-ctg', 'brush-bar')[0];
  assert.ok(bar, 'brush bar');
  assert.match(text(byAttr(r, 'data-ctg', 'brush-summary')[0]), /Range 1 · .* – .* · 5 m 0 s/);
  const head = find(byAttr(r, 'data-ctg', 'pen-table')[0], (n) => n.type === 'th').map(text);
  assert.ok(head.includes('First') && head.includes('UCL') && head.includes('Count') && !head.includes('Current'), JSON.stringify(head));
  // raw data: no exact request needed, stats from the loaded data
  assert.equal(s.fetches.filter((f) => f.mode === 'raw' && f.start === a && f.end === b).length, 0);
  const view = s.comp.engine.penView('p:0');
  const ref = s.C.statsFor(view, a, b, { median: true, sigma: 3, method: 'stdDev', lastKnownTime: view.t[view.t.length - 1] > b ? b : null });
  const row = byAttr(r, 'data-ctg-key', 'p:0').filter((n) => n.type === 'tr')[0];
  const cells = find(row, (n) => n.type === 'td' && n.props['data-col']);
  const cell = (id) => text(cells.find((c) => c.props['data-col'] === id));
  assert.equal(cell('count'), String(ref.count));
  assert.equal(cell('median'), s.C.formatPenValue(ref.median, s.comp._pens[0], 'en-US'));
  assert.equal(cell('ucl'), s.C.formatPenValue(ref.ucl, s.comp._pens[0], 'en-US'));
  // Copy stats: synchronous writeText, TSV with full-precision numbers, formula-looking names quoted
  let copied = null;
  s.env.window.navigator = { clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } };
  const copy = byAttr(r, 'data-ctg', 'brush-copy')[0];
  assert.equal(copy.props.disabled, false);
  copy.props.onClick();
  assert.ok(copied, 'written in the click handler');
  const lines = copied.trim().split('\n');
  assert.equal(lines[0].split('\t')[0], 'Pen');
  assert.ok(lines[0].includes('UCL'));
  assert.equal(lines[1].split('\t')[0], 'Temp');
  assert.equal(Number(lines[1].split('\t')[lines[0].split('\t').indexOf('UCL')]), ref.ucl, 'full precision');
  assert.equal(lines[2].split('\t')[0], "'=SUM(A1)", 'formula injection guard');
  // Clear removes them all and leaves the brush view
  byAttr(r, 'data-ctg', 'brush-clear')[0].props.onClick();
  r = s.comp.render();
  assert.equal(byAttr(r, 'data-ctg', 'brush-bar').length, 0);
  s.comp.componentWillUnmount();
});

test('brush view with aggregated data: ONE exact raw request for the brush, Copy disabled until it is in, no ≈ after', async () => {
  const s = await mounted({ raw: { pens: [{ tagPath: '[default]CTG/Temp' }], query: { mode: 'aggregated' },
    interaction: { mode: 'rangeBrush' }, timeRange: { realtime: { value: 8, unit: 'hours' }, refreshRate: 0 } } });
  await flush();
  assert.equal(s.comp.engine.penData('p:0').approx, true, 'aggregated');
  const ix = s.comp.ix;
  const vp = s.comp.engine.viewport.get();
  const a = Math.round(vp.max - 1800000), b = Math.round(vp.max - 1200000);
  ix.addBrush({ start: a, end: b, plot: 0 });
  let r = s.comp.render();
  assert.equal(byAttr(r, 'data-ctg', 'brush-copy')[0].props.disabled, true, 'Copy waits for the exact stats');
  await new Promise((res) => setTimeout(res, 300));       // the page queue spaces a chart's requests (minIntervalMs + 20)
  await flush();
  const exact = s.fetches.filter((f) => f.mode === 'raw' && f.start === a && f.end === b);
  assert.equal(exact.length, 1, 'one raw request for the brush');
  assert.equal(exact[0].onTooManyPoints, 'aggregate');
  r = s.comp.render();
  assert.equal(byAttr(r, 'data-ctg', 'brush-copy')[0].props.disabled, false);
  const row = byAttr(r, 'data-ctg-key', 'p:0').filter((n) => n.type === 'tr')[0];
  const first = find(row, (n) => n.type === 'td' && n.props['data-col'] === 'first')[0];
  assert.doesNotMatch(text(first), /≈/, 'exact');
  s.comp.render();
  await flush();
  assert.equal(s.fetches.filter((f) => f.mode === 'raw' && f.start === a && f.end === b).length, 1, 'cached per brush');
  s.comp.componentWillUnmount();
});

// ---- keyboard / viewport --------------------------------------------------------------------------------------------
test('keyboard: arrows pan 10 % (Shift 50 %), +/- zoom, Home resets; clampView keeps the span and the present', async () => {
  const s = await mounted({ raw: { pens: [{ tagPath: '[default]CTG/Temp' }], timeRange: { mode: 'historical', historical: { startDate: Date.now() - 7200000, endDate: Date.now() - 3600000 } } } });
  const e = s.comp.engine;
  const key = (k, shift) => { const ev = { key: k, shiftKey: !!shift, preventDefault() {}, stopPropagation() {} }; return s.comp.ix.key(ev); };
  const v0 = e.viewport.get();
  const span = v0.max - v0.min;
  assert.equal(key('ArrowLeft'), true);
  let v = e.viewport.get();
  assert.ok(Math.abs(v.min - (v0.min - 0.1 * span)) < 2);
  key('ArrowRight', true);
  v = e.viewport.get();
  assert.ok(Math.abs(v.min - (v0.min + 0.4 * span)) < 2);
  key('+');
  v = e.viewport.get();
  assert.ok(Math.abs((v.max - v.min) - span / 1.5) < 2);
  key('Home');
  v = e.viewport.get();
  assert.ok(Math.abs(v.min - v0.min) < 1000 && Math.abs(v.max - v0.max) < 1000, 'reset to the configured window');
  // clampView: min span 1 s (10 x minBucketMs), never a window that starts in the future, focal point kept
  const c1 = e.clampView({ min: 1000000, max: 1000100, focal: 1000050 });
  assert.equal(c1.max - c1.min, 1000);
  assert.ok(Math.abs((c1.min + c1.max) / 2 - 1000050) < 1);
  const now = Date.now();
  const c2 = e.clampView({ min: now + 3600000, max: now + 7200000 });
  assert.ok(c2.min < now && c2.max <= now + 60000);
  assert.equal(key('q'), false, 'other keys are not handled');
  s.comp.componentWillUnmount();
});

test('design mode: no keyboard, no pins (gestures off)', async () => {
  const s = await mounted({ design: true });
  const ev = { key: 'ArrowLeft', preventDefault() {}, stopPropagation() {} };
  assert.equal(s.comp.ix.key(ev), false);
  assert.equal(s.comp.canInteract(), false);
  const r = s.comp.render();
  const plot = byAttr(r, 'data-ctg', 'plot')[0];
  assert.equal(plot.props.tabIndex, undefined, 'not focusable in design mode');
  assert.equal(plot.props.role, 'img');
  s.comp.componentWillUnmount();
});

// ---- pen table ---------------------------------------------------------------------------------------------------------
test('pen table: X-Trace / Axis / Plot columns; collapse toggles the body', async () => {
  const s = await mounted({ raw: { pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Pressure', plot: 1 }], plots: [{}, {}],
    penTable: { columns: { xTrace: true, axis: true, plot: true } }, timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } } });
  let r = s.comp.render();
  const head = find(byAttr(r, 'data-ctg', 'pen-table')[0], (n) => n.type === 'th').map(text);
  assert.ok(head.includes('X-Trace') && head.includes('Axis') && head.includes('Plot'), JSON.stringify(head));
  const cellsOf = (key) => find(byAttr(r, 'data-ctg-key', key).filter((n) => n.type === 'tr')[0], (n) => n.type === 'td' && n.props['data-col']);
  const c0 = cellsOf('p:0'), c1 = cellsOf('p:1');
  assert.equal(text(c0.find((c) => c.props['data-col'] === 'plot')), '1');
  assert.equal(text(c1.find((c) => c.props['data-col'] === 'plot')), '2');
  assert.match(text(c0.find((c) => c.props['data-col'] === 'axis')), /Auto \(left\)/);
  assert.equal(text(c0.find((c) => c.props['data-col'] === 'xTrace')), '—', 'no cursor, no pin');
  const vp = s.comp.engine.viewport.get();
  s.comp.ix.pin(vp.max - 120000);
  r = s.comp.render();
  const xt = text(cellsOf('p:0').find((c) => c.props['data-col'] === 'xTrace'));
  assert.match(xt, /^\d/, 'value at the first pinned trace: ' + xt);
  // collapse: header only
  const toggle = byAttr(r, 'data-ctg', 'pen-table-toggle')[0];
  assert.equal(toggle.props['aria-expanded'], 'true');
  toggle.props.onClick();
  r = s.comp.render();
  assert.equal(byAttr(r, 'data-ctg', 'pen-row').length, 0);
  assert.equal(byAttr(r, 'data-ctg', 'pen-table')[0].props['data-collapsed'], 'true');
  s.comp.componentWillUnmount();
});

test('pen table: remove a static pen after the confirm -> whole pens array, onPensChange', async () => {
  const s = await mounted();
  let r = s.comp.render();
  const rm = byAttr(byAttr(r, 'data-ctg-key', 'p:0').filter((n) => n.type === 'tr')[0], 'data-ctg', 'pen-remove')[0];
  assert.ok(rm, 'remove button');
  rm.props.onClick({ stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ left: 1, top: 2, right: 3, bottom: 4, width: 2, height: 2 }) } });
  assert.equal(s.comp.state.confirm.penKey, 'p:0');
  r = s.comp.render();
  const cf = findRaw(r, (n) => n.type === s.NS.ui.Confirm)[0];
  assert.ok(cf, 'NS.ui.Confirm');
  assert.match(cf.props.text, /Remove Temp\?/);
  assert.equal(s.writes.filter((w) => w.key === 'pens').length, 0, 'nothing before the confirmation');
  cf.props.onConfirm();
  const w = lastWrite(s, 'pens').value;
  assert.deepEqual(w, [{ tagPath: '[default]CTG/Pressure' }]);
  assert.deepEqual(plain(s.fired.filter((f) => f.name === 'onPensChange').map((f) => f.payload)), [{ action: 'remove', tagPath: '[default]CTG/Temp', source: 'pens' }]);
  assert.equal(s.comp.state.confirm, null);
  s.comp.componentWillUnmount();
});

test('pen table: a trend pen is removed with chart.trendRemove; trendEdit not allowed -> disabled with the reason', async () => {
  const trend = [{ key: 't:[default]ctg/flow', source: 'trend', index: null, tagPath: '[default]CTG/Flow', name: 'Flow', status: 'ok', meta: null, trendable: true }];
  const s = await mounted({ raw: { trendGroup: 'g', penTable: { confirmRemove: false }, timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } }, penInfos: trend });
  let r = s.comp.render();
  byAttr(r, 'data-ctg', 'pen-remove')[0].props.onClick({ stopPropagation() {}, currentTarget: null });
  await flush();
  assert.deepEqual(plain(s.requests.filter((q) => q.name === 'chart.trendRemove')), [{ name: 'chart.trendRemove', body: { tagPath: '[default]CTG/Flow' } }]);
  assert.deepEqual(plain(s.fired.map((f) => [f.name, f.payload.source])), [['onPensChange', 'trend']]);
  s.comp.componentWillUnmount();

  const d = await mounted({ raw: { trendGroup: 'g', timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } }, penInfos: trend,
    trendEdit: { allowed: false, reason: 'FORBIDDEN_ROLE' } });
  r = d.comp.render();
  const btn = byAttr(r, 'data-ctg', 'pen-remove')[0];
  assert.equal(btn.props.disabled, true);
  assert.ok(btn.props.title && btn.props.title.length > 3, 'reason as the tooltip: ' + btn.props.title);
  d.comp.componentWillUnmount();

  const e = await mounted({ raw: { trendGroup: 'g', penTable: { confirmRemove: false }, timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } }, penInfos: trend,
    reply: () => ({ ok: false, error: { code: 'FORBIDDEN_ROLE', message: 'no' } }) });
  r = e.comp.render();
  byAttr(r, 'data-ctg', 'pen-remove')[0].props.onClick({ stopPropagation() {} });
  await flush();
  assert.equal(e.fired.length, 0, 'no event when the gateway refused');
  e.comp.componentWillUnmount();
});

test('pen table: pencil -> Settings at that pen, colour dot -> ColorPicker (when registered); hidden when !enabled', async () => {
  const s = await mounted();
  const opened = [];
  s.C.panels.register('settings', { dock: 'right', render: (api, args) => { opened.push(['settings', plain(args)]); return null; } });
  s.C.panels.register('color', { render: (api, args) => { opened.push(['color', plain(args)]); return null; } });
  let r = s.comp.render();
  const row = byAttr(r, 'data-ctg-key', 'p:1').filter((n) => n.type === 'tr')[0];
  const ev = { stopPropagation() {}, currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 20, right: 30, bottom: 40, width: 20, height: 20 }) } };
  byAttr(row, 'data-ctg', 'pen-edit')[0].props.onClick(ev);
  byAttr(row, 'data-ctg', 'pen-color')[0].props.onClick(ev);
  assert.deepEqual(plain(s.comp.state.panels.settings), { tab: 'pens', penKey: 'p:1', anchorRect: { left: 10, top: 20, right: 30, bottom: 40, width: 20, height: 20 }, source: 'penTable' });
  assert.equal(s.comp.state.panels.color.penKey, 'p:1');
  s.comp.componentWillUnmount();

  const d = await mounted({ raw: { enabled: false, pens: [{ tagPath: '[default]CTG/Temp' }], timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } } });
  r = d.comp.render();
  assert.equal(byAttr(r, 'data-ctg', 'pen-remove').length + byAttr(r, 'data-ctg', 'pen-edit').length + byAttr(r, 'data-ctg', 'pen-color').length, 0);
  assert.equal(find(byAttr(r, 'data-ctg', 'pen-row')[0], (n) => n.type === 'input')[0].props.disabled, false, 'viewing (show/hide) stays');
  d.comp.componentWillUnmount();
});

// ---- fullscreen, narrow, refresh rate --------------------------------------------------------------------------------------
test('fullscreen: no Fullscreen API -> maximised + interaction.fullscreen; Esc leaves; a binding enters it', async () => {
  const s = await mounted();
  s.comp._rootEl = {};                                            // no requestFullscreen
  let r = s.comp.render();
  byAttr(r, 'data-ctg', 'fullscreen')[0].props.onClick();
  assert.equal(s.comp.state.fs, 'max');
  r = s.comp.render();
  assert.match(r.props.className, /ctg-chart--maximised/);
  assert.equal(lastWrite(s, 'interaction').value.fullscreen, true);
  s.rerender();                                                     // own echo: nothing happens
  assert.equal(s.comp.state.fs, 'max');
  (s.winListeners.keydown || []).forEach((f) => f({ key: 'Escape' }));
  assert.equal(s.comp.state.fs, 'off');
  assert.equal(lastWrite(s, 'interaction').value.fullscreen, false);
  s.rerender();
  // a binding sets it
  const it = s.store.props.read('interaction');
  it.fullscreen = true;
  s.setTree('interaction', it);
  s.rerender();
  assert.equal(s.comp.state.fs, 'max', 'binding -> maximised (no user gesture for the API)');
  s.comp.componentWillUnmount();
});

test('narrow layout: mode menu button + More menu (secondary items, refresh rate); refresh-rate field validates', async () => {
  const s = await mounted({ raw: { pens: [{ tagPath: '[default]CTG/Temp' }], toolbar: { buttons: { refreshRate: true } },
    timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 1000 } } });
  s.comp.setState({ narrow: true, rootW: 400, rootH: 300 });
  let r = s.comp.render();
  assert.equal(byAttr(r, 'role', 'radio').length, 0, 'no radio group in narrow');
  const mb = byAttr(r, 'data-ctg', 'mode-menu')[0];
  assert.ok(mb && mb.props['aria-haspopup'] === 'menu');
  const anchor = { currentTarget: { getBoundingClientRect: () => ({ left: 5, top: 5, right: 25, bottom: 25, width: 20, height: 20 }) }, detail: 1 };
  mb.props.onClick(anchor);
  r = s.comp.render();
  let menu = findRaw(r, (n) => n.type === s.NS.ui.Menu)[0];
  assert.deepEqual(plain(menu.props.items.map((i) => i.id)), ['mode-xTrace', 'mode-pan', 'mode-zoom', 'mode-rangeBrush']);
  menu.props.items[1].onSelect();
  assert.equal(lastWrite(s, 'interaction').value.mode, 'pan');
  menu.props.onClose();
  r = s.comp.render();
  byAttr(r, 'data-ctg', 'more')[0].props.onClick(anchor);
  r = s.comp.render();
  menu = findRaw(r, (n) => n.type === s.NS.ui.Menu)[0];
  const ids = menu.props.items.map((i) => i.id);
  // FILES loads the real add-on parts: ctg-chart-tools.js registers `export`
  // (dock none, chart-supplied button) and ctg-chart-panels.js registers
  // `settings`, so the More menu lists them too (as in a live chart: Refresh,
  // Reset, Export, Settings, Fullscreen, Refresh rate). `tagBrowser` stays
  // out: the fixture's snapshot refuses it (ACTION_DISABLED).
  assert.deepEqual(plain(ids), ['refresh', 'reset', 'export', 'settings', 'fullscreen', 'refreshRate'], JSON.stringify(ids));
  menu.props.items.find((i) => i.id === 'refreshRate').onSelect();
  r = s.comp.render();
  const pop = findRaw(r, (n) => n.type === s.NS.ui.Popover)[0];
  assert.ok(pop, 'refresh-rate popover');
  // the form: draft committed on submit; 100 -> 250, 0 -> off, junk / too large -> inline error, no write
  const form = new s.C.RefreshRateForm({ value: 1000, onCommit: (v) => s.comp._setRefreshRate(v) });
  form.setState = function (p) { this.state = Object.assign({}, this.state, p); };
  const commit = (d) => { form.state.draft = d; form.commit(); return form.state.error; };
  assert.equal(commit('100'), null);
  assert.equal(lastWrite(s, 'timeRange').value.refreshRate, 250);
  assert.equal(lastWrite(s, 'timeRange').value.realtime.value, 15, 'the whole timeRange object');
  assert.equal(commit('0'), null);
  assert.equal(lastWrite(s, 'timeRange').value.refreshRate, 0);
  const n = s.writes.length;
  assert.ok(commit('abc'));
  assert.ok(commit('-5'));
  assert.ok(commit('4000000'));
  assert.equal(s.writes.length, n, 'invalid drafts write nothing');
  s.comp.componentWillUnmount();
});

test('narrow pen table: compact rows (Current), a row expands to the other columns and its actions', async () => {
  const s = await mounted();
  s.comp.setState({ narrow: true, rootW: 400, rootH: 600 });
  let r = s.comp.render();
  const head = find(byAttr(r, 'data-ctg', 'pen-table')[0], (n) => n.type === 'th').map(text);
  assert.ok(head.includes('Current') && !head.includes('Min'), JSON.stringify(head));
  byAttr(r, 'data-ctg', 'pen-expand')[0].props.onClick({ stopPropagation() {} });
  r = s.comp.render();
  const det = byAttr(r, 'data-ctg', 'pen-details')[0];
  assert.ok(det);
  assert.match(text(det), /Min.*Max.*Avg/);
  assert.equal(byAttr(det, 'data-ctg', 'pen-remove').length, 1);
  s.comp.componentWillUnmount();
});

// ---- ChartApi after unmount, stale close() -------------------------------------------------------------------------------
test('ChartApi members after unmount answer without throwing', async () => {
  const s = await mounted();
  const api = s.comp.api;
  s.comp.componentWillUnmount();
  assert.deepEqual(plain(api.viewport.get()), { min: null, max: null, followLive: false, span: 0 });
  assert.deepEqual(plain(api.viewport.set({ min: 1, max: 2 })), { min: null, max: null, followLive: false, span: 0 });
  assert.deepEqual(plain(api.viewport.reset()), { min: null, max: null, followLive: false, span: 0 });
  assert.deepEqual(plain(api.series.rows({ source: 'visible' })), { header: [], rows: [] });
  assert.deepEqual(plain(await api.history.fetchRaw({ start: 1, end: 2 })), { pens: [], error: 'DETACHED' });
  assert.deepEqual(plain(api.pens()), []);
  assert.deepEqual(plain(api.axesInUse()), []);
  assert.equal(api.plots.snapshot({}), null);
  assert.equal(api.write('pens', []), false);
  assert.equal(api.fireEvent('onPensChange', {}), false);
  assert.equal(api.panels.open('x'), false);
  assert.equal((await api.request('chart.browse', {})).error.code, 'DETACHED');
  assert.equal(api.status().state, 'connecting');
  assert.ok(api.capabilities());
});

test('a stale close() of an earlier opening never closes the re-opened panel', async () => {
  const s = await mounted();
  const closes = [];
  s.C.panels.register('px', { render: (api, args, close) => { closes.push(close); return null; } });
  s.comp.openPanel('px', {});
  find(s.comp.render(), () => false);                     // renders the panel (its render() gets close)
  const stale = closes[closes.length - 1];
  stale();
  assert.equal(s.comp.panelOpen('px'), false, 'its own close works');
  s.comp.openPanel('px', {});
  find(s.comp.render(), () => false);
  stale();
  assert.equal(s.comp.panelOpen('px'), true, 'the stale close is a no-op for the new opening');
  closes[closes.length - 1]();
  assert.equal(s.comp.panelOpen('px'), false);
  s.comp.openPanel('px', {});
  assert.equal(s.comp.api.panels.close('px'), true, 'api.panels.close(name) is not bound to an opening');
  s.comp.componentWillUnmount();
});

// ---- helpers ----------------------------------------------------------------------------------------------------------------
test('normalizers and small helpers', () => {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  const C = env.window.__CTG.chart;
  assert.deepEqual(plain(C.normTraces([{ time: 5.4 }, { fromEndMs: 10 }, { time: null }, null, 'x', { time: 'a' }])),
    [{ time: 5, fromEndMs: null }, { time: null, fromEndMs: 10 }]);
  assert.deepEqual(plain(C.normBrushes([{ id: 'b2', start: 10, end: 5, plot: 9 }, { id: 'b2', start: 1, end: 2 }, { start: 3, end: 3 }], 8)),
    [{ id: 'b2', start: 5, end: 10, plot: 7 }, { id: 'b3', start: 1, end: 2, plot: 0 }]);
  assert.equal(C.durationText(749000), '12 m 29 s');
  assert.equal(C.durationText(2 * 3600000 + 5 * 60000), '2 h 5 m');
  assert.equal(C.durationText(3 * 86400000 + 3600000), '3 d 1 h');
  assert.equal(C.tsvCell('=1+1'), "'=1+1");
  assert.equal(C.tsvCell('a\tb\nc'), 'a b c');
  assert.equal(C.traceKind({ drawType: 'line', interp: 'linear', isBool: false }), 'linear');
  assert.equal(C.traceKind({ drawType: 'line', interp: 'stepAfter', isBool: false }), 'step');
  assert.equal(C.traceKind({ drawType: 'line', interp: 'linear', isBool: true }), 'step');
  assert.equal(C.traceKind({ drawType: 'scatter', interp: 'linear', isBool: false }), 'nearest');
});

// ---- pen removal, gestures, pointers, exact brush stats --------------------------------------------------------------
const THREE = [
  { key: 'p:0', source: 'pens', index: 0, tagPath: '[default]CTG/Temp', name: 'Temp', status: 'ok', meta: null, trendable: true },
  { key: 'p:1', source: 'pens', index: 1, tagPath: '[default]CTG/Pressure', name: 'Pressure', status: 'ok', meta: null, trendable: true },
  { key: 'p:2', source: 'pens', index: 2, tagPath: '[default]CTG/SmallRange', name: 'SmallRange', status: 'ok', meta: null, trendable: true },
];
const threeRaw = (extra) => Object.assign({ pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Pressure' }, { tagPath: '[default]CTG/SmallRange' }],
  timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } }, extra);
const rowOf = (r, key) => byAttr(r, 'data-ctg-key', key).filter((n) => n.type === 'tr')[0];
const rmBtn = (r, key) => byAttr(rowOf(r, key), 'data-ctg', 'pen-remove')[0];
const fakeRec = () => ({ index: 0, u: { over: { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 300 }),
  setPointerCapture() {}, releasePointerCapture() {}, style: {} } } });

test('two removals before chart.pens arrives remove exactly the two pens clicked (index re-checked by tag)', async () => {
  const s = await mounted({ raw: threeRaw({ penTable: { confirmRemove: false } }), penInfos: THREE });
  const r = s.comp.render();
  const tempBtn = rmBtn(r, 'p:0'), presBtn = rmBtn(r, 'p:1');      // both from the same (pre-removal) render
  tempBtn.props.onClick({ stopPropagation() {} });
  presBtn.props.onClick({ stopPropagation() {} });                  // stale PenVM: its index 1 now names SmallRange
  assert.deepEqual(plain(lastWrite(s, 'pens').value), [{ tagPath: '[default]CTG/SmallRange' }]);
  assert.deepEqual(plain(s.fired.filter((f) => f.name === 'onPensChange').map((f) => f.payload.tagPath)), ['[default]CTG/Temp', '[default]CTG/Pressure']);
  // until the gateway's pens push, the rows of the removed pens are disabled (their PenVMs describe the old set)
  const r2 = s.comp.render();
  assert.equal(rowOf(r2, 'p:0').props['data-removing'], 'true');
  assert.equal(rowOf(r2, 'p:1').props['data-removing'], 'true');
  assert.equal(rowOf(r2, 'p:2').props['data-removing'], undefined);
  assert.equal(rmBtn(r2, 'p:0').props.disabled, true);
  rmBtn(r2, 'p:0').props.onClick({ stopPropagation() {} });         // a third click on a removing row does nothing
  assert.equal(s.writes.filter((w) => w.key === 'pens').length, 2);
  // the push arrives: SmallRange is now p:0, no row is "removing"
  s.source.snap = Object.assign({}, s.source.snap, { pens: [Object.assign({}, THREE[2], { key: 'p:0', index: 0 })] });
  s.source.emit('pens');
  await flush();
  const r3 = s.rerender();
  assert.equal(rowOf(r3, 'p:0').props['data-removing'], undefined);
  assert.equal(s.comp._removing.length, 0);
  s.comp.componentWillUnmount();
});

test('a pen no longer in `pens` is refused (no write); same-tag pens are told apart by name / aggregation', async () => {
  const s = await mounted({ raw: threeRaw({ penTable: { confirmRemove: false } }), penInfos: THREE });
  const r = s.comp.render();
  s.setTree('pens', [{ tagPath: '[default]CTG/Pressure' }]);       // changed elsewhere (a binding) since the last push
  rmBtn(r, 'p:0').props.onClick({ stopPropagation() {} });
  assert.equal(s.writes.filter((w) => w.key === 'pens').length, 0, 'nothing removed');
  assert.equal(s.fired.length, 0);
  s.comp.componentWillUnmount();
  const C = s.C;
  const raw = [{ tagPath: 'A', aggregation: 'Average' }, { tagPath: 'b' }, { tagPath: 'a', name: 'Max A', aggregation: 'Maximum' }];
  assert.equal(C.staticPenIndex(raw, { tagPath: 'b', index: 0 }), 1, 'index stale -> by tag');
  assert.equal(C.staticPenIndex(raw, { tagPath: 'A', index: 0, penRef: { name: 'Max A', aggregation: 'Maximum' } }), 2, 'same tag: by name + aggregation');
  assert.equal(C.staticPenIndex(raw, { tagPath: 'A', index: 2, penRef: { name: '', aggregation: 'Average' } }), 0);
  assert.equal(C.staticPenIndex(raw, { tagPath: 'A', index: 0, penRef: { name: 'x', aggregation: 'Sum' } }), -1, 'ambiguous -> refused');
  assert.equal(C.staticPenIndex([{ tagPath: 'a' }, { tagPath: 'a' }], { tagPath: 'A', index: 1, penRef: { name: '', aggregation: 'default' } }), 1, 'identical entries: its own index');
  assert.equal(C.staticPenIndex(raw, { tagPath: 'zzz', index: 1 }), -1);
});

test('the confirm is bound to the pen (tag), not to its row key; it closes when that pen is gone', async () => {
  const s = await mounted({ raw: threeRaw(), penInfos: THREE });
  let r = s.comp.render();
  rmBtn(r, 'p:1').props.onClick({ stopPropagation() {}, currentTarget: null });
  // the pen set shifts under the open confirm (another client removed Temp): Pressure is now p:0
  s.setTree('pens', [{ tagPath: '[default]CTG/Pressure' }, { tagPath: '[default]CTG/SmallRange' }]);
  s.source.snap = Object.assign({}, s.source.snap, { pens: [Object.assign({}, THREE[1], { key: 'p:0', index: 0 }), Object.assign({}, THREE[2], { key: 'p:1', index: 1 })] });
  s.source.emit('pens');
  await flush();
  r = s.rerender();
  const cf = findRaw(r, (n) => n.type === s.NS.ui.Confirm)[0];
  assert.ok(cf, 'still open');
  assert.match(cf.props.text, /Remove Pressure\?/, 'still names the pen it was opened for: ' + cf.props.text);
  cf.props.onConfirm();
  assert.deepEqual(plain(lastWrite(s, 'pens').value), [{ tagPath: '[default]CTG/SmallRange' }]);
  // a confirm whose pen disappears closes
  r = s.comp.render();
  rmBtn(r, 'p:1').props.onClick({ stopPropagation() {}, currentTarget: null });
  assert.ok(s.comp.state.confirm);
  s.setTree('pens', [{ tagPath: '[default]CTG/Flow' }]);
  s.source.snap = Object.assign({}, s.source.snap, { pens: [{ key: 'p:0', source: 'pens', index: 0, tagPath: '[default]CTG/Flow', name: 'Flow', status: 'ok', meta: null, trendable: true }] });
  s.source.emit('pens');
  await flush();
  r = s.rerender();
  assert.equal(findRaw(r, (n) => n.type === s.NS.ui.Confirm).length, 0);
  await new Promise((res) => setTimeout(res, 5));
  assert.equal(s.comp.state.confirm, null);
  s.comp.componentWillUnmount();
});

test('a plot rebuilt during a gesture drops the gesture and its preview; Reset and lost capture end a gesture', async () => {
  const s = await mounted({ raw: threeRaw({ interaction: { mode: 'pan' } }), penInfos: THREE });
  const ix = s.comp.ix, e = s.comp.engine;
  const rec = fakeRec();
  ix.recs.set(rec, { offs: [], box: null, rows: new Map() });
  const vp = e.viewport.get();
  ix._down(rec, { pointerType: 'mouse', button: 0, pointerId: 1, clientX: 500, clientY: 100, isPrimary: true, preventDefault() {} });
  ix._move(rec, { pointerType: 'mouse', pointerId: 1, clientX: 700, clientY: 100 });
  ix._frame();
  assert.ok(ix.preview && ix.g, 'a pan preview runs');
  assert.ok(ix.preview.max < vp.max - 1000, 'dragged into the past');
  ix.detach(rec);                                            // the PlotManager destroys this plot (a pen joined)
  assert.equal(ix.g, null);
  assert.equal(ix.preview, null, 'no left-over preview (it would pause the slide and win in _buildVM)');
  assert.equal(ix.pointers.size, 0);
  assert.ok(Math.abs(s.comp._buildVM(e.model()).viewport.max - e.viewport.get().max) < 100, 'the engine view, not the drag');
  // Reset while a gesture runs
  ix.recs.set(rec, { offs: [], box: null, rows: new Map() });
  ix._down(rec, { pointerType: 'mouse', button: 0, pointerId: 2, clientX: 500, clientY: 100, isPrimary: true, preventDefault() {} });
  ix._move(rec, { pointerType: 'mouse', pointerId: 2, clientX: 800, clientY: 100 });
  ix._frame();
  assert.ok(ix.preview);
  s.comp._resetZoom();
  assert.equal(ix.g, null);
  assert.equal(ix.preview, null);
  // lost pointer capture without a pointerup = cancel
  ix._down(rec, { pointerType: 'mouse', button: 0, pointerId: 3, clientX: 500, clientY: 100, isPrimary: true, preventDefault() {} });
  assert.ok(ix.g);
  ix._cancel({ pointerId: 3 });
  assert.equal(ix.g, null);
  s.comp.componentWillUnmount();
});

test('pointers are registered only for a gesture; a primary touch clears stale entries (no fake pinch)', async () => {
  const s = await mounted({ raw: threeRaw({ interaction: { mode: 'pan' } }), penInfos: THREE });
  const ix = s.comp.ix;
  const rec = fakeRec();
  ix.recs.set(rec, { offs: [], box: null, rows: new Map() });
  const down = (id, x, primary) => ix._down(rec, { pointerType: 'touch', pointerId: id, clientX: x, clientY: 100, isPrimary: primary, preventDefault() {} });
  down(10, 300, true);
  ix.g = null;                                               // a touch whose pointerup never arrived: its entry stayed
  assert.equal(ix.pointers.size, 1);
  down(11, 500, true);                                       // a new single touch (primary): no pinch
  assert.equal(ix.g && ix.g.kind, 'pan');
  assert.equal(ix.pointers.size, 1);
  down(12, 700, false);                                      // a real second finger starts a pinch
  assert.equal(ix.g && ix.g.kind, 'pinch');
  ix.cancelGesture();
  ix.pointers.clear();
  s.setTree('interaction', { mode: 'annotate' });
  s.rerender();
  down(13, 300, true);                                       // annotate: a gesture of one pointer
  assert.equal(ix.pointers.size, 1);
  // this chart offers no annotation editing (annotations off), so 'annotate' acts as X-Trace
  // (chart-live-view-and-export.test.mjs covers the mode with editing offered)
  assert.equal(ix.g && ix.g.kind, 'traceClick');
  ix.cancelGesture();
  s.comp.componentWillUnmount();
});

test('exact brush stats retry a busy answer, are cached per brush, and Copy marks approximate rows', async () => {
  const s = await mounted({ raw: { pens: [{ tagPath: '[default]CTG/Temp' }], query: { mode: 'aggregated' },
    interaction: { mode: 'rangeBrush' }, timeRange: { realtime: { value: 8, unit: 'hours' }, refreshRate: 0 } } });
  await flush();
  const e = s.comp.engine, ix = s.comp.ix;
  const calls = [];
  let fail = 1;
  const paint = () => { const r = s.comp.render(); find(r, () => false); return r; };   // the pen table renders when expanded
  const real = e.fetchRaw.bind(e);
  e.fetchRaw = (o) => { calls.push(o); if (fail-- > 0) return Promise.resolve({ pens: [{ key: 'p:0', t: [], v: [], status: 'error' }], error: 'HTTP_429' }); return real(o); };
  const vp = e.viewport.get();
  const a = Math.round(vp.max - 1800000), b = Math.round(vp.max - 1200000);
  ix.addBrush({ start: a, end: b, plot: 0 });
  paint();
  await flush();
  assert.equal(calls.length, 1);
  let r = s.comp.render();
  assert.equal(byAttr(r, 'data-ctg', 'brush-copy')[0].props.disabled, true, 'still loading while it retries');
  await new Promise((res) => setTimeout(res, 1400));           // backoff 1 s, then the queue spacing
  await flush();
  assert.equal(calls.length, 2, 'retried once');
  r = s.comp.render();
  assert.equal(byAttr(r, 'data-ctg', 'brush-copy')[0].props.disabled, false);
  assert.doesNotMatch(text(find(rowOf(r, 'p:0'), (n) => n.type === 'td' && n.props['data-col'] === 'first')[0]), /≈/);
  // a second brush, then back to the first: not fetched again
  ix.addBrush({ start: a - 3600000, end: b - 3600000, plot: 0 });
  paint();
  await new Promise((res) => setTimeout(res, 300));
  await flush();
  assert.equal(calls.length, 3);
  ix.selectBrush(ix.brushes[0].id);
  paint();
  await flush();
  assert.equal(calls.length, 3, 'cached per brush');
  // a non-retryable failure: approximate, marked in the brush bar and in the TSV
  e.fetchRaw = (o) => { calls.push(o); return Promise.resolve({ pens: [{ key: 'p:0', t: [], v: [], status: 'error' }], error: 'ACCESS_DENIED' }); };
  ix.addBrush({ start: a - 7200000, end: b - 7200000, plot: 0 });
  paint();
  await flush();
  assert.equal(calls.length, 4, 'not retried');
  r = s.comp.render();
  assert.ok(byAttr(r, 'data-ctg', 'brush-exact-failed')[0], 'note in the brush bar');
  let copied = null;
  s.env.window.navigator = { clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } };
  byAttr(r, 'data-ctg', 'brush-copy')[0].props.onClick();
  const lines = String(copied || '').trim().split('\n').map((l) => l.split('\t'));
  assert.equal(lines[0][lines[0].length - 1], 'Approximate', JSON.stringify(lines));
  assert.match(lines[1][lines[1].length - 1], /^yes/);
  s.comp.componentWillUnmount();
});

// ---- exact brush stats: pen reorder, transient failures --------------------------------------------------------------
const TWO_AGG = () => ({ raw: { pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Pressure' }], query: { mode: 'aggregated' },
  interaction: { mode: 'rangeBrush' }, timeRange: { realtime: { value: 8, unit: 'hours' }, refreshRate: 0 } },
  valueFn: (x, tag) => (/Temp/.test(tag) ? 10 + ((x / 1000) % 7) : 200 + ((x / 1000) % 11)) });
const exactCount = (s) => s.fetches.filter((f) => f.mode === 'raw').length;

test('exact brush stats follow the TAG after a pen reorder (no swapped numbers, no refetch)', async () => {
  const s = await mounted(TWO_AGG());
  await flush();
  const e = s.comp.engine, ix = s.comp.ix;
  assert.equal(e.penData('p:0').approx, true);
  const vp = e.viewport.get();
  const a = Math.round(vp.max - 1800000), b = Math.round(vp.max - 1200000);
  ix.addBrush({ start: a, end: b, plot: 0 });
  s.comp._brushView(s.comp.props.props);
  await new Promise((res) => setTimeout(res, 300));
  await flush();
  assert.equal(exactCount(s), 1);
  const before = s.comp._brushView(s.comp.props.props);
  assert.equal(before.loading, false);
  const temp = plain(before.stats['p:0']), pres = plain(before.stats['p:1']);
  assert.equal(temp.approx, false, 'exact');
  assert.ok(temp.average < 100 && pres.average > 100, JSON.stringify([temp.average, pres.average]));
  // reorder (a settings-panel drag / a binding): Pressure becomes p:0, Temp p:1
  s.setTree('pens', [{ tagPath: '[default]CTG/Pressure' }, { tagPath: '[default]CTG/Temp' }]);
  s.source.snap = Object.assign({}, s.source.snap, { pens: [
    Object.assign({}, s.source.snap.pens[1], { key: 'p:0', index: 0 }), Object.assign({}, s.source.snap.pens[0], { key: 'p:1', index: 1 })] });
  s.source.emit('pens');
  await flush();
  s.rerender();
  await new Promise((res) => setTimeout(res, 300));
  await flush();
  assert.match(s.comp._pens[0].tagPath, /Pressure/);
  const after = s.comp._brushView(s.comp.props.props);
  await flush();
  assert.deepEqual(plain(after.stats['p:0']), pres, 'Pressure row = Pressure numbers');
  assert.deepEqual(plain(after.stats['p:1']), temp, 'Temp row = Temp numbers');
  assert.equal(exactCount(s), 1, 'same tags: the cached exact answer is reused');
  // remove Temp and add another tag that lands on the same row key p:1 -> fetched for that tag, never Temp's numbers
  s.setTree('pens', [{ tagPath: '[default]CTG/Pressure' }, { tagPath: '[default]CTG/SmallRange' }]);
  s.source.snap = Object.assign({}, s.source.snap, { pens: [s.source.snap.pens[0],
    { key: 'p:1', source: 'pens', index: 1, tagPath: '[default]CTG/SmallRange', name: 'SmallRange', status: 'ok', meta: null, trendable: true }] });
  s.source.emit('pens');
  await flush();
  s.rerender();
  await new Promise((res) => setTimeout(res, 400));
  await flush();
  const mid = s.comp._brushView(s.comp.props.props);
  // unconditional: the new pen on p:1 IS aggregated, so the remove + add half always runs
  assert.ok(s.comp.engine.penData('p:1'), 'the new pen has data');
  assert.equal(s.comp.engine.penData('p:1').approx, true, 'the new pen on p:1 is aggregated (needs exact stats)');
  if (!mid.loading) assert.notDeepEqual(plain(mid.stats['p:1']), temp, 'not Temp\'s exact numbers');
  await new Promise((res) => setTimeout(res, 400));
  await flush();
  const fin = s.comp._brushView(s.comp.props.props);
  assert.equal(fin.loading, false);
  assert.ok(exactCount(s) >= 2, 'a new exact request for the new pen set');
  assert.notDeepEqual(plain(fin.stats['p:1']), temp);
  s.comp.componentWillUnmount();
});

// The per-pen status decides (a timeout is transient, a per-pen 'error' definitive) and the TTL retry is a timer
test('a transiently failed exact entry is not cached (next selection fetches); a refusal stays cached', async () => {
  const s = await mounted({ raw: { pens: [{ tagPath: '[default]CTG/Temp' }], query: { mode: 'aggregated' },
    interaction: { mode: 'rangeBrush' }, timeRange: { realtime: { value: 8, unit: 'hours' }, refreshRate: 0 } } });
  await flush();
  const e = s.comp.engine, ix = s.comp.ix;
  const calls = [];
  let answer = { pens: [{ key: 'p:0', t: [], v: [], status: 'timeout' }] };     // a transient per-pen answer, no top-level code
  const ttl = s.C.EXACT.failedTtlMs;
  s.C.EXACT.failedTtlMs = 60;
  e.fetchRaw = (o) => { calls.push(o); return Promise.resolve(answer); };
  const view = () => s.comp._brushView(s.comp.props.props);
  const vp = e.viewport.get();
  const a = Math.round(vp.max - 1800000), b = Math.round(vp.max - 1200000);
  try {     // the shared EXACT timing is restored even when an assertion fails
  ix.addBrush({ start: a, end: b, plot: 0 });
  view(); await flush();
  assert.equal(calls.length, 1);
  assert.equal(view().exactFailed, true);
  view(); await flush();
  assert.equal(calls.length, 1, 'no refetch storm while the same brush stays selected');
  ix.addBrush({ start: a - 3600000, end: b - 3600000, plot: 0 });
  view(); await flush();
  assert.equal(calls.length, 2);
  ix.selectBrush(ix.brushes[0].id);
  view(); await flush();
  assert.equal(calls.length, 3, 'the failed brush is fetched again on reselection');
  // expiry while selected: the TTL timer drops the entry and re-renders by itself (the next render fetches again)
  let renders = 0;
  s.comp.forceUpdate = () => { renders++; };
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(s.comp._exact, null, 'the failed entry was dropped by the TTL timer');
  assert.ok(renders >= 1, 'the timer re-renders without any other render');
  view(); await flush();
  assert.equal(calls.length, 4, 'tried again after EXACT.failedTtlMs');
  } finally { s.C.EXACT.failedTtlMs = ttl; }
  // a definitive refusal stays (no request per selection)
  answer = { pens: [{ key: 'p:0', t: [], v: [], status: 'error' }], error: 'ACCESS_DENIED' };
  ix.addBrush({ start: a - 7200000, end: b - 7200000, plot: 0 });
  view(); await flush();
  assert.equal(calls.length, 5);
  ix.selectBrush(ix.brushes[0].id);
  view(); await flush();
  const n = calls.length;
  ix.selectBrush(ix.brushes[2].id);
  view(); await flush();
  assert.equal(calls.length, n, 'refusal cached per brush');
  assert.equal(view().exactFailed, true);
  s.comp.componentWillUnmount();
});
