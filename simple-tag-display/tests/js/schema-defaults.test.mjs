// =============================================================================
// schema-defaults.test.mjs — structural checks of the two v2 props schemas
// =============================================================================
// Run:  node --test simple-tag-display/tests/js
//
// The Designer drops a component with the object-level `default` of every prop
// group, and the JS reducers deep-merge the raw tree onto the same defaults. If
// an object's `default` drifts from the defaults of its own leaves, the
// Designer shows one value while the component behaves as if it had another
// (as happened in v1). These checks keep the two in lock-step:
//
//   1. Every object node that declares `properties` has
//      `additionalProperties: false` (typo detection in the property editor).
//   2. Every object node outside an array item carries an object-level
//      `default`, and every property of such an object has a default.
//   3. Every object-level `default` deep-equals the assembly of its children's
//      defaults (array-item objects are checked when they carry a default).
//   4. Scalar defaults respect their own `enum`, `minimum`/`maximum` and type.
//   5. The root assembly has exactly the root's property keys.
//
// No dependencies: node:test + node:assert only.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.resolve(here, '..', '..', 'common', 'src', 'main', 'resources', 'schemas');

const SCHEMAS = {
  displaytemplate: 'displaytemplate.props.json',
  ctgchart: 'ctgchart.props.json',
};

const STYLE_REF = 'urn:ignition-schema:schemas/style-properties.schema.json';

function load(file) {
  return JSON.parse(readFileSync(path.join(SCHEMA_DIR, file), 'utf8'));
}

function isObjectNode(node) {
  return node && typeof node === 'object' && node.properties && typeof node.properties === 'object';
}

/** Default of a node: its own `default`, else the assembly of an object node, else undefined. */
function effectiveDefault(node) {
  if (node && Object.prototype.hasOwnProperty.call(node, 'default')) return node.default;
  if (isObjectNode(node)) return assemble(node);
  return undefined;
}

/** Object built from the defaults of an object node's properties. */
function assemble(node) {
  const out = {};
  for (const [key, child] of Object.entries(node.properties)) {
    const d = effectiveDefault(child);
    if (d !== undefined) out[key] = d;
  }
  return out;
}

function typesOf(node) {
  if (!node.type) return null;
  return Array.isArray(node.type) ? node.type : [node.type];
}

function jsonTypeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;   // 'number' | 'string' | 'boolean' | 'object'
}

function typeAccepts(types, v) {
  const t = jsonTypeOf(v);
  return types.some(x => x === t || (x === 'number' && t === 'integer') || (x === 'date' && (t === 'null' || t === 'number')));
}

/**
 * Walk every node, calling visit(node, path, ctx). ctx.inItems is true below an
 * array's `items` (array-item objects may legitimately omit defaults).
 */
function walk(node, p, ctx, visit) {
  if (!node || typeof node !== 'object') return;
  visit(node, p, ctx);
  if (isObjectNode(node)) {
    for (const [k, child] of Object.entries(node.properties)) walk(child, p ? `${p}.${k}` : k, ctx, visit);
  }
  if (node.items && typeof node.items === 'object' && !Array.isArray(node.items)) {
    walk(node.items, `${p}[]`, { ...ctx, inItems: true }, visit);
  }
}

