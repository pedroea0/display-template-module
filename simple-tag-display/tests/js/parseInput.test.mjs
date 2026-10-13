// =============================================================================
// parseInput.test.mjs — strict operator input parsing
// =============================================================================
// The client check is advisory (the gateway re-validates) but it must
// never accept what the gateway would read differently: no hex, no "1d", no
// grouping read as a decimal, never NaN.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv } from './_stubs.mjs';

function ns() {
  const env = createEnv();
  env.load('ctg-common.js');
  return env.window.__CTG;
}
const plain = (r) => JSON.parse(JSON.stringify(r));

test('the reference input list', () => {
  const NS = ns();
  const P = (t, dt, loc) => plain(NS.format.parseInput(t, dt, loc));
  const cases = [
    ['abc', 'Float8', 'en-US', { ok: false, code: 'NOT_NUMBER', error: 'Enter a number' }],
    ['12abc', 'Float8', 'en-US', { ok: false, code: 'NOT_NUMBER', error: 'Enter a number' }],
    ['1,5', 'Float8', 'en-US', { ok: false, code: 'GROUPING', error: 'Remove thousands separators' }],
    ['1,5', 'Float8', 'de-DE', { ok: true, value: 1.5 }],
    ['1,500', 'Float8', 'en-US', { ok: false, code: 'GROUPING', error: 'Remove thousands separators' }],
    ['0x10', 'Float8', 'en-US', { ok: false, code: 'NOT_NUMBER', error: 'Enter a number' }],
    ['1d', 'Float8', 'en-US', { ok: false, code: 'NOT_NUMBER', error: 'Enter a number' }],
    ['1e400', 'Float8', 'en-US', { ok: false, code: 'NOT_NUMBER', error: 'Enter a number' }],
    ['', 'Float8', 'en-US', { ok: false, code: 'EMPTY', error: 'Enter a value' }],
    [' 7 ', 'Float8', 'en-US', { ok: true, value: 7 }],
    ['1.5', 'Int4', 'en-US', { ok: false, code: 'NOT_INTEGER', error: 'Enter a whole number' }],
    ['9223372036854775808', 'Int8', 'en-US', { ok: false, code: 'TOO_LARGE', error: 'Value is too large for a Int8 tag' }],
  ];
  for (const [t, dt, loc, want] of cases) assert.deepEqual(P(t, dt, loc), want, `${JSON.stringify(t)} ${dt} ${loc}`);
});

test('numbers \u2014 decimals, exponent, signs, de-DE', () => {
  const NS = ns();
  const v = (t, dt = 'Float8', loc = 'en-US') => NS.format.parseInput(t, dt, loc).value;
  assert.equal(v('72.5'), 72.5);
  assert.equal(v('-.5'), -0.5);
  assert.equal(v('+3.'), 3);
  assert.equal(v('1e3'), 1000);
  assert.equal(v('2.5E-2'), 0.025);
  assert.equal(v('-0'), 0);
  assert.equal(Object.is(v('-0'), -0), false, 'no negative zero');
  assert.equal(v('72.5', 'Float8', 'de-DE'), 72.5, "'.' is always a decimal separator");
  assert.equal(v('-1,25', 'Float8', 'de-DE'), -1.25);
  for (const bad of ['1.500,5', '1 500', '1\u00A0500', "1'500", '1_000', '..5', '1..5', '1e', 'e5', '--1', '+-1', 'Infinity', 'NaN', '\u0663']) {
    const r = NS.format.parseInput(bad, 'Float8', 'de-DE');
    assert.equal(r.ok, false, bad);
    assert.ok(r.value === undefined, `${bad} carries no value`);
  }
  assert.equal(NS.format.parseInput('1 500', 'Float8', 'fr-FR').code, 'GROUPING');
  assert.equal(NS.format.parseInput('3.5e38', 'Float4', 'en-US').code, 'TOO_LARGE');
  assert.equal(NS.format.parseInput('3.4e38', 'Float4', 'en-US').ok, true);
});

test('integer widths and Int8 digit strings', () => {
  const NS = ns();
  const P = (t, dt) => plain(NS.format.parseInput(t, dt, 'en-US'));
  assert.deepEqual(P('-128', 'Int1'), { ok: true, value: -128 });
  assert.equal(P('128', 'Int1').code, 'TOO_LARGE');
  assert.equal(P('32767', 'Int2').ok, true);
  assert.equal(P('-32769', 'Int2').code, 'TOO_LARGE');
  assert.equal(P('2147483648', 'Int4').code, 'TOO_LARGE');
  assert.deepEqual(P('+42', 'Int4'), { ok: true, value: 42 });
  assert.deepEqual(P('9007199254740991', 'Int8'), { ok: true, value: 9007199254740991 });
  assert.deepEqual(P('9007199254740993', 'Int8'), { ok: true, value: '9007199254740993' }, 'beyond 2^53 -> digit string');
  assert.deepEqual(P('-9223372036854775808', 'Int8'), { ok: true, value: '-9223372036854775808' });
  assert.deepEqual(P('0007', 'Int4'), { ok: true, value: 7 });
  assert.equal(P('1e3', 'Int4').code, 'NOT_INTEGER');
  assert.equal(P('1,000', 'Int4').code, 'GROUPING');
});

