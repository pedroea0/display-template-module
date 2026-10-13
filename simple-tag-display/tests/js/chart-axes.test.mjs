// =============================================================================
// chart-axes.test.mjs — render model (ctg-chart.js SECTION 12)
// =============================================================================
//   assignAxes   named + automatic Y axes:
//                unit AND range aware, unit-less pens own an axis, <= 2 auto
//                axes per side, Boolean -> digital, grid on the innermost axis
//   yRange       auto / manual / engineering / log / digital, padding + nice
//                rounding, hysteresis that shrinks back
//   buildPens    styling sources, labels, stable distinct colours,
//                palette contrast guard, Boolean steps
//   rangeLabel, formatting, minMaxIn, pen status mapping
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, FILES } from './_stubs.mjs';

function load() {
  const env = createEnv();
  // CSS.supports as in a browser (colour props reach canvas/CSS only after it)
  env.window.CSS = { supports: (prop, v) => /^#[0-9a-f]{3,8}$/i.test(v) || /^(rgba?|hsla?)[(]/i.test(v) || /^[a-z]+$/i.test(v) && v !== 'not' };
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  return { NS: env.window.__CTG, C: env.window.__CTG.chart };
}
const { NS, C } = load();
const meta = (unit, lo, hi, dataType = 'Float8') => ({ dataType, engUnit: unit, engLow: lo, engHigh: hi, formatString: '' });
function mp(i, tagPath, m, extra) {
  return Object.assign({ key: 'p:' + i, source: 'pens', index: i, tagPath, name: tagPath.split('/').pop(), serverName: tagPath.split('/').pop(),
    status: 'ok', meta: m, trendable: true, points: 10 }, extra);
}
function tp(path, m, extra) {
  return Object.assign({ key: 't:' + path.toLowerCase(), source: 'trend', index: null, tagPath: path, name: path.split('/').pop(),
    serverName: path.split('/').pop(), status: 'ok', meta: m, trendable: true, points: 10 }, extra);
}
function build(modelPens, rawProps) {
  const p = C.reduceProps(Object.assign({ pens: modelPens.filter((x) => x.source !== 'trend').map((x) => ({ tagPath: x.tagPath })) }, rawProps));
  const vms = C.buildPens(modelPens, p, { background: '#FFFFFF' });
  const axes = C.assignAxes(vms, p);
  return { p, vms, axes, plot0: axes.plots[0] };
}
const plain = (x) => JSON.parse(JSON.stringify(x));

test('auto axes (static): Temp degF 0-100 + SmallRange V 1-5 -> two auto axes, left degF, right V', () => {
  const { vms, plot0 } = build([mp(0, '[default]CTG/Temp', meta('degF', 0, 100)), mp(1, '[default]CTG/SmallRange', meta('V', 1, 5))]);
  assert.equal(plot0.length, 2);
  assert.deepEqual(plain(plot0.map((a) => [a.side, a.units])), [['left', ['degF']], ['right', ['V']]]);
  assert.equal(vms[0].axisKey, 'y:auto:0:u:degf:0');
  assert.equal(vms[1].axisKey, 'y:auto:0:u:v:0');
  assert.ok(plot0.every((a) => a.auto && a.name === null));
});

test('auto axes (static): two pens without units get one axis each, on both sides', () => {
  const { vms, plot0 } = build([mp(0, 'a/Small', meta('', 0, 100)), mp(1, 'a/Big', meta('', 0, 1e6))]);
  assert.deepEqual(plain(plot0.map((a) => a.key)), ['y:auto:0:pen:p:0', 'y:auto:0:pen:p:1']);
  assert.deepEqual(plain(plot0.map((a) => a.side)), ['left', 'right']);
  assert.equal(vms[0].shared || vms[1].shared, false);
});

test('same unit: spans within 10x share an axis, >= 10x are split (sorted by span)', () => {
  const { vms, plot0 } = build([
    mp(0, 'a/T1', meta('degF', 0, 100)), mp(1, 'a/T2', meta('degF', 0, 300)), mp(2, 'a/T3', meta('degF', 0, 5000)), mp(3, 'a/T4', meta('degF', null, null)),
  ]);
  assert.equal(vms[0].axisKey, vms[1].axisKey, '100 vs 300: shared');
  assert.equal(vms[3].axisKey, vms[0].axisKey, 'no span -> the first axis of the unit');
  assert.notEqual(vms[2].axisKey, vms[0].axisKey, '100 vs 5000: own axis');
  assert.equal(plot0.length, 2);
  assert.ok(plot0[0].penKeys.length === 3 && plot0[1].penKeys.length === 1);
});

test('cap: at most 2 auto axes per side; further pens share the outermost axis of the side with fewer axes', () => {
  const pens = [0, 1, 2, 3, 4, 5].map((i) => mp(i, 'a/P' + i, meta('', 0, 10 ** i)));
  const { vms, plot0 } = build(pens);
  assert.equal(plot0.length, 4);
  assert.deepEqual(plain(plot0.map((a) => a.side)), ['left', 'right', 'left', 'right']);
  assert.deepEqual(plain(vms.map((v) => v.shared)), [false, false, false, false, true, true]);
  // tie (2 + 2) -> left; the outermost left axis is the second left one
  assert.equal(vms[4].axisKey, plot0[2].key);
  assert.equal(vms[5].axisKey, plot0[2].key);
});

test('named axes: by name and position; an unknown name falls back to auto with axisMissing; named axes do not count to the cap', () => {
  const { vms, plot0 } = build([mp(0, 'a/Temp', meta('degF', 0, 100)), mp(1, 'a/Press', meta('psi', 0, 300)), mp(2, 'a/X', meta('V', 0, 5))], {
    pens: [{ tagPath: 'a/Temp', axis: 'Temperature' }, { tagPath: 'a/Press', axis: 'Pressure' }, { tagPath: 'a/X', axis: 'Gone' }],
    axes: [{ name: 'Temperature', position: 'left' }, { name: 'Pressure', position: 'right' }],
  });
  assert.equal(vms[0].axisKey, 'y:Temperature');
  assert.equal(vms[1].axisKey, 'y:Pressure');
  assert.equal(vms[2].axisMissing, 'Gone');
  assert.equal(vms[2].axisKey, 'y:auto:0:u:v:0');
  assert.deepEqual(plain(plot0.map((a) => [a.key, a.side])), [['y:Temperature', 'left'], ['y:Pressure', 'right'], ['y:auto:0:u:v:0', 'left']]);
});

test('Boolean pens: digital auto axis, drawn as steps; plots: pens per plot, out-of-range plot -> last plot', () => {
  const { vms, axes } = build([mp(0, 'a/Temp', meta('degF', 0, 100)), mp(1, 'a/Run', meta('', null, null, 'Boolean')), mp(2, 'a/Z', meta('V', 0, 5))], {
    pens: [{ tagPath: 'a/Temp' }, { tagPath: 'a/Run', plot: 1 }, { tagPath: 'a/Z', plot: 7 }], plots: [{}, {}],
  });
  assert.equal(vms[1].isBool, true);
  assert.equal(vms[1].interp, 'stepAfter');
  assert.equal(vms[1].axisKey, 'y:auto:1:digital');
  assert.equal(vms[2].plot, 1, 'plot 7 of 2 plots -> the last plot');
  assert.equal(axes.plots[1].find((a) => a.key === 'y:auto:1:digital').digital, true);
  assert.equal(axes.plots.length, 2);
});

test('grid: innermost axis per side; an auto right axis skips it when the left side has one', () => {
  const { plot0 } = build([mp(0, 'a/T', meta('degF', 0, 100)), mp(1, 'a/V', meta('V', 0, 5)), mp(2, 'a/X', meta('', 0, 1))]);
  assert.deepEqual(plain(plot0.map((a) => [a.side, a.grid])), [['left', true], ['right', false], ['left', false]]);
  const named = build([mp(0, 'a/T', meta('degF', 0, 100)), mp(1, 'a/V', meta('V', 0, 5))], {
    pens: [{ tagPath: 'a/T', axis: 'L' }, { tagPath: 'a/V', axis: 'R' }], axes: [{ name: 'L' }, { name: 'R', position: 'right' }],
  }).plot0;
  assert.deepEqual(plain(named.map((a) => a.grid)), [true, true], 'named axes follow the schema rule');
});

test('fault pens own no series and no axis', () => {
  const { vms, plot0 } = build([mp(0, 'a/T', meta('degF', 0, 100)), mp(1, 'a/N', null, { status: 'notFound' }), mp(2, 'a/S', null, { status: 'outOfScope' })]);
  assert.deepEqual(plain(vms.map((v) => v.drawable)), [true, false, false]);
  assert.equal(plot0.length, 1);
  assert.equal(vms[1].axisKey, null);
});

const AX = (range, extra) => Object.assign({ digital: false, cfg: { scale: 'linear', range: Object.assign({ mode: 'auto', min: null, max: null, includeZero: false, padding: 0.05 }, range) } }, extra);

test('yRange auto: padding + nice rounding; flat data widened; includeZero; no data keeps the previous range', () => {
  const st = {};
  assert.deepEqual(plain(C.yRange(AX(), 2, 98, st)), [-10, 110]);
  assert.deepEqual(plain(C.yRange(AX(), 5, 5, {})), [3.8, 6.2]);
  assert.deepEqual(plain(C.yRange(AX({ includeZero: true }), 50, 100, {})), [-10, 110]);
  assert.deepEqual(plain(C.yRange(AX(), null, null, st)), [-10, 110], 'no data in view: previous range');
  assert.deepEqual(plain(C.yRange(AX(), null, null, {})), [0, 1]);
});

test('yRange hysteresis: keeps a range that still fits, shrinks back when a spike leaves the view', () => {
  const st = {};
  const a = C.yRange(AX(), 60, 1000, st);                       // spike in view
  assert.ok(a[1] >= 1000);
  assert.deepEqual(plain(C.yRange(AX(), 60, 990, st)), plain(a), 'small change: same range (no jitter)');
  const b = C.yRange(AX(), 70, 80, st);                          // spike scrolled out
  assert.ok(b[1] < 100 && b[0] > 50, 'shrinks back: ' + b);
  assert.deepEqual(plain(C.yRange(AX(), 71, 79, st)), plain(b), 'and stays');
});

test('yRange modes: manual (a null side stays auto), engineering, log, digital', () => {
  assert.deepEqual(plain(C.yRange(AX({ mode: 'manual', min: 0, max: 200 }), 10, 20, {})), [0, 200]);
  const half = C.yRange(AX({ mode: 'manual', min: 0, max: null }), 10, 20, {});
  assert.equal(half[0], 0);
  assert.ok(half[1] >= 20 && half[1] < 25);
  assert.deepEqual(plain(C.yRange(AX({ mode: 'engineering' }), 10, 20, {}, { low: 0, high: 300 })), [0, 300]);
  assert.ok(C.yRange(AX({ mode: 'engineering' }), 10, 20, {}, null)[1] < 30, 'no limits -> auto');
  assert.deepEqual(plain(C.yRange(AX({}, { cfg: { scale: 'log', range: { mode: 'auto', padding: 0.05 } } }), 3, 4500, {})), [1, 10000]);
  assert.deepEqual(plain(C.yRange(AX({}, { digital: true }), 0, 1, {})), [-0.1, 1.1]);
});

test('buildPens: labels (unique suffix, trend nameMode), override merge, explicit vs palette colours', () => {
  const pens = [mp(0, '[default]A/Pump1/Speed', meta('rpm', 0, 3000)), mp(1, '[default]A/Pump2/Speed', meta('rpm', 0, 3000)),
    tp('[default]B/Level', meta('%', 0, 100)), tp('[default]B/Flow', meta('gpm', 0, 50))];
  const p = C.reduceProps({
    pens: [{ tagPath: '[default]A/Pump1/Speed' }, { tagPath: '[default]A/Pump2/Speed', name: 'Second pump', color: 'not a colour' }],
    trendPens: { nameMode: 'leaf', overrides: [{ tagPath: '[DEFAULT]b/level', color: '#112233', visible: false, display: { type: 'area' } }] },
  });
  const vms = C.buildPens(pens, p, { background: '#FFFFFF' });
  assert.deepEqual(plain(vms.map((v) => v.label)), ['Pump1/Speed', 'Second pump', 'Level', 'Flow']);
  assert.equal(vms[0].color.toLowerCase(), '#2f7ed8', 'static: palette[index]');
  assert.equal(vms[1].color.toLowerCase(), '#e8743b', 'invalid explicit colour ignored -> palette');
  assert.equal(vms[2].color, '#112233', 'override colour (matched case-insensitively)');
  assert.equal(vms[2].visible, false);
  assert.equal(vms[2].drawType, 'area');
  const pal = new Set(p.appearance.palette.map((x) => x.toLowerCase()));
  assert.ok(pal.has(vms[3].color.toLowerCase()) || vms[3].color.startsWith('#'));
  assert.ok(![vms[0].color, vms[1].color, vms[2].color].map((x) => x.toLowerCase()).includes(vms[3].color.toLowerCase()), 'trend colour probed to a free one');
  // stable: same tag -> same colour regardless of order and reloads
  const again = C.buildPens([pens[3]], p, { background: '#FFFFFF' })[0].color;
  const twice = C.buildPens([pens[3]], p, { background: '#FFFFFF' })[0].color;
  assert.equal(again, twice);
  const full = C.buildPens([pens[3]], C.reduceProps({ trendPens: { nameMode: 'full' } }), {})[0].label;
  assert.equal(full, '[default]B/Flow');
});

test('palette contrast: palette colours reach >= 3:1 on light and dark plot backgrounds; explicit colours are left alone', () => {
  for (const bg of ['#FFFFFF', '#1E1E1E', '#2B2B2B']) {
    for (const c of C.reduceProps({}).appearance.palette) {
      const safe = C.contrastSafe(c, bg, 3);
      assert.ok(NS.theme.contrast(safe, bg) >= 3, `${c} on ${bg}: ${safe} ${NS.theme.contrast(safe, bg)}`);
    }
  }
  assert.notEqual(C.contrastSafe('#BF8F00', '#FFFFFF', 3).toLowerCase(), '#bf8f00', '2.94:1 adjusted');
  const vms = C.buildPens([mp(0, 'a/X', null)], C.reduceProps({ pens: [{ tagPath: 'a/X', color: '#FFFF00' }] }), { background: '#FFFFFF' });
  assert.equal(vms[0].color, '#FFFF00', 'explicit colour kept');
});

test('uniqueSuffixes', () => {
  assert.deepEqual(Array.from(C.uniqueSuffixes(['[p]A/Pump1/Speed', '[p]A/Pump2/Speed', '[p]B/Level'])), ['Pump1/Speed', 'Pump2/Speed', 'Level']);
  assert.deepEqual(Array.from(C.uniqueSuffixes(['[p]A/X', '[p]A/X'])), ['X', 'X'], 'the same tag twice keeps its name');
});

test('rangeLabel: realtime, zoomed realtime, historical, paused', () => {
  const T = Date.UTC(2026, 9, 8, 12, 0, 0);
  const p = C.reduceProps({ timeRange: { realtime: { value: 8, unit: 'hours' } } });
  const win = { start: T - 8 * 3600000, end: T, span: 8 * 3600000 };
  assert.equal(C.rangeLabel(p, { viewport: { followLive: true, span: win.span, min: win.start, max: T }, window: win }, 'UTC').text, 'Last 8 hours');
  assert.deepEqual(plain(C.rangeLabel(p, { viewport: { followLive: true, span: 300000, min: T - 300000, max: T }, window: win }, 'UTC')), { text: 'Last 5 minutes', zoomed: true });
  const one = C.reduceProps({ timeRange: { realtime: { value: 1, unit: 'hours' } } });
  assert.equal(C.rangeLabel(one, { viewport: { followLive: true, span: 3600000 }, window: { span: 3600000 } }, 'UTC').text, 'Last 1 hour');
  const h = C.reduceProps({ timeRange: { mode: 'historical', historical: { startDate: T - 3600000, endDate: T } } });
  const hw = { start: T - 3600000, end: T, span: 3600000 };
  assert.match(C.rangeLabel(h, { viewport: { followLive: false, min: hw.start, max: hw.end, span: 3600000 }, window: hw }, 'UTC').text, /^2026-10-08 11:00 → 2026-10-08 12:00/);
  const z = C.rangeLabel(h, { viewport: { followLive: false, min: T - 1800000, max: T - 900000, span: 900000 }, window: hw }, 'UTC');
  assert.equal(z.zoomed, true);
  assert.match(z.text, /^Zoomed: 11:30 – 11:45/);
});

test('formatting: pen values (format, auto precision, Boolean), ticks resolve the increment', () => {
  const vm = { format: '', isBool: false };
  assert.equal(C.formatPenValue(1234.567, vm, 'en-US'), '1,234.6');
  assert.equal(C.formatPenValue(72.456, vm, 'en-US'), '72.46');
  assert.equal(C.formatPenValue(0.012345, vm, 'en-US'), '0.0123');
  assert.equal(C.formatPenValue(null, vm, 'en-US'), '—');
  assert.equal(C.formatPenValue(3.14159, { format: '#,##0.000' }, 'en-US'), '3.142');
  assert.equal(C.formatPenValue(1, { format: '', isBool: true }, 'en-US'), '1');
  const fmt = C.tickFormatter({ digital: false, cfg: { format: '' } }, 'en-US');
  assert.equal(fmt(2.5, 0.5), '2.5');
  assert.equal(fmt(1000000, 100000), '1,000,000');
  assert.equal(fmt(0.25, 0.05), '0.25');
});

test('minMaxIn: visible window incl. the sample held at its left edge, only the given columns', () => {
  const data = [[0, 10, 20, 30, 40], [5, 1, 2, 3, 99], [100, 100, null, 100, 100]];
  assert.deepEqual(plain(C.minMaxIn(data, [1], 15, 35)), [1, 3], 'held sample at 15 = the one at 10');
  assert.deepEqual(plain(C.minMaxIn(data, [1, 2], 15, 35)), [1, 100]);
  assert.equal(C.minMaxIn(data, [], 0, 40), null, 'hidden pens only: no data');
});

test('pen status mapping: fault statuses incl. outOfScope, incomplete, quality, shares a scale', () => {
  const ctx = { locale: 'en-US', fatal: null, maxPens: 32 };
  const st = (vm, cur) => plain(C.penStatus(Object.assign({ status: 'ok', limit: null }, vm), cur || null, ctx));
  assert.equal(st({ status: 'outOfScope' }).text, 'not allowed on this chart');
  assert.equal(st({ status: 'outOfScope' }).tone, 'error');
  assert.equal(st({ status: 'noHistory' }).tone, 'warn');
  assert.equal(st({ status: 'tooManyPoints', limit: 100000 }).text, 'too many points (> 100,000)');
  assert.equal(st({ incomplete: 'partial' }).title, 'Older data in this range is missing.');
  assert.equal(st({}, { v: 1, q: { code: 0, name: 'Bad_Stale', level: 'bad' } }).text, 'Bad_Stale');
  assert.match(st({ shared: true }).title, /Shares a scale/);
  assert.equal(C.penStatus({ status: 'ok' }, null, ctx), null);
});
