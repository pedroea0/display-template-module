// =============================================================================
// chart-engine.test.mjs — history queue + ChartEngine against a fake gateway
// =============================================================================
// Drives NS.chart.ChartEngine with a fake delegate (snapshot/pens/token
// events), a fake history route (raw + aggregated, incl.
// `since`/replaceFrom) and manual timers, so every scheduling decision is
// deterministic:
//   - page queue: concurrency, priorities, per-key spacing, pause, abort
//   - full load body; realtime ticks: 1 request per tick, `since`, never
//     overlapping, hidden tab = no requests
//   - a lost token is not overwritten by an in-flight response
//   - 401 -> chart.token -> one retry; 429 Retry-After honoured
//   - chunked raw load: newest first, progress, cancel keeps data
//   - client point cap over the sum of chunks + aggregate fallback
//   - pen set reconciliation: partial load only for new pens, 30 s grace
//   - stale after staleAfter without success, recovery
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, FILES } from './_stubs.mjs';

const S = 1000, M = 60 * S, H = 60 * M;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

function load() {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  return { env, NS: env.window.__CTG, C: env.window.__CTG.chart };
}

async function flush() { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); }

/** Manual clock + timers (local and gateway time are the same here). */
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
    pending: () => q.length,
  };
}

/**
 * Fake /v2/history: one sample per second (v = t / 1000) per pen, raw or aggregated (LastValue on an
 * epoch-aligned grid). opts.latency (ms, fake time), opts.respond(body) may return {status, json, headers}.
 */
function fakeRoute(clock, opts = {}) {
  const calls = [];
  const fn = (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers, at: clock.now() });
    const make = () => {
      const custom = opts.respond && opts.respond(body, calls.length);
      const r = custom || { status: 200, json: answer(body, clock.now(), opts) };
      const headers = r.headers || {};
      return { status: r.status, headers: { get: (k) => (k in headers ? headers[k] : null) }, text: () => Promise.resolve(JSON.stringify(r.json)) };
    };
    const lat = typeof opts.latency === 'function' ? opts.latency(body) : opts.latency || 0;
    if (!lat) return Promise.resolve(make());
    return new Promise((res) => clock.timers.set(() => res(make()), lat));
  };
  fn.calls = calls;
  return fn;
}
function answer(body, now, opts) {
  const dataEnd = Math.min(body.end, now);
  const step = opts.stepMs || S;
  if (body.mode === 'raw') {
    return {
      v: 2, ok: true, requestId: body.requestId, serverNow: now,
      window: { start: body.start, end: dataEnd, mode: 'raw', aggregation: body.aggregation, bucketMs: null, bucketTime: null, aligned: false, downgraded: false },
      pens: body.pens.map((p) => {
        const from = p.since != null && p.since >= body.start ? p.since + 1 : body.start;
        const t = [];
        for (let x = Math.ceil(from / step) * step; x < dataEnd; x += step) t.push(x);
        if (body.maxPointsPerPen && t.length > body.maxPointsPerPen) {
          return { key: p.key, tagPath: p.tagPath, status: 'tooManyPoints', limit: body.maxPointsPerPen, t: [], v: [] };
        }
        return { key: p.key, tagPath: p.tagPath, status: 'ok', t, v: t.map((x) => x / 1000), anchor: p.since == null && body.includeAnchor ? { t: body.start - 500, v: 1 } : null,
          replaceFrom: null, downgraded: false, count: t.length };
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

function penInfo(i, tagPath, extra) {
  return Object.assign({ key: 'p:' + i, source: 'pens', index: i, tagPath, name: tagPath.split('/').pop(), status: 'ok', meta: null, trendable: true }, extra);
}
/** Fake CtgChartDelegate (the engine's `source`). */
function fakeSource(pens, extra) {
  const ls = [];
  const src = {
    snap: Object.assign({ pens, trend: { group: null, paths: [], max: 32 }, limits: { maxPens: 32, minBucketMs: 100, maxConcurrentPerSession: 4 } }, extra),
    creds: { url: '/data/simpletagdisplay/v2/history', token: 'tok-1', expiresAt: 4102444800000 },
    state: { connected: true }, reason: null, renewCount: 0,
    staleReason() { return this.reason; },
    getCreds() { return this.creds; },
    renewToken() { this.renewCount++; this.creds = Object.assign({}, this.creds, { token: 'tok-' + (this.renewCount + 1) }); return Promise.resolve(true); },
    on(fn) { ls.push(fn); return () => { const i = ls.indexOf(fn); if (i >= 0) ls.splice(i, 1); }; },
    emit(t, p) { ls.slice().forEach((f) => f(t, p)); },
  };
  return src;
}

function setup(opts = {}) {
  const { C } = load();
  const clock = fakeClock(opts.start || T0);
  const route = fakeRoute(clock, opts.route || {});
  const queue = new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers });
  const source = fakeSource(opts.pens || [penInfo(0, '[default]CTG/Temp')]);
  const doc = { hidden: false, ls: [], addEventListener(t, f) { this.ls.push(f); }, removeEventListener() {} };
  const props = C.reduceProps(opts.props || {
    pens: [{ tagPath: '[default]CTG/Temp' }], timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 1000 },
  });
  const engine = new C.ChartEngine({ id: 'c1', source, queue, now: clock.now, timers: clock.timers, document: doc, fetch: route,
    props, timeZone: 'UTC', plotWidth: 1000 });
  return { C, clock, route, queue, source, doc, engine };
}

// ---- queue -------------------------------------------------------------------------------------------------
test('historyQueue: <= maxConcurrent, priority user > chunk > tick, FIFO inside a priority', async () => {
  const { C } = load();
  const clock = fakeClock(T0);
  const q = new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers });
  const order = [];
  let running = 0, maxRunning = 0;
  const job = (name, prio, key) => q.run({ key: key || name, priority: prio, exec: () => {
    order.push(name); running++; maxRunning = Math.max(maxRunning, running);
    return new Promise((r) => clock.timers.set(() => { running--; r({ ok: true, name }); }, 100));
  } });
  const ps = [job('t1', 'tick'), job('t2', 'tick'), job('c1', 'chunk'), job('u1', 'user'), job('t3', 'tick'), job('u2', 'user')];
  await clock.advance(1000);
  const res = await Promise.all(ps);
  assert.deepEqual(res.map((r) => r.name), ['t1', 't2', 'c1', 'u1', 't3', 'u2']);
  assert.deepEqual(order, ['t1', 't2', 'u1', 'u2', 'c1', 't3']);
  assert.equal(maxRunning, 2);
});

