// =============================================================================
// dt-write-retry-id.test.mjs — Display Template: a refused retry after
// CLIENT_TIMEOUT keeps the request id
// =============================================================================
// After a dt.write ends in CLIENT_TIMEOUT the outcome is unknown, so the dialog
// remembers the request id: a same-value retry re-sends under it and the
// gateway's idempotency map answers with the first request's real outcome.
// A retry that is refused before the gateway's write handler sees it —
// RATE_LIMITED / MODULE_STOPPING (refused before the id is claimed),
// DISCONNECTED / DETACHED (nothing sent) — must NOT drop that id; otherwise the
// next press is a brand-new write while the first may already have landed
// (double write). Any reply produced by the write handler (TIMEOUT included)
// still drops it.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv } from './_stubs.mjs';

function load() {
  const env = createEnv();
  env.load('ctg-common.js');
  env.load('display-template.js');
  return { NS: env.window.__CTG, env };
}
function tree(obj) {
  return { read(p) { let v = obj; for (const k of String(p).split('.')) { if (v == null || typeof v !== 'object') return undefined; v = v[k]; } return v; } };
}
const GOOD = { code: 192, name: 'Good', level: 'good' };
const cap = (allowed, reason = null) => ({ allowed, reason });
const PATH = '[default]CTG/DT_SP';
const SNAP = {
  status: 'ok', tagPath: PATH, tagName: 'DT_SP',
  value: { v: 75, t: 1, type: 'Float8', q: GOOD },
  meta: { engUnit: 'degF', engLow: 0, engHigh: 100, formatString: '#,##0.0', dataType: 'Float8', canWrite: true, readOnly: false, tagType: 'AtomicTag' },
  history: { available: true, enabled: true, provider: 'Core Historian', reason: 'ok' },
  alarms: { live: true, hasActive: false, hasUnacked: false, highestActivePriority: null, highestUnackedPriority: null, limits: { low: null, high: null } },
  capabilities: { write: Object.assign(cap(true), { audit: 'profile' }), configEdit: cap(true), trend: cap(true), changeHistory: cap(true) },
  trend: { group: 'default', trending: false, count: 0, max: 32 },
  writeLimits: { low: 0, high: 100, inclusive: true, source: 'eng' },
};
const ENV = { locale: 'en-US', timeZone: 'UTC', canInteract: true, designMode: false, designer: false, frameBlocked: false };
const fail = (code) => ({ ok: false, error: { code, message: code } });

// ---- the pure rule ----------------------------------------------------------------------------------------------

test('requestMemoAfter: CLIENT_TIMEOUT remembers the attempt, refusals keep what was remembered, replies drop it', () => {
  const { NS } = load();
  const m = NS.dt.requestMemoAfter;
  const prev = { key: '50', id: 'dt0:0:1-1' };
  const attempt = { key: '50', id: 'dt0:0:1-1' };
  const fresh = { key: '40', id: 'dt0:0:1-2' };
  assert.equal(m(prev, attempt, undefined), null, 'success: nothing to remember');
  assert.deepEqual(m(null, fresh, 'CLIENT_TIMEOUT'), fresh, 'outcome unknown: remember this attempt');
  assert.deepEqual(m(prev, null, 'CLIENT_TIMEOUT'), prev);
  for (const code of ['RATE_LIMITED', 'MODULE_STOPPING', 'DISCONNECTED', 'DETACHED']) {
    assert.deepEqual(m(prev, attempt, code), prev, code + ' never reached the write handler: keep the unknown id');
    assert.deepEqual(m(prev, fresh, code), prev, code + ': a refused different value keeps the earlier unknown id');
    assert.equal(m(null, fresh, code), null, code + ': nothing was remembered, nothing is');
  }
  for (const code of ['TIMEOUT', 'AUDIT_UNAVAILABLE', 'WRITE_FAILED', 'BAD_QUALITY', 'OUT_OF_RANGE', 'STEP_TOO_LARGE',
    'STALE_TARGET', 'FORBIDDEN_ROLE', 'WRITE_DENIED', 'INTERNAL', 'BAD_REQUEST', 'AUTH_CHANGED']) {
    assert.equal(m(prev, attempt, code), null, code + ' is a reply of the write handler: a retry is a new write');
  }
});

// ---- the dialog, end to end over a scripted submit ---------------------------------------------------------------

/** A DtSetpointDialog with a synchronous setState and a scripted submit (one outcome per press). */
function dialog(NS, outcomes) {
  const cfg = NS.dt.makeReducer()(tree({ tagPath: PATH, setpoint: { enabled: true, confirm: 'never', popup: { closeOnSuccess: false } } }));
  const sent = [];
  let n = 0;
  const props = {
    cfg, env: ENV, d: { snap: SNAP, stale: false, staleReason: null, phase: 'ready' },
    vm: { labelText: 'SP', tagName: 'DT_SP' }, target: { tagPath: PATH, tagName: 'DT_SP' },
    onClose() {},
    submit(value, info) {
      const res = outcomes[sent.length];
      // like DisplayTemplateDelegate.write(): the reused id, or a new one only when something went out
      const wentOut = !(res && !res.ok && (res.error.code === 'DISCONNECTED' || res.error.code === 'DETACHED'));
      const id = info.reuseId || (wentOut ? 'dt0:0:1-' + (++n) : null);
      sent.push({ value, reuseId: info.reuseId || null, id });
      return { id, promise: Promise.resolve(res) };
    },
  };
  const d = new NS.dt.DtSetpointDialog(props);
  d.setState = function (u) { Object.assign(this.state, typeof u === 'function' ? u(this.state, this.props) : u); };
  d._alive = true;
  return { d, sent };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test('dialog: retries refused after CLIENT_TIMEOUT keep re-sending under the unknown id (no double write)', async () => {
  const { NS } = load();
  const { d, sent } = dialog(NS, [fail('CLIENT_TIMEOUT'), fail('RATE_LIMITED'), fail('DISCONNECTED'),
    fail('MODULE_STOPPING'), { ok: true, data: { written: 50 } }]);
  for (let i = 0; i < 5; i++) {
    d._send(50);
    await settle();
  }
  assert.deepEqual(sent.map((s) => s.reuseId), [null, 'dt0:0:1-1', 'dt0:0:1-1', 'dt0:0:1-1', 'dt0:0:1-1'],
    'every retry of the same value attaches to the first request (previously the 3rd press was a new write)');
  assert.equal(d.state.lastSent, null, 'the final reply settles it');
});

test('dialog: a different value refused locally does not lose the unknown id of the first value', async () => {
  const { NS } = load();
  const { d, sent } = dialog(NS, [fail('CLIENT_TIMEOUT'), fail('DISCONNECTED'), { ok: true, data: { written: 50 } }]);
  d._send(50);
  await settle();
  d._send(40);                                          // another value while the socket is down: nothing sent
  await settle();
  d._send(50);                                          // back to the first value
  await settle();
  assert.deepEqual(sent.map((s) => s.reuseId), [null, null, 'dt0:0:1-1']);
});

test('dialog: after a gateway reply (TIMEOUT) the next press is a new write', async () => {
  const { NS } = load();
  const { d, sent } = dialog(NS, [fail('CLIENT_TIMEOUT'), fail('TIMEOUT'), { ok: true, data: { written: 50 } }]);
  for (let i = 0; i < 3; i++) {
    d._send(50);
    await settle();
  }
  assert.deepEqual(sent.map((s) => s.reuseId), [null, 'dt0:0:1-1', null]);
});