// =============================================================================
// search-panels.test.mjs — tag browser "Search all folders"
// =============================================================================
// ctg-chart-panels.js SECTION 3b (TagSearchModel) and the TagBrowser search
// mode, against the ChartApi stub:
//   - which texts are searched (2+ characters, or 1 with a wildcard)
//   - the model: stale replies dropped, superseded / cancelled answers, paging,
//     failures, the status line for every `search.stopped` reason
//   - the panel: the switch, the debounced request {path:'', search, limit},
//     results as listbox options with their folder, selection shared with the
//     tree (kept after the switch goes off), Add selected, "Load more…" via the
//     opaque continuation, Cancel ({cancelSearch:true}), one retry after
//     RATE_LIMITED / BUSY, Escape, identity change and unmount
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createChartApiStub } from './_chartApiStub.mjs';

const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const deq = (a, b, m) => assert.deepEqual(J(a), J(b), m);
const T = '[default]CTG/';

function stub(fixture) {
  const s = createChartApiStub(fixture);
  const Comp = s.env.window.PerspectiveClient.Component;
  Comp.prototype.setState = function (patch, cb) {
    this.state = Object.assign({}, this.state, typeof patch === 'function' ? patch(this.state) : patch);
    if (cb) cb();
  };
  Comp.prototype.forceUpdate = function () {};
  return Object.assign(s, { P: s.NS.chartPanels });
}
function full(node) {
  if (node == null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(full);
  if (typeof node.type === 'function') {
    const kids = node.children || [];
    const props = Object.assign({}, node.props, kids.length ? { children: kids.length === 1 ? kids[0] : kids } : {});
    if (node.type.prototype && node.type.prototype.render) {
      const inst = new node.type(props);
      inst.props = props;
      if (!inst.state) inst.state = {};
      return full(inst.render());
    }
    return full(node.type(props));
  }
  const out = { type: node.type, props: Object.assign({}, node.props), children: full(node.children || []) };
  if (node.props && node.props.children !== undefined) out.props.children = full(node.props.children);
  return out;
}
function find(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach((n) => find(n, pred, out)); return out; }
  if (node.props && pred(node)) out.push(node);
  if (node.children) find(node.children, pred, out);
  if (node.props && node.props.children) find(node.props.children, pred, out);
  return out;
}
const byAttr = (tree, k, v) => find(tree, (n) => n.props[k] === v);
const text = (n) => (n == null || n === false ? '' : typeof n === 'string' || typeof n === 'number' ? String(n) : Array.isArray(n) ? n.map(text).join('')
  : (n.children ? text(n.children) : '') + (n.props && n.props.children ? text(n.props.children) : ''));
const ev = (extra = {}) => Object.assign({ preventDefault() {}, stopPropagation() {}, target: {},
  currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20 }), querySelector: () => null } }, extra);

const HIT = (name, folder, extra = {}) => Object.assign({ name, path: folder + '/' + name, type: 'AtomicTag', dataType: 'Float8',
  hasChildren: false, trendable: true, folder }, extra);
const SEARCH_OK = (rows, extra = {}) => ({ ok: true, data: Object.assign({ path: '', totalAvailable: rows.length, continuation: null,
  results: rows, search: { complete: true, stopped: null, matches: rows.length, folders: 3, nodes: 20, denied: 0, failed: 0,
    elapsedMs: 40, maxResults: 1000, timeBudgetMs: 5000, wildcard: false } }, extra) });

