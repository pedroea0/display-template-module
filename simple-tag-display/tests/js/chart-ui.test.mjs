// =============================================================================
// chart-ui.test.mjs — the CtgChart component without a browser (SECTION 18)
// =============================================================================
// Renders the component into the _stubs.mjs React stub (plain {type, props,
// children} nodes) with a real ChartEngine behind a fake delegate and a fake
// window.fetch (/v2/history), then drives the rendered handlers directly:
//   - mode radios write interaction.mode (whole object), never in design mode
//   - pen visibility: static pen -> whole `pens` array; trend pen -> whole
//     `trendPens` with an override entry; onPensChange fired
//   - outputs.* written on change only, never in the Designer
//   - banners (reload button), fault rows, toolbar buttons per panel registry
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, FILES } from './_stubs.mjs';

async function flush(n = 40) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

function setup(opts = {}) {
  const env = createEnv();
  env.window.addEventListener = () => {};
  env.window.removeEventListener = () => {};
  const now = Date.now();
  env.window.fetch = (url, init) => {
    const body = JSON.parse(init.body);
    const t = [];
    for (let x = Math.ceil(body.start / 1000) * 1000; x < Math.min(body.end, Date.now()); x += 5000) t.push(x);
    return Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify({
      v: 2, ok: true, requestId: body.requestId, serverNow: Date.now(),
      window: { start: body.start, end: Math.min(body.end, Date.now()), mode: body.mode, aggregation: body.aggregation, bucketMs: body.bucketMs, bucketTime: body.bucketMs ? 'start' : null },
      pens: body.pens.map((p) => ({ key: p.key, tagPath: p.tagPath, status: 'ok', t, v: t.map((x) => 50 + Math.sin(x / 60000) * 40), anchor: null })),
    })) });
  };
  // the chart shell WITHOUT the add-on panel files (ctg-chart-tools.js / ctg-chart-panels.js): the toolbar tests
  // register the panels they need themselves
  for (const f of FILES.filter((x) => !/^ctg-chart-(tools|panels)\.js$/.test(x))) env.load(f, '2.0.0-feedc0de');
  const NS = env.window.__CTG, C = NS.chart;
  const raw = opts.raw || { pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Nope' }], timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } };
  let tree = JSON.parse(JSON.stringify(raw));
  const writes = [];
  const store = {
    name: 'chart', addressPathString: '0:0', view: { page: { sessionProps: { read: (k) => (k === 'locale' ? 'en-US' : k === 'timeZoneId' ? 'UTC' : k === 'device.type' ? 'browser' : null) } } },
    props: { read: (k) => (k in tree ? JSON.parse(JSON.stringify(tree[k])) : undefined), write: (k, v) => { writes.push({ key: k, value: JSON.parse(JSON.stringify(v)) }); tree[k] = v; } },
  };
  const ls = [];
  const source = {
    snap: { pens: opts.penInfos || [
      { key: 'p:0', source: 'pens', index: 0, tagPath: '[default]CTG/Temp', name: 'Temp', status: 'ok', meta: { dataType: 'Float8', engUnit: 'degF', engLow: 0, engHigh: 100 }, trendable: true },
      { key: 'p:1', source: 'pens', index: 1, tagPath: '[default]CTG/Nope', name: 'Nope', status: 'notFound', meta: null, trendable: false },
    ], trend: { group: 'default', paths: [], max: 32 }, limits: { maxPens: 32 }, trendEdit: { allowed: true }, readScope: { runtimePensAllowed: false, roots: [] },
    tagBrowser: { allowed: false, reason: 'ACTION_DISABLED' }, annotations: { allowed: false, editAllowed: false } },
    state: { connected: true }, staleReason: () => null,
    getCreds: () => ({ url: '/data/simpletagdisplay/v2/history', token: 't', expiresAt: 4102444800000 }),
    renewToken: () => Promise.resolve(true), request: () => Promise.resolve({ ok: true, data: {} }),
    on(fn) { ls.push(fn); return () => {}; }, emit(t, p) { ls.forEach((f) => f(t, p)); }, attach() {}, detach() {},
  };
  store.delegate = source;
  const fired = [];
  const mk = () => ({
    store, props: C.reduceProps(tree), delegate: { phase: 'ready', connected: true }, eventsEnabled: opts.design ? false : true,
    componentEvents: { fireComponentEvent: (n, p) => fired.push({ name: n, payload: p }) },
    emit: (o) => ({ className: (o.classes || []).join(' '), style: {} }),
  });
  const comp = new C.CtgChart(mk());
  comp.setState = function (patch, cb) { this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch); if (cb) cb(); };
  comp.forceUpdate = () => {};
  const rerender = () => { const prev = comp.props; comp.props = mk(); comp.componentDidUpdate({ props: prev.props }); return comp.render(); };
  return { env, NS, C, comp, store, writes, fired, source, rerender, tree: () => tree, now };
}

