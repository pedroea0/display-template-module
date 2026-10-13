// =============================================================================
// chart-live-view-and-export.test.mjs — live view, session recovery, focus,
// export and editor behaviour of the chart (plus client delegate request ids)
// =============================================================================
// Engine tests run the real ChartEngine against a fake history route and a
// manual clock (the chart-aggregation-and-auth scaffold); component tests mount
// the CtgChart over the React stub (the chart-interaction scaffold); tool /
// panel tests run against the ChartApi stub.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, FILES } from './_stubs.mjs';
import { createChartApiStub } from './_chartApiStub.mjs';

const S = 1000, M = 60 * S;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const plain = (x) => JSON.parse(JSON.stringify(x));

function load() {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  return { env, NS: env.window.__CTG, C: env.window.__CTG.chart };
}
async function flush(n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

// ---- engine scaffold (chart-aggregation-and-auth.test.mjs) ------------------------------------------------------
function fakeClock(start) {
  let now = start;
  let id = 0;
  const q = [];
  return {
    now: () => now,
    timers: {
      set(fn, ms) { const t = { id: ++id, at: now + Math.max(0, ms || 0), fn }; q.push(t); return t.id; },
      clear(i) { const k = q.findIndex((t) => t.id === i); if (k >= 0) q.splice(k, 1); },
    },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        await flush();
        q.sort((a, b) => a.at - b.at || a.id - b.id);
        const t = q[0];
        if (!t || t.at > target) break;
        q.shift();
        now = t.at;
        t.fn();
      }
      now = target;
      await flush();
    },
  };
}
function answer(body, now, nullFrom) {
  const dataEnd = Math.min(body.end, now);
  if (body.mode === 'raw') {
    return {
      v: 2, ok: true, requestId: body.requestId, serverNow: now,
      window: { start: body.start, end: dataEnd, mode: 'raw', aggregation: body.aggregation, bucketMs: null, bucketTime: null, aligned: false, downgraded: false },
      pens: body.pens.map((p) => {
        const from = p.since != null && p.since >= body.start ? p.since + 1 : body.start;
        const t = [];
        for (let x = Math.ceil(from / S) * S; x < dataEnd; x += S) t.push(x);
        return { key: p.key, tagPath: p.tagPath, status: 'ok', t, v: t.map((x) => x / 1000), anchor: null, replaceFrom: null, downgraded: false, count: t.length };
      }),
    };
  }
  const b = body.bucketMs || 60000;
  const aS = Math.floor(body.start / b) * b, aE = Math.floor(dataEnd / b) * b;
  return {
    v: 2, ok: true, requestId: body.requestId, serverNow: now,
    window: { start: aS, end: aE, mode: 'aggregated', aggregation: body.aggregation, bucketMs: b, bucketTime: 'start', aligned: true, downgraded: false },
    pens: body.pens.map((p) => {
      const incr = p.since != null && p.since >= body.start;
      const from = incr ? Math.max(aS, Math.floor(p.since / b) * b - b) : aS;
      const t = [];
      for (let x = from; x < aE; x += b) t.push(x);
      return { key: p.key, tagPath: p.tagPath, status: 'ok', aggregation: p.aggregation, shape: 'points', t,
        v: t.map((x) => (nullFrom != null && x >= nullFrom ? null : (x + b - 1) / 1000)),
        anchor: null, replaceFrom: incr ? from : null, downgraded: false, count: t.length };
    }),
  };
}
function fakeRoute(clock, respond) {
  const calls = [];
  const fn = (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ body, at: clock.now() });
    const json = (respond && respond(body, calls.length, clock.now())) || answer(body, clock.now());
    const status = json.__status || 200;
    return Promise.resolve({ status, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(json)) });
  };
  fn.calls = calls;
  return fn;
}
const penInfo = (i, tagPath) => ({ key: 'p:' + i, source: 'pens', index: i, tagPath, name: tagPath.split('/').pop(), status: 'ok', meta: null, trendable: true });
function fakeSource(pens, creds) {
  const ls = [];
  return {
    snap: { pens, trend: { group: null, paths: [], max: 32 }, limits: { maxPens: 32, minBucketMs: 100, maxConcurrentPerSession: 4 } },
    creds: creds === undefined ? { url: '/data/simpletagdisplay/v2/history', token: 'tok-1', expiresAt: 4102444800000 } : creds,
    state: { connected: true }, reason: null, renewCount: 0,
    staleReason() { return this.reason; },
    getCreds() { return this.creds; },
    renewToken() { this.renewCount++; return Promise.resolve(true); },
    on(fn) { ls.push(fn); return () => { const i = ls.indexOf(fn); if (i >= 0) ls.splice(i, 1); }; },
    emit(t, p) { ls.slice().forEach((f) => f(t, p)); },
  };
}
function setup(o) {
  const { C, NS, env } = load();
  const clock = fakeClock(o.start || T0);
  const route = fakeRoute(clock, o.respond);
  const queue = new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers });
  const source = fakeSource(o.pens || [penInfo(0, '[default]CTG/Temp')], o.creds);
  if (o.snap) Object.assign(source.snap, o.snap);
  const doc = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const props = C.reduceProps(o.props);
  const engine = new C.ChartEngine({ id: 'c1', source, queue, now: clock.now, timers: clock.timers, document: doc, fetch: route,
    props, timeZone: 'UTC', plotWidth: 1000 });
  return { C, NS, env, clock, route, source, engine };
}
const RT = (extra) => Object.assign({ pens: [{ tagPath: '[default]CTG/Temp' }], timeRange: { realtime: { value: 10, unit: 'minutes' }, refreshRate: 1000 }, query: { mode: 'raw' } }, extra || {});

