// =============================================================================
// chart-api-raw-patch.test.mjs — regression tests for ctg-chart.js
// =============================================================================
// Covered here:
//   - ChartApi.patch: whole-object writes built from the RAW prop value
//     (unknown pen keys survive, the reducer's defaults / clamps are not
//     persisted), partial objects, refusals; stub parity (p:<pen.index>, patch)
//   - capabilities().user from the delegate's ctg.welcome
//   - the chart re-resolves its zone when session.props.timeZoneId changes
//   - fetchRaw: a real pointCount, window.downgraded on every pen
//   - exact brush statistics: pruned when a brush moves / is cleared, bounded
//     by points, per-pen transient / definitive classification
//   - api.series.rows quality words / headers through NS.i18n
//   - history queue: limits.maxConcurrentPerSession caps in-flight requests; a
//     concurrency 429 does not drain the bucket mirror, a bucket 429 waits the
//     exact X-CTG-Retry-After-Ms
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, FILES } from './_stubs.mjs';
import { createChartApiStub } from './_chartApiStub.mjs';

async function flush(n = 40) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }
const plain = (x) => JSON.parse(JSON.stringify(x));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A mounted CtgChart over the React stub (as chart-interaction.test.mjs), with a subscribable session props tree. */
function setup(opts = {}) {
  const env = createEnv();
  env.window.addEventListener = () => {};
  env.window.removeEventListener = () => {};
  env.window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 1);
  env.window.cancelAnimationFrame = (id) => clearTimeout(id);
  const fetches = [];
  env.window.fetch = (url, init) => {
    const body = JSON.parse(init.body);
    fetches.push(body);
    if (opts.history) return Promise.resolve(opts.history(body));
    const step = body.mode === 'raw' ? 1000 : (body.bucketMs || 5000);
    const t = [];
    for (let x = Math.ceil(body.start / step) * step; x < Math.min(body.end, Date.now()); x += step) t.push(x);
    return Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify({
      v: 2, ok: true, requestId: body.requestId, serverNow: Date.now(),
      window: { start: body.start, end: Math.min(body.end, Date.now()), mode: body.mode, aggregation: body.aggregation, bucketMs: body.bucketMs, bucketTime: body.bucketMs ? 'start' : null },
      pens: body.pens.map((p) => ({ key: p.key, tagPath: p.tagPath, status: 'ok', t, v: t.map((x) => 50 + Math.sin(x / 60000) * 40), anchor: null })),
    })) });
  };
  for (const f of FILES) env.load(f, '2.0.0-c0c0c001');
  const NS = env.window.__CTG, C = NS.chart;
  const raw = opts.raw || { pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Pressure' }],
    timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } };
  const tree = JSON.parse(JSON.stringify(raw));
  const writes = [];
  const session = { timeZoneId: opts.tz || 'UTC', subs: [] };
  const sessionProps = {
    read: (k) => (k === 'locale' ? 'en-US' : k === 'timeZoneId' ? session.timeZoneId : k === 'device.type' ? 'browser' : null),
    subscribe: (fn) => { session.subs.push(fn); return () => { session.subs = session.subs.filter((f) => f !== fn); }; },
  };
  const store = {
    name: 'chart', addressPathString: '0:0', view: { page: { sessionProps } },
    props: { read: (k) => (k in tree ? JSON.parse(JSON.stringify(tree[k])) : undefined), write: (k, v) => { writes.push({ key: k, value: JSON.parse(JSON.stringify(v)) }); tree[k] = v; } },
  };
  const ls = [];
  const source = {
    snap: { pens: [
      { key: 'p:0', source: 'pens', index: 0, tagPath: '[default]CTG/Temp', name: 'Temp', status: 'ok', meta: { dataType: 'Float8', engUnit: 'degF', engLow: 0, engHigh: 100 }, trendable: true },
      { key: 'p:1', source: 'pens', index: 1, tagPath: '[default]CTG/Pressure', name: 'Pressure', status: 'ok', meta: { dataType: 'Float8', engUnit: 'psi', engLow: 0, engHigh: 300 }, trendable: true },
    ], trend: { group: 'default', paths: [], max: 32 }, limits: Object.assign({ maxPens: 32 }, opts.limits || {}), trendEdit: { allowed: true },
    readScope: { runtimePensAllowed: true, roots: [] }, tagBrowser: { allowed: false, reason: 'ACTION_DISABLED' }, annotations: { allowed: false, editAllowed: false } },
    state: { connected: true, welcome: opts.welcome === undefined ? { user: { authenticated: true, userName: 'operator', roles: ['Operator'] } } : opts.welcome },
    staleReason: () => null, values: {},
    getCreds: () => ({ url: '/data/simpletagdisplay/v2/history', token: 't', expiresAt: 4102444800000 }),
    renewToken: () => Promise.resolve(true),
    request: () => Promise.resolve({ ok: true, data: {} }),
    on(fn) { ls.push(fn); return () => {}; }, emit(t, p) { ls.forEach((f) => f(t, p)); }, attach() {}, detach() {},
  };
  store.delegate = source;
  const mk = () => ({
    store, props: C.reduceProps(tree), delegate: { phase: 'ready', connected: true }, eventsEnabled: opts.design ? false : true,
    componentEvents: { fireComponentEvent: () => {} }, emit: (o) => ({ className: (o.classes || []).join(' '), style: {} }),
  });
  const comp = new C.CtgChart(mk());
  comp.setState = function (patch, cb) { this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch); if (cb) cb(); };
  let renders = 0;
  comp.forceUpdate = () => { renders++; };
  const rerender = () => { const prev = comp.props; comp.props = mk(); comp.componentDidUpdate({ props: prev.props }); return comp.render(); };
  return { env, NS, C, comp, store, tree, writes, source, session, fetches, rerender, renders: () => renders };
}
async function mounted(opts) {
  const s = setup(opts);
  s.comp.componentDidMount();
  await flush();
  s.comp.render();
  return s;
}

