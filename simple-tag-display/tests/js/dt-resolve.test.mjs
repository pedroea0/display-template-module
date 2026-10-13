// =============================================================================
// dt-resolve.test.mjs — Display Template pure evaluation (resolve and helpers)
// =============================================================================
// NS.dt.resolve / evalAlarm / evalBounds / writeGuard / stepCheck / menuModel
// and the small editing helpers, driven with snapshots shaped exactly like the
// gateway's dt.snapshot (DisplayTemplateDelegate.buildSnapshot): status,
// tagPath, tagName, value {v,t,type,q}, meta, history, alarms {live, hasActive,
// hasUnacked, highestActivePriority, highestUnackedPriority, limits}, capabilities,
// trend, writeLimits.
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
/** A gateway-shaped ok snapshot of [default]CTG/Temp (Float8, degF 0..100, alarms live). */
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

test('evalAlarm: priority names and ints, basis, minPriority, unacked', () => {
  const { NS } = load();
  const cfg = cfgOf(NS, {});
  const al = a => snapTemp({ alarms: Object.assign({ live: true, hasActive: false, hasUnacked: false, highestActivePriority: null, highestUnackedPriority: null, limits: {} }, a) });
  const ev = (c, s) => { const r = NS.dt.evalAlarm(c, s, { kind: 'number', numeric: 50 }); return r && plain(r); };
  assert.equal(ev(cfg, al({})), null, 'no alarm active');
  assert.deepEqual(ev(cfg, al({ hasActive: true, highestActivePriority: 'High' })), { priority: 3, unacked: false, source: 'live', name: 'High', key: 'high' });
  assert.equal(ev(cfg, al({ hasActive: true, highestActivePriority: 4 })).name, 'Critical', 'ints 0..4 accepted');
  // unacked: coloured priority equals the highest unacked one
  assert.equal(ev(cfg, al({ hasActive: true, highestActivePriority: 'High', hasUnacked: true, highestUnackedPriority: 'High' })).unacked, true);
  // with basis 'activeOrUnacked' (default) any unacknowledged alarm at or above minPriority blinks, even
  // a lower one than the active colour; with basis 'active' only when the unacked priority is the coloured one
  assert.equal(ev(cfg, al({ hasActive: true, highestActivePriority: 'High', hasUnacked: true, highestUnackedPriority: 'Low' })).unacked, true);
  assert.equal(ev(cfgOf(NS, { alarms: { basis: 'active' } }), al({ hasActive: true, highestActivePriority: 'High', hasUnacked: true, highestUnackedPriority: 'Low' })).unacked, false);
  // cleared but unacknowledged: activeOrUnacked colours, active does not
  const cleared = al({ hasUnacked: true, highestUnackedPriority: 'Critical' });
  assert.equal(ev(cfg, cleared).name, 'Critical');
  assert.equal(ev(cfgOf(NS, { alarms: { basis: 'active' } }), cleared), null);
  // minPriority
  assert.equal(ev(cfgOf(NS, { alarms: { minPriority: 'High' } }), al({ hasActive: true, highestActivePriority: 'Medium' })), null);
  assert.equal(ev(cfg, al({ hasActive: true, highestActivePriority: 'Diagnostic' })), null, 'default minPriority Low hides Diagnostic');
});

