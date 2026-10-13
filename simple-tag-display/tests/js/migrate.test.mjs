// =============================================================================
// migrate.test.mjs — v1 → v2 view migration (tools/migrate-v1-views.mjs)
// =============================================================================
// Run:  node --test "simple-tag-display/tests/js/*.test.mjs"
//
// Fixtures (tests/js/fixtures/):
//   v1-views/display-defaults.view.json  v1 palette drop: every v1 schema default stored
//   v1-views/all-keys.view.json          every v1 key set to a non-default value (+ v1 reducer-only keys)
//   v1-views/bindings.view.json          propConfig on v1 keys: 1:1 moves, manual cases, onChange
//   v1-views/nested.view.json            components inside tab/flex/column containers
//   v1-views/external-refs.view.json     other components/scripts referencing v1 props (+ negatives)
//   v1-views/mixed-and-v2.view.json      already-v2 and half-migrated components
//   v1-views/ctg-test-main.view.json     the real v1 test view (CTG_Test/Main)
//   v1-views/unrelated.view.json         a pre-module v1 view without module components (no false hits)
//   v1-views/library-code.py             a project library script with v1 references
//   v1-export.zip                        a REAL gateway project export (GET /data/api/v1/projects/export)
//                                        of a project holding five of the views above + the script
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as M from '../../tools/migrate-v1-views.mjs';
import { readZip, writeZip, entryData, crc32 } from '../../tools/lib/mini-zip.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures', 'v1-views');
const ZIP = path.join(here, 'fixtures', 'v1-export.zip');
const TOOL = path.resolve(here, '..', '..', 'tools', 'migrate-v1-views.mjs');
const schemas = M.loadSchemas();

const fixture = (name) => JSON.parse(readFileSync(path.join(FIX, name), 'utf8'));
const tmp = (tag) => mkdtempSync(path.join(os.tmpdir(), `ctg-migrate-${tag}-`));

function migrate(name, opts = {}) {
  const view = fixture(name);
  const res = M.migrateView(view, opts, schemas);
  return { view, res };
}

/** Find a component by meta.name anywhere in a view. */
function comp(view, name) {
  let found = null;
  const walk = (n) => {
    if (!n || found) return;
    if (n.meta?.name === name) found = n;
    (n.children || []).forEach(walk);
  };
  walk(view.root);
  assert.ok(found, `component ${name} not found`);
  return found;
}
const report = (res, where) => res.components.find((c) => c.where === where);