// ---- ChartApi.patch --------------------------------------------------------------------------------------------------
test('api.patch: built from the RAW value — unknown pen keys survive, no reducer defaults / clamps persisted', async () => {
  const s = await mounted({ raw: {
    pens: [{ tagPath: '[default]CTG/Temp', myTag: 'keep-me' }, 'junk', { tagPath: '[default]CTG/Pressure', display: { width: 20 } }],
    timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 100 } } });
  const api = s.comp.api;
  assert.ok(s.C.CHART_API_MEMBERS.includes('patch'));
  // the reduced view clamps width 20 -> 8 and drops 'junk'; the raw patch must not persist either
  assert.equal(api.props().pens[1].display.width, 8);
  const ok = api.patch('pens', (raw, reduced) => {
    assert.equal(reduced.length, 2, 'reduced root given for reference');
    assert.equal(reduced[1].index, 2, 'reduced items carry their raw index');
    raw[reduced[1].index].color = '#123456';
    return raw;
  });
  assert.equal(ok, true);
  const w = s.writes.pop();
  assert.equal(w.key, 'pens');
  assert.deepEqual(w.value, [{ tagPath: '[default]CTG/Temp', myTag: 'keep-me' }, 'junk',
    { tagPath: '[default]CTG/Pressure', display: { width: 20 }, color: '#123456' }], 'exactly the raw value + the one change');
  // undefined = the mutated copy; a partial object deep-merges into an object root (refreshRate 100 is kept raw)
  assert.equal(api.patch('timeRange', { realtime: { value: 3 } }), true);
  assert.deepEqual(s.writes.pop().value, { realtime: { value: 3, unit: 'minutes' }, refreshRate: 100 });
  assert.equal(api.patch('pens', (raw) => { raw[0].myTag = 'x'; }), true);
  assert.equal(s.writes.pop().value[0].myTag, 'x');
  // nothing to change: true, no write
  const n = s.writes.length;
  assert.equal(api.patch('pens', (raw) => raw), true);
  assert.equal(s.writes.length, n, 'unchanged -> no write');
  // refusals: security keys, outputs, unknown keys, a throwing fn, a partial object for an array root
  assert.equal(api.patch('enabled', { x: 1 }), false);
  assert.equal(api.patch('readScope', () => ({})), false);
  assert.equal(api.patch('outputs', {}), false);
  assert.equal(api.patch('nope', {}), false);
  assert.equal(api.patch('pens', () => { throw new Error('boom'); }), false);
  assert.equal(api.patch('pens', { 0: {} }), false);
  assert.equal(s.writes.length, n);
  s.comp.componentWillUnmount();
  assert.equal(api.patch('pens', (raw) => raw.concat([{ tagPath: 'x' }])), false, 'detached chart: refused');
});