test('evalAlarm: thresholds fallback, highest wins, ties keep the first, never blink; colorMode', () => {
  const { NS } = load();
  const th = [{ priority: 'Medium', above: 200 }, { priority: 'Critical', above: 260 }, { priority: 'Low', below: 20, inclusive: false }];
  const noLive = snapTemp({ alarms: { live: false, hasActive: false, hasUnacked: false, highestActivePriority: null, highestUnackedPriority: null, limits: {} } });
  const auto = cfgOf(NS, { alarms: { thresholds: th } });
  const ev = (c, s, x) => { const r = NS.dt.evalAlarm(c, s, { kind: 'number', numeric: x }); return r && r.name; };
  assert.equal(ev(auto, noLive, 199), null);
  assert.equal(ev(auto, noLive, 200), 'Medium', 'inclusive by default');
  assert.equal(ev(auto, noLive, 300), 'Critical');
  assert.equal(ev(auto, noLive, 20), null, 'exclusive below');
  assert.equal(ev(auto, noLive, 19.9), 'Low');
  const tie = cfgOf(NS, { alarms: { thresholds: [{ priority: 'High', above: 1 }, { priority: 'High', below: 100 }] } });
  assert.equal(NS.dt.evalAlarm(tie, noLive, { kind: 'number', numeric: 50 }).unacked, false);
  // auto with live data ignores the thresholds; 'thresholds' mode ignores live; 'off' nothing; 'live' never thresholds
  const live = snapTemp({ alarms: { live: true, hasActive: false, hasUnacked: false, highestActivePriority: null, highestUnackedPriority: null, limits: {} } });
  assert.equal(ev(auto, live, 300), null, 'tag has alarms (live): thresholds not used in auto');
  assert.equal(ev(cfgOf(NS, { alarms: { thresholds: th, colorMode: 'thresholds' } }), live, 300), 'Critical');
  assert.equal(ev(cfgOf(NS, { alarms: { thresholds: th, colorMode: 'off' } }), noLive, 300), null);
  assert.equal(ev(cfgOf(NS, { alarms: { thresholds: th, colorMode: 'live' } }), noLive, 300), null);
  // non-numeric values never match thresholds
  assert.equal(NS.dt.evalAlarm(auto, noLive, { kind: 'string', numeric: null }), null);
});

test('evalBounds: override \u2192 alarm setpoint \u2192 EngLow/High; inclusive edges; low > high skipped', () => {
  const { NS } = load();
  const s = snapTemp({ meta: Object.assign(snapTemp().meta, { engLow: 1, engHigh: 5 }) });
  const b = (props, x, snap = s) => { const r = NS.dt.evalBounds(cfgOf(NS, { bounds: Object.assign({ enabled: true }, props) }), snap, { kind: 'number', numeric: x }, '#,##0.0'); return r && r.state; };
  assert.equal(b({}, 1.0), null, 'at EngLow: in range (inclusive)');
  assert.equal(b({}, 5.0), null);
  assert.equal(b({}, 0.99), 'low');
  assert.equal(b({}, 5.01), 'high');
  assert.equal(b({ inclusive: false }, 1.0), 'low');
  assert.equal(b({ low: 2 }, 1.5), 'low', 'override wins');
  assert.equal(b({ low: 6, high: 2 }, 1.5), null, 'low > high: both skipped');
  assert.equal(b({ useEngLimits: false }, 0), null, 'no source: side skipped');
  const withAlarm = snapTemp({ alarms: { live: true, hasActive: false, hasUnacked: false, highestActivePriority: null, highestUnackedPriority: null,
    limits: { low: { name: 'Low', value: 10 }, high: null } } });
  assert.equal(b({ lowAlarmName: 'Low' }, 9, withAlarm), 'low', 'low = SetpointA of the named alarm');
  assert.equal(b({ lowAlarmName: 'Low' }, 11, withAlarm), null);
  assert.equal(b({ lowAlarmName: 'Low', useAlarmLimits: false }, 9, withAlarm), null, 'falls back to EngLow 0');
  // compareDisplayed: 99.96 shown as 100.0 counts as 100.0
  const hi = snapTemp();
  const raw = NS.dt.evalBounds(cfgOf(NS, { bounds: { enabled: true, high: 99.95, inclusive: true } }), hi, { kind: 'number', numeric: 99.96 }, '#,##0.0');
  const disp = NS.dt.evalBounds(cfgOf(NS, { bounds: { enabled: true, high: 100, inclusive: true, compareDisplayed: true } }), hi, { kind: 'number', numeric: 100.04 }, '#,##0.0');
  assert.equal(raw.state, 'high');
  assert.equal(disp.state, null);
  assert.equal(NS.dt.evalBounds(cfgOf(NS, { bounds: { enabled: true } }), hi, { kind: 'boolean', numeric: 1 }, ''), null, 'only numbers');
});

