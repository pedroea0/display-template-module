// =============================================================================
// chart-stats-and-pens.test.mjs — statistics, per-pen reloads, token renewal
// and pen UI of the chart
// =============================================================================
// Engine tests run the real ChartEngine against a fake history route and a
// manual clock (the chart-engine.test.mjs scaffold); UI tests call the pure
// helpers.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, FILES } from './_stubs.mjs';

const S = 1000, M = 60 * S, H = 60 * M;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);
const plain = (x) => JSON.parse(JSON.stringify(x));   // values from the vm realm

function load() {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  return { env, NS: env.window.__CTG, C: env.window.__CTG.chart };
}
async function flush() { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); }
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
/** Default answer: one sample per second (v = t / 1000), raw or aggregated LastValue (chart-engine.test.mjs). */
function answer(body, now) {
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
      return { key: p.key, tagPath: p.tagPath, status: 'ok', aggregation: p.aggregation, shape: 'points', t, v: t.map((x) => (x + b - 1) / 1000),
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
    return Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(json)) });
  };
  fn.calls = calls;
  return fn;
}
function penInfo(i, tagPath) {
  return { key: 'p:' + i, source: 'pens', index: i, tagPath, name: tagPath.split('/').pop(), status: 'ok', meta: null, trendable: true };
}
function fakeSource(pens, creds) {
  const ls = [];
  return {
    snap: { pens, trend: { group: null, paths: [], max: 32 }, limits: { maxPens: 32, minBucketMs: 100, maxConcurrentPerSession: 4 } },
    creds: creds || { url: '/data/simpletagdisplay/v2/history', token: 'tok-1', expiresAt: 4102444800000 },
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
  const source = fakeSource(o.pens || [penInfo(0, '[default]CTG/Temp')], o.creds && o.creds(clock.now()));
  const doc = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const props = C.reduceProps(o.props);
  const engine = new C.ChartEngine({ id: 'c1', source, queue, now: clock.now, timers: clock.timers, document: doc, fetch: route,
    props, timeZone: 'UTC', plotWidth: 1000 });
  return { C, NS, env, clock, route, source, engine };
}

// ---- a per-pen timeout in a full load is retried --------------------------------------------------------------

test('a pen that timed out in the full load is re-loaded (5 s, then backoff); the others keep ticking', async () => {
  const pens = [penInfo(0, '[default]CTG/Temp'), penInfo(1, '[default]CTG/Pressure')];
  const { engine, route, clock } = setup({
    pens,
    props: { pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Pressure' }],
      timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 1000 }, query: { mode: 'raw' } },
    respond: (body, n, now) => {
      if (n !== 1) return null;
      const a = answer(body, now);
      a.pens = a.pens.map((p) => (p.tagPath.endsWith('Pressure') ? { key: p.key, tagPath: p.tagPath, status: 'timeout', t: [], v: [] } : p));
      return a;
    },
  });
  engine.start();
  await clock.advance(10);
  assert.equal(engine.penData('p:1').status, 'timeout');
  await clock.advance(120 * S);
  const pd = engine.penData('p:1');
  assert.equal(pd.status, 'ok', 'retried (was: timeout with 0 points for good)');
  assert.ok(pd.t.length > 0);
  assert.ok(route.calls.some((c, i) => i > 0 && !c.body.pens.some((p) => p.since != null) && c.body.pens.length === 1 &&
    c.body.pens[0].tagPath.endsWith('Pressure')), 'a pen-add load for the pen alone');
  assert.ok(route.calls.filter((c) => c.body.pens.some((p) => p.since != null && p.tagPath.endsWith('Pressure'))).length > 0,
    'then it ticks like the others');
  engine.dispose();
});

// ---- downgraded pens of a raw realtime chart keep ticking -----------------------------------------------------

