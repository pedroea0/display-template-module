/* ============================================================================
 * ctg-chart.js — Click To Graph Chart (palette "Click To Graph Chart")
 * ============================================================================
 *
 * Part id: 'chart' (needs 'common'). Component id
 * com.example.simpletagdisplay.CtgChart (unchanged since v1).
 *
 * WHAT THIS FILE CONTAINS
 *   The data engine: everything between the gateway (delegate pushes
 *   + the history route) and the render model, DOM-free, exercised by the
 *   Node tests in tests/js/chart-*.test.mjs (SECTIONS 1–11).
 *   Plots, shell and ChartApi: render model, uPlot plots, toolbar,
 *   pen table, banners, outputs, the frozen panel facade (SECTIONS 12–20).
 *   Interaction: gestures (pointer / touch / wheel / keyboard) for
 *   X-Trace, pan, zoom and range brushes, the X-Trace info box and pinned
 *   traces, brush statistics, pen-table actions (collapse, edit, remove,
 *   colour), fullscreen, the narrow layout with its More menu, adaptive raw
 *   chunks (SECTIONS 3, 9, 15, 18, 19).
 *
 *   SECTION 1   strings (NS.i18n part 'chart')
 *   SECTION 2   props schema mirror + reduceProps
 *   SECTION 3   time windows, bucket ladder, planQuery, chunk plan
 *   SECTION 4   series views + k-way merge for uPlot
 *   SECTION 5   statistics: time-weighted average, held values
 *   SECTION 6   NS.chart.historyQueue — page-wide request queue
 *   SECTION 7   HistoryClient — POST /v2/history with the session token
 *   SECTION 8   SeriesStore — per data key columnar data + live buffer
 *   SECTION 9   ChartEngine — loads, incremental ticks, viewport, staleness
 *   SECTION 10  panel registry (add-on files register here)
 *   SECTION 11  CtgChartDelegate — protocol state, events for the engine
 *   SECTION 12  render model: pen view-models, colours, axes, y ranges (pure)
 *   SECTION 13  NS.chart.loadUPlot (bundled uPlot, retried, never cached failed)
 *   SECTION 14  PlotManager — one uPlot instance per stacked plot
 *   SECTION 15  ChartApi — the FROZEN facade for panels
 *   SECTION 16  the ctg-chart-styles sheet (:where(), shared --ctg-* tokens)
 *   SECTION 17  small React pieces: icons, time labels, error boundary, columns
 *   SECTION 18  ChartInteraction — gestures, X-Trace, range brushes
 *   SECTION 19  CtgChart — the component (toolbar, plots, pen table, outputs)
 *   SECTION 20  component meta + registration
 *
 * DATA FLOW
 *   delegate (chart.snapshot / chart.pens / chart.values / chart.token)
 *     -> ChartEngine.reconcile()      pen set -> data keys (path|aggregation)
 *     -> fullLoad / partial load      HistoryClient -> historyQueue -> fetch
 *     -> SeriesStore                  per data key: t[], v[], anchor, live buffer
 *     -> tick loop (realtime)         ONE incremental request per tick, `since`
 *     -> engine.model() / join()      render model + uPlot data
 *     -> buildPens / assignAxes       pen view-models, Y axes per plot (SECTION 12)
 *     -> PlotManager                  uPlot instances; live slide per animation frame
 *     -> CtgChart                     toolbar, banners, pen table, outputs.*, panels
 *
 * Every timestamp in the engine is GATEWAY epoch ms (NS.clock.now()), never
 * the browser clock. Every async continuation checks the load generation
 * and the mounted flag. There is no setInterval for data refresh: the tick
 * loop is a self-rescheduling setTimeout that never overlaps itself.
 *
 * Add-on files build on the frozen ChartApi (SECTION 15): the panels and
 * tools of ctg-chart-panels.js / ctg-chart-tools.js (NS.chart.panels) and
 * the annotation editor (PlotManager.overlays, the gesture layer of SECTION 18).
 * ============================================================================ */
(function () {
  'use strict';

  var NS = window.__CTG = window.__CTG || {};
  NS.loaded = NS.loaded || {};
  NS.ready = NS.ready || {};
  NS._queue = NS._queue || [];

  var PART = 'chart';
  var src = document.currentScript && document.currentScript.src;
  var BUILD = (src && new URL(src, location.href).searchParams.get('v')) || 'dev';
  if (NS.loaded[PART]) {
    if (NS.loaded[PART] !== BUILD) {
      console.warn('[CTG]', PART, BUILD, 'ignored; page runs', NS.loaded[PART], '- reload the page');
    }
    return;
  }
  NS.loaded[PART] = BUILD;

  NS._queue.push({ part: PART, needs: ['common'], init: initChart });
  if (NS._drain) NS._drain();

  function initChart(NS) {
    var W = window;
    var PC = W.PerspectiveClient;
    var React = W.React;
    var h = React.createElement;
    var hasOwn = Object.prototype.hasOwnProperty;
    var COMPONENT_ID = 'com.example.simpletagdisplay.CtgChart';
    var log = NS.log('ctg.chart');

    var SECOND = 1000;
    var MINUTE = 60 * SECOND;
    var HOUR = 60 * MINUTE;
    var DAY = 24 * HOUR;

    var defaultTimers = {
      set: function (fn, ms) { return setTimeout(fn, ms); },
      clear: function (t) { if (t != null) clearTimeout(t); },
    };

    /* ========================================================================
     * SECTION 1 / strings — every user-facing text of this part
     * ====================================================================== */
    NS.i18n.register('chart', {
      'chart.loading': 'Loading…',
      'chart.history.failed': 'history unavailable ({code})',
      'chart.status.ok': 'ok',
      'chart.status.loading': 'loading…',
      'chart.status.invalidPath': 'invalid path',
      'chart.status.notFound': 'tag not found',
      'chart.status.accessDenied': 'no read permission',
      'chart.status.noHistory': 'no history available',
      'chart.status.unsupportedType': 'cannot be trended (data type)',
      'chart.status.overLimit': 'over the pen limit',
      'chart.status.outOfScope': 'not allowed on this chart',
      'chart.status.overLimit.title': 'Too many pens (max {max})',
      'chart.status.notFound.title': 'Tag not found',
      'chart.status.accessDenied.title': 'No permission to read this tag',
      'chart.status.noHistory.title': 'History not enabled for this tag',
      'chart.status.unsupportedType.title': 'Only numeric and Boolean tags can be trended',
      'chart.status.invalidPath.title': 'Invalid tag path',
      'chart.status.outOfScope.title': 'Not allowed on this chart (outside its read scope)',
      'chart.status.tooManyPoints': 'too many points (> {limit})',
      'chart.status.timeout': 'history query timed out',
      'chart.status.error': 'history query failed',
      'chart.pen.downgraded': 'aggregated (too many raw points)',
      'chart.state.loading': 'Loading…',
      'chart.state.live': 'Live',
      'chart.state.paused': 'Paused',
      'chart.state.historical': 'Historical',
      'chart.state.stale': 'Stale since {time}',
      'chart.state.disconnected': 'Disconnected',
      'chart.state.connecting': 'Connecting…',
      'chart.state.error': 'Error',
      'chart.state.empty': 'No pens',
      'chart.progress': 'Loading history {done}/{total} ({pct} %) · {points} points',
      'chart.progress.cancel': 'Cancel',
      'chart.notice.clamped': 'Showing the last {days} days (gateway limit).',
      'chart.notice.partial': 'Partially loaded.',
      'chart.notice.busy': 'Gateway busy, retrying…',
      'chart.notice.tooManyPoints': '{pens}: more than {limit} points in this range.',
      'chart.notice.rawDowngraded': 'Raw data is limited to {days} days: showing aggregated data.',
      'chart.notice.annotationsUnsupported': 'Notes are not available: this historian does not support annotations.',
      // annotations: marker tooltip, More menu
      'chart.ann.note': 'Note',
      'chart.ann.range': 'Range',
      'chart.ann.by': 'by {author}',
      'chart.ann.unknownAuthor': 'author unknown',
      'chart.ann.saving': 'saving…',
      'chart.ann.show': 'Show notes',
      'chart.ann.hide': 'Hide notes',
      // range selector: the overview strip under the plots
      'chart.rs.label': 'Overview of {from} – {to}',
      'chart.rs.window': 'Visible range',
      'chart.rs.start': 'Start of the visible range',
      'chart.rs.end': 'End of the visible range',
      'chart.rs.keys': 'Arrow keys move the visible range (Shift: faster), Home and End go to the start or the end, Up and Down widen or narrow it. On the handles, the arrow keys move that end.',
      'chart.rs.show': 'Show overview',
      'chart.rs.hide': 'Hide overview',
      'chart.rs.unavailable': 'Overview unavailable ({code})',
      'chart.banner.SESSION_MISMATCH': 'History is not available in this session.',
      // the per-session token cap is transient (retried with backoff)
      'chart.banner.SESSION_FULL': 'History paused: this session already runs the maximum number of charts with history. It resumes when one closes.',
      'chart.banner.auth': 'Not authorised for history.',
      'chart.banner.reload': 'Module updated — reload the page.',
      // unmigrated v1 props are detected, never read
      'chart.v1Warn': 'CTG Chart: this view still uses v1 props ({keys}). They are ignored; run simple-tag-display/tools/migrate-v1-views.mjs.',
      'chart.v1Badge': 'v1 props: run tools/migrate-v1-views.mjs',
      'chart.banner.RANGE_INVALID': 'Start must be before end.',
      'chart.banner.RANGE_TOO_LARGE': 'The time range is too large for the gateway.',
      'chart.banner.RAW_RANGE_TOO_LARGE': 'Raw data is limited to {days} days: narrow the range or use aggregated data.',
      'chart.banner.TOO_MANY_PENS': 'Too many pens for one history request.',
      'chart.banner.memory': 'Too much data is loaded: narrow the range or use aggregated data.',
      'chart.banner.error': 'History query failed ({code}), retrying.',
      'chart.banner.failed': 'History query failed ({code}).',
      'chart.banner.network': 'Cannot reach the gateway for history (retrying).',
      'chart.banner.library': 'Chart library failed to load (retrying).',
      'chart.banner.render': 'Chart error: {message}',
      'chart.banner.panel': 'Panel error: {message}',
      'chart.banner.closePanel': 'Close panel',
      'chart.banner.reloadPage': 'Reload page',
      'chart.banner.reloadChart': 'Reload chart',
      'chart.notice.useAggregated': 'Use aggregated data',
      'chart.notice.narrowRange': 'Narrow the range',
      'chart.notice.overLimit': '+{n} more pens over the limit',
      // toolbar
      'chart.toolbar': 'Chart toolbar',
      'chart.toolbar.modes': 'Interaction mode',
      'chart.mode.xTrace': 'X-Trace',
      'chart.mode.pan': 'Pan',
      'chart.mode.zoom': 'Zoom',
      'chart.mode.rangeBrush': 'Range',
      'chart.mode.annotate': 'Note',
      'chart.mode.xTrace.title': 'X-Trace: hover to read values',
      'chart.mode.pan.title': 'Pan: drag to move, wheel to zoom',
      'chart.mode.zoom.title': 'Zoom: drag a box to zoom in',
      'chart.mode.rangeBrush.title': 'Range: drag to select a range and see its statistics',
      'chart.mode.annotate.title': 'Note: add annotations',
      'chart.btn.refresh': 'Refresh',
      'chart.btn.reset': 'Reset zoom',
      'chart.btn.returnLive': 'Return to live',
      'chart.btn.tags': 'Tags',
      'chart.btn.settings': 'Settings',
      'chart.btn.export': 'Export',
      'chart.btn.dateRange': 'Date range',
      'chart.range.last': 'Last {n} {unit}',
      'chart.range.zoomed': 'Zoomed: {from} – {to}',
      'chart.range.historical': '{from} → {to}',
      'chart.unit.seconds': 'seconds', 'chart.unit.second': 'second',
      'chart.unit.minutes': 'minutes', 'chart.unit.minute': 'minute',
      'chart.unit.hours': 'hours', 'chart.unit.hour': 'hour',
      'chart.unit.days': 'days', 'chart.unit.day': 'day',
      'chart.unit.weeks': 'weeks', 'chart.unit.week': 'week',
      'chart.unit.months': 'months', 'chart.unit.month': 'month',
      'chart.unit.years': 'years', 'chart.unit.year': 'year',
      // pen table
      'chart.table.caption': 'Pens',
      'chart.table.pens': 'Pens ({n})',
      'chart.col.current': 'Current',
      'chart.col.end': 'End',
      'chart.col.minimum': 'Min',
      'chart.col.maximum': 'Max',
      'chart.col.average': 'Avg',
      'chart.col.units': 'Units',
      'chart.col.status': 'Status',
      'chart.col.show': 'Show',
      'chart.col.average.title': 'Time-weighted average over the visible window',
      'chart.col.approx.title': '≈ computed from aggregated data',
      'chart.pen.show': 'Show {name}',
      'chart.pen.sharesScale': 'Shares a scale with other pens. Give this pen its own axis in Settings > Pens.',
      'chart.pen.axisMissing': 'Axis "{name}" not found: using an automatic axis.',
      'chart.pen.incomplete': 'Older data in this range is missing.',
      'chart.pen.incompleteShort': 'older data missing',
      'chart.pen.quality': 'Live value quality: {name}',
      'chart.empty.hint': 'No pens. Add pens to this chart, or right-click a Display Template and choose Trend Tag.',
      'chart.empty.design': 'No pens — add pens in props.pens, or trend tags at runtime.',
      'chart.plot.label': 'Trend of {pens}, {range}',
      'chart.banner.timeout': 'History queries are timing out (retrying).',
      // interaction: plot keyboard help, X-Trace, range brushes, pen table actions, fullscreen, narrow layout
      'chart.plot.keys': 'Arrow keys pan, plus and minus zoom, Home returns to the configured range, X moves the value cursor (Shift+X back), Enter pins it, Delete removes the selected range or trace, Escape cancels.',
      'chart.col.xTrace': 'X-Trace',
      'chart.col.xTrace.title': 'Value at the hovered or first pinned X-Trace cursor',
      'chart.col.axis': 'Axis',
      'chart.col.plot': 'Plot',
      'chart.col.actions': 'Actions',
      'chart.axis.auto': 'Auto ({side})',
      'chart.axis.left': 'left',
      'chart.axis.right': 'right',
      'chart.xtrace.bad': 'Bad',
      'chart.xtrace.max': 'At most {n} X-Trace cursors can be pinned.',
      'chart.xtrace.pinned': 'X-Trace cursor pinned at {time}.',
      'chart.xtrace.removed': 'X-Trace cursor removed.',
      'chart.brush.max': 'At most {n} ranges.',
      'chart.brush.label': 'Range {n}',
      'chart.brush.summary': '{label} · {from} – {to} · {span}',
      'chart.brush.select': 'Range',
      'chart.brush.prev': 'Previous range',
      'chart.brush.next': 'Next range',
      'chart.brush.zoom': 'Zoom to range',
      'chart.brush.copy': 'Copy stats',
      'chart.brush.copied': 'Statistics copied.',
      'chart.brush.copyFailed': 'Could not copy the statistics.',
      'chart.brush.clear': 'Clear',
      'chart.brush.exact': 'Loading exact statistics…',
      'chart.brush.removed': 'Range removed.',
      'chart.brush.tsvApprox': 'Approximate',
      'chart.brush.tsvApproxYes': 'yes (aggregated data)',
      'chart.brush.exactFailed': 'Exact statistics unavailable: the ≈ values come from aggregated data.',
      'chart.rcol.first': 'First', 'chart.rcol.last': 'Last', 'chart.rcol.delta': 'Delta',
      'chart.rcol.minimum': 'Min', 'chart.rcol.maximum': 'Max', 'chart.rcol.average': 'Avg',
      'chart.rcol.median': 'Median', 'chart.rcol.standardDeviation': 'Std dev', 'chart.rcol.sum': 'Sum',
      'chart.rcol.lcl': 'LCL', 'chart.rcol.ucl': 'UCL', 'chart.rcol.count': 'Count',
      'chart.rcol.average.title': 'Time-weighted average over the range',
      'chart.rcol.median.title': 'Median of the samples in the range (not time-weighted)',
      'chart.rcol.standardDeviation.title': 'Population standard deviation of the samples in the range (not time-weighted)',
      'chart.rcol.sum.title': 'Sum of the samples in the range',
      'chart.rcol.lcl.title': 'Lower control limit: {method}',
      'chart.rcol.ucl.title': 'Upper control limit: {method}',
      'chart.rcol.method.stdDev': 'mean − {k} × standard deviation (mean + for UCL)',
      'chart.rcol.method.movingRange': 'mean ∓ {k} × (average moving range / 1.128)',
      'chart.table.collapse': 'Collapse the pen table',
      'chart.table.expand': 'Expand the pen table',
      'chart.table.details': 'Details of {name}',
      'chart.pen.edit': 'Edit {name}',
      'chart.pen.remove': 'Remove {name}',
      'chart.pen.color': 'Change the colour of {name}',
      'chart.pen.removeConfirm': 'Remove {name}?',
      'chart.pen.removeTrendConfirm': 'Remove {name} from the trend list? Other charts of the group lose it too.',
      'chart.pen.removeBtn': 'Remove',
      'chart.pen.removeFailed': 'Could not remove {name}: {message}',
      'chart.pen.removed': '{name} removed.',
      'chart.pen.removeStale': 'the pen list changed. Try again.',
      'chart.pen.removing': 'Removing…',
      'chart.btn.fullscreen': 'Fullscreen',
      'chart.btn.exitFullscreen': 'Exit fullscreen',
      'chart.btn.more': 'More',
      'chart.btn.mode': 'Mode: {mode}',
      'chart.btn.back': 'Back',
      'chart.more.refreshRate': 'Refresh rate…',
      'chart.rate.title': 'Refresh rate',
      'chart.rate.label': 'Refresh every (ms)',
      'chart.rate.help': '0 = off; otherwise 250 to 3 600 000 ms.',
      'chart.rate.invalid': 'Enter 0 (off) or a whole number of milliseconds from 250 to 3 600 000.',
      'chart.rate.apply': 'Apply',
      'chart.rate.off': 'off',
      // api.series.rows headers and quality words (through NS.i18n like every user-facing text)
      'chart.rows.time': 'Time',
      'chart.rows.pen': 'Pen',
      'chart.rows.value': 'Value',
      'chart.rows.quality': 'Quality',
      'chart.rows.qualitySuffix': '{label} quality',
      'chart.rows.good': 'Good',
      // an aggregated pen's export column / pen name says so (its rows are buckets, not samples)
      'chart.rows.aggregated': '{label} [{aggregation}]',
      'chart.rows.bad': 'Bad',
      // Annotation time out of bounds. The code is annotation-only, so its text lives in this part, not
      // in the frozen ctg-common table; NS.i18n.errorText finds it from every part. details {reason, maxRangeDays}.
      'error.INVALID_TIME': function (d) {
        if (d.reason === 'future') return 'A note cannot start more than a day from now.';
        if (d.reason === 'order') return 'A range must end after it starts.';
        if (d.reason === 'length' && d.maxRangeDays != null) {
          return 'A range can be at most ' + String(d.maxRangeDays) + ' days long.';
        }
        return "The note's time is not allowed: check its start and end.";
      },
    });

    /* ========================================================================
     * SECTION 2 / props — schema mirror and reducer
     * ----------------------------------------------------------------------
     * SPEC mirrors common/src/main/resources/schemas/ctgchart.props.json node
     * for node (types, defaults, enums, bounds). The schema is not served to
     * the browser, so the mirror lives here; tests/js/chart-reducer.test.mjs
     * walks both and fails on ANY difference, so the two cannot drift apart.
     *
     * reduceProps(tree) returns a deep-frozen plain object with exactly the
     * schema's top-level keys. Rules: missing / null / wrong type -> default
     * (nullish, not falsy: 0 stays 0); numbers clamped to the schema
     * bounds; unknown enum -> default; array items that are not objects are
     * dropped. Extra keys from the tree are ignored (additionalProperties:
     * false). Non-enumerable extras (never written back, never in the key
     * set): pens[i].index (position in the raw array = the gateway's "p:<i>"),
     * props.dataHash and props.structuralHash (compared by ChartEngine.setProps).
     * ====================================================================== */
    var AGGREGATIONS = ['LastValue', 'SimpleAverage', 'Average', 'Minimum', 'Maximum', 'MinMax', 'Range', 'Count', 'Sum',
      'StdDev', 'Variance', 'DurationOn', 'DurationOff', 'CountOn', 'CountOff', 'PctGood', 'PctBad'];
    var UNITS = ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years'];
    /**
     * Aggregations whose buckets carry the tag's own values (same unit, same domain). The others
     * (Range, Count, Sum, StdDev, Variance, DurationOn/Off, CountOn/Off, PctGood/Bad) are statistics in another
     * domain: raw tag values must never stand in for them (auto raw mode, live tail, exact brush re-fetch), and a
     * Boolean pen with one of them is not a 0/1 signal. DIGITAL_AGGS: the subset that keeps a Boolean 0/1.
     */
    var VALUE_AGGS = { LastValue: 1, SimpleAverage: 1, Average: 1, Minimum: 1, Maximum: 1, MinMax: 1 };
    var DIGITAL_AGGS = { LastValue: 1, Minimum: 1, Maximum: 1, MinMax: 1 };
    function isValueAgg(a) { return a == null || a === '' || a === 'default' || hasOwn.call(VALUE_AGGS, a); }
    /** Auto mode may go raw only when every enabled pen (and the trend pens' chart aggregation) is a value aggregation. */
    function autoRawAllowed(p) {
      if (!p || !p.query) return true;
      var qa = p.query.aggregation;
      if (!isValueAgg(qa)) return false;
      return (p.pens || []).every(function (pen) {
        if (!pen || pen.enabled === false || !pen.tagPath) return true;
        return isValueAgg(pen.aggregation && pen.aggregation !== 'default' ? pen.aggregation : qa);
      });
    }

    // Spec node constructors. t: boolean | number | integer | string | enum | date | array | object | style | any
    function B(d) { return { t: 'boolean', d: d }; }
    function N(d, min, max) { return { t: 'number', d: d, min: min, max: max }; }
    function I(d, min, max) { return { t: 'integer', d: d, min: min, max: max }; }
    function S(d) { return { t: 'string', d: d }; }
    function E(d, values) { return { t: 'enum', d: d, values: values }; }
    function A(d, item, minItems) { return { t: 'array', d: d, item: item, minItems: minItems }; }
    function O(p) { return { t: 'object', p: p }; }
    var NN = { t: 'number', d: null, nullable: true };          // ["number","null"], default null
    var DATE = { t: 'date', d: null, nullable: true };          // ["date","null"], default null
    var STYLE = { t: 'style', d: { classes: '' } };             // $ref style-properties
    var STR_ITEM = { t: 'string' };
    var NUM_ITEM = { t: 'number' };
    var ANY_OBJ_ITEM = { t: 'any-object' };

    /**
     * Curve types (Power Chart parity): the four v2.0 names plus the rest of the Power Chart's 13 d3 curves
     * (curveBasis … curveStepBefore). SECTION 14a maps each one onto a uPlot path builder.
     */
    var INTERPOLATIONS = ['linear', 'spline', 'stepAfter', 'stepBefore', 'stepCenter', 'basis', 'basisOpen', 'cardinal',
      'cardinalOpen', 'catmullRom', 'catmullRomOpen', 'monotoneX', 'monotoneY', 'natural'];
    function DISPLAY() {
      return O({
        type: E('line', ['line', 'area', 'bar', 'scatter', 'step']),
        interpolation: E('linear', INTERPOLATIONS),
        breakLine: B(true),
        width: N(1.5, 0.5, 8),
        dash: A([], NUM_ITEM),
        fillOpacity: N(0.2, 0, 1),
        radius: N(3, 1, 10),
        // per-state pen styles: bad data, outside the limits, Boolean on / off (SECTION 12 penStates, SECTION 14)
        states: O({
          bad: O({ style: E('hatch', ['hatch', 'hold', 'none']), color: S('') }),
          outOfBounds: O({
            enabled: B(false), source: E('engineering', ['engineering', 'manual']), low: NN, high: NN, color: S(''), width: N(0, 0, 8),
          }),
          boolean: O({ enabled: B(false), onColor: S(''), offColor: S(''), fillOpacity: N(0.15, 0, 1) }),
        }),
      });
    }
    function ACCESS(requireLogin) {
      return O({ roles: A([], STR_ITEM), securityLevels: A([], STR_ITEM), requireLogin: B(requireLogin) });
    }

    var SPEC = O({
      enabled: B(true),
      title: O({ visible: B(false), text: S(''), style: STYLE }),
      pens: A([], O({
        tagPath: S(''), name: S(''), enabled: B(true), visible: B(true),
        aggregation: E('default', ['default'].concat(AGGREGATIONS)),
        color: S(''), axis: S(''), plot: I(0, 0, 7), units: S(''), format: S(''), display: DISPLAY(),
      })),
      trendGroup: { t: 'string', d: 'default', nullable: true, maxLength: 64 },
      trendEdit: O({ enabled: B(true), access: ACCESS(false) }),
      readScope: O({ allowedRoots: A([], STR_ITEM), allowRuntimePens: B(true) }),
      trendPens: O({
        nameMode: E('auto', ['auto', 'leaf', 'full']),
        defaults: O({ axis: S(''), plot: I(0, 0, 7), display: DISPLAY() }),
        overrides: A([], O({
          tagPath: S(''), name: S(''), color: S(''), visible: B(true), axis: S(''), plot: I(0, 0, 7),
          units: S(''), format: S(''), display: DISPLAY(),
        })),
      }),
      timeRange: O({
        mode: E('realtime', ['realtime', 'historical']),
        realtime: O({ value: N(8, 1), unit: E('hours', UNITS) }),
        refreshRate: I(1000, 0, 3600000),
        historical: O({ startDate: DATE, endDate: DATE }),
        presets: A([
          { value: 15, unit: 'minutes', label: '' }, { value: 1, unit: 'hours', label: '' },
          { value: 8, unit: 'hours', label: '' }, { value: 24, unit: 'hours', label: '' },
          { value: 7, unit: 'days', label: '' },
        ], O({ value: N(1, 1), unit: E('hours', UNITS), label: S('') })),
      }),
      query: O({
        mode: E('auto', ['auto', 'aggregated', 'raw']),
        aggregation: E('MinMax', AGGREGATIONS),
        pointCount: I(0, 0, 5000),
        autoRawBelowBucketMs: I(2000, 0, 3600000),
        maxPointsPerPen: I(100000, 1000, 2000000),
        onTooManyPoints: E('message', ['message', 'aggregate']),
        includeAnchor: B(true),
        chunking: O({ enabled: B(true), rawChunk: E('auto', ['auto', '1h', '6h', '1d']) }),
      }),
      axes: A([], O({
        name: S('Axis 1'), position: E('left', ['left', 'right']), visible: B(true),
        label: O({ text: S(''), visible: B(true) }),
        color: S(''), format: S(''), scale: E('linear', ['linear', 'log']), width: I(0, 0, 400),
        range: O({
          mode: E('auto', ['auto', 'manual', 'engineering']), min: NN, max: NN,
          includeZero: B(false), padding: N(0.05, 0, 0.5),
        }),
        grid: O({ visible: B(true), color: S(''), opacity: N(0.5, 0, 1), dash: A([], NUM_ITEM) }),
      })),
      plots: A([], O({
        relativeWeight: N(1, 0.1, 10), background: S(''),
        markers: A([], O({
          type: E('line', ['line', 'band']), axis: S(''), value: N(0), min: N(0), max: N(0), color: S(''),
          opacity: N(0.6, 0, 1), width: N(1), dash: A([4, 4], NUM_ITEM),
          label: O({ text: S(''), position: E('right', ['left', 'right']) }),
        })),
      })),
      timeAxis: O({
        visible: B(true), format: S('auto'), timeZone: S('session'),
        grid: O({ visible: B(true), color: S(''), opacity: N(0.5), dash: A([], NUM_ITEM) }),
      }),
      // the overview strip under the plots (like the Power Chart's range selector; SECTION 14c)
      rangeSelector: O({ visible: B(false), height: I(64, 40, 200), pens: E('visible', ['visible', 'all']), narrowVisible: B(false) }),
      interaction: O({
        mode: E('xTrace', ['xTrace', 'pan', 'zoom', 'rangeBrush', 'annotate']),
        fullscreen: B(false), cursorSyncGroup: S(''), keyboard: B(true),
        panAndZoom: O({ freeRange: B(true), wheelZoom: B(true) }),
        xTrace: O({
          values: A([], O({ time: NN, fromEndMs: NN })),
          maxTraces: I(4, 0, 8),
          infoBox: O({ visible: B(true), timeVisible: B(true) }),
          line: O({ color: S(''), width: N(1), dash: A([4, 2], NUM_ITEM) }),
        }),
        rangeBrush: O({
          values: A([], O({ id: S(''), start: NN, end: NN, plot: I(0) })),
          max: I(3, 1, 8), exactStats: B(true),
          active: O({ color: S(''), opacity: N(0.25) }),
          inactive: O({ color: S(''), opacity: N(0.12) }),
          controlLimits: O({ method: E('stdDev', ['stdDev', 'movingRange']), sigma: N(3, 0.5, 6) }),
        }),
      }),
      penTable: O({
        visible: B(true), collapsed: B(false), position: E('bottom', ['bottom', 'right']),
        size: I(30, 1, 2000), sizeUnit: E('%', ['%', 'px']),
        columns: O({
          current: B(true), minimum: B(true), maximum: B(true), average: B(true), xTrace: B(true),
          axis: B(false), plot: B(false), units: B(true), status: B(true),
        }),
        rangeColumns: O({
          first: B(true), last: B(true), delta: B(true), minimum: B(true), maximum: B(true), average: B(true),
          median: B(true), standardDeviation: B(true), sum: B(true), lcl: B(true), ucl: B(true), count: B(false),
        }),
        allowHide: B(true), allowColorChange: B(true), allowEdit: B(true), allowRemove: B(true), confirmRemove: B(true),
        style: STYLE,
      }),
      toolbar: O({
        visible: B(true), responsiveWidth: I(640, 0, 4000),
        buttons: O({
          dateRange: B(true), tagBrowser: B(true), xTrace: B(true), pan: B(true), zoom: B(true), rangeBrush: B(true),
          annotate: B(true), refresh: B(true), resetZoom: B(true), settings: B(true), export: B(true),
          fullscreen: B(true), refreshRate: B(false),
        }),
        style: STYLE,
      }),
      settingsPanel: O({
        enabled: B(true),
        tabs: O({ pens: B(true), axes: B(true), plots: B(true), columns: B(true) }),
        allowAddPen: B(true), allowEditTagPath: B(true),
      }),
      tagBrowser: O({
        // On by default (Power Chart parity). Browsing stays under the user's own permissions,
        // tagBrowser.rootPath, ctg.read.deniedProviders ([System]) and the read scope (all enforced by the gateway).
        enabled: B(true), rootPath: S(''), access: ACCESS(false),
        addTo: E('auto', ['auto', 'pens', 'trendList']), openOnStart: B(false), width: I(300, 200, 600),
      }),
      export: O({
        csv: O({
          enabled: B(true), layout: E('wide', ['wide', 'tall']), source: E('visible', ['visible', 'loaded', 'raw']),
          timeFormat: S('iso'), includeQuality: B(false),
        }),
        png: O({ enabled: B(true), scale: N(2, 1, 4), includeLegend: B(true) }),
        fileName: S('{title}_{start}'),
      }),
      annotations: O({
        enabled: B(false), visible: B(true),
        types: O({ note: B(true), range: B(true) }),
        edit: O({ enabled: B(false), ownOnly: B(true), access: ACCESS(true) }),
        moderate: O({ enabled: B(false), access: ACCESS(true) }),
        color: S(''),
      }),
      appearance: O({
        palette: A(['#2F7ED8', '#E8743B', '#19A979', '#ED4A7B', '#945ECF', '#13A4B4', '#BF8F00', '#6C8893', '#D15B47',
          '#4A6FE3'], STR_ITEM, 1),
        fontSize: N(11, 8, 24), liveBadge: B(true), extendToNow: B(true), breakOnGapMs: I(0, 0),
        emptyMessage: S(''), staleAfterMs: I(0, 0),
      }),
      outputs: O({
        range: O({ start: NN, end: NN, followLive: B(true) }),
        status: O({ state: S(''), message: S(''), lastUpdate: NN }),
        pens: A([], ANY_OBJ_ITEM),
      }),
      styles: O({ title: STYLE, toolbar: STYLE, plot: STYLE }),
      style: STYLE,
    });

    function clone(x) { return x == null || typeof x !== 'object' ? x : JSON.parse(JSON.stringify(x)); }

    /** Default value of a spec node (object nodes: assembled from their children). */
    function specDefault(spec) {
      if (spec.t === 'object') {
        var o = {};
        for (var k in spec.p) if (hasOwn.call(spec.p, k)) o[k] = specDefault(spec.p[k]);
        return o;
      }
      return clone(spec.d);
    }

    /** Epoch ms from a Date, a number, an object with getTime(), or an ISO / numeric string; else null. */
    function toEpochMs(x) {
      if (x == null) return null;
      if (typeof x === 'number') return isFinite(x) ? x : null;
      if (typeof x === 'object' && typeof x.getTime === 'function') {
        var t = x.getTime();
        return typeof t === 'number' && isFinite(t) ? t : null;
      }
      if (typeof x === 'string') {
        var s = x.trim();
        if (!s) return null;
        if (NS.util.NUMERIC_RE.test(s)) return Number(s);
        var p = Date.parse(s);
        return isFinite(p) ? p : null;
      }
      return null;
    }

    /** A panel-made item id (ctgId): short, URL-safe. */
    var ITEM_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
    function reduceNode(spec, raw) {
      switch (spec.t) {
        case 'object': {
          var src = NS.util.isPlainObject(raw) ? raw : {};
          var out = {};
          for (var k in spec.p) if (hasOwn.call(spec.p, k)) out[k] = reduceNode(spec.p[k], src[k]);
          return out;
        }
        case 'array': {
          if (!Array.isArray(raw)) return clone(spec.d);
          var arr = [];
          for (var i = 0; i < raw.length; i++) {
            var it = reduceItem(spec.item, raw[i]);
            if (it === undefined) continue;
            if (spec.item.t === 'object') {
              Object.defineProperty(it, 'index', { value: i, enumerable: false });
              // a stable item id the panels add when they create an item (plots, annotations): not part of the schema,
              // passed through unchanged so editors can follow that exact item whatever moves around it
              if (typeof raw[i].ctgId === 'string' && ITEM_ID_RE.test(raw[i].ctgId)) it.ctgId = raw[i].ctgId;
            }
            arr.push(it);
          }
          if (spec.minItems && arr.length < spec.minItems) return clone(spec.d);
          return arr;
        }
        case 'style':
          return NS.util.isPlainObject(raw) ? clone(raw) : clone(spec.d);
        case 'date':
          return toEpochMs(raw);
        case 'enum':
          return spec.values.indexOf(raw) >= 0 ? raw : spec.d;
        default:
          return NS.props.coerce(raw, {
            type: spec.t, default: spec.d, min: spec.min, max: spec.max, nullable: !!spec.nullable, maxLength: spec.maxLength,
          });
      }
    }

    /** One array item: objects are reduced over their item spec, scalars must coerce; anything else is dropped. */
    function reduceItem(item, raw) {
      if (item.t === 'object') return NS.util.isPlainObject(raw) ? reduceNode(item, raw) : undefined;
      if (item.t === 'any-object') return NS.util.isPlainObject(raw) ? clone(raw) : undefined;
      if (raw == null) return undefined;
      var v = NS.props.coerce(raw, { type: item.t, default: undefined });
      return v;
    }

    function deepFreeze(o) {
      if (o && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        Object.getOwnPropertyNames(o).forEach(function (k) { deepFreeze(o[k]); });
      }
      return o;
    }

    /** Stable JSON (sorted keys) for hashing. */
    function stableJson(x) {
      if (x === undefined) return 'null';
      if (x === null || typeof x !== 'object') return JSON.stringify(x);
      if (Array.isArray(x)) return '[' + x.map(stableJson).join(',') + ']';
      return '{' + Object.keys(x).sort().map(function (k) { return JSON.stringify(k) + ':' + stableJson(x[k]); }).join(',') + '}';
    }

    /**
     * The render-affecting and the data-affecting subsets of the props. The engine
     * compares finer slices itself (window, query, refresh rate, pen data fields).
     */
    function propHashes(p) {
      var penData = p.pens.map(function (pen) { return [pen.tagPath, pen.enabled, pen.aggregation, pen.index]; });
      var penLook = p.pens.map(function (pen) {
        return [pen.display, pen.axis, pen.plot, pen.color, pen.visible, pen.name, pen.units, pen.format];
      });
      return {
        dataHash: stableJson([penData, p.trendGroup, p.timeRange, p.query]),
        structuralHash: stableJson([penLook, p.axes, p.plots, p.timeAxis, p.appearance, p.trendPens]),
      };
    }

    /**
     * reduceProps(source): source is a Perspective PropertyTree (read(key)) or a plain object of raw props
     * (tests, bindings). Returns the frozen reduced props.
     */
    /**
     * v1 prop signature (the migrator's classify() rules, tools/migrate-v1-views.mjs): a v1-only root,
     * interaction.xTraceVisible, or interaction.mode panAndZoom / selection. A v2 `interaction` object alone is no
     * signature. Returns the v1 keys found ([] for a v2 view).
     */
    var CHART_V1_ROOTS = ['mode', 'rangeHours', 'pointCount', 'rawHistory', 'freeRangePanZoom', 'refreshRate',
      'startDate', 'endDate', 'dateFormat', 'timeFormat', 'visibility'];
    function chartV1Keys(read) {
      var out = [];
      CHART_V1_ROOTS.forEach(function (k) { if (read(k) !== undefined) out.push(k); });
      var ix = read('interaction');
      if (ix && typeof ix === 'object') {
        if (ix.xTraceVisible !== undefined) out.push('interaction.xTraceVisible');
        if (ix.mode === 'panAndZoom' || ix.mode === 'selection') out.push('interaction.mode');
      }
      return out;
    }
    function reduceProps(source) {
      var read = source && typeof source.read === 'function'
        ? function (k) { try { return source.read(k); } catch (e) { return undefined; } }
        : function (k) { return source && NS.util.isPlainObject(source) ? source[k] : undefined; };
      var out = {};
      for (var k in SPEC.p) if (hasOwn.call(SPEC.p, k)) out[k] = reduceNode(SPEC.p[k], read(k));
      Object.defineProperty(out, 'v1Keys', { value: chartV1Keys(read), enumerable: false });

      // Semantic clamps beyond the schema bounds.
      var rr = out.timeRange.refreshRate;
      out.timeRange.refreshRate = rr === 0 ? 0 : Math.max(250, rr);                 // 0 = off, else at least 250 ms
      var pc = out.query.pointCount;
      out.query.pointCount = pc === 0 ? 0 : Math.max(10, pc);                         // 0 = auto
      out.pens.forEach(function (pen) { pen.tagPath = pen.tagPath.trim(); });

      var hashes = propHashes(out);
      Object.defineProperty(out, 'dataHash', { value: hashes.dataHash, enumerable: false });
      Object.defineProperty(out, 'structuralHash', { value: hashes.structuralHash, enumerable: false });
      return deepFreeze(out);
    }

    var DEFAULTS = deepFreeze(specDefault(SPEC));

    /* ========================================================================
     * SECTION 3 / windows and query planning
     * ----------------------------------------------------------------------
     * The bucket ladder is the gateway's (BucketLadder.java): the snapshot's
     * limits.bucketLadder when present, else this client copy (same values;
     * chart-plan.test.mjs compares it with the Java source). Above 1 day every
     * whole number of days is a step. computeBucket() is a line-by-line port
     * of HistoryRequest.computeBucket so the bucketMs the client plans is the
     * one the gateway accepts for its incremental ticks.
     * ====================================================================== */
    var LADDER = [100, 200, 250, 500,
      SECOND, 2 * SECOND, 5 * SECOND, 10 * SECOND, 15 * SECOND, 30 * SECOND,
      MINUTE, 2 * MINUTE, 5 * MINUTE, 10 * MINUTE, 15 * MINUTE, 30 * MINUTE,
      HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY];

    /**
     * Gateway limits with the documented defaults for every field a (skeleton) snapshot may omit.
     * historyTimeoutMs = the gateway's history query deadline (ctg.history.timeoutMs); a gateway that does not
     * send it gets the documented default of 15 s.
     * historyBurst = requests one history token may start back to back before the minIntervalMs refill
     * applies (the gateway's token bucket); an older gateway that does not send it gets 1 = the fixed interval.
     */
    var LIMIT_DEFAULTS = {
      maxPens: 32, pointCountMin: 10, pointCountMax: 5000, maxRawPointsPerPen: 250000, maxPointsPerResponse: 500000,
      maxRangeDays: 400, maxRawRangeDays: 31, minIntervalMs: 200, minBucketMs: 100, maxConcurrentPerSession: 4,
      historyTimeoutMs: 15000, historyBurst: 1,
    };
    function effectiveLimits(raw) {
      var L = {};
      for (var k in LIMIT_DEFAULTS) {
        var v = raw && raw[k];
        L[k] = typeof v === 'number' && isFinite(v) && v >= 0 ? v : LIMIT_DEFAULTS[k];
      }
      var lad = raw && raw.bucketLadder;
      var ok = Array.isArray(lad) && lad.length > 0 && lad.every(function (x, i) {
        return typeof x === 'number' && isFinite(x) && x > 0 && (i === 0 || x > lad[i - 1]);
      });
      L.bucketLadder = ok ? lad.slice() : LADDER.slice();
      return L;
    }

    /** Smallest ladder step >= ms and >= minBucketMs (BucketLadder.niceAtLeast). */
    function niceBucket(ms, minBucketMs, ladder) {
      var lad = ladder || LADDER;
      var want = Math.max(Math.max(1, Math.ceil(ms)), minBucketMs || 0);
      if (want > DAY) return Math.ceil(want / DAY) * DAY;
      for (var i = 0; i < lad.length; i++) if (lad[i] >= want) return lad[i];
      return DAY;
    }
    /** Next ladder step strictly greater than step (BucketLadder.next). */
    function nextBucket(step, ladder) {
      var lad = ladder || LADDER;
      if (step >= DAY) return (Math.floor(step / DAY) + 1) * DAY;
      for (var i = 0; i < lad.length; i++) if (lad[i] > step) return lad[i];
      return 2 * DAY;
    }
    function alignDown(t, b) { return Math.floor(t / b) * b; }
    function ceilDiv(a, b) { return Math.ceil(a / b); }

    /** HistoryRequest.computeBucket: pointCount buckets over [start,end], widened until the aligned window fits. */
    function computeBucket(start, end, dataEnd, pointCount, minBucketMs, maxBuckets, ladder) {
      var b = niceBucket(ceilDiv(end - start, Math.max(1, pointCount)), minBucketMs, ladder);
      var guard = 0;
      while (ceilDiv(Math.max(0, alignDown(dataEnd, b) - alignDown(start, b)), b) > maxBuckets && guard++ < 100) {
        b = nextBucket(b, ladder);
      }
      return b;
    }

    /**
     * The configured window. now = gateway ms; loadTime = gateway ms when the load started
     * (historical "end = now at load time"). Returns {start, end, span, mode, clampedDays|0} or {error}.
     */
    function configWindow(p, now, tz, limits, loadTime) {
      var L = limits || effectiveLimits(null);
      var tr = p.timeRange;
      var start, end;
      if (tr.mode === 'historical') {
        var e0 = tr.historical.endDate != null ? tr.historical.endDate : (loadTime != null ? loadTime : now);
        end = Math.min(e0, now);
        start = tr.historical.startDate != null ? tr.historical.startDate : end - 8 * HOUR;
        if (!(start < end)) return { error: 'RANGE_INVALID', mode: 'historical' };
      } else {
        end = now;
        start = NS.time.subtractCalendar(end, tr.realtime.value, tr.realtime.unit, tz);
        if (!isFinite(start) || start >= end) start = end - 8 * HOUR;
      }
      if (end - start < SECOND) start = end - SECOND;                    // the gateway refuses spans under 1 s
      var clampedDays = 0;
      var maxSpan = L.maxRangeDays * DAY;
      if (end - start > maxSpan) { start = end - maxSpan; clampedDays = L.maxRangeDays; }
      return { start: Math.floor(start), end: Math.floor(end), span: Math.floor(end) - Math.floor(start), mode: tr.mode, clampedDays: clampedDays };
    }

    /** Effective point count: query.pointCount, or the plot width (0 = auto), within the gateway's bounds. */
    function plannedPointCount(p, plotWidthPx, L) {
      var pc = p.query.pointCount === 0
        ? NS.util.clamp(Math.round(plotWidthPx > 0 ? plotWidthPx : 1000), 100, 2000)
        : p.query.pointCount;
      return NS.util.clamp(pc, L.pointCountMin, L.pointCountMax);
    }

    /**
     * planQuery: request parameters for one window. Returns
     * {start, end, mode, aggregation, pointCount, bucketMs, onTooManyPoints, includeAnchor, maxPointsPerPen}
     * or {error, days}. `now` bounds the data end the gateway will use (dataEnd = min(end, now)).
     */
    function planQuery(p, win, plotWidthPx, limits, now) {
      var L = limits || effectiveLimits(null);
      var q = p.query;
      var span = win.end - win.start;
      var pc = plannedPointCount(p, plotWidthPx, L);
      var dataEnd = Math.min(win.end, now != null ? now : win.end);
      var bms = computeBucket(win.start, win.end, dataEnd, pc, L.minBucketMs, L.pointCountMax, L.bucketLadder);
      var mode = q.mode === 'raw' ? 'raw'
        : q.mode === 'aggregated' ? 'aggregated'
          : (q.autoRawBelowBucketMs > 0 && bms < q.autoRawBelowBucketMs && autoRawAllowed(p) ? 'raw' : 'aggregated');
      var aggregateFallback = q.onTooManyPoints === 'aggregate';
      var downgraded = false;
      if (mode === 'raw' && span > L.maxRawRangeDays * DAY) {
        if (q.mode === 'auto') mode = 'aggregated';
        else if (!aggregateFallback) return { error: 'RAW_RANGE_TOO_LARGE', days: L.maxRawRangeDays };
        else {
          // raw too long + onTooManyPoints "aggregate": planned aggregated here, with the
          // notice. Sending it raw would be chunked into <= 1 d pieces that each pass the gateway's
          // maxRawRangeDays check, so the gateway's own downgrade would never happen.
          mode = 'aggregated';
          downgraded = true;
        }
      }
      return {
        start: win.start, end: win.end, mode: mode, aggregation: q.aggregation, pointCount: pc,
        bucketMs: mode === 'aggregated' ? bms : null,
        onTooManyPoints: mode === 'raw' && aggregateFallback ? 'aggregate' : 'error',
        includeAnchor: q.includeAnchor,
        maxPointsPerPen: Math.min(q.maxPointsPerPen, L.maxRawPointsPerPen),
        downgraded: downgraded, rawDays: downgraded ? L.maxRawRangeDays : 0,
      };
    }

    /**
     * Raw chunk plan: chunk width from rawChunk or auto (smallest of 1 h / 6 h / 1 d giving
     * <= 50 chunks), boundaries on epoch multiples so chunk requests hit the gateway's raw chunk cache,
     * newest chunk first. Edge pieces shorter than 1 s (the gateway's minimum span) join their neighbour.
     * Never more than MAX_CHUNKS requests: an explicit rawChunk that would need more is widened to the next
     * ladder size (or whole days) that fits.
     */
    var CHUNK_SIZES = { '1h': HOUR, '6h': 6 * HOUR, '1d': DAY };
    var MAX_CHUNKS = 50;
    function chunkPlan(start, end, rawChunk) {
      var slots = function (w) { return Math.ceil((end - alignDown(start, w)) / w); };
      var c = CHUNK_SIZES[rawChunk] || HOUR;
      if (slots(c) > MAX_CHUNKS) {
        var sizes = [HOUR, 6 * HOUR, DAY], found = 0;
        for (var i = 0; i < sizes.length; i++) if (sizes[i] >= c && slots(sizes[i]) <= MAX_CHUNKS) { found = sizes[i]; break; }
        if (!found) { found = ceilDiv(end - start, (MAX_CHUNKS - 1) * DAY) * DAY; while (slots(found) > MAX_CHUNKS) found += DAY; }
        c = found;
      }
      var out = [];
      for (var k = alignDown(start, c); k < end; k += c) {
        out.push({ start: Math.max(start, k), end: Math.min(end, k + c) });
      }
      // merge sub-second pieces into their neighbour
      for (var j = 0; j < out.length && out.length > 1; j++) {
        if (out[j].end - out[j].start < SECOND) {
          if (j > 0) { out[j - 1].end = out[j].end; out.splice(j, 1); j--; } else { out[1].start = out[0].start; out.splice(0, 1); j--; }
        }
      }
      out.reverse();
      return { chunkMs: c, chunks: out };
    }

    /**
     * ADAPTIVE raw chunks (rawChunk "auto"). Fixed one-hour chunks would make a 27 h raw load 28
     * requests, serialised by the gateway's per-token interval (~10 s in total). Instead:
     *   1. a PROBE chunk first: the newest whole hour slot, widened to the previous hour boundary when that slot
     *      is shorter than CHUNK.probeMinMs (a 5 s probe says nothing about the density) — the newest data is
     *      drawn at once, as with fixed chunks;
     *   2. every further chunk is as wide as the data allows: the expected points per pen approach but do not
     *      exceed CHUNK.fill x the per-pen cap (maxPointsPerPen), and the expected points of all pens together
     *      stay under CHUNK.fill x the gateway's per-response cap (maxPointsPerResponse). The density is
     *      re-measured after every chunk (points loaded / span loaded, per pen), so a sparse probe that is
     *      followed by dense data corrects itself on the next chunk.
     * Widths are whole multiples of the gateway's raw cache geometry for that width (1 h up to 50 h, 6 h up to
     * 300 h, else 1 d) and chunk edges sit on multiples of it, so sealed pieces keep hitting the gateway cache.
     * A last piece shorter than a quarter of the width joins the chunk before it (at most 1.25 x fill <= the cap).
     * If a chunk still overflows the per-response cap (the density changed a lot), the engine splits it for the
     * refused pens (_runChunks); that never needs the per-pen cap, because a chunk over the per-pen cap means
     * the pen's whole window is over it as well (the cap applies to the sum of the chunks).
     */
    var CHUNK = { probeMs: HOUR, probeMinMs: 15 * MINUTE, fill: 0.8, maxSplitDepth: 6, minSplitMs: 10 * SECOND,
      timeoutSplitDepth: 3, unknownLimitSplitDepth: 2 };

    /** Gateway raw cache geometry for a request of width w (HistoryChunkCache: 1 h / 6 h / 1 d, <= 50 chunks). */
    function chunkUnit(w) { return w <= 50 * HOUR ? HOUR : w <= 300 * HOUR ? 6 * HOUR : DAY; }

    /**
     * Halves of a piece that has to be asked again in smaller parts (response-cap refusal, timeout): newer half
     * first. The middle sits on the cache unit of the half width when that leaves both halves non-empty.
     */
    function splitPiece(pc, keys) {
      var half = (pc.end - pc.start) / 2;
      var u = chunkUnit(half);
      var mid = alignDown(pc.start + half, u);
      if (mid <= pc.start || mid >= pc.end) mid = Math.floor(pc.start + half);
      return [{ start: mid, end: pc.end, keys: keys, depth: pc.depth + 1, why: pc.why },
        { start: pc.start, end: mid, keys: keys, depth: pc.depth + 1, why: pc.why }];
    }
    /** A timed-out piece is split when it is wider than one gateway cache unit (adaptive pieces can be days wide). */
    function timeoutSplittable(pc) {
      var w = pc.end - pc.start;
      return w > chunkUnit(w) && (pc.depth || 0) < CHUNK.timeoutSplitDepth;
    }
    /**
     * Kind of a pen's tooManyPoints in a chunk response: 'response' (the whole answer would exceed
     * maxPointsPerResponse: split the piece), 'pen' (this pen is over its cap), 'unknown' (a limit the client does
     * not mirror: stale limits; split a little, then believe the gateway). A limit equal to BOTH caps is taken as
     * 'response': splitting is always correct (the running total still enforces the per-pen cap), only slower.
     */
    function refusalKind(limit, cap, responseCap) {
      if (limit == null) return 'pen';
      if (responseCap > 0 && limit === responseCap) return 'response';
      if (limit === cap) return 'pen';
      return 'unknown';
    }

    /** The probe chunk of an adaptive plan: [start', end] with start' on an hour boundary (or the window start). */
    function probeChunk(start, end) {
      var s = alignDown(end, CHUNK.probeMs);
      if (end - s < CHUNK.probeMinMs) s = alignDown(end - CHUNK.probeMinMs, CHUNK.probeMs);
      if (s - start < SECOND) s = start;                   // nothing (or a sub-second sliver) left: one request
      return { start: Math.max(start, s), end: end };
    }

    /**
     * Width (ms) of the next adaptive chunk.
     *   densities  points per ms of each pen still loading (measured so far; 0 = no sample yet)
     *   cap        per-pen points of one request (the client cap sent as maxPointsPerPen)
     *   responseCap the gateway's maxPointsPerResponse
     *   remaining  ms still to load
     */
    function adaptiveChunkWidth(densities, cap, responseCap, remaining) {
      var maxD = 0, sumD = 0;
      (densities || []).forEach(function (d) { if (d > 0 && isFinite(d)) { maxD = Math.max(maxD, d); sumD += d; } });
      var w = remaining;
      if (maxD > 0 && cap > 0) w = Math.min(w, CHUNK.fill * cap / maxD);
      if (sumD > 0 && responseCap > 0) w = Math.min(w, CHUNK.fill * responseCap / sumD);
      var u = chunkUnit(w);
      return w >= remaining ? remaining : Math.max(u, Math.floor(w / u) * u);
    }

    /**
     * Next adaptive chunk below `edge` (the oldest loaded boundary) for the window starting at `start`:
     * {start, end, oldest}. Its start sits on a multiple of the width's cache unit, rounded so the chunk is not
     * wider than `width` — unless that would leave a sliver (< 1/4 width) at the edge, or a short remainder
     * (< 1/4 width) before the window start: those join the chunk (at most 1.25 x width).
     */
    function nextAdaptiveChunk(start, edge, width) {
      var s;
      if (width >= edge - start) {
        s = start;
      } else {
        var u = chunkUnit(width);
        s = Math.ceil((edge - width) / u) * u;
        if (edge - s < 0.25 * width) s -= u;
        s = Math.max(start, s);
        if (s - start < 0.25 * width || s - start < SECOND) s = start;
      }
      return { start: s, end: edge, oldest: s <= start };
    }

    /**
     * Free-range re-query rule: true when the new viewport [a, b] needs another load —
     * (1) [a - 10 %, b + 10 %] (right edge capped at now) leaves the loaded coverage, or (2) the ideal bucket
     * for the new span differs from the coverage bucket by a factor >= 2, or the auto raw/aggregated decision
     * flips. followLive: a view that follows live over a live coverage never fails on its right edge —
     * ticks extend the coverage forward, and the coverage end (the last tick's end) is always before `now`, so
     * otherwise every zoom / pan / Return to live that stayed live would reload the whole window.
     */
    function needsRequery(a, b, cov, p, plotWidthPx, limits, now, followLive) {
      if (!cov) return true;
      var L = limits || effectiveLimits(null);
      var span = b - a;
      var lo = a - 0.1 * span;
      var hi = Math.min(b + 0.1 * span, now != null ? now : b + 0.1 * span);
      if (followLive && cov.live) hi = Math.min(hi, cov.end);
      if (lo < cov.start || hi > cov.end) return true;
      var pc = plannedPointCount(p, plotWidthPx, L);
      var ideal = niceBucket(span / pc, L.minBucketMs, L.bucketLadder);
      if (p.query.mode === 'auto') {
        var wantRaw = p.query.autoRawBelowBucketMs > 0 && ideal < p.query.autoRawBelowBucketMs && autoRawAllowed(p);
        if (wantRaw !== (cov.mode === 'raw')) return true;
      }
      if (cov.mode === 'aggregated' && cov.bucketMs) {
        if (ideal >= 2 * cov.bucketMs || ideal * 2 <= cov.bucketMs) return true;
      }
      return false;
    }

    /** Wheel/zoom span bounds: min max(1 s, 10 x minBucketMs), max the gateway range limit. */
    function clampSpan(span, mode, limits) {
      var L = limits || effectiveLimits(null);
      var min = Math.max(SECOND, 10 * L.minBucketMs);
      var max = (mode === 'raw' ? L.maxRawRangeDays : L.maxRangeDays) * DAY;
      return NS.util.clamp(span, min, max);
    }

    /* ========================================================================
     * SECTION 4 / series views and the k-way merge
     * ----------------------------------------------------------------------
     * penView(pd) is what one pen contributes to a plot, in DRAW time:
     *   anchor (last sample before the window) + history + live buffer
     *   (realtime only) + optional gap breaks. Values: number, or null = bad
     *   quality (a gap uPlot honours when the series does not span gaps).
     * Aggregated rows arrive stamped with their bucket START (window.
     * bucketTime "start"). They are drawn where the value
     * belongs (bucketShift): a LastValue bucket at its END (its value is the
     * last sample in the bucket, so it lines up with raw data), every other
     * aggregate at the bucket MIDDLE (a statistic of the whole bucket). MinMax
     * delivers two rows per bucket with the same stamp: the second
     * is drawn 1 ms later so x stays strictly increasing.
     * joinPlot() merges the pens of one plot into uPlot's [x, y1, y2, …]
     * with a binary heap over k cursors (O(N log k)); a pen without a sample
     * at some x gets `undefined` there (uPlot connects across it), never
     * null — uPlot's gap finder tests `null ===` strictly.
     * ====================================================================== */
    var BUCKET_ALIGN = { mode: 'auto' };   // 'auto' (above) | 'start' | 'mid' | 'end' — test harness knob

    /** Draw-time offset for rows of an aggregated coverage. */
    function bucketShift(cov) {
      if (!cov || cov.mode !== 'aggregated' || !(cov.bucketMs > 0)) return 0;
      var b = cov.bucketMs;
      var stamped = cov.bucketTime === 'end' ? b : cov.bucketTime === 'mid' ? b / 2 : 0;
      var want;
      switch (BUCKET_ALIGN.mode) {
        case 'start': want = 0; break;
        case 'mid': want = b / 2; break;
        case 'end': want = b; break;
        default: want = cov.aggregation === 'LastValue' ? b : b / 2;
      }
      return want - stamped;
    }

    function lowerBound(arr, x) {          // first index with arr[i] >= x
      var lo = 0, hi = arr.length;
      while (lo < hi) { var mid = (lo + hi) >>> 1; if (arr[mid] < x) lo = mid + 1; else hi = mid; }
      return lo;
    }
    function upperBound(arr, x) {          // first index with arr[i] > x
      var lo = 0, hi = arr.length;
      while (lo < hi) { var mid = (lo + hi) >>> 1; if (arr[mid] <= x) lo = mid + 1; else hi = mid; }
      return lo;
    }

    /**
     * One pen's samples in draw time: {t, v, base}. opts: {live: include the live buffer, breakOnGapMs}.
     * Strictly increasing t is enforced here (defensive: a duplicate or out-of-order sample is skipped).
     * Cached on the PenData by revision, so repeated joins/stats cost nothing.
     */
    function penView(pd, opts) {
      var live = !!(opts && opts.live);
      var gap = (opts && opts.breakOnGapMs) || 0;
      var ck = pd.rev + '|' + pd.liveRev + '|' + (live ? 1 : 0) + '|' + gap;
      if (pd._view && pd._viewKey === ck) return pd._view;
      var t = [], v = [];
      var last = -Infinity;
      var push = function (tt, vv) { if (tt > last) { t.push(tt); v.push(vv); last = tt; } };
      if (pd.anchor && (!pd.t.length || pd.anchor.t < pd.t[0])) push(pd.anchor.t, pd.anchor.v);
      var shift = bucketShift(pd.coverage);
      var pairs = pd.coverage && pd.coverage.mode === 'aggregated';
      for (var i = 0; i < pd.t.length; i++) {
        var tt = pd.t[i] + shift;
        if (pairs && i > 0 && pd.t[i] === pd.t[i - 1]) tt += 1;           // MinMax second row: +1 ms
        push(tt, pd.v[i]);
      }
      if (live) {
        var lt = pd.live.t, lv = pd.live.v;
        for (var j = upperBound(lt, last); j < lt.length; j++) push(lt[j], lv[j]);
      }
      if (gap > 0 && t.length > 1) {
        var gt = [t[0]], gv = [v[0]];
        for (var k = 1; k < t.length; k++) {
          if (t[k] - t[k - 1] > gap) { gt.push((t[k] + t[k - 1]) / 2); gv.push(null); }
          gt.push(t[k]); gv.push(v[k]);
        }
        t = gt; v = gv;
      }
      pd._view = { t: t, v: v, base: pd.baseRev };
      pd._viewKey = ck;
      return pd._view;
    }

    /** k-way merge of views[i].t from index from[i] (all > xl) into x/ys (appending). */
    function kmergeInto(views, from, x, ys) {
      var k = views.length;
      if (k === 1) {
        var t0 = views[0].t, v0 = views[0].v;
        for (var a = from[0]; a < t0.length; a++) { x.push(t0[a]); ys[0].push(v0[a]); }
        return;
      }
      var pos = from.slice();
      var heap = [];
      var key = function (i) { return views[i].t[pos[i]]; };
      var up = function (n) {
        while (n > 0) {
          var p = (n - 1) >> 1;
          if (key(heap[p]) <= key(heap[n])) break;
          var tmp = heap[p]; heap[p] = heap[n]; heap[n] = tmp; n = p;
        }
      };
      var down = function (n) {
        for (;;) {
          var l = 2 * n + 1, r = l + 1, m = n;
          if (l < heap.length && key(heap[l]) < key(heap[m])) m = l;
          if (r < heap.length && key(heap[r]) < key(heap[m])) m = r;
          if (m === n) break;
          var tmp = heap[m]; heap[m] = heap[n]; heap[n] = tmp; n = m;
        }
      };
      for (var i = 0; i < k; i++) if (pos[i] < views[i].t.length) { heap.push(i); up(heap.length - 1); }
      while (heap.length) {
        var t = key(heap[0]);
        var row = x.length;
        x.push(t);
        for (var c = 0; c < k; c++) ys[c].push(undefined);
        while (heap.length && key(heap[0]) === t) {
          var j = heap[0];
          ys[j][row] = views[j].v[pos[j]];
          pos[j]++;
          if (pos[j] < views[j].t.length) down(0);
          else { var lastI = heap.pop(); if (heap.length) { heap[0] = lastI; down(0); } }
        }
      }
    }

    /** Full join of views into {x, ys}. */
    function joinViews(views) {
      var x = [], ys = views.map(function () { return []; });
      kmergeInto(views, views.map(function () { return 0; }), x, ys);
      return { x: x, ys: ys };
    }

    /**
     * Incremental join for one plot (fast path). update() appends in place when every
     * pen only gained samples after the last joined x (the normal realtime tick) and trims the left edge with
     * one splice per column; anything else (a new pen order, a replaced history, a bucket re-fetch) is a full
     * join. `now` adds the synthetic live point as the last row; it is removed before the next
     * update and never counted as data (stats, CSV).
     */
    function PlotJoin() { this.reset(); }
    PlotJoin.prototype.reset = function () {
      this.x = null; this.ys = null; this.sig = ''; this.base = []; this.lastT = []; this.synthetic = -1;
      this.fullJoins = 0; this.fastJoins = 0;
    };
    /**
     * Left edge after the store trimmed pens: a pen's cells before its (new) first sample are cleared, and
     * rows left without any sample are removed. Only the rows before the latest per-pen cut are visited
     * (normally the few trimmed rows).
     */
    PlotJoin.prototype._trimLeft = function (views) {
      var x = this.x, ys = this.ys;
      var cuts = views.map(function (v) { return v.t.length ? lowerBound(x, v.t[0]) : x.length; });
      var hiCut = Math.max.apply(null, cuts.concat([0]));
      if (!hiCut) return;
      var w = 0;
      for (var r = 0; r < hiCut; r++) {
        var any = false;
        for (var i = 0; i < ys.length; i++) {
          if (r < cuts[i]) ys[i][r] = undefined;
          else if (ys[i][r] !== undefined) any = true;
        }
        if (any) {
          if (w !== r) { x[w] = x[r]; for (var c = 0; c < ys.length; c++) ys[c][w] = ys[c][r]; }
          w++;
        }
      }
      if (w < hiCut) {
        x.splice(w, hiCut - w);
        ys.forEach(function (col) { col.splice(w, hiCut - w); });
      }
    };
    PlotJoin.prototype._full = function (views, sig) {
      var j = joinViews(views);
      this.x = j.x; this.ys = j.ys; this.sig = sig;
      this.fullJoins++;
    };
    /**
     * @param views  penView() results in column order
     * @param sig    identity of the pen set/order (+ view options)
     * @param nowPoint null | {t, values: [v|undefined per pen]} — synthetic hold point
     */
    PlotJoin.prototype.update = function (views, sig, nowPoint) {
      var self = this;
      if (this.synthetic >= 0 && this.x) {
        this.x.length = this.synthetic;
        this.ys.forEach(function (col) { col.length = self.synthetic; });
        this.synthetic = -1;
      }
      var fast = !!this.x && sig === this.sig && views.length === this.ys.length;
      var from = [];
      if (fast) {
        var xl = this.x.length ? this.x[this.x.length - 1] : -Infinity;
        for (var i = 0; i < views.length && fast; i++) {
          var vt = views[i].t;
          if (views[i].base !== this.base[i]) { fast = false; break; }
          var lt = this.lastT[i];
          var f = lt == null ? 0 : upperBound(vt, lt);
          if (lt != null && (f === 0 || vt[f - 1] !== lt)) { fast = false; break; }     // consumed samples vanished
          if (f < vt.length && vt[f] <= xl) { fast = false; break; }                      // new sample inside the joined range
          from.push(f);
        }
      }
      if (fast) {
        kmergeInto(views, from, this.x, this.ys);
        this._trimLeft(views);
        this.fastJoins++;
      } else {
        this._full(views, sig);
      }
      this.base = views.map(function (v) { return v.base; });
      this.lastT = views.map(function (v) { return v.t.length ? v.t[v.t.length - 1] : null; });
      if (nowPoint && (!this.x.length || nowPoint.t > this.x[this.x.length - 1])) {
        this.synthetic = this.x.length;
        this.x.push(nowPoint.t);
        for (var c = 0; c < this.ys.length; c++) this.ys[c].push(nowPoint.values[c]);
      }
      return { x: this.x, ys: this.ys, synthetic: this.synthetic };
    };

    /* ========================================================================
     * SECTION 5 / statistics
     * ----------------------------------------------------------------------
     * Sample-and-hold semantics (the historian's convention for on-change
     * data): the value held at `a` (last sample before a, incl. the anchor)
     * enters as a boundary sample AT a. A null (bad quality) sample ends a
     * segment; the time until the next good sample leaves the average's
     * denominator. Only real samples count: the synthetic "now" point never
     * reaches these functions — `lastKnownTime` extends the last segment
     * instead (now when following live, else the last sample).
     * ====================================================================== */
    /** Index of the last sample with t <= x, or -1. */
    function lastAtOrBefore(t, x) { return upperBound(t, x) - 1; }

    /** Value held at time x (last sample <= x; null when that sample is bad); undefined when none. */
    function heldAt(view, x) {
      var i = lastAtOrBefore(view.t, x);
      return i < 0 ? undefined : view.v[i];
    }

    /**
     * statsFor(view, a, b, opts) -> {first, last, delta, minimum, maximum, average, median, standardDeviation,
     * sum, lcl, ucl, count, approx} (null where undefined). opts: {lastKnownTime, approx, sigma (3),
     * method ('stdDev'|'movingRange'), median (true: compute the median, sorts a copy), pairs}.
     * pairs: the view holds MinMax pairs (penView draws a bucket's second row 1 ms after the first);
     * for the time-weighted average a pair counts as ONE bucket at the mean of its two rows. Otherwise the first
     * row would hold for 1 ms and the second for the whole bucket, and Avg would lean toward each bucket's later extreme.
     * lastKnownTime: how long the last value is known to have held (now when following live, else the end of the
     * data the historian answered for); null = until the last sample.
     */
    function statsFor(view, a, b, opts) {
      var o = opts || {};
      var t = view.t, v = view.v;
      var res = { first: null, last: null, delta: null, minimum: null, maximum: null, average: null, median: null,
        standardDeviation: null, sum: null, lcl: null, ucl: null, count: 0, approx: !!o.approx };
      if (!(b >= a)) return res;
      var i0 = lowerBound(t, a);                 // first sample >= a
      var i1 = upperBound(t, b);                 // first sample > b
      var held = i0 > 0 ? v[i0 - 1] : undefined;
      var hasHeld = i0 > 0 && t[i0 - 1] < a;
      // segment sequence: boundary sample at a (held), then in-range samples
      var segT = [], segV = [];
      if (hasHeld) { segT.push(a); segV.push(held); }
      var vals = [];
      var min = Infinity, max = -Infinity, sum = 0, mr = 0, mrN = 0, prev = null;
      if (hasHeld && typeof held === 'number') { min = Math.min(min, held); max = Math.max(max, held); }
      for (var i = i0; i < i1; i++) {
        segT.push(t[i]); segV.push(v[i]);
        var x = v[i];
        if (typeof x === 'number' && isFinite(x)) {
          vals.push(x); sum += x;
          if (x < min) min = x;
          if (x > max) max = x;
          if (prev !== null) { mr += Math.abs(x - prev); mrN++; }
          prev = x;
        }
      }
      res.count = vals.length;
      var firstV = hasHeld ? held : (i0 < i1 ? v[i0] : undefined);
      var lastV = i1 > i0 ? v[i1 - 1] : (hasHeld ? held : undefined);
      res.first = typeof firstV === 'number' ? firstV : null;
      res.last = typeof lastV === 'number' ? lastV : null;
      res.delta = res.first != null && res.last != null ? res.last - res.first : null;
      if (min !== Infinity) { res.minimum = min; res.maximum = max; }
      // time-weighted average over good segments
      var end = o.lastKnownTime != null ? Math.min(b, o.lastKnownTime) : (segT.length ? segT[segT.length - 1] : a);
      var num = 0, den = 0;
      for (var s = 0; s < segT.length; s++) {
        var s0 = segT[s];
        var sv = segV[s];
        var nx = s + 1;
        if (o.pairs && nx < segT.length && segT[nx] - s0 === 1 && typeof sv === 'number' && isFinite(sv) &&
            typeof segV[nx] === 'number' && isFinite(segV[nx])) {
          sv = (sv + segV[nx]) / 2;                                          // a MinMax pair: one bucket
          nx = s + 2;
          s++;
        }
        var s1 = Math.min(nx < segT.length ? segT[nx] : end, end);          // never past what is known
        if (typeof sv !== 'number' || !isFinite(sv)) continue;
        var dt = s1 - s0;
        if (dt > 0) { num += sv * dt; den += dt; }
      }
      if (den > 0) res.average = num / den;
      else {
        // a single instant (no duration): plain mean of what there is
        var good = segV.filter(function (x2) { return typeof x2 === 'number' && isFinite(x2); });
        if (good.length) res.average = good.reduce(function (p2, c2) { return p2 + c2; }, 0) / good.length;
      }
      if (vals.length) {
        var mean = sum / vals.length;
        var sq = 0;
        for (var k = 0; k < vals.length; k++) sq += (vals[k] - mean) * (vals[k] - mean);
        var sd = Math.sqrt(sq / vals.length);                          // population σ
        res.sum = sum;
        res.standardDeviation = sd;
        var kSig = o.sigma != null ? o.sigma : 3;
        var spread = o.method === 'movingRange' ? (mrN ? (mr / mrN) / 1.128 : 0) : sd;
        res.lcl = mean - kSig * spread;
        res.ucl = mean + kSig * spread;
        if (o.median !== false) {
          var sorted = Float64Array.from(vals).sort();
          var m = sorted.length >> 1;
          res.median = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
        }
      }
      return res;
    }

    /**
     * valueAt(view, x, kind): the pen's value at time x for X-Trace.
     * kind 'linear': interpolate between good neighbours (not across a null); 'step': held value (stepAfter);
     * 'before' (stepBefore): the NEXT sample's value between two samples; 'center' (stepCenter): the value
     * changes half-way, i.e. the nearer sample; 'nearest' (scatter/bar): the nearest sample within `tolerance` ms.
     * Outside the data: undefined.
     */
    function valueAt(view, x, kind, tolerance) {
      var t = view.t, v = view.v;
      if (!t.length || x < t[0] - (kind === 'nearest' ? (tolerance || 0) : 0)) return undefined;
      var i = lastAtOrBefore(t, x);
      if (kind === 'nearest') {
        var best = -1, bd = Infinity;
        [i, i + 1].forEach(function (j) {
          if (j >= 0 && j < t.length && Math.abs(t[j] - x) < bd) { bd = Math.abs(t[j] - x); best = j; }
        });
        return best >= 0 && bd <= (tolerance || 0) ? v[best] : undefined;
      }
      if (i < 0) return undefined;
      if (t[i] === x || kind === 'step') return v[i];
      if (kind === 'center') return i + 1 < t.length && t[i + 1] - x < x - t[i] ? v[i + 1] : v[i];
      if (i + 1 >= t.length) return undefined;                          // after the last sample
      if (kind === 'before') return v[i + 1];
      var y0 = v[i], y1 = v[i + 1];
      if (typeof y0 !== 'number' || typeof y1 !== 'number') return typeof y0 === 'number' ? undefined : y0;
      return y0 + (y1 - y0) * (x - t[i]) / (t[i + 1] - t[i]);
    }

    /* ========================================================================
     * SECTION 6 / NS.chart.historyQueue — one queue per page
     * ----------------------------------------------------------------------
     * Every history request of every chart on the page goes through here:
     *   - at most `maxConcurrent` (2) requests in flight per page (the
     *     gateway allows 4 per session; one session spans all tabs), and
     *     never more than a job's `sessionMax` (limits.maxConcurrentPerSession):
     *     a gateway configured below 2 is not answered with 429s;
     *   - priorities user > chunk > tick > overview, FIFO inside a priority;
     *   - an overview job (the range selector strip) runs ALONE: it
     *     starts only while none of the page's requests runs, and nothing
     *     else starts until it ends. The gateway refuses a request with 429
     *     (X-CTG-Limit: queue) when the session's queued + running query
     *     tasks would pass maxQueuedTasksPerSession (16) — except for an idle
     *     session — and a strip request plus an 8-pen tick passes that; a
     *     lone request is always admitted. The client cannot count the
     *     gateway's tasks (cached pieces add some), and the gateway runs one
     *     session's tasks from one FIFO lane anyway, so running next to a
     *     tick would not make either faster (measured side by side: 5 x 429
     *     and a tick p95 of 857 ms). To bound how long a strip holds the page,
     *     fetchOverview sends it in batches of OVERVIEW_BATCH_PENS pens, one
     *     job each: user / chunk / tick jobs that arrive meanwhile start
     *     between two batches (a 30-day 8-pen strip took 1.3 s in one piece);
     *     a batch that waited EXCLUSIVE_MAX_WAIT_MS behind a busy queue goes
     *     next (nothing new starts until it has run), so ticks cannot starve it;
     *     the other pending exclusive jobs then count their wait from that
     *     moment again, so aged batches never run back to back;
     *   - per key (one chart = one token) a minimum spacing between starts
     *     (the gateway's per-token interval, 200 ms, answers 429 otherwise);
     *   - Retry-After: pause(key, ms) after a 429, pauseAll(ms) after a 503;
     *     a 429 of the token bucket (X-CTG-Limit: rate) also drains the
     *     key's bucket mirror and waits its exact X-CTG-Retry-After-Ms; a 429
     *     of the per-session concurrency (X-CTG-Limit: concurrency) leaves the
     *     mirror alone — that refusal took nothing from the bucket; a
     *     per-session queue 429 (X-CTG-Limit: queue) also leaves it alone and
     *     both wait only a short pause;
     *   - a job whose signal aborts while queued resolves {aborted:true}.
     * The queue never rejects; a job's exec() result is passed through.
     * ====================================================================== */
    var PRIORITY = { user: 0, chunk: 1, tick: 2, overview: 3 };     // overview: the range selector strip
    var EXCLUSIVE = { overview: true };                               // priorities that run alone (see above)
    // Aging of an exclusive job: it starts only at idle, behind every better-ranked ready job,
    // so ticks that keep the queue busy could hold it forever (the strip would silently stop refreshing). After
    // this wait no new job starts until the running ones end; the exclusive job then starts first.
    var EXCLUSIVE_MAX_WAIT_MS = 5000;

    /** Minimal cancellation token (works in Node's vm sandbox and old browsers). */
    function Canceller() {
      var self = this;
      this.aborted = false;
      this._fns = [];
      this.signal = {
        get aborted() { return self.aborted; },
        on: function (fn) { if (self.aborted) fn(); else self._fns.push(fn); },
      };
    }
    Canceller.prototype.cancel = function () {
      if (this.aborted) return;
      this.aborted = true;
      var fns = this._fns;
      this._fns = [];
      fns.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
    };

    function HistoryQueue(opts) {
      var o = opts || {};
      this.maxConcurrent = o.maxConcurrent || 2;
      this.now = o.now || function () { return Date.now(); };
      this.timers = o.timers || defaultTimers;
      this.pending = [];
      this.running = 0;
      this.exclusive = 0;             // running exclusive jobs (0 or 1): nothing else starts meanwhile
      this.lastStart = {};
      this.buckets = {};              // key -> {tokens, at}: client mirror of the gateway's token bucket (burst > 1)
      this.pausedUntil = {};
      this.globalPauseUntil = 0;
      this._timer = null;
      this._seq = 0;
      this.stats = { started: 0, maxRunning: 0, maxQueued: 0 };
    }
    var ABORTED = { ok: false, aborted: true, code: 'ABORTED' };
    /**
     * job: {key, priority:'user'|'chunk'|'tick'|'overview', spacingMs, burst, sessionMax, signal (Canceller.signal), exec(signal) -> Promise}
     * sessionMax: the gateway's maxConcurrentPerSession — the job starts only while fewer requests run.
     * burst > 1: per key, up to `burst` jobs start back to back, refilled at one per spacingMs (a
     * mirror of the gateway's per-token bucket, refilled a little slower than the gateway: spacing has a margin);
     * otherwise at least spacingMs between two starts of a key.
     * Returns a Promise of exec's result (or ABORTED).
     */
    HistoryQueue.prototype.run = function (job) {
      var self = this;
      return new Promise(function (resolve) {
        if (job.signal && job.signal.aborted) { resolve(ABORTED); return; }
        var item = { job: job, resolve: resolve, seq: ++self._seq, queuedAt: self.now(), rank: hasOwn.call(PRIORITY, job.priority) ? PRIORITY[job.priority] : 1,
          exclusive: hasOwn.call(EXCLUSIVE, job.priority) };
        if (job.signal) {
          job.signal.on(function () {
            var i = self.pending.indexOf(item);
            if (i >= 0) { self.pending.splice(i, 1); resolve(ABORTED); self._pump(); }
          });
        }
        self.pending.push(item);
        if (self.pending.length > self.stats.maxQueued) self.stats.maxQueued = self.pending.length;
        self._pump();
      });
    };
    HistoryQueue.prototype.pause = function (key, ms) {
      var until = this.now() + Math.max(0, ms || 0);
      if (!(this.pausedUntil[key] >= until)) this.pausedUntil[key] = until;
      this._pump();
    };
    HistoryQueue.prototype.pauseAll = function (ms) {
      var until = this.now() + Math.max(0, ms || 0);
      if (until > this.globalPauseUntil) this.globalPauseUntil = until;
      this._pump();
    };
    /** The mirror bucket of a key, refilled to `now` (created full). */
    HistoryQueue.prototype._bucket = function (k, spacing, burst, now) {
      var b = this.buckets[k];
      if (!b) b = this.buckets[k] = { tokens: burst, at: now };
      if (spacing > 0) b.tokens = Math.min(burst, b.tokens + (now - b.at) / spacing);
      else b.tokens = burst;
      b.at = now;
      return b;
    };
    /** A refusal (429) says the gateway's bucket is empty: the mirror starts again from zero. */
    HistoryQueue.prototype.drain = function (key) {
      var b = this.buckets[key];
      if (b) { b.tokens = 0; b.at = this.now(); }
    };
    HistoryQueue.prototype._readyAt = function (item) {
      var k = item.job.key;
      var spacing = item.job.spacingMs || 0;
      var burst = item.job.burst > 1 ? Math.floor(item.job.burst) : 1;
      var last;
      if (burst > 1) {
        var now = this.now();
        var b = this._bucket(k, spacing, burst, now);
        last = b.tokens >= 1 ? 0 : now + Math.ceil((1 - b.tokens) * spacing);
      } else last = hasOwn.call(this.lastStart, k) ? this.lastStart[k] + spacing : 0;
      return Math.max(this.globalPauseUntil, this.pausedUntil[k] || 0, last);
    };
    HistoryQueue.prototype._pump = function () {
      var self = this;
      if (this._timer != null) { this.timers.clear(this._timer); this._timer = null; }
      if (this.exclusive) return;                     // an exclusive job runs: its end pumps again
      while (this.running < this.maxConcurrent && this.pending.length) {
        var now = this.now();
        var best = -1;
        var starved = this._starved(now);
        if (starved >= 0) {
          if (this.running > 0) break;                // drains: nothing new starts until the aged job has run
          best = starved;
        }
        for (var i = 0; starved < 0 && i < this.pending.length; i++) {
          var it = this.pending[i];
          if (this._readyAt(it) > now) continue;
          if (it.job.sessionMax > 0 && this.running >= it.job.sessionMax) continue;     // the gateway's per-session cap
          if (it.exclusive && this.running > 0) continue;                                // runs alone: waits for idle
          if (best < 0 || it.rank < this.pending[best].rank || (it.rank === this.pending[best].rank && it.seq < this.pending[best].seq)) best = i;
        }
        if (best < 0) break;
        var started = this.pending.splice(best, 1)[0];
        // The other exclusive jobs (the strip's next batches, other strips) were queued at the same moment and
        // have aged too. Counted from their enqueue time they would each drain the queue in turn, so no tick would
        // start between two batches. Their wait starts again now: the next batch runs at the next idle moment or
        // after another EXCLUSIVE_MAX_WAIT_MS, and ticks that arrive meanwhile go first.
        if (starved >= 0) this._restartAging(now);
        this._start(started);
        if (started.exclusive) return;
      }
      // draining for an aged exclusive job: the running jobs' ends pump (a timer would only spin)
      if (this.pending.length && this.running < this.maxConcurrent && !(this.running > 0 && this._starved(this.now()) >= 0)) {
        var nowT = this.now();
        var wake = Infinity;
        // a job held back only by its session cap (or, exclusive, by any running job) waits for a running job to
        // end (which pumps): no timer for it
        this.pending.forEach(function (it2) {
          if (it2.exclusive && self.running > 0) return;
          if (!(it2.job.sessionMax > 0 && self.running >= it2.job.sessionMax)) wake = Math.min(wake, self._readyAt(it2));
        });
        if (wake !== Infinity) this._timer = this.timers.set(function () { self._timer = null; self._pump(); }, Math.max(1, wake - nowT));
      }
    };
    /** Index of the oldest ready exclusive job waiting longer than EXCLUSIVE_MAX_WAIT_MS, or -1. */
    HistoryQueue.prototype._starved = function (now) {
      var found = -1;
      for (var i = 0; i < this.pending.length; i++) {
        var it = this.pending[i];
        if (!it.exclusive || now - it.queuedAt < EXCLUSIVE_MAX_WAIT_MS || this._readyAt(it) > now) continue;
        if (found < 0 || it.seq < this.pending[found].seq) found = i;
      }
      return found;
    };
    /** After an aged exclusive job starts: every other pending exclusive job counts its wait from `now` again. */
    HistoryQueue.prototype._restartAging = function (now) {
      for (var i = 0; i < this.pending.length; i++) if (this.pending[i].exclusive) this.pending[i].queuedAt = now;
    };
    HistoryQueue.prototype._start = function (item) {
      var self = this;
      var job = item.job;
      this.running++;
      if (item.exclusive) this.exclusive++;
      this.stats.started++;
      if (this.running > this.stats.maxRunning) this.stats.maxRunning = this.running;
      this.lastStart[job.key] = this.now();
      if (job.burst > 1) {
        var bk = this._bucket(job.key, job.spacingMs || 0, Math.floor(job.burst), this.now());
        bk.tokens = Math.max(0, bk.tokens - 1);
      } else delete this.buckets[job.key];
      var signal = job.signal || new Canceller().signal;
      var p;
      try { p = Promise.resolve(job.exec(signal)); } catch (e) { p = Promise.reject(e); }
      p.then(function (r) { return r; }, function (e) {
        log.warn('history job failed', e && e.message);
        return { ok: false, code: 'INTERNAL', message: String(e && e.message || e) };
      }).then(function (r) {
        self.running--;
        if (item.exclusive) self.exclusive--;
        item.resolve(r);
        self._pump();
      });
    };
    /** Drops the per-key bookkeeping of a disposed chart. */
    HistoryQueue.prototype.forget = function (key) {
      delete this.lastStart[key];
      delete this.buckets[key];
      delete this.pausedUntil[key];
    };

    /**
     * History credentials {url, token, expiresAt} of a chart delegate. Kept in a
     * module-private WeakMap, never as an object property: window.__CTG.debug.delegates (always present,
     * the page watchdog uses it) and __CTG.debug.charts reach the delegate, the engine and its HistoryClient,
     * so a property anywhere on that graph would expose the token to page scripts. Sources without an
     * entry (Node test fakes) answer through their own getCreds() — a fake source can only hand out its own
     * credentials, never a delegate's. The guarantee is "not reachable passively" (no property, prop, event
     * payload or log line holds it); script that wraps window.fetch sees the header like any request.
     */
    var CREDS = new WeakMap();
    /** History responses with a longer round trip do not feed NS.clock (the query time skews the midpoint). */
    var CLOCK_SAMPLE_MAX_RTT_MS = 250;
    function credsOf(src) {
      if (!src) return null;
      if (CREDS.has(src)) return CREDS.get(src) || null;
      return typeof src.getCreds === 'function' ? src.getCreds() || null : null;
    }
    /** chart.snapshot without its `history` member (the credentials): what the delegate keeps and maps. */
    function withoutCreds(payload) {
      var out = {};
      if (!payload || typeof payload !== 'object') return out;
      for (var k in payload) if (hasOwn.call(payload, k) && k !== 'history') out[k] = payload[k];
      return out;
    }

    /* ========================================================================
     * SECTION 7 / HistoryClient — one chart's POSTs to /v2/history
     * ----------------------------------------------------------------------
     * Headers X-CTG-Token (never in a URL, never logged: NS.log redacts it),
     * X-CTG-Protocol: 2, Content-Type application/json, same-origin cookies.
     * 401 -> ask the delegate for a fresh token (chart.token, TOKEN class) and
     * retry ONCE. 429 -> queue.pause(key, Retry-After), 503 -> pauseAll. The
     * HTTP response's serverNow feeds the page clock (RTT-centred).
     * Result: {ok:true, data, bytes} | {ok:false, status, code, message,
     * retryable, retryAfterMs} | {ok:false, aborted:true}. Never rejects.
     * ====================================================================== */
    var HISTORY_SERVER_TIMEOUT_MS = 15000;     // ModuleSettings ctg.history.timeoutMs default
    var CONCURRENCY_RETRY_MS = 250;            // pause after a per-session concurrency or queue 429 (X-CTG-Limit: concurrency | queue)
    var HISTORY_TIMEOUT_MARGIN_MS = 10000;
    function HistoryClient(o) {
      this.source = o.source;
      this.queue = o.queue;
      this.key = o.key;
      this.metrics = o.metrics;
      this.fetchImpl = o.fetch || null;
      this.limits = o.limits || function () { return LIMIT_DEFAULTS; };
      this.timers = o.timers || defaultTimers;
    }
    /**
     * Client-side deadline of one POST: the gateway's own query deadline (ctg.history.timeoutMs, 15 s by
     * default; taken from limits.historyTimeoutMs when a gateway sends it) plus HISTORY_TIMEOUT_MARGIN_MS for
     * the transfer. It only fires when the gateway never answers (a stalled connection): its own deadline
     * produces a 504 first.
     */
    HistoryClient.prototype.timeoutMs = function () {
      var l = this.limits();
      var server = l && NS.util.isFiniteNum(l.historyTimeoutMs) && l.historyTimeoutMs > 0 ? l.historyTimeoutMs : HISTORY_SERVER_TIMEOUT_MS;
      return server + HISTORY_TIMEOUT_MARGIN_MS;
    };
    HistoryClient.prototype.post = function (body, opts) {
      var self = this;
      var l = this.limits();
      var spacing = (l.minIntervalMs || 0) + 20;
      var burst = NS.util.isFiniteNum(l.historyBurst) && l.historyBurst > 1 ? Math.min(64, Math.floor(l.historyBurst)) : 1;
      var sessionMax = NS.util.isFiniteNum(l.maxConcurrentPerSession) && l.maxConcurrentPerSession >= 1 ? Math.floor(l.maxConcurrentPerSession) : 0;
      return this.queue.run({
        key: this.key, priority: (opts && opts.priority) || 'user', spacingMs: spacing, burst: burst, sessionMax: sessionMax,
        signal: opts && opts.signal,
        exec: function (signal) { return self._exec(body, signal, false); },
      });
    };
    HistoryClient.prototype._exec = function (body, signal, retried) {
      var self = this;
      var m = this.metrics;
      var creds = credsOf(this.source);
      if (!creds || !creds.url || !creds.token) {
        return Promise.resolve({ ok: false, status: 0, code: 'NO_TOKEN', message: 'no history token', retryable: false });
      }
      // A real delegate's token only ever goes to window.fetch: a caller-supplied fetch (Node tests) is used
      // for sources without a CREDS entry only, so `new HistoryClient({source: delegate, fetch: steal})`
      // cannot read the token. Wrapping window.fetch itself still sees the header — inherent to
      // same-origin script, which holds the session anyway (CREDS guards against passive exposure only).
      var f = (!CREDS.has(this.source) && this.fetchImpl) || (typeof W.fetch === 'function' ? W.fetch.bind(W) : null);
      if (!f) return Promise.resolve({ ok: false, status: 0, code: 'NETWORK', message: 'fetch unavailable', retryable: true });
      var ac = typeof W.AbortController === 'function' ? new W.AbortController() : null;
      if (signal && ac) signal.on(function () { try { ac.abort(); } catch (e) { /* ignore */ } });
      var timedOut = false;
      var timers = this.timers;
      var deadline = ac ? timers.set(function () {
        timedOut = true;
        try { ac.abort(); } catch (e) { /* ignore */ }
      }, this.timeoutMs()) : null;
      var sentAt = Date.now();
      var json = JSON.stringify(body);
      m.requests++;
      m.requestBytes += json.length;
      m.inFlight++;
      if (m.inFlight > m.inFlightMax) m.inFlightMax = m.inFlight;
      var done = false;
      var settle = function () { if (!done) { done = true; m.inFlight--; timers.clear(deadline); } };
      return f(creds.url, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-CTG-Token': creds.token, 'X-CTG-Protocol': '2' },
        body: json, signal: ac ? ac.signal : undefined,
      }).then(function (resp) {
        return resp.text().then(function (text) { return { resp: resp, text: text }; });
      }).then(function (r) {
        settle();
        var receivedAt = Date.now();
        var t0 = Date.now();
        var data = null;
        try { data = r.text ? JSON.parse(r.text) : null; } catch (e) { data = null; }
        var parseMs = Date.now() - t0;
        m.responses++;
        m.bytes += r.text.length;
        m.lastBytes = r.text.length;
        perfPush(m.perf.fetchMs, receivedAt - sentAt);
        perfPush(m.perf.parseMs, parseMs);
        if (signal && signal.aborted) return ABORTED;
        // serverNow is stamped after the historian query, so RTT-midpoint centring is off by about half the
        // query time: only quick responses feed the page clock (ctg.ping samples it too)
        if (data && NS.util.isFiniteNum(data.serverNow) && receivedAt - sentAt <= CLOCK_SAMPLE_MAX_RTT_MS) {
          NS.clock.sample(data.serverNow, sentAt, receivedAt);
        }
        var status = r.resp.status;
        if (status === 200 && data && data.ok) {
          return { ok: true, status: 200, data: data, bytes: r.text.length };
        }
        var err = (data && data.error) || {};
        var code = err.code || ('HTTP_' + status);
        if (status === 401 && !retried) {
          return self.source.renewToken().then(function (ok) {
            if (signal && signal.aborted) return ABORTED;
            return ok ? self._exec(body, signal, true)
              : { ok: false, status: 401, code: code, message: err.message || '', retryable: false };
          });
        }
        var hdr = function (n) { return r.resp.headers && r.resp.headers.get ? r.resp.headers.get(n) : null; };
        var ra = parseRetryAfter(hdr('Retry-After'));
        var transient = false;
        if (status === 429) {
          // The gateway names the limit. A concurrency refusal took nothing from the token bucket: no drain, and
          // a short pause (a slot frees when one of the session's running requests ends) instead of Retry-After's 1 s.
          // A bucket refusal drains the mirror and waits the exact refill time when the gateway sends it.
          // A per-session queue refusal (`queue`) is transient in the same way. It answers the second of
          // two charts that mount together (8 + 4 pens with their anchor tasks exceed the session's 16 queued tasks)
          // and clears within one query round, so it gets the same short pause, not Retry-After's 1 s. No drain either:
          // the gateway took this request's bucket token before its queue check, and the mirror counted the same start.
          var limit = String(hdr('X-CTG-Limit') || '');
          var exact = Number(hdr('X-CTG-Retry-After-Ms'));
          transient = limit === 'concurrency' || limit === 'queue';
          if (transient) ra = CONCURRENCY_RETRY_MS;
          else if (isFinite(exact) && exact > 0) ra = Math.ceil(exact) + 20;
          else ra = ra != null ? ra : 1000;
          self.queue.pause(self.key, ra);
          if (!transient && self.queue.drain) self.queue.drain(self.key);
        } else if (status === 503) {
          ra = ra != null ? ra : 2000;
          self.queue.pauseAll(ra);
        }
        return { ok: false, status: status, code: code, message: err.message || '', retryable: !!err.retryable, retryAfterMs: ra,
          transient: status === 429 && transient };
      }, function (e) {
        settle();
        if (signal && signal.aborted) return ABORTED;
        if (timedOut) {
          m.clientTimeouts++;
          return { ok: false, status: 0, code: 'CLIENT_TIMEOUT', message: 'no answer from the gateway', retryable: true };
        }
        if (e && e.name === 'AbortError') return ABORTED;
        m.networkErrors++;
        return { ok: false, status: 0, code: 'NETWORK', message: String(e && e.message || e), retryable: true };
      });
    };
    function parseRetryAfter(h) {
      if (h == null) return null;
      var s = Number(String(h).trim());
      return isFinite(s) && s >= 0 ? Math.round(s * 1000) : null;
    }
    function perfPush(arr, v) { arr.push(v); if (arr.length > 50) arr.shift(); }
    function p95(arr) {
      if (!arr.length) return null;
      var s = arr.slice().sort(function (a, b) { return a - b; });
      return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))];
    }

    /* ========================================================================
     * SECTION 8 / SeriesStore — data per data key
     * ----------------------------------------------------------------------
     * data key = normKey(tagPath) + "|" + aggregation. It does not depend on
     * the pen key (static "p:<i>" shifts on reorder; trend "t:<path>"), so a
     * reorder or a static <-> trend move never refetches. The
     * query mode is a COVERAGE attribute (a mode switch is always a full load
     * that replaces the data), not part of the key.
     * Stored times are the gateway's own stamps (aggregated: bucket starts);
     * the draw-time shift happens in penView. `rev` changes on every edit,
     * `baseRev` only on edits that are not pure appends (PlotJoin fast path).
     * ====================================================================== */
    function dataKeyOf(tagPath, aggregation) { return NS.util.normKey(tagPath) + '|' + aggregation; }

    function newPenData(dk, tagPath, aggregation) {
      return {
        key: dk, tagPath: tagPath, aggregation: aggregation,
        t: [], v: [], anchor: null, coverage: null, lastHistT: null, histEnd: null,
        live: { t: [], v: [] }, liveLatest: null,
        status: 'loading', message: null, limit: null, warn: null,
        // incomplete: 'timeout' | 'error' — a later chunk of a full load failed for this pen, so its older part
        // of the window is missing. Unlike warn (the last request's outcome), ticks do not clear it; a new
        // full load does, and so does a realtime window that slid past the missing part.
        incomplete: null,
        approx: false, downgraded: false, truncated: false, loaded: false,
        rev: 0, baseRev: 0, liveRev: 0, removedAt: 0, gen: 0,
      };
    }

    function SeriesStore(opts) {
      this.map = new Map();
      this.liveMax = (opts && opts.liveMax) || 20000;
    }
    SeriesStore.prototype.get = function (dk) { return this.map.get(dk) || null; };
    SeriesStore.prototype.ensure = function (dk, tagPath, aggregation) {
      var pd = this.map.get(dk);
      if (!pd) { pd = newPenData(dk, tagPath, aggregation); this.map.set(dk, pd); }
      pd.removedAt = 0;
      return pd;
    };
    SeriesStore.prototype.keys = function () { return Array.from(this.map.keys()); };
    SeriesStore.prototype.drop = function (dk) { this.map.delete(dk); };
    SeriesStore.prototype.clear = function () { this.map.clear(); };
    SeriesStore.prototype.heldPoints = function () {
      var n = 0;
      this.map.forEach(function (pd) { n += pd.t.length + pd.live.t.length; });
      return n;
    };
    function bump(pd, structural) { pd.rev++; if (structural) pd.baseRev++; }

    function coverageOf(win, wp) {
      var downgraded = !!(wp && wp.downgraded) || !!win.downgraded;
      var penBucket = wp && NS.util.isFiniteNum(wp.bucketMs) ? wp.bucketMs : null;
      var mode = penBucket ? 'aggregated' : win.mode;
      return {
        start: win.start, end: win.end, mode: mode, bucketMs: penBucket || win.bucketMs || null,
        bucketTime: win.bucketTime || (mode === 'aggregated' ? 'start' : null),
        aggregation: (wp && wp.aggregation) || win.aggregation || null, downgraded: downgraded,
      };
    }
    function validAnchor(a) {
      return a && NS.util.isFiniteNum(a.t) ? { t: a.t, v: NS.util.isFiniteNum(a.v) ? a.v : null } : null;
    }
    /** Columns from the wire: ascending check (defensive), v null for bad quality / non-finite. */
    function wireColumns(wp) {
      var t = Array.isArray(wp.t) ? wp.t : [];
      var v = Array.isArray(wp.v) ? wp.v : [];
      var n = Math.min(t.length, v.length);
      var ot = [], ov = [];
      var last = -Infinity;
      var minmax = wp.shape === 'minmax';
      for (var i = 0; i < n; i++) {
        var tt = t[i];
        if (!NS.util.isFiniteNum(tt)) continue;
        if (tt < last || (tt === last && !minmax)) continue;
        ot.push(tt);
        ov.push(NS.util.isFiniteNum(v[i]) ? v[i] : null);
        last = tt;
      }
      return { t: ot, v: ov };
    }
    SeriesStore.prototype._afterHistory = function (pd) {
      // live points now covered by history are dropped (they are history now)
      var cut = pd.histEnd;
      if (cut != null && pd.live.t.length && pd.live.t[0] <= cut) {
        var n = upperBound(pd.live.t, cut);
        pd.live.t.splice(0, n); pd.live.v.splice(0, n);
        pd.liveRev++;
      }
    };
    function histEndOf(pd) {
      if (!pd.coverage) return pd.lastHistT;
      // aggregated: everything up to the coverage end is represented by buckets; raw: by the last sample
      return pd.coverage.mode === 'aggregated' ? pd.coverage.end : pd.lastHistT;
    }
    /** Full (replacing) history for one pen. */
    SeriesStore.prototype.applyFull = function (dk, wp, win) {
      var pd = this.map.get(dk);
      if (!pd) return null;
      var cols = wireColumns(wp);
      pd.t = cols.t; pd.v = cols.v;
      pd.anchor = validAnchor(wp.anchor);
      pd.coverage = coverageOf(win, wp);
      pd.lastHistT = pd.t.length ? pd.t[pd.t.length - 1] : null;
      pd.histEnd = histEndOf(pd);
      pd.status = 'ok'; pd.message = null; pd.limit = null; pd.warn = null; pd.incomplete = null;
      pd.approx = pd.coverage.mode === 'aggregated';
      pd.downgraded = pd.coverage.downgraded;
      pd.truncated = !!wp.truncated;
      pd.loaded = true;
      pd.badRun = null;
      trackBadRun(pd, cols);
      bump(pd, true);
      this._afterHistory(pd);
      return pd;
    };
    /**
     * Older raw chunk: chunks arrive newest first and never overlap, so the chunk goes in
     * front; samples at or after the current first sample are dropped (inclusive chunk edges).
     */
    SeriesStore.prototype.prependChunk = function (dk, wp, win) {
      var pd = this.map.get(dk);
      if (!pd) return null;
      var cols = wireColumns(wp);
      if (pd.t.length) {
        var n = lowerBound(cols.t, pd.t[0]);
        cols.t.length = n; cols.v.length = n;
      }
      pd.t = cols.t.concat(pd.t);
      pd.v = cols.v.concat(pd.v);
      var a = validAnchor(wp.anchor);
      if (a) pd.anchor = a;
      if (pd.coverage) pd.coverage.start = Math.min(pd.coverage.start, win.start);
      if (wp.truncated) pd.truncated = true;
      bump(pd, true);
      return pd;
    };
    /**
     * Incremental tick: delete t >= replaceFrom (aggregated re-sends its last buckets), then
     * append only strictly newer samples.
     */
    SeriesStore.prototype.applyIncremental = function (dk, wp, win) {
      var pd = this.map.get(dk);
      if (!pd) return null;
      var structural = false;
      if (NS.util.isFiniteNum(wp.replaceFrom) && pd.t.length) {
        var cut = lowerBound(pd.t, wp.replaceFrom);
        if (cut < pd.t.length) { pd.t.length = cut; pd.v.length = cut; structural = true; }
      }
      var cols = wireColumns(wp);
      var last = pd.t.length ? pd.t[pd.t.length - 1] : -Infinity;
      // (MinMax pairs are never split: an aggregated tick re-sends from replaceFrom, a full-window answer for
      // this pen repeats both rows of the bucket at `last`, and upperBound skips both.)
      var from = upperBound(cols.t, last);
      var lt = pd.live.t, lv = pd.live.v;
      var lastLive = lt.length ? lt[lt.length - 1] : -Infinity;
      for (var i = from; i < cols.t.length; i++) {
        // A history sample landing among live points already drawn changes the drawn sequence (a sample the
        // coalesced pushes missed): not an append for PlotJoin unless it duplicates that live point exactly.
        if (!structural && cols.t[i] <= lastLive) {
          var j = lowerBound(lt, cols.t[i]);
          if (!(lt[j] === cols.t[i] && sameValue(lv[j], cols.v[i]))) structural = true;
        }
        pd.t.push(cols.t[i]); pd.v.push(cols.v[i]);
      }
      if (pd.t.length) pd.lastHistT = pd.t[pd.t.length - 1];
      if (pd.coverage) {
        pd.coverage.end = Math.max(pd.coverage.end, win.end);
        if (win.bucketMs && pd.coverage.mode === 'aggregated') pd.coverage.bucketMs = win.bucketMs;
      }
      pd.histEnd = histEndOf(pd);
      trackBadRun(pd, cols);
      // live points about to be pruned must reappear as identical history samples, else the sequence changed
      if (!structural && pd.histEnd != null) {
        for (var k = 0; k < lt.length && lt[k] <= pd.histEnd; k++) {
          var hi = lowerBound(pd.t, lt[k]);
          if (!(pd.t[hi] === lt[k] && sameValue(pd.v[hi], lv[k]))) { structural = true; break; }
        }
      }
      pd.warn = null;
      bump(pd, structural);
      this._afterHistory(pd);
      return pd;
    };
    function sameValue(a, b) { return a === b || (a == null && b == null); }
    /**
     * Bad-quality stretches of an aggregated pen. A tick re-asks only ~2 buckets; once
     * the bad raw sample that bounds a Bad stretch lies before the tick's query start, Core Historian interpolates the
     * following buckets from that sample's stored value toward the next good one and answers them Good — a ramp drawn
     * (and counted in the stats) where the sensor was Bad, while a fresh load shows the gap. pd.badRun remembers the
     * newest run of null (bad) rows the answers contained (merged while it grows); planIncrementalSince keeps the
     * boundary inside every tick query that still reaches the run.
     */
    function trackBadRun(pd, cols) {
      var cov = pd.coverage;
      if (!cov || cov.mode !== 'aggregated' || !(cov.bucketMs > 0)) { pd.badRun = null; return; }
      var b = cov.bucketMs;
      var t = cols.t, v = cols.v;
      var i = v.length - 1;
      while (i >= 0 && v[i] != null) i--;
      if (i < 0) return;
      var end = t[i];
      var j = i;
      while (j > 0 && v[j - 1] == null) j--;
      var start = t[j];
      var r = pd.badRun;
      if (r && start <= r.end + b && end >= r.start - b) {
        r.start = Math.min(r.start, start);
        if (end > r.end) r.done = false;                   // the run grew: replay it again
        r.end = Math.max(r.end, end);
      } else if (!r || end > r.end) {
        pd.badRun = { start: start, end: end, done: false };
      }
    }
    /** BAD_RUN_REPLAY_MS: how long after a Bad stretch began ticks may re-ask from it (at least 20 buckets). */
    var BAD_RUN_REPLAY_MS = 10 * 60000;
    /** The gateway's replay before a tick's since (HistoryRequest.INCREMENTAL_REPLAY_MS). */
    var GW_REPLAY_MS = 5000;
    /**
     * The since a tick sends for an aggregated pen (pure; Node-tested): the pen's last bucket, or — while the query the
     * gateway would run for that since (it starts min(alignDown(since) - b, alignDown(since - 5 s))) still reaches the
     * Bad run or the bucket right after it — one bucket before the run, so the query contains the bad boundary sample
     * and the historian marks the run Bad again instead of interpolating across it. Once the replay starts two buckets
     * past the run, the bounding sample is a good one and nothing is extended any more. Bounded by the window start; a
     * run older than max(BAD_RUN_REPLAY_MS, 20 buckets) is given up (a full load still draws it right).
     */
    function planIncrementalSince(pd, start, now) {
      var since = Math.max(pd.lastHistT != null ? pd.lastHistT : start, start);
      var r = pd.badRun;
      var b = pd.coverage && pd.coverage.bucketMs;
      if (!r || r.done || !(b > 0) || !pd.coverage || pd.coverage.mode !== 'aggregated') return since;
      if (now - r.start > Math.max(BAD_RUN_REPLAY_MS, 20 * b)) { r.done = true; return since; }
      var replayFrom = Math.min(Math.floor(since / b) * b - b, Math.floor((since - GW_REPLAY_MS) / b) * b);
      if (replayFrom > r.end + b) { r.done = true; return since; }
      return Math.max(start, Math.min(since, r.start - b));
    }
    /** Removes samples before ws, keeping the last one before it (the line enters from the left edge). */
    SeriesStore.prototype.trim = function (dk, ws) {
      var pd = this.map.get(dk);
      if (!pd) return;
      // by DRAW time: an aggregated row is drawn at its bucket end / middle (bucketShift), so the row to keep is
      // the last one DRAWN before ws; trimming by its stored bucket start would cut the row drawn just before ws,
      // and every tick would re-open a blank strip of up to one bucket at the left edge
      var idx = lowerBound(pd.t, ws - bucketShift(pd.coverage));
      if (idx >= 1 && pd.anchor) { pd.anchor = null; bump(pd, true); }
      var keep = idx - 1;                                  // the last sample before ws stays
      while (keep > 0 && pd.t[keep - 1] === pd.t[keep]) keep--;   // ... with its MinMax partner (same stamp)
      if (keep >= 1) {
        pd.t.splice(0, keep); pd.v.splice(0, keep);
        bump(pd, false);
      }
      if (pd.coverage && pd.coverage.start < ws) pd.coverage.start = ws;
      if (pd.incomplete && pd.coverage && pd.coverage.start <= ws) { pd.incomplete = null; bump(pd, false); }   // gap left the window
      var lidx = lowerBound(pd.live.t, ws);
      if (lidx >= 2) { pd.live.t.splice(0, lidx - 1); pd.live.v.splice(0, lidx - 1); pd.liveRev++; }
    };
    SeriesStore.prototype.setStatus = function (dk, status, wp) {
      var pd = this.map.get(dk);
      if (!pd) return;
      pd.status = status;
      pd.message = (wp && typeof wp.message === 'string') ? wp.message : null;
      pd.limit = wp && NS.util.isFiniteNum(wp.limit) ? wp.limit : null;
      if (status !== 'ok' && status !== 'loading') {
        pd.t = []; pd.v = []; pd.anchor = null; pd.lastHistT = null; pd.histEnd = null;
        pd.downgraded = false; pd.approx = false;
        pd.loaded = true;
      }
      bump(pd, true);
    };
    /**
     * Live point from chart.values: appended only after the history it does not
     * duplicate and after the previous live point; same t replaces; bad quality -> null (a gap).
     */
    SeriesStore.prototype.addLive = function (dk, val) {
      var pd = this.map.get(dk);
      if (!pd || !val) return false;
      var lvl = val.q && val.q.level;
      var good = (lvl == null || lvl === 'good') && NS.util.isFiniteNum(typeof val.v === 'boolean' ? (val.v ? 1 : 0) : val.v);
      var vv = good ? (typeof val.v === 'boolean' ? (val.v ? 1 : 0) : val.v) : null;
      pd.liveLatest = { v: vv, rawV: val.v, q: val.q || null, t: val.t };
      pd.liveRev++;
      var t = val.t;
      if (!NS.util.isFiniteNum(t)) return true;
      if (pd.histEnd != null && t <= pd.histEnd) return true;
      var lt = pd.live.t;
      if (lt.length && t < lt[lt.length - 1]) return true;
      if (lt.length && t === lt[lt.length - 1]) { pd.live.v[lt.length - 1] = vv; return true; }
      lt.push(t); pd.live.v.push(vv);
      if (lt.length > this.liveMax) { var drop = lt.length - this.liveMax + 1000; lt.splice(0, drop); pd.live.v.splice(0, drop); }
      return true;
    };

    /* ========================================================================
     * SECTION 9 / ChartEngine — the data side of one chart
     * ----------------------------------------------------------------------
     * Owns: the pen set (from the delegate) and its data keys, the SeriesStore,
     * the load generation, full / partial / chunked loads, the realtime tick
     * loop, the viewport (no gestures: ChartInteraction calls viewport.set),
     * staleness and load-error handling. Emits rAF-coalesced change events;
     * model() is the render model the component draws.
     *
     * Generation rule: every full load increments `gen` and cancels
     * everything in flight; a response is applied only when its load is still
     * current AND its requestId matches. Losing the token cancels the
     * generation first, so an older in-flight response can never overwrite
     * the SESSION_MISMATCH banner.
     * ====================================================================== */
    var ENGINE = {
      maxHeldPoints: 2000000,        // memory guard across pens
      removedGraceMs: 30000,         // data of a removed pen survives a quick re-add
      fullRetryMs: 5000,             // one retry of a timed-out full load
      requeryDebounceMs: 400,        // free-range re-query after a gesture
      statsThrottleMs: 100,          // pen table stats recompute
      tokenRenewBeforeMs: 120000,    // renew the history token when less is left
    };
    /**
     * When to renew a history token: 120 s before it expires, but never more than half its lifetime
     * (the gateway sends issuedAt). Without the half-life bound, a ctg.token.ttlMs at or below 120 s would make a
     * fresh token "due" at once and every tick would renew it (19 chart.token in 20 s), churning the session's
     * token cap.
     */
    function renewBeforeMs(creds) {
      var life = creds && NS.util.isFiniteNum(creds.issuedAt) && NS.util.isFiniteNum(creds.expiresAt)
        ? creds.expiresAt - creds.issuedAt : null;
      return life != null && life > 0 ? Math.min(ENGINE.tokenRenewBeforeMs, life / 2) : ENGINE.tokenRenewBeforeMs;
    }
    var BACKOFF = {
      network: [2000, 30000], failed: [2000, 60000], busy: [1000, 30000],
    };
    function backoffMs(kind, n, retryAfter) {
      var r = BACKOFF[kind] || BACKOFF.network;
      var ms = Math.min(r[1], r[0] * Math.pow(2, Math.max(0, n - 1)));
      return retryAfter != null ? Math.max(ms, retryAfter) : ms;
    }
    /**
     * Retry delay after a busy answer (429/503). A 429 of a transient per-session limit (`res.transient`:
     * X-CTG-Limit concurrency or queue) clears as soon as the session's other requests end — typically the second of
     * two charts that mount together. Its first TRANSIENT_BUSY_TRIES retries wait the HistoryClient's short pause
     * (250 ms) directly: backoffMs would raise it to the 1 s busy floor.
     * Repeated refusals, and every other busy answer, use the busy backoff.
     */
    var TRANSIENT_BUSY_TRIES = 3;
    function busyBackoffMs(res, n) {
      if (res && res.transient && n <= TRANSIENT_BUSY_TRIES && res.retryAfterMs != null) return res.retryAfterMs;
      return backoffMs('busy', n, res ? res.retryAfterMs : null);
    }
    var FATAL_BANNERS = { reload: true, SESSION_MISMATCH: true };
    // Banners whose cause the engine retries with chart.token renewals (2 s doubling to 60 s): a 401 whose renewal
    // failed, and the per-session token cap (a refused chart recovers without a page reload).
    var RENEW_BANNERS = { auth: true, SESSION_FULL: true };
    // Banners of a failure that the engine retries by itself (backoff): they stay up while the retry load runs
    // (no flicker) and clear on the next success, full load or tick.
    var TRANSIENT_BANNERS = { timeout: true, network: true, error: true };

    function newMetrics() {
      return {
        requests: 0, responses: 0, requestBytes: 0, bytes: 0, lastBytes: 0, inFlight: 0, inFlightMax: 0, networkErrors: 0, clientTimeouts: 0,
        ticks: 0, tickRequests: 0, skippedTicks: 0, fullLoads: 0, partialLoads: 0, chunkRequests: 0,
        staleDropped: 0, lastError: null, lastTickBody: null, sinceSent: 0,
        perf: { fetchMs: [], parseMs: [], joinMs: [], applyMs: [] },
      };
    }

    function ChartEngine(opts) {
      var o = opts || {};
      var self = this;
      this.id = o.id || NS.util.uid('chart');
      this.rid = NS.util.uid('h');      // short prefix of this chart's requestIds (<= 64 chars on the wire)
      this.name = o.name || '';
      this.source = o.source;
      this.queue = o.queue || NS.chart.historyQueue;
      this.gwNow = o.now || function () { return NS.clock.now(); };
      this.timers = o.timers || defaultTimers;
      this.doc = o.document !== undefined ? o.document : (typeof document !== 'undefined' ? document : null);
      this.timeZone = o.timeZone || null;
      this.plotWidth = o.plotWidth || 0;
      this.metrics = newMetrics();
      this.L = effectiveLimits(null);
      this.client = new HistoryClient({
        source: o.source, queue: this.queue, key: this.id, metrics: this.metrics, fetch: o.fetch, timers: this.timers,
        limits: function () { return self.L; },
      });
      this.store = new SeriesStore({ liveMax: o.liveMax });
      this.props = o.props || null;
      this.pens = [];
      this.gen = 0;
      this.loads = new Set();
      this.tick = null;              // {cancel, gen} while a tick request is in flight
      this.coverage = null;          // chart-level: {start, end, span, mode, bucketMs, aggregation, pointCount, live}
      this.window = null;            // last configured window
      this.vp = { followLive: true, span: 8 * HOUR, min: null, max: null };
      this.loadedOnce = false;
      this.lastSuccess = 0;
      this.failures = 0;
      this.tickFailures = 0;
      this.busyCount = 0;
      this.banner = null;            // {code, message, kind}
      this.notices = {};             // clamped, partial, busy, downgraded
      this._deferredLoad = null;     // {resetViewport} of a full load refused while the token or the snapshot was gone
      this.progress = null;          // {done, total, points, cancel}
      this.mounted = false;
      this._timer = null;
      this._retryTimer = null;
      this._requeryTimer = null;
      this._sweepTimer = null;
      this._off = [];
      this._listeners = [];
      this._rev = 0;
      this._model = null;
      this._joins = new Map();
      this._statsCache = new Map();
      this._reqN = 0;
      this._lastStaleState = null;
      this._emit = NS.util.rafThrottle(function () {
        self._rev++;
        self._model = null;
        self._publishDebug();
        self._listeners.slice().forEach(function (fn) { try { fn(); } catch (e) { log.warn('listener failed', e); } });
      });
      var vpApi = {
        get: function () { return self.viewportGet(); },
        set: function (r) { return self.viewportSet(r); },
        reset: function () { return self.viewportReset(); },
        clampSpan: function (span, mode) { return clampSpan(span, mode || (self.coverage && self.coverage.mode), self.L); },
      };
      this.viewport = vpApi;
      this.annotations = new AnnotationLayer(this);     // SECTION 9b
    }

    // ---- lifecycle -------------------------------------------------------------
    ChartEngine.prototype.start = function () {
      if (this.mounted) return;
      this.mounted = true;
      var self = this;
      if (this.source && typeof this.source.on === 'function') {
        this._off.push(this.source.on(function (type, payload) { self._onSource(type, payload); }));
      }
      if (this.doc && typeof this.doc.addEventListener === 'function') {
        var vis = function () { self._onVisibility(); };
        this.doc.addEventListener('visibilitychange', vis);
        this._off.push(function () { self.doc.removeEventListener('visibilitychange', vis); });
      }
      NS.debug.charts = NS.debug.charts || {};
      if (this.source && this.source.snap) this._onSnapshot();
      this._publishDebug();
    };
    ChartEngine.prototype.dispose = function () {
      if (!this.mounted) return;
      this.mounted = false;
      this.gen++;
      this._cancelAll();
      if (this._rawFetches) { this._rawFetches.forEach(function (c) { c.cancel(); }); this._rawFetches.clear(); }
      [this._timer, this._retryTimer, this._requeryTimer, this._sweepTimer, this._authTimer].forEach(this.timers.clear);
      this._timer = this._retryTimer = this._requeryTimer = this._sweepTimer = this._authTimer = null;
      this._off.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
      this._off = [];
      this._emit.cancel();
      this._listeners = [];
      this.annotations.dispose();
      this.store.clear();
      this._joins.clear();
      if (this.queue && this.queue.forget) this.queue.forget(this.id);
      if (NS.debug.charts) delete NS.debug.charts[this.id];
    };
    ChartEngine.prototype.onChange = function (fn) {
      var self = this;
      this._listeners.push(fn);
      return function () { var i = self._listeners.indexOf(fn); if (i >= 0) self._listeners.splice(i, 1); };
    };
    ChartEngine.prototype.changed = function () { this._model = null; this._emit(); };

    // ---- inputs ------------------------------------------------------------------
    /** New reduced props (component did update). Decides what to redo. */
    ChartEngine.prototype.setProps = function (p) {
      var prev = this.props;
      this.props = p;
      if (!prev) { if (this.mounted && this.source && this.source.snap) this._onSnapshot(); return; }
      if (prev === p) return;
      // annotations.* (enabled / types): read again, or drop everything when switched off
      if (stableJson(prev.annotations) !== stableJson(p.annotations)) this.annotations.request('props', 0);
      // Nothing the engine uses changed (the chart's own outputs.* / interaction.mode / penTable writes echo
      // back through props): keep the joins and the pen models as they are.
      if (prev.dataHash === p.dataHash && prev.structuralHash === p.structuralHash &&
          stableJson(prev.interaction.panAndZoom) === stableJson(p.interaction.panAndZoom) &&
          stableJson(prev.interaction.rangeBrush.controlLimits) === stableJson(p.interaction.rangeBrush.controlLimits)) {
        return;
      }
      var winChanged = stableJson([prev.timeRange.mode, prev.timeRange.realtime, prev.timeRange.historical]) !==
        stableJson([p.timeRange.mode, p.timeRange.realtime, p.timeRange.historical]);
      var queryChanged = stableJson(prev.query) !== stableJson(p.query);
      var rateChanged = prev.timeRange.refreshRate !== p.timeRange.refreshRate;
      var viewChanged = prev.appearance.breakOnGapMs !== p.appearance.breakOnGapMs ||
        prev.appearance.extendToNow !== p.appearance.extendToNow;
      this._reconcile({ noPartial: winChanged || queryChanged });       // a full load follows: it loads them
      if (winChanged) {
        this.fullLoad('props', { resetViewport: true });
      } else if (queryChanged) {
        this.fullLoad('props', { keepViewport: true });
      } else if (rateChanged) {
        this._schedule(0);                                // independent of plot existence
      }
      if (viewChanged) this._joins.forEach(function (j) { j.reset(); });
      this.changed();
    };
    /** Plot width in CSS px (planQuery's automatic point count). A big change re-plans an aggregated load. */
    ChartEngine.prototype.setPlotWidth = function (px) {
      var w = Math.round(px || 0);
      if (w <= 0 || w === this.plotWidth) return;
      var old = this.plotWidth;
      this.plotWidth = w;
      if (old > 0 && this.loadedOnce && this.props && this.props.query.pointCount === 0 &&
          (w >= old * 2 || w * 2 <= old)) {
        this.fullLoad('resize', { keepViewport: true });
      }
    };
    ChartEngine.prototype.setTimeZone = function (tz) { this.timeZone = tz || null; };

    ChartEngine.prototype._onSource = function (type, payload) {
      if (!this.mounted) return;
      switch (type) {
        case 'snapshot': this._onSnapshot(); break;
        case 'pens': this._reconcile(); this.annotations.onPens(); this.changed(); break;
        case 'values': this._onValues(payload); break;
        case 'token': this._onToken(); this.annotations.onPens(); break;
        case 'renewed': this._onToken(); break;              // a renewal this page asked for
        case 'epoch': this.changed(); break;                   // series data stays; a snapshot follows
        case 'state': this._onState(); break;
        default: break;
      }
    };
    ChartEngine.prototype._onSnapshot = function () {
      var snap = this.source && this.source.snap;
      if (!snap || !this.props) return;
      this.L = effectiveLimits(snap.limits);
      if (!credsOf(this.source)) {
        // No token for this session (e.g. a Designer without a known address). Cancel the
        // generation FIRST so no older in-flight response can overwrite the state afterwards.
        this.gen++;
        this._cancelAll();
        this._setBanner(this._noCredsCode());
        this._reconcile();
        this.changed();
        return;
      }
      var recovered = !!(this.banner && (this.banner.code === 'SESSION_MISMATCH' || RENEW_BANNERS[this.banner.code]));
      if (recovered) this._setBanner(null);
      // a recovery full load follows: no partial load for the missing pens first (it would be aborted at
      // once by the full load's gen++)
      this._reconcile({ noPartial: !this.loadedOnce || recovered || !!this._deferredLoad });
      if (!this.loadedOnce) this.fullLoad('initial', { resetViewport: true });
      else if (recovered || this._deferredLoad) { this._recoverLoad('snapshot'); if (recovered) this._resumeLoop(); }   // like _onToken
      else this._catchUp();                                                        // while the token was gone
      this.annotations.onPens();
      this.changed();
    };
    /**
     * The token is back after SESSION_MISMATCH/auth: everything that was cancelled or refused meanwhile
     * (pens that joined, a range change) is redone by one full load. A configured-window change made
     * while the token was gone resets the viewport (fullLoad recorded it in _deferredLoad).
     */
    /**
     * The banner for 'no credentials': SESSION_FULL when the snapshot says the per-session token cap
     * refused this chart (transient: renewals retried with backoff), else the permanent SESSION_MISMATCH.
     */
    ChartEngine.prototype._noCredsCode = function () {
      var s = this.source && this.source.snap;
      return s && s.historyRefused === 'sessionFull' ? 'SESSION_FULL' : 'SESSION_MISMATCH';
    };
    ChartEngine.prototype._recoverLoad = function (reason) {
      var d = this._deferredLoad;
      this._deferredLoad = null;
      if (d && d.resetViewport) this.fullLoad(reason, { resetViewport: true });
      else this.fullLoad(reason, { keepViewport: this.loadedOnce });
    };
    ChartEngine.prototype._onToken = function () {
      var creds = credsOf(this.source);
      if (!creds) {
        this.gen++;
        this._cancelAll();
        this._setBanner(this._noCredsCode());
        this.changed();
        return;
      }
      if (this.banner && (this.banner.code === 'SESSION_MISMATCH' || RENEW_BANNERS[this.banner.code])) {
        this._setBanner(null);
        this._recoverLoad('token');
        this._resumeLoop();
      }
    };
    /**
     * After a recovery the next tick comes at the refresh rate: the failed (401) tick scheduled the loop 30 s
     * out, so otherwise a recovered chart would draw its full load and then stand still for up to 30 s.
     */
    ChartEngine.prototype._resumeLoop = function () {
      if (this._realtime() && this.props && this.props.timeRange.refreshRate > 0) this._schedule(this.props.timeRange.refreshRate);
    };
    ChartEngine.prototype._onState = function () {
      var r = this.source.staleReason ? this.source.staleReason() : null;
      if (r !== this._lastStaleState) { this._lastStaleState = r; this.changed(); }
    };
    ChartEngine.prototype._onValues = function (values) {
      if (!values) return;
      var any = false;
      for (var i = 0; i < this.pens.length; i++) {
        var pen = this.pens[i];
        if (!hasOwn.call(values, pen.key)) continue;
        // a noHistory pen has no data key and no history: its live value is read straight from the
        // delegate's values map by current(); only re-render here
        if (!pen.dataKey) { if (pen.info && pen.info.status === 'noHistory') any = true; continue; }
        // a pen whose buckets are a statistic in another domain (Count, DurationOn, Range…) takes no raw live
        // samples (appended to its buckets they would distort the tail, the now point, Current and Min/Avg),
        // unless the pen is actually drawn raw (query.mode raw)
        if (!isValueAgg(pen.aggregation)) {
          var lpd = this.store.get(pen.dataKey);
          if (!lpd || !lpd.coverage || lpd.coverage.mode !== 'raw') continue;
        }
        if (this.store.addLive(pen.dataKey, values[pen.key])) any = true;
      }
      if (any) this.changed();
    };
    ChartEngine.prototype._onVisibility = function () {
      if (!this.mounted || this._hidden()) return;
      this._catchUp();
    };
    ChartEngine.prototype._hidden = function () { return !!(this.doc && this.doc.hidden); };
    ChartEngine.prototype._connected = function () {
      var s = this.source;
      if (!s) return false;
      var r = s.staleReason ? s.staleReason() : null;
      return r !== 'disconnected' && r !== 'reload' && (!s.state || s.state.connected !== false);
    };
    ChartEngine.prototype._realtime = function () { return !!this.props && this.props.timeRange.mode === 'realtime'; };

    // ---- pens ----------------------------------------------------------------------
    /** Effective aggregation of a pen: its own (static pens) unless 'default', else the chart's. */
    ChartEngine.prototype._penAgg = function (info, byIndex) {
      var p = this.props;
      if (info.source !== 'trend' && info.index != null && byIndex[info.index]) {
        var a = byIndex[info.index].aggregation;
        if (a && a !== 'default') return a;
      }
      return p.query.aggregation;
    };
    /**
     * Pen set reconciliation: PenInfo[] -> pen models + data keys; removed data keys expire
     * after 30 s; new loadable keys get a partial load over the current coverage (or wait for the running
     * full load). ro.noPartial: the caller starts a full load right after (it loads them).
     */
    ChartEngine.prototype._reconcile = function (ro) {
      var self = this;
      var snap = this.source && this.source.snap;
      if (!snap || !this.props) return;
      var byIndex = {};
      this.props.pens.forEach(function (pp) { byIndex[pp.index] = pp; });
      var infos = Array.isArray(snap.pens) ? snap.pens : [];
      var used = new Set();
      var pens = infos.filter(function (info) { return info && typeof info.key === 'string'; }).map(function (info) {
        var agg = self._penAgg(info, byIndex);
        var dk = info.status === 'ok' && typeof info.tagPath === 'string' ? dataKeyOf(info.tagPath, agg) : null;
        if (dk) used.add(dk);
        return { key: info.key, info: info, dataKey: dk, aggregation: agg, prop: info.index != null ? byIndex[info.index] || null : null };
      });
      this.pens = pens;
      var now = Date.now();
      this.store.keys().forEach(function (dk) {
        var pd = self.store.get(dk);
        if (!used.has(dk)) { if (!pd.removedAt) pd.removedAt = now; } else pd.removedAt = 0;
      });
      this._scheduleSweep();
      // missing = never loaded and not part of a running load (a key left at 'loading' by a load that a
      // generation change cancelled is missing too)
      var inLoad = this._keysInLoads();
      var missing = [];
      used.forEach(function (dk) {
        var pd = self.store.get(dk);
        if (!pd || (!pd.loaded && !inLoad.has(dk))) missing.push(dk);
        else if ((pd.status === 'timeout' || pd.status === 'error') && pd._retryTimer == null && !inLoad.has(dk)) missing.push(dk);
      });
      pens.forEach(function (pen) { if (pen.dataKey) self.store.ensure(pen.dataKey, pen.info.tagPath, pen.aggregation); });
      if (missing.length && this.loadedOnce && !this._fullLoadActive() && credsOf(this.source) && !(ro && ro.noPartial)) {
        this._partialLoad(missing);
      }
      this._joins.forEach(function (j) { j.reset(); });
    };
    ChartEngine.prototype._scheduleSweep = function () {
      var self = this;
      if (this._sweepTimer != null) return;
      this._sweepTimer = this.timers.set(function () {
        self._sweepTimer = null;
        if (!self.mounted) return;
        var now = Date.now(), left = false;
        self.store.keys().forEach(function (dk) {
          var pd = self.store.get(dk);
          if (pd.removedAt && now - pd.removedAt >= ENGINE.removedGraceMs) self.store.drop(dk);
          else if (pd.removedAt) left = true;
        });
        if (left) self._scheduleSweep();
      }, ENGINE.removedGraceMs + 50);
    };
    /** Unique data keys of loadable pens, with their tag path and aggregation. */
    ChartEngine.prototype._okKeys = function (only) {
      var seen = {}, out = [];
      this.pens.forEach(function (pen) {
        if (!pen.dataKey || seen[pen.dataKey] || (only && only.indexOf(pen.dataKey) < 0)) return;
        seen[pen.dataKey] = true;
        out.push({ dk: pen.dataKey, tagPath: pen.info.tagPath, aggregation: pen.aggregation });
      });
      return out;
    };

    // ---- loads -----------------------------------------------------------------------
    /** Data keys of every load that is still running (current generation, not cancelled). */
    ChartEngine.prototype._keysInLoads = function () {
      var self = this, set = new Set();
      this.loads.forEach(function (l) {
        if (l.gen !== self.gen || (l.canceller && l.canceller.aborted)) return;
        l.keys.forEach(function (k) { set.add(k.dk); });
      });
      return set;
    };
    ChartEngine.prototype._fullLoadActive = function () {
      var a = false;
      this.loads.forEach(function (l) { if (l.kind === 'full') a = true; });
      return a;
    };
    ChartEngine.prototype._cancelAll = function () {
      this.loads.forEach(function (l) { l.canceller.cancel(); });
      this.loads.clear();
      if (this.tick) { this.tick.canceller.cancel(); this.tick = null; }
      this.progress = null;
      if (this._retryTimer != null) { this.timers.clear(this._retryTimer); this._retryTimer = null; }
    };
    /** "<chart>-<gen>-<n>": a response is applied only when its id is the one sent. */
    ChartEngine.prototype._requestId = function () { return this.rid + '-' + this.gen + '-' + (++this._reqN); };
    /** Promise that resolves after ms (a cancelled load simply finds itself superseded afterwards). */
    ChartEngine.prototype._delay = function (ms) {
      var self = this;
      return new Promise(function (resolve) { self.timers.set(resolve, Math.max(0, ms)); });
    };
    function isBusy(res) {
      return res.status === 429 || res.status === 503 || res.code === 'TOO_MANY_REQUESTS' || res.code === 'RATE_LIMITED' ||
        res.code === 'BUSY' || res.code === 'MODULE_STOPPING';
    }
    function isTimeout(res) {
      return res.status === 504 || res.code === 'TIMEOUT' || res.code === 'CLIENT_TIMEOUT';
    }
    ChartEngine.prototype._setBanner = function (code, extra) {
      if (!RENEW_BANNERS[code] && this._authTimer != null) { this.timers.clear(this._authTimer); this._authTimer = null; }
      if (!RENEW_BANNERS[code]) this._authTries = 0;
      if (code == null) { this.banner = null; return; }
      if (RENEW_BANNERS[code]) this._armAuthRetry();
      var kind = code === 'auth' ? 'auth' : code === 'reload' ? 'reload' : code === 'memory' ? 'memory' : 'error';
      var key = 'chart.banner.' + code;
      var text = NS.i18n.t(key, extra || {});
      // codes without their own text are NOT retried (BAD_REQUEST, config/plan errors): no "retrying" promise;
      // only the explicit 'error' code (the retrying catch-all of _loadFailed) says so
      if (text === key) text = NS.i18n.t('chart.banner.failed', { code: code });
      this.banner = { code: code, message: text, kind: kind };
    };

    /**
     * Token renewal retry for the RENEW_BANNERS ('auth': a 401 whose one renewal failed; SESSION_FULL). Ticks skip
     * while such a banner shows, so without a retry a chart.token refused for a transient reason (RATE_LIMITED,
     * CLIENT_TIMEOUT, DISCONNECTED, MODULE_STOPPING) would freeze a wall-mounted trend until a reload. While the
     * banner shows, a renewal is retried with backoff (2 s doubling to 60 s); success recovers like a pushed token.
     */
    ChartEngine.prototype._armAuthRetry = function () {
      var self = this;
      if (this._authTimer != null || !this.mounted || !this.source || typeof this.source.renewToken !== 'function') return;
      var n = this._authTries || 0;
      this._authTimer = this.timers.set(function () {
        self._authTimer = null;
        if (!self.mounted || !self.banner || !RENEW_BANNERS[self.banner.code]) return;
        self._authTries = n + 1;
        if (!self._connected() || self._hidden()) { self._armAuthRetry(); return; }   // a snapshot recovers a reconnect
        self.metrics.authRetries = (self.metrics.authRetries || 0) + 1;
        var again = function () { if (self.mounted && self.banner && RENEW_BANNERS[self.banner.code]) self._armAuthRetry(); };
        Promise.resolve(self.source.renewToken()).then(function (ok) {
          if (!self.mounted || !self.banner || !RENEW_BANNERS[self.banner.code]) return;
          if (ok && credsOf(self.source)) self._onToken(); else again();
        }, again);
      }, Math.min(60000, 2000 * Math.pow(2, Math.min(n, 5))));
    };

    /** Request body for a set of pens (the /v2/history request schema). */
    ChartEngine.prototype._body = function (plan, keys, extra) {
      var reqKeys = {};
      var pens = keys.map(function (k, i) {
        var rk = 'd' + i;
        reqKeys[rk] = k.dk;
        return { key: rk, tagPath: k.tagPath, aggregation: k.aggregation, since: k.since != null ? k.since : null };
      });
      var body = {
        v: 2, requestId: this._requestId(), start: Math.floor(plan.start), end: Math.floor(plan.end), mode: plan.mode,
        aggregation: plan.aggregation, pointCount: plan.pointCount, bucketMs: plan.mode === 'aggregated' ? plan.bucketMs : null,
        onTooManyPoints: extra && extra.onTooManyPoints || plan.onTooManyPoints,
        includeAnchor: extra && extra.includeAnchor != null ? extra.includeAnchor : plan.includeAnchor,
        pens: pens,
      };
      if (plan.mode === 'raw') body.maxPointsPerPen = plan.maxPointsPerPen;
      return { body: body, reqKeys: reqKeys };
    };

    /**
     * Full load: new generation, everything in flight cancelled, all loadable pens over the
     * configured window (or opts.window for a free-range re-query), raw windows in chunks.
     * opts: {resetViewport, keepViewport, window:{start,end}, follow}
     */
    ChartEngine.prototype.fullLoad = function (reason, opts) {
      var o = opts || {};
      var self = this;
      if (!this.mounted || !this.props || !this.source) return;
      if (!this.source.snap) {
        // epoch gap (onEpochChange cleared the snapshot, a new one follows): remember the load like a load
        // refused for a missing token; _onSnapshot runs it through _recoverLoad
        this._deferLoad(o);
        this.changed();
        return;
      }
      this.gen++;
      this._cancelAll();
      var gen = this.gen;
      this.notices = {};
      this._respMode = null;
      this._respBucket = null;
      if (!credsOf(this.source)) {
        // remembered for the recovery load once the token is back (a window change resets the viewport)
        this._deferLoad(o);
        this._setBanner(this._noCredsCode());
        this.changed();
        return;
      }
      this._deferredLoad = null;
      // a retry keeps the banner of the failure it retries until it succeeds (no flicker per attempt)
      if (this.banner && !FATAL_BANNERS[this.banner.code] && !(reason === 'retry' && TRANSIENT_BANNERS[this.banner.code])) {
        this._setBanner(null);
      }
      if (this.banner && this.banner.code === 'reload') { this.changed(); return; }
      var now = this.gwNow();
      var cfg = configWindow(this.props, now, this.timeZone, this.L, now);
      if (cfg.error) { this._setBanner(cfg.error); this.changed(); return; }
      var prevWin = this.window;
      this.window = cfg;
      if (cfg.clampedDays) this.notices.clamped = { days: cfg.clampedDays };
      // A reload that keeps a paused viewport (retry, query change, refresh). The viewport is
      // kept only when the user moved it; a historical viewport still on the configured window reloads that
      // window as configured (no margin: a 25-day raw window must not turn into 37.5 days).
      if (!o.window && o.keepViewport && this.loadedOnce && !this.vp.followLive && this.vp.min != null && !o.resetViewport) {
        if (!this._realtime() && this._vpOnWindow(prevWin)) this._resetViewportState(cfg);
        else o = Object.assign({}, o, { window: this._marginWindow(this.vp.min, this.vp.max, now), follow: false });
      }
      var win = o.window ? { start: Math.max(0, Math.floor(o.window.start)), end: Math.floor(Math.min(o.window.end, now)) } : cfg;
      if (win.end - win.start > this.L.maxRangeDays * DAY) win.start = win.end - this.L.maxRangeDays * DAY;
      if (win.end - win.start < SECOND) win.start = win.end - SECOND;
      var plan = planQuery(this.props, win, this.plotWidth, this.L, now);
      if (plan.error) { this._setBanner(plan.error, { days: plan.days }); this.changed(); return; }
      if (plan.downgraded) this.notices.rawDowngraded = { days: plan.rawDays };
      if (o.resetViewport || !this.loadedOnce) this._resetViewportState(cfg);
      var keys = this._okKeys();
      this.metrics.fullLoads++;
      var live = this._realtime() && (o.window ? (o.follow !== false && win.end >= now - SECOND) : true);
      if (!keys.length) {
        this.coverage = { start: win.start, end: win.end, span: win.end - win.start, mode: plan.mode, bucketMs: plan.bucketMs,
          aggregation: plan.aggregation, pointCount: plan.pointCount, live: live };
        this.loadedOnce = true;
        this.lastSuccess = now;
        this._startLoop();
        this.annotations.request('load', 0);
        this.changed();
        return;
      }
      // (memory guard: a full load replaces the data of its pens; the running total is checked per chunk)
      keys.forEach(function (k) {
        var pd = self.store.ensure(k.dk, k.tagPath, k.aggregation);
        if (!pd.loaded) pd.status = 'loading';
      });
      this.changed();
      var fl = { kind: 'full', gen: gen, keys: keys, plan: plan, reason: reason };
      this._runLoad(fl).then(function (res) {
        if (gen !== self.gen || !self.mounted) return;
        if (res === 'ok' || res === 'partial') {
          // the loaded start belongs to THIS load (a pen-add partial load running beside it keeps its own,
          // cancelling that one must not move the chart coverage)
          var covStart = res === 'partial' && fl.loadedStart != null ? Math.max(plan.start, fl.loadedStart) : plan.start;
          self.coverage = { start: covStart, end: plan.end, span: plan.end - plan.start,
            mode: self._respMode || plan.mode, bucketMs: self._respBucket != null ? self._respBucket : plan.bucketMs,
            aggregation: plan.aggregation, pointCount: plan.pointCount, live: live, downgraded: !!plan.downgraded };
          // "Partially loaded" names the missing older part of the CHART window; it clears once a realtime
          // window slides past it (_applyTick) — per-pen gaps are the pens' own `incomplete` flags
          if (covStart > plan.start) self.notices.partial = { from: covStart };
          if (self.banner && TRANSIENT_BANNERS[self.banner.code]) self._setBanner(null);
          self.loadedOnce = true;
          self._startLoop();
          self.annotations.request('load', 0);               // the window or the pens changed
          // pens that arrived while this load ran
          var missing = [];
          self._okKeys().forEach(function (k) { var pd = self.store.get(k.dk); if (!pd || !pd.loaded) missing.push(k.dk); });
          if (missing.length) self._partialLoad(missing);
        }
        self.changed();
      });
    };

    /** Records a full load that could not run (no token / no snapshot) for _recoverLoad. */
    ChartEngine.prototype._deferLoad = function (o) {
      var dl = this._deferredLoad || {};
      this._deferredLoad = { resetViewport: !!(dl.resetViewport || o.resetViewport || !this.loadedOnce) };
    };
    /** True when the paused viewport is (still) the window w (the configured window of the last load). */
    ChartEngine.prototype._vpOnWindow = function (w) {
      return !!w && this.vp.min != null && Math.abs(this.vp.min - w.start) <= 1 && Math.abs(this.vp.max - w.end) <= 1;
    };
    /**
     * Load window for a viewport [min, max]: 25 % margin on both sides (right edge capped at now) so small
     * pans stay inside the data, but never wider than the mode's range limit — raw query mode: the raw
     * limit (maxRawRangeDays) while the viewport itself fits in it, else maxRangeDays. The margin shrinks
     * first; a viewport wider than the limit keeps its right edge.
     */
    ChartEngine.prototype._marginWindow = function (min, max, now) {
      var sp = max - min;
      var rawLim = this.L.maxRawRangeDays * DAY;
      var lim = this.props && this.props.query.mode === 'raw' && sp <= rawLim ? rawLim : this.L.maxRangeDays * DAY;
      var m = Math.max(0, Math.min(0.25 * sp, (lim - sp) / 2));
      var end = Math.min(max + m, now);
      var start = min - m;
      if (end - start > lim) start = end - lim;
      return { start: start, end: end };
    };
    /**
     * The view stopped following live: `edge` is the live edge it left. Pinned X-Traces placed while
     * live ({fromEndMs}) become fixed times there (onLeaveLive, set by the chart), so a pan / zoom / date change no
     * longer moves them with the view.
     */
    ChartEngine.prototype._leftLive = function (edge) {
      if (typeof this.onLeaveLive === 'function') {
        try { this.onLeaveLive(edge); } catch (e) { log.warn('onLeaveLive failed', e); }
      }
    };
    /** Viewport after a reset or a new configured window. */
    ChartEngine.prototype._resetViewportState = function (cfg) {
      var liveEdge = this.vp && this.vp.followLive && this.vp.max == null && this.props ? this.gwNow() : null;
      if (liveEdge != null && cfg.mode !== 'realtime') this._leftLive(liveEdge);
      if (cfg.mode === 'realtime') this.vp = { followLive: true, span: cfg.span, min: null, max: null };
      else this.vp = { followLive: false, span: cfg.span, min: cfg.start, max: cfg.end };
      this._statsCache.clear();
    };

    /** Partial full-load for pens that joined the chart, over the current coverage. */
    ChartEngine.prototype._partialLoad = function (dks) {
      var self = this;
      if (!this.coverage || !this.props) return;
      var keys = this._okKeys(dks);
      if (!keys.length) return;
      var cov = this.coverage;
      if (cov.mode === 'raw' && this.store.heldPoints() > ENGINE.maxHeldPoints) {
        // memory guard: no further raw loads on top of what is held
        keys.forEach(function (k) { var pd = self.store.ensure(k.dk, k.tagPath, k.aggregation); pd.status = 'error'; });
        this._setBanner('memory');
        this.changed();
        return;
      }
      var now = this.gwNow();
      var end = cov.live ? now : cov.end;
      var start = cov.live && this.vp.followLive ? end - cov.span : cov.start;
      var plan = {
        start: start, end: end, mode: cov.mode, aggregation: this.props.query.aggregation, pointCount: cov.pointCount,
        bucketMs: cov.bucketMs, onTooManyPoints: this.props.query.onTooManyPoints === 'aggregate' && cov.mode === 'raw' ? 'aggregate' : 'error',
        includeAnchor: this.props.query.includeAnchor,
        maxPointsPerPen: Math.min(this.props.query.maxPointsPerPen, this.L.maxRawPointsPerPen),
        downgraded: !!cov.downgraded,
      };
      var gen = this.gen;
      keys.forEach(function (k) { var pd = self.store.ensure(k.dk, k.tagPath, k.aggregation); pd.status = 'loading'; });
      this.metrics.partialLoads++;
      this._runLoad({ kind: 'partial', gen: gen, keys: keys, plan: plan }).then(function () { self.changed(); });
    };

    /**
     * Runs one load (single request, or raw chunks newest first). Resolves 'ok' | 'partial' | 'error' |
     * 'stale' (superseded). Applies results to the store as they arrive.
     */
    ChartEngine.prototype._runLoad = function (load) {
      var self = this;
      load.canceller = new Canceller();
      this.loads.add(load);
      var plan = load.plan;
      var q = this.props.query;
      // auto: chunked when the probe chunk does not already cover the window; explicit: wider than one chunk
      var chunked = plan.mode === 'raw' && q.chunking.enabled && (q.chunking.rawChunk === 'auto'
        ? probeChunk(plan.start, plan.end).start > plan.start
        : plan.end - plan.start > chunkPlan(plan.start, plan.end, q.chunking.rawChunk).chunkMs);
      var p = chunked ? this._runChunks(load) : this._runSingle(load);
      return p.then(function (r) {
        self.loads.delete(load);
        if (load.kind === 'full' && self.progress && self.progress.load === load) self.progress = null;
        if (load.kind !== 'fallback' && self._current(load)) self._retryFailedPens(load);
        return r;
      });
    };
    /**
     * Pens of a finished load that came back with their own 'timeout' or 'error' (the request itself succeeded:
     * a normal outcome under historian load, with the gateway's fair executor and per-pen deadline). Nothing else
     * asks for them again (ticks skip a pen whose status is not ok, a reconcile only reloads a never-loaded key), so
     * without this a dashboard pen could show "History query timed out" for good. They are re-loaded with a pen-add
     * (partial) load: a timeout after 5 s, then like an error with the 2, 4, 8 … 60 s backoff; a success
     * resets the count.
     */
    ChartEngine.prototype._retryFailedPens = function (load) {
      var self = this;
      var dks = [];
      load.keys.forEach(function (k) {
        var pd = self.store.get(k.dk);
        if (!pd) return;
        if (pd.status === 'ok') { pd.retryN = 0; return; }
        if (pd.loaded && (pd.status === 'timeout' || pd.status === 'error') && pd._retryTimer == null && dks.indexOf(k.dk) < 0) dks.push(k.dk);
      });
      if (dks.length) this._schedulePenRetry(dks);
    };
    ChartEngine.prototype._schedulePenRetry = function (dks) {
      var self = this;
      var n = 0, timeout = false;
      dks.forEach(function (dk) {
        var pd = self.store.get(dk);
        pd.retryN = (pd.retryN || 0) + 1;
        n = Math.max(n, pd.retryN);
        if (pd.status === 'timeout') timeout = true;
      });
      var ms = n <= 1 && timeout ? ENGINE.fullRetryMs : backoffMs('failed', n);
      var gen = this.gen;
      var id = this.timers.set(function () {
        dks.forEach(function (dk) { var pd = self.store.get(dk); if (pd && pd._retryTimer === id) pd._retryTimer = null; });
        if (!self.mounted || gen !== self.gen) return;
        var due = dks.filter(function (dk) {
          var pd = self.store.get(dk);
          return pd && (pd.status === 'timeout' || pd.status === 'error');
        });
        if (!due.length) return;
        if (self._fullLoadActive() || !credsOf(self.source)) { self._schedulePenRetry(due); return; }
        self.metrics.penRetries = (self.metrics.penRetries || 0) + 1;
        self._partialLoad(due);
      }, ms);
      dks.forEach(function (dk) { self.store.get(dk)._retryTimer = id; });
    };
    ChartEngine.prototype._current = function (load) {
      return this.mounted && load.gen === this.gen && !load.canceller.aborted;
    };
    ChartEngine.prototype._runSingle = function (load) {
      var self = this;
      var b = this._body(load.plan, load.keys);
      var t0 = Date.now();
      return this.client.post(b.body, { priority: 'user', signal: load.canceller.signal }).then(function (res) {
        if (!self._current(load)) { if (!res.aborted) self.metrics.staleDropped++; return 'stale'; }
        if (!res.ok) return self._loadFailed(load, res);
        if (res.data.requestId !== b.body.requestId) { self.metrics.staleDropped++; return 'stale'; }
        self._applyFull(res.data, b.reqKeys, load);
        perfPush(self.metrics.perf.applyMs, Date.now() - t0);
        return 'ok';
      });
    };
    ChartEngine.prototype._applyFull = function (data, reqKeys, load) {
      var self = this;
      var win = data.window || {};
      if (load.kind === 'full') { this._respMode = win.mode; this._respBucket = win.bucketMs != null ? win.bucketMs : null; }
      var alone = [];                // refused only by the RESPONSE cap: re-loaded on their own
      (data.pens || []).forEach(function (wp) {
        var dk = reqKeys[wp.key];
        if (!dk) return;
        if (wp.status === 'ok') {
          var pd = self.store.applyFull(dk, wp, win);
          if (load.plan.downgraded && pd) { pd.downgraded = true; if (pd.coverage) pd.coverage.downgraded = true; }
        } else if (wp.status === 'tooManyPoints' && load.keys.length > 1 &&
            refusalKind(wp.limit, load.plan.maxPointsPerPen, self.L.maxPointsPerResponse) === 'response') {
          // the pen is not over its own cap: the whole response was. The permanent tooManyPoints state would
          // wipe it and nothing would ask again. Alone it fits.
          var rp = self.store.get(dk);
          if (rp) rp.status = 'loading';
          alone.push(dk);
        } else self.store.setStatus(dk, wp.status, wp);
      });
      if (alone.length) {
        var agen = this.gen;
        this.metrics.responseCapReloads = (this.metrics.responseCapReloads || 0) + alone.length;
        this.timers.set(function () {
          if (!self.mounted || agen !== self.gen) return;
          alone.forEach(function (dk) { self._partialLoad([dk]); });
        }, 0);
      }
      this.lastSuccess = this.gwNow();
      this.failures = 0;
      this.tickFailures = 0;
      this.busyCount = 0;
      delete this.notices.busy;
      this._joins.forEach(function (j) { j.reset(); });
      this._statsCache.clear();
      // tooManyPoints with the aggregate fallback in a chunked/partial context is handled by the caller
    };
    /**
     * Raw chunked load: newest piece first (priority user, drawn at once), then older
     * pieces one after the other (priority chunk). rawChunk "auto" plans adaptively (probeChunk, then
     * adaptiveChunkWidth / nextAdaptiveChunk from the measured density); an explicit rawChunk uses the fixed
     * epoch-aligned chunkPlan. Per-pen running totals enforce the client cap over the SUM of the pieces; a pen
     * over it stops loading (tooManyPoints) or, with onTooManyPoints "aggregate", is re-queried aggregated over
     * the whole window. Pens the gateway refuses only because the RESPONSE would be too large
     * (maxPointsPerResponse: tooManyPoints with a limit other than the per-pen cap) get that piece again in two
     * halves (newer half first, so every pen's data stays newest-first and contiguous) before the load moves
     * on to older data. Cancel keeps what is loaded ("Partially loaded").
     */
    ChartEngine.prototype._runChunks = function (load) {
      var self = this;
      var plan = load.plan;
      var q = this.props.query;
      var auto = q.chunking.rawChunk === 'auto';
      var fixed = auto ? null : chunkPlan(plan.start, plan.end, q.chunking.rawChunk).chunks;      // newest first
      var cap = plan.maxPointsPerPen;
      var responseCap = this.L.maxPointsPerResponse;
      var totals = {};               // data key -> points this load stored for it
      var started = {};              // data key -> its newest piece is stored (later pieces are prepended)
      var active = load.keys.slice();
      var fallback = [];
      var splits = [];               // pending halves for pens refused by the response cap: {start, end, keys, depth}
      var edge = plan.end;           // oldest boundary of the window-wide sequence so far
      var fixedIdx = 0;
      var lastWidth = CHUNK.probeMs;
      var points = 0;
      var anyOk = false;
      var dropped = false;           // a pen left the load after a later-chunk timeout/error
      var piece = null;              // the piece being requested (kept across busy retries)
      var progress = { load: load, done: 0, total: auto ? 1 : fixed.length, points: 0, pct: 0, cancel: function () { self.cancelLoad(); } };
      if (load.kind === 'full') this.progress = progress;
      load.loadedStart = plan.end;    // per load: a partial (pen-add) load never moves the full load's value
      load.pieces = [];               // per-piece record for tests and debugging: [{start, end, pens, points, split}]
      var attempts = 0;
      // points per ms of a pen over what this load holds of it (the window-wide sequence reached `edge`)
      var density = function (k) { var span = plan.end - edge; return span > 0 ? (totals[k.dk] || 0) / span : 0; };
      var nextPiece = function () {
        if (splits.length) return splits.shift();
        if (!active.length || edge <= plan.start) return null;
        var ch;
        if (!auto) ch = fixed[fixedIdx] || null;
        else if (edge === plan.end) ch = probeChunk(plan.start, plan.end);
        else {
          lastWidth = adaptiveChunkWidth(active.map(density), cap, responseCap, edge - plan.start);
          ch = nextAdaptiveChunk(plan.start, edge, lastWidth);
        }
        return ch ? { start: ch.start, end: ch.end, keys: null, depth: 0, global: true } : null;
      };
      var remainingEstimate = function () {
        var left = edge - plan.start;
        if (!auto) return fixed.length - fixedIdx + splits.length;
        return splits.length + (left > 0 ? Math.max(1, Math.ceil(left / Math.max(lastWidth, CHUNK.probeMs))) : 0);
      };
      var step = function () {
        if (!self._current(load)) return Promise.resolve(load.cancelled ? 'partial' : 'stale');
        if (!piece) piece = nextPiece();
        var pc = piece;
        if (!pc) return Promise.resolve('ok');
        var keys = pc.keys ? pc.keys.filter(function (k) { return active.indexOf(k) >= 0; }) : active.slice();
        if (!keys.length) { piece = null; return step(); }
        var firstReq = progress.done === 0;
        var b = self._body(Object.assign({}, plan, { start: pc.start, end: pc.end }), keys,
          { onTooManyPoints: 'error', includeAnchor: pc.start <= plan.start && plan.includeAnchor });
        b.body.maxPointsPerPen = cap;
        self.metrics.chunkRequests++;
        return self.client.post(b.body, { priority: firstReq ? 'user' : 'chunk', signal: load.canceller.signal }).then(function (res) {
          if (!self._current(load)) {
            if (!res.aborted) self.metrics.staleDropped++;
            return load.cancelled ? 'partial' : 'stale';
          }
          if (!res.ok) {
            // busy: the same piece again after Retry-After (the queue holds it back meanwhile)
            if (isBusy(res) && ++attempts <= 5) {
              self.busyCount++;
              if (self.busyCount >= 3) { self.notices.busy = true; self.changed(); }
              return self._delay(busyBackoffMs(res, attempts)).then(step);
            }
            // a later, wide piece timed out: ask for it again in halves — an adaptive piece
            // sized from a sparse probe can be the whole remaining window
            if (!firstReq && isTimeout(res) && timeoutSplittable(pc)) {
              attempts = 0;
              self.metrics.timeoutSplits = (self.metrics.timeoutSplits || 0) + 1;
              splits = splitPiece(Object.assign({}, pc, { why: 'timeout' }), keys).concat(splits);
              if (pc.global) { edge = pc.start; if (!auto) fixedIdx++; }
              piece = null;
              return step();
            }
            if (firstReq) return self._loadFailed(load, res);
            // a later piece failed: keep what is loaded ("Partially loaded": the caller sets the notice from
            // load.loadedStart, so it can clear once a realtime window slides past the missing part)
            self.metrics.lastError = res.code;
            return 'partial';
          }
          attempts = 0;
          if (res.data.requestId !== b.body.requestId) { self.metrics.staleDropped++; return 'stale'; }
          var win = res.data.window || {};
          var keep = [], refused = [];
          var got = 0;
          (res.data.pens || []).forEach(function (wp) {
            var dk = b.reqKeys[wp.key];
            if (!dk) return;
            var k = keys.filter(function (a) { return a.dk === dk; })[0];
            if (!k) return;
            if (wp.status === 'ok') {
              // raw windows are inclusive at both ends, so the sample on a piece edge comes twice: count only what the
              // store keeps (an older piece adds the samples before the pen's first one), else a window of exactly
              // the cap would be refused (100 000 points in 2 pieces counted as 100 001)
              var n = Array.isArray(wp.t) ? wp.t.length : 0;
              var held = started[dk] ? self.store.get(dk) : null;
              if (held && held.t.length && n) n = lowerBound(wp.t, held.t[0]);
              totals[dk] = (totals[dk] || 0) + n;
              if (totals[dk] > cap) {
                self._capExceeded(dk, cap, fallback, k);
                return;
              }
              if (!started[dk]) {
                self.store.applyFull(dk, wp, { start: pc.start, end: plan.end, mode: 'raw', aggregation: null });
                started[dk] = true;
              } else self.store.prependChunk(dk, wp, win);
              points += n;
              got += n;
              anyOk = true;
              keep.push(k);
            } else if (wp.status === 'tooManyPoints') {
              // the RESPONSE was too large (maxPointsPerResponse), not this pen: halve the piece for it; a limit
              // the client does not know (stale limits) gets a little splitting, then the gateway's word
              var why = refusalKind(wp.limit, cap, responseCap);
              var depthMax = why === 'response' ? CHUNK.maxSplitDepth : why === 'unknown' ? CHUNK.unknownLimitSplitDepth : -1;
              if (pc.depth < depthMax && pc.end - pc.start > CHUNK.minSplitMs) refused.push(k);
              else self._capExceeded(dk, why === 'pen' ? cap : wp.limit, fallback, k);
            } else if (wp.status === 'timeout' && timeoutSplittable(pc)) {
              // this pen timed out on a wide piece: ask for the piece again in halves
              self.metrics.timeoutSplits = (self.metrics.timeoutSplits || 0) + 1;
              refused.push(k);
            } else if (started[dk] && (wp.status === 'timeout' || wp.status === 'error')) {
              // a later piece timed out / failed for this pen only (a normal outcome under load): keep
              // the newer data already drawn, stop loading this pen (its coverage stays the loaded span)
              // and say so — like a failed request
              var pdw = self.store.get(dk);
              if (pdw) { pdw.warn = wp.status; pdw.incomplete = wp.status; bump(pdw, false); }
              dropped = true;
            } else {
              self.store.setStatus(dk, wp.status, wp);
            }
          });
          // pens of this piece that left the load: over the cap, failed, or another status
          active = active.filter(function (a) { return keys.indexOf(a) < 0 || keep.indexOf(a) >= 0 || refused.indexOf(a) >= 0; });
          if (refused.length) splits = splitPiece(pc, refused).concat(splits);
          if (pc.global) { edge = pc.start; if (!auto) fixedIdx++; }
          piece = null;
          load.pieces.push({ start: pc.start, end: pc.end, pens: keys.length, points: got, split: pc.depth || 0 });
          // the loaded span grows only by a piece that some pen actually loaded (a piece in which every pen
          // timed out or went over the cap is not data the chart holds)
          if (keep.length) load.loadedStart = Math.min(load.loadedStart, pc.start);
          progress.done++;
          progress.points = points;
          progress.total = progress.done + remainingEstimate();
          progress.pct = Math.round(100 * (plan.end - Math.max(plan.start, edge)) / Math.max(1, plan.end - plan.start));
          if (self.store.heldPoints() > ENGINE.maxHeldPoints && (splits.length || (active.length && edge > plan.start))) {
            // memory guard: stop here, keep what is loaded
            self._setBanner('memory');
            self.changed();
            return 'partial';
          }
          self.lastSuccess = self.gwNow();
          self.failures = 0;
          self._joins.forEach(function (j) { j.reset(); });
          self._statsCache.clear();
          self.changed();
          return step();
        });
      };
      return step().then(function (r) {
        if (fallback.length && self._current(load)) self._aggregateFallback(fallback, plan, load);
        // a dropped pen makes the load partial even when the remaining pens finished: the chart coverage is
        // then the span some pen loaded, not the planned window (a pan into the gap re-queries)
        if (r === 'partial' || load.cancelled || (dropped && r === 'ok')) {
          // a pen-add (partial) load that stopped early leaves its pens incomplete, never the chart coverage
          if (load.kind === 'partial') markIncomplete(self, load, 'partial');
          return anyOk ? 'partial' : 'error';
        }
        return r;
      });
    };
    /**
     * Pens of a pen-add load that stopped early (cancelled, a later chunk failed): the data they got stays,
     * the older part is missing — the pen row says so (model warn/incomplete) instead of the chart coverage.
     */
    function markIncomplete(engine, load, why) {
      load.keys.forEach(function (k) {
        var pd = engine.store.get(k.dk);
        if (pd && pd.t.length && !pd.incomplete) { pd.incomplete = why; bump(pd, false); }
      });
    }
    /** A pen went over the client cap during a chunked load. */
    ChartEngine.prototype._capExceeded = function (dk, cap, fallback, k) {
      if (this.props.query.onTooManyPoints === 'aggregate' && k) fallback.push(k);
      this.store.setStatus(dk, 'tooManyPoints', { limit: cap });
    };
    /** onTooManyPoints "aggregate" for chunked pens: one aggregated request for those pens over the window. */
    ChartEngine.prototype._aggregateFallback = function (keys, plan, parent) {
      var self = this;
      var now = this.gwNow();
      var p = this.props;
      var pc = plannedPointCount(p, this.plotWidth, this.L);
      var bms = computeBucket(plan.start, plan.end, Math.min(plan.end, now), pc, this.L.minBucketMs, this.L.pointCountMax, this.L.bucketLadder);
      var agg = { start: plan.start, end: plan.end, mode: 'aggregated', aggregation: p.query.aggregation, pointCount: pc,
        bucketMs: bms, onTooManyPoints: 'error', includeAnchor: plan.includeAnchor, maxPointsPerPen: plan.maxPointsPerPen };
      var load = { kind: 'fallback', gen: parent.gen, keys: keys, plan: agg };
      this._runLoad(load).then(function () {
        keys.forEach(function (k) {
          var pd = self.store.get(k.dk);
          if (pd && pd.status === 'ok') { pd.downgraded = true; pd.coverage.downgraded = true; bump(pd, false); }
        });
        self.changed();
      });
    };
    /** Load error handling. Returns 'error'. */
    ChartEngine.prototype._loadFailed = function (load, res, keepData) {
      var self = this;
      this.metrics.lastError = res.code;
      var code = res.code;
      if (load.kind === 'fallback') return 'error';
      var retry = function (ms) {
        if (load.kind === 'partial') {
          var dks = load.keys.map(function (k) { return k.dk; });
          self.timers.set(function () {
            if (self.mounted && load.gen === self.gen && !self._fullLoadActive()) self._partialLoad(dks);
          }, ms);
          return;
        }
        if (self._retryTimer != null) self.timers.clear(self._retryTimer);
        self._retryTimer = self.timers.set(function () {
          self._retryTimer = null;
          if (self.mounted && load.gen === self.gen) self.fullLoad('retry', { keepViewport: true });
        }, ms);
      };
      // pens that never loaded say why (row "history query timed out" vs "history query failed")
      var penStatus = res.status === 504 || code === 'TIMEOUT' || code === 'CLIENT_TIMEOUT' ? 'timeout' : 'error';
      if (!keepData) load.keys.forEach(function (k) { var pd = self.store.get(k.dk); if (pd && !pd.loaded) pd.status = penStatus; });
      if (res.status === 401 || /^TOKEN_/.test(code)) {
        this._setBanner('auth');
      } else if (code === 'NO_TOKEN' || code === 'SESSION_MISMATCH') {
        this._setBanner('SESSION_MISMATCH');
      } else if (res.status === 409 || code === 'PROTOCOL_MISMATCH') {
        this._setBanner('reload');
      } else if (code === 'RANGE_INVALID' || code === 'RANGE_TOO_LARGE' || code === 'TOO_MANY_PENS' || code === 'BAD_REQUEST') {
        this._setBanner(code);
      } else if (res.status === 429 || res.status === 503 || code === 'TOO_MANY_REQUESTS' || code === 'RATE_LIMITED' || code === 'BUSY') {
        this.busyCount++;
        if (this.busyCount >= 3) this.notices.busy = true;
        retry(busyBackoffMs(res, this.busyCount));
      } else if (res.status === 504 || code === 'TIMEOUT' || code === 'CLIENT_TIMEOUT') {
        // Never give up. The first timeout retries after 5 s without a banner; from the second one on the
        // banner says so and the retries back off (5 s … 60 s) until a load succeeds, so a realtime chart
        // whose loads time out repeatedly recovers by itself once the historian answers again.
        this.failures++;
        if (this.failures >= 2) this._setBanner('timeout');
        retry(Math.max(ENGINE.fullRetryMs, this.failures <= 1 ? 0 : backoffMs('failed', this.failures)));
      } else if (code === 'NETWORK') {
        this.failures++;
        this._setBanner('network');
        retry(backoffMs('network', this.failures));
      } else {
        this.failures++;
        this._setBanner('error', { code: code });
        retry(backoffMs('failed', this.failures));
      }
      this.changed();
      return 'error';
    };
    /**
     * Cancel button of the chunk progress: keep what is loaded. A cancelled FULL load makes the chart coverage
     * the span it loaded ("Partially loaded"); a cancelled pen-add (partial) load only marks its own pens
     * incomplete — the rest of the chart is still covered.
     */
    ChartEngine.prototype.cancelLoad = function () {
      var self = this;
      var full = null;
      this.loads.forEach(function (l) {
        if (l.kind === 'full' || l.kind === 'partial') { l.cancelled = true; l.canceller.cancel(); }
        if (l.kind === 'full') full = l;
        else if (l.kind === 'partial') markIncomplete(self, l, 'partial');
      });
      if (full && full.loadedStart != null) {
        var ls = full.loadedStart;
        if (this.coverage == null && this.window) {
          // first load cancelled: the coverage is what arrived
          var cfg = this.window;
          this.coverage = { start: ls, end: cfg.end, span: cfg.end - ls, mode: 'raw', bucketMs: null,
            aggregation: this.props.query.aggregation, pointCount: plannedPointCount(this.props, this.plotWidth, this.L),
            live: this._realtime() };
          this.loadedOnce = true;
          this._startLoop();
        } else if (this.coverage) {
          this.coverage.start = Math.max(this.coverage.start, ls);
        }
        if (this.coverage && this.coverage.start > full.plan.start) this.notices.partial = { from: this.coverage.start };
      }
      this.progress = null;
      this.store.keys().forEach(function (dk) { var pd = self.store.get(dk); if (pd.status === 'loading') pd.status = pd.loaded ? 'ok' : 'error'; });
      this.changed();
    };
    /** Refresh button: a new full load keeping the viewport mode. */
    ChartEngine.prototype.reload = function () { this.fullLoad('refresh', { keepViewport: true }); };

    // ---- realtime tick loop ------------------------------------------------------------
    ChartEngine.prototype._schedule = function (ms) {
      var self = this;
      if (!this.mounted) return;
      if (this._timer != null) this.timers.clear(this._timer);
      this._nextTickAt = Date.now() + Math.max(0, ms);          // read by the range selector (strip after a tick)
      this._timer = this.timers.set(function () { self._timer = null; self._tickLoop(); }, Math.max(0, ms));
    };
    ChartEngine.prototype._startLoop = function () {
      if (!this._realtime() || !this.props || this.props.timeRange.refreshRate === 0) return;
      // first tick: + random 0–10 % jitter so several charts on a page do not fire in lockstep
      var rr = this.props.timeRange.refreshRate;
      if (this._timer == null) this._schedule(rr + Math.floor(Math.random() * rr * 0.1));
    };
    /** Catch-up after visibility / reconnect: a tick, or a full load when the gap exceeds the window. */
    ChartEngine.prototype._catchUp = function () {
      if (!this.loadedOnce || !this.coverage || !this._realtime()) return;
      if (this._hidden()) return;
      var gapMs = this.gwNow() - this.coverage.end;
      if (this.vp.followLive && gapMs > this.coverage.span) this.fullLoad('catchup', { keepViewport: true });
      else this._schedule(0);
    };
    ChartEngine.prototype._staleAfter = function () {
      var p = this.props;
      if (p.appearance.staleAfterMs > 0) return p.appearance.staleAfterMs;
      return Math.max(3 * p.timeRange.refreshRate, 10000);
    };
    ChartEngine.prototype._checkStale = function () {
      var s = this._staleSince();
      if (s !== this._lastStaleSince) { this._lastStaleSince = s; this.changed(); }
    };
    ChartEngine.prototype._staleSince = function () {
      if (!this._realtime() || !this.loadedOnce || !this.lastSuccess || !this.vp.followLive) return null;
      return this.gwNow() - this.lastSuccess > this._staleAfter() ? this.lastSuccess : null;
    };
    ChartEngine.prototype._tickLoop = function () {
      var self = this;
      if (!this.mounted || !this.props) return;
      if (!this._realtime() || this.props.timeRange.refreshRate === 0) return;          // no reschedule
      var rr = this.props.timeRange.refreshRate;
      this.metrics.ticks++;
      this._checkStale();
      var creds = credsOf(this.source);
      if (this._hidden() || !this._connected() || !creds || (this.banner && (FATAL_BANNERS[this.banner.code] || this.banner.code === 'auth'))) {
        this.metrics.skippedTicks++;
        this._schedule(rr);
        return;
      }
      if (this.tick || this.loads.size || !this.coverage) { this.metrics.skippedTicks++; this._schedule(rr); return; }
      var cov = this.coverage;
      if (!this.vp.followLive && !cov.live) { this.metrics.skippedTicks++; this._schedule(rr); return; }   // viewport in the past
      var now = this.gwNow();
      if (this.vp.followLive && now - cov.end > cov.span) { this.fullLoad('catchup', { keepViewport: true }); return; }
      if (creds.expiresAt && creds.expiresAt - now < renewBeforeMs(creds) && !this._renewing) {
        this._renewing = true;
        this.source.renewToken().then(function () { self._renewing = false; });
      }
      var start = this.vp.followLive ? Math.max(0, Math.floor(now - cov.span)) : cov.start;
      var keys = [];
      var down = {};                                       // bucketMs -> keys of downgraded pens
      this._okKeys().forEach(function (k) {
        var pd = self.store.get(k.dk);
        if (!pd || !pd.loaded || pd.status !== 'ok' || !pd.coverage) return;
        if (pd.coverage.mode !== cov.mode) {
          // A raw chart's pen that the gateway answered aggregated (onTooManyPoints "aggregate") cannot ride the
          // raw tick (its history would freeze and slide out of the window): it ticks on its own grid instead.
          if (cov.mode === 'raw' && pd.coverage.mode === 'aggregated' && pd.coverage.bucketMs > 0) {
            k.since = Math.max(pd.lastHistT != null ? pd.lastHistT : start, start);
            (down[pd.coverage.bucketMs] || (down[pd.coverage.bucketMs] = [])).push(k);
          }
          return;
        }
        k.since = planIncrementalSince(pd, start, now);
        if (k.since < Math.max(pd.lastHistT != null ? pd.lastHistT : start, start)) self.metrics.badRunReplays = (self.metrics.badRunReplays || 0) + 1;
        keys.push(k);
      });
      var groups = [];
      var maxPts = Math.min(this.props.query.maxPointsPerPen, this.L.maxRawPointsPerPen);
      if (keys.length) {
        groups.push({ keys: keys, plan: {
          start: start, end: now, mode: cov.mode, aggregation: this.props.query.aggregation, pointCount: cov.pointCount,
          bucketMs: cov.bucketMs, onTooManyPoints: 'error', includeAnchor: false, maxPointsPerPen: maxPts,
        } });
      }
      Object.keys(down).forEach(function (bms) {
        groups.push({ keys: down[bms], plan: {
          start: start, end: now, mode: 'aggregated', aggregation: self.props.query.aggregation, pointCount: cov.pointCount,
          bucketMs: Number(bms), onTooManyPoints: 'error', includeAnchor: false, maxPointsPerPen: maxPts,
        } });
      });
      if (!groups.length) {
        // nothing to refresh (no loadable pen): the chart is as current as it can be
        this.lastSuccess = now;
        this._schedule(rr);
        return;
      }
      var gen = this.gen;
      var canceller = new Canceller();
      var tk = { canceller: canceller, gen: gen };
      this.tick = tk;
      var bodies = groups.map(function (g) { return self._body(g.plan, g.keys); });
      this.metrics.tickRequests += bodies.length;
      this.metrics.sinceSent += keys.length;
      var b0 = bodies[0];
      this.metrics.lastTickBody = { start: b0.body.start, end: b0.body.end, mode: b0.body.mode, bucketMs: b0.body.bucketMs,
        pens: b0.body.pens.map(function (p) { return { since: p.since }; }) };
      var t0 = Date.now();
      Promise.all(bodies.map(function (b) {
        return self.client.post(b.body, { priority: 'tick', signal: canceller.signal });
      })).then(function (results) {
        if (self.tick === tk) self.tick = null;
        if (!self.mounted) return;
        var elapsed = Date.now() - t0;
        if (gen !== self.gen || canceller.aborted) {
          results.forEach(function (res) { if (!res.aborted) self.metrics.staleDropped++; });
          return;
        }
        var next = Math.max(250, rr - elapsed);
        var failed = null;
        results.forEach(function (res, i) {
          if (!res.ok) { failed = failed || res; return; }
          if (res.data.requestId !== bodies[i].body.requestId) { self.metrics.staleDropped++; return; }
          self._applyTick(res.data, bodies[i].reqKeys, start);
        });
        if (failed) { next = self._tickFailed(failed, rr); if (next != null) self._schedule(next); return; }
        perfPush(self.metrics.perf.applyMs, Date.now() - t0 - elapsed);
        self._schedule(next);
      });
    };
    ChartEngine.prototype._applyTick = function (data, reqKeys, start) {
      var self = this;
      var win = data.window || {};
      var cov = this.coverage;
      (data.pens || []).forEach(function (wp) {
        var dk = reqKeys[wp.key];
        if (!dk) return;
        var pd = self.store.get(dk);
        if (!pd) return;
        if (wp.status === 'ok') self.store.applyIncremental(dk, wp, win);
        else if (wp.status === 'timeout' || wp.status === 'error') { pd.warn = wp.status; bump(pd, false); }
        else if (wp.status === 'tooManyPoints' && refusalKind(wp.limit, Math.min(self.props.query.maxPointsPerPen, self.L.maxRawPointsPerPen),
            self.L.maxPointsPerResponse) === 'response') {
          // the response cap, not this pen's: keep its data, the next tick asks again from lastHistT
          pd.warn = 'error'; bump(pd, false);
        }
        else self.store.setStatus(dk, wp.status, wp);
      });
      if (NS.util.isFiniteNum(win.end)) cov.end = Math.max(cov.end, win.end);
      cov.live = true;
      if (this.vp.followLive) {
        cov.start = start;
        this.store.keys().forEach(function (dk) { self.store.trim(dk, start); });
        // the window slid past the part a cancelled/partial load never loaded
        var np = this.notices.partial;
        if (np && (np.from == null || start >= np.from)) delete this.notices.partial;
      }
      this.lastSuccess = this.gwNow();
      this.failures = 0;
      this.tickFailures = 0;
      this.busyCount = 0;
      delete this.notices.busy;
      if (this.banner && TRANSIENT_BANNERS[this.banner.code]) this._setBanner(null);
      this._lastStaleSince = null;
      this.changed();
    };
    /** Tick errors. Returns the delay of the next tick, or null to stop the loop. */
    ChartEngine.prototype._tickFailed = function (res, rr) {
      var code = res.code;
      this.metrics.lastError = code;
      this.changed();
      if (res.status === 409 || code === 'PROTOCOL_MISMATCH') { this._setBanner('reload'); return null; }
      if (code === 'NO_TOKEN' || code === 'SESSION_MISMATCH') { this._setBanner('SESSION_MISMATCH'); return null; }
      if (res.status === 401 || /^TOKEN_/.test(code)) { this._setBanner('auth'); return Math.max(rr, 30000); }
      if (code === 'RANGE_INVALID') { this.fullLoad('replan', { keepViewport: true }); return null; }       // grid no longer accepted
      if (code === 'RANGE_TOO_LARGE' || code === 'TOO_MANY_PENS' || code === 'BAD_REQUEST') { this._setBanner(code); return null; }
      if (res.status === 429 || res.status === 503 || code === 'TOO_MANY_REQUESTS' || code === 'RATE_LIMITED' || code === 'BUSY' || code === 'MODULE_STOPPING') {
        this.busyCount++;
        if (this.busyCount >= 3) this.notices.busy = true;
        return Math.max(rr, busyBackoffMs(res, this.busyCount));
      }
      if (res.status === 504 || code === 'TIMEOUT' || code === 'CLIENT_TIMEOUT') return rr;
      // ticks keep their own count: a failing tick beside a retrying full load must not double the full load's
      // backoff steps (2 / 4 / 8 s)
      this.tickFailures++;
      if (code === 'NETWORK') return Math.max(rr, backoffMs('network', this.tickFailures));
      return Math.max(rr, backoffMs('failed', this.tickFailures));
    };

    // ---- viewport (the gestures live in ChartInteraction) -------------------------
    ChartEngine.prototype.viewportGet = function () {
      var vp = this.vp;
      if (this._realtime() && vp.followLive) {
        var max = this.gwNow();
        return { min: max - vp.span, max: max, followLive: true, span: vp.span };
      }
      if (vp.min == null || vp.max == null) {
        var c = this.coverage || this.window;
        return { min: c ? c.start : null, max: c ? c.end : null, followLive: false, span: c ? c.end - c.start : vp.span };
      }
      return { min: vp.min, max: vp.max, followLive: false, span: vp.max - vp.min };
    };
    /**
     * Gesture result [min, max] (pan release, zoom box, wheel idle, keyboard). Realtime: following live when
     * the right edge is at now (within 2 % of the span or one bucket); free range: debounced re-query when
     * the data does not cover the view or its resolution is off by 2x; without free range the view is
     * clamped to the loaded coverage (pure magnification).
     */
    /**
     * The view a gesture may show for the requested [min, max] (no state change): the span clamped to
     * [max(1 s, 10 x minBucketMs), the mode's range limit] around the centre, never starting after now
     * (and never more than 60 s past it), and — without free range — inside the loaded coverage (pure
     * magnification). The gesture previews (SECTION 18) use it, so what the user drags is what viewportSet() keeps.
     */
    ChartEngine.prototype.clampView = function (r) {
      var now = this.gwNow();
      var a = r.min, b = Math.min(r.max, now + 60000);
      var mode = this.coverage ? this.coverage.mode : 'aggregated';
      var span = clampSpan(b - a, mode, this.L);
      if (span !== b - a) {
        // zoom around the requested focal point when one is given (wheel / pinch), else around the centre
        var f = NS.util.isFiniteNum(r.focal) ? NS.util.clamp((r.focal - a) / (b - a), 0, 1) : 0.5;
        var fx = a + f * (b - a);
        a = fx - f * span; b = a + span;
      }
      if (a > now) { a = now - span; b = now; }                     // cannot pan into the future
      if (b > now + 60000) { a -= b - now - 60000; b = now + 60000; }
      var free = this.props ? this.props.interaction.panAndZoom.freeRange : true;
      if (!free && this.coverage) {
        var cs = this.coverage.start, ce = this._realtime() ? Math.max(this.coverage.end, now) : this.coverage.end;
        if (b - a > ce - cs) { a = cs; b = ce; }
        if (a < cs) { b += cs - a; a = cs; }
        if (b > ce) { a -= b - ce; b = ce; }
      }
      return { min: a, max: b };
    };
    ChartEngine.prototype.viewportSet = function (r) {
      if (!r || !NS.util.isFiniteNum(r.min) || !NS.util.isFiniteNum(r.max) || !(r.max > r.min)) return this.viewportGet();
      var self = this;
      var now = this.gwNow();
      var cv = this.clampView(r);
      var a = cv.min, b = cv.max;
      var free = this.props ? this.props.interaction.panAndZoom.freeRange : true;
      var liveEdge = this._realtime() && this.vp && this.vp.followLive ? this.viewportGet().max : null;
      if (this._realtime()) {
        var bucket = this.coverage && this.coverage.bucketMs ? this.coverage.bucketMs : 1000;
        var follow = b >= now - Math.max(0.02 * (b - a), bucket);
        this.vp = follow ? { followLive: true, span: b - a, min: null, max: null } : { followLive: false, span: b - a, min: a, max: b };
      } else {
        this.vp = { followLive: false, span: b - a, min: a, max: b };
      }
      if (liveEdge != null && !this.vp.followLive) this._leftLive(liveEdge);
      this._statsCache.clear();
      if (free && this.props) {
        if (this._requeryTimer != null) this.timers.clear(this._requeryTimer);
        this._requeryTimer = this.timers.set(function () {
          self._requeryTimer = null;
          self._maybeRequery();
        }, ENGINE.requeryDebounceMs);
      }
      this.annotations.onViewport();
      this.changed();
      return this.viewportGet();
    };
    ChartEngine.prototype._maybeRequery = function () {
      if (!this.mounted || !this.props) return;
      var v = this.viewportGet();
      var now = this.gwNow();
      if (!needsRequery(v.min, v.max, this.coverage, this.props, this.plotWidth, this.L, now, v.followLive)) return;
      var w = this._marginWindow(v.min, v.followLive ? now : v.max, now);
      this.fullLoad('requery', { keepViewport: true, window: w, follow: v.followLive });
    };
    /**
     * Reset zoom (button, double-click, Home): realtime -> follow live over the configured window; historical
     * -> the configured [start, end]. A load runs only when the coverage does not match.
     */
    ChartEngine.prototype.viewportReset = function () {
      if (!this.props) return null;
      var now = this.gwNow();
      var cfg = configWindow(this.props, now, this.timeZone, this.L, this.window ? this.window.end : now);
      if (cfg.error) return this.viewportGet();
      this._resetViewportState(cfg);
      var cov = this.coverage;
      var plan = planQuery(this.props, cfg, this.plotWidth, this.L, now);
      var matches = cov && !plan.error && cov.mode === plan.mode && (plan.mode === 'raw' || cov.bucketMs === plan.bucketMs) &&
        Math.abs(cov.span - cfg.span) <= Math.max(SECOND, 0.01 * cfg.span) &&
        (this._realtime() ? cov.live : (cov.start <= cfg.start && cov.end >= cfg.end));
      if (!matches) this.fullLoad('reset', { resetViewport: true });
      else this.annotations.onViewport();
      this.changed();
      return this.viewportGet();
    };

    // ---- outputs for the render layer -------------------------------------------------
    /**
     * Live value of a noHistory pen (chart.values carries pens published ok OR noHistory). Such a
     * pen has no data key, so nothing is stored, drawn or requested from history; the "Current" column shows
     * the delegate's latest value while following live. Bad quality / non-finite -> v null (shown as "—").
     */
    ChartEngine.prototype._liveOnlyCurrent = function (penKey) {
      var pen = null;
      for (var i = 0; i < this.pens.length; i++) if (this.pens[i].key === penKey) { pen = this.pens[i]; break; }
      if (!pen || pen.dataKey || !pen.info || pen.info.status !== 'noHistory') return null;
      var vals = this.source && this.source.values;
      var val = vals && hasOwn.call(vals, penKey) ? vals[penKey] : null;
      if (!val) return null;
      var lvl = val.q && val.q.level;
      var raw = typeof val.v === 'boolean' ? (val.v ? 1 : 0) : val.v;
      var good = (lvl == null || lvl === 'good') && NS.util.isFiniteNum(raw);
      return { v: good ? raw : null, q: val.q || null, t: NS.util.isFiniteNum(val.t) ? val.t : null, label: 'current' };
    };
    ChartEngine.prototype.penData = function (penKey) {
      for (var i = 0; i < this.pens.length; i++) {
        if (this.pens[i].key === penKey) return this.pens[i].dataKey ? this.store.get(this.pens[i].dataKey) : null;
      }
      return null;
    };
    /**
     * View options. draw true = the plot's view, with the gap breaks of appearance.breakOnGapMs (a null at the
     * middle of each long gap, so the line breaks). Everything that reads values (stats, Current/End, X-Trace,
     * series.rows / CSV, the brush) uses the data view without them: those nulls are not samples, and read as
     * bad quality they would invent Bad rows in the CSV and break First/Min/Avg.
     */
    ChartEngine.prototype._viewOpts = function (draw) {
      return { live: this._realtime(), breakOnGapMs: draw && this.props ? this.props.appearance.breakOnGapMs : 0 };
    };
    /**
     * One pen as EXPORT rows (api.series.rows / CSV): real samples and real bucket stamps, never
     * draw positions. Raw data as the data view; aggregated rows at the bucket START the historian returned
     * (no bucketShift, no +1 ms on the second MinMax row: both rows of a pair share the bucket time), live
     * samples after the history as in the view. Returns {t, v, aggregation} (aggregation null for raw data).
     */
    ChartEngine.prototype.exportView = function (penKey) {
      var pd = this.penData(penKey);
      if (!pd) return { t: [], v: [], aggregation: null };
      var cov = pd.coverage;
      if (!cov || cov.mode !== 'aggregated') { var dv = penView(pd, this._viewOpts(false)); return { t: dv.t, v: dv.v, aggregation: null }; }
      var stamped = cov.bucketTime === 'end' ? cov.bucketMs : cov.bucketTime === 'mid' ? cov.bucketMs / 2 : 0;
      var t = [], v = [], last = -Infinity;
      if (pd.anchor && (!pd.t.length || pd.anchor.t < pd.t[0])) { t.push(pd.anchor.t); v.push(pd.anchor.v); last = pd.anchor.t; }
      for (var i = 0; i < pd.t.length; i++) {
        var tt = pd.t[i] - stamped;
        if (tt < last) continue;
        t.push(tt); v.push(pd.v[i]); last = tt;
      }
      if (this._realtime() && isValueAgg(pd.aggregation)) {
        // live samples newer than the last bucket's end (the view appends those after the history too)
        var lt = pd.live.t, lv = pd.live.v;
        var after = pd.t.length ? pd.t[pd.t.length - 1] - stamped + (cov.bucketMs || 0) : last;
        for (var j = lowerBound(lt, Math.max(after, last + 1)); j < lt.length; j++) { t.push(lt[j]); v.push(lv[j]); }
      }
      return { t: t, v: v, aggregation: cov.aggregation || pd.aggregation || null };
    };
    /** Samples of one pen in draw time (no synthetic point); draw true adds the gap breaks (plots only). */
    ChartEngine.prototype.penView = function (penKey, draw) {
      var pd = this.penData(penKey);
      return pd ? penView(pd, this._viewOpts(draw)) : { t: [], v: [], base: 0 };
    };
    /**
     * Until when the pen's last value is known to hold when not following live: the end of the
     * window the historian answered for (coverage.end) or the newest live sample, whichever is later. On-change
     * data that covers the window means the last value held until its end; stopping the average at the last
     * sample would drop that time (a pump switched off would read 100 % on).
     */
    function knownEndOf(pd) {
      var e = pd && pd.coverage && NS.util.isFiniteNum(pd.coverage.end) ? pd.coverage.end : null;
      var lt = pd && pd.live && pd.live.t;
      if (lt && lt.length) e = e == null ? lt[lt.length - 1] : Math.max(e, lt[lt.length - 1]);
      return e;
    }
    /** True when the pen's view holds MinMax pairs (aggregated rows, two per bucket). */
    function hasPairs(pd) {
      return !!(pd && pd.coverage && pd.coverage.mode === 'aggregated');
    }
    /**
     * uPlot data for one plot: {data:[x, y…], synthetic, keys}. penKeys in column order. The synthetic "now"
     * hold point (realtime, following live, appearance.extendToNow, connected) carries each pen's good live
     * value.
     */
    ChartEngine.prototype.join = function (plotId, penKeys) {
      var self = this;
      var t0 = Date.now();
      var pj = this._joins.get(plotId);
      if (!pj) { pj = new PlotJoin(); this._joins.set(plotId, pj); }
      var vo = this._viewOpts(true);
      var views = penKeys.map(function (k) { return self.penView(k, true); });
      var sig = penKeys.join('\u0001') + '|' + vo.live + '|' + vo.breakOnGapMs;
      var nowPoint = null;
      if (this._realtime() && this.vp.followLive && this.props && this.props.appearance.extendToNow && this._connected()) {
        var values = penKeys.map(function (k) {
          var pd = self.penData(k);
          var ll = pd && pd.liveLatest;
          return ll && ll.v != null && (!ll.q || !ll.q.level || ll.q.level === 'good') ? ll.v : undefined;
        });
        if (values.some(function (x) { return x !== undefined; })) nowPoint = { t: this.gwNow(), values: values };
      }
      var r = pj.update(views, sig, nowPoint);
      perfPush(this.metrics.perf.joinMs, Date.now() - t0);
      return { data: [r.x].concat(r.ys), synthetic: r.synthetic, keys: penKeys.slice() };
    };
    /** Window stats of one pen over [a, b] (default: the viewport), cached for statsThrottleMs. */
    ChartEngine.prototype.stats = function (penKey, a, b, opts) {
      var pd = this.penData(penKey);
      if (!pd) return null;
      var v = this.viewportGet();
      var lo = a != null ? a : v.min, hi = b != null ? b : v.max;
      var ck = penKey + '|' + (a != null ? a : 'vp') + '|' + (b != null ? b : 'vp') + '|' + (opts ? stableJson(opts) : '');
      var c = this._statsCache.get(ck);
      var nowL = Date.now();
      if (c && c.rev === pd.rev && c.liveRev === pd.liveRev && nowL - c.at < ENGINE.statsThrottleMs) return c.stats;
      var follow = this._realtime() && this.vp.followLive;
      var view = penView(pd, this._viewOpts());
      var o = Object.assign({ approx: pd.approx, lastKnownTime: follow ? this.gwNow() : knownEndOf(pd), pairs: hasPairs(pd),
        sigma: this.props ? this.props.interaction.rangeBrush.controlLimits.sigma : 3,
        method: this.props ? this.props.interaction.rangeBrush.controlLimits.method : 'stdDev', median: false }, opts || {});
      var s = statsFor(view, lo, hi, o);
      this._statsCache.set(ck, { rev: pd.rev, liveRev: pd.liveRev, at: nowL, stats: s });
      return s;
    };
    /** "Current" column: live value when following live, else the value held at the view end. */
    ChartEngine.prototype.current = function (penKey) {
      var pd = this.penData(penKey);
      var follow = this._realtime() && this.vp.followLive;
      if (!pd) return follow ? this._liveOnlyCurrent(penKey) : null;
      if (follow) {
        if (pd.liveLatest) return { v: pd.liveLatest.v, q: pd.liveLatest.q, t: pd.liveLatest.t, label: 'current' };
        var n = pd.t.length;
        // a statistic pen (no live samples): the newest bucket, labelled as such
        var lbl = pd.coverage && pd.coverage.mode === 'aggregated' && !isValueAgg(pd.aggregation) ? 'bucket' : 'current';
        return n ? { v: pd.v[n - 1], q: null, t: pd.t[n - 1], label: lbl } : null;
      }
      var vp = this.viewportGet();
      var view = penView(pd, this._viewOpts());
      var i = lastAtOrBefore(view.t, vp.max);
      return i < 0 ? null : { v: view.v[i], q: null, t: view.t[i], label: 'end' };
    };
    /**
     * Bad-quality runs of a pen in draw time, for the hatching overlay: [[t0, t1], …] where t0
     * is a bad sample and t1 the next good one (sample-and-hold: the value is unknown until then). Built from
     * the store, not from penView: the gap breaks of appearance.breakOnGapMs are nulls too, but not bad data.
     * A run still open at the end lasts until now (following live) or the last known time.
     * Cached per history revision: the scan state (closed runs, open run start, last time visited, live buffer
     * shape) is kept, so a new live sample only visits the new samples, and following live only moves the end
     * of the open run to now — no rescan of the whole series per frame.
     */
    ChartEngine.prototype.badRuns = function (penKey) {
      var pd = this.penData(penKey);
      if (!pd) return [];
      var live = this._realtime();
      var follow = live && this.vp.followLive;
      var lt = pd.live.t;
      var c = pd._badScan;
      var fresh = !c || c.rev !== pd.rev || c.live !== live;
      // the live buffer was cleared / trimmed at the front (not just appended to): full rescan
      if (!fresh && live && (lt.length < c.liveLen || (c.liveLen > 0 && lt[0] !== c.liveFirst))) fresh = true;
      // ... or its newest sample was replaced in place (same t, new value: SeriesStore.addLive)
      if (!fresh && live && lt.length && lt[lt.length - 1] === c.last && pd.live.v[lt.length - 1] !== c.lastV) fresh = true;
      if (fresh) {
        c = { rev: pd.rev, live: live, runs: [], open: null, last: -Infinity, lastV: undefined, liveRev: null, liveLen: 0, liveFirst: null };
        var shift = bucketShift(pd.coverage);
        var pairs = pd.coverage && pd.coverage.mode === 'aggregated';
        if (pd.anchor && (!pd.t.length || pd.anchor.t < pd.t[0])) badVisit(c, pd.anchor.t, pd.anchor.v);
        for (var i = 0; i < pd.t.length; i++) badVisit(c, pd.t[i] + shift + (pairs && i > 0 && pd.t[i] === pd.t[i - 1] ? 1 : 0), pd.v[i]);
      }
      if (live && c.liveRev !== pd.liveRev) {
        for (var j = upperBound(lt, c.last); j < lt.length; j++) badVisit(c, lt[j], pd.live.v[j]);
        c.liveRev = pd.liveRev;
        c.liveLen = lt.length;
        c.liveFirst = lt.length ? lt[0] : null;
      }
      pd._badScan = c;
      if (c.open == null) return c.runs;
      return c.runs.concat([[c.open, follow ? Math.max(this.gwNow(), c.last) : c.last]]);
    };
    /** One sample of the bad-run scan (state c: runs, open, last). */
    function badVisit(c, t, v) {
      if (!(t > c.last)) return;
      c.last = t;
      c.lastV = v;
      if (v === null) { if (c.open == null) c.open = t; }
      else if (c.open != null) { c.runs.push([c.open, t]); c.open = null; }
    }
    /** X-Trace value of a pen at time t (interpolation by display type). */
    ChartEngine.prototype.valueAt = function (penKey, t, kind, tolerance) {
      return valueAt(this.penView(penKey), t, kind || 'linear', tolerance);
    };
    /**
     * Raw fetch for exact brush stats / CSV "raw" (ChartApi.history.fetchRaw): one request,
     * priority user, onTooManyPoints "aggregate". Resolves {pens:[{key, t, v, status, downgraded, anchor}],
     * downgraded, window}.
     * The request carries the chart's real point count (query.pointCount or the plot width,
     * within the gateway's bounds) so the gateway's aggregate fallback has a sensible bucket count instead of
     * 0; when the gateway downgraded the WHOLE window (longer than maxRawRangeDays) it says so only in
     * `window.downgraded`: that flag is copied onto every pen and returned as `downgraded` / `window`, so callers
     * never mistake those buckets for raw samples.
     */
    ChartEngine.prototype.fetchRaw = function (o) {
      var self = this;
      var opts = o || {};
      var keys = [];
      (opts.penKeys || this.pens.map(function (p) { return p.key; })).forEach(function (pk) {
        self.pens.forEach(function (pen) {
          if (pen.key === pk && pen.dataKey) keys.push({ dk: pen.key, tagPath: pen.info.tagPath, aggregation: pen.aggregation });
        });
      });
      if (!keys.length || !(opts.end > opts.start)) return Promise.resolve({ pens: [] });
      // a signal aborted before the call: no request, no history-queue slot
      if (opts.signal && opts.signal.aborted) {
        return Promise.resolve({ pens: keys.map(function (k) { return { key: k.dk, t: [], v: [], status: 'aborted' }; }), error: 'ABORTED' });
      }
      var plan = { start: opts.start, end: opts.end, mode: 'raw', aggregation: this.props.query.aggregation,
        pointCount: plannedPointCount(this.props, this.plotWidth, this.L), bucketMs: null, onTooManyPoints: 'aggregate', includeAnchor: true,
        maxPointsPerPen: Math.min(this.props.query.maxPointsPerPen, this.L.maxRawPointsPerPen) };
      var b = this._body(plan, keys);
      var canceller = new Canceller();
      // the caller's signal may be long-lived (one controller for many brush-stats calls):
      // the listener is removed again once this request settles, so it never piles up
      var onAbort = function () { canceller.cancel(); };
      var sig = opts.signal && typeof opts.signal.addEventListener === 'function' ? opts.signal : null;
      if (sig) sig.addEventListener('abort', onAbort, { once: true });
      var detach = function () {
        if (sig && typeof sig.removeEventListener === 'function') { try { sig.removeEventListener('abort', onAbort); } catch (e) { /* ignore */ } }
      };
      var sent = this.client.post(b.body, { priority: 'user', signal: canceller.signal });
      // a caller (the raw CSV export) may outlive its menu; the chart's unmount still aborts it
      var rawFetches = this._rawFetches || (this._rawFetches = new Set());
      rawFetches.add(canceller);
      var settled = function () { rawFetches.delete(canceller); detach(); };
      sent.then(settled, settled);
      return sent.then(function (res) {
        if (typeof opts.onProgress === 'function') { try { opts.onProgress({ done: 1, total: 1 }); } catch (e) { /* ignore */ } }
        if (!res.ok) return { pens: keys.map(function (k) { return { key: k.dk, t: [], v: [], status: res.aborted ? 'aborted' : 'error' }; }), error: res.code };
        var win = res.data.window || {};
        var whole = !!win.downgraded;
        var aggOf = {};
        keys.forEach(function (k) { aggOf[k.dk] = k.aggregation; });
        return {
          pens: (res.data.pens || []).map(function (wp) {
            var cols = wp.status === 'ok' ? wireColumns(wp) : { t: [], v: [] };
            var key = b.reqKeys[wp.key];
            var down = whole || !!wp.downgraded;
            // a downgraded pen's rows are buckets stamped at the bucket START, MinMax pairs sharing one stamp:
            // their bucket and aggregation travel along so a consumer can place them (rawView)
            var bms = NS.util.isFiniteNum(wp.bucketMs) ? wp.bucketMs : NS.util.isFiniteNum(win.bucketMs) ? win.bucketMs : null;
            return { key: key, t: cols.t, v: cols.v, status: wp.status, downgraded: down,
              anchor: validAnchor(wp.anchor), bucketMs: down ? bms : null,
              aggregation: down ? (typeof wp.aggregation === 'string' && wp.aggregation) || aggOf[key] || null : null };
          }),
          downgraded: whole,
          window: { start: win.start, end: win.end, mode: win.mode || null, bucketMs: NS.util.isFiniteNum(win.bucketMs) ? win.bucketMs : null, downgraded: whole },
        };
      });
    };

    /**
     * One fetchRaw pen as samples on the chart's time axis: raw answers as they are (anchor first);
     * a downgraded (aggregated) answer goes through penView like the store's data — bucket rows moved to where
     * the value belongs (bucketShift) and the second row of a MinMax pair 1 ms later, so statsFor's pair
     * weighting recognises it. On the wire stamps, equal-stamp pairs would weigh each bucket by its later row.
     */
    function rawView(rp) {
      if (!rp) return { t: [], v: [] };
      if (!rp.downgraded || !(rp.bucketMs > 0)) {
        var t = rp.t || [], v = rp.v || [];
        if (rp.anchor && (!t.length || rp.anchor.t < t[0])) { t = [rp.anchor.t].concat(t); v = [rp.anchor.v].concat(v); }
        return { t: t, v: v };
      }
      var pd = newPenData('raw', '', rp.aggregation || null);
      pd.t = rp.t || []; pd.v = rp.v || []; pd.anchor = rp.anchor || null;
      pd.coverage = { mode: 'aggregated', bucketMs: rp.bucketMs, bucketTime: 'start', aggregation: rp.aggregation || null };
      var vw = penView(pd, { live: false });
      return { t: vw.t, v: vw.v };
    }

    /* ---- SECTION 9c / overview data for the range selector ------------------------------------------------------
     * The overview strip (SECTION 14c) shows the chart's whole range at the strip's resolution. It has its own data:
     * the plots' store holds the zoomed window after a free-range re-query, and a raw window would be far
     * more than a 1 000 px strip needs. One aggregated request per refresh for every pen with history, through the
     * same HistoryClient, token and page queue as the plots, at the queue's lowest priority ('overview': after
     * user / chunk / tick requests) and alone (SECTION 6: it starts only while no other request of the page runs,
     * and the page's next request waits for it), so it never delays a load and never pushes the session past the
     * gateway's task queue limit (a strip request next to an 8-pen tick does: 429 queue). Value pens are asked for MinMax
     * (a navigator should show spikes); a statistic pen (Count, DurationOn, …) for its own aggregation.
     */
    /** The overview request plan: aggregated, `pointCount` buckets of the gateway's ladder over [start, end]. */
    function overviewPlan(start, end, pointCount, L, now) {
      var lim = L || effectiveLimits(null);
      var pc = NS.util.clamp(Math.round(pointCount || 0), Math.max(10, lim.pointCountMin), Math.min(2000, lim.pointCountMax));
      var s = Math.floor(start), e = Math.floor(end);
      if (e - s > lim.maxRangeDays * DAY) s = e - lim.maxRangeDays * DAY;
      if (e - s < SECOND) s = e - SECOND;
      var dataEnd = Math.min(e, now != null ? now : e);
      var bms = computeBucket(s, e, dataEnd, pc, lim.minBucketMs, lim.pointCountMax, lim.bucketLadder);
      return { start: s, end: e, mode: 'aggregated', aggregation: 'MinMax', pointCount: pc, bucketMs: bms,
        onTooManyPoints: 'error', includeAnchor: true };
    }
    /**
     * fetchOverview({start, end, pointCount, penKeys}) -> Promise<{ok, code?, pens: [{key, t, v, status}], window}>.
     * Rows are placed on the chart's time axis like the plots' (penView: bucket shift, MinMax pairs 1 ms apart).
     * The pens go out in batches of at most OVERVIEW_BATCH_PENS (one request each, all queued at once at the
     * overview priority). Each batch runs alone in the page queue (SECTION 6); user / chunk / tick jobs that
     * arrive meanwhile start between two batches, so a long many-pen strip never holds the page in one piece. The first failed batch fails the whole call (and cancels the rest).
     * Never rejects (a payload that cannot be processed answers INTERNAL); the requests are aborted on unmount
     * (they share the raw-fetch cancellation set).
     */
    var OVERVIEW_BATCH_PENS = 4;
    ChartEngine.prototype.fetchOverview = function (o) {
      var self = this;
      var opts = o || {};
      if (!this.mounted || !this.props || !this.source || !this.source.snap) return Promise.resolve({ ok: false, code: 'NOT_READY', pens: [] });
      if (!credsOf(this.source)) return Promise.resolve({ ok: false, code: 'NO_TOKEN', pens: [] });
      var keys = [];
      var want = opts.penKeys || this.pens.map(function (p) { return p.key; });
      this.pens.forEach(function (pen) {
        if (!pen.dataKey || want.indexOf(pen.key) < 0) return;
        keys.push({ dk: pen.key, tagPath: pen.info.tagPath, aggregation: isValueAgg(pen.aggregation) ? 'MinMax' : pen.aggregation });
      });
      if (!keys.length || !(opts.end > opts.start)) return Promise.resolve({ ok: true, pens: [], window: null });
      var plan = overviewPlan(opts.start, opts.end, opts.pointCount, this.L, this.gwNow());
      var canceller = new Canceller();
      var rawFetches = this._rawFetches || (this._rawFetches = new Set());
      rawFetches.add(canceller);
      var batches = [];
      for (var i = 0; i < keys.length; i += OVERVIEW_BATCH_PENS) batches.push(keys.slice(i, i + OVERVIEW_BATCH_PENS));
      var failed = null;
      var one = function (bk) {
        var b = self._body(plan, bk);
        self.metrics.overviewRequests = (self.metrics.overviewRequests || 0) + 1;
        return self.client.post(b.body, { priority: 'overview', signal: canceller.signal }).then(function (res) {
          if (!self.mounted) return { ok: false, code: 'DETACHED', pens: [] };
          if (!res.ok) {
            return { ok: false, code: res.aborted ? 'ABORTED' : res.code, busy: isBusy(res), retryAfterMs: res.retryAfterMs || null, pens: [] };
          }
          var win = res.data.window || {};
          var pens = (res.data.pens || []).map(function (wp) {
            var key = b.reqKeys[wp.key];
            if (wp.status !== 'ok') return { key: key, t: [], v: [], status: wp.status };
            var pd = newPenData('overview', '', wp.aggregation || null);
            var cols = wireColumns(wp);
            pd.t = cols.t; pd.v = cols.v; pd.anchor = validAnchor(wp.anchor);
            pd.coverage = coverageOf({ start: win.start, end: win.end, mode: 'aggregated', bucketMs: win.bucketMs, bucketTime: win.bucketTime,
              aggregation: plan.aggregation }, wp);
            var vw = penView(pd, { live: false });
            return { key: key, t: vw.t, v: vw.v, status: 'ok' };
          });
          return { ok: true, pens: pens, window: { start: win.start != null ? win.start : plan.start, end: win.end != null ? win.end : plan.end,
            bucketMs: NS.util.isFiniteNum(win.bucketMs) ? win.bucketMs : plan.bucketMs } };
        }).then(null, function (err) {
          log.warn('overview response not usable', err && err.message);
          return { ok: false, code: 'INTERNAL', pens: [] };
        }).then(function (r) {
          // the first failure cancels the batches still queued or running (their ABORTED answers are ignored)
          if (!r.ok && !failed) { failed = r; canceller.cancel(); }
          return r;
        });
      };
      return Promise.all(batches.map(one)).then(function (rs) {
        rawFetches.delete(canceller);
        if (failed) return failed;
        var out = { ok: true, pens: [], window: null };
        rs.forEach(function (r) {
          out.pens = out.pens.concat(r.pens);
          if (!out.window && r.window) out.window = r.window;
        });
        return out;
      }).then(null, function (err) {
        rawFetches.delete(canceller);
        log.warn('overview failed', err && err.message);
        return { ok: false, code: 'INTERNAL', pens: [] };
      });
    };

    /** Render model (what the render layer draws). Cached until the next change; viewport/status are live. */
    ChartEngine.prototype.model = function () {
      var self = this;
      var snap = this.source && this.source.snap;
      var reason = this.source && this.source.staleReason ? this.source.staleReason() : null;
      var staleSince = this._staleSince();
      var loading = this._fullLoadActive() || (!this.loadedOnce && !!snap && !this.banner);
      // ctg.reload / protocol mismatch (delegate state) is the same blocking "reload the page" banner
      var banner = this.banner || (reason === 'reload'
        ? { code: 'reload', message: NS.i18n.t('chart.banner.reload'), kind: 'reload' } : null);
      var state;
      if (reason === 'disconnected') state = 'disconnected';
      else if (banner && (FATAL_BANNERS[banner.code] || RENEW_BANNERS[banner.code])) state = 'error';
      else if (!snap) state = 'connecting';
      else if (!this.pens.length) state = 'empty';
      else if (!this.loadedOnce) state = banner ? 'error' : 'loading';
      else if (!this._realtime()) state = 'historical';
      else if (!this.vp.followLive) state = 'paused';
      else if (staleSince != null || (reason && reason !== 'connecting') || (banner && banner.code === 'network')) state = 'stale';
      else state = 'live';
      var tooMany = [];
      var pens = this.pens.map(function (pen) {
        var pd = pen.dataKey ? self.store.get(pen.dataKey) : null;
        var status = pen.info.status !== 'ok' ? pen.info.status : (pd ? pd.status : 'loading');
        if (status === 'tooManyPoints') tooMany.push(pen);
        return {
          key: pen.key, dataKey: pen.dataKey, source: pen.info.source || 'pens', index: pen.info.index != null ? pen.info.index : null,
          tagPath: pen.info.tagPath, name: (pen.prop && pen.prop.name) || pen.info.name || NS.util.shortTagName(pen.info.tagPath),
          serverName: pen.info.name || null,
          status: status, message: pd ? pd.message : null, limit: pd ? pd.limit : null,
          warn: pd ? pd.warn || pd.incomplete || null : null, incomplete: pd ? pd.incomplete : null,
          meta: pen.info.meta || null, trendable: pen.info.trendable !== false, aggregation: pen.aggregation,
          points: pd ? pd.t.length : 0, livePoints: pd ? pd.live.t.length : 0,
          approx: pd ? pd.approx : false, downgraded: pd ? pd.downgraded : false, truncated: pd ? pd.truncated : false,
          loading: !!pd && pd.status === 'loading', coverage: pd && pd.coverage ? Object.assign({}, pd.coverage) : null,
        };
      });
      var notices = [];
      if (this.notices.clamped) notices.push({ code: 'clamped', text: NS.i18n.t('chart.notice.clamped', this.notices.clamped) });
      // chart-level partial coverage, or any pen whose older data is missing (cleared with `incomplete`)
      var anyIncomplete = this.pens.some(function (pen) { var pd = pen.dataKey ? self.store.get(pen.dataKey) : null; return !!(pd && pd.incomplete); });
      if (this.notices.partial || anyIncomplete) notices.push({ code: 'partial', text: NS.i18n.t('chart.notice.partial') });
      if (this.notices.busy) notices.push({ code: 'busy', text: NS.i18n.t('chart.notice.busy') });
      if (this.notices.rawDowngraded) {
        notices.push({ code: 'rawDowngraded', days: this.notices.rawDowngraded.days,
          text: NS.i18n.t('chart.notice.rawDowngraded', this.notices.rawDowngraded) });
      }
      if (tooMany.length) {
        var limit = tooMany.map(function (p) { var pd = self.store.get(p.dataKey); return pd && pd.limit; }).filter(Boolean)[0] ||
          (this.props ? Math.min(this.props.query.maxPointsPerPen, this.L.maxRawPointsPerPen) : null);
        notices.push({ code: 'tooManyPoints', pens: tooMany.map(function (p) { return p.key; }), limit: limit,
          text: NS.i18n.t('chart.notice.tooManyPoints', { pens: tooMany.map(function (p) { return p.info.name || p.info.tagPath; }).join(', '), limit: limit }) });
      }
      var ann = this.annotations.summary();
      if (ann.enabled && ann.unsupported) notices.push({ code: 'annotationsUnsupported', text: NS.i18n.t('chart.notice.annotationsUnsupported') });
      var pr = this.progress;
      return {
        id: this.id, rev: this._rev, state: state, staleReason: reason, staleSince: staleSince,
        lastUpdate: this.lastSuccess || null, mode: this.props ? this.props.timeRange.mode : null,
        loading: loading, banner: banner, notices: notices,
        // pct: the share of the window's TIME loaded (adaptive pieces differ in width)
        progress: pr ? { done: pr.done, total: Math.max(pr.total, pr.done), points: pr.points,
          pct: pr.pct != null ? pr.pct : pr.total ? Math.round(100 * pr.done / pr.total) : 0 } : null,
        window: this.window, coverage: this.coverage ? Object.assign({}, this.coverage) : null,
        viewport: this.viewportGet(), pens: pens, limits: this.L,
        capabilities: snap ? { trendEdit: snap.trendEdit || null, readScope: snap.readScope || null, tagBrowser: snap.tagBrowser || null,
          annotations: snap.annotations || null, trend: snap.trend || null } : null,
        annotations: ann,
      };
    };

    /**
     * window.__CTG.debug.charts[id]: counters plus the engine for harness scenarios. The
     * token is not reachable from here: credentials live only in the module-private CREDS WeakMap,
     * the delegate's snapshot is stored without `history` (a Node test walks the whole graph to check it).
     */
    ChartEngine.prototype._publishDebug = function () {
      if (!this.mounted) return;
      if (!NS.log.debugEnabled()) { if (NS.debug.charts) delete NS.debug.charts[this.id]; return; }
      NS.debug.charts = NS.debug.charts || {};
      var m = this.metrics;
      NS.debug.charts[this.id] = {
        name: this.name, engine: this,
        perf: {
          fetchMs: m.perf.fetchMs[m.perf.fetchMs.length - 1] || null, fetchMsP95: p95(m.perf.fetchMs),
          parseMs: m.perf.parseMs[m.perf.parseMs.length - 1] || null, parseMsP95: p95(m.perf.parseMs),
          joinMs: m.perf.joinMs[m.perf.joinMs.length - 1] || null, joinMsP95: p95(m.perf.joinMs),
          applyMs: m.perf.applyMs[m.perf.applyMs.length - 1] || null,
        },
        heldPoints: this.store.heldPoints(), requests: m.requests, responses: m.responses, bytes: m.bytes,
        lastBytes: m.lastBytes, inFlightMax: m.inFlightMax, ticks: m.ticks, tickRequests: m.tickRequests,
        skippedTicks: m.skippedTicks, fullLoads: m.fullLoads, partialLoads: m.partialLoads, chunkRequests: m.chunkRequests,
        staleDropped: m.staleDropped, lastError: m.lastError, lastTickBody: m.lastTickBody, gen: this.gen,
        coverage: this.coverage ? Object.assign({}, this.coverage) : null,
      };
      // the chart's ChartApi and component (for harness scenarios that mount a chart) — non-enumerable,
      // so copies / JSON of the counters never walk the React tree
      if (this.debugExtra) {
        Object.defineProperty(NS.debug.charts[this.id], 'api', { value: this.debugExtra.api, enumerable: false });
        Object.defineProperty(NS.debug.charts[this.id], 'ui', { value: this.debugExtra.ui, enumerable: false });
      }
    };

    /* ========================================================================
     * SECTION 9b / AnnotationLayer — historian notes and ranges
     * ----------------------------------------------------------------------
     * One layer per ChartEngine. It reads the
     * annotations of the chart's pens with history from the gateway through
     * the same history route and token as the data, in a request of its own:
     *   {..., pens, annotations: {types}, annotationsOnly: true}
     * (the series are never re-loaded for annotations, and the
     * chunked / incremental data loads stay as they are). It asks when:
     *   - a full load succeeded (the window or the pens changed),
     *   - the viewport left the window it covers (pan / zoom; debounced),
     *   - the pen set changed (a pen joined),
     *   - every minute while a realtime chart follows live (and the page is
     *     visible), and a few times after a save / delete (the historian
     *     stores asynchronously, ~0.3–1 s).
     * The query window is the view plus half a view on each side (pans stay
     * covered); the gateway also looks back one window so a range that began
     * earlier is still found.
     *
     * Model: items {id, penKey, tagPath, type 'note'|'range', start, end,
     * text, author (null = unknown), color, created, ours, pending}. `data`
     * from the historian is parsed here and shown as TEXT only (never as HTML): this
     * module's JSON {"v":1,"text","author","color","created"} or any other
     * tool's plain text (author unknown). Saves draw optimistically
     * (`pending`, dashed) until a re-read shows the stored entry; an edited /
     * deleted entry is hidden at once until a re-read no longer returns it.
     *
     * Capability: nothing is asked unless annotations.enabled (prop) AND the
     * gateway's snapshot says annotations.allowed AND the chart has a history
     * token. summary().unsupported: every pen's historian answered
     * "unsupported" -> the annotate mode is hidden and a notice says why.
     * ====================================================================== */
    var ANN = {
      liveRefreshMs: 60000,          // realtime, following live: re-read every minute
      debounceMs: 400,               // viewport / pen changes
      saveRequeryMs: [1200, 3000, 7000],   // after a save / delete (asynchronous historian storage)
      retryMs: 15000,                // a failed read (transient) is retried after this
      pendingTtlMs: 20000,           // an optimistic entry no re-read confirmed is dropped after this
      margin: 0.5,                   // query window = view + margin x span on each side
      maxItems: 5000,                // all pens together (the gateway caps each pen at ctg.annotations.maxPerPen)
    };
    var ANN_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

    /** A historian entry's `data`: this module's v1 JSON, or any other text (author unknown). */
    function parseAnnData(data) {
      var s = typeof data === 'string' ? data : data == null ? '' : String(data);
      var tr = s.trim();
      if (tr.charAt(0) === '{' && tr.length <= 16000) {
        try {
          var o = JSON.parse(tr);
          if (o && typeof o === 'object' && o.v === 1) {
            return {
              text: typeof o.text === 'string' ? o.text : '',
              author: typeof o.author === 'string' && o.author ? o.author : null,
              color: typeof o.color === 'string' && ANN_COLOR_RE.test(o.color) ? o.color : null,
              created: NS.util.isFiniteNum(o.created) ? o.created : null,
              editedBy: typeof o.editedBy === 'string' && o.editedBy ? o.editedBy : null,
              ours: true,
            };
          }
        } catch (e) { /* plain text */ }
      }
      return { text: s, author: null, color: null, created: null, editedBy: null, ours: false };
    }
    /** An item from one response entry of pen `pen` (null when the entry is unusable). */
    function annItem(raw, pen) {
      if (!raw || typeof raw !== 'object' || !NS.util.isFiniteNum(raw.start)) return null;
      var type = raw.type === 'range' && NS.util.isFiniteNum(raw.end) && raw.end > raw.start ? 'range' : 'note';
      var d = parseAnnData(raw.data);
      return {
        id: typeof raw.id === 'string' ? raw.id : null, penKey: pen.key, tagPath: pen.info.tagPath, type: type,
        start: raw.start, end: type === 'range' ? raw.end : null, text: d.text, author: d.author, color: d.color,
        created: d.created, editedBy: d.editedBy, ours: d.ours, pending: false,
      };
    }
    /** Where an item ends on the time axis (its start for a note). */
    function annLast(a) { return a.type === 'range' && a.end != null ? a.end : a.start; }

    function AnnotationLayer(engine) {
      this.engine = engine;
      this.items = [];               // confirmed items of the last read
      this.pending = [];             // optimistic entries of saves ({..., pending: true, until})
      this.hidden = {};              // id -> until: edited / deleted entries hidden until a read drops them
      this.status = {};              // pen key -> 'ok' | 'unsupported' | 'error' (last read)
      this.truncated = false;
      this.cover = null;             // {start, end, sig, live} of the last successful read
      this.seq = 0;                  // request sequence (a newer read supersedes an older one)
      this.inFlight = null;          // Canceller of the running read
      this.lastAt = 0;
      this.failures = 0;
      this._timer = null;            // the next scheduled read
      this._timerAt = 0;
      this._timerReason = null;
      this._liveTimer = null;
      this._saveTimers = [];
      this.metrics = { requests: 0, ok: 0, failed: 0, lastReason: null, lastBody: null };
      this.rev = 0;                  // bumped on every change of what is drawn (the chart redraws its overlays)
    }
    /** Types the props ask for (annotations.types); [] = none. */
    AnnotationLayer.prototype.types = function () {
      var p = this.engine.props;
      if (!p) return [];
      var t = p.annotations.types;
      var out = [];
      if (t.note) out.push('note');
      if (t.range) out.push('range');
      return out;
    };
    /** True when annotations may be read now (prop + gateway capability + a history token + a type). */
    AnnotationLayer.prototype.enabled = function () {
      var e = this.engine;
      var snap = e.source && e.source.snap;
      var cap = snap && snap.annotations;
      return !!(e.mounted && e.props && e.props.annotations.enabled && cap && cap.allowed && credsOf(e.source) &&
        this.types().length);
    };
    /** Pens whose annotations are read: every pen with history (PenInfo ok), in pen order. */
    AnnotationLayer.prototype._pens = function () {
      return this.engine.pens.filter(function (pen) {
        return pen.info && pen.info.status === 'ok' && typeof pen.info.tagPath === 'string' && pen.info.tagPath;
      });
    };
    /** Signature of what a read asks for (pens + types): a change asks again. */
    AnnotationLayer.prototype._sig = function () {
      return this._pens().map(function (pen) { return pen.key + '=' + pen.info.tagPath; }).join('|') + '#' + this.types().join(',');
    };
    /** The window a read should cover for the current view (null when there is no view yet). */
    AnnotationLayer.prototype._window = function () {
      var e = this.engine;
      var v = e.viewportGet();
      if (!NS.util.isFiniteNum(v.min) || !NS.util.isFiniteNum(v.max) || !(v.max > v.min)) return null;
      var now = e.gwNow();
      var span = v.max - v.min;
      var start = v.min - ANN.margin * span;
      var end = v.followLive ? now : Math.min(now + 60000, v.max + ANN.margin * span);
      var lim = e.L.maxRangeDays * DAY;
      if (end - start > lim) start = end - lim;
      if (end - start < SECOND) start = end - SECOND;
      return { start: Math.max(0, Math.floor(start)), end: Math.floor(end), live: !!v.followLive };
    };
    /** True when the last read covers the current view and pens. */
    AnnotationLayer.prototype.covers = function () {
      var c = this.cover;
      if (!c || c.sig !== this._sig()) return false;
      var v = this.engine.viewportGet();
      if (!NS.util.isFiniteNum(v.min)) return false;
      if (v.min < c.start) return false;
      return v.followLive ? c.live : v.max <= c.end;
    };
    /**
     * Schedules a read in `delayMs` (an earlier scheduled read wins). When it runs, `_run` cancels any read still in
     * flight whatever either reason is (viewport, pens, live, save, props, load): the newest window and pen set always
     * win, and a cancelled read's result is never applied. Clears everything when annotations are off.
     */
    AnnotationLayer.prototype.request = function (reason, delayMs) {
      var self = this;
      var e = this.engine;
      if (!this.enabled()) { this.clear(); return; }
      var at = Date.now() + Math.max(0, delayMs || 0);
      if (this._timer != null && this._timerAt <= at) return;
      if (this._timer != null) e.timers.clear(this._timer);
      this._timerAt = at;
      this._timerReason = reason;
      this._timer = e.timers.set(function () {
        self._timer = null;
        self._run(self._timerReason);
      }, Math.max(0, delayMs || 0));
    };
    /** The view moved (gesture end, reset): read again only when it left the covered window. */
    AnnotationLayer.prototype.onViewport = function () {
      if (this.enabled() && !this.covers()) this.request('viewport', ANN.debounceMs);
    };
    /** The pen set or the capability changed. */
    AnnotationLayer.prototype.onPens = function () {
      if (!this.enabled()) { if (this.items.length || this.cover) { this.clear(); this.engine.changed(); } return; }
      if (!this.cover || this.cover.sig !== this._sig()) this.request('pens', ANN.debounceMs);
    };
    /** Drops everything (annotations switched off, capability withdrawn). */
    AnnotationLayer.prototype.clear = function () {
      var e = this.engine;
      if (this._timer != null) { e.timers.clear(this._timer); this._timer = null; }
      if (this._liveTimer != null) { e.timers.clear(this._liveTimer); this._liveTimer = null; }
      this._saveTimers.forEach(function (t) { e.timers.clear(t); });
      this._saveTimers = [];
      if (this.inFlight) { this.inFlight.cancel(); this.inFlight = null; }
      this.seq++;
      this.items = [];
      this.pending = [];
      this.hidden = {};
      this.status = {};
      this.truncated = false;
      this.cover = null;
      this.rev++;
    };
    AnnotationLayer.prototype.dispose = function () { this.clear(); };
    /** One read (annotationsOnly request); supersedes (cancels) a read still in flight, for every reason. */
    AnnotationLayer.prototype._run = function (reason) {
      var self = this;
      var e = this.engine;
      if (!this.enabled()) { this.clear(); e.changed(); return; }
      var pens = this._pens();
      var win = this._window();
      if (!pens.length || !win) {
        this.items = [];
        this.status = {};
        this.cover = win ? { start: win.start, end: win.end, live: win.live, sig: this._sig() } : null;
        this._scheduleLive();
        e.changed();
        return;
      }
      if (e._hidden() && reason === 'live') { this._scheduleLive(); return; }
      if (this.inFlight) this.inFlight.cancel();
      var canceller = new Canceller();
      this.inFlight = canceller;
      var seq = ++this.seq;
      var sig = this._sig();
      var keyOf = {};
      var body = {
        v: 2, requestId: e.rid + '-a' + seq, start: win.start, end: win.end, mode: 'aggregated', aggregation: 'LastValue',
        pointCount: e.L.pointCountMin, includeAnchor: false, onTooManyPoints: 'error',
        pens: pens.map(function (pen, i) { keyOf['a' + i] = pen; return { key: 'a' + i, tagPath: pen.info.tagPath }; }),
        annotations: { types: this.types() }, annotationsOnly: true,
      };
      this.metrics.requests++;
      this.metrics.lastReason = reason;
      this.metrics.lastBody = { start: body.start, end: body.end, pens: body.pens.length, types: body.annotations.types.slice() };
      e.client.post(body, { priority: reason === 'save' ? 'chunk' : 'tick', signal: canceller.signal }).then(function (res) {
        if (self.inFlight === canceller) self.inFlight = null;
        if (!e.mounted || seq !== self.seq || canceller.aborted || (res && res.aborted)) return;
        if (!res.ok || !res.data || res.data.requestId !== body.requestId) {
          self.failures++;
          self.metrics.failed++;
          // transient refusals and network trouble are retried; a definitive refusal waits for the next trigger
          if (res && (res.retryable || isBusy(res) || isTimeout(res) || res.code === 'NETWORK')) {
            self.request('retry', Math.max(ANN.retryMs, res.retryAfterMs || 0));
          }
          self._scheduleLive();
          return;
        }
        self.failures = 0;
        self.metrics.ok++;
        self._apply(res.data, keyOf, { start: win.start, end: win.end, live: win.live, sig: sig });
        self._scheduleLive();
        e.changed();
      });
    };
    /** Applies one response: items per pen, statuses, confirmed optimistic entries dropped. */
    AnnotationLayer.prototype._apply = function (data, keyOf, cover) {
      var items = [];
      var status = {};
      var truncated = false;
      (data.pens || []).forEach(function (wp) {
        var pen = wp && keyOf[wp.key];
        if (!pen) return;
        var st = typeof wp.annotationsStatus === 'string' ? wp.annotationsStatus : (wp.status === 'ok' ? 'ok' : null);
        if (!st) return;
        status[pen.key] = st;
        if (wp.annotationsTruncated) truncated = true;
        if (st !== 'ok' || !Array.isArray(wp.annotations)) return;
        wp.annotations.forEach(function (raw) {
          if (items.length >= ANN.maxItems) { truncated = true; return; }
          var it = annItem(raw, pen);
          if (it) items.push(it);
        });
      });
      var now = Date.now();
      var ids = {};
      items.forEach(function (it) { if (it.id) ids[it.id] = true; });
      // optimistic entries: confirmed (their id came back) or expired -> dropped
      this.pending = this.pending.filter(function (p) { return !(p.id && ids[p.id]) && p.until > now; });
      // hidden (edited / deleted) entries: forgotten once the read no longer returns them
      var hidden = {};
      for (var id in this.hidden) if (hasOwn.call(this.hidden, id) && ids[id] && this.hidden[id] > now) hidden[id] = this.hidden[id];
      this.hidden = hidden;
      this.items = items;
      this.status = status;
      this.truncated = truncated;
      this.cover = cover;
      this.lastAt = now;
      this.rev++;
    };
    /** Realtime + following live: the next periodic read in a minute (setTimeout chain, no setInterval). */
    AnnotationLayer.prototype._scheduleLive = function () {
      var self = this;
      var e = this.engine;
      if (this._liveTimer != null) { e.timers.clear(this._liveTimer); this._liveTimer = null; }
      if (!this.enabled() || !e._realtime()) return;
      this._liveTimer = e.timers.set(function () {
        self._liveTimer = null;
        if (!e.mounted) return;
        if (e.vp.followLive) self.request('live', 0);
        else self._scheduleLive();
      }, ANN.liveRefreshMs);
    };
    /**
     * A save / delete the gateway accepted: draws the entry at once (dashed) and hides the replaced one, then
     * re-reads a few times until the historian shows the change. entry: the saved item (id = the new id) or null.
     */
    AnnotationLayer.prototype.saved = function (entry, replacedId) {
      var self = this;
      var e = this.engine;
      var now = Date.now();
      if (replacedId) this.hidden[replacedId] = now + ANN.pendingTtlMs;
      if (entry) this.pending.push(Object.assign({}, entry, { pending: true, until: now + ANN.pendingTtlMs }));
      this.rev++;
      this._saveTimers.forEach(function (t) { e.timers.clear(t); });
      this._saveTimers = ANN.saveRequeryMs.map(function (ms) {
        return e.timers.set(function () { if (e.mounted) self._run('save'); }, ms);
      });
      e.changed();
    };
    /** Items to draw: confirmed (minus hidden) + pending, of the given pen keys, overlapping [min, max]. */
    AnnotationLayer.prototype.list = function (penKeys, min, max) {
      var hidden = this.hidden;
      var now = Date.now();
      var keys = penKeys ? new Set(penKeys) : null;
      var out = [];
      var take = function (a) {
        if (keys && !keys.has(a.penKey)) return;
        if (min != null && (a.start > max || annLast(a) < min)) return;
        out.push(a);
      };
      this.items.forEach(function (a) { if (!(a.id && hidden[a.id] && hidden[a.id] > now)) take(a); });
      this.pending.forEach(function (a) { if (a.until > now) take(a); });
      return out;
    };
    /** Render-model summary (engine.model().annotations). */
    AnnotationLayer.prototype.summary = function () {
      var keys = Object.keys(this.status);
      var unsupported = keys.length > 0 && keys.every(function (k) { return this.status[k] === 'unsupported'; }, this);
      var error = keys.some(function (k) { return this.status[k] === 'error'; }, this);
      return {
        enabled: this.enabled(), count: this.items.length, pending: this.pending.length, unsupported: unsupported,
        error: error, truncated: this.truncated, lastAt: this.lastAt || null, rev: this.rev,
        cover: this.cover ? { start: this.cover.start, end: this.cover.end } : null,
      };
    };

    /* ========================================================================
     * SECTION 10 / panel registry — add-on files register here
     * ----------------------------------------------------------------------
     * ctg-chart-tools.js and ctg-chart-panels.js register whenever they load;
     * toolbar buttons appear once their panel exists. Each chart renders the
     * panels it has open through def.render(api, args, close) with its
     * ChartApi (SECTION 15 documents the contract; open/close are added to
     * this registry in SECTION 20).
     * ====================================================================== */
    var panels = Object.create(null);      // no prototype: 'toString' & co. are never panels
    var panelListeners = [];
    var historyQueue = new HistoryQueue({ maxConcurrent: 2 });

    NS.chart = {
      panels: {
        register: function (name, def) {
          if (typeof name !== 'string' || !name || name === '__proto__' || !def || typeof def !== 'object') {
            // a caller error must not throw: only a string name is ever stringified
            // (String(Object.create(null)) throws "Cannot convert object to primitive value")
            log.warn('panel register refused', typeof name === 'string' ? clean(name) : '(' + typeof name + ')');
            return false;
          }
          panels[name] = def;
          panelListeners.slice().forEach(function (fn) { try { fn(name); } catch (e) { console.error(e); } });
          return true;
        },
        get: function (name) { return typeof name === 'string' && hasOwn.call(panels, name) ? panels[name] : null; },
        names: function () { return Object.keys(panels); },
        onChange: function (fn) {
          panelListeners.push(fn);
          return function () { var i = panelListeners.indexOf(fn); if (i >= 0) panelListeners.splice(i, 1); };
        },
      },
      historyQueue: historyQueue,
      // engine API (Node-tested; the render layer builds on it)
      SPEC: SPEC, DEFAULTS: DEFAULTS, reduceProps: reduceProps, toEpochMs: toEpochMs, chartV1Keys: chartV1Keys,
      LADDER: LADDER, LIMIT_DEFAULTS: LIMIT_DEFAULTS, effectiveLimits: effectiveLimits,
      niceBucket: niceBucket, nextBucket: nextBucket, computeBucket: computeBucket, configWindow: configWindow,
      planQuery: planQuery, plannedPointCount: plannedPointCount, chunkPlan: chunkPlan, needsRequery: needsRequery,
      clampSpan: clampSpan, CHUNK: CHUNK, chunkUnit: chunkUnit, probeChunk: probeChunk, adaptiveChunkWidth: adaptiveChunkWidth,
      nextAdaptiveChunk: nextAdaptiveChunk, splitPiece: splitPiece, refusalKind: refusalKind, timeoutSplittable: timeoutSplittable,
      busyBackoffMs: busyBackoffMs,
      BUCKET_ALIGN: BUCKET_ALIGN, bucketShift: bucketShift, penView: penView, joinViews: joinViews, PlotJoin: PlotJoin,
      statsFor: statsFor, valueAt: valueAt, heldAt: heldAt, knownEndOf: knownEndOf, hasPairs: hasPairs, renewBeforeMs: renewBeforeMs,
      isValueAgg: isValueAgg, autoRawAllowed: autoRawAllowed, rawView: rawView,
      trackBadRun: trackBadRun, planIncrementalSince: planIncrementalSince,
      Canceller: Canceller, HistoryQueue: HistoryQueue, HistoryClient: HistoryClient,
      SeriesStore: SeriesStore, dataKeyOf: dataKeyOf, ChartEngine: ChartEngine, ENGINE: ENGINE,
      AnnotationLayer: AnnotationLayer, ANN: ANN, parseAnnData: parseAnnData,
    };
    NS.debug = NS.debug || {};
    NS.debug.charts = NS.debug.charts || {};

    /* ========================================================================
     * SECTION 11 / CtgChartDelegate — browser half of the chart protocol
     * ----------------------------------------------------------------------
     * Keeps the gateway's view of the chart:
     *   snap   chart.snapshot, updated by chart.pens (pens, trend, trendEdit,
     *          readScope, annotations capabilities)
     *   creds  flat {url, token, expiresAt} — held in the module-private
     *          CREDS WeakMap, never as a property and never in the mapped
     *          props: `snap` is the snapshot WITHOUT its `history` member
     *          (nothing reachable from window.__CTG holds the token)
     *   values latest chart.values entry per pen key
     * and forwards every change to its engine listeners:
     *   on(fn) -> off; fn(type, payload), type 'snapshot' | 'pens' | 'values' |
     *   'token' | 'epoch' | 'state'.
     * mapStateToProps adds a `rev` counter plus the base's mapped
     * stale/staleReason (the chart shows watchdog/resync states).
     * ====================================================================== */
    class CtgChartDelegate extends NS.delegate.CtgDelegateBase {
      constructor(store) {
        super(store, 'chart');
        this.snap = null;
        CREDS.set(this, null);
        this.values = {};
        this.rev = 0;
        this._chartListeners = [];
        this._renewP = null;
      }

      extraState() {
        return { snap: this.snap, rev: this.rev, hasToken: !!CREDS.get(this) };
      }

      on(fn) {
        var self = this;
        this._chartListeners.push(fn);
        return function () { var i = self._chartListeners.indexOf(fn); if (i >= 0) self._chartListeners.splice(i, 1); };
      }

      _notifyChart(type, payload) {
        this._chartListeners.slice().forEach(function (fn) {
          try { fn(type, payload); } catch (e) { log.warn('chart listener failed', type, e); }
        });
      }

      /** Base hook: every state change (connection, phase, resync) — the engine re-evaluates liveness. */
      changed() {
        super.changed();
        if (this._chartListeners && this._chartListeners.length) this._notifyChart('state');
      }

      /** True while a history token is held (the token itself is only reachable through credsOf()). */
      hasCreds() { return !!CREDS.get(this); }

      /**
       * Asks the gateway for a fresh token (chart.token, rate class TOKEN). Concurrent callers share one
       * request. Resolves true when new credentials were stored.
       */
      renewToken() {
        var self = this;
        if (this._renewP) return this._renewP;
        this._renewP = this.request('chart.token', {}, { timeoutMs: 8000 }).then(function (res) {
          self._renewP = null;
          if (res.ok && res.data && res.data.token) {
            CREDS.set(self, res.data);
            // the engine learns about a renewal it did not push itself, so an 'auth' banner clears
            self._notifyChart('renewed');
            return true;
          }
          return false;
        });
        return this._renewP;
      }

      onMessage(name, payload) {
        if (name === 'chart.snapshot') {
          this.snap = withoutCreds(payload);
          // null: no token could be issued (a Designer whose address is unknown). Fail closed; the engine
          // shows SESSION_MISMATCH instead of "loading" forever.
          CREDS.set(this, payload && payload.history && payload.history.token ? payload.history : null);
          this.values = {};
          this.rev++;
          this.changed();
          this._notifyChart('snapshot', this.snap);
        } else if (name === 'chart.pens') {
          if (!this.snap) return;
          var patch = {};
          ['pens', 'trend', 'trendEdit', 'readScope', 'annotations', 'tagBrowser'].forEach(function (k) {
            if (hasOwn.call(payload, k)) patch[k] = payload[k];
          });
          this.snap = Object.assign({}, this.snap, patch);
          this.rev++;
          this.changed();
          this._notifyChart('pens', payload);
        } else if (name === 'chart.values') {
          var vals = payload && payload.values;
          if (!vals || typeof vals !== 'object') return;
          for (var k in vals) if (hasOwn.call(vals, k)) this.values[k] = vals[k];
          this._notifyChart('values', vals);
        } else if (name === 'chart.token') {
          CREDS.set(this, payload && payload.token ? payload : null);
          this._notifyChart('token');
        }
      }

      onEpochChange() {
        // a new gateway delegate: its state is gone; a snapshot follows (series data stays in the engine)
        this.snap = null;
        CREDS.set(this, null);
        this.values = {};
        this.rev++;
        this.changed();
        this._notifyChart('epoch');
      }
    }

    /* ========================================================================
     * SECTION 12 / render model — pens, colours, axes, y ranges (pure)
     * ----------------------------------------------------------------------
     * Everything between engine.model() and pixels that can be decided
     * without a DOM, so tests/js/chart-axes.test.mjs covers it in Node:
     *   buildPens()   pen view-models: styling source (static
     *                 pen prop / trendPens override merged over defaults),
     *                 label, stable colour, units, number format, draw type
     *   assignAxes()  named + automatic Y axes per plot (unit AND range
     *                 aware, unit-less pens get their own axis, <= 2 auto
     *                 axes per side)
     *   yRange()      per-axis range with hysteresis
     *   tick / value formatting, the date-range pill text
     * ====================================================================== */
    var DRAWABLE = { ok: true, loading: true };           // pen statuses that own a series (and an axis)
    var DISPLAY_JSON_DEFAULT = stableJson(DEFAULTS.trendPens.defaults.display);
    var AUTO_AXIS_CFG = deepFreeze(specDefault(SPEC.p.axes.item));
    var MAX_AUTO_PER_SIDE = 2;

    /** FNV-1a 32 bit (stable colour choice per tag path). */
    function hashString(s) {
      var x = 0x811c9dc5;
      for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
      return x >>> 0;
    }
    function hex2(n) { var s = Math.round(NS.util.clamp(n, 0, 255)).toString(16); return s.length < 2 ? '0' + s : s; }
    function toHex(c) { return '#' + hex2(c.r) + hex2(c.g) + hex2(c.b); }
    /** rgba() string of a CSS colour at alpha a (falls back to the colour itself when it cannot be parsed). */
    function withAlpha(color, a) {
      var c = NS.theme.parseColor(color);
      if (!c) return color;
      return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + NS.util.clamp(a * (c.a == null ? 1 : c.a), 0, 1) + ')';
    }
    /**
     * Theme-safe palette colour: a palette colour (never an explicit one) whose contrast against the
     * plot background is under `min` is mixed towards black (light backgrounds) or white (dark ones) in 8 %
     * steps until it reaches it. #BF8F00 of the default palette is 2.94:1 on white, for example.
     */
    function contrastSafe(color, bg, min) {
      var c = NS.theme.parseColor(color), b = NS.theme.parseColor(bg);
      if (!c || !b) return color;
      var target = NS.theme.luminance(b) > 0.4 ? { r: 0, g: 0, b: 0 } : { r: 255, g: 255, b: 255 };
      var cur = c;
      for (var i = 0; i < 8 && (NS.theme.contrast(cur, b) || 0) < min; i++) {
        var f = (i + 1) * 0.08;
        cur = { r: c.r + (target.r - c.r) * f, g: c.g + (target.g - c.g) * f, b: c.b + (target.b - c.b) * f, a: 1 };
      }
      return cur === c ? color : toHex(cur);
    }

    /** Path segments without the [provider] prefix. */
    function pathSegments(p) {
      var s = String(p || '').replace(/^\[[^\]]*\]/, '');
      return s.split('/').filter(function (x) { return x !== ''; });
    }
    /**
     * Shortest unique path suffix per path (the same naming rule as the gateway's for trend pens):
     * Pump1/Speed vs Pump2/Speed. Identical paths keep their full path.
     */
    function uniqueSuffixes(paths) {
      var segs = paths.map(pathSegments);
      return segs.map(function (sg, i) {
        if (!sg.length) return String(paths[i] || '');
        for (var n = 1; n <= sg.length; n++) {
          var suf = sg.slice(-n).join('/');
          var clash = segs.some(function (o, j) { return j !== i && o.length >= n && o.slice(-n).join('/').toLowerCase() === suf.toLowerCase() && NS.util.normKey(paths[j]) !== NS.util.normKey(paths[i]); });
          if (!clash) return suf;
        }
        return String(paths[i]);
      });
    }

    /** Effective draw type: Boolean pens drawn as steps unless they chose an interpolation. */
    function drawTypeOf(display, isBool) {
      var t = display.type;
      if (t === 'step') return { type: 'line', interp: 'stepAfter' };
      if ((t === 'line' || t === 'area') && isBool && display.interpolation === 'linear') return { type: t, interp: 'stepAfter' };
      return { type: t, interp: t === 'line' || t === 'area' ? display.interpolation : 'linear' };
    }

    /**
     * Resolved per-state styles of a pen (display.states; Power Chart-style styles by data state):
     *   bad   {style: 'hatch' | 'hold' | 'none', color|null}       always present
     *   oob   {low|null, high|null, color|null, width} | null      outOfBounds on and at least one limit known
     *   bool  {on|null, off|null, fill}                 | null      boolean on, and the pen is drawn as 0 / 1
     * Limits: source 'engineering' takes the tag's EngLow / EngHigh, a configured low / high overrides that side;
     * 'manual' only the configured ones. A low >= high is not a range: no limits. Colours are resolved for canvas
     * use (R: CSS variables -> concrete colours); null = the theme default at draw time (warn / textMuted / pen).
     */
    var DEFAULT_PEN_STATES = deepFreeze({ bad: { style: 'hatch', color: null }, oob: null, bool: null });
    function penStates(display, meta, isBool, R) {
      var st = display && display.states;
      if (!st) return DEFAULT_PEN_STATES;
      var res = typeof R === 'function' ? R : function (c) { return c; };
      var col = function (c) { var x = NS.props.color(c); return x ? res(x) : null; };
      var out = { bad: { style: st.bad.style, color: col(st.bad.color) }, oob: null, bool: null };
      if (isBool) {
        if (st.boolean.enabled) out.bool = { on: col(st.boolean.onColor), off: col(st.boolean.offColor), fill: st.boolean.fillOpacity };
      } else if (st.outOfBounds.enabled) {
        var o = st.outOfBounds;
        var eng = o.source === 'engineering' && meta ? meta : null;
        var low = o.low != null ? o.low : eng && NS.util.isFiniteNum(eng.engLow) ? eng.engLow : null;
        var high = o.high != null ? o.high : eng && NS.util.isFiniteNum(eng.engHigh) ? eng.engHigh : null;
        if (low != null && high != null && !(high > low)) low = high = null;
        if (low != null || high != null) out.oob = { low: low, high: high, color: col(o.color), width: o.width };
      }
      return out;
    }

    /**
     * Pen view-models in gateway PenInfo order. modelPens = engine.model().pens; p = reduced
     * props; opts.background = plot background for the palette contrast guard. Returns PenVM[]:
     * {key, source, index, tagPath, label, color, colorExplicit, visible, axis (name, '' = auto), axisKey (set by
     * assignAxes), plot, units, format, display, drawType, interp, isBool, status, meta, trendable, approx,
     * downgraded, warn, incomplete, loading, limit, message, aggregation, drawable, states (penStates)}.
     */
    function buildPens(modelPens, p, opts) {
      var o = opts || {};
      var byIndex = {}, byTag = {};
      p.pens.forEach(function (pp) {
        byIndex[pp.index] = pp;
        var k = NS.util.normKey(pp.tagPath);
        byTag[k] = hasOwn.call(byTag, k) ? null : pp;           // null = several static pens on this tag
      });
      var overrides = {};
      p.trendPens.overrides.forEach(function (ov) { var k = NS.util.normKey(ov.tagPath); if (k && !overrides[k]) overrides[k] = ov; });
      var td = p.trendPens.defaults;
      var plotCount = Math.max(1, p.plots.length);
      // a theme variable ('--qual-3' -> 'var(--qual-3)') is resolved to a concrete colour here, because the plot
      // is a canvas and a 2D context ignores var() (the series would keep the previous pen's stroke)
      var R = typeof o.resolve === 'function' ? o.resolve : function (c) { return c; };
      var palette = p.appearance.palette.map(function (c) { var x = NS.props.color(c); return x ? R(x) : x; }).filter(Boolean);
      if (!palette.length) palette = DEFAULTS.appearance.palette.slice();
      var suffix = uniqueSuffixes(modelPens.map(function (mp) { return mp.tagPath; }));
      var vms = modelPens.map(function (mp, i) {
        var trend = mp.source === 'trend';
        var sp = !trend && mp.index != null ? byIndex[mp.index] || null : null;
        // between a local `pens` write and the gateway's next chart.pens push the indexes disagree: an entry
        // that names another tag is not this pen's (its name / colour would be shown on the wrong row)
        if (sp && NS.util.normKey(sp.tagPath) !== NS.util.normKey(mp.tagPath)) sp = byTag[NS.util.normKey(mp.tagPath)] || null;
        var ov = trend ? overrides[NS.util.normKey(mp.tagPath)] || null : null;
        var display, axis, plot, explicitName, explicitColor, visible, units, format;
        if (trend) {
          display = ov && stableJson(ov.display) !== DISPLAY_JSON_DEFAULT ? ov.display : td.display;
          axis = ov && ov.axis ? ov.axis : td.axis;
          plot = ov && ov.plot ? ov.plot : td.plot;
          explicitName = ov ? ov.name : '';
          explicitColor = ov ? ov.color : '';
          visible = ov ? ov.visible : true;
          units = ov ? ov.units : '';
          format = ov ? ov.format : '';
        } else {
          var s = sp || DEFAULTS_PEN;
          display = s.display; axis = s.axis; plot = s.plot; explicitName = s.name; explicitColor = s.color;
          visible = s.visible; units = s.units; format = s.format;
        }
        var meta = mp.meta || null;
        // a Boolean is drawn as a 0/1 signal only while its values are 0/1: raw, or LastValue / Minimum / Maximum /
        // MinMax buckets. DurationOn, CountOn, Count, Sum, Average… of a Boolean are numbers on a normal axis
        // (the fixed [-0.1, 1.1] digital axis would clip them)
        var penMode = mp.coverage && mp.coverage.mode ? mp.coverage.mode : p.query.mode === 'raw' ? 'raw' : 'aggregated';
        var penAgg = mp.aggregation || p.query.aggregation;
        var isBool = !!(meta && /^bool/i.test(String(meta.dataType || ''))) && (penMode === 'raw' || hasOwn.call(DIGITAL_AGGS, penAgg));
        var label = explicitName;
        if (!label) {
          if (trend && p.trendPens.nameMode === 'leaf') label = NS.util.shortTagName(mp.tagPath);
          else if (trend && p.trendPens.nameMode === 'full') label = mp.tagPath;
          else if (trend && mp.serverName) label = mp.serverName;
          else label = suffix[i] || mp.tagPath || mp.key;
        }
        var dt = drawTypeOf(display, isBool);
        return {
          key: mp.key, source: trend ? 'trend' : 'pens', index: trend ? null : mp.index != null ? mp.index : null,
          tagPath: mp.tagPath, label: String(label), name: String(label),
          colorExplicit: NS.props.color(explicitColor), color: null,
          visible: visible !== false, axis: axis || '', axisKey: null, plot: Math.min(Math.max(0, plot | 0), plotCount - 1),
          units: units || (meta && meta.engUnit) || '', format: format || (meta && meta.formatString) || '',
          display: display, drawType: dt.type, interp: dt.interp, isBool: isBool, states: penStates(display, meta, isBool, R),
          status: mp.status, meta: meta, trendable: mp.trendable !== false, approx: !!mp.approx, downgraded: !!mp.downgraded,
          warn: mp.warn || null, incomplete: mp.incomplete || null, loading: !!mp.loading, limit: mp.limit, message: mp.message,
          aggregation: mp.aggregation, drawable: !!DRAWABLE[mp.status], shared: false, axisMissing: null,
          points: mp.points != null ? mp.points : 0,
          // static pens: the reduced entry's name + aggregation (tie-breaker when several pens trend one tag)
          penRef: sp ? { name: String(sp.name || ''), aggregation: String(sp.aggregation || 'default') } : null,
        };
      });
      // colours: explicit first, static pens palette[index % n], trend pens hashed and probed to a free colour
      var used = {};
      vms.forEach(function (vm) { if (vm.colorExplicit) used[String(R(vm.colorExplicit)).toLowerCase()] = true; });
      vms.forEach(function (vm) {
        if (vm.colorExplicit || vm.source === 'trend') return;
        vm.color = palette[(vm.index != null ? vm.index : 0) % palette.length];
        used[vm.color.toLowerCase()] = true;
      });
      vms.forEach(function (vm) {
        if (vm.colorExplicit || vm.source !== 'trend') return;
        var start = hashString(NS.util.normKey(vm.tagPath)) % palette.length;
        var pick = palette[start];
        for (var k = 0; k < palette.length; k++) {
          var c = palette[(start + k) % palette.length];
          if (!used[c.toLowerCase()]) { pick = c; break; }
        }
        vm.color = pick;
        used[pick.toLowerCase()] = true;
      });
      vms.forEach(function (vm) {
        if (vm.colorExplicit) vm.color = R(vm.colorExplicit);
        else if (o.background) vm.color = contrastSafe(vm.color, o.background, 3);
      });
      return vms;
    }
    var DEFAULTS_PEN = deepFreeze(specDefault(SPEC.p.pens.item));

    /**
     * Index in the raw `pens` array of the static pen a PenVM names: the entries whose
     * normalized tagPath matches; several (same tag, other aggregation / name) are narrowed by vm.penRef; the
     * PenVM's own index only decides between entries that are indistinguishable. -1 = not found / ambiguous.
     */
    function staticPenIndex(raw, vm) {
      if (!Array.isArray(raw) || !vm) return -1;
      var nk = NS.util.normKey(vm.tagPath);
      var hits = [];
      raw.forEach(function (x, j) { if (NS.util.isPlainObject(x) && NS.util.normKey(x.tagPath) === nk) hits.push(j); });
      if (hits.length <= 1) return hits.length ? hits[0] : -1;
      var ref = vm.penRef;
      var fine = !ref ? hits : hits.filter(function (j) {
        var x = raw[j];
        return (typeof x.name === 'string' ? x.name : '') === ref.name &&
          (typeof x.aggregation === 'string' && x.aggregation ? x.aggregation : 'default') === ref.aggregation;
      });
      if (fine.length === 1) return fine[0];
      if (!fine.length) return -1;
      if (fine.indexOf(vm.index) >= 0) return vm.index;
      var first = stableJson(raw[fine[0]]);
      return fine.every(function (j) { return stableJson(raw[j]) === first; }) ? fine[0] : -1;
    }

    /** Finite positive engineering span of a pen, else null. */
    function engSpan(vm) {
      var m = vm.meta;
      if (!m || !NS.util.isFiniteNum(m.engLow) || !NS.util.isFiniteNum(m.engHigh)) return null;
      var s = m.engHigh - m.engLow;
      return s > 0 ? s : null;
    }

    /**
     * Y axes per plot. Mutates vm.axisKey / vm.shared / vm.axisMissing of the drawable
     * pens and returns {plots: [[AxisVM…] per plot], byKey}. AxisVM = {key, name|null, auto, side, plot, units[],
     * penKeys[], digital, cfg (the axes[] entry, or the auto-axis defaults), grid (draws grid lines)}.
     * Named axes: `y:<name>`; auto: `y:auto:<plot>:digital` (Boolean), `y:auto:<plot>:u:<unit>:<k>` (same EngUnit,
     * split when the engineering spans differ by >= 10x), `y:auto:<plot>:pen:<penKey>` (no unit). Auto axes
     * alternate left/right in pen order, at most 2 per side; further pens join the outermost axis of the side
     * with fewer axes and are flagged `shared` ("shares a scale"). Named axes do not count toward the cap.
     */
    function assignAxes(vms, p) {
      var plotCount = Math.max(1, p.plots.length);
      var named = {};
      p.axes.forEach(function (ax) { if (ax.name && !named[ax.name]) named[ax.name] = ax; });
      var plots = [];
      var byKey = {};
      for (var k = 0; k < plotCount; k++) {
        var list = [];
        var pens = vms.filter(function (vm) { return vm.drawable && vm.plot === k; });
        var add = function (ax) { list.push(ax); byKey[k + '|' + ax.key] = ax; return ax; };
        var get = function (key) { return byKey[k + '|' + key] || null; };
        // 1. named axes
        var auto = [];
        pens.forEach(function (vm) {
          if (vm.axis && named[vm.axis]) {
            var key = 'y:' + vm.axis;
            var ax = get(key) || add({ key: key, name: vm.axis, auto: false, side: named[vm.axis].position, plot: k, units: [], penKeys: [],
              digital: false, cfg: named[vm.axis] });
            ax.penKeys.push(vm.key);
            if (vm.units && ax.units.indexOf(vm.units) < 0) ax.units.push(vm.units);
            vm.axisKey = key;
          } else {
            vm.axisMissing = vm.axis ? vm.axis : null;
            auto.push(vm);
          }
        });
        // 2. auto groups, keyed in order of the first pen
        var groups = [];
        var byGroup = {};
        var unitPens = {};
        auto.forEach(function (vm) {
          var unit = String(vm.units || '').trim().toLowerCase();
          if (vm.isBool) {
            var gk = 'y:auto:' + k + ':digital';
            if (!byGroup[gk]) { byGroup[gk] = { key: gk, digital: true, pens: [] }; groups.push(byGroup[gk]); }
            byGroup[gk].pens.push(vm);
          } else if (unit) {
            if (!unitPens[unit]) { unitPens[unit] = []; groups.push({ unit: unit }); }
            unitPens[unit].push(vm);
          } else {
            var pk = 'y:auto:' + k + ':pen:' + vm.key;
            byGroup[pk] = { key: pk, digital: false, pens: [vm] };
            groups.push(byGroup[pk]);
          }
        });
        // unit groups split by range: sort by span, a new axis whenever span / first-of-axis >= 10
        var expanded = [];
        groups.forEach(function (g) {
          if (!g.unit) { expanded.push(g); return; }
          var ps = unitPens[g.unit];
          var withSpan = ps.filter(function (vm) { return engSpan(vm) != null; }).sort(function (a, b) { return engSpan(a) - engSpan(b); });
          var noSpan = ps.filter(function (vm) { return engSpan(vm) == null; });
          var subs = [];
          withSpan.forEach(function (vm) {
            var cur = subs[subs.length - 1];
            if (!cur || engSpan(vm) / cur.first >= 10) { cur = { first: engSpan(vm), pens: [] }; subs.push(cur); }
            cur.pens.push(vm);
          });
          if (!subs.length) subs.push({ first: null, pens: [] });
          subs[0].pens = subs[0].pens.concat(noSpan);
          // keep pen order inside an axis and order the axes by their first pen
          subs.forEach(function (s, si) {
            s.pens.sort(function (a, b) { return vms.indexOf(a) - vms.indexOf(b); });
            expanded.push({ key: 'y:auto:' + k + ':u:' + g.unit + ':' + si, digital: false, pens: s.pens });
          });
        });
        expanded.sort(function (a, b) { return vms.indexOf(a.pens[0]) - vms.indexOf(b.pens[0]); });
        // 3. sides: alternate, <= MAX_AUTO_PER_SIDE per side
        var side = { left: [], right: [] };
        list.forEach(function (ax) { ax.side = ax.side === 'right' ? 'right' : 'left'; });
        expanded.forEach(function (g, gi) {
          var want = gi % 2 === 0 ? 'left' : 'right';
          if (side[want].length >= MAX_AUTO_PER_SIDE) want = want === 'left' ? 'right' : 'left';
          var ax;
          if (side[want].length >= MAX_AUTO_PER_SIDE) {
            // cap reached on both sides: the outermost axis of the side with fewer axes (left on a tie)
            var target = side.left.length <= side.right.length ? side.left : side.right;
            ax = target[target.length - 1];
            g.pens.forEach(function (vm) { vm.shared = true; });
          } else {
            ax = add({ key: g.key, name: null, auto: true, side: want, plot: k, units: [], penKeys: [], digital: !!g.digital, cfg: AUTO_AXIS_CFG });
            side[want].push(ax);
          }
          g.pens.forEach(function (vm) {
            ax.penKeys.push(vm.key);
            vm.axisKey = ax.key;
            if (vm.units && ax.units.indexOf(vm.units) < 0) ax.units.push(vm.units);
          });
          if (ax.digital && g.pens.some(function (vm) { return !vm.isBool; })) ax.digital = false;
        });
        // 4. grid: the innermost axis of each side draws grid lines (axes[].grid.visible); an auto axis on the
        //    right does not when the left side already does (two unaligned grids are noise)
        var leftGrid = false;
        ['left', 'right'].forEach(function (sd) {
          var first = list.filter(function (ax) { return ax.side === sd; })[0];
          list.forEach(function (ax) { if (ax.side === sd) ax.grid = false; });
          if (!first || !first.cfg.grid.visible) return;
          if (sd === 'right' && first.auto && leftGrid) return;
          first.grid = true;
          if (sd === 'left') leftGrid = true;
        });
        plots.push(list);
      }
      return { plots: plots, byKey: byKey };
    }

    /** Nice tick step for a range (1, 2, 2.5, 5 x 10^n) aiming at `target` intervals. */
    function niceStep(range, target) {
      var raw = Math.abs(range) / Math.max(1, target || 5);
      if (!(raw > 0) || !isFinite(raw)) return 1;
      var mag = Math.pow(10, Math.floor(Math.log10(raw)));
      var steps = [1, 2, 2.5, 5, 10];
      for (var i = 0; i < steps.length; i++) if (steps[i] * mag >= raw) return steps[i] * mag;
      return 10 * mag;
    }
    /**
     * [lo, hi] rounded outwards to a fine nice step (about 1/16 of the range): the padding stays close to
     * axes[].range.padding instead of growing to a whole tick interval (0..100 data -> -10..110, not -25..125).
     */
    function niceRange(lo, hi) {
      var st = niceStep(hi - lo, 16);
      var a = Math.floor(lo / st) * st, b = Math.ceil(hi / st) * st;
      // floating noise (0.30000000000000004) -> as many decimals as the step has
      var dec = Math.max(0, -Math.floor(Math.log10(st)) + 2);
      return [+a.toFixed(Math.min(dec, 12)), +b.toFixed(Math.min(dec, 12))];
    }
    /**
     * yRange(axis, dmin, dmax, st, eng) -> [lo, hi].
     *   axis  AxisVM ({digital, cfg:{scale, range:{mode, min, max, includeZero, padding}}})
     *   dmin/dmax  min/max of the SHOWN series of the axis over the visible window (null: no data in view)
     *   st    per-axis hysteresis state {prev:[lo,hi]|null} (mutated); reset on pen-set / axis / mode change
     *   eng   {low, high} engineering limits of the axis' first pen with finite limits, or null
     * auto: data (+ 0 when includeZero), widened when flat, padded, nice-rounded; the previous range is kept
     * while it still contains the data and the data fills >= 60 % of it (no jitter, not grow-only).
     * No data in view keeps the previous range (no collapsing axis while a re-query runs).
     */
    function yRange(axis, dmin, dmax, st, eng) {
      var r = axis.cfg.range;
      var state = st || {};
      if (axis.digital) return [-0.1, 1.1];
      if (axis.cfg.scale === 'log') {
        // range.mode 'engineering' and 'manual' apply to a log axis too (not only the decade fit to the data);
        // a side that is not > 0 cannot be drawn on a log scale and falls back to the decade fit.
        if (r.mode === 'engineering' && eng && NS.util.isFiniteNum(eng.low) && NS.util.isFiniteNum(eng.high) && eng.low > 0 &&
            eng.high > eng.low) {
          return [eng.low, eng.high];
        }
        var fit = function () {
          if (!(dmax > 0)) return state.prev || [1, 10];
          var lmin = dmin > 0 ? dmin : dmax / 10;
          var res = [Math.pow(10, Math.floor(Math.log10(lmin))), Math.pow(10, Math.ceil(Math.log10(dmax)))];
          if (res[0] === res[1]) res[1] = res[0] * 10;
          state.prev = res;
          return res;
        };
        if (r.mode === 'manual') {
          var lg = (r.min != null && r.min > 0) && (r.max != null && r.max > 0) ? null : fit();
          var llo = r.min != null && r.min > 0 ? r.min : lg[0];
          var lhi = r.max != null && r.max > 0 ? r.max : lg[1];
          return llo < lhi ? [llo, lhi] : fit();
        }
        return fit();
      }
      if (r.mode === 'engineering' && eng && NS.util.isFiniteNum(eng.low) && NS.util.isFiniteNum(eng.high) && eng.high > eng.low) {
        return [eng.low, eng.high];
      }
      var auto = function () {
        if (dmin == null || dmax == null || !isFinite(dmin) || !isFinite(dmax)) return state.prev || [0, 1];
        var lo = dmin, hi = dmax;
        if (r.includeZero) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
        if (lo === hi) { var w = Math.max(1, Math.abs(lo) * 0.1); lo -= w; hi += w; }
        var pad = (hi - lo) * r.padding;
        var nr = niceRange(lo - pad, hi + pad);
        var pv = state.prev;
        if (pv && pv[0] <= nr[0] && nr[1] <= pv[1] && (nr[1] - nr[0]) >= 0.6 * (pv[1] - pv[0])) return pv;
        state.prev = nr;
        return nr;
      };
      if (r.mode === 'manual') {
        var a = auto();
        var lo2 = r.min != null ? r.min : a[0], hi2 = r.max != null ? r.max : a[1];
        return lo2 < hi2 ? [lo2, hi2] : a;
      }
      return auto();
    }

    /** Number pattern for a value without a configured format: precision by magnitude. */
    function autoPattern(v) {
      var a = Math.abs(v);
      if (a >= 1000) return '#,##0.#';
      if (a >= 1 || a === 0) return '#,##0.##';
      if (a >= 0.01) return '0.####';
      return '0.######';
    }
    /** Pen value text: pen format (or the tag's FormatString) else automatic; '—' for no value. */
    function formatPenValue(v, vm, locale) {
      if (v == null || typeof v !== 'number' || !isFinite(v)) return '—';
      if (vm && vm.isBool && !vm.format) return v >= 0.5 ? '1' : '0';
      return NS.format.number(v, vm && vm.format ? vm.format : autoPattern(v), locale);
    }
    /** Tick labels: the axis format, else decimals that resolve the tick increment. */
    function tickFormatter(axis, locale) {
      var pat = axis.cfg.format;
      return function (v, incr) {
        if (pat) return NS.format.number(v, pat, locale);
        if (axis.digital) return v === 0 || v === 1 ? String(v) : '';
        var dec = incr > 0 && incr < 1 ? Math.min(10, Math.ceil(-Math.log10(incr) - 1e-9)) : 0;
        var p = '#,##0' + (dec > 0 ? '.' + new Array(dec + 1).join('0') : '');
        return NS.format.number(v, p, locale);
      };
    }

    /** "15 minutes" style text (singular for 1). */
    function unitText(value, unit) {
      var u = value === 1 ? unit.replace(/s$/, '') : unit;
      return NS.i18n.t('chart.unit.' + u);
    }
    /** Span in ms as "5 min", "2 h", "3 d" (zoomed realtime pill). */
    function spanText(ms) {
      var u = [[365 * DAY, 'years'], [7 * DAY, 'weeks'], [DAY, 'days'], [HOUR, 'hours'], [MINUTE, 'minutes'], [SECOND, 'seconds']];
      for (var i = 0; i < u.length; i++) {
        var n = ms / u[i][0];
        if (n >= 1) { var r = Math.round(n * 10) / 10; return NS.i18n.t('chart.range.last', { n: r, unit: unitText(r, u[i][1]) }); }
      }
      return NS.i18n.t('chart.range.last', { n: Math.round(ms), unit: 'ms' });
    }
    /** Time pattern for a window of `span` ms. */
    function spanPattern(span, sameDay) {
      if (span < 10 * MINUTE) return sameDay ? 'HH:mm:ss' : 'MM-DD HH:mm:ss';
      return sameDay ? 'HH:mm' : 'YYYY-MM-DD HH:mm';
    }
    /**
     * Date pill text: realtime "Last 8 hours"; historical "2026-10-01 08:00 → 2026-10-01 16:00"
     * (+ zone when it is not the browser's); a zoomed / paused view "Zoomed: 10:02 – 10:14". Returns
     * {text, zoomed}.
     */
    function rangeLabel(p, m, tz) {
      var vp = m.viewport;
      var win = m.window;
      var tr = p.timeRange;
      var browserTz = (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return null; } })();
      var zoneSuffix = tz && browserTz && tz !== browserTz ? ' (' + tz + ')' : '';
      if (tr.mode === 'realtime') {
        if (vp && vp.followLive) {
          if (win && Math.abs(vp.span - win.span) > SECOND) return { text: spanText(vp.span), zoomed: true };
          return { text: NS.i18n.t('chart.range.last', { n: tr.realtime.value, unit: unitText(tr.realtime.value, tr.realtime.unit) }), zoomed: false };
        }
      } else if (win && vp && vp.min != null && Math.abs(vp.min - win.start) <= SECOND && Math.abs(vp.max - win.end) <= SECOND) {
        var pat = 'YYYY-MM-DD HH:mm';
        return { text: NS.i18n.t('chart.range.historical', { from: NS.time.format(win.start, pat, tz), to: NS.time.format(win.end, pat, tz) }) + zoneSuffix, zoomed: false };
      }
      if (vp && vp.min != null && vp.max != null) {
        var same = NS.time.format(vp.min, 'YYYY-MM-DD', tz) === NS.time.format(vp.max, 'YYYY-MM-DD', tz);
        var pt = spanPattern(vp.max - vp.min, same);
        return { text: NS.i18n.t('chart.range.zoomed', { from: NS.time.format(vp.min, pt, tz), to: NS.time.format(vp.max, pt, tz) }) + zoneSuffix, zoomed: true };
      }
      return { text: NS.i18n.t('chart.btn.dateRange'), zoomed: false };
    }

    /* ========================================================================
     * SECTION 13 / NS.chart.loadUPlot — the bundled uPlot, loaded once per page
     * ----------------------------------------------------------------------
     * Injects /res/simpletagdisplay/css/uplot.min.css and js/uplot.min.js with
     * this file's own ?v= (immutable cache) and resolves window.uPlot.
     * A failed load is NOT cached: the <script> is removed and the next
     * call tries again; the component retries after 3 s, 10 s, 30 s, then
     * every 30 s, with the banner "Chart library failed to load (retrying)".
     * ====================================================================== */
    var uplotLoad = null;
    var LIB_RETRY_MS = [3000, 10000, 30000];
    var UPLOT_CSS = '/res/simpletagdisplay/css/uplot.min.css?v=' + encodeURIComponent(BUILD);
    var UPLOT_JS = '/res/simpletagdisplay/js/uplot.min.js?v=' + encodeURIComponent(BUILD);
    function resUrl(rel) { return new URL(rel, src || location.href).href; }
    function loadUPlot() {
      if (W.uPlot) return Promise.resolve(W.uPlot);
      if (uplotLoad) return uplotLoad;
      uplotLoad = new Promise(function (resolve, reject) {
        if (!document.getElementById('ctg-uplot-css')) {
          var link = document.createElement('link');
          link.id = 'ctg-uplot-css';
          link.rel = 'stylesheet';
          link.href = resUrl(UPLOT_CSS);
          document.head.appendChild(link);
        }
        var s = document.createElement('script');
        s.id = 'ctg-uplot-js';
        s.src = resUrl(UPLOT_JS);
        s.async = true;
        s.onload = function () {
          if (W.uPlot) resolve(W.uPlot);
          else { uplotLoad = null; if (s.parentNode) s.parentNode.removeChild(s); reject(new Error('uPlot missing after load')); }
        };
        s.onerror = function () {
          uplotLoad = null;                       // never cache a failure
          if (s.parentNode) s.parentNode.removeChild(s);
          reject(new Error('uPlot failed to load'));
        };
        document.head.appendChild(s);
      });
      return uplotLoad;
    }

    /* ========================================================================
     * SECTION 14a / curve path builders — the Power Chart's curve types
     * ----------------------------------------------------------------------
     * display.interpolation picks how a line / area pen joins its samples.
     * The Power Chart draws d3's 13 curves (curveBasis … curveStepBefore);
     * uPlot ships three path builders (linear, spline = monotone cubic,
     * stepped). The mapping:
     *   linear                     uPlot's default builder (pixel-decimated)
     *   spline                     uPlot.paths.spline()          (v2.0 name)
     *   stepAfter / stepBefore     uPlot.paths.stepped({align: 1 / -1})
     *   stepCenter, basis, basisOpen, cardinal, cardinalOpen, catmullRom,
     *   catmullRomOpen, monotoneX, monotoneY, natural
     *                              curvePaths(kind): the d3-shape curve state
     *                              machines below, drawn into a Path2D
     * Power Chart names map one to one (curveBasis -> basis, curveStep ->
     * stepCenter, curveLinear -> linear, …); `spline` stays the fast,
     * overshoot-free choice.
     *
     * curvePaths() follows uPlot's gap rule: null (bad quality) ends a run
     * while the pen breaks its line at bad data (breakLine), an `undefined`
     * cell (another pen's sample time in the joined data) is skipped. Every
     * run of defined points is one curve (lineStart … lineEnd); an area pen
     * closes each run down to its fillTo baseline.
     * Density guard: with more of the pen's own samples in view than device
     * pixels across the plot (other pens' rows of the joined data are not
     * counted), a smooth curve cannot be told from straight segments and the
     * per-point Bezier work would only cost frame time, so the
     * builder hands that frame to uPlot's decimating linear builder.
     * ====================================================================== */
    // d3-shape v3 curves, ported for a uPlot Path2D. Copyright 2010-2021 Mike Bostock, ISC licence
    // (https://github.com/d3/d3-shape/blob/main/LICENSE): "Permission to use, copy, modify, and/or distribute this
    // software for any purpose with or without fee is hereby granted, provided that the above copyright notice and
    // this permission notice appear in all copies." Only line output is needed here (no d3 area mode), so the
    // originals' _line / closePath bookkeeping is left out; per run the geometry is unchanged.
    function CurveLinear(c) { this._c = c; }
    CurveLinear.prototype.lineStart = function () { this._point = 0; };
    CurveLinear.prototype.lineEnd = function () { };
    CurveLinear.prototype.point = function (x, y) {
      if (this._point) this._c.lineTo(x, y);
      else { this._point = 1; this._c.moveTo(x, y); }
    };

    function basisPoint(that, x, y) {
      that._c.bezierCurveTo((2 * that._x0 + that._x1) / 3, (2 * that._y0 + that._y1) / 3, (that._x0 + 2 * that._x1) / 3,
        (that._y0 + 2 * that._y1) / 3, (that._x0 + 4 * that._x1 + x) / 6, (that._y0 + 4 * that._y1 + y) / 6);
    }
    /** curveBasis: cubic B-spline, clamped to the first and last point (does not pass through the others). */
    function CurveBasis(c) { this._c = c; }
    CurveBasis.prototype.lineStart = function () { this._x0 = this._x1 = this._y0 = this._y1 = NaN; this._point = 0; };
    CurveBasis.prototype.lineEnd = function () {
      switch (this._point) {
        case 3: basisPoint(this, this._x1, this._y1); // falls through
        case 2: this._c.lineTo(this._x1, this._y1); break;
        default: break;
      }
    };
    CurveBasis.prototype.point = function (x, y) {
      switch (this._point) {
        case 0: this._point = 1; this._c.moveTo(x, y); break;
        case 1: this._point = 2; break;
        case 2: this._point = 3; this._c.lineTo((5 * this._x0 + this._x1) / 6, (5 * this._y0 + this._y1) / 6); // falls through
        default: basisPoint(this, x, y); break;
      }
      this._x0 = this._x1; this._x1 = x;
      this._y0 = this._y1; this._y1 = y;
    };
    /** curveBasisOpen: the B-spline without the clamped end segments. */
    function CurveBasisOpen(c) { this._c = c; }
    CurveBasisOpen.prototype.lineStart = CurveBasis.prototype.lineStart;
    CurveBasisOpen.prototype.lineEnd = function () { };
    CurveBasisOpen.prototype.point = function (x, y) {
      switch (this._point) {
        case 0: this._point = 1; break;
        case 1: this._point = 2; break;
        case 2: this._point = 3; this._c.moveTo((this._x0 + 4 * this._x1 + x) / 6, (this._y0 + 4 * this._y1 + y) / 6); break;
        case 3: this._point = 4; // falls through
        default: basisPoint(this, x, y); break;
      }
      this._x0 = this._x1; this._x1 = x;
      this._y0 = this._y1; this._y1 = y;
    };

    function cardinalPoint(that, x, y) {
      that._c.bezierCurveTo(that._x1 + that._k * (that._x2 - that._x0), that._y1 + that._k * (that._y2 - that._y0),
        that._x2 + that._k * (that._x1 - x), that._y2 + that._k * (that._y1 - y), that._x2, that._y2);
    }
    /** curveCardinal (tension 0): cubic Hermite through every point. */
    function CurveCardinal(c, tension) { this._c = c; this._k = (1 - tension) / 6; }
    CurveCardinal.prototype.lineStart = function () {
      this._x0 = this._x1 = this._x2 = this._y0 = this._y1 = this._y2 = NaN;
      this._point = 0;
    };
    CurveCardinal.prototype.lineEnd = function () {
      switch (this._point) {
        case 2: this._c.lineTo(this._x2, this._y2); break;
        case 3: cardinalPoint(this, this._x1, this._y1); break;
        default: break;
      }
    };
    CurveCardinal.prototype.point = function (x, y) {
      switch (this._point) {
        case 0: this._point = 1; this._c.moveTo(x, y); break;
        case 1: this._point = 2; this._x1 = x; this._y1 = y; break;
        case 2: this._point = 3; // falls through
        default: cardinalPoint(this, x, y); break;
      }
      this._x0 = this._x1; this._x1 = this._x2; this._x2 = x;
      this._y0 = this._y1; this._y1 = this._y2; this._y2 = y;
    };
    /** curveCardinalOpen: the cardinal spline without the first and last segment. */
    function CurveCardinalOpen(c, tension) { this._c = c; this._k = (1 - tension) / 6; }
    CurveCardinalOpen.prototype.lineStart = CurveCardinal.prototype.lineStart;
    CurveCardinalOpen.prototype.lineEnd = function () { };
    CurveCardinalOpen.prototype.point = function (x, y) {
      switch (this._point) {
        case 0: this._point = 1; break;
        case 1: this._point = 2; break;
        case 2: this._point = 3; this._c.moveTo(this._x2, this._y2); break;
        case 3: this._point = 4; // falls through
        default: cardinalPoint(this, x, y); break;
      }
      this._x0 = this._x1; this._x1 = this._x2; this._x2 = x;
      this._y0 = this._y1; this._y1 = this._y2; this._y2 = y;
    };

    var CURVE_EPSILON = 1e-12;
    function catmullRomPoint(that, x, y) {
      var x1 = that._x1, y1 = that._y1, x2 = that._x2, y2 = that._y2;
      if (that._l01_a > CURVE_EPSILON) {
        var a = 2 * that._l01_2a + 3 * that._l01_a * that._l12_a + that._l12_2a;
        var n = 3 * that._l01_a * (that._l01_a + that._l12_a);
        x1 = (x1 * a - that._x0 * that._l12_2a + that._x2 * that._l01_2a) / n;
        y1 = (y1 * a - that._y0 * that._l12_2a + that._y2 * that._l01_2a) / n;
      }
      if (that._l23_a > CURVE_EPSILON) {
        var b = 2 * that._l23_2a + 3 * that._l23_a * that._l12_a + that._l12_2a;
        var m = 3 * that._l23_a * (that._l23_a + that._l12_a);
        x2 = (x2 * b + that._x1 * that._l23_2a - x * that._l12_2a) / m;
        y2 = (y2 * b + that._y1 * that._l23_2a - y * that._l12_2a) / m;
      }
      that._c.bezierCurveTo(x1, y1, x2, y2, that._x2, that._y2);
    }
    /** Shared step of the Catmull-Rom curves: the chord-length terms of the new point. */
    function catmullRomAdvance(that, x, y) {
      if (that._point) {
        var x23 = that._x2 - x, y23 = that._y2 - y;
        that._l23_a = Math.sqrt(that._l23_2a = Math.pow(x23 * x23 + y23 * y23, that._alpha));
      }
    }
    function catmullRomShift(that, x, y) {
      that._l01_a = that._l12_a; that._l12_a = that._l23_a;
      that._l01_2a = that._l12_2a; that._l12_2a = that._l23_2a;
      that._x0 = that._x1; that._x1 = that._x2; that._x2 = x;
      that._y0 = that._y1; that._y1 = that._y2; that._y2 = y;
    }
    /** curveCatmullRom (alpha 0.5, centripetal): smooth through every point, no cusps or self-loops. */
    function CurveCatmullRom(c, alpha) { this._c = c; this._alpha = alpha; }
    CurveCatmullRom.prototype.lineStart = function () {
      this._x0 = this._x1 = this._x2 = this._y0 = this._y1 = this._y2 = NaN;
      this._l01_a = this._l12_a = this._l23_a = this._l01_2a = this._l12_2a = this._l23_2a = this._point = 0;
    };
    CurveCatmullRom.prototype.lineEnd = function () {
      switch (this._point) {
        case 2: this._c.lineTo(this._x2, this._y2); break;
        case 3: this.point(this._x2, this._y2); break;
        default: break;
      }
    };
    CurveCatmullRom.prototype.point = function (x, y) {
      catmullRomAdvance(this, x, y);
      switch (this._point) {
        case 0: this._point = 1; this._c.moveTo(x, y); break;
        case 1: this._point = 2; break;
        case 2: this._point = 3; // falls through
        default: catmullRomPoint(this, x, y); break;
      }
      catmullRomShift(this, x, y);
    };
    /** curveCatmullRomOpen: Catmull-Rom without the first and last segment. */
    function CurveCatmullRomOpen(c, alpha) { this._c = c; this._alpha = alpha; }
    CurveCatmullRomOpen.prototype.lineStart = CurveCatmullRom.prototype.lineStart;
    CurveCatmullRomOpen.prototype.lineEnd = function () { };
    CurveCatmullRomOpen.prototype.point = function (x, y) {
      catmullRomAdvance(this, x, y);
      switch (this._point) {
        case 0: this._point = 1; break;
        case 1: this._point = 2; break;
        case 2: this._point = 3; this._c.moveTo(this._x2, this._y2); break;
        case 3: this._point = 4; // falls through
        default: catmullRomPoint(this, x, y); break;
      }
      catmullRomShift(this, x, y);
    };

    function curveSign(x) { return x < 0 ? -1 : 1; }
    // Steffen's method (1990), as in d3: the slope at (x1, y1) from its two neighbours, limited so the curve
    // stays monotone between the samples (no overshoot above a peak or below a trough)
    function monotoneSlope3(that, x2, y2) {
      var h0 = that._x1 - that._x0, h1 = x2 - that._x1;
      var s0 = (that._y1 - that._y0) / (h0 || (h1 < 0 && -0));
      var s1 = (y2 - that._y1) / (h1 || (h0 < 0 && -0));
      var p = (s0 * h1 + s1 * h0) / (h0 + h1);
      return (curveSign(s0) + curveSign(s1)) * Math.min(Math.abs(s0), Math.abs(s1), 0.5 * Math.abs(p)) || 0;
    }
    function monotoneSlope2(that, t) {
      var h = that._x1 - that._x0;
      return h ? (3 * (that._y1 - that._y0) / h - t) / 2 : t;
    }
    function monotonePoint(that, t0, t1) {
      var x0 = that._x0, y0 = that._y0, x1 = that._x1, y1 = that._y1, dx = (x1 - x0) / 3;
      that._c.bezierCurveTo(x0 + dx, y0 + dx * t0, x1 - dx, y1 - dx * t1, x1, y1);
    }
    /** curveMonotoneX: cubic through every point, monotone in y between samples (x increasing, i.e. time). */
    function CurveMonotoneX(c) { this._c = c; }
    CurveMonotoneX.prototype.lineStart = function () {
      this._x0 = this._x1 = this._y0 = this._y1 = this._t0 = NaN;
      this._point = 0;
    };
    CurveMonotoneX.prototype.lineEnd = function () {
      switch (this._point) {
        case 2: this._c.lineTo(this._x1, this._y1); break;
        case 3: monotonePoint(this, this._t0, monotoneSlope2(this, this._t0)); break;
        default: break;
      }
    };
    CurveMonotoneX.prototype.point = function (x, y) {
      var t1 = NaN;
      if (x === this._x1 && y === this._y1) return;          // coincident points are ignored
      switch (this._point) {
        case 0: this._point = 1; this._c.moveTo(x, y); break;
        case 1: this._point = 2; break;
        case 2: this._point = 3; t1 = monotoneSlope3(this, x, y); monotonePoint(this, monotoneSlope2(this, t1), t1); break;
        default: t1 = monotoneSlope3(this, x, y); monotonePoint(this, this._t0, t1); break;
      }
      this._x0 = this._x1; this._x1 = x;
      this._y0 = this._y1; this._y1 = y;
      this._t0 = t1;
    };
    /** A context with x and y swapped (d3 ReflectContext): curveMonotoneY = curveMonotoneX on the reflected points. */
    function ReflectContext(c) { this._c = c; }
    ReflectContext.prototype.moveTo = function (x, y) { this._c.moveTo(y, x); };
    ReflectContext.prototype.lineTo = function (x, y) { this._c.lineTo(y, x); };
    ReflectContext.prototype.bezierCurveTo = function (x1, y1, x2, y2, x, y) { this._c.bezierCurveTo(y1, x1, y2, x2, y, x); };
    /** curveMonotoneY: monotone in x between samples (treats the value as the independent axis). */
    function CurveMonotoneY(c) { this._c = new ReflectContext(c); }
    CurveMonotoneY.prototype.lineStart = CurveMonotoneX.prototype.lineStart;
    CurveMonotoneY.prototype.lineEnd = CurveMonotoneX.prototype.lineEnd;
    CurveMonotoneY.prototype.point = function (x, y) { CurveMonotoneX.prototype.point.call(this, y, x); };

    /** Control points of a natural cubic spline through x[] (one coordinate; Thomas algorithm, O(n)). */
    function naturalControlPoints(x) {
      var i, n = x.length - 1, m, a = new Array(n), b = new Array(n), r = new Array(n);
      a[0] = 0; b[0] = 2; r[0] = x[0] + 2 * x[1];
      for (i = 1; i < n - 1; ++i) { a[i] = 1; b[i] = 4; r[i] = 4 * x[i] + 2 * x[i + 1]; }
      a[n - 1] = 2; b[n - 1] = 7; r[n - 1] = 8 * x[n - 1] + x[n];
      for (i = 1; i < n; ++i) { m = a[i] / b[i - 1]; b[i] -= m; r[i] -= m * r[i - 1]; }
      a[n - 1] = r[n - 1] / b[n - 1];
      for (i = n - 2; i >= 0; --i) a[i] = (r[i] - a[i + 1]) / b[i];
      b[n - 1] = (x[n] + a[n - 1]) / 2;
      for (i = 0; i < n - 1; ++i) b[i] = 2 * x[i + 1] - a[i + 1];
      return [a, b];
    }
    /** curveNatural: natural cubic spline (second derivative 0 at both ends) through every point. */
    function CurveNatural(c) { this._c = c; }
    CurveNatural.prototype.lineStart = function () { this._x = []; this._y = []; };
    CurveNatural.prototype.lineEnd = function () {
      var x = this._x, y = this._y, n = x.length;
      if (n) {
        this._c.moveTo(x[0], y[0]);
        if (n === 2) this._c.lineTo(x[1], y[1]);
        else if (n > 2) {
          var px = naturalControlPoints(x), py = naturalControlPoints(y);
          for (var i0 = 0, i1 = 1; i1 < n; ++i0, ++i1) this._c.bezierCurveTo(px[0][i0], py[0][i0], px[1][i0], py[1][i0], x[i1], y[i1]);
        }
      }
      this._x = this._y = null;
    };
    CurveNatural.prototype.point = function (x, y) { this._x.push(x); this._y.push(y); };

    /** curveStep (t 0.5): the value changes half-way between two samples (stepAfter / stepBefore are uPlot's). */
    function CurveStep(c, t) { this._c = c; this._t = t; }
    CurveStep.prototype.lineStart = function () { this._x = this._y = NaN; this._point = 0; };
    CurveStep.prototype.lineEnd = function () {
      if (this._t > 0 && this._t < 1 && this._point === 2) this._c.lineTo(this._x, this._y);
    };
    CurveStep.prototype.point = function (x, y) {
      switch (this._point) {
        case 0: this._point = 1; this._c.moveTo(x, y); break;
        case 1: this._point = 2; // falls through
        default:
          if (this._t <= 0) {
            this._c.lineTo(this._x, y);
            this._c.lineTo(x, y);
          } else {
            var x1 = this._x * (1 - this._t) + x * this._t;
            this._c.lineTo(x1, this._y);
            this._c.lineTo(x1, y);
          }
          break;
      }
      this._x = x; this._y = y;
    };

    /** Curve factories by display.interpolation (the ones curvePaths draws; linear is for the tests / fallback). */
    var CURVES = {
      linear: function (c) { return new CurveLinear(c); },
      stepCenter: function (c) { return new CurveStep(c, 0.5); },
      basis: function (c) { return new CurveBasis(c); },
      basisOpen: function (c) { return new CurveBasisOpen(c); },
      cardinal: function (c) { return new CurveCardinal(c, 0); },
      cardinalOpen: function (c) { return new CurveCardinalOpen(c, 0); },
      catmullRom: function (c) { return new CurveCatmullRom(c, 0.5); },
      catmullRomOpen: function (c) { return new CurveCatmullRomOpen(c, 0.5); },
      monotoneX: function (c) { return new CurveMonotoneX(c); },
      monotoneY: function (c) { return new CurveMonotoneY(c); },
      natural: function (c) { return new CurveNatural(c); },
    };

    /**
     * Draws the defined points of xs / ys[i0..i1] as curve `kind` into ctx ({moveTo, lineTo, bezierCurveTo}).
     * X(x) / Y(v) map to pixels. null ends a run unless spanGaps; undefined (no sample of this pen at that x) and
     * non-finite values are skipped. onRunEnd() runs after each run (the area fill closes it). Returns the run count.
     */
    function drawCurve(kind, ctx, xs, ys, i0, i1, X, Y, spanGaps, onRunEnd) {
      var cv = (CURVES[kind] || CURVES.linear)(ctx);
      var open = false, runs = 0;
      for (var i = i0; i <= i1; i++) {
        var v = ys[i];
        if (typeof v !== 'number' || !isFinite(v)) {
          if (v === null && !spanGaps && open) { cv.lineEnd(); open = false; runs++; if (onRunEnd) onRunEnd(); }
          continue;
        }
        if (!open) { cv.lineStart(); open = true; }
        cv.point(X(xs[i]), Y(v));
      }
      if (open) { cv.lineEnd(); runs++; if (onRunEnd) onRunEnd(); }
      return runs;
    }

    /**
     * uPlot `paths` builder for curve `kind` (series.paths(u, seriesIdx, idx0, idx1) -> {stroke, fill, clip, band,
     * gaps, flags}). `area`: also a fill path, each run closed down to the series' fillTo value.
     */
    /**
     * Density guard count: more than `limit` of the pen's OWN rows in [i0, i1]? The data is joined per plot, so an
     * `undefined` cell is another pen's sample time and does not count (a sparse pen next to a dense one keeps its
     * curve); null (a bad-quality gap) is the pen's own row. Stops as soon as the limit is passed.
     */
    function ownRowsAbove(ys, i0, i1, limit) {
      if (i1 - i0 + 1 <= limit) return false;
      var n = 0;
      for (var i = i0; i <= i1; i++) if (ys[i] !== undefined && ++n > limit) return true;
      return false;
    }
    function curvePaths(kind, area) {
      var fallback = null;
      return function (u, si, i0, i1) {
        var s = u.series[si];
        var xs = u.data[0], ys = u.data[si];
        var bb = u.bbox;
        if (ownRowsAbove(ys, i0, i1, Math.max(2, bb.width))) {          // density guard (see the banner)
          fallback = fallback || W.uPlot.paths.linear();
          return fallback(u, si, i0, i1);
        }
        var sk = s.scale;
        var X = function (x) { return u.valToPos(x, 'x', true); };
        var Y = function (v) { return u.valToPos(v, sk, true); };
        var stroke = new Path2D();
        var fill = area ? new Path2D() : null;
        var base = bb.top + bb.height;
        if (fill) {
          var bv = typeof s.fillTo === 'function' ? s.fillTo(u, si, s.min, s.max, 0) : 0;
          var by = u.valToPos(bv, sk, true);
          if (isFinite(by)) base = NS.util.clamp(by, bb.top - 1, bb.top + bb.height + 1);
        }
        var run = { fx: null, lx: 0 };
        var ctx = {
          moveTo: function (x, y) { stroke.moveTo(x, y); if (fill) { fill.moveTo(x, y); run.fx = x; } run.lx = x; },
          lineTo: function (x, y) { stroke.lineTo(x, y); if (fill) fill.lineTo(x, y); run.lx = x; },
          bezierCurveTo: function (a, b, c, d, x, y) {
            stroke.bezierCurveTo(a, b, c, d, x, y);
            if (fill) fill.bezierCurveTo(a, b, c, d, x, y);
            run.lx = x;
          },
        };
        var closeRun = function () {
          if (run.fx == null) return;
          fill.lineTo(run.lx, base); fill.lineTo(run.fx, base); fill.closePath();
          run.fx = null;
        };
        drawCurve(kind, ctx, xs, ys, i0, i1, X, Y, !!s.spanGaps, fill ? closeRun : null);
        return { stroke: stroke, fill: fill, clip: null, band: null, gaps: null, flags: 0 };
      };
    }
    /** The `paths` of a line / area pen for its effective interpolation (undefined = uPlot's linear default). */
    function linePathsFor(interp, area) {
      var up = W.uPlot.paths;
      if (interp === 'spline') return up.spline();
      if (interp === 'stepAfter') return up.stepped({ align: 1 });
      if (interp === 'stepBefore') return up.stepped({ align: -1 });
      if (interp !== 'linear' && hasOwn.call(CURVES, interp)) return curvePaths(interp, area);
      return undefined;
    }

    /* ========================================================================
     * SECTION 14 / PlotManager — one uPlot instance per stacked plot
     * ----------------------------------------------------------------------
     * The x scale belongs to the engine's viewport, never to uPlot: uPlot's
     * own drag-zoom and double-click autoscale are off, so
     * there is no scale hook and no suppression flag. Every refresh() runs
     *   u.batch(() => { setData(data, false); setScale('x', view);
     *                   setScale(<y>, yRange(...)) for each axis })
     * per plot. Y ranges are computed here (yRange over the SHOWN series of
     * the axis inside the visible window), so hiding a pen re-ranges its axis
     * at once without relying on uPlot's autoscale rules.
     *
     * Structure changes (pens of a plot, axes, display types, colours, time
     * axis, theme-dependent colours) rebuild only the affected plot instance
     * (destroy + create, same data and viewport: zoom survives pen
     * add/remove). Visibility is uPlot's setSeries(show) — no rebuild.
     *
     * Stacked plots: heights by plots[].relativeWeight; the bottom plot also
     * carries the time axis; the others keep an invisible zero-height x axis
     * so their vertical grid lines stay aligned. The plot areas line up left
     * and right: paddings are functions reading pad.l/pad.r, re-balanced after
     * a draw when the measured axis widths changed (at most a few passes per
     * update).
     *
     * Overlays drawn on the canvas in hooks.draw (no DOM text): plot
     * background, markers (bands then lines, with labels), the pens' state
     * styles (bad-quality hatching / hold line, wider out-of-bounds
     * segments; Boolean "on" shading goes under the series, in drawClear),
     * then `overlays` — the extension point for the interaction layer
     * (traces, brushes) and annotations: fn(u, plotRecord, ctx, pm).
     *
     * Per-state colours (display.states): an out-of-bounds or Boolean
     * pen's stroke is a function returning a vertical canvas gradient with
     * hard stops where the limits / the 0.5 threshold sit on its y scale
     * (_stateStroke), so the line changes colour exactly where it crosses
     * them, for every curve type, at the cost of one gradient per draw.
     * Lifecycle events for the gesture layer (SECTION 18): pm.on('create', fn(rec))
     * after a plot instance is (re)built — attach pointer handlers to
     * rec.u.over there; 'destroy' before it goes; 'cursor' on every uPlot
     * setCursor (info box). on() returns a disposer.
     * ====================================================================== */
    var PAD = { top: 8, bottom: 4, left: 4, right: 12, between: 6, bare: 36 };
    var MIN_PLOT_H = 40;
    var measureCtx = null;
    function textWidth(text, font) {
      try {
        if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
        measureCtx.font = font;
        return measureCtx.measureText(String(text)).width;
      } catch (e) { return String(text).length * 7; }
    }
    /** min/max of columns `cols` of data rows whose x lies in [xmin, xmax] (+ the sample held at xmin). */
    function minMaxIn(data, cols, xmin, xmax) {
      var x = data[0];
      if (!x || !x.length || !cols.length) return null;
      var i0 = Math.max(0, lowerBound(x, xmin) - 1), i1 = upperBound(x, xmax);
      var lo = Infinity, hi = -Infinity;
      for (var c = 0; c < cols.length; c++) {
        var col = data[cols[c]];
        if (!col) continue;
        for (var i = i0; i < i1; i++) {
          var v = col[i];
          if (typeof v === 'number' && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
        }
      }
      return lo === Infinity ? null : [lo, hi];
    }
    /**
     * Gradient stops of a state stroke: the plot area [top, top + height] split at ya <= yb (canvas px;
     * -Infinity / Infinity = no boundary on that side, NaN = treated as none). Above ya: cAbove; between: cMid (null
     * = no middle band, ya == yb); below yb: cBelow. Hard stops (two stops at each offset). null when height <= 0.
     */
    function stateStops(top, height, ya, yb, cAbove, cMid, cBelow) {
      if (!(height > 0)) return null;
      var off = function (y, none) {
        if (y === -Infinity) return 0;
        if (y === Infinity) return 1;
        if (typeof y !== 'number' || isNaN(y)) return none;
        return NS.util.clamp((y - top) / height, 0, 1);
      };
      var fa = off(ya, 0), fb = off(yb, 1);
      if (fb < fa) fb = fa;
      var out = [[0, cAbove], [fa, cAbove]];
      if (cMid != null) out.push([fa, cMid], [fb, cMid]);
      out.push([fb, cBelow], [1, cBelow]);
      return out;
    }
    /**
     * "On" periods of a Boolean column in [a, b] (for the shading): [[t0, t1], …] with sample-and-hold semantics over
     * the joined data — `undefined` cells hold the previous state, null (bad quality) ends a period, a period still on
     * at the last sample ends there (the synthetic "now" point while following live).
     */
    function boolRuns(xs, col, a, b) {
      var out = [];
      if (!xs || !col || !xs.length) return out;
      var i0 = Math.max(0, lowerBound(xs, a) - 1), i1 = Math.min(xs.length, upperBound(xs, b) + 1);
      var start = null, lastT = null;
      for (var i = i0; i < i1; i++) {
        var v = col[i];
        if (v === undefined) continue;
        if (typeof v !== 'number' || !isFinite(v)) {
          if (start != null) { out.push([start, xs[i]]); start = null; }
          continue;
        }
        lastT = xs[i];
        if (v >= 0.5) { if (start == null) start = xs[i]; }
        else if (start != null) { out.push([start, xs[i]]); start = null; }
      }
      if (start != null && lastT != null && lastT > start) out.push([start, lastT]);
      return out;
    }
    /** The last finite value before time t in a joined column (the 'hold' bad-data line), or null. */
    function lastGoodBefore(xs, col, t) {
      if (!xs || !col) return null;
      for (var i = lowerBound(xs, t) - 1, n = 0; i >= 0 && n < 20000; i--, n++) {
        var v = col[i];
        if (typeof v === 'number' && isFinite(v)) return v;
      }
      return null;
    }
    var hatchCache = new Map();
    function hatchPattern(ctx, color, pxr) {
      var key = color + '|' + pxr;
      var pat = hatchCache.get(key);
      if (pat) return pat;
      var s = Math.round(8 * pxr);
      var c = document.createElement('canvas');
      c.width = c.height = s;
      var g = c.getContext('2d');
      g.strokeStyle = withAlpha(color, 0.35);
      g.lineWidth = Math.max(1, pxr);
      g.beginPath(); g.moveTo(0, s); g.lineTo(s, 0); g.moveTo(-s / 2, s / 2); g.lineTo(s / 2, -s / 2); g.moveTo(s / 2, s * 1.5); g.lineTo(s * 1.5, s / 2); g.stroke();
      pat = ctx.createPattern(c, 'repeat');
      if (hatchCache.size > 64) hatchCache.clear();
      hatchCache.set(key, pat);
      return pat;
    }

    function PlotManager(host, o) {
      this.host = host;
      this.engine = o.engine;
      this.syncKey = o.syncKey;
      this.onError = o.onError || function () { };
      this.tokens = o.tokens || NS.theme.tokens(host);
      this.plots = [];
      this.vm = null;
      this.width = 0;
      this.height = 0;
      this.view = { min: 0, max: 1 };
      this.overlays = [];
      this.hyst = {};               // per axis (plot|key): {prev}; dropped whole when the range epoch changes
      this._hystEpoch = 0;
      this._alignPasses = 0;
      this.destroyed = false;
      this.metrics = { creates: 0, refreshes: 0, drawMs: [] };
      this._events = { create: [], destroy: [], cursor: [] };
    }
    /** Subscribes to 'create' | 'destroy' (fn(rec)) or 'cursor' (fn(u, rec)); returns a disposer. */
    PlotManager.prototype.on = function (type, fn) {
      var list = this._events[type];
      if (!list || typeof fn !== 'function') return function () { };
      list.push(fn);
      return function () { var i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
    };
    PlotManager.prototype._fire = function (type, a, b) {
      (this._events[type] || []).slice().forEach(function (fn) { try { fn(a, b); } catch (e) { log.warn('plot ' + type + ' listener failed', e); } });
    };
    /** Sets the host size (ResizeObserver). Re-lays the plots out. */
    PlotManager.prototype.resize = function (w, h) {
      var W2 = Math.max(0, Math.floor(w)), H2 = Math.max(0, Math.floor(h));
      if (W2 === this.width && H2 === this.height) return;
      this.width = W2; this.height = H2;
      if (this.vm) this.update(this.vm);
    };
    PlotManager.prototype.setTokens = function (t) {
      this.tokens = t;
      hatchCache.clear();
      this.plots.forEach(function (rec) { try { rec.u.redraw(false, true); } catch (e) { /* ignore */ } });
    };
    /** Plot heights (CSS px): weights; the bottom plot adds the time axis height. */
    PlotManager.prototype._heights = function (vm) {
      var n = vm.plots.length;
      var xh = vm.xAxisHeight;
      var avail = Math.max(n * MIN_PLOT_H, this.height - xh - (n - 1) * PAD.between);
      var sum = vm.plots.reduce(function (a, pv) { return a + pv.weight; }, 0) || 1;
      var out = [], used = 0;
      for (var i = 0; i < n; i++) {
        var hh = i === n - 1 ? avail - used : Math.max(MIN_PLOT_H, Math.floor(avail * vm.plots[i].weight / sum));
        used += hh;
        out.push(i === n - 1 ? Math.max(MIN_PLOT_H, hh) + xh : hh);
      }
      return out;
    };
    /** Structural signature of one plot: anything that needs a new uPlot instance. */
    PlotManager.prototype._sig = function (pv, i, vm) {
      return stableJson([
        i === vm.plots.length - 1, vm.timeAxis, vm.fontSize, vm.tz, vm.locale, vm.scheme, this.syncKey,
        pv.pens.map(function (p) { return [p.key, p.axisKey, p.color, p.drawType, p.interp, p.display, p.states]; }),
        pv.axes.map(function (a) { return [a.key, a.side, a.digital, a.grid, a.cfg, a.units, a.penKeys.length === 1 ? a.penKeys[0] : '']; }),
      ]);
    };
    /** Applies a view model ({plots, viewport, ...}); creates / rebuilds / resizes plots, then refreshes. */
    PlotManager.prototype.update = function (vm) {
      if (this.destroyed) return;
      var self = this;
      this.vm = vm;
      this.view = { min: vm.viewport.min, max: vm.viewport.max };
      this._alignPasses = 0;
      if (!(this.width > 0) || !(this.height > 0) || !W.uPlot) return;
      var heights = this._heights(vm);
      while (this.plots.length > vm.plots.length) this._destroyPlot(this.plots.pop());
      vm.plots.forEach(function (pv, i) {
        var rec = self.plots[i];
        var sig = self._sig(pv, i, vm);
        if (!rec || rec.sig !== sig) {
          if (rec) self._destroyPlot(rec);
          self.plots[i] = rec = self._create(pv, i, vm, heights[i], sig);
        } else {
          rec.pv = pv;
          if (rec.h !== heights[i] || rec.w !== self.width) {
            rec.h = heights[i]; rec.w = self.width;
            rec.u.setSize({ width: rec.w, height: rec.h });
          }
        }
        rec.el.style.marginTop = i > 0 ? PAD.between + 'px' : '0';
        if (rec.el.parentNode !== self.host || self.host.children[i] !== rec.el) self.host.insertBefore(rec.el, self.host.children[i] || null);
      });
      this.refresh();
    };
    /** New data / new view: one batch per plot. */
    PlotManager.prototype.refresh = function (view) {
      if (this.destroyed || !this.vm) return;
      var self = this;
      if (view) this.view = { min: view.min, max: view.max };
      var t0 = Date.now();
      this.plots.forEach(function (rec) {
        try { self._refreshPlot(rec); } catch (e) { self.onError(e); }
      });
      this.metrics.refreshes++;
      perfPush(this.metrics.drawMs, Date.now() - t0);
    };
    /**
     * Gesture preview (pan drag, wheel, pinch: a live preview by setScale): moves the x window
     * of every plot and re-ranges the y axes over the data already joined — no join, no setData, so a frame stays
     * cheap even with 100 000+ points. The gesture's end hands the view to the engine.
     */
    PlotManager.prototype.preview = function (view) {
      if (this.destroyed || !this.vm || !view) return;
      var self = this;
      var t0 = Date.now();
      this.view = { min: view.min, max: view.max };
      this.plots.forEach(function (rec) {
        try {
          var u = rec.u, data = rec.data;
          if (!data) return;
          var ranges = rec.pv.axes.map(function (ax) { return [ax.key, self._yRange(rec, ax, data, self.view)]; });
          ranges.forEach(function (r) { rec.yr[r[0]] = r[1]; });
          u.batch(function () {
            u.setScale('x', { min: self.view.min, max: self.view.max });
            ranges.forEach(function (r) { u.setScale(r[0], { min: r[1][0], max: r[1][1] }); });
          });
        } catch (e) { self.onError(e); }
      });
      perfPush(this.metrics.previewMs || (this.metrics.previewMs = []), Date.now() - t0);
    };
    /** Redraws the canvases without rebuilding paths (overlay changes: traces, brushes, selection). */
    PlotManager.prototype.redrawOverlays = function () {
      this.plots.forEach(function (rec) { try { rec.u.redraw(false, false); } catch (e) { /* ignore */ } });
    };
    PlotManager.prototype._data = function (rec) {
      var keys = rec.pv.pens.map(function (p) { return p.key; });
      var j = this.engine.join(rec.id, keys);
      var data = j.data;
      if (rec.logCols.length) {
        // log axes ignore values <= 0 (schema: "Log scale ignores values <= 0"): a copy of those columns only
        data = data.slice();
        rec.logCols.forEach(function (c) { data[c] = data[c].map(function (v) { return typeof v === 'number' && v <= 0 ? null : v; }); });
      }
      rec.synthetic = j.synthetic;
      return data;
    };
    PlotManager.prototype._refreshPlot = function (rec) {
      var self = this;
      var u = rec.u;
      var data = this._data(rec);
      rec.data = data;
      // visibility: uPlot's own show flag (no rebuild)
      rec.pv.pens.forEach(function (p, k) {
        var s = u.series[k + 1];
        if (s && s.show !== p.visible) u.setSeries(k + 1, { show: p.visible });
      });
      var view = this.view;
      var ranges = rec.pv.axes.map(function (ax) { return [ax.key, self._yRange(rec, ax, data, view)]; });
      rec.yr = {};
      ranges.forEach(function (r) { rec.yr[r[0]] = r[1]; });
      u.batch(function () {
        u.setData(data, false);
        u.setScale('x', { min: view.min, max: view.max });
        ranges.forEach(function (r) { u.setScale(r[0], { min: r[1][0], max: r[1][1] }); });
      });
    };
    PlotManager.prototype._yRange = function (rec, ax, data, view) {
      var cols = [];
      rec.pv.pens.forEach(function (p, k) { if (p.axisKey === ax.key && p.visible) cols.push(k + 1); });
      var mm = minMaxIn(data, cols, view.min, view.max);
      // a user range change (gesture, reset, mode change) starts fresh ranges: the state of older epochs is
      // dropped here instead of being kept under epoch-specific keys forever
      var epoch = this.vm.rangeEpoch || 0;
      if (epoch !== this._hystEpoch) { this.hyst = {}; this._hystEpoch = epoch; }
      var hk = rec.index + '|' + ax.key;
      var st = this.hyst[hk] || (this.hyst[hk] = {});
      var eng = null;
      if (ax.cfg.range.mode === 'engineering') {
        rec.pv.pens.some(function (p) {
          var m = p.meta;
          if (p.axisKey === ax.key && m && NS.util.isFiniteNum(m.engLow) && NS.util.isFiniteNum(m.engHigh) && m.engHigh > m.engLow) {
            eng = { low: m.engLow, high: m.engHigh };
            return true;
          }
          return false;
        });
      }
      return yRange(ax, mm ? mm[0] : null, mm ? mm[1] : null, st, eng);
    };
    /** Axis colour: the axis' own, a one-pen auto axis in its pen's colour, else the muted text token. */
    PlotManager.prototype._axisColor = function (ax, pv) {
      var c = ax.cfg.color ? NS.props.color(ax.cfg.color) : null;
      if (c) return c;
      if (ax.auto && ax.penKeys.length === 1) {
        var pen = pv.pens.filter(function (p) { return p.key === ax.penKeys[0]; })[0];
        if (pen) return pen.color;
      }
      return this.tokens.textMuted;
    };
    PlotManager.prototype._gridColor = function (grid) {
      var c = grid.color ? NS.props.color(grid.color) : null;
      return c ? withAlpha(c, grid.opacity) : withAlpha(this.tokens.text, 0.24 * grid.opacity);
    };
    PlotManager.prototype._create = function (pv, index, vm, height, sig) {
      var self = this;
      var uPlot = W.uPlot;
      var bottom = index === vm.plots.length - 1;
      var fs = vm.fontSize;
      var font = fs + 'px ' + (this.tokens.font || 'sans-serif');
      var labelFont = '600 ' + font;
      // a side without a y axis needs room for the half of the first / last time label that overhangs the plot
      var hasL = pv.axes.some(function (a) { return a.side !== 'right' && a.cfg.visible; });
      var hasR = pv.axes.some(function (a) { return a.side === 'right' && a.cfg.visible; });
      var base = { l: hasL ? PAD.left : PAD.bare, r: hasR ? PAD.right : PAD.bare };
      var rec = { id: 'plot' + index, index: index, pv: pv, sig: sig, w: this.width, h: height, base: base, pad: { l: base.l, r: base.r },
        logCols: [], yr: {}, data: null, synthetic: -1 };
      var el = document.createElement('div');
      el.className = 'ctg-chart__plot';
      el.setAttribute('data-ctg-plot', String(index));
      rec.el = el;
      var ta = vm.timeAxis;
      var xValues = !bottom || !ta.visible ? function (u, splits) { return splits.map(function () { return ''; }); }
        : ta.format && ta.format !== 'auto' ? function (u, splits) { return splits.map(function (ms) { return NS.time.format(ms, ta.format, vm.tz); }); }
          : autoTimeValues(vm.tz);
      var axes = [{
        scale: 'x', side: 2, show: true,
        size: bottom && ta.visible ? vm.xAxisHeight : 0,
        font: font, gap: 4, space: Math.max(60, fs * 7),
        stroke: function () { return self.tokens.textMuted; },
        ticks: { show: bottom && ta.visible, stroke: function () { return withAlpha(self.tokens.textMuted, 0.6); }, width: 1, size: 4 },
        grid: { show: ta.grid.visible, stroke: function () { return self._gridColor(ta.grid); }, width: 1, dash: ta.grid.dash },
        values: xValues,
      }];
      var scales = {
        x: { time: true, auto: false, range: function (u, mn, mx) { return mn == null || mx == null ? [self.view.min, self.view.max] : [mn, mx]; } },
      };
      var tickFmt = {};
      pv.axes.forEach(function (ax) {
        var fmt = tickFmt[ax.key] = tickFormatter(ax, vm.locale);
        var log = ax.cfg.scale === 'log';
        scales[ax.key] = {
          auto: false, distr: log ? 3 : 1, log: 10,
          range: function (u, mn, mx) { return mn == null || mx == null || !(mx > mn) ? (rec.yr[ax.key] || [0, 1]) : [mn, mx]; },
        };
        var label = ax.cfg.label.visible ? (ax.cfg.label.text || ax.units.join(', ')) : '';
        var fixedW = ax.cfg.width > 0 ? ax.cfg.width : 0;
        axes.push({
          scale: ax.key, side: ax.side === 'right' ? 1 : 3, show: ax.cfg.visible,
          font: font, labelFont: labelFont, gap: 4,
          label: label || undefined, labelSize: label ? fs + 8 : 0, labelGap: 0,
          stroke: function () { return self._axisColor(ax, rec.pv); },
          ticks: { show: true, stroke: function () { return withAlpha(self._axisColor(ax, rec.pv), 0.5); }, width: 1, size: 4 },
          grid: { show: !!ax.grid, stroke: function () { return self._gridColor(ax.cfg.grid); }, width: 1, dash: ax.cfg.grid.dash },
          splits: ax.digital ? function () { return [0, 1]; } : undefined,
          values: function (u, splits, ai, space, incr) { return splits.map(function (v) { return fmt(v, incr); }); },
          size: function (u, values) {
            if (fixedW) return fixedW;
            var w = 0;
            (values || []).forEach(function (t) { w = Math.max(w, textWidth(t, font)); });
            return Math.max(28, Math.ceil(w) + 4 + 4 + 6);
          },
        });
      });
      if (!pv.axes.length) {
        scales.y = { auto: false, range: function () { return [0, 1]; } };
        axes.push({ scale: 'y', show: false });
      }
      var series = [{}];
      pv.pens.forEach(function (p, k) {
        var d = p.display;
        var axis = pv.axes.filter(function (a) { return a.key === p.axisKey; })[0];
        if (axis && axis.cfg.scale === 'log') rec.logCols.push(k + 1);
        var s = {
          label: p.label, scale: p.axisKey || 'y', show: p.visible,
          stroke: p.color, width: d.width, dash: d.dash && d.dash.length ? d.dash.slice() : undefined,
          spanGaps: !d.breakLine,
          value: function (u, v) { return formatPenValue(v, p, vm.locale); },
        };
        if (p.drawType === 'scatter') {
          s.paths = function () { return null; };
          s.points = { show: true, size: 2 * d.radius, fill: p.color, stroke: p.color, width: 1, space: 0 };
        } else if (p.drawType === 'bar') {
          s.paths = uPlot.paths.bars({ size: [0.8, Infinity], align: 0 });
          s.points = { show: false };
          s.fill = withAlpha(p.color, d.fillOpacity);
          s.fillTo = function (u, si, dmin, dmax) { return dmin <= 0 && dmax >= 0 ? 0 : dmin; };
        } else {
          var lp = linePathsFor(p.interp, p.drawType === 'area');         // SECTION 14a (curve types)
          if (lp) s.paths = lp;
          if (p.drawType === 'area') s.fill = withAlpha(p.color, d.fillOpacity);
          s.points = { size: Math.max(4, d.width * 3) };
        }
        // per-state colours: a vertical gradient with hard stops at the limits / the 0.5 threshold, read at
        // draw time (uPlot evaluates a stroke function on every draw), so a moved y range keeps the stops in place
        if (p.states && (p.states.oob || p.states.bool)) {
          s.stroke = function (u, si) { return self._stateStroke(u, rec, si); };
          // the data-point markers (canvas) take the same gradient, so a marker beyond a limit has the state colour too;
          // the cursor's hover point is a DOM element and gets plain colours (cursor.points below)
          if (s.points) s.points.stroke = s.stroke;
        }
        series.push(s);
      });
      var opts = {
        width: this.width, height: height, ms: 1,
        tzDate: function (ts) { return uPlot.tzDate(new Date(ts), vm.tz); },
        legend: { show: false },
        padding: [PAD.top, function () { return rec.pad.r; }, bottom && ta.visible ? PAD.bottom : PAD.top, function () { return rec.pad.l; }],
        cursor: {
          sync: { key: this.syncKey, scales: ['x', null], setSeries: false },
          drag: { x: false, y: false, setScale: false },
          bind: { dblclick: function () { return null; } },        // no uPlot autoscale on double-click
          // uPlot's defaults read the series points' stroke / fill, which is a canvas gradient for a pen with state
          // styles: the hover point is a DOM element and needs a CSS colour, so such a pen gets its pen colour
          points: {
            show: true, size: 6,
            stroke: function (u, si) { var sp = u.series[si].points, c = sp._stroke || sp._fill; return typeof c === 'string' ? c : self._penColorAt(rec, si); },
            fill: function (u, si) { var sp = u.series[si].points, c = sp._fill || sp._stroke; return typeof c === 'string' ? c : self._penColorAt(rec, si); },
          },
          focus: { prox: 16 },
          x: true, y: false,
        },
        focus: { alpha: 0.3 },
        select: { show: true },
        scales: scales, axes: axes, series: series,
        hooks: {
          drawClear: [function (u) { self._drawBackground(u, rec); }],
          draw: [function (u) { self._drawOverlays(u, rec); }],
          ready: [function () { self._scheduleAlign(); }],
          setSize: [function () { self._scheduleAlign(); }],
          setCursor: [function (u) { if (self._events.cursor.length) self._fire('cursor', u, rec); }],
        },
      };
      rec.data = this._data(rec);
      // first ranges before the first draw (the scales' range functions return them)
      pv.axes.forEach(function (ax) { rec.yr[ax.key] = self._yRange(rec, ax, rec.data, self.view); });
      rec.u = new uPlot(opts, rec.data, el);
      this.metrics.creates++;
      this._fire('create', rec);
      return rec;
    };
    PlotManager.prototype._destroyPlot = function (rec) {
      this._fire('destroy', rec);
      try { rec.u.destroy(); } catch (e) { /* ignore */ }
      if (rec.el && rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    };
    PlotManager.prototype.destroy = function () {
      this.destroyed = true;
      var self = this;
      this.plots.forEach(function (rec) { self._destroyPlot(rec); });
      this.plots = [];
      if (this._alignRaf) { this._alignRaf(); this._alignRaf = null; }
    };
    /** Hover on a pen-table row: dim the other series (uPlot focus); null clears. */
    PlotManager.prototype.focusPen = function (penKey) {
      this.plots.forEach(function (rec) {
        var k = penKey == null ? -1 : rec.pv.pens.map(function (p) { return p.key; }).indexOf(penKey);
        try { rec.u.setSeries(k >= 0 ? k + 1 : null, { focus: k >= 0 }); } catch (e) { /* ignore */ }
      });
    };
    PlotManager.prototype._drawBackground = function (u, rec) {
      var bg = rec.pv.background ? NS.props.color(rec.pv.background) : null;
      var b = u.bbox;
      if (bg) {
        u.ctx.save();
        u.ctx.fillStyle = bg;
        u.ctx.fillRect(b.left, b.top, b.width, b.height);
        u.ctx.restore();
      }
      this._drawBoolShading(u, rec);
    };
    /**
     * Boolean "on" shading (display.states.boolean.fillOpacity): the band between the pen's 0 and 1 levels
     * wherever its held value is on, drawn under the series (drawClear) so the line stays on top.
     */
    PlotManager.prototype._drawBoolShading = function (u, rec) {
      var self = this;
      var data = rec.data;
      if (!data || !data[0] || !data[0].length) return;
      var b = u.bbox;
      var ctx = u.ctx;
      rec.pv.pens.forEach(function (p, k) {
        var bs = p.states && p.states.bool;
        if (!bs || !(bs.fill > 0) || !p.visible || !data[k + 1] || !u.series[k + 1]) return;
        var runs = boolRuns(data[0], data[k + 1], self.view.min, self.view.max);
        if (!runs.length) return;
        var sk = u.series[k + 1].scale;
        var y1 = u.valToPos(1, sk, true), y0 = u.valToPos(0, sk, true);
        if (!isFinite(y0) || !isFinite(y1)) return;
        var top = Math.max(b.top, Math.min(y0, y1)), bottom = Math.min(b.top + b.height, Math.max(y0, y1));
        if (!(bottom > top)) return;
        ctx.save();
        ctx.fillStyle = withAlpha(bs.on || p.color, bs.fill);
        runs.forEach(function (r) {
          var x0 = Math.max(b.left, u.valToPos(r[0], 'x', true));
          var x1 = Math.min(b.left + b.width, u.valToPos(r[1], 'x', true));
          if (x1 - x0 >= 0.5) ctx.fillRect(x0, top, x1 - x0, bottom - top);
        });
        ctx.restore();
      });
    };
    /** The plain colour of series si of plot rec (CSS-safe: never a gradient). */
    PlotManager.prototype._penColorAt = function (rec, si) {
      var vm = rec.pv.pens[si - 1];
      return vm && vm.color ? vm.color : this.tokens.text;
    };
    /**
     * The stroke of a pen with an out-of-bounds or Boolean state style: a vertical gradient over the plot
     * area with hard stops at the high / low limit (outside = the state colour) or at the 0.5 threshold of a Boolean
     * (above = on colour, below = off colour). Evaluated by uPlot on every draw, so it follows the y range.
     */
    PlotManager.prototype._stateStroke = function (u, rec, si) {
      var vm = rec.pv.pens[si - 1];
      if (!vm) return this.tokens.text;
      var st = vm.states;
      var b = u.bbox;
      var sk = u.series[si] && u.series[si].scale;
      var stops = null;
      if (st && st.bool && sk) {
        var yt = u.valToPos(0.5, sk, true);
        stops = stateStops(b.top, b.height, yt, yt, st.bool.on || vm.color, null, st.bool.off || this.tokens.textMuted);
      } else if (st && st.oob && sk) {
        var yh = st.oob.high != null ? u.valToPos(st.oob.high, sk, true) : -Infinity;
        var yl = st.oob.low != null ? u.valToPos(st.oob.low, sk, true) : Infinity;
        var oc = st.oob.color || this.tokens.warn;
        stops = stateStops(b.top, b.height, yh, yl, oc, vm.color, oc);
      }
      if (!stops) return vm.color;
      var g = u.ctx.createLinearGradient(0, b.top, 0, b.top + b.height);
      for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
      return g;
    };
    PlotManager.prototype._drawOverlays = function (u, rec) {
      var self = this;
      var ctx = u.ctx;
      var b = u.bbox;
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.left, b.top, b.width, b.height);
      ctx.clip();
      try {
        this._drawMarkers(u, rec, ctx);
        this._drawStates(u, rec, ctx);
        this.overlays.forEach(function (fn) { try { fn(u, rec, ctx, self); } catch (e) { log.warn('overlay failed', e); } });
      } finally { ctx.restore(); }
    };
    /** plots[].markers: bands first, then lines; labels on the chosen side (canvas text only). */
    PlotManager.prototype._drawMarkers = function (u, rec, ctx) {
      var self = this;
      var ms = rec.pv.markers || [];
      if (!ms.length || !rec.pv.axes.length) return;
      var b = u.bbox;
      var pxr = u.pxRatio || W.devicePixelRatio || 1;
      var scaleOf = function (m) {
        var named = m.axis ? rec.pv.axes.filter(function (a) { return a.name === m.axis; })[0] : null;
        return (named || rec.pv.axes[0]).key;
      };
      var ordered = ms.filter(function (m) { return m.type === 'band'; }).concat(ms.filter(function (m) { return m.type !== 'band'; }));
      ordered.forEach(function (m) {
        var sk = scaleOf(m);
        var color = (m.color && NS.props.color(m.color)) || self.tokens.textMuted;
        var y1, y2;
        if (m.type === 'band') {
          y1 = u.valToPos(Math.max(m.min, m.max), sk, true);
          y2 = u.valToPos(Math.min(m.min, m.max), sk, true);
          if (!isFinite(y1) || !isFinite(y2)) return;
          ctx.fillStyle = withAlpha(color, m.opacity * 0.4);
          ctx.fillRect(b.left, y1, b.width, Math.max(1, y2 - y1));
        } else {
          y1 = u.valToPos(m.value, sk, true);
          if (!isFinite(y1)) return;
          ctx.strokeStyle = withAlpha(color, m.opacity);
          ctx.lineWidth = Math.max(1, m.width) * pxr;
          ctx.setLineDash((m.dash || []).map(function (x) { return x * pxr; }));
          ctx.beginPath(); ctx.moveTo(b.left, Math.round(y1) + 0.5); ctx.lineTo(b.left + b.width, Math.round(y1) + 0.5); ctx.stroke();
          ctx.setLineDash([]);
        }
        if (m.label && m.label.text) {
          ctx.font = Math.round((self.vm.fontSize) * pxr) + 'px ' + (self.tokens.font || 'sans-serif');
          ctx.fillStyle = color;
          // a line's label sits above it; a band's inside its top edge (above the band could be off the plot)
          ctx.textBaseline = m.type === 'band' ? 'top' : 'bottom';
          if (m.type === 'band') y1 += 4 * pxr;
          var right = m.label.position !== 'left';
          ctx.textAlign = right ? 'right' : 'left';
          ctx.fillText(m.label.text, right ? b.left + b.width - 4 * pxr : b.left + 4 * pxr, y1 - 2 * pxr);
        }
      });
    };
    /**
     * The pens' state styles drawn over the series (display.states):
     *   bad data   'hatch' (default): bad-quality runs (null samples) hatched in the state / pen colour at 35 %
     *              (like the Power Chart's fault overlay); 'hold': the last good value as a dashed line across each
     *              run; 'none'.
     *   outOfBounds with a width above the pen's: uPlot's stroke path of this draw is stroked again, wider, clipped
     *              to the bands beyond the limits (the gradient stroke already coloured those parts).
     */
    PlotManager.prototype._drawStates = function (u, rec, ctx) {
      var self = this;
      var b = u.bbox;
      var pxr = u.pxRatio || W.devicePixelRatio || 1;
      var data = rec.data;
      rec.pv.pens.forEach(function (p, k) {
        if (!p.visible) return;
        var st = p.states || DEFAULT_PEN_STATES;
        var si = k + 1;
        var style = st.bad ? st.bad.style : 'hatch';
        var runs = style === 'none' ? [] : self.engine.badRuns(p.key);
        if (runs.length) {
          var color = (st.bad && st.bad.color) || p.color;
          if (style === 'hold') {
            var sk = u.series[si] && u.series[si].scale;
            if (sk && data && data[si]) {
              ctx.save();
              ctx.strokeStyle = withAlpha(color, 0.85);
              ctx.lineWidth = Math.max(1, p.display.width) * pxr;
              ctx.setLineDash([5 * pxr, 4 * pxr]);
              runs.forEach(function (r) {
                if (r[1] < self.view.min || r[0] > self.view.max) return;
                var v = lastGoodBefore(data[0], data[si], r[0]);
                if (v == null) return;
                var y = u.valToPos(v, sk, true);
                var x0 = u.valToPos(Math.max(r[0], self.view.min), 'x', true);
                var x1 = u.valToPos(Math.min(r[1], self.view.max), 'x', true);
                if (!isFinite(y) || !(x1 - x0 >= 1)) return;
                ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
              });
              ctx.restore();
            }
          } else {
            var pat = hatchPattern(ctx, color, pxr);
            runs.forEach(function (r) {
              if (r[1] < self.view.min || r[0] > self.view.max) return;
              var hx0 = u.valToPos(Math.max(r[0], self.view.min), 'x', true);
              var hx1 = u.valToPos(Math.min(r[1], self.view.max), 'x', true);
              if (!(hx1 - hx0 >= 1)) return;
              ctx.fillStyle = pat;
              ctx.fillRect(hx0, b.top, hx1 - hx0, b.height);
            });
          }
        }
        var oob = st.oob;
        if (oob && oob.width > p.display.width) {
          var s = u.series[si];
          // uPlot keeps the Path2D it stroked for this draw on series._paths (1.6.x); without it nothing is widened
          var path = s && s._paths && s._paths.stroke;
          if (!path || typeof ctx.stroke !== 'function') return;
          var yh = oob.high != null ? u.valToPos(oob.high, s.scale, true) : null;
          var yl = oob.low != null ? u.valToPos(oob.low, s.scale, true) : null;
          ctx.save();
          ctx.beginPath();
          var any = false;
          if (yh != null && isFinite(yh) && yh > b.top) { ctx.rect(b.left, b.top, b.width, Math.min(b.height, yh - b.top)); any = true; }
          if (yl != null && isFinite(yl) && yl < b.top + b.height) { var yy = Math.max(b.top, yl); ctx.rect(b.left, yy, b.width, b.top + b.height - yy); any = true; }
          if (any) {
            ctx.clip();
            ctx.strokeStyle = oob.color || self.tokens.warn;
            ctx.lineWidth = oob.width * pxr;
            ctx.lineJoin = 'round';
            ctx.setLineDash((p.display.dash || []).map(function (x) { return x * pxr; }));
            ctx.stroke(path);
          }
          ctx.restore();
        }
      });
    };
    /** Lines the plot areas of stacked plots up (left and right edges). */
    PlotManager.prototype._scheduleAlign = function () {
      var self = this;
      if (this.plots.length < 2 || this._alignRaf) return;
      this._alignRaf = NS.util.nextFrame(function () { self._alignRaf = null; self._align(); });
    };
    PlotManager.prototype._align = function () {
      if (this.destroyed || this.plots.length < 2 || this._alignPasses >= 3) return;
      // intrinsic = axis space + the plot's own base padding; every plot is padded up to the widest
      var info = this.plots.map(function (rec) {
        var u = rec.u;
        var pxr = u.pxRatio || W.devicePixelRatio || 1;
        var b = u.bbox;
        return { l: b.left / pxr - rec.pad.l + rec.base.l, r: rec.w - (b.left + b.width) / pxr - rec.pad.r + rec.base.r };
      });
      var maxL = Math.max.apply(null, info.map(function (x) { return x.l; }));
      var maxR = Math.max.apply(null, info.map(function (x) { return x.r; }));
      var changed = false;
      this.plots.forEach(function (rec, i) {
        var wl = Math.round(rec.base.l + maxL - info[i].l), wr = Math.round(rec.base.r + maxR - info[i].r);
        if (Math.abs(wl - rec.pad.l) >= 1 || Math.abs(wr - rec.pad.r) >= 1) {
          rec.pad.l = wl; rec.pad.r = wr;
          changed = true;
          try { rec.u.redraw(false, true); } catch (e) { /* ignore */ }
        }
      });
      if (changed) this._alignPasses++;
    };
    /** Left edges of the plot areas in CSS px (for alignment checks). */
    PlotManager.prototype.plotRects = function () {
      return this.plots.map(function (rec) {
        var u = rec.u;
        var pxr = u.pxRatio || W.devicePixelRatio || 1;
        var b = u.bbox;
        return { index: rec.index, left: b.left / pxr, top: b.top / pxr, width: b.width / pxr, height: b.height / pxr, cssHeight: rec.h };
      });
    };

    /* ========================================================================
     * SECTION 14c / RangeSelector — the overview strip under the plots
     * ----------------------------------------------------------------------
     * Power Chart parity: the range-selector mini chart. One small uPlot
     * instance under the plots shows the chart's whole range (realtime: the
     * sliding configured window; historical: the configured start..end,
     * widened to the visible part when the user panned outside it) for the
     * visible pens (rangeSelector.pens 'all': every pen), each scaled to its
     * own minimum / maximum, from cheap aggregated data (SECTION 9c). The
     * visible part of the plots is a window on top of it:
     *   drag the window       pan              drag an edge handle   resize
     *   drag elsewhere        draw a new window
     *   click elsewhere       centre the window there
     *   wheel                 zoom the window around the pointer (panAndZoom.wheelZoom)
     *   double-click          reset zoom
     *   keyboard: the window and its two handles are sliders. ←/→ move 2 % of
     *   the range (Shift 10 %, PageUp/PageDown 10 %), Home/End go to the start /
     *   the end (End on the window = back to live), ↑/↓ or -/+ on the window
     *   widen / narrow it, Escape cancels a drag.
     * A drag previews through the chart's gesture preview (the plots move
     * with it, no React render per frame) and commits on release through the
     * same path as a plot gesture (engine viewport: follow-live rule, free-
     * range re-query, onRangeChange). Touch uses the same Pointer Events
     * (touch-action pan-y: the page still scrolls vertically over the strip;
     * the handles get a wider hit area on coarse pointers). Gestures are off
     * in Designer design mode (host.canInteract()), like the plots'.
     *
     * Data: fetched when the pen set, the configured window or the strip
     * width change, and while a realtime chart refreshes every
     * max(10 s, one strip bucket, refreshRate); never while the plots' own
     * full load runs (it waits for it). Between refreshes a realtime strip
     * slides with the plots and its right end is the plots' live data (the
     * samples after the overview's last bucket), so the line reaches now.
     * Shown in the narrow layout only with rangeSelector.narrowVisible, never
     * in very small charts; the More menu hides / shows it for the session.
     * DOM built with createElement only (no innerHTML).
     * ====================================================================== */
    var RS = {
      minRefreshMs: 10000,                 // realtime refresh floor
      retryMs: [3000, 10000, 30000, 60000],
      settleMs: 300,                       // debounce after a structural change (pens / window / width)
      waitLoadMs: 500,                     // re-check while the plots' full load runs
      axisPx: 16,                          // time labels under the strip
      handlePx: 8,
      stepFrac: 0.02, bigStepFrac: 0.1, zoomFactor: 1.25,
      maxPens: 16,                         // pens fetched for the strip
      boolBand: 0.25,                      // Boolean pens: a 0 / 1 track in the bottom quarter (they would hide the analogue pens)
      maxTail: 5000,                       // live samples appended per pen (realtime)
      tailEveryMs: 500,                    // the live tail is re-joined at most this often (renders come with every tick)
      guessMs: 200,                        // expected strip request time before one was measured
      afterTickMs: 100,                    // a deferred strip request starts this long after the plots' next tick
      clickSlopPx: 4, wheelIdleMs: 250, wheelBase: 1.2,
    };

    /**
     * The strip's time domain: realtime = the configured span ending now, historical = the configured window; both
     * widened to include the committed viewport (a view panned outside the window stays visible). null without a
     * window (nothing loaded yet).
     */
    /**
     * The part of a strip domain an overview request can ask for: the same rule as overviewPlan (the last
     * maxRangeDays of the domain, whole ms). A historical domain widened by a far pan can be longer than that.
     */
    function rsClampDomain(dom, L) {
      if (!dom) return null;
      var lim = L || effectiveLimits(null);
      var s = Math.floor(dom.start), e = Math.floor(dom.end);
      if (e - s > lim.maxRangeDays * DAY) s = e - lim.maxRangeDays * DAY;
      return { start: s, end: e };
    }
    /**
     * Historical strip: a new request is due when the domain left what the last request asked for (2 % of the
     * domain tolerance). Both sides are clamped by rsClampDomain, so a domain longer than maxRangeDays is due
     * once and not again until the asked-for part itself moves (compared with the answer's window instead, a
     * domain longer than 400 days could never be covered and the strip would refetch every 300 ms forever).
     */
    /*
     * Also due when the domain SHRANK (a far pan, then Reset zoom): the old answer covers it, but at the far
     * domain's resolution (a 3 h bucket for a 6 h window = a few rows). Due when the wanted span is under half of
     * the asked-for span, or when the data's planned bucket is more than 2x the bucket overviewPlan picks for the
     * current domain at `pointCount` px. The data's own plan is compared (data.planBucketMs, the bucket asked for),
     * not the gateway's answer, so an answer coarser than planned can never make every update due again; after the
     * refetch both sides are equal. realtime: only these two checks — its domain slides with now, and the periodic
     * refresh follows it — so a realtime strip is not left at a 3 h resolution until its next 3 h refresh.
     */
    function rsFetchDue(dom, data, L, pointCount, now, realtime) {
      if (!dom || !data) return false;
      var want = rsClampDomain(dom, L);
      var asked = data.req || data;
      var wSpan = want.end - want.start, aSpan = asked.end - asked.start;
      var tol = 0.02 * wSpan;
      if (!realtime && (want.start < asked.start - tol || want.end > asked.end + tol)) return true;   // panned outside
      if (aSpan > 0 && wSpan < 0.5 * aSpan) return true;                                              // shrunk
      var had = data.planBucketMs > 0 ? data.planBucketMs : data.bucketMs;
      if (pointCount > 0 && had > 0) {
        var plan = overviewPlan(want.start, want.end, pointCount, L, now);
        if (plan.bucketMs > 0 && had > 2 * plan.bucketMs) return true;                               // too coarse
      }
      return false;
    }
    function rsDomain(win, vp, now, realtime) {
      if (!win || !(win.span > 0 || win.end > win.start)) return null;
      var d = realtime ? { start: now - (win.span || (win.end - win.start)), end: now } : { start: win.start, end: win.end };
      if (vp && NS.util.isFiniteNum(vp.min) && NS.util.isFiniteNum(vp.max) && vp.max > vp.min) {
        d.start = Math.min(d.start, vp.min);
        d.end = Math.max(d.end, vp.max);
      }
      return d.end > d.start ? d : null;
    }
    /**
     * Each column scaled to its own [min, max] -> [0, 1] (flat columns sit at 0.5), so pens of very different ranges
     * share the strip; Boolean columns become a 0 / RS.boolBand track at the bottom. null (bad) and undefined (no
     * sample at that x) stay as they are.
     */
    function rsNormalize(ys, boolFlags) {
      return ys.map(function (col, c) {
        var lo = Infinity, hi = -Infinity, i;
        if (boolFlags && boolFlags[c]) { lo = 0; hi = 1; }
        else {
          for (i = 0; i < col.length; i++) {
            var v = col[i];
            if (typeof v === 'number' && isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
          }
        }
        var span = hi - lo;
        var out = new Array(col.length);
        for (i = 0; i < col.length; i++) {
          var x = col[i];
          if (typeof x !== 'number' || !isFinite(x)) out[i] = x;
          else if (boolFlags && boolFlags[c]) out[i] = (x >= 0.5 ? 1 : 0) * RS.boolBand;
          else out[i] = span > 0 ? (x - lo) / span : 0.5;
        }
        return out;
      });
    }
    /**
     * The view a strip gesture asks for (before the engine's clampView): 'win' moves v0 by tB - tA, 'start' / 'end'
     * move one edge to tB, 'new' spans tA..tB, 'center' centres v0's span on tB. Kept inside dom (a window wider than
     * the domain becomes the domain).
     */
    function rsDragView(kind, v0, tA, tB, dom) {
      var lo = dom.start, hi = dom.end, span = v0.max - v0.min;
      var a, b;
      var fit = function () {
        if (b - a >= hi - lo) { a = lo; b = hi; return; }
        if (a < lo) { b += lo - a; a = lo; }
        if (b > hi) { a -= b - hi; b = hi; }
      };
      switch (kind) {
        case 'win': a = v0.min + (tB - tA); b = v0.max + (tB - tA); fit(); break;
        case 'start': a = Math.max(lo, Math.min(tB, v0.max - 1)); b = v0.max; break;
        case 'end': a = v0.min; b = Math.min(hi, Math.max(tB, v0.min + 1)); break;
        case 'new': a = Math.max(lo, Math.min(tA, tB)); b = Math.min(hi, Math.max(tA, tB)); break;
        case 'center': a = tB - span / 2; b = a + span; fit(); break;
        default: return { min: v0.min, max: v0.max };
      }
      return { min: a, max: b };
    }
    /** The view a key on part 'win' | 'start' | 'end' asks for (null = not a key of that part). */
    function rsKeyView(part, key, shift, v, dom) {
      var span = dom.end - dom.start;
      if (!(span > 0)) return null;
      var k = part !== 'win' && key === 'ArrowUp' ? 'ArrowRight' : part !== 'win' && key === 'ArrowDown' ? 'ArrowLeft' : key;
      var step = (shift ? RS.bigStepFrac : RS.stepFrac) * span;
      var d = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : k === 'PageDown' ? -RS.bigStepFrac * span : k === 'PageUp' ? RS.bigStepFrac * span : 0;
      var w = v.max - v.min;
      if (part === 'win') {
        if (d) return rsDragView('win', v, 0, d, dom);
        if (k === 'Home') return { min: dom.start, max: dom.start + Math.min(w, span) };
        if (k === 'End') return { min: dom.end - Math.min(w, span), max: dom.end };
        var z = k === 'ArrowUp' || k === '-' ? RS.zoomFactor : k === 'ArrowDown' || k === '+' || k === '=' ? 1 / RS.zoomFactor : 0;
        if (!z) return null;
        var c = (v.min + v.max) / 2, nw = Math.min(span, w * z);
        return rsDragView('center', { min: c - nw / 2, max: c + nw / 2 }, 0, c, dom);
      }
      if (part === 'start') {
        if (d) return { min: Math.max(dom.start, Math.min(v.min + d, v.max - 1)), max: v.max };
        return k === 'Home' ? { min: dom.start, max: v.max } : null;
      }
      if (part === 'end') {
        if (d) return { min: v.min, max: Math.min(dom.end, Math.max(v.max + d, v.min + 1)) };
        return k === 'End' ? { min: v.min, max: dom.end } : null;
      }
      return null;
    }
    /** Strip time labels: one line, precision from the tick increment (and the date for multi-day ranges). */
    function rsTimeLabel(ms, incr, span, tz) {
      if (incr >= 28 * DAY) return NS.time.format(ms, 'YYYY-MM', tz);
      if (incr >= DAY) return NS.time.format(ms, 'MM-DD', tz);
      if (span > DAY) return NS.time.format(ms, 'MM-DD HH:mm', tz);
      return NS.time.format(ms, incr >= MINUTE ? 'HH:mm' : 'HH:mm:ss', tz);
    }

    function RangeSelector(host) {
      this.host = host;
      this.el = null;              // the React-owned strip container (no React children)
      this.u = null;               // uPlot instance
      this.sig = '';               // structural signature of this.u
      this.parts = null;           // {shadeL, shadeR, win, start, end, msg}
      this.pens = [];              // PenVMs drawn
      this.data = null;            // {sig, start, end, req: {start, end}, bucketMs, planBucketMs, fetchedAt, pens: {key: {t, v}}}
      this._dataSig = '';          // what the uPlot data was built from
      this.dom = null;             // the x domain drawn {start, end}
      this.pad = { l: PAD.bare, r: PAD.bare };
      this.timer = null;
      this.fetching = null;
      this.failures = 0;
      this.lastError = null;
      this._lastMs = 0;            // duration of the last strip request (ms, queue wait included)
      this._dirty = false;         // data set since the last draw (sync() draws it)
      this._deferred = false;      // the pending request was already moved behind a plot tick once
      this.g = null;               // running pointer gesture
      this.wheel = null;
      this._raf = 0;
      this._offs = [];
      this._place0 = '';
      this.disposed = false;
      this.metrics = { fetches: 0, builds: 0, frames: 0, frameMs: [], dataMs: [] };
    }
    /** The strip container element (React ref); a new element rebuilds the instance. */
    RangeSelector.prototype.setEl = function (el) {
      if (el === this.el) return;
      this._destroyPlot();
      this.el = el;
    };
    /** PenVMs drawn in the strip (rangeSelector.pens) and fetched (every pen with history, up to RS.maxPens). */
    RangeSelector.prototype._fetchPens = function () {
      return this.host.penVMs().filter(function (vm) { return vm.drawable && vm.status === 'ok'; }).slice(0, RS.maxPens);
    };
    RangeSelector.prototype._drawPens = function () {
      var all = this.host.reducedProps().rangeSelector.pens === 'all';
      return this._fetchPens().filter(function (vm) { return all || vm.visible; });
    };
    RangeSelector.prototype._domain = function () {
      var e = this.host.engine;
      if (!e) return null;
      return rsDomain(e.window, e.viewportGet(), e.gwNow(), e._realtime());
    };
    /** Identity of what the fetched data depends on (pens, window, mode, strip width in 50 px steps). */
    RangeSelector.prototype._fetchSig = function () {
      var e = this.host.engine;
      if (!e || !e.window) return '';
      var p = this.host.reducedProps();
      var rt = e._realtime();
      return stableJson([this._fetchPens().map(function (vm) { return [vm.key, vm.tagPath, vm.aggregation]; }), rt ? 'rt' : 'hist',
        rt ? Math.round(e.window.span / SECOND) : [e.window.start, e.window.end], Math.round(this._width() / 50), p.query.aggregation]);
    };
    /** Plot-area width of the strip in CSS px (the request's point count). */
    RangeSelector.prototype._width = function () {
      if (this.u) {
        var pxr = this.u.pxRatio || W.devicePixelRatio || 1;
        if (this.u.bbox.width > 0) return this.u.bbox.width / pxr;
      }
      var w = this.el ? this.el.clientWidth : 0;
      return Math.max(0, w - this.pad.l - this.pad.r);
    };

    // ---- lifecycle ----------------------------------------------------------------------------------------
    /** After every chart render (and resize): visibility, data plan, structure, data, window position. */
    RangeSelector.prototype.update = function () {
      if (this.disposed) return;
      var host = this.host;
      if (!this.el || !host.engine || !W.uPlot || !host.rangeSelectorShown()) { this._destroyPlot(); this._clearTimer(); return; }
      var w = this.el.clientWidth, hgt = this.el.clientHeight;
      if (!(w > 0) || !(hgt > 0)) return;
      try {
        this._planFetch();
        this.pens = this._drawPens();
        this._build(w, hgt);
        this._setData(false);
        this.sync();
      } catch (e) {
        log.warn('range selector failed', e && e.message);
        this._destroyPlot();
      }
    };
    /** Live slide frame (realtime, following live): the domain moves with now; the live tail joins the line. */
    RangeSelector.prototype.slide = function () {
      if (!this.u || this.disposed) return;
      try {
        this._setData(false);
        this.sync();
      } catch (e) { log.warn('range selector slide failed', e && e.message); }
    };
    RangeSelector.prototype.destroy = function () {
      this.disposed = true;
      this._clearTimer();
      this.fetching = null;
      this._destroyPlot();
      this.el = null;
    };
    RangeSelector.prototype._clearTimer = function () {
      if (this.timer != null) { clearTimeout(this.timer); this.timer = null; }
    };
    RangeSelector.prototype._schedule = function (ms) {
      var self = this;
      this._clearTimer();
      this.timer = setTimeout(function () { self.timer = null; self._fetch(); }, Math.max(0, ms));
    };
    RangeSelector.prototype._destroyPlot = function () {
      if (this._raf) { cancelRaf(this._raf); this._raf = 0; }
      if (this.wheel) { clearTimeout(this.wheel.timer); this.wheel = null; }
      if (this.g) { this.g = null; this.host.clearPreview(); }
      this._offs.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
      this._offs = [];
      if (this.u) { try { this.u.destroy(); } catch (e) { /* ignore */ } }
      this.u = null;
      this.parts = null;
      this.sig = '';
      this._dataSig = '';
      this._dataBase = '';
      this._place0 = '';
    };

    // ---- data ---------------------------------------------------------------------------------------------
    /** Starts a fetch when the data no longer fits (debounced), or the next realtime refresh. Never during a fetch. */
    RangeSelector.prototype._planFetch = function () {
      var sig = this._fetchSig();
      if (!sig || this.fetching) return;
      var d = this.data;
      var due = !d || d.sig !== sig;
      var e = this.host.engine;
      if (!due && rsFetchDue(this._domain(), d, e.L, this._width(), e.gwNow(), e._realtime())) due = true;   // panned outside, shrunk or too coarse
      if (due) { if (this._due !== sig || this.timer == null) { this._due = sig; this._schedule(d ? RS.settleMs : 0); } }
      else if (this.timer == null) this._scheduleRefresh();
    };
    RangeSelector.prototype._scheduleRefresh = function () {
      var e = this.host.engine;
      var p = this.host.reducedProps();
      if (!e || !e._realtime() || !(p.timeRange.refreshRate > 0) || !this.data) return;
      var every = Math.max(RS.minRefreshMs, this.data.bucketMs || 0, p.timeRange.refreshRate);
      this._schedule(Math.max(0, every - (Date.now() - this.data.fetchedAt)));
    };
    RangeSelector.prototype._fetch = function () {
      var self = this;
      var host = this.host, e = host.engine;
      if (this.disposed || !e || !this.el || !host.rangeSelectorShown()) return;
      if (this.fetching) return;
      if (!e.loadedOnce || e._fullLoadActive()) { this._schedule(RS.waitLoadMs); return; }    // the plots first
      if (typeof document !== 'undefined' && document.hidden) { this._schedule(RS.minRefreshMs); return; }
      var dom = this._domain();
      var sig = this._fetchSig();
      if (!dom || !sig) return;
      // Realtime: each strip batch runs alone in the page queue (SECTION 6), so a strip sent just before a plot tick
      // holds that tick back until its batch ends. Unless there is time for it before the next tick, it starts
      // just after that tick instead. Deferred at most once per request: with a refresh rate close to the request
      // time no gap is long enough, and the tick then waits once per strip refresh.
      var p = host.reducedProps();
      if (!this._deferred && e._realtime() && p.timeRange.refreshRate > 0 && e._nextTickAt != null) {
        var gap = e._nextTickAt - Date.now();
        var guard = Math.min(p.timeRange.refreshRate / 2, (this._lastMs || RS.guessMs) * 1.5 + 100);
        if (gap < guard) { this._deferred = true; this._schedule(Math.max(0, gap) + RS.afterTickMs); return; }
      }
      this._deferred = false;
      var keys = this._fetchPens().map(function (vm) { return vm.key; });
      var my = this.fetching = { sig: sig };
      var t0 = Date.now();
      var width = this._width();
      var planBucketMs = overviewPlan(dom.start, dom.end, width, e.L, e.gwNow()).bucketMs;   // what this request asks for (rsFetchDue)
      e.fetchOverview({ start: dom.start, end: dom.end, pointCount: width, penKeys: keys }).then(function (r) {
        if (self.disposed || self.fetching !== my) return;
        self.fetching = null;
        if (r.ok) {
          self._lastMs = Date.now() - t0;
          self.failures = 0;
          self.lastError = null;
          var pens = {};
          (r.pens || []).forEach(function (pp) { if (pp.status === 'ok') pens[pp.key] = { t: pp.t, v: pp.v }; });
          self.data = { sig: sig, start: r.window ? r.window.start : dom.start, end: r.window ? r.window.end : dom.end,
            req: rsClampDomain(dom, e.L), bucketMs: r.window ? r.window.bucketMs : null, planBucketMs: planBucketMs, fetchedAt: Date.now(), pens: pens };
          self.metrics.fetches++;
        } else if (r.code === 'ABORTED' || r.code === 'DETACHED') {
          return;
        } else {
          self.failures++;
          self.lastError = r.code || 'error';
          self._schedule(Math.max(RS.retryMs[Math.min(self.failures - 1, RS.retryMs.length - 1)], r.retryAfterMs || 0));
        }
        self.update();
      }).then(null, function (err) {
        // never stuck as 'fetching': a throw while applying the answer clears it and retries like a failed request
        log.warn('range selector update failed', err && err.message);
        if (self.disposed) return;
        if (self.fetching === my) self.fetching = null;
        self.failures++;
        self.lastError = 'INTERNAL';
        self._schedule(RS.retryMs[Math.min(self.failures - 1, RS.retryMs.length - 1)]);
      });
    };
    /**
     * uPlot data: per drawn pen its overview rows, plus (realtime) the plots' live samples after the last overview
     * row; joined (k-way merge, SECTION 4) and scaled per pen. Rebuilt only when its inputs changed.
     */
    RangeSelector.prototype._setData = function (force) {
      var u = this.u;
      if (!u) return;
      var e = this.host.engine;
      var rt = e._realtime();
      var d = this.data;
      var keys = this.pens.map(function (vm) { return vm.key; });
      var base = [d ? d.fetchedAt : 0, keys.join('|')].join('/');
      var sig = base + '/' + (rt ? e._rev : 0);
      if (!force && sig === this._dataSig) return;
      // only the live tail moved: re-joined at most every RS.tailEveryMs (a render comes with every engine change)
      var nowMs = Date.now();
      if (!force && rt && this._dataBase === base && nowMs - (this._dataAt || 0) < RS.tailEveryMs) return;
      var t0 = perfNow();
      this._dataSig = sig;
      this._dataBase = base;
      this._dataAt = nowMs;
      var views = this.pens.map(function (vm) {
        var base = d && d.pens[vm.key] ? d.pens[vm.key] : { t: [], v: [] };
        if (!rt) return base;
        var pv = e.penView(vm.key, true);
        var last = base.t.length ? base.t[base.t.length - 1] : -Infinity;
        var from = Math.max(upperBound(pv.t, last), pv.t.length - RS.maxTail);
        if (from >= pv.t.length) return base;
        return { t: base.t.concat(pv.t.slice(from)), v: base.v.concat(pv.v.slice(from)) };
      });
      var j = joinViews(views);
      var ys = rsNormalize(j.ys, this.pens.map(function (vm) { return vm.isBool; }));
      // setData(…, false) keeps the x scale (sync() owns it) but does not draw by itself (uPlot 1.6 commits only on
      // a scale change): sync() draws it, with its own x change or with a redraw when the x scale stays the same
      u.setData([j.x].concat(ys), false);
      this._dirty = true;
      if (this.parts) this._msg();
      perfPush(this.metrics.dataMs, perfNow() - t0);
    };

    // ---- structure ------------------------------------------------------------------------------------------
    RangeSelector.prototype._build = function (w, hgt) {
      var self = this;
      var host = this.host;
      var vm = host._vm;
      var tz = host.engine.timeZone || (vm && vm.tz) || null;
      var sig = stableJson([this.pens.map(function (p) { return [p.key, p.color, p.isBool, p.interp]; }), hgt, tz, NS.theme.scheme()]);
      if (this.u && sig === this.sig) {
        if (Math.abs(this.u.width - w) >= 1 || Math.abs(this.u.height - hgt) >= 1) this.u.setSize({ width: w, height: hgt });
        return;
      }
      this._destroyPlot();
      var uPlot = W.uPlot;
      var tokens = function () { return host._tokens || NS.theme.tokens(); };
      var font = '10px ' + (tokens().font || 'sans-serif');
      var series = [{}];
      this.pens.forEach(function (p) {
        var s = { scale: 'y', stroke: withAlpha(p.color, p.isBool ? 0.6 : 0.9), width: 1, fill: p.isBool ? undefined : withAlpha(p.color, 0.06),
          spanGaps: false, points: { show: false } };
        if (p.isBool || p.interp === 'stepAfter') s.paths = uPlot.paths.stepped({ align: 1 });
        else if (p.interp === 'stepBefore') s.paths = uPlot.paths.stepped({ align: -1 });
        series.push(s);
      });
      var dom0 = this._domain() || { start: 0, end: 1 };
      this.dom = dom0;
      var opts = {
        width: w, height: hgt, ms: 1,
        tzDate: function (ts) { return uPlot.tzDate(new Date(ts), tz); },
        legend: { show: false },
        cursor: { show: false, x: false, y: false, points: { show: false }, drag: { x: false, y: false, setScale: false },
          bind: { dblclick: function () { return null; } } },
        select: { show: false },
        padding: [3, function () { return self.pad.r; }, 0, function () { return self.pad.l; }],
        scales: {
          x: { time: true, auto: false, range: function (u, mn, mx) { return mn == null || mx == null ? [self.dom.start, self.dom.end] : [mn, mx]; } },
          y: { auto: false, range: function () { return [-0.1, 1.1]; } },
        },
        axes: [{
          scale: 'x', side: 2, size: RS.axisPx, font: font, gap: 2, space: 84,
          stroke: function () { return tokens().textMuted; },
          ticks: { show: false },
          grid: { show: true, stroke: function () { return withAlpha(tokens().text, 0.1); }, width: 1 },
          values: function (u, splits, ai, space, incr) {
            var span = self.dom ? self.dom.end - self.dom.start : 0;
            return splits.map(function (ms) { return ms == null ? '' : rsTimeLabel(ms, incr, span, tz); });
          },
        }, { scale: 'y', show: false }],
        series: series,
        hooks: {
          drawClear: [function (u) {
            var b = u.bbox;
            u.ctx.save();
            u.ctx.fillStyle = withAlpha(tokens().surface2, 0.6);
            u.ctx.fillRect(b.left, b.top, b.width, b.height);
            u.ctx.restore();
          }],
        },
      };
      var empty = [[]].concat(this.pens.map(function () { return []; }));
      this.u = new uPlot(opts, empty, this.el);
      this.sig = sig;
      this.metrics.builds++;
      this._buildParts();
    };
    /** The window, its two handles, the shades and the message line, inside u.over (DOM, text nodes only). */
    RangeSelector.prototype._buildParts = function () {
      var self = this;
      var over = this.u.over;
      var mk = function (cls, attrs) {
        var el = document.createElement('div');
        el.className = cls;
        Object.keys(attrs || {}).forEach(function (k) { el.setAttribute(k, attrs[k]); });
        over.appendChild(el);
        return el;
      };
      var shadeL = mk('ctg-rs__shade', { 'aria-hidden': 'true' });
      var shadeR = mk('ctg-rs__shade', { 'aria-hidden': 'true' });
      var win = mk('ctg-rs__win', { role: 'slider', 'data-rs': 'win', 'data-ctg': 'rs-window', 'aria-label': NS.i18n.t('chart.rs.window') });
      var start = mk('ctg-rs__handle', { role: 'slider', 'data-rs': 'start', 'data-ctg': 'rs-start', 'aria-label': NS.i18n.t('chart.rs.start') });
      var end = mk('ctg-rs__handle', { role: 'slider', 'data-rs': 'end', 'data-ctg': 'rs-end', 'aria-label': NS.i18n.t('chart.rs.end') });
      var msg = mk('ctg-rs__msg', { 'aria-hidden': 'true' });
      [win, start, end].forEach(function (el) { el.setAttribute('aria-describedby', self.host._rsHelpId); });
      this.parts = { shadeL: shadeL, shadeR: shadeR, win: win, start: start, end: end, msg: msg };
      over.style.touchAction = 'pan-y';
      var on = function (el, type, fn, opt) {
        el.addEventListener(type, fn, opt);
        self._offs.push(function () { el.removeEventListener(type, fn, opt); });
      };
      on(over, 'pointerdown', function (e) { self._down(e); });
      on(over, 'pointermove', function (e) { self._move(e); });
      on(over, 'pointerup', function (e) { self._up(e); });
      on(over, 'pointercancel', function (e) { self._cancel(e); });
      on(over, 'lostpointercapture', function (e) { if (self.g && self.g.id === e.pointerId) self._cancel(e); });
      on(over, 'wheel', function (e) { self._wheel(e); }, { passive: false });
      on(over, 'dblclick', function (e) { if (self.host.canInteract()) { e.preventDefault(); self.host.resetZoom(); } });
      [['win', win], ['start', start], ['end', end]].forEach(function (pe) {
        on(pe[1], 'keydown', function (e) { self._key(pe[0], e); });
      });
      this._interactive();
      this._msg();
    };
    /** Focusable sliders only where gestures are allowed (not in Designer design mode). */
    RangeSelector.prototype._interactive = function () {
      if (!this.parts) return;
      var ok = this.host.canInteract();
      if (this.parts.ok === ok) return;              // DOM writes only when it changes (sync runs per gesture frame)
      this.parts.ok = ok;
      var parts = this.parts;
      [parts.win, parts.start, parts.end].forEach(function (el) {
        el.tabIndex = ok ? 0 : -1;
        if (ok) el.removeAttribute('aria-disabled'); else el.setAttribute('aria-disabled', 'true');
      });
      if (this.el) this.el.classList.toggle('ctg-rs--off', !ok);
    };
    /** "No data" / "Overview unavailable (CODE)" inside the strip while there is nothing to draw. */
    RangeSelector.prototype._msg = function () {
      var m = this.parts && this.parts.msg;
      if (!m) return;
      var has = this.u && this.u.data && this.u.data[0] && this.u.data[0].length > 0;
      var text = has ? '' : this.lastError ? NS.i18n.t('chart.rs.unavailable', { code: this.lastError }) : '';
      if (m.textContent !== text) m.textContent = text;
    };

    // ---- geometry -------------------------------------------------------------------------------------------
    /** Moves the x domain to now (realtime), lines the plot area up with the plots', places the window. */
    RangeSelector.prototype.sync = function () {
      var u = this.u;
      if (!u || this.disposed) return;
      var host = this.host;
      var dom = this.g ? this.g.dom : this._domain();
      if (!dom) return;
      // the domain slides with now: a new x scale (= a strip redraw) only once it moved by half a pixel or more
      var px = Math.max(1, (dom.end - dom.start) / Math.max(1, this._width()));
      var changed = !this.dom || Math.abs(this.dom.start - dom.start) >= px / 2 || Math.abs(this.dom.end - dom.end) >= px / 2;
      if (changed || this.g) this.dom = dom;
      else dom = this.dom;
      var padChanged = this._alignPads();
      if (padChanged) u.redraw(false, true);
      if (changed || padChanged) u.setScale('x', { min: dom.start, max: dom.end });
      else if (this._dirty) u.redraw();               // new data on an unchanged x scale (historical, static window)
      this._dirty = false;
      this._interactive();
      this._place(host.currentView());
    };
    /** Strip paddings = the plots' left / right margins, so a time sits at the same x in the strip and the plots. */
    RangeSelector.prototype._alignPads = function () {
      var pm = this.host.pm;
      var rects = pm && pm.plots.length ? pm.plotRects() : null;
      var l = PAD.bare, r = PAD.bare;
      if (rects && rects[0] && rects[0].width > 0) {
        l = Math.max(0, Math.round(rects[0].left));
        r = Math.max(0, Math.round(pm.width - rects[0].left - rects[0].width));
      }
      if (Math.abs(l - this.pad.l) < 1 && Math.abs(r - this.pad.r) < 1) return false;
      this.pad.l = l; this.pad.r = r;
      return true;
    };
    /** Window, handles and shades for view v (CSS px inside u.over); ARIA values follow. */
    RangeSelector.prototype._place = function (v) {
      var u = this.u, parts = this.parts;
      if (!u || !parts || !v || !NS.util.isFiniteNum(v.min) || !NS.util.isFiniteNum(v.max)) return;
      var w = u.over.clientWidth || 0;
      var x0 = NS.util.clamp(u.valToPos(v.min, 'x'), 0, w), x1 = NS.util.clamp(u.valToPos(v.max, 'x'), 0, w);
      if (!isFinite(x0) || !isFinite(x1)) return;
      if (x1 - x0 < 2) { var mid = (x0 + x1) / 2; x0 = Math.max(0, mid - 1); x1 = Math.min(w, mid + 1); }
      var key = [Math.round(x0 * 2), Math.round(x1 * 2), Math.round(w)].join(',');
      if (key !== this._place0) {
        this._place0 = key;
        parts.shadeL.style.width = Math.max(0, x0) + 'px';
        parts.shadeR.style.transform = 'translateX(' + x1 + 'px)';
        parts.shadeR.style.width = Math.max(0, w - x1) + 'px';
        parts.win.style.transform = 'translateX(' + x0 + 'px)';
        parts.win.style.width = (x1 - x0) + 'px';
        parts.start.style.transform = 'translate(' + (x0 - RS.handlePx / 2) + 'px,-50%)';
        parts.end.style.transform = 'translate(' + (x1 - RS.handlePx / 2) + 'px,-50%)';
      }
      var tz = this.host.engine ? this.host.engine.timeZone : null;
      var pat = 'YYYY-MM-DD HH:mm:ss';
      var from = NS.time.format(v.min, pat, tz), to = NS.time.format(v.max, pat, tz);
      var dom = this.dom || { start: v.min, end: v.max };
      var set = function (el, now, min, max, text) {
        var vals = [String(Math.round(now)), String(Math.round(min)), String(Math.round(max)), text];
        if (el._ctgAria === vals.join('|')) return;
        el._ctgAria = vals.join('|');
        el.setAttribute('aria-valuenow', vals[0]);
        el.setAttribute('aria-valuemin', vals[1]);
        el.setAttribute('aria-valuemax', vals[2]);
        el.setAttribute('aria-valuetext', text);
      };
      set(parts.win, v.min, dom.start, Math.max(dom.start, dom.end - (v.max - v.min)), from + ' – ' + to);
      set(parts.start, v.min, dom.start, v.max, from);
      set(parts.end, v.max, v.min, dom.end, to);
      if (this.el) this.el.setAttribute('aria-label', NS.i18n.t('chart.rs.label', { from: NS.time.format(dom.start, 'YYYY-MM-DD HH:mm', tz),
        to: NS.time.format(dom.end, 'YYYY-MM-DD HH:mm', tz) }));
    };
    RangeSelector.prototype._pos = function (e) {
      var r = this.u.over.getBoundingClientRect();
      return { x: e.clientX - r.left, w: Math.max(1, r.width) };
    };
    RangeSelector.prototype._timeAt = function (x, w, dom) {
      var d = dom || this.dom;
      return d.start + NS.util.clamp(x / w, 0, 1) * (d.end - d.start);
    };

    // ---- pointer, wheel, keyboard ---------------------------------------------------------------------------
    RangeSelector.prototype._down = function (e) {
      if (!this.host.canInteract() || this.g || !this.dom) return;
      if ((e.pointerType || 'mouse') === 'mouse' && e.button !== 0) return;
      var part = e.target && e.target.getAttribute ? e.target.getAttribute('data-rs') : null;
      var p = this._pos(e);
      var v = this.host.currentView();
      this.g = { id: e.pointerId, part: part, x0: p.x, x: p.x, w: p.w, v0: { min: v.min, max: v.max },
        dom: { start: this.dom.start, end: this.dom.end }, moved: false, type: e.pointerType || 'mouse' };
      try { this.u.over.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      var focusEl = part && this.parts ? this.parts[part] : null;
      if (focusEl) { try { focusEl.focus({ preventScroll: true }); } catch (err) { /* ignore */ } }
      e.preventDefault();
    };
    RangeSelector.prototype._move = function (e) {
      var g = this.g;
      if (!g || e.pointerId !== g.id) return;
      g.x = this._pos(e).x;
      if (!g.moved && Math.abs(g.x - g.x0) >= RS.clickSlopPx) g.moved = true;
      if (g.moved) this._frameSoon();
    };
    RangeSelector.prototype._frameSoon = function () {
      var self = this;
      if (this._raf) return;
      this._raf = raf(function () { self._raf = 0; self._frame(); });
    };
    /** One preview per animation frame for the running drag. */
    RangeSelector.prototype._frame = function () {
      var g = this.g;
      var e = this.host.engine;
      if (!g || !e || this.disposed) return;
      var t0 = perfNow();
      var tA = this._timeAt(g.x0, g.w, g.dom), tB = this._timeAt(g.x, g.w, g.dom);
      var kind = g.part === 'win' || g.part === 'start' || g.part === 'end' ? g.part : 'new';
      this.host.previewView(e.clampView(rsDragView(kind, g.v0, tA, tB, g.dom)));
      this.metrics.frames++;
      perfPush(this.metrics.frameMs, perfNow() - t0);
    };
    RangeSelector.prototype._up = function (e) {
      var g = this.g;
      if (!g || e.pointerId !== g.id) return;
      try { this.u.over.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (this._raf) { cancelRaf(this._raf); this._raf = 0; }
      g.x = this._pos(e).x;
      if (!g.moved && Math.abs(g.x - g.x0) >= RS.clickSlopPx) g.moved = true;
      if (g.moved) this._frame();
      this.g = null;
      var host = this.host;
      if (g.moved) {
        var pv = host.ix && host.ix.preview;
        if (pv) host.commitView(pv); else host.clearPreview();
      } else if (!g.part && host.engine) {
        // a click beside the window centres it there
        host.commitView(host.engine.clampView(rsDragView('center', g.v0, 0, this._timeAt(g.x0, g.w, g.dom), g.dom)));
      }
      this.sync();
    };
    RangeSelector.prototype._cancel = function () {
      if (!this.g) return;
      this.g = null;
      if (this._raf) { cancelRaf(this._raf); this._raf = 0; }
      this.host.clearPreview();
      this.sync();
    };
    RangeSelector.prototype._wheel = function (e) {
      var host = this.host;
      if (!host.canInteract() || !host.reducedProps().interaction.panAndZoom.wheelZoom || !this.dom || this.g) return;
      e.preventDefault();
      var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      if (!dy) return;
      var self = this;
      var v = this.wheel ? this.wheel.view : host.currentView();
      var f = this._timeAt(this._pos(e).x, this._pos(e).w);
      var k = Math.pow(RS.wheelBase, dy / 100);
      var nv = host.engine.clampView({ min: f - (f - v.min) * k, max: f + (v.max - f) * k, focal: f });
      if (this.wheel) clearTimeout(this.wheel.timer);
      this.wheel = { view: nv, timer: setTimeout(function () {
        var w = self.wheel;
        self.wheel = null;
        if (!self.disposed && w && !self.g) host.commitView(w.view);
      }, RS.wheelIdleMs) };
      host.previewView(nv);
    };
    RangeSelector.prototype._key = function (part, ev) {
      var host = this.host;
      if (!host.canInteract() || !host.engine || !this.dom) return;
      if (ev.key === 'Escape' || ev.key === 'Esc') { if (this.g) { ev.preventDefault(); this._cancel(); } return; }
      if (this.g) return;
      var nv = rsKeyView(part, ev.key, ev.shiftKey, host.currentView(), this.dom);
      if (!nv) return;
      ev.preventDefault();
      ev.stopPropagation();
      host.commitView(host.engine.clampView(nv));
    };

    /* ========================================================================
     * SECTION 15 / ChartApi — the frozen facade for panels
     * ----------------------------------------------------------------------
     * ctg-chart-tools.js, ctg-chart-panels.js and the interaction layer's
     * panel hooks use ONLY this object; it is FROZEN (members are added,
     * never changed or removed). tests/js/_chartApiStub.mjs implements every
     * member over fixture data (same shapes) and tests/js/chart-api.test.mjs
     * checks both against CHART_API_MEMBERS.
     *
     *   api.id                                    chart instance id (string)
     *   api.props()                               frozen reduced props (reduceProps)
     *   api.write(rootKey, wholeValue)            -> boolean. Whole-object write of ONE root prop
     *                                             (store.props.write); never nested paths (missing
     *                                             intermediates throw in the property tree). Refused (false):
     *                                             Designer design mode, unknown keys, gateway security
     *                                             keys (enabled, trendGroup, trendEdit, readScope,
     *                                             tagBrowser, annotations — the gateway would revert them
     *                                             and log prop-tamper) and outputs (chart-owned). The
     *                                             chart's own echo of the write is not reprocessed.
     *   api.patch(rootKey, fn | partialObject)    -> boolean (the one addition after the freeze).
     *                                             A whole-object write built from the RAW prop value (the
     *                                             property tree as configured), never from the reduced
     *                                             props: keys the reducer does not know (a pen's custom
     *                                             field) survive, and defaults / clamps of untouched fields
     *                                             are not persisted into the view. fn(raw, reduced) gets a
     *                                             private deep copy of the raw root (Dates kept; the reduced
     *                                             copy of it when the raw value is missing or of the wrong
     *                                             kind) and the frozen reduced root (array items carry their
     *                                             raw position as the non-enumerable `index`); it returns the
     *                                             new root or undefined (= the mutated copy). A plain object
     *                                             is deep-merged into an object root (plain objects merge,
     *                                             everything else replaces). Nothing is written when the
     *                                             result equals the raw value (true). Same refusals as write;
     *                                             a throwing fn -> false.
     *   api.pens()                                -> PenVM[] {key, source:'pens'|'trend', index|null, tagPath,
     *                                             label, color, visible, axisKey, plot, units, format,
     *                                             display, status, meta, trendable} (+ isBool, shared,
     *                                             axisMissing, approx, downgraded, incomplete) in gateway order
     *   api.penInfo(key)                          -> the gateway PenInfo of that pen key, or null
     *   api.axesInUse()                           -> [{key, name|null, auto, side, plot, units}] (units: string)
     *   api.limits()                              -> effective chart.snapshot.limits (defaults filled in)
     *   api.timeZone()                            -> resolved IANA zone of the chart (timeAxis.timeZone)
     *   api.now()                                 -> gateway time in ms (NS.clock; "Now" buttons)
     *   api.status()                              -> {state, mode, staleSince, loading, lastUpdate, window,
     *                                             coverage, banner} (copies)
     *   api.viewport.get() / set({min, max}) / reset()   -> {min, max, followLive, span}
     *   api.request(name, body, {timeoutMs})      -> Promise<{ok, data|error}>; allow-list chart.browse,
     *                                             chart.trendAdd, chart.trendRemove, chart.trendClear,
     *                                             chart.annotationSave, chart.annotationDelete; anything
     *                                             else resolves {ok:false, error:{code:'NOT_ALLOWED'}}
     *   api.history.fetchRaw({start, end, penKeys, onProgress, signal})
     *                                             -> Promise<{pens:[{key, t, v, status, downgraded, anchor}],
     *                                             downgraded, window, error?}> (queue priority 'user'; signal =
     *                                             AbortSignal; a real pointCount for the aggregate
     *                                             fallback, window.downgraded copied onto every pen)
     *   api.series.rows({source:'visible'|'loaded', layout:'wide'|'tall', penKeys?, includeQuality?})
     *                                             -> {header:string[], rows:any[][]}: real samples only (no
     *                                             synthetic "now" point), epoch-ms times in draw time,
     *                                             wide = k-way merge ('' where a pen has no sample), tall =
     *                                             [time, label, value]; null = bad quality. Default pens:
     *                                             the shown pens with data
     *   api.plots.snapshot({scale, includeLegend}) -> HTMLCanvasElement (title, plots, legend) or null
     *   api.tokens()                              -> NS.theme.tokens(root)
     *   api.capabilities()                        -> {enabled, designMode, designer, nativeApp, deviceType, user,
     *                                             tagBrowser:{allowed, reason}, trendEdit:{allowed, reason},
     *                                             readScope:{runtimePensAllowed, roots}, annotations:{allowed,
     *                                             editAllowed, moderateAllowed, reason}, settingsPanel:{enabled,
     *                                             tabs}, export:{csv, png}}; user: the session user's
     *                                             name from the last ctg.welcome (null before it) — panels
     *                                             key user-specific state (the tag browser's tree) by it
     *   api.panels.open(name, args) / close(name) / isOpen(name)
     *   api.fireEvent(name, payload)              -> boolean; onPensChange | onRangeChange | onBrushChange |
     *                                             onXTraceChange only, flat payloads, no-op unless events
     *                                             are enabled (NS.events)
     *   api.onChange(cb) -> dispose               cb({props, pens, viewport, capabilities}: booleans) after
     *                                             props / pens / viewport state / capabilities changed,
     *                                             rAF-coalesced (the live slide alone is not a change)
     *   api.t(key, vars, part)                    NS.i18n.t (part = the caller's string table)
     *
     * Panel registry (NS.chart.panels): register(name, def) with
     *   def.render(api, args, close) -> React element | null   (called on every chart render while open)
     *   def.dock: 'left' | 'right' | 'none' (default)  where the chart mounts it: a side column next to
     *             the plot area, or at the end of the chart root (modals / popovers portal themselves)
     *   def.button: {label, icon?, title?, order?} optional toolbar button (toggles the panel). The chart
     *             names the built-in slots: 'tagBrowser' (Tags button, left), 'dateRange' (the date pill),
     *             'settings', 'export' (right group); other names with a `button` go to the right group.
     *             Visibility rules of the built-in slots (toolbar.buttons.*, capabilities) stay the chart's.
     * Panel names in use: dateRange, color, export (ctg-chart-tools.js); settings, tagBrowser, annotation
     * (ctg-chart-panels.js). api.panels.open is a no-op in Designer design mode.
     * ====================================================================== */
    var CHART_API_MEMBERS = ['id', 'props', 'write', 'patch', 'pens', 'penInfo', 'axesInUse', 'limits', 'timeZone', 'now', 'status',
      'viewport.get', 'viewport.set', 'viewport.reset', 'request', 'history.fetchRaw', 'series.rows', 'plots.snapshot',
      'tokens', 'capabilities', 'panels.open', 'panels.close', 'panels.isOpen', 'fireEvent', 'onChange', 't'];
    var API_REQUESTS = { 'chart.browse': true, 'chart.trendAdd': true, 'chart.trendRemove': true, 'chart.trendClear': true,
      'chart.annotationSave': true, 'chart.annotationDelete': true };
    var API_EVENTS = { onPensChange: true, onRangeChange: true, onBrushChange: true, onXTraceChange: true };
    var SECURITY_KEYS = { enabled: true, trendGroup: true, trendEdit: true, readScope: true, tagBrowser: true, annotations: true };
    /** True when a panel may write root `rootKey` (write and patch share the rule). */
    function apiWritable(rootKey) {
      return typeof rootKey === 'string' && hasOwn.call(SPEC.p, rootKey) && !SECURITY_KEYS[rootKey] && rootKey !== 'outputs';
    }

    /* ---- api.patch helpers: raw copies, deep merge, change signature ---------------------------------------- */
    /** Deep copy of a raw prop value: plain objects and arrays copied, Dates kept as Dates, other objects via JSON. */
    function rawCopy(x) {
      if (x == null || typeof x !== 'object') return x;
      if (x instanceof Date) return new Date(x.getTime());
      if (Array.isArray(x)) return x.map(rawCopy);
      if (!NS.util.isPlainObject(x)) return jsonCopy(x);
      var out = {};
      for (var k in x) if (hasOwn.call(x, k)) out[k] = rawCopy(x[k]);
      return out;
    }
    /** Deep merge of `part` into `base` (mutated and returned): plain objects merge, anything else replaces. */
    function deepMerge(base, part) {
      for (var k in part) {
        if (!hasOwn.call(part, k)) continue;
        if (NS.util.isPlainObject(part[k]) && NS.util.isPlainObject(base[k])) deepMerge(base[k], part[k]);
        else base[k] = rawCopy(part[k]);
      }
      return base;
    }
    /** Stable signature of a raw value (sorted keys; a Date by its time, so two dates never compare equal as {}). */
    function patchSig(x) {
      if (x === undefined) return 'u';
      if (x instanceof Date) return 'D' + x.getTime();
      if (x === null || typeof x !== 'object') return JSON.stringify(x);
      if (Array.isArray(x)) return '[' + x.map(patchSig).join(',') + ']';
      return '{' + Object.keys(x).sort().map(function (k) { return JSON.stringify(k) + ':' + patchSig(x[k]); }).join(',') + '}';
    }
    /**
     * The value api.patch writes (pure; tests/js/_chartApiStub.mjs uses the same function): `raw` = the root as stored,
     * `reduced` = the reduced root, `change` = fn(rawCopy, reduced) or a partial object. Returns {ok, changed, value};
     * ok false = the change is not applicable (a throwing fn, a partial object for a non-object root).
     */
    /**
     * The reduced value of one root computed from its RAW value: the ctx.reduced an
     * operation maps raw positions through must describe the very raw value it is applied to — the chart's last
     * rendered reduced props can lag behind the store (a write echo still on its way) and then point at other items.
     */
    function reducedRootOf(rootKey, raw) {
      var src = {};
      src[rootKey] = raw;
      return reduceProps(src)[rootKey];
    }
    /** api.patch's result for root `rootKey` from its RAW value (pure; the stub uses the same function). */
    function patchRoot(rootKey, raw, change) { return applyPatch(raw, reducedRootOf(rootKey, raw), change); }
    function applyPatch(raw, reduced, change) {
      var kindOk = Array.isArray(reduced) ? Array.isArray(raw) : NS.util.isPlainObject(reduced) ? NS.util.isPlainObject(raw) : raw !== undefined;
      var base = kindOk ? rawCopy(raw) : rawCopy(jsonCopy(reduced));
      var before = kindOk ? patchSig(raw) : 'u';
      var next;
      if (typeof change === 'function') {
        try { next = change(base, reduced); } catch (e) { log.warn('ChartApi.patch function failed', e && e.message); return { ok: false }; }
        if (next === undefined) next = base;
      } else if (NS.util.isPlainObject(change) && NS.util.isPlainObject(base)) {
        next = deepMerge(base, change);
      } else {
        return { ok: false };
      }
      return { ok: true, changed: patchSig(next) !== before, value: next };
    }

    /**
     * Builds the api of one chart. `host` is the CtgChart component (or any object with the same small
     * surface: engine, store(), reducedProps(), penVMs(), axisVMs(), designMode(), designer(), root(),
     * plotManager(), writeProp(k, v), openPanel / closePanel / panelOpen, fire(name, payload)).
     */
    /**
     * After the chart unmounted (host.engine is gone) every member still answers without throwing: a panel's
     * late callback (a timer, a fetch that resolves after close) must not take the page down.
     * viewport.get / set / reset -> DETACHED_VIEWPORT, pens / axesInUse -> [], penInfo -> null, series.rows ->
     * {header: [], rows: []}, plots.snapshot -> null, history.fetchRaw -> {pens: [], error: 'DETACHED'},
     * request -> {ok: false, error: {code: 'DETACHED'}}, write / fireEvent / panels.* -> false.
     */
    var DETACHED_VIEWPORT = Object.freeze({ min: null, max: null, followLive: false, span: 0 });
    function createChartApi(host) {
      var listeners = [];
      var detached = function () { return !host.engine; };
      var api = {
        id: host.chartId,
        props: function () { return host.reducedProps(); },
        write: function (rootKey, value) {
          if (!apiWritable(rootKey)) {
            log.warn('ChartApi.write refused for', clean(rootKey));
            return false;
          }
          if (host.designMode() || detached()) return false;
          return host.writeProp(rootKey, value);
        },
        patch: function (rootKey, change) {
          if (!apiWritable(rootKey)) {
            log.warn('ChartApi.patch refused for', clean(rootKey));
            return false;
          }
          if (host.designMode() || detached()) return false;
          var r = patchRoot(rootKey, host.rawProp(rootKey), change);
          if (!r.ok) return false;
          return r.changed ? host.writeProp(rootKey, r.value) : true;
        },
        pens: function () {
          if (detached()) return [];
          return host.penVMs().map(function (vm) {
            return {
              key: vm.key, source: vm.source, index: vm.index, tagPath: vm.tagPath, label: vm.label, color: vm.color,
              visible: vm.visible, axisKey: vm.axisKey, plot: vm.plot, units: vm.units, format: vm.format,
              display: vm.display, status: vm.status, meta: vm.meta, trendable: vm.trendable,
              isBool: vm.isBool, shared: vm.shared, axisMissing: vm.axisMissing, approx: vm.approx, downgraded: vm.downgraded,
              incomplete: vm.incomplete,
            };
          });
        },
        penInfo: function (key) {
          var snap = host.engine && host.engine.source && host.engine.source.snap;
          var list = snap && Array.isArray(snap.pens) ? snap.pens : [];
          for (var i = 0; i < list.length; i++) if (list[i] && list[i].key === key) return list[i];
          return null;
        },
        axesInUse: function () {
          var out = [];
          if (detached()) return out;
          host.axisVMs().forEach(function (plotAxes) {
            plotAxes.forEach(function (ax) {
              out.push({ key: ax.key, name: ax.name, auto: ax.auto, side: ax.side, plot: ax.plot, units: ax.units.join(', ') });
            });
          });
          return out;
        },
        limits: function () { return host.engine ? Object.assign({}, host.engine.L) : effectiveLimits(null); },
        timeZone: function () { return (host.engine && host.engine.timeZone) || NS.time.resolveZone('session', host.store()); },
        now: function () { return NS.clock.now(); },
        status: function () {
          var m = host.engine ? host.engine.model() : null;
          if (!m) return { state: 'connecting', mode: null, staleSince: null, loading: false, lastUpdate: null, window: null, coverage: null, banner: null };
          return { state: m.state, mode: m.mode, staleSince: m.staleSince, loading: m.loading, lastUpdate: m.lastUpdate,
            window: m.window ? Object.assign({}, m.window) : null, coverage: m.coverage ? Object.assign({}, m.coverage) : null,
            banner: m.banner ? Object.assign({}, m.banner) : null };
        },
        viewport: {
          get: function () { return detached() ? Object.assign({}, DETACHED_VIEWPORT) : host.engine.viewport.get(); },
          set: function (r) {
            if (detached()) return Object.assign({}, DETACHED_VIEWPORT);
            if (host.ix) host.ix.cancelGesture();     // an explicit view ends a running gesture's preview
            var v = host.engine.viewport.set(r); host.userRange(); return v;
          },
          reset: function () {
            if (detached()) return Object.assign({}, DETACHED_VIEWPORT);
            if (host.ix) host.ix.cancelGesture();
            var v = host.engine.viewport.reset(); host.userRange(); return v;
          },
        },
        request: function (name, body, opts) {
          if (!API_REQUESTS[name]) return Promise.resolve({ ok: false, error: { code: 'NOT_ALLOWED', message: 'not allowed from a panel' } });
          var d = host.engine && host.engine.source;
          if (!d || typeof d.request !== 'function') return Promise.resolve({ ok: false, error: { code: 'DETACHED', message: '' } });
          return d.request(name, body || {}, opts || {});
        },
        history: {
          fetchRaw: function (o) {
            var q = o || {};
            if (detached()) return Promise.resolve({ pens: [], error: 'DETACHED' });
            return host.engine.fetchRaw({ start: q.start, end: q.end, penKeys: q.penKeys, onProgress: q.onProgress, signal: q.signal });
          },
        },
        series: { rows: function (o) { return detached() ? { header: [], rows: [] } : seriesRows(host, o || {}); } },
        plots: { snapshot: function (o) { return detached() ? null : plotSnapshot(host, o || {}); } },
        tokens: function () { return NS.theme.tokens(host.root() || undefined); },
        capabilities: function () { return chartCapabilities(host); },
        panels: {
          open: function (name, args) { return host.openPanel(name, args); },
          close: function (name) { return host.closePanel(name); },
          isOpen: function (name) { return host.panelOpen(name); },
        },
        fireEvent: function (name, payload) {
          if (!API_EVENTS[name] || detached()) return false;
          return host.fire(name, payload);
        },
        onChange: function (cb) {
          if (typeof cb !== 'function') return function () { };
          listeners.push(cb);
          return function () { var i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); };
        },
        t: function (key, vars, part) { return NS.i18n.t(key, vars, part || 'chart'); },
      };
      // the chart calls this after every render with what changed (rAF-coalesced there)
      Object.defineProperty(api, '_notify', {
        enumerable: false,
        value: function (what) {
          listeners.slice().forEach(function (fn) { try { fn(what); } catch (e) { log.warn('ChartApi listener failed', e); } });
        },
      });
      // internal: a panel with pending drafts registers a flush the chart runs at the top of its unmount, while this
      // API still writes (React unmounts the chart before its panels)
      Object.defineProperty(api, '_flushOnUnmount', {
        enumerable: false,
        value: function (fn) {
          if (typeof fn !== 'function') return function () { };
          var l = host._unmountFlushers || (host._unmountFlushers = []);
          l.push(fn);
          return function () { var cur = host._unmountFlushers || []; var i = cur.indexOf(fn); if (i >= 0) cur.splice(i, 1); };
        },
      });
      return Object.freeze(api);
    }

    /** api.capabilities() (contract: SECTION 15). */
    function chartCapabilities(host) {
      var p = host.reducedProps();
      var m = host.engine ? host.engine.model() : null;
      var caps = (m && m.capabilities) || {};
      var tb = caps.tagBrowser || {};
      var te = caps.trendEdit || {};
      var rs = caps.readScope || {};
      var an = caps.annotations || {};
      var dev = host.deviceType();
      var nativeApp = /^(ios|android|mobile)/i.test(dev || '');
      return {
        enabled: !!p.enabled, designMode: host.designMode(), designer: host.designer(), nativeApp: nativeApp, deviceType: dev || null,
        user: sessionUserOf(host),
        tagBrowser: { allowed: !!tb.allowed && p.tagBrowser.enabled, reason: tb.reason || (p.tagBrowser.enabled ? null : 'ACTION_DISABLED') },
        trendEdit: { allowed: !!te.allowed, reason: te.reason || null },
        readScope: { runtimePensAllowed: !!rs.runtimePensAllowed, roots: Array.isArray(rs.roots) ? rs.roots.slice() : [] },
        annotations: { allowed: !!an.allowed, editAllowed: !!an.editAllowed, moderateAllowed: !!an.moderateAllowed, reason: an.reason || null },
        settingsPanel: { enabled: p.settingsPanel.enabled && !!p.enabled, tabs: Object.assign({}, p.settingsPanel.tabs) },
        export: { csv: p.export.csv.enabled && !nativeApp, png: p.export.png.enabled && !nativeApp },
      };
    }

    /**
     * The session user's name from the chart delegate's last ctg.welcome (the gateway sends a new welcome after
     * every auth change, CtgDelegateBase.authChanged), or null before the first one / without a delegate.
     */
    function sessionUserOf(host) {
      var d = host.engine && host.engine.source;
      var w = d && d.state && d.state.welcome;
      var u = w && w.user;
      return u && typeof u.userName === 'string' ? u.userName : null;
    }

    /** api.series.rows: the data as drawn, real samples only. */
    function seriesRows(host, o) {
      var engine = host.engine;
      var vms = host.penVMs();
      var keys = Array.isArray(o.penKeys) ? o.penKeys : vms.filter(function (vm) { return vm.visible && vm.drawable; }).map(function (vm) { return vm.key; });
      var byKey = {};
      vms.forEach(function (vm) { byKey[vm.key] = vm; });
      keys = keys.filter(function (k) { return byKey[k]; });
      var vp = engine.viewport.get();
      var visible = o.source !== 'loaded';
      // export rows come from the stored series (real bucket stamps), not the draw view, which moves buckets
      // to their middle / end and adds a +1 ms row for the second half of each MinMax pair
      var views = keys.map(function (k) {
        var v = engine.exportView ? engine.exportView(k) : engine.penView(k);
        if (!visible) return v;
        var i0 = lowerBound(v.t, vp.min), i1 = upperBound(v.t, vp.max);
        return { t: v.t.slice(i0, i1), v: v.v.slice(i0, i1), aggregation: v.aggregation };
      });
      var T = function (k, vars) { return NS.i18n.t('chart.rows.' + k, vars); };
      var aggregated = [];
      var names = keys.map(function (k, i) {
        var vm = byKey[k];
        var a = views[i].aggregation;
        if (a) aggregated.push(vm.label);
        return a ? T('aggregated', { label: vm.label, aggregation: a }) : vm.label;
      });
      var labels = keys.map(function (k, i) {
        var vm = byKey[k];
        var a = views[i].aggregation;
        var l = vm.label + (vm.units ? ' (' + vm.units + ')' : '');
        return a ? T('aggregated', { label: l, aggregation: a }) : l;
      });
      var q = !!o.includeQuality;
      var good = T('good'), bad = T('bad');
      if (o.layout === 'tall') {
        var rows = [];
        views.forEach(function (v, i) {
          for (var j = 0; j < v.t.length; j++) {
            var r = [v.t[j], names[i], v.v[j]];
            if (q) r.push(v.v[j] === null ? bad : good);
            rows.push(r);
          }
        });
        rows.sort(function (a, b) { return a[0] - b[0]; });
        return { header: q ? [T('time'), T('pen'), T('value'), T('quality')] : [T('time'), T('pen'), T('value')], rows: rows,
          aggregated: aggregated };
      }
      var header = [T('time')];
      labels.forEach(function (l) { header.push(l); if (q) header.push(T('qualitySuffix', { label: l })); });
      // wide: k-way merge; equal times share one row, except a second row of one pen at the same time (the two
      // rows of a MinMax bucket), which gets a row of its own (the other pens blank there)
      var idx = views.map(function () { return 0; });
      var out = [];
      for (;;) {
        var tmin = Infinity;
        for (var a = 0; a < views.length; a++) if (idx[a] < views[a].t.length && views[a].t[idx[a]] < tmin) tmin = views[a].t[idx[a]];
        if (tmin === Infinity) break;
        var row = [tmin];
        for (var c = 0; c < views.length; c++) {
          var vw = views[c];
          if (idx[c] < vw.t.length && vw.t[idx[c]] === tmin) {
            var v = vw.v[idx[c]];
            idx[c]++;
            row.push(v);
            if (q) row.push(v === null ? bad : good);
          } else {
            row.push('');
            if (q) row.push('');
          }
        }
        out.push(row);
      }
      return { header: header, rows: out, aggregated: aggregated };
    }

    /** api.plots.snapshot: one canvas with the title, every plot canvas and (optionally) a legend. */
    function plotSnapshot(host, o) {
      var pm = host.plotManager();
      if (!pm || !pm.plots.length) return null;
      var p = host.reducedProps();
      var scale = NS.util.clamp(Number(o.scale) || p.export.png.scale || 2, 1, 4);
      var legend = o.includeLegend != null ? !!o.includeLegend : p.export.png.includeLegend;
      var tk = NS.theme.tokens(host.root() || undefined);
      var fs = p.appearance.fontSize;
      var w = pm.width;
      var titleH = p.title.visible && p.title.text ? fs * 2 + 8 : 0;
      var plotsH = pm.plots.reduce(function (a, rec, i) { return a + rec.h + (i ? PAD.between : 0); }, 0);
      var vms = host.penVMs().filter(function (vm) { return vm.visible; });
      var rowH = fs + 10;
      var legendH = legend ? vms.length * rowH + 12 : 0;
      var c = document.createElement('canvas');
      c.width = Math.round(w * scale);
      c.height = Math.round((titleH + plotsH + legendH) * scale);
      var g = c.getContext('2d');
      g.scale(scale, scale);
      g.fillStyle = tk.surface;
      g.fillRect(0, 0, w, titleH + plotsH + legendH);
      g.fillStyle = tk.text;
      g.textBaseline = 'middle';
      if (titleH) {
        g.font = '600 ' + (fs + 4) + 'px ' + tk.font;
        g.fillText(p.title.text, 8, titleH / 2);
      }
      var y = titleH;
      pm.plots.forEach(function (rec, i) {
        if (i) y += PAD.between;
        g.drawImage(rec.u.ctx.canvas, 0, y, rec.w, rec.h);
        y += rec.h;
      });
      if (legend) {
        y += 6;
        g.font = fs + 'px ' + tk.font;
        var locale = host.locale();
        vms.forEach(function (vm) {
          g.fillStyle = vm.color;
          g.fillRect(8, y + 3, 12, rowH - 6);
          g.fillStyle = tk.text;
          var cur = host.engine.current(vm.key);
          var txt = vm.label + '   ' + formatPenValue(cur ? cur.v : null, vm, locale) + (vm.units ? ' ' + vm.units : '');
          g.fillText(txt, 28, y + rowH / 2);
          y += rowH;
        });
      }
      return c;
    }

    /* ========================================================================
     * SECTION 16 / the ctg-chart-styles sheet
     * ----------------------------------------------------------------------
     * Every rule is wrapped in :where() (zero specificity), so the component
     * `style`, `styles.*`, `penTable.style` and project classes always win.
     * The chart defines NO tokens of its own: it uses the shared --ctg-* set
     * that ctg-common.js puts on :root, so the Perspective light and
     * dark themes both work. Root: transparent background, inherited
     * colour. --ctg-chart-fs carries appearance.fontSize to the pen table.
     * ====================================================================== */
    var v1Warned = {};                   // view resource path -> warned (one console line per view)
    var CHART_CSS = [
      ':where(.ctg-v1-badge){position:absolute;top:1px;right:1px;z-index:40;padding:0 4px;font-size:9px;line-height:14px;' +
        'font-weight:normal;color:#FFFFFF;background:var(--ctg-warn,#AD5F00);border-radius:3px;pointer-events:none;}',
      ':where(.ctg-chart){position:relative;display:flex;flex-direction:column;box-sizing:border-box;min-width:0;min-height:0;',
      'overflow:hidden;background-color:transparent;color:inherit;font-family:var(--ctg-font);font-size:13px;line-height:1.35;}',
      ':where(.ctg-chart *,.ctg-chart *::before,.ctg-chart *::after){box-sizing:border-box;}',
      ':where(.ctg-chart__title){flex:none;padding:6px 10px 2px;font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;}',
      // toolbar
      ':where(.ctg-chart__toolbar){flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:4px 6px;padding:4px 6px;',
      'border-bottom:1px solid var(--ctg-border);}',
      '@supports (color:color-mix(in srgb,red 50%,blue)){:where(.ctg-chart__toolbar){',
      'border-bottom-color:color-mix(in srgb,var(--ctg-border) 45%,transparent);}}',
      ':where(.ctg-tb-group){display:inline-flex;align-items:center;gap:2px;min-width:0;}',
      ':where(.ctg-tb-spacer){flex:1 1 0;min-width:4px;}',
      ':where(.ctg-tb-btn){display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;min-width:28px;',
      'padding:0 7px;font:inherit;font-size:13px;color:inherit;background:transparent;border:1px solid transparent;',
      'border-radius:var(--ctg-radius);cursor:pointer;white-space:nowrap;}',
      ':where(.ctg-tb-btn:hover:not(:disabled)){background:var(--ctg-surface-2);}',
      ':where(.ctg-tb-btn:disabled){opacity:.45;cursor:default;}',
      ':where(.ctg-tb-btn[aria-pressed="true"]){background:var(--ctg-surface-2);border-color:var(--ctg-border);}',
      ':where(.ctg-tb-btn:focus-visible,.ctg-tb-mode:focus-visible,.ctg-tb-pill:focus-visible,.ctg-chip:focus-visible,',
      '.ctg-swatch input:focus-visible+.ctg-swatch__box,.ctg-banner__btn:focus-visible){outline:2px solid var(--ctg-focus);outline-offset:1px;}',
      ':where(.ctg-icon){width:18px;height:18px;flex:none;fill:currentColor;}',
      ':where(.ctg-tb-pill){display:inline-flex;align-items:center;gap:6px;height:28px;max-width:100%;padding:0 10px 0 8px;font:inherit;',
      'font-size:13px;color:inherit;background:transparent;border:1px solid var(--ctg-border);border-radius:14px;cursor:pointer;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      ':where(.ctg-tb-pill:hover:not(:disabled)){background:var(--ctg-surface-2);}',
      ':where(.ctg-tb-pill:disabled){cursor:default;}',
      ':where(.ctg-tb-pill__text){overflow:hidden;text-overflow:ellipsis;}',
      ':where(.ctg-tb-pill--zoomed){border-color:var(--ctg-primary);}',
      ':where(.ctg-tb-modes){display:inline-flex;align-items:stretch;border:1px solid var(--ctg-border);border-radius:var(--ctg-radius);',
      'overflow:hidden;}',
      ':where(.ctg-tb-mode){height:26px;padding:0 9px;font:inherit;font-size:12.5px;color:inherit;background:transparent;border:0;',
      'border-left:1px solid var(--ctg-border);cursor:pointer;white-space:nowrap;}',
      ':where(.ctg-tb-mode:first-child){border-left:0;}',
      ':where(.ctg-tb-mode:hover:not(:disabled)){background:var(--ctg-surface-2);}',
      ':where(.ctg-tb-mode[aria-checked="true"]){color:var(--ctg-primary-text);background:var(--ctg-primary);}',
      ':where(.ctg-tb-mode:disabled){opacity:.5;cursor:default;}',
      // badge + chip
      ':where(.ctg-badge){display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;font-size:12px;font-weight:600;',
      'white-space:nowrap;border-radius:12px;color:var(--ctg-text-muted);}',
      ':where(.ctg-badge__dot){width:8px;height:8px;border-radius:50%;background:currentColor;flex:none;}',
      ':where(.ctg-badge--live){color:var(--ctg-success);}',
      ':where(.ctg-badge--live .ctg-badge__dot){animation:ctg-chart-pulse 2s ease-in-out infinite;}',
      ':where(.ctg-badge--stale){color:var(--ctg-warn);}',
      ':where(.ctg-badge--error){color:var(--ctg-danger);}',
      ':where(.ctg-badge--paused,.ctg-badge--historical){color:var(--ctg-primary);}',
      ':where(.ctg-badge .ctg-badge__text){color:var(--ctg-text);font-weight:600;}',
      '@keyframes ctg-chart-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
      ':where(.ctg-chip){display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 10px;font:inherit;font-size:12px;',
      'font-weight:600;color:var(--ctg-primary-text);background:var(--ctg-primary);border:0;border-radius:12px;cursor:pointer;',
      'white-space:nowrap;}',
      // body / panels / plot area
      ':where(.ctg-chart__body){flex:1 1 auto;display:flex;min-height:0;min-width:0;}',
      ':where(.ctg-chart__dock){flex:none;display:flex;flex-direction:column;min-height:0;overflow:auto;}',
      // the panel slot fills the dock's height, so a docked panel spans the plot area
      ':where(.ctg-chart__dock>.ctg-chart__panel){display:flex;flex-direction:column;flex:1 1 auto;min-height:0;}',
      ':where(.ctg-chart__dock--left){border-right:1px solid var(--ctg-border);}',
      ':where(.ctg-chart__dock--right){border-left:1px solid var(--ctg-border);}',
      ':where(.ctg-chart__main){position:relative;flex:1 1 auto;display:flex;flex-direction:column;min-width:0;min-height:0;}',
      ':where(.ctg-chart__plots){position:relative;flex:1 1 auto;min-height:0;min-width:0;overflow:hidden;}',
      ':where(.ctg-chart__plots-host){position:absolute;inset:0;}',
      ':where(.ctg-chart__plot){position:relative;}',
      ':where(.ctg-chart .uplot){font-family:inherit;width:auto;}',
      ':where(.ctg-chart .u-cursor-x){border-right:1px dashed var(--ctg-text-muted);}',
      ':where(.ctg-chart .u-select){background:color-mix(in srgb,var(--ctg-primary) 18%,transparent);}',
      ':where(.ctg-chart[data-ctg-mode="pan"] .u-cursor-x,.ctg-chart[data-ctg-mode="zoom"] .u-cursor-x){display:none;}',
      ':where(.ctg-chart[data-ctg-mode="pan"] .u-over){cursor:grab;}',
      ':where(.ctg-chart[data-ctg-mode="zoom"] .u-over,.ctg-chart[data-ctg-mode="rangeBrush"] .u-over){cursor:crosshair;}',
      ':where(.ctg-chart__loadbar){position:absolute;left:0;right:0;top:0;height:3px;overflow:hidden;z-index:2;pointer-events:none;}',
      ':where(.ctg-chart__loadbar::after){content:"";position:absolute;top:0;bottom:0;width:30%;background:var(--ctg-primary);',
      'animation:ctg-chart-load 1.2s ease-in-out infinite;}',
      '@keyframes ctg-chart-load{0%{left:-30%}100%{left:100%}}',
      ':where(.ctg-chart__empty){position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;',
      'text-align:center;color:var(--ctg-text-muted);font-size:13px;}',
      ':where(.ctg-chart__empty-text){max-width:420px;}',
      // banners, notices, progress
      ':where(.ctg-banner){flex:none;display:flex;align-items:center;flex-wrap:wrap;gap:6px 10px;margin:4px 6px 0;padding:6px 10px;',
      'font-size:12.5px;border-radius:var(--ctg-radius);border-left:3px solid var(--ctg-danger);background:var(--ctg-surface-2);}',
      ':where(.ctg-banner--warn){border-left-color:var(--ctg-warn);}',
      ':where(.ctg-banner--info){border-left-color:var(--ctg-primary);}',
      ':where(.ctg-banner .ctg-icon){width:16px;height:16px;}',
      ':where(.ctg-banner--error .ctg-icon){color:var(--ctg-danger);}',
      ':where(.ctg-banner--warn .ctg-icon){color:var(--ctg-warn);}',
      ':where(.ctg-banner--info .ctg-icon){color:var(--ctg-primary);}',
      ':where(.ctg-banner__text){flex:1 1 200px;min-width:0;}',
      ':where(.ctg-banner__btn){height:24px;padding:0 10px;font:inherit;font-size:12px;font-weight:600;color:inherit;',
      'background:transparent;border:1px solid var(--ctg-border);border-radius:var(--ctg-radius);cursor:pointer;}',
      ':where(.ctg-progress){flex:none;margin:4px 6px 0;font-size:12px;color:var(--ctg-text-muted);}',
      ':where(.ctg-progress__row){display:flex;align-items:center;gap:8px;}',
      ':where(.ctg-progress__bar){height:3px;margin-top:3px;background:var(--ctg-surface-2);border-radius:2px;overflow:hidden;}',
      ':where(.ctg-progress__fill){height:100%;background:var(--ctg-primary);transition:width .2s;}',
      // pen table
      ':where(.ctg-pentable){flex:none;overflow:auto;min-height:0;font-size:var(--ctg-chart-fs,12px);',
      'border-top:1px solid var(--ctg-border);}',
      ':where(.ctg-pentable--right){border-top:0;border-left:1px solid var(--ctg-border);}',
      ':where(.ctg-pentable table){width:100%;border-collapse:separate;border-spacing:0;}',
      ':where(.ctg-pentable th){position:sticky;top:0;z-index:1;padding:4px 8px;font-weight:600;text-align:left;',
      'white-space:nowrap;color:var(--ctg-text-muted);background:var(--ctg-surface);border-bottom:1px solid var(--ctg-border);}',
      ':where(.ctg-pentable td){padding:3px 8px;white-space:nowrap;border-bottom:1px solid transparent;vertical-align:middle;}',
      ':where(.ctg-pentable .ctg-num){text-align:right;font-variant-numeric:tabular-nums;}',
      ':where(.ctg-pentable th.ctg-num){text-align:right;}',
      ':where(.ctg-pentable tbody tr:hover){background:var(--ctg-surface-2);}',
      ':where(.ctg-pen__name){width:35%;max-width:320px;overflow:hidden;text-overflow:ellipsis;}',
      ':where(.ctg-pen--hidden .ctg-pen__name,.ctg-pen--hidden .ctg-num){opacity:.55;}',
      ':where(.ctg-pen--removing){opacity:.45;pointer-events:none;}',
      ':where(.ctg-pen--fault td:first-child){box-shadow:inset 3px 0 0 var(--ctg-danger);}',
      ':where(.ctg-pen--warn td:first-child){box-shadow:inset 3px 0 0 var(--ctg-warn);}',
      ':where(.ctg-pen--fault .ctg-num){color:var(--ctg-text-muted);}',
      ':where(.ctg-pen__status){display:inline-flex;align-items:center;gap:4px;max-width:280px;overflow:hidden;text-overflow:ellipsis;}',
      ':where(.ctg-pen__status .ctg-icon){width:15px;height:15px;}',
      ':where(.ctg-pen__status--error){color:var(--ctg-danger);}',
      ':where(.ctg-pen__status--warn){color:var(--ctg-warn);}',
      ':where(.ctg-pen__status--info){color:var(--ctg-text-muted);}',
      ':where(.ctg-pen__bad){color:var(--ctg-danger);}',
      ':where(.ctg-pen__chip){display:inline-block;margin-left:6px;padding:0 6px;font-size:.85em;border-radius:8px;',
      'color:var(--ctg-text-muted);border:1px solid var(--ctg-border);}',
      ':where(.ctg-pentable__more td){color:var(--ctg-text-muted);font-style:italic;}',
      ':where(.ctg-swatch){position:relative;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;',
      'vertical-align:middle;cursor:pointer;}',
      ':where(.ctg-swatch input){position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:inherit;}',
      ':where(.ctg-swatch__box){width:14px;height:14px;border-radius:3px;border:2px solid var(--ctg-pen,currentColor);',
      'background:transparent;}',
      ':where(.ctg-swatch input:checked+.ctg-swatch__box){background:var(--ctg-pen,currentColor);}',
      ':where(.ctg-swatch--static){cursor:default;}',
      ':where(.ctg-swatch input:disabled){cursor:default;}',
      // fullscreen / maximised (z-index: above the primary view, below Perspective popups)
      ':where(.ctg-chart:fullscreen,.ctg-chart--fullscreen){width:100%;height:100%;background-color:var(--ctg-surface);}',
      // Perspective's own ':not(video):fullscreen{background:var(--fullscreen-background-color)}' has specificity
      // (0,1,1) and beats the zero-specificity rule above (the chart would be painted on the black backdrop).
      // This one is (0,2,0); a theme still overrides it by setting --ctg-surface.
      '.ctg-chart:fullscreen{background-color:var(--ctg-surface);}',
      ':where(.ctg-chart--maximised){position:fixed;inset:0;z-index:var(--ctg-z-max,10500);width:auto;height:auto;',
      'background-color:var(--ctg-surface);box-shadow:0 0 0 100vmax rgba(0,0,0,.25);}',
      // plot area: keyboard focus, touch-action per mode (also set inline on each u.over), brush cursors
      ':where(.ctg-chart__plots:focus){outline:none;}',
      ':where(.ctg-chart__plots:focus-visible){outline:2px solid var(--ctg-focus);outline-offset:-2px;}',
      ':where(.ctg-chart .u-over){touch-action:none;}',
      ':where(.ctg-chart[data-ctg-mode="xTrace"] .u-over){touch-action:pan-y;}',
      ':where(.ctg-chart[data-ctg-mode="rangeBrush"] .u-cursor-x){display:none;}',
      // X-Trace info box (DOM in u.over, text nodes only)
      ':where(.ctg-infobox){position:absolute;left:0;top:0;z-index:3;pointer-events:none;max-width:340px;padding:4px 7px;',
      'font-size:var(--ctg-chart-fs,12px);line-height:1.45;color:var(--ctg-text);background:var(--ctg-surface);',
      'border:1px solid var(--ctg-border);border-radius:var(--ctg-radius);box-shadow:0 2px 8px rgba(0,0,0,.18);white-space:nowrap;}',
      ':where(.ctg-infobox__time){font-weight:600;color:var(--ctg-text-muted);margin-bottom:2px;}',
      ':where(.ctg-infobox__row){display:flex;align-items:center;gap:6px;}',
      ':where(.ctg-infobox__sw){flex:none;width:10px;height:10px;border-radius:2px;}',
      ':where(.ctg-infobox__name){flex:1 1 auto;min-width:0;max-width:170px;overflow:hidden;text-overflow:ellipsis;}',
      ':where(.ctg-infobox__val){margin-left:auto;padding-left:8px;font-weight:600;font-variant-numeric:tabular-nums;}',
      ':where(.ctg-infobox__val--bad){color:var(--ctg-danger);}',
      ':where(.ctg-infobox__unit){color:var(--ctg-text-muted);}',
      // annotation tooltip: the info box look, wrapped text
      ':where(.ctg-anntip){max-width:280px;white-space:normal;}',
      ':where(.ctg-anntip__text){white-space:pre-wrap;overflow-wrap:anywhere;margin:2px 0;max-height:9.5em;overflow:hidden;}',
      ':where(.ctg-anntip__meta){color:var(--ctg-text-muted);}',
      // pen table: collapse toggle, colour dot, hover actions (always visible on touch), compact rows, brush bar
      ':where(.ctg-pentable__namehead){white-space:nowrap;}',
      ':where(.ctg-pentable__toggle,.ctg-pen__act,.ctg-pen__expand){display:inline-flex;align-items:center;justify-content:center;',
      'width:24px;height:24px;padding:0;margin:0 2px 0 0;vertical-align:middle;color:inherit;background:transparent;border:1px solid transparent;',
      'border-radius:var(--ctg-radius);cursor:pointer;}',
      ':where(.ctg-pentable__toggle .ctg-icon,.ctg-pen__act .ctg-icon,.ctg-pen__expand .ctg-icon){width:16px;height:16px;}',
      ':where(.ctg-pentable__toggle:hover,.ctg-pen__act:hover:not(:disabled),.ctg-pen__expand:hover){background:var(--ctg-surface-2);border-color:var(--ctg-border);}',
      ':where(.ctg-pen__act:disabled){opacity:.4;cursor:default;}',
      ':where(.ctg-pentable__toggle:focus-visible,.ctg-pen__act:focus-visible,.ctg-pen__expand:focus-visible,.ctg-pen__color:focus-visible,',
      '.ctg-brushbar button:focus-visible,.ctg-brushbar select:focus-visible){outline:2px solid var(--ctg-focus);outline-offset:1px;}',
      ':where(.ctg-pen__actions){width:1%;white-space:nowrap;text-align:right;}',
      ':where(.ctg-pentable tbody tr .ctg-pen__actions .ctg-pen__act){opacity:0;}',
      ':where(.ctg-pentable tbody tr:hover .ctg-pen__act,.ctg-pentable tbody tr:focus-within .ctg-pen__act){opacity:1;}',
      ':where(.ctg-pentable tbody tr:hover .ctg-pen__act:disabled){opacity:.4;}',
      '@media (hover:none){:where(.ctg-pentable tbody tr .ctg-pen__actions .ctg-pen__act){opacity:1;}}',
      ':where(.ctg-pen__color){display:inline-block;width:12px;height:12px;padding:0;margin:0 6px 0 0;vertical-align:middle;cursor:pointer;',
      'border:1px solid var(--ctg-border);border-radius:50%;background:var(--ctg-pen,currentColor);}',
      ':where(.ctg-pen__label){vertical-align:middle;}',
      ':where(.ctg-pentable--compact .ctg-pen__name){width:auto;max-width:none;}',
      ':where(.ctg-pentable--compact tbody tr.ctg-chart-pen){cursor:pointer;}',
      ':where(.ctg-pen__details td){padding:2px 8px 8px 34px;white-space:normal;background:var(--ctg-surface-2);}',
      ':where(.ctg-pen__dl){display:grid;grid-template-columns:max-content 1fr;gap:2px 12px;margin:0 0 4px;}',
      ':where(.ctg-pen__dl dt){color:var(--ctg-text-muted);}',
      ':where(.ctg-pen__dl dd){margin:0;}',
      ':where(.ctg-pen__actions--inline){text-align:left;}',
      ':where(.ctg-pen__actions--inline .ctg-pen__act){opacity:1;}',
      ':where(.ctg-brushbar){position:sticky;top:0;left:0;z-index:2;display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;',
      'padding:4px 8px;font-size:12px;background:var(--ctg-surface);border-bottom:1px solid var(--ctg-border);}',
      ':where(.ctg-brushbar__summary){font-weight:600;font-variant-numeric:tabular-nums;}',
      ':where(.ctg-brushbar__note){color:var(--ctg-warn,var(--ctg-text-muted));font-weight:600;cursor:help;}',
      ':where(.ctg-brushbar__select){font:inherit;font-size:12px;color:inherit;background:transparent;border:1px solid var(--ctg-border);',
      'border-radius:var(--ctg-radius);height:24px;}',
      ':where(.ctg-brushbar .ctg-banner__btn:disabled){opacity:.5;cursor:default;}',
      // narrow layout: mode menu button, the panel sheet over the component, the 3 px progress bar
      ':where(.ctg-tb-modebtn){width:auto;padding:0 6px 0 9px;font-size:12.5px;}',
      ':where(.ctg-chart--narrow .ctg-tb-pill){max-width:210px;}',
      ':where(.ctg-chart__sheet){position:absolute;inset:0;z-index:6;display:flex;flex-direction:column;background:var(--ctg-surface);}',
      ':where(.ctg-chart__sheet-head){flex:none;display:flex;align-items:center;padding:4px 6px;border-bottom:1px solid var(--ctg-border);}',
      ':where(.ctg-chart__sheet-body){flex:1 1 auto;display:flex;flex-direction:column;min-height:0;overflow:auto;}',
      ':where(.ctg-progress--bar){margin:0;}',
      ':where(.ctg-progress--bar .ctg-progress__bar){margin-top:0;}',
      ':where(.ctg-rate){display:flex;flex-direction:column;gap:8px;width:260px;padding:10px;}',
      ':where(.ctg-rate__actions){display:flex;justify-content:flex-end;}',
      // range selector (SECTION 14c): the overview strip under the plots, its window, handles and shades
      ':where(.ctg-rs){position:relative;flex:none;min-width:0;overflow:hidden;border-top:1px solid var(--ctg-border);',
      'touch-action:pan-y;user-select:none;-webkit-user-select:none;}',
      ':where(.ctg-rs .uplot){width:auto;}',
      ':where(.ctg-rs .u-over){cursor:crosshair;}',
      // outside the window the data is faded with the surface colour (dims in light and dark alike); the window stays clear
      ':where(.ctg-rs__shade){position:absolute;top:0;bottom:0;left:0;width:0;pointer-events:none;background:var(--ctg-surface);opacity:.62;}',
      ':where(.ctg-rs__win){position:absolute;top:0;bottom:0;left:0;width:0;border:1px solid var(--ctg-primary);border-radius:2px;',
      'background:transparent;cursor:grab;}',
      ':where(.ctg-rs__win:active){cursor:grabbing;}',
      ':where(.ctg-rs__handle){position:absolute;top:50%;left:0;width:8px;height:60%;min-height:14px;max-height:28px;',
      'background:var(--ctg-primary);border:1px solid var(--ctg-surface);border-radius:3px;cursor:ew-resize;}',
      ':where(.ctg-rs__handle::before){content:"";position:absolute;top:-6px;bottom:-6px;left:-6px;right:-6px;}',
      ':where(.ctg-rs__win:focus,.ctg-rs__handle:focus){outline:none;}',
      ':where(.ctg-rs__win:focus-visible,.ctg-rs__handle:focus-visible){outline:2px solid var(--ctg-focus);outline-offset:1px;}',
      ':where(.ctg-rs__msg){position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;',
      'color:var(--ctg-text-muted);pointer-events:none;}',
      ':where(.ctg-rs--off .ctg-rs__win,.ctg-rs--off .ctg-rs__handle,.ctg-rs--off .u-over){cursor:default;}',
      '@supports (color:color-mix(in srgb,red 50%,blue)){:where(.ctg-rs){border-top-color:color-mix(in srgb,var(--ctg-border) 45%,transparent);}',
      ':where(.ctg-rs__win){background:color-mix(in srgb,var(--ctg-primary) 6%,transparent);}}',
      // narrow touch targets
      '@media (pointer:coarse){:where(.ctg-rs__handle::before){top:-10px;bottom:-10px;left:-12px;right:-12px;}}',
      '@media (pointer:coarse){:where(.ctg-tb-btn,.ctg-tb-pill){height:40px;min-width:40px;}:where(.ctg-tb-mode){height:38px;}',
      ':where(.ctg-swatch){width:32px;height:32px;}',
      ':where(.ctg-pentable__toggle,.ctg-pen__act,.ctg-pen__expand){width:36px;height:36px;}',
      ':where(.ctg-pen__color){width:20px;height:20px;}}',
      '@media (prefers-reduced-motion:reduce){:where(.ctg-badge--live .ctg-badge__dot,.ctg-chart__loadbar::after){animation:none;}',
      ':where(.ctg-progress__fill){transition:none;}}',
    ].join('');

    /* ========================================================================
     * SECTION 17 / small React pieces (icons, time-axis labels, error boundary)
     * ----------------------------------------------------------------------
     * Icons are inline SVG built with createElement (no icon font, no
     * innerHTML). Every icon-only button carries aria-label + title.
     * ====================================================================== */
    var ICON_PATHS = {
      refresh: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
      reset: 'M12 5V2L8 6l4 4V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z',
      calendar: 'M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2zm0 16H5V9h14v11zM7 11h5v5H7z',
      tags: 'M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z',
      settings: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
      export: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
      warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
      error: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
      lock: 'M18 8h-1V6A5 5 0 0 0 7 6v2H6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V10a2 2 0 0 0-2-2zm-6 9a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm3.1-9H8.9V6a3.1 3.1 0 0 1 6.2 0v2z',
      link: 'M3.9 12A3.1 3.1 0 0 1 7 8.9h4V7H7a5 5 0 0 0 0 10h4v-1.9H7A3.1 3.1 0 0 1 3.9 12zM8 13h8v-2H8v2zm9-6h-4v1.9h4a3.1 3.1 0 0 1 0 6.2h-4V17h4a5 5 0 0 0 0-10z',
      info: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
      close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
      history: 'M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6a7 7 0 1 1 2.05 4.95l-1.42 1.42A9 9 0 1 0 13 3zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z',
      dropdown: 'M7 10l5 5 5-5z',
      // interaction: fullscreen, More menu, pen-table actions, range brushes
      fullscreen: 'M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z',
      fullscreenExit: 'M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z',
      more: 'M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm12 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm-6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
      edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
      trash: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
      expandMore: 'M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6z',
      expandLess: 'M12 8l-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z',
      back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
      timer: 'M15 1H9v2h6V1zm-4 13h2V8h-2v6zm8.03-6.61 1.42-1.42c-.43-.51-.9-.99-1.41-1.41l-1.42 1.42A8.96 8.96 0 0 0 12 4a9 9 0 1 0 9 9c0-2.12-.74-4.07-1.97-5.61zM12 20a7 7 0 1 1 0-14 7 7 0 0 1 0 14z',
      copy: 'M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z',
      zoomIn: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14zm.5-7H9v2H7v1h2v2h1v-2h2V9h-2z',
    };
    function Icon(name, title) {
      return h('svg', {
        className: 'ctg-icon', viewBox: '0 0 24 24', focusable: 'false',
        'aria-hidden': title ? undefined : 'true', role: title ? 'img' : undefined, 'aria-label': title || undefined,
      }, title ? h('title', null, title) : null, h('path', { d: ICON_PATHS[name] || '' }));
    }

    /**
     * Automatic time-axis labels (timeAxis.format "auto"): 24-hour times whose precision follows the tick
     * increment, and the date as a second line on the first tick and wherever the day changes.
     */
    function autoTimeValues(tz) {
      return function (u, splits, ai, space, incr) {
        var prevDay = null, prevYear = null;
        return splits.map(function (ms, i) {
          if (ms == null) return '';
          var day = NS.time.format(ms, 'YYYY-MM-DD', tz);
          var year = day.slice(0, 4);
          var line1, line2 = '';
          if (incr >= 28 * DAY) {
            line1 = NS.time.format(ms, incr >= 360 * DAY ? 'YYYY' : 'MMM', tz);
            if (incr < 360 * DAY && (i === 0 || year !== prevYear)) line2 = year;
          } else if (incr >= DAY) {
            line1 = NS.time.format(ms, 'MM-DD', tz);
            if (i === 0 || year !== prevYear) line2 = year;
          } else {
            line1 = NS.time.format(ms, incr >= MINUTE ? 'HH:mm' : incr >= SECOND ? 'HH:mm:ss' : 'HH:mm:ss.SSS', tz);
            if (i === 0 || day !== prevDay) line2 = NS.time.format(ms, i === 0 || year !== prevYear ? 'YYYY-MM-DD' : 'MM-DD', tz);
          }
          prevDay = day; prevYear = year;
          return line2 ? line1 + '\n' + line2 : line1;
        });
      };
    }

    var RComponent = (React && React.Component) || PC.Component;
    /**
     * Error boundaries. A boundary only catches what its CHILDREN throw while rendering, so
     * every guarded part is rendered by a child component (RenderPart calls the part's render function in its
     * own render) — an element built eagerly in CtgChart.render would throw in the chart itself and reach
     * Perspective's "Component Error" (engine disposed, chart gone). Guarded parts: toolbar, main area (plots,
     * banners), pen table, and every open panel. A failing part shows "Chart error: …" + "Reload chart"
     * (main: destroys and recreates the plots; toolbar / pen table: renders again) or, for a panel,
     * "Panel error: …" + "Close panel"; the rest of the chart keeps working.
     */
    class ChartErrorBoundary extends RComponent {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }
      static getDerivedStateFromError(e) { return { error: e || new Error('render failed') }; }
      componentDidCatch(e) { log.error('chart render failed', clean(this.props.part || 'chart'), e); }
      render() {
        var self = this;
        if (!this.state.error) return this.props.children;
        var msg = String((this.state.error && this.state.error.message) || this.state.error).slice(0, 200);
        var panel = !!this.props.panel;
        return h('div', {
          className: 'ctg-banner ctg-banner--error', role: 'alert', 'data-ctg': 'banner', 'data-code': 'render',
          'data-ctg-part': this.props.part || 'main',
        }, Icon('error'),
        h('span', { className: 'ctg-banner__text' }, NS.i18n.t(panel ? 'chart.banner.panel' : 'chart.banner.render', { message: msg })),
        h('button', {
          type: 'button', className: 'ctg-banner__btn',
          onClick: function () { self.setState({ error: null }); if (self.props.onReset) self.props.onReset(); },
        }, NS.i18n.t(panel ? 'chart.banner.closePanel' : 'chart.banner.reloadChart')));
      }
    }
    /** Renders props.fn() as its own render, so a throw lands in the enclosing ChartErrorBoundary. */
    class RenderPart extends RComponent {
      render() { var out = this.props.fn(); return out === undefined ? null : out; }
    }
    /** A part of the chart behind its own boundary (see ChartErrorBoundary). */
    function guarded(key, part, fn, onReset, panel) {
      return h(ChartErrorBoundary, { key: key, part: part, onReset: onReset, panel: !!panel }, h(RenderPart, { fn: fn }));
    }

    /** Status cell of a pen row: {tone, icon, text, title} or null (the fault overlay). */
    var FAULT_TONE = { notFound: 'error', accessDenied: 'error', invalidPath: 'error', unsupportedType: 'error', overLimit: 'error',
      outOfScope: 'error', error: 'error', noHistory: 'warn', tooManyPoints: 'warn', timeout: 'warn' };
    var FAULT_ICON = { accessDenied: 'lock', outOfScope: 'lock', timeout: 'history', noHistory: 'history' };
    function penStatus(vm, cur, ctx) {
      var limitText = vm.limit != null ? NS.format.number(vm.limit, '#,##0', ctx.locale) : '';
      if (ctx.fatal) return { tone: 'error', icon: 'error', text: NS.i18n.t('chart.history.failed', { code: ctx.fatal }) };
      if (vm.status !== 'ok' && vm.status !== 'loading') {
        var tk = 'chart.status.' + vm.status + '.title';
        var title = NS.i18n.has(tk, 'chart') ? NS.i18n.t(tk, { max: ctx.maxPens }) : null;
        return { tone: FAULT_TONE[vm.status] || 'error', icon: FAULT_ICON[vm.status] || (FAULT_TONE[vm.status] === 'warn' ? 'warning' : 'error'),
          text: NS.i18n.t('chart.status.' + vm.status, { limit: limitText }), title: title };
      }
      if (vm.status === 'loading') return { tone: 'info', spinner: true, text: NS.i18n.t('chart.status.loading') };
      var lvl = cur && cur.q ? NS.quality.level(cur.q) : 'good';
      if (lvl !== 'good' && cur && cur.q) {
        var qn = cur.q.name || NS.quality.label(cur.q);
        return { tone: lvl === 'uncertain' ? 'warn' : 'error', icon: 'warning', text: qn, title: NS.i18n.t('chart.pen.quality', { name: qn }) };
      }
      if (vm.incomplete) return { tone: 'warn', icon: 'warning', text: NS.i18n.t('chart.pen.incompleteShort'), title: NS.i18n.t('chart.pen.incomplete') };
      if (vm.warn) return { tone: 'warn', icon: 'warning', text: NS.i18n.t('chart.status.' + vm.warn, { limit: limitText }) };
      if (vm.downgraded) return { tone: 'info', icon: 'info', text: NS.i18n.t('chart.pen.downgraded') };
      if (vm.shared) return { tone: 'info', icon: 'link', text: '', title: NS.i18n.t('chart.pen.sharesScale') };
      if (vm.axisMissing) return { tone: 'info', icon: 'info', text: '', title: NS.i18n.t('chart.pen.axisMissing', { name: vm.axisMissing }) };
      return null;
    }

    /**
     * The X-Trace column cell: the pen's value at the hovered (or keyboard) cursor, else at the
     * first pinned trace. It re-renders by itself from the interaction's hover notifications (rAF-coalesced),
     * so hovering never re-renders the chart (plots, pen table) — only these cells.
     */
    class XTraceCell extends RComponent {
      constructor(props) {
        super(props);
        this.state = { n: 0 };
      }
      componentDidMount() {
        var self = this;
        this._off = this.props.ix ? this.props.ix.subscribe(function () { self.setState(function (st) { return { n: st.n + 1 }; }); }) : null;
      }
      componentWillUnmount() { if (this._off) this._off(); }
      render() {
        var ix = this.props.ix;
        var t = ix ? ix.columnTime() : null;
        if (t == null) return '—';
        var r = ix.valueFor(this.props.vm, t);
        return r.bad ? h('span', { className: 'ctg-pen__bad' }, r.text) : r.text;
      }
    }

    /**
     * Pen table columns, in schema order (penTable.columns): Current / Min / Max / Avg / X-Trace /
     * Axis / Plot / Units / Status. Shape: id, num, header(ctx), cell(vm, ctx) -> text | element; `stat`
     * columns come from the window statistics.
     */
    var PEN_COLUMNS = [
      { id: 'current', num: true,
        header: function (c) { return NS.i18n.t(c.follow ? 'chart.col.current' : 'chart.col.end'); },
        cell: function (vm, c) {
          var cur = c.current(vm);
          if (!cur) return '—';
          var lvl = cur.q ? NS.quality.level(cur.q) : 'good';
          var txt = formatPenValue(cur.v, vm, c.locale);
          return lvl === 'bad' || lvl === 'error' ? h('span', { className: 'ctg-pen__bad' }, txt) : txt;
        } },
      { id: 'minimum', num: true, stat: 'minimum', header: function () { return NS.i18n.t('chart.col.minimum'); } },
      { id: 'maximum', num: true, stat: 'maximum', header: function () { return NS.i18n.t('chart.col.maximum'); } },
      { id: 'average', num: true, stat: 'average', title: 'chart.col.average.title', header: function () { return NS.i18n.t('chart.col.average'); } },
      { id: 'xTrace', num: true, title: 'chart.col.xTrace.title', header: function () { return NS.i18n.t('chart.col.xTrace'); },
        cell: function (vm, c) { return vm.drawable && c.ix ? h(XTraceCell, { ix: c.ix, vm: vm }) : '—'; } },
      { id: 'axis', header: function () { return NS.i18n.t('chart.col.axis'); },
        cell: function (vm, c) {
          var ax = vm.drawable && c.axisOf ? c.axisOf(vm) : null;
          if (!ax) return '—';
          return ax.name || NS.i18n.t('chart.axis.auto', { side: NS.i18n.t('chart.axis.' + (ax.side === 'right' ? 'right' : 'left')) });
        } },
      { id: 'plot', num: true, header: function () { return NS.i18n.t('chart.col.plot'); },
        cell: function (vm) { return vm.drawable ? String(vm.plot + 1) : '—'; } },
      { id: 'units', header: function () { return NS.i18n.t('chart.col.units'); }, cell: function (vm) { return vm.units || ''; } },
      { id: 'status', header: function () { return NS.i18n.t('chart.col.status'); },
        cell: function (vm, c) {
          var st = penStatus(vm, c.current(vm), c);
          if (!st) return '';
          return h('span', { className: 'ctg-pen__status ctg-pen__status--' + st.tone, title: st.title || st.text || undefined },
            st.spinner ? h('span', { className: 'ctg-spinner', 'aria-hidden': 'true' }) : st.icon ? Icon(st.icon, st.text ? null : st.title) : null,
            st.text ? h('span', null, st.text) : null);
        } },
    ];
    /**
     * Range-brush columns (penTable.rangeColumns): while the selected brush is shown they replace
     * the window statistics (Units and Status stay). Values come from statsFor over the brushed range.
     */
    var RANGE_COLUMNS = ['first', 'last', 'delta', 'minimum', 'maximum', 'average', 'median', 'standardDeviation', 'sum', 'lcl',
      'ucl', 'count'].map(function (id) { return { id: id, num: true, stat: id }; });
    var RANGE_TITLES = { average: 'chart.rcol.average.title', median: 'chart.rcol.median.title',
      standardDeviation: 'chart.rcol.standardDeviation.title', sum: 'chart.rcol.sum.title' };

    /**
     * Clipboard text (Copy stats): called synchronously in the click handler (user
     * activation); falls back to a hidden textarea + execCommand('copy') when the async API is missing or
     * refuses. done(ok) reports the outcome.
     */
    function copyText(text, done) {
      var fallback = function () {
        var ok = false;
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.setAttribute('readonly', '');
          ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.top = '0';
          document.body.appendChild(ta);
          ta.select();
          ok = !!document.execCommand('copy');
          document.body.removeChild(ta);
        } catch (e) { ok = false; }
        done(ok);
      };
      var nav = W.navigator;
      if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
        var p;
        try { p = nav.clipboard.writeText(text); } catch (e) { fallback(); return; }
        Promise.resolve(p).then(function () { done(true); }, fallback);
      } else fallback();
    }
    /** A cell for copied / exported text: no tabs or line breaks; a leading = + - @ is quoted (formula injection). */
    /**
     * The CSV exporter's formula-injection rule (ctg-chart-tools INJECTION_RE): a trigger after leading white
     * space, full-width / look-alike triggers, or a leading tab / line break (tested on the raw text too, not only
     * after tabs are turned into spaces).
     */
    var TSV_INJECTION_RE = /^[\s\u00a0\u2000-\u200b\u3000\ufeff]*[=+\-@\uff1d\uff0b\uff0d\uff20\u2212\ufe62\ufe63]|^[\t\r\n]/;
    function tsvCell(s) {
      var raw = String(s == null ? '' : s);
      var x = raw.replace(/[\t\r\n]+/g, ' ');
      return TSV_INJECTION_RE.test(raw) || TSV_INJECTION_RE.test(x) ? "'" + x : x;
    }

    /**
     * Refresh-rate field: a draft string committed on Enter / blur / Apply, never on every
     * keystroke; 0 = off, otherwise clamped to [250, 3 600 000] ms; anything else shows the inline error and
     * writes nothing.
     */
    class RefreshRateForm extends RComponent {
      constructor(props) {
        super(props);
        this.state = { draft: String(props.value), error: null };
        this.id = NS.util.uid('ctg-rate');
      }
      commit() {
        var raw = String(this.state.draft).trim().replace(/[\s  _]/g, '');
        if (!/^\d{1,9}$/.test(raw)) { this.setState({ error: NS.i18n.t('chart.rate.invalid') }); return; }
        var n = Number(raw);
        if (n > 3600000) { this.setState({ error: NS.i18n.t('chart.rate.invalid') }); return; }
        var v = n === 0 ? 0 : Math.max(250, n);
        this.setState({ draft: String(v), error: null });
        this.props.onCommit(v);
      }
      render() {
        var self = this;
        return h('form', {
          className: 'ctg-rate', 'data-ctg': 'refresh-rate',
          onSubmit: function (e) { e.preventDefault(); self.commit(); },
        }, h(NS.ui.Field, { id: this.id, label: NS.i18n.t('chart.rate.label'), help: NS.i18n.t('chart.rate.help'), error: this.state.error },
          h('input', {
            id: this.id, type: 'text', inputMode: 'numeric', autoComplete: 'off', className: 'ctg-input', value: this.state.draft,
            onChange: function (e) { self.setState({ draft: e.target.value, error: null }); },
            onBlur: function () { if (String(self.state.draft) !== String(self.props.value)) self.commit(); },
          })),
        h('div', { className: 'ctg-rate__actions' }, h(NS.ui.Button, { kind: 'primary', type: 'submit' }, NS.i18n.t('chart.rate.apply'))));
      }
    }

    /* ========================================================================
     * SECTION 18 / ChartInteraction — gestures, X-Trace, range brushes
     * ----------------------------------------------------------------------
     * User-facing behaviour: docs/user-guide/components/ctg-chart/interaction.md.
     * One controller per chart; it attaches Pointer Event handlers to every
     * plot's uPlot `over` element when the
     * PlotManager (re)creates a plot (pm.on('create')), draws pinned traces
     * and brushes through pm.overlays (canvas, no DOM text) and keeps the
     * X-Trace info box (DOM, createElement + textContent only).
     *
     *   mode        mouse / pen                    touch                       wheel
     *   xTrace      hover = cursor + info box;     tap = cursor; long-press    page scroll
     *               click pins (click a pinned     = pin / unpin; drag a
     *               line removes it); drag a       pinned line moves it;
     *               pinned line moves it           double-tap = pin / unpin
     *   pan         drag pans (live preview)       1 finger pans, 2 pinch      zoom around the pointer
     *   zoom        drag a box (x only, >= 5 px)   1 finger box, 2 pinch       zoom around the pointer
     *   rangeBrush  drag = new brush; drag a body moves it, an edge (6 px, touch 16 px) resizes it; click
     *               selects; double-click removes; Delete removes the selected one
     *   annotate    click = note at that time (editor popover, pen nearest the pointer); drag = range; click a
     *               note flag / range strip (or a note line) = open it. Everywhere: hovering a flag /
     *               strip shows the note (DOM tooltip, textContent only); a touch tap on one shows it too.
     *   double-click in pan / zoom = reset zoom. touch-action: pan-y in xTrace (the page still scrolls
     *   vertically), none in the other modes. Keyboard on the focused plot area (interaction.keyboard):
     *   arrows pan 10 % (Shift 50 %), + / - zoom x1.5 around the centre, Home = reset, X / Shift+X walk the
     *   value cursor through the data, Enter pins it, Delete removes the selected brush / trace, Esc cancels.
     *
     * A gesture never re-renders React per frame: it previews by moving the uPlot scales (PlotManager.
     * preview, rAF-throttled) and hands the final view to the engine at its end (engine.viewport.set ->
     * free-range re-query, follow-live decision, onRangeChange). Gestures are off in Designer design mode
     * (host.canInteract()).
     *
     * Pinned traces live in interaction.xTrace.values ({time} while not following live, {fromEndMs} while
     * following, so they slide with the window), brushes in interaction.rangeBrush.values ({id, start, end,
     * plot}); both are written whole (never in the Designer) and an external binding that
     * changes them is adopted (host.adoptInteraction). Events: onXTraceChange {times, count},
     * onBrushChange {id, start, end, plot, action}.
     * ====================================================================== */
    // exact brush statistics. One object, read at use time (Node tests shorten the timings).
    var EXACT = {
      cache: 8,                            // cached entries (one per brush geometry + pen set), LRU
      retries: 3,                          // retries of a busy / timeout / network answer (with backoff)
      failedTtlMs: 30000,                  // a transiently failed selected brush is fetched again after this (timer)
      // the cached raw samples count against the chart's memory: at most this share of ENGINE.maxHeldPoints,
      // and never more than what the engine leaves free of it (the selected entry is kept while selected anyway)
      pointsShare: 0.25,
    };
    var EXACT_RETRYABLE = { TOO_MANY_REQUESTS: true, RATE_LIMITED: true, BUSY: true, MODULE_STOPPING: true, TIMEOUT: true,
      CLIENT_TIMEOUT: true, NETWORK: true, NETWORK_ERROR: true, HTTP_429: true, HTTP_503: true, HTTP_504: true };
    /**
     * Per-pen statuses of a history answer that are worth asking again: the gateway or the
     * client gave up on time or load. Every other non-ok status (error, accessDenied, notFound, outOfScope, noHistory,
     * unsupportedType, invalidPath …) is a definitive answer for that pen: asking again gives the same.
     */
    var EXACT_TRANSIENT_PEN = { timeout: true, busy: true, aborted: true, cancelled: true };
    /** The geometry part of an exact-stats key (a brush moved or resized is another geometry). */
    function exactBrushKey(b) { return b.id + '|' + b.start + '|' + b.end; }
    /** Raw points held by one exact-stats entry. */
    function exactPoints(ex) {
      var n = 0;
      for (var k in ex.views) if (hasOwn.call(ex.views, k)) n += ex.views[k].view.t.length;
      return n;
    }
    var IX = {
      clickSlopPx: 4,                      // a press that moved less is a click
      minBoxPx: 5,                         // zoom box / new brush minimum width
      hitPx: { mouse: 6, touch: 16 },      // brush edges and pinned trace lines
      wheelIdleMs: 250,                    // wheel zoom commits after this pause
      wheelBase: 1.2,                      // factor 1.2^(deltaY / 100)
      keyPan: 0.1, keyPanShift: 0.5, keyZoom: 1.5,
      longPressMs: 500,
      boxGap: 12,                          // info box distance from the cursor
    };
    var BRUSH_ID_RE = /^b(\d+)$/;
    // annotation markers: a note = vertical line + a flag at the top; a range = band + top strip
    var ANN_GEOM = { flagW: 10, flagH: 9, stripH: 2, hitTopPx: 16, bandAlpha: 0.12 };

    /** Normalized pinned traces from props (entries with a finite time or fromEndMs). */
    function normTraces(list) {
      return (Array.isArray(list) ? list : []).filter(function (x) {
        return x && (NS.util.isFiniteNum(x.time) || NS.util.isFiniteNum(x.fromEndMs));
      }).map(function (x) {
        return NS.util.isFiniteNum(x.time) ? { time: Math.round(x.time), fromEndMs: null } : { time: null, fromEndMs: Math.round(x.fromEndMs) };
      });
    }
    /** Normalized brushes from props: finite start < end, a string id (generated when missing, unique). */
    function normBrushes(list, max) {
      var seen = {};
      var out = [];
      (Array.isArray(list) ? list : []).forEach(function (x) {
        if (!x || !NS.util.isFiniteNum(x.start) || !NS.util.isFiniteNum(x.end)) return;
        var a = Math.min(x.start, x.end), b = Math.max(x.start, x.end);
        if (!(b > a)) return;
        var id = typeof x.id === 'string' && x.id && !seen[x.id] ? x.id : null;
        out.push({ id: id, start: Math.round(a), end: Math.round(b), plot: Math.max(0, Math.min(7, x.plot | 0)) });
        if (id) seen[id] = true;
      });
      out.forEach(function (br) { if (!br.id) br.id = nextBrushId(out); });
      return max > 0 ? out.slice(0, max) : out;
    }
    function nextBrushId(list) {
      var n = 0;
      list.forEach(function (br) { var m = br.id && BRUSH_ID_RE.exec(br.id); if (m) n = Math.max(n, +m[1]); });
      return 'b' + (n + 1);
    }
    /** Brush span as "12 m 29 s" (pen-table brush header). */
    function durationText(ms) {
      var s = Math.round(ms / 1000);
      var d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
      var parts = [];
      if (d) parts.push(d + ' d');
      if (hh) parts.push(hh + ' h');
      if (mm && !d) parts.push(mm + ' m');
      if (!d && !hh) parts.push(ss + ' s');
      return parts.join(' ') || (Math.round(ms) + ' ms');
    }
    /** The X-Trace value kind of a pen: interpolated line, held step value, nearest point. */
    function traceKind(vm) {
      if (vm.drawType === 'scatter' || vm.drawType === 'bar') return 'nearest';
      if (vm.isBool || vm.interp === 'stepAfter') return 'step';
      if (vm.interp === 'stepBefore') return 'before';
      if (vm.interp === 'stepCenter') return 'center';
      return 'linear';
    }

    function ChartInteraction(host) {
      var ip = host.props.props.interaction;
      this.host = host;
      this.recs = new Map();          // plot record -> {offs[], box, rows: Map}
      this.g = null;                  // the active gesture
      this.pointers = new Map();      // pointerId -> {clientX, clientY, type}
      this.preview = null;            // the view drawn while a gesture runs (null = the engine's)
      this.wheel = null;              // {view, timer}
      this.hoverRec = null;
      this.hoverT = null;             // time under the hover / keyboard cursor
      this.kbd = null;                // {rec, t} keyboard cursor (X key)
      this.traces = normTraces(ip.xTrace.values);
      this.brushes = normBrushes(ip.rangeBrush.values, ip.rangeBrush.max);
      this.selBrush = this.brushes.length ? this.brushes[this.brushes.length - 1].id : null;
      this.temp = null;               // {brush} or {trace: idx, time} while a drag edits them
      this.lastPointerType = 'mouse';
      this.listeners = [];            // X-Trace column cells
      this._raf = 0;
      this._notifyRaf = 0;
      this.metrics = { frames: 0, frameMs: [], commits: 0 };
      this.disposed = false;
    }

    // ---- wiring -------------------------------------------------------------------------------------------
    /** Hooks a (new) PlotManager: per-plot listeners, the cursor hook and the overlay drawer. */
    ChartInteraction.prototype.bind = function (pm) {
      var self = this;
      this.recs.forEach(function (st, rec) { self.detach(rec); });
      pm.on('create', function (rec) { self.attach(rec); });
      pm.on('destroy', function (rec) { self.detach(rec); });
      pm.on('cursor', function (u, rec) { self._onCursor(u, rec); });
      pm.overlays.push(function (u, rec, ctx) { self.draw(u, rec, ctx); });
    };
    ChartInteraction.prototype.attach = function (rec) {
      var self = this;
      if (this.recs.has(rec) || !rec.u || !rec.u.over) return;
      var over = rec.u.over;
      var st = { offs: [], box: null, rows: new Map() };
      var on = function (type, fn, opt) {
        over.addEventListener(type, fn, opt);
        st.offs.push(function () { over.removeEventListener(type, fn, opt); });
      };
      on('pointerdown', function (e) { self._down(rec, e); });
      on('pointermove', function (e) { self._move(rec, e); });
      on('pointerup', function (e) { self._up(rec, e); });
      on('pointercancel', function (e) { self._cancel(e); });
      // capture lost without a pointerup (element re-parented, browser took the pointer): the same as a cancel
      on('lostpointercapture', function (e) { if (self.pointers.has(e.pointerId)) self._cancel(e); });
      on('pointerenter', function (e) { if (e.pointerType === 'mouse' || !e.pointerType) { self.hoverRec = rec; self.kbd = null; } });
      // a mouse leaving hides the box; after a touch tap the cursor and its box stay (tap = cursor at the finger)
      on('pointerleave', function (e) {
        if ((e.pointerType === 'mouse' || !e.pointerType) && self.hoverRec === rec) { self.hoverRec = null; if (!self.kbd) self._hideHover(); }
        self._hideAnnTip(rec);
      });
      on('wheel', function (e) { self._wheel(rec, e); }, { passive: false });
      on('dblclick', function (e) { self._dbl(rec, e); });
      on('contextmenu', function (e) { if (self.g && self.g.type !== 'mouse') e.preventDefault(); });
      st.offs.push(NS.ui.longPress(over, { ms: IX.longPressMs, onLongPress: function (pt) { self._longPress(rec, pt); } }));
      this.recs.set(rec, st);
      this._touchAction(rec);
    };
    ChartInteraction.prototype.detach = function (rec) {
      var st = this.recs.get(rec);
      if (!st) return;
      st.offs.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
      if (st.box && st.box.parentNode) st.box.parentNode.removeChild(st.box);
      if (st.tip && st.tip.parentNode) st.tip.parentNode.removeChild(st.tip);
      this.recs.delete(rec);
      if (this.hoverRec === rec) this.hoverRec = null;
      if (this.kbd && this.kbd.rec === rec) this.kbd = null;
      var self = this;
      this.pointers.forEach(function (pt, id) { if (pt.rec === rec) self.pointers.delete(id); });
      // The plot of a running gesture goes away (rebuild: a pen joined, a plot was added): its pointerup will
      // never come, so the gesture, its preview (which pauses the live slide and wins in _buildVM) and the
      // temporary brush / trace are dropped now. The PlotManager is mid-update here, so the
      // engine's view is handed back on the next frame instead of synchronously.
      if (this.g && this.g.rec === rec) this._dropGesture();
    };
    /** cancelGesture without touching the PlotManager now (it may be destroying / creating plots). */
    ChartInteraction.prototype._dropGesture = function () {
      var self = this;
      var had = !!this.g || !!this.preview || !!this.temp;
      this.g = null;
      this.temp = null;
      this.preview = null;
      if (this._raf) { cancelRaf(this._raf); this._raf = 0; }
      if (this.wheel) { clearTimeout(this.wheel.timer); this.wheel = null; }
      if (!had || this.disposed) return;
      raf(function () {
        if (self.disposed || self.g || self.preview) return;
        var pm = self.host.pm, e = self.host.engine;
        if (pm && e) pm.preview(e.viewport.get());
        self._redraw();
        self.host.ixChanged();
      });
    };
    ChartInteraction.prototype.dispose = function () {
      var self = this;
      this.disposed = true;
      Array.from(this.recs.keys()).forEach(function (rec) { self.detach(rec); });
      if (this._raf) { cancelRaf(this._raf); this._raf = 0; }
      if (this._notifyRaf) { cancelRaf(this._notifyRaf); this._notifyRaf = 0; }
      if (this.wheel && this.wheel.timer) clearTimeout(this.wheel.timer);
      this.wheel = null;
      this.g = null;
      this.preview = null;
      this.temp = null;
      this.pointers.clear();
      this.listeners = [];
    };
    /** Mode switch (the uPlot instances stay): cancel what runs, touch-action, hide the info box. */
    ChartInteraction.prototype.modeChanged = function () {
      var self = this;
      this.cancelGesture();
      this.recs.forEach(function (st, rec) { self._touchAction(rec); });
      if (this.host.mode() !== 'xTrace') { this.kbd = null; this._hideHover(); }
      this._redraw();
    };
    ChartInteraction.prototype._touchAction = function (rec) {
      try { rec.u.over.style.touchAction = this.host.mode() === 'xTrace' ? 'pan-y' : 'none'; } catch (e) { /* ignore */ }
    };

    // ---- geometry -----------------------------------------------------------------------------------------
    /** The view drawn now: the gesture preview, else what the PlotManager shows (engine viewport / slide). */
    ChartInteraction.prototype.view = function () {
      if (this.preview) return this.preview;
      var pm = this.host.pm;
      return pm && pm.view ? pm.view : this.host.engine.viewport.get();
    };
    ChartInteraction.prototype._pos = function (rec, clientX, clientY) {
      var r = rec.u.over.getBoundingClientRect();
      return { x: clientX - r.left, y: clientY - r.top, w: Math.max(1, r.width), h: Math.max(1, r.height) };
    };
    ChartInteraction.prototype._timeAt = function (x, w, view) {
      var v = view || this.view();
      return v.min + (x / w) * (v.max - v.min);
    };
    ChartInteraction.prototype._xOf = function (t, w, view) {
      var v = view || this.view();
      return (t - v.min) / Math.max(1, v.max - v.min) * w;
    };
    /**
     * Resolved pinned trace times. {fromEndMs} is relative to the LIVE edge (as documented): the view's right edge
     * while it follows live, the gateway clock otherwise (so a pan does not move the trace; leaving live also freezes
     * such traces, see freezeTraces); in a historical chart the view's right edge.
     */
    ChartInteraction.prototype.traceTimes = function () {
      var e = this.host.engine;
      var vp = e ? e.viewport.get() : null;
      var end = vp && vp.max != null ? vp.max : NS.clock.now();
      if (e && vp && !vp.followLive && e._realtime && e._realtime() && typeof e.gwNow === 'function') end = e.gwNow();
      var temp = this.temp;
      return this.traces.map(function (tr, i) {
        if (temp && temp.trace === i) return temp.time;
        return tr.time != null ? tr.time : end - tr.fromEndMs;
      });
    };
    /** Committed brushes, with the one being drawn / moved replaced by its temporary version. */
    ChartInteraction.prototype.brushList = function () {
      var t = this.temp && this.temp.brush;
      if (!t) return this.brushes;
      var hit = false;
      var out = this.brushes.map(function (br) { if (br.id === t.id) { hit = true; return t; } return br; });
      if (!hit) out = out.concat([t]);
      return out;
    };
    ChartInteraction.prototype.brushById = function (id) {
      for (var i = 0; i < this.brushes.length; i++) if (this.brushes[i].id === id) return this.brushes[i];
      return null;
    };
    ChartInteraction.prototype._plotOf = function (br) {
      var n = this.host.pm ? this.host.pm.plots.length : 1;
      return Math.min(br.plot | 0, Math.max(0, n - 1));
    };
    /** Brush under x (CSS px of rec): {brush, edge: 'start' | 'end' | null} or null. */
    ChartInteraction.prototype._hitBrush = function (rec, x, w, touch) {
      var tol = touch ? IX.hitPx.touch : IX.hitPx.mouse;
      var self = this;
      var best = null;
      // the selected brush first (it is drawn on top), then newest first
      var list = this.brushes.slice().reverse().sort(function (a, b) { return (b.id === self.selBrush) - (a.id === self.selBrush); });
      for (var i = 0; i < list.length; i++) {
        var br = list[i];
        if (this._plotOf(br) !== rec.index) continue;
        var xs = this._xOf(br.start, w), xe = this._xOf(br.end, w);
        if (Math.abs(x - xs) <= tol) { best = { brush: br, edge: 'start' }; break; }
        if (Math.abs(x - xe) <= tol) { best = { brush: br, edge: 'end' }; break; }
        if (x > xs && x < xe) { best = { brush: br, edge: null }; break; }
      }
      return best;
    };
    /** Pinned trace near x: its index, or -1. */
    ChartInteraction.prototype._hitTrace = function (x, w, touch) {
      var tol = touch ? IX.hitPx.touch : IX.hitPx.mouse;
      var times = this.traceTimes();
      var best = -1, bd = Infinity;
      for (var i = 0; i < times.length; i++) {
        var d = Math.abs(this._xOf(times[i], w) - x);
        if (d <= tol && d < bd) { bd = d; best = i; }
      }
      return best;
    };

    // ---- pointer gestures ---------------------------------------------------------------------------------
    ChartInteraction.prototype._down = function (rec, e) {
      if (!this.host.canInteract()) return;
      var type = e.pointerType || 'mouse';
      if (type === 'mouse' && e.button !== 0) return;
      var mode = this.host.mode();
      if (mode !== 'pan' && mode !== 'zoom' && mode !== 'rangeBrush' && mode !== 'xTrace' && mode !== 'annotate') return;
      this.lastPointerType = type;
      // A primary pointer starts a new contact set: entries left by pointers whose up / cancel never arrived
      // must not turn the next single touch into a pinch.
      if (e.isPrimary) {
        var self0 = this;
        this.pointers.forEach(function (pt, id) { if (pt.type === type && id !== e.pointerId && !(self0.g && self0.g.id === id)) self0.pointers.delete(id); });
      }
      if (mode === 'xTrace') { this.hoverRec = rec; this.kbd = null; }
      this.host.focusPlots();
      var pinchable = type === 'touch' && (mode === 'pan' || mode === 'zoom');
      if (this.g && !(pinchable && this.g.type === 'touch' && this.g.kind !== 'pinch' && this.pointers.size === 1)) return;   // one gesture at a time
      this.pointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY, type: type, rec: rec });
      if (this.pointers.size === 2 && pinchable) {
        this._startPinch(rec);
        try { rec.u.over.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
        e.preventDefault();
        return;
      }
      if (this.pointers.size > 1) { this.pointers.delete(e.pointerId); return; }
      var p = this._pos(rec, e.clientX, e.clientY);
      var touch = type !== 'mouse';
      var view = this.view();
      var g = { rec: rec, id: e.pointerId, type: type, x0: p.x, x: p.x, y0: p.y, w: p.w, h: p.h, moved: false,
        view0: { min: view.min, max: view.max }, t0: this._timeAt(p.x, p.w, view), kind: null,
        clientX: e.clientX, clientY: e.clientY };
      if (mode === 'pan') g.kind = 'pan';
      else if (mode === 'zoom') g.kind = 'zoomBox';
      else if (mode === 'rangeBrush') {
        var hit = this._hitBrush(rec, p.x, p.w, touch);
        if (hit) { g.kind = hit.edge ? 'brushResize' : 'brushMove'; g.brush = Object.assign({}, hit.brush); g.edge = hit.edge; }
        else g.kind = 'brushNew';
      } else if (mode === 'xTrace') {
        var ti = this._hitTrace(p.x, p.w, touch);
        if (ti >= 0) { g.kind = 'traceDrag'; g.trace = ti; } else g.kind = 'traceClick';
      } else if (mode === 'annotate') {
        // annotate: press on a marker = open it on release; elsewhere = a new note (click) or range (drag)
        var ah = this._hitAnnotation(rec, p.x, p.y, p.w, touch, true);
        g.kind = ah ? 'annHit' : 'annNew';
        g.ann = ah;
      }
      this.g = g;
      try { rec.u.over.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      // no text selection / native drag; xTrace keeps the page's vertical scrolling on touch (touch-action pan-y)
      if (mode !== 'xTrace' || g.kind === 'traceDrag') e.preventDefault();
    };
    ChartInteraction.prototype._move = function (rec, e) {
      var pt = this.pointers.get(e.pointerId);
      if (pt) { pt.clientX = e.clientX; pt.clientY = e.clientY; }
      var g = this.g;
      if (!g) {
        if (e.pointerType === 'mouse' || !e.pointerType) { this.hoverRec = rec; this.kbd = null; }
        if (e.pointerType !== 'touch') this._annHover(rec, e.clientX, e.clientY);
        return;
      }
      if (g.kind === 'pinch') { this._frameSoon(); return; }
      if (e.pointerId !== g.id) return;
      var p = this._pos(g.rec, e.clientX, e.clientY);
      g.x = p.x;
      if (!g.moved && Math.abs(p.x - g.x0) >= IX.clickSlopPx) g.moved = true;
      if (g.moved) this._frameSoon();
    };
    ChartInteraction.prototype._frameSoon = function () {
      var self = this;
      if (this._raf) return;
      this._raf = raf(function () { self._raf = 0; self._frame(); });
    };
    /** Applies the latest pointer position of the running gesture (one per animation frame). */
    ChartInteraction.prototype._frame = function () {
      var g = this.g;
      if (!g || this.disposed) return;
      var t0 = perfNow();
      var engine = this.host.engine;
      var v0 = g.view0, span0 = v0.max - v0.min;
      switch (g.kind) {
        case 'pan': {
          var dt = -(g.x - g.x0) / g.w * span0;
          this._setPreview(engine.clampView({ min: v0.min + dt, max: v0.max + dt }));
          break;
        }
        case 'zoomBox': {
          var xa = NS.util.clamp(Math.min(g.x0, g.x), 0, g.w), xb = NS.util.clamp(Math.max(g.x0, g.x), 0, g.w);
          try { g.rec.u.setSelect({ left: xa, top: 0, width: xb - xa, height: g.h }, false); } catch (e) { /* ignore */ }
          break;
        }
        case 'brushNew': {
          var tn = this._timeAt(NS.util.clamp(g.x, 0, g.w), g.w);
          var id = g.newId || (g.newId = nextBrushId(this.brushes));
          this.temp = { brush: { id: id, start: Math.min(g.t0, tn), end: Math.max(g.t0, tn), plot: g.rec.index } };
          this._redraw();
          break;
        }
        case 'brushMove': {
          var dm = (g.x - g.x0) / g.w * span0;
          this.temp = { brush: { id: g.brush.id, start: g.brush.start + dm, end: g.brush.end + dm, plot: g.brush.plot } };
          this._redraw();
          break;
        }
        case 'brushResize': {
          var tr = this._timeAt(NS.util.clamp(g.x, 0, g.w), g.w);
          var a = g.edge === 'start' ? tr : g.brush.start, b = g.edge === 'end' ? tr : g.brush.end;
          this.temp = { brush: { id: g.brush.id, start: Math.min(a, b), end: Math.max(a, b), plot: g.brush.plot } };
          this._redraw();
          break;
        }
        case 'traceDrag':
          this.temp = { trace: g.trace, time: this._timeAt(NS.util.clamp(g.x, 0, g.w), g.w) };
          this._redraw();
          this._notify();
          break;
        case 'annNew':
        case 'annHit': {
          // dragging (also from a marker) draws a new range
          var ta = this._timeAt(NS.util.clamp(g.x, 0, g.w), g.w);
          this.temp = { annRange: { start: Math.min(g.t0, ta), end: Math.max(g.t0, ta), plot: g.rec.index } };
          this._redraw();
          break;
        }
        case 'pinch':
          this._pinchFrame();
          break;
        default: break;
      }
      this.metrics.frames++;
      perfPush(this.metrics.frameMs, perfNow() - t0);
    };
    ChartInteraction.prototype._up = function (rec, e) {
      var g = this.g;
      this.pointers.delete(e.pointerId);
      if (!g) return;
      if (g.kind === 'pinch') {
        if (this.pointers.size < 2) { this.g = null; this._commitPreview(); }
        return;
      }
      if (e.pointerId !== g.id) return;
      try { g.rec.u.over.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ }
      if (this._raf) { cancelRaf(this._raf); this._raf = 0; }
      var p = this._pos(g.rec, e.clientX, e.clientY);
      g.x = p.x;
      if (!g.moved && Math.abs(p.x - g.x0) >= IX.clickSlopPx) g.moved = true;
      if (g.moved && g.kind !== 'zoomBox' && g.kind !== 'traceClick') this._frame();
      this.g = null;
      var v0 = g.view0;
      switch (g.kind) {
        case 'pan':
          if (g.moved) this._commitPreview(); else this._clearPreview();
          break;
        case 'zoomBox': {
          try { g.rec.u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false); } catch (err) { /* ignore */ }
          var xa = NS.util.clamp(Math.min(g.x0, g.x), 0, g.w), xb = NS.util.clamp(Math.max(g.x0, g.x), 0, g.w);
          if (xb - xa >= IX.minBoxPx) this.host.commitView({ min: this._timeAt(xa, g.w, v0), max: this._timeAt(xb, g.w, v0) });
          break;
        }
        case 'brushNew': {
          var nb = this.temp && this.temp.brush;
          this.temp = null;
          if (g.moved && nb && this._xOf(nb.end, g.w) - this._xOf(nb.start, g.w) >= IX.minBoxPx) this.addBrush(nb);
          else if (!g.moved && this.selBrush) { this.selBrush = null; this.host.ixChanged(); }
          this._redraw();
          break;
        }
        case 'brushMove':
        case 'brushResize': {
          var mb = this.temp && this.temp.brush;
          this.temp = null;
          if (g.moved && mb) this.updateBrush(mb);
          else { this.selBrush = g.brush.id; this.host.ixChanged(); }
          this._redraw();
          break;
        }
        case 'traceDrag': {
          var tt = this.temp ? this.temp.time : null;
          this.temp = null;
          if (g.moved && tt != null) this.moveTrace(g.trace, tt);
          else if (g.type === 'mouse') this.removeTrace(g.trace);       // a click on a pinned line removes it
          this._redraw();
          break;
        }
        case 'traceClick':
          if (!g.moved && g.type === 'mouse') this.pin(g.t0);
          else if (!g.moved) this._annTapTip(g);          // touch: a tap on a marker shows its note
          break;
        case 'annNew':
        case 'annHit': {
          var ar = this.temp && this.temp.annRange;
          this.temp = null;
          this._redraw();
          var anchor = { clientX: e.clientX, clientY: e.clientY };
          if (g.moved && ar && this._xOf(ar.end, g.w, v0) - this._xOf(ar.start, g.w, v0) >= IX.minBoxPx) {
            this.host.openAnnotation({ mode: 'add', type: 'range', start: Math.round(ar.start), end: Math.round(ar.end), rec: g.rec,
              penKey: this._nearestPen(g.rec, (ar.start + ar.end) / 2, g.y0), anchor: anchor });
          } else if (!g.moved && g.kind === 'annHit' && g.ann) {
            this.host.openAnnotation({ mode: 'edit', item: g.ann, rec: g.rec, anchor: anchor });
          } else if (!g.moved) {
            this.host.openAnnotation({ mode: 'add', type: 'note', start: Math.round(g.t0), rec: g.rec,
              penKey: this._nearestPen(g.rec, g.t0, g.y0), anchor: anchor });
          }
          break;
        }
        default: break;
      }
    };
    ChartInteraction.prototype._cancel = function (e) {
      this.pointers.delete(e.pointerId);
      if (this.g && (this.g.id === e.pointerId || this.g.kind === 'pinch')) this.cancelGesture();
    };
    /** Drops the running gesture without applying it (Escape, pointercancel, mode switch). */
    ChartInteraction.prototype.cancelGesture = function () {
      var g = this.g;
      this.g = null;
      if (this._raf) { cancelRaf(this._raf); this._raf = 0; }
      if (g && g.kind === 'zoomBox') { try { g.rec.u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false); } catch (e) { /* ignore */ } }
      if (this.wheel) { clearTimeout(this.wheel.timer); this.wheel = null; }
      this.temp = null;
      var had = !!this.preview;
      this._clearPreview();
      if (g || had) this._redraw();
      return !!g || had;
    };

    // ---- pinch (two touch pointers) -----------------------------------------------------------------------
    ChartInteraction.prototype._touchPair = function () {
      var list = [];
      this.pointers.forEach(function (p) { if (p.type === 'touch') list.push(p); });
      return list.length >= 2 ? list.slice(0, 2) : null;
    };
    ChartInteraction.prototype._startPinch = function (rec) {
      var pair = this._touchPair();
      if (!pair) return;
      if (this.g && this.g.kind === 'zoomBox') { try { this.g.rec.u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false); } catch (e) { /* ignore */ } }
      this.temp = null;
      var view = this.g && this.g.view0 ? this.g.view0 : this.view();     // a one-finger pan just started: from its origin
      var r = rec.u.over.getBoundingClientRect();
      var mx = (pair[0].clientX + pair[1].clientX) / 2 - r.left;
      this.g = { kind: 'pinch', rec: rec, w: Math.max(1, r.width), view0: { min: view.min, max: view.max },
        d0: Math.max(10, Math.abs(pair[0].clientX - pair[1].clientX)), tf: this._timeAt(mx, Math.max(1, r.width), view), moved: true };
    };
    ChartInteraction.prototype._pinchFrame = function () {
      var g = this.g;
      var pair = this._touchPair();
      if (!pair) return;
      var r = g.rec.u.over.getBoundingClientRect();
      var d = Math.max(10, Math.abs(pair[0].clientX - pair[1].clientX));
      var mx = (pair[0].clientX + pair[1].clientX) / 2 - r.left;
      var span = (g.view0.max - g.view0.min) * g.d0 / d;
      var a = g.tf - (mx / g.w) * span;
      this._setPreview(this.host.engine.clampView({ min: a, max: a + span, focal: g.tf }));
    };

    // ---- wheel, double-click, long-press ---------------------------------------------------------------------
    ChartInteraction.prototype._wheel = function (rec, e) {
      var mode = this.host.mode();
      var p = this.host.props.props;
      if (!this.host.canInteract() || (mode !== 'pan' && mode !== 'zoom') || !p.interaction.panAndZoom.wheelZoom) return;
      e.preventDefault();
      if (this.g && this.g.kind !== 'pan') return;
      var self = this;
      var dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);
      if (!dy) return;
      var k = Math.pow(IX.wheelBase, dy / 100);
      var v = this.wheel ? this.wheel.view : this.view();
      var pos = this._pos(rec, e.clientX, e.clientY);
      var f = v.min + NS.util.clamp(pos.x / pos.w, 0, 1) * (v.max - v.min);
      var nv = this.host.engine.clampView({ min: f - (f - v.min) * k, max: f + (v.max - f) * k, focal: f });
      if (this.wheel) clearTimeout(this.wheel.timer);
      this.wheel = {
        view: nv,
        timer: setTimeout(function () { self.wheel = null; if (!self.disposed && !self.g) self._commitPreview(); }, IX.wheelIdleMs),
      };
      this._setPreview(nv);
    };
    ChartInteraction.prototype._dbl = function (rec, e) {
      if (!this.host.canInteract()) return;
      var mode = this.host.mode();
      var p = this._pos(rec, e.clientX, e.clientY);
      if (mode === 'pan' || mode === 'zoom') {
        e.preventDefault();
        this.cancelGesture();
        this.host.resetZoom();
      } else if (mode === 'rangeBrush') {
        var hit = this._hitBrush(rec, p.x, p.w, this.lastPointerType !== 'mouse');
        if (hit) this.removeBrush(hit.brush.id);
      } else if (mode === 'xTrace' && this.lastPointerType !== 'mouse') {
        // touch / pen: a double-tap pins or unpins (mouse clicks already do; their dblclick changes nothing)
        this._togglePinAt(rec, p.x, p.w);
      } else if (mode === 'annotate') {
        e.preventDefault();       // the first click already opened the editor (or added); nothing else to do
      }
    };
    ChartInteraction.prototype._longPress = function (rec, pt) {
      if (!this.host.canInteract() || this.host.mode() !== 'xTrace') return;
      if (this.g && this.g.moved) return;
      this.g = null;
      var p = this._pos(rec, pt.x, pt.y);
      this._togglePinAt(rec, p.x, p.w);
    };
    ChartInteraction.prototype._togglePinAt = function (rec, x, w) {
      var ti = this._hitTrace(x, w, true);
      if (ti >= 0) this.removeTrace(ti); else this.pin(this._timeAt(x, w));
    };

    // ---- annotations: hit-testing, nearest pen, tooltip --------------------------------------------------------
    /**
     * The annotation under (x, y) of plot `rec` (CSS px of rec's plot area), or null: a note's flag (top
     * ANN_GEOM.hitTopPx px, from the line to the flag's right edge) or a range's top strip; with `line` (annotate
     * mode) anywhere on a note's line. Notes win over ranges; the nearest wins.
     */
    ChartInteraction.prototype._hitAnnotation = function (rec, x, y, w, touch, line) {
      var items = this.host.annotationItems ? this.host.annotationItems(rec, this.view()) : [];
      if (!items.length) return null;
      var tol = touch ? IX.hitPx.touch : IX.hitPx.mouse;
      var top = y <= ANN_GEOM.hitTopPx + (touch ? 8 : 0);
      var best = null, bd = Infinity;
      for (var i = 0; i < items.length; i++) {
        var a = items[i];
        var xs = this._xOf(a.start, w);
        if (a.type === 'note') {
          var d = x < xs ? xs - x : x > xs + ANN_GEOM.flagW ? x - xs - ANN_GEOM.flagW : 0;
          var onFlag = top && d <= tol;
          var onLine = line && Math.abs(x - xs) <= tol;
          if ((onFlag || onLine) && d < bd + 0.5) { bd = d; best = a; }
        } else if (!best || best.type !== 'note') {
          var xe = this._xOf(a.end, w);
          if (top && x >= xs - tol && x <= xe + tol) {
            var dr = Math.abs(x - (xs + xe) / 2) / Math.max(1, xe - xs);
            if (!best || dr < bd) { bd = dr; best = a; }
          }
        }
      }
      return best;
    };
    /**
     * The pen a new note belongs to by default: of the plot's visible pens with history, the one
     * whose line is nearest the pointer at time t (CSS px; y = pointer y in the plot area); else the first.
     */
    ChartInteraction.prototype._nearestPen = function (rec, t, y) {
      var host = this.host;
      var u = rec.u;
      var best = null, bd = Infinity, first = null;
      (rec.pv.pens || []).forEach(function (vm, i) {
        if (!vm.visible || !host.annotationPenOk(vm.key)) return;
        if (!first) first = vm.key;
        var v = host.engine.valueAt(vm.key, t, traceKind(vm));
        var sc = u.series[i + 1] && u.series[i + 1].scale;
        if (typeof v !== 'number' || !isFinite(v) || !sc) return;
        var py;
        try { py = u.valToPos(v, sc); } catch (e) { return; }
        var d = Math.abs(py - y);
        if (isFinite(d) && d < bd) { bd = d; best = vm.key; }
      });
      return best || first;
    };
    /** Mouse / pen hover: the note under the pointer in a tooltip (hidden while a gesture runs). */
    ChartInteraction.prototype._annHover = function (rec, clientX, clientY) {
      if (!this.host.annotationItems) return;
      var p = this._pos(rec, clientX, clientY);
      var a = this._hitAnnotation(rec, p.x, p.y, p.w, false, this.host.mode() === 'annotate');
      if (a) this._showAnnTip(rec, a, p.x); else this._hideAnnTip(rec);
    };
    /** A touch tap (no movement) in a mode without its own tap action: show the note under the finger. */
    ChartInteraction.prototype._annTapTip = function (g) {
      var a = this._hitAnnotation(g.rec, g.x0, g.y0, g.w, true, false);
      if (a) this._showAnnTip(g.rec, a, g.x0); else this._hideAnnTip(g.rec);
    };
    ChartInteraction.prototype._hideAnnTip = function (rec) {
      var st = this.recs.get(rec);
      if (st && st.tip) { st.tip.style.display = 'none'; st.tipFor = null; }
    };
    /** The tooltip of annotation `a` near x (DOM in u.over; createElement + textContent only). */
    ChartInteraction.prototype._showAnnTip = function (rec, a, x) {
      var st = this.recs.get(rec);
      if (!st) return;
      var host = this.host;
      if (!st.tip) {
        st.tip = document.createElement('div');
        st.tip.className = 'ctg-infobox ctg-anntip';
        st.tip.setAttribute('data-ctg', 'annotation-tip');
        st.tip.setAttribute('role', 'tooltip');
        st.tipHead = document.createElement('div');
        st.tipHead.className = 'ctg-infobox__time';
        st.tipText = document.createElement('div');
        st.tipText.className = 'ctg-anntip__text';
        st.tipMeta = document.createElement('div');
        st.tipMeta.className = 'ctg-anntip__meta';
        st.tip.appendChild(st.tipHead);
        st.tip.appendChild(st.tipText);
        st.tip.appendChild(st.tipMeta);
        rec.u.over.appendChild(st.tip);
      }
      var tz = host.engine ? host.engine.timeZone : null;
      var pat = 'YYYY-MM-DD HH:mm:ss';
      var when = NS.time.format(a.start, pat, tz) + (a.type === 'range' ? ' – ' + NS.time.format(a.end, pat, tz) : '');
      st.tipHead.textContent = NS.i18n.t(a.type === 'range' ? 'chart.ann.range' : 'chart.ann.note') + ' · ' + when;
      st.tipText.textContent = String(a.text || '').slice(0, 1000);
      var who = a.author ? NS.i18n.t('chart.ann.by', { author: a.author }) : NS.i18n.t('chart.ann.unknownAuthor');
      st.tipMeta.textContent = host.annotationPenLabel(a.penKey) + ' · ' + who + (a.pending ? ' · ' + NS.i18n.t('chart.ann.saving') : '');
      st.tip.setAttribute('data-ann-id', a.id || '');
      st.tipFor = a;
      var tip = st.tip;
      tip.style.display = '';
      var ow = rec.u.over.clientWidth || 0;
      var tw = tip.offsetWidth || 220;
      var left = Math.max(0, Math.min(x + IX.boxGap, ow - tw - 2));
      if (x + IX.boxGap + tw > ow && x - IX.boxGap - tw >= 0) left = x - IX.boxGap - tw;
      tip.style.transform = 'translate(' + Math.round(left) + 'px,' + (ANN_GEOM.hitTopPx + 4) + 'px)';
    };

    // ---- preview / commit -------------------------------------------------------------------------------------
    ChartInteraction.prototype._setPreview = function (view) {
      this.preview = { min: view.min, max: view.max };
      var pm = this.host.pm;
      if (pm) pm.preview(this.preview);
      this._redraw();
      if (typeof this.host.previewChanged === 'function') this.host.previewChanged();     // the overview window follows
    };
    ChartInteraction.prototype._clearPreview = function () {
      if (!this.preview) return;
      this.preview = null;
      var pm = this.host.pm;
      var e = this.host.engine;
      if (pm && e) pm.preview(e.viewport.get());
      if (typeof this.host.previewChanged === 'function') this.host.previewChanged();
    };
    ChartInteraction.prototype._commitPreview = function () {
      var v = this.preview;
      if (!v) return;
      this.metrics.commits++;
      this.host.commitView(v);
    };

    // ---- X-Trace: hover box, pinned traces ----------------------------------------------------------------------
    ChartInteraction.prototype._onCursor = function (u, rec) {
      if (this.disposed || this.host.mode() !== 'xTrace') return;
      if (this.kbd ? this.kbd.rec !== rec : this.hoverRec !== rec) return;      // synced plots: the box follows the source
      var left = u.cursor.left;
      if (!(left >= 0)) { if (!this.kbd) this._hideHover(); return; }
      var t = this.kbd ? this.kbd.t : u.posToVal(left, 'x');
      this.hoverT = t;
      this._showBox(rec, t, left, u.cursor.top);
      this._notify();
    };
    ChartInteraction.prototype._hideHover = function () {
      this.recs.forEach(function (st) { if (st.box) st.box.style.display = 'none'; });
      if (this.hoverT != null) { this.hoverT = null; this._notify(); }
    };
    /** X-Trace value of a pen at t: {v, text, bad}. Lines hold their last value to now while following live. */
    ChartInteraction.prototype.valueFor = function (vm, t) {
      var e = this.host.engine;
      if (!e || t == null || !vm.drawable) return { v: undefined, text: '—', bad: false };
      var kind = traceKind(vm);
      var view = e.penView(vm.key);
      var tol = 0;
      if (kind === 'nearest') {
        var pd = e.penData(vm.key);
        var vw = this.view();
        var pm = this.host.pm;
        tol = Math.max(pd && pd.coverage && pd.coverage.bucketMs || 0, (vw.max - vw.min) / Math.max(1, pm ? pm.width : 1000) * 3);
      }
      var v = valueAt(view, t, kind, tol);
      var n = view.t.length;
      if (v === undefined && n && t >= view.t[n - 1] && e._realtime() && e.vp.followLive && this.host.props.props.appearance.extendToNow) {
        v = view.v[n - 1];
      }
      if (v === null) return { v: null, text: NS.i18n.t('chart.xtrace.bad'), bad: true };
      return { v: v, text: formatPenValue(v, vm, this.host.locale()), bad: false };
    };
    /** The time of the X-Trace column: hover / keyboard cursor, else the first pinned trace. */
    ChartInteraction.prototype.columnTime = function () {
      if (this.hoverT != null) return this.hoverT;
      var times = this.traceTimes();
      return times.length ? times[0] : null;
    };
    ChartInteraction.prototype.subscribe = function (fn) {
      var self = this;
      this.listeners.push(fn);
      return function () { var i = self.listeners.indexOf(fn); if (i >= 0) self.listeners.splice(i, 1); };
    };
    ChartInteraction.prototype._notify = function () {
      var self = this;
      if (this._notifyRaf || !this.listeners.length) return;
      this._notifyRaf = raf(function () {
        self._notifyRaf = 0;
        self.listeners.slice().forEach(function (fn) { try { fn(); } catch (e) { log.warn('x-trace listener failed', e); } });
      });
    };
    ChartInteraction.prototype._showBox = function (rec, t, left, top) {
      var p = this.host.props.props;
      var ib = p.interaction.xTrace.infoBox;
      var st = this.recs.get(rec);
      if (!st) return;
      if (!ib.visible) { if (st.box) st.box.style.display = 'none'; return; }
      var self = this;
      this.recs.forEach(function (s2, r2) { if (r2 !== rec && s2.box) s2.box.style.display = 'none'; });
      if (!st.box) {
        st.box = document.createElement('div');
        st.box.className = 'ctg-infobox';
        st.box.setAttribute('data-ctg', 'info-box');
        st.box.setAttribute('aria-hidden', 'true');           // the pen table's X-Trace column is the accessible equivalent
        st.timeEl = document.createElement('div');
        st.timeEl.className = 'ctg-infobox__time';
        st.box.appendChild(st.timeEl);
        rec.u.over.appendChild(st.box);
      }
      var box = st.box;
      box.style.display = '';
      var vw = this.view();
      var tz = this.host.engine ? this.host.engine.timeZone : null;
      st.timeEl.style.display = ib.timeVisible ? '' : 'none';
      if (ib.timeVisible) st.timeEl.textContent = NS.time.format(t, vw.max - vw.min < 10 * SECOND ? 'YYYY-MM-DD HH:mm:ss.SSS' : 'YYYY-MM-DD HH:mm:ss', tz);
      // one row per visible pen of every plot, in pen order (the same view models as the series)
      var pens = this.host.penVMs().filter(function (vm) { return vm.drawable && vm.visible; });
      var keep = {};
      pens.forEach(function (vm) {
        keep[vm.key] = true;
        var row = st.rows.get(vm.key);
        if (!row) {
          row = { el: document.createElement('div'), sw: document.createElement('span'), name: document.createElement('span'),
            val: document.createElement('span'), unit: document.createElement('span') };
          row.el.className = 'ctg-infobox__row';
          row.sw.className = 'ctg-infobox__sw';
          row.name.className = 'ctg-infobox__name';
          row.val.className = 'ctg-infobox__val';
          row.unit.className = 'ctg-infobox__unit';
          row.el.appendChild(row.sw); row.el.appendChild(row.name); row.el.appendChild(row.val); row.el.appendChild(row.unit);
          row.el.setAttribute('data-ctg-key', vm.key);
          st.rows.set(vm.key, row);
        }
        box.appendChild(row.el);                                // (re)appended in pen order
        row.sw.style.background = vm.color;
        row.name.textContent = vm.label;
        var r = self.valueFor(vm, t);
        row.val.textContent = r.text;
        row.val.className = 'ctg-infobox__val' + (r.bad ? ' ctg-infobox__val--bad' : '');
        row.unit.textContent = vm.units || '';
      });
      st.rows.forEach(function (row, key) { if (!keep[key]) { if (row.el.parentNode) row.el.parentNode.removeChild(row.el); st.rows.delete(key); } });
      // right of the cursor, flipped left near the right edge, clamped vertically inside the plot
      var ow = rec.u.over.clientWidth || 0, oh = rec.u.over.clientHeight || 0;
      var bw = box.offsetWidth || 0, bh = box.offsetHeight || 0;
      var x = left + IX.boxGap;
      if (x + bw > ow) x = Math.max(0, left - IX.boxGap - bw);
      var y = NS.util.clamp((top >= 0 ? top : oh / 2) - bh / 2, 0, Math.max(0, oh - bh));
      box.style.transform = 'translate(' + Math.round(x) + 'px,' + Math.round(y) + 'px)';
    };
    /** Pins a trace at t (interaction.xTrace.maxTraces; 0 = hover only). */
    ChartInteraction.prototype.pin = function (t) {
      var p = this.host.props.props;
      var max = p.interaction.xTrace.maxTraces;
      if (!(max > 0) || t == null || !isFinite(t)) return false;
      if (this.traces.length >= max) { NS.a11y.announce(NS.i18n.t('chart.xtrace.max', { n: max })); return false; }
      var e = this.host.engine;
      var vp = e.viewport.get();
      var live = e._realtime() && vp.followLive;
      this.traces = this.traces.concat([live ? { time: null, fromEndMs: Math.max(0, Math.round(vp.max - t)) } : { time: Math.round(t), fromEndMs: null }]);
      NS.a11y.announce(NS.i18n.t('chart.xtrace.pinned', { time: NS.time.format(t, 'HH:mm:ss', e.timeZone) }));
      this._commitTraces();
      return true;
    };
    /** Converts the {fromEndMs} traces to fixed {time} at the live edge `edge` the view just left. */
    ChartInteraction.prototype.freezeTraces = function (edge) {
      if (!NS.util.isFiniteNum(edge) || !this.traces.some(function (x) { return x.time == null && x.fromEndMs != null; })) return false;
      this.traces = this.traces.map(function (x) {
        return x.time == null && x.fromEndMs != null ? { time: Math.round(edge - x.fromEndMs), fromEndMs: null } : x;
      });
      this._commitTraces();
      return true;
    };
    ChartInteraction.prototype.removeTrace = function (i) {
      if (i < 0 || i >= this.traces.length) return false;
      this.traces = this.traces.filter(function (x, j) { return j !== i; });
      NS.a11y.announce(NS.i18n.t('chart.xtrace.removed'));
      this._commitTraces();
      return true;
    };
    ChartInteraction.prototype.moveTrace = function (i, t) {
      var tr = this.traces[i];
      if (!tr) return false;
      var e = this.host.engine;
      var vp = e.viewport.get();
      var next = this.traces.slice();
      next[i] = tr.fromEndMs != null && e._realtime() && vp.followLive
        ? { time: null, fromEndMs: Math.max(0, Math.round(vp.max - t)) } : { time: Math.round(t), fromEndMs: null };
      this.traces = next;
      this._commitTraces();
      return true;
    };
    /** Replaces the traces from props (external binding); returns true when they changed. */
    ChartInteraction.prototype.setTraces = function (list) {
      var n = normTraces(list);
      if (stableJson(n) === stableJson(this.traces)) return false;
      this.traces = n;
      this._redraw();
      this._notify();
      return true;
    };
    ChartInteraction.prototype._commitTraces = function () {
      var times = this.traceTimes().map(function (x) { return Math.round(x); });
      this.host.writeInteraction('xTrace', this.traces.map(function (x) { return x.time != null ? { time: x.time } : { fromEndMs: x.fromEndMs }; }));
      this.host.fire('onXTraceChange', { times: times.join(','), count: times.length });
      this._redraw();
      this._notify();
      this.host.ixChanged();
    };

    // ---- range brushes ------------------------------------------------------------------------------------------
    ChartInteraction.prototype.addBrush = function (br) {
      var p = this.host.props.props;
      var max = p.interaction.rangeBrush.max;
      if (this.brushes.length >= max) { NS.a11y.announce(NS.i18n.t('chart.brush.max', { n: max })); return null; }
      var b = { id: br.id && !this.brushById(br.id) ? br.id : nextBrushId(this.brushes), start: Math.round(br.start), end: Math.round(br.end), plot: br.plot | 0 };
      this.brushes = this.brushes.concat([b]);
      this.selBrush = b.id;
      this._commitBrushes(b, 'add');
      return b;
    };
    ChartInteraction.prototype.updateBrush = function (br) {
      var cur = this.brushById(br.id);
      if (!cur) return false;
      var b = { id: cur.id, start: Math.round(Math.min(br.start, br.end)), end: Math.round(Math.max(br.start, br.end)), plot: cur.plot };
      if (!(b.end > b.start)) return false;
      this.brushes = this.brushes.map(function (x) { return x.id === b.id ? b : x; });
      this.selBrush = b.id;
      this._commitBrushes(b, 'change');
      return true;
    };
    ChartInteraction.prototype.removeBrush = function (id) {
      var cur = this.brushById(id);
      if (!cur) return false;
      this.brushes = this.brushes.filter(function (x) { return x.id !== id; });
      if (this.selBrush === id) this.selBrush = this.brushes.length ? this.brushes[this.brushes.length - 1].id : null;
      NS.a11y.announce(NS.i18n.t('chart.brush.removed'));
      this._commitBrushes(cur, 'remove');
      return true;
    };
    ChartInteraction.prototype.clearBrushes = function () {
      var self = this;
      var old = this.brushes;
      if (!old.length) return;
      this.brushes = [];
      this.selBrush = null;
      this.host.writeInteraction('rangeBrush', []);
      old.forEach(function (b) { self.host.fire('onBrushChange', { id: b.id, start: b.start, end: b.end, plot: b.plot, action: 'remove' }); });
      this._redraw();
      this.host.ixChanged();
    };
    ChartInteraction.prototype.selectBrush = function (id) {
      if (!this.brushById(id)) return;
      this.selBrush = id;
      this._redraw();
      this.host.ixChanged();
    };
    /** Replaces the brushes from props (external binding); returns true when they changed. */
    ChartInteraction.prototype.setBrushes = function (list) {
      var n = normBrushes(list, this.host.props.props.interaction.rangeBrush.max);
      if (stableJson(n) === stableJson(this.brushes)) return false;
      this.brushes = n;
      if (!this.brushById(this.selBrush)) this.selBrush = n.length ? n[n.length - 1].id : null;
      this._redraw();
      return true;
    };
    ChartInteraction.prototype._commitBrushes = function (b, action) {
      this.host.writeInteraction('rangeBrush', this.brushes.map(function (x) { return { id: x.id, start: x.start, end: x.end, plot: x.plot }; }));
      this.host.fire('onBrushChange', { id: b.id, start: b.start, end: b.end, plot: b.plot, action: action });
      this._redraw();
      this.host.ixChanged();
    };

    // ---- keyboard (plot area focused) --------------------------------------------------------------------------
    ChartInteraction.prototype.key = function (e) {
      var host = this.host;
      var p = host.props.props;
      if (!host.canInteract() || !p.interaction.keyboard || !host.engine) return false;
      var k = e.key;
      var mode = host.mode();
      var v = host.engine.viewport.get();
      if (v.min == null || v.max == null) return false;
      var span = v.max - v.min;
      var handled = true;
      if (k === 'ArrowLeft' || k === 'ArrowRight') {
        var d = (k === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? IX.keyPanShift : IX.keyPan) * span;
        host.commitView({ min: v.min + d, max: v.max + d });
      } else if (k === '+' || k === '=' || k === 'Add' || k === '-' || k === '_' || k === 'Subtract') {
        var f = k === '-' || k === '_' || k === 'Subtract' ? IX.keyZoom : 1 / IX.keyZoom;
        var c = (v.min + v.max) / 2;
        // at the live edge the zoom keeps the right edge (stays live)
        var live = host.engine._realtime() && v.followLive;
        host.commitView(live ? { min: v.max - span * f, max: v.max } : { min: c - span * f / 2, max: c + span * f / 2 });
      } else if (k === 'Home') {
        host.resetZoom();
      } else if ((k === 'x' || k === 'X') && mode === 'xTrace' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this._kbdStep(e.shiftKey ? -1 : 1);
      } else if ((k === 'Enter' || k === ' ' || k === 'Spacebar') && mode === 'xTrace' && this.kbd) {
        this.pin(this.kbd.t);
      } else if (k === 'Escape' || k === 'Esc') {
        if (this.cancelGesture()) { /* cancelled */ }
        else if (this.kbd || this.hoverT != null) { this.kbd = null; this._hideHover(); this._clearCursor(); }
        else if (this.selBrush) { this.selBrush = null; this._redraw(); host.ixChanged(); }
        else handled = false;
      } else if (k === 'Delete' || k === 'Backspace') {
        if (mode === 'rangeBrush' && this.selBrush) this.removeBrush(this.selBrush);
        else if (mode === 'xTrace' && this.traces.length) {
          var times = this.traceTimes();
          var at = this.kbd ? this.kbd.t : this.hoverT;
          var idx = times.length - 1;
          if (at != null) {
            var bd = Infinity;
            times.forEach(function (t, i) { if (Math.abs(t - at) < bd) { bd = Math.abs(t - at); idx = i; } });
          }
          this.removeTrace(idx);
        } else handled = false;
      } else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
      return handled;
    };
    /** X / Shift+X: the value cursor moves to the next / previous data point of the first plot in view. */
    ChartInteraction.prototype._kbdStep = function (dir) {
      var pm = this.host.pm;
      var rec = pm && pm.plots[0];
      if (!rec || !rec.data || !rec.data[0] || !rec.data[0].length) return;
      var x = rec.data[0];
      var v = this.view();
      var cur = this.kbd ? this.kbd.t : (dir > 0 ? v.min - 1 : v.max + 1);
      var i = dir > 0 ? upperBound(x, cur) : lowerBound(x, cur) - 1;
      if (rec.synthetic >= 0 && i === rec.synthetic) i += dir;             // never the synthetic "now" point
      if (i < 0 || i >= x.length || x[i] < v.min || x[i] > v.max) return;
      var t = x[i];
      this.kbd = { rec: rec, t: t };
      try { rec.u.setCursor({ left: rec.u.valToPos(t, 'x'), top: Math.round(rec.u.over.clientHeight / 3) }); } catch (e) { /* ignore */ }
    };
    ChartInteraction.prototype._clearCursor = function () {
      var pm = this.host.pm;
      if (!pm) return;
      pm.plots.forEach(function (rec) { try { rec.u.setCursor({ left: -10, top: -10 }); } catch (e) { /* ignore */ } });
    };

    // ---- drawing (PlotManager overlay; canvas, inside the plot clip) ---------------------------------------------
    ChartInteraction.prototype._redraw = function () {
      if (this.host.pm) this.host.pm.redrawOverlays();
    };
    ChartInteraction.prototype.draw = function (u, rec, ctx) {
      var host = this.host;
      var p = host.props.props;
      var tk = host._tokens || {};
      var pxr = u.pxRatio || W.devicePixelRatio || 1;
      var b = u.bbox;
      var view = this.view();
      var tz = host.engine ? host.engine.timeZone : null;
      var fs = Math.round(p.appearance.fontSize * pxr);
      var font = fs + 'px ' + (tk.font || 'sans-serif');
      var xOf = function (t) { return u.valToPos(t, 'x', true); };
      var self = this;
      // brushes on their plot: inactive first, the selected / edited one on top
      var rb = p.interaction.rangeBrush;
      var list = this.brushList().slice().sort(function (a, c) { return (a.id === self.selBrush) - (c.id === self.selBrush); });
      list.forEach(function (br) {
        if (self._plotOf(br) !== rec.index || br.end < view.min || br.start > view.max) return;
        var active = br.id === self.selBrush || (self.temp && self.temp.brush && self.temp.brush.id === br.id);
        var cfg = active ? rb.active : rb.inactive;
        var col = (cfg.color && NS.props.color(cfg.color)) || tk.primary || '#2F7ED8';
        var x0 = Math.max(b.left, xOf(br.start)), x1 = Math.min(b.left + b.width, xOf(br.end));
        if (!(x1 - x0 >= 0.5)) return;
        ctx.fillStyle = withAlpha(col, cfg.opacity);
        ctx.fillRect(x0, b.top, x1 - x0, b.height);
        ctx.strokeStyle = withAlpha(col, active ? 0.95 : 0.55);
        ctx.lineWidth = Math.max(1, pxr) * (active ? 1.5 : 1);
        ctx.setLineDash([]);
        ctx.beginPath();
        [xOf(br.start), xOf(br.end)].forEach(function (x) {
          if (x >= b.left && x <= b.left + b.width) { ctx.moveTo(Math.round(x) + 0.5, b.top); ctx.lineTo(Math.round(x) + 0.5, b.top + b.height); }
        });
        ctx.stroke();
        // label: "Range n" (+ times while selected), canvas text only
        var n = BRUSH_ID_RE.exec(br.id);
        var label = NS.i18n.t('chart.brush.label', { n: n ? n[1] : br.id });
        if (active) {
          var pat = spanPattern(br.end - br.start, NS.time.format(br.start, 'YYYY-MM-DD', tz) === NS.time.format(br.end, 'YYYY-MM-DD', tz));
          label += '  ' + NS.time.format(br.start, pat, tz) + ' – ' + NS.time.format(br.end, pat, tz);
        }
        drawTag(ctx, label, x0 + 4 * pxr, b.top + 3 * pxr, font, tk, col, pxr, b);
      });
      // annotations (drawing order: bands after the brushes, note markers last)
      var anns = host.annotationItems ? host.annotationItems(rec, view) : [];
      var annRange = this.temp && this.temp.annRange && this.temp.annRange.plot === rec.index ? this.temp.annRange : null;
      anns.forEach(function (a) { if (a.type === 'range') drawAnnRange(ctx, a, host.annotationColor(a), xOf, b, pxr, a.pending); });
      if (annRange) drawAnnRange(ctx, annRange, host.annotationColor(null), xOf, b, pxr, true);
      // pinned traces on every plot; their time labels on the top plot
      var lc = p.interaction.xTrace.line;
      var lcol = (lc.color && NS.props.color(lc.color)) || tk.text || '#333';
      var times = this.traceTimes();
      times.forEach(function (t) {
        if (t < view.min || t > view.max) return;
        var x = Math.round(xOf(t)) + 0.5;
        ctx.strokeStyle = lcol;
        ctx.lineWidth = Math.max(1, lc.width * pxr);
        ctx.setLineDash((lc.dash || []).map(function (d) { return d * pxr; }));
        ctx.beginPath(); ctx.moveTo(x, b.top); ctx.lineTo(x, b.top + b.height); ctx.stroke();
        ctx.setLineDash([]);
        if (rec.index === 0) {
          var span = view.max - view.min;
          var txt = NS.time.format(t, span < 10 * SECOND ? 'HH:mm:ss.SSS' : span < 2 * DAY ? 'HH:mm:ss' : 'MM-DD HH:mm', tz);
          drawTag(ctx, txt, x + 3 * pxr, b.top + 3 * pxr, font, tk, lcol, pxr, b);
        }
      });
      anns.forEach(function (a) { if (a.type === 'note') drawAnnNote(ctx, a, host.annotationColor(a), xOf, b, pxr, a.pending); });
    };
    /** A range annotation: band at ANN_GEOM.bandAlpha + a solid strip at the top (dashed edges while pending). */
    function drawAnnRange(ctx, a, col, xOf, b, pxr, pending) {
      var x0 = Math.max(b.left, xOf(a.start)), x1 = Math.min(b.left + b.width, xOf(a.end));
      if (!(x1 - x0 >= 0.5)) return;
      ctx.fillStyle = withAlpha(col, ANN_GEOM.bandAlpha);
      ctx.fillRect(x0, b.top, x1 - x0, b.height);
      ctx.fillStyle = withAlpha(col, 0.9);
      ctx.fillRect(x0, b.top, x1 - x0, Math.max(1, ANN_GEOM.stripH * pxr));
      if (pending) {
        ctx.strokeStyle = withAlpha(col, 0.8);
        ctx.lineWidth = Math.max(1, pxr);
        ctx.setLineDash([4 * pxr, 3 * pxr]);
        ctx.strokeRect(Math.round(x0) + 0.5, b.top + 0.5, Math.round(x1 - x0), b.height - 1);
        ctx.setLineDash([]);
      }
    }
    /** A note: a vertical line over the plot + a flag at the top (dashed line while pending). */
    function drawAnnNote(ctx, a, col, xOf, b, pxr, pending) {
      var x = Math.round(xOf(a.start)) + 0.5;
      if (x < b.left - 1 || x > b.left + b.width + 1) return;
      ctx.strokeStyle = withAlpha(col, 0.95);
      ctx.lineWidth = Math.max(1, 1.5 * pxr);
      ctx.setLineDash(pending ? [4 * pxr, 3 * pxr] : []);
      ctx.beginPath(); ctx.moveTo(x, b.top); ctx.lineTo(x, b.top + b.height); ctx.stroke();
      ctx.setLineDash([]);
      var fw = ANN_GEOM.flagW * pxr, fh = ANN_GEOM.flagH * pxr;
      ctx.fillStyle = pending ? withAlpha(col, 0.45) : col;
      ctx.beginPath();
      ctx.moveTo(x, b.top);
      ctx.lineTo(x + fw, b.top + fh / 2);
      ctx.lineTo(x, b.top + fh);
      ctx.closePath();
      ctx.fill();
    }
    /** A small text tag with a translucent surface behind it, kept inside the plot box. */
    function drawTag(ctx, text, x, y, font, tk, edge, pxr, b) {
      ctx.font = font;
      var w = ctx.measureText(text).width + 8 * pxr;
      var hgt = parseFloat(font) + 6 * pxr;
      var left = Math.min(x, b.left + b.width - w - 2 * pxr);
      left = Math.max(b.left + 2 * pxr, left);
      ctx.fillStyle = withAlpha(tk.surface || '#ffffff', 0.88);
      ctx.fillRect(left, y, w, hgt);
      ctx.strokeStyle = withAlpha(edge, 0.7);
      ctx.lineWidth = Math.max(1, pxr);
      ctx.strokeRect(Math.round(left) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(hgt));
      ctx.fillStyle = tk.text || '#222';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, left + 4 * pxr, y + hgt / 2);
    }

    /* ========================================================================
     * SECTION 19 / CtgChart — the component
     * ----------------------------------------------------------------------
     *   root .ctg-chart (emit(); data-ctg-state / data-ctg-mode)
     *     [title]                          title.visible
     *     toolbar (role=toolbar)           Tags · date pill · modes · badge · ↻ ⤺ · export · settings
     *     body: [left dock] main [right dock] [pen table when position "right"]
     *       main: banners · notices · chunk progress · plots (PlotManager) · empty state
     *     pen table (position "bottom")
     *     floating panels (dock "none": modals / popovers portal themselves)
     *
     * Data: ChartEngine (SECTION 9) -> engine.model() each render -> buildPens /
     * assignAxes -> PlotManager.update (structure + data) and, while following
     * live, a requestAnimationFrame slider that only moves the x window (and
     * the synthetic "now" point) at most every max(250 ms, span / plot width)
     * — no React render per frame.
     *
     * Writes: runtime prop writes are whole root objects (never nested paths).
     * Never in Designer design mode (eventsEnabled false). outputs.* are written
     * only when they change (lastUpdate at most every 10 s) and never in the
     * Designer. Component events go through NS.events
     * (no-op when events are disabled).
     * ====================================================================== */
    var OUTPUT_LAST_UPDATE_MS = 10000;
    var charts = new Map();                        // chartId -> component (panel registry open())
    var MODES = ['xTrace', 'pan', 'zoom', 'rangeBrush', 'annotate'];
    function clean(s) {
      var str;
      try { str = String(s == null ? '' : s); } catch (e) { str = '(' + typeof s + ')'; }   // null-prototype objects
      return str.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120); }
    /** A chart's synchronous open-panel map (falls back to state.panels for a minimal host that has no _panels). */
    function panelMapOf(c) { return c._panels || (c.state && c.state.panels) || {}; }
    /** The focused element when it is inside chart c (else null). */
    function focusedInside(c) {
      if (typeof document === 'undefined') return null;
      var ae = document.activeElement;
      var root = c._rootEl;
      return ae && ae !== document.body && root && root.contains && root.contains(ae) ? ae : null;
    }
    /**
     * After a panel closed with focus inside it: when focus fell to <body> (the panel and, in the
     * narrow layout, the sheet with its Back button are gone), back to the opener, else the panel's toolbar button,
     * else the More button, else the plot.
     */
    function restorePanelFocus(c, name, opener) {
      if (!c._alive || typeof document === 'undefined') return;
      var ae = document.activeElement;
      if (ae && ae !== document.body && ae.isConnected !== false) return;
      var root = c._rootEl;
      var ok = function (el) { return el && el.isConnected !== false && typeof el.focus === 'function' && (!root || !root.contains || root.contains(el)); };
      var q = function (sel) { return root && root.querySelector ? root.querySelector(sel) : null; };
      var target = [opener, q('[data-ctg-panel="' + name + '"]'), q('[data-ctg="more"]')].filter(ok)[0];
      try {
        if (target) target.focus({ preventScroll: true });
        else if (typeof c.focusPlots === 'function') c.focusPlots();
      } catch (e) { /* ignore */ }
    }
    function jsonCopy(x) { try { return x == null ? x : JSON.parse(JSON.stringify(x)); } catch (e) { return null; } }

    class CtgChart extends PC.Component {
      constructor(props) {
        super(props);
        // narrow: width < toolbar.responsiveWidth (hysteresis); small: height < 240 or width < 320.
        // tableCollapsed null = follow penTable.collapsed (and "small"); menu {kind, x, y, returnFocus} | null;
        // rate {anchorRect} | null (refresh-rate popover); confirm {penKey, anchorRect} | null; fs 'off' | 'native' | 'max'.
        this.state = { lib: W.uPlot ? 'ready' : 'loading', panels: {}, rootW: 0, rootH: 0, plotError: null, modeOverride: null, visOverride: {},
          narrow: false, small: false, tableCollapsed: null, expandedRow: null, menu: null, rate: null, confirm: null, fs: 'off',
          annShown: null,                  // null = follow annotations.visible; true / false = the More menu toggle
          rsShown: null };                 // null = follow rangeSelector.visible; false / true = the More menu toggle
        // The open-panel map's source of truth. openPanel/closePanel update it synchronously and then
        // mirror it into state.panels (render reads the state). React applies setState later or batched,
        // so reading this.state here would lose an open/close that happens in the same tick as another.
        this._panels = {};
        this.engine = null;
        this.pm = null;
        this.api = null;
        this.chartId = null;
        this._alive = false;
        this._rootEl = null;
        this._plotsEl = null;
        this._pens = [];
        this._removing = [];            // [{source, key, nk, sig, at}] removals sent, until the next chart.pens push
        this._pensSig = '';
        this._axes = { plots: [], byKey: {} };
        this._vm = null;
        this._tokens = null;
        this._off = [];
        this._libTimer = null;
        this._libAttempt = 0;
        this._slideRaf = 0;
        this._lastSlide = 0;
        this._outTimer = null;
        this._ovTimer = null;
        this._ovAt = {};                   // optimistic override key -> set at (ms); MODE_OV for the mode override
        this._lastOut = null;
        this._outLastUpdate = 0;
        this._rangeTimer = null;
        this._rangeEpoch = 0;
        this._lastState = null;
        this._lastNotify = null;
        this._openedOnStart = false;
        this.timing = { mount: null, firstDraw: null };      // load-time measurements (performance.now ms)
        this._panelGen = {};               // panel name -> generation of its current opening (ignores a stale close())
        this._panelSeq = 0;
        this._ownIx = {};                  // interaction.* fields the chart wrote last (echo detection)
        this._exact = null;                // exact brush statistics of the selected brush (entry of _exactCache)
        this._exactCache = new Map();      // key (brush id|start|end|pens) -> entry, per brush geometry (<= EXACT.cache, points bounded)
        this._exactRetryT = 0;
        this._brushCache = new Map();
        this._plotsBox = null;             // the focusable plot area (keyboard)
        this._helpId = NS.util.uid('ctg-plot-keys');
        this._lastMode = null;
        this._zoneSp = null;               // the session props tree whose changes re-resolve the zone
        this._zoneOff = null;
        this._annSig = '';                 // annotations drawn last (overlay redraw when they change)
        this.ix = new ChartInteraction(this);
        this._rs = new RangeSelector(this);        // the overview strip (SECTION 14c)
        this._rsHelpId = NS.util.uid('ctg-rs-keys');
        this._rsEl = null;
        var self = this;
        this._setPlotsBox = function (el) { self._plotsBox = el; };
        this._setRs = function (el) {
          if (el === self._rsEl) return;
          if (self._rsOff) { self._rsOff(); self._rsOff = null; }
          self._rsEl = el;
          self._rs.setEl(el);
          if (el) {
            self._rsOff = NS.resize.observe(el, function () { if (self._alive) self._rs.update(); });
            self._rs.update();
          }
        };
        this._setRoot = function (el) {
          if (el === self._rootEl) return;
          if (self._rootOff) { self._rootOff(); self._rootOff = null; }
          self._rootEl = el;
          if (el) {
            self._rootOff = NS.resize.observe(el, function (r) {
              if (!self._alive) return;
              var patch = {};
              if (Math.abs(r.width - self.state.rootW) >= 1 || Math.abs(r.height - self.state.rootH) >= 1) { patch.rootW = r.width; patch.rootH = r.height; }
              var narrow = self._narrowAt(r.width);
              var small = r.width > 0 && (r.height < 240 || r.width < 320);
              if (narrow !== self.state.narrow) patch.narrow = narrow;
              if (small !== self.state.small) patch.small = small;
              if (Object.keys(patch).length) self.setState(patch);
            });
          }
        };
        this._setPlots = function (el) {
          if (el === self._plotsEl) return;
          if (self._plotsOff) { self._plotsOff(); self._plotsOff = null; }
          if (self.pm) { self.pm.destroy(); self.pm = null; }        // the host element changed: new instances
          self._plotsEl = el;
          if (el) {
            self._plotsOff = NS.resize.observe(el, function (r) {
              if (!self._alive) return;
              if (self.engine) self.engine.setPlotWidth(r.width);
              if (self.pm) self.pm.resize(r.width, r.height);
              else self._syncPlots();
              self._plotsSize = { w: r.width, h: r.height };
            });
          }
        };
      }

      // ---- lifecycle -------------------------------------------------------------------------------
      componentDidMount() {
        var self = this;
        this._alive = true;
        this.timing.mount = perfNow();
        NS.theme.ensureStyles('ctg-chart-styles', CHART_CSS);
        var store = this.props.store;
        var d = store && store.delegate;
        this.chartId = 'chart' + String((store && store.addressPathString) || '').replace(/[^A-Za-z0-9_.:-]/g, '_') + '-' + NS.util.uid('e');
        this._tokens = this._readTokens();
        this.engine = new ChartEngine({
          id: this.chartId, name: (store && store.name) || '', source: d, props: this.props.props, timeZone: this._zone(),
        });
        this.api = createChartApi(this);
        this.engine.debugExtra = { api: this.api, ui: this };
        this.engine.onLeaveLive = function (edge) { if (self.ix) self.ix.freezeTraces(edge); };
        this._warnV1();
        charts.set(this.chartId, this);
        this._off.push(this.engine.onChange(function () { if (self._alive) self.forceUpdate(); }));
        this._off.push(NS.theme.onChange(store, function () { self._onTheme(); }));
        this._off.push(NS.chart.panels.onChange(function () { if (self._alive) self.forceUpdate(); }));
        if (typeof document !== 'undefined' && document.addEventListener) {
          var vis = function () { self._ensureSlide(); };
          document.addEventListener('visibilitychange', vis);
          this._off.push(function () { document.removeEventListener('visibilitychange', vis); });
          var fsc = function () { self._onFullscreenChange(); };
          document.addEventListener('fullscreenchange', fsc);
          this._off.push(function () { document.removeEventListener('fullscreenchange', fsc); });
        }
        this._lastMode = this.mode();
        // interaction.fullscreen already true (a binding, or a page reloaded in fullscreen): the maximised
        // presentation (the Fullscreen API needs a user gesture)
        if (this.props.props.interaction.fullscreen && !this.designMode()) this._maximise(false);
        this._watchZone();
        this.engine.start();
        if (d && d.attach) d.attach();
        if (this.state.lib !== 'ready') this._loadLib();
        this._syncPlots();
        this.forceUpdate();
      }

      /** Narrow below toolbar.responsiveWidth; back to wide only 16 px above it (no flapping at the breakpoint). */
      _narrowAt(width) {
        var rw = this.props.props.toolbar.responsiveWidth;
        return rw > 0 && width > 0 && (this.state.narrow ? width < rw + 16 : width < rw);
      }
      /** Unmigrated v1 props: one console warning per view (the Designer also shows a badge). */
      _warnV1() {
        var keys = this.props.props && this.props.props.v1Keys;
        if (!keys || !keys.length) return;
        var view = '';
        try { view = String(this.props.store.view.resourcePath || ''); } catch (e) { /* ignore */ }
        if (v1Warned[view]) return;
        v1Warned[view] = true;
        log.warn(NS.i18n.t('chart.v1Warn', { keys: keys.join(', ') }), view ? '(view ' + view + ')' : '');
      }
      componentDidUpdate(prev) {
        if (!this.engine) return;
        this._watchZone();
        if (prev.props !== this.props.props) this._warnV1();
        if (prev.props !== this.props.props) {
          this.engine.setTimeZone(this._zone());
          this.engine.setProps(this.props.props);
          this._clearSettledOverrides();
          if (prev.props.interaction.mode !== this.props.props.interaction.mode || prev.props.timeRange.mode !== this.props.props.timeRange.mode) this._rangeEpoch++;
          this._adoptInteraction(prev.props);
          // a responsiveWidth set at run time / in the Designer applies now, not at the next resize
          if (prev.props.toolbar.responsiveWidth !== this.props.props.toolbar.responsiveWidth && this.state.rootW > 0) {
            var nw = this._narrowAt(this.state.rootW);
            if (nw !== this.state.narrow) this.setState({ narrow: nw });
          }
        }
        else if (this._syncZone()) this.forceUpdate();       // the session zone changed (one more render, then equal)
        var mode = this.mode();
        if (mode !== this._lastMode) { this._lastMode = mode; this.ix.modeChanged(); }
        this._restoreRemoveFocus();
        this._syncPlots();
        this._afterRender();
      }

      // ---- time zone -----------------------------------------------------------------------------------
      /** The chart's zone now: timeAxis.timeZone resolved against the session ('session' = session.props.timeZoneId). */
      _zone() { return NS.time.resolveZone(this.props.props.timeAxis.timeZone, this.props.store); }
      /**
       * session.props.timeZoneId (or gateway.timezone) can change while the chart's own props stay the same (a
       * script, a binding on the session prop): the chart subscribes to the session props tree and re-resolves its
       * zone on every change of it, so axis labels, X-Trace times, the date pill and the date-range tool follow at
       * once. Perspective may replace the tree, so every update re-subscribes when the tree differs (the same
       * pattern as the common theme watch).
       */
      _watchZone() {
        var sp = null;
        try { sp = this.props.store.view.page.sessionProps || null; } catch (e) { sp = null; }
        if (sp === this._zoneSp) return;
        if (this._zoneOff) { try { this._zoneOff(); } catch (e) { /* ignore */ } this._zoneOff = null; }
        this._zoneSp = sp;
        if (!sp || typeof sp.subscribe !== 'function') return;
        var self = this;
        try {
          var off = sp.subscribe(function () { if (self._syncZone()) self.forceUpdate(); });
          this._zoneOff = typeof off === 'function' ? off : null;
        } catch (e) { log.debug('session props subscription unavailable', e && e.message); }
      }
      /**
       * Re-resolves the zone; true when it changed. The engine then has the new zone and the caller re-renders: the
       * plots rebuild their time axis (the zone is part of PlotManager._sig).
       */
      _syncZone() {
        if (!this._alive || !this.engine) return false;
        var tz = this._zone();
        if (tz === this.engine.timeZone) return false;
        this.engine.setTimeZone(tz);
        return true;
      }
      /**
       * interaction.* changed in the props: values written by someone else (a binding, a script) are adopted;
       * the echo of the chart's own write is not (it already is the local state). fullscreen from a binding
       * enters the maximised presentation, or leaves fullscreen.
       */
      _adoptInteraction(prevP) {
        var ip = this.props.props.interaction, pp = prevP.interaction;
        if (stableJson(ip.xTrace.values) !== stableJson(pp.xTrace.values) && !this._isOwnEcho('xTrace', stableJson(normTraces(ip.xTrace.values)))) {
          if (this.ix.setTraces(ip.xTrace.values)) this.ixChanged();
        }
        if (stableJson(ip.rangeBrush.values) !== stableJson(pp.rangeBrush.values) &&
            !this._isOwnEcho('rangeBrush', stableJson(normBrushes(ip.rangeBrush.values, ip.rangeBrush.max)))) {
          if (this.ix.setBrushes(ip.rangeBrush.values)) this.ixChanged();
        }
        if (ip.fullscreen !== pp.fullscreen && !this._isOwnEcho('fullscreen', String(ip.fullscreen)) && !this.designMode()) {
          if (ip.fullscreen && this.state.fs === 'off') this._maximise(false);
          else if (!ip.fullscreen && this.state.fs !== 'off') this._exitFullscreen(false);
        }
      }
      /**
       * True when `sig` is the echo of one of the chart's own recent writes of that field (props arrive later
       * than the local state, possibly several writes behind): the echo and the older writes are forgotten.
       */
      _isOwnEcho(field, sig) {
        var list = this._ownIx[field] || [];
        var i = list.indexOf(sig);
        if (i < 0) return false;
        this._ownIx[field] = list.slice(i + 1);
        return true;
      }

      componentWillUnmount() {
        // open panels flush their pending drafts while the API still writes (React unmounts the chart before its
        // panels, so a panel's own unmount flush would find the API detached and drop the edit)
        (this._unmountFlushers || []).slice().forEach(function (fn) { try { fn(); } catch (e) { log.warn('panel flush failed', e); } });
        this._unmountFlushers = [];
        this._alive = false;
        this.ix.dispose();
        this._rs.destroy();
        if (this._rsOff) { this._rsOff(); this._rsOff = null; }
        this._abortExact();
        this._unlistenMax();
        try {
          if (this._rootEl && document.fullscreenElement === this._rootEl && document.exitFullscreen) document.exitFullscreen().catch(function () { });
        } catch (e) { /* ignore */ }
        if (this._slideRaf) { cancelRaf(this._slideRaf); this._slideRaf = 0; }
        [this._libTimer, this._outTimer, this._rangeTimer, this._ovTimer, this._confirmGoneT, this._exactRetryT].forEach(function (t) { if (t) clearTimeout(t); });
        this._off.forEach(function (fn) { try { fn(); } catch (e) { /* ignore */ } });
        this._off = [];
        if (this._zoneOff) { try { this._zoneOff(); } catch (e) { /* ignore */ } this._zoneOff = null; }
        this._zoneSp = null;
        if (this._rootOff) { this._rootOff(); this._rootOff = null; }
        if (this._plotsOff) { this._plotsOff(); this._plotsOff = null; }
        if (this.pm) { this.pm.destroy(); this.pm = null; }
        if (this.engine) { this.engine.dispose(); this.engine = null; }
        charts.delete(this.chartId);
        var d = this.props.store && this.props.store.delegate;
        if (d && d.detach) d.detach();
      }

      _loadLib() {
        var self = this;
        loadUPlot().then(function () {
          if (!self._alive) return;
          self._libAttempt = 0;
          self.setState({ lib: 'ready' });
        }, function (e) {
          if (!self._alive) return;
          log.warn('uPlot load failed', e && e.message);
          var wait = LIB_RETRY_MS[Math.min(self._libAttempt, LIB_RETRY_MS.length - 1)];
          self._libAttempt++;
          self.setState({ lib: 'error' });
          self._libTimer = setTimeout(function () { self._libTimer = null; if (self._alive) self._loadLib(); }, wait);
        });
      }

      /** Canvas colours + font. The font token can be "inherit": canvas needs a real family. */
      _readTokens() {
        var t = NS.theme.tokens(this._rootEl || undefined);
        if (!t.font || /^(inherit|initial|unset)$/i.test(String(t.font).trim())) {
          var fam = '';
          try { fam = W.getComputedStyle(this._rootEl || document.body).fontFamily; } catch (e) { /* ignore */ }
          t = Object.assign({}, t, { font: fam || 'sans-serif' });
        }
        return t;
      }
      _onTheme() {
        if (!this._alive) return;
        this._colorCache = null;                 // theme variables resolve anew
        this._tokens = this._readTokens();
        if (this.pm) this.pm.setTokens(this._tokens);
        this.forceUpdate();
      }

      /**
       * emit() hands out Perspective's own ref for the component root (it sets store.element, used by the
       * Designer, popups and anything that finds a component by its element): never replace it — chain ours.
       * Cached per emit ref so React does not detach / re-attach on every render.
       */
      _rootRef(emitRef) {
        if (this._rootRefFor === emitRef && this._rootRefFn) return this._rootRefFn;
        var self = this;
        this._rootRefFor = emitRef;
        this._rootRefFn = function (el) {
          if (typeof emitRef === 'function') emitRef(el);
          else if (emitRef && typeof emitRef === 'object') emitRef.current = el;
          self._setRoot(el);
        };
        return this._rootRefFn;
      }

      // ---- host surface for ChartApi (SECTION 15) ---------------------------------------------------
      store() { return this.props.store; }
      reducedProps() { return this.props.props; }
      /** The raw (unreduced) value of one root prop as the property tree holds it (api.patch); undefined if unreadable. */
      rawProp(key) {
        try { return this.props.store.props.read(key); } catch (e) { return undefined; }
      }
      penVMs() { return this._pens; }
      axisVMs() { return this._axes.plots; }
      designMode() { return this.props.eventsEnabled === false; }
      designer() { return NS.nav.isDesigner(this.props.store); }
      root() { return this._rootEl; }
      plotManager() { return this.pm; }
      locale() { return NS.format.locale(this.props.store); }
      deviceType() {
        try {
          var sp = this.props.store.view.page.sessionProps;
          var v = sp && sp.read ? sp.read('device.type') : null;
          return v == null ? null : String(v);
        } catch (e) { return null; }
      }
      /** Whole-object write of one root prop (never in design mode). */
      writeProp(key, value) {
        if (this.designMode()) return false;
        try {
          this.props.store.props.write(key, value);
          return true;
        } catch (e) {
          log.warn('prop write failed', key, e && e.message);
          return false;
        }
      }
      fire(name, payload) { return NS.events.fire(this.props, name, payload); }
      /**
       * Opens a panel. Every opening gets a new generation: the close() handed to that opening closes it
       * only while it is still the same opening, so a stale close() of an earlier opening (a late timer, a
       * fetch that resolves after the user closed and re-opened it) never closes the re-opened panel.
       */
      openPanel(name, args) {
        if (this.designMode() || !this._alive || !NS.chart.panels.get(name)) return false;
        var next = Object.assign({}, panelMapOf(this));
        var src = args || {};
        // every opening gets its own args object with a hidden openingId (the generation below), so a panel
        // can tell a re-mount of this opening (same object) from a new opening that a caller made with the same
        // constant args object (the tag browser keeps per-opening state across a dock <-> sheet move)
        if (!this._panelGen) this._panelGen = {};
        var gen = (this._panelSeq = (this._panelSeq || 0) + 1);
        var a = src;
        if (typeof src === 'object') {
          a = Object.assign(Object.create(Object.getPrototypeOf(src)), src);   // a copy (same prototype as the caller's)
          Object.defineProperty(a, 'openingId', { value: gen, enumerable: false, configurable: true });
          // remember what opened the panel (focus returns there when it closes, WCAG 2.4.3). A DOM
          // element in the panel's args: NOT enumerable, so a panel that copies or serialises its args (add-on
          // panels, JSON.stringify) never meets it (React's DOM nodes are circular)
          var opener = src.returnFocus || focusedInside(this);
          if (opener) Object.defineProperty(a, 'returnFocus', { value: opener, enumerable: false, configurable: true });
        }
        next[name] = a;
        this._panelGen[name] = gen;
        this._panels = next;
        this.setState({ panels: next });
        return true;
      }
      /** Closes a panel; with `gen`, only while that opening is still the current one (see openPanel). */
      closePanel(name, gen) {
        if (!this.panelOpen(name) || !this._alive) return false;
        if (gen != null && this._panelGen && this._panelGen[name] !== gen) return false;
        var self = this;
        var next = Object.assign({}, panelMapOf(this));
        var args = next[name] || {};
        delete next[name];
        this._panels = next;
        // focus in the panel (or its sheet) when it closes: it must not drop to <body>
        var had = focusedInside(this);
        var inPanel = !!(had && had.closest && had.closest('.ctg-chart__panel, .ctg-chart__sheet'));
        this.setState({ panels: next }, function () { if (inPanel) restorePanelFocus(self, name, args.returnFocus); });
        return true;
      }
      /** Reads the synchronous map (this._panels), so isOpen() is true right after open() — as in the stub. */
      panelOpen(name) { return typeof name === 'string' && hasOwn.call(panelMapOf(this), name); }
      _togglePanel(name, e) {
        if (this.panelOpen(name)) { this.closePanel(name); return; }
        var r = e && e.currentTarget && e.currentTarget.getBoundingClientRect ? e.currentTarget.getBoundingClientRect() : null;
        this.openPanel(name, { anchorRect: r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null, source: 'toolbar' });
      }
      // ---- interaction host (SECTION 18 uses these) ----------------------------------------------------
      /** The effective interaction mode (the optimistic toolbar choice until the prop echo arrives). */
      /**
       * The effective interaction mode: 'annotate' while annotation editing is not offered (annotations
       * off, no edit permission, no editor, a historian without annotations) acts as 'xTrace' — gestures, hover and
       * the toolbar's checked mode — without writing the prop; otherwise it would be a mode with no toolbar button
       * where every click opens a read-only 'Add note' dialog.
       */
      mode() {
        var md = this.state.modeOverride || this.props.props.interaction.mode;
        return md === 'annotate' && !this._annotateOffered() ? 'xTrace' : md;
      }
      _annotateOffered() {
        var a = this.props.props.annotations;
        if (!a || !a.enabled || !NS.chart.panels || !NS.chart.panels.get('annotation')) return false;
        var m = this.engine ? this.engine.model() : null;
        if (!m || (m.annotations && m.annotations.unsupported)) return false;
        var an = m.capabilities && m.capabilities.annotations;
        return !!(an && an.editAllowed);
      }
      /** Gestures, keyboard and pins: never in Designer design mode or after unmount. */
      canInteract() { return this._alive && !!this.engine && !this.designMode(); }

      // ---- annotations (SECTION 9b data, SECTION 18 gestures and drawing) ----------------------------------
      /** Annotations drawn: annotations.enabled and visible (or the More menu toggle of this session). */
      annotationsShown() {
        var a = this.props.props.annotations;
        return !!a.enabled && (this.state.annShown != null ? this.state.annShown : !!a.visible);
      }
      /** The annotations to draw on plot `rec` in `view`: its visible pens', of the enabled types. */
      annotationItems(rec, view) {
        if (!this.engine || !this.annotationsShown() || !rec || !rec.pv) return [];
        var keys = (rec.pv.pens || []).filter(function (vm) { return vm.visible !== false; }).map(function (vm) { return vm.key; });
        if (!keys.length) return [];
        var types = this.props.props.annotations.types;
        return this.engine.annotations.list(keys, view ? view.min : null, view ? view.max : null).filter(function (a) {
          return a.type === 'range' ? types.range : types.note;
        });
      }
      /** Marker colour: the entry's own colour, else annotations.color, else the theme's primary colour. */
      annotationColor(a) {
        var c = a && a.color ? NS.props.color(a.color) : null;
        if (!c) c = NS.props.color(this.props.props.annotations.color);
        return c || (this._tokens && this._tokens.primary) || '#0C7BB3';
      }
      /** True for a pen whose history the gateway serves (status ok): annotations belong to such pens. */
      annotationPenOk(key) {
        var pens = this.engine ? this.engine.pens : [];
        for (var i = 0; i < pens.length; i++) if (pens[i].key === key) return !!pens[i].info && pens[i].info.status === 'ok';
        return false;
      }
      annotationPenLabel(key) {
        for (var i = 0; i < this._pens.length; i++) if (this._pens[i].key === key) return this._pens[i].label;
        return '';
      }
      /**
       * Opens the AnnotationEditor (ctg-chart-panels.js, panel 'annotation') for a new note / range or an existing
       * entry. args carry the plot's pens with history (the editor's pen choice), the anchor at the pointer, and the
       * callbacks through which the editor reports what the gateway accepted (optimistic draw + re-read).
       */
      openAnnotation(o) {
        if (!this.engine || this.designMode() || !o) return false;
        var self = this;
        var it = o.item || null;
        var plotKeys = o.rec && o.rec.pv ? (o.rec.pv.pens || []).filter(function (vm) {
          return vm.visible !== false && self.annotationPenOk(vm.key);
        }).map(function (vm) { return vm.key; }) : [];
        var cx = o.anchor ? o.anchor.clientX : 0, cy = o.anchor ? o.anchor.clientY : 0;
        var args = {
          mode: it ? 'edit' : 'add', type: it ? it.type : (o.type === 'range' ? 'range' : 'note'),
          start: it ? it.start : o.start, end: it ? it.end : (o.end != null ? o.end : null),
          penKey: it ? it.penKey : (o.penKey || plotKeys[0] || null), penKeys: it ? [it.penKey] : plotKeys,
          item: it ? Object.assign({}, it) : null, source: 'plot',
          anchorRect: { left: cx, top: cy, right: cx, bottom: cy, width: 0, height: 0 },
          onSaved: function (r) { if (self.engine && r) self.engine.annotations.saved(r.entry || null, r.replacedId || null); },
          onDeleted: function (r) { if (self.engine && r) self.engine.annotations.saved(null, r.id || null); },
        };
        return this.openPanel('annotation', args);
      }
      _toggleAnnotations() {
        var self = this;
        this.setState({ annShown: !this.annotationsShown() }, function () { if (self.pm) self.pm.redrawOverlays(); });
      }
      focusPlots() {
        var el = this._plotsBox;
        if (!el || !this.props.props.interaction.keyboard || typeof el.focus !== 'function') return;
        if (typeof document !== 'undefined' && document.activeElement === el) return;
        try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
      }
      /** The end of a gesture: the engine keeps the view (follow-live rule, free-range re-query), onRangeChange. */
      commitView(v) {
        if (!this.engine || !v) return;
        this.ix.preview = null;
        this.engine.viewport.set({ min: v.min, max: v.max });
        this.userRange();
      }
      resetZoom() { if (this.engine) this._resetZoom(); }
      // ---- range selector host (SECTION 14c) ------------------------------------------------------------
      /**
       * The overview strip is shown: rangeSelector.visible (and not hidden from the More menu this session), not a
       * very small chart, and in the narrow layout only with rangeSelector.narrowVisible.
       */
      rangeSelectorShown() {
        var rs = this.props.props.rangeSelector;
        if (!rs.visible || this.state.rsShown === false || this.state.small) return false;
        return !this.state.narrow || rs.narrowVisible;
      }
      /** The view drawn now: a running gesture's preview, else what the plots show, else the engine's viewport. */
      currentView() {
        if (this.ix && this.ix.preview) return this.ix.preview;
        if (this.pm && this.pm.vm && this.pm.view) return this.pm.view;
        return this.engine ? this.engine.viewport.get() : null;
      }
      /** A strip gesture's live view: the plots move with it (the same preview as a plot gesture). */
      previewView(v) { if (this.ix && v) this.ix._setPreview(v); }
      clearPreview() {
        if (!this.ix || !this.ix.preview) return;
        this.ix._clearPreview();
        this.ix._redraw();
      }
      /** The gesture preview changed (any gesture): the strip's window follows. */
      previewChanged() {
        if (!this._rs || !this._alive) return;
        try { this._rs.sync(); } catch (e) { log.warn('range selector sync failed', e && e.message); }
      }
      _toggleRangeSelector() {
        var self = this;
        this.setState({ rsShown: !this.rangeSelectorShown() }, function () { if (self._alive) self._rs.update(); });
      }
      /** Interaction state changed (traces, brushes, selection): re-render the pen table / brush view. */
      ixChanged() {
        if (!this._alive) return;
        this._pruneExact();              // exact statistics of brush geometries that are gone
        this.forceUpdate();
      }
      /**
       * Writes interaction.<field> (xTrace / rangeBrush -> its `values`; fullscreen -> the flag) as the whole
       * `interaction` object read from the tree (never a nested path). Never in the Designer (these automatic
       * writes would dirty the view) — the state then stays local.
       */
      writeInteraction(field, value) {
        if (this.designMode() || this.designer()) return false;
        var raw = jsonCopy(this.props.store.props.read('interaction'));
        var obj = NS.util.isPlainObject(raw) ? raw : jsonCopy(this.props.props.interaction);
        if (field === 'fullscreen') obj.fullscreen = !!value;
        else {
          if (!NS.util.isPlainObject(obj[field])) obj[field] = jsonCopy(this.props.props.interaction[field]);
          obj[field].values = value;
        }
        // the echo signature: what the reducer will make of this value (normalized like the adopt path compares)
        var sig = field === 'fullscreen' ? String(!!value)
          : field === 'xTrace' ? stableJson(normTraces(value)) : stableJson(normBrushes(value, this.props.props.interaction.rangeBrush.max));
        if (!this.writeProp('interaction', obj)) return false;
        this._ownIx[field] = (this._ownIx[field] || []).concat([sig]).slice(-4);
        return true;
      }

      /** A user changed the visible range (reset, return to live, ChartApi.viewport): onRangeChange, debounced 500 ms. */
      userRange() {
        var self = this;
        this._rangeEpoch++;
        if (this._rangeTimer) clearTimeout(this._rangeTimer);
        this._rangeTimer = setTimeout(function () {
          self._rangeTimer = null;
          if (!self._alive || !self.engine) return;
          var v = self.engine.viewport.get();
          self.fire('onRangeChange', { mode: self.props.props.timeRange.mode, start: Math.round(v.min), end: Math.round(v.max) });
          self._scheduleOutputs();
        }, 500);
        this.forceUpdate();
      }

      // ---- view model ---------------------------------------------------------------------------
      /**
       * Resolver of CSS colours for canvas use: a value with var(...) is resolved against the chart
       * root through a hidden probe's computed colour (rgb()), cached until the theme changes; anything else is
       * returned unchanged. Pen colours reach uPlot's canvas, which ignores var().
       */
      _resolveColorFn() {
        var self = this;
        return this._resolveFn || (this._resolveFn = function (c) { return self._resolveColor(c); });
      }
      _resolveColor(c) {
        if (typeof c !== 'string' || c.indexOf('var(') < 0) return c;
        var cache = this._colorCache || (this._colorCache = {});
        if (hasOwn.call(cache, c)) return cache[c];
        var out = c;
        try {
          var root = this._rootEl || (typeof document !== 'undefined' ? document.body : null);
          if (root && typeof document !== 'undefined') {
            var probe = document.createElement('span');
            probe.style.display = 'none';
            probe.style.color = c;
            root.appendChild(probe);
            var got = W.getComputedStyle(probe).color;
            root.removeChild(probe);
            if (got && NS.theme.parseColor(got)) out = String(got);
          }
        } catch (e) { /* keep the CSS form */ }
        cache[c] = out;
        return out;
      }
      _background() {
        var p = this.props.props;
        var bg = p.plots.length && p.plots[0].background ? NS.props.color(p.plots[0].background) : null;
        return bg || (this._tokens && this._tokens.surface) || '#FFFFFF';
      }
      _buildVM(m) {
        var p = this.props.props;
        var pens = buildPens(m.pens.map(function (mp) {
          var x = Object.assign({}, mp);
          return x;
        }), p, { background: this._background(), resolve: this._resolveColorFn() });
        var ov = this.state.visOverride;
        pens.forEach(function (vm) { if (hasOwn.call(ov, vm.key)) vm.visible = ov[vm.key]; });
        this._pruneRemoving(m.pens.map(function (mp) { return mp.source + ':' + mp.key + ':' + NS.util.normKey(mp.tagPath); }).join('|'));
        var axes = assignAxes(pens, p);
        this._pens = pens;
        this._axes = axes;
        var fs = p.appearance.fontSize;
        var plotList = p.plots.length ? p.plots : [{ relativeWeight: 1, background: '', markers: [] }];
        var ta = p.timeAxis;
        this._vm = {
          plots: plotList.map(function (pl, i) {
            return { index: i, weight: pl.relativeWeight, background: pl.background, markers: pl.markers,
              pens: pens.filter(function (vm) { return vm.drawable && vm.plot === i; }), axes: axes.plots[i] || [] };
          }),
          timeAxis: ta, fontSize: fs, tz: this.engine.timeZone || NS.time.resolveZone('session', this.props.store),
          // a running gesture's preview wins over the engine's viewport (engine changes during a drag re-render)
          locale: this.locale(), scheme: NS.theme.scheme(), viewport: this.ix.preview || m.viewport, rangeEpoch: this._rangeEpoch,
          xAxisHeight: ta.visible ? (ta.format === 'auto' ? 2 * fs + 18 : fs + 18) : 0,
        };
        return this._vm;
      }
      _syncPlots() {
        if (!this._alive || this.state.lib !== 'ready' || !this._plotsEl || !this._vm || !this.engine) return;
        var self = this;
        try {
          var syncKey = this.props.props.interaction.cursorSyncGroup || 'ctg-' + this.chartId;
          if (!this.pm) {
            this.pm = new PlotManager(this._plotsEl, {
              engine: this.engine, tokens: this._tokens,
              syncKey: syncKey,
              onError: function (e) { self._plotFailed(e); },
            });
            this.ix.bind(this.pm);               // gestures per plot instance, cursor hook, overlay drawer
            if (this._plotsSize) this.pm.resize(this._plotsSize.w, this._plotsSize.h);
            // layout size, not getBoundingClientRect: under the Designer canvas zoom (a CSS transform on an ancestor)
            // the bounding rect is the SCALED size, and the plots would be drawn at the zoomed size once more
            else if (this._plotsEl.clientWidth != null) this.pm.resize(this._plotsEl.clientWidth || 0, this._plotsEl.clientHeight || 0);
          }
          // a new cursorSyncGroup (run time / Designer) rebuilds the plots with the new uPlot sync key
          // (the key is part of each plot's signature), so it applies without a reload
          this.pm.syncKey = syncKey;
          this.pm.update(this._vm);
          var an = this._model && this._model.annotations;
          var annSig = an ? [an.rev, an.count, an.pending, this.annotationsShown()].join('|') : '';
          if (annSig !== this._annSig) { this._annSig = annSig; this.pm.redrawOverlays(); }
          if (this.timing.firstDraw == null && this.pm.plots.some(function (r) { return r.data && r.data[0] && r.data[0].length > 1; })) {
            this.timing.firstDraw = perfNow();
          }
        } catch (e) {
          this._plotFailed(e);
        }
        this._rs.update();
        this._ensureSlide();
      }
      _plotFailed(e) {
        log.error('plot failed', e);
        if (this.pm) { try { this.pm.destroy(); } catch (e2) { /* ignore */ } this.pm = null; }
        if (this._alive && !this.state.plotError) this.setState({ plotError: String((e && e.message) || e).slice(0, 200) });
      }
      _reloadPlots() {
        if (this.pm) { this.pm.destroy(); this.pm = null; }
        this.setState({ plotError: null });
      }
      /** Live slide: only while realtime + following live + visible. */
      _ensureSlide() {
        var self = this;
        var e = this.engine;
        var want = this._alive && !!this.pm && !!e && e._realtime() && e.vp.followLive && !(typeof document !== 'undefined' && document.hidden);
        if (!want) { if (this._slideRaf) { cancelRaf(this._slideRaf); this._slideRaf = 0; } return; }
        if (this._slideRaf) return;
        var step = function () {
          self._slideRaf = 0;
          var en = self.engine;
          if (!self._alive || !self.pm || !en || !en._realtime() || !en.vp.followLive) return;
          if (self.ix.preview || self.ix.g) { self._slideRaf = raf(step); return; }    // a gesture owns the view
          var now = Date.now();
          var px = Math.max(1, self.pm.width - 80);
          var interval = Math.max(250, en.vp.span / px);
          if (now - self._lastSlide >= interval) {
            self._lastSlide = now;
            self.pm.refresh(en.viewport.get());
            self._rs.slide();
          }
          self._slideRaf = raf(step);
        };
        this._slideRaf = raf(step);
      }

      // ---- after render: outputs, a11y, ChartApi change notifications --------------------------------
      _afterRender() {
        var m = this._model;
        if (!m) return;
        if (m.state !== this._lastState) {
          var prevState = this._lastState;
          this._lastState = m.state;
          if (prevState != null && (m.state === 'stale' || m.state === 'error' || m.state === 'disconnected' || (prevState !== 'live' && m.state === 'live'))) {
            NS.a11y.announce(this._stateText(m));
          }
        }
        this._scheduleOutputs();
        this._openOnStart(m);
        var vp = m.viewport;
        var sig = {
          props: this.props.props, pens: stableJson(this._pens.map(function (x) { return [x.key, x.status, x.visible, x.color, x.label, x.axisKey]; })),
          viewport: stableJson(vp.followLive ? [true, vp.span] : [false, vp.min, vp.max]),
          caps: stableJson([m.capabilities, this.props.props.enabled, this.designMode()]),
        };
        var last = this._lastNotify;
        if (last && this.api) {
          var what = { props: last.props !== sig.props, pens: last.pens !== sig.pens, viewport: last.viewport !== sig.viewport, capabilities: last.caps !== sig.caps };
          if (what.props || what.pens || what.viewport || what.capabilities) this.api._notify(what);
        }
        this._lastNotify = sig;
      }
      _openOnStart(m) {
        var p = this.props.props;
        if (this._openedOnStart || m.state !== 'empty' || !p.tagBrowser.openOnStart || this.designMode()) return;
        var caps = chartCapabilities(this);
        if (!caps.tagBrowser.allowed || !NS.chart.panels.get('tagBrowser')) return;
        this._openedOnStart = true;
        this.openPanel('tagBrowser', { source: 'openOnStart' });
      }
      /** outputs.*: written on change only, never in the Designer. */
      _scheduleOutputs() {
        var self = this;
        if (this._outTimer || this.designMode() || this.designer()) return;
        this._outTimer = setTimeout(function () { self._outTimer = null; self._writeOutputs(); }, 150);
      }
      _writeOutputs() {
        if (!this._alive || !this.engine || this.designMode() || this.designer()) return;
        var m = this.engine.model();
        var vp = m.viewport;
        var lu = m.lastUpdate || null;
        if (lu != null && lu - this._outLastUpdate < OUTPUT_LAST_UPDATE_MS && this._lastOut) lu = this._outLastUpdate || lu;
        var out = {
          range: vp.min == null ? { start: null, end: null, followLive: !!vp.followLive }
            : { start: Math.round(vp.min), end: Math.round(vp.max), followLive: !!vp.followLive },
          // the schema documents loading | live | paused | historical | stale | error | empty: the two transport
          // states map onto them (connecting = loading, disconnected = stale; the message says which)
          status: { state: OUTPUT_STATE[m.state] || m.state,
            message: m.banner ? m.banner.message : (m.state === 'stale' || m.state === 'disconnected' ? this._stateText(m) : ''), lastUpdate: lu },
          pens: this._pens.map(function (vm) { return { key: vm.key, tagPath: vm.tagPath, name: vm.label, source: vm.source, visible: vm.visible, status: vm.status }; }),
        };
        // following live, start/end move every tick: the range is rewritten only when its state changes
        var rangeKey = vp.followLive ? stableJson([true, Math.round(vp.span)]) : stableJson([false, out.range.start, out.range.end]);
        var cmp = stableJson([rangeKey, out.status, out.pens]);
        if (this._lastOut === cmp) return;
        var prevRange = this._lastOutRange;
        if (vp.followLive && prevRange && prevRange.key === rangeKey) out.range = prevRange.value;
        this._lastOut = cmp;
        this._lastOutRange = { key: rangeKey, value: out.range };
        if (lu != null) this._outLastUpdate = lu;
        this.writeProp('outputs', out);
      }
      _stateText(m) {
        var tz = this.engine ? this.engine.timeZone : null;
        if (m.state === 'stale' && m.staleSince) return NS.i18n.t('chart.state.stale', { time: NS.time.format(m.staleSince, 'HH:mm:ss', tz) });
        return NS.i18n.t('chart.state.' + m.state);
      }

      // ---- user actions -------------------------------------------------------------------------
      _setMode(mode) {
        if (this.designMode()) return;
        var raw = jsonCopy(this.props.store.props.read('interaction'));
        var obj = NS.util.isPlainObject(raw) ? raw : jsonCopy(this.props.props.interaction);
        obj.mode = mode;
        this.setState({ modeOverride: mode });
        this._ovAt[MODE_OV] = Date.now();
        this._scheduleOverrideExpiry();
        if (!this.writeProp('interaction', obj)) this._dropOverride(null);
      }
      _toggleVisible(vm) {
        if (this.designMode() || !this.props.props.penTable.allowHide) return;
        var next = !vm.visible;
        var key, value;
        if (vm.source === 'trend') {
          var tp = jsonCopy(this.props.store.props.read('trendPens'));
          if (!NS.util.isPlainObject(tp)) tp = jsonCopy(this.props.props.trendPens);
          if (!NS.util.isPlainObject(tp)) return;
          var list = Array.isArray(tp.overrides) ? tp.overrides : [];
          var nk = NS.util.normKey(vm.tagPath);
          var hit = list.filter(function (o) { return o && NS.util.normKey(o.tagPath) === nk; })[0];
          if (hit) hit.visible = next;
          else list.push({ tagPath: vm.tagPath, visible: next });
          tp.overrides = list;
          key = 'trendPens'; value = tp;
        } else {
          var pens = jsonCopy(this.props.store.props.read('pens'));
          // by identity, like _removePen: vm.index comes from the last chart.pens push, and another
          // writer (Settings reorder / delete, a binding, a script) may have moved the pens since
          var at = staticPenIndex(pens, vm);
          if (at < 0 || !NS.util.isPlainObject(pens[at])) return;      // nothing to write: no override
          pens[at].visible = next;
          key = 'pens'; value = pens;
        }
        // optimistic: the row and the plot follow the click at once; the override is dropped when the props
        // agree (_clearSettledOverrides), when the write fails, or after OVERRIDE_TTL_MS (a binding reverted it)
        this._setVisOverride(vm.key, next);
        if (this.pm) this.pm.focusPen(null);
        if (!this.writeProp(key, value)) { this._dropOverride(vm.key); return; }
        this.fire('onPensChange', { action: 'edit', tagPath: vm.tagPath, source: vm.source === 'trend' ? 'trend' : 'pens' });
      }
      _setVisOverride(penKey, visible) {
        this._ovAt[penKey] = Date.now();
        this.setState(function (st) {
          var ov = Object.assign({}, st.visOverride);
          ov[penKey] = visible;
          return { visOverride: ov };
        });
        this._scheduleOverrideExpiry();
      }
      /** Drops one optimistic override (penKey; null = the mode override). */
      _dropOverride(penKey) {
        if (!this._alive) return;
        if (penKey == null) {
          delete this._ovAt[MODE_OV];
          this.setState({ modeOverride: null });
          return;
        }
        delete this._ovAt[penKey];
        this.setState(function (st) {
          if (!hasOwn.call(st.visOverride, penKey)) return null;
          var ov = Object.assign({}, st.visOverride);
          delete ov[penKey];
          return { visOverride: ov };
        });
      }
      _scheduleOverrideExpiry() {
        var self = this;
        if (this._ovTimer) return;
        this._ovTimer = setTimeout(function () {
          self._ovTimer = null;
          if (!self._alive) return;
          var now = Date.now();
          var left = false;
          Object.keys(self._ovAt).forEach(function (k) {
            if (now - self._ovAt[k] >= OVERRIDE_TTL_MS) self._dropOverride(k === MODE_OV ? null : k);
            else left = true;
          });
          if (left) self._scheduleOverrideExpiry();
        }, OVERRIDE_TTL_MS / 2);
      }
      /** Drops optimistic overrides the props now agree with. */
      _clearSettledOverrides() {
        var self = this;
        var ov = this.state.visOverride;
        var keys = Object.keys(ov);
        var mo = this.state.modeOverride;
        var patch = {};
        if (mo && this.props.props.interaction.mode === mo) { patch.modeOverride = null; delete this._ovAt[MODE_OV]; }
        if (keys.length) {
          var left = {};
          var changed = false;
          var pens = this.engine ? buildPens(this.engine.model().pens, this.props.props, { background: this._background(), resolve: this._resolveColorFn() }) : [];
          keys.forEach(function (k) {
            var vm = pens.filter(function (x) { return x.key === k; })[0];
            if (!vm || vm.visible === ov[k]) { changed = true; delete self._ovAt[k]; }      // settled, or the pen is gone
            else left[k] = ov[k];
          });
          if (changed) patch.visOverride = left;
        }
        if (Object.keys(patch).length) this.setState(patch);
      }
      _useAggregated() {
        var raw = jsonCopy(this.props.store.props.read('query'));
        var q = NS.util.isPlainObject(raw) ? raw : jsonCopy(this.props.props.query);
        q.mode = 'aggregated';
        this.writeProp('query', q);
      }
      _returnToLive() {
        if (this.ix) this.ix.cancelGesture();      // a left-over gesture preview would win over the new view
        var v = this.engine.viewport.get();
        var now = NS.clock.now();
        this.engine.viewport.set({ min: now - v.span, max: now });
        this.userRange();
      }
      _resetZoom() {
        if (this.ix) this.ix.cancelGesture();      // Reset / Home / double-click also end a running gesture
        this.engine.viewport.reset();
        this.userRange();
      }
      _resetNeeded(m) {
        var vp = m.viewport, w = m.window;
        if (!w || !vp) return false;
        if (m.mode === 'realtime') return !vp.followLive || Math.abs(vp.span - w.span) > SECOND;
        return vp.min == null || Math.abs(vp.min - w.start) > SECOND || Math.abs(vp.max - w.end) > SECOND;
      }

      // ---- fullscreen ----------------------------------------------------------------------------------
      /**
       * Fullscreen button: the Fullscreen API on the component root; where it is missing or refuses (Workstation,
       * a cross-origin frame, a binding without a user gesture) the "maximised" fallback — the root itself becomes
       * position:fixed over the page (z-index --ctg-z-max 10500: above the primary view, below Perspective
       * popups), rendered in place (no portal: the React
       * tree and the delegate stay). Esc leaves both. interaction.fullscreen follows (not in the Designer).
       */
      _toggleFullscreen() {
        if (this.state.fs !== 'off') this._exitFullscreen(true);
        else this._enterFullscreen(true);
      }
      _enterFullscreen(gesture) {
        var self = this;
        var el = this._rootEl;
        if (!el || this.designMode()) return;
        var api = gesture && typeof el.requestFullscreen === 'function' && (typeof document === 'undefined' || document.fullscreenEnabled !== false);
        if (!api) { this._maximise(true); return; }
        var p;
        try { p = el.requestFullscreen(); } catch (e) { p = Promise.reject(e); }
        Promise.resolve(p).then(function () {
          if (!self._alive) return;
          if (document.fullscreenElement === el) {
            self.setState({ fs: 'native' });
            self._listenEsc();
            self.writeInteraction('fullscreen', true);
          } else self._maximise(true);
        }, function (e) {
          log.debug('requestFullscreen refused, maximising instead', e && e.message);
          if (self._alive) self._maximise(true);
        });
      }
      _maximise(write) {
        if (!this._alive && this.engine == null) return;
        this.setState({ fs: 'max' });
        this._listenEsc();
        if (write) this.writeInteraction('fullscreen', true);
      }
      _exitFullscreen(write) {
        var el = this._rootEl;
        var native = this.state.fs === 'native';
        this._unlistenMax();
        this.setState({ fs: 'off' });
        if (native && el && typeof document !== 'undefined' && document.fullscreenElement === el && document.exitFullscreen) {
          try { document.exitFullscreen().catch(function () { }); } catch (e) { /* ignore */ }
        }
        if (write) this.writeInteraction('fullscreen', false);
      }
      /** The browser left fullscreen (its own Esc / UI): follow it. */
      _onFullscreenChange() {
        if (!this._alive || this.state.fs !== 'native') return;
        if (document.fullscreenElement !== this._rootEl) {
          this._unlistenMax();
          this.setState({ fs: 'off' });
          this.writeInteraction('fullscreen', false);
        }
      }
      /** Esc leaves fullscreen / maximised — unless an overlay (menu, dialog) is open: Esc closes that first. */
      _listenEsc() {
        var self = this;
        if (this._escOff || typeof W.addEventListener !== 'function') return;
        var fn = function (e) {
          if ((e.key === 'Escape' || e.key === 'Esc') && self.state.fs !== 'off' && !NS.overlay.isOpen() && !(self.ix && self.ix.g)) {
            self._exitFullscreen(true);
          }
        };
        W.addEventListener('keydown', fn);
        this._escOff = function () { W.removeEventListener('keydown', fn); };
      }
      _unlistenMax() { if (this._escOff) { this._escOff(); this._escOff = null; } }

      // ---- menus, refresh rate (narrow layout, More) --------------------------------------------------------
      _anchorOf(ev) {
        var t = ev && ev.currentTarget;
        var r = t && t.getBoundingClientRect ? t.getBoundingClientRect() : null;
        return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null;
      }
      _openMenu(kind, ev) {
        if (this.designMode()) return;
        if (this.state.menu && this.state.menu.kind === kind) { this.setState({ menu: null }); return; }
        var r = this._anchorOf(ev);
        this.setState({ menu: { kind: kind, x: r ? r.left : 0, y: r ? r.bottom + 2 : 0, anchorRect: r, returnFocus: ev && ev.currentTarget,
          keyboard: !!(ev && ev.detail === 0) } });
      }
      _setRefreshRate(v) {
        var raw = jsonCopy(this.props.store.props.read('timeRange'));
        var tr = NS.util.isPlainObject(raw) ? raw : jsonCopy(this.props.props.timeRange);
        tr.refreshRate = v;
        this.writeProp('timeRange', tr);
        this.setState({ rate: null });
      }

      // ---- pen table actions ------------------------------------------------------------------------------
      /**
       * Remove a pen: a static pen leaves `pens` (whole array, raw from the tree; the gateway then pushes
       * chart.pens); a trend pen goes through chart.trendRemove (gated on the gateway by trendEdit). An error
       * reply shows a toast with its text. onPensChange {action:"remove"} after success.
       */
      _removePen(vm, btn) {
        var self = this;
        if (this.designMode() || !this.props.props.enabled) return;
        if (this._isRemoving(vm)) return;                    // already on its way out (double click / race)
        this._rememberRemoveFocus(btn);
        var removeFailed = function (msg) {
          NS.ui.Toast.show({ key: 'ctg-chart-remove-' + self.chartId, tone: 'error', durationMs: 8000,
            text: NS.i18n.t('chart.pen.removeFailed', { name: vm.label, message: msg }) });
        };
        if (vm.source === 'trend') {
          var d = this.engine && this.engine.source;
          if (!d || typeof d.request !== 'function') return;
          var pend = this._markRemoving(vm);
          d.request('chart.trendRemove', { tagPath: vm.tagPath }, { timeoutMs: 8000 }).then(function (res) {
            if (!self._alive) return;
            if (res && res.ok) {
              NS.a11y.announce(NS.i18n.t('chart.pen.removed', { name: vm.label }));
              self.fire('onPensChange', { action: 'remove', tagPath: vm.tagPath, source: 'trend' });
              return;
            }
            self._unmarkRemoving(pend);
            var err = (res && res.error) || {};
            removeFailed((err.code && NS.i18n.errorText(err.code, err.details)) || err.message || err.code || '');
          });
          return;
        }
        // A static pen: `pens` is read raw from the tree (an earlier removal may already have shifted it), so the
        // PenVM's index from the last chart.pens push is only trusted when that entry still names the same tag;
        // otherwise the pen is looked up by its normalized tagPath.
        var raw = jsonCopy(this.props.store.props.read('pens'));
        if (!Array.isArray(raw)) return;
        var i = staticPenIndex(raw, vm);
        if (i < 0) {
          removeFailed(NS.i18n.t('chart.pen.removeStale'));
          this.forceUpdate();
          return;
        }
        var gone = raw.splice(i, 1)[0];
        if (this.writeProp('pens', raw)) {
          this._markRemoving(vm);
          NS.a11y.announce(NS.i18n.t('chart.pen.removed', { name: vm.label }));
          this.fire('onPensChange', { action: 'remove', tagPath: gone && gone.tagPath != null ? String(gone.tagPath) : vm.tagPath, source: 'pens' });
        }
      }
      /**
       * Rows whose removal was sent are shown disabled until the next chart.pens push (or 10 s, or a refusal):
       * their PenVM (index, key) describes the pen set before the removal. Identity = source + key + tag.
       */
      _markRemoving(vm) {
        var ent = { source: vm.source, key: vm.key, nk: NS.util.normKey(vm.tagPath), sig: this._pensSig, at: Date.now() };
        this._removing = (this._removing || []).concat([ent]);
        this.forceUpdate();
        return ent;
      }
      _unmarkRemoving(ent) {
        if (!this._removing) return;
        this._removing = this._removing.filter(function (x) { return x !== ent; });
        if (this._alive) this.forceUpdate();
      }
      _isRemoving(vm) {
        var list = this._removing;
        if (!list || !list.length) return false;
        var nk = NS.util.normKey(vm.tagPath);
        return list.some(function (x) { return x.source === vm.source && x.key === vm.key && x.nk === nk; });
      }
      /** Called with every new view model: a changed pen set (chart.pens arrived) or age > 10 s ends "removing". */
      _pruneRemoving(sig) {
        this._pensSig = sig;
        if (!this._removing || !this._removing.length) return;
        var now = Date.now();
        this._removing = this._removing.filter(function (x) { return x.sig === sig && now - x.at < 10000; });
      }
      _askRemove(vm, ev) {
        if (this.props.props.penTable.confirmRemove) {
          // bound to the pen's identity (source + tag), not to its index-based row key
          this.setState({ confirm: { penKey: vm.key, source: vm.source, nk: NS.util.normKey(vm.tagPath), anchorRect: this._anchorOf(ev), returnFocus: ev && ev.currentTarget } });
        } else this._removePen(vm, ev && ev.currentTarget);
      }
      /**
       * Focus after a pen removal: the row and its remove button unmount once the pens push arrives, and focus
       * would fall to <body>. The button's position among the table's remove buttons is remembered; once it is gone,
       * focus moves to the remove button now at that position, else the previous one, else the pen-table toggle or
       * the chart root (_restoreRemoveFocus, from componentDidUpdate).
       */
      _rememberRemoveFocus(btn) {
        var root = this._rootEl;
        if (!btn || !root || typeof root.querySelectorAll !== 'function') return;
        var all = Array.prototype.slice.call(root.querySelectorAll('[data-ctg="pen-remove"]'));
        var i = all.indexOf(btn);
        if (i >= 0) this._removeFocus = { btn: btn, index: i, at: Date.now() };
      }
      _restoreRemoveFocus() {
        var rf = this._removeFocus;
        if (!rf || typeof document === 'undefined') return;
        if (Date.now() - rf.at > 15000) { this._removeFocus = null; return; }
        if (rf.btn.isConnected !== false || this.state.confirm) return;     // the row is still there
        this._removeFocus = null;
        var root = this._rootEl;
        var active = document.activeElement;
        if (!root || (active && active !== document.body && active.isConnected !== false)) return;   // focus went somewhere on purpose
        var all = Array.prototype.slice.call(root.querySelectorAll('[data-ctg="pen-remove"]')).filter(function (b) { return !b.disabled; });
        var target = all[Math.min(rf.index, all.length - 1)] || root.querySelector('[data-ctg="pen-table-toggle"]') || root;
        NS.ui.focusEl ? NS.ui.focusEl(target) : (target.focus && target.focus());
      }
      /**
       * What a pen row may do: {color, edit, remove, removeReason, inert} (hidden when !enabled). Design
       * mode shows the same buttons as runtime (so the pen table has its runtime width and look) but `inert`: they are
       * rendered disabled and every action also refuses itself in design mode.
       */
      _penActions(vm, p, caps) {
        var pt = p.penTable;
        var reg = NS.chart.panels;
        var out = { color: false, edit: false, remove: false, removeReason: null, removing: false, inert: this.designMode() };
        if (!p.enabled) return out;
        if (this._isRemoving(vm)) {
          // a removal is on its way: the row's actions describe the pen set before it
          out.removing = true;
          out.remove = true;
          out.removeReason = NS.i18n.t('chart.pen.removing');
          return out;
        }
        out.color = pt.allowColorChange && !!reg.get('color') && vm.status !== 'outOfScope';
        out.edit = pt.allowEdit && !!reg.get('settings') && !!(caps && caps.settingsPanel.enabled && caps.settingsPanel.tabs.pens);
        if (pt.allowRemove) {
          if (vm.source === 'trend') {
            out.remove = true;
            if (!(caps && caps.trendEdit.allowed)) {
              var code = (caps && caps.trendEdit.reason) || 'ACTION_DISABLED';
              out.removeReason = NS.i18n.errorText(code) || code;
            }
          } else out.remove = vm.index != null;
        }
        return out;
      }

      // ---- range brush statistics ---------------------------------------------------------------------------
      /** Stops the running exact-stats request / its retry timer (the entry is dropped: it is fetched again later). */
      _abortExact() {
        var ex = this._exact;
        this._exact = null;
        if (this._exactRetryT) { clearTimeout(this._exactRetryT); this._exactRetryT = 0; }
        if (ex && ex.loading) {
          if (ex.ac) { try { ex.ac.abort(); } catch (e) { /* ignore */ } }
          ex.ac = null;
          this._exactCache.delete(ex.key);
        }
      }
      /**
       * Exact statistics for a brush (rangeBrush.exactStats): when a pen's data in the range is aggregated, ONE
       * raw request (ChartApi history.fetchRaw semantics: priority user, onTooManyPoints "aggregate") for those
       * pens over [start, end]; the result is kept per brush geometry (id + range + pens, up to EXACT.cache
       * entries), so switching between brushes does not fetch again. Pens are identified by their DATA key (tag +
       * aggregation), never by the index-based PenVM key: after a reorder / remove + add, `p:N` names another
       * tag, and a cache keyed by it would show that tag's numbers as exact.
       *
       * Failures: a busy / timeout / network answer is retried with backoff (<= EXACT.retries; the history queue
       * also holds the request back for a 429's Retry-After). After that the stats stay approximate ("≈" in the
       * table, a note in the brush bar, an "Approximate" column in Copy stats). The failure is classified PER PEN:
       * a needed pen whose answer is a transient status (EXACT_TRANSIENT_PEN), or that got no answer, or a
       * whole request refused for a retryable reason makes the entry transient — it is not cached and, while its
       * brush stays selected, fetched again by an explicit EXACT.failedTtlMs timer (no render needed; cancelled by
       * _abortExact and unmount). A definitive per-pen answer (error, accessDenied, notFound, …) is cached like a
       * success: asking again would give the same. A downgraded answer (too many raw points) keeps the "≈" marker.
       *
       * Memory: entries of brush geometries that no longer exist are dropped whenever the brushes change
       * (_pruneExact: move, resize, remove, Clear, a binding), and the cached raw samples are bounded by
       * _trimExact (see EXACT.pointsShare).
       */
      _exactFor(br, vms, p) {
        var e = this.engine;
        if (!e || !p.interaction.rangeBrush.exactStats) return null;
        var need = [];
        vms.forEach(function (vm) {
          var pd = e.penData(vm.key);
          // a statistic aggregation (Count, DurationOn…) has no raw equivalent: it stays approximate
          if (pd && pd.approx && isValueAgg(pd.aggregation) && need.indexOf(pd.key) < 0) need.push(pd.key);
        });
        if (!need.length) return null;
        need.sort();                               // order-independent: a reorder of the same pens is a cache hit
        var key = br.id + '|' + br.start + '|' + br.end + '|' + need.join(',');
        var cur = this._exact;
        if (cur && cur.key === key) return cur;
        this._abortExact();
        var ex = this._exactCache.get(key);
        if (ex) {
          this._exactCache.delete(key);              // most recently used last
          this._exactCache.set(key, ex);
          this._exact = ex;
          return ex;
        }
        ex = { key: key, brushKey: exactBrushKey(br), loading: true, failed: false, transient: false, failedAt: 0, views: {},
          ac: null, attempt: 0, start: br.start, end: br.end, need: need, points: 0 };
        this._exactCache.set(key, ex);
        while (this._exactCache.size > EXACT.cache) this._exactCache.delete(this._exactCache.keys().next().value);
        this._exact = ex;
        this._fetchExact(ex);
        return ex;
      }
      _fetchExact(ex) {
        var self = this;
        var e = this.engine;
        if (!e) return;
        // the PenVM keys that name the needed data NOW (fetchRaw resolves them synchronously, and answers per
        // PenVM key): the answer is mapped back to data keys with this request-time table
        var dkOf = {};
        var penKeys = [];
        (e.pens || []).forEach(function (pen) {
          if (pen.dataKey && ex.need.indexOf(pen.dataKey) >= 0 && !hasOwn.call(dkOf, pen.key) &&
              !penKeys.some(function (k) { return dkOf[k] === pen.dataKey; })) {
            dkOf[pen.key] = pen.dataKey;
            penKeys.push(pen.key);
          }
        });
        var ac = typeof W.AbortController === 'function' ? new W.AbortController() : null;
        ex.ac = ac || true;
        var mine = ex.ac;
        e.fetchRaw({ start: ex.start, end: ex.end, penKeys: penKeys, signal: ac ? ac.signal : undefined }).then(function (res) {
          if (self._exact !== ex || !self._alive || ex.ac !== mine) return;
          ex.ac = null;
          var code = res && res.error;
          if (code && EXACT_RETRYABLE[code] && ex.attempt < EXACT.retries) {
            ex.attempt++;
            self._exactRetryT = setTimeout(function () {
              self._exactRetryT = 0;
              if (self._alive && self._exact === ex) self._fetchExact(ex);
            }, backoffMs('busy', ex.attempt, null));
            return;
          }
          ex.loading = false;
          if (code) { ex.failed = true; log.info('exact brush statistics unavailable', code); }
          var answered = {};
          ((res && res.pens) || []).forEach(function (rp) {
            var dk = rp && hasOwn.call(dkOf, rp.key) ? dkOf[rp.key] : null;
            if (!dk) return;
            answered[dk] = rp.status;
            if (rp.status !== 'ok') return;
            ex.views[dk] = { view: rawView(rp), approx: !!rp.downgraded };
          });
          ex.points = exactPoints(ex);
          var missing = ex.need.filter(function (k) { return !ex.views[k]; });
          if (missing.length) {
            ex.failed = true;
            ex.failedAt = Date.now();
            // transient: the whole request was refused for a retryable reason, or a needed pen got a transient status
            // or no answer at all; definitive per-pen answers (error, accessDenied, notFound, ...) are kept
            ex.transient = code ? !!EXACT_RETRYABLE[code]
              : missing.some(function (k) { return !hasOwn.call(answered, k) || !!EXACT_TRANSIENT_PEN[answered[k]]; });
            if (ex.transient) {
              if (self._exactCache.get(ex.key) === ex) self._exactCache.delete(ex.key);
              // fetched again after the TTL while this brush stays selected: a timer, so a paused / historical
              // chart that does not re-render retries too
              self._exactRetryT = setTimeout(function () {
                self._exactRetryT = 0;
                if (!self._alive || self._exact !== ex) return;
                self._exact = null;                    // the next render's _exactFor starts a fresh entry
                self._brushCache.clear();
                self.forceUpdate();
              }, EXACT.failedTtlMs);
            }
          }
          self._trimExact();
          self._brushCache.clear();
          self.forceUpdate();
        });
      }
      /**
       * Drops cached exact statistics of brush geometries that no longer exist: a moved / resized brush gets
       * a new entry, and the old position can never be shown again; Clear and remove drop theirs. The selected
       * entry is aborted when its brush is gone. Called after every change of the brushes (ixChanged).
       */
      _pruneExact() {
        var live = {};
        (this.ix ? this.ix.brushes : []).forEach(function (b) { live[exactBrushKey(b)] = true; });
        var self = this;
        Array.from(this._exactCache.keys()).forEach(function (k) {
          var ex = self._exactCache.get(k);
          if (!live[ex.brushKey]) self._exactCache.delete(k);
        });
        if (this._exact && !live[this._exact.brushKey]) this._abortExact();
        this._brushCache.clear();
      }
      /**
       * Bounds the cached raw samples: they count against the chart's memory guard. The cache keeps at most
       * EXACT.pointsShare of ENGINE.maxHeldPoints and never more than the engine leaves free of it; least recently
       * used entries go first. The selected entry stays usable while selected (it is what the table shows) but
       * leaves the cache when it alone is over the budget, so it is not kept once another brush is selected.
       */
      _trimExact() {
        var held = this.engine ? this.engine.store.heldPoints() : 0;
        var budget = Math.max(0, Math.min(ENGINE.maxHeldPoints * EXACT.pointsShare, ENGINE.maxHeldPoints - held));
        var total = 0;
        this._exactCache.forEach(function (ex) { total += ex.points || 0; });
        var cur = this._exact;
        var self = this;
        Array.from(this._exactCache.keys()).forEach(function (k) {
          var ex = self._exactCache.get(k);
          if (total <= budget || (ex === cur && (ex.points || 0) <= budget)) return;     // others go first
          self._exactCache.delete(k);
          total -= ex.points || 0;
        });
        if (cur && (cur.points || 0) > budget && this._exactCache.get(cur.key) === cur) this._exactCache.delete(cur.key);
      }
      /** Raw points held for exact statistics: the cache plus the selected entry when it is not cached (tests, debug). */
      exactHeldPoints() {
        var n = 0;
        this._exactCache.forEach(function (ex) { n += ex.points || 0; });
        if (this._exact && this._exactCache.get(this._exact.key) !== this._exact) n += this._exact.points || 0;
        return n;
      }
      /** The brush view of the pen table: {brush, stats{penKey}, loading, approx} or null. */
      _brushView(p) {
        var ix = this.ix;
        if (this.mode() !== 'rangeBrush' || !ix.brushes.length || !this.engine) return null;
        var br = ix.brushById(ix.selBrush) || ix.brushes[ix.brushes.length - 1];
        var e = this.engine;
        var vms = this._pens.filter(function (vm) { return vm.status === 'ok'; });
        var ex = this._exactFor(br, vms, p);
        var cl = p.interaction.rangeBrush.controlLimits;
        var follow = e._realtime() && e.vp.followLive;
        var now = NS.clock.now();
        var cache = this._brushCache;
        if (cache.size > 64) cache.clear();
        var stats = {};
        var approx = false;
        vms.forEach(function (vm) {
          var pd = e.penData(vm.key);
          var exv = ex && !ex.loading && pd ? ex.views[pd.key] || null : null;
          // keyed by the pen's data (tag + aggregation), not its index-based row key (a reorder moves `p:N`)
          var ck = [br.id, br.start, br.end, pd ? pd.key : '#' + vm.key, pd ? pd.rev : 0, pd ? pd.liveRev : 0, exv ? 'x' : '-', cl.method, cl.sigma, follow].join('|');
          var s = cache.get(ck);
          if (!s) {
            var view = exv ? exv.view : e.penView(vm.key);
            var n = view.t.length;
            // the value is held until the brush end when the pen has data after it; following live, until now;
            // otherwise until the end of what the historian answered for, not only until the last sample
            // (the exact view is a raw re-fetch that covers the brush up to its end)
            var ke = exv ? Math.min(br.end, now) : knownEndOf(pd);
            var lk = n && view.t[n - 1] > br.end ? br.end : follow ? Math.min(br.end, now)
              : ke != null ? Math.min(br.end, ke) : null;
            s = statsFor(view, br.start, br.end, { approx: exv ? exv.approx : !!(pd && pd.approx), lastKnownTime: lk,
              sigma: cl.sigma, method: cl.method, median: true, pairs: exv ? !!exv.approx : hasPairs(pd) });
            cache.set(ck, s);
          }
          stats[vm.key] = s;
          if (s.approx) approx = true;
        });
        return { brush: br, stats: stats, loading: !!(ex && ex.loading), approx: approx, exactFailed: !!(ex && ex.failed) };
      }
      /** "Copy stats": TSV of the brush view (pen + the shown range columns), synchronously in the click handler. */
      _copyStats(bv, cols) {
        var self = this;
        // rows computed from aggregated data are marked in an extra last column (present only when there are any)
        var anyApprox = this._pens.some(function (vm) { var s = bv.stats[vm.key]; return !!(s && s.approx); });
        var head = [NS.i18n.t('chart.rows.pen')].concat(cols.map(function (c) { return NS.i18n.t('chart.rcol.' + c.id); }));
        if (anyApprox) head.push(NS.i18n.t('chart.brush.tsvApprox'));
        var lines = [head.map(tsvCell).join('\t')];
        this._pens.forEach(function (vm) {
          var s = bv.stats[vm.key];
          if (!s) return;
          var row = [tsvCell(vm.label)].concat(cols.map(function (c) { var v = s[c.stat]; return v == null ? '' : String(v); }));
          if (anyApprox) row.push(s.approx ? tsvCell(NS.i18n.t('chart.brush.tsvApproxYes')) : '');
          lines.push(row.join('\t'));
        });
        copyText(lines.join('\n') + '\n', function (ok) {
          if (!self._alive) return;
          NS.a11y.announce(NS.i18n.t(ok ? 'chart.brush.copied' : 'chart.brush.copyFailed'));
          if (!ok) NS.ui.Toast.show({ key: 'ctg-chart-copy-' + self.chartId, tone: 'error', durationMs: 5000, text: NS.i18n.t('chart.brush.copyFailed') });
        });
      }

      // ---- render -------------------------------------------------------------------------------
      render() {
        var self = this;
        var p = this.props.props;
        var d = this.props.delegate || {};
        var e = this.engine;
        var m = e ? e.model() : null;
        this._model = m;
        var design = this.designMode();
        var mode = this.mode();
        var narrow = this.state.narrow, small = this.state.small;
        var classes = ['ctg-chart'];
        if (design) classes.push('ctg-chart--design');
        if (narrow) classes.push('ctg-chart--narrow');
        if (small) classes.push('ctg-chart--small');
        if (this.state.fs === 'native') classes.push('ctg-chart--fullscreen');
        if (this.state.fs === 'max') classes.push('ctg-chart--maximised');
        var rootProps = this.props.emit({ classes: classes });
        rootProps.ref = this._rootRef(rootProps.ref);
        rootProps['data-ctg'] = 'chart';
        rootProps['data-chart-phase'] = d.phase || 'idle';
        rootProps['data-ctg-mode'] = mode;
        rootProps['data-ctg-fs'] = this.state.fs;
        rootProps.style = Object.assign({}, rootProps.style, { '--ctg-chart-fs': p.appearance.fontSize + 'px' });
        if (!m) {
          rootProps['data-ctg-state'] = 'loading';
          return h('div', rootProps, h('div', { className: 'ctg-chart__body' }, h('div', { className: 'ctg-chart__empty' }, NS.i18n.t('chart.loading'))));
        }
        rootProps['data-chart-id'] = m.id;
        rootProps['data-chart-state'] = m.state;
        rootProps['data-ctg-state'] = m.state;
        // the view model is built here (toolbar, main and pen table share it); a failure is re-thrown inside the
        // main area's boundary instead of taking the whole chart down
        var caps = null, vmError = null;
        try {
          this._buildVM(m);
          caps = chartCapabilities(this);
        } catch (err) {
          vmError = err;
          log.error('chart view model failed', err);
        }
        var children = [];
        if (p.title.visible && p.title.text && !small) {
          var ts = mergeStyles(p.styles.title, p.title.style);
          children.push(h('div', { key: 'title', className: 'ctg-chart__title' + (ts.className ? ' ' + ts.className : ''), style: ts.style, title: p.title.text }, p.title.text));
        }
        var rerender = function () { if (self._alive) self.forceUpdate(); };
        if (p.toolbar.visible && !vmError) {
          children.push(guarded('toolbar', 'toolbar', function () { return self._renderToolbar(m, p, caps, design, mode); }, rerender));
        }
        // narrow: docked panels open as a full overlay of the component with a "Back" header
        var docks = narrow ? { left: [], right: [] } : { left: this._renderPanels('left'), right: this._renderPanels('right') };
        var tableRight = p.penTable.visible && p.penTable.position === 'right' && !vmError && !narrow;
        var penTable = function () { return self._renderPenTable(m, p, design, tableRight, caps); };
        var body = h('div', { key: 'body', className: 'ctg-chart__body' },
          docks.left.length ? h('div', { key: 'dl', className: 'ctg-chart__dock ctg-chart__dock--left' }, docks.left) : null,
          guarded('eb', 'main', function () {
            if (vmError) throw vmError;
            return self._renderMain(m, p, caps, design);
          }, function () { self._reloadPlots(); }),
          docks.right.length ? h('div', { key: 'dr', className: 'ctg-chart__dock ctg-chart__dock--right' }, docks.right) : null,
          tableRight ? guarded('pentable', 'penTable', penTable, rerender) : null);
        children.push(body);
        if (p.penTable.visible && !tableRight && !vmError) children.push(guarded('pentable', 'penTable', penTable, rerender));
        if (narrow) {
          var sheet = this._renderPanels('left').concat(this._renderPanels('right'));
          if (sheet.length) {
            var names = Object.keys(this.state.panels).filter(function (n) { var df = NS.chart.panels.get(n); return df && (df.dock === 'left' || df.dock === 'right'); });
            var top = names[names.length - 1];
            children.push(h('div', { key: 'sheet', className: 'ctg-chart__sheet', 'data-ctg': 'sheet', role: 'region', 'aria-label': top || '' },
              h('div', { className: 'ctg-chart__sheet-head' },
                h('button', { type: 'button', className: 'ctg-tb-btn', 'data-ctg': 'sheet-back', onClick: function () { names.forEach(function (n) { self.closePanel(n); }); } },
                  Icon('back'), h('span', null, NS.i18n.t('chart.btn.back')))),
              h('div', { className: 'ctg-chart__sheet-body' }, sheet)));
          }
        }
        this._renderPanels('none').forEach(function (el) { children.push(el); });
        var v1 = p.v1Keys || [];
        if (v1.length && this.designer()) {
          children.push(h('span', { key: 'v1', className: 'ctg-v1-badge', 'data-ctg': 'v1-badge',
            title: NS.i18n.t('chart.v1Warn', { keys: v1.join(', ') }) }, NS.i18n.t('chart.v1Badge')));
        }
        return h('div', rootProps, children);
      }

      /** Toolbar (wide layout; narrow layout: date pill, mode menu, badge, More). */
      _renderToolbar(m, p, caps, design, mode) {
        var self = this;
        var b = p.toolbar.buttons;
        var reg = NS.chart.panels;
        var st = mergeStyles(p.styles.toolbar, p.toolbar.style);
        var narrow = this.state.narrow;
        var left = [], right = [];
        var panelBtn = function (name, icon, labelKey, show) {
          if (!show || !reg.get(name)) return null;
          var def = reg.get(name);
          var label = (def.button && def.button.label) || NS.i18n.t(labelKey);
          return h('button', {
            key: 'pb-' + name, type: 'button', className: 'ctg-tb-btn', 'data-ctg-panel': name, disabled: design,
            'aria-pressed': self.panelOpen(name) ? 'true' : 'false', 'aria-label': label, title: (def.button && def.button.title) || label,
            onClick: function (ev) { self._togglePanel(name, ev); },
          }, Icon(icon));
        };
        var showTags = b.tagBrowser && p.tagBrowser.enabled && caps.tagBrowser.allowed;
        var showExport = b.export && (caps.export.csv || caps.export.png);
        var showSettings = b.settings && caps.settingsPanel.enabled;
        if (!narrow) left.push(panelBtn('tagBrowser', 'tags', 'chart.btn.tags', showTags));
        if (b.dateRange) {
          var rl = rangeLabel(p, m, this.engine.timeZone);
          var canOpen = !!reg.get('dateRange') && !design;
          left.push(h('button', {
            key: 'pill', type: 'button', className: 'ctg-tb-pill' + (rl.zoomed ? ' ctg-tb-pill--zoomed' : ''), 'data-ctg': 'date-pill',
            disabled: !canOpen, 'aria-haspopup': canOpen ? 'dialog' : undefined, title: NS.i18n.t('chart.btn.dateRange'),
            onClick: function (ev) { self._togglePanel('dateRange', ev); },
          }, Icon('calendar'), h('span', { className: 'ctg-tb-pill__text' }, rl.text)));
          if (rl.zoomed && b.resetZoom) {
            left.push(h('button', {
              key: 'pillx', type: 'button', className: 'ctg-tb-btn', 'data-ctg': 'zoom-clear', disabled: design,
              'aria-label': NS.i18n.t('chart.btn.reset'), title: NS.i18n.t('chart.btn.reset'),
              onClick: function () { self._resetZoom(); },
            }, Icon('close')));
          }
        }
        var modes = MODES.filter(function (md) {
          if (!b[md]) return false;
          // annotate: the editor must be loaded and the historian must support annotations
          if (md === 'annotate') return p.annotations.enabled && caps.annotations.editAllowed && !!reg.get('annotation') &&
            !(m.annotations && m.annotations.unsupported);
          return true;
        });
        var pick = function (md) { if (md !== mode) self._setMode(md); };
        var modeGroup = null;
        if (modes.length > 1 && !narrow) {
          modeGroup = h('div', {
            key: 'modes', className: 'ctg-tb-modes', role: 'radiogroup', 'aria-label': NS.i18n.t('chart.toolbar.modes'),
            onKeyDown: function (ev) {
              var dir = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
              if (!dir || design) return;
              ev.preventDefault();
              var i = modes.indexOf(mode);
              var n = modes[(i + dir + modes.length) % modes.length];
              pick(n);
              var btn = ev.currentTarget.querySelector('[data-ctg-mode="' + n + '"]');
              if (btn) btn.focus();
            },
          }, modes.map(function (md) {
            var on = md === mode;
            return h('button', {
              key: md, type: 'button', role: 'radio', className: 'ctg-tb-mode', 'data-ctg-mode': md, 'aria-checked': on ? 'true' : 'false',
              tabIndex: on || (modes.indexOf(mode) < 0 && md === modes[0]) ? 0 : -1, disabled: design,
              title: NS.i18n.t('chart.mode.' + md + '.title'), onClick: function () { pick(md); },
            }, NS.i18n.t('chart.mode.' + md));
          }));
        } else if (modes.length > 1) {
          // narrow: one button with the current mode, opening a menu of the modes
          var mlabel = NS.i18n.t('chart.mode.' + (modes.indexOf(mode) >= 0 ? mode : modes[0]));
          modeGroup = h('button', {
            key: 'modebtn', type: 'button', className: 'ctg-tb-btn ctg-tb-modebtn', 'data-ctg': 'mode-menu', disabled: design,
            'aria-haspopup': 'menu', 'aria-expanded': this.state.menu && this.state.menu.kind === 'mode' ? 'true' : 'false',
            'aria-label': NS.i18n.t('chart.btn.mode', { mode: mlabel }), title: NS.i18n.t('chart.toolbar.modes'),
            onClick: function (ev) { self._openMenu('mode', ev); },
          }, h('span', null, mlabel), Icon('dropdown'));
        }
        if (p.appearance.liveBadge) right.push(this._renderBadge(m, design));
        if (!narrow) {
          if (b.refresh) {
            right.push(h('button', {
              key: 'refresh', type: 'button', className: 'ctg-tb-btn', 'data-ctg': 'refresh', disabled: design || m.state === 'empty',
              'aria-label': NS.i18n.t('chart.btn.refresh'), title: NS.i18n.t('chart.btn.refresh'),
              onClick: function () { self.engine.reload(); },
            }, Icon('refresh')));
          }
          if (b.resetZoom) {
            right.push(h('button', {
              key: 'reset', type: 'button', className: 'ctg-tb-btn', 'data-ctg': 'reset', disabled: design || !this._resetNeeded(m),
              'aria-label': NS.i18n.t('chart.btn.reset'), title: NS.i18n.t('chart.btn.reset'),
              onClick: function () { self._resetZoom(); },
            }, Icon('reset')));
          }
          right.push(panelBtn('export', 'export', 'chart.btn.export', showExport));
          right.push(panelBtn('settings', 'settings', 'chart.btn.settings', showSettings));
          // add-on panels with their own button (not one of the built-in slots)
          reg.names().forEach(function (name) {
            var def = reg.get(name);
            if (!def || !def.button || BUILTIN_PANELS[name]) return;
            right.push(h('button', {
              key: 'px-' + name, type: 'button', className: 'ctg-tb-btn', 'data-ctg-panel': name, disabled: design,
              'aria-pressed': self.panelOpen(name) ? 'true' : 'false', 'aria-label': String(def.button.label || name),
              title: String(def.button.title || def.button.label || name), onClick: function (ev) { self._togglePanel(name, ev); },
            }, def.button.icon && ICON_PATHS[def.button.icon] ? Icon(def.button.icon) : String(def.button.label || name)));
          });
          if (b.fullscreen) {
            var fsOn = this.state.fs !== 'off';
            right.push(h('button', {
              key: 'fs', type: 'button', className: 'ctg-tb-btn', 'data-ctg': 'fullscreen', disabled: design, 'aria-pressed': fsOn ? 'true' : 'false',
              'aria-label': NS.i18n.t(fsOn ? 'chart.btn.exitFullscreen' : 'chart.btn.fullscreen'), title: NS.i18n.t(fsOn ? 'chart.btn.exitFullscreen' : 'chart.btn.fullscreen'),
              onClick: function () { self._toggleFullscreen(); },
            }, Icon(fsOn ? 'fullscreenExit' : 'fullscreen')));
          }
        }
        // the More menu: everything secondary in the narrow layout; in the wide layout only the refresh-rate field
        var more = this._moreItems(m, p, caps, design, { tags: showTags, export: showExport, settings: showSettings });
        if (more.length) {
          right.push(h('button', {
            key: 'more', type: 'button', className: 'ctg-tb-btn', 'data-ctg': 'more', disabled: design,
            'aria-haspopup': 'menu', 'aria-expanded': this.state.menu && this.state.menu.kind === 'more' ? 'true' : 'false',
            'aria-label': NS.i18n.t('chart.btn.more'), title: NS.i18n.t('chart.btn.more'),
            onClick: function (ev) { self._openMenu('more', ev); },
          }, Icon('more')));
        }
        var overlays = [];
        var menu = this.state.menu;
        if (menu && !design) {
          var items = menu.kind === 'mode'
            ? modes.map(function (md) { return { id: 'mode-' + md, label: NS.i18n.t('chart.mode.' + md) + (md === mode ? ' ✓' : ''), onSelect: function () { pick(md); } }; })
            : more;
          overlays.push(h(NS.ui.Menu, {
            key: 'menu', x: menu.x, y: menu.y, items: items, returnFocus: menu.returnFocus, openedByKeyboard: menu.keyboard,
            // the opener's own press is not "outside" — its click reaches _openMenu's toggle (closes)
            ignoreEls: menu.returnFocus ? [menu.returnFocus] : undefined,
            ariaLabel: NS.i18n.t(menu.kind === 'mode' ? 'chart.toolbar.modes' : 'chart.btn.more'), className: 'ctg-chart-menu',
            onClose: function () { if (self._alive) self.setState({ menu: null }); },
          }));
        }
        if (this.state.rate && !design) {
          overlays.push(h(NS.ui.Popover, {
            key: 'rate', anchorRect: this.state.rate.anchorRect, placement: 'bottom', align: 'end', ariaLabel: NS.i18n.t('chart.rate.title'),
            className: 'ctg-chart-popover', returnFocus: this.state.rate.returnFocus,
            onClose: function () { if (self._alive) self.setState({ rate: null }); },
          }, h(RefreshRateForm, { value: p.timeRange.refreshRate, onCommit: function (v) { self._setRefreshRate(v); } })));
        }
        return h('div', {
          key: 'toolbar', role: 'toolbar', 'aria-label': NS.i18n.t('chart.toolbar'), 'data-ctg': 'toolbar',
          className: 'ctg-chart__toolbar' + (narrow ? ' ctg-chart__toolbar--narrow' : '') + (st.className ? ' ' + st.className : ''), style: st.style,
        }, h('div', { key: 'l', className: 'ctg-tb-group ctg-tb-group--left' }, left.filter(Boolean)), modeGroup,
        h('div', { key: 'sp', className: 'ctg-tb-spacer' }),
        h('div', { key: 'r', className: 'ctg-tb-group' }, right.filter(Boolean)), overlays);
      }
      /** More menu items: narrow -> Tags, Refresh, Reset zoom, Export, Settings, Fullscreen, add-ons; always the refresh rate. */
      _moreItems(m, p, caps, design, show) {
        var self = this;
        var b = p.toolbar.buttons;
        var reg = NS.chart.panels;
        var items = [];
        var anchor = function () { var r = self.state.menu && self.state.menu.anchorRect; return r ? { anchorRect: r, source: 'more' } : { source: 'more' }; };
        if (this.state.narrow) {
          if (show.tags && reg.get('tagBrowser')) items.push({ id: 'tags', label: NS.i18n.t('chart.btn.tags'), onSelect: function () { self.openPanel('tagBrowser', anchor()); } });
          if (b.refresh) items.push({ id: 'refresh', label: NS.i18n.t('chart.btn.refresh'), disabled: m.state === 'empty', onSelect: function () { self.engine.reload(); } });
          if (b.resetZoom) items.push({ id: 'reset', label: NS.i18n.t('chart.btn.reset'), disabled: !this._resetNeeded(m), onSelect: function () { self._resetZoom(); } });
          if (show.export && reg.get('export')) items.push({ id: 'export', label: NS.i18n.t('chart.btn.export'), onSelect: function () { self.openPanel('export', anchor()); } });
          if (show.settings && reg.get('settings')) items.push({ id: 'settings', label: NS.i18n.t('chart.btn.settings'), onSelect: function () { self.openPanel('settings', anchor()); } });
          if (b.fullscreen) {
            var fsOn = this.state.fs !== 'off';
            items.push({ id: 'fullscreen', label: NS.i18n.t(fsOn ? 'chart.btn.exitFullscreen' : 'chart.btn.fullscreen'), onSelect: function () { self._toggleFullscreen(); } });
          }
          reg.names().forEach(function (name) {
            var def = reg.get(name);
            if (!def || !def.button || BUILTIN_PANELS[name]) return;
            items.push({ id: 'panel-' + name, label: String(def.button.label || name), onSelect: function () { self.openPanel(name, anchor()); } });
          });
        }
        if (p.annotations.enabled && caps.annotations.allowed && !(m.annotations && m.annotations.unsupported)) {
          var shown = this.annotationsShown();
          items.push({ id: 'annotations', label: NS.i18n.t(shown ? 'chart.ann.hide' : 'chart.ann.show'), separatorBefore: items.length > 0,
            onSelect: function () { self._toggleAnnotations(); } });
        }
        // the overview strip can be hidden / shown again for the session (only where it may show at all)
        if (p.rangeSelector.visible && !this.state.small && (!this.state.narrow || p.rangeSelector.narrowVisible)) {
          var rsOn = this.rangeSelectorShown();
          items.push({ id: 'rangeSelector', label: NS.i18n.t(rsOn ? 'chart.rs.hide' : 'chart.rs.show'), separatorBefore: items.length > 0,
            onSelect: function () { self._toggleRangeSelector(); } });
        }
        if (b.refreshRate && p.timeRange.mode === 'realtime') {
          var rr = p.timeRange.refreshRate;
          items.push({ id: 'refreshRate', label: NS.i18n.t('chart.more.refreshRate'), hint: rr === 0 ? NS.i18n.t('chart.rate.off') : rr + ' ms',
            separatorBefore: items.length > 0,
            onSelect: function () {
              var mn = self.state.menu;
              self.setState({ rate: { anchorRect: mn && mn.anchorRect, returnFocus: mn && mn.returnFocus } });
            } });
        }
        return items;
      }

      _renderBadge(m, design) {
        var self = this;
        var kind = { live: 'live', stale: 'stale', error: 'error', paused: 'paused', historical: 'historical' }[m.state] || 'muted';
        var spinner = m.state === 'loading' || m.state === 'connecting';
        var out = [h('span', {
          key: 'badge', className: 'ctg-badge ctg-badge--' + kind, 'data-ctg': 'badge', 'data-state': m.state, role: 'status',
        }, spinner ? h('span', { className: 'ctg-spinner', 'aria-hidden': 'true' }) : h('span', { className: 'ctg-badge__dot', 'aria-hidden': 'true' }),
        h('span', { className: 'ctg-badge__text' }, this._stateText(m)))];
        if (m.state === 'paused') {
          out.push(h('button', {
            key: 'live', type: 'button', className: 'ctg-chip', 'data-ctg': 'return-live', disabled: design,
            onClick: function () { self._returnToLive(); },
          }, NS.i18n.t('chart.btn.returnLive')));
        }
        return h('span', { key: 'badgewrap', className: 'ctg-tb-group' }, out);
      }

      _renderMain(m, p, caps, design) {
        var self = this;
        var kids = [];
        var banner = m.banner;
        if (this.state.lib === 'error') {
          kids.push(h('div', { key: 'lib', className: 'ctg-banner ctg-banner--error', role: 'alert', 'data-ctg': 'banner', 'data-code': 'library' },
            Icon('error'), h('span', { className: 'ctg-banner__text' }, NS.i18n.t('chart.banner.library'))));
        }
        if (this.state.plotError) {
          kids.push(h('div', { key: 'perr', className: 'ctg-banner ctg-banner--error', role: 'alert', 'data-ctg': 'banner', 'data-code': 'render' },
            Icon('error'), h('span', { className: 'ctg-banner__text' }, NS.i18n.t('chart.banner.render', { message: this.state.plotError })),
            h('button', { type: 'button', className: 'ctg-banner__btn', onClick: function () { self._reloadPlots(); } }, NS.i18n.t('chart.banner.reloadChart'))));
        }
        if (banner) {
          kids.push(h('div', {
            key: 'b', className: 'ctg-banner ctg-banner--' + (banner.code === 'timeout' || banner.code === 'network' ? 'warn' : 'error'),
            role: 'alert', 'data-ctg': 'banner', 'data-code': banner.code,
          }, Icon(banner.code === 'timeout' || banner.code === 'network' ? 'warning' : 'error'),
          h('span', { className: 'ctg-banner__text' }, banner.message),
          banner.code === 'reload' ? h('button', { type: 'button', className: 'ctg-banner__btn', onClick: function () { try { W.location.reload(); } catch (e) { /* ignore */ } } },
            NS.i18n.t('chart.banner.reloadPage')) : null));
        }
        m.notices.forEach(function (n) {
          var actions = [];
          if (n.code === 'tooManyPoints' && !design) {
            actions.push(h('button', { key: 'agg', type: 'button', className: 'ctg-banner__btn', onClick: function () { self._useAggregated(); } },
              NS.i18n.t('chart.notice.useAggregated')));
            if (NS.chart.panels.get('dateRange')) {
              actions.push(h('button', { key: 'nar', type: 'button', className: 'ctg-banner__btn', onClick: function (ev) { self._togglePanel('dateRange', ev); } },
                NS.i18n.t('chart.notice.narrowRange')));
            }
          }
          var info = n.code === 'clamped' || n.code === 'rawDowngraded' || n.code === 'annotationsUnsupported';
          kids.push(h('div', {
            key: 'n-' + n.code, className: 'ctg-banner ctg-banner--' + (info ? 'info' : 'warn'), role: 'status', 'data-ctg': 'notice', 'data-code': n.code,
          }, Icon(info ? 'info' : 'warning'), h('span', { className: 'ctg-banner__text' }, n.text), actions));
        });
        var snap = this.engine.source && this.engine.source.snap;
        if (snap && snap.overLimitCount > 0 && !p.penTable.visible) {          // else a row of the pen table says it
          kids.push(h('div', { key: 'ol', className: 'ctg-banner ctg-banner--warn', role: 'status', 'data-ctg': 'notice', 'data-code': 'overLimit' },
            Icon('warning'), h('span', { className: 'ctg-banner__text' }, NS.i18n.t('chart.notice.overLimit', { n: snap.overLimitCount }))));
        }
        if (m.progress) {
          var pr = m.progress;
          var ptext = NS.i18n.t('chart.progress', { done: pr.done, total: pr.total, pct: pr.pct, points: NS.format.number(pr.points, '#,##0', this.locale()) });
          if (this.state.small) {
            // very small charts: a 3 px bar only; the text stays for screen readers
            kids.push(h('div', { key: 'prog', className: 'ctg-progress ctg-progress--bar', 'data-ctg': 'progress', role: 'status', 'aria-label': ptext },
              h('div', { className: 'ctg-progress__bar' }, h('div', { className: 'ctg-progress__fill', style: { width: pr.pct + '%' } }))));
          } else {
            kids.push(h('div', { key: 'prog', className: 'ctg-progress', 'data-ctg': 'progress', role: 'status' },
              h('div', { className: 'ctg-progress__row' },
                h('span', null, ptext),
                h('button', { type: 'button', className: 'ctg-banner__btn', onClick: function () { self.engine.cancelLoad(); } }, NS.i18n.t('chart.progress.cancel'))),
              h('div', { className: 'ctg-progress__bar' }, h('div', { className: 'ctg-progress__fill', style: { width: pr.pct + '%' } }))));
          }
        }
        var ps = NS.props.style(p.styles.plot);
        var labels = this._pens.filter(function (vm) { return vm.drawable && vm.visible; }).map(function (vm) { return vm.label; });
        var plotLabel = NS.i18n.t('chart.plot.label', { pens: labels.join(', ') || '—', range: rangeLabel(p, m, this.engine.timeZone).text });
        var plotKids = [h('div', { key: 'host', className: 'ctg-chart__plots-host', ref: this._setPlots })];
        if (m.loading && m.state !== 'empty') plotKids.push(h('div', { key: 'lb', className: 'ctg-chart__loadbar', 'aria-hidden': 'true' }));
        if (m.state === 'empty') {
          var msg = p.appearance.emptyMessage || NS.i18n.t(design ? 'chart.empty.design' : 'chart.empty.hint');
          plotKids.push(h('div', { key: 'empty', className: 'ctg-chart__empty', 'data-ctg': 'empty' }, h('div', { className: 'ctg-chart__empty-text' }, msg)));
        }
        // keyboard: the plot area is focusable and handles the keys itself; the pen table
        // stays the accessible data equivalent. Without keyboard interaction it is a plain labelled image.
        var kb = p.interaction.keyboard && !design;
        if (kb) plotKids.push(h('span', { key: 'keys', id: this._helpId, className: 'ctg-sr-only' }, NS.i18n.t('chart.plot.keys')));
        kids.push(h('div', {
          key: 'plots', className: 'ctg-chart__plots' + (ps.className ? ' ' + ps.className : ''), style: ps.style, 'data-ctg': 'plot',
          role: kb ? 'application' : 'img', 'aria-roledescription': kb ? 'chart' : undefined, 'aria-label': plotLabel,
          'aria-describedby': kb ? this._helpId : undefined, tabIndex: kb ? 0 : undefined, ref: this._setPlotsBox,
          onKeyDown: kb ? function (ev) { self.ix.key(ev); } : undefined,
        }, plotKids));
        // the overview strip (SECTION 14c): an empty container the RangeSelector builds its uPlot into
        if (this.rangeSelectorShown() && m.state !== 'empty') {
          kids.push(h('span', { key: 'rskeys', id: this._rsHelpId, className: 'ctg-sr-only' }, NS.i18n.t('chart.rs.keys')));
          kids.push(h('div', { key: 'rs', className: 'ctg-rs', 'data-ctg': 'range-selector', role: 'group', ref: this._setRs,
            style: { height: p.rangeSelector.height + 'px' } }));
        }
        return h('div', { className: 'ctg-chart__main' }, kids);
      }

      /** Collapsed pen table: the user's choice, else penTable.collapsed (or a very small chart). */
      _tableCollapsed(p) {
        return this.state.tableCollapsed != null ? this.state.tableCollapsed : (p.penTable.collapsed || this.state.small);
      }
      _renderPenTable(m, p, design, right, caps) {
        var self = this;
        var e = this.engine;
        var pt = p.penTable;
        var locale = this.locale();
        var narrow = this.state.narrow;
        var follow = m.mode === 'realtime' && m.viewport && m.viewport.followLive;
        var fatal = m.banner && (m.banner.code === 'SESSION_MISMATCH' || m.banner.code === 'SESSION_FULL') ? m.banner.code : null;
        var curCache = {};
        var axes = this._axes;
        var ctx = {
          follow: follow, locale: locale, fatal: fatal, maxPens: e.L.maxPens, ix: this.ix,
          current: function (vm) {
            if (!hasOwn.call(curCache, vm.key)) curCache[vm.key] = vm.status === 'ok' || vm.status === 'noHistory' ? e.current(vm.key) : null;
            return curCache[vm.key];
          },
          axisOf: function (vm) { return (axes && axes.byKey && axes.byKey[vm.plot + '|' + vm.axisKey]) || null; },
        };
        var collapsed = this._tableCollapsed(p);
        var bv = collapsed ? null : this._brushView(p);
        // columns: the window statistics, or (brush view) the range columns + Units / Status
        var cols;
        if (bv) {
          cols = RANGE_COLUMNS.filter(function (c) { return pt.rangeColumns[c.id]; })
            .concat(PEN_COLUMNS.filter(function (c) { return (c.id === 'units' || c.id === 'status') && pt.columns[c.id]; }));
        } else {
          cols = PEN_COLUMNS.filter(function (c) { return pt.columns[c.id] !== false && hasOwn.call(pt.columns, c.id); });
        }
        // narrow: compact rows (swatch, name, Current); a row expands to its details
        var detailCols = cols;
        if (narrow) cols = cols.filter(function (c) { return c.id === 'current' || (bv && c.id === 'average'); });
        var stats = {};
        var anyApprox = false;
        if (bv) { stats = bv.stats; anyApprox = bv.approx; }
        else {
          this._pens.forEach(function (vm) {
            if (vm.status === 'ok') {
              var s = e.stats(vm.key);
              stats[vm.key] = s;
              if (s && s.approx) anyApprox = true;
            }
          });
        }
        var actions = {};
        var anyActions = false;
        this._pens.forEach(function (vm) {
          var a = self._penActions(vm, p, caps);
          actions[vm.key] = a;
          if (a.edit || a.remove) anyActions = true;
        });
        var showActions = anyActions && !narrow;
        var tbodyId = 'ctg-pt-' + this.chartId;
        var headText = function (c) {
          if (!c.stat || RANGE_COLUMNS.indexOf(c) < 0) return c.header(ctx);
          return NS.i18n.t('chart.rcol.' + c.id);
        };
        var headTitle = function (c) {
          if (RANGE_COLUMNS.indexOf(c) >= 0) {
            if (c.id === 'lcl' || c.id === 'ucl') {
              var cl = p.interaction.rangeBrush.controlLimits;
              return NS.i18n.t('chart.rcol.' + c.id + '.title', { method: NS.i18n.t('chart.rcol.method.' + cl.method, { k: cl.sigma }) });
            }
            if (RANGE_TITLES[c.id]) return NS.i18n.t(RANGE_TITLES[c.id]);
            return anyApprox ? NS.i18n.t('chart.col.approx.title') : undefined;
          }
          return c.title ? NS.i18n.t(c.title) : (c.stat && anyApprox ? NS.i18n.t('chart.col.approx.title') : undefined);
        };
        var head = h('tr', null,
          h('th', { key: 'sw', scope: 'col' }, h('span', { className: 'ctg-sr-only' }, NS.i18n.t('chart.col.show'))),
          h('th', { key: 'name', scope: 'col', className: 'ctg-pentable__namehead' },
            h('button', {
              type: 'button', className: 'ctg-pentable__toggle', 'data-ctg': 'pen-table-toggle', 'aria-expanded': collapsed ? 'false' : 'true',
              'aria-controls': tbodyId, title: NS.i18n.t(collapsed ? 'chart.table.expand' : 'chart.table.collapse'),
              'aria-label': NS.i18n.t(collapsed ? 'chart.table.expand' : 'chart.table.collapse'),
              onClick: function () { self.setState({ tableCollapsed: !collapsed }); },
            }, Icon(collapsed ? 'expandLess' : 'expandMore')),
            h('span', null, NS.i18n.t('chart.table.pens', { n: this._pens.length }))),
          cols.map(function (c) {
            return h('th', { key: c.id, scope: 'col', className: c.num ? 'ctg-num' : undefined, title: headTitle(c) },
              (c.stat && anyApprox ? '≈ ' : '') + headText(c));
          }),
          showActions ? h('th', { key: 'act', scope: 'col', className: 'ctg-pen__acthead' }, h('span', { className: 'ctg-sr-only' }, NS.i18n.t('chart.col.actions'))) : null);
        var cellOf = function (c, vm) {
          if (c.stat) {
            var s = stats[vm.key];
            var v = s ? s[c.stat] : null;
            if (c.stat === 'count') return vm.status !== 'ok' || !s ? '—' : NS.format.number(s.count, '#,##0', locale);
            return vm.status !== 'ok' || v == null ? '—' : (s.approx ? '≈ ' : '') + formatPenValue(v, vm, locale);
          }
          return c.cell(vm, ctx);
        };
        var actionButtons = function (vm, a) {
          var out = [];
          if (a.edit) {
            out.push(h('button', {
              key: 'edit', type: 'button', className: 'ctg-pen__act', 'data-ctg': 'pen-edit', disabled: a.inert || undefined,
              'aria-label': NS.i18n.t('chart.pen.edit', { name: vm.label }), title: NS.i18n.t('chart.pen.edit', { name: vm.label }),
              onClick: function (ev) { ev.stopPropagation(); self.api.panels.open('settings', { tab: 'pens', penKey: vm.key, anchorRect: self._anchorOf(ev), source: 'penTable' }); },
            }, Icon('edit')));
          }
          if (a.remove) {
            var rtitle = a.removeReason || NS.i18n.t('chart.pen.remove', { name: vm.label });
            out.push(h('button', {
              key: 'rm', type: 'button', className: 'ctg-pen__act', 'data-ctg': 'pen-remove', disabled: !!a.removeReason || a.inert,
              'aria-label': NS.i18n.t('chart.pen.remove', { name: vm.label }), title: rtitle,
              onClick: function (ev) { ev.stopPropagation(); self._askRemove(vm, ev); },
            }, Icon('trash')));
          }
          return out;
        };
        var rows = [];
        if (!collapsed) {
          this._pens.forEach(function (vm) {
            var cur = ctx.current(vm);
            var lvl = cur && cur.q ? NS.quality.level(cur.q) : 'good';
            var fault = vm.status !== 'ok' && vm.status !== 'loading' && FAULT_TONE[vm.status] !== 'warn';
            var warn = !fault && (FAULT_TONE[vm.status] === 'warn' || lvl !== 'good' || !!vm.incomplete || !!vm.warn);
            var expanded = narrow && self.state.expandedRow === vm.key;
            var a = actions[vm.key];
            var cls = 'ctg-chart-pen' + (fault || fatal ? ' ctg-pen--fault' : warn ? ' ctg-pen--warn' : '') + (vm.visible ? '' : ' ctg-pen--hidden') +
              (expanded ? ' ctg-pen--expanded' : '') + (a.removing ? ' ctg-pen--removing' : '');
            var cells = cols.map(function (c) {
              return h('td', { key: c.id, className: c.num ? 'ctg-num' : undefined, 'data-col': c.id }, cellOf(c, vm));
            });
            var canHide = pt.allowHide && vm.drawable && !a.removing;
            var swatch = h('label', {
              className: 'ctg-swatch' + (canHide ? '' : ' ctg-swatch--static'), style: { '--ctg-pen': vm.color },
              title: canHide ? NS.i18n.t('chart.pen.show', { name: vm.label }) : undefined,
              onClick: function (ev) { ev.stopPropagation(); },
            }, h('input', {
              type: 'checkbox', checked: vm.visible, disabled: !canHide || design, 'aria-label': NS.i18n.t('chart.pen.show', { name: vm.label }),
              onChange: function () { self._toggleVisible(vm); },
            }), h('span', { className: 'ctg-swatch__box', 'aria-hidden': 'true' }));
            var nameKids = [];
            if (a.color && !a.removing) {
              nameKids.push(h('button', {
                key: 'color', type: 'button', className: 'ctg-pen__color', 'data-ctg': 'pen-color', style: { '--ctg-pen': vm.color }, disabled: a.inert || undefined,
                'aria-label': NS.i18n.t('chart.pen.color', { name: vm.label }), title: NS.i18n.t('chart.pen.color', { name: vm.label }),
                onClick: function (ev) { ev.stopPropagation(); self.api.panels.open('color', { penKey: vm.key, anchorRect: self._anchorOf(ev), source: 'penTable' }); },
              }));
            }
            nameKids.push(h('span', { key: 'label', className: 'ctg-pen__label' }, vm.label));
            if (narrow) {
              nameKids.push(h('button', {
                key: 'more', type: 'button', className: 'ctg-pen__expand', 'data-ctg': 'pen-expand', 'aria-expanded': expanded ? 'true' : 'false',
                'aria-label': NS.i18n.t('chart.table.details', { name: vm.label }),
                onClick: function (ev) { ev.stopPropagation(); self.setState({ expandedRow: expanded ? null : vm.key }); },
              }, Icon(expanded ? 'expandLess' : 'expandMore')));
            }
            var rowCells = [h('td', { key: 'sw' }, swatch), h('td', { key: 'name', className: 'ctg-pen__name' }, nameKids)].concat(cells);
            if (showActions) rowCells.push(h('td', { key: 'act', className: 'ctg-pen__actions' }, actionButtons(vm, a)));
            rows.push(h('tr', {
              key: vm.key, className: cls, 'data-ctg': 'pen-row', 'data-ctg-key': vm.key, 'data-pen-key': vm.key,
              'data-history-status': fatal ? 'error' : vm.status === 'loading' ? undefined : vm.status,
              'data-removing': a.removing ? 'true' : undefined, 'aria-disabled': a.removing ? 'true' : undefined,
              'data-points': vm.status === 'ok' && !fatal ? String(vm.points != null ? vm.points : '') : undefined,
              title: vm.tagPath,
              onClick: narrow ? function () { self.setState({ expandedRow: expanded ? null : vm.key }); } : undefined,
              onMouseEnter: function () { if (self.pm && vm.visible) self.pm.focusPen(vm.key); },
              onMouseLeave: function () { if (self.pm) self.pm.focusPen(null); },
            }, rowCells));
            if (expanded) {
              // details of a compact row: the columns that did not fit, plus the row actions
              var extra = detailCols.filter(function (c) { return cols.indexOf(c) < 0; });
              rows.push(h('tr', { key: vm.key + '__d', className: 'ctg-pen__details', 'data-ctg': 'pen-details', 'data-ctg-key': vm.key },
                h('td', { colSpan: cols.length + 2 },
                  h('dl', { className: 'ctg-pen__dl' }, extra.map(function (c) {
                    return [h('dt', { key: c.id + '-t' }, headText(c)), h('dd', { key: c.id + '-d', className: c.num ? 'ctg-num' : undefined }, cellOf(c, vm))];
                  })),
                  h('div', { className: 'ctg-pen__actions ctg-pen__actions--inline' }, actionButtons(vm, a)))));
            }
          });
          var snap = e.source && e.source.snap;
          if (snap && snap.overLimitCount > 0) {
            rows.push(h('tr', { key: '__more', className: 'ctg-pentable__more' },
              h('td', { colSpan: cols.length + 2 + (showActions ? 1 : 0) }, NS.i18n.t('chart.notice.overLimit', { n: snap.overLimitCount }))));
          }
        }
        var ts = NS.props.style(pt.style);
        var style = Object.assign({}, ts.style);
        if (right) style.width = pt.sizeUnit === '%' ? pt.size + '%' : pt.size + 'px';
        else if (pt.sizeUnit === 'px') style.maxHeight = pt.size + 'px';
        else if (this.state.rootH > 0) style.maxHeight = Math.max(48, Math.round(this.state.rootH * pt.size / 100)) + 'px';
        var kids = [];
        if (bv) kids.push(this._renderBrushBar(bv, p, design, RANGE_COLUMNS.filter(function (c) { return pt.rangeColumns[c.id]; })));
        kids.push(h('table', { key: 'table' }, h('caption', { className: 'ctg-sr-only' }, NS.i18n.t('chart.table.caption')), h('thead', null, head),
          collapsed ? null : h('tbody', { id: tbodyId }, rows)));
        var cf = this.state.confirm;
        // the confirm follows its pen by identity (source + tag; the row key is index-based), and closes when
        // that pen is gone or already being removed
        var cand = cf ? this._pens.filter(function (x) { return x.source === cf.source && NS.util.normKey(x.tagPath) === cf.nk; }) : [];
        var cvm = cand.filter(function (x) { return x.key === cf.penKey; })[0] || (cand.length === 1 ? cand[0] : null);
        if (cvm && this._isRemoving(cvm)) cvm = null;
        if (cf && !cvm && !this._confirmGoneT) {
          this._confirmGoneT = setTimeout(function () { self._confirmGoneT = 0; if (self._alive && self.state.confirm === cf) self.setState({ confirm: null }); }, 0);
        }
        if (cf && cvm && !design) {
          var close = function () { if (self._alive && self.state.confirm) self.setState({ confirm: null }); };
          kids.push(h(NS.ui.Confirm, {
            key: 'confirm', anchorRect: cf.anchorRect, tone: 'danger', returnFocus: cf.returnFocus,
            text: NS.i18n.t(cvm.source === 'trend' ? 'chart.pen.removeTrendConfirm' : 'chart.pen.removeConfirm', { name: cvm.label }),
            confirmLabel: NS.i18n.t('chart.pen.removeBtn'),
            onConfirm: function () { close(); self._removePen(cvm, cf.returnFocus); },
            onCancel: close,
          }));
        }
        return h('div', {
          key: 'pentable', className: 'ctg-pentable' + (right ? ' ctg-pentable--right' : '') + (narrow ? ' ctg-pentable--compact' : '') +
            (collapsed ? ' ctg-pentable--collapsed' : '') + (ts.className ? ' ' + ts.className : ''),
          style: style, 'data-ctg': 'pen-table', 'data-collapsed': collapsed ? 'true' : 'false', 'data-brush': bv ? bv.brush.id : undefined,
        }, kids);
      }
      /** Header of the brush view: which range, its span, Zoom to range, Copy stats (after exact stats), Clear. */
      _renderBrushBar(bv, p, design, rcols) {
        var self = this;
        var ix = this.ix;
        var br = bv.brush;
        var tz = this.engine.timeZone;
        var same = NS.time.format(br.start, 'YYYY-MM-DD', tz) === NS.time.format(br.end, 'YYYY-MM-DD', tz);
        var pat = br.end - br.start < 10 * MINUTE ? (same ? 'HH:mm:ss' : 'MM-DD HH:mm:ss') : same ? 'HH:mm:ss' : 'YYYY-MM-DD HH:mm';
        var num = function (b) { var mm = BRUSH_ID_RE.exec(b.id); return mm ? mm[1] : b.id; };
        var summary = NS.i18n.t('chart.brush.summary', { label: NS.i18n.t('chart.brush.label', { n: num(br) }),
          from: NS.time.format(br.start, pat, tz), to: NS.time.format(br.end, pat, tz), span: durationText(br.end - br.start) });
        var kids = [];
        if (ix.brushes.length > 1) {
          var selId = NS.util.uid('ctg-brush-sel');
          kids.push(h('label', { key: 'sl', className: 'ctg-sr-only', htmlFor: selId }, NS.i18n.t('chart.brush.select')));
          kids.push(h('select', {
            key: 'sel', id: selId, className: 'ctg-brushbar__select', 'data-ctg': 'brush-select', value: br.id,
            onChange: function (ev) { ix.selectBrush(ev.target.value); },
          }, ix.brushes.map(function (b) { return h('option', { key: b.id, value: b.id }, NS.i18n.t('chart.brush.label', { n: num(b) })); })));
        }
        kids.push(h('span', { key: 'sum', className: 'ctg-brushbar__summary', 'data-ctg': 'brush-summary' }, summary));
        if (bv.loading) {
          kids.push(h('span', { key: 'ld', className: 'ctg-brushbar__loading', role: 'status' },
            h('span', { className: 'ctg-spinner', 'aria-hidden': 'true' }), h('span', { className: 'ctg-sr-only' }, NS.i18n.t('chart.brush.exact'))));
        }
        if (bv.exactFailed && bv.approx) {
          kids.push(h('span', { key: 'xf', className: 'ctg-brushbar__note', 'data-ctg': 'brush-exact-failed', role: 'status',
            title: NS.i18n.t('chart.brush.exactFailed') }, h('span', { 'aria-hidden': 'true' }, '≈'),
            h('span', { className: 'ctg-sr-only' }, NS.i18n.t('chart.brush.exactFailed'))));
        }
        kids.push(h('span', { key: 'sp', className: 'ctg-tb-spacer' }));
        kids.push(h('button', {
          key: 'zoom', type: 'button', className: 'ctg-banner__btn', 'data-ctg': 'brush-zoom', disabled: design,
          onClick: function () { self.commitView({ min: br.start, max: br.end }); },
        }, NS.i18n.t('chart.brush.zoom')));
        kids.push(h('button', {
          key: 'copy', type: 'button', className: 'ctg-banner__btn', 'data-ctg': 'brush-copy', disabled: bv.loading,
          'aria-busy': bv.loading ? 'true' : undefined, onClick: function () { self._copyStats(bv, rcols); },
        }, NS.i18n.t('chart.brush.copy')));
        kids.push(h('button', {
          key: 'clear', type: 'button', className: 'ctg-banner__btn', 'data-ctg': 'brush-clear', disabled: design,
          onClick: function () { ix.clearBrushes(); },
        }, NS.i18n.t('chart.brush.clear')));
        return h('div', { key: 'brushbar', className: 'ctg-brushbar', 'data-ctg': 'brush-bar' }, kids);
      }

      /** Open panels docked at `dock` ('left' | 'right' | 'none'), each rendered through its registry entry. */
      _renderPanels(dock) {
        var self = this;
        var out = [];
        if (this.designMode()) return this._designPanels(dock);
        Object.keys(this.state.panels).forEach(function (name) {
          var def = NS.chart.panels.get(name);
          if (!def || typeof def.render !== 'function') return;
          var where = def.dock === 'left' || def.dock === 'right' ? def.dock : 'none';
          if (where !== dock) return;
          var args = self.state.panels[name];
          // bound to THIS opening: a stale close() of an earlier opening does not close a re-opened panel
          var gen = self._panelGen ? self._panelGen[name] : null;
          var close = function () { self.closePanel(name, gen); };
          // the panel's render() AND the components it returns run inside the panel's own boundary: a
          // failing panel shows "Panel error" + "Close panel" in its slot; the chart keeps running
          out.push(h('div', { key: 'panel-' + name + '-' + gen, className: 'ctg-chart__panel', 'data-ctg-panel-open': name },
            guarded('pb', 'panel:' + name, function () { return def.render(self.api, args, close); }, close, true)));
        });
        return out;
      }
    }
    /**
     * Designer preview parity: a chart whose tag browser opens on start (tagBrowser.openOnStart, empty
     * chart) shows the docked browser frame in design mode too, so the plot has its runtime width. The panel renders
     * its design-mode notice in it; nothing in it can act (panels never open in design mode).
     */
    CtgChart.prototype._designPanels = function (dock) {
      var self = this;
      var p = this.props.props;
      var m = this._model;
      var def = NS.chart.panels.get('tagBrowser');
      if (!def || typeof def.render !== 'function' || !p.enabled || !p.tagBrowser.enabled || !p.tagBrowser.openOnStart || !m || m.state !== 'empty') return [];
      var where = def.dock === 'left' || def.dock === 'right' ? def.dock : 'none';
      if (where !== dock) return [];
      var noop = function () { };
      return [h('div', { key: 'panel-tagBrowser-design', className: 'ctg-chart__panel', 'data-ctg-panel-open': 'tagBrowser', 'data-ctg-design-preview': 'true' },
        guarded('pb', 'panel:tagBrowser', function () { return def.render(self.api, { source: 'openOnStart' }, noop); }, noop, true))];
    };
    var MODE_OV = '#mode';               // _ovAt key of the mode override (pen keys are p:/t:...)
    var OVERRIDE_TTL_MS = 3000;          // an optimistic visibility / mode override the props never confirmed
    var OUTPUT_STATE = { connecting: 'loading', disconnected: 'stale' };
    var BUILTIN_PANELS = { tagBrowser: true, dateRange: true, settings: true, export: true, color: true, annotation: true };
    function mergeStyles(a, b) {
      var x = NS.props.style(a), y = NS.props.style(b);
      return { className: [x.className, y.className].filter(Boolean).join(' '), style: Object.assign({}, x.style, y.style) };
    }
    function perfNow() { return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now(); }
    function raf(fn) { return typeof W.requestAnimationFrame === 'function' ? W.requestAnimationFrame(fn) : setTimeout(fn, 16); }
    function cancelRaf(id) { if (typeof W.cancelAnimationFrame === 'function') W.cancelAnimationFrame(id); else clearTimeout(id); }

    /* ========================================================================
     * SECTION 20 / component meta + registration
     * ====================================================================== */
    class CtgChartMeta {
      getComponentType() { return COMPONENT_ID; }
      getViewComponent() { return CtgChart; }
      getDefaultSize() { return { width: 600, height: 400 }; }
      createDelegate(store) { return new CtgChartDelegate(store); }
      getPropsReducer(tree) { return reduceProps(tree); }
    }

    // Engine + UI API (Node-tested; the interaction layer and the add-on files build on it)
    Object.assign(NS.chart, {
      loadUPlot: loadUPlot,
      buildPens: buildPens, staticPenIndex: staticPenIndex, assignAxes: assignAxes, yRange: yRange, niceRange: niceRange, niceStep: niceStep,
      uniqueSuffixes: uniqueSuffixes, contrastSafe: contrastSafe, hashString: hashString, rangeLabel: rangeLabel,
      formatPenValue: formatPenValue, tickFormatter: tickFormatter, autoTimeValues: autoTimeValues, minMaxIn: minMaxIn,
      PlotManager: PlotManager, PEN_COLUMNS: PEN_COLUMNS, penStatus: penStatus,
      createChartApi: createChartApi, CHART_API_MEMBERS: CHART_API_MEMBERS, chartCapabilities: chartCapabilities,
      seriesRows: seriesRows, CtgChartDelegate: CtgChartDelegate, CtgChart: CtgChart, CHART_CSS: CHART_CSS,
      // interaction (Node-tested)
      ChartInteraction: ChartInteraction, IX: IX, normTraces: normTraces, normBrushes: normBrushes, durationText: durationText,
      traceKind: traceKind, RANGE_COLUMNS: RANGE_COLUMNS, RefreshRateForm: RefreshRateForm, XTraceCell: XTraceCell, copyText: copyText,
      tsvCell: tsvCell, DETACHED_VIEWPORT: DETACHED_VIEWPORT,
      // api.patch semantics, shared with tests/js/_chartApiStub.mjs
      applyPatch: applyPatch, patchRoot: patchRoot, reducedRootOf: reducedRootOf, apiWritable: apiWritable,
      EXACT: EXACT, EXACT_TRANSIENT_PEN: EXACT_TRANSIENT_PEN,
      // curve types, per-state pen styles, the range selector (Node-tested)
      INTERPOLATIONS: INTERPOLATIONS, CURVES: CURVES, drawCurve: drawCurve, curvePaths: curvePaths, ownRowsAbove: ownRowsAbove, linePathsFor: linePathsFor,
      penStates: penStates, stateStops: stateStops, boolRuns: boolRuns, lastGoodBefore: lastGoodBefore, drawTypeOf: drawTypeOf,
      RangeSelector: RangeSelector, RS: RS, rsDomain: rsDomain, rsClampDomain: rsClampDomain, rsFetchDue: rsFetchDue, rsNormalize: rsNormalize, rsDragView: rsDragView, rsKeyView: rsKeyView,
      rsTimeLabel: rsTimeLabel, overviewPlan: overviewPlan,
    });
    NS.chart.panels.open = function (name, args, chartId) {
      var c = chartId ? charts.get(chartId) : Array.from(charts.values()).pop();
      return c ? c.openPanel(name, args) : false;
    };
    NS.chart.panels.close = function (name, chartId) {
      var c = chartId ? charts.get(chartId) : Array.from(charts.values()).pop();
      return c ? c.closePanel(name) : false;
    };
    NS.registerComponent(new CtgChartMeta());
  }
})();