// ---- request ids repeated after a page reload ----------------------------------------------------------------------

test('a new client delegate on the same component address never reuses the previous page\'s request ids', () => {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  const NS = env.window.__CTG;
  const store = { addressPathString: '0:2:0' };
  const ids = [];
  for (const value of [11, 44]) {                          // the page before and after F5
    const d = new NS.dt.DisplayTemplateDelegate(store);
    d.attach();
    try {
      d.handleEvent('ctg.welcome', { v: 2, epoch: '7a4b52', seq: 1, serverNow: Date.now() });
      d.request('dt.write', { expectedTagPath: '[default]CTG/DT_SP', value, ui: 'popup' }, { timeoutMs: 50 });
    } finally { d.detach(); }
    ids.push(env.fired.filter((f) => f.store === store && f.name === 'dt.write').pop().payload.id);
  }
  assert.match(ids[0], /^dt0:2:0-[a-z0-9]{8}-1$/);
  assert.match(ids[1], /^dt0:2:0-[a-z0-9]{8}-1$/);
  assert.notEqual(ids[0], ids[1], 'was dt0:2:0-1 twice: the write of 44 got the write of 11\'s reply and never ran');
  assert.ok(ids.every((id) => id.length <= 64));
});

// ---- a chart refused by the per-session token cap waited for a reload -------------------------------------------------

test('SESSION_FULL: its own banner, chart.token retried with backoff, history starts once a slot frees', async () => {
  const { engine, clock, source, route } = setup({ props: RT(), creds: null, snap: { historyRefused: 'sessionFull' } });
  let tries = 0;
  source.renewToken = function () {
    tries++;
    if (tries < 3) return Promise.resolve(false);            // BUSY: the session is still full
    this.creds = { url: '/data/simpletagdisplay/v2/history', token: 'tok-2', expiresAt: 4102444800000 };
    return Promise.resolve(true);
  };
  engine.start();
  await clock.advance(500);
  assert.equal(engine.banner && engine.banner.code, 'SESSION_FULL', 'was SESSION_MISMATCH (fatal, never retried)');
  assert.match(engine.banner.message, /maximum number of charts/);
  assert.equal(route.calls.length, 0);
  await clock.advance(30 * S);
  assert.equal(tries, 3, '2 s, 4 s, 8 s');
  assert.equal(engine.banner, null, 'recovered');
  assert.ok(route.calls.length >= 1, 'history loads');
  engine.dispose();

  // control: a refusal that is not the cap stays SESSION_MISMATCH and asks nothing
  const c = setup({ props: RT(), creds: null });
  c.engine.start();
  await c.clock.advance(30 * S);
  assert.equal(c.engine.banner.code, 'SESSION_MISMATCH');
  assert.equal(c.source.renewCount, 0);
  c.engine.dispose();
});

// ---- realtime aggregated ticks froze interpolated values over a Bad stretch --------------------------------------------