for (const [name, file] of Object.entries(SCHEMAS)) {
  const schema = load(file);

  test(`${name}: root is a closed object`, () => {
    assert.equal(schema.type, 'object');
    assert.equal(schema.additionalProperties, false, 'root additionalProperties must be false');
    assert.ok(Object.keys(schema.properties).length > 0);
  });

  test(`${name}: every object node is closed and carries a matching default`, () => {
    const problems = [];
    walk(schema, '', { inItems: false }, (node, p, ctx) => {
      if (!isObjectNode(node)) return;
      if (node.additionalProperties !== false) problems.push(`${p || '<root>'}: additionalProperties must be false`);
      if (p === '') return;   // the root has no object-level default; checked by the root test below
      const has = Object.prototype.hasOwnProperty.call(node, 'default');
      if (!has && !ctx.inItems) problems.push(`${p}: object-level "default" missing`);
      if (!ctx.inItems) {
        for (const [k, child] of Object.entries(node.properties)) {
          if (effectiveDefault(child) === undefined) problems.push(`${p}.${k}: property has no default`);
        }
      }
      if (has) {
        try { assert.deepStrictEqual(node.default, assemble(node)); }
        catch { problems.push(`${p}: default ${JSON.stringify(node.default)} != assembled ${JSON.stringify(assemble(node))}`); }
      }
    });
    assert.deepEqual(problems, []);
  });

  test(`${name}: every top-level property has a default`, () => {
    const missing = Object.entries(schema.properties).filter(([, n]) => effectiveDefault(n) === undefined).map(([k]) => k);
    assert.deepEqual(missing, []);
    assert.deepEqual(Object.keys(assemble(schema)).sort(), Object.keys(schema.properties).sort());
  });

  test(`${name}: scalar defaults respect enum, range and type`, () => {
    const problems = [];
    walk(schema, '', { inItems: false }, (node, p) => {
      if (!Object.prototype.hasOwnProperty.call(node, 'default') || isObjectNode(node)) return;
      const d = node.default;
      const types = typesOf(node);
      if (types && !typeAccepts(types, d)) problems.push(`${p}: default ${JSON.stringify(d)} is not of type ${types}`);
      if (Array.isArray(node.enum) && !node.enum.includes(d)) problems.push(`${p}: default ${JSON.stringify(d)} not in enum`);
      if (typeof d === 'number') {
        if (typeof node.minimum === 'number' && d < node.minimum) problems.push(`${p}: default ${d} < minimum`);
        if (typeof node.maximum === 'number' && d > node.maximum) problems.push(`${p}: default ${d} > maximum`);
        if (typeof node.exclusiveMinimum === 'number' && d <= node.exclusiveMinimum) problems.push(`${p}: default ${d} <= exclusiveMinimum`);
      }
    });
    assert.deepEqual(problems, []);
  });

  test(`${name}: style props use the standard style $ref with {classes:""}`, () => {
    const problems = [];
    walk(schema, '', { inItems: false }, (node, p) => {
      if (node.$ref === undefined) return;
      if (node.$ref !== STYLE_REF) problems.push(`${p}: unexpected $ref ${node.$ref}`);
      try { assert.deepStrictEqual(node.default, { classes: '' }); } catch { problems.push(`${p}: style default must be {classes:""}`); }
    });
    assert.deepEqual(problems, []);
  });
}

test('displaytemplate: the [S] security keys exist', () => {
  const s = load(SCHEMAS.displaytemplate);
  const keys = ['tagPath', 'enabled', 'trendGroup', 'bounds.lowAlarmName', 'bounds.highAlarmName', 'alarms.colorMode',
    'setpoint.enabled', 'setpoint.access.roles', 'setpoint.access.securityLevels', 'setpoint.access.requireLogin',
    'setpoint.limits.useEngLimits', 'setpoint.limits.low', 'setpoint.limits.high', 'setpoint.limits.inclusive',
    'setpoint.maxStep', 'setpoint.maxStepPercent', 'setpoint.options', 'setpoint.maxStringLength', 'setpoint.allowOnBadQuality',
    'menu.enabled', 'menu.trend.enabled', 'menu.trend.access.roles', 'menu.configEdit.enabled', 'menu.configEdit.access.roles',
    'menu.changeHistory.enabled', 'menu.changeHistory.access.roles', 'menu.changeHistory.limit'];
  for (const k of keys) {
    let n = s;
    for (const part of k.split('.')) { n = n.properties && n.properties[part]; assert.ok(n, `missing ${k}`); }
    assert.match(String(n.description || ''), /\[S\]/, `${k} description must be marked [S]`);
  }
});

test('ctgchart: the [S] security keys exist', () => {
  const s = load(SCHEMAS.ctgchart);
  const keys = ['enabled', 'trendGroup', 'trendEdit.enabled', 'trendEdit.access.roles', 'readScope.allowedRoots',
    'readScope.allowRuntimePens', 'tagBrowser.enabled', 'tagBrowser.rootPath', 'tagBrowser.access.roles', 'annotations.enabled',
    'annotations.edit.enabled', 'annotations.edit.ownOnly', 'annotations.moderate.enabled'];
  for (const k of keys) {
    let n = s;
    for (const part of k.split('.')) { n = n.properties && n.properties[part]; assert.ok(n, `missing ${k}`); }
  }
  // aggregation enums are the 17 AggregationMode names (+ "default" on pens)
  assert.equal(s.properties.query.properties.aggregation.enum.length, 17);
  assert.equal(s.properties.pens.items.properties.aggregation.enum.length, 18);
});
