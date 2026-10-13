// =============================================================================
// migrate-edge-cases.test.mjs — regression tests for edge cases of
// tools/migrate-v1-views.mjs and tools/lib/mini-zip.mjs
// =============================================================================
// Run:  node --test "simple-tag-display/tests/js/*.test.mjs"
//
//   - a second run moved a sub-hour rangeHours binding that run 1 left MANUAL
//     on a mixed chart whose stored unit is already "hours"
//   - a mixed component whose only v2 content was empty objects got no
//     idempotence marker (re-migrated with v1 defaults on the next run)
//   - moved bindings ignored bindings on an ancestor, a descendant or the unit
//   - property configs without a binding on rangeHours were reported with a
//     message about a binding
//   - mini-zip decoded CP437 names as Latin-1
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as M from '../../tools/migrate-v1-views.mjs';
import { readZip, writeZip, entryData, cp437 } from '../../tools/lib/mini-zip.mjs';

const schemas = M.loadSchemas();
const B = (expression = '1') => ({ binding: { type: 'expr', config: { expression } } });

/** A view whose root holds the given components. */
const view = (...children) => ({ root: { type: 'ia.container.flex', meta: { name: 'root' }, children } });
const chart = (name, props, propConfig) => ({ type: M.TYPE_CHART, meta: { name }, props, ...(propConfig ? { propConfig } : {}) });
const display = (name, props, propConfig) => ({ type: M.TYPE_DISPLAY, meta: { name }, props, ...(propConfig ? { propConfig } : {}) });

/** Runs the migration twice (run 1 with `bare`, run 2 with the default) and checks run 2 changes no byte. */
function twice(v, bare = 'auto') {
  const r1 = M.migrateView(v, { bare }, schemas);
  const once = JSON.stringify(v);
  const r2 = M.migrateView(v, {}, schemas);
  assert.equal(JSON.stringify(v), once, 'the second run changes nothing');
  assert.equal(r2.changed, false);
  return { r1, r2 };
}

// ---- rangeHours binding decided by the final unit, not the static value -------------------------------------

test('mixed chart, sub-hour rangeHours bound, stored unit hours: the binding moves on run 1 (as run 2 would)', () => {
  for (const realtime of [{ value: 2, unit: 'hours' }, { value: 2 }]) {
    for (const extra of [{}, { mode: 'realtime' }]) {
      const v = view(chart('C', { rangeHours: 0.5, timeRange: { realtime }, ...extra }, { 'props.rangeHours': B('0.5') }));
      const { r1 } = twice(v);
      const c = v.root.children[0];
      assert.deepEqual(Object.keys(c.propConfig), ['props.timeRange.realtime.value'], JSON.stringify({ realtime, extra }));
      assert.deepEqual(c.props.timeRange.realtime, realtime, 'the existing v2 value wins');
      assert.deepEqual(r1.components[0].manual, []);
      assert.match(r1.components[0].warnings.join('\n'), /value ≥ 1/, 'the fractional-hours warning is given');
    }
  }
});

