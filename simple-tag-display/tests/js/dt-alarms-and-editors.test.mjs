// =============================================================================
// dt-alarms-and-editors.test.mjs — Display Template: alarm colouring and editors
// =============================================================================
// Also: hideValueOnBad, units placement, Change History tooltips, write outcomes
// after the dialog closes, gateway-derived deadlines and the root font cascade.
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
const plain = x => JSON.parse(JSON.stringify(x));
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

// ---- activeOrUnacked hides a higher unacknowledged alarm ----------------------------------------------------

test('alarms: an unacknowledged High is not hidden by an active Low (colour High, blinking)', () => {
  const { NS } = load();
  const cfg = cfgOf(NS, {});
  const vm = NS.dt.resolve(cfg, D(snapTemp({ alarms: alarms({ hasActive: true, hasUnacked: true, highestActivePriority: 'Low', highestUnackedPriority: 'High' }) })), ENV);
  assert.equal(vm.alarm.name, 'High', 'the higher of active and unacknowledged (was Low)');
  assert.equal(vm.alarm.unacked, true, 'blinks (was steady)');
  assert.ok(vm.rootClasses.includes('dt--alarm-unacked'));
  assert.ok(vm.rootClasses.includes('dt--alarm-high'));
  assert.match(vm.ariaLabel, /High priority alarm, unacknowledged/);
});

test('alarms: an unacknowledged Critical shows although the active alarm is a Diagnostic below minPriority', () => {
  const { NS } = load();
  const cfg = cfgOf(NS, {});
  const vm = NS.dt.resolve(cfg, D(snapTemp({ alarms: alarms({ hasActive: true, hasUnacked: true, highestActivePriority: 'Diagnostic', highestUnackedPriority: 'Critical' }) })), ENV);
  assert.ok(vm.alarm, 'an indication at all (was none)');
  assert.equal(vm.alarm.name, 'Critical');
  assert.equal(vm.alarm.unacked, true);
  // minPriority applies per candidate: an unacked Diagnostic alone stays hidden, an active Diagnostic does not mask
  assert.equal(NS.dt.resolve(cfg, D(snapTemp({ alarms: alarms({ hasUnacked: true, highestUnackedPriority: 'Diagnostic' }) })), ENV).alarm, null);
  // basis 'active' keeps colouring by the active alarm only
  const act = NS.dt.resolve(cfgOf(NS, { alarms: { basis: 'active' } }), D(snapTemp({ alarms: alarms({ hasActive: true, hasUnacked: true, highestActivePriority: 'Low', highestUnackedPriority: 'High' }) })), ENV);
  assert.equal(act.alarm.name, 'Low');
  assert.equal(act.alarm.unacked, false);
});

// ---- hideValueOnBad still derived bounds / threshold alarms from the hidden value ---------------------------

test('hideValueOnBad: no bounds glyph and no threshold alarm from the hidden bad value; live alarms stay', () => {
  const { NS } = load();
  const bad = { level: 'bad', name: 'Bad', code: 12 };
  const cfg = cfgOf(NS, { quality: { hideValueOnBad: true }, bounds: { enabled: true },
    alarms: { colorMode: 'thresholds', thresholds: [{ priority: 'Critical', above: 100 }] } });
  const snap = snapTemp({ value: { v: 150, type: 'Float8', q: bad }, alarms: alarms({ live: false }) });
  const vm = NS.dt.resolve(cfg, D(snap), ENV);
  assert.equal(vm.kind, 'hidden');
  assert.equal(vm.valueText, 'Bad quality');
  assert.equal(vm.alarm, null, 'no Critical from an untrusted value (was Critical)');
  assert.ok(!vm.bounds || !vm.bounds.state, 'no over-range (was high)');
  assert.ok(!vm.rootClasses.includes('dt--high') && !vm.rootClasses.includes('dt--alarm'));
  assert.equal((vm.ariaLabel.match(/Bad quality/g) || []).length, 1, 'said once: ' + vm.ariaLabel);
  // the gateway's live alarm state is not derived from the value: it still shows
  const live = NS.dt.resolve(cfgOf(NS, { quality: { hideValueOnBad: true } }),
    D(snapTemp({ value: { v: 150, type: 'Float8', q: bad }, alarms: alarms({ hasActive: true, highestActivePriority: 'High' }) })), ENV);
  assert.equal(live.alarm.name, 'High');
  // without hideValueOnBad the value is shown and judged as before
  const shown = NS.dt.resolve(cfgOf(NS, { bounds: { enabled: true }, alarms: { colorMode: 'thresholds', thresholds: [{ priority: 'Critical', above: 100 }] } }),
    D(snapTemp({ value: { v: 150, type: 'Float8', q: GOOD }, alarms: alarms({ live: false }) })), ENV);
  assert.equal(shown.alarm.name, 'Critical');
  assert.equal(shown.bounds.state, 'high');
});

