// =============================================================================
// chart-aggregation-and-auth.test.mjs — aggregation, export, auth renewal and
// panel behaviour of the chart
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
    const status = json.__status || 200;
    return Promise.resolve({ status, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(json)) });
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


// ---- a failed renewal after a 401 froze the chart on the 'auth' banner ------------------------------------------

test('401 + a RATE_LIMITED renewal: the renewal is retried with backoff, the banner clears and ticks resume', async () => {
  let refuse = false;
  const { engine, clock, source, route } = setup({
    props: { pens: [{ tagPath: '[default]CTG/Temp' }], timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 1000 }, query: { mode: 'raw' } },
    respond: (body, n, now) => (refuse ? { __status: 401, v: 2, ok: false, error: { code: 'TOKEN_INVALID', message: 'gone', retryable: false } } : null),
  });
  let renewals = 0;
  source.renewToken = function () {
    renewals++;
    if (renewals === 1) return Promise.resolve(false);            // chart.token RATE_LIMITED
    refuse = false;
    this.creds = Object.assign({}, this.creds, { token: 'tok-2' });
    return Promise.resolve(true);
  };
  engine.start();
  await clock.advance(5 * S);
  refuse = true;
  await clock.advance(1500);
  assert.equal(engine.banner && engine.banner.code, 'auth');
  assert.equal(renewals, 1);
  const before = route.calls.length;
  await clock.advance(3 * S);                                  // the first retry is due after 2 s
  assert.equal(engine.banner, null, 'recovered by the 2 s retry');
  const recoveredAt = clock.now();
  await clock.advance(3 * S);
  assert.ok(route.calls.some((c) => c.at > recoveredAt && c.body.pens.some((p) => p.since != null)),
    'ticks resume at the refresh rate after the recovery (not 30 s later)');
  await clock.advance(70 * S);
  assert.ok(renewals >= 2, 'renewal retried (was: never again)');
  assert.equal(engine.banner, null, 'banner cleared (was: auth for good)');
  assert.ok(route.calls.length > before + 10, 'history requests resume: ' + (route.calls.length - before));
  assert.equal(route.calls[route.calls.length - 1].body.pens.length, 1);
  engine.dispose();
});

test('auth retry backs off (2 s doubling to 60 s) while every renewal fails, and stops on dispose', async () => {
  const { engine, clock, source } = setup({
    props: { pens: [{ tagPath: '[default]CTG/Temp' }], timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 1000 }, query: { mode: 'raw' } },
    respond: () => ({ __status: 401, v: 2, ok: false, error: { code: 'TOKEN_INVALID' } }),
  });
  let renewals = 0;
  source.renewToken = () => { renewals++; return Promise.resolve(false); };
  engine.start();
  await clock.advance(10);
  assert.equal(engine.banner && engine.banner.code, 'auth');
  const r0 = renewals;
  await clock.advance(5 * 60 * S);
  const n = renewals - r0;
  // 2+4+8+16+32+60+60+60 ... in 300 s: about 9 attempts, never one per second
  assert.ok(n >= 5 && n <= 12, 'backoff attempts in 5 min: ' + n);
  engine.dispose();
  const r1 = renewals;
  await clock.advance(5 * 60 * S);
  assert.equal(renewals, r1, 'no retry after dispose');
});

// ---- statistic aggregations (Count, DurationOn…) are not tag values ----------------------------------------------

const GQ = { code: 192, name: 'Good', level: 'good' };

