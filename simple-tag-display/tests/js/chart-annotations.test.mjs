// =============================================================================
// chart-annotations.test.mjs — chart annotations, plus raw patches, stable
// plot ids and the tag browser's add counts
// =============================================================================
//   - parseAnnData: this module's v1 JSON vs another tool's plain text
//   - AnnotationLayer: annotationsOnly reads (only with annotations.enabled +
//     the gateway capability), types / pens / window, items per pen, the
//     unsupported status (notice + annotate mode hidden), re-read when the
//     view leaves the covered window, optimistic save / delete + re-reads
//   - gestures: annotate click = note editor at the nearest pen, drag = range,
//     click on a flag = edit; tooltip hit-testing; canvas drawing
//   - AnnotationEditor: body rules, edit permission mirror, save / delete over
//     ChartApi.request, read-only views
//   - api.patch reduces from the raw root, stable plot ids, raw index guards,
//     tag browser counts only tags really added
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv, FILES } from './_stubs.mjs';
import { createChartApiStub } from './_chartApiStub.mjs';

async function flush(n = 40) { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const T = '[default]CTG/';

/** History route fake: data requests get a sine; annotationsOnly requests get `opts.ann(body)` per pen. */
function setup(opts = {}) {
  const env = createEnv();
  env.window.addEventListener = () => {};
  env.window.removeEventListener = () => {};
  env.window.requestAnimationFrame = (fn) => setTimeout(() => fn(Date.now()), 1);
  env.window.cancelAnimationFrame = (id) => clearTimeout(id);
  const fetches = [];
  const annBodies = [];
  env.window.fetch = (url, init) => {
    const body = JSON.parse(init.body);
    fetches.push(body);
    const reply = (o) => Promise.resolve({ status: 200, headers: { get: () => null }, text: () => Promise.resolve(JSON.stringify(o)) });
    if (body.annotationsOnly) {
      annBodies.push(body);
      const per = opts.ann ? opts.ann(body) : {};
      return reply({ v: 2, ok: true, requestId: body.requestId, serverNow: Date.now(),
        window: { start: body.start, end: body.end, mode: 'raw' },
        pens: body.pens.map((p) => Object.assign({ key: p.key, tagPath: p.tagPath, status: 'ok', t: [], v: [], anchor: null,
          annotations: [], annotationsStatus: 'ok', annotationsTruncated: false }, per[p.tagPath] || {})) });
    }
    const step = body.mode === 'raw' ? 1000 : (body.bucketMs || 5000);
    const t = [];
    for (let x = Math.ceil(body.start / step) * step; x < Math.min(body.end, Date.now()); x += step) t.push(x);
    return reply({ v: 2, ok: true, requestId: body.requestId, serverNow: Date.now(),
      window: { start: body.start, end: Math.min(body.end, Date.now()), mode: body.mode, aggregation: body.aggregation, bucketMs: body.bucketMs, bucketTime: body.bucketMs ? 'start' : null },
      pens: body.pens.map((p) => ({ key: p.key, tagPath: p.tagPath, status: 'ok', t, v: t.map((x) => 50 + Math.sin(x / 60000) * 40), anchor: null })) });
  };
  for (const f of FILES) env.load(f, '2.0.0-a0a0a001');
  const NS = env.window.__CTG, C = NS.chart;
  const raw = opts.raw || { pens: [{ tagPath: T + 'Temp' }, { tagPath: T + 'Pressure' }, { tagPath: T + 'NoHistory' }],
    timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 },
    annotations: { enabled: true, edit: { enabled: true } } };
  const tree = JSON.parse(JSON.stringify(raw));
  const writes = [];
  const sessionProps = { read: (k) => (k === 'locale' ? 'en-US' : k === 'timeZoneId' ? 'UTC' : null), subscribe: () => () => {} };
  const store = {
    name: 'chart', addressPathString: '0:0', view: { page: { sessionProps } },
    props: { read: (k) => (k in tree ? JSON.parse(JSON.stringify(tree[k])) : undefined), write: (k, v) => { writes.push({ key: k, value: J(v) }); tree[k] = v; } },
  };
  const ls = [];
  const requests = [];
  const source = {
    snap: { pens: [
      { key: 'p:0', source: 'pens', index: 0, tagPath: T + 'Temp', name: 'Temp', status: 'ok', meta: { dataType: 'Float8', engUnit: 'degF', engLow: 0, engHigh: 100 }, history: { available: true, provider: 'Core Historian' }, trendable: true },
      { key: 'p:1', source: 'pens', index: 1, tagPath: T + 'Pressure', name: 'Pressure', status: 'ok', meta: { dataType: 'Float8', engUnit: 'psi', engLow: 0, engHigh: 300 }, history: { available: true, provider: 'Core Historian' }, trendable: true },
      { key: 'p:2', source: 'pens', index: 2, tagPath: T + 'NoHistory', name: 'NoHistory', status: 'noHistory', meta: { dataType: 'Float8' }, trendable: false },
    ], trend: { group: 'default', paths: [], max: 32 }, limits: { maxPens: 32 }, trendEdit: { allowed: true },
    readScope: { runtimePensAllowed: true, roots: [] }, tagBrowser: { allowed: false, reason: 'ACTION_DISABLED' },
    annotations: opts.cap || { allowed: true, editAllowed: true, moderateAllowed: false, ownOnly: true, reason: null } },
    state: { connected: true, welcome: { user: { authenticated: true, userName: 'engineer', roles: ['Engineer'] } } },
    staleReason: () => null, values: {},
    getCreds: () => ({ url: '/data/simpletagdisplay/v2/history', token: 't', expiresAt: 4102444800000 }),
    renewToken: () => Promise.resolve(true),
    request: (name, body) => { requests.push({ name, body: J(body) }); return Promise.resolve(opts.reply ? opts.reply(name, body) : { ok: true, data: {} }); },
    on(fn) { ls.push(fn); return () => {}; }, emit(t, p) { ls.forEach((f) => f(t, p)); }, attach() {}, detach() {},
  };
  store.delegate = source;
  const mk = () => ({
    store, props: C.reduceProps(tree), delegate: { phase: 'ready', connected: true }, eventsEnabled: true,
    componentEvents: { fireComponentEvent: () => {} }, emit: (o) => ({ className: (o.classes || []).join(' '), style: {} }),
  });
  const comp = new C.CtgChart(mk());
  comp.setState = function (patch, cb) { this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch); if (cb) cb(); };
  comp.forceUpdate = () => {};
  const rerender = () => { const prev = comp.props; comp.props = mk(); comp.componentDidUpdate({ props: prev.props }); return comp.render(); };
  const setTree = (k, v) => { tree[k] = v; };
  return { env, NS, C, comp, store, tree, writes, source, fetches, annBodies, requests, rerender, setTree };
}
async function mounted(opts) {
  const s = setup(opts);
  s.comp.componentDidMount();
  await flush();
  s.comp.render();
  await settle();
  return s;
}
/** The history queue spaces requests (limits.minIntervalMs + 20 ms): wait for the queued annotation read. */
async function settle() { await flush(); await sleep(300); await flush(); }
const fakeRec = (pens) => ({ index: 0, pv: { pens: pens || [] },
  u: { over: { addEventListener() {}, removeEventListener() {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 1000, height: 300 }),
    setPointerCapture() {}, releasePointerCapture() {}, style: {}, clientWidth: 1000, appendChild() {} },
    series: [{}, { scale: 'y0' }, { scale: 'y1' }], valToPos: (v, sc) => (sc === 'y0' ? 300 - v * 3 : 300 - v), bbox: { left: 0, top: 0, width: 1000, height: 300 } } });

