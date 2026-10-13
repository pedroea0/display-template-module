// =============================================================================
// dt-reducer.test.mjs — Display Template props reducer
// =============================================================================
// Loads ctg-common.js + display-template.js into the stub page and drives
// NS.dt.makeReducer() with a fake PropertyTree. Checks: the frozen defaults
// equal the shipped schema's object defaults; the reducer output has exactly
// the schema's key set; coercion never throws and clamps/drops bad values;
// memoisation; v1 detection; psc- class mapping.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnv } from './_stubs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(path.resolve(here, '..', '..', 'common', 'src', 'main', 'resources', 'schemas',
  'displaytemplate.props.json'), 'utf8'));

function load() {
  const env = createEnv();
  env.load('ctg-common.js');
  env.load('display-template.js');
  const NS = env.window.__CTG;
  assert.equal(NS.ready.display, true, 'display part initialised');
  return { NS, env };
}

/** Fake PropertyTree over a plain object (read(path) with dotted paths; no readStyle → v1 psc- fallback). */
function tree(obj) {
  return {
    obj,
    read(p) {
      let v = obj;
      for (const k of String(p).split('.')) { if (v == null || typeof v !== 'object') return undefined; v = v[k]; }
      return v;
    },
  };
}

/** Leaf-default assembly of a schema node (what the palette drops). */
function assemble(node) {
  if (node && node.type === 'object' && node.properties && !node.$ref) {
    const o = {};
    for (const [k, v] of Object.entries(node.properties)) o[k] = assemble(v);
    return o;
  }
  return node.default;
}
const plain = x => JSON.parse(JSON.stringify(x));

/** Key paths of a defaults object down to leaves (arrays and style objects are leaves). */
function keyPaths(o, prefix = '', out = []) {
  for (const [k, v] of Object.entries(o)) {
    const p = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && !/(^|\.)style$/.test(p) && p !== 'menu.trendPopup.params') keyPaths(v, p, out);
    else out.push(p);
  }
  return out;
}

test('DT_DEFAULTS equals the schema defaults (and the root object default)', () => {
  const { NS } = load();
  assert.deepEqual(plain(NS.dt.DEFAULTS), assemble(SCHEMA));
  assert.ok(Object.isFrozen(NS.dt.DEFAULTS) && Object.isFrozen(NS.dt.DEFAULTS.setpoint.access), 'deep-frozen');
});

test('reducer output has exactly the schema key set (+ derived fields), defaults for an empty tree', () => {
  const { NS } = load();
  const cfg = NS.dt.makeReducer()(tree({}));
  const derived = ['styles', 'tagPathTrimmed', 'fontOverride', 'v1Keys'];
  const own = Object.keys(cfg).filter(k => !derived.includes(k)).sort();
  assert.deepEqual(plain(own), Object.keys(SCHEMA.properties).sort());
  const groups = {};
  for (const k of own) groups[k] = cfg[k];
  assert.deepEqual(keyPaths(plain(groups)).sort(), keyPaths(assemble(SCHEMA)).sort());
  assert.deepEqual(plain(groups), assemble(SCHEMA));
  assert.equal(cfg.tagPathTrimmed, '');
  assert.deepEqual(plain(cfg.v1Keys), []);
});