test('resolve: data states, error texts, quality marks, stale, designer hint', () => {
  const { NS } = load();
  const cfg = cfgOf(NS, {});
  const r = (snap, extra = {}, env = ENV) => NS.dt.resolve(cfg, D(snap, extra), env);
  const live = r(snapTemp());
  assert.equal(live.state, 'LIVE');
  assert.equal(live.valueText, '72.3', 'tag Format String #,##0.0');
  assert.equal(live.unitsText, 'degF');
  assert.ok(live.rootClasses.includes('dt--q-good'));
  assert.equal(r(null).state, 'CONNECTING');
  assert.equal(r(null).valueText, '\u2026');
  assert.equal(r({ status: 'loading', tagPath: '[default]CTG/Temp' }).state, 'LOADING');
  const un = r({ status: 'noTagPath', tagPath: '' });
  assert.equal(un.state, 'UNCONFIGURED');
  assert.equal(un.valueText, '\u2014');
  assert.equal(r({ status: 'noTagPath', tagPath: '' }, {}, Object.assign({}, ENV, { designer: true })).valueText, 'Set tagPath');
  const nf = r({ status: 'notFound', tagPath: '[default]CTG/Nope', tagName: 'Nope' });
  assert.equal(nf.valueText, 'Tag not found');
  assert.ok(nf.rootClasses.includes('dt--error'));
  assert.match(nf.valueTitle, /\[default\]CTG\/Nope was not found/);
  assert.equal(r({ status: 'invalidPath', tagPath: 'x.EngUnit' }).valueText, 'Invalid tag path');
  assert.equal(r({ status: 'accessDenied', tagPath: 'x', value: { v: null, q: { level: 'bad', name: 'Bad_AccessDenied' } } }).valueText, 'No access');
  // quality: value kept + mark; hideValueOnBad opt-in; uncertain only with markUncertain
  const bad = r(snapTemp({ value: { v: 5.5, type: 'Float8', q: { code: -2147483136, name: 'Bad_NotConnected', level: 'bad' } } }));
  assert.equal(bad.valueText, '5.5');
  assert.equal(bad.qualityMark, 'bad');
  assert.ok(bad.rootClasses.includes('dt--q-bad') && bad.rootClasses.includes('dt--qmark-bad'));
  assert.match(bad.ariaLabel, /Bad quality/);
  const hid = NS.dt.resolve(cfgOf(NS, { quality: { hideValueOnBad: true } }), D(snapTemp({ value: { v: 5.5, type: 'Float8', q: { level: 'bad', name: 'Bad' } } })), ENV);
  assert.equal(hid.valueText, 'Bad quality');
  const unc = { v: 1, type: 'Float8', q: { level: 'uncertain', name: 'Uncertain_LastKnownValue' } };
  assert.equal(r(snapTemp({ value: unc })).qualityMark, 'uncertain');
  assert.equal(NS.dt.resolve(cfgOf(NS, { quality: { markUncertain: false } }), D(snapTemp({ value: unc })), ENV).qualityMark, null);
  // stale keeps the value and adds the flag
  const st = r(snapTemp(), { stale: true, staleReason: 'disconnected' });
  assert.equal(st.valueText, '72.3');
  assert.ok(st.rootClasses.includes('dt--stale'));
  assert.match(st.ariaLabel, /not connected/);
  assert.equal(r(snapTemp(), { stale: true, staleReason: 'watchdog' }).staleText, 'Gateway service not responding');
});