test('a CountOn pen takes no raw live samples: no tail, no now point, Current is the newest bucket', async () => {
  const { engine, clock, source } = setup({
    props: { pens: [{ tagPath: '[default]CTG/Running', aggregation: 'CountOn' }, { tagPath: '[default]CTG/Temp' }],
      timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 1000 }, query: { mode: 'aggregated', pointCount: 30 } },
    pens: [penInfo(0, '[default]CTG/Running'), penInfo(1, '[default]CTG/Temp')],
  });
  engine.start();
  await clock.advance(5 * S);
  const now = clock.now();
  source.emit('values', { 'p:0': { v: true, q: GQ, t: now }, 'p:1': { v: 41.5, q: GQ, t: now } });
  await clock.advance(10);
  const cnt = engine.penData('p:0');
  assert.equal(cnt.live.t.length, 0, 'no raw sample in the CountOn series (was appended: [..., buckets, 1])');
  assert.equal(cnt.liveLatest, null);
  const view = engine.penView('p:0');
  assert.ok(view.v.every((x) => x > 1000), 'only bucket values in the view: ' + view.v.slice(-3));
  const cur = engine.current('p:0');
  assert.equal(cur.label, 'bucket', 'Current = newest bucket (was the raw 1, labelled current)');
  assert.equal(cur.v, cnt.v[cnt.v.length - 1]);
  // the value pen keeps its live tail and Current
  assert.equal(engine.penData('p:1').live.t.length, 1);
  assert.equal(engine.current('p:1').v, 41.5);
  // the synthetic now point carries nothing for the CountOn pen
  const j = engine.join('plot0', ['p:0', 'p:1']);
  const last = j.data[0].length - 1;
  if (j.synthetic) assert.equal(j.data[1][last], undefined, 'no now point for CountOn');
  engine.dispose();
});

test('auto mode stays aggregated on short windows while a pen uses a statistic aggregation', () => {
  const { C } = load();
  const L = C.effectiveLimits(null);
  const win = { start: T0 - 15 * M, end: T0 };
  const plain = C.reduceProps({ pens: [{ tagPath: 'a/Run' }], timeRange: { realtime: { value: 15, unit: 'minutes' } } });
  assert.equal(C.planQuery(plain, win, 1390, L, T0).mode, 'raw', 'control: value aggregations go raw below 2 s buckets');
  const counting = C.reduceProps({ pens: [{ tagPath: 'a/Run', aggregation: 'DurationOn' }, { tagPath: 'a/Temp' }] });
  const q = C.planQuery(counting, win, 1390, L, T0);
  assert.equal(q.mode, 'aggregated', 'was raw: DurationOn silently became the raw 0/1');
  const chartWide = C.reduceProps({ pens: [{ tagPath: 'a/Run' }], query: { aggregation: 'Count' } });
  assert.equal(C.planQuery(chartWide, win, 1390, L, T0).mode, 'aggregated');
  // a disabled counting pen does not hold the chart aggregated; explicit raw stays raw
  assert.equal(C.planQuery(C.reduceProps({ pens: [{ tagPath: 'a/Run', aggregation: 'Count', enabled: false }] }), win, 1390, L, T0).mode, 'raw');
  assert.equal(C.planQuery(C.reduceProps({ pens: [{ tagPath: 'a/Run', aggregation: 'Count' }], query: { mode: 'raw' } }), win, 1390, L, T0).mode, 'raw');
  // needsRequery agrees (no flip-flop between raw and aggregated)
  const cov = { start: win.start - 2 * M, end: win.end + 2 * M, mode: 'aggregated', bucketMs: q.bucketMs };
  assert.equal(C.needsRequery(win.start, win.end, cov, counting, 1390, L, T0), false);
});

test('Boolean pen: a counting / duration aggregation is not drawn on the 0/1 digital axis', () => {
  const env = createEnv();
  env.window.CSS = { supports: () => true };
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  const C = env.window.__CTG.chart;
  const bmeta = { dataType: 'Boolean', engUnit: '', engLow: null, engHigh: null, formatString: '' };
  const m = (i, agg, cov) => ({ key: 'p:' + i, source: 'pens', index: i, tagPath: '[default]CTG/Running', name: 'Running', serverName: 'Running',
    status: 'ok', meta: bmeta, trendable: true, points: 10, aggregation: agg, coverage: cov || null });
  const p = C.reduceProps({ pens: [0, 1, 2, 3].map(() => ({ tagPath: '[default]CTG/Running' })) });
  const agg = { mode: 'aggregated', bucketMs: 30000 };
  const vms = C.buildPens([m(0, 'DurationOn', agg), m(1, 'CountOn', agg), m(2, 'LastValue', agg), m(3, 'DurationOn', { mode: 'raw' })], p, { background: '#FFFFFF' });
  assert.equal(vms[0].isBool, false, 'DurationOn: a number of seconds (was digital, clipped to [-0.1, 1.1])');
  assert.equal(vms[1].isBool, false);
  assert.equal(vms[2].isBool, true, 'LastValue stays a 0/1 signal');
  assert.equal(vms[3].isBool, true, 'raw data is 0/1 whatever the aggregation');
  assert.equal(C.traceKind(vms[0]), 'linear');
  const axes = C.assignAxes(vms, p);
  assert.ok(!/digital/.test(vms[0].axisKey), vms[0].axisKey);
  assert.ok(/digital/.test(vms[2].axisKey));
  assert.equal(C.formatPenValue(15.5, vms[0], 'en-US'), '15.5', 'not "1"');
  assert.ok(axes);
});

