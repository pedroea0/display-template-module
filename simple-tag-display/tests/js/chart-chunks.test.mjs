// =============================================================================
// chart-chunks.test.mjs — adaptive raw chunks + the history deadline
// =============================================================================
// rawChunk "auto" no longer means one-hour chunks: a probe chunk (the newest
// hour) measures the density, then every further chunk is sized so its
// expected points per pen approach (not exceed) fill x maxPointsPerPen and the
// whole response stays under fill x maxPointsPerResponse. Pens the gateway
// refuses only for the RESPONSE size get the piece again in halves. The client
// fetch deadline follows limits.historyTimeoutMs, 15 s default.
// Same fake gateway style as chart-engine.test.mjs (manual clock + route).
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, FILES } from './_stubs.mjs';

const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;
const T0 = Date.UTC(2026, 9, 8, 12, 0, 0);

function load() {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  return env.window.__CTG.chart;
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
/**
 * Raw route: samples every stepOf(t) ms (default 1 s); per-pen cap = body.maxPointsPerPen; with opts.responseCap the
 * pens are charged in request order and a pen that would push the response over it gets tooManyPoints with that
 * limit (HistoryService's response cap, "Too many points in this response.").
 */
function fakeRoute(clock, opts = {}) {
  const calls = [];
  const fn = (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ body, at: clock.now() });
    const step = opts.stepOf || (() => S);
    let used = 0;
    const pens = body.pens.map((p) => {
      const t = [];
      for (let x = Math.ceil(body.start / 1000) * 1000; x <= Math.min(body.end, clock.now()); ) { t.push(x); x += step(x, p.tagPath); }
      if (body.maxPointsPerPen && t.length > body.maxPointsPerPen) return { key: p.key, status: 'tooManyPoints', limit: body.maxPointsPerPen, t: [], v: [] };
      if (opts.responseCap && used + t.length > opts.responseCap) return { key: p.key, status: 'tooManyPoints', limit: opts.responseCap, message: 'Too many points in this response.', t: [], v: [] };
      used += t.length;
      return { key: p.key, tagPath: p.tagPath, status: 'ok', t, v: t.map((x) => x / 1000), anchor: body.includeAnchor ? { t: body.start - 500, v: 1 } : null };
    });
    const json = { v: 2, ok: true, requestId: body.requestId, serverNow: clock.now(),
      window: { start: body.start, end: Math.min(body.end, clock.now()), mode: 'raw', bucketMs: null }, pens };
    return Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(json)) });
  };
  fn.calls = calls;
  return fn;
}
function setup(o = {}) {
  const C = load();
  const clock = fakeClock(o.start || T0 + H);
  const route = fakeRoute(clock, o.route || {});
  const queue = new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers });
  const pens = (o.paths || ['Bulk1']).map((p, i) => ({ key: 'p:' + i, source: 'pens', index: i, tagPath: p, name: p, status: 'ok', meta: null, trendable: true }));
  const ls = [];
  const source = {
    snap: { pens, trend: { group: null, paths: [], max: 32 }, limits: Object.assign({ maxPens: 32, minBucketMs: 100 }, o.limits || {}) },
    state: { connected: true }, staleReason: () => null,
    getCreds: () => ({ url: '/data/simpletagdisplay/v2/history', token: 't', expiresAt: 4102444800000 }),
    renewToken: () => Promise.resolve(true), on(fn) { ls.push(fn); return () => {}; },
  };
  const props = C.reduceProps({
    pens: (o.paths || ['Bulk1']).map((p) => ({ tagPath: p })),
    timeRange: { mode: 'historical', historical: { startDate: T0 - (o.spanMs || 27 * H), endDate: T0 } },
    query: Object.assign({ mode: 'raw', chunking: { enabled: true, rawChunk: 'auto' } }, o.query || {}),
  });
  const doc = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const engine = new C.ChartEngine({ id: 'c1', source, queue, now: clock.now, timers: clock.timers, document: doc, fetch: route, props, timeZone: 'UTC', plotWidth: 1000 });
  return { C, clock, route, engine, source };
}
const plain = (x) => JSON.parse(JSON.stringify(x));          // objects of the vm realm -> this realm (deepEqual)
const contiguous = (pd, step) => Array.from(pd.t).every((x, i, a) => i === 0 || x - a[i - 1] === step);