test('bad-run replay (pure): ticks whose replay still reaches a Bad stretch re-ask from one bucket before it', () => {
  const { C } = load();
  const b = 5000;
  const pd = { coverage: { mode: 'aggregated', bucketMs: b, start: 0, end: 60000 }, lastHistT: 55000, badRun: null };
  C.trackBadRun(pd, { t: [40000, 45000, 50000, 55000], v: [1, null, null, null] });
  assert.deepEqual(plain(pd.badRun), { start: 45000, end: 55000, done: false });
  assert.equal(C.planIncrementalSince(pd, 0, 60000), 40000, 'was 55000: the bad boundary sample fell before the query');
  // the recovery came back from a short query (ramp 4.79 / 8.02): the replay still reaches the run, so it is re-asked
  pd.lastHistT = 65000;
  C.trackBadRun(pd, { t: [55000, 60000, 65000], v: [4.79, 8.02, 11] });
  assert.equal(C.planIncrementalSince(pd, 0, 70000), 40000);
  // the replay with the boundary marks the ramp Bad: the run grows, and stays replayed while the replay reaches it
  C.trackBadRun(pd, { t: [35000, 40000, 45000, 50000, 55000, 60000, 65000], v: [1, 1, null, null, null, null, 11] });
  assert.deepEqual(plain(pd.badRun), { start: 45000, end: 60000, done: false });
  pd.lastHistT = 70000;
  assert.equal(C.planIncrementalSince(pd, 0, 75000), 40000, 'replay from 65000 still reaches the bucket after the run');
  // two buckets past the run the bounding sample is good: back to the plain since
  pd.lastHistT = 75000;
  assert.equal(C.planIncrementalSince(pd, 0, 80000), 75000);
  assert.equal(pd.badRun.done, true);
  // the run grows again (new Bad rows): replayed again
  C.trackBadRun(pd, { t: [70000, 75000], v: [null, null] });
  assert.equal(pd.badRun.done, false);
  // bounded by the window start, given up after max(10 min, 20 buckets)
  const old = { coverage: { mode: 'aggregated', bucketMs: b, start: 0, end: 0 }, lastHistT: 130000, badRun: { start: 100000, end: 125000, done: false } };
  assert.equal(C.planIncrementalSince(old, 200000, 700000), 200000);
  assert.equal(C.planIncrementalSince(old, 0, 100000 + 11 * M), 130000);
  assert.equal(old.badRun.done, true);
  // raw pens never replay
  assert.equal(C.planIncrementalSince({ coverage: { mode: 'raw' }, lastHistT: 5, badRun: { start: 1, end: 2, done: false } }, 0, 10), 5);
});

test('bad-run replay (engine): ticks after a load that ended Bad ask from before the stretch, then normal again', async () => {
  let nullFrom = null;
  const { engine, clock, route } = setup({
    props: RT({ timeRange: { realtime: { value: 5, unit: 'minutes' }, refreshRate: 1000 }, query: { mode: 'aggregated', pointCount: 60 } }),
    respond: (body, n, now) => answer(body, now, n === 1 ? nullFrom : null),
  });
  nullFrom = Math.floor(T0 / 5000) * 5000 - 15000;            // the last 3 buckets of the full load are Bad
  engine.start();
  await clock.advance(500);
  const full = route.calls[0].body;
  assert.equal(full.bucketMs, 5000);
  await clock.advance(1500);
  const tick1 = route.calls[1].body.pens[0];
  assert.ok(tick1.since <= nullFrom - 5000, 'tick since ' + tick1.since + ' must reach before the stretch (' + nullFrom + ')');
  await clock.advance(1000);
  assert.ok(route.calls[2].body.pens[0].since <= nullFrom - 5000, 'the replay still reaches the run');
  await clock.advance(17000);                              // T0 + 20 s: the replay starts two buckets past the run
  const last = route.calls[route.calls.length - 1].body.pens[0];
  assert.ok(last.since > nullFrom, 'back to the last bucket (' + last.since + ')');
  assert.ok(engine.metrics.badRunReplays >= 1);
  engine.dispose();
});

// ---- every zoom / pan that stayed live reloaded the whole window -----------------------------------------------------

test('needsRequery: a view that follows live over a live coverage ignores the right edge', () => {
  const { C } = load();
  const p = C.reduceProps(RT());
  const L = C.effectiveLimits(null);
  const now = T0;
  const cov = { start: now - 712500, end: now - 700, mode: 'raw', bucketMs: null, live: true };
  assert.equal(C.needsRequery(now - 570000, now, cov, p, 1000, L, now, true), false, 'was true: an unchanged live view reloaded');
  assert.equal(C.needsRequery(now - 570000, now, cov, p, 1000, L, now), true, 'not following live: the right edge counts');
  assert.equal(C.needsRequery(now - 700000, now, cov, p, 1000, L, now, true), true, 'the left edge still counts');
  assert.equal(C.needsRequery(now - 570000, now, Object.assign({}, cov, { live: false }), p, 1000, L, now, true), true);
});

