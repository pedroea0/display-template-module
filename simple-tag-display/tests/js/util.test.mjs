// =============================================================================
// util.test.mjs — NS.util, NS.props, NS.quality, NS.alarm, NS.i18n, NS.log,
// NS.ui placement maths and the delegate base
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEnv, FILES } from './_stubs.mjs';

function ns(opts) {
  const env = createEnv(opts);
  env.load('ctg-common.js');
  return { NS: env.window.__CTG, env };
}

test('normKey, normTrendGroup, shortTagName', () => {
  const { NS } = ns();
  assert.equal(NS.util.normKey(' [default]CTG/Temp '), '[default]ctg/temp');
  assert.equal(NS.util.normKey(null), '');
  assert.equal(NS.util.normTrendGroup(undefined), 'default');
  assert.equal(NS.util.normTrendGroup('  ', { kind: 'chart' }), null);
  assert.equal(NS.util.normTrendGroup('Line 1/Area#2', { kind: 'dt' }), 'Line_1_Area_2');
  assert.equal(NS.util.shortTagName('[default]CTG/Area/Temp'), 'Temp');
  assert.equal(NS.util.shortTagName('[default]Odd]Name/X]Y'), 'X]Y'.slice(2), 'after the last ]');
  assert.equal(NS.util.shortTagName('Temp'), 'Temp');
  assert.equal(NS.util.shortTagName(undefined), '');
});

test('looseEqual: numeric strings, booleans as 1/0, case-sensitive strings', () => {
  const { NS } = ns();
  const eq = NS.util.looseEqual;
  assert.equal(eq(1, '1'), true);
  assert.equal(eq('1.0', 1), true);
  assert.equal(eq(' 2 ', 2), true);
  assert.equal(eq('1', '1.0'), false, 'two strings compare exactly');
  assert.equal(eq(true, 1), true);
  assert.equal(eq(false, 0), true);
  assert.equal(eq(false, '0'), true);
  assert.equal(eq(true, 'true'), false);
  assert.equal(eq('Auto', 'auto'), false);
  assert.equal(eq('Auto', 'Auto'), true);
  assert.equal(eq('0x1', 1), false);
  assert.equal(eq(null, undefined), true);
  assert.equal(eq(null, 0), false);
  assert.equal(eq(NaN, NaN), true);
  assert.equal(eq({}, {}), false);
  assert.equal(eq('', 0), false);
});

test('interpolate, debounce, rafThrottle, clamp', async () => {
  const { NS } = ns();
  assert.equal(NS.util.interpolate('/trend/{tagName}?g={trendGroup}&x={nope}', { tagName: 'A B/C', trendGroup: 'g&1' }),
    '/trend/A%20B%2FC?g=g%261&x={nope}');
  assert.equal(NS.util.interpolate('{tagPath}', { tagPath: '[a]b' }, false), '[a]b');
  assert.equal(NS.util.clamp(5, 0, 3), 3);
  let n = 0;
  const d = NS.util.debounce(() => n++, 10);
  d(); d(); d();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(n, 1);
  const seen = [];
  const t = NS.util.rafThrottle((x) => seen.push(x));
  t(1); t(2); t(3);
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(seen, [3], 'one call per frame with the latest arguments');
});

test('framedCrossOrigin with a stubbed window.top', () => {
  const { NS, env } = ns();
  const w = env.window;
  assert.equal(NS.util.framedCrossOrigin(), false, 'top-level page');
  w.top = { get location() { throw new Error('SecurityError'); } };
  assert.equal(NS.util.framedCrossOrigin(), true, 'cross-origin top throws');
  w.top = { location: { origin: 'http://localhost:8088' } };
  w.location = { origin: 'http://localhost:8088' };
  assert.equal(NS.util.framedCrossOrigin(), false, 'same-origin frame');
  w.top = { location: { origin: 'http://evil.example' } };
  assert.equal(NS.util.framedCrossOrigin(), true, 'other origin');
  w.top = { location: { origin: 'http://localhost:8088' } };
  w.location = { origin: 'http://localhost:8088', ancestorOrigins: ['http://localhost:8088', 'http://evil.example'] };
  assert.equal(NS.util.framedCrossOrigin(), true, 'a cross-origin ancestor in between');
  w.top = w;
  assert.equal(NS.util.framedCrossOrigin(), false);
});