test('resolve: label, units placement, row suffix, states and Boolean texts, units only for numbers', () => {
  const { NS } = load();
  const s = snapTemp();
  assert.equal(NS.dt.resolve(cfgOf(NS, { label: { text: 'Tank' } }), D(s), ENV).labelDisplay, 'Tank');
  assert.equal(NS.dt.resolve(cfgOf(NS, { units: { placement: 'label' } }), D(s), ENV).labelDisplay, 'Temp (degF)');
  assert.equal(NS.dt.resolve(cfgOf(NS, { layout: { direction: 'row' } }), D(s), ENV).labelDisplay, 'Temp:');
  assert.equal(NS.dt.resolve(cfgOf(NS, { units: { text: '\u00B0C' } }), D(s), ENV).unitsText, '\u00B0C');
  assert.equal(NS.dt.resolve(cfgOf(NS, { units: { visible: false } }), D(s), ENV).unitsText, '');
  const run = snapTemp({ value: { v: true, type: 'Boolean', q: GOOD }, meta: Object.assign({}, s.meta, { dataType: 'Boolean', engUnit: 'x' }) });
  const rb = NS.dt.resolve(cfgOf(NS, { states: { boolean: { trueText: 'Running', falseText: 'Stopped' } } }), D(run), ENV);
  assert.equal(rb.valueText, 'Running');
  assert.equal(rb.unitsText, '', 'never units on Boolean values');
  const mode = snapTemp({ value: { v: 2, type: 'Int4', q: GOOD }, meta: Object.assign({}, s.meta, { dataType: 'Int4', formatString: '#,##0.##' }) });
  const opts = [{ value: 0, label: 'Off' }, { value: 1, label: 'Auto' }, { value: 2, label: 'Manual' }];
  assert.equal(NS.dt.resolve(cfgOf(NS, { states: { options: opts } }), D(mode), ENV).valueText, 'Manual');
  assert.equal(NS.dt.resolve(cfgOf(NS, { states: { options: opts, unmatchedText: '?' } }), D(snapTemp({ value: { v: 9, type: 'Int4', q: GOOD } })), ENV).valueText, '?');
  // setpoint.options labels are used when states.options is empty (useSetpointOptions)
  assert.equal(NS.dt.resolve(cfgOf(NS, { setpoint: { options: [{ value: 2, label: 'Hand' }] } }), D(mode), ENV).valueText, 'Hand');
  assert.equal(NS.dt.resolve(cfgOf(NS, { setpoint: { options: [{ value: 2, label: 'Hand' }] }, states: { useSetpointOptions: false } }), D(mode), ENV).valueText, '2');
});

test('resolve: alarm / bounds / setpoint classes and blink variants', () => {
  const { NS } = load();
  const al = snapTemp({ alarms: { live: true, hasActive: true, hasUnacked: true, highestActivePriority: 'High', highestUnackedPriority: 'High', limits: {} } });
  const c1 = NS.dt.resolve(cfgOf(NS, {}), D(al), ENV).rootClasses;
  for (const k of ['dt--alarm', 'dt--alarm-high', 'dt--alarm-bg', 'dt--alarm-unacked', 'dt--blink-indicator']) assert.ok(c1.includes(k), k);
  assert.ok(NS.dt.resolve(cfgOf(NS, { alarms: { indicatorVisible: false } }), D(al), ENV).rootClasses.includes('dt--blink-outline'));
  assert.ok(NS.dt.resolve(cfgOf(NS, { alarms: { blink: 'value', applyTo: 'component' } }), D(al), ENV).rootClasses.includes('dt--blink-value'));
  assert.ok(!NS.dt.resolve(cfgOf(NS, { alarms: { blink: 'off' } }), D(al), ENV).rootClasses.some(c => /blink/.test(c)));
  const hi = snapTemp({ value: { v: 120, type: 'Float8', q: GOOD } });
  const c2 = NS.dt.resolve(cfgOf(NS, { bounds: { enabled: true } }), D(hi), ENV).rootClasses;
  for (const k of ['dt--high', 'dt--bounds-border', 'dt--bounds-glyph']) assert.ok(c2.includes(k), k);
  const c3 = NS.dt.resolve(cfgOf(NS, { setpoint: { enabled: true } }), D(snapTemp()), ENV);
  assert.ok(c3.rootClasses.includes('dt--setpoint'));
  assert.match(c3.ariaLabel, /Press Enter to change/);
  const denied = snapTemp({ capabilities: Object.assign({}, snapTemp().capabilities, { write: cap(false, 'AUTH_REQUIRED') }) });
  const c4 = NS.dt.resolve(cfgOf(NS, { setpoint: { enabled: true } }), D(denied), ENV);
  assert.ok(c4.rootClasses.includes('dt--setpoint-denied'));
  assert.equal(c4.guard.text, 'Log in to change this value.');
  assert.ok(!NS.dt.resolve(cfgOf(NS, { setpoint: { enabled: true, whenNotAllowed: 'hide' } }), D(denied), ENV).rootClasses.some(c => /setpoint/.test(c)));
  assert.ok(NS.dt.resolve(cfgOf(NS, { enabled: false }), D(snapTemp()), ENV).rootClasses.includes('dt--disabled'));
  assert.ok(NS.dt.resolve(cfgOf(NS, {}), D(snapTemp()), Object.assign({}, ENV, { designMode: true, canInteract: false })).rootClasses.includes('dt--design'));
});

