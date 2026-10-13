// =============================================================================
// designer-preview-parity.test.mjs — Designer preview parity (v2.0.0) and the
// "a gateway setting refused this" texts + Designer hint
// =============================================================================
// Design mode = Perspective's Designer with interaction off (eventsEnabled false, window.__client.isDesigner).
// Every VISUAL output must equal the runtime one for the same props and data; only interaction differs.
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
const cap = (allowed, reason = null, extra = {}) => Object.assign({ allowed, reason }, extra);
const caps = (write, configEdit) => ({ write, configEdit: configEdit || cap(true), trend: cap(true), changeHistory: cap(true) });
function snapTemp(over = {}) {
  return Object.assign({
    status: 'ok', tagPath: '[default]CTG/Temp', tagName: 'Temp',
    value: { v: 72.25, t: 1, type: 'Float8', q: GOOD },
    meta: { engUnit: 'degF', engLow: 0, engHigh: 100, formatString: '#,##0.0', dataType: 'Float8', canWrite: true, readOnly: false, tagType: 'AtomicTag' },
    history: { available: true, enabled: true, provider: 'Core Historian', reason: 'ok' },
    alarms: { live: false, hasActive: false, hasUnacked: false, highestActivePriority: null, highestUnackedPriority: null, limits: { low: null, high: null } },
    capabilities: caps(cap(true, null, { audit: 'profile' })),
    trend: { group: 'default', trending: false, count: 0, max: 32 },
    writeLimits: { low: 0, high: 100, inclusive: true, source: 'eng' },
  }, over);
}
const cfgOf = (NS, props) => NS.dt.makeReducer()(tree(Object.assign({ tagPath: '[default]CTG/Temp' }, props)));
const D = (snap, extra = {}) => Object.assign({ snap, stale: false, staleReason: null, phase: 'ready' }, extra);
const RUN_ENV = { locale: 'en-US', timeZone: 'UTC', canInteract: true, designMode: false, designer: false, frameBlocked: false };
const DESIGN_ENV = Object.assign({}, RUN_ENV, { canInteract: false, designMode: true, designer: true });

/** Mounts a DisplayTemplate the way Perspective does, in design mode (Designer, events off) or at runtime. */
function mount(NS, env, cfg, d, design) {
  env.window.__client.isDesigner = design;
  env.window.__client.isPreviewing = design ? false : undefined;
  const props = {
    props: cfg, delegate: d, eventsEnabled: !design,
    store: { props: { read: () => undefined }, meta: { readBoolean: () => false }, view: { resourcePath: 'Test/View' } },
    emit: (o) => ({ className: ((o && o.classes) || []).join(' '), style: {} }),
  };
  const c = new NS.dt.DisplayTemplate(props);
  c._mounted = true;
  c.setState = function (p, cb) { this.state = Object.assign({}, this.state, typeof p === 'function' ? p(this.state) : p); if (cb) cb(); };
  return c;
}
/** The visual part of a rendered tree: element types, classes, inline styles, text, data-* (no handlers, focus or ARIA). */
function visual(n) {
  if (n == null || n === false) return null;
  if (typeof n !== 'object') return String(n);
  if (Array.isArray(n)) return n.map(visual).filter((x) => x !== null);
  const out = { type: typeof n.type === 'string' ? n.type : (n.type && (n.type.displayName || n.type.name)) || '?' };
  const p = n.props || {};
  for (const k of Object.keys(p).sort()) {
    if (/^on[A-Z]/.test(k) || k === 'ref' || k === 'key' || k === 'tabIndex' || k === 'role' || /^aria-/.test(k) || k === 'children') continue;
    if (typeof p[k] === 'function') continue;
    out[k] = p[k];
  }
  out.children = visual(n.children || []);
  return JSON.parse(JSON.stringify(out));
}
function renderBoth(NS, env, cfg, d) {
  const rt = dropDesignClass(visual(mount(NS, env, cfg, d, false).render()));
  const ds = visual(mount(NS, env, cfg, d, true).render());
  env.window.__client.isDesigner = undefined;
  return { rt, ds };
}
/**
 * design mode adds one class (dt--design) to the root; dt--has-menu only marks interaction (no text selection /
 * touch callout where the display menu opens), so it is not part of the look. Everything else must match.
 */
