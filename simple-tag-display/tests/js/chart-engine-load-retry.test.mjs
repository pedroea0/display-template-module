// =============================================================================
// chart-engine-load-retry.test.mjs — load retries, client deadline, partial loads
// =============================================================================
//   - a realtime chart whose full loads time out twice (504 TIMEOUT) used to
//     stop for good: now it backs off, keeps retrying, shows a banner and
//     recovers by itself
//   - a client-side deadline for history POSTs (AbortController, the
//     gateway's query deadline + margin): CLIENT_TIMEOUT, retried
//   - cancelLoad during a pen-add (partial) chunked load must not shrink the
//     whole chart's coverage (only that pen is incomplete)
//   - the "Partially loaded" notice clears once the realtime window slid past
//     the missing part (together with the pens' `incomplete`)
// Helpers are a minimal copy of chart-engine.test.mjs's fakes (fake clock,
// fake /v2/history, fake delegate) so this file runs on its own.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, FILES } from './_stubs.mjs';

const S = 1000, M = 60 * S, H = 60 * M;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

function load() {
  const env = createEnv();
  env.window.AbortController = AbortController;              // the client deadline needs it (browser has it)
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  return { env, NS: env.window.__CTG, C: env.window.__CTG.chart };
}
async function flush() { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); }
function fakeClock(start) {
  let now = start, id = 0;
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
/** Fake /v2/history (raw 1 sample per stepMs, v = t/1000); opts.respond(body, n) overrides; opts.latency(body, n). */
function fakeRoute(clock, opts = {}) {
  const calls = [];
  const fn = (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ body, at: clock.now() });
    const n = calls.length;
    const make = () => {
      const custom = opts.respond && opts.respond(body, n);
      const r = custom || { status: 200, json: answer(body, clock.now(), opts) };
      return { status: r.status, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(r.json)) };
    };
    const lat = typeof opts.latency === 'function' ? opts.latency(body, n) : opts.latency || 0;
    return new Promise((res, rej) => {
      // like fetch: an aborted signal rejects with AbortError (the client deadline relies on it)
      if (init.signal) init.signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; rej(e); });
      if (!lat) res(make()); else clock.timers.set(() => res(make()), lat);
    });
  };
  fn.calls = calls;
  return fn;
}
function answer(body, now, opts) {
  const dataEnd = Math.min(body.end, now);
  const step = opts.stepMs || S;
  return {
    v: 2, ok: true, requestId: body.requestId, serverNow: now,
    window: { start: body.start, end: dataEnd, mode: 'raw', aggregation: body.aggregation, bucketMs: null, bucketTime: null },
    pens: body.pens.map((p) => {
      const from = p.since != null && p.since >= body.start ? p.since + 1 : body.start;
      const t = [];
      for (let x = Math.ceil(from / step) * step; x < dataEnd; x += step) t.push(x);
      return { key: p.key, tagPath: p.tagPath, status: 'ok', t, v: t.map((x) => x / 1000), anchor: null, replaceFrom: null, count: t.length };
    }),
  };
}
const TIMEOUT = { status: 504, json: { v: 2, ok: false, error: { code: 'TIMEOUT', message: 'history query timed out', retryable: true } } };
function penInfo(i, tagPath) {
  return { key: 'p:' + i, source: 'pens', index: i, tagPath, name: tagPath.split('/').pop(), status: 'ok', meta: null, trendable: true };
}
function fakeSource(pens) {
  const ls = [];
  return {
    snap: { pens, trend: { group: null, paths: [], max: 32 }, limits: { maxPens: 32, minBucketMs: 100, maxConcurrentPerSession: 4 } },
    creds: { url: '/data/simpletagdisplay/v2/history', token: 'tok-1', expiresAt: 4102444800000 },
    state: { connected: true }, reason: null,
    staleReason() { return this.reason; },
    getCreds() { return this.creds; },
    renewToken() { return Promise.resolve(true); },
    on(fn) { ls.push(fn); return () => { const i = ls.indexOf(fn); if (i >= 0) ls.splice(i, 1); }; },
    emit(t, p) { ls.slice().forEach((f) => f(t, p)); },
  };
}
function setup(opts = {}) {
  const { C } = load();
  const clock = fakeClock(opts.start || T0);
  const route = fakeRoute(clock, opts.route || {});
  const queue = new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers });
  const source = fakeSource(opts.pens || [penInfo(0, '[default]CTG/Temp')]);
  const doc = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const props = C.reduceProps(opts.props || { pens: [{ tagPath: '[default]CTG/Temp' }], timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 1000 } });
  const engine = new C.ChartEngine({ id: 'c1', source, queue, now: clock.now, timers: clock.timers, document: doc, fetch: route,
    props, timeZone: 'UTC', plotWidth: 1000 });
  return { C, clock, route, queue, source, engine };
}

