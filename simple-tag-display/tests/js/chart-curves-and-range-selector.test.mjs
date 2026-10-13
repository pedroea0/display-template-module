// =============================================================================
// chart-curves-and-range-selector.test.mjs — curve types, per-state pen styles, range selector
// =============================================================================
// Pure parts are tested directly through NS.chart (curve state machines, state
// resolution, gradient stops, Boolean runs, strip geometry and keys); the overview
// request runs the real ChartEngine against a fake history route and a manual clock
// (the chart-live-view-and-export scaffold); the editor model through NS.chartPanels.
// Run: node --test "simple-tag-display/tests/js/*.test.mjs"
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnv, FILES } from './_stubs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(path.resolve(here, '..', '..', 'common', 'src', 'main', 'resources', 'schemas', 'ctgchart.props.json'), 'utf8'));
const S = 1000, M = 60 * S, H = 60 * M;
const T0 = Date.UTC(2026, 9, 11, 12, 0, 0);
const plain = (x) => JSON.parse(JSON.stringify(x));

function load() {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  return { env, NS: env.window.__CTG, C: env.window.__CTG.chart, P: env.window.__CTG.chartPanels };
}
async function flush(n = 30) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }

/** A recording drawing context: [['M', x, y] | ['L', x, y] | ['C', x1, y1, x2, y2, x, y]]. */
function recorder() {
  const ops = [];
  return {
    ops,
    moveTo(x, y) { ops.push(['M', x, y]); },
    lineTo(x, y) { ops.push(['L', x, y]); },
    bezierCurveTo(a, b, c, d, x, y) { ops.push(['C', a, b, c, d, x, y]); },
  };
}
/** Draws points [[x, y]…] as `kind` (identity pixel mapping). */
function draw(C, kind, pts, spanGaps = false) {
  const r = recorder();
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const runs = C.drawCurve(kind, r, xs, ys, 0, xs.length - 1, (x) => x, (y) => y, spanGaps, null);
  return { ops: r.ops, runs };
}
/** End points of every drawing op (where the pen is after it). */
const ends = (ops) => ops.map((o) => [o[o.length - 2], o[o.length - 1]]);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const PTS = [[0, 0], [10, 8], [20, 2], [30, 9], [40, 4]];

// ---- curve types -----------------------------------------------------------------------------------------------------

test('curve types: the schema enum, the reducer mirror and the editor list are the same 14 names (13 Power Chart curves + spline)', () => {
  const { C, P } = load();
  const pens = SCHEMA.properties.pens.items.properties.display.properties.interpolation.enum;
  assert.equal(pens.length, 14);
  assert.deepEqual(pens, plain(C.INTERPOLATIONS));
  assert.deepEqual(SCHEMA.properties.trendPens.properties.defaults.properties.display.properties.interpolation.enum, pens);
  assert.deepEqual(SCHEMA.properties.trendPens.properties.overrides.items.properties.display.properties.interpolation.enum, pens);
  assert.deepEqual(plain(P.INTERPOLATIONS).sort(), pens.slice().sort(), 'the pen editor offers every curve');
  // every Power Chart curve has a builder: uPlot's (linear, spline, stepAfter / stepBefore) or a d3 port
  const pc = { curveBasis: 'basis', curveBasisOpen: 'basisOpen', curveCardinal: 'cardinal', curveCardinalOpen: 'cardinalOpen',
    curveCatmullRom: 'catmullRom', curveCatmullRomOpen: 'catmullRomOpen', curveLinear: 'linear', curveMonotoneX: 'monotoneX',
    curveMonotoneY: 'monotoneY', curveNatural: 'natural', curveStep: 'stepCenter', curveStepAfter: 'stepAfter', curveStepBefore: 'stepBefore' };
  assert.equal(Object.keys(pc).length, 13);
  Object.values(pc).forEach((k) => {
    assert.ok(pens.includes(k), k);
    assert.ok(k === 'stepAfter' || k === 'stepBefore' || typeof C.CURVES[k] === 'function', 'builder for ' + k);
  });
});

test('linear / stepCenter geometry; reduceProps keeps every curve and drops unknown names', () => {
  const { C } = load();
  assert.deepEqual(draw(C, 'linear', [[0, 0], [10, 10], [20, 0]]).ops, [['M', 0, 0], ['L', 10, 10], ['L', 20, 0]]);
  // curveStep: the value changes half-way between two samples
  assert.deepEqual(draw(C, 'stepCenter', [[0, 0], [10, 10], [30, 4]]).ops,
    [['M', 0, 0], ['L', 5, 0], ['L', 5, 10], ['L', 20, 10], ['L', 20, 4], ['L', 30, 4]]);
  C.INTERPOLATIONS.forEach((k) => {
    assert.equal(C.reduceProps({ pens: [{ tagPath: 'x', display: { interpolation: k } }] }).pens[0].display.interpolation, k);
  });
  assert.equal(C.reduceProps({ pens: [{ tagPath: 'x', display: { interpolation: 'curveBasis' } }] }).pens[0].display.interpolation, 'linear');
});

test('interpolating curves pass through every sample; basis only through the ends; open variants leave the end segments out', () => {
  const { C } = load();
  for (const k of ['cardinal', 'catmullRom', 'monotoneX', 'natural', 'monotoneY']) {
    const { ops } = draw(C, k, PTS);
    assert.equal(ops[0][0], 'M', k);
    const at = ends(ops);
    PTS.forEach((p) => assert.ok(at.some((e) => near(e[0], p[0], 1e-6) && near(e[1], p[1], 1e-6)), k + ' passes through ' + p));
    assert.ok(ops.slice(1).every((o) => o[0] === 'C'), k + ' is made of cubic segments');
  }
  // basis: starts at the first point, ends at the last, misses the interior samples
  const b = draw(C, 'basis', PTS).ops;
  assert.deepEqual(b[0], ['M', 0, 0]);
  assert.deepEqual(ends(b).pop(), [40, 4]);
  assert.ok(!ends(b).some((e) => near(e[0], 10) && near(e[1], 8)), 'B-spline approximates, it does not interpolate');
  // basisOpen starts at (p0 + 4 p1 + p2) / 6; cardinalOpen / catmullRomOpen draw p1 .. p(n-2)
  const bo = draw(C, 'basisOpen', PTS).ops;
  assert.equal(bo[0][0], 'M');
  assert.ok(near(bo[0][1], (0 + 40 + 20) / 6) && near(bo[0][2], (0 + 32 + 2) / 6));
  for (const k of ['cardinalOpen', 'catmullRomOpen']) {
    const o = draw(C, k, PTS).ops;
    assert.deepEqual(o[0], ['M', 10, 8], k);
    assert.deepEqual(ends(o).pop(), [30, 9], k);
    assert.equal(o.length, 1 + 2, k + ': segments p1-p2 and p2-p3');
  }
  // two points: every interpolating curve is a straight line
  for (const k of ['cardinal', 'catmullRom', 'monotoneX', 'natural', 'basis']) {
    assert.deepEqual(draw(C, k, [[0, 0], [10, 5]]).ops, [['M', 0, 0], ['L', 10, 5]], k);
  }
});

