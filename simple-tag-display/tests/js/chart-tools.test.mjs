// =============================================================================
// chart-tools.test.mjs — ctg-chart-tools.js: DateRangeModal, ColorPicker,
// ExportMenu and their pure models, run against the ChartApi stub
// (tests/js/_chartApiStub.mjs: the real reducer, buildPens and i18n in the
// _stubs.mjs environment). The panel file is loaded by the stub with the other
// module files; NS.chart.tools exposes its pure helpers.
// =============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChartApiStub, CHART_API_MEMBERS } from './_chartApiStub.mjs';

const HOUR = 3600000, DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const PENS = [{ tagPath: '[default]CTG/Temp' }, { tagPath: '[default]CTG/Pressure', color: '#112233' }, { tagPath: '[default]CTG/SmallRange' }];

/** Deep equality across the vm realm (objects built inside the stub context have other prototypes). */
const same = (actual, expected, msg) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, msg);
const GROUPS = ['viewport', 'history', 'series', 'plots', 'panels'];

/** Stub + helpers; `api` is a recording copy of the stub api: every member the tools touch lands in `used`. */
function setup(fixture = {}) {
  const s = createChartApiStub(Object.assign({ props: { pens: PENS } }, fixture));
  const used = new Set();
  const wrap = (obj, prefix) => {
    const out = {};
    for (const k of Object.keys(obj)) {
      const name = prefix ? prefix + '.' + k : k;
      const v = obj[k];
      if (GROUPS.includes(k) && v && typeof v === 'object') out[k] = wrap(v, name);
      else if (typeof v === 'function') out[k] = function (...a) { used.add(name); return v.apply(obj, a); };
      else Object.defineProperty(out, k, { enumerable: true, get() { used.add(name); return v; } });
    }
    return Object.freeze(out);
  };
  const api = wrap(s.api, '');
  return Object.assign(s, { api, used, T: s.NS.chart.tools });
}
/** Instantiates a tool component with a working setState (the stub Component has none). */
function mount(Comp, api, args = {}) {
  const closed = [];
  const inst = new Comp({ api, args, close: () => closed.push(1) });
  inst.setState = (patch) => { Object.assign(inst.state, typeof patch === 'function' ? patch(inst.state) : patch); };
  if (inst.componentDidMount) inst.componentDidMount();
  return { inst, closed };
}
/** Depth-first search over the stub React tree (children and element-valued props such as footer). */
function find(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; }
  if (node.props !== undefined && pred(node)) out.push(node);
  if (node.children) find(node.children, pred, out);
  if (node.props) for (const v of Object.values(node.props)) if (v && typeof v === 'object' && (Array.isArray(v) || v.props !== undefined)) find(v, pred, out);
  return out;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (hx) => { const n = parseInt(hx.slice(1), 16); return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255); };
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

// ---------------------------------------------------------------------------------------------------------------
test('registration: the three slots exist, dock none, strings registered', () => {
  const s = setup();
  for (const name of ['dateRange', 'color', 'export']) {
    const def = s.C.panels.get(name);
    assert.ok(def, name);
    assert.equal(def.dock, 'none');
    assert.equal(typeof def.render, 'function');
    assert.equal(def.button, undefined, 'built-in slots get their buttons from the chart');
  }
  assert.equal(s.NS.i18n.t('tools.date.title', null, 'chartTools'), 'Date range');
  assert.ok(s.env.window.document === undefined || true);
});

test('design mode: every tool renders nothing and api.panels.open refuses', () => {
  const s = setup({ designMode: true });
  for (const name of ['dateRange', 'color', 'export']) {
    assert.equal(s.C.panels.get(name).render(s.api, { penKey: 'p:0' }, () => {}), null, name);
    assert.equal(s.api.panels.open(name, {}), false);
  }
});

// ---- date range model ------------------------------------------------------------------------------------------
test('local datetime fields: round trip in the chart zone, impossible dates rejected', () => {
  const { T } = setup();
  const ms = Date.UTC(2026, 2, 8, 9, 15, 7);
  assert.equal(T.toLocalInput(ms, 'America/Chicago'), '2026-03-08T04:15:07');
  assert.equal(T.toLocalInput(ms, 'Asia/Tokyo'), '2026-03-08T18:15:07');
  same(T.parseLocalInput('2026-03-08T04:15'), { y: 2026, M: 3, d: 8, h: 4, m: 15, s: 0, ms: 0 });
  assert.equal(T.parseLocalInput('2026-02-30T01:00:00'), null);
  assert.equal(T.parseLocalInput('2026-02-28T24:00:00'), null);
  assert.equal(T.parseLocalInput('1969-12-31T23:00:00'), null);
  assert.equal(T.parseLocalInput(''), null);
  assert.ok(T.parseLocalInput('2028-02-29T00:00:00'));
});

function ctxOf(s, tz = 'UTC', now = NOW) { return { p: s.api.props(), now, tz, limits: s.api.limits() }; }
const rt = (v, u) => ({ tab: 'realtime', rtValue: String(v), rtUnit: u, startText: '', endText: '' });
const hi = (a, b) => ({ tab: 'historical', rtValue: '8', rtUnit: 'hours', startText: a, endText: b });

test('realtime validation: amount, unit, gateway limit, raw-only limit', () => {
  const s = setup();
  const ok = s.T.evaluateRange(rt(8, 'hours'), ctxOf(s));
  assert.equal(ok.valid, true);
  assert.equal(ok.timeRange.mode, 'realtime');
  same(ok.timeRange.realtime, { value: 8, unit: 'hours' });
  assert.equal(ok.window.span, 8 * HOUR);
  assert.equal(ok.timeRange.refreshRate, 1000, 'other timeRange fields are kept (whole-object write)');
  assert.equal(ok.timeRange.presets.length, 5);
  for (const bad of ['0', '-1', '1.5', 'abc', '']) {
    const r = s.T.evaluateRange(rt(bad, 'hours'), ctxOf(s));
    assert.equal(r.valid, false, bad);
    assert.match(r.errors.value, /whole number/);
  }
  const twoYears = s.T.evaluateRange(rt(2, 'years'), ctxOf(s));
  assert.equal(twoYears.valid, false);
  assert.match(twoYears.errors.range, /400 days/);
  assert.equal(s.T.evaluateRange(rt(399, 'days'), ctxOf(s)).valid, true);
  // raw-only chart: 31 days
  const sr = setup({ props: { pens: PENS, query: { mode: 'raw' } } });
  const raw = sr.T.evaluateRange(rt(40, 'days'), ctxOf(sr));
  assert.equal(raw.valid, false);
  assert.match(raw.errors.range, /Raw data is limited to 31 days/);
  // raw with the aggregate fallback is bound by the aggregated limit
  const sa = setup({ props: { pens: PENS, query: { mode: 'raw', onTooManyPoints: 'aggregate' } } });
  assert.equal(sa.T.evaluateRange(rt(40, 'days'), ctxOf(sa)).valid, true);
  // a gateway that allows less (limits from the snapshot)
  const sl = setup({ limits: { maxRangeDays: 30 } });
  assert.equal(sl.T.evaluateRange(rt(5, 'weeks'), ctxOf(sl)).valid, false);
});