/** A tag browser with a search handler; `searches` collects the search request bodies. */
function browser({ props, caps, onSearch, onCancel } = {}) {
  const searches = [];
  const cancels = [];
  const s = stub({
    props: Object.assign({ tagBrowser: { enabled: true, addTo: 'pens' }, pens: [] }, props || {}),
    penInfos: [],
    capabilities: caps || { readScope: { runtimePensAllowed: true, roots: ['[default]'] } },   // the same object: tests mutate it
    handlers: {
      'chart.browse': (b) => {
        if (b.cancelSearch) { cancels.push(b); return onCancel ? onCancel(b) : { ok: true, data: { cancelled: true } }; }
        if (b.search !== undefined) { searches.push(b); return onSearch(b, searches.length); }
        return { ok: true, data: { path: b.path || '', continuation: null, results: [
          { name: 'CTG', path: '[default]CTG', type: 'Folder', dataType: null, hasChildren: true, trendable: false }] } };
      },
    },
  });
  const tb = new s.P.TagBrowser({ api: s.api, args: {}, close: () => {} });
  tb.componentDidMount();
  return Object.assign(s, { tb, searches, cancels, view: () => full(tb.render()) });
}
const field = (v) => byAttr(v, 'data-ctg-field', 'browser-filter')[0];
const toggle = (v) => byAttr(v, 'data-ctg-act', 'search-all')[0];
const type = (s, value) => field(s.view()).props.onChange(ev({ target: { value } }));
const options = (v) => byAttr(v, 'role', 'option');
const status = (v) => byAttr(v, 'data-ctg', 'browser-search-status')[0];
async function searchFor(s, value) {
  toggle(s.view()).props.onChange(ev({ target: { checked: true } }));
  type(s, value);
  field(s.view()).props.onKeyDown(ev({ key: 'Enter' }));   // Enter searches at once (no debounce)
  await flush();
}

// ---- text rule + model -------------------------------------------------------------------------------------------------
test('searchable: 2+ literal characters, or 1 with a wildcard; at most 64', () => {
  const { P } = stub({});
  const ok = P.TagBrowser.searchable;
  for (const x of ['te', ' te ', 'p*', '?1', 'Pump 101', 'a'.repeat(64)]) assert.equal(ok(x), true, x);
  for (const x of ['', ' ', 't', '*', '**?', '* ?', 'a'.repeat(65), null, undefined]) assert.equal(ok(x), false, String(x));
});

test('model: stale replies dropped, superseded ignored, cancelled answered, paging appends, failures keep rows', () => {
  const { P } = stub({});
  const m = new P.TagBrowser.SearchModel();
  const s1 = m.start('temp');
  assert.equal(m.status, 'running');
  const s2 = m.start('tempsp');
  assert.equal(m.apply(s1, SEARCH_OK([HIT('Temp', '[default]A')]).data), false, 'stale: an older search');
  assert.equal(m.apply(s2, { results: [], search: { stopped: 'superseded' } }), false, 'superseded: a newer one answers');
  assert.equal(m.status, 'running');
  assert.equal(m.apply(s2, SEARCH_OK([HIT('TempSP', '[default]A'), HIT('TempSP', '[default]A'), { name: 'x' }], { totalAvailable: 3, continuation: 'c1' }).data), true);
  deq(m.keys, ['[default]a/tempsp'], 'de-duplicated by normKey; rows without a path ignored');
  const hit = m.get('[default]a/tempsp');
  deq([hit.type, hit.hasChildren, hit.trendable, hit.folder, hit.dataType], ['AtomicTag', false, true, '[default]A', 'Float8']);
  assert.equal(m.continuation, 'c1');
  assert.equal(m.apply(m.seq, SEARCH_OK([HIT('TempPV', '[default]B')]).data, true), true);
  deq(m.keys, ['[default]a/tempsp', '[default]b/temppv'], 'Load more appends');
  assert.equal(m.continuation, null);
  assert.equal(m.fail(m.seq, { code: 'TIMEOUT' }, true), true);
  assert.equal(m.status, 'done', 'a failed Load more keeps the results');
  assert.match(m.statusLine().text, /failed/);
  const s3 = m.start('x1');
  assert.equal(m.cancel(), true);
  assert.equal(m.status, 'cancelled');
  assert.equal(m.apply(s3, SEARCH_OK([HIT('X1', '[default]A')]).data), false, 'a cancelled search\'s late reply is stale');
  assert.equal(m.cancel(), false, 'nothing running');
  const s4 = m.start('x2');
  assert.equal(m.apply(s4, { results: [], search: { stopped: 'cancelled' } }), true);
  assert.equal(m.status, 'cancelled', 'cancelled on the gateway (another tab of the panel)');
  const s5 = m.start('x3');
  m.fail(s5, { code: 'BUSY' });
  assert.equal(m.status, 'error');
  deq(m.statusLine().act, 'retry');
});