test('partial objects, wrong types and bad enums never throw and fall back per field', () => {
  const { NS } = load();
  const reduce = NS.dt.makeReducer();
  const cfg = reduce(tree({
    tagPath: '  [default]CTG/Temp  ',
    enabled: 'yes',                      // not a Boolean: default
    trendGroup: 'Line 1/Area#2',
    label: { visible: 0, text: 42, unknownKey: 1 },
    value: { decimals: -1, maxArrayItems: 1000, format: null },
    units: 'oops',
    quality: { indicator: 'blink' },
    bounds: { enabled: true, low: '5', high: 'NaN', appearance: 'neon', lowColor: 'red;}', highColor: '#123456' },
    alarms: { colorMode: 'LIVE', thresholds: [{ priority: 'High', above: 80 }, { priority: 'Bogus', above: 1 }, 7, { above: 3 }] },
    setpoint: { enabled: 1, mode: 'inline', maxStep: 0, maxStepPercent: 150, verifyMs: 999999, options: [{ label: 'x' }, { value: 1, label: 'One', isDisabled: 'yes' }],
      spinner: { increment: -2 }, access: { roles: ['Operator', 7, null], requireLogin: 'no' } },
    menu: { longPressMs: 10, items: [{ id: 'a', label: 'A' }, { label: 'no id' }, { id: '', label: 'empty' }], trendPopup: { popup: { width: 5 } } },
    layout: { direction: 'diagonal', autoFontSize: { min: 50, max: 10, labelScale: 9 } },
  }));
  assert.equal(cfg.tagPath, '  [default]CTG/Temp  ');
  assert.equal(cfg.tagPathTrimmed, '[default]CTG/Temp');
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.trendGroup, 'Line_1_Area_2', 'trend group normalisation');
  assert.equal(cfg.label.visible, false, '0 coerces to false (schema-lite boolean)');
  assert.equal(cfg.label.text, '42');
  assert.equal('unknownKey' in cfg.label, false, 'additionalProperties:false');
  assert.equal(cfg.value.decimals, 0, 'decimals -1 clamped to 0');
  assert.equal(cfg.value.maxArrayItems, 100);
  assert.equal(cfg.value.format, '');
  assert.deepEqual(plain(cfg.units), plain(NS.dt.DEFAULTS.units));
  assert.equal(cfg.quality.indicator, 'icon');
  assert.equal(cfg.bounds.low, 5);
  assert.equal(cfg.bounds.high, null);
  assert.equal(cfg.bounds.appearance, 'border');
  assert.equal(cfg.bounds.lowColor, '', 'unsafe colour ignored');
  assert.equal(cfg.bounds.highColor, '#123456');
  assert.equal(cfg.alarms.colorMode, 'auto', 'enums are case-sensitive');
  assert.deepEqual(plain(cfg.alarms.thresholds), [
    { priority: 'High', above: 80, below: null, inclusive: true },
    { priority: 'Medium', above: 3, below: null, inclusive: true },
  ], 'unknown priority and non-objects dropped; missing priority = schema default Medium');
  assert.equal(cfg.setpoint.enabled, true);
  assert.equal(cfg.setpoint.mode, 'popup', "'inline' is not a setpoint mode");
  assert.equal(cfg.setpoint.maxStep, null, 'exclusiveMinimum 0: 0 = off');
  assert.equal(cfg.setpoint.maxStepPercent, 100);
  assert.equal(cfg.setpoint.verifyMs, 60000);
  assert.deepEqual(plain(cfg.setpoint.options), [{ value: 1, label: 'One', isDisabled: false }], 'items without value dropped');
  assert.equal(cfg.setpoint.spinner.increment, 1);
  assert.deepEqual(plain(cfg.setpoint.access), { roles: ['Operator'], securityLevels: [], requireLogin: false }, 'setpoint needs no login by default');
  assert.equal(cfg.menu.longPressMs, 300);
  assert.deepEqual(plain(cfg.menu.items), [{ id: 'a', label: 'A', enabled: true, separatorBefore: false,
    access: { roles: [], securityLevels: [], requireLogin: false } }]);
  assert.equal(cfg.menu.trendPopup.popup.width, 200);
  assert.equal(cfg.layout.direction, 'column');
  assert.equal(cfg.layout.autoFontSize.labelScale, 1);
  assert.ok(cfg.layout.autoFontSize.max >= cfg.layout.autoFontSize.min);
});

test('decimals: -1 / 101 / 2.7 / "x" / "3" (bound values) clamp or fall back, never throw', () => {
  const { NS } = load();
  const r = NS.dt.makeReducer();
  const d = v => r(tree({ value: { decimals: v } })).value.decimals;
  assert.equal(d(-1), 0);
  assert.equal(d(101), 15);
  assert.equal(d(2.7), 2);
  assert.equal(d('x'), null);
  assert.equal(d('3'), 3);
  assert.equal(d(null), null);
  assert.equal(d(Infinity), null);
});

