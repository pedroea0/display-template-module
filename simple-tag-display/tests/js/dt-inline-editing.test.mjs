// =============================================================================
// dt-inline-editing.test.mjs — Display Template: inline editing, commit rules
// and focus
// =============================================================================
// Also: exact numbers in write-path texts, truncated String values, trend popup
// ids, the direct-mode context menu, stepping and the 'active' alarm basis.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv } from './_stubs.mjs';

function load() {
  const env = createEnv();
  env.load('ctg-common.js');
  env.load('display-template.js');
  return { NS: env.window.__CTG, env };
}
function tree(obj) {
  return { read(p) { let v = obj; for (const k of String(p).split('.')) { if (v == null || typeof v !== 'object') return undefined; v = v[k]; } return v; } };
}
const GOOD = { code: 192, name: 'Good', level: 'good' };
const cap = (allowed, reason = null) => ({ allowed, reason });
function snapTemp(over = {}) {
  return Object.assign({
    status: 'ok', tagPath: '[default]CTG/Temp', tagName: 'Temp',
    value: { v: 72.25, t: 1, type: 'Float8', q: GOOD },
    meta: { engUnit: 'degF', engLow: 0, engHigh: 100, formatString: '#,##0.0', dataType: 'Float8', canWrite: true, readOnly: false, tagType: 'AtomicTag' },
    history: { available: true, enabled: true, provider: 'Core Historian', reason: 'ok' },
    alarms: { live: true, hasActive: false, hasUnacked: false, highestActivePriority: null, highestUnackedPriority: null, limits: { low: null, high: null } },
    capabilities: { write: Object.assign(cap(true), { audit: 'profile' }), configEdit: cap(true), trend: cap(true), changeHistory: cap(true) },
    trend: { group: 'default', trending: false, count: 0, max: 32 },
    writeLimits: { low: 0, high: 100, inclusive: true, source: 'eng' },
  }, over);
}
function cfgOf(NS, props) { return NS.dt.makeReducer()(tree(Object.assign({ tagPath: '[default]CTG/Temp' }, props))); }
const D = (snap, extra = {}) => Object.assign({ snap, stale: false, staleReason: null, phase: 'ready' }, extra);
const ENV = { locale: 'en-US', timeZone: 'UTC', canInteract: true, designMode: false, designer: false, frameBlocked: false };
const alarms = a => Object.assign({ live: true, hasActive: false, hasUnacked: false, highestActivePriority: null, highestUnackedPriority: null, limits: {} }, a);

function fakeComponent(NS, over = {}) {
  const c = Object.create(NS.dt.DisplayTemplate.prototype);
  const calls = { bubble: [], sent: [], focused: 0, menu: 0 };
  Object.assign(c, {
    _mounted: true, _writing: 0, _timers: new Set(),
    state: { dialog: null, edit: null, confirm: null, menu: null },
    setState(p, cb) { Object.assign(this.state, typeof p === 'function' ? p(this.state) : p); if (cb) cb(); },
    _flash() {},
    _bubble(text, tone) { calls.bubble.push({ text, tone }); },
    _startVerify() {},
    _later(fn) { (this._q || (this._q = [])).push(fn); return 1; },
    _rect() { return null; },
    _focusEditor() {},
    _env() { return ENV; },
    _sendEdit(v) { calls.sent.push(v); },
    valueEl: { focus() { calls.focused++; } },
  }, over);
  return { c, calls };
}
const run = c => (c._q || []).splice(0).forEach(fn => fn());
const edit = o => Object.assign({ kind: 'float', busy: false, target: { tagPath: '[default]CTG/Temp' } }, o);

// ---- the inline editor decided "unchanged" against the opening text, not the live value -----------------------