// ---- units placement 'label' with a hidden label --------------------------------------------------------------

test('units: placement label with label.visible false moves the units into the value', () => {
  const { NS } = load();
  const vm = NS.dt.resolve(cfgOf(NS, { units: { placement: 'label' }, label: { visible: false } }), D(snapTemp()), ENV);
  assert.equal(vm.unitsInValue, true, 'was false: the unit vanished from the screen');
  assert.equal(vm.unitsText, 'degF');
  const shown = NS.dt.resolve(cfgOf(NS, { units: { placement: 'label' } }), D(snapTemp()), ENV);
  assert.equal(shown.unitsInValue, false);
  assert.equal(shown.labelDisplay, 'Temp (degF)');
});

// ---- Float4 edit text -----------------------------------------------------------------------------------------

test('Float4: the editors start with the shortest text of the single-precision value', () => {
  const { NS } = load();
  const f4 = snapTemp({ value: { v: Math.fround(72.3), type: 'Float4', q: GOOD }, meta: Object.assign({}, snapTemp().meta, { dataType: 'Float4' }) });
  assert.equal(NS.dt.editText(f4, 'en-US'), '72.3', 'was 72.3000030517578');
  assert.equal(NS.dt.editText(f4, 'de-DE'), '72,3');
  assert.equal(Math.fround(Number(NS.dt.editText(f4, 'en-US'))), Math.fround(72.3), 'round-trips to the same float');
  const f4b = snapTemp({ value: { v: Math.fround(0.1), type: 'Float4', q: GOOD }, meta: Object.assign({}, snapTemp().meta, { dataType: 'Float4' }) });
  assert.equal(NS.dt.editText(f4b, 'en-US'), '0.1');
  assert.equal(NS.dt.stepText('72.3', 1, 1, f4, 'en-US', 'float'), '73.3');
  // Float8 keeps 15 significant digits
  assert.equal(NS.dt.editText(snapTemp({ value: { v: 72.30000305175781, type: 'Float8', q: GOOD } }), 'en-US'), '72.3000030517578');
});

// ---- stepping onto an exclusive limit -------------------------------------------------------------------------

test('stepText never lands on an exclusive write limit', () => {
  const { NS } = load();
  const ex = snapTemp({ writeLimits: { low: 0, high: 100, inclusive: false, source: 'props' } });
  assert.equal(NS.dt.stepText('99.5', 1, 1, ex, 'en-US', 'float'), '99.5', 'stays inside (was 100, rejected by the validator)');
  assert.equal(NS.dt.stepText('0.5', -1, 1, ex, 'en-US', 'float'), '0.5');
  assert.equal(NS.dt.stepText('50', 1, 1, ex, 'en-US', 'float'), '51');
  assert.equal(NS.dt.stepText('99', 1, 1, ex, 'en-US', 'int'), '99', 'int: the nearest valid integer');
  assert.equal(NS.dt.stepText('1', -5, 1, ex, 'en-US', 'int'), '1');
  // inclusive limits still clamp onto the limit
  assert.equal(NS.dt.stepText('99.5', 1, 1, snapTemp(), 'en-US', 'float'), '100');
});

// ---- Change History tooltip -----------------------------------------------------------------------------------

function findAll(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => findAll(n, pred, out)); return out; }
  if (pred(node)) out.push(node);
  findAll(node.children, pred, out);
  if (node.props) findAll(node.props.children, pred, out);
  return out;
}