test('d3 parity: cardinal(0) = uniform Catmull-Rom tangents; centripetal Catmull-Rom equals it for equal chords; natural spline controls', () => {
  const { C } = load();
  // equal chord lengths (all sqrt(2) * 10): centripetal Catmull-Rom reduces to the uniform one = cardinal tension 0
  const zig = [[0, 0], [10, 10], [20, 0], [30, 10], [40, 0]];
  const ca = draw(C, 'cardinal', zig).ops, cr = draw(C, 'catmullRom', zig).ops;
  assert.equal(ca.length, cr.length);
  ca.forEach((o, i) => o.slice(1).forEach((v, j) => assert.ok(near(v, cr[i][j + 1], 1e-9), `op ${i}.${j}: ${v} vs ${cr[i][j + 1]}`)));
  // interior segment p1 -> p2: control points p1 + (p2 - p0) / 6 and p2 - (p3 - p1) / 6
  const seg = ca[2];
  const r9 = (a) => a.map((v) => (typeof v === 'number' ? +v.toFixed(9) : v));
  assert.deepEqual(r9(seg), r9(['C', 10 + 20 / 6, 10, 20 - 20 / 6, 0, 20, 0]));
  // natural cubic spline over uniformly spaced x: the x controls sit at thirds
  const nat = draw(C, 'natural', [[0, 0], [10, 10], [20, 0], [30, 10]]).ops;
  nat.slice(1).forEach((o, i) => {
    assert.ok(near(o[1], i * 10 + 10 / 3, 1e-9) && near(o[3], i * 10 + 20 / 3, 1e-9), 'x controls of segment ' + i);
  });
});

test('monotoneX never overshoots: a flat step stays flat, a monotone rise keeps its controls inside the neighbours', () => {
  const { C } = load();
  const ops = draw(C, 'monotoneX', [[0, 0], [10, 10], [20, 10], [30, 20]]).ops;
  const flat = ops[2];                                     // p1 -> p2 (both 10)
  assert.equal(flat[2], 10); assert.equal(flat[4], 10);
  ops.slice(1).forEach((o, i) => {
    const y0 = [0, 10, 10][i], y1 = [10, 10, 20][i];
    [o[2], o[4]].forEach((cy) => assert.ok(cy >= Math.min(y0, y1) - 1e-9 && cy <= Math.max(y0, y1) + 1e-9, `segment ${i} control ${cy}`));
  });
  // cardinal does overshoot there (control y = 10 + (10 - 0) / 6): the difference the two choices exist for
  const card = draw(C, 'cardinal', [[0, 0], [10, 10], [20, 10], [30, 20]]).ops;
  assert.ok(near(card[2][2], 10 + 10 / 6, 1e-9), 'cardinal bends above the plateau: ' + card[2][2]);
  // coincident points are ignored (d3)
  assert.deepEqual(draw(C, 'monotoneX', [[0, 0], [0, 0], [10, 5]]).ops, [['M', 0, 0], ['L', 10, 5]]);
});

test('gaps: null ends a run when the line breaks at bad data, joins with spanGaps; undefined (no sample of this pen) is skipped', () => {
  const { C } = load();
  const xs = [0, 10, 20, 30, 40, 50], ys = [1, 2, null, 4, undefined, 6];
  for (const k of ['catmullRom', 'stepCenter', 'basis', 'natural', 'linear']) {
    const r1 = recorder();
    const runEnds = [];
    assert.equal(C.drawCurve(k, r1, xs, ys, 0, 5, (x) => x, (y) => y, false, () => runEnds.push(r1.ops.length)), 2, k + ': two runs');
    assert.equal(r1.ops.filter((o) => o[0] === 'M').length, 2, k + ': one moveTo per run');
    assert.equal(runEnds.length, 2);
    assert.ok(!ends(r1.ops).some((e) => e[0] === 20), k + ': nothing drawn at the bad sample');
    const r2 = recorder();
    assert.equal(C.drawCurve(k, r2, xs, ys, 0, 5, (x) => x, (y) => y, true, null), 1, k + ': spanGaps joins');
  }
  // a window inside the data: only i0..i1 drawn
  const r = recorder();
  C.drawCurve('linear', r, [0, 1, 2, 3], [5, 6, 7, 8], 1, 2, (x) => x, (y) => y, false, null);
  assert.deepEqual(r.ops, [['M', 1, 6], ['L', 2, 7]]);
});

test('drawTypeOf: Boolean pens keep a chosen curve; only "linear" becomes steps; X-Trace kinds follow the step curves', () => {
  const { C, NS } = load();
  const d = (interpolation, type = 'line') => Object.assign({}, C.DEFAULTS.trendPens.defaults.display, { type, interpolation });
  assert.equal(C.drawTypeOf(d('linear'), true).interp, 'stepAfter');
  assert.equal(C.drawTypeOf(d('catmullRom'), true).interp, 'catmullRom');
  assert.equal(C.drawTypeOf(d('natural', 'area'), false).interp, 'natural');
  assert.equal(C.drawTypeOf(d('basis', 'bar'), false).interp, 'linear');
  assert.equal(C.traceKind({ drawType: 'line', interp: 'stepBefore' }), 'before');
  assert.equal(C.traceKind({ drawType: 'line', interp: 'stepCenter' }), 'center');
  assert.equal(C.traceKind({ drawType: 'line', interp: 'catmullRom' }), 'linear');
  assert.equal(C.traceKind({ drawType: 'line', interp: 'stepAfter' }), 'step');
  const view = { t: [0, 10, 20], v: [1, 5, 9] };
  assert.equal(C.valueAt(view, 4, 'center'), 1);
  assert.equal(C.valueAt(view, 6, 'center'), 5);
  assert.equal(C.valueAt(view, 25, 'center'), 9, 'held after the last sample');
  assert.equal(C.valueAt(view, 4, 'before'), 5, 'stepBefore: the next sample\'s value');
  assert.equal(C.valueAt(view, 10, 'before'), 5);
  assert.equal(C.valueAt(view, 4, 'step'), 1);
  void NS;
});

// ---- per-state styles ------------------------------------------------------------------------------------------------

test('display.states: schema defaults, and penStates resolves limits, colours and the Boolean rule', () => {
  const { C } = load();
  const st = SCHEMA.properties.pens.items.properties.display.properties.states;
  assert.deepEqual(st.default, { bad: { style: 'hatch', color: '' },
    outOfBounds: { enabled: false, source: 'engineering', low: null, high: null, color: '', width: 0 },
    boolean: { enabled: false, onColor: '', offColor: '', fillOpacity: 0.15 } });
  const base = C.DEFAULTS.trendPens.defaults.display;
  const disp = (states) => Object.assign({}, base, { states: Object.assign({}, base.states, states) });
  const meta = { engLow: 10, engHigh: 90, dataType: 'Float8' };
  // defaults: hatch, no oob, no bool
  assert.deepEqual(plain(C.penStates(base, meta, false)), { bad: { style: 'hatch', color: null }, oob: null, bool: null });
  // engineering limits from the tag, a configured side overrides it
  const oob = (o) => disp({ outOfBounds: Object.assign({}, base.states.outOfBounds, { enabled: true }, o) });
  assert.deepEqual(plain(C.penStates(oob({}), meta, false).oob), { low: 10, high: 90, color: null, width: 0 });
  assert.deepEqual(plain(C.penStates(oob({ high: 75 }), meta, false).oob), { low: 10, high: 75, color: null, width: 0 });
  // manual: only the configured sides
  assert.deepEqual(plain(C.penStates(oob({ source: 'manual', high: 75, width: 3, color: '#ff0000' }), meta, false).oob),
    { low: null, high: 75, color: '#ff0000', width: 3 });
  assert.equal(C.penStates(oob({ source: 'manual' }), meta, false).oob, null, 'no limit known -> no style');
  assert.equal(C.penStates(oob({}), null, false).oob, null, 'engineering limits not known yet');
  assert.equal(C.penStates(oob({ low: 50, high: 40 }), meta, false).oob, null, 'low >= high is not a range');
  // Boolean: only for pens drawn as 0 / 1; outOfBounds never applies to them
  const bool = disp({ boolean: { enabled: true, onColor: 'var(--on)', offColor: '', fillOpacity: 0.3 } });
  const R = (c) => (c === 'var(--on)' ? 'rgb(1, 2, 3)' : c);
  assert.deepEqual(plain(C.penStates(bool, meta, true, R).bool), { on: 'rgb(1, 2, 3)', off: null, fill: 0.3 }, 'theme variables resolved for canvas');
  assert.equal(C.penStates(bool, meta, false).bool, null);
  assert.equal(C.penStates(Object.assign({}, oob({}), { states: Object.assign({}, oob({}).states, { boolean: bool.states.boolean }) }), meta, true).oob, null);
  // bad data: style and colour
  assert.deepEqual(plain(C.penStates(disp({ bad: { style: 'hold', color: 'red' } }), meta, false).bad), { style: 'hold', color: 'red' });
  // buildPens carries them on the PenVM
  const vms = C.buildPens([{ key: 'p:0', source: 'pens', index: 0, tagPath: '[default]A', status: 'ok', meta }],
    C.reduceProps({ pens: [{ tagPath: '[default]A', display: { states: { outOfBounds: { enabled: true } } } }] }), {});
  assert.deepEqual(plain(vms[0].states.oob), { low: 10, high: 90, color: null, width: 0 });
});