test('inline editor: Enter on the opening text after the live value moved writes it (was: closed, nothing written)', () => {
  const { NS } = load();
  const cfg = cfgOf(NS, { setpoint: { enabled: true, mode: 'protected', confirm: 'never' } });
  const live = v => ({ props: { props: cfg, delegate: D(snapTemp({ value: { v, type: 'Float8', q: GOOD } })) } });
  // the tag went 50 -> 55 while the editor kept "50"
  let { c, calls } = fakeComponent(NS, live(55));
  c.state.edit = edit({ text: '50', initial: '50' });
  c._commitEdit(false);
  assert.deepEqual(calls.sent, [50]);
  // control: nothing typed and the value did not move -> nothing written
  ({ c, calls } = fakeComponent(NS, live(50)));
  c.state.edit = edit({ text: '50', initial: '50' });
  c._commitEdit(false);
  assert.deepEqual(calls.sent, []);
  assert.equal(c.state.edit, null);
  // typed the value the tag already holds -> no write
  ({ c, calls } = fakeComponent(NS, live(55)));
  c.state.edit = edit({ text: '55', initial: '50', touched: true });
  c._commitEdit(false);
  assert.deepEqual(calls.sent, []);
});

test('inline select: Enter on the opening option after the live value moved writes it; blur untouched never writes', () => {
  const { NS } = load();
  const opts = [{ value: 0, label: 'Off' }, { value: 1, label: 'Auto' }, { value: 2, label: 'Manual' }];
  const cfg = cfgOf(NS, { setpoint: { enabled: true, mode: 'protected', confirm: 'never', commitOnBlur: true, options: opts } });
  const snap = snapTemp({ value: { v: 2, type: 'Int4', q: GOOD }, meta: Object.assign({}, snapTemp().meta, { dataType: 'Int4' }) });
  let { c, calls } = fakeComponent(NS, { props: { props: cfg, delegate: D(snap) } });
  c.state.edit = edit({ kind: 'options', choice: 1, initialChoice: 1 });
  c._commitEdit(false);
  assert.deepEqual(calls.sent, [1], 'Auto written back (was: closed, tag stays Manual)');
  // blur: an untouched select never puts a stale value back
  ({ c, calls } = fakeComponent(NS, { props: { props: cfg, delegate: D(snap) } }));
  c.state.edit = edit({ kind: 'options', choice: 1, initialChoice: 1 });
  c._editBlur();
  run(c);
  assert.deepEqual(calls.sent, []);
  // the choice is the live one already: nothing to write
  ({ c, calls } = fakeComponent(NS, { props: { props: cfg, delegate: D(snap) } }));
  c.state.edit = edit({ kind: 'options', choice: 2, initialChoice: 1 });
  c._commitEdit(false);
  assert.deepEqual(calls.sent, []);
});

test('commitOnBlur: an untouched numeric editor does not write after the live value moved; typed-back text does', () => {
  const { NS } = load();
  const cfg = cfgOf(NS, { setpoint: { enabled: true, mode: 'protected', confirm: 'never', commitOnBlur: true } });
  const props = { props: { props: cfg, delegate: D(snapTemp({ value: { v: 55, type: 'Float8', q: GOOD } })) } };
  let { c, calls } = fakeComponent(NS, props);
  c.state.edit = edit({ text: '50', initial: '50' });
  c._editBlur(); run(c);
  assert.deepEqual(calls.sent, [], 'untouched: cancelled');
  ({ c, calls } = fakeComponent(NS, props));
  c.state.edit = edit({ text: '50', initial: '50', touched: true });
  c._editBlur(); run(c);
  assert.deepEqual(calls.sent, [50], 'typed back after the change: written (was: nothing)');
});

// ---- write-path texts rounded with the display pattern -----------------------------------------------------------

