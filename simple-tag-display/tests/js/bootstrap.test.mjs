// =============================================================================
// bootstrap.test.mjs — load protocol of the five browser resources
// =============================================================================
// Perspective's injection order of BROWSER_RESOURCES is
// not guaranteed, so every one of the 120 load orders must register both
// components exactly once and mark every part ready. A second copy of a file
// (old + new ?v= after an upgrade) must be ignored with exactly one warning.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, permutations, FILES } from './_stubs.mjs';

const DT = 'com.example.simpletagdisplay.SimpleTagDisplay';
const CHART = 'com.example.simpletagdisplay.CtgChart';

test('every load order registers both components once and readies all parts', () => {
  const orders = permutations(FILES);
  assert.equal(orders.length, 120);
  for (const order of orders) {
    const env = createEnv();
    for (const f of order) env.load(f);
    const NS = env.window.__CTG;
    assert.deepEqual([...env.registered].sort(), [DT, CHART].sort(), `order ${order.join(',')}`);
    for (const part of ['common', 'display', 'chart', 'chartTools', 'chartPanels']) {
      assert.equal(NS.ready[part], true, `${part} not ready for order ${order.join(',')}`);
    }
    assert.equal(NS._queue.length, 0, 'queue drained');
    assert.deepEqual(env.errors, [], `errors for order ${order.join(',')}`);
    assert.deepEqual(env.warnings, []);
  }
});

test('build id comes from the ?v= of the script URL', () => {
  const env = createEnv();
  env.load('ctg-common.js', '2.0.0-1a2b3c4d');
  assert.equal(env.window.__CTG.build, '2.0.0-1a2b3c4d');
  assert.equal(env.window.__CTG.loaded.common, '2.0.0-1a2b3c4d');
});

test('a second copy with another build is ignored with one warning; same build is silent', () => {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-aaaaaaaa');
  env.load('display-template.js', '2.0.0-aaaaaaaa');
  assert.equal(env.warnings.length, 0);
  env.load('display-template.js', '2.0.0-bbbbbbbb');
  env.load('ctg-common.js', '2.0.0-bbbbbbbb');
  assert.equal(env.warnings.length, 2);
  assert.match(env.warnings[0].join(' '), /display 2\.0\.0-bbbbbbbb ignored; page runs 2\.0\.0-aaaaaaaa/);
  assert.equal(env.registered.length, 2);
  assert.equal(env.window.__CTG.build, '2.0.0-aaaaaaaa');
});

test('a failing part is isolated and does not block the others', () => {
  const env = createEnv();
  env.window.__CTG = { _queue: [{ part: 'broken', needs: ['common'], init() { throw new Error('boom'); } }] };
  for (const f of FILES) env.load(f);
  const NS = env.window.__CTG;
  assert.ok(NS.failed.broken);
  assert.equal(NS.ready.broken, undefined);
  assert.equal(NS.ready.display, true);
  assert.equal(env.errors.length, 1);
});

test('nothing but window.__CTG is added to the page', () => {
  const env = createEnv();
  const before = new Set(Object.keys(env.window));
  const ctxBefore = new Set(Object.keys(env.context));
  for (const f of FILES) env.load(f);
  const added = Object.keys(env.window).filter(k => !before.has(k));
  const ctxAdded = Object.keys(env.context).filter(k => !ctxBefore.has(k));
  assert.deepEqual(added, ['__CTG']);
  assert.deepEqual(ctxAdded, []);
});