test('stateStops: hard stops at the limits, open sides, NaN treated as no boundary', () => {
  const { C } = load();
  // plot 100..300 px, high limit at y 150 (above = state), low limit at y 250
  assert.deepEqual(plain(C.stateStops(100, 200, 150, 250, 'W', 'P', 'W')),
    [[0, 'W'], [0.25, 'W'], [0.25, 'P'], [0.75, 'P'], [0.75, 'W'], [1, 'W']]);
  // no high limit (-Infinity): the pen colour from the top
  assert.deepEqual(plain(C.stateStops(100, 200, -Infinity, 250, 'W', 'P', 'W')).slice(0, 3), [[0, 'W'], [0, 'W'], [0, 'P']]);
  // limits outside the plot clamp to its edges
  assert.deepEqual(plain(C.stateStops(100, 200, 20, 900, 'W', 'P', 'W')).map((s) => s[0]), [0, 0, 0, 1, 1, 1]);
  // Boolean: one threshold, no middle band
  assert.deepEqual(plain(C.stateStops(0, 100, 50, 50, 'ON', null, 'OFF')), [[0, 'ON'], [0.5, 'ON'], [0.5, 'OFF'], [1, 'OFF']]);
  // log scale value <= 0 -> NaN position: no boundary on that side
  assert.deepEqual(plain(C.stateStops(0, 100, NaN, 80, 'W', 'P', 'W')).map((s) => s[0]), [0, 0, 0, 0.8, 0.8, 1]);
  assert.equal(C.stateStops(0, 0, 1, 2, 'a', 'b', 'c'), null);
});

test('boolRuns (on shading) and lastGoodBefore (hold line) over joined data', () => {
  const { C } = load();
  const xs = [0, 10, 20, 30, 40, 50, 60, 70];
  const col = [0, 1, undefined, 0, 1, null, 1, 1];
  assert.deepEqual(plain(C.boolRuns(xs, col, -Infinity, Infinity)), [[10, 30], [40, 50], [60, 70]], 'undefined holds, null ends a period, ends at the last sample');
  assert.deepEqual(plain(C.boolRuns(xs, col, 35, 45)), [[40, 50]], 'only the visible part (+ the sample held at its left edge)');
  assert.deepEqual(plain(C.boolRuns([0, 10], [1, undefined], 0, 10)), [], 'a single on sample has no width');
  assert.equal(C.lastGoodBefore(xs, [1, 2, null, undefined, 5, 6, 7, 8], 30), 2);
  assert.equal(C.lastGoodBefore(xs, [null, null, null, 4, 5, 6, 7, 8], 20), null);
});

// ---- range selector (pure) -------------------------------------------------------------------------------------------

test('rsDomain: realtime = configured span ending now, historical = the window; both widened to the viewport', () => {
  const { C } = load();
  const win = { start: T0 - 8 * H, end: T0, span: 8 * H };
  assert.deepEqual(plain(C.rsDomain(win, { min: T0 + M - H, max: T0 + M }, T0 + M, true)), { start: T0 + M - 8 * H, end: T0 + M });
  assert.deepEqual(plain(C.rsDomain(win, { min: T0 - 2 * H, max: T0 - H }, T0 + M, false)), { start: T0 - 8 * H, end: T0 });
  assert.deepEqual(plain(C.rsDomain(win, { min: T0 - 10 * H, max: T0 - 9 * H }, T0, false)), { start: T0 - 10 * H, end: T0 }, 'panned left of the window');
  assert.equal(C.rsDomain(null, null, T0, true), null);
});

test('rsNormalize: every pen fills the strip; flat at 0.5; Boolean = a 0 / 0.25 track at the bottom; null and undefined untouched', () => {
  const { C } = load();
  const out = C.rsNormalize([[10, 20, null, 30, undefined], [5, 5, 5], [0, 1, 1]], [false, false, true]);
  assert.deepEqual(out[0], [0, 0.5, null, 1, undefined]);
  assert.deepEqual(out[1], [0.5, 0.5, 0.5]);
  assert.deepEqual(out[2], [0, 0.25, 0.25]);
});

test('rsDragView / rsKeyView: move, resize, draw, centre and keys stay inside the domain', () => {
  const { C } = load();
  const dom = { start: 0, end: 1000 };
  const v = { min: 400, max: 600 };
  assert.deepEqual(plain(C.rsDragView('win', v, 100, 150, dom)), { min: 450, max: 650 });
  assert.deepEqual(plain(C.rsDragView('win', v, 100, 900, dom)), { min: 800, max: 1000 }, 'stops at the end (= live in realtime)');
  assert.deepEqual(plain(C.rsDragView('win', v, 500, 0, dom)), { min: 0, max: 200 });
  assert.deepEqual(plain(C.rsDragView('start', v, 0, 100, dom)), { min: 100, max: 600 });
  assert.deepEqual(plain(C.rsDragView('start', v, 0, 900, dom)), { min: 599, max: 600 }, 'never past the other edge');
  assert.deepEqual(plain(C.rsDragView('end', v, 0, 2000, dom)), { min: 400, max: 1000 });
  assert.deepEqual(plain(C.rsDragView('new', v, 700, 300, dom)), { min: 300, max: 700 });
  assert.deepEqual(plain(C.rsDragView('center', v, 0, 950, dom)), { min: 800, max: 1000 });
  assert.deepEqual(plain(C.rsDragView('win', { min: -50, max: 2000 }, 0, 10, dom)), { min: 0, max: 1000 }, 'wider than the domain');
  // keys
  assert.deepEqual(plain(C.rsKeyView('win', 'ArrowRight', false, v, dom)), { min: 420, max: 620 }, '2 %');
  assert.deepEqual(plain(C.rsKeyView('win', 'ArrowLeft', true, v, dom)), { min: 300, max: 500 }, 'Shift: 10 %');
  assert.deepEqual(plain(C.rsKeyView('win', 'End', false, v, dom)), { min: 800, max: 1000 });
  assert.deepEqual(plain(C.rsKeyView('win', 'Home', false, v, dom)), { min: 0, max: 200 });
  assert.deepEqual(plain(C.rsKeyView('win', 'ArrowUp', false, v, dom)), { min: 375, max: 625 }, 'widen x1.25 around the centre');
  assert.deepEqual(plain(C.rsKeyView('win', 'ArrowDown', false, v, dom)), { min: 420, max: 580 }, 'narrow');
  assert.deepEqual(plain(C.rsKeyView('start', 'ArrowLeft', false, v, dom)), { min: 380, max: 600 });
  assert.deepEqual(plain(C.rsKeyView('start', 'ArrowUp', false, v, dom)), { min: 420, max: 600 }, 'Up = Right on a handle');
  assert.deepEqual(plain(C.rsKeyView('start', 'Home', false, v, dom)), { min: 0, max: 600 });
  assert.deepEqual(plain(C.rsKeyView('end', 'PageUp', false, v, dom)), { min: 400, max: 700 });
  assert.deepEqual(plain(C.rsKeyView('end', 'End', false, v, dom)), { min: 400, max: 1000 });
  assert.equal(C.rsKeyView('win', 'x', false, v, dom), null);
  assert.equal(C.rsKeyView('end', 'Home', false, v, dom), null);
});