// ---- data parsing ---------------------------------------------------------------------------------------------------
test('parseAnnData: v1 JSON is ours (author, colour, created); anything else is text with an unknown author', async () => {
  const s = setup();
  const p = s.C.parseAnnData;
  const ours = p(JSON.stringify({ v: 1, text: '<img src=x onerror=1>', author: 'engineer', color: '#FF0000', created: 5, editedBy: 'op' }));
  assert.deepEqual(J(ours), { text: '<img src=x onerror=1>', author: 'engineer', color: '#FF0000', created: 5, editedBy: 'op', ours: true });
  assert.equal(p('{"v":1,"text":"t","color":"red;x"}').color, null, 'colour must be #RRGGBB');
  const foreign = p('pump tripped (script)');
  assert.equal(foreign.text, 'pump tripped (script)');
  assert.equal(foreign.author, null);
  assert.equal(foreign.ours, false);
  assert.equal(p('{"v":2,"author":"x"}').ours, false);
  assert.equal(p(null).text, '');
});

// ---- AnnotationLayer reads -------------------------------------------------------------------------------------------
test('reads: one annotationsOnly request for the pens with history, types from props; items per pen', async () => {
  const now = Date.now();
  const s = await mounted({ ann: () => ({
    [T + 'Temp']: { annotations: [
      { id: 'a1', type: 'note', start: now - 60000, end: null, data: JSON.stringify({ v: 1, text: 'pump tripped', author: 'engineer' }) },
      { id: 'a2', type: 'range', start: now - 600000, end: now - 300000, data: 'maintenance window' }] },
  }) });
  assert.equal(s.annBodies.length, 1, 'after the first full load');
  const b = s.annBodies[0];
  assert.equal(b.annotationsOnly, true);
  assert.deepEqual(J(b.annotations), { types: ['note', 'range'] });
  assert.deepEqual(J(b.pens.map((p) => p.tagPath)), [T + 'Temp', T + 'Pressure'], 'the noHistory pen is not asked for');
  assert.ok(b.pens.every((p) => /^a\d+$/.test(p.key)), 'short request keys (the gateway caps pen keys at 200 chars)');
  assert.ok(b.end - b.start >= 15 * 60000 * 1.5, 'the view plus half a view before it');
  const e = s.comp.engine;
  const items = e.annotations.list(['p:0', 'p:1'], now - 3600000, now);
  assert.equal(items.length, 2);
  const note = items.find((a) => a.id === 'a1');
  assert.equal(note.text, 'pump tripped');
  assert.equal(note.author, 'engineer');
  assert.equal(note.penKey, 'p:0');
  const range = items.find((a) => a.id === 'a2');
  assert.equal(range.type, 'range');
  assert.equal(range.author, null, 'plain text from another tool: author unknown');
  assert.equal(e.annotations.list(['p:1'], now - 3600000, now).length, 0, 'per pen');
  assert.equal(e.annotations.list(['p:0'], now - 30000, now).length, 0, 'outside [min, max]');
  const m = e.model();
  assert.equal(m.annotations.count, 2);
  assert.equal(m.annotations.unsupported, false);
  s.comp.componentWillUnmount();
});