const NOT_VISUAL = { 'dt--design': 1, 'dt--has-menu': 1 };
const dropDesignClass = (t) => Object.assign({}, t, { className: String(t.className).split(' ').filter((c) => !NOT_VISUAL[c]).join(' ') });
const classesOf = (t) => String(t.className).split(' ');

test('design mode renders the setpoint colour, setpoint style and edit icon exactly like runtime (was: hidden in the Designer)', () => {
  const { NS, env } = load();
  const cfg = cfgOf(NS, {
    setpoint: { enabled: true, mode: 'popup', color: '#ff00aa', editIconVisible: true, style: { backgroundColor: '#eeeeee' } },
  });
  const { rt, ds } = renderBoth(NS, env, cfg, D(snapTemp()));
  assert.ok(classesOf(ds).includes('dt--design'));
  assert.deepEqual(dropDesignClass(ds), rt);
  assert.equal(rt.style['--dt-setpoint-color'], '#ff00aa');
  assert.ok(classesOf(ds).includes('dt--setpoint'), 'the setpoint class drives the colour: was missing in design mode');
  const json = JSON.stringify(ds);
  assert.match(json, /dt-edit-icon/, 'edit icon in design mode');
  assert.match(json, /"backgroundColor":"#eeeeee"/, 'setpoint.style in design mode');
});

test('design mode: Designer-dependent refusals (read-only Designer, its user, no reply yet) do not grey the setpoint out', () => {
  const { NS, env } = load();
  const cfg = cfgOf(NS, { setpoint: { enabled: true, color: '#00aa00' } });
  for (const reason of ['DESIGNER_READ_ONLY', 'AUTH_REQUIRED', 'FORBIDDEN_ROLE', 'WRITE_DENIED']) {
    const ds = mount(NS, env, cfg, D(snapTemp({ capabilities: caps(cap(false, reason)) })), true);
    const cls = classesOf(visual(ds.render()));
    assert.ok(cls.includes('dt--setpoint') && !cls.includes('dt--setpoint-denied'), reason + ': ' + cls.join(' '));
  }
  // a data / configuration problem still shows as at runtime
  const bad = D(snapTemp({ value: { v: 1, t: 1, type: 'Float8', q: { code: 12, name: 'Bad', level: 'bad' } } }));
  const { rt, ds } = renderBoth(NS, env, cfg, bad);
  assert.deepEqual(dropDesignClass(ds), rt);
  assert.ok(classesOf(rt).includes('dt--setpoint-denied'));
});

test('design mode: identical DOM for the visual props (alarm / bounds colours, units, label, quality, direct mode, styles)', () => {
  const { NS, env } = load();
  const cases = [
    {},
    { label: { text: 'Reactor temp', suffix: ':' }, layout: { direction: 'row', gap: '12px' }, units: { placement: 'value' } },
    { bounds: { enabled: true, appearance: 'background', lowColor: '#123456', highColor: '#654321' } },
    { alarms: { colorMode: 'thresholds', thresholds: [{ priority: 'High', above: 50 }], colors: { high: '#aa0000' } } },
    { value: { style: { color: '#0000ff', fontWeight: 'bold' } }, style: { backgroundColor: '#fafafa' } },
    { setpoint: { enabled: true, mode: 'direct', color: '#336699' } },
    { quality: { indicator: 'icon' } },
  ];
  for (const props of cases) {
    const { rt, ds } = renderBoth(NS, env, cfgOf(NS, props), D(snapTemp()));
    assert.deepEqual(dropDesignClass(ds), rt, JSON.stringify(props));
  }
});

