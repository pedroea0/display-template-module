// =============================================================================
// delegate-base.test.mjs — browser half of the delegate protocol
// =============================================================================
// Exercises NS.delegate.CtgDelegateBase against the stub environment:
// handshake, replies, timeouts, seq-gap and reconnect resync, epoch change,
// request() never rejecting, and log redaction of history tokens.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEnv, FILES } from './_stubs.mjs';

function setup(opts) {
  const env = createEnv(opts);
  for (const f of FILES) env.load(f, '2.0.0-cafebabe');
  const NS = env.window.__CTG;
  const store = { addressPathString: '0:3' };
  const d = new NS.dt.DisplayTemplateDelegate(store);
  return { env, NS, d, sent: () => env.fired.filter(f => f.store === store) };
}
const env0 = (seq, extra) => Object.assign({ v: 2, epoch: 'e1', seq, serverNow: Date.now() }, extra);

test('attach sends ctg.hello with kind and build; welcome makes it ready', () => {
  const { d, sent } = setup();
  d.attach();
  const hello = sent()[0];
  assert.equal(hello.name, 'ctg.hello');
  assert.deepEqual({ ...hello.payload }, { v: 2, component: 'dt', resync: false, clientBuild: '2.0.0-cafebabe' });
  assert.equal(d.mapStateToProps().phase, 'helloSent');
  d.handleEvent('ctg.welcome', env0(1, { protocol: 2, staleClient: false, user: { userName: 'x' } }));
  d.handleEvent('dt.snapshot', env0(2, { status: 'ok', tagPath: '[default]A', value: { v: 1 } }));
  const s = d.mapStateToProps();
  assert.equal(s.phase, 'ready');
  assert.equal(s.snap.value.v, 1);
  assert.equal(s.snap.seq, undefined, 'envelope stripped');
  d.detach();
});

test('mapStateToProps returns the same object until something changes', () => {
  const { d } = setup();
  d.attach();
  const a = d.mapStateToProps();
  assert.equal(d.mapStateToProps(), a);
  d.handleEvent('ctg.welcome', env0(1));
  assert.notEqual(d.mapStateToProps(), a);
  d.detach();
});

test('request resolves with the reply and samples the clock', async () => {
  const { d, sent, NS } = setup();
  d.attach();
  d.handleEvent('ctg.welcome', env0(1));
  const p = d.request('ctg.ping', {});
  const msg = sent().at(-1);
  assert.equal(msg.name, 'ctg.ping');
  assert.match(msg.payload.id, /^dt0:3-[a-z0-9]{8}-\d+$/);
  assert.equal(msg.payload.v, 2);
  d.handleEvent('ctg.reply', env0(2, { id: msg.payload.id, ok: true, data: { t: 5 }, serverNow: Date.now() + 10000 }));
  assert.deepEqual(JSON.parse(JSON.stringify(await p)), { ok: true, data: { t: 5 } });   // vm realm -> plain
  assert.ok(Math.abs(NS.clock.offset() - 10000) < 2000);
  d.detach();
});

test('error replies resolve ok:false; nothing ever rejects', async () => {
  const { d, sent } = setup();
  d.attach();
  const p = d.request('ctg.debug.fire', { event: 'onSetpointWrite' });
  const id = sent().at(-1).payload.id;
  d.handleEvent('ctg.reply', env0(1, { id, ok: false, error: { code: 'UNKNOWN_MESSAGE', message: 'Unknown request.', retryable: false } }));
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'UNKNOWN_MESSAGE');
  d.detach();
});

test('client timeout, disconnected and detached requests', async () => {
  const { d, env } = setup();
  d.attach();
  const t = await d.request('ctg.ping', {}, { timeoutMs: 20 });
  assert.equal(t.error.code, 'CLIENT_TIMEOUT');
  env.setConnected(false);
  assert.equal((await d.request('ctg.ping', {})).error.code, 'DISCONNECTED');
  env.setConnected(true);
  const pending = d.request('ctg.ping', {});
  d.detach();
  assert.equal((await pending).error.code, 'DETACHED');
  assert.equal((await d.request('ctg.ping', {})).error.code, 'DETACHED');
});