test('engine: zooming within a live window that stays live does not reload it', async () => {
  const { engine, clock, route } = setup({ props: RT() });
  engine.start();
  await clock.advance(3 * S);
  // a first zoom-in may re-query once (its 10 % left margin leaves the configured window): that one is legitimate
  engine.viewportSet({ min: clock.now() - 9.5 * M, max: clock.now() });
  await clock.advance(2 * S);
  const loads = engine.metrics.fullLoads;
  const before = route.calls.filter((c) => c.body.pens[0].since == null).length;
  for (const f of [0.95, 0.95, 0.93]) {
    const now = clock.now();
    engine.viewportSet({ min: now - f * 10 * M, max: now });
    await clock.advance(2 * S);
  }
  assert.equal(engine.viewport.get().followLive, true);
  assert.equal(engine.metrics.fullLoads, loads, 'was one full reload per gesture');
  assert.equal(route.calls.filter((c) => c.body.pens[0].since == null).length, before);
  engine.dispose();
});

// ---- export: a raw fetch outlives its menu; the chart's unmount aborts it -------------------------------------------

test('engine.dispose aborts an in-flight fetchRaw', async () => {
  const { engine, clock } = setup({ props: RT() });
  engine.start();
  await clock.advance(2 * S);
  const p = engine.fetchRaw({ start: clock.now() - M, end: clock.now(), penKeys: ['p:0'] });
  engine.dispose();
  const res = await p;
  assert.ok(res.error, 'was a normal answer after the chart was gone: ' + JSON.stringify(plain(res)).slice(0, 80));
});

// ---- a pinned X-Trace placed while live moved with a pan ------------------------------------------------------------

function mountChart(opts = {}) {
  const env = createEnv();
  env.window.addEventListener = () => {};
  env.window.removeEventListener = () => {};
  env.window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 1);
  env.window.cancelAnimationFrame = (id) => clearTimeout(id);
  env.window.fetch = (url, init) => {
    const body = JSON.parse(init.body);
    const step = body.mode === 'raw' ? 1000 : (body.bucketMs || 5000);
    const t = [];
    for (let x = Math.ceil(body.start / step) * step; x < Math.min(body.end, Date.now()); x += step) t.push(x);
    return Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify({
      v: 2, ok: true, requestId: body.requestId, serverNow: Date.now(),
      window: { start: body.start, end: Math.min(body.end, Date.now()), mode: body.mode, aggregation: body.aggregation, bucketMs: body.bucketMs, bucketTime: body.bucketMs ? 'start' : null },
      pens: body.pens.map((p) => ({ key: p.key, tagPath: p.tagPath, status: 'ok', t, v: t.map((x) => 50 + Math.sin(x / 60000) * 40), anchor: null })),
    })) });
  };
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  const NS = env.window.__CTG, C = NS.chart;
  let tree = JSON.parse(JSON.stringify(opts.raw || { pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Pressure' }],
    timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } }));
  const writes = [];
  const store = {
    name: 'chart', addressPathString: '0:0', view: { page: { sessionProps: { read: (k) => (k === 'locale' ? 'en-US' : k === 'timeZoneId' ? 'UTC' : k === 'device.type' ? 'browser' : null) } } },
    props: { read: (k) => (k in tree ? JSON.parse(JSON.stringify(tree[k])) : undefined), write: (k, v) => { writes.push({ key: k, value: JSON.parse(JSON.stringify(v)) }); tree[k] = v; } },
  };
  const source = {
    snap: { pens: [
      { key: 'p:0', source: 'pens', index: 0, tagPath: '[default]CTG/Temp', name: 'Temp', status: 'ok', meta: { dataType: 'Float8' }, trendable: true },
      { key: 'p:1', source: 'pens', index: 1, tagPath: '[default]CTG/Pressure', name: 'Pressure', status: 'ok', meta: { dataType: 'Float8' }, trendable: true },
    ], trend: { group: 'default', paths: [], max: 32 }, limits: { maxPens: 32 }, trendEdit: { allowed: true },
    readScope: { runtimePensAllowed: true, roots: [] }, tagBrowser: { allowed: false, reason: 'ACTION_DISABLED' },
    annotations: opts.annotations || { allowed: false, editAllowed: false } },
    state: { connected: true }, staleReason: () => null, values: {},
    getCreds: () => ({ url: '/data/simpletagdisplay/v2/history', token: 't', expiresAt: 4102444800000 }),
    renewToken: () => Promise.resolve(true),
    request: () => Promise.resolve({ ok: true, data: {} }),
    on() { return () => {}; }, attach() {}, detach() {},
  };
  store.delegate = source;
  const mk = () => ({ store, props: C.reduceProps(tree), delegate: { phase: 'ready', connected: true }, eventsEnabled: true,
    componentEvents: { fireComponentEvent() {} }, emit: (o) => ({ className: (o.classes || []).join(' '), style: {} }) });
  const comp = new C.CtgChart(mk());
  comp.setState = function (patch, cb) { this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch); if (cb) cb(); };
  comp.forceUpdate = () => {};
  return { env, NS, C, comp, writes, source, store };
}
function findRaw(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => findRaw(n, pred, out)); return out; }
  if (node.props && pred(node)) out.push(node);
  if (node.children) findRaw(node.children, pred, out);
  if (node.props && node.props.children) findRaw(node.props.children, pred, out);
  if (typeof node.type === 'function' && node.type.prototype && node.type.prototype.render && !pred(node) &&
      (node.type.name === 'RenderPart' || node.type.name === 'ChartErrorBoundary')) {
    const kids = node.children || [];
    const props = Object.assign({}, node.props, { children: kids.length <= 1 ? kids[0] : kids });
    const inst = new node.type(props); inst.props = props; if (!inst.state) inst.state = {};
    findRaw(inst.render(), pred, out);
  }
  return out;
}