test('model: the status line names every stop reason', () => {
  const { P } = stub({});
  const m = new P.TagBrowser.SearchModel();
  const line = (search, total = 7) => { const q = m.start('te'); m.apply(q, { results: [], totalAvailable: total, search }); return m.statusLine().text; };
  assert.match(line({ complete: true, stopped: null }), /7 matching tags/);
  assert.match(line({ complete: true, stopped: null }, 1), /1 matching tag\./);
  assert.match(line({ complete: true, stopped: null }, 0), /No tags match/);
  assert.match(line({ complete: false, stopped: 'results' }, 1000), /first 1000 matches/);
  assert.match(line({ complete: false, stopped: 'time', elapsedMs: 5012 }), /^7 matching tags\. The search stopped after 5 s\./);
  assert.match(line({ complete: false, stopped: 'nodes', folders: 812 }), /after 812 folders/);
  assert.match(line({ complete: false, stopped: 'folders', folders: 5000 }), /after 5000 folders/);
  assert.match(line({ complete: false, stopped: 'depth' }), /^7 matching tags\. Very deep folders were not searched\.$/);
  assert.match(line({ complete: false, stopped: 'depth' }, 1), /^1 matching tag\. Very deep/, 'singular');
  assert.match(line({ complete: false, stopped: 'errors' }), /could not be searched/);
  assert.match(line({ complete: false, stopped: 'time', elapsedMs: 5000 }, 0), /^No tags match\. The search stopped after 5 s\. Narrow/,
    'an incomplete empty search says why it stopped');
  m.start('te');
  deq([m.statusLine().act, m.statusLine().text], ['cancel', 'Searching all folders…']);
});

// ---- panel ---------------------------------------------------------------------------------------------------------------
test('panel: the switch turns the field into a search of every folder; results are options with their folder', async () => {
  const s = browser({ onSearch: () => SEARCH_OK([HIT('Speed', '[default]Area1/Pump101'), HIT('Label', '[default]Area2', { dataType: 'String', trendable: false })]) });
  await flush();
  let v = s.view();
  assert.ok(byAttr(v, 'data-ctg', 'browser-tree')[0], 'tree mode first');
  assert.equal(toggle(v).props.checked, false);
  toggle(v).props.onChange(ev({ target: { checked: true } }));
  v = s.view();
  assert.equal(field(v).props.placeholder, 'Search all tags');
  assert.ok(!byAttr(v, 'data-ctg', 'browser-tree')[0], 'the tree is replaced');
  type(s, 'p');
  await sleep(520);
  assert.equal(s.searches.length, 0, 'one character: no search');
  assert.match(text(s.view()), /at least 2 characters/);
  type(s, 'pu');
  type(s, 'pump');
  await sleep(520);
  await flush();
  assert.equal(s.searches.length, 1, 'debounced: one search for the last text');
  deq(s.searches[0], { path: '', search: 'pump', limit: 100 });
  const req = s.requests.filter((r) => r.body.search !== undefined)[0];
  assert.ok(req.opts.timeoutMs >= 15000, 'a longer client timeout than a browse');
  v = s.view();
  const list = byAttr(v, 'role', 'listbox')[0];
  assert.equal(list.props['aria-multiselectable'], 'true');
  const opts = options(v);
  assert.equal(opts.length, 2);
  assert.equal(opts[0].props['data-ctg-path'], '[default]Area1/Pump101/Speed');
  assert.match(text(opts[0]), /Speed.*\[default\]Area1\/Pump101.*Float8/);
  assert.equal(opts[0].props['aria-selected'], 'false');
  assert.equal(opts[1].props['aria-disabled'], 'true', 'String: not trendable, not selectable');
  assert.match(opts[1].props.title, /numeric and Boolean/);
  assert.match(text(status(v)), /2 matching tags/);
  assert.equal(status(v).props.role, 'status');
});

test('panel: select in the results, add to pens; the selection survives switching back to the tree', async () => {
  const s = browser({ onSearch: () => SEARCH_OK([HIT('Speed', '[default]Area1/Pump101'), HIT('Temp', '[default]Area1/Pump101')]) });
  await searchFor(s, 'pump101');
  options(s.view())[0].props.onClick(ev());
  assert.equal(options(s.view())[0].props['aria-selected'], 'true');
  toggle(s.view()).props.onChange(ev({ target: { checked: false } }));
  assert.equal(Object.keys(s.tb.state.selected).length, 1);
  const add = byAttr(s.view(), 'data-ctg-act', 'add-selected')[0];
  assert.match(text(add), /Add selected \(1\)/, 'a hit selected before the switch still counts in tree mode');
  add.props.onClick(ev());
  const w = s.writes.pop();
  assert.equal(w.patch, true);
  deq(w.value.map((p) => p.tagPath), ['[default]Area1/Pump101/Speed']);
  assert.ok(s.events.some((e) => e.name === 'onPensChange' && e.payload.tagPath === '[default]Area1/Pump101/Speed'));
});