test('confirm / range / refusal / max-step texts show the exact numbers', () => {
  const { NS } = load();
  const cfg = cfgOf(NS, { setpoint: { enabled: true, confirm: 'always', maxStep: 0.25 } });
  const snap = snapTemp({ writeLimits: { low: 0.05, high: 99.95, inclusive: true, source: 'props' } });
  assert.equal(NS.dt.fmtExact(72.36, cfg, snap, ENV), '72.36', 'was 72.4');
  assert.equal(NS.dt.fmtExact(72.3, cfg, snap, ENV), '72.3', 'the pattern when it is exact');
  assert.equal(NS.dt.fmtExact(1234.5, cfg, snap, ENV), '1,234.5', 'grouping kept');
  const r = NS.dt.rangeText(cfg, snap, ENV, 'degF');
  assert.match(r, /0\.05/);
  assert.match(r, /99\.95/);
  const intSnap = snapTemp({ meta: Object.assign({}, snapTemp().meta, { formatString: '#,##0' }) });
  assert.equal(NS.dt.fmtExact(72.6, cfg, intSnap, ENV), '72.6', 'was 73');
  // the dialog's refusals and Confirm
  const mk = (s) => {
    const dlg = new NS.dt.DtSetpointDialog({ cfg, d: D(s), env: ENV, vm: { labelText: 'Num' }, target: { tagPath: '[default]CTG/Temp' },
      submit: () => ({ promise: new Promise(() => {}), id: 'x' }), onClose() {} });
    dlg.setState = function (p) { Object.assign(this.state, typeof p === 'function' ? p(this.state) : p); };
    dlg._focusInput = () => {};
    return dlg;
  };
  const dlg = mk(snap);
  dlg.state.text = '73'; dlg.state.touched = true;          // 72.25 -> 73: more than the 0.25 max step
  const step = dlg._validate();
  assert.equal(step.ok, false);
  assert.match(step.error, /0\.25/, 'max step 0.25, was 0.3: ' + step.error);
  dlg.state.text = '99.96';
  assert.match(dlg._validate().error, /99\.95/, 'was "Must be between 0.1 and 100.0"');
  const dlg2 = mk(snapTemp());
  dlg2.state.text = '72.36'; dlg2.state.touched = true;
  dlg2._submit();
  assert.ok(dlg2.state.confirm, 'confirm always');
  assert.match(dlg2.state.confirm.text, /72\.36/, 'Confirm names the value written: ' + dlg2.state.confirm.text);
});

// ---- a push-truncated String must not seed an editor ---------------------------------------------------------------

test('a String value pushed truncated cannot be edited (guard VALUE_TRUNCATED); a whole one can', () => {
  const { NS } = load();
  const cfg = cfgOf(NS, { setpoint: { enabled: true, mode: 'popup', maxStringLength: 4096 } });
  const sm = Object.assign({}, snapTemp().meta, { dataType: 'String', formatString: '' });
  const long = 'A'.repeat(4096);
  const g = NS.dt.writeGuard(cfg, D(snapTemp({ value: { v: long, type: 'String', q: GOOD, truncated: true }, meta: sm, writeLimits: null })), ENV);
  assert.equal(g.allowed, false, 'was allowed: Write sent the 4096 chars and dropped the tail');
  assert.equal(g.code, 'VALUE_TRUNCATED');
  assert.match(g.text, /too long to edit/);
  const ok = NS.dt.writeGuard(cfg, D(snapTemp({ value: { v: 'short', type: 'String', q: GOOD }, meta: sm, writeLimits: null })), ENV);
  assert.equal(ok.allowed, true);
});

// ---- singleTag trend popups shared one id per group -----------------------------------------------------------------

test('Open Trend Popup singleTag: the default id names the tag (trendList keeps one popup per group; explicit id as is)', () => {
  const { NS } = load();
  const v = tagPath => ({ tagPath, trendGroup: 'default' });
  const single = { mode: 'singleTag', id: '' };
  const a = NS.dt.trendPopupId(single, v('[default]Area1/Tank/LevelA'));
  const b = NS.dt.trendPopupId(single, v('[default]Area1/Tank/LevelB'));
  assert.notEqual(a, b, 'two tags must not share one popup (opening the second would only focus the first)');
  assert.equal(a, NS.dt.trendPopupId(single, v('[default]area1/tank/levela')), 'same tag (normalised) -> same popup');
  assert.ok(a.startsWith('ctg-trend-default-'));
  assert.equal(NS.dt.trendPopupId({ mode: 'trendList', id: '' }, v('[default]X')), 'ctg-trend-default');
  assert.equal(NS.dt.trendPopupId({ mode: 'singleTag', id: 'mine' }, v('[default]X')), 'mine');
});