test('reads: nothing is asked without annotations.enabled or without the gateway capability; switching on reads', async () => {
  const off = await mounted({ raw: { pens: [{ tagPath: T + 'Temp' }], timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } } });
  assert.equal(off.annBodies.length, 0, 'annotations.enabled false (default)');
  off.setTree('annotations', { enabled: true });
  off.rerender();
  await settle();
  assert.equal(off.annBodies.length, 1, 'enabled at runtime -> read');
  off.comp.componentWillUnmount();
  const denied = await mounted({ cap: { allowed: false, editAllowed: false, reason: 'ACTION_DISABLED' } });
  assert.equal(denied.annBodies.length, 0, 'the gateway says not allowed');
  denied.comp.componentWillUnmount();
  const types = await mounted({ raw: { pens: [{ tagPath: T + 'Temp' }], timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 },
    annotations: { enabled: true, types: { note: false, range: true } } } });
  assert.deepEqual(J(types.annBodies[0].annotations.types), ['range']);
  types.comp.componentWillUnmount();
});

test('unsupported historian: notice, annotate mode hidden, no More toggle', async () => {
  const s = await mounted({ ann: () => ({ [T + 'Temp']: { annotationsStatus: 'unsupported' }, [T + 'Pressure']: { annotationsStatus: 'unsupported' } }) });
  const m = s.comp.engine.model();
  assert.equal(m.annotations.unsupported, true);
  assert.ok(m.notices.some((n) => n.code === 'annotationsUnsupported'));
  s.comp._model = m;
  const p = s.comp.props.props;
  const caps = s.comp.api.capabilities();
  const more = s.comp._moreItems(m, p, caps, false, {});
  assert.ok(!more.some((i) => i.id === 'annotations'));
  s.comp.componentWillUnmount();
  // one pen supported -> not "unsupported"
  const s2 = await mounted({ ann: () => ({ [T + 'Temp']: { annotationsStatus: 'unsupported' } }) });
  assert.equal(s2.comp.engine.model().annotations.unsupported, false);
  const m2 = s2.comp.engine.model();
  assert.ok(s2.comp._moreItems(m2, s2.comp.props.props, s2.comp.api.capabilities(), false, {}).some((i) => i.id === 'annotations'));
  s2.comp.componentWillUnmount();
});

test('reads: a viewport outside the covered window asks again (debounced); inside it does not', async () => {
  const s = await mounted();
  const e = s.comp.engine;
  const L = e.annotations;
  const vp = e.viewport.get();
  e.viewport.set({ min: vp.min + 60000, max: vp.max - 60000 });            // zoom in: still covered
  assert.equal(L.covers(), true);
  assert.equal(L._timer, null, 'covered: no read scheduled by the viewport');
  await sleep(1200); await flush();
  e.viewport.set({ min: vp.min - 3 * 3600000, max: vp.max - 3 * 3600000 });  // pan 3 h back: outside
  assert.equal(L.covers(), false);
  assert.notEqual(L._timer, null, 'a read is scheduled');
  await sleep(1500); await flush();
  const v2 = e.viewport.get();
  const last = s.annBodies[s.annBodies.length - 1];
  assert.ok(last.start <= v2.min && last.end >= v2.max, 'the read covers the new view');
  assert.equal(L.covers(), true);
  s.comp.componentWillUnmount();
});