test('autoFontSize: the same sizes in design mode and at runtime, measured from the layout box (not the zoomed rect), and re-run on a prop change', () => {
  const { NS, env } = load();
  const props = (valueScale) => ({ setpoint: { enabled: true, color: '#ff00aa' }, layout: { autoFontSize: { enabled: true, valueScale, labelScale: 0.25, min: 8, max: 72 } } });
  // the Designer canvas zoom is a CSS transform on an ancestor: getBoundingClientRect is scaled (here 0.5x),
  // the ResizeObserver contentRect / offset sizes are not
  const rootEl = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 30 }), offsetWidth: 200, offsetHeight: 60 };
  env.window.getComputedStyle = () => ({ paddingLeft: '0px', paddingRight: '0px', paddingTop: '0px', paddingBottom: '0px', fontSize: '14px', getPropertyValue: () => '' });
  const sizes = [];
  for (const design of [false, true]) {
    const c = mount(NS, env, cfgOf(NS, props(0.5)), D(snapTemp()), design);
    c.rootEl = rootEl;
    c._onResize({ width: 200, height: 60 });            // what NS.resize hands over: the ResizeObserver contentRect
    const r = visual(c.render());
    sizes.push([r.style['--dt-value-size'], r.style['--dt-label-size'], r.style['--dt-setpoint-color']]);
    // a prop change without a resize (the Designer property editor) re-computes at once
    c.props = Object.assign({}, c.props, { props: cfgOf(NS, props(0.25)) });
    c._roEl = rootEl; c._roDispose = () => {};
    c._bindRoot();
    sizes.push([visual(c.render()).style['--dt-value-size']]);
  }
  delete env.window.getComputedStyle;
  env.window.__client.isDesigner = undefined;
  assert.deepEqual(sizes[0], ['30px', '15px', '#ff00aa'], 'min(200, 60) x 0.5 = 30: the layout box, not the 0.5x zoomed rect (15)');
  assert.deepEqual(sizes[2], sizes[0], 'design mode = runtime');
  assert.deepEqual(sizes[1], ['15px'], 'valueScale 0.25 applied without a resize (was: stayed 30px until the box changed)');
  assert.deepEqual(sizes[3], sizes[1]);
});

test('design mode shows a representative value until the first value arrives (runtime / preview keep the loading text)', () => {
  const { NS } = load();
  const cfg = cfgOf(NS, { setpoint: { enabled: true }, value: { decimals: 2 } });
  const runtime = NS.dt.resolve(cfg, D(null), RUN_ENV);
  const design = NS.dt.resolve(cfg, D(null), DESIGN_ENV);
  assert.equal(runtime.valueText, cfg.value.loadingText);
  assert.equal(design.valueText, '123.40', 'formatted like the configured value (decimals 2)');
  assert.ok(design.rootClasses.includes('dt--placeholder') && design.rootClasses.includes('dt--setpoint'));
  const preview = NS.dt.resolve(cfg, D(null), Object.assign({}, RUN_ENV, { designer: true }));
  assert.equal(preview.valueText, cfg.value.loadingText, 'preview mode follows runtime');
  const states = cfgOf(NS, { states: { options: [{ value: 0, label: 'Stopped' }, { value: 1, label: 'Running' }] } });
  assert.equal(NS.dt.resolve(states, D(null), DESIGN_ENV).valueText, 'Stopped');
  const unconfigured = NS.dt.makeReducer()(tree({}));
  assert.equal(NS.dt.resolve(unconfigured, D({ status: 'noTagPath', tagPath: '' }), DESIGN_ENV).valueText, 'Set tagPath');
  assert.equal(NS.dt.resolve(unconfigured, D(null), DESIGN_ENV).valueText, unconfigured.value.loadingText, 'no tag path: no fake value');
});

test('design mode never starts an edit (the preview guard refuses every action)', () => {
  const { NS, env } = load();
  const c = mount(NS, env, cfgOf(NS, { setpoint: { enabled: true, mode: 'direct' } }), D(snapTemp()), true);
  let began = 0;
  const orig = c._beginEdit;
  c._beginEdit = function (s) { began++; return orig.call(this, s); };
  c._directFocus(null);
  assert.equal(began, 0, 'focus on the direct field in design mode');
  assert.equal(c._checkGuard(), false);
  assert.equal(c.state.edit, null);
  env.window.__client.isDesigner = undefined;
});