test('historical validation: DST gap note + query start, overlap, order, span, future', () => {
  const s = setup();
  const tz = 'America/Chicago';
  // 2026-03-08 02:30 does not exist in Chicago (spring forward): moved to 03:30 CDT = 08:30Z
  const gap = s.T.evaluateRange(hi('2026-03-08T02:30', '2026-03-08T06:00'), ctxOf(s, tz));
  assert.equal(gap.valid, true);
  assert.match(gap.notes.start, /^02:30 does not exist on this date; using 03:30\.$/);
  assert.equal(gap.window.start, Date.UTC(2026, 2, 8, 8, 30));
  assert.equal(gap.timeRange.mode, 'historical');
  assert.ok(gap.timeRange.historical.startDate instanceof s.env.context.Date || gap.timeRange.historical.startDate.getTime);
  assert.equal(gap.timeRange.historical.startDate.getTime(), Date.UTC(2026, 2, 8, 8, 30));
  assert.equal(gap.timeRange.historical.endDate.getTime(), Date.UTC(2026, 2, 8, 11, 0));
  // 2026-11-01 01:30 occurs twice: the first (CDT, -05:00) = 06:30Z
  const ov = s.T.evaluateRange(hi('2026-11-01T01:30', '2026-11-01T05:00'), ctxOf(s, tz));
  assert.equal(ov.window.start, Date.UTC(2026, 10, 1, 6, 30));
  assert.match(ov.notes.start, /occurs twice.*first one \(UTC−05:00\)/);
  // errors
  assert.match(s.T.evaluateRange(hi('2026-10-08T10:00', '2026-10-08T09:00'), ctxOf(s)).errors.end, /after the start/);
  assert.match(s.T.evaluateRange(hi('2026-10-08T10:00:00', '2026-10-08T10:00:00'), ctxOf(s)).errors.end, /after the start/);
  assert.match(s.T.evaluateRange(hi('2026-10-08T13:00', '2026-10-08T14:00'), ctxOf(s)).errors.start, /in the past/);
  assert.match(s.T.evaluateRange(hi('', '2026-10-08T10:00'), ctxOf(s)).errors.start, /Enter a date/);
  assert.match(s.T.evaluateRange(hi('2026-13-01T00:00', '2026-10-08T10:00'), ctxOf(s)).errors.start, /valid date/);
  assert.match(s.T.evaluateRange(hi('2025-01-01T00:00', '2026-10-08T10:00'), ctxOf(s)).errors.range, /400 days/);
  const fut = s.T.evaluateRange(hi('2026-10-08T10:00', '2026-10-08T14:00'), ctxOf(s));
  assert.equal(fut.valid, true);
  assert.match(fut.notes.end, /future/);
  assert.equal(fut.window.end, NOW, 'the window ends at now (the gateway clamps)');
  // realtime fields survive a switch to historical (whole object written)
  same(fut.timeRange.realtime, { value: 8, unit: 'hours' });
});

test('initial draft, quick ranges, sameWindow', () => {
  const s = setup({ props: { pens: PENS, timeRange: { mode: 'realtime', realtime: { value: 15, unit: 'minutes' } } } });
  const d = s.T.initialDraft(s.api.props(), { tz: 'UTC', now: NOW, viewport: { min: NOW - 15 * 60000, max: NOW }, window: null });
  same(d, { tab: 'realtime', rtValue: '15', rtUnit: 'minutes', startText: '2026-10-08T11:45:00', endText: '2026-10-08T12:00:00' });
  const tz = 'Asia/Tokyo';                                  // 12:00Z = 21:00 in Tokyo
  same(s.T.quickRange('today', d, NOW, tz), { startText: '2026-10-08T00:00:00', endText: '2026-10-08T21:00:00' });
  same(s.T.quickRange('yesterday', d, NOW, tz), { startText: '2026-10-07T00:00:00', endText: '2026-10-08T00:00:00' });
  same(s.T.quickRange('now', d, NOW, tz), { endText: '2026-10-08T21:00:00' });
  same(s.T.quickRange('lastShift', { endText: '2026-10-08T20:00:00' }, NOW, tz), { startText: '2026-10-08T12:00:00', endText: '2026-10-08T20:00:00' });
  const unchanged = s.T.evaluateRange(rt(15, 'minutes'), ctxOf(s));
  assert.equal(s.T.sameWindow(s.api.props(), unchanged.timeRange), true);
  assert.equal(s.T.sameWindow(s.api.props(), s.T.evaluateRange(rt(16, 'minutes'), ctxOf(s)).timeRange), false);
  assert.equal(s.T.presetLabel({ value: 15, unit: 'minutes', label: '' }), '15 min');
  assert.equal(s.T.presetLabel({ value: 1, unit: 'hours', label: 'Shift' }), 'Shift');
  assert.equal(s.T.refreshText(0), 'Auto refresh off.');
  assert.equal(s.T.refreshText(1000), 'Refreshes every 1 s.');
  assert.equal(s.T.refreshText(250), 'Refreshes every 250 ms.');
});