// ---- a pen refused only by the response cap was wiped for good --------------------------------------------------

test('tooManyPoints at the RESPONSE cap in a single-request load: the pen is re-loaded alone, not wiped', async () => {
  const pens = [penInfo(0, '[default]CTG/Temp'), penInfo(1, '[default]CTG/Pressure')];
  const { engine, route, clock } = setup({
    pens,
    props: { pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Pressure' }],
      timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 1000 }, query: { mode: 'raw' } },
    respond: (body, n, now) => {
      if (n !== 1) return null;
      const a = answer(body, now);
      a.pens = a.pens.map((p) => (p.tagPath.endsWith('Pressure') ? { key: p.key, tagPath: p.tagPath, status: 'tooManyPoints', limit: 500000, t: [], v: [] } : p));
      return a;
    },
  });
  engine.start();
  await clock.advance(5 * S);
  const pd = engine.penData('p:1');
  assert.equal(pd.status, 'ok', 'was tooManyPoints with 0 points for good');
  assert.ok(pd.t.length > 0);
  assert.ok(route.calls.some((c, i) => i > 0 && c.body.pens.length === 1 && c.body.pens[0].tagPath.endsWith('Pressure') && c.body.pens[0].since == null),
    'a load of the refused pen alone');
  assert.ok(!engine.model().notices.some((x) => x.code === 'tooManyPoints'), 'no "More than 500000 points" notice');
  engine.dispose();
});

test('tooManyPoints at the pen\'s OWN cap stays permanent (control), and a lone pen is not re-asked in a loop', async () => {
  const { engine, route, clock } = setup({
    pens: [penInfo(0, '[default]CTG/Temp'), penInfo(1, '[default]CTG/Pressure')],
    props: { pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Pressure' }],
      timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 1000 }, query: { mode: 'raw' } },
    respond: (body, n, now) => {
      const a = answer(body, now);
      a.pens = a.pens.map((p) => (p.tagPath.endsWith('Pressure') && p.since == null ? { key: p.key, tagPath: p.tagPath, status: 'tooManyPoints',
        limit: body.pens.length === 1 ? 500000 : 100000, t: [], v: [] } : p));
      return a;
    },
  });
  engine.start();
  await clock.advance(30 * S);
  assert.equal(engine.penData('p:1').status, 'tooManyPoints');
  const alone = route.calls.filter((c) => c.body.pens.length === 1 && c.body.pens[0].tagPath.endsWith('Pressure') && c.body.pens[0].since == null);
  assert.equal(alone.length, 0, 'the per-pen cap is not re-asked');
  engine.dispose();
});

// ---- downgraded MinMax answers (exact brush view, raw CSV wide) --------------------------------------------------

test('rawView: a downgraded MinMax answer is placed like the store (pairs 1 ms apart, bucket middle), so pair-weighted Avg is the bucket mean', () => {
  const { C } = load();
  const rp = { key: 'p:0', status: 'ok', downgraded: true, bucketMs: 10000, aggregation: 'MinMax',
    t: [0, 0, 10000, 10000, 20000, 20000], v: [0, 10, 0, 10, 0, 10], anchor: null };
  const view = plain(C.rawView(rp));
  assert.deepEqual(view.t, [5000, 5001, 15000, 15001, 25000, 25001]);
  const st = C.statsFor(view, 0, 30000, { pairs: true, lastKnownTime: 30000 });
  assert.equal(st.average, 5, 'was 10: equal stamps weighed each bucket by its later row');
  // raw answers stay as they are (anchor first)
  const raw = plain(C.rawView({ t: [5, 6], v: [1, 2], anchor: { t: 1, v: 0 }, downgraded: false }));
  assert.deepEqual(raw, { t: [1, 5, 6], v: [0, 1, 2] });
});

