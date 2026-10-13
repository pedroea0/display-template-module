// =============================================================================
// dt-direct-mode.test.mjs — Display Template: direct setpoint mode and editors
// =============================================================================
// Direct-mode colours, clicks, keys and focus; String / Int8 editor guards,
// integer spinner limits, unmatched-state alarms and the macOS Ctrl+click docs.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnv } from './_stubs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..', '..', '..');

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
    alarms: { live: false, hasActive: false, hasUnacked: false, highestActivePriority: null, highestUnackedPriority: null, limits: { low: null, high: null } },
    capabilities: { write: Object.assign(cap(true), { audit: 'profile' }), configEdit: cap(true), trend: cap(true), changeHistory: cap(true) },
    trend: { group: 'default', trending: false, count: 0, max: 32 },
    writeLimits: { low: 0, high: 100, inclusive: true, source: 'eng' },
  }, over);
}
function cfgOf(NS, props) { return NS.dt.makeReducer()(tree(Object.assign({ tagPath: '[default]CTG/Temp' }, props))); }
const D = (snap, extra = {}) => Object.assign({ snap, stale: false, staleReason: null, phase: 'ready' }, extra);
const ENV = { locale: 'en-US', timeZone: 'UTC', canInteract: true, designMode: false, designer: false, frameBlocked: false };
const meta = (dataType, extra) => Object.assign({}, snapTemp().meta, { dataType, formatString: dataType === 'String' ? '' : '#,##0' }, extra || {});

function fakeComponent(NS, over = {}) {
  const c = Object.create(NS.dt.DisplayTemplate.prototype);
  const calls = { begin: [], menu: 0 };
  Object.assign(c, {
    _mounted: true, _writing: 0, _timers: new Set(),
    state: { dialog: null, edit: null, confirm: null, menu: null },
    setState(p, cb) { Object.assign(this.state, typeof p === 'function' ? p(this.state) : p); if (cb) cb(); },
    _bubble() {}, _later(fn) { (this._q || (this._q = [])).push(fn); return 1; },
    _rect() { return null; }, _focusEditor() {}, _env() { return ENV; },
    _beginEdit(seed) { calls.begin.push(seed === undefined ? 'none' : seed); },
  }, over);
  return { c, calls };
}

// ---- the direct-mode value ignored the whole colour policy ------------------------------------------------------