test('delegate frameBlocked: framed cross-origin and not allowed by the gateway', () => {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-cafebabe');
  const NS = env.window.__CTG;
  env.window.top = { get location() { throw new Error('SecurityError'); } };
  const d = new NS.dt.DisplayTemplateDelegate({ addressPathString: '0:5' });
  d.attach();
  try {
    assert.equal(d.frameBlocked(), true);
    d.handleEvent('ctg.welcome', { v: 2, epoch: 'e', seq: 1, serverNow: Date.now(), allowCrossOriginFrames: true });
    assert.equal(d.frameBlocked(), false);
    assert.equal(NS.i18n.t('frame.blocked'), 'Editing is disabled inside a frame from another site.');
  } finally {
    d.detach();
  }
});

test('NS.log redacts tokens in strings and objects; debug follows localStorage', () => {
  const { NS, env } = ns();
  const tok = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
  assert.equal(NS.log.redact({ token: tok }).token, '***');
  assert.equal(NS.log.redact({ data: { url: '/x', token: tok, expiresAt: 5 } }).data.token, '***', 'chart.token payload');
  assert.equal(NS.log.redact(`{"token":"${tok}"}`), '{"token":"***"}');
  assert.equal(NS.log.redact(`X-CTG-Token=${tok}`), 'X-CTG-Token=***');
  assert.equal(NS.log.redact('tokenizer: abc'), 'tokenizer: abc');
  const circular = {}; circular.self = circular;
  assert.equal(NS.log.redact(circular), '[unserializable]');
  const logged = [];
  env.context.console.debug = (...a) => logged.push(a);
  env.window.localStorage = { getItem: () => '0' };
  NS.log('t').debug('hidden');
  env.window.localStorage = { getItem: () => '1' };
  NS.log('t').debug('shown', { token: tok });
  assert.equal(logged.length, 1);
  assert.equal(logged[0][0], '[t]');
  assert.equal(logged[0][2].token, '***');
});

