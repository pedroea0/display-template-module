// =============================================================================
// dt-common-value-text.test.mjs — ctg-common.js value text and input edge
// cases: accounting negative zero, Boolean text parity with parseInput,
// canonical type name in TOO_LARGE.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv } from './_stubs.mjs';

/**
 * Perspective NumberFormat stand-in with numeral.js accounting behaviour: a pattern with '(' prints a
 * negative value in parentheses, keeping the rounded digits (so -0.001 with 2 decimals is "(0.00)").
 */
class FakeNumberFormat {
  constructor(v) { this.v = v; this.type = null; }
  format(pattern) {
    const dec = (/\.(0+)/.exec(pattern) || ['', ''])[1].length;
    const abs = Math.abs(this.v).toFixed(dec);
    if (this.v < 0 || Object.is(this.v, -0)) return pattern.indexOf('(') >= 0 ? '(' + abs + ')' : '-' + abs;
    return abs;
  }
}

function load(withNumberFormat) {
  const env = createEnv();
  if (withNumberFormat) {
    env.window.PerspectiveClient.NumberFormat = FakeNumberFormat;
    env.window.PerspectiveClient.NumberFormatType = { NUMBER: 'number' };
  }
  env.load('ctg-common.js');
  return env.window.__CTG;
}

test('accounting pattern on the Perspective route: a negative value that rounds to zero prints the zero text', () => {
  const NS = load(true);
  assert.equal(NS.format.number(-0.001, '(0.00)', 'en-US'), '0.00', 'not "(0.00)"');
  assert.equal(NS.format.number(-0.004, '(0.00)', 'en-US'), '0.00');
  assert.equal(NS.format.number(-1.5, '(0.00)', 'en-US'), '(1.50)', 'real negatives keep their parentheses');
  assert.equal(NS.format.number(-0.001, '0.00', 'en-US'), '0.00');
  assert.equal(NS.format.number(-2, '0.00', 'en-US'), '-2.00');
  assert.equal(NS.format.number(0.001, '(0.00)', 'en-US'), '0.00');
});

test('Boolean value text accepts the same words as parseInput (true/1/on/yes)', () => {
  const NS = load(false);
  const text = v => NS.format.value({ v, type: 'Boolean' }, { trueText: 'Run', falseText: 'Stop' }).text;
  for (const w of ['true', 'TRUE', ' 1 ', 'on', 'On', 'yes', 'YES']) {
    assert.equal(text(w), 'Run', w);
    assert.equal(NS.format.parseInput(w, 'Boolean', 'en-US').value, true, w + ' (parseInput)');
  }
  for (const w of ['false', '0', 'off', 'no', 'nonsense']) assert.equal(text(w), 'Stop', w);
});

test('TOO_LARGE message names the canonical Ignition type, whatever spelling the caller used', () => {
  const NS = load(false);
  assert.equal(NS.format.parseInput('40000', 'short', 'en-US').error, 'Value is too large for a Int2 tag');
  assert.equal(NS.format.parseInput('128', 'Byte', 'en-US').error, 'Value is too large for a Int1 tag');
  assert.equal(NS.format.parseInput('2147483648', 'integer', 'en-US').error, 'Value is too large for a Int4 tag');
  assert.equal(NS.format.parseInput('9223372036854775808', 'Long', 'en-US').error, 'Value is too large for a Int8 tag');
  assert.equal(NS.format.parseInput('9223372036854775808', 'Int8', 'en-US').error, 'Value is too large for a Int8 tag');
});