// ---- DateRangeModal against the stub api ----------------------------------------------------------------------
// Apply patches only mode + realtime / historical of the RAW timeRange (no reducer defaults persisted)
test('DateRangeModal: Apply patches timeRange, fires onRangeChange, closes; invalid keeps Apply disabled', () => {
  const s = setup({ props: { pens: PENS, timeRange: { mode: 'realtime', realtime: { value: 15, unit: 'minutes' } } } });
  const { inst, closed } = mount(s.T.DateRangeModal, s.api);
  assert.equal(inst.state.tab, 'realtime');
  // invalid -> Apply disabled, nothing written
  inst.setState({ rtValue: '2', rtUnit: 'years' });
  let tree = inst.render();
  const apply = () => find(tree, (n) => n.props['data-ctg-apply'])[0];
  assert.equal(apply().props.disabled, true);
  assert.equal(inst._apply(), false);
  assert.equal(s.writes.length, 0);
  // valid realtime change
  inst.setState({ rtValue: '1', rtUnit: 'hours' });
  tree = inst.render();
  assert.equal(apply().props.disabled, false);
  assert.equal(inst._apply(), true);
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].key, 'timeRange');
  assert.equal(s.writes[0].patch, true, 'through ChartApi.patch');
  assert.equal(s.writes[0].value.mode, 'realtime');
  same(s.writes[0].value.realtime, { value: 1, unit: 'hours' });
  same(Object.keys(s.writes[0].value).sort(), ['mode', 'realtime'], 'only what the view stored + the change (old: every reducer default)');
  same(s.events.map((e) => e.name), ['onRangeChange']);
  same(s.events[0].payload, { mode: 'realtime', start: NOW - HOUR, end: NOW });
  assert.equal(closed.length, 1);
});

test('DateRangeModal: historical apply in the chart zone; re-applying the same window resets the viewport only', () => {
  const s = setup({ tz: 'America/Chicago', props: { pens: PENS } });
  const { inst } = mount(s.T.DateRangeModal, s.api);
  inst.setState({ tab: 'historical', startText: '2026-03-08T02:30', endText: '2026-03-08T06:00' });
  const tree = inst.render();
  const notes = find(tree, (n) => n.props.className === 'ctg-tools-note').map((n) => n.children.join(''));
  same(notes, ['02:30 does not exist on this date; using 03:30.']);
  assert.ok(inst._apply());
  const w = s.writes[0].value;
  assert.equal(w.mode, 'historical');
  // (the stub records a JSON copy of each write: the Date objects arrive as ISO strings)
  assert.equal(new Date(w.historical.startDate).getTime(), Date.UTC(2026, 2, 8, 8, 30));
  assert.equal(s.api.props().timeRange.historical.startDate, Date.UTC(2026, 2, 8, 8, 30), 'reducer reads the Date');
  // same window again: no write, a viewport reset (the chart fires onRangeChange itself)
  let vpNotified = 0;
  s.api.onChange((what) => { if (what.viewport) vpNotified++; });
  const second = mount(s.T.DateRangeModal, s.api);
  second.inst.setState({ tab: 'historical', startText: '2026-03-08T03:30:00', endText: '2026-03-08T06:00:00' });
  assert.ok(second.inst._apply());
  assert.equal(s.writes.length, 1);
  assert.equal(vpNotified, 1);
  assert.equal(s.events.length, 1);
});

test('DateRangeModal: Enter in a field applies, Enter on a button does not; tabs switch with arrow keys', () => {
  const s = setup();
  const { inst } = mount(s.T.DateRangeModal, s.api);
  inst.setState({ rtValue: '2' });
  let prevented = 0;
  inst._onKeyDown({ key: 'Enter', target: { tagName: 'BUTTON' }, preventDefault: () => prevented++ });
  assert.equal(s.writes.length, 0);
  inst._onKeyDown({ key: 'Enter', target: { tagName: 'INPUT' }, preventDefault: () => prevented++ });
  assert.equal(s.writes.length, 1);
  assert.equal(prevented, 1);
  const tree = inst.render();
  const tablist = find(tree, (n) => n.props.role === 'tablist')[0];
  const tabs = find(tablist, (n) => n.props.role === 'tab');
  same(tabs.map((x) => x.props['aria-selected']), ['true', 'false']);
  same(tabs.map((x) => x.props.tabIndex), [0, -1]);
  tablist.props.onKeyDown({ key: 'ArrowRight', preventDefault() {}, currentTarget: { querySelector: () => ({ focus() {} }) } });
  assert.equal(inst.state.tab, 'historical');
  const panel = find(inst.render(), (n) => n.props.role === 'tabpanel')[0];
  assert.equal(panel.props['data-tabpanel'], 'historical');
  assert.ok(find(panel, (n) => n.props['data-ctg-field'] === 'start' && n.props.type === 'datetime-local' && n.props.step === 1).length);
});

test('DateRangeModal: presets come from timeRange.presets and set the draft', () => {
  const s = setup({ props: { pens: PENS, timeRange: { presets: [{ value: 30, unit: 'seconds', label: '' }, { value: 2, unit: 'days', label: 'Two days' }] } } });
  const { inst } = mount(s.T.DateRangeModal, s.api);
  const chips = find(inst.render(), (n) => n.props['data-preset'] != null);
  same(chips.map((c) => c.children.join('')), ['30 s', 'Two days']);
  chips[1].props.onClick();
  same([inst.state.rtValue, inst.state.rtUnit], ['2', 'days']);
  const again = find(inst.render(), (n) => n.props['data-preset'] != null);
  same(again.map((c) => c.props['aria-pressed']), ['false', 'true']);
});

test('DateRangeModal: closes itself when toolbar.buttons.dateRange is off', async () => {
  const s = setup({ props: { pens: PENS, toolbar: { buttons: { dateRange: false } } } });
  assert.equal(s.T.toolGate(s.api, 'dateRange').ok, false);
  const { inst, closed } = mount(s.T.DateRangeModal, s.api);
  assert.equal(inst.render(), null);
  await tick();
  assert.equal(closed.length, 1);
  assert.equal(s.T.toolGate(s.api, 'export').ok, true);
});

// ---- colours ----------------------------------------------------------------------------------------------------
test('colour model: hex parsing, swatches, contrast of the extras', () => {
  const { T } = setup();
  assert.equal(T.normalizeHex('#abc'), '#AABBCC');
  assert.equal(T.normalizeHex('2f7ed8'), '#2F7ED8');
  assert.equal(T.normalizeHex(' #2F7ED8 '), '#2F7ED8');
  for (const bad of ['#abcd', 'red', '#ggg', '', null, 'url(x)', '#2F7ED8;x']) assert.equal(T.normalizeHex(bad), null, String(bad));
  const sw = T.swatchColors(['#2f7ed8', 'red', '#1E88E5']);
  assert.equal(sw[0], '#2F7ED8');
  assert.equal(sw.filter((c) => c === '#1E88E5').length, 1, 'de-duplicated');
  assert.equal(sw.length, 1 + T.EXTRA_COLORS.length);
  for (const c of T.EXTRA_COLORS) for (const bg of ['#FFFFFF', '#1E1E1E', '#323232']) assert.ok(contrast(c, bg) >= 3, c + ' on ' + bg);
});