test('pure v1 chart, sub-hour rangeHours bound: the converted unit lands, the binding stays MANUAL on both runs', () => {
  const v = view(chart('C', { rangeHours: 0.5 }, { 'props.rangeHours': B('0.5') }));
  const { r1, r2 } = twice(v);
  const c = v.root.children[0];
  assert.deepEqual(c.props.timeRange.realtime, { value: 30, unit: 'minutes' });
  assert.deepEqual(Object.keys(c.propConfig), ['props.rangeHours']);
  assert.match(r1.components[0].manual[0].reason, /below v2's minimum/);
  assert.match(r2.components[0].manual[0].reason, /unit is "minutes"/);
});

// ---- idempotence marker for empty-object v2 content --------------------------------------------------------

test('a mixed chart whose only v2 content is an empty object gets a marker and is not re-migrated', () => {
  for (const bare of ['auto', 'v1']) {
    const v = view(chart('C', { interaction: { mode: 'panAndZoom' }, timeRange: {} }));
    const { r1 } = twice(v, bare);
    const c = v.root.children[0];
    assert.deepEqual(c.props, { timeRange: { mode: 'realtime' } }, 'the first marker with its v2 default');
    assert.ok(r1.components[0].changes.some((x) => x.marker), 'reported as the marker');
    assert.equal(M.classify('chart', c.props, null, schemas), 'v2');
  }
  // With a MANUAL v1 property config left on the component and a v1 sibling in the view.
  const v = view(chart('C', { interaction: { mode: 'panAndZoom' }, timeRange: {} }, { 'props.pointCount': { persistent: false } }),
    chart('V1', { rangeHours: 8 }));
  twice(v, 'v1');
  assert.deepEqual(v.root.children[0].props.timeRange, { mode: 'realtime' });
  assert.equal(v.root.children[0].props.query, undefined, 'no v1 defaults filled in on run 2');
});

test('a mixed display whose only v2 content is an empty object gets the display marker', () => {
  const v = view(display('D', { showTagName: true, label: {} }));
  twice(v);
  const props = v.root.children[0].props;
  assert.equal(M.classify('display', props, null, schemas), 'v2');
  assert.ok(Object.keys(props).length > 0);
});

// ---- ancestor / descendant / unit bindings make the target taken --------------------------------------------

test('a rangeHours binding does not move under a bound ancestor or next to a bound unit', () => {
  const cases = {
    realtime: { 'props.timeRange.realtime': B('{"value": 2, "unit": "hours"}') },
    timeRange: { 'props.timeRange': B('{}') },
    unit: { 'props.timeRange.realtime.unit': B('"minutes"') },
  };
  for (const [name, bound] of Object.entries(cases)) {
    const v = view(chart('C', { rangeHours: 2, timeRange: { realtime: { value: 3, unit: 'hours' } } },
      { 'props.rangeHours': B('2'), ...bound }));
    const { r1, r2 } = twice(v);
    const c = v.root.children[0];
    assert.ok(Object.keys(c.propConfig).includes('props.rangeHours'), `${name}: the binding stays`);
    assert.ok(!Object.keys(c.propConfig).includes('props.timeRange.realtime.value'), `${name}: nothing moved`);
    const reason = r1.components[0].manual.find((m) => m.key === 'props.rangeHours')?.reason || '';
    assert.match(reason, /is bound, which overlaps|merge the two bindings by hand/, `${name}: ${reason}`);
    assert.ok(r2.components[0].manual.some((m) => m.key === 'props.rangeHours'), `${name}: reported again on run 2`);
  }
});

test('display: showTagName does not move under a bound props.label; tagNameStyle not over a bound descendant', () => {
  const v = view(
    display('A', { showTagName: false, label: { text: 'x' } }, { 'props.showTagName': B('false'), 'props.label': B('{}') }),
    display('B', { tagNameStyle: { color: 'red' } }, { 'props.tagNameStyle': B('{}'), 'props.label.style.color': B('"red"') }),
  );
  const r = M.migrateView(v, {}, schemas);
  const [a, b] = v.root.children;
  assert.ok('props.showTagName' in a.propConfig && !('props.label.visible' in a.propConfig));
  assert.match(r.components[0].manual.find((m) => m.key === 'props.showTagName').reason, /props\.label is bound/);
  assert.ok('props.tagNameStyle' in b.propConfig && !('props.label.style' in b.propConfig));
  assert.match(r.components[1].manual.find((m) => m.key === 'props.tagNameStyle').reason, /props\.label\.style\.color is bound/);
  const once = JSON.stringify(v);
  M.migrateView(v, {}, schemas);
  assert.equal(JSON.stringify(v), once);
});

test('a free target still takes the binding (no regression)', () => {
  const v = view(display('A', { showTagName: false }, { 'props.showTagName': B('false') }));
  M.migrateView(v, {}, schemas);
  assert.deepEqual(Object.keys(v.root.children[0].propConfig), ['props.label.visible']);
});

// ---- property configs without a binding on rangeHours -----------------------------------------------------

test('an onChange-only config on rangeHours is MANUAL with its own reason, not a binding message', () => {
  const v = view(chart('C', { rangeHours: 24 }, { 'props.rangeHours': { onChange: { enabled: true, script: 'x' } } }));
  const { r1 } = twice(v);
  const c = v.root.children[0];
  assert.deepEqual(c.props.timeRange?.realtime ?? { value: 1, unit: 'days' }, { value: 1, unit: 'days' });
  assert.deepEqual(Object.keys(c.propConfig), ['props.rangeHours']);
  const m = r1.components[0].manual[0];
  assert.equal(m.what, 'property config');
  assert.match(m.reason, /property config \(no binding\) on rangeHours/);
  assert.match(m.reason, /unit "days"/);
  assert.doesNotMatch(m.reason, /binding produces hours/);
});

test('an onChange-only config on rangeHours next to unit hours still moves (nothing produces a wrong unit)', () => {
  const v = view(chart('C', { rangeHours: 2, timeRange: { realtime: { value: 3, unit: 'hours' } } },
    { 'props.rangeHours': { onChange: { enabled: true, script: 'x' } } }));
  twice(v);
  assert.deepEqual(Object.keys(v.root.children[0].propConfig), ['props.timeRange.realtime.value']);
});

// ---- mini-zip CP437 names ----------------------------------------------------------------------------------

test('mini-zip decodes names without the UTF-8 flag as CP437 and writes them back as the same characters', () => {
  assert.equal(cp437(Buffer.from([0x81, 0x41, 0xe1, 0xff])), 'üAß ');
  // A zip with an ASCII name, then the name byte patched to 0x81 (CP437 'ü') in both headers; no UTF-8 flag.
  const zip = writeZip([{ name: 'X.txt', data: Buffer.from('hello') }]);
  let at = -1;
  while ((at = zip.indexOf('X.txt', at + 1)) !== -1) zip[at] = 0x81;
  const read = readZip(zip);
  assert.equal(read.entries[0].name, 'ü.txt', 'CP437, not Latin-1 (U+0081)');
  assert.equal(entryData(read.entries[0]).toString(), 'hello');
  const again = readZip(writeZip(read.entries));
  assert.equal(again.entries[0].name, 'ü.txt', 'same characters after a round trip');
  assert.ok(again.entries[0].flags & 0x0800, 'written as UTF-8 with the flag');
});