/**
 * Component nodes (ChartErrorBoundary, RenderPart: the guarded parts of the chart) are rendered in place, like
 * React would: the stub's createElement keeps children outside props, so they are passed in as props.children.
 */
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

/** Depth-first search of the React stub tree. */
function find(node, pred, out = []) {
  node = expand(node);
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; }
  if (node.props && pred(node)) out.push(node);
  if (node.children) find(node.children, pred, out);
  if (node.props && node.props.children) find(node.props.children, pred, out);
  return out;
}
const byAttr = (tree, k, v) => find(tree, (n) => n.props[k] === v);
const text = (n) => { const node = expand(n); return (node == null ? '' : typeof node === 'string' || typeof node === 'number' ? String(node) : Array.isArray(node) ? node.map(text).join('') :
  (node.children ? text(node.children) : '') + (node.props && node.props.children ? text(node.props.children) : '')); };

test('toolbar: mode radios write the whole interaction object; design mode writes nothing', async () => {
  const s = setup();
  s.comp.componentDidMount();
  await flush();
  let r = s.comp.render();
  const modes = byAttr(r, 'role', 'radio');
  assert.deepEqual(modes.map((m) => m.props['data-ctg-mode']), ['xTrace', 'pan', 'zoom', 'rangeBrush'], 'annotate hidden without annotations');
  assert.equal(modes[0].props['aria-checked'], 'true');
  modes[1].props.onClick();
  const w = s.writes.find((x) => x.key === 'interaction');
  assert.equal(w.value.mode, 'pan');
  assert.ok('xTrace' in w.value && 'rangeBrush' in w.value, 'whole object');
  r = s.rerender();
  assert.equal(find(r, (n) => n.props.role === 'radio' && n.props['data-ctg-mode'] === 'pan')[0].props['aria-checked'], 'true');
  assert.equal(r.props['data-ctg-mode'], 'pan', 'root carries the mode (cursor CSS)');
  s.comp.componentWillUnmount();

  const d = setup({ design: true });
  d.comp.componentDidMount();
  await flush();
  const rd = d.comp.render();
  const pan = find(rd, (n) => n.props.role === 'radio' && n.props['data-ctg-mode'] === 'pan')[0];
  assert.equal(pan.props.disabled, true);
  pan.props.onClick();
  assert.equal(d.writes.filter((x) => x.key === 'interaction').length, 0, 'no prop writes in design mode');
  d.comp._writeOutputs();
  assert.equal(d.writes.filter((x) => x.key === 'outputs').length, 0, 'no outputs in design mode');
  d.comp.componentWillUnmount();
});