test('historyQueue: per-key spacing, pause (429) and pauseAll (503), abort while queued', async () => {
  const { C } = load();
  const clock = fakeClock(T0);
  const q = new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers });
  const starts = [];
  const run = (key, spacingMs, signal) => q.run({ key, priority: 'tick', spacingMs, signal, exec: () => { starts.push([key, clock.now() - T0]); return Promise.resolve({ ok: true }); } });
  run('a', 220); run('a', 220); run('b', 220);
  await clock.advance(1000);
  assert.deepEqual(starts, [['a', 0], ['b', 0], ['a', 220]]);
  starts.length = 0;
  q.pause('a', 2000);
  run('a', 0); run('b', 0);
  await clock.advance(3000);
  assert.deepEqual(starts.map((s) => s[0]), ['b', 'a']);
  assert.ok(starts[1][1] >= 3000, 'a waited for its Retry-After');
  starts.length = 0;
  q.pauseAll(500);
  const cancel = new C.Canceller();
  const aborted = run('c', 0, cancel.signal);
  cancel.cancel();
  assert.equal((await aborted).aborted, true);
  run('d', 0);
  await clock.advance(1000);
  assert.deepEqual(starts.map((s) => s[0]), ['d']);
  assert.ok(starts[0][1] >= 4500);
});

// ---- loads and ticks -------------------------------------------------------------------------------------------
test('initial full load: request body, token headers, data applied', async () => {
  const { engine, route, clock } = setup();
  engine.start();
  await clock.advance(10);
  assert.equal(route.calls.length, 1);
  const { body, headers } = route.calls[0];
  assert.equal(headers['X-CTG-Token'], 'tok-1');
  assert.equal(headers['X-CTG-Protocol'], '2');
  assert.equal(body.v, 2);
  assert.equal(body.mode, 'raw', '15 min at 1000 px -> raw');
  assert.equal(body.end - body.start, 15 * M);
  assert.equal(body.includeAnchor, true);
  assert.equal(body.maxPointsPerPen, 100000);
  assert.deepEqual(body.pens.map((p) => [p.tagPath, p.since]), [['[default]CTG/Temp', null]]);
  assert.match(body.requestId, /^h-[a-z0-9]+-\d+-\d+$/);
  const m = engine.model();
  assert.equal(m.state, 'live');
  assert.equal(m.pens[0].status, 'ok');
  assert.equal(m.pens[0].points, 900);
  engine.dispose();
});

test('realtime ticks: exactly one request per tick with since; never overlapping under latency', async () => {
  const { engine, route, clock } = setup();
  engine.start();
  await clock.advance(10);
  await clock.advance(10 * S);
  const ticks = route.calls.slice(1);
  assert.ok(ticks.length >= 8 && ticks.length <= 10, `ticks in 10 s: ${ticks.length}`);
  ticks.forEach((c) => { assert.equal(c.body.includeAnchor, false); assert.ok(c.body.pens.every((p) => typeof p.since === 'number')); });
  // since = the newest sample the chart holds: increasing, and at most ~1 sample period behind the tick
  ticks.forEach((c, i) => {
    const since = c.body.pens[0].since;
    assert.ok(c.at - since <= 2.5 * S && c.at - since > 0, `tick ${i}: since ${c.at - since} ms behind`);
    if (i) assert.ok(since > ticks[i - 1].body.pens[0].since);
  });
  assert.equal(engine.metrics.inFlightMax, 1);
  const pts = engine.model().pens[0].points;
  assert.ok(pts >= 899 && pts <= 901, `window keeps sliding: ${pts} points`);
  engine.dispose();

  const slow = setup({ route: { latency: (b) => (b.pens[0].since != null ? 3000 : 0) } });
  slow.engine.start();
  await slow.clock.advance(10);
  await slow.clock.advance(12 * S);
  const n = slow.route.calls.length - 1;
  assert.ok(n >= 3 && n <= 4, `3 s latency at 1 s refresh: ${n} tick requests in 12 s`);
  assert.equal(slow.engine.metrics.inFlightMax, 1, 'no overlap');
  assert.ok(slow.engine.metrics.skippedTicks === 0 || slow.engine.metrics.ticks >= n);
  slow.engine.dispose();
});

test('hidden tab: no requests; visible: one immediate catch-up tick', async () => {
  const { engine, route, clock, doc } = setup();
  engine.start();
  await clock.advance(2 * S);
  const before = route.calls.length;
  doc.hidden = true;
  await clock.advance(30 * S);
  assert.equal(route.calls.length, before, '0 requests while hidden');
  doc.hidden = false;
  doc.ls.forEach((f) => f());
  await clock.advance(10);
  assert.equal(route.calls.length, before + 1, 'one catch-up request');
  const since = route.calls[route.calls.length - 1].body.pens[0].since;
  assert.ok(clock.now() - since > 29 * S, 'since covers the hidden gap');
  assert.ok(engine.model().pens[0].points >= 899, 'no gap');
  engine.dispose();
});

test('an in-flight response cannot overwrite SESSION_MISMATCH; a token push restores history', async () => {
  const { engine, route, clock, source } = setup({ route: { latency: 2000 } });
  engine.start();
  await clock.advance(500);
  assert.equal(route.calls.length, 1, 'first load in flight');
  source.creds = null;
  source.snap = Object.assign({}, source.snap);
  source.emit('snapshot');
  assert.equal(engine.model().banner.code, 'SESSION_MISMATCH');
  await clock.advance(5000);
  assert.equal(engine.model().banner.code, 'SESSION_MISMATCH', 'old response ignored');
  assert.notEqual(engine.model().pens[0].status, 'ok');
  assert.equal(route.calls.length, 1, 'no requests without a token');
  source.creds = { url: '/h', token: 'tok-new', expiresAt: 4102444800000 };
  source.emit('token');
  await clock.advance(2500);
  assert.equal(engine.model().banner, null);
  assert.equal(route.calls[1].headers['X-CTG-Token'], 'tok-new');
  assert.equal(engine.model().pens[0].status, 'ok');
  engine.dispose();
});

test('401 -> chart.token -> one retry with the new token', async () => {
  const { engine, route, clock, source } = setup({ route: { respond: (b, n) => (n === 1 ? { status: 401, json: { v: 2, ok: false, error: { code: 'TOKEN_EXPIRED' } } } : null) } });
  engine.start();
  await clock.advance(10);
  assert.equal(source.renewCount, 1);
  assert.equal(route.calls.length, 2);
  assert.equal(route.calls[1].headers['X-CTG-Token'], 'tok-2');
  assert.equal(engine.model().banner, null);
  assert.equal(engine.model().pens[0].status, 'ok');
  engine.dispose();
});

test('429 on a tick: Retry-After honoured, ticks resume', async () => {
  let n429 = 0;
  const { engine, route, clock } = setup({ route: { respond: (b, n) => (n === 3 ? (n429++, { status: 429, headers: { 'Retry-After': '3' }, json: { v: 2, ok: false, error: { code: 'TOO_MANY_REQUESTS' } } }) : null) } });
  engine.start();
  await clock.advance(2100);
  assert.equal(n429, 1);
  const at429 = route.calls[2].at;
  await clock.advance(6 * S);
  const next = route.calls[3].at;
  assert.ok(next - at429 >= 3000, `next request ${next - at429} ms after the 429`);
  assert.ok(route.calls.length >= 5, 'ticks resumed');
  engine.dispose();
});