test('overviewPlan: aggregated MinMax on the gateway ladder, point count within bounds; strip labels by increment', () => {
  const { C, NS } = load();
  const L = { pointCountMin: 10, pointCountMax: 5000, maxRangeDays: 400, minBucketMs: 100, bucketLadder: null };
  const p = C.overviewPlan(T0 - 8 * H, T0, 1000, Object.assign({}, C.effectiveLimits ? C.effectiveLimits(null) : L), T0);
  assert.equal(p.mode, 'aggregated');
  assert.equal(p.aggregation, 'MinMax');
  assert.equal(p.pointCount, 1000);
  assert.ok([30 * S, M].includes(p.bucketMs), 'a ladder step: ' + p.bucketMs);
  assert.ok((p.end - p.start) / p.bucketMs <= 5000);
  assert.equal(C.overviewPlan(T0 - H, T0, 3, null, T0).pointCount, 10, 'clamped up');
  assert.equal(C.overviewPlan(T0 - H, T0, 99999, null, T0).pointCount, 2000, 'clamped down');
  assert.equal(C.overviewPlan(T0 - 500 * 24 * H, T0, 1000, null, T0).start, T0 - 400 * 24 * H, 'maxRangeDays');
  NS.time.format.bind(NS.time);
  assert.equal(C.rsTimeLabel(T0, 30 * 24 * H, 365 * 24 * H, 'UTC'), '2026-10');
  assert.equal(C.rsTimeLabel(T0, 24 * H, 30 * 24 * H, 'UTC'), '10-11');
  assert.equal(C.rsTimeLabel(T0, H, 3 * 24 * H, 'UTC'), '10-11 12:00');
  assert.equal(C.rsTimeLabel(T0, 15 * M, 8 * H, 'UTC'), '12:00');
  assert.equal(C.rsTimeLabel(T0 + 5 * S, 10 * S, 5 * M, 'UTC'), '12:00:05');
});

// ---- overview request through the engine -----------------------------------------------------------------------------

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
function answer(body, now) {
  const dataEnd = Math.min(body.end, now);
  const b = body.bucketMs || 60000;
  const aS = Math.floor(body.start / b) * b, aE = Math.floor(dataEnd / b) * b;
  return {
    v: 2, ok: true, requestId: body.requestId, serverNow: now,
    window: { start: aS, end: aE, mode: body.mode, aggregation: body.aggregation, bucketMs: body.mode === 'raw' ? null : b,
      bucketTime: body.mode === 'raw' ? null : 'start', aligned: true, downgraded: false },
    pens: body.pens.map((p) => {
      const t = [];
      for (let x = aS; x < aE; x += b) t.push(x);
      return { key: p.key, tagPath: p.tagPath, status: 'ok', aggregation: p.aggregation, shape: 'points', t, v: t.map((x) => x / 1000),
        anchor: null, replaceFrom: null, downgraded: false, count: t.length };
    }),
  };
}
function fakeRoute(clock) {
  const calls = [];
  const fn = (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ body, at: clock.now() });
    return Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(answer(body, clock.now()))) });
  };
  fn.calls = calls;
  return fn;
}
const penInfo = (i, tagPath) => ({ key: 'p:' + i, source: 'pens', index: i, tagPath, name: tagPath.split('/').pop(), status: 'ok', meta: null, trendable: true });
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
  };
}

test('fetchOverview: one aggregated request at the lowest priority, MinMax for value pens, own aggregation for statistics, rows keyed by pen', async () => {
  const { C } = load();
  const clock = fakeClock(T0);
  const route = fakeRoute(clock);
  const queue = new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers });
  const source = fakeSource([penInfo(0, '[default]CTG/Temp'), penInfo(1, '[default]CTG/Running')]);
  const props = C.reduceProps({ pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Running', aggregation: 'DurationOn' }],
    timeRange: { realtime: { value: 8, unit: 'hours' }, refreshRate: 0 }, query: { mode: 'aggregated' } });
  const doc = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const engine = new C.ChartEngine({ id: 'c1', source, queue, now: clock.now, timers: clock.timers, document: doc, fetch: route, props, timeZone: 'UTC', plotWidth: 1000 });
  engine.start();
  await clock.advance(2000);
  const n0 = route.calls.length;
  assert.ok(n0 >= 1, 'the plots loaded first');
  const p = engine.fetchOverview({ start: T0 - 8 * H, end: T0 + 2000, pointCount: 960, penKeys: ['p:0', 'p:1'] });
  await clock.advance(1000);
  const r = await p;
  const body = route.calls[n0].body;
  assert.equal(body.mode, 'aggregated');
  assert.deepEqual(body.pens.map((x) => x.aggregation), ['MinMax', 'DurationOn']);
  assert.equal(body.pointCount, 960);
  assert.ok(body.bucketMs > 0 && (body.end - body.start) / body.bucketMs <= 5000);
  assert.equal(r.ok, true);
  assert.deepEqual([...r.pens.map((x) => x.key)], ['p:0', 'p:1']);
  assert.ok(r.pens[0].t.length > 100);
  // MinMax rows are placed like the plots' (bucket middle, not the bucket start the wire carries)
  assert.equal(r.pens[0].t[0] % body.bucketMs, body.bucketMs / 2);
  assert.equal(engine.metrics.overviewRequests, 1);
  // a pen without history is never asked
  assert.equal((await engine.fetchOverview({ start: T0 - H, end: T0, pointCount: 100, penKeys: ['p:9'] })).pens.length, 0);
  engine.dispose();
  assert.equal((await engine.fetchOverview({ start: T0 - H, end: T0, pointCount: 100 })).ok, false, 'after unmount: refused, no request');
});

test('history queue: overview jobs wait behind tick, chunk and user jobs of every chart', async () => {
  const { C } = load();
  const clock = fakeClock(T0);
  const q = new C.HistoryQueue({ maxConcurrent: 1, now: clock.now, timers: clock.timers });
  const order = [];
  let release = null;
  const job = (name, priority) => q.run({ key: name, priority, exec: () => { order.push(name); return new Promise((r) => { release = r; }); } });
  job('first', 'user');
  job('ov', 'overview'); job('tick', 'tick'); job('chunk', 'chunk'); job('user', 'user');
  for (let i = 0; i < 5; i++) { await flush(); if (release) { const r = release; release = null; r({ ok: true }); } }
  await flush();
  assert.deepEqual(order, ['first', 'user', 'chunk', 'tick', 'ov']);
});