test('i18n: part tables, common fallback, errorText for every ErrorCode', () => {
  const { NS } = ns();
  NS.i18n.register('display', { 'error.DISABLED': 'Display text', 'dt.x': 'Hello {name}' });
  NS.i18n.register('chart', { 'error.DISABLED': 'Chart text' });
  assert.equal(NS.i18n.t('dt.x', { name: 'A' }), 'Hello A');
  assert.equal(NS.i18n.t('missing.key'), 'missing.key');
  assert.equal(NS.i18n.errorText('DISABLED', null, 'chart'), 'Chart text');
  assert.equal(NS.i18n.errorText('DISABLED', null, 'display'), 'Display text');
  assert.equal(NS.i18n.errorText('DISABLED'), 'Editing is turned off for this value.', 'common wins without a part');
  assert.equal(NS.i18n.errorText('OUT_OF_RANGE', { low: 0, high: 100 }), 'Must be between 0 and 100.');
  assert.equal(NS.i18n.errorText('OUT_OF_RANGE', { low: 5 }), 'Must be at least 5.');
  assert.equal(NS.i18n.errorText('OUT_OF_RANGE', {}), 'The value is outside the allowed range.');
  assert.equal(NS.i18n.errorText('TREND_LIST_FULL', { max: 32 }), 'The trend list is full (32 tags).');
  assert.equal(NS.i18n.errorText('WRITE_FAILED', { quality: 'Bad_Stale' }), 'Write failed (quality Bad_Stale).');
  assert.equal(NS.i18n.errorText('STEP_TOO_LARGE', { max: 5, delta: 9 }), 'Change is larger than allowed (max \u00B15).');
  assert.equal(NS.i18n.errorText('NO_SUCH_CODE'), 'Something went wrong (NO_SUCH_CODE).');
  assert.equal(NS.i18n.errorText('DETACHED'), '');
  // every gateway ErrorCode constant (Java enum) and every client-only code has its own text
  const java = readFileSync(new URL('../../common/src/main/java/com/example/simpletagdisplay/common/protocol/ErrorCode.java', import.meta.url), 'utf8');
  const codes = [...java.matchAll(/^\s{4}([A-Z][A-Z0-9_]+)\s*\(/gm)].map((m) => m[1]);
  assert.ok(codes.length >= 50, `found ${codes.length} codes`);
  // A code used by one part only may keep its text in that part's own table (the common table is frozen):
  // INVALID_TIME is annotation-only and lives in ctg-chart.js.
  const PART_OWNED = { INVALID_TIME: 'chart' };
  for (const code of [...codes, 'CLIENT_TIMEOUT', 'DISCONNECTED', 'DETACHED']) {
    if (PART_OWNED[code]) continue;
    assert.ok(NS.i18n.has('error.' + code), `error text for ${code}`);
  }
  const all = createEnv();
  for (const f of FILES) all.load(f, '2.0.0-feedc0de');
  const NSA = all.window.__CTG;
  for (const [code, part] of Object.entries(PART_OWNED)) {
    assert.ok(codes.includes(code), `${code} is a gateway ErrorCode`);
    assert.ok(NSA.i18n.has('error.' + code, part), `error text for ${code} in the ${part} part`);
  }
  for (const code of codes) assert.ok(NSA.i18n.has('error.' + code), `error text for ${code} with every part loaded`);
  assert.equal(NSA.i18n.errorText('INVALID_TIME', { reason: 'future' }), 'A note cannot start more than a day from now.');
  assert.equal(NSA.i18n.errorText('INVALID_TIME', { reason: 'order' }), 'A range must end after it starts.');
  assert.equal(NSA.i18n.errorText('INVALID_TIME', { reason: 'length', maxRangeDays: 400 }), 'A range can be at most 400 days long.');
  assert.equal(NSA.i18n.errorText('INVALID_TIME', {}), "The note's time is not allowed: check its start and end.");
  assert.equal(NS.i18n.errorText('BOUND_BIDIRECTIONAL'), "Editing is turned off: this screen's configuration is not safe (ask the integrator).");
  assert.equal(NS.i18n.errorText('NOT_OWNER'), 'You can only change your own notes.');
});

test('quality levels from objects, codes and names; alarm priorities', () => {
  const { NS } = ns();
  const L = NS.quality.level;
  assert.equal(L({ code: 192, name: 'Good', level: 'good' }), 'good');
  assert.equal(L({ level: 'Bad' }), 'bad');
  assert.equal(L(-2147483134), 'bad', 'Bad_AccessDenied');
  assert.equal(L(0x40000000 | 5), 'uncertain');
  assert.equal(L(0xC0000000 | 0), 'error');
  assert.equal(L(192), 'good');
  assert.equal(L('Uncertain_LastKnownValue'), 'uncertain');
  assert.equal(L('Error_Configuration'), 'error');
  assert.equal(L({ name: 'Bad_NotConnected' }), 'bad');
  assert.equal(L(null), 'good');
  assert.equal(L({}), 'uncertain');
  assert.equal(NS.quality.label({ name: 'Bad_NotConnected', level: 'bad' }), 'Bad_NotConnected');
  assert.equal(NS.quality.label({ level: 'uncertain' }), 'Uncertain');
  assert.equal(NS.alarm.priority('Critical'), 4);
  assert.equal(NS.alarm.priority('high'), 3);
  assert.equal(NS.alarm.priority(0), 0);
  assert.equal(NS.alarm.priority('2'), 2);
  assert.equal(NS.alarm.priority(5), null);
  assert.equal(NS.alarm.priority(1.5), null);
  assert.equal(NS.alarm.priority('Urgent'), null);
  assert.equal(NS.alarm.name(3), 'High');
  assert.ok(Object.isFrozen(NS.alarm.PRIORITIES));
});

test('props.merge: deep merge, arrays and scalars replace, undefined keeps defaults', () => {
  const { NS } = ns();
  const D = Object.freeze({ a: 1, g: Object.freeze({ x: 1, y: Object.freeze({ z: 2 }) }), arr: Object.freeze([1, 2]), n: null });
  const m = NS.props.merge(D, { g: { y: { z: 3 }, extra: true }, arr: [9], a: undefined, n: 5 });
  assert.deepEqual(JSON.parse(JSON.stringify(m)), { a: 1, g: { x: 1, y: { z: 3 }, extra: true }, arr: [9], n: 5 });
  assert.equal(NS.props.merge(D, undefined), D);
  assert.deepEqual(JSON.parse(JSON.stringify(NS.props.merge(D, { g: 'oops' }))).g, { x: 1, y: { z: 2 } }, 'a mistyped group keeps its defaults');
  assert.deepEqual(JSON.parse(JSON.stringify(NS.props.merge(D, 'oops'))), JSON.parse(JSON.stringify(D)));
  assert.equal(NS.props.merge(D, { a: null }).a, null, 'null replaces (nullable fields)');
  assert.deepEqual([...D.arr], [1, 2], 'defaults untouched');
});

test('props.coerce: schema-lite rules never throw', () => {
  const { NS } = ns();
  const c = NS.props.coerce;
  const dec = { type: 'integer', min: 0, max: 15, default: null, nullable: true };
  assert.equal(c(-1, dec), 0);
  assert.equal(c(101, dec), 15);
  assert.equal(c(2.7, dec), 2);
  assert.equal(c('3', dec), 3);
  assert.equal(c('x', dec), null);
  assert.equal(c(NaN, dec), null);
  assert.equal(c(null, dec), null);
  assert.equal(c(undefined, { type: 'number', default: 4 }), 4);
  assert.equal(c(null, { type: 'number', default: 4 }), 4, 'null without nullable -> default');
  assert.equal(c('top', { type: 'enum', values: ['top', 'center'], default: 'center' }), 'top');
  assert.equal(c('TOP', { type: 'enum', values: ['top', 'center'], default: 'center' }), 'center');
  assert.equal(c(5, { type: 'string', default: '' }), '5');
  assert.equal(c({}, { type: 'string', default: 'd' }), 'd');
  assert.equal(c('abcdef', { type: 'string', maxLength: 3 }), 'abc');
  assert.equal(c('true', { type: 'boolean', default: false }), true);
  assert.equal(c('yes', { type: 'boolean', default: false }), false);
  const opts = c([{ value: 1 }, { label: 'no value' }, null, { value: 2 }], {
    type: 'array', default: [], item: (o) => (o && Object.prototype.hasOwnProperty.call(o, 'value') ? o : undefined),
  });
  assert.equal(opts.length, 2);
  assert.deepEqual(c('nope', { type: 'array', default: [] }), []);
  assert.deepEqual(JSON.parse(JSON.stringify(c([1, 'x', 3], { type: 'array', item: { type: 'number' } }))), [1, 3]);
  assert.equal(c([], { type: 'object', default: 'd' }), 'd');
  assert.equal(c('--callToAction', { type: 'color', default: null }), 'var(--callToAction)');
  assert.equal(c('red;background:url(x)', { type: 'color', default: null }), null);
  assert.equal(c(42, { type: 'any' }), 42);
});

test('props.style: tree.readStyle, PropertyTree.parseStyle and the v1 fallback', () => {
  const { NS, env } = ns();
  // fallback (no Perspective helpers in the stub)
  const s = NS.props.style({ classes: 'Big ia_x psc-Done', 'font-size': '30px', color: '--label', margin: 2, bad: 'x;y' });
  assert.equal(s.className, 'psc-Big ia_x psc-Done');
  assert.deepEqual({ ...s.style }, { fontSize: '30px', color: 'var(--label)', margin: 2 });
  assert.deepEqual(JSON.parse(JSON.stringify(NS.props.style(undefined))), { className: '', style: {} });
  // tree.readStyle path
  const tree = { readStyle: (p) => ({ toStyleProps: () => ({ className: 'psc-' + p, style: { color: 'red' } }) }), read: () => ({}) };
  assert.deepEqual(JSON.parse(JSON.stringify(NS.props.style(tree, 'label.style'))), { className: 'psc-label.style', style: { color: 'red' } });
  // tree without readStyle support -> parseStyle -> fallback
  const tree2 = { readStyle: () => { throw new Error('x'); }, read: () => ({ classes: 'A' }) };
  assert.equal(NS.props.style(tree2, 'p').className, 'psc-A');
  env.window.PerspectiveClient.PropertyTree = { parseStyle: () => ({ toStyleProps: () => ({ className: 'psc-Parsed', style: {} }) }) };
  assert.equal(NS.props.style({ classes: 'X' }).className, 'psc-Parsed');
});

test('props.color uses CSS.supports when present', () => {
  const { NS, env } = ns();
  env.window.CSS = { supports: (p, v) => p === 'color' && /^(#[0-9a-f]{3,8}|red|var\(.+\))$/i.test(v) };
  assert.equal(NS.props.color('#00f'), '#00f');
  const w0 = env.warnings.length;
  assert.equal(NS.props.color('notacolor'), null);
  assert.equal(NS.props.color('notacolor'), null);
  assert.equal(env.warnings.length, w0 + 1, 'one warning per bad value');
  assert.equal(NS.props.color(''), null);
  assert.equal(NS.props.color(12), null);
});

test('ui placement maths: menu clamps at all four corners, popover flips', () => {
  const { NS } = ns();
  const vp = { left: 0, top: 0, width: 800, height: 600 };
  const inside = (p, w, h) => p.left >= 4 && p.top >= 4 && p.left + w <= 796 && p.top + Math.min(h, p.maxHeight || h) <= 596;
  for (const [x, y] of [[0, 0], [799, 0], [0, 599], [799, 599], [400, 300]]) {
    const p = NS.ui.placeAt(x, y, 200, 150, vp);
    assert.ok(inside(p, 200, 150), `corner ${x},${y} -> ${JSON.stringify(p)}`);
  }
  assert.deepEqual({ ...NS.ui.placeAt(100, 100, 200, 150, vp) }, { left: 100, top: 100, maxHeight: 592 }, 'room: at the pointer');
  assert.equal(NS.ui.placeAt(100, 550, 200, 150, vp).top, 400, 'opens upwards near the bottom');
  const tall = NS.ui.placeAt(10, 10, 200, 2000, vp);
  assert.equal(tall.top, 4);
  assert.equal(tall.maxHeight, 592);
  const below = NS.ui.placeNear({ left: 100, top: 100, right: 200, bottom: 120 }, 150, 80, 'bottom', vp);
  assert.deepEqual({ ...below }, { left: 100, top: 126, placement: 'bottom' });
  const flipped = NS.ui.placeNear({ left: 100, top: 550, right: 200, bottom: 570 }, 150, 80, 'bottom', vp);
  assert.equal(flipped.placement, 'top');
  assert.equal(flipped.top, 550 - 6 - 80);
  const clampedX = NS.ui.placeNear({ left: 780, top: 100, right: 800, bottom: 120 }, 150, 80, 'bottom', vp);
  assert.equal(clampedX.left, 800 - 150 - 4);
  const right = NS.ui.placeNear({ left: 700, top: 100, right: 750, bottom: 120 }, 150, 80, 'right', vp);
  assert.equal(right.placement, 'left');
  const centered = NS.ui.placeNear({ left: 300, top: 100, right: 400, bottom: 120 }, 100, 50, 'bottom', vp, 0, 'center');
  assert.equal(centered.left, 300);
});

test('delegate base: stale reasons, ctg.hb, awaitingSnapshot, silence, mapped stale flag', () => {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-cafebabe');
  const NS = env.window.__CTG;
  const d = new NS.dt.DisplayTemplateDelegate({ addressPathString: '0:9' });
  const E = (seq, extra) => Object.assign({ v: 2, epoch: 'e1', seq, serverNow: Date.now() }, extra);
  d.attach();
  try {
  assert.equal(d.staleReason(), 'connecting');
  d.handleEvent('ctg.welcome', E(1));
  d.handleEvent('dt.snapshot', E(2, { status: 'ok', value: { v: 1 } }));
  assert.equal(d.staleReason(), null);
  assert.equal(d.mapStateToProps().stale, false);
  d.handleEvent('ctg.hb', E(3));
  assert.ok(d.lastPushAt > 0);
  assert.equal(d.mapStateToProps().snap.value.v, 1, 'a heartbeat is not forwarded to onMessage');
  d.handleEvent('dt.values', E(7, { value: { v: 2 } }));                // gap
  assert.equal(d.staleReason(), 'resync');
  assert.equal(d.mapStateToProps().stale, true);
  d.handleEvent('ctg.welcome', E(8));
  d.handleEvent('dt.snapshot', E(9, { status: 'ok', value: { v: 3 } }));
  assert.equal(d.staleReason(), null);
  d.silenceLimitMs = 1000;
  d._checkSilence(d.lastPushAt + 5000);
  assert.equal(d.staleReason(), 'silent');
  d.handleEvent('ctg.hb', E(10));
  assert.equal(d.staleReason(), null, 'any push ends the silence');
  env.setConnected(false);
  assert.equal(d.staleReason(), 'disconnected');
  env.setConnected(true);
  d.handleEvent('ctg.reload', E(11, { reason: 'build' }));
  assert.equal(d.staleReason(), 'reload');
  } finally {
    d.detach();     // stops the page watchdog (a self-rescheduling timer) so the test process can exit
  }
  assert.equal(NS.debug.delegates.size, 0);
});

test('delegate base: request id reuse and lastRequestId', async () => {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-cafebabe');
  const NS = env.window.__CTG;
  const store = { addressPathString: '0:4' };
  const d = new NS.dt.DisplayTemplateDelegate(store);
  d.attach();
  try {
  d.handleEvent('ctg.welcome', { v: 2, epoch: 'e', seq: 1, serverNow: Date.now() });
  const p1 = d.request('dt.write', { value: 1 }, { timeoutMs: 1000 });
  const id = d.lastRequestId();
  const p2 = d.request('dt.write', { value: 1 }, { timeoutMs: 1000, reuseId: id });
  assert.equal((await p1).error.code, 'CLIENT_TIMEOUT', 'the superseded pending entry settles');
  d.handleEvent('ctg.reply', { v: 2, epoch: 'e', seq: 2, serverNow: Date.now(), id, ok: true, data: { written: 1 } });
  assert.equal((await p2).ok, true);
  const sent = env.fired.filter((f) => f.store === store && f.name === 'dt.write');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].payload.id, id);
  } finally {
    d.detach();
  }
});

test('props.merge never copies __proto__ / constructor / prototype keys', () => {
  const { NS } = ns();
  const m = NS.props.merge({ a: 1 }, JSON.parse('{"__proto__":{"polluted":1},"constructor":{"x":1},"prototype":2,"b":2}'));
  assert.equal(m.polluted, undefined, 'prototype not re-pointed');
  assert.equal(Object.prototype.hasOwnProperty.call(m, 'constructor'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(m, 'prototype'), false);
  assert.equal(m.b, 2);
  assert.equal(m.a, 1);
});

test('overlay: a bubble replaces only bubbles; menus/popovers stay single-open', () => {
  const { NS } = ns();
  const closed = [];
  const open = (owner, kind) => NS.overlay.open(owner, { kind, onClose: (r) => closed.push([owner, kind, r]) });
  open('B', 'menu');
  open('C', 'popover');
  assert.deepEqual(closed, [['B', 'menu', 'replaced']], 'a popover replaces a menu');
  closed.length = 0;
  open('A', 'bubble');
  assert.deepEqual(closed, [], "a bubble does not cancel another component's Confirm popover");
  assert.equal(NS.overlay.count('popover'), 1);
  open('D', 'bubble');
  assert.deepEqual(closed, [['A', 'bubble', 'replaced']], 'one bubble at a time');
  closed.length = 0;
  open('E', 'menu');
  assert.deepEqual(closed.map((c) => c[1]).sort(), ['bubble', 'popover'], 'a menu still closes every transient');
  NS.overlay.closeAll();
  assert.equal(NS.overlay.count(), 0);
});

test('longPress: page-level listeners are shared by every instance', () => {
  const env = createEnv();
  const added = [], removed = [];
  env.window.addEventListener = (t) => added.push(t);
  env.window.removeEventListener = (t) => removed.push(t);
  env.load('ctg-common.js');
  const NS = env.window.__CTG;
  const fakeEl = () => {
    const l = {};
    return { l, addEventListener: (t, fn) => { l[t] = fn; }, removeEventListener: (t) => { delete l[t]; } };
  };
  added.length = 0;
  const els = Array.from({ length: 250 }, fakeEl);
  const disposers = els.map((el) => NS.ui.longPress(el, { onLongPress() {} }));
  assert.deepEqual(added.slice().sort(), ['click', 'contextmenu', 'scroll'], '3 window listeners for 250 instances');
  assert.equal(NS.debug.longPress().instances, 250);
  els[0].l.pointerdown({ pointerType: 'touch', button: 0, clientX: 1, clientY: 1, pointerId: 1 });
  assert.equal(NS.debug.longPress().pressing, 1);
  els[0].l.pointerup({ pointerId: 1 });
  assert.equal(NS.debug.longPress().pressing, 0);
  removed.length = 0;
  disposers.forEach((d) => d());
  disposers[0]();   // idempotent
  assert.deepEqual(removed.slice().sort(), ['click', 'contextmenu', 'scroll']);
  assert.equal(NS.debug.longPress().instances, 0);
});