test('X-Trace pinned while live becomes a fixed time when the view leaves live (pan / zoom / date change)', async () => {
  const s = mountChart();
  s.comp.componentDidMount();
  await flush(40);
  const ix = s.comp.ix;
  const vp = s.comp.engine.viewport.get();
  assert.equal(vp.followLive, true);
  const t = Math.round(vp.max - 6 * M);
  assert.equal(ix.pin(t), true);
  assert.ok(ix.traces[0].fromEndMs != null, '{fromEndMs} while following live');
  // Shift+ArrowLeft-like pan: half a window into the past
  s.comp.engine.viewportSet({ min: vp.max - 22 * M, max: vp.max - 7 * M });
  assert.equal(s.comp.engine.viewport.get().followLive, false);
  assert.ok(ix.traces[0].time != null && Math.abs(ix.traces[0].time - t) <= 50, 'was {fromEndMs}: the line kept its screen x and read another moment');
  const frozen = ix.traces[0].time;
  assert.equal(ix.traceTimes()[0], frozen);
  const w = s.writes.filter((x) => x.key === 'interaction').pop().value;
  assert.deepEqual(plain(w.xTrace.values), [{ time: frozen }], 'interaction.xTrace says what is shown');
  s.comp.componentWillUnmount();
});

// ---- 'annotate' without annotation editing ---------------------------------------------------------------------------

test("interaction.mode 'annotate' acts as X-Trace while annotation editing is not offered", async () => {
  const off = mountChart({ raw: { pens: [{ tagPath: '[default]CTG/Temp' }], interaction: { mode: 'annotate' }, timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } } });
  off.comp.componentDidMount();
  await flush(40);
  assert.equal(off.comp.mode(), 'xTrace', 'was annotate: no toolbar mode checked, no hover, every click an "Add note" dialog');
  const radios = findRaw(off.comp.render(), (n) => n.props && n.props.role === 'radio');
  assert.ok(radios.some((r) => r.props['aria-checked'] === 'true' || r.props['aria-checked'] === true), 'one toolbar mode is checked');
  assert.equal(off.writes.filter((w) => w.key === 'interaction').length, 0, 'the prop is not rewritten');
  off.comp.componentWillUnmount();
  const on = mountChart({ raw: { pens: [{ tagPath: '[default]CTG/Temp' }], interaction: { mode: 'annotate' }, annotations: { enabled: true },
    timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } }, annotations: { allowed: true, editAllowed: true } });
  on.comp.componentDidMount();
  await flush(40);
  assert.ok(on.C.panels.get('annotation'), 'the annotation editor is registered');
  assert.equal(on.comp.mode(), 'annotate', 'offered: annotate stays');
  on.comp.componentWillUnmount();
});

// ---- the More button did not close its own menu ---------------------------------------------------------------------

test('the toolbar menu ignores presses on its own opener, so a second click toggles it closed', async () => {
  const s = mountChart({ raw: { pens: [{ tagPath: '[default]CTG/Temp' }], timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } } });
  s.comp.componentDidMount();
  await flush(40);
  s.comp.setState({ narrow: true, rootW: 400, rootH: 300 });
  let r = s.comp.render();
  const btn = { getBoundingClientRect: () => ({ left: 5, top: 5, right: 25, bottom: 25, width: 20, height: 20 }) };
  findRaw(r, (n) => n.props && n.props['data-ctg'] === 'more')[0].props.onClick({ currentTarget: btn, detail: 1 });
  r = s.comp.render();
  const menu = findRaw(r, (n) => n.type === s.NS.ui.Menu)[0];
  assert.ok(menu);
  assert.equal(menu.props.ignoreEls && menu.props.ignoreEls[0], btn, 'was undefined: the press closed it and the click re-opened it');
  s.comp.componentWillUnmount();
});

// ---- focus after a keyboard pen removal ------------------------------------------------------------------------------