test('history queue: an overview job runs alone (waits for idle, holds the next request) so the session task limit is never passed', async () => {
  const { C } = load();
  const clock = fakeClock(T0);
  const q = new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers });
  const running = new Set();
  const releases = {};
  let maxTogether = 0;
  const seen = [];
  const job = (name, priority, key) => q.run({ key: key || name, priority, exec: () => {
    running.add(name); seen.push([name, [...running].sort().join('+')]);
    maxTogether = Math.max(maxTogether, running.size);
    return new Promise((r) => { releases[name] = () => { running.delete(name); r({ ok: true }); }; });
  } });
  const end = async (name) => { releases[name](); await flush(); };
  // a tick runs; the overview (same chart) waits even though a second slot is free
  job('tick1', 'tick', 'a'); await flush();
  job('ov', 'overview', 'a'); await flush();
  assert.deepEqual([...running], ['tick1'], 'overview waits while a request runs');
  // idle -> the overview starts; a tick and a user load of other charts arrive and wait for it
  await end('tick1');
  assert.deepEqual([...running], ['ov']);
  job('tick2', 'tick', 'b'); job('user', 'user', 'c'); await flush();
  assert.deepEqual([...running], ['ov'], 'nothing starts next to a running overview');
  assert.equal(q.exclusive, 1);
  await end('ov');
  assert.deepEqual([...running].sort(), ['tick2', 'user'], 'both start when it ends (two slots)');
  assert.equal(q.exclusive, 0);
  await end('tick2'); await end('user');
  assert.ok(seen.every(([n, set]) => n !== 'ov' || set === 'ov'), JSON.stringify(seen));
  assert.equal(maxTogether, 2, 'ordinary jobs still share the two slots');
  // an aborted overview leaves the queue usable
  const cn = new C.Canceller();
  job('tick3', 'tick', 'a'); await flush();
  const ab = q.run({ key: 'a', priority: 'overview', signal: cn.signal, exec: () => Promise.resolve({ ok: true }) });
  cn.cancel();
  assert.equal((await ab).aborted, true);
  await end('tick3');
  job('tick4', 'tick', 'b'); await flush();
  assert.deepEqual([...running], ['tick4']);
  await end('tick4');
});

test('history queue: the batches of one strip each run alone, and a tick that arrives during a batch starts before the next batch', async () => {
  const { C } = load();
  const clock = fakeClock(T0);
  const q = new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers });
  const running = new Set();
  const order = [];
  const releases = {};
  const job = (name, priority, key) => q.run({ key: key || name, priority, exec: () => {
    running.add(name); order.push([name, [...running].sort().join('+')]);
    return new Promise((r) => { releases[name] = () => { running.delete(name); r({ ok: true }); }; });
  } });
  const end = async (name) => { releases[name](); await flush(); };
  job('ov1', 'overview', 'a'); job('ov2', 'overview', 'a'); await flush();
  assert.deepEqual([...running], ['ov1'], 'one batch at a time');
  job('tick', 'tick', 'b'); await flush();
  assert.deepEqual([...running], ['ov1'], 'the tick waits for the running batch only');
  await end('ov1');
  assert.deepEqual([...running], ['tick'], 'the tick goes before the second batch');
  await end('tick');
  assert.deepEqual([...running], ['ov2']);
  await end('ov2');
  assert.deepEqual(order.map((x) => x[1]), ['ov1', 'tick', 'ov2'], 'never two at once');
});

test('history queue: an overview job that waited 5 s behind a busy queue starts next (no new job starts until it has run)', async () => {
  const { C } = load();
  const clock = fakeClock(T0);
  const q = new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers });
  const running = new Set();
  const order = [];
  const releases = {};
  const job = (name, priority, key) => q.run({ key: key || name, priority, exec: () => {
    running.add(name); order.push([name, [...running].sort().join('+')]);
    return new Promise((r) => { releases[name] = () => { running.delete(name); r({ ok: true }); }; });
  } });
  const end = async (name) => { releases[name](); await flush(); };
  // two charts whose ticks overlap so the queue is never idle
  job('a0', 'tick', 'a'); job('b0', 'tick', 'b'); await flush();
  job('ov', 'overview', 's'); await flush();
  let n = 1;
  for (; n < 6; n++) {                               // 5 x 900 ms of overlapping ticks: below the wait limit
    await clock.advance(900);
    job('a' + n, 'tick', 'a'); await end('a' + (n - 1));
    job('b' + n, 'tick', 'b'); await end('b' + (n - 1));
  }
  assert.ok(!running.has('ov') && order.every((x) => x[0] !== 'ov'), 'still waiting below the limit');
  await clock.advance(900);                           // 5.4 s: aged
  job('a6', 'tick', 'a'); await end('a5');
  assert.deepEqual([...running].sort(), ['b5'], 'the aged overview drains the queue: the new tick does not start');
  await end('b5');
  assert.deepEqual([...running], ['ov'], 'then the overview runs alone');
  await end('ov');
  assert.deepEqual([...running], ['a6'], 'and the held tick follows');
  await end('a6');
  assert.equal(order.find((x) => x[0] === 'ov')[1], 'ov');
});

/**
 * A REAL strip — the real ChartEngine (historical, fake history route + manual clock), the real
 * RangeSelector and its real _fetch / _planFetch; only the timer (_schedule) and the uPlot render are left out.
 * rs.data is therefore what the product stores, not a hand-built fixture.
 */
async function realStrip(C, clock, o = {}) {
  const route = fakeRoute(clock);
  const queue = new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers });
  const source = fakeSource([penInfo(0, '[default]CTG/Temp')]);
  const span = o.spanMs || 6 * H;
  const props = C.reduceProps({ pens: [{ tagPath: '[default]CTG/Temp' }], rangeSelector: { visible: true },
    timeRange: { mode: 'historical', historical: { startDate: T0 - span, endDate: T0 } }, query: { mode: 'aggregated' } });
  const doc = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const engine = new C.ChartEngine({ id: 'c1', source, queue, now: clock.now, timers: clock.timers, document: doc, fetch: route, props, timeZone: 'UTC', plotWidth: 1000 });
  engine.start();
  await clock.advance(2000);
  assert.ok(engine.loadedOnce && !engine._fullLoadActive(), 'the plots loaded');
  const vm = { key: 'p:0', tagPath: '[default]CTG/Temp', aggregation: 'MinMax', drawable: true, status: 'ok', visible: true };
  const host = { engine, reducedProps: () => props, penVMs: () => [vm], rangeSelectorShown: () => true };
  const rs = new C.RangeSelector(host);
  rs.el = {};
  rs._width = () => o.width || 1000;
  const scheduled = [];
  rs._schedule = (ms) => { scheduled.push(ms); rs.timer = 1; };   // a due fetch is recorded (no real timer)
  rs.update = () => rs._planFetch();                               // the render after an answer re-plans
  return {
    engine, rs, route, scheduled,
    /** Re-plans; when due, runs the fetch through the engine and the page queue. Returns whether it was due. */
    async step() {
      scheduled.length = 0; rs.timer = null;
      rs._planFetch();
      if (!scheduled.length) return false;
      rs.timer = null;
      rs._fetch();
      await clock.advance(1000);
      return true;
    },
    dispose() { rs.disposed = true; engine.dispose(); },
  };
}