test('pen table: fault row, visibility toggle writes the whole pens array and fires onPensChange', async () => {
  const s = setup();
  s.comp.componentDidMount();
  await flush();
  const r = s.comp.render();
  const rows = byAttr(r, 'data-ctg', 'pen-row');
  assert.equal(rows.length, 2);
  assert.match(rows[1].props.className, /ctg-pen--fault/);
  assert.match(text(rows[1]), /tag not found/);
  assert.equal(rows[0].props['data-history-status'], 'ok');
  const box = find(rows[0], (n) => n.type === 'input' && n.props.type === 'checkbox')[0];
  assert.equal(box.props.checked, true);
  box.props.onChange();
  const w = s.writes.find((x) => x.key === 'pens');
  assert.equal(w.value.length, 2);
  assert.equal(w.value[0].visible, false);
  assert.deepEqual(w.value[1], { tagPath: '[default]CTG/Nope' }, 'the raw array is written back (no defaults added)');
  assert.deepEqual(s.fired.map((f) => [f.name, f.payload.action, f.payload.source]), [['onPensChange', 'edit', 'pens']]);
  const r2 = s.rerender();
  const box2 = find(byAttr(r2, 'data-ctg', 'pen-row')[0], (n) => n.type === 'input')[0];
  assert.equal(box2.props.checked, false);
  s.comp.componentWillUnmount();
});

test('pen table: a trend pen toggles through a trendPens.overrides entry (whole object)', async () => {
  const s = setup({
    raw: { trendGroup: 'default', timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } },
    penInfos: [{ key: 't:[default]ctg/flow', source: 'trend', index: null, tagPath: '[default]CTG/Flow', name: 'Flow', status: 'ok', meta: null, trendable: true }],
  });
  s.comp.componentDidMount();
  await flush();
  const r = s.comp.render();
  find(byAttr(r, 'data-ctg', 'pen-row')[0], (n) => n.type === 'input')[0].props.onChange();
  const w = s.writes.find((x) => x.key === 'trendPens');
  assert.deepEqual(w.value.overrides, [{ tagPath: '[default]CTG/Flow', visible: false }]);
  assert.equal(w.value.nameMode, 'auto', 'whole object written');
  assert.equal(s.fired[0].payload.source, 'trend');
  s.comp.componentWillUnmount();
});

test('outputs.*: written on change only, with range / status / pens; never in the Designer', async () => {
  const s = setup();
  s.comp.componentDidMount();
  await flush();
  s.comp.render();
  s.comp._writeOutputs();
  const outs = s.writes.filter((x) => x.key === 'outputs');
  assert.equal(outs.length, 1);
  const o = outs[0].value;
  assert.deepEqual(Object.keys(o).sort(), ['pens', 'range', 'status']);
  assert.equal(o.status.state, 'live');
  assert.equal(o.range.followLive, true);
  assert.deepEqual(o.pens.map((p) => [p.key, p.status]), [['p:0', 'ok'], ['p:1', 'notFound']]);
  s.comp._writeOutputs();
  s.comp._writeOutputs();
  assert.equal(s.writes.filter((x) => x.key === 'outputs').length, 1, 'unchanged -> no rewrite');
  // Designer (preview): never written
  s.env.window.__client.isDesigner = true;
  s.source.snap.pens[1].status = 'ok';
  s.source.emit('pens');
  await flush();
  s.comp.render();
  s.comp._writeOutputs();
  assert.equal(s.writes.filter((x) => x.key === 'outputs').length, 1);
  s.comp.componentWillUnmount();
});

test('banners and panel buttons: reload banner with a button; registered panels get toolbar buttons', async () => {
  const s = setup();
  s.comp.componentDidMount();
  await flush();
  s.comp.engine._setBanner('reload');
  let r = s.comp.render();
  const b = byAttr(r, 'data-code', 'reload')[0];
  assert.ok(b && /reload the page/i.test(text(b)));
  assert.ok(find(b, (n) => n.type === 'button').length === 1);
  assert.equal(byAttr(r, 'data-ctg-panel', 'export').length, 0, 'no export button before the panel exists');
  s.C.panels.register('export', { render: () => null });
  s.C.panels.register('custom1', { button: { label: 'Custom' }, render: () => null });
  r = s.comp.render();
  assert.equal(byAttr(r, 'data-ctg-panel', 'export').length, 1);
  assert.equal(byAttr(r, 'data-ctg-panel', 'custom1').length, 1);
  assert.equal(byAttr(r, 'data-ctg', 'date-pill')[0].props.disabled, true, 'no dateRange panel -> pill is static');
  s.comp.componentWillUnmount();
});