test('save / delete: optimistic entry (pending) and hidden replaced entry until a re-read confirms', async () => {
  const now = Date.now();
  let stored = [{ id: 'old', type: 'note', start: now - 120000, end: null, data: JSON.stringify({ v: 1, text: 'v1', author: 'engineer' }) }];
  const s = await mounted({ ann: () => ({ [T + 'Temp']: { annotations: stored } }) });
  const L = s.comp.engine.annotations;
  const ANN = s.C.ANN;
  const saved = ANN.saveRequeryMs;
  ANN.saveRequeryMs = [30, 260];
  try {
    assert.equal(L.list(['p:0'], now - 3600000, now).length, 1);
    // edit: new id 'new' replaces 'old'
    L.saved({ id: 'new', penKey: 'p:0', tagPath: T + 'Temp', type: 'note', start: now - 60000, end: null, text: 'v2', author: 'engineer' }, 'old');
    let items = L.list(['p:0'], now - 3600000, now);
    assert.deepEqual(J(items.map((a) => [a.id, !!a.pending])), [['new', true]], 'old hidden at once, new drawn pending');
    stored = [{ id: 'new', type: 'note', start: now - 60000, end: null, data: JSON.stringify({ v: 1, text: 'v2', author: 'engineer' }) }];
    await sleep(300); await flush();
    items = L.list(['p:0'], now - 3600000, now);
    assert.deepEqual(J(items.map((a) => [a.id, !!a.pending, a.text])), [['new', false, 'v2']], 'confirmed by the re-read');
    assert.equal(L.pending.length, 0);
    assert.deepEqual(J(Object.keys(L.hidden)), [], 'hidden forgotten once the read no longer returns it');
    // delete
    L.saved(null, 'new');
    assert.equal(L.list(['p:0'], now - 3600000, now).length, 0, 'deleted: hidden at once');
    stored = [];
    await sleep(400); await flush();
    assert.equal(L.list(['p:0'], now - 3600000, now).length, 0);
  } finally { ANN.saveRequeryMs = saved; }
  s.comp.componentWillUnmount();
});

// ---- gestures, hit-testing, drawing ---------------------------------------------------------------------------------
test('annotate mode: click = note editor at the nearest pen of the plot; drag = range; click on a flag = edit', async () => {
  const now = Date.now();
  const s = await mounted({ raw: { pens: [{ tagPath: T + 'Temp' }, { tagPath: T + 'Pressure' }],
    timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 }, annotations: { enabled: true, edit: { enabled: true } },
    interaction: { mode: 'annotate' } },
  ann: () => ({ [T + 'Temp']: { annotations: [{ id: 'n1', type: 'note', start: now - 450000, end: null, data: 'hello' }] } }) });
  const comp = s.comp, ix = comp.ix;
  const opened = [];
  comp.openPanel = (name, args) => { opened.push({ name, args }); return true; };
  const vms = comp._pens.slice(0, 2);
  const rec = fakeRec(vms);
  ix.recs.set(rec, { offs: [], box: null, rows: new Map() });
  ix.preview = { min: now - 900000, max: now };                    // a fixed view for the geometry
  const ev = (id, x, y) => ({ pointerType: 'mouse', button: 0, pointerId: id, clientX: x, clientY: y, isPrimary: true, preventDefault() {} });
  // click far from the flag at x=500 (t = now - 450 s is at x=500): the nearest pen is chosen from the plot's lines
  ix._down(rec, ev(1, 800, 150)); ix._up(rec, ev(1, 800, 150));
  assert.equal(opened.length, 1);
  assert.equal(opened[0].name, 'annotation');
  const a1 = opened[0].args;
  assert.equal(a1.mode, 'add');
  assert.equal(a1.type, 'note');
  assert.ok(Math.abs(a1.start - (now - 180000)) < 2000, 'time under the pointer');
  assert.deepEqual(J(a1.penKeys), ['p:0', 'p:1'], 'only the pens of that plot with history');
  assert.ok(['p:0', 'p:1'].includes(a1.penKey));
  assert.ok(a1.anchorRect && a1.anchorRect.left === 800);
  // drag = range
  ix._down(rec, ev(2, 100, 150));
  ix._move(rec, ev(2, 300, 150)); ix._frame();
  assert.ok(ix.temp && ix.temp.annRange, 'the range is drawn while dragging');
  ix._up(rec, ev(2, 300, 150));
  const a2 = opened[1].args;
  assert.equal(a2.type, 'range');
  assert.ok(a2.end > a2.start);
  assert.ok(Math.abs(a2.start - (now - 810000)) < 2000 && Math.abs(a2.end - (now - 630000)) < 2000);
  // click on the note's flag (top of the plot, just right of its line) = edit that note
  ix._down(rec, ev(3, 503, 5)); ix._up(rec, ev(3, 503, 5));
  const a3 = opened[2].args;
  assert.equal(a3.mode, 'edit');
  assert.equal(a3.item.id, 'n1');
  assert.deepEqual(J(a3.penKeys), ['p:0']);
  // hit-testing: flag area only (outside annotate mode the line itself is not a hit)
  assert.equal(ix._hitAnnotation(rec, 505, 8, 1000, false, false).id, 'n1');
  assert.equal(ix._hitAnnotation(rec, 505, 150, 1000, false, false), null);
  assert.equal(ix._hitAnnotation(rec, 501, 150, 1000, false, true).id, 'n1', 'annotate mode: the line too');
  // hidden via the More toggle: nothing to hit or draw
  comp._toggleAnnotations();
  assert.equal(comp.annotationsShown(), false);
  assert.equal(ix._hitAnnotation(rec, 505, 8, 1000, false, false), null);
  comp.componentWillUnmount();
});