test('rsFetchDue on real strip data: clamped long domain, panned outside, tolerance (fixtures from the real fetch)', async () => {
  const { C } = load();
  const D = 24 * H;
  const clock = fakeClock(T0 + H);
  const s = await realStrip(C, clock, { spanMs: 7 * D });
  assert.equal(await s.step(), true, 'first plan: due');
  const d = s.rs.data;
  assert.ok(d && d.req && d.planBucketMs > 0 && d.bucketMs > 0, 'stored: ' + JSON.stringify(d && { req: d.req, b: d.bucketMs, pb: d.planBucketMs }));
  assert.equal(d.bucketMs, d.planBucketMs, 'the route answered the planned bucket');
  const dom = s.rs._domain();
  assert.deepEqual(plain(d.req), plain(C.rsClampDomain(dom, s.engine.L)));
  const L = s.engine.L, w = 1000, now = clock.now();
  assert.equal(C.rsFetchDue(dom, d, L, w, now, false), false, 'what was asked for is what is wanted');
  assert.equal(C.rsFetchDue({ start: dom.start - 9 * D, end: dom.end - 9 * D }, d, L, w, now, false), true, 'panned outside');
  assert.equal(C.rsFetchDue({ start: dom.start, end: dom.end + 0.01 * (dom.end - dom.start) }, d, L, w, now, false), false, 'within the 2 % tolerance');
  assert.equal(await s.step(), false, 'no refetch of an unchanged domain');
  // a 500-day domain (the viewport panned far back): the request clamps it to maxRangeDays; compared as clamped
  s.engine.viewportSet({ min: T0 - 500 * D, max: T0 - 500 * D + 2 * H });
  await clock.advance(1000);
  assert.equal(await s.step(), true, 'the far pan is due once');
  const d2 = s.rs.data, dom2 = s.rs._domain();
  assert.ok(dom2.end - dom2.start > L.maxRangeDays * D, 'domain longer than maxRangeDays');
  assert.equal(d2.req.end - d2.req.start, L.maxRangeDays * D);
  assert.equal(C.rsFetchDue({ start: dom2.start - 30 * D, end: dom2.end }, d2, L, w, now, false), false, 'further left: the same clamped request');
  assert.equal(await s.step(), false, 'and not again');
  s.dispose();
});

test('range selector (historical): after a far pan and Reset zoom the strip is refetched at the window\'s resolution', async () => {
  const { C } = load();
  const D = 24 * H;
  const clock = fakeClock(T0 + H);
  const s = await realStrip(C, clock, { spanMs: 6 * H });
  assert.equal(await s.step(), true);
  const fine = s.rs.data.bucketMs;
  const inDom = () => { const dom = s.rs._domain(); const t = s.rs.data.pens['p:0'].t; return t.filter((x) => x >= dom.start && x <= dom.end).length; };
  assert.ok(inDom() > 500, 'initial: the 6 h window at strip resolution (' + inDom() + ' rows, bucket ' + fine + ')');
  s.engine.viewportSet({ min: T0 - 100 * D, max: T0 - 100 * D + 2 * H });
  await clock.advance(1000);
  assert.equal(await s.step(), true, 'the 100-day domain is fetched');
  const coarse = s.rs.data.bucketMs;
  assert.ok(coarse > 100 * fine, 'coarse: ' + coarse);
  s.engine.viewportReset();
  await clock.advance(1000);
  const dom = s.rs._domain();
  assert.ok(dom.end - dom.start <= 6 * H + 1, 'the domain shrank back to the window');
  // old code: not due (the domain lies inside the 100-day request), the strip kept 2-4 rows for the window
  assert.equal(C.rsFetchDue(dom, s.rs.data, s.engine.L, 1000, clock.now(), false), true, 'shrunk: due');
  assert.equal(await s.step(), true, 'refetched');
  assert.equal(s.rs.data.bucketMs, fine, 'back at the window resolution');
  assert.ok(inDom() > 500, 'rows in the domain after the refetch: ' + inDom());
  assert.equal(await s.step(), false, 'no loop: equal plans are not due');
  assert.equal(await s.step(), false);
  // the resolution rule alone: same span, but the data's planned bucket is more than 2x this domain's plan
  const d = s.rs.data;
  assert.equal(C.rsFetchDue(dom, Object.assign({}, d, { planBucketMs: 3 * d.planBucketMs }), s.engine.L, 1000, clock.now(), false), true, 'too coarse');
  assert.equal(C.rsFetchDue(dom, Object.assign({}, d, { planBucketMs: 2 * d.planBucketMs }), s.engine.L, 1000, clock.now(), false), false, '2x is tolerated');
  // a gateway answer coarser than planned is not a reason to refetch again (the plan is compared, not the answer)
  assert.equal(C.rsFetchDue(dom, Object.assign({}, d, { bucketMs: 10 * d.planBucketMs }), s.engine.L, 1000, clock.now(), false), false);
  // realtime: the slide is not "outside", but a shrink is due
  assert.equal(C.rsFetchDue({ start: dom.start + H, end: dom.end + H }, d, s.engine.L, 1000, clock.now(), true), false, 'realtime slide');
  assert.equal(C.rsFetchDue({ start: dom.end - H, end: dom.end }, d, s.engine.L, 1000, clock.now(), true), true, 'realtime shrink');
  s.dispose();
});

test('history queue: after an aged overview batch starts, the other batches wait again, so ticks start between them', async () => {
  const { C } = load();
  const clock = fakeClock(T0);
  const q = new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers });
  const running = new Set();
  const order = [];
  const releases = {};
  const job = (name, priority, key) => q.run({ key: key || name, priority, exec: () => {
    running.add(name); order.push(name);
    return new Promise((r) => { releases[name] = () => { running.delete(name); r({ ok: true }); }; });
  } });
  const end = async (name) => { releases[name](); await flush(); };
  const tickPair = async (k) => {                    // two charts whose ticks overlap, so the queue is never idle
    await clock.advance(900);
    job('a' + k, 'tick', 'a'); await end('a' + (k - 1));
    job('b' + k, 'tick', 'b'); await end('b' + (k - 1));
  };
  job('a0', 'tick', 'a'); job('b0', 'tick', 'b'); await flush();
  job('ov1', 'overview', 's'); job('ov2', 'overview', 's'); job('ov3', 'overview', 't'); await flush();   // two strips' batches, queued at once
  let k = 1;
  for (; k < 7; k++) await tickPair(k);              // 5.4 s: the batches aged
  assert.deepEqual([...running], ['ov1'], 'the aged first batch drained the queue and runs alone');
  await clock.advance(1100);
  await end('ov1');
  assert.deepEqual([...running].sort(), ['a6', 'b6'], 'the held ticks start after it (old code: ov2 drained the queue at once)');
  // the ticks keep overlapping: ov2 / ov3 wait again from ov1's start, then each drains once more
  for (; k < 40 && !(order.includes('ov2') && order.includes('ov3')); k++) {
    if (running.has('ov2')) { await clock.advance(500); await end('ov2'); }
    if (running.has('ov3')) { await clock.advance(500); await end('ov3'); }
    await tickPair(k);
  }
  const i1 = order.indexOf('ov1'), i2 = order.indexOf('ov2'), i3 = order.indexOf('ov3');
  assert.ok(i2 > i1 && i3 > i1, 'all batches ran: ' + order.join(','));
  const between = (x, y) => order.slice(Math.min(x, y) + 1, Math.max(x, y)).filter((n) => /^[ab]/.test(n)).length;
  assert.ok(between(i1, i2) >= 2 && between(i1, i3) >= 2 && between(i2, i3) >= 2, 'ticks ran between every two batches: ' + order.join(','));
});