test('limits, strings, booleans, unsupported types', () => {
  const NS = ns();
  const lim = { low: 0, high: 100 };
  const fmt = (n) => n.toFixed(1) + ' degF';
  assert.equal(NS.format.parseInput('150', 'Float8', 'en-US', { limits: lim, formatLimit: fmt }).error, 'Must be between 0.0 degF and 100.0 degF.');
  assert.equal(NS.format.parseInput('100', 'Float8', 'en-US', { limits: lim }).ok, true, 'inclusive by default');
  assert.equal(NS.format.parseInput('100', 'Float8', 'en-US', { limits: { ...lim, inclusive: false } }).ok, false);
  assert.equal(NS.format.parseInput('-1', 'Int4', 'en-US', { limits: { low: 0 } }).error, 'Must be at least 0.');
  assert.equal(NS.format.parseInput('5', 'Int4', 'en-US', { limits: { high: 4 } }).error, 'Must be at most 4.');
  assert.equal(NS.format.parseInput('5', 'Int4', 'en-US', { limits: { low: 9, high: 1 } }).ok, true, 'misconfigured limits are left to the gateway');
  assert.deepEqual(plain(NS.format.parseInput('  Pump 7 ', 'String', 'en-US')), { ok: true, value: '  Pump 7 ' }, 'strings are not trimmed');
  assert.equal(NS.format.parseInput('123456789', 'String', 'en-US', { maxLength: 8 }).error, 'Too long (max 8 characters)');
  assert.equal(NS.format.parseInput('', 'String', 'en-US').ok, true, 'an empty string is a valid string');
  assert.equal(NS.format.parseInput('On', 'Boolean', 'en-US').value, true);
  assert.equal(NS.format.parseInput('0', 'Boolean', 'en-US').value, false);
  assert.equal(NS.format.parseInput('maybe', 'Boolean', 'en-US').code, 'NOT_BOOLEAN');
  for (const dt of ['DateTime', 'DataSet', 'Document', 'Float8Array', 'Whatever']) {
    assert.equal(NS.format.parseInput('1', dt, 'en-US').code, 'UNSUPPORTED', dt);
  }
  assert.equal(NS.format.parseInput('2.5', null, 'en-US').value, 2.5, 'unknown data type parses as a float');
});

test('never NaN, never throws (fuzz)', () => {
  const NS = ns();
  const chars = '0123456789+-.,eE xX_\'\u00A0abc';
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 3000; i++) {
    let s = '';
    const n = Math.floor(rnd() * 12);
    for (let k = 0; k < n; k++) s += chars[Math.floor(rnd() * chars.length)];
    for (const dt of ['Float8', 'Int4', 'Int8']) {
      for (const loc of ['en-US', 'de-DE']) {
        const r = NS.format.parseInput(s, dt, loc);
        if (r.ok) {
          assert.ok(typeof r.value === 'string' ? /^-?\d+$/.test(r.value) : Number.isFinite(r.value), `${JSON.stringify(s)} ${dt} -> ${r.value}`);
        } else {
          assert.equal(typeof r.error, 'string');
          assert.ok(r.error.length > 0);
        }
      }
    }
  }
});

test("'.'-grouped text in comma-decimal locales is rejected, not read as a decimal (de 1.500)", () => {
  const NS = ns();
  const P = (t, dt = 'Float8', loc = 'de-DE') => plain(NS.format.parseInput(t, dt, loc));
  for (const t of ['1.500', '12.345', '-1.500', '+999.999', '1.000.000', '12.345.678']) {
    assert.equal(P(t).code, 'GROUPING', `de-DE ${t}`);
    assert.equal(P(t, 'Int4').code, 'GROUPING', `de-DE Int4 ${t}`);
    assert.equal(P(t).error, "Remove thousands separators (use ',' for decimals)");
  }
  for (const loc of ['es-ES', 'it-IT', 'pt-BR', 'nl-NL']) assert.equal(P('1.500', 'Float8', loc).code, 'GROUPING', loc);
  // unambiguous '.' decimals keep working ('.' is always a decimal separator)
  assert.deepEqual(P('1.5'), { ok: true, value: 1.5 });
  assert.deepEqual(P('72.5'), { ok: true, value: 72.5 });
  assert.deepEqual(P('0.500'), { ok: true, value: 0.5 });
  assert.deepEqual(P('1000.25'), { ok: true, value: 1000.25 });
  assert.deepEqual(P('1.5000'), { ok: true, value: 1.5 });
  assert.deepEqual(P('1500'), { ok: true, value: 1500 });
  // en-US is unaffected: '.' is its decimal separator
  assert.deepEqual(P('1.500', 'Float8', 'en-US'), { ok: true, value: 1.5 });
});

test('exclusive limits wording and integer type aliases', () => {
  const NS = ns();
  const ex = { limits: { low: 0, high: 10, inclusive: false } };
  assert.equal(NS.format.parseInput('10', 'Float8', 'en-US', ex).error, 'Must be greater than 0 and less than 10.');
  assert.equal(NS.format.parseInput('0', 'Float8', 'en-US', ex).error, 'Must be greater than 0 and less than 10.');
  assert.equal(NS.format.parseInput('5', 'Float8', 'en-US', ex).ok, true);
  assert.equal(NS.format.parseInput('11', 'Float8', 'en-US', { limits: { low: 0, high: 10 } }).error, 'Must be between 0 and 10.');
  const P = (t, dt) => plain(NS.format.parseInput(t, dt, 'en-US'));
  assert.equal(P('40000', 'Short').code, 'TOO_LARGE');
  assert.equal(P('32767', 'Short').ok, true);
  assert.equal(P('128', 'Byte').code, 'TOO_LARGE');
  assert.equal(P('2147483648', 'Integer').code, 'TOO_LARGE');
  assert.equal(P('128', 'int1').code, 'TOO_LARGE', 'type names are matched case-insensitively');
  assert.deepEqual(P('3000000000', 'Long'), { ok: true, value: 3000000000 });
});
