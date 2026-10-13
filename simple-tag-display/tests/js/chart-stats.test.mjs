// =============================================================================
// chart-stats.test.mjs — window statistics
// =============================================================================
// statsFor() against an independent reference: the pen is a sample-and-hold
// step function; the average is its integral over [a, end] divided by the
// time it had a good value (null = bad quality = excluded), where end is
// min(b, lastKnownTime) (now when following live, else the last sample).
// The value held at `a` takes part (min/max/first), the synthetic "now"
// point never does. Also median, population σ, sum, count, delta, LCL/UCL
// (σ and moving-range methods) and valueAt() for X-Trace.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, FILES } from './_stubs.mjs';

function load() {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  return env.window.__CTG.chart;
}

/** Reference implementation (deliberately different code path: breakpoint integration). */
function reference(t, v, a, b, lastKnownTime) {
  const held = (x) => { let r; for (let i = 0; i < t.length && t[i] <= x; i++) r = v[i]; return r; };
  const inRange = t.map((tt, i) => [tt, v[i]]).filter(([tt]) => tt >= a && tt <= b);
  const before = t.map((tt, i) => [tt, v[i]]).filter(([tt]) => tt < a);
  const hv = before.length ? before[before.length - 1][1] : undefined;
  const lastSample = inRange.length ? inRange[inRange.length - 1][0] : a;
  const end = lastKnownTime != null ? Math.min(b, lastKnownTime) : lastSample;
  const pts = [a, ...inRange.map(([tt]) => tt).filter((tt) => tt > a && tt < end), end].filter((x, i, arr) => i === 0 || x > arr[i - 1]);
  let num = 0, den = 0;
  for (let k = 0; k + 1 < pts.length; k++) {
    const val = held(pts[k]);
    if (typeof val === 'number') { num += val * (pts[k + 1] - pts[k]); den += pts[k + 1] - pts[k]; }
  }
  const good = inRange.map(([, x]) => x).filter((x) => typeof x === 'number');
  const mm = typeof hv === 'number' ? [hv, ...good] : good;
  const mean = good.length ? good.reduce((s, x) => s + x, 0) / good.length : null;
  return {
    // no duration at all (a single instant): the plain mean of the values there (documented fallback)
    average: den > 0 ? num / den : (mm.length ? mm.reduce((s2, x2) => s2 + x2, 0) / mm.length : null),
    minimum: mm.length ? Math.min(...mm) : null,
    maximum: mm.length ? Math.max(...mm) : null,
    count: good.length,
    sum: good.length ? good.reduce((s, x) => s + x, 0) : null,
    sd: good.length ? Math.sqrt(good.reduce((s, x) => s + (x - mean) ** 2, 0) / good.length) : null,
  };
}
const close = (a, b) => (a === null || b === null ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));

test('time-weighted average, min/max with the held value, count/sum/σ match the reference', () => {
  const C = load();
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let run = 0; run < 200; run++) {
    const t = [], v = [];
    let x = Math.floor(rnd() * 1000);
    const n = 1 + Math.floor(rnd() * 60);
    for (let i = 0; i < n; i++) { x += 1 + Math.floor(rnd() * 900); t.push(x); v.push(rnd() < 0.1 ? null : Math.round(rnd() * 2000 - 1000) / 7); }
    const a = Math.floor(rnd() * x), b = a + Math.floor(rnd() * (x - a + 2000));
    const lk = rnd() < 0.5 ? null : b + Math.floor(rnd() * 500) - 250;
    const got = C.statsFor({ t, v }, a, b, { lastKnownTime: lk });
    const ref = reference(t, v, a, b, lk);
    for (const k of ['average', 'minimum', 'maximum', 'sum']) {
      assert.ok(close(got[k], ref[k]), `run ${run} ${k}: ${got[k]} vs ${ref[k]}`);
    }
    assert.equal(got.count, ref.count, `run ${run} count`);
    assert.ok(close(got.standardDeviation, ref.sd), `run ${run} sd`);
  }
});

test('held value at a: sample-and-hold boundary (first, min/max, average)', () => {
  const C = load();
  const view = { t: [0, 100, 200], v: [10, 20, 30] };
  const s = C.statsFor(view, 50, 150, { lastKnownTime: 150 });
  assert.equal(s.first, 10, 'value held at a');
  assert.equal(s.last, 20);
  assert.equal(s.delta, 10);
  assert.equal(s.minimum, 10);
  assert.equal(s.maximum, 20);
  assert.equal(s.count, 1, 'count = in-range real samples');
  assert.equal(s.average, (10 * 50 + 20 * 50) / 100);
});

test('a bad-quality sample ends its segment and leaves the denominator', () => {
  const C = load();
  const s = C.statsFor({ t: [0, 10, 20, 30], v: [1, null, 3, 3] }, 0, 30, {});
  assert.equal(s.average, (1 * 10 + 3 * 10) / 20);
  assert.equal(s.count, 3);
});

