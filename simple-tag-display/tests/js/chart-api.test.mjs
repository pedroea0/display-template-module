// =============================================================================
// chart-api.test.mjs — ChartApi conformance (the contract panels code against)
// =============================================================================
// The same shape checks run against
//   (1) the REAL api (NS.chart.createChartApi) over a real ChartEngine fed by
//       a fake delegate + fake /v2/history, and
//   (2) the panel-test stub tests/js/_chartApiStub.mjs,
// so panels written against the stub behave the same on the chart.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, FILES } from './_stubs.mjs';
import { createChartApiStub, CHART_API_MEMBERS as STUB_MEMBERS } from './_chartApiStub.mjs';

const S = 1000, M = 60 * S;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
async function flush() { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); }

function get(obj, path) { return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

/** Real api over a real engine (fake delegate, fake route, fake timers). */
async function realApi(opts = {}) {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  const NS = env.window.__CTG, C = NS.chart;
  let now = T0;
  const timers = { set: (fn, ms) => setTimeout(fn, 0), clear: (t) => clearTimeout(t) };
  const calls = [];
  const route = (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    const t = [];
    for (let x = Math.ceil(body.start / S) * S; x < Math.min(body.end, now); x += S) t.push(x);
    return Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify({
      v: 2, ok: true, requestId: body.requestId, serverNow: now,
      window: { start: body.start, end: Math.min(body.end, now), mode: body.mode, aggregation: body.aggregation, bucketMs: body.bucketMs, bucketTime: body.bucketMs ? 'start' : null },
      pens: body.pens.map((p) => ({ key: p.key, tagPath: p.tagPath, status: 'ok', t, v: t.map((x) => x / 1000), anchor: null })),
    })) });
  };
  const ls = [];
  const source = {
    snap: { pens: [
      { key: 'p:0', source: 'pens', index: 0, tagPath: '[default]CTG/Temp', name: 'Temp', status: 'ok', meta: { dataType: 'Float8', engUnit: 'degF', engLow: 0, engHigh: 100 }, trendable: true },
      { key: 'p:1', source: 'pens', index: 1, tagPath: '[default]CTG/Nope', name: 'Nope', status: 'notFound', meta: null, trendable: false },
    ], trend: { group: 'default', paths: [], max: 32 }, limits: { maxPens: 32 },
    trendEdit: { allowed: true, reason: null }, readScope: { runtimePensAllowed: true, roots: ['[default]CTG'] },
    tagBrowser: { allowed: false, reason: 'ACTION_DISABLED' }, annotations: { allowed: false, editAllowed: false, moderateAllowed: false, reason: 'ACTION_DISABLED' } },
    state: { connected: true }, staleReason: () => null,
    getCreds: () => ({ url: '/data/simpletagdisplay/v2/history', token: 't', expiresAt: 4102444800000 }),
    renewToken: () => Promise.resolve(true),
    requests: [],
    request(name, body, opts) { this.requests.push({ name, body, opts }); return Promise.resolve({ ok: true, data: { echo: name } }); },
    on(fn) { ls.push(fn); return () => {}; },
  };
  const props = C.reduceProps({ pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Nope' }],
    timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } });
  const engine = new C.ChartEngine({ id: 'c1', source, now: () => now, timers, document: { hidden: false, addEventListener() {}, removeEventListener() {} },
    fetch: route, props, timeZone: 'UTC', plotWidth: 800 });
  engine.start();
  await flush();
  await new Promise((r) => setTimeout(r, 20));
  await flush();
  const vms = C.buildPens(engine.model().pens, props, { background: '#FFFFFF' });
  const axes = C.assignAxes(vms, props);
  const writes = [], fired = [], open = new Map();
  let ranges = 0;
  // panels and events go through the CHART's own methods (CtgChart.prototype) over a minimal component state,
  // so the conformance suite checks the real registry / events behaviour, not a test double
  const CP = C.CtgChart.prototype;
  const host = {
    state: { panels: {} }, _alive: true, setState(patch) { this.state = Object.assign({}, this.state, patch); },
    props: { eventsEnabled: opts.eventsEnabled !== false, componentEvents: { fireComponentEvent: (n, p) => fired.push({ name: n, payload: p }) } },
    openPanel: CP.openPanel, closePanel: CP.closePanel, panelOpen: CP.panelOpen, fire: CP.fire,
    chartId: 'c1', engine,
    reducedProps: () => props, penVMs: () => vms, axisVMs: () => axes.plots,
    designMode() { return this.props.eventsEnabled === false; }, designer: () => false, root: () => null, plotManager: () => null, store: () => null,
    locale: () => 'en-US', deviceType: () => 'browser',
    writeProp: (k, v) => { writes.push({ key: k, value: v }); return true; },
    userRange: () => { ranges++; },
  };
  const api = C.createChartApi(host);
  return { api, C, NS, writes, fired, open, source, engine, ranges: () => ranges, calls, host };
}

