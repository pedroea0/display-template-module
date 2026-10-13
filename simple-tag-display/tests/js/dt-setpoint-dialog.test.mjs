// =============================================================================
// dt-setpoint-dialog.test.mjs — Display Template setpoint dialog: request ids,
// write blocks and overlay event isolation
// =============================================================================
// keepsRequestId: the dialog reuses a dt.write request id ONLY after
//   CLIENT_TIMEOUT (the gateway's outcome may still be pending). After any reply
//   from the gateway, a gateway TIMEOUT included (the idempotency cache stores
//   TIMEOUT too), the id is dropped, so a retry is a new attempt and not the
//   gateway's cached failure.
// OVERLAY_STOP_EVENTS: the overlay host stops every bubbling React event that
//   ctg-common's portal guard leaves out (against ancestor DOM scripts).
// dialogBlock: why Write is off in an open dialog. "The tag or permissions
//   changed…" only when the dialog's own target is gone; advisory capability
//   reasons show their own text (they can clear by themselves).
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
function snapSp(over = {}) {
  return Object.assign({
    status: 'ok', tagPath: '[default]CTG/DT_SP', tagName: 'DT_SP',
    value: { v: 75, t: 1, type: 'Float8', q: GOOD },
    meta: { engUnit: 'degF', engLow: 0, engHigh: 100, formatString: '#,##0.0', dataType: 'Float8', canWrite: true, readOnly: false, tagType: 'AtomicTag' },
    history: { available: true, enabled: true, provider: 'Core Historian', reason: 'ok' },
    alarms: { live: true, hasActive: false, hasUnacked: false, highestActivePriority: null, highestUnackedPriority: null, limits: { low: null, high: null } },
    capabilities: { write: Object.assign(cap(true), { audit: 'profile' }), configEdit: cap(true), trend: cap(true), changeHistory: cap(true) },
    trend: { group: 'default', trending: false, count: 0, max: 32 },
    writeLimits: { low: 0, high: 100, inclusive: true, source: 'eng' },
  }, over);
}
const withWrite = (w) => snapSp({ capabilities: Object.assign({}, snapSp().capabilities, { write: w }) });
const D = (snap, extra = {}) => Object.assign({ snap, stale: false, staleReason: null, phase: 'ready' }, extra);
const ENV = { locale: 'en-US', timeZone: 'UTC', canInteract: true, designMode: false, designer: false, frameBlocked: false };
const PATH = '[default]CTG/DT_SP';

test('keepsRequestId: only a client-side timeout keeps the request id for a retry', () => {
  const { NS } = load();
  assert.equal(NS.dt.keepsRequestId('CLIENT_TIMEOUT'), true);
  for (const code of ['TIMEOUT', 'AUDIT_UNAVAILABLE', 'WRITE_FAILED', 'BAD_QUALITY', 'BUSY', 'RATE_LIMITED', 'OUT_OF_RANGE', 'INVALID_VALUE',
    'STEP_TOO_LARGE', 'STALE_TARGET', 'FORBIDDEN_ROLE', 'WRITE_DENIED', 'INTERNAL', 'MODULE_STOPPING', 'DISCONNECTED', 'DETACHED',
    undefined, null, '']) {
    assert.equal(NS.dt.keepsRequestId(code), false, String(code));
  }
});

test('dialogBlock: target changes vs advisory capability reasons', () => {
  const { NS } = load();
  const cfg = NS.dt.makeReducer()(tree({ tagPath: PATH, setpoint: { enabled: true } }));
  const b = (snap, extra = {}, c = cfg, path = PATH, env = ENV) => NS.dt.dialogBlock(c, D(snap, extra), env, path);
  const CHANGED = 'The tag or permissions changed while this dialog was open. Close and try again.';
  assert.equal(b(snapSp()), '', 'writable');
  // the dialog's own target is gone
  assert.equal(b(snapSp(), {}, cfg, '[default]CTG/Other'), CHANGED, 'other tag');
  assert.equal(b(null), CHANGED, 'no snapshot');
  assert.equal(b(snapSp(), {}, NS.dt.makeReducer()(tree({ tagPath: PATH, setpoint: { enabled: false } }))), CHANGED, 'setpoint off');
  assert.equal(b(snapSp(), {}, NS.dt.makeReducer()(tree({ tagPath: PATH, enabled: false, setpoint: { enabled: true } }))), CHANGED, 'component off');
  // connection
  assert.equal(b(snapSp(), { stale: true, staleReason: 'disconnected' }), 'Not connected');
  // advisory reasons: their own text, never "changed"
  const own = (reason) => b(withWrite(cap(false, reason)));
  assert.equal(own('READ_ONLY'), 'This tag is read-only.');
  assert.equal(own('FORBIDDEN_ROLE'), "You don't have permission to change this value.");
  assert.equal(own('WRITE_DENIED'), "This tag's write permissions do not include you.");
  for (const r of ['BAD_QUALITY', 'LIMITS_UNAVAILABLE', 'AUDIT_UNAVAILABLE', 'AUTH_REQUIRED']) {
    const txt = own(r);
    assert.ok(txt && txt !== CHANGED, r + ' → ' + txt);
    assert.equal(txt, NS.dt.errText({ code: r }), r);
  }
  // a bad-quality dip on the value itself (capability still allowed)
  assert.equal(b(snapSp({ value: { v: 1, type: 'Float8', q: { level: 'bad', name: 'Bad' } } })), NS.dt.errText({ code: 'BAD_QUALITY' }));
  // and it clears by itself: back to '' once the reason is gone
  assert.equal(b(withWrite(Object.assign(cap(true), { audit: 'profile' }))), '');
});

test('OVERLAY_STOP_EVENTS: every bubbling React event outside ctg-common GUARD_EVENTS is stopped at the overlay host', () => {
  const { NS } = load();
  const set = new Set(NS.dt.OVERLAY_STOP_EVENTS);
  for (const n of ['onMouseMove', 'onMouseOver', 'onMouseOut', 'onPointerMove', 'onPointerOver', 'onPointerOut', 'onPointerCancel',
    'onKeyPress', 'onTouchMove', 'onTouchCancel', 'onInput', 'onChange', 'onSelect', 'onBeforeInput', 'onCopy', 'onCut', 'onPaste',
    'onDrag', 'onDragStart', 'onDrop', 'onAuxClick', 'onCompositionEnd', 'onSubmit',
    // the GUARD_EVENTS themselves too (defence in depth)
    'onClick', 'onMouseDown', 'onMouseUp', 'onPointerDown', 'onPointerUp', 'onContextMenu', 'onDoubleClick', 'onKeyDown', 'onKeyUp',
    'onFocus', 'onBlur', 'onWheel', 'onTouchStart', 'onTouchEnd']) {
    assert.ok(set.has(n), n);
  }
  // enter/leave are not bubbled by React: stopPropagation cannot cover them, so they are not listed
  for (const n of ['onMouseEnter', 'onMouseLeave', 'onPointerEnter', 'onPointerLeave']) assert.ok(!set.has(n), n);
  assert.equal(set.size, NS.dt.OVERLAY_STOP_EVENTS.length, 'no duplicates');
});
