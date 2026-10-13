// =============================================================================
// chart-plan.test.mjs — windows, bucket ladder and query planning
// =============================================================================
// Checked here:
//   - the client ladder equals the gateway's (parsed from BucketLadder.java),
//     and limits.bucketLadder from the snapshot wins when present;
//   - computeBucket is the same rule as HistoryRequest.computeBucket
//     (nice step >= span/pointCount, widened until the aligned window fits);
//   - pointCount 0 = auto from the plot width; the auto raw/aggregated flip;
//   - configured windows (realtime calendar units, historical defaults,
//     gateway range clamp), chunk plans and the free-range re-query rule.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnv, FILES } from './_stubs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const JAVA_LADDER = path.resolve(here, '..', '..', 'gateway', 'src', 'main', 'java', 'com', 'example', 'simpletagdisplay',
  'gateway', 'history', 'BucketLadder.java');

const S = 1000, M = 60 * S, H = 60 * M, D = 24 * H;

function load() {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  return { NS: env.window.__CTG, C: env.window.__CTG.chart };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

/** STEPS of BucketLadder.java, evaluated (terms like `2 * MINUTE`). */
function javaSteps() {
  const src = readFileSync(JAVA_LADDER, 'utf8');
  const body = /STEPS\s*=\s*\{([\s\S]*?)\};/.exec(src)[1];
  const units = { SECOND: S, MINUTE: M, HOUR: H, DAY: D };
  return body.split(',').map((t) => t.trim()).filter(Boolean).map((t) => {
    let m;
    if ((m = /^(\d+)$/.exec(t))) return Number(m[1]);
    if ((m = /^(\d+)\s*\*\s*(SECOND|MINUTE|HOUR|DAY)$/.exec(t))) return Number(m[1]) * units[m[2]];
    if ((m = /^(SECOND|MINUTE|HOUR|DAY)$/.exec(t))) return units[m[1]];
    throw new Error('unparsed ladder term ' + t);
  });
}

test('ladder parity: client copy == BucketLadder.java STEPS; snapshot limits.bucketLadder wins', () => {
  const { C } = load();
  assert.deepEqual(plain(C.LADDER), javaSteps());
  const L = C.effectiveLimits({ bucketLadder: [1000, 60000, 3600000], minBucketMs: 1000 });
  assert.deepEqual(plain(L.bucketLadder), [1000, 60000, 3600000]);
  assert.equal(C.niceBucket(2000, L.minBucketMs, L.bucketLadder), 60000);
  const bad = C.effectiveLimits({ bucketLadder: [5000, 1000] });
  assert.deepEqual(plain(bad.bucketLadder), javaSteps(), 'a non-ascending ladder is ignored');
  const def = C.effectiveLimits({ maxPens: 32 });
  assert.equal(def.pointCountMax, 5000);
  assert.equal(def.maxRawRangeDays, 31);
});

test('niceBucket / nextBucket follow BucketLadder.niceAtLeast / next', () => {
  const { C } = load();
  assert.equal(C.niceBucket(1, 100), 100);
  assert.equal(C.niceBucket(101, 100), 200);
  assert.equal(C.niceBucket(28800, 100), 30000);
  assert.equal(C.niceBucket(13 * H, 100), D);
  assert.equal(C.niceBucket(D + 1, 100), 2 * D, 'whole days above 1 d');
  assert.equal(C.niceBucket(50, 250), 250, 'minBucketMs');
  assert.equal(C.nextBucket(30000), M);
  assert.equal(C.nextBucket(D), 2 * D);
  assert.equal(C.nextBucket(3 * D), 4 * D);
});

test('computeBucket: span / pointCount rounded up, widened until the aligned window fits', () => {
  const { C } = load();
  const t0 = Date.UTC(2026, 9, 8, 6, 0, 0);
  assert.equal(C.computeBucket(t0, t0 + 8 * H, t0 + 8 * H, 1000, 100, 5000), 30000);
  // exactly 5000 aligned buckets fit 5000 ...
  assert.equal(C.computeBucket(500, 500 + 5000000, 500 + 5000000, 5000, 100, 5000), 1000);
  // ... but not 4999: next step
  assert.equal(C.computeBucket(500, 500 + 5000000, 500 + 5000000, 5000, 100, 4999), 2000);
});

test('planQuery: pointCount 0 = plot width (100..2000); explicit counts clamp to the gateway bounds', () => {
  const { C } = load();
  const L = C.effectiveLimits(null);
  const t0 = Date.UTC(2026, 9, 8, 0, 0, 0);
  const win = { start: t0, end: t0 + 8 * H };
  const p = C.reduceProps({});
  assert.equal(C.planQuery(p, win, 1234, L, win.end).pointCount, 1234);
  assert.equal(C.planQuery(p, win, 40, L, win.end).pointCount, 100);
  assert.equal(C.planQuery(p, win, 9000, L, win.end).pointCount, 2000);
  assert.equal(C.planQuery(p, win, 0, L, win.end).pointCount, 1000, 'unknown width -> 1000');
  const p2 = C.reduceProps({ query: { pointCount: 4000 } });
  assert.equal(C.planQuery(p2, win, 600, L, win.end).pointCount, 4000);
  const L2 = C.effectiveLimits({ pointCountMax: 3000 });
  assert.equal(C.planQuery(p2, win, 600, L2, win.end).pointCount, 3000);
});

test('planQuery: auto mode goes raw below autoRawBelowBucketMs; request fields per mode', () => {
  const { C } = load();
  const L = C.effectiveLimits(null);
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  const p = C.reduceProps({});
  const agg = C.planQuery(p, { start: now - 8 * H, end: now }, 1000, L, now);
  assert.equal(agg.mode, 'aggregated');
  assert.equal(agg.bucketMs, 30000);
  assert.equal(agg.aggregation, 'MinMax');
  assert.equal(agg.onTooManyPoints, 'error');
  const raw = C.planQuery(p, { start: now - 15 * M, end: now }, 1000, L, now);
  assert.equal(raw.mode, 'raw', '15 min / 1000 px -> 1 s buckets < 2 s');
  assert.equal(raw.bucketMs, null);
  assert.equal(raw.maxPointsPerPen, 100000, 'client cap (query.maxPointsPerPen)');
  const capped = C.planQuery(C.reduceProps({ query: { maxPointsPerPen: 2000000 } }), { start: now - 15 * M, end: now }, 1000, L, now);
  assert.equal(capped.maxPointsPerPen, 250000, 'never above the gateway cap');
  const forcedAgg = C.planQuery(C.reduceProps({ query: { mode: 'aggregated' } }), { start: now - 15 * M, end: now }, 1000, L, now);
  assert.equal(forcedAgg.mode, 'aggregated');
  assert.equal(forcedAgg.bucketMs, 1000);
  const off = C.planQuery(C.reduceProps({ query: { autoRawBelowBucketMs: 0 } }), { start: now - 15 * M, end: now }, 1000, L, now);
  assert.equal(off.mode, 'aggregated', 'autoRawBelowBucketMs 0 disables the raw flip');
});

test('planQuery: raw spans over maxRawRangeDays -> error, or planned aggregated (downgraded) with the aggregate fallback', () => {
  const { C } = load();
  const L = C.effectiveLimits(null);
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  const win = { start: now - 40 * D, end: now };
  const e = C.planQuery(C.reduceProps({ query: { mode: 'raw' } }), win, 1000, L, now);
  assert.equal(e.error, 'RAW_RANGE_TOO_LARGE');
  assert.equal(e.days, 31);
  // sent raw it would be chunked into 1-day requests that each pass the gateway's check
  const a = C.planQuery(C.reduceProps({ query: { mode: 'raw', onTooManyPoints: 'aggregate' } }), win, 1000, L, now);
  assert.equal(a.mode, 'aggregated');
  assert.equal(a.downgraded, true);
  assert.equal(a.rawDays, 31);
  assert.ok(a.bucketMs > 0);
  assert.equal(a.onTooManyPoints, 'error');
  // inside the raw limit: still raw with the gateway fallback for the point cap
  const r = C.planQuery(C.reduceProps({ query: { mode: 'raw', onTooManyPoints: 'aggregate' } }), { start: now - 20 * D, end: now }, 1000, L, now);
  assert.equal(r.mode, 'raw');
  assert.equal(r.downgraded, false);
  assert.equal(r.onTooManyPoints, 'aggregate');
});

test('chunkPlan: never more than 50 chunks, an explicit small rawChunk is widened', () => {
  const { C } = load();
  const t0 = Date.UTC(2026, 9, 5, 0, 30, 0);
  const a = C.chunkPlan(t0, t0 + 31 * D, '1h');
  assert.ok(a.chunks.length <= 50, String(a.chunks.length));
  assert.equal(a.chunkMs, D);
  const b = C.chunkPlan(t0, t0 + 120 * D, 'auto');
  assert.ok(b.chunks.length <= 50, String(b.chunks.length));
  assert.equal(b.chunkMs % D, 0);
  assert.equal(b.chunks[0].end, t0 + 120 * D);
  assert.equal(b.chunks[b.chunks.length - 1].start, t0);
  assert.equal(C.chunkPlan(t0, t0 + 10 * H, '1h').chunkMs, H, 'small spans keep the requested width');
});

test('configWindow: realtime calendar units in the zone, historical defaults, gateway clamp', () => {
  const { C } = load();
  const L = C.effectiveLimits(null);
  const now = Date.UTC(2026, 2, 31, 12, 0, 0);
  const month = C.configWindow(C.reduceProps({ timeRange: { realtime: { value: 1, unit: 'months' } } }), now, 'UTC', L, now);
  assert.equal(month.start, Date.UTC(2026, 1, 28, 12, 0, 0), 'Mar 31 - 1 month = Feb 28');
  const h8 = C.configWindow(C.reduceProps({}), now, 'UTC', L, now);
  assert.equal(h8.end - h8.start, 8 * H);
  assert.equal(h8.mode, 'realtime');
  const s1 = C.configWindow(C.reduceProps({ timeRange: { realtime: { value: 1, unit: 'seconds' } } }), now, 'UTC', L, now);
  assert.equal(s1.span, 1000);
  const big = C.configWindow(C.reduceProps({ timeRange: { realtime: { value: 2, unit: 'years' } } }), now, 'UTC', L, now);
  assert.equal(big.span, 400 * D);
  assert.equal(big.clampedDays, 400);
  // historical: null end = load time (never after now), null start = end - 8 h
  const loadTime = now - H;
  const hist = C.configWindow(C.reduceProps({ timeRange: { mode: 'historical' } }), now, 'UTC', L, loadTime);
  assert.deepEqual([hist.start, hist.end], [loadTime - 8 * H, loadTime]);
  const fut = C.configWindow(C.reduceProps({ timeRange: { mode: 'historical', historical: { startDate: now - D, endDate: now + D } } }), now, 'UTC', L, now);
  assert.equal(fut.end, now, 'future end clamped to now');
  const bad = C.configWindow(C.reduceProps({ timeRange: { mode: 'historical', historical: { startDate: now, endDate: now - H } } }), now, 'UTC', L, now);
  assert.equal(bad.error, 'RANGE_INVALID');
});

test('chunkPlan: auto width (1 h / 6 h / 1 d for <= 50 chunks), epoch-aligned, newest first', () => {
  const { C } = load();
  const t0 = Date.UTC(2026, 9, 5, 0, 30, 0);
  const p = C.chunkPlan(t0, t0 + 27 * H, 'auto');
  assert.equal(p.chunkMs, H);
  assert.equal(p.chunks.length, 28, '27 h starting at :30 touches 28 one-hour slots');
  assert.equal(p.chunks[0].end, t0 + 27 * H, 'newest first');
  assert.equal(p.chunks[p.chunks.length - 1].start, t0);
  for (let i = 1; i < p.chunks.length - 1; i++) {
    assert.equal(p.chunks[i].start % H, 0, 'inner boundaries on epoch hours');
    assert.equal(p.chunks[i].end, p.chunks[i - 1].start, 'contiguous');
  }
  assert.equal(C.chunkPlan(t0, t0 + 100 * H, 'auto').chunkMs, 6 * H);
  assert.equal(C.chunkPlan(t0, t0 + 20 * D, 'auto').chunkMs, D);
  assert.equal(C.chunkPlan(t0, t0 + 3 * H, '1d').chunks.length, 1);
  // a sub-second edge piece joins its neighbour (the gateway refuses spans under 1 s)
  const e = C.chunkPlan(Date.UTC(2026, 9, 5, 0, 59, 59, 500), Date.UTC(2026, 9, 5, 3, 0, 0), '1h');
  assert.ok(e.chunks.every((c) => c.end - c.start >= 1000), JSON.stringify(e.chunks));
  assert.equal(e.chunks[e.chunks.length - 1].start, Date.UTC(2026, 9, 5, 0, 59, 59, 500));
});

test('needsRequery: outside the coverage, resolution off by 2x, or the auto raw flip', () => {
  const { C } = load();
  const L = C.effectiveLimits(null);
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  const p = C.reduceProps({});
  const cov = { start: now - 24 * H, end: now, mode: 'aggregated', bucketMs: 2 * M };
  assert.equal(C.needsRequery(now - 20 * H, now - 12 * H, cov, p, 1000, L, now), true, '8 h at 30 s vs 2 min buckets');
  assert.equal(C.needsRequery(now - 20 * H, now, cov, p, 720, L, now), false, 'same resolution, inside (with the 10 % margin)');
  assert.equal(C.needsRequery(now - 23 * H, now, cov, p, 720, L, now), true, 'the 10 % margin leaves the coverage');
  assert.equal(C.needsRequery(now - 30 * H, now - 7 * H, cov, p, 720, L, now), true, 'panned past the loaded data');
  assert.equal(C.needsRequery(now - 10 * M, now, cov, p, 1000, L, now), true, 'zoomed to raw territory');
  assert.equal(C.needsRequery(now - 10 * M, now, null, p, 1000, L, now), true, 'nothing loaded');
});

test('clampSpan: wheel bounds (min max(1 s, 10 x minBucketMs), max the gateway range)', () => {
  const { C } = load();
  const L = C.effectiveLimits(null);
  assert.equal(C.clampSpan(10, 'raw', L), 1000);
  assert.equal(C.clampSpan(1e13, 'raw', L), 31 * D);
  assert.equal(C.clampSpan(1e13, 'aggregated', L), 400 * D);
  assert.equal(C.clampSpan(5 * H, 'aggregated', L), 5 * H);
});