test('a pen downgraded by onTooManyPoints "aggregate" ticks on its own aggregated grid', async () => {
  const { engine, route, clock } = setup({
    props: { pens: [{ tagPath: '[default]CTG/Temp' }], timeRange: { realtime: { value: 10, unit: 'minutes' }, refreshRate: 1000 },
      query: { mode: 'raw', maxPointsPerPen: 1000, onTooManyPoints: 'aggregate' } },
    respond: (body, n, now) => {
      if (body.mode !== 'raw' || body.pens.some((p) => p.since != null)) return null;
      const b = 1000;
      const aS = Math.floor(body.start / b) * b, aE = Math.floor(Math.min(body.end, now) / b) * b;
      const t = [];
      for (let x = aS; x < aE; x += b) t.push(x);
      return { v: 2, ok: true, requestId: body.requestId, serverNow: now,
        window: { start: body.start, end: Math.min(body.end, now), mode: 'raw', aggregation: body.aggregation, bucketMs: null, bucketTime: null, aligned: false, downgraded: false },
        pens: body.pens.map((p) => ({ key: p.key, tagPath: p.tagPath, status: 'ok', downgraded: true, bucketMs: b, aggregation: 'LastValue',
          shape: 'points', t, v: t.map((x) => x / 1000), anchor: null, replaceFrom: null, count: t.length })) };
    },
  });
  engine.start();
  await clock.advance(10);
  const pd = engine.penData('p:0');
  assert.equal(pd.coverage.mode, 'aggregated');
  const end0 = pd.lastHistT;
  await clock.advance(60 * S);
  const ticks = route.calls.filter((c) => c.body.pens.some((p) => p.since != null));
  assert.ok(ticks.length >= 30, 'ticks for the downgraded pen (was 0): ' + ticks.length);
  assert.ok(ticks.every((c) => c.body.mode === 'aggregated' && c.body.bucketMs === 1000), 'on its own grid');
  assert.ok(engine.penData('p:0').lastHistT >= end0 + 50 * S, 'its history advances');
  engine.dispose();
});

// ---- time-weighted Avg in a historical window keeps the held tail ---------------------------------------------

const A = T0 - 284 * S;
function histProps(extra) {
  return Object.assign({ pens: [{ tagPath: '[default]CTG/Flag' }],
    timeRange: { mode: 'historical', historical: { startDate: A, endDate: T0 } }, query: { mode: 'raw' } }, extra);
}

test('historical Avg: the value after the last change counts until the window end (pump off reads 64.8 %, not 100 %)', async () => {
  const { engine, clock } = setup({
    start: T0 + H, pens: [penInfo(0, '[default]CTG/Flag')], props: histProps(),
    respond: (body, n, now) => ({ v: 2, ok: true, requestId: body.requestId, serverNow: now,
      window: { start: body.start, end: body.end, mode: 'raw', aggregation: body.aggregation, bucketMs: null, bucketTime: null, aligned: false, downgraded: false },
      pens: body.pens.map((p) => ({ key: p.key, tagPath: p.tagPath, status: 'ok', t: [A + 184 * S], v: [0], anchor: { t: A - 10 * S, v: 1 },
        replaceFrom: null, downgraded: false, count: 1 })) }),
  });
  engine.start();
  await clock.advance(10 * S);
  const st = engine.stats('p:0');
  assert.equal(st.last, 0);
  assert.ok(Math.abs(st.average - 184 / 284) < 1e-6, 'avg ' + st.average + ' (was 1)');
  engine.dispose();
});

// ---- breakOnGapMs gap markers are not data ---------------------------------------------------------------------

test('breakOnGapMs: the gap breaks stay in the plot only (stats, Current, X-Trace, series.rows read real samples)', async () => {
  const B0 = T0 - 11 * M;
  const { C, engine, clock } = setup({
    start: T0 + H, pens: [penInfo(0, '[default]CTG/OnChange')],
    props: { pens: [{ tagPath: '[default]CTG/OnChange' }], timeRange: { mode: 'historical', historical: { startDate: B0, endDate: T0 } },
      query: { mode: 'raw' }, appearance: { breakOnGapMs: 60000 } },
    respond: (body, n, now) => ({ v: 2, ok: true, requestId: body.requestId, serverNow: now,
      window: { start: body.start, end: body.end, mode: 'raw', aggregation: body.aggregation, bucketMs: null, bucketTime: null, aligned: false, downgraded: false },
      pens: body.pens.map((p) => ({ key: p.key, tagPath: p.tagPath, status: 'ok', t: [B0, B0 + 10 * M], v: [20, 40], anchor: null,
        replaceFrom: null, downgraded: false, count: 2 })) }),
  });
  engine.start();
  await clock.advance(10 * S);
  assert.deepEqual(plain(engine.penView('p:0').v), [20, 40], 'data view: real samples only');
  assert.ok(engine.penView('p:0', true).v.includes(null), 'the plot still breaks the line');
  const join = engine.join('plot0', ['p:0']);
  assert.ok(join.data[1].includes(null), 'the joined plot data keeps the break');
  const st = engine.stats('p:0', B0 + 6 * M, T0);
  assert.equal(st.first, 20, 'held value at a (was null: the gap marker)');
  assert.equal(st.minimum, 20, '(was 40)');
  assert.ok(Math.abs(st.average - 24) < 1e-9, 'avg ' + st.average + ' (was 40)');
  assert.equal(engine.valueAt('p:0', B0 + 7 * M, 'step'), 20, 'X-Trace: not "Bad quality"');
  engine.viewport.set({ min: B0, max: B0 + 7 * M });
  assert.equal(engine.current('p:0').v, 20, 'End column (was null: "—")');
  engine.dispose();
});

