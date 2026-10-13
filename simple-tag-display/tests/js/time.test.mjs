// =============================================================================
// time.test.mjs — NS.time: tokens, zones, DST gap/overlap, calendar maths
// =============================================================================
// America/Chicago 2026: DST starts Sun 2026-03-08 02:00 CST (clocks jump to
// 03:00 CDT, 08:00Z) and ends Sun 2026-11-01 02:00 CDT (back to 01:00 CST,
// 07:00Z). Node ships full ICU, so the zone data matches the browser's.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv } from './_stubs.mjs';

const TZ = 'America/Chicago';
function ns() {
  const env = createEnv();
  env.load('ctg-common.js');
  return { NS: env.window.__CTG, env };
}

test('format: every token, literals, zones and locales', () => {
  const { NS } = ns();
  const t = Date.UTC(2026, 9, 7, 23, 40, 52, 123);             // 18:40:52.123 CDT
  assert.equal(NS.time.format(t, 'YYYY-MM-DD HH:mm:ss.SSS ZZ', TZ), '2026-10-07 18:40:52.123 -0500');
  assert.equal(NS.time.format(t, 'YY M D H h hh A', TZ), '26 10 7 18 6 06 PM');
  assert.equal(NS.time.format(t, 'MMM MMMM [at] HH:mm', TZ), 'Oct October at 18:40');
  assert.equal(NS.time.format(t, 'D. MMMM YYYY', TZ, 'de-DE'), '7. Oktober 2026');
  assert.equal(NS.time.format(t, '[YYYY] YYYY', 'UTC'), 'YYYY 2026');
  assert.equal(NS.time.format(t, 'HH:mm ZZ', 'Asia/Kolkata'), '05:10 +0530');
  assert.equal(NS.time.format(Date.UTC(2026, 0, 1, 6, 0), 'hh:mm A ZZ', TZ), '12:00 AM -0600');
  assert.equal(NS.time.format(Date.UTC(2026, 0, 1, 18, 0), 'h A', TZ), '12 PM');
  assert.equal(NS.time.format(t, undefined, TZ), '2026-10-07 18:40:52', 'default pattern');
  assert.equal(NS.time.format(NaN, 'YYYY'), '');
  assert.equal(NS.time.format('x', 'YYYY'), '');
  assert.equal(NS.format.date(t, 'HH:mm', TZ), '18:40');
});

test('zonedToEpoch: normal, DST gap (moved forward), DST overlap (earlier instant)', () => {
  const { NS } = ns();
  const normal = NS.time.zonedToEpoch({ y: 2026, M: 7, d: 1, h: 12 }, TZ);
  assert.deepEqual({ ...normal }, { ms: Date.UTC(2026, 6, 1, 17), note: null });
  const gap = NS.time.zonedToEpoch({ y: 2026, M: 3, d: 8, h: 2, m: 30 }, TZ);
  assert.equal(gap.note, 'gap');
  assert.equal(gap.ms, Date.UTC(2026, 2, 8, 8, 30));
  assert.equal(NS.time.format(gap.ms, 'HH:mm ZZ', TZ), '03:30 -0500', '02:30 does not exist -> 03:30 CDT');
  const ov = NS.time.zonedToEpoch({ y: 2026, M: 11, d: 1, h: 1, m: 30 }, TZ);
  assert.equal(ov.note, 'overlap');
  assert.equal(ov.ms, Date.UTC(2026, 10, 1, 6, 30), 'first 01:30 (CDT)');
  assert.equal(NS.time.zonedToEpoch({ y: 2026, M: 11, d: 1, h: 2, m: 30 }, TZ).note, null);
  assert.equal(NS.time.zonedToEpoch({ y: 'x', M: 1, d: 1 }, TZ).note, 'invalid');
  assert.ok(Number.isNaN(NS.time.zonedToEpoch(null, TZ).ms));
  // round trip over a whole year of hours
  for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3600000 * 7) {
    const p = NS.time.parts(t, TZ);
    const back = NS.time.zonedToEpoch(p, TZ);
    assert.ok(back.ms === t || back.note === 'overlap', `round trip ${new Date(t).toISOString()}`);
  }
});