test('drawing: range band + strip before the traces, note line + flag last; pending dashed', async () => {
  const now = Date.now();
  const s = await mounted({ raw: { pens: [{ tagPath: T + 'Temp' }], timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 },
    annotations: { enabled: true, color: '#00AA00' } },
  ann: () => ({ [T + 'Temp']: { annotations: [
    { id: 'r', type: 'range', start: now - 600000, end: now - 300000, data: '{"v":1,"text":"r","color":"#112233"}' },
    { id: 'n', type: 'note', start: now - 120000, end: null, data: 'n' }] } }) });
  const comp = s.comp;
  comp.engine.annotations.saved({ id: 'p', penKey: 'p:0', tagPath: T + 'Temp', type: 'note', start: now - 60000, text: 'x' }, null);
  const calls = [];
  const ctx = new Proxy({}, { get: (o, k) => (k in o ? o[k] : (...a) => { calls.push([k, ...a]); }), set: (o, k, v) => { calls.push(['set:' + String(k), v]); o[k] = v; return true; } });
  ctx.measureText = () => ({ width: 10 });
  const rec = fakeRec(comp._pens.slice(0, 1));
  rec.u.valToPos = (t) => (t - (now - 900000)) / 900000 * 1000;
  comp.ix.preview = { min: now - 900000, max: now };
  comp.ix.draw(rec.u, rec, ctx);
  const fills = calls.filter((c) => c[0] === 'set:fillStyle').map((c) => c[1]);
  assert.ok(fills.some((f) => /17,\s*34,\s*51|#112233/i.test(String(f))), 'the entry\'s own colour for the range: ' + fills.join(' '));
  assert.ok(fills.some((f) => /0,\s*170,\s*0|#00AA00/i.test(String(f))), 'annotations.color for entries without one');
  assert.ok(calls.some((c) => c[0] === 'fillRect'), 'band');
  assert.ok(calls.some((c) => c[0] === 'setLineDash' && Array.isArray(c[1]) && c[1].length === 2), 'pending note dashed');
  assert.ok(calls.filter((c) => c[0] === 'closePath').length >= 2, 'two flags (confirmed + pending note)');
  comp.componentWillUnmount();
});

test('the annotate mode button needs the edit capability and the editor panel', async () => {
  const s = await mounted();
  const modesOf = (r) => byAttr(r, 'role', 'radio').map((n) => n.props['data-ctg-mode']).filter(Boolean);
  const r0 = s.comp.render();
  assert.ok(modesOf(r0).includes('annotate'));
  s.source.snap = Object.assign({}, s.source.snap, { annotations: { allowed: true, editAllowed: false, reason: 'FORBIDDEN_ROLE' } });
  s.source.emit('pens');
  await flush();
  assert.ok(!modesOf(s.comp.render()).includes('annotate'), 'viewer: no annotate mode');
  s.comp.componentWillUnmount();
});

// ---- AnnotationEditor -----------------------------------------------------------------------------------------------
function editorStub(fixture = {}) {
  const s = createChartApiStub(Object.assign({ props: { pens: [{ tagPath: T + 'Temp' }, { tagPath: T + 'Pressure' }],
    annotations: { enabled: true, edit: { enabled: true } } } }, fixture));
  const Comp = s.env.window.PerspectiveClient.Component;
  Comp.prototype.setState = function (patch, cb) { this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch); if (cb) cb(); };
  Comp.prototype.forceUpdate = function () {};
  return Object.assign(s, { P: s.NS.chartPanels });
}
/** Component nodes (error boundaries, guarded parts, the dialog) are rendered in place, like React would. */
function expand(node) {
  while (node && typeof node === 'object' && typeof node.type === 'function' && node.type.prototype && node.type.prototype.render
    && !(node.props && node.props.footer)) {
    const kids = node.children || [];
    const props = Object.assign({}, node.props, { children: kids.length <= 1 ? kids[0] : kids });
    const inst = new node.type(props);
    inst.props = props;
    if (!inst.state) inst.state = {};
    node = inst.render();
  }
  return node;
}
function find(node, pred, out = []) {
  node = expand(node);
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; }
  if (node.props && pred(node)) out.push(node);
  if (node.children) find(node.children, pred, out);
  if (node.props && node.props.children) find(node.props.children, pred, out);
  if (node.props && node.props.footer) find(node.props.footer, pred, out);
  return out;
}
const byAttr = (tree, k, v) => find(tree, (n) => n.props[k] === v);

test('editor pure rules: input <-> epoch in the chart zone, save body validation, edit permission mirror', () => {
  const s = editorStub();
  const P = s.P;
  const ms = Date.UTC(2026, 9, 9, 17, 5, 7);
  assert.equal(P.annInputValue(ms, 'America/Chicago'), '2026-10-09T12:05:07');
  assert.equal(P.annParseInput('2026-10-09T12:05:07', 'America/Chicago'), ms);
  assert.equal(P.annParseInput('2026-10-09T12:05', 'America/Chicago'), ms - 7000, 'seconds optional');
  assert.ok(Number.isNaN(P.annParseInput('yesterday', 'UTC')));
  const ok = P.annSaveBody({ type: 'range', penTagPath: T + 'Temp', start: '2026-10-09T12:00:00', end: '2026-10-09T13:00:00', text: '  maint  ', color: '#e8743b' }, null, 'UTC');
  assert.deepEqual(J(ok.body), { tagPath: T + 'Temp', type: 'range', start: Date.UTC(2026, 9, 9, 12), end: Date.UTC(2026, 9, 9, 13), text: 'maint', color: '#e8743b' });
  const bad = P.annSaveBody({ type: 'range', penTagPath: '', start: 'x', end: '2026-10-09T11:00:00', text: ' ', color: '' }, null, 'UTC');
  assert.deepEqual(J(Object.keys(bad.error).sort()), ['pen', 'start', 'text']);
  const plain = P.annSaveBody({ type: 'note', penTagPath: 'a', start: '2026-10-09T12:00:00', text: 'x', color: '' }, null, 'UTC');
  assert.equal(plain.body.color, '', 'no colour chosen = the default (live run found #000000 here)');
  assert.equal(P.annColorOf(null), '');
  const order = P.annSaveBody({ type: 'range', penTagPath: 'a', start: '2026-10-09T12:00:00', end: '2026-10-09T11:00:00', text: 'x' }, null, 'UTC');
  assert.equal(order.error.end, 'an.rangeOrder');
  const edit = P.annSaveBody({ type: 'note', penTagPath: 'a', start: '2026-10-09T12:00:00', text: 'x' }, { id: 'u1', start: 5 }, 'UTC');
  assert.equal(edit.body.annotationId, 'u1');
  assert.equal(edit.body.id, undefined, '`id` is the envelope request id');
  assert.equal(edit.body.oldStart, 5);
  const caps = { enabled: true, designMode: false, user: 'operator', annotations: { editAllowed: true, moderateAllowed: false } };
  assert.equal(P.annCanEdit(caps, null, true), true, 'add');
  assert.equal(P.annCanEdit(caps, { id: 'x', author: 'operator' }, true), true, 'own');
  assert.equal(P.annCanEdit(caps, { id: 'x', author: 'engineer' }, true), false, 'others\' with ownOnly');
  assert.equal(P.annCanEdit(caps, { id: 'x', author: 'engineer' }, false), true, 'ownOnly off');
  assert.equal(P.annCanEdit(Object.assign({}, caps, { annotations: { editAllowed: true, moderateAllowed: true } }), { id: 'x', author: null }, true), true, 'moderator');
  assert.equal(P.annCanEdit(caps, { id: null, author: 'operator' }, false), false, 'no storage id');
  assert.equal(P.annCanEdit(Object.assign({}, caps, { designMode: true }), null, true), false);
  assert.equal(P.annCanEdit(Object.assign({}, caps, { enabled: false }), null, true), false);
});

test('editor: save -> chart.annotationSave with the body, onSaved gets the entry; errors stay in the dialog', async () => {
  const replies = [{ ok: false, error: { code: 'RATE_LIMITED', message: '' } }, { ok: true, data: { id: 'new-id', tagPath: T + 'Temp' } }];
  const s = editorStub({ capabilities: { annotations: { allowed: true, editAllowed: true, moderateAllowed: false, reason: null } }, user: 'engineer',
    handlers: { 'chart.annotationSave': () => replies.shift() } });
  const keys = s.api.pens().map((p) => p.key);
  let closed = 0;
  const savedCalls = [];
  const args = { mode: 'add', type: 'note', start: Date.UTC(2026, 9, 8, 11, 0, 0), penKey: keys[0], penKeys: keys,
    onSaved: (r) => savedCalls.push(r), anchorRect: { left: 1, top: 1, right: 1, bottom: 1, width: 0, height: 0 } };
  const ed = new s.P.AnnotationEditor({ api: s.api, args, close: () => { closed++; } });
  ed.componentDidMount();
  ed.setState({ text: 'Pump tripped', color: '#19a979' });
  ed._save();
  await flush();
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].name, 'chart.annotationSave');
  assert.deepEqual(s.requests[0].body, { tagPath: T + 'Temp', type: 'note', start: Date.UTC(2026, 9, 8, 11), text: 'Pump tripped', color: '#19a979' });
  assert.equal(closed, 0);
  assert.match(ed.state.error, /Too many requests|try again/i, 'refusal shown in the dialog');
  ed._save();
  await flush();
  assert.equal(closed, 1);
  assert.equal(savedCalls.length, 1);
  assert.equal(savedCalls[0].entry.id, 'new-id');
  assert.equal(savedCalls[0].entry.author, 'engineer');
  assert.equal(savedCalls[0].replacedId, null);
});