test('raw CSV wide: both rows of a downgraded MinMax bucket are kept (raw duplicates: last still wins)', () => {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  const T = env.window.__CTG.chart.tools;
  const labels = { a: { name: 'A', column: 'A' }, b: { name: 'B', column: 'B' } };
  const w = T.rawTable([{ key: 'a', t: [0, 0, 10, 10], v: [1, 9, 2, 8], status: 'ok', downgraded: true },
    { key: 'b', t: [0, 10], v: [5, 6], status: 'ok' }], labels, 'wide', false);
  assert.deepEqual(plain(w.rows), [[0, 1, 5], [0, 9, ''], [10, 2, 6], [10, 8, '']], 'was [[0, 9, 5], [10, 8, 6]]: min lost');
  assert.deepEqual(plain(T.rawTable([{ key: 'a', t: [1, 1], v: [7, 8], status: 'ok' }], labels, 'wide', false).rows), [[1, 8]]);
});

// ---- CSV export of an aggregated chart wrote draw positions --------------------------------------------------------

function minMaxAnswer(body, now) {
  const a = answer(body, now);
  if (body.mode !== 'aggregated') return a;
  a.pens = a.pens.map((p) => {
    const t = [], v = [];
    p.t.forEach((x, i) => { t.push(x, x); v.push(p.v[i] - 10, p.v[i]); });
    return Object.assign({}, p, { t, v, aggregation: 'MinMax', shape: 'minmax', count: t.length });
  });
  return a;
}

test('series.rows of an aggregated MinMax chart: real bucket-start stamps, no +1 ms rows, marked aggregated', async () => {
  const { engine, clock, C } = setup({
    props: { pens: [{ tagPath: '[default]CTG/Temp' }], timeRange: { realtime: { value: 8, unit: 'hours' }, refreshRate: 0 },
      query: { mode: 'aggregated', aggregation: 'MinMax', pointCount: 100 } },
    respond: (body, n, now) => minMaxAnswer(body, now),
  });
  engine.start();
  await clock.advance(2 * S);
  const pd = engine.penData('p:0');
  const b = pd.coverage.bucketMs;
  assert.ok(b > 0);
  const ev = plain(engine.exportView('p:0'));
  assert.equal(ev.aggregation, 'MinMax');
  assert.ok(ev.t.every((x) => x % b === 0), 'every stamp is a bucket start (was the bucket middle and +1 ms)');
  for (let i = 1; i < ev.t.length; i += 2) assert.equal(ev.t[i], ev.t[i - 1], 'both rows of a pair at the bucket time');
  const vm = { key: 'p:0', label: 'Temp', units: 'degF', visible: true, drawable: true };
  const host = { engine, penVMs: () => [vm] };
  const wide = plain(C.seriesRows(host, { source: 'loaded', layout: 'wide' }));
  assert.deepEqual(wide.header, ['Time', 'Temp (degF) [MinMax]']);
  assert.deepEqual(wide.aggregated, ['Temp']);
  assert.ok(!wide.rows.some((r, i) => i > 0 && r[0] - wide.rows[i - 1][0] === 1), 'no rows 1 ms apart');
  assert.equal(wide.rows.length, pd.t.length, 'one row per stored row');
  const tall = plain(C.seriesRows(host, { source: 'loaded', layout: 'tall' }));
  assert.equal(tall.rows[0][1], 'Temp [MinMax]');
  engine.dispose();
});

test('series.rows of a raw chart: unchanged (real samples, no aggregation mark)', async () => {
  const { engine, clock, C } = setup({
    props: { pens: [{ tagPath: '[default]CTG/Temp' }], timeRange: { realtime: { value: 5, unit: 'minutes' }, refreshRate: 0 }, query: { mode: 'raw' } },
  });
  engine.start();
  await clock.advance(2 * S);
  const vm = { key: 'p:0', label: 'Temp', units: '', visible: true, drawable: true };
  const wide = plain(C.seriesRows({ engine, penVMs: () => [vm] }, { source: 'loaded', layout: 'wide' }));
  assert.deepEqual(wide.header, ['Time', 'Temp']);
  assert.deepEqual(wide.aggregated, []);
  assert.deepEqual(wide.rows.map((r) => r[0]), plain(engine.penView('p:0').t));
  engine.dispose();
});