test('subtractCalendar: exact units, wall-clock days across DST, month-end clamping', () => {
  const { NS } = ns();
  const at = (y, M, d, h = 0, m = 0) => NS.time.zonedToEpoch({ y, M, d, h, m }, TZ).ms;
  const fmt = (ms) => NS.time.format(ms, 'YYYY-MM-DD HH:mm', TZ);
  const noon = at(2026, 3, 8, 12);
  assert.equal(fmt(NS.time.subtractCalendar(noon, 1, 'days', TZ)), '2026-03-07 12:00');
  assert.equal((noon - NS.time.subtractCalendar(noon, 1, 'days', TZ)) / 3600000, 23, 'a calendar day across spring-forward is 23 h');
  assert.equal((noon - NS.time.subtractCalendar(noon, 24, 'hours', TZ)) / 3600000, 24, 'hours are exact');
  assert.equal(fmt(NS.time.subtractCalendar(noon, 24, 'hours', TZ)), '2026-03-07 11:00');
  const fall = at(2026, 11, 1, 12);
  assert.equal((fall - NS.time.subtractCalendar(fall, 1, 'day', TZ)) / 3600000, 25);
  assert.equal(fmt(NS.time.subtractCalendar(at(2026, 3, 31, 10), 1, 'months', TZ)), '2026-02-28 10:00');
  assert.equal(fmt(NS.time.subtractCalendar(at(2024, 2, 29), 1, 'years', TZ)), '2023-02-28 00:00');
  assert.equal(fmt(NS.time.subtractCalendar(at(2026, 1, 15, 9), 2, 'weeks', TZ)), '2026-01-01 09:00');
  assert.equal(fmt(NS.time.subtractCalendar(at(2026, 1, 31, 9), 13, 'months', TZ)), '2024-12-31 09:00');
  assert.equal(fmt(NS.time.subtractCalendar(at(2026, 1, 31, 9), -1, 'months', TZ)), '2026-02-28 09:00', 'negative adds');
  assert.equal(NS.time.subtractCalendar(noon, 90, 's', TZ), noon - 90000);
  assert.equal(NS.time.subtractCalendar(noon, 5, 'minutes', TZ), noon - 300000);
  assert.ok(Number.isNaN(NS.time.subtractCalendar(noon, 1, 'fortnight', TZ)));
  assert.ok(Number.isNaN(NS.time.subtractCalendar(noon, 'x', 'days', TZ)));
});

test('resolveZone: session / gateway / browser / IANA / invalid', () => {
  const { NS, env } = ns();
  const props = { timeZoneId: 'Europe/Berlin', 'gateway.timezone': 'Asia/Tokyo' };
  const store = { view: { page: { sessionProps: { read: (p) => props[p] } } } };
  assert.equal(NS.time.resolveZone('session', store), 'Europe/Berlin');
  assert.equal(NS.time.resolveZone(undefined, store), 'Europe/Berlin');
  assert.equal(NS.time.resolveZone('gateway', store), 'Asia/Tokyo');
  assert.equal(NS.time.resolveZone('America/Chicago', store), 'America/Chicago');
  assert.equal(NS.time.resolveZone('browser', store), NS.time.browserZone());
  const before = env.warnings.length;
  assert.equal(NS.time.resolveZone('Mars/Olympus', store), 'Europe/Berlin');
  assert.equal(NS.time.resolveZone('Mars/Olympus', store), 'Europe/Berlin');
  assert.equal(env.warnings.length, before + 1, 'one warning per invalid zone');
  props.timeZoneId = 'nonsense';
  assert.equal(NS.time.resolveZone('session', store), NS.time.browserZone());
  assert.equal(NS.time.isValidZone('UTC'), true);
  assert.equal(NS.time.isValidZone(''), false);
});

test('NS.clock: median of the last 5 offset samples', () => {
  const { NS } = ns();
  const now = Date.now();
  [1000, 1000, 50000, 1000, -40000].forEach((o) => NS.clock.sample(now + o, undefined, now));
  assert.equal(NS.clock.offset(), 1000);
  NS.clock.sample(now + 2000, now - 100, now + 100);       // RTT-centred: serverNow - (sent+recv)/2
  assert.equal(NS.clock.offset(), 1000);
  assert.ok(Math.abs(NS.clock.now() - (Date.now() + 1000)) < 50);
  NS.clock.sample('x');
  assert.equal(NS.clock.offset(), 1000);
});