test('editor: edit + delete with confirmation; another author\'s note is read-only (ownOnly)', async () => {
  const s = editorStub({ capabilities: { annotations: { allowed: true, editAllowed: true, moderateAllowed: false, reason: null } }, user: 'engineer',
    handlers: { 'chart.annotationDelete': () => ({ ok: true, data: { deleted: 1 } }) } });
  const key = s.api.pens()[0].key;
  const item = { id: 'n1', penKey: key, tagPath: T + 'Temp', type: 'note', start: Date.UTC(2026, 9, 8, 11), text: 'mine', author: 'engineer' };
  const deleted = [];
  let closed = 0;
  const ed = new s.P.AnnotationEditor({ api: s.api, args: { mode: 'edit', item, penKeys: [key], penKey: key, onDeleted: (r) => deleted.push(r) }, close: () => { closed++; } });
  ed.componentDidMount();
  let tree = ed.render();
  assert.equal(byAttr(tree, 'data-ctg-act', 'annotation-save').length, 1);
  byAttr(tree, 'data-ctg-act', 'annotation-delete')[0].props.onClick();
  tree = ed.render();
  byAttr(tree, 'data-ctg-act', 'annotation-delete-confirm')[0].props.onClick();
  await flush();
  assert.deepEqual(J(s.requests.map((r) => [r.name, r.body])), [['chart.annotationDelete', { tagPath: T + 'Temp', annotationId: 'n1', start: item.start }]]);
  assert.deepEqual(J(deleted), [{ id: 'n1' }]);
  assert.equal(closed, 1);
  // someone else's note: no Save / Delete, the reason in the dialog
  const ro = new s.P.AnnotationEditor({ api: s.api, args: { mode: 'edit', item: Object.assign({}, item, { author: 'operator' }), penKeys: [key], penKey: key }, close: () => {} });
  const rt = ro.render();
  assert.equal(byAttr(rt, 'data-ctg-act', 'annotation-save').length, 0);
  assert.equal(byAttr(rt, 'data-ctg-act', 'annotation-delete').length, 0);
  assert.equal(byAttr(rt, 'data-ctg', 'annotation-readonly').length, 1);
});