test('median, population σ, sum and control limits (σ and moving range)', () => {
  const C = load();
  const view = { t: [1, 2, 3, 4, 5], v: [2, 4, 4, 4, 6] };
  const s = C.statsFor(view, 1, 5, { median: true, sigma: 3 });
  assert.equal(s.median, 4);
  assert.equal(s.sum, 20);
  assert.ok(close(s.standardDeviation, Math.sqrt(8 / 5)));
  assert.ok(close(s.lcl, 4 - 3 * Math.sqrt(8 / 5)));
  assert.ok(close(s.ucl, 4 + 3 * Math.sqrt(8 / 5)));
  const mr = C.statsFor(view, 1, 5, { method: 'movingRange', sigma: 3 });
  const mrBar = (2 + 0 + 0 + 2) / 4;
  assert.ok(close(mr.ucl, 4 + 3 * mrBar / 1.128));
  const even = C.statsFor({ t: [1, 2, 3, 4], v: [1, 9, 3, 7] }, 1, 4, { median: true });
  assert.equal(even.median, 5);
  assert.equal(C.statsFor(view, 1, 5, { median: false }).median, null, 'median only on demand');
});

test('empty window: nulls, count 0; an approx flag passes through (aggregated data)', () => {
  const C = load();
  const s = C.statsFor({ t: [], v: [] }, 0, 10, { approx: true });
  assert.equal(s.count, 0);
  assert.equal(s.average, null);
  assert.equal(s.approx, true);
  assert.equal(C.statsFor({ t: [5], v: [1] }, 10, 0).count, 0, 'b < a');
});

test('valueAt: linear between good neighbours, held for step, nearest within tolerance, — outside', () => {
  const C = load();
  const view = { t: [0, 10, 20, 30], v: [0, 10, null, 30] };
  assert.equal(C.valueAt(view, 5, 'linear'), 5);
  assert.equal(C.valueAt(view, 10, 'linear'), 10);
  assert.equal(C.valueAt(view, 15, 'linear'), undefined, 'not across a bad-quality sample');
  assert.equal(C.valueAt(view, 25, 'linear'), null, 'inside a bad run');
  assert.equal(C.valueAt(view, 15, 'step'), 10);
  assert.equal(C.valueAt(view, 31, 'linear'), undefined, 'after the last sample');
  assert.equal(C.valueAt(view, -1, 'step'), undefined);
  assert.equal(C.valueAt(view, 12, 'nearest', 3), 10);
  assert.equal(C.valueAt(view, 15, 'nearest', 3), undefined);
  assert.equal(C.heldAt(view, 29), null);
  assert.equal(C.heldAt(view, 30), 30);
});

// ---- range brush statistics --------------------------------------------------------------------------------------------
test('brush stats: First/Last/Delta/Median/σ/Sum/LCL/UCL (both methods, any sigma) match an independent computation', () => {
  const C = load();
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let run = 0; run < 150; run++) {
    const t = [], v = [];
    let x = 0;
    const n = 2 + Math.floor(rnd() * 80);
    for (let i = 0; i < n; i++) { x += 1 + Math.floor(rnd() * 500); t.push(x); v.push(rnd() < 0.08 ? null : Math.round(rnd() * 1000 - 300) / 3); }
    const a = Math.floor(rnd() * x * 0.5), b = a + Math.floor(rnd() * x * 0.6) + 1;
    const sigma = [0.5, 1, 2, 3, 4.5, 6][run % 6];
    const inR = t.map((tt, i) => [tt, v[i]]).filter(([tt, vv]) => tt >= a && tt <= b && typeof vv === 'number').map(([, vv]) => vv);
    const before = t.map((tt, i) => [tt, v[i]]).filter(([tt]) => tt < a);
    const allIn = t.map((tt, i) => [tt, v[i]]).filter(([tt]) => tt >= a && tt <= b);
    const held = before.length ? before[before.length - 1][1] : undefined;
    const firstRef = before.length ? (typeof held === 'number' ? held : null) : (allIn.length && typeof allIn[0][1] === 'number' ? allIn[0][1] : null);
    const lastRaw = allIn.length ? allIn[allIn.length - 1][1] : held;
    const lastRef = typeof lastRaw === 'number' ? lastRaw : null;
    for (const method of ['stdDev', 'movingRange']) {
      const s = C.statsFor({ t, v }, a, b, { median: true, sigma, method });
      assert.equal(s.count, inR.length);
      assert.equal(s.first, firstRef, `run ${run} first`);
      assert.equal(s.last, lastRef, `run ${run} last`);
      assert.equal(s.delta, firstRef != null && lastRef != null ? lastRef - firstRef : null);
      if (!inR.length) { assert.equal(s.median, null); assert.equal(s.lcl, null); continue; }
      const mean = inR.reduce((p, c) => p + c, 0) / inR.length;
      const sd = Math.sqrt(inR.reduce((p, c) => p + (c - mean) ** 2, 0) / inR.length);
      const sorted = inR.slice().sort((p, q) => p - q);
      const med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
      let mr = 0;
      for (let i = 1; i < inR.length; i++) mr += Math.abs(inR[i] - inR[i - 1]);
      const spread = method === 'stdDev' ? sd : (inR.length > 1 ? mr / (inR.length - 1) / 1.128 : 0);
      assert.ok(close(s.median, med), `run ${run} median`);
      assert.ok(close(s.sum, inR.reduce((p, c) => p + c, 0)), `run ${run} sum`);
      assert.ok(close(s.standardDeviation, sd), `run ${run} sd`);
      assert.ok(close(s.lcl, mean - sigma * spread), `run ${run} ${method} lcl`);
      assert.ok(close(s.ucl, mean + sigma * spread), `run ${run} ${method} ucl`);
    }
  }
});
