// =============================================================================
// chart-reducer.test.mjs — CtgChart props reducer
// =============================================================================
// Static check: the JS mirror of the props schema (NS.chart.SPEC)
// must equal ctgchart.props.json node for node — key sets, types, defaults,
// enums, bounds — and reduceProps() of an empty tree must produce exactly the
// schema's key set and default values. Then the reducer's runtime rules:
// nullish-not-falsy defaults, clamps, enum fallback, dates, array item
// filtering, frozen output, non-enumerable extras.
//
// Run: node --test "simple-tag-display/tests/js/*.test.mjs"
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEnv, FILES } from './_stubs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(path.resolve(here, '..', '..', 'common', 'src', 'main', 'resources', 'schemas',
  'ctgchart.props.json'), 'utf8'));
const STYLE_REF = 'urn:ignition-schema:schemas/style-properties.schema.json';

function load() {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-feedc0de');
  return { env, NS: env.window.__CTG, C: env.window.__CTG.chart };
}
const plain = (x) => JSON.parse(JSON.stringify(x));     // vm realm -> this realm

/** Default of a schema node: own default, else the assembly of its properties. */
function schemaDefault(node) {
  if (Object.prototype.hasOwnProperty.call(node, 'default')) return node.default;
  if (node.properties) {
    const o = {};
    for (const [k, c] of Object.entries(node.properties)) o[k] = schemaDefault(c);
    return o;
  }
  return undefined;
}