test('api.patch: Dates in the raw value stay Dates; a missing raw root starts from the reduced copy', async () => {
  const start = new Date(Date.UTC(2026, 9, 1, 0, 0, 0));
  const s = await mounted({ raw: { pens: [{ tagPath: '[default]CTG/Temp' }], timeRange: { mode: 'historical', historical: { startDate: start.toISOString(), endDate: null }, refreshRate: 0 } } });
  // the tree read gives JSON here; a Date written by a patch is kept as a Date object (not stringified by the copy)
  const d = new Date(Date.UTC(2026, 9, 2));
  assert.equal(s.comp.api.patch('timeRange', { historical: { endDate: d } }), true);
  const w = s.writes.pop();
  assert.equal(w.value.historical.endDate, d.toISOString(), 'written (the recording stringifies)');
  assert.equal(s.tree.timeRange.historical.endDate instanceof s.env.context.Date || s.tree.timeRange.historical.endDate instanceof Date, true, 'a Date object reached the store');
  delete s.tree.title;
  assert.equal(s.comp.api.patch('title', (raw) => { raw.text = 'T'; }), true);
  assert.equal(s.writes.pop().value.text, 'T', 'built on the reduced copy (raw missing)');
  s.comp.componentWillUnmount();
});

test('stub parity: _chartApiStub keys PenVMs p:<pen.index> (raw index) and implements patch over raw props', () => {
  const s = createChartApiStub({ props: { pens: [{ tagPath: '[default]A' }, 'junk', { tagPath: '[default]B', extra: 1 }] } });
  const vms = s.api.pens();
  assert.deepEqual(plain(vms.map((v) => [v.key, v.index])), [['p:0', 0], ['p:2', 2]], 'like the live chart / gateway');
  assert.equal(typeof s.api.patch, 'function');
  assert.equal(s.api.patch('pens', (raw) => { raw[2].color = '#00FF00'; }), true);
  const w = s.writes.pop();
  assert.equal(w.patch, true);
  assert.deepEqual(plain(w.value), [{ tagPath: '[default]A' }, 'junk', { tagPath: '[default]B', extra: 1, color: '#00FF00' }]);
  assert.equal(s.api.props().pens[1].color, '#00FF00', 'props re-reduced from the raw value');
});

test('capabilities().user follows the delegate\'s ctg.welcome (null before it)', async () => {
  const s = await mounted();
  assert.equal(s.comp.api.capabilities().user, 'operator');
  s.source.state.welcome = { user: { authenticated: true, userName: 'engineer', roles: [] } };
  assert.equal(s.comp.api.capabilities().user, 'engineer');
  s.comp.componentWillUnmount();
  const n = await mounted({ welcome: null });
  assert.equal(n.comp.api.capabilities().user, null);
  n.comp.componentWillUnmount();
});