test('Change History: the row tooltip shows only the gateway-validated auditId, never a client parse', () => {
  const { NS } = load();
  const AID = '0b7c4d2e-1f3a-4b5c-9d6e-7f8a9b0c1d2e';
  const dlg = new NS.dt.DtHistoryDialog({ env: { timeZone: 'UTC' }, vm: { labelText: 'L' }, target: { tagPath: '[default]X' },
    cfg: { menu: { changeHistory: { limit: 50 } } }, onClose() {}, query: () => new Promise(() => {}) });
  dlg.state = { loading: false, error: null, rows: [
    { t: 1, user: 'native', value: 'x [auditId=forged]', status: 'Good', action: 'tag write' },          // no r.auditId
    { t: 2, user: 'operator', value: 'y [ui=popup] [auditId=' + AID + ']', status: 'Good', action: 'tag write', auditId: AID },
  ] };
  const rows = findAll(dlg.render(), n => n.type === 'tr' && n.props && n.props.key !== undefined);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].props.title, undefined, 'no "auditId forged" (was shown)');
  assert.equal(rows[1].props.title, 'auditId ' + AID);
  const forged = plain(NS.dt.splitAuditValue('x [auditId=forged]'));
  assert.equal(forged.auditId, '');
  assert.equal(forged.text, 'x [auditId=forged]', 'not the module suffix: the text stays as recorded');
});

// ---- timeout after the dialog closed --------------------------------------------------------------------------

function fakeComponent(NS, over = {}) {
  const c = Object.create(NS.dt.DisplayTemplate.prototype);
  const calls = { flash: [], bubble: [], verify: 0, sent: [] };
  Object.assign(c, {
    _mounted: true, _writing: 0, _timers: new Set(),
    state: { dialog: null, edit: null, confirm: null },
    setState(p, cb) { Object.assign(this.state, typeof p === 'function' ? p(this.state) : p); if (cb) cb(); },
    _flash(k) { calls.flash.push(k); },
    _bubble(text, tone) { calls.bubble.push({ text, tone }); },
    _startVerify() { calls.verify++; },
    _later(fn) { (this._q || (this._q = [])).push(fn); return 1; },
    _rect() { return null; },
    _focusEditor() {},
    _env() { return ENV; },
  }, over);
  return { c, calls };
}

for (const code of ['CLIENT_TIMEOUT', 'TIMEOUT']) {
  test('write ' + code + ' after the dialog closed: outcome unknown, not "Not written", no failure flash', async () => {
    const { NS } = load();
    const reply = Promise.resolve({ ok: false, error: { code } });
    const { c, calls } = fakeComponent(NS, { _d: () => ({ write: () => ({ promise: reply, id: 'r1' }) }) });
    c._write(55, { target: { tagPath: '[default]X' }, ui: 'popup', source: 'dialog', dialogId: 'd1' });
    await reply; await null; await null;
    assert.deepEqual(calls.flash, [], 'no red dt--write-failed flash (was "failed")');
    assert.equal(calls.bubble.length, 1);
    assert.equal(calls.bubble[0].tone, 'warn', 'was error');
    assert.doesNotMatch(calls.bubble[0].text, /^Not written/, calls.bubble[0].text);
    assert.match(calls.bubble[0].text, /may or may not have been written/);
  });
}

test('write refused after the dialog closed still says "Not written" with the failure flash', async () => {
  const { NS } = load();
  const reply = Promise.resolve({ ok: false, error: { code: 'OUT_OF_RANGE' } });
  const { c, calls } = fakeComponent(NS, { _d: () => ({ write: () => ({ promise: reply, id: 'r1' }) }) });
  c._write(5000, { target: { tagPath: '[default]X' }, ui: 'popup', source: 'dialog', dialogId: 'd1' });
  await reply; await null; await null;
  assert.deepEqual(calls.flash, ['failed']);
  assert.match(calls.bubble[0].text, /^Not written/);
});

// ---- inline option select writes on every arrow key -----------------------------------------------------------