/** Walks spec and schema together; returns a list of mismatch strings. */
function compare(spec, node, at, out) {
  const fail = (msg) => out.push(`${at || '<root>'}: ${msg}`);
  if (node.$ref) {
    if (node.$ref !== STYLE_REF) fail('unknown $ref ' + node.$ref);
    if (spec.t !== 'style') fail(`spec ${spec.t} for a style ref`);
    else assertEq(plain(spec.d), node.default, fail, 'style default');
    return out;
  }
  const types = Array.isArray(node.type) ? node.type : [node.type];
  const nullable = types.includes('null');
  const base = types.filter((t) => t !== 'null');
  if (node.properties) {
    if (spec.t !== 'object') { fail(`spec ${spec.t} for an object`); return out; }
    const a = Object.keys(spec.p).sort(), b = Object.keys(node.properties).sort();
    assertEq(a, b, fail, 'keys');
    for (const k of b) if (spec.p[k]) compare(spec.p[k], node.properties[k], at ? `${at}.${k}` : k, out);
    return out;
  }
  if (base[0] === 'array') {
    if (spec.t !== 'array') { fail(`spec ${spec.t} for an array`); return out; }
    assertEq(plain(spec.d), node.default, fail, 'array default');
    assertEq(spec.minItems || 0, node.minItems || 0, fail, 'minItems');
    const it = node.items || {};
    if (it.properties) {
      if (spec.item.t !== 'object') fail('item spec is not an object');
      else compare(spec.item, it, `${at}[]`, out);
    } else if (it.type === 'object') {
      if (spec.item.t !== 'any-object') fail(`item spec ${spec.item.t} for plain objects`);
    } else if (spec.item.t !== it.type) fail(`item spec ${spec.item.t} vs ${it.type}`);
    return out;
  }
  if (node.enum) {
    if (spec.t !== 'enum') fail(`spec ${spec.t} for an enum`);
    else assertEq(plain(spec.values), node.enum, fail, 'enum values');
    assertEq(spec.d, node.default, fail, 'default');
    return out;
  }
  if (base[0] === 'date') {
    if (spec.t !== 'date') fail(`spec ${spec.t} for a date`);
    assertEq(spec.d, node.default, fail, 'default');
    return out;
  }
  if (spec.t !== base[0]) fail(`type ${spec.t} vs ${base[0]}`);
  if (!!spec.nullable !== nullable) fail(`nullable ${!!spec.nullable} vs ${nullable}`);
  assertEq(spec.d, node.default, fail, 'default');
  assertEq(spec.min, node.minimum, fail, 'minimum');
  assertEq(spec.max, node.maximum, fail, 'maximum');
  assertEq(spec.maxLength, node.maxLength, fail, 'maxLength');
  return out;
}
function assertEq(a, b, fail, what) {
  if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${what}: spec ${JSON.stringify(a)} != schema ${JSON.stringify(b)}`);
}

test('the JS spec mirrors ctgchart.props.json exactly', () => {
  const { C } = load();
  const problems = compare(C.SPEC, SCHEMA, '', []);
  assert.deepEqual(problems, []);
});

test('the spec/schema comparison itself detects drift (self-check)', () => {
  const { C } = load();
  const drift = JSON.parse(JSON.stringify(SCHEMA));
  drift.properties.query.properties.pointCount.maximum = 4000;
  drift.properties.timeRange.properties.mode.enum.push('rolling');
  drift.properties.penTable.properties.columns.properties.extra = { type: 'boolean', default: true };
  drift.properties.pens.items.properties.display.properties.width.default = 2;
  const problems = compare(C.SPEC, drift, '', []);
  assert.equal(problems.length, 4, problems.join('\n'));
});

test('reduceProps({}) has exactly the schema key set and default values', () => {
  const { C } = load();
  const r = C.reduceProps({});
  assert.deepEqual(Object.keys(r).sort(), Object.keys(SCHEMA.properties).sort());
  assert.deepEqual(plain(r), schemaDefault(SCHEMA));
  assert.deepEqual(plain(C.DEFAULTS), schemaDefault(SCHEMA));
});

test('reduceProps reads a PropertyTree through read(key) and ignores unknown keys', () => {
  const { C } = load();
  const raw = { enabled: false, query: { mode: 'raw', bogus: 1 }, nonsense: 5 };
  const tree = { read: (k) => raw[k], readStyle: () => null };
  const r = C.reduceProps(tree);
  assert.equal(r.enabled, false);
  assert.equal(r.query.mode, 'raw');
  assert.equal(r.query.bogus, undefined);
  assert.equal(r.nonsense, undefined);
  assert.equal(r.query.aggregation, 'MinMax', 'missing leaf -> default');
});

test('nullish, not falsy: 0 and false survive; null/undefined/wrong types fall back', () => {
  const { C } = load();
  const r = C.reduceProps({
    timeRange: { refreshRate: 0, realtime: { value: null, unit: 'parsecs' } },
    query: { pointCount: 0, includeAnchor: false, autoRawBelowBucketMs: 0 },
    appearance: { liveBadge: 'no', fontSize: '14' },
    trendGroup: null,
  });
  assert.equal(r.timeRange.refreshRate, 0, 'refreshRate 0 = off');
  assert.equal(r.timeRange.realtime.value, 8, 'null -> default');
  assert.equal(r.timeRange.realtime.unit, 'hours', 'unknown enum -> default');
  assert.equal(r.query.pointCount, 0, 'pointCount 0 = auto');
  assert.equal(r.query.includeAnchor, false);
  assert.equal(r.query.autoRawBelowBucketMs, 0);
  assert.equal(r.appearance.liveBadge, true, 'non-boolean -> default');
  assert.equal(r.appearance.fontSize, 14, 'numeric string accepted');
  assert.equal(r.trendGroup, null, 'trendGroup is nullable');
});

test('runtime clamps: schema bounds plus refreshRate/pointCount minimums', () => {
  const { C } = load();
  const r = C.reduceProps({
    timeRange: { refreshRate: 100 },
    query: { pointCount: 3, maxPointsPerPen: 50 },
    penTable: { size: 99999 },
    interaction: { rangeBrush: { controlLimits: { sigma: 100 } } },
  });
  assert.equal(r.timeRange.refreshRate, 250);
  assert.equal(r.query.pointCount, 10);
  assert.equal(r.query.maxPointsPerPen, 1000);
  assert.equal(r.penTable.size, 2000);
  assert.equal(r.interaction.rangeBrush.controlLimits.sigma, 6);
  const r2 = C.reduceProps({ timeRange: { refreshRate: 9e9 }, query: { pointCount: 77.9 } });
  assert.equal(r2.timeRange.refreshRate, 3600000);
  assert.equal(r2.query.pointCount, 77, 'integers are truncated');
});

test('historical dates: Date, epoch ms, ISO and numeric strings; garbage -> null', () => {
  const { C } = load();
  const iso = '2026-10-07T12:00:00Z';
  const ms = Date.parse(iso);
  const cases = [[new Date(ms), ms], [ms, ms], [iso, ms], [String(ms), ms], ['yesterday-ish', null], [NaN, null], [{}, null], [null, null]];
  for (const [input, want] of cases) {
    const r = C.reduceProps({ timeRange: { historical: { startDate: input } } });
    assert.equal(r.timeRange.historical.startDate, want, `startDate ${String(input)}`);
  }
});

test('pens: items merged over item defaults, non-objects dropped, index = raw position (non-enumerable)', () => {
  const { C } = load();
  const r = C.reduceProps({
    pens: [{ tagPath: '  [default]CTG/Temp ' }, 'junk', null, { tagPath: '[default]CTG/Pressure', aggregation: 'Nope', display: { width: 99 } }],
  });
  assert.equal(r.pens.length, 2);
  assert.equal(r.pens[0].tagPath, '[default]CTG/Temp', 'trimmed');
  assert.equal(r.pens[0].index, 0);
  assert.equal(r.pens[1].index, 3, 'index counts dropped items like the gateway\'s "p:<i>"');
  assert.equal(Object.keys(r.pens[1]).includes('index'), false, 'index is not written back');
  assert.equal(r.pens[1].aggregation, 'default');
  assert.equal(r.pens[1].display.width, 8, 'clamped');
  assert.equal(r.pens[1].display.type, 'line');
  assert.deepEqual(Object.keys(r.pens[0]).sort(), Object.keys(SCHEMA.properties.pens.items.properties).sort());
});

test('scalar arrays drop bad items; palette needs at least one entry', () => {
  const { C } = load();
  const r = C.reduceProps({
    readScope: { allowedRoots: ['[default]A', 5, null, { x: 1 }] },
    pens: [{ display: { dash: [4, '2', 'x'] } }],
    appearance: { palette: [] },
  });
  assert.deepEqual(plain(r.readScope.allowedRoots), ['[default]A', '5']);
  assert.deepEqual(plain(r.pens[0].display.dash), [4, 2]);
  assert.equal(r.appearance.palette.length, 10, 'empty palette -> default (minItems 1)');
});

test('output is deeply frozen and carries non-enumerable dataHash / structuralHash', () => {
  const { C } = load();
  const a = C.reduceProps({ pens: [{ tagPath: 'A' }] });
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.pens) && Object.isFrozen(a.pens[0].display));
  assert.equal(typeof a.dataHash, 'string');
  assert.equal(Object.keys(a).includes('dataHash'), false);
  const b = C.reduceProps({ pens: [{ tagPath: 'A', color: '#ff0000' }] });
  assert.equal(a.dataHash, b.dataHash, 'colour is not data');
  assert.notEqual(a.structuralHash, b.structuralHash, 'colour is structure');
  const c = C.reduceProps({ pens: [{ tagPath: 'A' }], query: { aggregation: 'Average' } });
  assert.notEqual(a.dataHash, c.dataHash);
  assert.equal(a.structuralHash, c.structuralHash);
});

test('style keys keep the raw style object (resolved by the render layer)', () => {
  const { C } = load();
  const r = C.reduceProps({ style: { classes: 'big', color: 'red' }, title: { style: 'nope' } });
  assert.deepEqual(plain(r.style), { classes: 'big', color: 'red' });
  assert.deepEqual(plain(r.title.style), { classes: '' });
});

test('the registered component meta reduces through NS.chart.reduceProps', () => {
  const { env, C } = load();
  const meta = env.window.PerspectiveClient.ComponentRegistry.getMeta('com.example.simpletagdisplay.CtgChart');
  const r = meta.getPropsReducer({ read: (k) => (k === 'timeRange' ? { mode: 'historical' } : undefined) });
  assert.equal(r.timeRange.mode, 'historical');
  assert.deepEqual(Object.keys(r).sort(), Object.keys(C.DEFAULTS).sort());
});
