// =============================================================================
// chart-nohistory-live.test.mjs — live "Current" values for noHistory pens
// =============================================================================
//   The gateway sends chart.values for pens whose published status is
//   noHistory as well as ok. The engine keeps no data key for such a
//   pen (nothing stored, drawn or requested from history); the pen table's
//   "Current" column shows the delegate's latest value while following live.
// Helpers are a copy of chart-engine-load-retry.test.mjs's fakes (fake clock,
// fake /v2/history, fake delegate with a `values` map like
// CtgChartDelegateClient).
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
function penInfo(i, tagPath) {
  return { key: 'p:' + i, source: 'pens', index: i, tagPath, name: tagPath.split('/').pop(), status: 'ok', meta: null, trendable: true };
}
function fakeSource(pens) {
  const ls = [];
  return {
    snap: { pens, trend: { group: null, paths: [], max: 32 }, limits: { maxPens: 32, minBucketMs: 100, maxConcurrentPerSession: 4 } },
    creds: { url: '/data/simpletagdisplay/v2/history', token: 'tok-1', expiresAt: 4102444800000 },
    values: {},
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

function nhInfo(i, tagPath, status) {
  return { key: 'p:' + i, source: 'pens', index: i, tagPath, name: tagPath.split('/').pop(), status, meta: null, trendable: false };
}
const TWO = { pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/NoHistory' }],
  timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 1000 } };
function push(source, key, val) { source.values[key] = val; source.emit('values', { [key]: val }); }

test('noHistory pen: live value shown as Current, never requested from history, nothing stored', async () => {
  const { engine, route, clock, source } = setup({ props: TWO,
    pens: [penInfo(0, '[default]CTG/Temp'), nhInfo(1, '[default]CTG/NoHistory', 'noHistory')] });
  let changes = 0;
  const changed0 = engine.changed; engine.changed = function () { changes++; return changed0.apply(this, arguments); };
  engine.start();
  await clock.advance(3 * S);
  assert.equal(engine.current('p:1'), null, 'no value yet');
  const c0 = changes;
  push(source, 'p:1', { v: 12.34, q: { level: 'good', name: 'Good' }, t: clock.now() });
  await clock.advance(50);
  const cur = engine.current('p:1');
  assert.equal(cur.v, 12.34);
  assert.equal(cur.label, 'current');
  assert.ok(changes > c0, 'a value for the noHistory pen re-renders');
  push(source, 'p:1', { v: 13.5, q: { level: 'good' }, t: clock.now() });
  assert.equal(engine.current('p:1').v, 13.5, 'latest value wins');
  await clock.advance(5 * S);
  const sent = route.calls.flatMap((c) => c.body.pens.map((p) => p.tagPath));
  assert.ok(sent.length > 0 && sent.every((t) => t === '[default]CTG/Temp'), 'history only for Temp: ' + [...new Set(sent)]);
  assert.equal(engine.penData('p:1'), null, 'no series data for the noHistory pen');
  engine.dispose();
});

test('noHistory pen: bad quality / non-finite -> null value; boolean -> 1/0', async () => {
  const { engine, clock, source } = setup({ props: TWO,
    pens: [penInfo(0, '[default]CTG/Temp'), nhInfo(1, '[default]CTG/NoHistory', 'noHistory')] });
  engine.start();
  await clock.advance(2 * S);
  push(source, 'p:1', { v: 5, q: { level: 'bad', name: 'Bad' }, t: clock.now() });
  assert.equal(engine.current('p:1').v, null);
  assert.equal(engine.current('p:1').q.level, 'bad', 'quality kept for the status/styling');
  push(source, 'p:1', { v: 'x', q: { level: 'good' }, t: clock.now() });
  assert.equal(engine.current('p:1').v, null);
  push(source, 'p:1', { v: true, q: null, t: clock.now() });
  assert.equal(engine.current('p:1').v, 1);
  engine.dispose();
});

test('noHistory pen: no live value when not following live; other faulted pens never show one', async () => {
  const { engine, clock, source } = setup({ props: TWO,
    pens: [penInfo(0, '[default]CTG/Temp'), nhInfo(1, '[default]CTG/NoHistory', 'noHistory'), nhInfo(2, '[default]CTG/Nope', 'notFound')] });
  engine.start();
  await clock.advance(2 * S);
  push(source, 'p:1', { v: 1.5, q: { level: 'good' }, t: clock.now() });
  push(source, 'p:2', { v: 9, q: { level: 'good' }, t: clock.now() });
  assert.equal(engine.current('p:1').v, 1.5);
  assert.equal(engine.current('p:2'), null, 'notFound pen: no live value');
  engine.vp.followLive = false;                                   // paused / zoomed away from the live edge
  assert.equal(engine.current('p:1'), null, 'the live value is not the value at the view end');
  engine.dispose();
});