test('writeGuard: stale, frame, loading, statuses, unsupported types, capability reasons, bad quality', () => {
  const { NS } = load();
  const sp = cfgOf(NS, { setpoint: { enabled: true } });
  const g = (snap, extra = {}, env = ENV, cfg = sp) => plain(NS.dt.writeGuard(cfg, D(snap, extra), env));
  assert.equal(g(snapTemp()).allowed, true);
  assert.equal(g(snapTemp()).kind, 'float');
  assert.equal(g(snapTemp(), { stale: true, staleReason: 'disconnected' }).code, 'STALE');
  assert.equal(g(snapTemp(), {}, Object.assign({}, ENV, { frameBlocked: true })).text, 'Editing is disabled inside a frame from another site.');
  assert.equal(g(null).code, 'LOADING');
  assert.equal(g({ status: 'notFound', tagPath: 'x' }).code, 'TAG_NOT_FOUND');
  const date = snapTemp({ value: { v: 1, type: 'DateTime', q: GOOD }, meta: Object.assign({}, snapTemp().meta, { dataType: 'DateTime' }) });
  assert.equal(g(date).code, 'UNSUPPORTED_TYPE');
  assert.equal(g(date).text, 'Cannot write DateTime values');
  const ro = snapTemp({ capabilities: Object.assign({}, snapTemp().capabilities, { write: cap(false, 'READ_ONLY') }) });
  assert.equal(g(ro).text, 'This tag is read-only.');
  const badQ = snapTemp({ value: { v: 1, type: 'Float8', q: { level: 'bad', name: 'Bad' } } });
  assert.equal(g(badQ).code, 'BAD_QUALITY');
  assert.equal(g(badQ, {}, ENV, cfgOf(NS, { setpoint: { enabled: true, allowOnBadQuality: true } })).allowed, true);
  // Designer preview parity: design mode shows the runtime affordance (setpoint colour / icon), marked
  // as a preview so nothing can act on it; it was hidden before, so the Designer never showed setpoint.color
  const dg = g(snapTemp(), {}, Object.assign({}, ENV, { canInteract: false }));
  assert.equal(dg.show, true, 'design mode: same affordance as runtime');
  assert.equal(dg.preview, true, 'design mode: preview only');
  assert.equal(g(snapTemp(), {}, ENV, cfgOf(NS, { enabled: false, setpoint: { enabled: true } })).show, false);
  assert.equal(g(snapTemp({ value: { v: 1, type: 'Int4', q: GOOD } }), {}, ENV, cfgOf(NS, { setpoint: { enabled: true, options: [{ value: 1 }] } })).kind, 'options');
});

test('step guard and confirm-above: abs and percent limits, unknown current value', () => {
  const { NS } = load();
  const c = props => cfgOf(NS, { setpoint: Object.assign({ enabled: true }, props) });
  const s = snapTemp({ value: { v: 75, type: 'Float8', q: GOOD } });
  assert.deepEqual(plain(NS.dt.stepCheck(c({}), s, 1000)), { ok: true }, 'no guard');
  assert.deepEqual(plain(NS.dt.stepCheck(c({ maxStep: 10 }), s, 85)), { ok: true });
  assert.deepEqual(plain(NS.dt.stepCheck(c({ maxStep: 10 }), s, 86)), { ok: false, max: 10, delta: 11 });
  assert.equal(NS.dt.stepCheck(c({ maxStepPercent: 5 }), s, 81).max, 5, '5 % of 0..100');
  assert.equal(NS.dt.stepCheck(c({ maxStep: 3, maxStepPercent: 5 }), s, 81).max, 3, 'the smaller one');
  const nullTag = snapTemp({ value: { v: null, type: 'Float8', q: GOOD } });
  assert.deepEqual(plain(NS.dt.stepCheck(c({ maxStep: 10 }), nullTag, 5)), { ok: false, max: 10, unknown: true });
  assert.equal(NS.dt.maxStepOf(c({ maxStepPercent: 5 }), snapTemp({ writeLimits: null })), null, 'percent needs a range');
  // gateway reply STALE_TOO_LARGE {delta:null, previous:'notFinite'} gets its own wording
  assert.match(NS.dt.errText({ code: 'STEP_TOO_LARGE', details: { max: 10, delta: null, previous: 'notFinite' } }), /Current value unknown .*max \u00B110/);
  assert.equal(NS.dt.errText({ code: 'STEP_TOO_LARGE', details: { max: 10, delta: 15 } }), 'Change is larger than allowed (max \u00B110).');
  assert.equal(NS.dt.errText({ code: 'OUT_OF_RANGE', details: { low: 0, high: 100 } }), 'Must be between 0 and 100.');
  assert.equal(NS.dt.errText({ code: 'SOMETHING_NEW', message: 'gateway text' }), 'gateway text');
  // confirmAbovePercent
  assert.equal(NS.dt.bigChange(c({ confirmAbovePercent: 20 }), s, 90), null);
  assert.equal(Math.round(NS.dt.bigChange(c({ confirmAbovePercent: 20 }), s, 100).pct), 25);
  assert.equal(NS.dt.rangeText(c({}), s, { locale: 'en-US' }, 'degF'), '0.0\u00A0degF \u2013 100.0\u00A0degF (inclusive)');
});