test('aggregated realtime: tick sends the coverage bucketMs, replaces from replaceFrom', async () => {
  const { engine, route, clock } = setup({ props: { pens: [{ tagPath: 'A' }], timeRange: { refreshRate: 1000 } } });
  engine.start();
  await clock.advance(10);
  const full = route.calls[0].body;
  assert.equal(full.mode, 'aggregated');
  assert.equal(full.bucketMs, 30000, '8 h / 1000 px');
  await clock.advance(61 * S);
  const tick = route.calls[route.calls.length - 1].body;
  assert.equal(tick.bucketMs, 30000);
  assert.equal(tick.mode, 'aggregated');
  const pd = engine.penData('p:0');
  const t = Array.from(pd.t);
  assert.ok(t.every((x, i) => i === 0 || x > t[i - 1]), 'ascending, no duplicated buckets');
  assert.equal(t[t.length - 1], Math.floor(clock.now() / 30000) * 30000 - 30000, 'last complete bucket');
  engine.dispose();
});

test('RANGE_INVALID on a tick (grid refused) re-plans with a full load', async () => {
  const { engine, route, clock } = setup({ route: { respond: (b, n) => (n === 2 ? { status: 400, json: { v: 2, ok: false, error: { code: 'RANGE_INVALID' } } } : null) } });
  engine.start();
  await clock.advance(1500);
  assert.ok(route.calls[1].body.pens[0].since != null, 'the refused tick');
  assert.equal(route.calls[2].body.pens[0].since, null, 'full load again');
  assert.equal(engine.metrics.fullLoads, 2);
  engine.dispose();
});

test('stale: no success for staleAfter -> state stale with staleSince; recovers on the next success', async () => {
  let fail = false;
  const { engine, clock } = setup({ route: { respond: () => (fail ? { status: 502, json: { v: 2, ok: false, error: { code: 'HISTORY_QUERY_FAILED' } } } : null) } });
  engine.start();
  await clock.advance(1100);
  assert.equal(engine.model().state, 'live');
  const lastOk = engine.lastSuccess;
  fail = true;
  await clock.advance(15 * S);
  const m = engine.model();
  assert.equal(m.state, 'stale');
  assert.equal(m.staleSince, lastOk);
  fail = false;
  await clock.advance(70 * S);
  assert.equal(engine.model().state, 'live');
  engine.dispose();
});

test('delegate stale reasons show through (watchdog/resync -> stale, disconnected -> disconnected)', async () => {
  const { engine, clock, source } = setup();
  engine.start();
  await clock.advance(10);
  source.reason = 'watchdog';
  source.emit('state');
  assert.equal(engine.model().state, 'stale');
  assert.equal(engine.model().staleReason, 'watchdog');
  source.reason = 'disconnected';
  assert.equal(engine.model().state, 'disconnected');
  engine.dispose();
});

// ---- chunks and caps ---------------------------------------------------------------------------------------------
// Fixed one-hour chunks (rawChunk "1h"): these tests exercise the per-chunk mechanics (order, anchor, cancel,
// cap, memory guard, per-pen timeouts). The adaptive "auto" planner has its own tests (chart-chunks).
function histProps(extra) {
  return Object.assign({
    pens: [{ tagPath: 'Bulk1' }],
    timeRange: { mode: 'historical', historical: { startDate: T0 - 27 * H, endDate: T0 } },
    query: { mode: 'raw', chunking: { enabled: true, rawChunk: '1h' } },
  }, extra);
}

test('chunked raw load: newest chunk first, progress, contiguous data', async () => {
  const { engine, route, clock } = setup({ start: T0 + H, props: histProps(), route: { stepMs: 10 * S } });
  engine.start();
  await clock.advance(10);
  const first = route.calls[0].body;
  assert.equal(first.end, T0, 'newest chunk first');
  assert.ok(engine.model().progress || route.calls.length === 27);
  await clock.advance(20 * S);
  assert.equal(route.calls.length, 27, '27 h on whole hours = 27 one-hour chunks');
  assert.equal(route.calls.filter((c) => c.body.includeAnchor).length, 1, 'anchor only on the oldest chunk');
  assert.equal(route.calls[26].body.start, T0 - 27 * H);
  const pd = engine.penData('p:0');
  assert.equal(pd.t.length, 27 * 360);
  assert.ok(Array.from(pd.t).every((x, i, a) => i === 0 || x - a[i - 1] === 10 * S), 'no holes, no duplicates at chunk edges');
  assert.equal(engine.model().progress, null);
  assert.equal(engine.model().state, 'historical');
  engine.dispose();
});

test('chunked load: Cancel keeps what is loaded ("Partially loaded")', async () => {
  const { engine, route, clock } = setup({ start: T0 + H, props: histProps(), route: { stepMs: 10 * S, latency: 100 } });
  engine.start();
  await clock.advance(1000);
  const m0 = engine.model();
  assert.ok(m0.progress && m0.progress.done >= 2 && m0.progress.total === 27, JSON.stringify(m0.progress));
  engine.cancelLoad();
  const after = route.calls.length;
  await clock.advance(5000);
  assert.ok(route.calls.length <= after + 1, 'no more chunks');
  const m = engine.model();
  assert.ok(m.notices.some((n) => n.code === 'partial'));
  assert.ok(m.pens[0].points > 0);
  assert.equal(m.pens[0].status, 'ok');
  engine.dispose();
});

test('client cap over the SUM of chunks -> tooManyPoints; with "aggregate" -> aggregated + downgraded', async () => {
  const capped = setup({ start: T0 + H, props: histProps({ query: { mode: 'raw', maxPointsPerPen: 20000, chunking: { enabled: true, rawChunk: '1h' } } }) });
  capped.engine.start();
  await capped.clock.advance(30 * S);
  let m = capped.engine.model();
  assert.equal(m.pens[0].status, 'tooManyPoints');
  assert.equal(m.pens[0].limit, 20000);
  assert.ok(m.notices.some((n) => n.code === 'tooManyPoints' && n.limit === 20000));
  assert.ok(capped.route.calls.length < 27, `stopped early (${capped.route.calls.length} chunks)`);
  assert.ok(capped.route.calls.every((c) => c.body.maxPointsPerPen === 20000), 'cap sent with every chunk');
  capped.engine.dispose();

  const agg = setup({ start: T0 + H, props: histProps({ query: { mode: 'raw', maxPointsPerPen: 20000, onTooManyPoints: 'aggregate', chunking: { enabled: true, rawChunk: '1h' } } }) });
  agg.engine.start();
  await agg.clock.advance(30 * S);
  m = agg.engine.model();
  const last = agg.route.calls[agg.route.calls.length - 1].body;
  assert.equal(last.mode, 'aggregated', 'fallback request');
  assert.equal(m.pens[0].status, 'ok');
  assert.equal(m.pens[0].downgraded, true);
  assert.equal(m.pens[0].approx, true);
  agg.engine.dispose();
});