test('direct mode: the idle input inherits the value colour and takes the stale / denied cues', () => {
  const { NS } = load();
  const css = NS.dt.css();
  const at = (s) => css.indexOf(s);
  const own = at(':where(.dt-input){');
  const inherit = at(':where(.dt-value--direct .dt-input[readonly]){color:inherit}');
  assert.ok(own >= 0, 'the .dt-input rule');
  assert.ok(inherit > own, 'was missing: the input kept var(--dt-setpoint-color) over alarm / bounds / value.style colours');
  assert.match(css, /:where\(\.dt--setpoint-denied \.dt-value--direct \.dt-input\[readonly\]\)\{opacity:\.5\}/, 'denied looked writable');
  assert.match(css, /:where\(\.dt--stale \.dt-value--direct \.dt-input\[readonly\]\)\{opacity:var\(--dt-stale-opacity\);text-decoration:underline dashed/,
    'connection loss did not dim / underline the direct value');
  // the editing colours stay on the focused (editable) input only
  assert.ok(at(':where(.dt-input:focus)') >= 0);
});

// ---- multi-line Strings lost their line breaks in the single-line editors ----------------------------------------

test('a String with line breaks cannot be edited inline / in the popup (guard VALUE_MULTILINE); a plain one can', () => {
  const { NS } = load();
  const cfg = cfgOf(NS, { setpoint: { enabled: true, mode: 'popup' } });
  for (const v of ['line1\nline2', 'a\r\nb', 'cr\ronly']) {
    const g = NS.dt.writeGuard(cfg, D(snapTemp({ value: { v, type: 'String', q: GOOD }, meta: meta('String'), writeLimits: null })), ENV);
    assert.equal(g.allowed, false, JSON.stringify(v) + ': was allowed, and Write sent "line1line2X"');
    assert.equal(g.code, 'VALUE_MULTILINE');
    assert.match(g.text, /line breaks/);
  }
  const ok = NS.dt.writeGuard(cfg, D(snapTemp({ value: { v: 'line1 line2', type: 'String', q: GOOD }, meta: meta('String'), writeLimits: null })), ENV);
  assert.equal(ok.allowed, true);
});

// ---- states.unmatchedText removed the threshold alarm ------------------------------------------------------------

test('an unmatched state value keeps its threshold alarm (unmatchedText shown, numeric kept)', () => {
  const { NS } = load();
  const base = { states: { options: [{ value: 0, label: 'Off' }, { value: 1, label: 'On' }] },
    alarms: { colorMode: 'thresholds', thresholds: [{ priority: 'Critical', above: 3 }] } };
  const snap = snapTemp({ value: { v: 5, type: 'Int4', q: GOOD }, meta: meta('Int4') });
  const withText = NS.dt.resolve(cfgOf(NS, Object.assign({}, base, { states: Object.assign({}, base.states, { unmatchedText: 'Unknown' }) })), D(snap), ENV);
  const plainVm = NS.dt.resolve(cfgOf(NS, base), D(snap), ENV);
  assert.equal(withText.valueText, 'Unknown');
  assert.ok(plainVm.alarm && plainVm.alarm.name === 'Critical', 'control: without unmatchedText the value 5 is Critical');
  assert.ok(withText.alarm, 'was null: the unexpected fault code lost its alarm colour');
  assert.equal(withText.alarm.name, 'Critical');
  assert.ok(withText.rootClasses.some((k) => /^dt--alarm/.test(k)));
});

// ---- Int8 values were rounded to 15 digits in the editor ----------------------------------------------------------

test('editText / stepText never round an integer; a bigint steps with BigInt arithmetic', () => {
  const { NS } = load();
  const s = snapTemp({ value: { v: 1760000000000123, type: 'Int8', q: GOOD }, meta: meta('Int8'), writeLimits: null });
  assert.equal(NS.dt.editText(s, 'en-US'), '1760000000000123', 'was 1760000000000120: an unedited Write changed the tag');
  assert.equal(NS.dt.stepText('1760000000000123', 1, 1, s, 'en-US', 'int'), '1760000000000124', 'was stuck at ...120');
  assert.equal(NS.dt.stepText('1760000000000123', -1, 1, s, 'en-US', 'int'), '1760000000000122');
  assert.equal(NS.dt.stepText('9007199254740993', 1, 1, s, 'en-US', 'int'), '9007199254740994', 'was 9007199254740990 (a +1 step wrote less)');
  assert.equal(NS.dt.stepText('-9007199254740993', -1, 2, s, 'en-US', 'int'), '-9007199254740995');
  // write limits still clamp a big step
  const lim = snapTemp({ value: { v: 1, type: 'Int8', q: GOOD }, meta: meta('Int8'), writeLimits: { low: 0, high: 9007199254740992, inclusive: true, source: 'props' } });
  assert.equal(NS.dt.stepText('9007199254740992', 1, 1, lim, 'en-US', 'int'), '9007199254740992');
  // floats unchanged: 15 significant digits / Float4 shortest
  assert.equal(NS.dt.editText(snapTemp({ value: { v: 0.1 + 0.2, type: 'Float8', q: GOOD } }), 'en-US'), '0.3');
});

// ---- integer spinner landed on a fractional inclusive limit -------------------------------------------------------

test('an Int spinner clamps to the whole numbers inside fractional inclusive limits', () => {
  const { NS } = load();
  const s = snapTemp({ value: { v: 1, type: 'Int4', q: GOOD }, meta: meta('Int4'), writeLimits: { low: 0.5, high: 10.5, inclusive: true, source: 'props' } });
  assert.equal(NS.dt.stepText('1', -1, 1, s, 'en-US', 'int'), '1', 'was 0.5 ("Enter a whole number", Write disabled)');
  assert.equal(NS.dt.stepText('10', 1, 1, s, 'en-US', 'int'), '10', 'was 10.5');
  assert.equal(NS.dt.stepText('5', 1, 1, s, 'en-US', 'int'), '6');
  // no whole number inside: no clamp to an invalid value either way
  const none = snapTemp({ value: { v: 1, type: 'Int4', q: GOOD }, meta: meta('Int4'), writeLimits: { low: 0.2, high: 0.8, inclusive: true, source: 'props' } });
  assert.equal(NS.dt.stepText('0', 1, 1, none, 'en-US', 'int'), '1');
  // floats keep the exact limit
  assert.equal(NS.dt.stepText('1', -1, 1, s, 'en-US', 'float'), '0.5');
});

// ---- direct mode, focused but idle after a write / Escape ----------------------------------------------------------

function directIdle(NS, env, over = {}) {
  const cfg = cfgOf(NS, { setpoint: { enabled: true, mode: 'direct' } });
  const d = D(snapTemp());
  const { c, calls } = fakeComponent(NS, Object.assign({ props: { props: cfg, delegate: d } }, over));
  const vm = NS.dt.resolve(cfg, d, ENV);
  const parts = c._renderValueContent(cfg, vm, ENV);
  const list = Array.isArray(parts) ? parts : parts.parts;
  const input = list.find((p) => p && p.type === 'input');
  return { c, calls, input, doc: env.context.document };
}

test('direct mode: a click on the focused idle input begins the edit; a printable key begins it with that key', () => {
  const { NS, env } = load();
  const { c, calls, input, doc } = directIdle(NS, env);
  assert.ok(input, 'the idle direct input');
  const el = { tagName: 'INPUT', readOnly: true, isConnected: true };
  doc.activeElement = el;                                   // focus stayed on it after the write
  let prevented = false;
  input.props.onMouseDown({ button: 0, currentTarget: el, preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'the caret is placed as usual');
  assert.equal(typeof input.props.onClick, 'function', 'was: no click handler (no focus event on an element that has focus)');
  input.props.onClick({ button: 0, currentTarget: el });
  assert.deepEqual(calls.begin, [null], 'the click on the focused idle input begins the edit');
  // a right / middle press never focuses or edits
  let prevented2 = false;
  input.props.onMouseDown({ button: 2, currentTarget: el, preventDefault() { prevented2 = true; } });
  assert.equal(prevented2, true);
  input.props.onClick({ button: 1, currentTarget: el });
  assert.equal(calls.begin.length, 1);
  void doc;
  input.props.onKeyDown({ key: '6', preventDefault() {} });
  assert.deepEqual(calls.begin, [null, '6'], 'was: the typed 6 dropped (read-only input)');
  input.props.onKeyDown({ key: 'c', ctrlKey: true, preventDefault() {} });
  assert.equal(calls.begin.length, 2, 'Ctrl+C is not an edit');
  void c;
});

test('direct mode: a closing menu / dialog returns focus to the idle input without starting an edit', () => {
  const { NS, env } = load();
  const el = { tagName: 'INPUT', readOnly: true, isConnected: true };
  const { c, calls } = directIdle(NS, env, { inputEl: el, valueEl: { tagName: 'DIV' } });
  assert.equal(c._returnFocusEl(), el, 'was the value wrapper (not focusable): focus fell to <body>');
  el.readOnly = false;                                      // the menu renders before a cancelled edit's input is read-only
  assert.equal(c._returnFocusEl(), el);
  el.readOnly = true;
  c._closeMenu();
  c._directFocus();                                         // the focus event of the returning focus
  assert.deepEqual(calls.begin, [], 'no edit begins');
  c._directFocus();                                         // a later real focus does begin it
  assert.deepEqual(calls.begin, ['none']);
  c._closeDialog();
  c._directFocus(null);                                     // Enter / a click: always an edit
  assert.deepEqual(calls.begin, ['none', null]);
  // popup / protected: the value element as before
  const pc = fakeComponent(NS, { props: { props: cfgOf(NS, { setpoint: { enabled: true, mode: 'popup' } }), delegate: D(snapTemp()) },
    inputEl: null, valueEl: { tagName: 'DIV', tabIndex: 0 } }).c;
  assert.equal(pc._returnFocusEl(), pc.valueEl);
});

// ---- Shift+F10 while typing committed the typed value -------------------------------------------------------------

test('Shift+F10 in an inline edit the operator typed in leaves it to the input (no display menu, no blur commit)', () => {
  const { NS } = load();
  const input = { tagName: 'INPUT' };
  const cfg = cfgOf(NS, { setpoint: { enabled: true, mode: 'direct', commitOnBlur: true } });
  const { c, calls } = fakeComponent(NS, { props: { props: cfg, delegate: D(snapTemp()) }, inputEl: input,
    _menuAllowed: () => true, _menuModel: () => ({ items: [1] }), _openMenu() { calls.menu++; } });
  c.state.edit = { kind: 'float', text: '77', initial: '50', touched: true, busy: false };
  let prevented = false;
  c._onRootKeyDown({ key: 'F10', shiftKey: true, target: input, preventDefault() { prevented = true; }, stopPropagation() {} });
  assert.equal(calls.menu, 0, 'was: the menu opened and the blur wrote 77');
  assert.equal(prevented, false);
  assert.equal(c.state.edit.text, '77', 'the typed text stays');
  // an untouched edit (or none): the display menu as before
  c.state.edit = { kind: 'float', text: '50', initial: '50', busy: false };
  c._onRootKeyDown({ key: 'ContextMenu', target: input, preventDefault() {}, stopPropagation() {} });
  assert.equal(calls.menu, 1);
});

// ---- docs promised a Ctrl+click menu on Windows ---------------------------------------------------------------------

test('docs: Ctrl+click opens the menu only on macOS', () => {
  const dir = path.join(REPO, 'docs', 'user-guide', 'components', 'display-template');
  const md = readdirSync(dir).filter((f) => f.endsWith('.md'))
    .map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.match(md, /Ctrl\+click/, 'the menu page still names the macOS gesture');
  for (const m of md.matchAll(/Ctrl\+click[^\n]*/g)) {
    assert.match(m[0], /macOS/, 'was "Right-click, Ctrl+click, a long press…" (Windows: the setpoint dialog opened): ' + m[0]);
  }
});
