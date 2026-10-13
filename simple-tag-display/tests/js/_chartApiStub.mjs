// =============================================================================
// _chartApiStub.mjs — a fake ChartApi for panel tests in Node
// =============================================================================
// ctg-chart-tools.js and ctg-chart-panels.js talk to the chart ONLY through
// ChartApi, whose member list is fixed. This stub implements
// every member with the same shapes over fixture data, so panel code can be
// developed and unit-tested without a gateway, a delegate or uPlot:
//
//   import { createChartApiStub } from './_chartApiStub.mjs';
//   const s = createChartApiStub({ props: { pens: [{ tagPath: '[default]CTG/Temp' }] } });
//   s.api.pens()                         // PenVMs built by the REAL buildPens/assignAxes
//   s.api.write('timeRange', {...})      // recorded in s.writes; props re-reduced; onChange fired
//   s.api.patch('pens', (raw) => ...)    // built from the RAW props (s.raw()); recorded with patch: true
//   s.api.request('chart.browse', {...}) // recorded in s.requests; answered by fixture.handlers
//   s.NS, s.C                            // the loaded window.__CTG and NS.chart (real code)
//
// It loads the real module files into the _stubs.mjs environment, so props
// are reduced by the real reducer (exact schema shapes) and strings come from
// the real NS.i18n. Panel files can be loaded into the same environment with
// s.env.load('ctg-chart-tools.js') and then render(s.api, args, close) called.
//
// Fixture (all optional):
//   props      raw component props (reduced with NS.chart.reduceProps)
//   penInfos   gateway PenInfo[] (default: one ok PenInfo per props.pens entry)
//   series     {penKey: {t:[], v:[]}} samples in draw time (default: a 1 s sine over the window)
//   limits     chart.snapshot.limits (defaults filled in like the chart does)
//   capabilities  partial override of capabilities()
//   now        gateway "now" ms (default 2026-10-08T12:00:00Z), tz (default 'UTC')
//   handlers   {name: (body) => {ok, data|error}} for api.request (defaults below)
//   designMode boolean (also disables events, like the chart)
//   user       capabilities().user (default 'stub-user')
//   eventsEnabled  boolean (default true): false = fireEvent is a no-op returning false, as on a chart
//              whose component events are disabled (design mode, Designer not previewing)
//   panels     {name: def} registered in the REAL panel registry (s.C.panels) before the api is built;
//              api.panels.open(name) is true only for a registered name, exactly like the chart
//              (panel files loaded with s.env.load(...) register there too; s.registerPanel is a shortcut)
// =============================================================================
import { createEnv, FILES } from './_stubs.mjs';

/** The frozen member list (same as NS.chart.CHART_API_MEMBERS; chart-api.test.mjs checks they agree). */
export const CHART_API_MEMBERS = ['id', 'props', 'write', 'patch', 'pens', 'penInfo', 'axesInUse', 'limits', 'timeZone', 'now', 'status',
  'viewport.get', 'viewport.set', 'viewport.reset', 'request', 'history.fetchRaw', 'series.rows', 'plots.snapshot',
  'tokens', 'capabilities', 'panels.open', 'panels.close', 'panels.isOpen', 'fireEvent', 'onChange', 't'];

const SECURITY_KEYS = new Set(['enabled', 'trendGroup', 'trendEdit', 'readScope', 'tagBrowser', 'annotations']);
const REQUESTS = new Set(['chart.browse', 'chart.trendAdd', 'chart.trendRemove', 'chart.trendClear', 'chart.annotationSave', 'chart.annotationDelete']);
const EVENTS = new Set(['onPensChange', 'onRangeChange', 'onBrushChange', 'onXTraceChange']);
const LIGHT_TOKENS = { text: '#323232', textMuted: '#767676', border: '#A1A1A1', primary: '#0C7BB3', primaryText: '#FFFFFF',
  danger: '#DA1E28', warn: '#AD5F00', success: '#038537', surface: '#FFFFFF', surface2: '#F3F4F5', inputBg: '#FFFFFF',
  inputText: '#323232', focus: '#0C7BB3', font: 'sans-serif', radius: '4px' };