test('memory guard: a chunked load stops once the held points pass the limit', async () => {
  const { C, engine, route, clock } = setup({ start: T0 + H, props: histProps(), route: { stepMs: 10 * S } });
  const saved = C.ENGINE.maxHeldPoints;
  C.ENGINE.maxHeldPoints = 2000;
  try {
    engine.start();
    await clock.advance(20 * S);
    const m = engine.model();
    assert.equal(m.banner.code, 'memory');
    assert.ok(m.notices.some((n) => n.code === 'partial'));
    assert.ok(route.calls.length < 27, `stopped after ${route.calls.length} chunks`);
    assert.ok(m.pens[0].points > 2000 && m.pens[0].points < 3000);
    assert.equal(m.state, 'historical', 'data shown');
  } finally {
    C.ENGINE.maxHeldPoints = saved;
    engine.dispose();
  }
});

test('reload while paused in the past loads the viewport, not the configured window', async () => {
  const { engine, route, clock } = setup({ props: { pens: [{ tagPath: 'A' }], timeRange: { realtime: { value: 1, unit: 'hours' } } } });
  engine.start();
  await clock.advance(10);
  const a = clock.now() - 50 * M, b = clock.now() - 40 * M;
  engine.viewport.set({ min: a, max: b });
  await clock.advance(1000);                       // (10 min at 1000 px flips auto mode to raw: a free-range re-query runs)
  const n = route.calls.length;
  engine.reload();
  await clock.advance(500);
  const body = route.calls[n].body;
  assert.equal(body.start, Math.floor(a - 2.5 * M));
  assert.equal(body.end, Math.floor(b + 2.5 * M));
  assert.equal(engine.viewport.get().followLive, false);
  assert.equal(engine.coverage.live, false, 'a past window does not tick');
  engine.dispose();
});

test('raw window beyond maxRawRangeDays without the fallback: banner, no request', async () => {
  const { engine, route, clock } = setup({ props: histProps({ timeRange: { mode: 'historical', historical: { startDate: T0 - 40 * 24 * H, endDate: T0 } } }) });
  engine.start();
  await clock.advance(100);
  assert.equal(route.calls.length, 0);
  assert.equal(engine.model().banner.code, 'RAW_RANGE_TOO_LARGE');
  engine.dispose();
});

// ---- pen set ---------------------------------------------------------------------------------------------------
test('reconcile: a new pen gets a partial load (only that pen); a removed pen keeps its data 30 s', async () => {
  const { engine, route, clock, source } = setup();
  engine.start();
  await clock.advance(10);
  const n0 = route.calls.length;
  source.snap = Object.assign({}, source.snap, { pens: [penInfo(0, '[default]CTG/Temp'), penInfo(1, '[default]CTG/Pressure')] });
  source.emit('pens');
  await clock.advance(300);                       // per-chart spacing after the full load (minIntervalMs + 20)
  const partial = route.calls[n0].body;
  assert.deepEqual(partial.pens.map((p) => p.tagPath), ['[default]CTG/Pressure']);
  assert.equal(partial.pens[0].since, null);
  assert.equal(engine.metrics.partialLoads, 1);
  // remove Pressure, re-add within 30 s: no new load
  source.snap = Object.assign({}, source.snap, { pens: [penInfo(0, '[default]CTG/Temp')] });
  source.emit('pens');
  await clock.advance(5 * S);
  source.snap = Object.assign({}, source.snap, { pens: [penInfo(0, '[default]CTG/Temp'), penInfo(1, '[default]CTG/Pressure')] });
  source.emit('pens');
  await clock.advance(10);
  assert.equal(engine.metrics.partialLoads, 1, 'data kept, nothing refetched');
  // non-ok pens are never requested
  source.snap = Object.assign({}, source.snap, { pens: [penInfo(0, '[default]CTG/Temp'), penInfo(1, 'X', { status: 'noHistory' }), penInfo(2, 'Y', { status: 'outOfScope' })] });
  source.emit('pens');
  await clock.advance(3 * S);
  route.calls.slice(-2).forEach((c) => assert.deepEqual(c.body.pens.map((p) => p.tagPath), ['[default]CTG/Temp']));
  assert.deepEqual(engine.model().pens.map((p) => p.status), ['ok', 'noHistory', 'outOfScope']);
  engine.dispose();
});

test('a transient "loading" PenInfo is a pending row (no query) until it turns ok; chart.values per pen key', async () => {
  const { engine, route, clock, source } = setup();
  engine.start();
  await clock.advance(10);
  const n0 = route.calls.length;
  // a meta read still pending on the gateway: the pen is listed but must not be queried
  source.snap = Object.assign({}, source.snap, { pens: [penInfo(0, '[default]CTG/Temp'), penInfo(1, '[default]CTG/Pressure', { status: 'loading' })] });
  source.emit('pens', { pens: source.snap.pens, reason: 'meta' });
  await clock.advance(3 * S);
  route.calls.slice(n0).forEach((c) => assert.deepEqual(c.body.pens.map((p) => p.tagPath), ['[default]CTG/Temp']));
  assert.equal(engine.metrics.partialLoads, 0);
  assert.deepEqual(engine.model().pens.map((p) => p.status), ['ok', 'loading']);
  // the re-read resolves it: exactly that pen gets a partial load
  const n1 = route.calls.length;
  source.snap = Object.assign({}, source.snap, { pens: [penInfo(0, '[default]CTG/Temp'), penInfo(1, '[default]CTG/Pressure')] });
  source.emit('pens', { pens: source.snap.pens, reason: 'meta' });
  await clock.advance(300);
  const partial = route.calls.slice(n1).find((c) => c.body.pens.every((p) => p.since == null));
  assert.deepEqual(partial.body.pens.map((p) => p.tagPath), ['[default]CTG/Pressure']);
  assert.equal(engine.metrics.partialLoads, 1);
  // two pens on the same tag (static pen + trend-list pen): chart.values carries one entry per PEN key; both
  // resolve to the same data key, so either entry updates the shared "Current"
  source.snap = Object.assign({}, source.snap, { pens: [penInfo(0, '[default]CTG/Temp'),
    { key: 't:[default]ctg/temp', source: 'trend', index: null, tagPath: '[default]CTG/Temp', name: 'Temp', status: 'ok', meta: null, trendable: true }] });
  source.emit('pens', { pens: source.snap.pens, reason: 'trend' });
  await clock.advance(10);
  const now = clock.now();
  source.emit('values', { 'p:0': { v: 41.5, q: { code: 192, name: 'Good', level: 'good' }, t: now },
    't:[default]ctg/temp': { v: 41.5, q: { code: 192, name: 'Good', level: 'good' }, t: now } });
  assert.equal(engine.current('p:0').v, 41.5);
  assert.equal(engine.current('t:[default]ctg/temp').v, 41.5);
  // a value for a pen key the chart does not have is ignored; bad quality -> null "Current" (a gap)
  source.emit('values', { 'p:9': { v: 1, q: null, t: now + 1 }, 'p:0': { v: 7, q: { code: 0, name: 'Bad', level: 'bad' }, t: now + 2 } });
  assert.equal(engine.current('p:0').v, null);
  assert.equal(engine.current('p:0').q.level, 'bad');
  engine.dispose();
});