// ---- a gateway setting refused what the display allows ------------------------------------------------------------

test('a refusal from a gateway setting names it in the hover text and the menu hint', () => {
  const { NS } = load();
  const cfg = cfgOf(NS, { setpoint: { enabled: true }, menu: { configEdit: { enabled: true, access: { requireLogin: false } } } });
  const floor = cap(false, 'AUTH_REQUIRED', { setting: 'ctg.write.requireAuthenticated' });
  const snap = snapTemp({ capabilities: caps(floor, cap(false, 'AUTH_REQUIRED', { setting: 'ctg.write.requireAuthenticated' })) });
  const g = NS.dt.writeGuard(cfg, D(snap), RUN_ENV);
  assert.equal(g.allowed, false);
  assert.match(g.text, /requires a login for every write \(gateway setting ctg\.write\.requireAuthenticated\)/);
  assert.equal(NS.dt.resolve(cfg, D(snap), RUN_ENV).guard.text, g.text, 'the value tooltip uses the guard text');
  // the component's own rule refused: the plain text, no setting named
  const own = NS.dt.writeGuard(cfg, D(snapTemp({ capabilities: caps(cap(false, 'AUTH_REQUIRED')) })), RUN_ENV);
  assert.doesNotMatch(own.text, /gateway setting/);
  const txt = (code, setting) => NS.dt.writeGuard(cfg, D(snapTemp({ capabilities: caps(cap(false, code, { setting })) })), RUN_ENV).text;
  assert.match(txt('AUTH_REQUIRED', 'ctg.write.requiredRoles'), /^Log in: .*ctg\.write\.requiredRoles/);
  assert.match(txt('FORBIDDEN_ROLE', 'ctg.write.requiredRoles'), /you have none of them .*ctg\.write\.requiredRoles/);
  assert.match(txt('INVALID_PATH', 'ctg.write.deniedProviders'), /ctg\.write\.deniedProviders/);
  assert.match(txt('OUT_OF_SCOPE', 'ctg.write.allowedRoots'), /ctg\.write\.allowedRoots/);
  assert.doesNotMatch(txt('OUT_OF_SCOPE', 'evil<b>'), /evil/, 'only ctg.* setting names are shown');
  const m = NS.dt.menuModel(cfg, snap, { guard: g, user: { authenticated: false, roles: [] } });
  const items = m.items;
  assert.match(items.find((i) => i.id === 'setValue').hint, /ctg\.write\.requireAuthenticated/);
  assert.match(items.find((i) => i.id === 'configEdit').hint, /ctg\.write\.requireAuthenticated/);
});

test('a write refused by a gateway setting: the bubble text names the setting (reply details.setting)', () => {
  const { NS } = load();
  const text = NS.dt.errText({ code: 'AUTH_REQUIRED', details: { setting: 'ctg.write.requireAuthenticated' } });
  assert.match(text, /ctg\.write\.requireAuthenticated/);
  assert.doesNotMatch(NS.dt.errText({ code: 'AUTH_REQUIRED' }), /gateway setting/);
});

test('Designer-only hint: a badge names the gateway settings that override the display\'s access config', () => {
  const { NS, env } = load();
  const cfg = cfgOf(NS, { setpoint: { enabled: true } });
  const snap = snapTemp({ capabilities: caps(cap(true, null, { overrides: ['ctg.write.requireAuthenticated', 'ctg.write.allowedRoots'] })) });
  const vm = NS.dt.resolve(cfg, D(snap), DESIGN_ENV);
  assert.match(vm.gwHint, /setpoint\): ctg\.write\.requireAuthenticated, ctg\.write\.allowedRoots/);
  assert.equal(NS.dt.resolve(cfg, D(snap), RUN_ENV).gwHint, '', 'never outside the Designer');
  const badge = visual(mount(NS, env, cfg, D(snap), true).render()).children.flat().find((k) => k && k['data-dt'] === 'gw-hint');
  assert.ok(badge, 'badge rendered in the Designer');
  assert.match(badge.title, /ctg\.write\.requireAuthenticated/);
  env.window.__client.isDesigner = undefined;
});