// ---- session time zone and fetchRaw ----------------------------------------------------------------------------------
test('the chart re-resolves its zone when session.props.timeZoneId changes (its own props unchanged)', async () => {
  const s = await mounted({ tz: 'UTC' });
  assert.equal(s.comp.engine.timeZone, 'UTC');
  assert.equal(s.comp.api.timeZone(), 'UTC');
  const subs = s.session.subs.length;             // the page theme watch (ctg-common) subscribes too
  assert.ok(subs >= 1, 'subscribed to the session props tree');
  const before = s.renders();
  s.session.timeZoneId = 'America/Chicago';
  s.session.subs.forEach((f) => f());
  assert.equal(s.comp.engine.timeZone, 'America/Chicago');
  assert.equal(s.comp.api.timeZone(), 'America/Chicago');
  assert.ok(s.renders() > before, 're-rendered (axis labels, X-Trace, date pill)');
  s.comp.render();
  assert.equal(s.comp._vm.tz, 'America/Chicago', 'the plots get the new zone (PlotManager._sig rebuilds the time axis)');
  // an explicit timeAxis.timeZone ignores the session zone
  s.tree.timeAxis = { timeZone: 'Asia/Tokyo' };
  s.rerender();
  assert.equal(s.comp.engine.timeZone, 'Asia/Tokyo');
  s.session.timeZoneId = 'Europe/Berlin';
  s.session.subs.forEach((f) => f());
  assert.equal(s.comp.engine.timeZone, 'Asia/Tokyo');
  s.comp.componentWillUnmount();
  assert.equal(s.session.subs.length, subs - 1, 'the chart\'s own subscription ends on unmount');
});

test('fetchRaw sends a real pointCount and passes window.downgraded on to every pen', async () => {
  let downgradeWhole = true;
  const s = await mounted({ history: (body) => ({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify({
    v: 2, ok: true, requestId: body.requestId, serverNow: Date.now(),
    window: { start: body.start, end: body.end, mode: downgradeWhole ? 'aggregated' : body.mode, bucketMs: downgradeWhole ? 3600000 : null, downgraded: downgradeWhole },
    pens: body.pens.map((p) => ({ key: p.key, status: 'ok', t: [], v: [] })),
  })) }) });
  const end = Date.now(), start = end - 40 * 86400000;
  const res = await s.comp.api.history.fetchRaw({ start, end, penKeys: ['p:0', 'p:1'] });
  const body = s.fetches.filter((b) => b.mode === 'raw').pop();
  assert.ok(body.pointCount >= 10, 'a real point count for the aggregate fallback, not 0: ' + body.pointCount);
  assert.equal(body.onTooManyPoints, 'aggregate');
  assert.equal(res.downgraded, true);
  assert.equal(res.window.downgraded, true);
  assert.deepEqual(res.pens.map((p) => p.downgraded), [true, true], 'every pen says so');
  downgradeWhole = false;
  const r2 = await s.comp.api.history.fetchRaw({ start: end - 60000, end, penKeys: ['p:0'] });
  assert.equal(r2.downgraded, false);
  assert.equal(r2.pens[0].downgraded, false);
  s.comp.componentWillUnmount();
});

// ---- exact brush statistics ------------------------------------------------------------------------------------------
const AGG = () => ({ raw: { pens: [{ tagPath: '[default]CTG/Temp' }], query: { mode: 'aggregated' },
  interaction: { mode: 'rangeBrush' }, timeRange: { realtime: { value: 8, unit: 'hours' }, refreshRate: 0 } } });

