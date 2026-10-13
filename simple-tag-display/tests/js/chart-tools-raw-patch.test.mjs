// =============================================================================
// chart-tools-raw-patch.test.mjs — ctg-chart-tools.js: raw-value patches and export edge cases
// =============================================================================
// Regression tests:
//   - the date range and the colour picker write with ChartApi.patch on
//     the RAW prop (the reducer's clamps / defaults and unknown keys stay as the
//     view stores them)
//   - historical span / minimum length on the window the chart SHOWS (end
//     clamped to now)
//   - quality words, the fallback file name and the canvas failure via NS.i18n
//   - CSV injection guard: leading whitespace + trigger, full-width forms
//   - wide / tall raw merge with non-finite or unsorted timestamps
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartApiStub } from './_chartApiStub.mjs';

const HOUR = 3600000, DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const same = (actual, expected, msg) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, msg);

function setup(fixture = {}) {
  const s = createChartApiStub(fixture);
  return Object.assign(s, { T: s.NS.chart.tools });
}
function mount(Comp, api, args = {}) {
  const closed = [];
  const inst = new Comp({ api, args, close: () => closed.push(1) });
  inst.setState = (patch) => { Object.assign(inst.state, typeof patch === 'function' ? patch(inst.state) : patch); };
  if (inst.componentDidMount) inst.componentDidMount();
  return { inst, closed };
}

test('the date range patches the RAW timeRange (refreshRate 100 and an unknown key survive)', () => {
  const s = setup({ props: { pens: [{ tagPath: '[default]CTG/Temp' }],
    timeRange: { mode: 'realtime', realtime: { value: 15, unit: 'minutes', note: 'mine' }, refreshRate: 100, custom: true } } });
  assert.equal(s.api.props().timeRange.refreshRate, 250, 'the reducer clamps 100 -> 250');
  const { inst } = mount(s.T.DateRangeModal, s.api);
  inst.setState({ rtValue: '2', rtUnit: 'hours' });
  assert.equal(inst._apply(), true);
  const w = s.writes.pop();
  same(w.value, { mode: 'realtime', realtime: { value: 2, unit: 'hours', note: 'mine' }, refreshRate: 100, custom: true },
    'old: refreshRate 250 + presets/historical defaults written, custom dropped');
});