// ---- Avg of MinMax pens ------------------------------------------------------------------------------------------

test('MinMax: each pair weighs as one bucket at its mean (a rising sawtooth averages its midpoint, not its maxima)', async () => {
  const b = 10 * S;
  const { engine, clock } = setup({
    start: T0 + H, pens: [penInfo(0, '[default]CTG/Counter')],
    props: { pens: [{ tagPath: '[default]CTG/Counter' }], timeRange: { mode: 'historical', historical: { startDate: T0 - 100 * S, endDate: T0 } },
      query: { mode: 'aggregated', aggregation: 'MinMax' } },
    respond: (body, n, now) => {
      const t = [], v = [];
      for (let x = T0 - 100 * S; x < T0; x += b) { t.push(x, x); v.push(0, 10); }
      return { v: 2, ok: true, requestId: body.requestId, serverNow: now,
        window: { start: T0 - 100 * S, end: T0, mode: 'aggregated', aggregation: 'MinMax', bucketMs: b, bucketTime: 'start', aligned: true, downgraded: false },
        pens: body.pens.map((p) => ({ key: p.key, tagPath: p.tagPath, status: 'ok', aggregation: 'MinMax', shape: 'minmax', t, v, anchor: null,
          replaceFrom: null, downgraded: false, count: t.length })) };
    },
  });
  engine.start();
  await clock.advance(10 * S);
  const st = engine.stats('p:0');
  assert.equal(st.minimum, 0);
  assert.equal(st.maximum, 10);
  assert.ok(Math.abs(st.average - 5) < 0.01, 'avg ' + st.average + ' (was ~10)');
  engine.dispose();
});

test('statsFor pairs option: unit check, and nothing changes without it', () => {
  const { C } = load();
  const view = { t: [0, 1, 10000, 10001], v: [0, 10, 0, 10] };
  assert.ok(Math.abs(C.statsFor(view, 0, 20000, { lastKnownTime: 20000, pairs: true }).average - 5) < 1e-9);
  assert.ok(C.statsFor(view, 0, 20000, { lastKnownTime: 20000 }).average > 9.9, 'raw data (no pairs) is unchanged');
});

// ---- token renewal with a short TTL --------------------------------------------------------------------------------

test('a 90 s token is renewed at half its life, not on every tick', async () => {
  const { engine, clock, source } = setup({
    creds: (now) => ({ url: '/data/simpletagdisplay/v2/history', token: 'tok-1', issuedAt: now, expiresAt: now + 90 * S }),
    props: { pens: [{ tagPath: '[default]CTG/Temp' }], timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 1000 } },
  });
  engine.start();
  await clock.advance(20 * S);
  assert.equal(source.renewCount, 0, 'no renewal while more than half the lifetime is left (was one per tick)');
  await clock.advance(30 * S);
  assert.ok(source.renewCount >= 1, 'renewed once past half');
  const { C } = load();
  assert.equal(C.renewBeforeMs({ issuedAt: 0, expiresAt: 900000 }), 120000, 'long TTL: the 120 s margin as before');
  assert.equal(C.renewBeforeMs({ issuedAt: 0, expiresAt: 60000 }), 30000);
  assert.equal(C.renewBeforeMs({ expiresAt: 60000 }), 120000, 'no issuedAt: unchanged');
  engine.dispose();
});

// ---- chart UI ------------------------------------------------------------------------------------------------------

test('Copy stats: the TSV guard matches the CSV guard (leading space, tab, full-width / look-alike triggers)', () => {
  const { C } = load();
  const FW_EQ = String.fromCharCode(0xff1d), MINUS = String.fromCharCode(0x2212);
  for (const s of [' =HYPERLINK("http://x","y")', '\t=1+1', FW_EQ + '1+1', MINUS + 'A1', '=1+1', '@SUM(A1)']) {
    assert.equal(C.tsvCell(s).charAt(0), "'", JSON.stringify(s) + ' -> ' + JSON.stringify(C.tsvCell(s)));
  }
  assert.equal(C.tsvCell('Temp (degF)'), 'Temp (degF)');
  assert.equal(C.tsvCell('a\tb'), 'a b');
});