test("root ref: Perspective's emit() ref is chained, never replaced (store.element), and stable across renders", async () => {
  const s = setup();
  const seen = [];
  const emitRef = (el) => seen.push(el);
  const orig = s.comp.props.emit;
  s.comp.props.emit = (o) => Object.assign(orig(o), { ref: emitRef });
  s.comp.componentDidMount();
  await flush();
  const r1 = s.comp.render();
  const r2 = s.comp.render();
  assert.equal(typeof r1.props.ref, 'function');
  assert.equal(r1.props.ref, r2.props.ref, 'same function each render (no detach/attach churn)');
  const el = { id: 'x' };
  r1.props.ref(el);
  assert.deepEqual(seen, [el], "emit's ref received the element");
  assert.equal(s.comp.root(), el, 'and the chart keeps it too');
  s.comp.componentWillUnmount();
});

// ---- error boundaries, panels and state edge cases -------------------------------------------------------------

/** Depth-first search WITHOUT rendering components (to see the boundaries themselves). */
function findRaw(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => findRaw(n, pred, out)); return out; }
  if (node.props && pred(node)) out.push(node);
  if (node.children) findRaw(node.children, pred, out);
  if (node.props && node.props.children) findRaw(node.props.children, pred, out);
  return out;
}
/** Renders a boundary node in its error state (what React does after getDerivedStateFromError). */
function boundaryInError(node, err) {
  const props = Object.assign({}, node.props, { children: node.children[0] });
  const inst = new node.type(props);
  inst.props = props;
  inst.state = node.type.getDerivedStateFromError(err);
  inst.setState = (x) => { inst.state = Object.assign({}, inst.state, x); };
  return { inst, out: inst.render() };
}
const renderChild = (b) => { const c = b.children[0]; return new c.type(c.props).render(); };

test('error boundaries: toolbar, main, pen table and every panel render inside their own boundary', async () => {
  const s = setup();
  s.comp.componentDidMount();
  await flush();
  s.C.panels.register('vboom', { dock: 'right', render: () => { throw new Error('panel boom'); } });
  s.C.panels.register('vfloat', { render: () => { throw new Error('float boom'); } });
  assert.equal(s.comp.openPanel('vboom', {}), true);
  assert.equal(s.comp.openPanel('vfloat', {}), true);
  const r = s.comp.render();                                   // a throwing panel no longer throws HERE
  const parts = findRaw(r, (n) => typeof n.type === 'function' && 'part' in n.props).map((n) => n.props.part).sort();
  assert.deepEqual(parts, ['main', 'panel:vboom', 'panel:vfloat', 'penTable', 'toolbar']);
  // the panel's render() runs in the boundary's CHILD (RenderPart), i.e. inside the boundary
  const pb = findRaw(r, (n) => n.props.part === 'panel:vboom')[0];
  assert.throws(() => renderChild(pb), /panel boom/);
  // the boundary's fallback: "Panel error" + "Close panel" closes that panel only
  const { out } = boundaryInError(pb, new Error('panel boom'));
  assert.match(text(out), /Panel error: panel boom/);
  const btn = find(out, (n) => n.type === 'button')[0];
  assert.equal(text(btn), 'Close panel');
  btn.props.onClick();
  assert.equal(s.comp.panelOpen('vboom'), false, 'reset closes the failing panel');
  assert.equal(s.comp.panelOpen('vfloat'), true, 'other panels untouched');
  // the chart's own render path: a throwing _renderMain / _renderToolbar / _renderPenTable / view model is caught
  // by the part's boundary, not thrown from CtgChart.render (Perspective's "Component Error")
  const orig = { m: s.comp._renderMain, t: s.comp._renderToolbar, p: s.comp._renderPenTable, v: s.comp._buildVM };
  s.comp._renderMain = () => { throw new Error('main boom'); };
  s.comp._renderToolbar = () => { throw new Error('toolbar boom'); };
  s.comp._renderPenTable = () => { throw new Error('table boom'); };
  const r2 = s.comp.render();
  for (const [part, re] of [['main', /main boom/], ['toolbar', /toolbar boom/], ['penTable', /table boom/]]) {
    const b = findRaw(r2, (n) => n.props.part === part)[0];
    assert.throws(() => renderChild(b), re, part);
    assert.match(text(boundaryInError(b, new Error('x')).out), /Chart error: x.*Reload chart/);
  }
  Object.assign(s.comp, { _renderMain: orig.m, _renderToolbar: orig.t, _renderPenTable: orig.p });
  s.comp._buildVM = () => { throw new Error('vm boom'); };
  const r3 = s.comp.render();
  const mb = findRaw(r3, (n) => n.props.part === 'main')[0];
  assert.throws(() => renderChild(mb), /vm boom/, 'view-model failure lands in the main boundary');
  s.comp._buildVM = orig.v;
  s.comp.componentWillUnmount();
});