test('exact-stats cache: a moved brush drops its old geometry; Clear empties the cache', async () => {
  const s = await mounted(AGG());
  await flush();
  const e = s.comp.engine, ix = s.comp.ix;
  const calls = [];
  e.fetchRaw = (o) => {
    calls.push(o);
    const t = [], v = [];
    for (let x = o.start; x <= o.end; x += 1000) { t.push(x); v.push(1); }
    return Promise.resolve({ pens: o.penKeys.map((k) => ({ key: k, t, v, status: 'ok' })) });
  };
  const view = () => s.comp._brushView(s.comp.props.props);
  const vp = e.viewport.get();
  ix.addBrush({ start: Math.round(vp.max - 1800000), end: Math.round(vp.max - 1200000), plot: 0 });
  view(); await flush();
  for (let i = 1; i <= 5; i++) {                 // move the brush 5 times (each a new geometry)
    const b = ix.brushes[0];
    ix.updateBrush({ id: b.id, start: b.start - 60000, end: b.end - 60000 });
    view(); await flush();
  }
  assert.equal(calls.length, 6);
  assert.equal(s.comp._exactCache.size, 1, 'only the current geometry is cached, not 6 (old: 6)');
  assert.equal(s.comp.exactHeldPoints(), 2 * 601, 'one geometry x 2 pens x 601 raw points');
  ix.clearBrushes();
  assert.equal(s.comp._exactCache.size, 0, 'Clear drops the cache (old: entries survived)');
  assert.equal(s.comp._exact, null);
  s.comp.componentWillUnmount();
});

test('exact-stats cache is bounded by points (counts against the memory guard)', async () => {
  const s = await mounted(AGG());
  await flush();
  const e = s.comp.engine, ix = s.comp.ix;
  const share = s.C.EXACT.pointsShare;
  s.C.EXACT.pointsShare = 3000 / s.C.ENGINE.maxHeldPoints;      // a budget of 3 000 points for the test
  e.fetchRaw = (o) => {
    const t = [], v = [];
    for (let x = o.start; x <= o.end; x += 1000) { t.push(x); v.push(1); }     // 601 points per pen per 10 min brush
    return Promise.resolve({ pens: o.penKeys.map((k) => ({ key: k, t, v, status: 'ok' })) });
  };
  const view = () => s.comp._brushView(s.comp.props.props);
  const vp = e.viewport.get();
  for (let i = 0; i < 4; i++) {
    ix.addBrush({ start: Math.round(vp.max - (i + 3) * 1800000), end: Math.round(vp.max - (i + 3) * 1800000 + 600000), plot: 0 });
    view(); await flush();
  }
  let cached = 0;
  s.comp._exactCache.forEach((ex) => { cached += ex.points; });
  assert.ok(cached <= 3000, 'cached raw points within the budget: ' + cached + ' in ' + s.comp._exactCache.size + ' entries (old: 4 x 1 202)');
  assert.equal(s.comp._exactCache.size, 2, 'least recently used entries went first');
  assert.ok(s.comp._exact && !s.comp._exact.loading && s.comp._exact.points === 1202, 'the selected entry is usable');
  s.C.EXACT.pointsShare = share;
  s.comp.componentWillUnmount();
});

test('exact stats: a per-pen definitive answer is cached; a per-pen timeout is transient and retried by a timer', async () => {
  const s = await mounted(AGG());
  await flush();
  const e = s.comp.engine, ix = s.comp.ix;
  const calls = [];
  let status = 'error';
  e.fetchRaw = (o) => { calls.push(o); return Promise.resolve({ pens: o.penKeys.map((k) => ({ key: k, t: [], v: [], status })) }); };
  const view = () => s.comp._brushView(s.comp.props.props);
  const vp = e.viewport.get();
  const ttl = s.C.EXACT.failedTtlMs;
  s.C.EXACT.failedTtlMs = 50;
  try {     // restored even when an assertion fails
  ix.addBrush({ start: Math.round(vp.max - 1800000), end: Math.round(vp.max - 1200000), plot: 0 });
  view(); await flush();
  assert.equal(calls.length, 1);
  assert.equal(view().exactFailed, true);
  await sleep(120); view(); await flush();
  assert.equal(calls.length, 1, "per-pen 'error' is definitive: no timer, no refetch (old: refetched as transient)");
  ix.addBrush({ start: Math.round(vp.max - 5400000), end: Math.round(vp.max - 4800000), plot: 0 });
  view(); await flush();
  ix.selectBrush(ix.brushes[0].id);
  view(); await flush();
  assert.equal(calls.length, 2, 'the definitive answer is cached per brush');
  // a per-pen timeout: transient, retried after the TTL by a timer, without a render in between
  status = 'timeout';
  ix.addBrush({ start: Math.round(vp.max - 9000000), end: Math.round(vp.max - 8400000), plot: 0 });
  view(); await flush();
  const n = calls.length;
  const r0 = s.renders();
  await sleep(150);
  assert.ok(s.renders() > r0, 'the TTL timer re-rendered by itself (old: waited for a render)');
  view(); await flush();
  assert.equal(calls.length, n + 1);
  } finally { s.C.EXACT.failedTtlMs = ttl; }
  s.comp.componentWillUnmount();
});