test('full loads timing out keep retrying with backoff, banner from the 2nd failure, automatic recovery', async () => {
  let fails = 4;
  const { engine, route, clock } = setup({ route: { respond: (body, n) => (fails-- > 0 ? TIMEOUT : null) } });
  engine.start();
  await clock.advance(10);
  assert.equal(route.calls.length, 1);
  assert.equal(engine.model().banner, null, 'no banner after the first timeout');
  await clock.advance(5 * S);                                  // retry 1 (5 s)
  assert.equal(route.calls.length, 2);
  assert.equal(engine.model().banner.code, 'timeout', 'banner from the second failure on');
  assert.match(engine.model().banner.message, /retrying/);
  await clock.advance(60 * S);                                 // retries 2, 3 back off (>= 5 s, growing)
  assert.ok(route.calls.length >= 4, `kept retrying (${route.calls.length} requests) — an earlier version stopped after 2`);
  const fulls = route.calls.filter((c) => c.body.pens.every((p) => p.since == null));
  const gaps = fulls.slice(1, 5).map((c, i) => c.at - fulls[i].at);
  assert.ok(gaps.every((g) => g >= 5 * S), 'never faster than the 5 s first retry: ' + gaps);
  assert.ok(gaps[gaps.length - 1] >= gaps[0], 'backs off');
  await clock.advance(70 * S);                                 // the 5th attempt succeeds -> loop runs
  const m = engine.model();
  assert.equal(m.banner, null, 'banner cleared by the successful load');
  assert.equal(m.state, 'live');
  const n = route.calls.length;
  await clock.advance(5 * S);
  assert.ok(route.calls.length >= n + 4, 'realtime ticks resumed');
  engine.dispose();
});

test('a realtime catch-up load that times out repeatedly does not kill the tick loop', async () => {
  let timeouts = false;
  const { engine, route, clock } = setup({ route: { respond: (body) => (timeouts && body.pens.every((p) => p.since == null) ? TIMEOUT : null) } });
  engine.start();
  await clock.advance(3 * S);
  assert.equal(engine.model().state, 'live');
  // the page sleeps longer than the window: the next tick needs a full catch-up load, which times out 3x
  timeouts = true;
  engine.coverage.end = clock.now() - 20 * M;
  await clock.advance(40 * S);
  assert.ok(route.calls.filter((c) => c.body.pens.every((p) => p.since == null)).length >= 3, 'catch-up retried');
  timeouts = false;
  await clock.advance(70 * S);
  const m = engine.model();
  assert.equal(m.banner, null);
  assert.equal(m.state, 'live');
  const n = route.calls.length;
  await clock.advance(4 * S);
  assert.ok(route.calls.length >= n + 3, 'ticks run again');
  engine.dispose();
});

test('a gateway that never answers is aborted at the client deadline (CLIENT_TIMEOUT) and retried', async () => {
  const { engine, route, clock } = setup({ route: { latency: (body, n) => (n === 1 ? 10 * 60 * S : 0) } });
  assert.equal(engine.client.timeoutMs(), 25 * S, 'gateway default 15 s + 10 s margin');
  engine.L.historyTimeoutMs = 30 * S;                           // a gateway announcing its deadline wins
  assert.equal(engine.client.timeoutMs(), 40 * S);
  delete engine.L.historyTimeoutMs;
  engine.start();
  await clock.advance(24 * S);
  assert.equal(route.calls.length, 1, 'still waiting');
  await clock.advance(2 * S);
  assert.equal(engine.metrics.clientTimeouts, 1);
  assert.equal(engine.metrics.lastError, 'CLIENT_TIMEOUT');
  await clock.advance(6 * S);
  assert.equal(route.calls.filter((c) => c.body.pens.every((p) => p.since == null)).length, 2, 'retried (one new full load) after 5 s');
  assert.equal(engine.model().state, 'live');
  engine.dispose();
});