test('range selector (historical): a domain over 400 days is fetched once, not again on every update', async () => {
  const { C } = load();
  const D = 24 * H;
  const dom = { start: T0 - 500 * D, end: T0 };
  let calls = 0;
  const engine = {
    window: { start: T0 - 7 * D, end: T0, span: 7 * D }, loadedOnce: true, _nextTickAt: null,
    _fullLoadActive: () => false, _realtime: () => false, viewportGet: () => ({ min: dom.start, max: dom.start + 7 * D, followLive: false }),
    gwNow: () => T0,
    fetchOverview: (o) => { calls++; const s = Math.max(o.start, o.end - 400 * D);   // the engine clamps like overviewPlan
      return Promise.resolve({ ok: true, pens: [], window: { start: s + 3 * H, end: o.end, bucketMs: 12 * H } }); },
  };
  const props = { timeRange: { refreshRate: 0 }, rangeSelector: { pens: 'visible' }, query: { aggregation: 'MinMax' } };
  const vm = { key: 'p:0', tagPath: '[default]A', aggregation: 'MinMax', drawable: true, status: 'ok', visible: true };
  const host = { engine, reducedProps: () => props, penVMs: () => [vm], rangeSelectorShown: () => true };
  const rs = new C.RangeSelector(host);
  rs.el = {};
  rs._domain = () => dom;
  rs._fetchSig = () => 'sig';
  rs._width = () => 1000;
  rs.update = () => rs._planFetch();                  // the render after an answer re-plans
  let pending = 0;
  rs._schedule = () => { pending++; };
  rs._planFetch();
  assert.equal(pending, 1, 'first plan: due');
  pending = 0;
  rs._fetch();
  await flush(); await flush();
  assert.equal(calls, 1);
  for (let i = 0; i < 5; i++) rs._planFetch();
  assert.equal(pending, 0, 'no refetch after the clamped answer (was: every 300 ms forever)');
  rs.disposed = true;
});

function overviewEngine(C, clock, route, n) {
  const queue = new C.HistoryQueue({ maxConcurrent: 2, now: clock.now, timers: clock.timers });
  const tags = Array.from({ length: n }, (_, i) => '[default]CTG/P' + i);
  const source = fakeSource(tags.map((t, i) => penInfo(i, t)));
  const props = C.reduceProps({ pens: tags.map((tagPath) => ({ tagPath })), timeRange: { realtime: { value: 8, unit: 'hours' }, refreshRate: 0 },
    query: { mode: 'aggregated' } });
  const doc = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const engine = new C.ChartEngine({ id: 'c1', source, queue, now: clock.now, timers: clock.timers, document: doc, fetch: route, props, timeZone: 'UTC', plotWidth: 1000 });
  return { engine, keys: tags.map((_, i) => 'p:' + i) };
}

test('fetchOverview: more than 4 pens go out in batches of 4, merged in pen order; a failed batch fails the call', async () => {
  const { C } = load();
  const clock = fakeClock(T0);
  const route = fakeRoute(clock);
  let failAt = 0;
  let n = 0;
  const fetch = (url, init) => {
    if (failAt && ++n === failAt) {
      return Promise.resolve({ status: 500, headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify({ v: 2, ok: false, code: 'HISTORIAN_ERROR', message: 'x' })) });
    }
    return route(url, init);
  };
  const { engine, keys } = overviewEngine(C, clock, fetch, 10);
  engine.start();
  await clock.advance(2000);
  const n0 = route.calls.length;
  const p = engine.fetchOverview({ start: T0 - 8 * H, end: T0 + 2000, pointCount: 500, penKeys: keys });
  await clock.advance(3000);
  const r = await p;
  const bodies = route.calls.slice(n0).map((c) => c.body);
  assert.deepEqual(bodies.map((b) => b.pens.length), [4, 4, 2]);
  assert.ok(bodies.every((b) => b.includeAnchor === true && b.start === bodies[0].start && b.bucketMs === bodies[0].bucketMs));
  assert.equal(r.ok, true);
  assert.deepEqual([...r.pens.map((x) => x.key)], keys);
  assert.ok(r.window && r.window.bucketMs > 0);
  assert.equal(engine.metrics.overviewRequests, 3);
  assert.equal(engine._rawFetches.size, 0, 'canceller released');
  // the second batch is answered with an error -> the whole call fails with a real code (not ABORTED)
  failAt = 2; n = 0;
  const p2 = engine.fetchOverview({ start: T0 - 8 * H, end: T0 + 2000, pointCount: 500, penKeys: keys });
  await clock.advance(3000);
  const r2 = await p2;
  assert.equal(r2.ok, false);
  assert.notEqual(r2.code, 'ABORTED');
  assert.equal(engine._rawFetches.size, 0);
  engine.dispose();
});

test('fetchOverview never rejects: an unusable payload answers INTERNAL and releases its canceller', async () => {
  const { C } = load();
  const clock = fakeClock(T0);
  const route = fakeRoute(clock);
  let broken = false;
  const fetch = (url, init) => {
    if (!broken) return route(url, init);
    const a = answer(JSON.parse(init.body), clock.now());
    a.pens = 'not-an-array';               // (res.data.pens || []).map is not a function
    return Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(a)) });
  };
  const { engine, keys } = overviewEngine(C, clock, fetch, 1);
  engine.start();
  await clock.advance(2000);
  broken = true;
  const p = engine.fetchOverview({ start: T0 - 8 * H, end: T0, pointCount: 500, penKeys: keys });
  await clock.advance(1000);
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INTERNAL');
  assert.equal(engine._rawFetches.size, 0);
  engine.dispose();
});

test('range selector: a rejected overview clears fetching and schedules a retry', async () => {
  const { C } = load();
  const engine = {
    window: { start: T0 - H, end: T0, span: H }, loadedOnce: true, _nextTickAt: null,
    _fullLoadActive: () => false, _realtime: () => false, viewportGet: () => ({ min: T0 - H, max: T0, followLive: false }),
    gwNow: () => T0, fetchOverview: () => Promise.reject(new Error('boom')),
  };
  const props = { timeRange: { refreshRate: 0 }, rangeSelector: { pens: 'visible' }, query: { aggregation: 'MinMax' } };
  const vm = { key: 'p:0', tagPath: '[default]A', aggregation: 'MinMax', drawable: true, status: 'ok', visible: true };
  const host = { engine, reducedProps: () => props, penVMs: () => [vm], rangeSelectorShown: () => true };
  const rs = new C.RangeSelector(host);
  rs.el = {};
  const scheduled = [];
  rs._schedule = (ms) => scheduled.push(ms);
  rs._domain = () => ({ start: T0 - H, end: T0 });
  rs._fetchSig = () => 'sig';
  rs._fetchPens = () => [vm];
  rs._width = () => 500;
  rs._fetch();
  assert.ok(rs.fetching, 'fetching while the request is out');
  await flush(); await flush(); await flush();
  assert.equal(rs.fetching, null, 'not stuck as fetching');
  assert.equal(rs.lastError, 'INTERNAL');
  assert.equal(scheduled.length, 1, 'a retry is scheduled');
  rs.disposed = true;
});

test('curve density guard counts the pen\'s own rows, not the joined rows of the plot', () => {
  const { C } = load();
  const ys = new Array(3000).fill(undefined);
  for (let i = 0; i < 10; i++) ys[i * 300] = i;
  assert.equal(C.ownRowsAbove(ys, 0, 2999, 1000), false, 'a sparse pen in 3000 joined rows keeps its curve');
  const dense = Array.from({ length: 3000 }, (_, i) => (i % 7 === 0 ? null : i));
  assert.equal(C.ownRowsAbove(dense, 0, 2999, 1000), true, 'own rows (null gaps count) above the width: fallback');
  assert.equal(C.ownRowsAbove(dense, 0, 500, 1000), false, 'fewer rows than the width in view');
});