// ---- series.rows words via NS.i18n -----------------------------------------------------------------------------------
test('api.series.rows headers and quality words come from NS.i18n (chart.rows.*)', async () => {
  const s = await mounted();
  await flush();
  s.NS.i18n.register('chart', { 'chart.rows.time': 'Zeit', 'chart.rows.good': 'Gut', 'chart.rows.bad': 'Schlecht', 'chart.rows.qualitySuffix': '{label} Qualität' });
  const wide = s.comp.api.series.rows({ source: 'loaded', layout: 'wide', includeQuality: true });
  assert.equal(wide.header[0], 'Zeit');
  assert.match(wide.header[2], / Qualität$/);
  assert.ok(wide.rows.length > 0);
  assert.ok(wide.rows.every((r) => r[2] === 'Gut' || r[2] === 'Schlecht' || r[2] === ''), JSON.stringify(wide.rows[0]));
  const tall = s.comp.api.series.rows({ source: 'loaded', layout: 'tall', includeQuality: true });
  assert.equal(tall.header[0], 'Zeit');
  assert.ok(tall.rows.every((r) => r[3] === 'Gut' || r[3] === 'Schlecht'));
  s.comp.componentWillUnmount();
});

// ---- the client side of the bucket semantics -------------------------------------------------------------------------
function fakeClock(t0) {
  let now = t0;
  const timers = [];
  return {
    now: () => now,
    timers: {
      set: (fn, ms) => { const t = { at: now + ms, fn }; timers.push(t); return t; },
      clear: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); },
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
        await flush(5);
      }
      now = end;
      await flush(5);
    },
    pending: () => timers.length,
  };
}

test('history queue: never more in flight than limits.maxConcurrentPerSession (no timer spin while capped)', async () => {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-c0c0c001');
  const C = env.window.__CTG.chart;
  const clock = fakeClock(1e12);
  const q = new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers });
  let running = 0, max = 0;
  const done = [];
  const job = () => q.run({ key: 'k' + Math.random(), priority: 'chunk', spacingMs: 0, sessionMax: 1,
    exec: () => { running++; max = Math.max(max, running); return new Promise((r) => done.push(() => { running--; r({ ok: true }); })); } });
  job(); job(); job();
  await flush();
  assert.equal(running, 1, 'a gateway with maxConcurrentPerSession 1: one at a time (old: 2)');
  assert.equal(clock.pending(), 0, 'no wake-up timer while only the session cap holds jobs back');
  while (done.length) { done.shift()(); await flush(); }
  assert.equal(max, 1);
  // the HistoryClient passes the snapshot's maxConcurrentPerSession
  const seen = [];
  const hc = new C.HistoryClient({ source: {}, key: 'k', metrics: {}, queue: { run: (j) => { seen.push(j.sessionMax); return Promise.resolve({ ok: true }); } },
    limits: () => C.effectiveLimits({ maxConcurrentPerSession: 3 }) });
  await hc.post({});
  assert.deepEqual(seen, [3]);
});