// ---- aggregated pens never reached the left edge ------------------------------------------------------------------

test('store.trim keeps the last row DRAWN before the window start (aggregated LastValue: bucket end), not by its bucket start', () => {
  const { C } = load();
  const st = new C.SeriesStore({});
  st.ensure('k', 'a/T', 'LastValue');
  const b = 30000;
  st.applyFull('k', { status: 'ok', t: [0, b, 2 * b, 3 * b], v: [1, 2, 3, 4], anchor: null },
    { start: 0, end: 4 * b, mode: 'aggregated', aggregation: 'LastValue', bucketMs: b, bucketTime: 'start' });
  st.trim('k', 50000);
  const pd = st.get('k');
  assert.deepEqual(plain(pd.t), [0, b, 2 * b, 3 * b], 'the row drawn at 30 000 (< 50 000) stays (was cut: blank 50 000 .. 60 000)');
  const view = plain(C.penView(pd, { live: false }));
  assert.ok(view.t[0] <= 50000, 'the series reaches the left edge: ' + view.t[0]);
  st.trim('k', 70000);
  assert.deepEqual(plain(st.get('k').t), [b, 2 * b, 3 * b], 'drawn 30 000 is no longer needed once 60 000 is before ws');
});

// ---- Copy stats header 'Pen' was hard-coded English ---------------------------------------------------------------

test('Copy stats: the first TSV header goes through NS.i18n (chart.rows.pen)', async () => {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  const NS = env.window.__CTG;
  NS.i18n.register('chart', { 'chart.rows.pen': 'Stift', 'chart.rcol.min': 'Kleinst' });
  let copied = null;
  env.window.navigator = { clipboard: { writeText: (t) => { copied = t; return Promise.resolve(); } } };
  const c = Object.create(NS.chart.CtgChart.prototype);
  Object.assign(c, { _alive: true, chartId: 'c', _pens: [{ key: 'p:0', label: 'Temp' }] });
  c._copyStats({ stats: { 'p:0': { minimum: 1, approx: false } } }, [{ id: 'min', stat: 'minimum' }]);
  await flush();
  assert.ok(copied, 'copied');
  assert.equal(copied.split('\n')[0], 'Stift\tKleinst', 'was "Pen\tKleinst"');
});

// ---- panels — narrow decision and focus on close -------------------------------------------------------------------

function uiEnv() {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  const doc = env.context.document;
  doc.body = { tag: 'body' };
  doc.activeElement = doc.body;
  return { env, NS: env.window.__CTG, doc };
}
function fakeEl(name, opts = {}) {
  const el = { name, isConnected: true, children: opts.children || [],
    focus() { focused.push(name); el.doc.activeElement = el; },
    contains(x) { return x === el || el.children.some((c) => c === x || (c.contains && c.contains(x))); },
    closest: opts.closest || (() => null), querySelector: opts.querySelector || (() => null) };
  return el;
}
let focused = [];

test('PanelFrame is narrow exactly when the chart rendered it into its sheet (no rw - 16 band of its own)', () => {
  const { NS } = uiEnv();
  const P = NS.chartPanels;
  const mk = (inSheet) => {
    const f = new P.PanelFrame({ panel: 'settings', title: 'x', width: 340, responsiveWidth: 1390, onClose() {}, children: null });
    f.setState = function (p) { Object.assign(this.state, p); };
    const root = { querySelector: () => null };
    f._attach({ closest: (sel) => (sel === '.ctg-chart' ? root : sel === '.ctg-chart__sheet' ? (inSheet ? {} : null) : null) });
    f.componentDidMount();
    return f;
  };
  const sheet = mk(true);
  assert.equal(sheet.state.narrow, true, 'in the sheet: overlay with Back (was false in the 16 px band: 340 px panel + x)');
  const out = sheet.render();
  assert.match(out.props.className, /ctg-pnl--overlay/);
  assert.equal(out.props.style.width, undefined);
  const dock = mk(false);
  assert.equal(dock.state.narrow, false);
  assert.equal(dock.render().props.style.width, '340px');
});