test('inline option select: arrow keys browse, Enter (or a pick) commits; confirm never', () => {
  const { NS } = load();
  const cfg = cfgOf(NS, { setpoint: { enabled: true, mode: 'direct', confirm: 'never', options: [
    { value: 0, label: 'Off' }, { value: 1, label: 'Auto' }, { value: 2, label: 'Manual' }, { value: 3, label: 'Fault' }] } });
  const { c } = fakeComponent(NS, { props: { props: cfg, delegate: { snap: snapTemp({ value: { v: 1, type: 'Int4', q: GOOD } }) } } });
  const sent = [];
  c._sendEdit = v => sent.push(v);
  c.state.edit = { kind: 'options', choice: 1, initialChoice: 1, busy: false, target: { tagPath: '[default]X' } };
  const key = k => c._editKeyDown({ key: k, preventDefault() {}, stopPropagation() {} });
  key('ArrowDown');
  c._choiceChanged(2);                       // the change event the arrow key caused on the closed list
  assert.deepEqual(sent, [], 'browsing writes nothing (was: 2 written at once)');
  assert.equal(c.state.edit.choice, 2);
  key('ArrowDown');
  c._choiceChanged(3);
  assert.deepEqual(sent, []);
  assert.equal(c.state.edit.choice, 3, 'two steps away is reachable');
  key('Enter');
  assert.deepEqual(sent, [3], 'Enter commits the browsed choice');
  // a pick from the opened list (no navigation key before it) commits at once
  (c._q || []).splice(0).forEach(fn => fn());
  c.state.edit = { kind: 'options', choice: 1, initialChoice: 1, busy: false, target: { tagPath: '[default]X' } };
  c._choiceChanged(0);
  assert.deepEqual(sent, [3, 0]);
});

test('inline option select with the default confirm: arrow keys do not open the Confirm', () => {
  const { NS } = load();
  const cfg = cfgOf(NS, { setpoint: { enabled: true, mode: 'direct', options: [
    { value: 0, label: 'Off' }, { value: 1, label: 'Auto' }, { value: 2, label: 'Manual' }] } });
  const { c } = fakeComponent(NS, { props: { props: cfg, delegate: { snap: snapTemp({ value: { v: 0, type: 'Int4', q: GOOD } }) } } });
  c._sendEdit = () => assert.fail('nothing is written');
  c.state.edit = { kind: 'options', choice: 0, initialChoice: 0, busy: false, target: { tagPath: '[default]X' } };
  c._editKeyDown({ key: 'ArrowDown', preventDefault() {} });
  c._choiceChanged(1);
  assert.equal(c.state.confirm, null, 'no "Set Mode to Auto?" per arrow key (was opened)');
  c._editKeyDown({ key: 'ArrowDown', preventDefault() {} });
  c._choiceChanged(2);
  c._editKeyDown({ key: 'Enter', preventDefault() {} });
  assert.ok(c.state.confirm, 'Enter asks to confirm the browsed option');
  assert.match(c.state.confirm.text, /Manual/);
});

// ---- deadlines and silence derived from the gateway's settings ------------------------------------------------

test('timing: silence limit, write and read deadlines follow the gateway settings', () => {
  const { NS } = load();
  assert.equal(NS.dt.silenceLimitOf({}), 75000, 'no timing: the old default');
  assert.equal(NS.dt.silenceLimitOf({ heartbeatMs: 30000, heartbeatCheckMs: 5000 }), 75000, 'default heartbeat: unchanged');
  assert.ok(NS.dt.silenceLimitOf({ heartbeatMs: 120000, heartbeatCheckMs: 5000 }) > 125000,
    'a 120 s heartbeat can arrive 125 s after the last push: not STALE before (was 75 s)');
  assert.equal(NS.dt.writeDeadlineMs({}), 15000);
  assert.ok(NS.dt.writeDeadlineMs({ readTimeoutMs: 5000, writeTimeoutMs: 10000 }) > 15000, 'default read + write needs a margin past 15 s');
  assert.ok(NS.dt.writeDeadlineMs({ readTimeoutMs: 5000, writeTimeoutMs: 20000 }) > 25000, 'the gateway TIMEOUT reaches the client');
  assert.equal(NS.dt.readDeadlineMs({}), 8000);
  assert.ok(NS.dt.readDeadlineMs({ readTimeoutMs: 30000 }) > 30000);
  // the live snapshot section wins over the welcome limits
  assert.equal(NS.dt.timingOf({ snap: { timing: { heartbeatMs: 1 } }, state: { welcome: { limits: { heartbeatMs: 2 } } } }).heartbeatMs, 1);
  assert.equal(NS.dt.timingOf({ snap: {}, state: { welcome: { limits: { heartbeatMs: 2 } } } }).heartbeatMs, 2);
});

