// =============================================================================
// format.test.mjs — NS.format number patterns and value text
// =============================================================================
// Runs ctg-common.js in the stub page (no PerspectiveClient.NumberFormat), so
// NS.format.number uses our Java-DecimalFormat-subset port on Intl. The browser
// uses Perspective's NumberFormat for pure numeric patterns; both were checked
// in a real browser to agree on this matrix.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv } from './_stubs.mjs';

function ns() {
  const env = createEnv();
  env.load('ctg-common.js');
  return env.window.__CTG;
}
const enc = (v, extra = {}) => ({ v, t: 0, type: typeof v === 'number' ? 'Float8' : undefined, q: { level: 'good' }, ...extra });

// pattern -> [en-US, de-DE] for 1234.567, 0.1234, -1234.5
const MATRIX = {
  '#,##0.0': [['1,234.6', '0.1', '-1,234.5'], ['1.234,6', '0,1', '-1.234,5']],
  '0.00%': [['123456.70%', '12.34%', '-123450.00%'], ['123456,70%', '12,34%', '-123450,00%']],
  '0.00E0': [['1.23E3', '1.23E-1', '-1.23E3'], ['1,23E3', '1,23E-1', '-1,23E3']],
  '0': [['1235', '0', '-1235'], ['1235', '0', '-1235']],
  '#,##0.##': [['1,234.57', '0.12', '-1,234.5'], ['1.234,57', '0,12', '-1.234,5']],
};

test('patterns x locales (en-US, de-DE)', () => {
  const NS = ns();
  for (const [pattern, [en, de]] of Object.entries(MATRIX)) {
    [1234.567, 0.1234, -1234.5].forEach((v, i) => {
      assert.equal(NS.format.number(v, pattern, 'en-US'), en[i], `en-US ${pattern} ${v}`);
      assert.equal(NS.format.number(v, pattern, 'de-DE'), de[i], `de-DE ${pattern} ${v}`);
    });
  }
});

test('DecimalFormat subset extras \u2014 literals, negative sub-pattern, per-mille, leading-dot', () => {
  const NS = ns();
  assert.equal(NS.format.number(1234.56, "#,##0.0 'psi'", 'en-US'), '1,234.6 psi');
  assert.equal(NS.format.number(12.5, "0.0' it''s'", 'en-US'), "12.5 it's");
  assert.equal(NS.format.number(-3.25, '0.0;(0.0)', 'en-US'), '(3.3)');
  assert.equal(NS.format.number(0.1234, '0.0\u2030', 'en-US'), '123.4\u2030');
  assert.equal(NS.format.number(0.5, '.00', 'en-US'), '.50');
  assert.equal(NS.format.number(7, '000', 'en-US'), '007');
  assert.equal(NS.format.number(-0.001, '0', 'en-US'), '0', 'no "-0"');
  assert.equal(NS.format.number(-0.004, '0.00', 'de-DE'), '0,00');
  assert.equal(NS.format.number(NaN, '0'), 'NaN');
  assert.equal(NS.format.number(Infinity, '0'), '\u221E');
  assert.equal(NS.format.number(-Infinity, '0'), '\u2212\u221E');
  assert.equal(NS.format.number('12.5', '0.0'), '12.5', 'numeric strings are numbers');
  assert.equal(NS.format.number('0x1A', '0.0'), '0x1A', 'non-numeric strings pass through');
});

test('patternToIntl spec', () => {
  const NS = ns();
  const s = NS.format.patternToIntl('#,##0.0##');
  assert.equal(s.options.useGrouping, true);
  assert.equal(s.options.minimumIntegerDigits, 1);
  assert.equal(s.options.minimumFractionDigits, 1);
  assert.equal(s.options.maximumFractionDigits, 3);
  assert.equal(NS.format.patternToIntl('0.00E0').options.notation, 'scientific');
  assert.equal(NS.format.patternToIntl('##0.##E0').options.notation, 'engineering');
  assert.equal(NS.format.patternToIntl('0%').multiplier, 100);
  assert.equal(NS.format.buildFixedPattern(2, true), '#,##0.00');
  assert.equal(NS.format.buildFixedPattern(0, false), '0');
  assert.equal(NS.format.buildFixedPattern(99, false), '0.' + '0'.repeat(15));
  assert.equal(NS.format.buildFixedPattern(-3, false), '0');
});