test('planner: probe = the newest hour slot (widened below 15 min), adaptive widths on the cache geometry', () => {
  const C = load();
  assert.deepEqual(plain(C.probeChunk(T0 - 27 * H, T0)), { start: T0 - H, end: T0 }, 'end on an hour: the previous hour');
  assert.deepEqual(plain(C.probeChunk(T0 - 27 * H, T0 + 40 * M)), { start: T0, end: T0 + 40 * M }, '40 min slot');
  assert.deepEqual(plain(C.probeChunk(T0 - 27 * H, T0 + 5 * M)), { start: T0 - H, end: T0 + 5 * M }, 'a 5 min slot is widened');
  assert.deepEqual(plain(C.probeChunk(T0 - 30 * M, T0)), { start: T0 - 30 * M, end: T0 }, 'a short window is one request');
  // 1 sample/s, cap 100 000, fill 0.8 -> 80 000 s = 22.2 h -> 22 h (1 h unit up to 50 h)
  assert.equal(C.adaptiveChunkWidth([1 / 1000], 100000, 500000, 26 * H), 22 * H);
  // the response cap binds when several pens share a request: 4 pens x 1/s, 500 000 x 0.8 / 4 = 100 000 s
  assert.equal(C.adaptiveChunkWidth([1 / 1000, 1 / 1000, 1 / 1000, 1 / 1000], 250000, 500000, 60 * D), 27 * H);
  // above 50 h the width is a multiple of 6 h, above 300 h of a day
  assert.equal(C.adaptiveChunkWidth([1 / 10000], 100000, 500000, 30 * D) % (6 * H), 0);
  assert.equal(C.adaptiveChunkWidth([1 / 100000], 100000, 500000, 60 * D) % D, 0);
  assert.equal(C.adaptiveChunkWidth([0, 0], 100000, 500000, 26 * H), 26 * H, 'no sample yet: the rest in one request');
  assert.equal(C.adaptiveChunkWidth([1], 100000, 500000, 26 * H), H, 'never below one unit');
  // nextAdaptiveChunk: not wider than the width, edges on the unit, no sliver / tiny remainder
  assert.deepEqual(plain(C.nextAdaptiveChunk(T0 - 27 * H, T0 - 23 * H + 5 * M, 22 * H)), { start: T0 - 27 * H, end: T0 - 23 * H + 5 * M, oldest: true });
  assert.deepEqual(plain(C.nextAdaptiveChunk(T0 - 40 * H, T0 - H, 22 * H)), { start: T0 - 23 * H, end: T0 - H, oldest: false });
  assert.deepEqual(plain(C.nextAdaptiveChunk(T0 - 27 * H, T0 - 23 * H, 22 * H)), { start: T0 - 27 * H, end: T0 - 23 * H, oldest: true });
  const c = C.nextAdaptiveChunk(T0 - 27 * H, T0 - H, 25 * H);
  assert.deepEqual(plain(c), { start: T0 - 27 * H, end: T0 - H, oldest: true }, 'a remainder under 1/4 width joins');
  const u6 = C.nextAdaptiveChunk(T0 - 40 * D, T0 - H, 60 * H);
  assert.equal(u6.start % (6 * H), 0, '6 h unit');
  assert.ok(u6.end - u6.start <= 60 * H && u6.end - u6.start >= 0.75 * 60 * H);
});

test('Bulk1 27 h raw (1/s, cap 100 000) loads in 2 requests instead of 28, contiguous, anchor once', async () => {
  const { route, engine, clock } = setup();
  engine.start();
  await clock.advance(10 * S);
  assert.equal(route.calls.length, 2, JSON.stringify(route.calls.map((c) => [(T0 - c.body.start) / H, (T0 - c.body.end) / H])));
  const spans = route.calls.map((c) => (c.body.end - c.body.start) / H);
  // probe 1 h (3 601 points) -> width 0.8 x 100 000 s = 22 h; the 4 h left after it (< 1/4 of 22 h) joins: 26 h,
  // 93 600 expected points <= the cap
  assert.deepEqual(spans, [1, 26]);
  assert.equal(route.calls[0].body.end, T0, 'newest first');
  assert.equal(route.calls.filter((c) => c.body.includeAnchor).length, 1, 'anchor only on the oldest');
  assert.ok(route.calls.every((c) => c.body.maxPointsPerPen === 100000));
  const pd = engine.penData('p:0');
  assert.equal(pd.t.length, 27 * 3600 + 1, 'inclusive window, no duplicate at the piece edges');
  assert.ok(contiguous(pd, S));
  assert.equal(pd.status, 'ok');
  const m = engine.model();
  assert.equal(m.progress, null);
  assert.equal(engine.coverage.start, T0 - 27 * H);
  assert.equal(m.notices.length, 0);
  engine.dispose();
});