test('reconnect re-sends hello with resync:true and marks the component stale meanwhile', () => {
  const { d, env, sent } = setup();
  d.attach();
  d.handleEvent('ctg.welcome', env0(1));
  env.setConnected(false);
  assert.equal(d.mapStateToProps().connected, false);
  assert.equal(d.isStale(), true);
  env.setConnected(true);
  const hello = sent().filter(s => s.name === 'ctg.hello').at(-1);
  assert.equal(hello.payload.resync, true);
  d.handleEvent('ctg.welcome', env0(2));
  assert.equal(d.isStale(), false);
  d.detach();
});

test('a seq gap triggers a resync hello; an epoch change drops the snapshot', () => {
  const { d, sent } = setup();
  d.attach();
  d.handleEvent('ctg.welcome', env0(1));
  d.handleEvent('dt.snapshot', env0(2, { status: 'ok', value: { v: 1 } }));
  const before = sent().filter(s => s.name === 'ctg.hello').length;
  d.handleEvent('dt.values', env0(5, { value: { v: 2 } }));
  assert.equal(sent().filter(s => s.name === 'ctg.hello').length, before + 1);
  assert.equal(d.mapStateToProps().snap.value.v, 2);
  d.handleEvent('dt.values', { v: 2, epoch: 'e2', seq: 1, serverNow: Date.now(), value: { v: 3 } });
  assert.equal(d.mapStateToProps().snap, null);
  d.detach();
});

test('protocol mismatch sets reload', () => {
  const { d } = setup();
  d.attach();
  d.handleEvent('dt.snapshot', { v: 3, epoch: 'x', seq: 1 });
  assert.deepEqual({ ...d.mapStateToProps().reload }, { reason: 'protocol' });
  d.detach();
});

test('NS.log redacts history tokens', () => {
  const { NS } = setup();
  const r = NS.log.redact({ url: '/x', token: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG', nested: { 'X-CTG-Token': 'zzzzzzzzzzzzzz' } });
  assert.equal(r.token, '***');
  assert.equal(r.nested['X-CTG-Token'], '***');
  assert.equal(NS.log.redact('X-CTG-Token: abcdefghijklmnop'), 'X-CTG-Token: ***');
});

test('trendGroup and key normalisation match the gateway rules', () => {
  const { NS } = setup();
  assert.equal(NS.util.normTrendGroup(null, { kind: 'dt' }), 'default');
  assert.equal(NS.util.normTrendGroup('', { kind: 'chart' }), null);
  assert.equal(NS.util.normTrendGroup(' Area 1.B-2 ', { kind: 'dt' }), 'Area_1.B-2');
  assert.equal(NS.util.normTrendGroup('x'.repeat(100)).length, 64);
  assert.equal(NS.util.normKey(' [default]CTG/Temp '), '[default]ctg/temp');
  assert.equal(NS.util.shortTagName('[default]CTG/Area/Temp'), 'Temp');
});

test('normTrendGroup matches the shared gateway vectors (tests/vectors/trend-group.json)', () => {
  const { NS } = setup();
  const file = new URL('../vectors/trend-group.json', import.meta.url);
  const { vectors } = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(vectors.length >= 15);
  for (const { in: input, kind, out } of vectors) {
    assert.equal(NS.util.normTrendGroup(input, { kind }), out, `normTrendGroup(${JSON.stringify(input)}, ${kind})`);
  }
});

test('a re-attached delegate starts the handshake afresh after an earlier noResponse', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { d, sent } = setup();   // the stub context captures the mocked setTimeout
  d.attach();
  for (let i = 0; i < 3; i++) t.mock.timers.tick(5000);
  assert.equal(d.mapStateToProps().phase, 'noResponse');
  d.detach();
  const before = sent().filter((s) => s.name === 'ctg.hello').length;
  d.attach();
  assert.equal(d.mapStateToProps().phase, 'helloSent', 'not noResponse right after the remount');
  assert.equal(d.staleReason(), 'connecting');
  t.mock.timers.tick(5000);
  assert.equal(sent().filter((s) => s.name === 'ctg.hello').length, before + 2, 'fast 5 s resend cadence, not the 15 s slow retry');
  assert.equal(d.mapStateToProps().phase, 'helloSent');
  d.handleEvent('ctg.welcome', env0(1));
  assert.equal(d.mapStateToProps().phase, 'ready');
  d.detach();
});