test('panel: keyboard in the results — arrows move, Space selects, Enter adds', async () => {
  const s = browser({ onSearch: () => SEARCH_OK([HIT('A1', '[default]X'), HIT('A2', '[default]X')]) });
  await searchFor(s, 'a*');
  const key = (k) => byAttr(s.view(), 'role', 'listbox')[0].props.onKeyDown(ev({ key: k }));
  key('ArrowDown');
  assert.equal(s.tb.state.focus, 'h:[default]x/a2');
  key(' ');
  key('Home');
  key(' ');
  assert.equal(Object.keys(s.tb.state.selected).length, 2);
  key('Enter');
  deq(s.writes.pop().value.map((p) => p.tagPath).sort(), ['[default]X/A1', '[default]X/A2']);
});

test('panel: Load more uses the opaque continuation of the same search', async () => {
  const s = browser({ onSearch: (b) => (b.continuation === 'opaque-1' ? SEARCH_OK([HIT('T2', '[default]X')], { totalAvailable: 2 })
    : SEARCH_OK([HIT('T1', '[default]X')], { totalAvailable: 2, continuation: 'opaque-1' })) });
  await searchFor(s, 't*');
  let more = byAttr(s.view(), 'data-ctg-row', 'more')[0];
  assert.ok(more);
  more.props.onClick(ev());
  await flush();
  deq(s.searches[1], { path: '', search: 't*', continuation: 'opaque-1', limit: 100 });
  assert.equal(options(s.view()).length, 2);
  assert.ok(!byAttr(s.view(), 'data-ctg-row', 'more')[0]);
});

test('panel: Cancel stops the search on the gateway; Escape clears and cancels; a late reply is dropped', async () => {
  let release;
  const s = browser({ onSearch: () => new Promise((r) => { release = r; }) });
  await searchFor(s, 'pump');
  let st = status(s.view());
  assert.equal(st.props['data-ctg-state'], 'running');
  byAttr(s.view(), 'data-ctg-act', 'cancel-search')[0].props.onClick(ev());
  deq(s.cancels, [{ cancelSearch: true }]);
  release(SEARCH_OK([HIT('Pump', '[default]X')]));
  await flush();
  assert.equal(options(s.view()).length, 0, 'the cancelled search\'s reply is not shown');
  assert.match(text(status(s.view())), /cancelled/);
  byAttr(s.view(), 'data-ctg-act', 'retry-search')[0].props.onClick(ev());
  assert.equal(s.searches.length, 2, 'Try again searches the same text');
  // Escape while running: clears the field and cancels
  field(s.view()).props.onKeyDown(ev({ key: 'Escape' }));
  assert.equal(s.tb.state.filter, '');
  assert.equal(s.cancels.length, 2);
  assert.equal(status(s.view()), undefined, 'no status line without a search');
});

test('panel: RATE_LIMITED / BUSY are retried once after a pause, then reported', async () => {
  const s = browser({ onSearch: (b, n) => (n === 1 ? { ok: false, error: { code: 'RATE_LIMITED' } } : n === 2 ? SEARCH_OK([HIT('Temp', '[default]X')])
    : { ok: false, error: { code: 'BUSY' } }) });
  await searchFor(s, 'temp');
  assert.equal(status(s.view()).props['data-ctg-state'], 'running', 'still searching while the retry waits');
  await sleep(1300);
  await flush();
  assert.equal(s.searches.length, 2);
  assert.equal(options(s.view()).length, 1);
  type(s, 'tempx');
  field(s.view()).props.onKeyDown(ev({ key: 'Enter' }));
  await flush();
  await sleep(1300);
  await flush();
  assert.equal(s.searches.length, 4, 'one retry');
  assert.equal(status(s.view()).props['data-ctg-state'], 'error');
  assert.match(text(status(s.view())), /busy/i);
});