test('after a pen removal focus goes to the remove button now at that row (or the previous one), not <body>', () => {
  const { NS, env } = load();
  const doc = env.context.document;
  doc.body = { tag: 'body' };
  const focused = [];
  const btn = (n) => ({ n, isConnected: true, disabled: false, focus() { focused.push(n); doc.activeElement = this; } });
  const [b0, b1, b2] = [btn(0), btn(1), btn(2)];
  let list = [b0, b1, b2];
  const root = { querySelectorAll: () => list, querySelector: () => null, focus() { focused.push('root'); } };
  const c = Object.create(NS.chart.CtgChart.prototype);
  Object.assign(c, { _rootEl: root, state: { confirm: null } });
  c._rememberRemoveFocus(b1);
  doc.activeElement = b1;
  c._restoreRemoveFocus();
  assert.deepEqual(focused, [], 'the row is still there (pens push pending)');
  list = [b0, b2]; b1.isConnected = false; doc.activeElement = doc.body;   // the row unmounted
  c._restoreRemoveFocus();
  assert.deepEqual(focused, [2], 'was <body>; the next row\'s remove button');
  // the last row: the previous one
  focused.length = 0;
  c._rememberRemoveFocus(b2);
  list = [b0]; b2.isConnected = false; doc.activeElement = doc.body;
  c._restoreRemoveFocus();
  assert.deepEqual(focused, [0]);
  // the operator moved on meanwhile: left alone
  focused.length = 0;
  const other = { isConnected: true };
  c._rememberRemoveFocus(b0);
  list = []; b0.isConnected = false; doc.activeElement = other;
  c._restoreRemoveFocus();
  assert.deepEqual(focused, []);
});

// ---- theme-variable pen colours on the canvas -----------------------------------------------------------------------

test('pen colours given as theme variables are resolved to a concrete colour for the canvas', () => {
  const { NS, C, env } = load();
  const p = C.reduceProps({ pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Pressure', color: '--qual-3' }],
    appearance: { palette: ['var(--qual-1)', '#2f7ed8'] } });
  const mps = [penInfo(0, '[default]CTG/Temp'), penInfo(1, '[default]CTG/Pressure')];
  const map = { 'var(--qual-3)': 'rgb(8, 105, 98)', 'var(--qual-1)': 'rgb(47, 126, 216)' };
  const vms = C.buildPens(mps, p, { resolve: (c) => map[c] || c });
  assert.equal(vms[1].color, 'rgb(8, 105, 98)', 'was var(--qual-3): a 2D context ignores it and kept the previous stroke');
  assert.equal(vms[1].colorExplicit, 'var(--qual-3)', 'the explicit (CSS) form stays for the swatch / picker');
  assert.equal(vms[0].color, 'rgb(47, 126, 216)', 'palette theme variables too');
  // the chart's resolver: a hidden probe's computed colour, cached until the theme changes
  const doc = env.context.document;
  doc.createElement = () => ({ style: {} });
  let probes = 0;
  env.window.getComputedStyle = (el) => { probes++; return { color: el.style.color === 'var(--qual-3)' ? 'rgb(8, 105, 98)' : '' }; };
  const c = Object.create(NS.chart.CtgChart.prototype);
  c._rootEl = { appendChild() {}, removeChild() {} };
  assert.equal(c._resolveColor('var(--qual-3)'), 'rgb(8, 105, 98)');
  assert.equal(c._resolveColor('var(--qual-3)'), 'rgb(8, 105, 98)');
  assert.equal(probes, 1, 'cached');
  assert.equal(c._resolveColor('#00AA00'), '#00AA00', 'concrete colours untouched');
  assert.equal(c._resolveColor('var(--nope)'), 'var(--nope)', 'unresolvable: the CSS form');
});

// ---- settings drafts lost on chart unmount ----------------------------------------------------------------------------

test('the chart flushes open panels\' drafts at the top of its unmount, while the API still writes', async () => {
  const s = mountChart();
  s.comp.componentDidMount();
  await flush(40);
  const results = [];
  const off = s.comp.api._flushOnUnmount(() => { results.push(s.comp.api.patch('pens', (raw) => { raw[0].name = 'Renamed'; return raw; })); });
  assert.equal(typeof off, 'function');
  s.comp.componentWillUnmount();
  assert.deepEqual(results, [true], 'was: the panel flushed after the engine was gone (patch -> false, edit dropped)');
  assert.equal(s.writes.filter((w) => w.key === 'pens').pop().value[0].name, 'Renamed');
  assert.equal(Object.keys(s.comp.api).includes('_flushOnUnmount'), false, 'internal: not part of the documented API');

  // the SettingsPanel registers its DraftStore flush with that hook and unregisters on its own unmount
  const st = createChartApiStub({ props: { pens: [{ tagPath: '[default]CTG/Temp' }] } });
  const Comp = st.env.window.PerspectiveClient.Component;
  Comp.prototype.setState = function (patch, cb) { this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch); if (cb) cb(); };
  let hook = null, unhooked = 0;
  const api = Object.assign({}, st.api);
  Object.defineProperty(api, '_flushOnUnmount', { value: (fn) => { hook = fn; return () => { unhooked++; }; } });
  const sp = new st.NS.chartPanels.SettingsPanel({ api, args: { source: 'toolbar' }, close() {} });
  sp.componentDidMount();
  assert.equal(typeof hook, 'function');
  let flushes = 0;
  const orig = sp.drafts.flush.bind(sp.drafts);
  sp.drafts.flush = () => { flushes++; return orig(); };
  hook();
  assert.equal(flushes, 1);
  sp.componentWillUnmount();
  assert.equal(unhooked, 1);
});

