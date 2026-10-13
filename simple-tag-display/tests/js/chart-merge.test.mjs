// =============================================================================
// chart-merge.test.mjs — series store, draw-time views and the uPlot merge
// =============================================================================
// Checked here:
//   - `undefined` = "no sample at this x" (the line connects), `null` = bad
//     quality (a gap): never mixed up by the merge;
//   - aggregated rows are stamped with their bucket start; LastValue is drawn
//     at the bucket end, other aggregates at the middle; MinMax pairs share a
//     stamp and the second row is drawn +1 ms;
//   - the PlotJoin fast path (append + left trim) always equals a full join;
//   - incremental ticks: replaceFrom, strictly newer appends, trim with the
//     last sample before the window kept; live buffer vs history.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, FILES } from './_stubs.mjs';

function load() {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  return { NS: env.window.__CTG, C: env.window.__CTG.chart };
}
const plain = (x) => JSON.parse(JSON.stringify(x, (k, v) => (v === undefined ? '<u>' : v)));
const U = '<u>';

function view(t, v, base = 0) { return { t, v, base }; }

test('join: undefined where a pen has no sample, null kept for bad quality, equal t collapse', () => {
  const { C } = load();
  const j = C.joinViews([view([1, 2, 4], [10, null, 40]), view([2, 3, 4], [200, 300, null])]);
  assert.deepEqual(plain(j.x), [1, 2, 3, 4]);
  assert.deepEqual(plain(j.ys[0]), [10, null, U, 40]);
  assert.deepEqual(plain(j.ys[1]), [U, 200, 300, null]);
});

test('join: k-way merge of many pens equals a sort-based reference', () => {
  const { C } = load();
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const views = [];
  for (let p = 0; p < 9; p++) {
    const t = []; let x = 0;
    for (let i = 0; i < 300; i++) { x += 1 + Math.floor(rnd() * 5); t.push(x); }
    views.push(view(t, t.map((tt) => (rnd() < 0.05 ? null : tt * (p + 1)))));
  }
  const j = C.joinViews(views);
  const all = [...new Set(views.flatMap((v) => v.t))].sort((a, b) => a - b);
  assert.deepEqual(plain(j.x), all);
  views.forEach((v, p) => {
    const m = new Map(v.t.map((tt, i) => [tt, v.v[i]]));
    assert.deepEqual(plain(j.ys[p]), plain(all.map((tt) => (m.has(tt) ? m.get(tt) : undefined))));
  });
});

function store(C) { return new C.SeriesStore({}); }
const WIN_RAW = { start: 0, end: 100000, mode: 'raw', bucketMs: null, bucketTime: null, aggregation: null, downgraded: false };

test('penView: MinMax pairs +1 ms at mid-bucket, LastValue at bucket end, raw unshifted', () => {
  const { C } = load();
  const s = store(C);
  const winAgg = (agg) => ({ start: 0, end: 30000, mode: 'aggregated', bucketMs: 10000, bucketTime: 'start', aggregation: agg, downgraded: false });
  s.ensure('a|MinMax', 'A', 'MinMax');
  s.applyFull('a|MinMax', { status: 'ok', shape: 'minmax', aggregation: 'MinMax', t: [0, 0, 10000, 10000], v: [1, 5, 2, 6] }, winAgg('MinMax'));
  const mm = C.penView(s.get('a|MinMax'), {});
  assert.deepEqual(plain(mm.t), [5000, 5001, 15000, 15001]);
  assert.deepEqual(plain(mm.v), [1, 5, 2, 6]);
  s.ensure('a|LastValue', 'A', 'LastValue');
  s.applyFull('a|LastValue', { status: 'ok', aggregation: 'LastValue', t: [0, 10000], v: [1, 2] }, winAgg('LastValue'));
  assert.deepEqual(plain(C.penView(s.get('a|LastValue'), {}).t), [10000, 20000]);
  C.BUCKET_ALIGN.mode = 'start';
  s.get('a|LastValue').rev++;                       // knob change: drop the cached view
  assert.deepEqual(plain(C.penView(s.get('a|LastValue'), {}).t), [0, 10000]);
  C.BUCKET_ALIGN.mode = 'auto';
  s.ensure('r|raw', 'R', 'MinMax');
  s.applyFull('r|raw', { status: 'ok', t: [1, 2, 3], v: [1, 2, 3] }, WIN_RAW);
  assert.deepEqual(plain(C.penView(s.get('r|raw'), {}).t), [1, 2, 3]);
});