test('PanelFrame close: focus returns to the opener (pen pencil), not the toolbar button', () => {
  const { NS, doc } = uiEnv();
  focused = [];
  const P = NS.chartPanels;
  const pencil = fakeEl('pencil'); pencil.doc = doc;
  const tbBtn = fakeEl('toolbar-settings'); tbBtn.doc = doc;
  const inner = fakeEl('pens-tab'); inner.doc = doc;
  const f = new P.PanelFrame({ panel: 'settings', title: 'x', width: 340, onClose() {}, children: null, returnFocus: pencil });
  f.el = fakeEl('frame', { children: [inner] });
  f._chartRoot = { querySelector: (sel) => (sel === '[data-ctg-panel="settings"]' ? tbBtn : null) };
  doc.activeElement = inner;
  f.componentWillUnmount();
  assert.deepEqual(focused, ['pencil'], 'was the toolbar Settings button');
  // without an opener: the toolbar button as before
  focused = [];
  const g = new P.PanelFrame({ panel: 'settings', title: 'x', width: 340, onClose() {}, children: null });
  g.el = fakeEl('frame', { children: [inner] });
  g._chartRoot = f._chartRoot;
  doc.activeElement = inner;
  g.componentWillUnmount();
  assert.deepEqual(focused, ['toolbar-settings']);
});

test('chart closePanel: focus that fell to <body> goes to the More button / the plot (narrow layout, no toolbar button)', () => {
  const { NS, doc } = uiEnv();
  focused = [];
  const C = NS.chart;
  const more = fakeEl('more'); more.doc = doc;
  const inPanel = fakeEl('esc-target', { closest: (sel) => (/ctg-chart__panel|ctg-chart__sheet/.test(sel) ? {} : null) }); inPanel.doc = doc;
  const root = fakeEl('root', { children: [more, inPanel], querySelector: (sel) => (sel === '[data-ctg="more"]' ? more : null) });
  const c = Object.create(C.CtgChart.prototype);
  let plots = 0;
  Object.assign(c, { _alive: true, _rootEl: root, props: { eventsEnabled: true, props: {} }, state: { panels: {} },
    setState(p, cb) { Object.assign(this.state, p); doc.activeElement = doc.body; if (cb) cb(); },
    focusPlots() { plots++; } });
  doc.activeElement = more;                        // the More menu's button had focus when Settings opened
  assert.equal(c.openPanel('settings', { source: 'toolbar' }), true);
  const args = c._panels.settings;
  assert.equal(args.returnFocus, more, 'the opener is kept for the panel');
  assert.deepEqual(Object.keys(args), ['source'], 'but not enumerable: panels may copy / serialise their args');
  assert.equal(JSON.stringify(args), '{"source":"toolbar"}');
  more.isConnected = false;                         // ... and is gone in this layout when the sheet closes
  doc.activeElement = inPanel;                      // Esc pressed inside the panel
  c.closePanel('settings');
  assert.equal(plots, 1, 'focus moved to the plot (was <body>)');
  // the More button present: it gets focus
  more.isConnected = true;
  c.openPanel('settings', {});
  doc.activeElement = inPanel;
  focused = [];
  c.closePanel('settings');
  assert.deepEqual(focused, ['more']);
});

// ---- responsiveWidth / cursorSyncGroup at run time -------------------------------------------------------------------

test('responsiveWidth changed at run time switches the layout without a resize', () => {
  const { NS } = uiEnv();
  const c = Object.create(NS.chart.CtgChart.prototype);
  const p0 = NS.chart.reduceProps({ toolbar: { responsiveWidth: 640 } });
  const p1 = NS.chart.reduceProps({ toolbar: { responsiveWidth: 1389 } });
  Object.assign(c, { _alive: true, state: { rootW: 1383, narrow: false }, props: { props: p1 },
    setState(p) { Object.assign(this.state, p); },
    engine: { setTimeZone() {}, setProps() {} }, _watchZone() {}, _zone() {}, _clearSettledOverrides() {}, _adoptInteraction() {},
    _syncZone() { return false; }, mode() { return 'xTrace'; }, _lastMode: 'xTrace', ix: { modeChanged() {} }, _syncPlots() {}, _afterRender() {}, _rangeEpoch: 0 });
  c.componentDidUpdate({ props: p0 });
  assert.equal(c.state.narrow, true, 'narrow at once (was: only after the next resize)');
  c.props = { props: p0 };
  c.componentDidUpdate({ props: p1 });
  assert.equal(c.state.narrow, false);
});