test('menu model: order, separators, trend reasons, stale/loading, whenNotAllowed hide, custom access', () => {
  const { NS } = load();
  const all = cfgOf(NS, { setpoint: { enabled: true }, menu: { trendPage: { enabled: true }, trendPopup: { enabled: true },
    configEdit: { enabled: true }, changeHistory: { enabled: true }, copyPath: { enabled: true },
    items: [{ id: 'faceplate', label: 'Faceplate' }, { id: 'eng', label: 'Engineering', access: { roles: ['Engineer'] } }] } });
  const guard = { allowed: true };
  const m = NS.dt.menuModel(all, snapTemp(), { guard, user: { authenticated: true, roles: ['Operator'], levels: [] } });
  assert.deepEqual(plain(m.items.map(i => i.id)), ['trend', 'trendPage', 'trendPopup', 'setValue', 'configEdit', 'changeHistory', 'copyPath', 'custom:faceplate', 'custom:eng']);
  assert.deepEqual(plain(m.items.filter(i => i.separatorBefore).map(i => i.id)), ['setValue', 'copyPath', 'custom:faceplate']);
  assert.equal(m.items[0].label, 'Trend Tag');
  assert.equal(m.items.find(i => i.id === 'custom:eng').hint, 'Not permitted');
  assert.equal(m.header.title, 'Temp');
  assert.equal(m.header.subtitle, '[default]CTG/Temp');
  // trending → remove label; NO_HISTORY replaces the label with the reason as hint
  assert.equal(NS.dt.menuModel(all, snapTemp({ trend: { group: 'default', trending: true, count: 1, max: 32 } }), { guard }).items[0].label, 'Remove from Trend');
  const noHist = snapTemp({ history: { available: false, enabled: false, provider: null, reason: 'disabled' },
    capabilities: Object.assign({}, snapTemp().capabilities, { trend: cap(false, 'NO_HISTORY') }) });
  const nh = NS.dt.menuModel(all, noHist, { guard }).items[0];
  assert.equal(nh.label, 'No history available');
  assert.equal(nh.hint, 'History is not enabled for this tag');
  assert.equal(nh.disabled, true);
  const full = NS.dt.menuModel(all, snapTemp({ trend: { group: 'default', trending: false, count: 32, max: 32 } }), { guard }).items[0];
  assert.equal(full.hint, 'Trend list full (32)');
  const auth = snapTemp({ capabilities: Object.assign({}, snapTemp().capabilities, { trend: cap(false, 'AUTH_REQUIRED'), configEdit: cap(false, 'FORBIDDEN_ROLE'),
    changeHistory: cap(false, 'AUDIT_UNAVAILABLE') }) });
  const ma = NS.dt.menuModel(all, auth, { guard });
  assert.equal(ma.items[0].hint, 'Log in to trend');
  assert.equal(ma.items.find(i => i.id === 'configEdit').hint, 'Not permitted');
  assert.equal(ma.items.find(i => i.id === 'changeHistory').hint, 'No audit log is configured');
  // stale / loading: every gateway item disabled; UI-only items stay enabled
  const ms = NS.dt.menuModel(all, snapTemp(), { stale: true, staleReason: 'disconnected', guard: { allowed: false, text: 'x' } });
  assert.equal(ms.items.find(i => i.id === 'trend').hint, 'Not connected');
  assert.equal(ms.items.find(i => i.id === 'trendPage').disabled, undefined);
  assert.equal(NS.dt.menuModel(all, null, { guard: { allowed: false } }).items[0].hint, 'Loading\u2026');
  // whenNotAllowed: hide
  const hide = cfgOf(NS, { menu: { whenNotAllowed: 'hide', configEdit: { enabled: true } } });
  assert.deepEqual(plain(NS.dt.menuModel(hide, auth, { guard }).items.map(i => i.id)), []);
  // frame guard: config edit and change history disabled
  assert.equal(NS.dt.menuModel(all, snapTemp(), { guard, frameBlocked: true }).items.find(i => i.id === 'configEdit').hint,
    'Editing is disabled inside a frame from another site.');
});