test('prop changes: window -> full load; refresh rate -> rescheduled without a load', async () => {
  const { C, engine, route, clock } = setup();
  engine.start();
  await clock.advance(10);
  engine.setProps(C.reduceProps({ pens: [{ tagPath: '[default]CTG/Temp' }], timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 5000 } }));
  await clock.advance(4500);
  const ticksAt5s = route.calls.length;
  assert.equal(engine.metrics.fullLoads, 1);
  engine.setProps(C.reduceProps({ pens: [{ tagPath: '[default]CTG/Temp' }], timeRange: { realtime: { value: 30, unit: 'minutes' }, refreshRate: 5000 } }));
  await clock.advance(10);
  assert.equal(engine.metrics.fullLoads, 2);
  assert.equal(route.calls[route.calls.length - 1].body.end - route.calls[route.calls.length - 1].body.start, 30 * M);
  assert.ok(ticksAt5s <= 3);
  engine.dispose();
});

test('viewport: following live slides; a past range pauses; reset returns to live', async () => {
  const { engine, clock } = setup({ props: { pens: [{ tagPath: 'A' }], timeRange: { realtime: { value: 1, unit: 'hours' } } } });
  engine.start();
  await clock.advance(10);
  let v = engine.viewport.get();
  assert.equal(v.followLive, true);
  assert.equal(v.max, clock.now());
  engine.viewport.set({ min: clock.now() - 30 * M, max: clock.now() - 10 * M });
  v = engine.viewport.get();
  assert.equal(v.followLive, false);
  assert.equal(engine.model().state, 'paused');
  await clock.advance(1000);
  engine.viewport.set({ min: clock.now() - 20 * M, max: clock.now() });
  assert.equal(engine.viewport.get().followLive, true, 'right edge at now -> live again');
  assert.equal(engine.viewport.get().span, 20 * M);
  engine.viewport.reset();
  assert.equal(engine.viewport.get().span, H);
  engine.dispose();
});

test('dispose: no timers fire afterwards, queue bookkeeping dropped', async () => {
  const { engine, route, clock, queue } = setup();
  engine.start();
  await clock.advance(1100);
  const n = route.calls.length;
  engine.dispose();
  await clock.advance(10 * S);
  assert.equal(route.calls.length, n);
  assert.equal(queue.lastStart.c1, undefined);
});

// ---- recovery after token loss, Refresh window, per-pen timeouts, token privacy --------------------------------
test('a pen added while the token is gone loads once a SNAPSHOT brings the token back (no "loading" forever)', async () => {
  const { engine, route, clock, source } = setup();
  engine.start();
  await clock.advance(10);
  source.creds = null;
  source.snap = Object.assign({}, source.snap);
  source.emit('snapshot');
  assert.equal(engine.model().banner.code, 'SESSION_MISMATCH');
  source.snap = Object.assign({}, source.snap, { pens: [penInfo(0, '[default]CTG/Temp'), penInfo(1, '[default]CTG/Extra')] });
  source.emit('pens');
  await clock.advance(2 * S);
  const n = route.calls.length;
  assert.equal(engine.model().pens[1].status, 'loading');
  // the token comes back through a snapshot (not a chart.token push)
  source.creds = { url: '/h', token: 'tok-back', expiresAt: 4102444800000 };
  source.snap = Object.assign({}, source.snap);
  source.emit('snapshot');
  await clock.advance(3 * S);
  const m = engine.model();
  assert.equal(m.banner, null);
  assert.ok(route.calls.length > n, 'requests resumed');
  assert.ok(route.calls.slice(n).some((c) => c.body.pens.some((p) => p.tagPath === '[default]CTG/Extra')), 'new pen requested');
  assert.equal(m.pens[1].status, 'ok');
  assert.ok(m.pens[1].points > 0);
  engine.dispose();
});

test('a partial load cancelled by the token loss is redone when a snapshot brings the token back', async () => {
  const { engine, clock, source } = setup({ route: { latency: 1500 } });
  engine.start();
  await clock.advance(2 * S);
  source.snap = Object.assign({}, source.snap, { pens: [penInfo(0, '[default]CTG/Temp'), penInfo(1, '[default]CTG/Extra')] });
  source.emit('pens');                               // partial load for Extra in flight (1.5 s)
  await clock.advance(300);
  source.creds = null;
  source.emit('token');                              // gen++ cancels the partial load
  await clock.advance(3 * S);
  assert.equal(engine.model().pens[1].status, 'loading');
  source.creds = { url: '/h', token: 'tok-back', expiresAt: 4102444800000 };
  source.snap = Object.assign({}, source.snap);
  source.emit('snapshot');
  await clock.advance(5 * S);
  assert.equal(engine.model().pens[1].status, 'ok');
  assert.ok(engine.model().pens[1].points > 0);
  engine.dispose();
});

test('reconcile re-queues a key left at "loading" by a cancelled load (not part of any running load)', async () => {
  const { engine, route, clock, source } = setup();
  engine.start();
  await clock.advance(2 * S);
  // simulate the leftover of a cancelled load: the key exists at 'loading', no load holds it
  const pd = engine.store.ensure('[default]ctg/third|' + engine.props.query.aggregation, '[default]CTG/Third', engine.props.query.aggregation);
  assert.equal(pd.status, 'loading');
  const n = route.calls.length;
  source.snap = Object.assign({}, source.snap, { pens: [penInfo(0, '[default]CTG/Temp'), penInfo(2, '[default]CTG/Third')] });
  source.emit('pens');
  await clock.advance(2 * S);
  assert.ok(route.calls.slice(n).some((c) => c.body.pens.some((p) => p.tagPath === '[default]CTG/Third' && p.since == null)), 'loaded');
  assert.equal(engine.model().pens[1].status, 'ok');
  engine.dispose();
});

test('a window change made while the token is gone is applied (viewport reset) when it comes back', async () => {
  const { C, engine, route, clock, source } = setup({ start: T0 + H, props: histProps({ query: { mode: 'aggregated' } }) });
  engine.start();
  await clock.advance(2 * S);
  source.creds = null;
  source.emit('token');
  engine.setProps(C.reduceProps(histProps({ query: { mode: 'aggregated' },
    timeRange: { mode: 'historical', historical: { startDate: T0 - 3 * H, endDate: T0 - H } } })));
  assert.equal(engine.model().banner.code, 'SESSION_MISMATCH');
  const n = route.calls.length;
  source.creds = { url: '/h', token: 'tok-back', expiresAt: 4102444800000 };
  source.snap = Object.assign({}, source.snap);
  source.emit('snapshot');
  await clock.advance(2 * S);
  const body = route.calls[n].body;
  assert.equal(body.start, T0 - 3 * H);
  assert.equal(body.end, T0 - H);
  const v = engine.viewport.get();
  assert.deepEqual([v.min, v.max], [T0 - 3 * H, T0 - H]);
  engine.dispose();
});