// ---- direct mode right-click on the value -------------------------------------------------------------------------

test('direct mode: a right-click on the idle value input opens the display menu (not the native text menu)', () => {
  const { NS } = load();
  const cfg = cfgOf(NS, { setpoint: { enabled: true, mode: 'direct' } });
  const input = { tagName: 'INPUT' };
  const { c, calls } = fakeComponent(NS, { props: { props: cfg, delegate: D(snapTemp()) }, inputEl: input,
    _menuAllowed: () => true, _menuModel: () => ({ items: [1] }), _clearHold() {}, _openMenu() { calls.menu++; } });
  const ev = target => ({ target, clientX: 1, clientY: 2, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {} });
  const e1 = ev(input);
  c._onContextMenu(e1);
  assert.equal(calls.menu, 1, 'was: native Cut/Copy/Paste');
  assert.equal(e1.prevented, true);
  // the edit the right button's focus opened (untouched) is dropped and the menu shows
  c.state.edit = edit({ text: '72.25', initial: '72.25' });
  c._onContextMenu(ev(input));
  assert.equal(calls.menu, 2);
  assert.equal(c.state.edit, null);
  // while the operator is typing: the native menu stays
  c.state.edit = edit({ text: '72.5', initial: '72.25', touched: true });
  const e3 = ev(input);
  c._onContextMenu(e3);
  assert.equal(calls.menu, 2);
  assert.equal(e3.prevented, false);
  // an input that is not ours keeps the native menu as before
  c.state.edit = null;
  c._onContextMenu(ev({ tagName: 'INPUT' }));
  assert.equal(calls.menu, 2);
});

// ---- keyboard focus after a successful inline write ------------------------------------------------------------------

test('a successful / timed-out inline write puts focus back on the value (not <body>); a blur commit does not', async () => {
  const { NS, env } = load();
  const doc = env.context.document;
  doc.body = { tag: 'body' };
  const cfg = cfgOf(NS, { setpoint: { enabled: true, mode: 'protected' } });
  const cases = [[{ ok: true }, false, 1], [{ ok: false, error: { code: 'CLIENT_TIMEOUT' } }, false, 1], [{ ok: true }, true, 0]];
  for (const [reply, blur, expect] of cases) {
    const p = Promise.resolve(reply);
    const { c, calls } = fakeComponent(NS, { props: { props: cfg, delegate: D(snapTemp()) }, _write: () => ({ promise: p, id: 'r' }) });
    delete c._sendEdit;
    c.state.edit = edit({ text: '61', initial: '72.25', touched: true });
    c._sendEdit(61, blur);
    await p; await null; await null;
    assert.equal(c.state.edit, null);
    doc.activeElement = doc.body;                       // the input unmounted
    run(c);
    assert.equal(calls.focused, expect, JSON.stringify(reply) + ' blur ' + blur);
  }
});

// ---- a transient guard change threw the inline edit away ------------------------------------------------------------