test('cursorSyncGroup is part of each plot signature (a change rebuilds the plots with the new sync key)', () => {
  const { NS } = uiEnv();
  const PM = NS.chart.PlotManager;
  const vm = { plots: [{}], timeAxis: {}, fontSize: 12, tz: 'UTC', locale: 'en-US', scheme: 'light' };
  const pv = { pens: [], axes: [] };
  const a = PM.prototype._sig.call({ syncKey: 'ctg-c0' }, pv, 0, vm);
  const b = PM.prototype._sig.call({ syncKey: 'grpA' }, pv, 0, vm);
  assert.notEqual(a, b, 'was equal: the plots kept the old uPlot cursor.sync.key');
});

// ---- annotation editor and the repeated DST hour --------------------------------------------------------------------

test('annotation editor: a note in the repeated 01:30 (America/Chicago, 2026-11-01) keeps its instant', () => {
  const { NS } = uiEnv();
  const P = NS.chartPanels;
  const tz = 'America/Chicago';
  const second = Date.UTC(2026, 10, 1, 7, 30, 0);              // 01:30 CST, the second occurrence
  const first = Date.UTC(2026, 10, 1, 6, 30, 0);               // 01:30 CDT
  const shown = P.annInputValue(second, tz);
  assert.equal(shown, '2026-11-01T01:30:00');
  // text-only edit: the stored note does not move
  const r = P.annSaveBody({ type: 'note', penTagPath: '[default]CTG/Temp', start: shown, text: 'fix typo' }, { id: 'u1', start: second }, tz);
  assert.equal(r.body.start, second, 'was 06:30Z: moved one hour earlier');
  assert.equal(r.body.oldStart, second);
  // a new note clicked in the second 01:30: the clicked instant
  const n = P.annSaveBody({ type: 'note', penTagPath: '[default]CTG/Temp', start: shown, text: 'x' }, null, tz, { start: second });
  assert.equal(n.body.start, second);
  // an edited time inside the overlap keeps the seed's offset (CST); the first occurrence stays reachable from CDT
  assert.equal(P.annParseInput('2026-11-01T01:45:00', tz, second), second + 15 * 60000);
  assert.equal(P.annParseInput('2026-11-01T01:45:00', tz, first), first + 15 * 60000);
  assert.equal(P.annParseInput('2026-11-01T01:45:00', tz), first + 15 * 60000, 'no hint: the first one, as before');
  // outside the overlap nothing changes
  assert.equal(P.annParseInput('2026-11-01T03:00:00', tz, second), Date.UTC(2026, 10, 1, 9, 0, 0));
});

// ---- v1 props on a CTG Chart were never detected ------------------------------------------------------------------

test('chart reducer detects v1 props (migrator rules), warns once per view; a v2 interaction object is no signature', () => {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  const C = env.window.__CTG.chart;
  const v1 = C.reduceProps({ rangeHours: 0.25, rawHistory: true, refreshRate: 5000, visibility: { showLegend: false } });
  assert.deepEqual(plain(v1.v1Keys), ['rangeHours', 'rawHistory', 'refreshRate', 'visibility'], 'was: no detection at all');
  assert.deepEqual(plain(C.reduceProps({ interaction: { mode: 'panAndZoom', xTraceVisible: true } }).v1Keys), ['interaction.xTraceVisible', 'interaction.mode']);
  assert.deepEqual(plain(C.reduceProps({ interaction: { mode: 'xTrace' }, timeRange: { mode: 'realtime' }, query: { pointCount: 300 } }).v1Keys), []);
  assert.ok(!Object.keys(v1).includes('v1Keys'), 'not enumerable: no effect on hashes / patches');
  // one console warning per view
  const c = Object.create(C.CtgChart.prototype);
  c.props = { props: v1, store: { view: { resourcePath: 'Area1/LegacyChart' } } };
  c._warnV1(); c._warnV1();
  const w = env.warnings.filter((a) => a.some((x) => /still uses v1 props/.test(String(x))));
  assert.equal(w.length, 1);
  assert.match(String(w[0].find((x) => /v1 props/.test(String(x)))), /rangeHours, rawHistory, refreshRate, visibility/);
});