test('raw beyond maxRawRangeDays with onTooManyPoints "aggregate": ONE aggregated request, downgraded + notice', async () => {
  const { engine, route, clock } = setup({ start: T0 + H, props: histProps({
    timeRange: { mode: 'historical', historical: { startDate: T0 - 120 * 24 * H, endDate: T0 } },
    query: { mode: 'raw', onTooManyPoints: 'aggregate' } }) });
  engine.start();
  await clock.advance(10 * S);
  assert.equal(route.calls.length, 1, `requests: ${route.calls.length}`);
  assert.equal(route.calls[0].body.mode, 'aggregated');
  const m = engine.model();
  assert.equal(m.banner, null);
  assert.equal(m.pens[0].status, 'ok');
  assert.equal(m.pens[0].downgraded, true);
  assert.ok(m.notices.some((x) => x.code === 'rawDowngraded' && x.days === 31), JSON.stringify(m.notices));
  engine.dispose();
});

test('historical Refresh reloads the CONFIGURED window (no +-25 %): a 25-day raw window stays valid', async () => {
  const props = histProps({ timeRange: { mode: 'historical', historical: { startDate: T0 - 25 * 24 * H, endDate: T0 } } });
  const { engine, route, clock } = setup({ start: T0 + H, props, route: { stepMs: 2 * H } });
  engine.start();
  await clock.advance(20 * S);
  assert.equal(engine.model().banner, null);
  const span = (calls) => [Math.min(...calls.map((c) => c.body.start)), Math.max(...calls.map((c) => c.body.end))];
  assert.deepEqual(span(route.calls), [T0 - 25 * 24 * H, T0]);
  const n = route.calls.length;
  engine.reload();
  await clock.advance(20 * S);
  assert.equal(engine.model().banner, null, 'no RAW_RANGE_TOO_LARGE on Refresh');
  assert.ok(route.calls.length > n);
  assert.deepEqual(span(route.calls.slice(n)), [T0 - 25 * 24 * H, T0], 'the configured window, not 37.5 days');
  assert.deepEqual([engine.viewport.get().min, engine.viewport.get().max], [T0 - 25 * 24 * H, T0]);
  // a moved historical viewport keeps a margin, clamped to the raw limit
  engine.viewport.set({ min: T0 - 30 * 24 * H, max: T0 - 1 * 24 * H });
  await clock.advance(20 * S);
  const k = route.calls.length;
  engine.reload();
  await clock.advance(20 * S);
  const [a, b] = span(route.calls.slice(k));
  assert.ok(b - a <= 31 * 24 * H, `reload window ${(b - a) / H} h`);
  assert.ok(a <= T0 - 30 * 24 * H && b >= T0 - 1 * 24 * H, 'covers the viewport');
  assert.equal(engine.model().banner, null);
  engine.dispose();
});

test('a per-pen timeout on a later chunk keeps that pen\'s loaded chunks ("Partially loaded")', async () => {
  let clk;
  const timeoutBulk1 = (body, n) => {
    if (n !== 5) return null;
    const json = answer(body, clk.now(), { stepMs: 10 * S });
    json.pens = json.pens.map((p) => (p.tagPath === 'Bulk1' ? { key: p.key, tagPath: p.tagPath, status: 'timeout', t: [], v: [] } : p));
    return { status: 200, json };
  };
  const s = setup({ start: T0 + H, pens: [penInfo(0, 'Bulk1'), penInfo(1, 'Bulk2')],
    props: histProps({ pens: [{ tagPath: 'Bulk1' }, { tagPath: 'Bulk2' }] }), route: { stepMs: 10 * S, respond: timeoutBulk1 } });
  clk = s.clock;
  s.engine.start();
  await s.clock.advance(30 * S);
  const m = s.engine.model();
  assert.equal(m.pens[0].status, 'ok');
  assert.equal(m.pens[0].points, 4 * 360, 'Bulk1 keeps its 4 newest chunks');
  assert.equal(m.pens[0].warn, 'timeout');
  assert.equal(s.engine.penData('p:0').coverage.start, T0 - 4 * H, 'coverage = loaded span');
  assert.equal(m.pens[1].points, 27 * 360, 'Bulk2 loads every chunk');
  assert.ok(m.notices.some((x) => x.code === 'partial'));
  assert.ok(s.route.calls.slice(5).every((c) => c.body.pens.every((p) => p.tagPath !== 'Bulk1')), 'Bulk1 not requested again');
  s.engine.dispose();
});

test('slow history responses do not feed the page clock', async () => {
  const { NS, C } = load();
  const clock = fakeClock(T0);
  const route = fakeRoute(clock, { respond: (b) => ({ status: 200, json: Object.assign(answer(b, clock.now(), {}), { serverNow: Date.now() + 3600000 }) }) });
  const queue = new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers });
  const metrics = { requests: 0, requestBytes: 0, responses: 0, bytes: 0, lastBytes: 0, inFlight: 0, inFlightMax: 0, perf: { fetchMs: [], parseMs: [] } };
  const slowFetch = (url, init) => new Promise((res) => setTimeout(() => res(route(url, init)), 400));
  const before = NS.clock.offset();
  const slow = new C.HistoryClient({ source: fakeSource([]), queue, key: 'k', fetch: slowFetch, metrics });
  const r = await slow.post({ v: 2, requestId: 'r', start: T0 - H, end: T0, mode: 'raw', pens: [] }, {});
  assert.equal(r.ok, true);
  assert.equal(NS.clock.offset(), before, 'a 400 ms round trip is not sampled');
  const fast = new C.HistoryClient({ source: fakeSource([]), queue, key: 'k2', fetch: route, metrics });
  await fast.post({ v: 2, requestId: 'r2', start: T0 - H, end: T0, mode: 'raw', pens: [] }, {});
  assert.ok(Math.abs(NS.clock.offset() - 3600000) < 2000, `a quick one is: ${NS.clock.offset()}`);
});

test('stats() cache is keyed by its options (median on request)', async () => {
  const { engine, clock } = setup();
  engine.start();
  await clock.advance(10);
  const a = engine.stats('p:0');
  assert.equal(a.median, null);
  const b = engine.stats('p:0', null, null, { median: true });
  assert.ok(Number.isFinite(b.median), JSON.stringify(b));
  engine.dispose();
});