test('a concurrency 429 keeps the bucket mirror and retries soon; a bucket 429 drains it and waits the exact ms', async () => {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-c0c0c001');
  const C = env.window.__CTG.chart;
  const metrics = { requests: 0, responses: 0, requestBytes: 0, bytes: 0, lastBytes: 0, inFlight: 0, inFlightMax: 0, networkErrors: 0,
    clientTimeouts: 0, perf: { fetchMs: [], parseMs: [], joinMs: [], applyMs: [] } };
  const calls = [];
  const queue = { pause: (k, ms) => calls.push(['pause', ms]), drain: (k) => calls.push(['drain']), pauseAll: (ms) => calls.push(['pauseAll', ms]),
    run: (j) => j.exec({ aborted: false, on() {} }) };
  let headers = {};
  const fetch = () => Promise.resolve({ status: 429, headers: { get: (n) => (n in headers ? headers[n] : null) },
    text: () => Promise.resolve(JSON.stringify({ v: 2, ok: false, error: { code: 'TOO_MANY_REQUESTS', message: '', retryable: true } })) });
  const hc = new C.HistoryClient({ source: { getCreds: () => ({ url: '/h', token: 't' }) }, key: 'k', metrics, queue, fetch,
    limits: () => C.effectiveLimits({ historyBurst: 8, minIntervalMs: 200 }) });
  headers = { 'Retry-After': '1', 'X-CTG-Limit': 'concurrency' };
  let r = await hc.post({});
  assert.equal(r.code, 'TOO_MANY_REQUESTS');
  assert.deepEqual(calls, [['pause', 250]], 'no drain, a short pause instead of 1 s (old: pause 1000 + drain)');
  calls.length = 0;
  // a per-session queue refusal (two charts mounting together) is transient like a concurrency one
  headers = { 'Retry-After': '1', 'X-CTG-Limit': 'queue' };
  r = await hc.post({});
  assert.equal(r.code, 'TOO_MANY_REQUESTS');
  assert.equal(r.retryAfterMs, 250);
  assert.deepEqual(calls, [['pause', 250]], 'queue 429: short pause, the mirror is not drained (old: pause 1000 + drain)');
  assert.equal(r.transient, true, 'the result says the refusal is transient');
  calls.length = 0;
  headers = { 'Retry-After': '1', 'X-CTG-Limit': 'rate', 'X-CTG-Retry-After-Ms': '137' };
  r = await hc.post({});
  assert.deepEqual(calls, [['pause', 157], ['drain']], 'the exact refill wait (+20 ms margin), and the mirror drains');
  assert.equal(r.retryAfterMs, 157);
  calls.length = 0;
  headers = { 'Retry-After': '1' };                     // an older gateway: as before
  r = await hc.post({});
  assert.deepEqual(calls, [['pause', 1000], ['drain']]);
  assert.equal(r.transient, false);
});

test('the engine retries a transient 429 (concurrency / queue) after the short pause, not the 1 s busy floor', () => {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-c0c0c001');
  const C = env.window.__CTG.chart;
  const transient = { ok: false, status: 429, code: 'TOO_MANY_REQUESTS', retryAfterMs: 250, transient: true };
  assert.equal(C.busyBackoffMs(transient, 1), 250, 'first retry after 250 ms (old: 1000)');
  assert.equal(C.busyBackoffMs(transient, 3), 250);
  assert.equal(C.busyBackoffMs(transient, 4), 8000, 'a refusal that keeps coming falls back to the doubling busy backoff');
  const rate = { ok: false, status: 429, code: 'TOO_MANY_REQUESTS', retryAfterMs: 157, transient: false };
  assert.equal(C.busyBackoffMs(rate, 1), 1000, 'a bucket 429 keeps the 1 s busy floor');
  assert.equal(C.busyBackoffMs({ ok: false, status: 503, code: 'BUSY', retryAfterMs: 2000 }, 1), 2000, '503 BUSY: Retry-After');
  assert.equal(C.busyBackoffMs({ ok: false, status: 429, code: 'TOO_MANY_REQUESTS', retryAfterMs: null, transient: true }, 1), 1000);
});