test('cancelling a pen-add chunked load keeps the chart coverage; only the new pen is incomplete', async () => {
  const props = { pens: [{ tagPath: '[default]CTG/Bulk1' }, { tagPath: '[default]CTG/Bulk2' }], query: { mode: 'raw', chunking: { enabled: true, rawChunk: '1h' } },
    timeRange: { mode: 'historical', historical: { startDate: T0 - 27 * H, endDate: T0 } } };
  const { engine, route, clock, source } = setup({ start: T0 + H, props, pens: [penInfo(0, '[default]CTG/Bulk1')],
    route: { stepMs: 10 * S, latency: (body, n) => (n > 27 ? 100 : 0) } });
  engine.start();
  await clock.advance(20 * S);
  const cov0 = Object.assign({}, engine.coverage);
  assert.equal(cov0.start, T0 - 27 * H, 'full window loaded');
  source.snap = Object.assign({}, source.snap, { pens: [penInfo(0, '[default]CTG/Bulk1'), penInfo(1, '[default]CTG/Bulk2')] });
  source.emit('pens');
  await clock.advance(450);                                   // a few chunks of the pen-add load
  assert.ok(engine.metrics.partialLoads === 1);
  engine.cancelLoad();
  await clock.advance(5 * S);
  assert.equal(engine.coverage.start, cov0.start, 'chart coverage not shrunk (an earlier version moved it to the partial load\'s start)');
  const m = engine.model();
  const added = m.pens.find((p) => p.key === 'p:1');
  assert.ok(added.points > 0 && added.points < 27 * 360, 'the pen keeps what arrived');
  assert.equal(added.incomplete, 'partial');
  assert.equal(m.pens.find((p) => p.key === 'p:0').incomplete, null);
  assert.ok(m.notices.some((n) => n.code === 'partial'), 'notice from the pen\'s incomplete flag');
  assert.ok(route.calls.length < 27 + 27, 'remaining chunks not requested');
  engine.dispose();
});

test('"Partially loaded" clears once the realtime window slid past the part that was never loaded', async () => {
  const props = { pens: [{ tagPath: '[default]CTG/Temp' }], query: { mode: 'raw', chunking: { enabled: true, rawChunk: '1h' } },
    timeRange: { realtime: { value: 3, unit: 'hours' }, refreshRate: 60000 } };
  const { engine, clock } = setup({ props, route: { stepMs: 10 * S, latency: 200 } });
  engine.start();
  await clock.advance(250);                                   // newest chunk only
  engine.cancelLoad();
  await clock.advance(1000);
  let m = engine.model();
  assert.ok(m.notices.some((n) => n.code === 'partial'), 'partial after the cancel');
  const missingUntil = engine.coverage.start;
  assert.ok(missingUntil > clock.now() - 3 * H + 30 * M, 'coverage = the loaded newest chunk');
  // the window start passes the loaded start after ~ (missingUntil - windowStart) of sliding
  await clock.advance(missingUntil - (clock.now() - 3 * H) + 2 * 60000);
  m = engine.model();
  assert.ok(!m.notices.some((n) => n.code === 'partial'), 'notice cleared by the slide');
  assert.equal(m.state, 'live');
  engine.dispose();
});

test('failing ticks beside a retrying full load do not speed up its 2 / 4 / 8 s backoff', async () => {
  let fail = false;
  const F502 = { status: 502, json: { v: 2, ok: false, error: { code: 'HISTORY_QUERY_FAILED', message: 'History query failed', retryable: true } } };
  const { engine, route, clock } = setup({ route: { respond: () => (fail ? F502 : null) } });
  engine.start();
  await clock.advance(3 * S);
  fail = true;
  const n0 = route.calls.length;
  engine.reload();
  await clock.advance(16 * S);
  const fulls = route.calls.slice(n0).filter((c) => c.body.pens.every((p) => p.since == null));
  const gaps = fulls.slice(1, 4).map((c, i) => (c.at - fulls[i].at) / S);
  assert.deepEqual(gaps, [2, 4, 8], 'full-load retries: ' + gaps);
  assert.ok(route.calls.slice(n0).some((c) => c.body.pens.every((p) => p.since != null)), 'ticks kept running (and failing) meanwhile');
  assert.equal(engine.model().banner.code, 'error');
  fail = false;
  await clock.advance(20 * S);
  assert.equal(engine.model().banner, null);
  engine.dispose();
});