test('penView: anchor first, live buffer only when asked, gap breaks insert a null midway', () => {
  const { C } = load();
  const s = store(C);
  s.ensure('k', 'A', 'LastValue');
  s.applyFull('k', { status: 'ok', t: [1000, 2000, 9000], v: [1, 2, 9], anchor: { t: 500, v: 0.5 } }, WIN_RAW);
  s.addLive('k', { v: 10, q: { level: 'good' }, t: 9500 });
  s.addLive('k', { v: 11, q: { level: 'bad' }, t: 9800 });
  s.addLive('k', { v: 1, q: { level: 'good' }, t: 8000 });      // older than the history: not drawn as live
  const pd = s.get('k');
  assert.deepEqual(plain(C.penView(pd, {}).t), [500, 1000, 2000, 9000]);
  const lv = C.penView(pd, { live: true });
  assert.deepEqual(plain(lv.t), [500, 1000, 2000, 9000, 9500, 9800]);
  assert.deepEqual(plain(lv.v), [0.5, 1, 2, 9, 10, null], 'bad live quality -> null gap');
  assert.equal(pd.liveLatest.v, 1, 'latest value is the last push regardless of time order');
  const g = C.penView(pd, { breakOnGapMs: 3000 });
  assert.deepEqual(plain(g.t), [500, 1000, 2000, 5500, 9000]);
  assert.deepEqual(plain(g.v), [0.5, 1, 2, null, 9]);
});

test('store: incremental raw appends strictly newer samples; aggregated replaces from replaceFrom', () => {
  const { C } = load();
  const s = store(C);
  s.ensure('r', 'A', 'MinMax');
  s.applyFull('r', { status: 'ok', t: [1, 2, 3], v: [1, 2, 3] }, WIN_RAW);
  const base = s.get('r').baseRev;
  s.applyIncremental('r', { status: 'ok', t: [3, 4, 5], v: [3, 4, 5], replaceFrom: null }, { end: 6 });
  assert.deepEqual(plain(s.get('r').t), [1, 2, 3, 4, 5]);
  assert.equal(s.get('r').lastHistT, 5);
  assert.equal(s.get('r').baseRev, base, 'a pure append keeps the base revision (fast join)');
  const winAgg = { start: 0, end: 40000, mode: 'aggregated', bucketMs: 10000, bucketTime: 'start', aggregation: 'MinMax' };
  s.ensure('m', 'B', 'MinMax');
  s.applyFull('m', { status: 'ok', shape: 'minmax', t: [0, 0, 10000, 10000, 20000, 20000], v: [1, 2, 3, 4, 5, 6] }, winAgg);
  const b2 = s.get('m').baseRev;
  s.applyIncremental('m', { status: 'ok', shape: 'minmax', replaceFrom: 10000, t: [10000, 10000, 20000, 20000, 30000, 30000],
    v: [3, 4.5, 5, 7, 8, 9] }, { end: 40000, bucketMs: 10000 });
  assert.deepEqual(plain(s.get('m').t), [0, 0, 10000, 10000, 20000, 20000, 30000, 30000]);
  assert.deepEqual(plain(s.get('m').v), [1, 2, 3, 4.5, 5, 7, 8, 9]);
  assert.notEqual(s.get('m').baseRev, b2, 'a replaced tail is structural');
  assert.equal(s.get('m').histEnd, 40000, 'aggregated history covers up to the coverage end');
});