test('range selector (realtime): a strip request due just before a plot tick starts just after it, once', async () => {
  const { C } = load();
  const calls = [];
  const engine = {
    window: { start: T0 - H, end: T0, span: H }, loadedOnce: true, _nextTickAt: null,
    _fullLoadActive: () => false, _realtime: () => true, viewportGet: () => ({ min: T0 - H, max: T0, followLive: true }),
    gwNow: () => T0, fetchOverview: (o) => { calls.push(Date.now()); return new Promise(() => {}); },
  };
  const props = { timeRange: { refreshRate: 1000 }, rangeSelector: { pens: 'visible' }, query: { aggregation: 'MinMax' } };
  const vm = { key: 'p:0', tagPath: '[default]A', aggregation: 'MinMax', drawable: true, status: 'ok', visible: true };
  const host = { engine, reducedProps: () => props, penVMs: () => [vm], rangeSelectorShown: () => true };
  const rs = new C.RangeSelector(host);
  rs.el = { clientWidth: 600, clientHeight: 64 };
  // the next tick is 50 ms away: no room for a ~200 ms strip request -> after the tick (+100 ms)
  engine._nextTickAt = Date.now() + 50;
  const t0 = Date.now();
  rs._fetch();
  assert.equal(calls.length, 0, 'deferred');
  assert.equal(rs._deferred, true);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(calls.length, 1, 'sent after the tick');
  assert.ok(calls[0] - t0 >= 140, 'not before the tick + 100 ms: ' + (calls[0] - t0));
  assert.equal(rs._deferred, false);
  // the tick is 800 ms away: sent at once; a second deferral never happens for the same request
  const rs2 = new C.RangeSelector(host);
  rs2.el = rs.el;
  engine._nextTickAt = Date.now() + 800;
  rs2._fetch();
  assert.equal(calls.length, 2, 'room before the tick: sent now');
  const rs3 = new C.RangeSelector(host);
  rs3.el = rs.el;
  rs3._deferred = true;                    // already moved once (refresh rate close to the request time)
  engine._nextTickAt = Date.now() + 10;
  rs3._fetch();
  assert.equal(calls.length, 3, 'deferred at most once');
  [rs, rs2, rs3].forEach((x) => x.destroy());
});

test('range selector: new data on an unchanged x scale is drawn (setData(false) alone never commits in uPlot 1.6)', () => {
  const { C } = load();
  const W0 = { start: T0 - 6 * H, end: T0, span: 6 * H };
  const engine = { window: W0, _realtime: () => false, _rev: 1, viewportGet: () => ({ min: W0.start, max: W0.end, followLive: false }),
    gwNow: () => T0 + H, penView: () => ({ t: [], v: [] }) };
  const host = { engine, pm: null, currentView: () => ({ min: W0.start, max: W0.end }), canInteract: () => true };
  const rs = new C.RangeSelector(host);
  const calls = [];
  rs.u = { setData: (d, reset) => calls.push(['setData', reset]), setScale: (k, o) => calls.push(['setScale', k]),
    redraw: () => calls.push(['redraw']), bbox: { width: 600 }, pxRatio: 1, over: { clientWidth: 600 }, data: [[]] };
  rs.pens = [{ key: 'p:0', isBool: false }];
  rs.sync();                                            // first sync: the domain is new -> setScale
  assert.deepEqual(calls.splice(0), [['setScale', 'x']]);
  rs.data = { sig: 's', start: W0.start, end: W0.end, bucketMs: 30000, fetchedAt: 1, pens: { 'p:0': { t: [W0.start + H, W0.start + 2 * H], v: [1, 2] } } };
  rs._setData(false);
  rs.sync();                                            // same domain (historical window): the data still has to be drawn
  assert.deepEqual(calls.splice(0), [['setData', false], ['redraw']]);
  rs.sync();                                            // nothing new: no draw at all
  assert.deepEqual(calls.splice(0), []);
});

// ---- editor model -------------------------------------------------------------------------------------------------------

test('pen editor: default display carries the states; a state edit is a nested patch on the raw pen and on a trend override', () => {
  const { C, P } = load();
  assert.deepEqual(plain(P.defaultDisplay()), plain(C.DEFAULTS.trendPens.defaults.display));
  assert.deepEqual(plain(P.defaultStates()), plain(C.DEFAULTS.trendPens.defaults.display.states));
  assert.deepEqual(plain(P.BAD_STYLES), SCHEMA.properties.pens.items.properties.display.properties.states.properties.bad.properties.style.enum);
  // static pen: only the leaf changes (the raw display had no states object at all)
  const raw = [{ tagPath: '[default]A', display: { type: 'line' } }];
  const op = P.penFieldOp('[default]a', 0, ['display', 'states', 'outOfBounds', 'enabled'], true);
  const out = op(raw, { raw: true });
  assert.deepEqual(plain(out[0].display), { type: 'line', states: { outOfBounds: { enabled: true } } });
  assert.equal(C.reduceProps({ pens: out }).pens[0].display.states.outOfBounds.enabled, true);
  assert.equal(C.reduceProps({ pens: out }).pens[0].display.states.outOfBounds.source, 'engineering', 'the rest from defaults');
  // trend pen: the effective display (defaults merged) with the nested field set
  const tp = { defaults: plain(C.DEFAULTS.trendPens.defaults), overrides: [] };
  const t2 = P.overrideDisplayOp('[default]B', ['states', 'bad', 'style'], 'hold')(tp, {});
  assert.equal(t2.overrides.length, 1);
  assert.equal(t2.overrides[0].display.states.bad.style, 'hold');
  assert.equal(t2.overrides[0].display.interpolation, 'linear');
  // the chart then applies the override (a non-default display)
  const vms = C.buildPens([{ key: 't:b', source: 'trend', index: null, tagPath: '[default]B', status: 'ok', meta: null }],
    C.reduceProps({ trendPens: t2 }), {});
  assert.equal(vms[0].states.bad.style, 'hold');
});

test('pen editor limits line: the same rule as the chart (engineering + override, manual, invalid -> none)', () => {
  const { C, P } = load();
  const meta = { engLow: 10, engHigh: 90 };
  const o = (x) => Object.assign({ enabled: true, source: 'engineering', low: null, high: null, color: '', width: 0 }, x);
  [[{}, meta], [{ high: 75 }, meta], [{ source: 'manual', high: 75 }, meta], [{ source: 'manual' }, meta], [{}, null], [{ low: 50, high: 40 }, meta]].forEach(([x, m]) => {
    const disp = Object.assign({}, C.DEFAULTS.trendPens.defaults.display, { states: Object.assign({}, C.DEFAULTS.trendPens.defaults.display.states, { outOfBounds: o(x) }) });
    const chart = C.penStates(disp, m, false).oob;
    assert.deepEqual(plain(P.oobLimits(o(x), m)), chart ? { low: chart.low, high: chart.high } : null, JSON.stringify(x));
  });
});

test('rangeSelector schema: off by default, height bounds, pens visible | all; the chart CSS styles the strip with shared tokens only', () => {
  const { C } = load();
  assert.deepEqual(SCHEMA.properties.rangeSelector.default, { visible: false, height: 64, pens: 'visible', narrowVisible: false });
  assert.deepEqual(plain(C.DEFAULTS.rangeSelector), SCHEMA.properties.rangeSelector.default);
  assert.equal(C.reduceProps({ rangeSelector: { height: 5000 } }).rangeSelector.height, 200);
  assert.equal(C.reduceProps({ rangeSelector: { height: 1 } }).rangeSelector.height, 40);
  assert.equal(C.reduceProps({ rangeSelector: { pens: 'some' } }).rangeSelector.pens, 'visible');
  const css = C.CHART_CSS;
  ['.ctg-rs', '.ctg-rs__win', '.ctg-rs__handle', '.ctg-rs__shade', '.ctg-rs__handle:focus-visible'].forEach((sel) => assert.ok(css.includes(sel), sel));
  assert.ok(!/--ctg-rs-/.test(css), 'no tokens of its own');
  assert.ok(/pointer:coarse\)\{:where\(\.ctg-rs__handle::before\)/.test(css), 'wider touch hit area');
});