test('custom item access (advisory): login, roles, security levels', () => {
  const { NS } = load();
  const deny = NS.dt.accessDenied;
  const anon = { authenticated: false, roles: [], levels: [] };
  const op = { authenticated: true, roles: ['Operator'], levels: NS.dt.levelPaths([{ name: 'Authenticated', children: [{ name: 'Roles', children: [{ name: 'Operator', children: [] }] }] }], '', []) };
  assert.equal(deny({ roles: [], securityLevels: [], requireLogin: true }, anon), 'AUTH_REQUIRED');
  assert.equal(deny({ roles: ['Operator'], securityLevels: [], requireLogin: false }, op), null);
  assert.equal(deny({ roles: ['operator'], securityLevels: [], requireLogin: false }, op), 'FORBIDDEN_ROLE', 'exact role names');
  assert.equal(deny({ roles: [], securityLevels: ['Authenticated/Roles/Operator'], requireLogin: false }, op), null);
  assert.equal(deny({ roles: [], securityLevels: ['SecurityZones/ControlRoom'], requireLogin: false }, op), 'FORBIDDEN_ROLE');
});

test('editing helpers: edit text, \u00B1 toggle, spinner steps clamped to limits, inputmode rule', () => {
  const { NS } = load();
  assert.equal(NS.dt.editText(snapTemp({ value: { v: 72.5, type: 'Float8' } }), 'en-US'), '72.5');
  assert.equal(NS.dt.editText(snapTemp({ value: { v: 72.5, type: 'Float8' } }), 'de-DE'), '72,5');
  assert.equal(NS.dt.editText(snapTemp({ value: { v: 0.1 + 0.2, type: 'Float8' } }), 'en-US'), '0.3', '15 significant digits');
  assert.equal(NS.dt.editText(snapTemp({ value: { v: '9007199254740993', bigint: true, type: 'Int8' } }), 'en-US'), '9007199254740993');
  assert.equal(NS.dt.editText(snapTemp({ value: { v: null } }), 'en-US'), '');
  assert.equal(NS.dt.negateText('5'), '-5');
  assert.equal(NS.dt.negateText('-5'), '5');
  assert.equal(NS.dt.negateText('+5'), '-5');
  const s = snapTemp();
  assert.equal(NS.dt.stepText('99.5', 1, 1, s, 'en-US', 'float'), '100', 'clamped to the high limit');
  assert.equal(NS.dt.stepText('0.2', 1, 0.1, s, 'en-US', 'float'), '0.3');
  assert.equal(NS.dt.stepText('abc', 1, 1, s, 'en-US', 'float'), null);
  assert.equal(NS.dt.stepText('1,5', 1, 1, s, 'de-DE', 'float'), '2,5');
  assert.deepEqual(plain(NS.dt.numericInputMode('float', s)), { inputMode: 'decimal', needsSign: false });
  assert.deepEqual(plain(NS.dt.numericInputMode('int', s)), { inputMode: 'numeric', needsSign: false });
  assert.deepEqual(plain(NS.dt.numericInputMode('float', snapTemp({ writeLimits: { low: -50, high: 50, inclusive: true } }))), { inputMode: 'text', needsSign: true });
  assert.deepEqual(plain(NS.dt.numericInputMode('float', snapTemp({ writeLimits: null }))), { inputMode: 'text', needsSign: true });
  assert.equal(NS.dt.displayTolerance(72.5, '#,##0.0'), 0.05);
  const AID = '0b7c4d2e-1f3a-4b5c-9d6e-7f8a9b0c1d2e';
  assert.deepEqual(plain(NS.dt.splitAuditValue('72.5 (was 71.0) [ui=popup] [auditId=' + AID + ']')), { text: '72.5 (was 71.0)', ui: 'popup', auditId: AID });
  assert.deepEqual(plain(NS.dt.splitAuditValue('72.5 (was 71.0) [ui=popup] [auditId=' + AID + ', late=true]')), { text: '72.5 (was 71.0)', ui: 'popup', auditId: AID });
  assert.deepEqual(plain(NS.dt.splitAuditValue('engUnit degC (was degF)')), { text: 'engUnit degC (was degF)', ui: '', auditId: '' });
});