test('store: trim keeps the last sample before the window and drops the anchor', () => {
  const { C } = load();
  const s = store(C);
  s.ensure('k', 'A', 'x');
  s.applyFull('k', { status: 'ok', t: [10, 20, 30, 40, 50], v: [1, 2, 3, 4, 5], anchor: { t: 5, v: 0 } }, WIN_RAW);
  s.trim('k', 35);
  assert.deepEqual(plain(s.get('k').t), [30, 40, 50]);
  assert.equal(s.get('k').anchor, null);
  s.trim('k', 10);
  assert.deepEqual(plain(s.get('k').t), [30, 40, 50], 'nothing before the window: unchanged');
  // MinMax: the kept bucket keeps both of its rows
  s.ensure('m', 'B', 'MinMax');
  s.applyFull('m', { status: 'ok', shape: 'minmax', t: [0, 0, 10, 10, 20, 20], v: [1, 2, 3, 4, 5, 6] },
    { start: 0, end: 30, mode: 'aggregated', bucketMs: 10, bucketTime: 'start', aggregation: 'MinMax' });
  // by DRAW time: the MinMax buckets are drawn at their middle (5/6, 15/16, 25/26), so the bucket at
  // 0 is the last one drawn before 15 and stays (with both rows); at 21 the bucket at 10 (drawn 15/16) is that one
  s.trim('m', 15);
  assert.deepEqual(plain(s.get('m').t), [0, 0, 10, 10, 20, 20]);
  s.trim('m', 21);
  assert.deepEqual(plain(s.get('m').t), [10, 10, 20, 20]);
});

test('store: live points interleaving with history make the change structural (no stale fast join)', () => {
  const { C } = load();
  const s = store(C);
  s.ensure('k', 'A', 'x');
  s.applyFull('k', { status: 'ok', t: [1000, 2000], v: [1, 2] }, WIN_RAW);
  s.addLive('k', { v: 3, t: 3000 });
  s.addLive('k', { v: 4, t: 4000 });
  let base = s.get('k').baseRev;
  // history repeats the live samples exactly: still an append
  s.applyIncremental('k', { status: 'ok', t: [3000], v: [3] }, { end: 3500 });
  assert.equal(s.get('k').baseRev, base);
  assert.deepEqual(plain(s.get('k').live.t), [4000], 'live points now in history are pruned');
  // history brings a sample the pushes missed (3500 < live 4000): structural
  base = s.get('k').baseRev;
  s.applyIncremental('k', { status: 'ok', t: [3500, 4000], v: [3.5, 4] }, { end: 4000 });
  assert.notEqual(s.get('k').baseRev, base);
});

test('PlotJoin: fast appends + left trims always equal a full join; synthetic now point is removed again', () => {
  const { C } = load();
  const s = store(C);
  ['a', 'b'].forEach((k) => s.ensure(k, k, 'x'));
  s.applyFull('a', { status: 'ok', t: [0, 1000, 2000], v: [0, 1, 2] }, WIN_RAW);
  s.applyFull('b', { status: 'ok', t: [500, 2000], v: [5, 20] }, WIN_RAW);
  const pj = new C.PlotJoin();
  const views = () => [C.penView(s.get('a'), { live: true }), C.penView(s.get('b'), { live: true })];
  let r = pj.update(views(), 'sig', { t: 2500, values: [2, undefined] });
  assert.equal(r.synthetic, r.x.length - 1);
  assert.equal(r.x[r.x.length - 1], 2500);
  let t = 2000;
  for (let i = 0; i < 40; i++) {
    t += 700;
    s.applyIncremental('a', { status: 'ok', t: [t], v: [i] }, { end: t });
    if (i % 3 === 0) s.applyIncremental('b', { status: 'ok', t: [t], v: [-i] }, { end: t });
    if (i % 5 === 4) { s.trim('a', t - 6000); s.trim('b', t - 6000); }
    r = pj.update(views(), 'sig', i % 2 ? { t: t + 300, values: [i, undefined] } : null);
    const full = C.joinViews(views());
    const xs = r.synthetic >= 0 ? r.x.slice(0, r.synthetic) : r.x;
    assert.deepEqual(plain(xs), plain(full.x), `tick ${i}`);
    full.ys.forEach((col, c) => assert.deepEqual(plain(r.ys[c].slice(0, xs.length)), plain(col)));
  }
  assert.ok(pj.fastJoins >= 30, `fast path used (${pj.fastJoins} fast / ${pj.fullJoins} full)`);
  // a structural change (replaced history) falls back to a full join
  const before = pj.fullJoins;
  s.applyFull('a', { status: 'ok', t: [t - 1000, t], v: [1, 2] }, WIN_RAW);
  pj.update(views(), 'sig', null);
  assert.equal(pj.fullJoins, before + 1);
});