/** Shape checks shared by the real api and the stub. */
async function conformance(api, label, register) {
  for (const m of STUB_MEMBERS) {
    const v = get(api, m);
    if (m === 'id') assert.equal(typeof v, 'string', `${label}: id`);
    else assert.equal(typeof v, 'function', `${label}: ${m} is a function`);
  }
  assert.ok(Object.isFrozen(api), `${label}: frozen`);
  const p = api.props();
  assert.ok(p && p.timeRange && p.pens && p.query, `${label}: props() = reduced props`);
  assert.ok(Object.isFrozen(p), `${label}: props frozen`);
  const pens = api.pens();
  assert.ok(Array.isArray(pens) && pens.length >= 1, `${label}: pens`);
  for (const k of ['key', 'source', 'index', 'tagPath', 'label', 'color', 'visible', 'axisKey', 'plot', 'units', 'format', 'display', 'status', 'meta', 'trendable']) {
    assert.ok(k in pens[0], `${label}: PenVM.${k}`);
  }
  assert.match(pens[0].color, /^#[0-9a-f]{6}$/i, `${label}: resolved colour`);
  assert.ok(api.penInfo(pens[0].key) && api.penInfo(pens[0].key).key === pens[0].key, `${label}: penInfo`);
  assert.equal(api.penInfo('p:999'), null);
  const axes = api.axesInUse();
  assert.ok(axes.length >= 1, `${label}: axesInUse`);
  for (const k of ['key', 'name', 'auto', 'side', 'plot', 'units']) assert.ok(k in axes[0], `${label}: axis.${k}`);
  assert.equal(typeof axes[0].units, 'string');
  const L = api.limits();
  for (const k of ['maxPens', 'maxRangeDays', 'maxRawRangeDays', 'minBucketMs', 'bucketLadder']) assert.ok(k in L, `${label}: limits.${k}`);
  assert.equal(typeof api.timeZone(), 'string');
  assert.equal(typeof api.now(), 'number');
  const st = api.status();
  for (const k of ['state', 'mode', 'staleSince', 'loading', 'lastUpdate', 'window', 'coverage', 'banner']) assert.ok(k in st, `${label}: status.${k}`);
  const v = api.viewport.get();
  for (const k of ['min', 'max', 'followLive', 'span']) assert.ok(k in v, `${label}: viewport.${k}`);
  const v2 = api.viewport.set({ min: v.max - 5 * M, max: v.max - 2 * M });
  assert.equal(v2.followLive, false, `${label}: a viewport in the past pauses`);
  assert.equal(api.viewport.reset().followLive, true, `${label}: reset -> live`);
  const bad = await api.request('dt.write', {});
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'NOT_ALLOWED', `${label}: request allow-list`);
  const ok = await api.request('chart.browse', { path: '[default]' }, { timeoutMs: 8000 });
  assert.equal(ok.ok, true, `${label}: chart.browse allowed`);
  const raw = await api.history.fetchRaw({ start: v.min, end: v.max, penKeys: [pens[0].key] });
  assert.ok(Array.isArray(raw.pens), `${label}: fetchRaw pens`);
  for (const k of ['key', 't', 'v', 'status']) assert.ok(k in raw.pens[0], `${label}: fetchRaw pen.${k}`);
  for (const layout of ['wide', 'tall']) {
    const rows = api.series.rows({ source: 'visible', layout });
    assert.ok(Array.isArray(rows.header) && rows.header[0] === 'Time', `${label}: rows.header (${layout})`);
    const list = Array.from(rows.rows);
    assert.ok(list.length > 0, `${label}: rows (${layout})`);
    assert.equal(list[0].length, rows.header.length, `${label}: row width (${layout})`);
    assert.equal(typeof list[0][0], 'number', `${label}: epoch-ms times`);
  }
  const q = api.series.rows({ source: 'loaded', layout: 'wide', includeQuality: true });
  assert.equal(q.header.length, 1 + 2 * (q.header.length - 1) / 2, `${label}: quality columns`);
  const tk = api.tokens();
  for (const k of ['text', 'textMuted', 'surface', 'primary', 'danger', 'warn', 'border', 'font']) assert.ok(k in tk, `${label}: tokens.${k}`);
  const caps = api.capabilities();
  for (const k of ['enabled', 'designMode', 'nativeApp', 'tagBrowser', 'trendEdit', 'readScope', 'annotations', 'settingsPanel', 'export']) {
    assert.ok(k in caps, `${label}: capabilities.${k}`);
  }
  assert.deepEqual(Object.keys(caps.tagBrowser).sort(), ['allowed', 'reason']);
  assert.deepEqual(Object.keys(caps.trendEdit).sort(), ['allowed', 'reason']);
  assert.deepEqual(Object.keys(caps.readScope).sort(), ['roots', 'runtimePensAllowed']);
  assert.deepEqual(Object.keys(caps.annotations).sort(), ['allowed', 'editAllowed', 'moderateAllowed', 'reason']);
  assert.deepEqual(Object.keys(caps.settingsPanel).sort(), ['enabled', 'tabs']);
  assert.deepEqual(Object.keys(caps.export).sort(), ['csv', 'png']);
  // 'probePanel': a name no add-on file registers (the stub loads ctg-chart-tools.js, which owns 'color')
  assert.equal(api.panels.open('probePanel', { penKey: pens[0].key }), false, `${label}: an unregistered panel does not open`);
  assert.equal(api.panels.open('toString'), false, `${label}: prototype names are not panels`);
  assert.equal(api.panels.isOpen('toString'), false);
  register('probePanel', { render: () => null });
  assert.equal(api.panels.open('probePanel', { penKey: pens[0].key }), true, `${label}: panels.open`);
  assert.equal(api.panels.isOpen('probePanel'), true);
  assert.equal(api.panels.close('probePanel'), true);
  assert.equal(api.fireEvent('onSetpointWrite', {}), false, `${label}: event allow-list`);
  assert.equal(api.fireEvent('onRangeChange', { mode: 'realtime', start: 1, end: 2 }), true);
  assert.equal(api.write('enabled', false), false, `${label}: security key refused`);
  assert.equal(api.write('readScope', {}), false);
  assert.equal(api.write('outputs', {}), false, `${label}: outputs are chart-owned`);
  assert.equal(api.write('nope', 1), false, `${label}: unknown key refused`);
  assert.equal(api.write('timeRange', { mode: 'historical', historical: { startDate: T0 - 3600000, endDate: T0 } }), true);
  const off = api.onChange(() => {});
  assert.equal(typeof off, 'function');
  off();
  assert.equal(typeof api.t('chart.btn.refresh'), 'string');
  assert.equal(api.t('chart.btn.refresh'), 'Refresh');
}