test('panel registry: prototype names are never panels', async () => {
  const s = setup();
  s.comp.componentDidMount();
  await flush();
  assert.equal(s.C.panels.get('toString'), null);
  assert.equal(s.C.panels.get('constructor'), null);
  assert.equal(s.C.panels.get('__proto__'), null);
  assert.equal(s.comp.openPanel('toString', {}), false);
  assert.equal(s.comp.api.panels.open('hasOwnProperty'), false);
  assert.equal(s.comp.api.panels.isOpen('toString'), false);
  assert.equal(s.comp.closePanel('toString'), false);
  assert.equal(s.C.panels.register('__proto__', { render: () => null }), false);
  assert.equal(s.C.panels.register('', { render: () => null }), false);
  assert.equal(s.C.panels.register('ok1', { render: () => null }), true);
  assert.ok(!s.C.panels.names().includes('__proto__'));
  assert.equal(s.comp.api.panels.open('ok1'), true);
  assert.equal(s.comp.api.panels.isOpen('ok1'), true);
  s.comp.componentWillUnmount();
});

test('banner text: only retried failures say "retrying"', async () => {
  const s = setup();
  s.comp.componentDidMount();
  await flush();
  const e = s.comp.engine;
  e._setBanner('BAD_REQUEST');
  assert.doesNotMatch(e.banner.message, /retrying/i);
  assert.match(e.banner.message, /History query failed \(BAD_REQUEST\)/);
  e._setBanner('SOME_NEW_CODE');
  assert.doesNotMatch(e.banner.message, /retrying/i);
  e._setBanner('error', { code: 'HISTORY_QUERY_FAILED' });
  assert.match(e.banner.message, /HISTORY_QUERY_FAILED.*retrying/);
  e._setBanner('RANGE_TOO_LARGE');
  assert.match(e.banner.message, /too large/);
  s.comp.componentWillUnmount();
});

test('outputs.status.state: connecting / disconnected map onto the documented values', async () => {
  const s = setup();
  s.comp.componentDidMount();
  await flush();
  s.comp.render();
  const model = s.comp.engine.model.bind(s.comp.engine);
  const states = [];
  for (const st of ['disconnected', 'connecting', 'live']) {
    s.comp.engine.model = () => Object.assign(model(), { state: st });
    s.comp._writeOutputs();
    const o = s.writes.filter((x) => x.key === 'outputs').pop().value.status;
    states.push([st, o.state, o.message]);
  }
  assert.deepEqual(states, [['disconnected', 'stale', 'Disconnected'], ['connecting', 'loading', ''], ['live', 'live', '']]);
  const documented = ['loading', 'live', 'paused', 'historical', 'stale', 'error', 'empty'];
  for (const st of ['connecting', 'loading', 'live', 'paused', 'historical', 'stale', 'disconnected', 'error', 'empty']) {
    s.comp.engine.model = () => Object.assign(model(), { state: st, banner: null });
    s.comp._writeOutputs();
    const o = s.writes.filter((x) => x.key === 'outputs').pop().value.status;
    assert.ok(documented.includes(o.state), `${st} -> ${o.state}`);
  }
  s.comp.componentWillUnmount();
});