// ---- a raw CSV export was cancelled by a window blur / scroll ------------------------------------------------------

function toolsSetup(fixture) {
  const s = createChartApiStub(Object.assign({ props: { pens: [{ tagPath: '[default]CTG/Temp' }], export: { csv: { source: 'raw', timeFormat: 'epoch' } } } }, fixture || {}));
  const saved = [], toasts = [];
  const ctx = s.env.context;
  ctx.Blob = Blob;
  ctx.AbortController = AbortController;
  const doc = ctx.document;
  doc.body = { appendChild() {}, removeChild() {} };
  const origCreate = doc.createElement;
  const urls = new Map();
  let n = 0;
  ctx.URL = { createObjectURL: (b) => { const u = 'blob:t/' + (++n); urls.set(u, b); return u; }, revokeObjectURL: (u) => urls.delete(u) };
  doc.createElement = (tag) => (tag !== 'a' ? origCreate(tag)
    : { tag, download: '', href: '', style: {}, click() { saved.push({ name: this.download, blob: urls.get(this.href) }); } });
  try { s.NS.ui.Toast.show = (o) => { toasts.push(o.text); }; } catch (e) { /* frozen */ }
  return Object.assign(s, { saved, toasts, T: s.NS.chart.tools });
}
function mountTool(Comp, api, args = {}) {
  const closed = [];
  const inst = new Comp({ api, args, close: () => closed.push(1) });
  inst.setState = (patch) => { Object.assign(inst.state, typeof patch === 'function' ? patch(inst.state) : patch); };
  if (inst.componentDidMount) inst.componentDidMount();
  return { inst, closed };
}
function deferredFetch() {
  const d = {};
  d.fetchRaw = (o) => { d.signal = o.signal; return new Promise((res) => { d.resolve = res; }); };
  return d;
}

test('raw CSV: closing the menu (blur / scroll / outside) keeps the export; the file is saved when the data arrives', async () => {
  const s = toolsSetup();
  const d = deferredFetch();
  const api = Object.assign({}, s.api, { history: Object.assign({}, s.api.history, { fetchRaw: d.fetchRaw }) });
  const { inst, closed } = mountTool(s.T.ExportMenu, api, {});
  inst.render().props.items[0].onSelect();
  assert.equal(inst.state.busy, true);
  inst.render().props.onClose('blur');                     // the operator Alt-Tabs to mail
  assert.equal(closed.length, 1, 'the menu closes');
  inst.componentWillUnmount();                             // ... and unmounts
  assert.equal(d.signal.aborted, false, 'was aborted: no file, no toast');
  d.resolve({ pens: [{ key: 'p:0', t: [T0, T0 + 1000], v: [1, 2], status: 'ok' }] });
  await flush();
  assert.equal(s.saved.length, 1, 'the file is saved');
  assert.match(await s.saved[0].blob.text(), /1\r?\n|2/);
});

test('raw CSV: the chart going away cancels with a notice; the Cancel item cancels quietly', async () => {
  const s = toolsSetup();
  const d = deferredFetch();
  const api = Object.assign({}, s.api, { history: Object.assign({}, s.api.history, { fetchRaw: d.fetchRaw }) });
  const a = mountTool(s.T.ExportMenu, api, {});
  a.inst.render().props.items[0].onSelect();
  a.inst.render().props.onClose('scroll');
  a.inst.componentWillUnmount();
  d.resolve({ pens: [{ key: 'p:0', t: [], v: [], status: 'aborted' }], error: 'ABORTED' });
  await flush();
  assert.equal(s.saved.length, 0);
  assert.ok(s.toasts.some((t) => /Export cancelled/.test(t)), 'was silent');

  const d2 = deferredFetch();
  const api2 = Object.assign({}, s.api, { history: Object.assign({}, s.api.history, { fetchRaw: d2.fetchRaw }) });
  const b = mountTool(s.T.ExportMenu, api2, {});
  b.inst.render().props.items[0].onSelect();
  const n = s.toasts.length;
  b.inst.render().props.items.find((i) => i.id === 'cancel').onSelect();
  assert.equal(d2.signal.aborted, true, 'Cancel aborts');
  d2.resolve({ pens: [], error: 'ABORTED' });
  await flush();
  assert.equal(s.toasts.length, n, 'no notice for the explicit Cancel');
  assert.equal(s.saved.length, 0);
});