test('the annotation panel is registered without a toolbar button and renders nothing in design mode', () => {
  const s = editorStub({ designMode: true });
  const def = s.C.panels.get('annotation');
  assert.ok(def);
  assert.equal(def.dock, 'none');
  assert.equal(def.button, undefined);
  assert.equal(def.render(s.api, {}, () => {}), null);
});

// ---- raw patches, plot ids, tag browser add counts -------------------------------------------------------------------
test('api.patch maps raw positions through a reduced root computed from the raw value itself', async () => {
  const s = setup({ raw: { pens: [{ tagPath: T + 'Temp' }], timeRange: { realtime: { value: 15, unit: 'minutes' }, refreshRate: 0 } } });
  s.comp.componentDidMount();
  await flush();
  // another writer inserted a junk entry and a pen in front: the chart's last reduced props (rendered) still
  // show the old array, the store already has the new one
  s.tree.pens = ['junk', { tagPath: T + 'Pressure' }, { tagPath: T + 'Temp' }];
  let seen = null;
  s.comp.api.patch('pens', (raw, reduced) => { seen = reduced.map((p) => [p.tagPath, p.index]); raw[reduced[1].index].color = '#123456'; return raw; });
  assert.deepEqual(J(seen), [[T + 'Pressure', 1], [T + 'Temp', 2]], 'reduced from the raw value, with its raw positions');
  assert.equal(s.writes.pop().value[2].color, '#123456', 'the edit lands on Temp, not on the junk entry');
  const r = s.C.patchRoot('pens', [{ tagPath: ' a ' }], (raw, red) => { assert.equal(red[0].tagPath, 'a'); return raw; });
  assert.equal(r.ok, true);
  s.comp.componentWillUnmount();
});