test('optimistic overrides: dropped on a failed write, never set without a write, expire when unconfirmed', async () => {
  const s = setup();
  s.comp.componentDidMount();
  await flush();
  const box = (r) => find(byAttr(r, 'data-ctg', 'pen-row')[0], (n) => n.type === 'input')[0];
  // (a) the write fails -> no override, no event
  const write = s.store.props.write;
  s.store.props.write = () => { throw new Error('read-only'); };
  let r = s.comp.render();
  box(r).props.onChange();
  assert.equal(JSON.stringify(s.comp.state.visOverride), JSON.stringify({}), 'failed write: override dropped');
  assert.equal(s.fired.length, 0);
  find(r, (n) => n.props.role === 'radio' && n.props['data-ctg-mode'] === 'pan')[0].props.onClick();
  assert.equal(s.comp.state.modeOverride, null, 'failed mode write: override dropped');
  // (b) nothing to write (raw pens not an array) -> no override
  s.store.props.write = write;
  const read = s.store.props.read;
  s.store.props.read = (k) => (k === 'pens' ? 'oops' : read(k));
  r = s.comp.render();
  box(r).props.onChange();
  assert.equal(JSON.stringify(s.comp.state.visOverride), JSON.stringify({}));
  s.store.props.read = read;
  // (c) the write "succeeds" but a binding puts the old value back: the override expires
  s.store.props.write = (k, v) => { s.writes.push({ key: k, value: v }); };          // tree unchanged = reverted
  r = s.comp.render();
  box(r).props.onChange();
  assert.equal(JSON.stringify(s.comp.state.visOverride), JSON.stringify({ 'p:0': false }));
  s.rerender();
  assert.equal(JSON.stringify(s.comp.state.visOverride), JSON.stringify({ 'p:0': false }), 'props disagree: kept for now');
  assert.equal(box(s.comp.render()).props.checked, false, 'optimistic');
  s.comp._ovAt['p:0'] -= 10000;                                                     // pretend 10 s passed
  await new Promise((res) => setTimeout(res, 1700));
  assert.equal(JSON.stringify(s.comp.state.visOverride), JSON.stringify({}), 'expired');
  assert.equal(box(s.comp.render()).props.checked, true, 'row follows the props again');
  s.comp.componentWillUnmount();
});

test('PlotManager hysteresis state is dropped on a range-epoch change, not kept per epoch', async () => {
  const s = setup();
  const PM = s.C.PlotManager.prototype;
  const fake = { hyst: {}, _hystEpoch: 0, vm: { rangeEpoch: 0 } };
  const rec = { index: 0, pv: { pens: [{ axisKey: 'a0', visible: true, meta: null }] } };
  const ax = { key: 'a0', cfg: { range: { mode: 'auto', includeZero: false, padding: 0.05, min: null, max: null }, scale: 'linear' } };
  const data = [[1, 2, 3], [10, 20, 30]];
  for (let ep = 0; ep < 50; ep++) {
    fake.vm.rangeEpoch = ep;
    PM._yRange.call(fake, rec, ax, data, { min: 0, max: 4 });
  }
  assert.equal(Object.keys(fake.hyst).length, 1, `hyst keys: ${Object.keys(fake.hyst)}`);
  assert.equal(fake._hystEpoch, 49);
});