// ---- colour picker Default for a non-hex explicit colour ---------------------------------------------------------------

test('colour picker: Default is enabled for any explicit colour (rgb(), named, var())', () => {
  for (const color of ['rgb(220, 20, 60)', 'crimson', 'var(--qual-3)']) {
    const s = toolsSetup({ props: { pens: [{ tagPath: '[default]CTG/Temp', color }] } });
    const { inst } = mountTool(s.T.ColorPicker, s.api, { penKey: 'p:0' });
    const find = (node, out = []) => {
      if (!node || typeof node !== 'object') return out;
      if (Array.isArray(node)) { node.forEach((x) => find(x, out)); return out; }
      if (node.props && node.props['data-ctg-default']) out.push(node);
      if (node.children) find(node.children, out);
      if (node.props) for (const v of Object.values(node.props)) if (v && typeof v === 'object') find(v, out);
      return out;
    };
    const def = find(inst.render())[0];
    assert.ok(def, 'the Default button');
    assert.equal(!!def.props.disabled, false, color + ': was disabled, the pen could not go back to automatic');
  }
});

// ---- Escape in the tag browser filter closed the panel ---------------------------------------------------------------

test('tag browser: Escape in a non-empty filter clears it and keeps the panel; on an empty filter it closes as before', () => {
  const s = createChartApiStub({ props: { tagBrowser: { enabled: true }, pens: [] }, penInfos: [],
    capabilities: { readScope: { runtimePensAllowed: true, roots: ['[default]CTG'] } },
    handlers: { 'chart.browse': () => ({ ok: true, data: { path: '', continuation: null, results: [] } }) } });
  const Comp = s.env.window.PerspectiveClient.Component;
  Comp.prototype.setState = function (patch, cb) { this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch); if (cb) cb(); };
  Comp.prototype.forceUpdate = function () {};
  const tb = new s.NS.chartPanels.TagBrowser({ api: s.api, args: { source: 'toolbar' }, close() {} });
  tb.componentDidMount();
  const input = () => {
    const out = [];
    const walk = (n) => {
      if (!n || typeof n !== 'object') return;
      if (Array.isArray(n)) { n.forEach(walk); return; }
      if (n.type === 'input' && n.props && n.props.type === 'search') out.push(n);
      if (n.children) walk(n.children);
      if (n.props && n.props.children) walk(n.props.children);
      if (typeof n.type === 'function' && n.type.prototype && n.type.prototype.render) {
        const kids = n.children || [];
        const props = Object.assign({}, n.props, kids.length ? { children: kids.length === 1 ? kids[0] : kids } : {});
        const inst = new n.type(props); inst.props = props; if (!inst.state) inst.state = {};
        walk(inst.render());
      }
    };
    walk(tb.render());
    return out[0];
  };
  input().props.onChange({ target: { value: 'Pre' } });
  assert.equal(tb.state.filter, 'Pre');
  let stopped = false;
  const e = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { stopped = true; } };
  input().props.onKeyDown(e);
  assert.equal(tb.state.filter, '', 'cleared');
  assert.equal(e.defaultPrevented, true, 'was not handled: PanelFrame closed the panel and the selection was lost');
  assert.equal(stopped, true);
  const e2 = { key: 'Escape', defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
  input().props.onKeyDown(e2);
  assert.equal(e2.defaultPrevented, false, 'empty filter: left to the panel (closes)');
});

// ---- security (client mirror): anonymous sessions own no annotation -----------------------------------------------------

test('annotation editor: an anonymous session is not the owner of an anonymous note', () => {
  const { NS } = load();
  const P = NS.chartPanels;
  const caps = (user) => ({ enabled: true, designMode: false, user, annotations: { editAllowed: true, moderateAllowed: false } });
  assert.equal(P.annCanEdit(caps('Unauthenticated'), { id: 'a', author: 'Unauthenticated' }, true), false, 'was true');
  assert.equal(P.annCanEdit(caps('engineer'), { id: 'a', author: 'engineer' }, true), true);
  assert.equal(P.annCanEdit(caps('Unauthenticated'), { id: 'a', author: 'Unauthenticated' }, false), true, 'ownOnly off: anyone with edit');
});