// colorPatch edits the RAW root (a static pen at its raw index, a trend override by normKey)
test('colour patches: static pen = its raw entry only, trend pen = trendPens.overrides upsert (normKey), default clears', () => {
  const s = setup({
    penInfos: [
      { key: 'p:0', source: 'pens', index: 0, tagPath: '[default]CTG/Temp', name: 'Temp', status: 'ok', meta: {} },
      { key: 'p:1', source: 'pens', index: 1, tagPath: '[default]CTG/Pressure', name: 'Pressure', status: 'ok', meta: {} },
      { key: 't:[default]ctg/counter', source: 'trend', index: null, tagPath: '[default]CTG/Counter', name: 'Counter', status: 'ok', meta: {} },
    ],
    props: { pens: PENS.slice(0, 2), trendPens: { overrides: [{ tagPath: '[DEFAULT]ctg/counter ', name: 'Cnt' }] } },
  });
  const T = s.T, p = s.api.props();
  const vms = s.api.pens();
  const raw = (k) => JSON.parse(JSON.stringify(s.raw()[k]));
  const w0 = T.colorPatch(p, vms[0], '#f00');
  assert.equal(w0.key, 'pens');
  same(w0.fn(raw('pens')), [{ tagPath: '[default]CTG/Temp', color: '#FF0000' }, { tagPath: '[default]CTG/Pressure', color: '#112233' }],
    'only pen 0 changes; nothing the reducer fills in is added');
  assert.equal(T.explicitColor(p, vms[1]), '#112233');
  const wt = T.colorPatch(p, vms[2], '#00ff00');
  assert.equal(wt.key, 'trendPens');
  const tp = wt.fn(raw('trendPens'));
  assert.equal(tp.overrides.length, 1, 'existing entry updated, case-insensitive match');
  assert.equal(tp.overrides[0].color, '#00FF00');
  assert.equal(tp.overrides[0].name, 'Cnt');
  same(Object.keys(tp).sort(), ['overrides'], 'no defaults (nameMode …) persisted');
  assert.equal(T.colorPatch(p, vms[0], 'red'), null, 'only validated hex');
  // through ChartApi.patch: one write of the raw value
  assert.equal(s.api.patch(w0.key, w0.fn), true);
  same(s.writes.pop().value[0], { tagPath: '[default]CTG/Temp', color: '#FF0000' });
  // a trend pen without an override: a new entry; clearing it without an override writes nothing
  const s2 = setup({ penInfos: [{ key: 't:x', source: 'trend', index: null, tagPath: '[default]CTG/X', name: 'X', status: 'ok', meta: {} }], props: { pens: [] } });
  const vx = s2.api.pens()[0];
  same(s2.T.colorPatch(s2.api.props(), vx, '#123456').fn({}).overrides, [{ tagPath: '[default]CTG/X', color: '#123456' }]);
  assert.equal(s2.T.colorPatch(s2.api.props(), vx, ''), null);
});

test('ColorPicker: swatch pick writes + onPensChange edit; onPick callers get the colour; gates close it', async () => {
  const s = setup();
  const { inst, closed } = mount(s.T.ColorPicker, s.api, { penKey: 'p:0', anchorRect: { left: 10, top: 10, right: 30, bottom: 30 } });
  const tree = inst.render();
  assert.ok(tree, 'renders');
  const opts = find(tree, (n) => n.props.role === 'option');
  assert.equal(opts.length, 10 + 8);
  assert.equal(opts.filter((o) => o.props['aria-selected'] === 'true').length, 1, 'the effective colour is selected');
  assert.equal(opts.filter((o) => o.props.tabIndex === 0).length, 1, 'roving tabindex');
  opts[3].props.onClick();
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].key, 'pens');
  assert.equal(s.writes[0].value[0].color, opts[3].props['data-color']);
  same(s.events[0], { name: 'onPensChange', payload: { action: 'edit', tagPath: '[default]CTG/Temp', source: 'pens' } });
  assert.equal(closed.length, 1);
  assert.equal(s.api.pens()[0].color, opts[3].props['data-color'], 'the chart now draws that colour');
  // hex field: invalid -> error, valid -> write
  const m2 = mount(s.T.ColorPicker, s.api, { penKey: 'p:1' });
  m2.inst.setState({ hex: '#12' });
  m2.inst._applyHex();
  assert.match(m2.inst.state.hexError, /#RGB or #RRGGBB/);
  m2.inst.setState({ hex: 'abcdef' });
  m2.inst._applyHex();
  assert.equal(s.writes.at(-1).value[1].color, '#ABCDEF');
  // Default: back to automatic
  const m3 = mount(s.T.ColorPicker, s.api, { penKey: 'p:1' });
  m3.inst._apply('');
  assert.equal(s.writes.at(-1).value[1].color, '');
  // onPick (embedded use): callback, no write
  const picked = [];
  const before = s.writes.length;
  const m4 = mount(s.T.ColorPicker, s.api, { penKey: 'p:2', onPick: (c) => picked.push(c), value: '#010203' });
  assert.equal(m4.inst.state.hex, '#010203');
  m4.inst._apply('#0A0B0C');
  same(picked, ['#0A0B0C']);
  assert.equal(s.writes.length, before);
  // unknown pen -> nothing, closes
  const m5 = mount(s.T.ColorPicker, s.api, { penKey: 'p:99' });
  assert.equal(m5.inst.render(), null);
  await tick();
  assert.equal(m5.closed.length, 1);
});

test('ColorPicker: hidden when !enabled or penTable.allowColorChange is off (onPick callers own their gate)', async () => {
  const off = setup({ props: { pens: PENS, enabled: false } });
  const a = mount(off.T.ColorPicker, off.api, { penKey: 'p:0' });
  assert.equal(a.inst.render(), null);
  await tick();
  assert.equal(a.closed.length, 1);
  const noColor = setup({ props: { pens: PENS, penTable: { allowColorChange: false } } });
  const b = mount(noColor.T.ColorPicker, noColor.api, { penKey: 'p:0' });
  assert.equal(b.inst.render(), null);
  const c = mount(noColor.T.ColorPicker, noColor.api, { penKey: 'p:0', onPick() {} });
  assert.ok(c.inst.render());
});