test('panel: switching off, a new identity and closing the panel cancel a running search', async () => {
  const caps = { readScope: { runtimePensAllowed: true, roots: ['[default]'] }, user: 'operator' };
  const s = browser({ caps, onSearch: () => new Promise(() => {}) });
  await searchFor(s, 'pump');
  toggle(s.view()).props.onChange(ev({ target: { checked: false } }));
  assert.equal(s.cancels.length, 1, 'switch off');
  await searchFor(s, 'pump');
  caps.user = 'engineer';
  s.tb.componentDidUpdate();
  assert.equal(s.cancels.length, 2, 'new identity');
  assert.equal(s.tb.search.status, 'idle');
  await searchFor(s, 'pump');
  s.tb.componentWillUnmount();
  assert.equal(s.cancels.length, 3, 'unmount');
});

test('panel: the scope mirror greys hits outside the read scope; charted tags show as charted', async () => {
  const s = browser({ props: { pens: [{ tagPath: '[default]A/Temp' }] }, caps: { readScope: { runtimePensAllowed: true, roots: ['[default]A'] } },
    onSearch: () => SEARCH_OK([HIT('Temp', '[default]A'), HIT('Temp', '[default]B')]) });
  await searchFor(s, 'temp');
  const [a, b] = options(s.view());
  assert.match(text(a), /Already on this chart/);
  assert.equal(b.props['aria-disabled'], 'true');
  assert.match(b.props.title, /Outside the tags this chart may show/);
});

test('panel: moving between the dock and the narrow sheet (re-mount) keeps the mode, text, ticks and results of the opening', async () => {
  const caps = { readScope: { runtimePensAllowed: true, roots: ['[default]'] }, user: 'operator' };
  let hang = false;
  const s = browser({ caps, onSearch: () => (hang ? new Promise(() => {}) : SEARCH_OK([HIT('Speed', '[default]A/Pump101'), HIT('Temp', '[default]A/Pump101')])) });
  const args = s.tb.props.args;
  await searchFor(s, 'pump101');
  options(s.view())[0].props.onClick();
  s.tb.componentDidUpdate();                         // (React: after every update)
  // React order of a move: the new instance (same opening = same args) is constructed, THEN the old one unmounts,
  // THEN the new one mounts
  const move = (old) => { const tb = new s.P.TagBrowser({ api: s.api, args, close: () => {} }); old.componentWillUnmount(); tb.componentDidMount(); return tb; };
  let tb = move(s.tb);
  let v = full(tb.render());
  assert.equal(tb.state.searchAll, true);
  assert.equal(field(v).props.value, 'pump101');
  deq(options(v).map((o) => [o.props['data-ctg-path'], o.props['aria-selected']]),
    [['[default]A/Pump101/Speed', 'true'], ['[default]A/Pump101/Temp', 'false']], 'results and the tick are back');
  assert.equal(s.searches.length, 1, 'a finished search is not run again');
  assert.equal(s.cancels.length, 0, 'nothing was running');
  // a search running at the move is cancelled with the old instance and runs again in the new one
  hang = true;
  field(v).props.onKeyDown(ev({ key: 'Enter' }));
  await flush();
  tb.componentDidUpdate();
  assert.equal(s.searches.length, 2);
  tb = move(tb);
  await flush();
  assert.equal(s.cancels.length, 1, 'the old instance cancels on the gateway');
  assert.equal(s.searches.length, 3, 'searched again after the move');
  assert.equal(tb.search.status, 'running');
  assert.equal(Object.keys(tb.state.selected).length, 1, 'tick kept');
  // another browse identity meanwhile (login as someone else): nothing comes back
  caps.user = 'engineer';
  tb = move(tb);
  assert.equal(tb.state.searchAll, false);
  assert.equal(tb.state.filter, '');
  deq(tb.state.selected, {});
  // a NEW opening (new args) always starts clean
  const fresh = new s.P.TagBrowser({ api: s.api, args: {}, close: () => {} });
  assert.equal(fresh.state.searchAll, false);
});

// ---- search hint and per-opening state ----------------------------------------------------------------------------------