test('sparse data loads in 2 requests; the probe hour is drawn first', async () => {
  const { route, engine, clock } = setup({ route: { stepOf: () => 10 * S } });
  engine.start();
  await clock.advance(10);
  assert.ok(engine.penData('p:0').t.length >= 360, 'probe drawn before the rest arrives');
  await clock.advance(10 * S);
  assert.equal(route.calls.length, 2);
  assert.equal(engine.penData('p:0').t.length, 27 * 360 + 1);
  engine.dispose();
});

test('a pen over the cap still stops at the cap (sum of the pieces); the density is re-measured per piece', async () => {
  // dense only in the older part: the probe (newest hour) is sparse, the next piece is sized on it, the one after on the
  // re-measured density
  const dense = (x) => (x < T0 - 10 * H ? 1000 : 60000);
  const { route, engine, clock } = setup({ route: { stepOf: dense }, query: { maxPointsPerPen: 50000 } });
  engine.start();
  await clock.advance(20 * S);
  const pd = engine.penData('p:0');
  const m = engine.model();
  // 17 h at 1/s = 61 200 > 50 000: tooManyPoints is right, and no request exceeded the cap by more than one piece
  assert.equal(m.pens[0].status, 'tooManyPoints');
  assert.equal(m.pens[0].limit, 50000);
  assert.ok(route.calls.length >= 2 && route.calls.length <= 6, String(route.calls.length));
  assert.ok(pd);
  engine.dispose();
});

test('pens refused for the RESPONSE size get the piece again in halves (no false tooManyPoints)', async () => {
  // a sparse newest hour (1 / 10 s) sizes the next piece for 0.3 samples/s: the 26 h piece then holds 3 x 93 600 points,
  // over the 100 000 response cap -> the gateway refuses the 2nd and 3rd pen -> they get that piece in halves
  const { route, engine, clock } = setup({ paths: ['Bulk1', 'Bulk2', 'Bulk3'], limits: { maxPointsPerResponse: 100000 },
    route: { responseCap: 100000, stepOf: (x) => (x >= T0 - H ? 10 * S : S) }, query: { maxPointsPerPen: 250000 } });
  engine.start();
  await clock.advance(30 * S);
  const m = engine.model();
  assert.deepEqual(m.pens.map((p) => p.status), ['ok', 'ok', 'ok'], JSON.stringify(m.pens.map((p) => [p.status, p.limit])));
  for (const k of ['p:0', 'p:1', 'p:2']) {
    const pd = engine.penData(k);
    assert.equal(pd.t.length, 26 * 3600 + 360 + 1, k);
    const older = Array.from(pd.t).filter((x) => x <= T0 - H);
    assert.ok(older.every((x, i, a) => i === 0 || x - a[i - 1] === S), k + ' contiguous across the split pieces');
  }
  const split = route.calls.filter((c) => c.body.pens.length === 2);
  assert.ok(split.length >= 2, 'the refused pens got the piece again in halves: ' + route.calls.map((c) => c.body.pens.length).join(','));
  assert.ok(split[0].body.start > split[1].body.start, 'newer half first');
  assert.ok(route.calls.length < 28, String(route.calls.length));
  engine.dispose();
});

test('an explicit rawChunk keeps the fixed epoch-aligned chunks', async () => {
  const { route, engine, clock } = setup({ query: { chunking: { enabled: true, rawChunk: '1h' } }, route: { stepOf: () => 10 * S } });
  engine.start();
  await clock.advance(30 * S);
  assert.equal(route.calls.length, 27);
  engine.dispose();
});

test('the client deadline follows limits.historyTimeoutMs (15 s default + 10 s margin)', () => {
  const C = load();
  assert.equal(C.LIMIT_DEFAULTS.historyTimeoutMs, 15000);
  assert.equal(C.effectiveLimits({ historyTimeoutMs: 40000 }).historyTimeoutMs, 40000, 'kept from the snapshot');
  assert.equal(C.effectiveLimits({}).historyTimeoutMs, 15000);
  const mk = (L) => new C.HistoryClient({ source: {}, queue: {}, key: 'k', metrics: {}, limits: () => L });
  assert.equal(mk(C.effectiveLimits({ historyTimeoutMs: 40000 })).timeoutMs(), 50000);
  assert.equal(mk(C.effectiveLimits(null)).timeoutMs(), 25000);
});

test('a window of exactly the cap still loads: the sample on a piece edge (inclusive raw windows) is counted once', async () => {
  const { engine, clock, route } = setup({ query: { maxPointsPerPen: 27 * 3600 + 1 } });
  engine.start();
  await clock.advance(10 * S);
  assert.ok(route.calls.length >= 2, 'more than one piece');
  const m = engine.model();
  assert.equal(m.pens[0].status, 'ok', JSON.stringify([m.pens[0].status, m.pens[0].limit]));
  assert.equal(engine.penData('p:0').t.length, 27 * 3600 + 1);
  engine.dispose();
});