test('ColorPicker: arrow keys move in a 6-column grid, Enter picks', () => {
  const s = setup();
  const { inst } = mount(s.T.ColorPicker, s.api, { penKey: 'p:0' });
  const grid = find(inst.render(), (n) => n.props.role === 'listbox')[0];
  const focused = [];
  const opts = Array.from({ length: 18 }, (_, i) => ({ i, focus() { focused.push(i); } }));
  const doc = s.env.context.document;
  doc.activeElement = opts[0];
  const ev = (key) => ({ key, preventDefault() {}, currentTarget: { querySelectorAll: () => opts } });
  grid.props.onKeyDown(ev('ArrowRight'));
  grid.props.onKeyDown(ev('ArrowDown'));
  grid.props.onKeyDown(ev('End'));
  same(focused, [1, 6, 17]);
  doc.activeElement = opts[2];
  grid.props.onKeyDown(ev('Enter'));
  assert.equal(s.writes.length, 1);
  delete doc.activeElement;
});

// ---- export model -------------------------------------------------------------------------------------------------
test('CSV cells: injection guard on text only, quoting, numbers verbatim', () => {
  const { T } = setup();
  assert.equal(T.csvText('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(T.csvText('+cmd'), "'+cmd");
  assert.equal(T.csvText('-cmd'), "'-cmd");
  assert.equal(T.csvText('@SUM(A1)'), "'@SUM(A1)");
  assert.equal(T.csvText('\tx'), "'\tx");
  assert.equal(T.csvText('a,b'), '"a,b"');
  assert.equal(T.csvText('Temp (degF)'), 'Temp (degF)');
  assert.equal(T.csvValue(-5.25), '-5.25', 'negative numbers are not guarded');
  assert.equal(T.csvValue(0.1 + 0.2), '0.30000000000000004', 'full precision');
  assert.equal(T.csvValue(1234567.5), '1234567.5', 'no grouping, dot decimal');
  assert.equal(T.csvValue(null), '');
  assert.equal(T.csvValue(''), '');
  assert.equal(T.csvValue(NaN), '');
  assert.equal(T.csvValue(true), '1');
});

test('CSV time formats: iso in the chart zone with offset, epoch, pattern', () => {
  const { T } = setup();
  const ms = Date.UTC(2026, 9, 8, 12, 0, 0, 5);
  assert.equal(T.csvTime(ms, 'iso', 'Asia/Tokyo'), '2026-10-08T21:00:00.005+09:00');
  assert.equal(T.csvTime(ms, 'iso', 'America/Chicago'), '2026-10-08T07:00:00.005-05:00');
  assert.equal(T.csvTime(ms, 'epoch', 'UTC'), String(ms));
  assert.equal(T.csvTime(ms, 'YYYY-MM-DD HH:mm:ss.SSS', 'UTC'), '2026-10-08 12:00:00.005');
});

test('CSV document from api.series.rows: BOM, CRLF, guarded header, one line per row', () => {
  const s = setup({ props: { pens: [{ tagPath: '[default]CTG/Temp', name: '=evil' }, { tagPath: '[default]CTG/Pressure' }] } });
  const table = s.api.series.rows({ source: 'visible', layout: 'wide' });
  const parts = s.T.csvParts(table, { timeFormat: 'epoch', tz: 'UTC', textCols: s.T.textColumns(table.header, 'wide', false) });
  const text = parts.join('');
  assert.ok(text.startsWith('﻿'));
  const lines = text.slice(1).split('\r\n');
  assert.equal(lines.at(-1), '');
  assert.equal(lines.length - 2, table.rows.length);
  assert.equal(lines[0], "Time,'=evil,Pressure");
  assert.match(lines[1], /^\d{13},\d+(\.\d+)?,\d+(\.\d+)?$/);
  // tall + quality: pen names are text (guarded), quality words text
  const tall = s.api.series.rows({ source: 'visible', layout: 'tall', includeQuality: true });
  const tl = s.T.csvParts(tall, { timeFormat: 'epoch', tz: 'UTC', textCols: s.T.textColumns(tall.header, 'tall', true) }).join('').split('\r\n');
  assert.equal(tl[0], '﻿Time,Pen,Value,Quality');
  assert.ok(tl.some((l) => /^\d+,'=evil,[\d.]+,Good$/.test(l)));
});

test('raw table: wide k-way merge (blank where a pen has no sample, null = bad), tall sorted, quality columns', () => {
  const { T } = setup();
  const pens = [
    { key: 'a', t: [1, 2, 4, 4], v: [10, null, 40, 41], status: 'ok' },
    { key: 'b', t: [2, 3], v: [-2, 3], status: 'ok' },
  ];
  const labels = { a: { name: 'A', column: 'A (u)' }, b: { name: 'B', column: 'B' } };
  const w = T.rawTable(pens, labels, 'wide', false);
  same(w.header, ['Time', 'A (u)', 'B']);
  same(w.rows, [[1, 10, ''], [2, null, -2], [3, '', 3], [4, 41, '']]);
  const wq = T.rawTable(pens, labels, 'wide', true);
  same(wq.header, ['Time', 'A (u)', 'A (u) quality', 'B', 'B quality']);
  same(wq.rows[1], [2, null, 'Bad', -2, 'Good']);
  same(wq.rows[0], [1, 10, 'Good', '', '']);
  const tl = T.rawTable(pens, labels, 'tall', false);
  same(tl.rows.map((r) => r[0]), [1, 2, 2, 3, 4, 4]);
  same(tl.header, ['Time', 'Pen', 'Value']);
  const csv = T.csvParts(wq, { timeFormat: 'epoch', tz: 'UTC', textCols: T.textColumns(wq.header, 'wide', true) }).join('');
  assert.ok(csv.includes('\r\n2,,Bad,-2,Good\r\n'), 'a bad sample is an empty value with quality Bad');
});

test('file names: tokens in the chart zone, unsafe characters replaced, never empty', () => {
  const { T } = setup();
  const s = Date.UTC(2026, 9, 8, 3, 4, 5), e = Date.UTC(2026, 9, 8, 4, 0, 0);
  assert.equal(T.exportFileName('{title}_{start}', { title: 'Line 3', start: s, end: e }, 'UTC'), 'Line 3_20261008-030405');
  assert.equal(T.exportFileName('{title}_{start}_{end}', { title: '', start: s, end: e }, 'Asia/Tokyo'), 'chart_20261008-120405_20261008-130000');
  assert.equal(T.exportFileName('a/b:c*?"<>|d', {}, 'UTC'), 'a_b_c_d');
  assert.equal(T.exportFileName('..', {}, 'UTC'), 'chart');
  assert.equal(T.exportFileName('', { title: 'T' }, 'UTC').startsWith('T_'), true);
  assert.equal(T.exportFileName('x'.repeat(300), {}, 'UTC').length, 120);
});

// ---- ExportMenu ---------------------------------------------------------------------------------------------------
/** Makes downloads observable in the stub environment (Blob, an <a download>, object URLs). */
function withDownloads(s) {
  const saved = [];
  const ctx = s.env.context;
  ctx.Blob = Blob;
  ctx.AbortController = AbortController;
  const doc = ctx.document;
  doc.body = { appendChild() {}, removeChild() {} };
  const origCreate = doc.createElement;
  const urls = new Map();
  let n = 0;
  ctx.URL = { createObjectURL: (b) => { const u = 'blob:test/' + (++n); urls.set(u, b); return u; }, revokeObjectURL: (u) => urls.delete(u) };
  doc.createElement = (tag) => {
    if (tag !== 'a') return origCreate(tag);
    const a = { tag, download: '', href: '', style: {}, parentNode: null, click() { saved.push({ name: a.download, blob: urls.get(a.href) }); } };
    return a;
  };
  return saved;
}

test('ExportMenu: items follow export.* toggles; CSV visible downloads a guarded CSV and closes; PNG via plots.snapshot', async () => {
  const s = setup({ props: { pens: [{ tagPath: '[default]CTG/Temp', name: '@x' }, { tagPath: '[default]CTG/Pressure' }], title: { visible: true, text: 'Line 3' } } });
  const saved = withDownloads(s);
  const { inst, closed } = mount(s.T.ExportMenu, s.api, { anchorRect: { left: 500, top: 10, right: 530, bottom: 40 } });
  let menu = inst.render();
  assert.equal(menu.type, s.NS.ui.Menu);
  assert.equal(menu.props.y, 42);
  same(menu.props.items.filter((i) => !i.hidden).map((i) => i.id), ['csv', 'png']);
  menu.props.items[0].onSelect();
  assert.equal(saved.length, 1);
  assert.match(saved[0].name, /^Line 3_\d{8}-\d{6}\.csv$/);
  const text = await saved[0].blob.text();
  const rows = s.api.series.rows({ source: 'visible', layout: 'wide' });
  const lines = text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
  assert.equal(lines.length, rows.rows.length + 1);
  assert.equal(lines[0], "Time,'@x,Pressure");
  assert.match(lines[1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00,/);
  assert.equal(closed.length, 1);
  // PNG
  const m2 = mount(s.T.ExportMenu, s.api, {});
  m2.inst.render().props.items[1].onSelect();
  assert.equal(saved.length, 2);
  assert.match(saved[1].name, /\.png$/);
  // toggles
  const s2 = setup({ props: { pens: PENS, export: { csv: { enabled: false } } } });
  const m3 = mount(s2.T.ExportMenu, s2.api, {});
  same(m3.inst.render().props.items.filter((i) => !i.hidden).map((i) => i.id), ['png']);
  const s3 = setup({ props: { pens: PENS, export: { csv: { enabled: false }, png: { enabled: false } } } });
  const m4 = mount(s3.T.ExportMenu, s3.api, {});
  assert.equal(m4.inst.render(), null);
  await tick();
  assert.equal(m4.closed.length, 1);
  const s4 = setup({ props: { pens: PENS, toolbar: { buttons: { export: false } } } });
  assert.equal(mount(s4.T.ExportMenu, s4.api, {}).inst.render(), null);
});

test('ExportMenu: mobile app -> items disabled with the mobile-app tooltip; !enabled keeps export (viewing action)', () => {
  const s = setup({ capabilities: { nativeApp: true, deviceType: 'ios' } });
  const items = mount(s.T.ExportMenu, s.api, {}).inst.render().props.items.filter((i) => !i.hidden);
  assert.ok(items.every((i) => i.disabled && i.title === 'Export is not available in the mobile app'));
  const off = setup({ props: { pens: PENS, enabled: false } });
  assert.ok(mount(off.T.ExportMenu, off.api, {}).inst.render());
  assert.equal(off.T.toolGate(off.api, 'dateRange').ok, true);
});

test('ExportMenu: raw CSV goes through history.fetchRaw over the visible window, busy + cancel', async () => {
  const s = setup({ props: { pens: PENS, export: { csv: { source: 'raw', layout: 'wide', timeFormat: 'epoch' } } } });
  const saved = withDownloads(s);
  const { inst, closed } = mount(s.T.ExportMenu, s.api, {});
  const items = inst.render().props.items;
  assert.equal(items[0].keepOpen, true);
  items[0].onSelect();
  assert.equal(inst.state.busy, true);
  const busy = inst.render().props.items;
  assert.equal(busy[0].busy, true);
  assert.equal(busy[2].hidden, false, 'Cancel item');
  await tick(); await tick();
  assert.equal(saved.length, 1);
  const lines = (await saved[0].blob.text()).replace(/^﻿/, '').split('\r\n').filter(Boolean);
  const vp = s.api.viewport.get();
  const times = lines.slice(1).map((l) => Number(l.split(',')[0]));
  assert.ok(times.length > 100 && times.every((x) => x >= vp.min && x <= vp.max));
  assert.equal(lines[0], 'Time,Temp,Pressure,SmallRange');
  assert.equal(closed.length, 1);
  // cancel before the reply: nothing saved
  const m2 = mount(s.T.ExportMenu, s.api, {});
  m2.inst.render().props.items[0].onSelect();
  m2.inst.render().props.items[2].onSelect();
  await tick(); await tick();
  assert.equal(saved.length, 1);
});

test('ChartApi conformance: the tools use only frozen ChartApi members', () => {
  const s = setup({ props: { pens: PENS, export: { csv: { source: 'raw' } } } });
  withDownloads(s);
  const dr = mount(s.T.DateRangeModal, s.api);
  dr.inst.render(); dr.inst.setState({ rtValue: '3' }); dr.inst._apply();
  const cp = mount(s.T.ColorPicker, s.api, { penKey: 'p:0' });
  cp.inst.render(); cp.inst._apply('#123456');
  const em = mount(s.T.ExportMenu, s.api, {});
  em.inst.render().props.items[0].onSelect();
  mount(s.T.ExportMenu, s.api, {}).inst.render().props.items[1].onSelect();
  const allowed = new Set(CHART_API_MEMBERS);
  const extra = [...s.used].filter((m) => !allowed.has(m));
  same(extra, []);
  for (const m of ['props', 'patch', 'pens', 'capabilities', 'now', 'timeZone', 'limits', 'status', 'viewport.get', 'fireEvent',
    'history.fetchRaw', 'plots.snapshot', 'id']) assert.ok(s.used.has(m), m);
});

// ---- export fallbacks, refused writes, tool openings ----------------------------------------------------------------
/** Captures toasts (NS.ui.Toast.show) of the stub environment; returns the list of {text, tone}. */
function withToasts(s) {
  const shown = [];
  const T = s.NS.ui.Toast;
  try { T.show = (o) => { shown.push({ text: o.text, tone: o.tone }); }; } catch (e) { /* frozen: toasts not observable */ }
  return shown;
}
/** A copy of the (recording) api with some members replaced. */
const withApi = (api, over) => Object.assign({}, api, over);
/** Small fixture series inside [start, end] for keys p:0..p:2. */
function smallSeries(start, end) {
  const out = {};
  ['p:0', 'p:1', 'p:2'].forEach((k, i) => {
    const t = [], v = [];
    for (let x = start + 60000; x < end; x += (end - start) / 10) { t.push(Math.round(x)); v.push(i * 10 + t.length); }
    out[k] = { t, v };
  });
  return out;
}

test('raw CSV over limits.maxRawRangeDays exports the visible data with a notice, no fetchRaw', async () => {
  const s = setup({ limits: { maxRawRangeDays: 1 }, series: smallSeries(NOW - 3 * DAY, NOW),
    props: { pens: PENS, timeRange: { mode: 'realtime', realtime: { value: 3, unit: 'days' } }, export: { csv: { source: 'raw', timeFormat: 'epoch' } } } });
  const saved = withDownloads(s);
  const toasts = withToasts(s);
  const { inst, closed } = mount(s.T.ExportMenu, s.api, {});
  inst.render().props.items[0].onSelect();
  assert.equal(inst.state.busy, false, 'never busy: no raw request');
  assert.equal(s.used.has('history.fetchRaw'), false);
  assert.equal(saved.length, 1);
  const lines = (await saved[0].blob.text()).replace(/^﻿/, '').split('\r\n').filter(Boolean);
  assert.equal(lines.length, 1 + s.api.series.rows({ source: 'visible', layout: 'wide' }).rows.length);
  assert.ok(lines.length > 1);
  assert.equal(toasts.length, 1);
  assert.match(toasts[0].text, /Raw export is limited to 1 days/);
  assert.equal(closed.length, 1);
});

test('a raw reply that was downgraded and is empty falls back to the visible data', async () => {
  const s = setup({ props: { pens: PENS, export: { csv: { source: 'raw', timeFormat: 'epoch' } } } });
  const saved = withDownloads(s);
  const toasts = withToasts(s);
  const api = withApi(s.api, { history: { fetchRaw: (o) => Promise.resolve({ pens: o.penKeys.map((key) => ({ key, t: [], v: [], status: 'ok', downgraded: true })) }) } });
  const { inst, closed } = mount(s.T.ExportMenu, api, {});
  inst.render().props.items[0].onSelect();
  await tick(); await tick();
  assert.equal(saved.length, 1, 'a file instead of "no data"');
  assert.match(toasts[toasts.length - 1].text, /Raw samples are not available/);
  assert.equal(closed.length, 1);
});

test('fetchRaw throwing synchronously leaves no busy item behind', () => {
  const s = setup({ props: { pens: PENS, export: { csv: { source: 'raw' } } } });
  withDownloads(s);
  const toasts = withToasts(s);
  const api = withApi(s.api, { history: { fetchRaw: () => { throw new Error('detached'); } } });
  const { inst, closed } = mount(s.T.ExportMenu, api, {});
  inst.render().props.items[0].onSelect();
  assert.equal(inst.state.busy, false);
  assert.equal(inst._ctl, null);
  assert.equal(closed.length, 1);
  assert.match(toasts[0].text, /Export failed: detached/);
});

test('a refused timeRange write keeps the modal (and the draft) open', () => {
  const s = setup();
  const toasts = withToasts(s);
  const api = withApi(s.api, { patch: () => false });
  const { inst, closed } = mount(s.T.DateRangeModal, api);
  inst.setState({ rtValue: '2', rtUnit: 'hours' });
  assert.equal(inst._apply(), false);
  assert.equal(closed.length, 0);
  assert.equal(inst.state.rtValue, '2');
  assert.equal(s.events.length, 0);
  assert.equal(toasts[0].text, 'The date range could not be changed.');
});

test('without a[download] the blob opens in a new tab and a returned window is success', () => {
  const s = setup();
  withDownloads(s);
  const toasts = withToasts(s);
  const ctx = s.env.context;
  const calls = [];
  const fakeWin = { opener: 'x' };
  ctx.open = s.env.window.open = (url, target, features) => { calls.push({ url, target, features }); return fakeWin; };
  const orig = ctx.document.createElement;
  ctx.document.createElement = (tag) => (tag === 'a' ? { tag, style: {} } : orig(tag));   // no 'download' property
  const { inst } = mount(s.T.ExportMenu, s.api, {});
  inst.render().props.items[0].onSelect();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].features, undefined, 'no noopener feature (it makes open() return null)');
  assert.equal(fakeWin.opener, null, 'opener cut by hand');
  assert.equal(toasts.filter((x) => /Export failed/.test(x.text)).length, 0);
  // a real popup block (null) is still reported
  ctx.open = s.env.window.open = () => null;
  mount(s.T.ExportMenu, s.api, {}).inst.render().props.items[0].onSelect();
  assert.match(toasts[toasts.length - 1].text, /Export failed: blocked/);
});

test('file names are never Windows device names', () => {
  const { T } = setup();
  for (const [title, want] of [['CON', '_CON'], ['nul', '_nul'], ['COM1', '_COM1'], ['lpt9.x', '_lpt9.x'], ['Aux', '_Aux'],
    ['CONSOLE', 'CONSOLE'], ['com10', 'com10'], ['prn ', '_prn']]) {
    assert.equal(T.exportFileName('{title}', { title }, 'UTC'), want, title);
  }
});

test('a colour patch edits the pen at its raw index; other raw entries stay exactly as stored', () => {
  const { T, C } = setup();
  const rawPens = [{ tagPath: '[default]A' }, 'junk', { tagPath: '[default]B', color: '#445566', custom: 1 }];
  const p = C.reduceProps({ pens: rawPens });
  assert.equal(p.pens.length, 2);
  const w = T.colorPatch(p, { source: 'pens', index: 2, tagPath: '[default]B' }, '#123');
  assert.equal(w.key, 'pens');
  same(w.fn(JSON.parse(JSON.stringify(rawPens))), [{ tagPath: '[default]A' }, 'junk', { tagPath: '[default]B', color: '#112233', custom: 1 }]);
  // the raw index no longer names the tag (another writer moved it): found by tag path; a pen that is gone: no change
  same(w.fn([{ tagPath: '[default]B' }]), [{ tagPath: '[default]B', color: '#112233' }]);
  same(w.fn([{ tagPath: '[default]A' }]), [{ tagPath: '[default]A' }]);
  // read back through the reducer: the same raw indices
  same(C.reduceProps({ pens: w.fn(JSON.parse(JSON.stringify(rawPens))) }).pens.map((x) => x.index), [0, 2]);
});

test('opening a tool again with new args remounts it (key per opening); the same opening keeps its key', () => {
  const s = setup();
  for (const name of ['color', 'dateRange', 'export']) {
    const def = s.C.panels.get(name);
    const a = { penKey: 'p:0', anchorRect: { left: 1, top: 1, right: 2, bottom: 2 } };
    const b = { penKey: 'p:1', anchorRect: { left: 50, top: 50, right: 60, bottom: 60 } };
    const k1 = def.render(s.api, a, () => {}).props.key;
    assert.equal(def.render(s.api, a, () => {}).props.key, k1, name + ': stable while open');
    assert.notEqual(def.render(s.api, b, () => {}).props.key, k1, name + ': new opening, new element');
  }
  // the picker of the second opening shows pen 1's colour, not pen 0's
  const cp = mount(s.T.ColorPicker, s.api, { penKey: 'p:1' });
  assert.equal(cp.inst.state.hex, '#112233');
});

// --- apply once, pending native picks, file-name cuts ------------------------------------------------------------
test('DateRangeModal applies once per opening (a double activation writes once)', () => {
  const s = setup({ props: { pens: PENS, timeRange: { mode: 'realtime', realtime: { value: 15, unit: 'minutes' } } } });
  const { inst, closed } = mount(s.T.DateRangeModal, s.api);
  inst.setState({ rtValue: '3', rtUnit: 'hours' });
  assert.equal(inst._apply(), true);
  assert.equal(inst._apply(), false, 'second activation in the same tick is ignored');
  assert.equal(s.writes.length, 1);
  same(s.events.map((e) => e.name), ['onRangeChange']);
  assert.equal(closed.length, 1);
  // a refused write does not consume the opening: the user can retry
  const r = setup();
  let ok = false;
  const api = Object.freeze(Object.assign({}, r.api, { patch: (k, v) => (ok ? r.api.patch(k, v) : false) }));
  const m = mount(r.T.DateRangeModal, api);
  m.inst.setState({ rtValue: '2', rtUnit: 'hours' });
  assert.equal(m.inst._apply(), false);
  ok = true;
  assert.equal(m.inst._apply(), true);
  assert.equal(r.writes.length, 1);
});

test('ColorPicker closing apply happens once; a closing pick cancels a pending native pick', async () => {
  const s = setup();
  const { inst, closed } = mount(s.T.ColorPicker, s.api, { penKey: 'p:0' });
  inst._apply('#AA0000');
  inst._apply('#00AA00');
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].value[0].color, '#AA0000');
  assert.equal(s.events.length, 1);
  assert.equal(closed.length, 1);
  // native pick then a swatch pick inside the debounce: only the swatch is written, nothing later
  const m = mount(s.T.ColorPicker, s.api, { penKey: 'p:1' });
  m.inst._onNative({ target: { value: '#0000aa' } });
  m.inst._apply('#00BB00');
  m.inst.componentWillUnmount();
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(s.writes.length, 2);
  assert.equal(s.writes[1].value[1].color, '#00BB00');
});

test('a native pick still inside the debounce is applied once when the picker closes', async () => {
  const s = setup();
  const m = mount(s.T.ColorPicker, s.api, { penKey: 'p:0' });
  m.inst._onNative({ target: { value: '#123456' } });
  assert.equal(m.inst.state.hex, '#123456');
  m.inst.componentWillUnmount();                  // Esc 50 ms later
  assert.equal(s.writes.length, 1);
  assert.equal(s.writes[0].value[0].color, '#123456');
  same(s.events.map((e) => e.name), ['onPensChange']);
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(s.writes.length, 1, 'the debounce timer does not write a second time');
  // the ordinary live path still writes once and the unmount adds nothing
  const m2 = mount(s.T.ColorPicker, s.api, { penKey: 'p:1' });
  m2.inst._onNative({ target: { value: '#654321' } });
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(s.writes.length, 2);
  m2.inst.componentWillUnmount();
  assert.equal(s.writes.length, 2);
  // onPick callers get the pending colour too
  const picked = [];
  const m3 = mount(s.T.ColorPicker, s.api, { penKey: 'p:2', onPick: (c) => picked.push(c) });
  m3.inst._onNative({ target: { value: '#abcdef' } });
  m3.inst.componentWillUnmount();
  same(picked, ['#ABCDEF']);
  // a picker closed by its gate (chart disabled meanwhile) drops the pending pick, and a refused write stays quiet
  const g = setup();
  let enabled = true;
  const gApi = Object.freeze(Object.assign({}, g.api, { capabilities: () => Object.assign({}, g.api.capabilities(), { enabled }) }));
  const m4 = mount(g.T.ColorPicker, gApi, { penKey: 'p:0' });
  m4.inst._onNative({ target: { value: '#111111' } });
  enabled = false;
  m4.inst.componentWillUnmount();
  assert.equal(g.writes.length, 0);
  const q = setup();
  const toasts = withToasts(q);
  const qApi = Object.freeze(Object.assign({}, q.api, { write: () => false }));
  const m5 = mount(q.T.ColorPicker, qApi, { penKey: 'p:0' });
  m5.inst._onNative({ target: { value: '#222222' } });
  m5.inst.componentWillUnmount();
  assert.equal(toasts.length, 0, 'no toast while the chart goes away');
});

test('file names are cut at 120 code points, never inside a surrogate pair', () => {
  const { T } = setup();
  const n = T.exportFileName('{title}', { title: 'a'.repeat(119) + '\u{1F600}' + 'b' }, 'UTC');
  assert.equal(Array.from(n).length, 120);
  assert.ok(n.endsWith('\u{1F600}'), 'the emoji is kept whole');
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(n), false);
  const lone = T.exportFileName('{title}', { title: 'x\uD83Dy' }, 'UTC');
  assert.equal(lone, 'x_y');
  // a cut that leaves a trailing space or dot is trimmed
  assert.equal(T.exportFileName('{title}', { title: 'a'.repeat(119) + ' z' }, 'UTC'), 'a'.repeat(119));
  assert.equal(T.exportFileName('x'.repeat(300), {}, 'UTC').length, 120);
});