test('the "Type at least 2 characters" hint is not shown for valid text waiting for the debounce', async () => {
  const s = browser({ onSearch: () => SEARCH_OK([]) });
  await flush();
  toggle(s.view()).props.onChange(ev({ target: { checked: true } }));
  type(s, 'p');
  assert.match(text(s.view()), /at least 2 characters/, 'one character: the hint');
  type(s, 'pump');                                   // valid; the debounced search has not started yet
  assert.equal(s.tb.search.status, 'idle');
  assert.doesNotMatch(text(s.view()), /at least 2 characters/, 'valid text: no "too short" hint during the debounce');
  type(s, 'p*');
  assert.doesNotMatch(text(s.view()), /at least 2 characters/, 'one character plus a wildcard is valid too');
  s.tb.componentWillUnmount();
});

test('per-opening state — a real close drops it; a new opening with the same args object starts clean', async () => {
  const caps = { readScope: { runtimePensAllowed: true, roots: ['[default]'] }, user: 'operator' };
  const s = browser({ caps, onSearch: () => SEARCH_OK([HIT('Speed', '[default]A/Pump101')]) });
  s.tb.componentWillUnmount();                       // (the helper's own instance)
  const ARGS = {};                                   // a caller that re-uses one constant args object
  const api = s.api;                                 // the stub's panel registry answers isOpen like the chart
  assert.equal(api.panels.open('tagBrowser'), true);
  const mk = (args) => { const tb = new s.P.TagBrowser({ api, args, close: () => {} }); tb.componentDidMount(); return tb; };
  Object.defineProperty(ARGS, 'openingId', { value: 1, enumerable: false, configurable: true });
  let tb = mk(ARGS);
  const viewOf = (x) => full(x.render());
  toggle(viewOf(tb)).props.onChange(ev({ target: { checked: true } }));
  field(viewOf(tb)).props.onChange(ev({ target: { value: 'pump101' } }));
  field(viewOf(tb)).props.onKeyDown(ev({ key: 'Enter' }));
  await flush();
  options(viewOf(tb))[0].props.onClick();
  tb.componentDidUpdate();
  // a re-mount of the same opening (panel still open): state comes back
  const again = new s.P.TagBrowser({ api, args: ARGS, close: () => {} });
  tb.componentWillUnmount();
  again.componentDidMount();
  assert.equal(again.state.searchAll, true, 're-mount keeps the mode');
  assert.equal(again.state.filter, 'pump101');
  // a real close: the panel is no longer open when it unmounts -> nothing is kept, even for the same args object
  assert.equal(api.panels.close('tagBrowser'), true);
  again.componentWillUnmount();
  api.panels.open('tagBrowser');
  const reopened = mk(ARGS);
  assert.equal(reopened.state.searchAll, false, 'closed and opened again: clean (old code restored the old opening)');
  assert.equal(reopened.state.filter, '');
  assert.deepEqual(J(reopened.state.selected), {});
  // a new opening while open, same object but another openingId (the chart stamps one per opening): clean too
  field(viewOf(reopened)).props.onChange(ev({ target: { value: 'x' } }));
  reopened.componentDidUpdate();
  const ARGS2 = ARGS;                                 // same object ...
  Object.defineProperty(ARGS2, 'openingId', { value: 2, enumerable: false, configurable: true });   // ... next opening
  const next = new s.P.TagBrowser({ api, args: ARGS2, close: () => {} });
  assert.equal(next.state.filter, '', 'another opening id: not restored');
  reopened.componentWillUnmount();
});

test('the chart gives every panel opening its own args copy with a hidden openingId', () => {
  const s = stub({ props: { tagBrowser: { enabled: true } }, penInfos: [] });
  const C = s.NS.chart;
  const c = Object.create(C.CtgChart.prototype);
  Object.assign(c, { _alive: true, props: { eventsEnabled: true, props: {} }, state: { panels: {} },
    setState(p, cb) { Object.assign(this.state, p); if (cb) cb(); } });
  const ARGS = { source: 'api' };
  assert.equal(c.openPanel('tagBrowser', ARGS), true);
  const a1 = c._panels.tagBrowser;
  assert.notEqual(a1, ARGS, 'a copy per opening');
  assert.deepEqual(Object.keys(a1), ['source'], 'openingId is not enumerable');
  assert.equal(JSON.stringify(a1), '{"source":"api"}');
  assert.ok(a1.openingId > 0);
  assert.equal(c.openPanel('tagBrowser', ARGS), true);
  const a2 = c._panels.tagBrowser;
  assert.ok(a2 !== a1 && a2.openingId > a1.openingId, 'the next opening has a new object and id');
});