// ---- piece timeouts, refusal kinds and the request burst -------------------------------------------------------------
/** Wraps fakeRoute: `over(body)` true -> the answer for that request is replaced (per-pen timeout or HTTP 504). */
function withTimeouts(clock, opts, over, kind) {
  const base = fakeRoute(clock, opts);
  const fn = (url, init) => {
    const body = JSON.parse(init.body);
    if (!over(body)) return base(url, init);
    base.calls.push({ body, at: clock.now(), timedOut: true });
    if (kind === 'http') {
      return Promise.resolve({ status: 504, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify({ v: 2, ok: false, error: { code: 'TIMEOUT', message: 'history query timed out' } })) });
    }
    const json = { v: 2, ok: true, requestId: body.requestId, serverNow: clock.now(), window: { start: body.start, end: body.end, mode: 'raw', bucketMs: null },
      pens: body.pens.map((p) => ({ key: p.key, status: 'timeout', t: [], v: [] })) };
    return Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(json)) });
  };
  fn.calls = base.calls;
  return fn;
}
function setupWith(o, routeFn) {
  const s = setup(o);
  s.engine.dispose();
  const C = s.C, clock = s.clock;
  const queue = new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers });
  const props = C.reduceProps({
    pens: (o.paths || ['Bulk1']).map((p) => ({ tagPath: p })),
    timeRange: { mode: 'historical', historical: { startDate: T0 - (o.spanMs || 27 * H), endDate: T0 } },
    query: Object.assign({ mode: 'raw', chunking: { enabled: true, rawChunk: 'auto' } }, o.query || {}),
  });
  const route = routeFn(clock);
  const doc = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const engine = new C.ChartEngine({ id: 'c2', source: s.source, queue, now: clock.now, timers: clock.timers, document: doc, fetch: route, props, timeZone: 'UTC', plotWidth: 1000 });
  return { C, clock, route, engine };
}

test('a wide adaptive piece that times out (per pen) is asked again in halves; the pen completes', async () => {
  // sparse probe (1 / 10 s) -> the next piece is the whole 26 h; the gateway times out on anything wider than 8 h
  const { route, engine, clock } = setupWith({ route: {} }, (clk) => withTimeouts(clk, { stepOf: (x) => (x >= T0 - H ? 10 * S : 60 * S) },
    (b) => b.end - b.start > 8 * H, 'pen'));
  engine.start();
  await clock.advance(60 * S);
  const m = engine.model();
  assert.equal(m.pens[0].status, 'ok');
  assert.equal(m.pens[0].incomplete, null, 'not left incomplete');
  assert.equal(engine.coverage.start, T0 - 27 * H);
  const pd = engine.penData('p:0');
  assert.equal(pd.t[0], T0 - 27 * H);
  assert.ok(route.calls.some((c) => c.timedOut), 'a wide piece did time out');
  assert.ok(route.calls.filter((c) => !c.timedOut).every((c) => c.body.end - c.body.start <= 8 * H), 'then only pieces the gateway answers');
  assert.ok(engine.metrics.timeoutSplits >= 1);
  engine.dispose();
});

test('a whole-request timeout (HTTP 504) of a later wide piece is split too; 1 h pieces are not split', async () => {
  const { route, engine, clock } = setupWith({ route: {} }, (clk) => withTimeouts(clk, { stepOf: (x) => (x >= T0 - H ? 10 * S : 60 * S) },
    (b) => b.end - b.start > 8 * H, 'http'));
  engine.start();
  await clock.advance(60 * S);
  const m = engine.model();
  assert.equal(m.pens[0].status, 'ok');
  assert.equal(engine.coverage.start, T0 - 27 * H, 'complete, not "Partially loaded"');
  assert.ok(route.calls.some((c) => c.timedOut));
  engine.dispose();
  const C = load();
  assert.equal(C.timeoutSplittable({ start: 0, end: H, depth: 0 }), false, 'one cache unit');
  assert.equal(C.timeoutSplittable({ start: 0, end: 26 * H, depth: 0 }), true);
  assert.equal(C.timeoutSplittable({ start: 0, end: 26 * H, depth: C.CHUNK.timeoutSplitDepth }), false, 'bounded depth');
  const halves = C.splitPiece({ start: T0 - 26 * H, end: T0, depth: 0 }, ['k']);
  assert.equal(halves[0].end, T0);
  assert.equal(halves[0].start, halves[1].end);
  assert.equal(halves[1].start, T0 - 26 * H);
  assert.equal(halves[0].start % H, 0, 'middle on the cache unit');
});