test('a Bad-quality dip keeps the inline editor (blocked with the real reason); a commit is refused with it', () => {
  const { NS } = load();
  const cfg = cfgOf(NS, { setpoint: { enabled: true, mode: 'protected', confirm: 'never' } });
  const good = D(snapTemp(), { valueSeq: 1 });
  const bad = D(snapTemp({ value: { v: 72.25, type: 'Float8', q: { code: 12, name: 'Bad', level: 'bad' } } }), { valueSeq: 1 });
  const { c, calls } = fakeComponent(NS, { props: { props: cfg, delegate: bad, eventsEnabled: true } });
  c.state.edit = edit({ text: '61', initial: '72.25', touched: true });
  c.componentDidUpdate({ props: cfg, delegate: good });
  assert.ok(c.state.edit, 'the typed text survives (was: editor closed)');
  assert.equal(c.state.edit.text, '61');
  assert.ok(c.state.edit.blocked);
  assert.ok(!calls.bubble.some(b => /dialog/.test(b.text)), 'no "while this dialog was open" wording');
  c._commitEdit(false);
  assert.deepEqual(calls.sent, []);
  assert.equal(calls.bubble.at(-1).tone, 'error');
  // quality back: the block clears and Enter writes
  c.props = { props: cfg, delegate: good, eventsEnabled: true };
  c.componentDidUpdate({ props: cfg, delegate: bad });
  assert.equal(c.state.edit.blocked, null);
  c._commitEdit(false);
  assert.deepEqual(calls.sent, [61]);
  // the target really gone (another tag): cancelled with the inline wording
  c.state.edit = edit({ text: '61', initial: '72.25', touched: true });
  c.props = { props: cfg, delegate: D(snapTemp({ tagPath: '[default]CTG/Other' }), { valueSeq: 1 }), eventsEnabled: true };
  c.componentDidUpdate({ props: cfg, delegate: good });
  assert.equal(c.state.edit, null);
  assert.match(calls.bubble.at(-1).text, /while you were editing/);
});

// ---- stepping with fractional / exponent increments -----------------------------------------------------------------

test('stepText: an Int tag with a fractional increment moves both ways; a 1e-7 increment is not rounded away', () => {
  const { NS } = load();
  const s = snapTemp({ writeLimits: null });
  assert.equal(NS.dt.stepText('2', -1, 0.5, s, 'en-US', 'int'), '1', 'was 2 (Math.round(1.5))');
  assert.equal(NS.dt.stepText('1', 1, 0.5, s, 'en-US', 'int'), '2');
  assert.equal(NS.dt.stepText('5', 1, 0.4, s, 'en-US', 'int'), '6', 'was 5');
  assert.equal(NS.dt.stepText('5', -1, 0.4, s, 'en-US', 'int'), '4');
  assert.equal(NS.dt.stepText('5', 1, 1, s, 'en-US', 'int'), '6');
  assert.equal(NS.dt.stepText('0', 1, 1e-7, s, 'en-US', 'float'), '0.0000001', 'was 0');
  assert.equal(NS.dt.stepText('0.0000001', 1, 1e-7, s, 'en-US', 'float'), '0.0000002');
  assert.equal(NS.dt.stepText('0.1', 1, 0.1, s, 'en-US', 'float'), '0.2');
  assert.equal(NS.dt.decimalsOf(2.5e-7), 8);
});

// ---- alarms.basis 'active' guessed acknowledgement -------------------------------------------------------------------

test("alarms basis 'active': colour by the active alarm, no blink guessed from the two priorities", () => {
  const { NS } = load();
  const cfg = cfgOf(NS, { alarms: { basis: 'active' } });
  const both = alarms({ hasActive: true, hasUnacked: true, highestActivePriority: 'High', highestUnackedPriority: 'High' });
  // HiHi cleared-unacked + Hi active-acked, both High: was a blinking "unacknowledged"
  const a = NS.dt.resolve(cfg, D(snapTemp({ alarms: both })), ENV);
  assert.equal(a.alarm.name, 'High');
  assert.equal(a.alarm.unacked, false);
  assert.ok(!a.rootClasses.includes('dt--alarm-unacked'));
  assert.doesNotMatch(a.ariaLabel, /unacknowledged/);
  // the default basis still blinks while anything is unacknowledged
  const d = NS.dt.resolve(cfgOf(NS, {}), D(snapTemp({ alarms: both })), ENV);
  assert.equal(d.alarm.unacked, true);
});