test('log axis: range.mode manual and engineering apply (values > 0), decades otherwise', () => {
  const { C } = load();
  const axis = (range) => ({ digital: false, cfg: { scale: 'log', range: Object.assign({ mode: 'auto', min: null, max: null, includeZero: false, padding: 0.05 }, range) } });
  assert.deepEqual(plain(C.yRange(axis({ mode: 'manual', min: 0.001, max: 100000 }), 3, 45, {}, null)), [0.001, 100000], 'was [1, 100]');
  assert.deepEqual(plain(C.yRange(axis({ mode: 'engineering' }), 3, 45, {}, { low: 0.01, high: 1000 })), [0.01, 1000], 'was [1, 100]');
  assert.deepEqual(plain(C.yRange(axis({ mode: 'manual', min: -5, max: 1000 }), 3, 45, {}, null)), [1, 1000], 'a side <= 0 falls back to the decade');
  assert.deepEqual(plain(C.yRange(axis({}), 3, 45, {}, null)), [1, 100], 'auto unchanged');
});

test('pen table show/hide on a static pen writes the pen with that tag, not the one now at its old index', () => {
  const { C } = load();
  const c = Object.create(C.CtgChart.prototype);
  const raw = [{ tagPath: '[default]CTG/A' }, { tagPath: '[default]CTG/B' }];        // reordered since the last chart.pens
  let written = null;
  Object.assign(c, {
    props: { props: { penTable: { allowHide: true } }, store: { props: { read: () => JSON.parse(JSON.stringify(raw)) } } },
    designMode: () => false, pm: null,
    _setVisOverride() {}, _dropOverride() {}, fire() {},
    writeProp(k, v) { written = { k, v }; return true; },
  });
  c._toggleVisible({ source: 'pens', index: 0, key: 'p:0', tagPath: '[default]CTG/B', visible: true, penRef: null });
  assert.equal(written.k, 'pens');
  assert.equal(written.v[1].visible, false, 'B is hidden');
  assert.equal(written.v[0].visible, undefined, 'A is untouched (was hidden instead)');
  written = null;
  c._toggleVisible({ source: 'pens', index: 0, key: 'p:0', tagPath: '[default]CTG/Gone', visible: true, penRef: null });
  assert.equal(written, null, 'a pen that is gone writes nothing');
});

test('native fullscreen: overlays portal into the fullscreen element, and the chart gets its surface colour', () => {
  const { NS, C, env } = load();
  const doc = env.context.document;
  doc.body = { nodeType: 1, tagName: 'BODY' };
  assert.equal(NS.ui.portalHost(), doc.body);
  const fsEl = { nodeType: 1, tagName: 'DIV' };
  doc.fullscreenElement = fsEl;
  assert.equal(NS.ui.portalHost(), fsEl, 'in the top layer, not behind it (was body)');
  doc.fullscreenElement = { nodeType: 1, tagName: 'VIDEO' };
  assert.equal(NS.ui.portalHost(), doc.body, 'a media element cannot hold overlays');
  doc.fullscreenElement = null;
  const css = Array.isArray(C.CHART_CSS) ? C.CHART_CSS.join('') : String(C.CHART_CSS);
  assert.ok(css.includes('.ctg-chart:fullscreen{background-color:var(--ctg-surface);}'),
    'a (0,2,0) rule that beats Perspective\'s ":not(video):fullscreen" background');
});

test('pen editor: built-in axis / plot / style choices the trend pen defaults would override are flagged', () => {
  const { NS } = load();
  const P = NS.chartPanels;
  assert.deepEqual(plain(P.defaultsLocks({ defaults: { axis: '', plot: 0, display: P.defaultDisplay() } })), { axis: false, plot: false, display: false });
  const locks = P.defaultsLocks({ defaults: { axis: 'Right', plot: 1, display: Object.assign(P.defaultDisplay(), { interpolation: 'step' }) } });
  assert.deepEqual(plain(locks), { axis: true, plot: true, display: true });
  // and the reason: an override of plot 0 / axis '' reads as "not set"
  const tp = { defaults: { axis: 'Right', plot: 1, display: P.defaultDisplay() }, overrides: [{ tagPath: '[default]CTG/P', axis: '', plot: 0 }] };
  const eff = P.effectiveOverride(tp, '[default]CTG/P');
  assert.equal(eff.plot, 1);
  assert.equal(eff.axis, 'Right');
});