test('no throw for any decimals or pattern input', () => {
  const NS = ns();
  const patterns = [undefined, null, '', ' ', '###', '0.0.0', ',,,', 'E0', '0E', "'", "''", ';', ';;', 'abc', '%%%', '0.' + '#'.repeat(40),
    '0'.repeat(40), '#,##0.00;', '\u0000', '{}', 42, {}, [], '0.00E0E0', '$#,##0.00', '0.0a', '0o', '00:00:00'];
  const decimals = [undefined, null, '', -1, 101, 2.7, 'x', NaN, Infinity, -Infinity, '3', true, {}];
  for (const p of patterns) {
    for (const v of [0, -1.5, 1e21, 1e-12, 123456789.123, NaN]) {
      const out = NS.format.number(v, p, 'en-US');
      assert.equal(typeof out, 'string', `pattern ${String(p)}`);
    }
    for (const d of decimals) {
      const r = NS.format.value(enc(12.3456), { format: p, decimals: d, locale: 'de-DE' });
      assert.equal(typeof r.text, 'string');
      assert.ok(!/undefined|\[object/.test(r.text), `${String(p)} / ${String(d)} -> ${r.text}`);
    }
  }
  for (const loc of [undefined, '', 'xx_YY_bad!', 'de_DE', 42]) assert.equal(typeof NS.format.number(1.5, '0.0', loc), 'string');
});

test('value text \u2014 edge-case table', () => {
  const NS = ns();
  const V = (e, o) => NS.format.value(e, o || {});
  assert.equal(V(enc('')).text, '');
  assert.equal(V(enc(' ')).text, ' ');
  assert.equal(V(enc('0x1A')).text, '0x1A');
  assert.equal(V(enc('0b11')).text, '0b11');
  assert.equal(V(enc(1.5), { decimals: -1 }).text, '2');
  assert.equal(V(enc(1.23456), { decimals: 101 }).text, '1.234560000000000');
  assert.equal(V(enc(1.23456), { decimals: 2.7 }).text, '1.23');
  assert.equal(V(enc(5, { type: 'Int4' }), { tagFormat: '#,##0.##' }).text, '5');
  const big = V(enc('9007199254740993', { type: 'Int8', bigint: true }), { tagFormat: '#,##0.##' });
  assert.deepEqual([big.text, big.kind, big.approximate], ['9,007,199,254,740,993', 'number', true]);
  assert.equal(V(enc(1e21)).text, '1,000,000,000,000,000,000,000');
  const nan = V(enc(null, { nonFinite: 'NaN' }));
  assert.equal(nan.text, 'NaN');
  assert.equal(nan.kind, 'nonFinite');
  assert.equal(V(enc(null, { nonFinite: '-Infinity' })).text, '\u2212\u221E');
  assert.equal(V(enc(null)).text, '\u2014');
  assert.equal(V(enc(null), { nullText: 'n/a' }).text, 'n/a');
  const date = V(enc(Date.UTC(2026, 9, 7, 23, 40, 52), { type: 'DateTime' }), { timeZone: 'America/Chicago' });
  assert.deepEqual([date.text, date.kind], ['2026-10-07 18:40:52', 'date']);
  assert.equal(V(enc({ dataset: { rows: 3, cols: 2 } })).text, 'Dataset [3 \u00D7 2]');
  assert.equal(V(null).kind, 'loading');
  assert.equal(V(undefined, { loadingText: 'wait' }).text, 'wait');
});

test('booleans, states, arrays, strings, objects', () => {
  const NS = ns();
  const V = (e, o) => NS.format.value(e, o || {});
  const b = V(enc(true, { type: 'Boolean' }), { trueText: ' Run ' });
  assert.deepEqual([b.text, b.kind, b.numeric], [' Run ', 'boolean', 1], 'padding preserved');
  assert.equal(V(enc(false, { type: 'Boolean' })).text, 'false');
  assert.equal(V(enc('TRUE', { type: 'String' })).text, 'TRUE', 'string tags holding TRUE are not relabelled');
  const states = [{ value: 0, label: 'Off' }, { value: '2', label: 'Manual' }, { value: true, label: 'Yes' }];
  assert.equal(V(enc(2), { states }).text, 'Manual');
  assert.equal(V(enc(2), { states }).kind, 'state');
  assert.equal(V(enc(0), { states }).text, 'Off');
  assert.equal(V(enc(7), { states }).text, '7', 'no match continues');
  assert.equal(V(enc(7), { states, unmatchedText: '?' }).text, '?');
  assert.equal(V(enc([1, 2, 3.25]), { format: '0.0' }).text, '1.0, 2.0, 3.3');
  assert.equal(V(enc(Array.from({ length: 15 }, (_, i) => i))).text, '0, 1, 2, 3, 4, 5, 6, 7, 8, 9 \u2026 (+5)');
  assert.equal(V(enc([true, null, 'x']), { trueText: 'on' }).text, 'on, \u2014, x');
  assert.equal(V(enc('abc', { truncated: true })).text, 'abc\u2026');
  const long = V(enc({ k: 'x'.repeat(500) }));
  assert.equal(long.kind, 'object');
  assert.ok(long.text.length <= 200);
});

test('locale helpers', () => {
  const NS = ns();
  assert.equal(NS.format.decimalSeparator('de-DE'), ',');
  assert.equal(NS.format.decimalSeparator('en-US'), '.');
  assert.equal(NS.format.groupSeparator('de-DE'), '.');
  assert.equal(NS.format.normLocale('de_DE'), 'de-DE');
  assert.equal(NS.format.normLocale('!!'), 'en-US');
  assert.equal(NS.format.locale(null), NS.format.normLocale(globalThis.navigator ? navigator.language : 'en-US'));
  const f = NS.format.formatter('#,##0.0', 'en-US');
  assert.equal(f(1234.56), '1,234.6');
});

test('negatives keep their sign in locales with native digits (ar-EG, fa-IR, bn-BD, mr-IN)', () => {
  const NS = ns();
  // Previously an ASCII-only /[1-9]/ decided "rounds to zero" and dropped the minus here.
  const MINUS = new RegExp('[-' + String.fromCharCode(0x2212) + ']');
  for (const loc of ['ar-EG', 'fa-IR', 'bn-BD', 'mr-IN', 'en-US', 'de-DE']) {
    for (const [v, pattern] of [[-12.5, '#,##0.##'], [-5.25, '0.0'], [-1234.5, '#,##0.0'], [-0.5, '.00'], [-3, '0'], [-0.25, '0.00%']]) {
      const s = NS.format.number(v, pattern, loc);
      assert.ok(MINUS.test(s), `${loc} ${pattern} ${v} -> ${JSON.stringify(s)} keeps its minus`);
      assert.equal(NS.format.formatter(pattern, loc)(v), s, 'formatter() is the same port');
    }
    const t = NS.format.value({ v: -12.5, t: 0, type: 'Float8', q: { level: 'good' } }, { locale: loc }).text;
    assert.ok(MINUS.test(t), `${loc} value text ${JSON.stringify(t)} keeps its minus`);
    // a negative that rounds to zero prints exactly the zero text (no "-0"), in every script
    for (const [v, pattern] of [[-0.001, '0.00'], [-0.004, '.00'], [-0.4, '0'], [-0, '0.0']]) {
      assert.equal(NS.format.number(v, pattern, loc), NS.format.number(0, pattern, loc), `${loc} ${pattern} ${v}`);
    }
    assert.ok(!MINUS.test(NS.format.number(12.5, '0.0', loc)), `${loc} positive has no minus`);
  }
  const arabicZero = String.fromCharCode(0x0660);
  assert.ok(!NS.format.number(0.5, '.00', 'ar-EG').startsWith(arabicZero), "'.00' strips the native leading zero too");
});

test('Boolean-typed values sent as strings', () => {
  const NS = ns();
  const V = (v) => NS.format.value({ v, t: 0, type: 'Boolean', q: { level: 'good' } }, {}).text;
  assert.equal(V('true'), 'true');
  assert.equal(V('TRUE'), 'true');
  assert.equal(V(' 1 '), 'true');
  assert.equal(V('false'), 'false');
  assert.equal(V('0'), 'false');
  assert.equal(V('nonsense'), 'false');
  assert.equal(V(1), 'true');
  assert.equal(V(0), 'false');
});