/** Default answers of api.request (override per test with fixture.handlers). */
const DEFAULT_HANDLERS = {
  'chart.browse': (b) => ({ ok: true, data: { path: b.path || '', continuation: null,
    rows: [{ name: 'Temp', path: '[default]CTG/Temp', type: 'AtomicTag', dataType: 'Float8', hasChildren: false, trendable: true },
      { name: 'Label', path: '[default]CTG/Label', type: 'AtomicTag', dataType: 'String', hasChildren: false, trendable: false }] } }),
  'chart.trendAdd': (b) => (b.tagPaths ? { ok: true, data: { group: 'default', added: b.tagPaths.slice(), rejected: [], count: b.tagPaths.length, max: 32 } }
    : { ok: true, data: { group: 'default', count: 1, max: 32 } }),
  'chart.trendRemove': () => ({ ok: true, data: { group: 'default', count: 0 } }),
  'chart.trendClear': () => ({ ok: true, data: { group: 'default', count: 0 } }),
  'chart.annotationSave': (b) => ({ ok: true, data: { id: null, tagPath: b.tagPath } }),
  'chart.annotationDelete': () => ({ ok: true, data: { deleted: 1 } }),
};

export function createChartApiStub(fixture = {}) {
  const env = createEnv();
  for (const f of FILES) env.load(f, '2.0.0-stub0000');
  const NS = env.window.__CTG;
  const C = NS.chart;
  const now = fixture.now || Date.UTC(2026, 9, 8, 12, 0, 0);
  const tz = fixture.tz || 'UTC';
  let raw = JSON.parse(JSON.stringify(fixture.props || {}));
  let props = C.reduceProps(raw);
  const limits = C.effectiveLimits(fixture.limits || null);
  const writes = [], requests = [], events = [], panelsOpen = new Map(), listeners = [];
  const designMode = !!fixture.designMode;
  const eventsEnabled = fixture.eventsEnabled !== false && !designMode;
  Object.entries(fixture.panels || {}).forEach(([name, def]) => C.panels.register(name, def));

  // keyed by the reducer's RAW index (p:<pen.index>) exactly like the gateway / live chart:
  // with pens [A, 'junk', B] pen B is p:2 / index 2, not p:1
  const penInfos = () => fixture.penInfos || props.pens.map((p) => ({
    key: 'p:' + p.index, source: 'pens', index: p.index, tagPath: p.tagPath, name: p.tagPath.split('/').pop(), status: 'ok',
    meta: { dataType: 'Float8', engUnit: '', engLow: 0, engHigh: 100, formatString: '' }, trendable: true,
  }));
  const vp = { followLive: props.timeRange.mode === 'realtime', span: 15 * 60000, min: null, max: null };
  const win = () => {
    const w = C.configWindow(props, now, tz, limits, now);
    return w.error ? { start: now - 3600000, end: now, span: 3600000, mode: props.timeRange.mode } : w;
  };
  const vpGet = () => (vp.followLive ? { min: now - vp.span, max: now, followLive: true, span: vp.span }
    : { min: vp.min, max: vp.max, followLive: false, span: vp.max - vp.min });
  const resetVp = () => {
    const w = win();
    if (props.timeRange.mode === 'realtime') Object.assign(vp, { followLive: true, span: w.span, min: null, max: null });
    else Object.assign(vp, { followLive: false, span: w.span, min: w.start, max: w.end });
  };
  resetVp();
  const seriesOf = (key) => {
    if (fixture.series && fixture.series[key]) return fixture.series[key];
    const t = [], v = [];
    const w = win();
    for (let x = Math.ceil(w.start / 1000) * 1000; x <= w.end; x += 1000) { t.push(x); v.push(50 + 40 * Math.sin(x / 30000)); }
    return { t, v };
  };
  const model = () => ({
    pens: penInfos().map((info) => ({ key: info.key, source: info.source || 'pens', index: info.index, tagPath: info.tagPath,
      name: info.name, serverName: info.name, status: info.status, meta: info.meta, trendable: info.trendable !== false,
      approx: false, downgraded: false, warn: null, incomplete: null, loading: false, limit: null, message: null,
      aggregation: props.query.aggregation, points: info.status === 'ok' ? seriesOf(info.key).t.length : 0 })),
  });
  const pensVM = () => {
    const vms = C.buildPens(model().pens, props, { background: LIGHT_TOKENS.surface });
    const axes = C.assignAxes(vms, props);
    return { vms, axes };
  };
  const notify = (what) => listeners.slice().forEach((fn) => fn(Object.assign({ props: false, pens: false, viewport: false, capabilities: false }, what)));
  const caps = () => Object.assign({
    enabled: props.enabled, designMode, designer: false, nativeApp: false, deviceType: 'browser',
    user: fixture.user === undefined ? 'stub-user' : fixture.user,
    tagBrowser: { allowed: props.tagBrowser.enabled, reason: props.tagBrowser.enabled ? null : 'ACTION_DISABLED' },
    trendEdit: { allowed: true, reason: null },
    readScope: { runtimePensAllowed: true, roots: ['[default]'] },
    annotations: { allowed: props.annotations.enabled, editAllowed: false, moderateAllowed: false, reason: null },
    settingsPanel: { enabled: props.settingsPanel.enabled && props.enabled, tabs: Object.assign({}, props.settingsPanel.tabs) },
    export: { csv: props.export.csv.enabled, png: props.export.png.enabled },
  }, fixture.capabilities || {});

  const api = {
    id: 'chart-stub',
    props: () => props,
    write(rootKey, value) {
      if (typeof rootKey !== 'string' || !(rootKey in props) || SECURITY_KEYS.has(rootKey) || rootKey === 'outputs' || designMode) return false;
      writes.push({ key: rootKey, value: JSON.parse(JSON.stringify(value)) });
      raw = Object.assign({}, raw, { [rootKey]: value });
      props = C.reduceProps(raw);
      notify({ props: true, pens: rootKey === 'pens' || rootKey === 'trendPens' });
      return true;
    },
    // the chart's own patch semantics (NS.chart.applyPatch) over the stub's RAW props; recorded in `writes`
    // with patch: true (the value is the new raw root)
    patch(rootKey, change) {
      if (!C.apiWritable(rootKey) || designMode) return false;
      // ctx.reduced is computed from the raw root itself, like the chart
      const r = C.patchRoot(rootKey, raw[rootKey], change);
      if (!r.ok) return false;
      if (!r.changed) return true;
      writes.push({ key: rootKey, value: JSON.parse(JSON.stringify(r.value)), patch: true });
      raw = Object.assign({}, raw, { [rootKey]: r.value });
      props = C.reduceProps(raw);
      notify({ props: true, pens: rootKey === 'pens' || rootKey === 'trendPens' });
      return true;
    },
    pens: () => pensVM().vms.map((vm) => ({ key: vm.key, source: vm.source, index: vm.index, tagPath: vm.tagPath, label: vm.label,
      color: vm.color, visible: vm.visible, axisKey: vm.axisKey, plot: vm.plot, units: vm.units, format: vm.format, display: vm.display,
      status: vm.status, meta: vm.meta, trendable: vm.trendable, isBool: vm.isBool, shared: vm.shared, axisMissing: vm.axisMissing,
      approx: vm.approx, downgraded: vm.downgraded, incomplete: vm.incomplete })),
    penInfo: (key) => penInfos().find((p) => p.key === key) || null,
    axesInUse: () => pensVM().axes.plots.flat().map((ax) => ({ key: ax.key, name: ax.name, auto: ax.auto, side: ax.side, plot: ax.plot, units: ax.units.join(', ') })),
    limits: () => Object.assign({}, limits),
    timeZone: () => tz,
    now: () => now,
    status: () => ({ state: props.timeRange.mode === 'realtime' ? (vp.followLive ? 'live' : 'paused') : 'historical', mode: props.timeRange.mode,
      staleSince: null, loading: false, lastUpdate: now, window: win(), coverage: Object.assign({}, win()), banner: null }),
    viewport: {
      get: vpGet,
      set(r) {
        if (!r || !(r.max > r.min)) return vpGet();
        const follow = props.timeRange.mode === 'realtime' && r.max >= now - Math.max(0.02 * (r.max - r.min), 1000);
        Object.assign(vp, follow ? { followLive: true, span: r.max - r.min, min: null, max: null } : { followLive: false, span: r.max - r.min, min: r.min, max: r.max });
        notify({ viewport: true });
        return vpGet();
      },
      reset() { resetVp(); notify({ viewport: true }); return vpGet(); },
    },
    request(name, body, opts) {
      requests.push({ name, body: JSON.parse(JSON.stringify(body || {})), opts: opts || {} });
      if (!REQUESTS.has(name)) return Promise.resolve({ ok: false, error: { code: 'NOT_ALLOWED', message: 'not allowed from a panel' } });
      const fn = (fixture.handlers && fixture.handlers[name]) || DEFAULT_HANDLERS[name];
      return Promise.resolve(fn(body || {}));
    },
    history: {
      fetchRaw(o = {}) {
        const keys = o.penKeys || penInfos().filter((p) => p.status === 'ok').map((p) => p.key);
        // same shape as the chart for a signal aborted before the call (no request is made there)
        if (o.signal && o.signal.aborted) return Promise.resolve({ pens: keys.map((key) => ({ key, t: [], v: [], status: 'aborted' })), error: 'ABORTED' });
        const pens = keys.map((key) => {
          const s = seriesOf(key);
          const t = [], v = [];
          s.t.forEach((x, i) => { if (x >= o.start && x <= o.end) { t.push(x); v.push(s.v[i]); } });
          return { key, t, v, status: 'ok', downgraded: false, anchor: null };
        });
        if (typeof o.onProgress === 'function') o.onProgress({ done: 1, total: 1 });
        return Promise.resolve({ pens, downgraded: false, window: { start: o.start, end: o.end, mode: 'raw', bucketMs: null, downgraded: false } });
      },
    },
    series: {
      rows(o = {}) {
        const { vms } = pensVM();
        const keys = o.penKeys || vms.filter((vm) => vm.visible && vm.drawable).map((vm) => vm.key);
        const v = vpGet();
        const views = keys.map((k) => {
          const s = seriesOf(k);
          if (o.source === 'loaded') return s;
          const t = [], vv = [];
          s.t.forEach((x, i) => { if (x >= v.min && x <= v.max) { t.push(x); vv.push(s.v[i]); } });
          return { t, v: vv };
        });
        const byKey = Object.fromEntries(vms.map((vm) => [vm.key, vm]));
        const q = !!o.includeQuality;
        // the chart's own words (series.rows goes through NS.i18n 'chart.rows.*')
        const T = (k, vars) => NS.i18n.t('chart.rows.' + k, vars);
        const good = T('good'), bad = T('bad');
        if (o.layout === 'tall') {
          const rows = [];
          views.forEach((s, i) => s.t.forEach((x, j) => rows.push(q ? [x, byKey[keys[i]].label, s.v[j], s.v[j] === null ? bad : good] : [x, byKey[keys[i]].label, s.v[j]])));
          rows.sort((a, b) => a[0] - b[0]);
          return { header: q ? [T('time'), T('pen'), T('value'), T('quality')] : [T('time'), T('pen'), T('value')], rows };
        }
        const j = C.joinViews(views);
        const header = [T('time')];
        keys.forEach((k) => { const vm = byKey[k]; const l = vm.label + (vm.units ? ' (' + vm.units + ')' : ''); header.push(l); if (q) header.push(T('qualitySuffix', { label: l })); });
        const rows = j.x.map((x, r) => {
          const row = [x];
          j.ys.forEach((col) => { const val = col[r]; row.push(val === undefined ? '' : val); if (q) row.push(val === undefined ? '' : val === null ? bad : good); });
          return row;
        });
        return { header, rows };
      },
    },
    plots: {
      // a canvas-like object (there is no HTMLCanvasElement in Node): width/height, toBlob, toDataURL
      snapshot(o = {}) {
        const scale = Math.min(4, Math.max(1, Number(o.scale) || props.export.png.scale));
        return { width: 800 * scale, height: 400 * scale, includeLegend: o.includeLegend != null ? !!o.includeLegend : props.export.png.includeLegend,
          toBlob(cb) { cb({ type: 'image/png', size: 1024 }); }, toDataURL() { return 'data:image/png;base64,'; } };
      },
    },
    tokens: () => Object.assign({}, LIGHT_TOKENS),
    capabilities: caps,
    panels: {
      // like the chart: only a name registered in the panel registry opens (never in design mode)
      open(name, args) {
        if (designMode || typeof name !== 'string' || !C.panels.get(name)) return false;
        panelsOpen.set(name, args || {});
        return true;
      },
      close(name) { return panelsOpen.delete(name); },
      isOpen(name) { return panelsOpen.has(name); },
    },
    fireEvent(name, payload) {
      if (!EVENTS.has(name) || !eventsEnabled) return false;     // the chart fires nothing while events are disabled
      events.push({ name, payload });
      return true;
    },
    onChange(cb) {
      if (typeof cb !== 'function') return () => {};
      listeners.push(cb);
      return () => { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
    },
    t: (key, vars, part) => NS.i18n.t(key, vars, part || 'chart'),
  };
  const registerPanel = (name, def) => C.panels.register(name, def);
  // raw(): the stub's RAW props (as a binding / the Designer configured them) — what api.patch builds on
  return { api: Object.freeze(api), writes, requests, events, panelsOpen, env, NS, C, emit: notify, registerPanel, raw: () => raw };
}