test('a colour pick patches one pen; other pens keep exactly what the view stores', () => {
  const s = setup({ props: { pens: [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Pressure', display: { width: 20 }, mine: 'x' }] } });
  const { inst } = mount(s.T.ColorPicker, s.api, { penKey: 'p:1' });
  inst.render();
  inst._apply('#123456');
  const w = s.writes.pop();
  same(w.value, [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Pressure', display: { width: 20 }, mine: 'x', color: '#123456' }],
    'old: every pen rewritten with the reducer defaults, width clamped to 8, "mine" dropped');
  same(s.events.map((e) => [e.name, e.payload.action, e.payload.tagPath]), [['onPensChange', 'edit', '[default]CTG/Pressure']]);
});

test('historical span / minimum length use the window the chart shows (end clamped to now)', () => {
  const s = setup({ props: { pens: [{ tagPath: '[default]CTG/Temp' }] } });
  const T = s.T;
  const tz = 'UTC';
  const ctx = { p: s.api.props(), now: NOW, tz, limits: s.api.limits() };
  const loc = (ms) => T.toLocalInput(ms, tz);
  // start 1 h ago, end 401 days ahead: a 1 h window, not "longer than 400 days"
  let r = T.evaluateRange({ tab: 'historical', startText: loc(NOW - HOUR), endText: loc(NOW + 401 * DAY) }, ctx);
  assert.equal(r.errors.range, null, 'old: tooLong');
  assert.equal(r.valid, true);
  assert.equal(r.window.span, HOUR);
  assert.ok(r.notes.end, 'the "end is in the future" note');
  // start 0.5 s before now with a future end: the shown window is shorter than 1 s
  r = T.evaluateRange({ tab: 'historical', startText: loc(NOW - 1000) + '.500', endText: loc(NOW + HOUR) }, ctx);
  assert.equal(r.errors.start, null, 'the start (now - 0.5 s) is in the past');
  assert.ok(r.errors.end, 'shorter than 1 s once the end is clamped to now (old: valid, 1 h)');
  assert.equal(r.valid, false);
  r = T.evaluateRange({ tab: 'historical', startText: loc(NOW), endText: loc(NOW + HOUR) }, ctx);
  assert.equal(r.valid, false);
  assert.ok(r.errors.start || r.errors.end, 'a window that shows nothing is refused (start not in the past / too short)');
  // the order check still uses the typed values
  r = T.evaluateRange({ tab: 'historical', startText: loc(NOW - HOUR), endText: loc(NOW - 2 * HOUR) }, ctx);
  assert.ok(r.errors.end);
  // and the patch carries the typed end (the chart clamps when it queries)
  r = T.evaluateRange({ tab: 'historical', startText: loc(NOW - HOUR), endText: loc(NOW + DAY) }, ctx);
  assert.equal(new Date(r.patch.historical.endDate).getTime(), NOW + DAY);
});

test('quality words, the fallback file name and the canvas failure go through NS.i18n', () => {
  const s = setup();
  const T = s.T;
  s.NS.i18n.register('chartTools', { 'tools.export.good': 'Gut', 'tools.export.bad': 'Schlecht', 'tools.export.fileFallback': 'diagramm' });
  const labels = { 'p:0': { name: 'A', column: 'A' } };
  const wide = T.rawTable([{ key: 'p:0', t: [1, 2], v: [5, null], status: 'ok' }], labels, 'wide', true);
  same(wide.rows, [[1, 5, 'Gut'], [2, null, 'Schlecht']]);
  const tall = T.rawTable([{ key: 'p:0', t: [1, 2], v: [5, null], status: 'ok' }], labels, 'tall', true);
  same(tall.rows.map((r) => r[3]), ['Gut', 'Schlecht']);
  assert.equal(T.exportFileName('{title}', { title: '' }, 'UTC'), 'diagramm');
  assert.equal(T.exportFileName('', { title: '   ' }, 'UTC').indexOf('diagramm'), 0);
  assert.ok(s.NS.i18n.has('tools.export.canvasFailed', 'chartTools'), 'the canvas failure text is registered');
});

test('CSV injection guard: a trigger after leading whitespace and full-width / look-alike triggers are guarded too', () => {
  const T = setup().T;
  for (const x of [' =1+1', '\n=1+1', ' +cmd', '　@SUM(1)', '＝1+1', '＋1', '－1', '＠x', '−1', '﹢1', '﹣1',
    '=1', '+1', '-1', '@x', '\t1', '\r1']) {
    const cell = T.csvText(x);
    assert.ok(/^"?'/.test(cell), JSON.stringify(x) + ' -> ' + JSON.stringify(cell));
  }
  for (const x of ['Temp', 'Temp = 1', 'a-b', ' Temp', '1+1']) {
    assert.ok(!/^"?'/.test(T.csvText(x)), JSON.stringify(x) + ' stays as it is');
  }
  assert.equal(T.csvValue(-5), '-5', 'numbers are never touched');
});

test('raw merge: non-finite timestamps are skipped, unsorted pens merged in time order (no dropped samples)', () => {
  const T = setup().T;
  const labels = { a: { name: 'A', column: 'A' }, b: { name: 'B', column: 'B' } };
  const pens = [
    { key: 'a', t: [3, 1, 2, NaN, 5], v: [30, 10, 20, 99, 50], status: 'ok' },
    { key: 'b', t: [1, Infinity, 4], v: [100, 99, 400], status: 'ok' },
  ];
  const wide = T.rawTable(pens, labels, 'wide', false);
  same(wide.rows, [[1, 10, 100], [2, 20, ''], [3, 30, ''], [4, '', 400], [5, 50, '']], 'old: t=4 and t=5 were dropped, rows out of order');
  const tall = T.rawTable(pens, labels, 'tall', false);
  same(tall.rows.map((r) => r[0]), [1, 1, 2, 3, 4, 5]);
  // duplicate timestamps: the last sample at that time still wins
  same(T.rawTable([{ key: 'a', t: [2, 1, 1], v: [2, 7, 8], status: 'ok' }], labels, 'wide', false).rows, [[1, 8], [2, 2]]);
});