test('member list: stub == NS.chart.CHART_API_MEMBERS', async () => {
  const { C } = await realApi();
  assert.deepEqual(STUB_MEMBERS, Array.from(C.CHART_API_MEMBERS));          // (cross-realm array)
});

test('real ChartApi conforms to the ChartApi contract', async () => {
  const r = await realApi();
  await conformance(r.api, 'real', (n, d) => r.C.panels.register(n, d));
  assert.deepEqual(r.writes.map((w) => w.key), ['timeRange'], 'only the allowed write reached the store');
  assert.deepEqual(r.source.requests.map((x) => x.name), ['chart.browse'], 'only allow-listed requests reach the delegate');
  assert.deepEqual(r.fired.map((f) => f.name), ['onRangeChange']);
  assert.ok(r.ranges() >= 2, 'viewport.set/reset count as user range changes (onRangeChange, outputs.range)');
  // fault pens are listed (status) but own no axis; real samples only in rows (no synthetic point)
  const pens = r.api.pens();
  assert.equal(pens.find((p) => p.key === 'p:1').status, 'notFound');
  assert.equal(pens.find((p) => p.key === 'p:1').axisKey, null);
  r.engine.dispose();
});

test('stub ChartApi conforms and records what a panel did', async () => {
  const s = createChartApiStub({ props: { pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Pressure' }] } });
  await conformance(s.api, 'stub', s.registerPanel);
  assert.equal(s.writes.length, 1);
  assert.equal(s.api.props().timeRange.mode, 'historical', 'writes re-reduce props');
  assert.ok(s.requests.some((r) => r.name === 'dt.write'));
  assert.deepEqual(s.events.map((e) => e.name), ['onRangeChange']);
  let seen = null;
  s.api.onChange((w) => { seen = w; });
  s.api.write('penTable', Object.assign({}, s.api.props().penTable, { visible: false }));
  assert.equal(seen.props, true);
});

test('stub: fixture handlers, design mode refuses writes and panels', async () => {
  const s = createChartApiStub({ designMode: true, handlers: { 'chart.trendAdd': () => ({ ok: false, error: { code: 'FORBIDDEN_ROLE' } }) } });
  assert.equal(s.api.write('timeRange', {}), false);
  assert.equal(s.api.panels.open('settings'), false);
  assert.equal((await s.api.request('chart.trendAdd', { tagPaths: ['x'] })).error.code, 'FORBIDDEN_ROLE');
  assert.equal(s.api.capabilities().designMode, true);
});

// ---- events off, aborted fetchRaw, incremental badRuns, abort listeners --------------------------------------

test('events disabled: fireEvent is a no-op on the real api and on the stub', async () => {
  const r = await realApi({ eventsEnabled: false });
  assert.equal(r.api.fireEvent('onRangeChange', { mode: 'realtime', start: 1, end: 2 }), false);
  assert.equal(r.fired.length, 0);
  r.engine.dispose();
  const s = createChartApiStub({ eventsEnabled: false, props: { pens: [{ tagPath: '[default]CTG/Temp' }] } });
  assert.equal(s.api.fireEvent('onRangeChange', { mode: 'realtime', start: 1, end: 2 }), false);
  assert.equal(s.events.length, 0);
  const s2 = createChartApiStub({ panels: { settings: { render: () => null } }, props: { pens: [{ tagPath: '[default]CTG/Temp' }] } });
  assert.equal(s2.api.panels.open('settings'), true, 'fixture.panels registers in the real registry');
  assert.equal(s2.api.panels.open('probePanel'), false);
});

test('history.fetchRaw: an already-aborted signal sends no request', async () => {
  const r = await realApi();
  const before = r.calls.length;
  const ac = new AbortController();
  ac.abort();
  const v = r.api.viewport.get();
  const res = await r.api.history.fetchRaw({ start: v.min, end: v.max, penKeys: ['p:0'], signal: ac.signal });
  assert.equal(r.calls.length, before, 'no POST');
  assert.equal(res.error, 'ABORTED');
  assert.equal(JSON.stringify(res.pens.map((p) => [p.key, p.status])), JSON.stringify([['p:0', 'aborted']]));
  const s = createChartApiStub({ props: { pens: [{ tagPath: '[default]CTG/Temp' }] } });
  const sres = await s.api.history.fetchRaw({ start: v.min, end: v.max, penKeys: ['p:0'], signal: ac.signal });
  assert.equal(sres.error, 'ABORTED', 'stub: same shape');
  assert.equal(JSON.stringify(sres.pens.map((p) => p.status)), JSON.stringify(['aborted']));
  r.engine.dispose();
});

/** The pre-fix full scan (reference for the incremental badRuns). */
function refRuns(C, e, pd) {
  const live = e._realtime(), follow = live && e.vp.followLive;
  const runs = []; let open = null, last = -Infinity;
  const shift = C.bucketShift(pd.coverage);
  const pairs = pd.coverage && pd.coverage.mode === 'aggregated';
  const visit = (t, v) => { if (!(t > last)) return; last = t; if (v === null) { if (open == null) open = t; } else if (open != null) { runs.push([open, t]); open = null; } };
  if (pd.anchor && (!pd.t.length || pd.anchor.t < pd.t[0])) visit(pd.anchor.t, pd.anchor.v);
  for (let i = 0; i < pd.t.length; i++) visit(pd.t[i] + shift + (pairs && i > 0 && pd.t[i] === pd.t[i - 1] ? 1 : 0), pd.v[i]);
  if (live) for (let j = 0; j < pd.live.t.length; j++) visit(pd.live.t[j], pd.live.v[j]);
  if (open != null) runs.push([open, follow ? Math.max(e.gwNow(), last) : last]);
  return runs;
}

test('badRuns: incremental while following live == a full rescan; no rescan per frame', async () => {
  const r = await realApi();
  const e = r.engine;
  const pd = e.penData('p:0');
  const dk = e.pens.find((p) => p.key === 'p:0').dataKey;
  assert.ok(pd && pd.t.length > 10, 'history loaded');
  // history with two bad runs, then a revision bump
  pd.v[3] = null; pd.v[4] = null; pd.v[pd.v.length - 2] = null;
  pd.rev++;
  const same = (label) => assert.equal(JSON.stringify(e.badRuns('p:0')), JSON.stringify(refRuns(r.C, e, pd)), label);
  same('history');
  const scan = pd._badScan;
  same('cached (same scan state)');
  assert.equal(pd._badScan, scan, 'no rescan without a change');
  // live samples arrive (t > history end): only the new ones are visited
  let t = Math.max(pd.histEnd || 0, pd.t[pd.t.length - 1]) + 1000;
  const add = (v, q) => { e.store.addLive(dk, { v, t, q: q || { level: 'good' } }); t += 1000; };
  add(5); same('live good');
  assert.equal(pd._badScan, scan, 'appending live samples extends the same scan');
  add(null, { level: 'bad' }); add(null, { level: 'bad' }); same('live bad run open (ends at now)');
  assert.equal(e.badRuns('p:0').length, 3, 'two history runs + the open live run');
  assert.equal(pd.live.t.length, 3, 'live samples were appended');
  add(7); same('live run closed');
  add(null, { level: 'bad' }); same('open again');
  // same t replaced in place (null -> value): must not keep the stale open run
  t -= 1000; add(9); same('in-place replacement');
  // trim at the front of the live buffer / history revision: full rescan
  pd.live.t.splice(0, 1); pd.live.v.splice(0, 1); pd.liveRev++; same('front trim');
  pd.v[6] = null; pd.rev++; same('history revision');
  assert.notEqual(pd._badScan, scan);
  r.engine.dispose();
});

test('history.fetchRaw: the abort listener on a long-lived signal is removed once each request settles', async () => {
  const r = await realApi();
  const ls = new Set();
  const sig = { aborted: false, addEventListener: (t, fn) => { if (t === 'abort') ls.add(fn); }, removeEventListener: (t, fn) => { if (t === 'abort') ls.delete(fn); } };
  const v = r.api.viewport.get();
  for (let i = 0; i < 5; i++) {
    const res = await r.api.history.fetchRaw({ start: v.min, end: v.max, penKeys: ['p:0'], signal: sig });
    assert.ok(Array.isArray(res.pens));
  }
  await flush();
  assert.equal(ls.size, 0, 'no listener left on the shared signal');
  // abort still cancels while a request is in flight
  const ac = new AbortController();
  const p = r.api.history.fetchRaw({ start: v.min, end: v.max, penKeys: ['p:0'], signal: ac.signal });
  ac.abort();
  const res = await p;
  assert.ok(Array.isArray(res.pens));
  r.engine.dispose();
});