test('the history token is not reachable from window.__CTG (delegates, debug charts, mapped props)', async () => {
  const { env, NS, C } = load();
  env.window.localStorage = { getItem: (k) => (k === 'ctg.debug' ? '1' : null) };
  const TOKEN = 'SECRET-token-0123456789abcdefghijklmnopq';
  const TOKEN2 = 'RENEWED-token-9876543210zyxwvutsrqponml';
  const store = { addressPathString: '0:7' };
  const d = new C.CtgChartDelegate(store);
  d.attach();
  const e = (seq, extra) => Object.assign({ v: 2, epoch: 'e1', seq, serverNow: Date.now() }, extra);
  d.handleEvent('ctg.welcome', e(1, { protocol: 2 }));
  d.handleEvent('chart.snapshot', e(2, { pens: [penInfo(0, '[default]CTG/Temp')], trend: { group: null, paths: [], max: 32 },
    limits: { maxPens: 32 }, history: { url: '/data/simpletagdisplay/v2/history', token: TOKEN, expiresAt: 4102444800000 } }));
  const clock = fakeClock(T0);
  const sentTokens = [];
  const route = fakeRoute(clock);
  // a real delegate's token only goes to window.fetch (a caller-supplied fetch is ignored for it)
  env.window.fetch = (url, init) => { sentTokens.push(init.headers['X-CTG-Token']); return route(url, init); };
  const engine = new C.ChartEngine({ id: 'chartProbe', source: d, queue: new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers }),
    now: clock.now, timers: clock.timers, document: null, props: C.reduceProps({ pens: [{ tagPath: '[default]CTG/Temp' }] }), timeZone: 'UTC', plotWidth: 1000 });
  engine.start();
  await clock.advance(100);
  assert.deepEqual(sentTokens, [TOKEN], 'the engine still sends the token');
  assert.equal(d.hasCreds(), true);
  assert.ok(NS.debug.charts.chartProbe && NS.debug.charts.chartProbe.engine === engine, 'debug entry published');
  d.handleEvent('chart.token', e(3, { url: '/data/simpletagdisplay/v2/history', token: TOKEN2, expiresAt: 4102444800000 }));
  /** Breadth-first walk over every own property (enumerable or not), Map/Set entries and prototypes' data. */
  const reach = (roots, needle) => {
    const seen = new Set(), queue = roots.slice(), hits = [];
    while (queue.length && seen.size < 200000) {
      const [o, path] = queue.shift();
      if (typeof o === 'string') { if (o.includes(needle)) hits.push(path); continue; }
      if (!o || (typeof o !== 'object' && typeof o !== 'function') || seen.has(o)) continue;
      seen.add(o);
      if (o instanceof Map || (o.constructor && o.constructor.name === 'Map')) for (const [k, v] of o) { queue.push([k, path + '<k>']); queue.push([v, path + '.get(' + String(k).slice(0, 20) + ')']); }
      if (o instanceof Set || (o.constructor && o.constructor.name === 'Set')) { let i = 0; for (const v of o) queue.push([v, path + '{' + (i++) + '}']); }
      for (const k of Object.getOwnPropertyNames(o)) {
        const desc = Object.getOwnPropertyDescriptor(o, k);
        if (desc && 'value' in desc) queue.push([desc.value, path + '.' + k]);
      }
    }
    return hits;
  };
  const roots = [[NS, '__CTG'], [d.mapStateToProps(), 'props'], [engine, 'engine'], [engine.model(), 'model']];
  assert.deepEqual(reach(roots, TOKEN), []);
  assert.deepEqual(reach(roots, TOKEN2), []);
  assert.equal(d.snap.history, undefined, 'snapshot kept without history');
  assert.equal(d.mapStateToProps().hasToken, true);
  engine.dispose();
  d.detach();
});

// ---- epoch gaps, snapshot recovery, later-chunk timeouts, token isolation --------------------------------------
/** onEpochChange of the real delegate: the snapshot is gone until the new one arrives. */
function epochGap(source) { source.snap = null; source.emit('epoch'); }
function snapshotBack(source, snap) { source.snap = Object.assign({}, snap); source.emit('snapshot'); }

test('a historical window change made during an epoch gap (no snapshot) is applied when the snapshot returns', async () => {
  const { C, engine, route, clock, source } = setup({ start: T0 + H, props: histProps({ query: { mode: 'aggregated' } }) });
  engine.start();
  await clock.advance(2 * S);
  const snap = source.snap;
  epochGap(source);
  engine.setProps(C.reduceProps(histProps({ query: { mode: 'aggregated' },
    timeRange: { mode: 'historical', historical: { startDate: T0 - 3 * H, endDate: T0 - H } } })));
  const n = route.calls.length;
  await clock.advance(2 * S);
  assert.equal(route.calls.length, n, 'nothing can load without a snapshot');
  snapshotBack(source, snap);
  await clock.advance(2 * S);
  assert.ok(route.calls.length > n, 'the deferred load ran');
  assert.equal(route.calls[n].body.start, T0 - 3 * H);
  assert.equal(route.calls[n].body.end, T0 - H);
  const v = engine.viewport.get();
  assert.deepEqual([v.min, v.max], [T0 - 3 * H, T0 - H], 'viewport reset to the new window');
  assert.equal(engine.window.start, T0 - 3 * H);
  engine.dispose();
});

test('a realtime range change (15 -> 60 min) during an epoch gap is applied when the snapshot returns', async () => {
  const { C, engine, route, clock, source } = setup();
  engine.start();
  await clock.advance(3 * S);
  const snap = source.snap;
  epochGap(source);
  engine.setProps(C.reduceProps({ pens: [{ tagPath: '[default]CTG/Temp' }], timeRange: { realtime: { value: 60, unit: 'minutes' }, refreshRate: 1000 } }));
  await clock.advance(S);
  const n = route.calls.length;
  snapshotBack(source, snap);
  await clock.advance(3 * S);
  const full = route.calls.slice(n).find((c) => c.body.pens.every((p) => p.since == null));
  assert.ok(full, 'a full load after the snapshot');
  assert.equal(full.body.end - full.body.start, 60 * M);
  assert.equal(engine.viewport.get().max - engine.viewport.get().min, 60 * M, 'viewport span follows the props');
  const tick = route.calls[route.calls.length - 1].body;
  assert.ok(tick.pens.every((p) => p.since != null), 'ticks resumed');
  assert.ok(Math.abs(tick.end - tick.start - 60 * M) <= S, `ticks over 60 min (${(tick.end - tick.start) / M} min)`);
  engine.dispose();
});