test('plots carry a stable ctgId from creation; the editor follows that exact plot', () => {
  const s = editorStub();
  const P = s.P, C = s.C;
  const ids = { first: 'plA', added: 'plB' };
  const op = P.addPlotOp(ids);
  const shown = op([], { raw: false, reduced: [] });
  const written = op([], { raw: true, reduced: [] });
  assert.deepEqual(J(shown.map(P.plotIdOf)), ['plA', 'plB'], 'the implicit plot materialised with its own id');
  assert.deepEqual(J(written.map(P.plotIdOf)), ['plA', 'plB'], 'the same ids in both applications');
  const reduced = C.reduceProps({ plots: [{ relativeWeight: 1, ctgId: 'plA' }, { relativeWeight: 1, ctgId: 'plB' }, { relativeWeight: 2 }] }).plots;
  assert.equal(reduced[1].ctgId, 'plB', 'the reducer passes the id through');
  assert.equal(C.reduceProps({ plots: [{ ctgId: '<script>' }] }).plots[0].ctgId, undefined, 'only safe ids');
  const ref = P.plotRefOf(reduced, 1);
  assert.equal(ref.id, 'plB');
  // another writer removed the first plot and changed plot B in place: still found (by id), not by position
  const after = C.reduceProps({ plots: [{ relativeWeight: 3, ctgId: 'plB' }, { relativeWeight: 2 }] }).plots;
  assert.equal(P.resolvePlot(after, ref), 0);
  assert.equal(P.resolvePlot(C.reduceProps({ plots: [{ relativeWeight: 2 }] }).plots, ref), -1, 'gone -> -1 (never another plot)');
  // plots without ids keep the position / JSON rule
  const legacy = P.plotRefOf([{ relativeWeight: 1 }, { relativeWeight: 2 }], 1);
  assert.equal(legacy.id, null);
  assert.equal(P.resolvePlot([{ relativeWeight: 1 }, { relativeWeight: 2 }], legacy), 1);
});

test('plot / marker operations never write past the end of a shorter raw list', () => {
  const s = editorStub();
  const P = s.P, C = s.C;
  const reduced = C.reduceProps({ plots: [{ relativeWeight: 1 }, { relativeWeight: 1, markers: [{ type: 'line', value: 1 }] }] }).plots;
  const ref = P.plotRefOf(reduced, 1);
  const ctx = { raw: true, reduced };
  const shortRaw = [{ relativeWeight: 1 }];                                // a binding rewrote the raw list meanwhile
  assert.deepEqual(P.plotFieldOp(ref, ['relativeWeight'], 5)(shortRaw, ctx), shortRaw, 'no hole / new plot');
  assert.deepEqual(P.addMarkerOp(ref, '')(shortRaw, ctx), shortRaw);
  const noMarkers = [{ relativeWeight: 1 }, { relativeWeight: 1 }];
  assert.deepEqual(P.plotFieldOp(ref, ['markers', 0, 'value'], 9)(noMarkers, ctx), noMarkers, 'marker gone from the raw plot');
  assert.deepEqual(P.removeMarkerOp(ref, 0)(noMarkers, ctx), noMarkers);
  const ok = P.plotFieldOp(ref, ['relativeWeight'], 5)([{ relativeWeight: 1 }, { relativeWeight: 1, markers: [{ type: 'line', value: 1 }] }], ctx);
  assert.equal(ok[1].relativeWeight, 5, 'the normal case still edits');
});

test('the tag browser fires add / counts only the tags really added; the others are duplicates', async () => {
  const s = editorStub({ props: { pens: [{ tagPath: T + 'Temp' }], tagBrowser: { enabled: true, addTo: 'pens' } } });
  const P = s.P;
  const report = { added: [], duplicates: [] };
  const next = P.addPensOp([T + 'Temp', T + 'Pressure', T + 'pressure'], report)([{ tagPath: T + 'Temp' }]);
  assert.deepEqual(J(next.map((p) => p.tagPath)), [T + 'Temp', T + 'Pressure']);
  assert.deepEqual(J(report), { added: [T + 'Pressure'], duplicates: [T + 'Temp', T + 'pressure'] });
});