test('panels: open/close survive a deferred or batched setState', async () => {
  for (const mode of ['deferred', 'batched']) {
    const s = setup();
    s.comp.componentDidMount();
    await flush();
    for (const n of ['pa', 'pb', 'pc']) s.C.panels.register(n, { render: () => null });
    // React-like host: setState is NOT applied synchronously; 'deferred' commits each patch later in order,
    // 'batched' merges every patch of one handler into a single commit (React 18 automatic batching)
    let queue = [];
    s.comp.setState = function (patch, cb) { queue.push({ patch, cb }); };
    const commit = () => {
      const q = queue; queue = [];
      if (mode === 'batched') {
        let next = Object.assign({}, s.comp.state);
        q.forEach(({ patch }) => { next = Object.assign(next, typeof patch === 'function' ? patch(next) : patch); });
        s.comp.state = next;
      } else {
        q.forEach(({ patch }) => { s.comp.state = Object.assign({}, s.comp.state, typeof patch === 'function' ? patch(s.comp.state) : patch); });
      }
      q.forEach(({ cb }) => cb && cb());
    };
    const api = s.comp.api;
    // (A) open + open in one tick: both open; isOpen is true at once (stub parity)
    assert.equal(api.panels.open('pa'), true, mode);
    assert.equal(api.panels.isOpen('pa'), true, `${mode}: isOpen right after open`);
    assert.equal(api.panels.open('pb'), true, mode);
    commit();
    assert.deepEqual(Object.keys(s.comp.state.panels).sort(), ['pa', 'pb'], `${mode}: open+open keeps both`);
    // (B) open + close of the same panel in one tick: close succeeds and the panel ends closed
    assert.equal(api.panels.close('pa'), true, mode);
    assert.equal(api.panels.open('pa'), true, mode);
    assert.equal(api.panels.close('pa'), true, `${mode}: close right after open`);
    assert.equal(api.panels.isOpen('pa'), false, mode);
    commit();
    assert.deepEqual(Object.keys(s.comp.state.panels), ['pb'], `${mode}: open+close leaves it closed`);
    // (C) a swap inside one click handler: close('pb') then open('pc') -> only 'pc'
    assert.equal(s.comp.closePanel('pb'), true, mode);
    assert.equal(api.panels.open('pc', { from: 'pb' }), true, mode);
    commit();
    assert.deepEqual(Object.keys(s.comp.state.panels), ['pc'], `${mode}: close+open swaps`);
    assert.deepEqual(s.comp.state.panels.pc, { from: 'pb' });
    // the toolbar toggle reads the same synchronous map
    s.comp._togglePanel('pc');
    s.comp._togglePanel('pa');
    commit();
    assert.deepEqual(Object.keys(s.comp.state.panels), ['pa'], `${mode}: toggles in one tick`);
    s.comp.componentWillUnmount();
  }
});

test('panels.register: a null-prototype name is refused, never thrown', async () => {
  const s = setup();
  assert.equal(s.C.panels.register(Object.create(null), { render: () => null }), false);
  assert.equal(s.C.panels.register({ toString() { throw new Error('x'); } }, { render: () => null }), false);
  assert.equal(s.C.panels.register(Symbol('p'), { render: () => null }), false);
});

test('design mode: the pen table shows the same action buttons as runtime, disabled, and they do nothing', async () => {
  const s = setup();
  s.comp.componentDidMount();
  await flush();
  const rt = s.comp.render();
  const d = setup({ design: true });
  d.comp.componentDidMount();
  await flush();
  const ds = d.comp.render();
  for (const act of ['pen-remove', 'pen-edit', 'pen-color']) {
    const a = byAttr(rt, 'data-ctg', act), b = byAttr(ds, 'data-ctg', act);
    assert.equal(b.length, a.length, act + ': same buttons as runtime (were hidden in design mode)');
    b.forEach((n) => assert.ok(n.props.disabled, act + ' disabled in design mode'));
  }
  const rm = byAttr(ds, 'data-ctg', 'pen-remove');
  assert.ok(rm.length > 0, 'the static pens have a remove button');
  rm[0].props.onClick({ stopPropagation() {}, currentTarget: null });
  assert.equal(d.writes.filter((x) => x.key === 'pens').length, 0, 'no pen removal in design mode');
  s.comp.componentWillUnmount();
  d.comp.componentWillUnmount();
});