/** Minimal validator: every stored leaf exists in the v2 schema with a valid type / enum / range. */
function validate(node, value, p = '') {
  const problems = [];
  if (!node) return [`${p}: not in the v2 schema`];
  if (node.$ref) return isObj(value) ? [] : [`${p}: style must be an object`];
  const types = node.type ? [].concat(node.type) : [];
  const t = value === null ? 'null' : Array.isArray(value) ? 'array' : Number.isInteger(value) ? 'integer' : typeof value;
  const ok = !types.length || types.some((x) => x === t || (x === 'number' && t === 'integer') || (x === 'date' && (t === 'number' || t === 'integer' || t === 'null')));
  if (!ok) problems.push(`${p}: ${JSON.stringify(value)} is not ${types.join('|')}`);
  if (node.enum && !node.enum.includes(value)) problems.push(`${p}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === 'number' && node.minimum !== undefined && value < node.minimum) problems.push(`${p}: below minimum`);
  if (typeof value === 'number' && node.maximum !== undefined && value > node.maximum) problems.push(`${p}: above maximum`);
  if (node.properties && isObj(value)) {
    for (const [k, v] of Object.entries(value)) problems.push(...validate(node.properties[k], v, p ? `${p}.${k}` : k));
  }
  return problems;
}
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Build a project folder (views + script library) from the fixtures. */
function makeProject(dir, views) {
  const persp = path.join(dir, 'com.inductiveautomation.perspective', 'views');
  for (const [viewPath, file] of Object.entries(views)) {
    const d = path.join(persp, ...viewPath.split('/'));
    mkdirSync(d, { recursive: true });
    cpSync(path.join(FIX, file), path.join(d, 'view.json'));
    writeFileSync(path.join(d, 'resource.json'), '{"scope":"G","version":1,"files":["view.json"],"attributes":{}}');
  }
  const lib = path.join(dir, 'ignition', 'script-python', 'ctg', 'helpers');
  mkdirSync(lib, { recursive: true });
  cpSync(path.join(FIX, 'library-code.py'), path.join(lib, 'code.py'));
  return dir;
}
const ALL_VIEWS = {
  Defaults: 'display-defaults.view.json', AllKeys: 'all-keys.view.json', Bindings: 'bindings.view.json',
  'Deep/Nested': 'nested.view.json', Refs: 'external-refs.view.json', Mixed: 'mixed-and-v2.view.json',
  Main: 'ctg-test-main.view.json', Unrelated: 'unrelated.view.json',
};

/** Snapshot of every file under a folder: relative path → bytes. */
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = readFileSync(p);
    }
  };
  walk(dir);
  return out;
}

// ---- 1. defaults --------------------------------------------------------------
test('default drop: a v1 palette drop keeps only what differs from v2', () => {
  const { view, res } = migrate('display-defaults.view.json');
  assert.equal(res.changed, true);
  assert.deepEqual(comp(view, 'DisplayTemplate').props, {
    tagPath: '[default]CTG/Temp',
    value: { decimals: 1 },                       // valuePrecision stored → written (v1 showed 1 decimal)
    units: { visible: false },                    // v1 default false, v2 default true
    layout: { verticalAlign: 'top' },             // v1 default top, v2 default center
  });
  assert.deepEqual(comp(view, 'CTG-Chart').props, {
    timeRange: { realtime: { value: 1, unit: 'days' } },   // rangeHours 24 → largest integer unit
    query: { pointCount: 300 },
    toolbar: { buttons: { refreshRate: true } },           // v1 showed the refresh-rate input unless hidden
  });
  for (const c of res.components) assert.deepEqual(c.warnings, [], `${c.where} has no warnings`);
});

test('absent v1 keys take v1 defaults; valuePrecision absent is not written', () => {
  const { view } = migrate('ctg-test-main.view.json');
  assert.deepEqual(comp(view, 'Running').props, { tagPath: '[default]CTG/Running', units: { visible: false }, layout: { verticalAlign: 'top' } });
  assert.deepEqual(comp(view, 'Temp').props, { tagPath: '[default]CTG/Temp', layout: { verticalAlign: 'top' } });
  assert.deepEqual(comp(view, 'Chart').props, { timeRange: { realtime: { value: 15, unit: 'minutes' } }, query: { pointCount: 300 },
    toolbar: { buttons: { refreshRate: true } } });
  // Non-module components are untouched.
  assert.deepEqual(comp(view, 'Title'), fixture('ctg-test-main.view.json').root.children[0]);
});

// ---- 2. every key -------------------------------------------------------------
test('every v1 display key maps to its v2 name', () => {
  const { view, res } = migrate('all-keys.view.json');
  assert.deepEqual(comp(view, 'Full').props, {
    tagPath: '[default]CTG/TempSP',
    label: { visible: false, text: 'Setpoint', style: { classes: 'label-cls', color: '#333333' } },
    value: { decimals: 3, style: { classes: '', fontWeight: 'bold' } },
    states: { boolean: { trueText: 'ON', falseText: 'OFF' } },
    bounds: { enabled: true, appearance: 'background', lowColor: '#0000FF', highColor: '#FF00FF' },   // inclusive true = v2 default
    setpoint: { enabled: true, access: { requireLogin: false }, limits: { useEngLimits: false } },
    layout: { direction: 'row', evenSplit: true, verticalAlign: 'bottom' },
    style: { classes: 'card', backgroundColor: '#FAFAFA' },
  });
  const w = report(res, 'root/Full').warnings.join('\n');
  assert.match(w, /ctg\.write\.requireAuthenticated/, 'floor-policy warning for setpoint:true');
  assert.match(w, /useEngLimits=false/);
});

test('every v1 chart key maps to its v2 name, with clamps', () => {
  const { view, res } = migrate('all-keys.view.json');
  assert.deepEqual(comp(view, 'FullChart').props, {
    timeRange: {
      mode: 'historical',
      realtime: { value: 90, unit: 'minutes' },
      refreshRate: 250,                                        // 100 → 250
      historical: { startDate: Date.parse('2026-01-02T03:04:05Z'), endDate: Date.parse('2026-01-03T00:00:00.000Z') },
    },
    query: { mode: 'raw', pointCount: 5000 },                  // 20000 clamped
    timeAxis: { format: 'DD.MM.YYYY HH:mm' },
    interaction: { panAndZoom: { freeRange: false } },          // v1 interaction.mode/xTraceVisible dropped
    // showDateRangeSelector/showPenControlDisplay false: ignored by the v1 reducer → not carried over (warning)
    toolbar: { buttons: { refresh: false, resetZoom: false, fullscreen: false, refreshRate: true } },
    style: { classes: 'trend' },
  });
  const w = report(res, 'root/FullChart').warnings.join('\n');
  for (const re of [/refreshRate 100/, /pointCount 20000 clamped to 5000/, /timeAxis\.format/, /interaction\.mode "selection" dropped/, /xTraceVisible false dropped/,
    /showDateRangeSelector false was ignored by v1/, /showPenControlDisplay false was ignored by v1/]) {
    assert.match(w, re);
  }
  // v1 reducer-only flags: the date pill hides only when BOTH showRangePresets and showModeToggle are false.
  assert.deepEqual(comp(view, 'ReducerKeys').props, {
    timeRange: { realtime: { value: 1, unit: 'weeks' }, refreshRate: 0 },
    penTable: { visible: false },
    toolbar: { buttons: { dateRange: false, refreshRate: true } },
  });
});

test('rangeHours → largest integer unit; pointCount and refreshRate edges', () => {
  const cases = [[24, 1, 'days'], [168, 1, 'weeks'], [720, 30, 'days'], [0.25, 15, 'minutes'], [0.1, 6, 'minutes'],
    [1.5, 90, 'minutes'], [8, 8, 'hours'], [1 / 7200, 1, 'seconds'], [336, 2, 'weeks']];
  for (const [h, value, unit] of cases) assert.deepEqual(M.rangeHoursToRealtime(h), { value, unit }, `rangeHours ${h}`);
  const w = [];
  assert.deepEqual(M.rangeHoursToRealtime(0, w), { value: 1, unit: 'seconds' });
  assert.match(w.join(), /below one second/);

  const chart = (props) => {
    const view = { root: { type: 'ia.container.flex', meta: { name: 'root' }, children: [{ type: M.TYPE_CHART, meta: { name: 'C' }, props }] } };
    M.migrateView(view, {}, schemas);
    return view.root.children[0].props;
  };
  assert.equal(chart({ pointCount: 0 }).query, undefined, 'pointCount 0 = v2 auto (default) → not written');
  assert.equal(chart({ pointCount: 5 }).query.pointCount, 10);
  assert.equal(chart({ pointCount: 1234.4 }).query.pointCount, 1234);
  assert.equal(chart({ refreshRate: 249 }).timeRange.refreshRate, 250);
  assert.equal(chart({ refreshRate: 250 }).timeRange.refreshRate, 250);
  assert.equal(chart({ refreshRate: 1000 }).timeRange.realtime.value, 1, 'refreshRate 1000 = v2 default, dropped');
  assert.equal(chart({ startDate: 'not a date' }).timeRange.historical, undefined);
});

test('--keep-aggregation writes LastValue (not for raw history)', () => {
  const view = { root: { type: 'ia.container.flex', meta: { name: 'root' }, children: [
    { type: M.TYPE_CHART, meta: { name: 'A' }, props: { rangeHours: 1 } },
    { type: M.TYPE_CHART, meta: { name: 'B' }, props: { rangeHours: 1, rawHistory: true } },
  ] } };
  const res = M.migrateView(view, { keepAggregation: true }, schemas);
  assert.equal(view.root.children[0].props.query.aggregation, 'LastValue');
  assert.equal(view.root.children[1].props.query.aggregation, undefined);
  assert.equal(view.root.children[1].props.query.mode, 'raw');
  assert.deepEqual(res.components[0].notes, []);
  const { res: plain } = migrate('ctg-test-main.view.json');
  assert.match(report(plain, 'root/Chart').notes.join(), /MinMax/);
});

// ---- 3. bindings --------------------------------------------------------------
test('bindings: 1:1 moves, manual leftovers, warnings', () => {
  const { view, res } = migrate('bindings.view.json');
  const d = comp(view, 'Bound');
  assert.deepEqual(Object.keys(d.propConfig).sort(), [
    'custom.note', 'position.basis', 'props.bounds.minInclusive', 'props.label.style.color', 'props.label.visible',
    'props.row', 'props.setpoint.enabled', 'props.states.boolean.trueText', 'props.tagPath', 'props.units.visible',
  ]);
  const orig = fixture('bindings.view.json').root.children[0].propConfig;
  assert.deepEqual(d.propConfig['props.units.visible'], orig['props.showUnits'], 'entry moved whole');
  assert.deepEqual(d.propConfig['props.label.visible'], { persistent: true, access: 'PROTECTED' }, 'non-binding config moves too');
  assert.deepEqual(d.propConfig['props.row'], orig['props.row'], 'manual entry left in place');
  const r = report(res, 'root/Bound');
  assert.deepEqual(r.manual.map((m) => m.key).sort(), ['props.bounds.minInclusive', 'props.row']);
  assert.match(r.warnings.join('\n'), /rejectBoundGates/, 'bound setpoint gate warning');
  // A bound key is written even when its value equals the v2 default; bound setpoint keeps its extras.
  assert.equal(d.props.units.visible, true);
  assert.deepEqual(d.props.setpoint, { enabled: true, access: { requireLogin: false }, limits: { useEngLimits: false } });
  assert.equal(d.props.layout.direction, 'column');
  assert.equal(d.custom.note, 'kept');

  const c = comp(view, 'BoundChart');
  assert.deepEqual(c.props.timeRange.realtime, { value: 4, unit: 'hours' }, 'bound rangeHours keeps the unit hours');
  assert.deepEqual(c.propConfig['props.timeRange.refreshRate'], fixture('bindings.view.json').root.children[1].propConfig['props.refreshRate'], 'onChange script travels');
  assert.ok(c.propConfig['props.timeRange.realtime.value']);
  assert.ok(c.propConfig['props.penTable.visible']);
  const rc = report(res, 'root/BoundChart');
  assert.deepEqual(rc.manual.map((m) => m.key).sort(), ['props.interaction.xTraceVisible', 'props.rawHistory', 'props.visibility.showPenControlDisplay']);
  assert.match(rc.manual.find((m) => m.key === 'props.visibility.showPenControlDisplay').reason, /v1 ignored this flag/);
  assert.match(rc.warnings.join('\n'), /unit "hours"/);
});

test('second run: leftover manual bindings are reported again without warnings; late 1:1 bindings still move', () => {
  const { view } = migrate('bindings.view.json');
  const again = M.migrateView(view, {}, schemas);
  assert.equal(again.changed, false);
  for (const c of again.components) {
    assert.equal(c.status, 'already v2 (v1 bindings left)');
    assert.deepEqual(c.warnings, []);
    assert.ok(c.manual.length > 0);
  }
  // A binding added to a v1 key after the migration (props already v2) moves on the next run.
  const d = comp(view, 'Bound');
  d.propConfig['props.evenRow'] = { binding: { type: 'expr', config: { expression: 'true' } } };
  const third = M.migrateView(view, {}, schemas);
  assert.equal(third.changed, true);
  assert.equal(third.components[0].status, 'migrated (bindings only)');
  assert.ok(d.propConfig['props.layout.evenSplit']);
  assert.equal(d.propConfig['props.evenRow'], undefined);
});

test('ambiguous bindings (setpoint/bounds/interaction exist in v1 and v2) are never guessed', () => {
  const objBinding = { binding: { type: 'property', config: { path: 'view.custom.sp' } } };
  const view = { root: { type: 'ia.container.flex', meta: { name: 'root' }, children: [
    { type: M.TYPE_DISPLAY, meta: { name: 'V1' }, props: { tagPath: 'a', showUnits: true } },
    // No static value: v1 boolean or v2 object? → left in place, reported as manual.
    { type: M.TYPE_DISPLAY, meta: { name: 'NoStatic' }, propConfig: { 'props.setpoint': objBinding }, props: { tagPath: 'b' } },
    // Static v2 object: a v2 object binding → untouched, not reported.
    { type: M.TYPE_DISPLAY, meta: { name: 'V2Obj' }, propConfig: { 'props.setpoint': objBinding, 'props.showUnits': objBinding },
      props: { tagPath: 'c', setpoint: { enabled: true } } },
    { type: M.TYPE_CHART, meta: { name: 'V2Chart' }, propConfig: { 'props.interaction': objBinding, 'props.rangeHours': objBinding },
      props: { timeRange: { mode: 'realtime' } } },
  ] } };
  const res = M.migrateView(view, {}, schemas);
  const [, noStatic, v2obj, v2chart] = view.root.children;
  assert.deepEqual(Object.keys(noStatic.propConfig), ['props.setpoint']);
  assert.match(report(res, 'root/NoStatic').manual[0].reason, /v1 boolean .* or a v2 setpoint object/);
  assert.equal(noStatic.props.setpoint, undefined, 'no setpoint extras written for an unknown binding');
  assert.deepEqual(Object.keys(v2obj.propConfig).sort(), ['props.setpoint', 'props.units.visible'], 'v1 key moved, v2 object binding kept');
  assert.deepEqual(report(res, 'root/V2Obj').manual, []);
  assert.deepEqual(Object.keys(v2chart.propConfig).sort(), ['props.interaction', 'props.timeRange.realtime.value']);
  assert.deepEqual(report(res, 'root/V2Chart').manual, []);
});

test('bare components follow their view: a view with only v2 components keeps them as they are', () => {
  const bare = () => ({ type: M.TYPE_DISPLAY, meta: { name: 'Bare' }, props: { tagPath: 'x' } });
  const v2view = { root: { type: 'ia.container.flex', meta: { name: 'root' }, children: [
    { type: M.TYPE_DISPLAY, meta: { name: 'V2' }, props: { tagPath: 'y', units: { visible: true } } }, bare()] } };
  const r2 = M.migrateView(v2view, {}, schemas);
  assert.equal(r2.changed, false);
  assert.equal(report(r2, 'root/Bare').status, 'skipped (bare, view holds only v2 components)');
  const v1view = { root: { type: 'ia.container.flex', meta: { name: 'root' }, children: [
    { type: M.TYPE_DISPLAY, meta: { name: 'V1' }, props: { tagPath: 'y', showUnits: true } }, bare()] } };
  const r1 = M.migrateView(v1view, {}, schemas);
  assert.equal(report(r1, 'root/Bare').status, 'migrated');
});

test('bindingTarget table', () => {
  assert.deepEqual(M.bindingTarget('display', 'tagValueStyle.fontSize'), { to: 'value.style.fontSize' });
  assert.deepEqual(M.bindingTarget('display', 'style.classes'), { to: 'style.classes' });
  assert.deepEqual(M.bindingTarget('display', 'bounds.maxColor'), { to: 'bounds.highColor' });
  assert.ok(M.bindingTarget('display', 'boolean').manual);
  assert.equal(M.bindingTarget('display', 'label.text'), null, 'v2 key: not touched');
  assert.deepEqual(M.bindingTarget('chart', 'visibility.showZoomButton'), { to: 'toolbar.buttons.resetZoom' });
  assert.ok(M.bindingTarget('chart', 'visibility.showModeToggle').manual);
});

// ---- 4. nesting, mixed, already v2, bare --------------------------------------
test('nested containers: components at any depth are migrated, others untouched', () => {
  const { view, res } = migrate('nested.view.json');
  assert.deepEqual(res.components.map((c) => [c.where, c.status]), [
    ['root/Tabs/TabOne/Cols/Deep', 'migrated'], ['root/Tabs/TabTwo/DeepChart', 'migrated'],
  ]);
  assert.deepEqual(comp(view, 'Deep').props, { tagPath: '[default]CTG/Pressure', layout: { direction: 'row', verticalAlign: 'top' } });
  assert.deepEqual(comp(view, 'Deep').position, { basis: '80px', shrink: 0 });
  assert.deepEqual(comp(view, 'Embedded').props, { path: 'Popups/Faceplate', params: { showTagName: true } }, 'embedded view params untouched');
});

test('already-v2 components are skipped; mixed ones keep their v2 values', () => {
  const { view, res } = migrate('mixed-and-v2.view.json');
  const orig = fixture('mixed-and-v2.view.json');
  assert.deepEqual(comp(view, 'AlreadyV2'), orig.root.children[0]);
  assert.deepEqual(comp(view, 'AlreadyV2Chart'), orig.root.children[2]);
  assert.equal(report(res, 'root/AlreadyV2').status, 'already v2');
  assert.deepEqual(comp(view, 'Mixed').props, {
    tagPath: '[default]CTG/Temp', label: { text: 'Kept' }, units: { visible: false }, layout: { direction: 'row' }, customThing: 1,
  });
  const w = report(res, 'root/Mixed').warnings.join('\n');
  assert.match(w, /both v1 and v2 keys/);
  assert.match(w, /unknown prop "customThing"/);
  assert.deepEqual(comp(view, 'MixedChart').props, {
    timeRange: { realtime: { value: 2, unit: 'hours' } }, query: { aggregation: 'Average' }, interaction: { mode: 'zoom' },
  });
});

test('classification and --bare skip', () => {
  const c = (kind, props, pc) => M.classify(kind, props, pc, schemas);
  assert.equal(c('display', { tagPath: 'x' }), 'bare');
  assert.equal(c('display', {}), 'bare');
  assert.equal(c('display', { setpoint: false }), 'v1');
  assert.equal(c('display', { setpoint: { enabled: false } }), 'v2');
  assert.equal(c('display', { bounds: { enabled: true, minColor: '#f00' } }), 'v1');
  assert.equal(c('display', { bounds: { enabled: true, lowColor: '#f00' } }), 'v2');
  assert.equal(c('display', { tagPath: 'x' }, { 'props.showUnits': { binding: {} } }), 'v1', 'binding on a v1 key');
  assert.equal(c('chart', { interaction: { mode: 'panAndZoom' } }), 'v1');
  assert.equal(c('chart', { interaction: { mode: 'pan' } }), 'v2');
  assert.equal(c('chart', { style: { classes: '' } }), 'bare');
  const view = { root: { type: 'ia.container.flex', meta: { name: 'root' }, children: [{ type: M.TYPE_DISPLAY, meta: { name: 'B' }, props: { tagPath: 'x' } }] } };
  const res = M.migrateView(view, { bare: 'skip' }, schemas);
  assert.equal(res.changed, false);
  assert.equal(res.components[0].status, 'skipped (bare)');
});

test('every migrated component validates against the v2 schemas', () => {
  for (const file of Object.values(ALL_VIEWS)) {
    const { view } = migrate(file);
    const walk = (n) => {
      if (!n) return;
      if (n.type === M.TYPE_DISPLAY || n.type === M.TYPE_CHART) {
        const kind = n.type === M.TYPE_DISPLAY ? 'display' : 'chart';
        const problems = validate(schemas[kind], n.props).filter((p) => !p.startsWith('customThing'));
        assert.deepEqual(problems, [], `${file} ${n.meta.name}`);
      }
      (n.children || []).forEach(walk);
    };
    walk(view.root);
  }
});

// ---- 4b. idempotence, bare views, sub-hour bindings, --out safety ---------------
const view1 = (...children) => ({ root: { type: 'ia.container.flex', meta: { name: 'root' }, children } });
const kindOf = (n) => (n.type === M.TYPE_DISPLAY ? 'display' : 'chart');

test('every migrated component classifies as v2 (incl. all-defaults), so a second run is a no-op', () => {
  // All-defaults: every mapped value equals the v2 default → one marker key is kept.
  const allDefaults = view1(
    { type: M.TYPE_DISPLAY, meta: { name: 'D' }, props: { tagPath: 'a', showUnits: true, verticalAlign: 'center' } },
    { type: M.TYPE_CHART, meta: { name: 'C' }, props: { rangeHours: 8, pointCount: 0, visibility: { showRefreshRateControl: false } } },
  );
  const r = M.migrateView(allDefaults, {}, schemas);
  assert.deepEqual(allDefaults.root.children[0].props, { tagPath: 'a', units: { visible: true } });
  assert.deepEqual(allDefaults.root.children[1].props, { timeRange: { mode: 'realtime' } });
  assert.ok(r.components.every((c) => c.changes.some((ch) => ch.marker)), 'marker reported');
  const once = JSON.stringify(allDefaults);
  const again = M.migrateView(allDefaults, { bare: 'v1' }, schemas);
  assert.equal(again.changed, false);
  assert.equal(JSON.stringify(allDefaults), once, 'second run (even with --bare v1) is byte-identical');

  const views = [...Object.values(ALL_VIEWS).map((f) => migrate(f).view), allDefaults];
  for (const v of views) {
    const walk = (n) => {
      if (!n) return;
      if (n.type === M.TYPE_DISPLAY || n.type === M.TYPE_CHART) {
        assert.notEqual(M.classify(kindOf(n), n.props, null, schemas), 'bare', `${n.meta.name} is not bare after migration`);
        assert.notEqual(M.classify(kindOf(n), n.props, null, schemas), 'v1', `${n.meta.name}`);
      }
      (n.children || []).forEach(walk);
    };
    walk(v.root);
    const s = JSON.stringify(v);
    M.migrateView(v, { bare: 'v1' }, schemas);
    assert.equal(JSON.stringify(v), s, 'second run changes nothing');
  }
});

test('--bare auto (default): a view of only bare components is skipped as ambiguous; --bare v1 migrates it', () => {
  const mk = () => view1({ type: M.TYPE_DISPLAY, meta: { name: 'B' }, props: { tagPath: 'x', style: { classes: 'c' } } });
  const v = mk();
  const r = M.migrateView(v, {}, schemas);
  assert.equal(r.changed, false);
  assert.match(r.components[0].status, /^skipped \(bare, ambiguous/);
  assert.deepEqual(v, mk());
  const forced = mk();
  assert.equal(M.migrateView(forced, { bare: 'v1' }, schemas).components[0].status, 'migrated');
  assert.deepEqual(forced.root.children[0].props, { tagPath: 'x', units: { visible: false }, layout: { verticalAlign: 'top' }, style: { classes: 'c' } });
  // --bare v1 still leaves bare components alone in a view that holds v2 components and no v1 ones.
  const v2 = view1({ type: M.TYPE_DISPLAY, meta: { name: 'V2' }, props: { units: { visible: true } } }, mk().root.children[0]);
  assert.equal(M.migrateView(v2, { bare: 'v1' }, schemas).changed, false);
  // The CLI prints the ambiguous components prominently and counts them.
  const dir = tmp('bare');
  writeFileSync(path.join(dir, 'view.json'), JSON.stringify(mk(), null, 2));
  const out = cli(path.join(dir, 'view.json'));
  assert.match(out.stdout, /AMBIGUOUS: 1 component\(s\)/);
  assert.match(out.stdout, /1 bare skipped/);
  rmSync(dir, { recursive: true, force: true });
});

test('bound rangeHours below 1 h: static value in a smaller unit, binding left MANUAL', () => {
  const v = view1({ type: M.TYPE_CHART, meta: { name: 'C' }, props: { rangeHours: 0.25 },
    propConfig: { 'props.rangeHours': { binding: { type: 'expr', config: { expression: '0.25' } } } } });
  const r = M.migrateView(v, {}, schemas);
  const c = v.root.children[0];
  assert.deepEqual(c.props.timeRange.realtime, { value: 15, unit: 'minutes' });
  assert.deepEqual(Object.keys(c.propConfig), ['props.rangeHours']);
  assert.match(r.components[0].manual[0].reason, /below v2's minimum/);
  assert.deepEqual(validate(schemas.chart, c.props), []);
  // Second run: the binding stays MANUAL on props.rangeHours (it produces hours, the unit is minutes).
  const once = JSON.stringify(v);
  const r2 = M.migrateView(v, {}, schemas);
  assert.equal(JSON.stringify(v), once);
  assert.equal(r2.changed, false);
  assert.equal(r2.components[0].status, 'already v2 (v1 bindings left)');
  assert.match(r2.components[0].manual[0].reason, /unit is "minutes"/);
});

test('bound rangeHours on a mixed chart whose stored unit is not hours stays MANUAL; with hours it moves', () => {
  const b = { binding: { type: 'expr', config: { expression: '2' } } };
  const v = view1(
    { type: M.TYPE_CHART, meta: { name: 'M' }, props: { rangeHours: 2, timeRange: { realtime: { value: 30, unit: 'minutes' } } },
      propConfig: { 'props.rangeHours': b } },
    { type: M.TYPE_CHART, meta: { name: 'H' }, props: { rangeHours: 2, timeRange: { realtime: { value: 3, unit: 'hours' } } },
      propConfig: { 'props.rangeHours': b } },
    { type: M.TYPE_CHART, meta: { name: 'L' }, props: { timeRange: { realtime: { value: 30, unit: 'seconds' } } },
      propConfig: { 'props.rangeHours': b } },
    { type: M.TYPE_CHART, meta: { name: 'D' }, props: { timeRange: { mode: 'realtime' } }, propConfig: { 'props.rangeHours': b } },
  );
  const r = M.migrateView(v, {}, schemas);
  const [m, h, l, d] = v.root.children;
  assert.deepEqual(Object.keys(m.propConfig), ['props.rangeHours']);
  assert.deepEqual(m.props.timeRange.realtime, { value: 30, unit: 'minutes' });
  assert.match(r.components[0].manual[0].reason, /unit is "minutes"/);
  assert.doesNotMatch(r.components[0].warnings.join(), /unit "hours"/);
  assert.deepEqual(Object.keys(h.propConfig), ['props.timeRange.realtime.value']);
  assert.deepEqual(Object.keys(l.propConfig), ['props.rangeHours']);                // leftover path, stored seconds
  assert.match(r.components[2].manual[0].reason, /unit is "seconds"/);
  assert.deepEqual(Object.keys(d.propConfig), ['props.timeRange.realtime.value']);  // leftover path, schema default hours
  const once = JSON.stringify(v);
  assert.equal(M.migrateView(v, {}, schemas).changed, false);
  assert.equal(JSON.stringify(v), once);
});

test('ambiguous bindings on already-v2 components are noted on every run', () => {
  const b = { binding: { type: 'property', config: { path: 'view.custom.x' } } };
  const v = view1(
    { type: M.TYPE_DISPLAY, meta: { name: 'D' }, props: { tagPath: 'a', units: { visible: true } }, propConfig: { 'props.bounds': b } },
    { type: M.TYPE_CHART, meta: { name: 'C' }, props: { timeRange: { mode: 'realtime' } }, propConfig: { 'props.interaction': b, 'props.rawHistory': b } },
  );
  const r = M.migrateView(v, {}, schemas);
  assert.equal(r.components[0].status, 'already v2');
  assert.match(r.components[0].notes.join(), /check by hand: .*props\.bounds/);
  assert.equal(r.components[1].status, 'already v2 (v1 bindings left)');
  assert.match(r.components[1].notes.join(), /check by hand: .*props\.interaction/);
});

test('--out is compared by file identity (case, short names); backups are raw bytes; inflate is capped', () => {
  const dir = tmp('ident');
  const zipCopy = path.join(dir, 'in.zip');
  cpSync(ZIP, zipCopy);
  const before = readFileSync(zipCopy);
  assert.equal(M.sameFile(zipCopy, zipCopy.toUpperCase()), process.platform === 'win32' || process.platform === 'darwin');
  if (process.platform === 'win32') {
    assert.throws(() => M.run({ input: zipCopy, write: true, out: path.join(dir, 'IN.ZIP') }), /must differ/);
    assert.deepEqual(readFileSync(zipCopy), before, 'input untouched');
  }
  assert.equal(M.sameFile(zipCopy, path.join(dir, 'other.zip')), false);

  // Backup = original bytes, even when they are not valid UTF-8 (a Latin-1 "é" in a string).
  const vf = path.join(dir, 'view.json');
  const json = Buffer.from(JSON.stringify(view1({ type: M.TYPE_DISPLAY, meta: { name: 'D' }, props: { tagPath: 'x', showUnits: true, tagNameLabel: 'cafX' } })));
  json[json.indexOf('cafX') + 3] = 0xe9;
  writeFileSync(vf, json);
  M.run({ input: vf, write: true });
  assert.deepEqual(readFileSync(vf + '.v1.bak'), json, 'backup byte-identical');

  // A deflate entry that inflates beyond its declared size fails without inflating everything.
  const big = Buffer.alloc(5_000_000, 0x41);
  const bomb = { name: 'b.json', method: 8, raw: zlib.deflateRawSync(big), size: 10, crc: 0 };
  assert.throws(() => entryData(bomb), /more than its declared 10 bytes|size mismatch/);
  rmSync(dir, { recursive: true, force: true });
});

// ---- 5. external references ---------------------------------------------------
test('external references: bindings, scripts and the project library are reported; data and v2 keys are not', () => {
  const dir = makeProject(tmp('refs'), ALL_VIEWS);
  const rep = M.run({ input: dir });
  const hits = rep.externalReferences.map((r) => `${r.file.split('/').slice(-2).join('/')}|${r.key}|${r.line}`).sort();
  assert.deepEqual(hits, [
    'Refs/view.json|bounds.minColor|1',
    'Refs/view.json|rangeHours|1',
    'Refs/view.json|rangeHours|2',
    'Refs/view.json|setpoint|1',
    'Refs/view.json|showTagName|2',
    'helpers/code.py|rangeHours|7',
    'helpers/code.py|setpoint|3',
    'helpers/code.py|showUnits|4',
  ]);
  const setpoint = rep.externalReferences.find((r) => r.key === 'setpoint' && r.file.endsWith('view.json'));
  assert.equal(setpoint.confidence, 'low');
  assert.match(setpoint.location, /events\/component\/onActionPerformed/);
  // The pre-module view has v1-looking names only in view.params: no hits, no components.
  assert.equal(rep.externalReferences.filter((r) => r.file.includes('Unrelated')).length, 0);
  assert.equal(rep.views.filter((v) => v.file.includes('Unrelated')).length, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('scanText normalises bracket access and blanks; longest key wins', () => {
  const h = (t) => M.scanText(t, {}).map((x) => x.key);
  assert.deepEqual(h("c.props[ 'tagNameStyle' ]"), ['tagNameStyle']);
  assert.deepEqual(h('c.props . boolean . textOnTrue'), ['boolean.textOnTrue']);
  assert.deepEqual(h('c.props.boolean'), ['boolean']);
  assert.deepEqual(h('c.props.setpoint.enabled = True'), []);
  assert.deepEqual(h('c.props.modeX + c.props.timeRange.mode'), []);
  assert.deepEqual(h('a.props.rangeHours; b.props.showUnits'), ['rangeHours', 'showUnits']);
});

// ---- 6. write mode, backups, idempotence, formatting -------------------------
test('folder --write: backups once, second run is a no-op', () => {
  const dir = makeProject(tmp('write'), ALL_VIEWS);
  const before = snapshot(dir);
  const dry = M.run({ input: dir });
  assert.deepEqual(snapshot(dir), before, 'dry run writes nothing');
  assert.equal(dry.summary.viewsChanged, 7);

  const first = M.run({ input: dir, write: true });
  assert.equal(first.summary.viewsChanged, 7);
  assert.equal(first.backups.length, 7);
  const mainFile = path.join(dir, 'com.inductiveautomation.perspective', 'views', 'Main', 'view.json');
  assert.deepEqual(readFileSync(mainFile + '.v1.bak'), before[path.relative(dir, mainFile)], 'backup = original bytes');
  assert.equal(existsSync(path.join(dir, 'com.inductiveautomation.perspective', 'views', 'Unrelated', 'view.json.v1.bak')), false);
  assert.deepEqual(readFileSync(path.join(dir, 'com.inductiveautomation.perspective', 'views', 'Unrelated', 'view.json')),
    before[path.join('com.inductiveautomation.perspective', 'views', 'Unrelated', 'view.json')], 'views without module components untouched');

  const afterFirst = snapshot(dir);
  const second = M.run({ input: dir, write: true });
  assert.equal(second.summary.viewsChanged, 0);
  assert.equal(second.summary.migrated.display + second.summary.migrated.chart, 0);
  assert.equal(second.backups.length, 0);
  assert.deepEqual(snapshot(dir), afterFirst, 'second run changes no byte');
  // The manual items are still reported on the second run (nothing is silently forgotten).
  assert.equal(second.summary.externalReferences, first.summary.externalReferences);
  rmSync(dir, { recursive: true, force: true });
});

test('serialisation keeps indent, CRLF and BOM of the input', () => {
  const dir = tmp('fmt');
  const file = path.join(dir, 'view.json');
  const view = fixture('ctg-test-main.view.json');
  writeFileSync(file, '﻿' + JSON.stringify(view, null, '\t').replace(/\n/g, '\r\n') + '\r\n');
  M.run({ input: file, write: true });
  const out = readFileSync(file, 'utf8');
  assert.ok(out.startsWith('﻿{\r\n\t"custom"'));
  assert.ok(out.endsWith('}\r\n'));
  assert.ok(!/[^\r]\n/.test(out), 'only CRLF line ends');
  assert.equal(JSON.parse(out.slice(1)).root.children[2].props.layout.verticalAlign, 'top');
  rmSync(dir, { recursive: true, force: true });
});

// ---- 7. zip -------------------------------------------------------------------
test('zip round trip on a real gateway export', () => {
  const src = readZip(readFileSync(ZIP));
  assert.ok(src.entries.some((e) => e.flags & 0x08), 'fixture uses data descriptors (Java ZipOutputStream)');
  const dir = tmp('zip');
  const out = path.join(dir, 'migrated.zip');
  const rep = M.run({ input: ZIP, write: true, out });
  assert.equal(rep.output.changedEntries, 5);
  const res = readZip(readFileSync(out));
  assert.deepEqual(res.entries.map((e) => e.name), src.entries.map((e) => e.name), 'same entries, same order');
  for (const [i, e] of res.entries.entries()) {
    const data = entryData(e);                                     // verifies CRC + size
    if (e.name.endsWith('view.json')) {
      const view = JSON.parse(data.toString('utf8'));
      assert.equal(M.migrateView(view, {}, schemas).changed, false, `${e.name} fully migrated`);
    } else {
      assert.deepEqual(data, entryData(src.entries[i]), `${e.name} unchanged`);
      assert.deepEqual(Buffer.from(e.raw), Buffer.from(src.entries[i].raw), `${e.name} copied without re-compression`);
    }
  }
  // The zip result equals the folder result for the same view.
  const fromZip = JSON.parse(entryData(res.entries.find((e) => e.name.endsWith('V1Full/view.json'))).toString());
  const { view } = migrate('all-keys.view.json');
  assert.deepEqual(fromZip, view);
  // Second run over the migrated archive: nothing to do.
  const again = M.run({ input: out, write: true, out: path.join(dir, 'again.zip') });
  assert.equal(again.output.changedEntries, 0);
  assert.equal(again.summary.viewsChanged, 0);
  assert.equal(again.externalReferences.length, 8, 'script + view references still listed');
  assert.throws(() => M.run({ input: out, write: true, out }), /must differ/);
  rmSync(dir, { recursive: true, force: true });
});

test('mini-zip: stored/deflate, UTF-8 names, CRC fallback, bad input', () => {
  const entries = [
    { name: 'dir/', data: Buffer.alloc(0) },
    { name: 'a.txt', data: Buffer.from('x'.repeat(1000)) },             // compresses → deflate
    { name: 'tiny.bin', data: Buffer.from([1, 2, 3]) },                 // grows when deflated → stored
    { name: 'ünïcode/view.json', data: Buffer.from('{"a":1}') },
  ];
  const zip = readZip(writeZip(entries, Buffer.from('comment')));
  assert.deepEqual(zip.entries.map((e) => [e.name, e.method]), [['dir/', 0], ['a.txt', 8], ['tiny.bin', 0], ['ünïcode/view.json', 0]]);
  assert.equal(zip.entries[0].isDir, true);
  assert.equal(entryData(zip.entries[1]).toString(), 'x'.repeat(1000));
  assert.equal(zip.comment.toString(), 'comment');
  if (typeof zlib.crc32 === 'function') assert.equal(crc32(Buffer.from('hello')), zlib.crc32(Buffer.from('hello')));
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926, 'CRC-32 check value');
  assert.throws(() => readZip(Buffer.from('not a zip at all, definitely not')), /not a ZIP/);
  const bad = writeZip([{ name: 'v.json', data: Buffer.from('{"b":2}') }]);
  bad[bad.indexOf('{"b"') + 2] = 0x63;                                    // corrupt one stored byte
  assert.throws(() => entryData(readZip(bad).entries[0]), /CRC mismatch/);
  const long = writeZip([{ name: 'x.bin', data: Buffer.from([1, 2, 3]) }]);
  long.writeUInt32LE(4096, long.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])) + 20);   // central dir: compressedSize
  assert.throws(() => readZip(long), /data of "x\.bin" runs past the end/);
});

// ---- 8. CLI -------------------------------------------------------------------
const cli = (...args) => spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });

test('CLI: dry run, report file, exit codes', () => {
  const dir = makeProject(tmp('cli'), { Main: 'ctg-test-main.view.json', Refs: 'external-refs.view.json' });
  const reportFile = path.join(dir, 'report.json');
  const before = snapshot(path.join(dir, 'com.inductiveautomation.perspective'));
  const r = cli(dir, '--report', reportFile);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /DRY RUN/);
  assert.match(r.stdout, /showUnits → units\.visible = false {2}\(v1 default\)/);
  assert.match(r.stdout, /External references to v1 props/);
  assert.deepEqual(snapshot(path.join(dir, 'com.inductiveautomation.perspective')), before);
  const rep = JSON.parse(readFileSync(reportFile, 'utf8'));
  assert.equal(rep.mode, 'dry-run');
  assert.deepEqual(Object.keys(rep.summary).sort(), ['alreadyV2', 'bareSkipped', 'components', 'errors', 'externalReferences', 'manualBindings',
    'migrated', 'viewsChanged', 'viewsWithComponents', 'warnings']);

  // A broken view.json: reported, the others still processed, exit 2.
  const broken = path.join(dir, 'com.inductiveautomation.perspective', 'views', 'Broken');
  mkdirSync(broken);
  writeFileSync(path.join(broken, 'view.json'), '{ "root": ');
  const w = cli(dir, '--write');
  assert.equal(w.status, 2);
  assert.match(w.stdout, /ERROR .*Broken\/view\.json: invalid JSON/);
  assert.match(w.stdout, /2\/2 view\(s\) changed/);

  assert.equal(cli().status, 1, 'no input');
  assert.equal(cli(dir, '--nope').status, 1, 'unknown option');
  assert.equal(cli(path.join(dir, 'missing')).status, 1, 'missing input');
  assert.equal(cli(dir, '--bare', 'maybe').status, 1);
  const help = cli('--help');
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--keep-aggregation/);
  rmSync(dir, { recursive: true, force: true });
});