test('delegate: snapshot + section merge, valueSeq, epoch reset, write ids only for sent requests', async () => {
  const { NS, env } = load();
  const store = { addressPathString: '0:7' };
  const d = new NS.dt.DisplayTemplateDelegate(store);
  d.attach();
  const env2 = { v: 2, epoch: 'e1', serverNow: Date.now() };
  d.handleEvent('ctg.welcome', Object.assign({ seq: 1 }, env2));
  d.handleEvent('dt.snapshot', Object.assign({ seq: 2 }, env2, snapTemp()));
  assert.equal(d.snap.tagName, 'Temp');
  const seq0 = d.valueSeq;
  d.handleEvent('dt.values', Object.assign({ seq: 3 }, env2, { trend: { group: 'default', trending: true, count: 1, max: 32 } }));
  assert.equal(d.snap.trend.trending, true);
  assert.equal(d.snap.meta.engUnit, 'degF', 'other sections kept');
  assert.equal(d.valueSeq, seq0, 'no value section: no value update');
  d.handleEvent('dt.values', Object.assign({ seq: 4 }, env2, { value: { v: 80, type: 'Float8', q: GOOD } }));
  assert.equal(d.valueSeq, seq0 + 1);
  assert.equal(d.mapStateToProps().snap.value.v, 80);
  // a write while disconnected never goes out, so its id must not be remembered for reuse
  env.setConnected(false);
  const w = d.write('[default]CTG/Temp', 5, { ui: 'popup' });
  assert.equal(w.id, null);
  assert.equal((await w.promise).error.code, 'DISCONNECTED');
  env.setConnected(true);
  const w2 = d.write('[default]CTG/Temp', 6, { ui: 'popup', display: 'x'.repeat(100) });
  assert.ok(w2.id && /^dt/.test(w2.id));
  const sent = env.fired.filter(f => f.name === 'dt.write').pop();
  assert.equal(sent.payload.expectedTagPath, '[default]CTG/Temp');
  assert.equal(sent.payload.display.length, 64);
  assert.equal(sent.payload.ui, 'popup');
  // epoch change drops the old snapshot (never shows the old tag's data meanwhile)
  d.handleEvent('dt.values', { v: 2, epoch: 'e2', seq: 1, serverNow: Date.now(), value: { v: 1 } });
  assert.equal(d.snap, null);
  d.detach();
  assert.equal((await w2.promise).error.code, 'DETACHED');
});

test('stylesheet: zero-specificity rules, dark tokens, no colour from props concatenated', () => {
  const { NS } = load();
  const css = NS.dt.css();
  const rules = css.split('\n').filter(l => l && !l.startsWith('@'));
  assert.ok(rules.every(l => l.startsWith(':where(')), 'every element rule is wrapped in :where()');
  assert.match(css, /:where\(:root\[data-ctg-scheme="dark"\]\)\{--dt-low-color:#8FA9C8/);
  assert.match(css, /prefers-reduced-motion:reduce/);
  // bounds rules come before alarm rules (alarm beats bounds at equal specificity)
  assert.ok(css.indexOf('.dt--low.dt--bounds-bg') < css.indexOf('.dt--alarm-critical.dt--alarm-bg'));
  assert.ok(!/javascript:|expression\(/i.test(css));
});