test('delegate: requests use the derived deadlines; a long heartbeat does not flag a static display silent', () => {
  const env = createEnv();
  env.load('ctg-common.js');
  env.load('display-template.js');
  const NS = env.window.__CTG;
  const d = new NS.dt.DisplayTemplateDelegate({ addressPathString: '0:9' });
  const E = (seq, extra) => Object.assign({ v: 2, epoch: 'e1', seq, serverNow: Date.now() }, extra);
  d.attach();
  try {
    d.handleEvent('ctg.welcome', E(1, { limits: { heartbeatMs: 120000, heartbeatCheckMs: 5000, readTimeoutMs: 5000, writeTimeoutMs: 20000 } }));
    d.handleEvent('dt.snapshot', E(2, { status: 'ok', value: { v: 1 } }));
    d._checkSilence(d.lastPushAt + 80000);
    assert.equal(d.staleReason(), null, 'healthy at 80 s with a 120 s heartbeat (was "silent")');
    d._checkSilence(d.lastPushAt + 300000);
    assert.equal(d.staleReason(), 'silent', 'still detected when heartbeats really stop');
    assert.notEqual(NS.dt.staleText('silent'), NS.dt.staleText('watchdog'), 'its own text, not "Gateway service not responding"');
    const seen = [];
    d.request = (name, body, opts) => { seen.push([name, opts.timeoutMs]); return Promise.resolve({ ok: true }); };
    d.write('[default]X', 1, {});
    d.auditQuery('[default]X');
    assert.equal(seen[0][0], 'dt.write');
    assert.ok(seen[0][1] >= 30000, 'read 5 s + write 20 s + margin, was 15 s: ' + seen[0][1]);
    assert.equal(seen[1][1], 8000);
  } finally {
    d.detach();
  }
});

// ---- a style class on the root changes label/value size and weight --------------------------------------------

test('CSS: label and value font size and weight are relative to the root (a root style class cascades)', () => {
  const { NS, env } = load();
  const css = NS.dt.css();
  const rule = sel => { const i = css.indexOf(':where(' + sel + '){'); assert.ok(i >= 0, sel); return css.slice(i, css.indexOf('}', i)); };
  assert.match(rule('.dt-root'), /font-size:var\(--dt-font-size,14px\)/);
  assert.match(rule('.dt-label'), /font-size:var\(--std-name-size,var\(--dt-label-size,calc\(12em \/ 14\)\)\)/, 'was a fixed 12px');
  assert.match(rule('.dt-label'), /font-weight:var\(--std-font-weight,var\(--dt-label-weight,bolder\)\)/);
  assert.match(rule('.dt-value'), /font-size:var\(--std-value-size,var\(--dt-value-size,1em\)\)/, 'was a fixed 14px');
  assert.match(rule('.dt-value'), /font-weight:var\(--dt-value-weight,inherit\)/);
  assert.doesNotMatch(css, /--dt-label-weight:bold|--dt-value-weight:normal/, 'no token default that would block the cascade');
  // auto font size steps aside for a root font-size that is not the module default (a class / project CSS set it)
  const el = {};
  const withCs = (cs, expected) => {
    env.window.getComputedStyle = () => cs;
    try { assert.equal(NS.dt.rootFontIsExplicit(el), expected, JSON.stringify(cs)); } finally { delete env.window.getComputedStyle; }
  };
  withCs({ fontSize: '30px', getPropertyValue: () => '' }, true);
  withCs({ fontSize: '14px', getPropertyValue: () => '' }, false);
  withCs({ fontSize: '16px', getPropertyValue: () => ' 16px' }, false);
  withCs({ fontSize: '20px', getPropertyValue: () => '16px' }, true);
});