test('styles: psc- prefix on label/value/units/setpoint/state styles; root font-size flags', () => {
  const { NS } = load();
  const cfg = NS.dt.makeReducer()(tree({
    label: { style: { classes: 'DtBig other', color: 'blue' } },
    value: { style: { classes: ['DtVal', 'ia_x'], 'font-size': '30px' } },
    states: { options: [{ value: 3, label: 'Fault', style: { classes: 'Bad', backgroundColor: '--error' } }] },
    style: { classes: '' },
  }));
  assert.equal(cfg.styles.label.className, 'psc-DtBig psc-other');
  assert.equal(cfg.styles.label.style.color, 'blue');
  assert.equal(cfg.styles.value.className, 'psc-DtVal ia_x');
  assert.equal(cfg.styles.value.style.fontSize, '30px');
  assert.equal(cfg.styles.states[0].className, 'psc-Bad');
  assert.equal(cfg.styles.states[0].style.backgroundColor, 'var(--error)');
  assert.deepEqual(plain(cfg.fontOverride), { label: false, value: true });
});

test('memoisation: unchanged tree \u2192 same object; one group changed \u2192 only that group is new', () => {
  const { NS } = load();
  const r = NS.dt.makeReducer();
  const obj = { tagPath: '[default]CTG/Temp', setpoint: { enabled: true }, label: { text: 'A' } };
  const a = r(tree(obj));
  const b = r(tree(JSON.parse(JSON.stringify(obj))));
  assert.equal(a, b, 'same object when nothing changed (cheap HOC re-renders)');
  const c = r(tree({ ...obj, label: { text: 'B' } }));
  assert.notEqual(c, a);
  assert.equal(c.setpoint, a.setpoint, 'untouched groups keep their identity');
  assert.equal(c.label.text, 'B');
});

test('v1 detection: signature keys are reported, never read', () => {
  const { NS } = load();
  const r = NS.dt.makeReducer();
  const cfg = r(tree({ tagPath: '[default]CTG/Temp', showTagName: false, valuePrecision: 3, setpoint: true, row: true }));
  assert.deepEqual(plain([...cfg.v1Keys].sort()), ['row', 'setpoint', 'showTagName', 'valuePrecision']);
  assert.equal(cfg.setpoint.enabled, false, 'v1 boolean setpoint is not read as setpoint.enabled');
  assert.equal(cfg.value.decimals, null, 'valuePrecision is not read');
  assert.equal(cfg.layout.direction, 'column');
  assert.deepEqual(plain(r(tree({ tagPath: 'x' })).v1Keys), []);
});

test('the reducer survives a throwing tree and odd raw values', () => {
  const { NS } = load();
  const r = NS.dt.makeReducer();
  const bad = { read() { throw new Error('boom'); } };
  const cfg = r(bad);
  assert.equal(cfg.enabled, true);
  const cyc = { a: 1 }; cyc.self = cyc;
  assert.doesNotThrow(() => r(tree({ label: cyc, setpoint: { options: 'nope' }, menu: { items: null } })));
});

test('component meta registers with the expected id, default size and a delegate', () => {
  const { env } = load();
  assert.ok(env.registered.includes('com.example.simpletagdisplay.SimpleTagDisplay'));
  const meta = env.window.PerspectiveClient.ComponentRegistry.getMeta('com.example.simpletagdisplay.SimpleTagDisplay');
  assert.deepEqual(plain(meta.getDefaultSize()), { width: 160, height: 64 });
  const t1 = tree({ tagPath: 'a' });
  assert.equal(meta.getPropsReducer(t1), meta.getPropsReducer(t1), 'per-tree memo');
  const d = meta.createDelegate({ addressPathString: '0:1' });
  assert.equal(d.kind, 'dt');
  assert.equal(d.silenceLimitMs, 75000, 'STALE after 75 s without a push');
});
