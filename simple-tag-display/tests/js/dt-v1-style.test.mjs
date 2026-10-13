// =============================================================================
// dt-v1-style.test.mjs — v1 view compatibility: a v1 view keeps scalars where the v2
// groups live (`setpoint: true`). The reducer must not call readStyle() below a
// non-object node: Perspective's PropertyTree logs a console error for that
// ("Unexpected type while operating on path setpoint.style").
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv } from './_stubs.mjs';

function load() {
  const env = createEnv();
  env.load('ctg-common.js');
  env.load('display-template.js');
  return env.window.__CTG;
}

/** Fake PropertyTree with readStyle that records every path it is asked for. */
function tree(obj) {
  const styled = [];
  return {
    styled,
    read(p) {
      let v = obj;
      for (const k of String(p).split('.')) { if (v == null || typeof v !== 'object') return undefined; v = v[k]; }
      return v;
    },
    readStyle(p) { styled.push(p); return { toStyleProps: () => ({ className: '', style: {} }) }; },
  };
}

test('v1 boolean setpoint: no readStyle under the scalar, v1 key detected', () => {
  const NS = load();
  const t = tree({ tagPath: '[default]CTG/Temp', setpoint: true, showUnits: true, label: { style: { color: 'red' } } });
  const cfg = NS.dt.makeReducer()(t);
  assert.ok(!t.styled.includes('setpoint.style'), 'setpoint.style not read through the tree: ' + t.styled.join(','));
  assert.ok(t.styled.includes('label.style'), 'object parents still use readStyle');
  assert.ok(cfg.v1Keys.includes('setpoint') && cfg.v1Keys.includes('showUnits'));
  assert.deepEqual(Object.keys(cfg.styles.setpoint).sort(), ['className', 'style']);
});

test('v2 setpoint object without a style key still resolves through the tree', () => {
  const NS = load();
  const t = tree({ tagPath: '[default]CTG/Temp', setpoint: { mode: 'popup' } });
  NS.dt.makeReducer()(t);
  assert.ok(t.styled.includes('setpoint.style'));
});