test('snapshot recovery does not start a partial load that the recovery full load aborts', async () => {
  const { engine, route, clock, source } = setup();
  engine.start();
  await clock.advance(10);
  source.creds = null;
  source.snap = Object.assign({}, source.snap);
  source.emit('snapshot');
  source.snap = Object.assign({}, source.snap, { pens: [penInfo(0, '[default]CTG/Temp'), penInfo(1, '[default]CTG/Extra')] });
  source.emit('pens');
  await clock.advance(2 * S);
  const n = route.calls.length;
  const partials = engine.metrics.partialLoads;
  source.creds = { url: '/h', token: 'tok-back', expiresAt: 4102444800000 };
  source.snap = Object.assign({}, source.snap);
  source.emit('snapshot');
  await clock.advance(3 * S);
  assert.equal(engine.metrics.partialLoads, partials, 'no partial load');
  assert.deepEqual(route.calls[n].body.pens.map((p) => p.tagPath).sort(), ['[default]CTG/Extra', '[default]CTG/Temp'],
    'the first request is the full load with both pens');
  assert.equal(engine.model().pens[1].status, 'ok');
  // a plain pen add (no full load follows) still uses a partial load
  const k = engine.metrics.partialLoads;
  source.snap = Object.assign({}, source.snap, { pens: source.snap.pens.concat([penInfo(2, '[default]CTG/Third')]) });
  source.emit('pens');
  await clock.advance(2 * S);
  assert.equal(engine.metrics.partialLoads, k + 1);
  assert.equal(engine.model().pens[2].status, 'ok');
  engine.dispose();
});

test('a window change together with a new pen loads the pen in the full load (no aborted partial first)', async () => {
  const { C, engine, route, clock, source } = setup();
  engine.start();
  await clock.advance(3 * S);
  const partials = engine.metrics.partialLoads;
  const n = route.calls.length;
  source.snap = Object.assign({}, source.snap, { pens: [penInfo(0, '[default]CTG/Temp'), penInfo(1, '[default]CTG/Extra')] });
  // the props change arrives first (the component re-renders), the pens push right after
  engine.setProps(C.reduceProps({ pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Extra' }],
    timeRange: { realtime: { value: 30, unit: 'minutes' }, refreshRate: 1000 } }));
  await clock.advance(3 * S);
  assert.equal(engine.metrics.partialLoads, partials, 'no partial load');
  assert.deepEqual(route.calls[n].body.pens.map((p) => p.tagPath).sort(), ['[default]CTG/Extra', '[default]CTG/Temp']);
  assert.equal(engine.model().pens[1].status, 'ok');
  engine.dispose();
});

test('a pen dropped after a later-chunk timeout keeps its warning through realtime ticks', async () => {
  let clk;
  const timeoutBulk1 = (body, n) => {
    if (n !== 2) return null;
    const json = answer(body, clk.now(), { stepMs: 10 * S });
    json.pens = json.pens.map((p) => (p.tagPath === 'Bulk1' ? { key: p.key, tagPath: p.tagPath, status: 'timeout', t: [], v: [] } : p));
    return { status: 200, json };
  };
  const s = setup({ pens: [penInfo(0, 'Bulk1'), penInfo(1, 'Bulk2')],
    // fixed 1 h chunks: a 1 h piece is one cache unit, so its timeout is not split (only wider pieces are)
    props: { pens: [{ tagPath: 'Bulk1' }, { tagPath: 'Bulk2' }], timeRange: { realtime: { value: 5, unit: 'hours' }, refreshRate: 1000 },
      query: { mode: 'raw', chunking: { enabled: true, rawChunk: '1h' } } },
    route: { stepMs: 10 * S, respond: timeoutBulk1 } });
  clk = s.clock;
  s.engine.start();
  await s.clock.advance(8 * S);
  const m = s.engine.model();
  assert.ok(s.route.calls.slice(-1)[0].body.pens.every((p) => p.since != null), 'ticks running');
  assert.equal(m.pens[0].status, 'ok');
  assert.equal(m.pens[0].warn, 'timeout', 'still warned after the ticks');
  assert.equal(m.pens[0].incomplete, 'timeout');
  assert.equal(m.pens[1].warn, null);
  assert.equal(m.pens[1].incomplete, null);
  assert.ok(m.pens[0].coverage.start > m.pens[1].coverage.start, 'Bulk1 covers less of the window');
  // a new full load (Refresh) clears it
  s.engine.reload();
  await s.clock.advance(10 * S);
  assert.equal(s.engine.model().pens[0].incomplete, null);
  assert.equal(s.engine.model().pens[0].warn, null);
  s.engine.dispose();
});

test('every pen timing out on a later chunk -> partial, coverage = the loaded span, a pan into the gap re-queries', async () => {
  let clk;
  const timeoutFrom3 = (body, n) => {
    if (n < 3) return null;
    const json = answer(body, clk.now(), { stepMs: 10 * S });
    json.pens = json.pens.map((p) => ({ key: p.key, tagPath: p.tagPath, status: 'timeout', t: [], v: [] }));
    return { status: 200, json };
  };
  const s = setup({ start: T0 + H, props: histProps(), route: { stepMs: 10 * S, respond: timeoutFrom3 } });
  clk = s.clock;
  s.engine.start();
  await s.clock.advance(10 * S);
  assert.equal(s.route.calls.length, 3, 'stops after the timed-out chunk');
  const m = s.engine.model();
  assert.ok(m.notices.some((x) => x.code === 'partial'));
  assert.equal(m.pens[0].warn, 'timeout');
  assert.equal(m.pens[0].incomplete, 'timeout');
  assert.equal(s.engine.coverage.start, T0 - 2 * H, 'chart coverage = the two loaded chunks, not the 27 h window');
  const n = s.route.calls.length;
  s.engine.viewport.set({ min: T0 - 10 * H, max: T0 - 8 * H });
  await s.clock.advance(2 * S);
  assert.ok(s.route.calls.length > n, 'a pan into the missing part re-queries');
  s.engine.dispose();
});

test('a HistoryClient built by page script on a real delegate cannot hand its token to a caller fetch', async () => {
  const { env, C } = load();
  const TOKEN = 'SECRET-token-stolen-0123456789abcdefghijk';
  const d = new C.CtgChartDelegate({ addressPathString: '0:9' });
  d.attach();
  const e = (seq, extra) => Object.assign({ v: 2, epoch: 'e1', seq, serverNow: Date.now() }, extra);
  d.handleEvent('ctg.welcome', e(1, { protocol: 2 }));
  d.handleEvent('chart.snapshot', e(2, { pens: [], trend: { group: null, paths: [], max: 32 }, limits: { maxPens: 32 },
    history: { url: '/data/simpletagdisplay/v2/history', token: TOKEN, expiresAt: 4102444800000 } }));
  const clock = fakeClock(T0);
  const reply = () => Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve('{}') });
  const stolen = [];
  const steal = (url, init) => { stolen.push(init.headers['X-CTG-Token']); return reply(); };
  const viaWindow = [];
  env.window.fetch = (url, init) => { viaWindow.push(url); return reply(); };
  const metrics = { requests: 0, requestBytes: 0, responses: 0, bytes: 0, lastBytes: 0, inFlight: 0, inFlightMax: 0, perf: { fetchMs: [], parseMs: [] } };
  const hc = new C.HistoryClient({ source: d, queue: new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers }),
    key: 'x', fetch: steal, metrics });
  await hc.post({ v: 2, requestId: 'r', pens: [] }, {});
  assert.deepEqual(stolen, [], 'the caller-supplied fetch never sees the delegate token');
  assert.equal(viaWindow.length, 1, 'the request went through window.fetch');
  d.detach();
});