test('refusal kinds; caps equal -> split (no false tooManyPoints); an unknown limit is split a little, then believed', async () => {
  const C = load();
  assert.equal(C.refusalKind(100000, 100000, 100000), 'response', 'both caps equal: splitting is always correct');
  assert.equal(C.refusalKind(100000, 100000, 500000), 'pen');
  assert.equal(C.refusalKind(500000, 100000, 500000), 'response');
  assert.equal(C.refusalKind(42, 100000, 500000), 'unknown');
  assert.equal(C.refusalKind(null, 100000, 500000), 'pen');
  // maxPointsPerResponse == the per-pen cap: three pens refused for the response size still load completely
  const a = setup({ paths: ['Bulk1', 'Bulk2', 'Bulk3'], limits: { maxPointsPerResponse: 100000 },
    route: { responseCap: 100000, stepOf: (x) => (x >= T0 - H ? 10 * S : S) }, query: { maxPointsPerPen: 100000 } });
  a.engine.start();
  await a.clock.advance(30 * S);
  assert.deepEqual(a.engine.model().pens.map((p) => p.status), ['ok', 'ok', 'ok']);
  a.engine.dispose();
  // a per-pen limit the client does not mirror (stale limits): at most CHUNK.unknownLimitSplitDepth levels, then
  // tooManyPoints with the gateway's limit
  const b = setupWith({ route: {} }, (clk) => {
    const base = fakeRoute(clk, {});
    const fn = (url, init) => base(url, Object.assign({}, init, { body: JSON.stringify(Object.assign(JSON.parse(init.body), { maxPointsPerPen: 100 })) }));
    fn.calls = base.calls;
    return fn;
  });
  b.engine.start();
  await b.clock.advance(30 * S);
  const pen = b.engine.model().pens[0];
  assert.equal(pen.status, 'tooManyPoints');
  assert.equal(pen.limit, 100, "the gateway's limit");
  assert.ok(b.route.calls.length <= 1 + C.CHUNK.unknownLimitSplitDepth, String(b.route.calls.length));
  b.engine.dispose();
});

test('limits.historyBurst is kept; the queue mirrors the gateway bucket (burst, then the refill rate)', async () => {
  const C = load();
  assert.equal(C.LIMIT_DEFAULTS.historyBurst, 1, 'an older gateway: the fixed interval');
  assert.equal(C.effectiveLimits({ historyBurst: 8 }).historyBurst, 8);
  const clock = fakeClock(T0);
  const starts = [];
  const q = new C.HistoryQueue({ maxConcurrent: 16, now: clock.now, timers: clock.timers });
  const run = (burst) => q.run({ key: 'k', priority: 'chunk', spacingMs: 220, burst, exec: () => { starts.push(clock.now() - T0); return Promise.resolve({ ok: true }); } });
  for (let i = 0; i < 10; i++) run(8);
  await clock.advance(2 * S);
  assert.deepEqual(starts, [0, 0, 0, 0, 0, 0, 0, 0, 220, 440]);
  // a 429 empties the mirror: the next start waits one interval
  starts.length = 0;
  await clock.advance(5 * S);                                  // full again
  q.drain('k');
  const t0 = clock.now() - T0;
  run(8);
  await clock.advance(1 * S);
  assert.deepEqual(starts.map((x) => x - t0), [220]);
  // burst 1 = the old spacing between starts
  const q1 = new C.HistoryQueue({ maxConcurrent: 16, now: clock.now, timers: clock.timers });
  const s1 = [];
  const t1 = clock.now();
  for (let i = 0; i < 3; i++) q1.run({ key: 'k', priority: 'chunk', spacingMs: 220, exec: () => { s1.push(clock.now() - t1); return Promise.resolve({ ok: true }); } });
  await clock.advance(1 * S);
  assert.deepEqual(s1, [0, 220, 440]);
  // the client posts with the snapshot's burst
  const seen = [];
  const hc = new C.HistoryClient({ source: {}, key: 'k', metrics: {}, queue: { run: (job) => { seen.push(job.burst); return Promise.resolve({ ok: true }); } },
    limits: () => C.effectiveLimits({ historyBurst: 8, minIntervalMs: 200 }) });
  await hc.post({});
  const hc1 = new C.HistoryClient({ source: {}, key: 'k', metrics: {}, queue: { run: (job) => { seen.push(job.burst); return Promise.resolve({ ok: true }); } },
    limits: () => C.effectiveLimits(null) });
  await hc1.post({});
  assert.deepEqual(seen, [8, 1]);
});
