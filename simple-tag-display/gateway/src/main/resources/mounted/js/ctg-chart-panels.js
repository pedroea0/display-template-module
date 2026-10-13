/* ============================================================================
 * ctg-chart-panels.js — Click To Graph Chart add-on: panels (settings, tag browser)
 * ============================================================================
 *
 * Part id: 'chartPanels' (needs 'common' and 'chart'). Loaded as its own browser
 * resource, separate from the chart engine: the panels register
 * into NS.chart.panels whenever this file loads, and the chart shows their
 * toolbar buttons (Tags, Settings) once they are registered.
 *
 * WHAT THIS FILE CONTAINS (user documentation:
 * docs/user-guide/components/ctg-chart/panels-and-tools.md)
 *   SettingsPanel  'settings'   docked right (340 px); tabs Pens / Axes / Plots /
 *                               Columns. Edits apply live (debounced 300 ms) as
 *                               whole-object prop writes of the affected root key
 *                               (pens, axes, plots, penTable, trendPens).
 *   TagBrowser     'tagBrowser' docked left (tagBrowser.width px); lazy tree over
 *                               chart.browse (opaque continuation, "Load more…"),
 *                               multi-select, scope greying, Add selected ->
 *                               ONE chart.trendAdd {tagPaths} (trend list) or ONE
 *                               write of `pens`.
 *   AnnotationEditor 'annotation' anchored dialog at the click on the plot
 *                               (annotate mode): add / edit / delete a
 *                               note or range over chart.annotationSave /
 *                               chart.annotationDelete.
 *
 * THE ONLY WAY TO THE CHART IS ChartApi (a frozen, stable interface).
 * Every panel is rendered by the chart through def.render(api, args, close); it
 * reads api.props() / api.pens() / api.capabilities() / api.limits(), writes
 * with api.patch(rootKey, op) on the RAW prop value (SECTION 2b),
 * talks to the gateway with
 * api.request('chart.browse' | 'chart.trendAdd' | 'chart.trendRemove' |
 * 'chart.trendClear', ...) and fires onPensChange with api.fireEvent. Nothing in
 * here touches NS.chart internals (engine, PlotManager, SPEC): the defaults the
 * panels write are mirrored in SECTION 2 and tests/js/chart-panels.test.mjs checks
 * them against the chart's reducer.
 *
 * WRITE RULES
 *   - Whole root objects only (a nested write with missing intermediates throws),
 *     built by ChartApi.patch from the RAW root: only the edited item changes;
 *     unknown keys and every value the reducer would default / clamp stay as
 *     the view stores them.
 *   - Never in Designer design mode (api.patch refuses; the panels say so).
 *   - Nothing when the chart's root `enabled` is false: the
 *     panels show why and offer no edit. Browsing still works (the gateway's
 *     browse gate ignores `enabled`: browsing changes nothing).
 *   - The panel SHOWS the reduced shape (the same operation applied to
 *     api.props()) until the chart's props echo the write, so a value never
 *     flickers back (DraftStore).
 *   - The gateway stays the authority: read scope, trendEdit and the tag
 *     browser gates are only *mirrored* here (greying + reasons); refusals from
 *     the gateway are shown inline.
 *
 * SECTIONS
 *   1  strings (NS.i18n part 'chartPanels')
 *   2  pure model: defaults, copies, pen rows, edits of pens / overrides / axes /
 *      plots, read-scope mirror, add target, number parsing (Node-tested)
 *   2b patch operations: raw-safe edits by identity
 *   3  TagTree — the browse tree model (pure, Node-tested)
 *   4  DraftStore — debounced whole-object writes + echo tracking
 *   5  styles (ctg-chart-panels-styles; :where(), shared --ctg-* tokens only)
 *   6  small React pieces: icons, form controls, PanelFrame
 *   7  SettingsPanel (Pens / Axes / Plots / Columns)
 *   8  TagBrowser
 *   8b AnnotationEditor
 *   9  registration + NS.chartPanels (test surface)
 *
 * CODE RULES: no innerHTML (createElement / text children only);
 * colours reach CSS only after NS.props.color (CSS.supports); no setInterval;
 * every async continuation checks that the panel is still mounted.
 * ============================================================================ */
(function () {
  'use strict';

  var NS = window.__CTG = window.__CTG || {};
  NS.loaded = NS.loaded || {};
  NS.ready = NS.ready || {};
  NS._queue = NS._queue || [];

  var PART = 'chartPanels';
  var src = document.currentScript && document.currentScript.src;
  var BUILD = (src && new URL(src, location.href).searchParams.get('v')) || 'dev';
  if (NS.loaded[PART]) {
    if (NS.loaded[PART] !== BUILD) {
      console.warn('[CTG]', PART, BUILD, 'ignored; page runs', NS.loaded[PART], '- reload the page');
    }
    return;
  }
  NS.loaded[PART] = BUILD;

  NS._queue.push({ part: PART, needs: ['common', 'chart'], init: initPanels });
  if (NS._drain) NS._drain();

  function initPanels(NS) {
    var W = window;
    var PC = W.PerspectiveClient;
    var React = W.React;
    var h = React.createElement;
    var hasOwn = Object.prototype.hasOwnProperty;
    var log = NS.log('ctg.chartPanels');
    var RComponent = (React && React.Component) || PC.Component;

    /* ========================================================================
     * SECTION 1 / strings — every user-facing text of this part
     * ====================================================================== */
    NS.i18n.register(PART, {
      // shared frame
      'cp.close': 'Close',
      'cp.back': 'Back',
      'cp.done': 'Done',
      'cp.saveFailed': 'Some changes could not be saved.',
      'cp.designMode': 'Panels are not available in the Designer\u2019s design mode. Use preview mode.',
      'cp.readOnly': 'Changes are turned off for this chart.',
      // settings
      'sp.title': 'Chart settings',
      'sp.off': 'The settings panel is turned off for this chart.',
      'sp.tabs': 'Settings sections',
      'sp.tab.pens': 'Pens',
      'sp.tab.axes': 'Axes',
      'sp.tab.plots': 'Plots',
      'sp.tab.columns': 'Columns',
      'sp.noTabs': 'No settings sections are enabled.',
      'sp.pens.static': 'Chart pens ({n})',
      'sp.pens.none': 'No pens yet.',
      'sp.pens.trend': 'Session trend list \u201C{group}\u201D ({n})',
      'sp.pens.trendNone': 'No tags in the trend list.',
      'sp.pens.clear': 'Clear list',
      'sp.pens.clearConfirm': 'Remove all {n} tags from the trend list \u201C{group}\u201D?',
      'sp.pens.clearDone': 'Trend list cleared.',
      'sp.pens.edit': 'Edit {name}',
      'sp.pens.up': 'Move {name} up',
      'sp.pens.down': 'Move {name} down',
      'sp.pens.drag': 'Drag to reorder',
      'sp.pens.disabled': 'disabled',
      'sp.add.label': 'Add pen',
      'sp.add.placeholder': '[default]Folder/Tag',
      'sp.add.button': 'Add',
      'sp.add.help': 'Type a full tag path. The tag browser is the easier way.',
      'sp.add.empty': 'Enter a tag path.',
      'sp.add.dup': 'This tag is already on the chart.',
      'sp.add.full': 'This chart already has the maximum of {max} pens.',
      'sp.add.added': 'Added {name}.',
      'sp.pen.back': 'All pens',
      'sp.pen.gone': 'This pen is no longer on the chart.',
      'sp.pen.name': 'Name',
      'sp.pen.namePh': 'Automatic ({auto})',
      'sp.pen.tagPath': 'Tag path',
      'sp.pen.enabled': 'Enabled (query and show this pen)',
      'sp.pen.visible': 'Visible',
      'sp.pen.axis': 'Y axis',
      'sp.pen.axisAuto': 'Automatic',
      'sp.pen.axisNew': 'New axis\u2026',
      'sp.pen.plot': 'Plot',
      'sp.pen.plotN': 'Plot {n}',
      'sp.pen.plotNew': 'New plot',
      'sp.pen.style': 'Line style',
      'sp.pen.type': 'Display type',
      'sp.pen.type.line': 'Line', 'sp.pen.type.area': 'Area', 'sp.pen.type.bar': 'Bar',
      'sp.pen.type.scatter': 'Points', 'sp.pen.type.step': 'Step',
      'sp.pen.interp': 'Interpolation',
      'sp.pen.interp.linear': 'Linear', 'sp.pen.interp.spline': 'Smooth (spline)',
      'sp.pen.interp.stepAfter': 'Step after', 'sp.pen.interp.stepBefore': 'Step before',
      // the rest of the Power Chart's curve types, and the per-state styles
      'sp.pen.interp.stepCenter': 'Step half-way', 'sp.pen.interp.basis': 'B-spline (smoothest)',
      'sp.pen.interp.basisOpen': 'B-spline, open ends', 'sp.pen.interp.cardinal': 'Cardinal',
      'sp.pen.interp.cardinalOpen': 'Cardinal, open ends', 'sp.pen.interp.catmullRom': 'Catmull-Rom',
      'sp.pen.interp.catmullRomOpen': 'Catmull-Rom, open ends', 'sp.pen.interp.monotoneX': 'Monotone (no overshoot)',
      'sp.pen.interp.monotoneY': 'Monotone in Y', 'sp.pen.interp.natural': 'Natural cubic',
      'sp.pen.interpHelp': 'Smooth curves are drawn as straight lines when there are more samples than pixels.',
      'sp.pen.states': 'States',
      'sp.pen.bad': 'Bad data',
      'sp.pen.bad.hatch': 'Hatched', 'sp.pen.bad.hold': 'Hold the last good value (dashed)', 'sp.pen.bad.none': 'Gap only',
      'sp.pen.badColor': 'Bad data colour',
      'sp.pen.oob': 'Highlight values outside the limits',
      'sp.pen.oobSource': 'Limits',
      'sp.pen.oobSource.engineering': 'Engineering low / high of the tag', 'sp.pen.oobSource.manual': 'Manual',
      'sp.pen.oobLow': 'Low limit (empty = {auto})',
      'sp.pen.oobHigh': 'High limit (empty = {auto})',
      'sp.pen.oobAutoEng': 'the tag’s', 'sp.pen.oobAutoNone': 'none',
      'sp.pen.oobColor': 'Colour outside the limits',
      'sp.pen.oobWidth': 'Width outside (px, only if wider than the pen)',
      'sp.pen.oobLimits': 'Limits in use: {low} – {high}',
      'sp.pen.oobInvalid': 'The low limit must be below the high limit.',
      'sp.pen.bool': 'Colour on / off (Boolean)',
      'sp.pen.boolOn': 'Colour when on',
      'sp.pen.boolOff': 'Colour when off',
      'sp.pen.boolFill': 'Shading when on (0–1)',
      'sp.pen.boolOnly': 'Applies to Boolean pens only.',
      'sp.pen.width': 'Line width (px)',
      'sp.pen.dash': 'Dash',
      'sp.dash.solid': 'Solid', 'sp.dash.dashed': 'Dashed', 'sp.dash.dotted': 'Dotted', 'sp.dash.custom': 'Custom ({v})',
      'sp.pen.fill': 'Fill opacity (0\u20131)',
      'sp.pen.radius': 'Point size (px)',
      'sp.pen.breakLine': 'Break the line at bad data',
      'sp.pen.color': 'Colour',
      'sp.pen.aggregation': 'Aggregation',
      'sp.pen.aggDefault': 'Chart default ({agg})',
      'sp.pen.units': 'Units',
      'sp.pen.unitsPh': 'From the tag ({units})',
      'sp.pen.format': 'Number format',
      'sp.pen.formatPh': 'From the tag, e.g. #,##0.0',
      'sp.pen.delete': 'Delete pen',
      'sp.pen.deleteConfirm': 'Delete the pen {name}?',
      'sp.pen.remove': 'Remove from trend list',
      'sp.pen.removeConfirm': 'Remove {name} from the trend list?',
      'sp.pen.trendHint': 'Trend list tag: the look is stored in trendPens.overrides for this page.',
      'sp.pen.defaultsLock': 'The trend pen defaults set an axis, plot or style for every trend list tag: this pen cannot be set back to the automatic axis, plot 1 or the built-in style here (the defaults apply). Change trendPens.defaults instead.',
      'sp.pen.status': 'Status: {text}',
      'sp.color.default': 'Default',
      'sp.color.more': 'More\u2026',
      'sp.color.invalid': 'Not a colour (use #rrggbb, rgb(\u2026) or a colour name).',
      'sp.color.picker': 'Pick a colour',
      // axes
      'sp.axes.named': 'Named axes ({n})',
      'sp.axes.none': 'No named axes. Pens use automatic axes (one per unit and range).',
      'sp.axes.add': 'Add axis',
      'sp.axes.auto': 'Automatic axes in use',
      'sp.axes.autoRow': '{units} \u00B7 {side} \u00B7 plot {plot}',
      'sp.axes.noUnits': 'no units',
      'sp.axes.side.left': 'left', 'sp.axes.side.right': 'right',
      'sp.axis.back': 'All axes',
      'sp.axis.name': 'Name',
      'sp.axis.nameEmpty': 'Enter a name.',
      'sp.axis.nameTaken': 'Another axis already has this name.',
      'sp.axis.position': 'Position',
      'sp.axis.left': 'Left', 'sp.axis.right': 'Right',
      'sp.axis.visible': 'Visible',
      'sp.axis.label': 'Label text',
      'sp.axis.labelVisible': 'Show the label',
      'sp.axis.color': 'Axis colour',
      'sp.axis.format': 'Number format',
      'sp.axis.scale': 'Scale',
      'sp.axis.scale.linear': 'Linear', 'sp.axis.scale.log': 'Logarithmic',
      'sp.axis.width': 'Width (px, 0 = automatic)',
      'sp.axis.range': 'Range',
      'sp.axis.range.auto': 'Automatic', 'sp.axis.range.manual': 'Manual', 'sp.axis.range.engineering': 'Engineering limits',
      'sp.axis.min': 'Minimum (empty = automatic)',
      'sp.axis.max': 'Maximum (empty = automatic)',
      'sp.axis.includeZero': 'Always include zero',
      'sp.axis.padding': 'Padding (0\u20130.5)',
      'sp.axis.grid': 'Grid',
      'sp.axis.gridVisible': 'Show grid lines',
      'sp.axis.gridColor': 'Grid colour',
      'sp.axis.gridOpacity': 'Grid opacity (0\u20131)',
      'sp.axis.gridDash': 'Grid dash',
      'sp.axis.pens': 'Pens on this axis: {names}',
      'sp.axis.delete': 'Delete axis',
      'sp.axis.deleteConfirm': 'Delete the axis {name}? Its pens move to automatic axes.',
      'sp.axis.minMax': 'Minimum must be less than maximum.',
      // plots
      'sp.plots.list': 'Plots ({n})',
      'sp.plots.implicit': 'One plot (default settings).',
      'sp.plots.row': 'Plot {n} \u00B7 weight {w} \u00B7 {pens} pens',
      'sp.plots.add': 'Add plot',
      'sp.plots.max': 'At most {max} plots.',
      'sp.plot.back': 'All plots',
      'sp.plot.gone': 'This plot is no longer on the chart.',
      'sp.plot.title': 'Plot {n}',
      'sp.plot.weight': 'Relative height (0.1\u201310)',
      'sp.plot.background': 'Background colour',
      'sp.plot.markers': 'Markers ({n})',
      'sp.plot.markerAdd': 'Add marker',
      'sp.plot.marker': 'Marker {n}',
      'sp.plot.markerRemove': 'Remove marker {n}',
      'sp.plot.remove': 'Remove plot',
      'sp.plot.removeConfirm': 'Remove plot {n}? Its pens move to plot 1.',
      'sp.plot.removeLast': 'The last plot cannot be removed.',
      'sp.marker.type': 'Type',
      'sp.marker.type.line': 'Line at a value', 'sp.marker.type.band': 'Band between two values',
      'sp.marker.axis': 'Axis',
      'sp.marker.axisFirst': 'First axis of the plot',
      'sp.marker.value': 'Value',
      'sp.marker.min': 'From',
      'sp.marker.max': 'To',
      'sp.marker.color': 'Colour',
      'sp.marker.opacity': 'Opacity (0\u20131)',
      'sp.marker.width': 'Line width (px)',
      'sp.marker.label': 'Label',
      'sp.marker.labelPos': 'Label position',
      'sp.marker.labelLeft': 'Left', 'sp.marker.labelRight': 'Right',
      // columns
      'sp.cols.table': 'Pen table columns',
      'sp.cols.range': 'Range statistics columns',
      'sp.col.current': 'Current / End', 'sp.col.minimum': 'Minimum', 'sp.col.maximum': 'Maximum', 'sp.col.average': 'Average',
      'sp.col.xTrace': 'X-Trace value', 'sp.col.axis': 'Axis', 'sp.col.plot': 'Plot', 'sp.col.units': 'Units', 'sp.col.status': 'Status',
      'sp.col.first': 'First', 'sp.col.last': 'Last', 'sp.col.delta': 'Delta', 'sp.col.median': 'Median',
      'sp.col.standardDeviation': 'Standard deviation', 'sp.col.sum': 'Sum', 'sp.col.lcl': 'LCL', 'sp.col.ucl': 'UCL', 'sp.col.count': 'Count',
      // numbers
      'num.invalid': 'Enter a number.',
      'num.integer': 'Enter a whole number.',
      'num.range': 'Between {min} and {max}.',
      'num.min': 'At least {min}.',
      'num.max': 'At most {max}.',
      // tag browser
      'tb.title': 'Tags',
      'tb.tree': 'Tag tree',
      'tb.filter': 'Filter tags',
      'tb.filterHelp': 'Filters the open folder by name.',
      'tb.reload': 'Reload',
      'tb.loading': 'Loading\u2026',
      'tb.empty': 'Nothing here.',
      'tb.emptyFiltered': 'No names match the filter on this page.',
      'tb.more': 'Load more\u2026',
      'tb.retry': 'Try again',
      'tb.denied': 'You don\u2019t have permission to browse tags.',
      'tb.login': 'Log in to browse tags.',
      'tb.off': 'The tag browser is turned off for this chart.',
      'tb.unsafe': 'The tag browser is turned off: this screen\u2019s configuration is not safe (ask the integrator).',
      'tb.unavailable': 'The tag browser is not available ({code}).',
      'tb.charted': 'Already on this chart',
      'tb.notTrendable': 'Only numeric and Boolean tags can be trended',
      'tb.outOfScope': 'Outside the tags this chart may show',
      'tb.folderOutOfScope': 'Tags in this folder cannot be added to this chart',
      'tb.noRuntime': 'Tags cannot be added to this chart while it runs.',
      'tb.type.Provider': 'Tag provider', 'tb.type.Folder': 'Folder', 'tb.type.UdtInstance': 'UDT instance',
      'tb.type.UdtType': 'UDT definition', 'tb.type.AtomicTag': 'Tag',
      'tb.target.trend': 'Adds to the session trend list \u201C{group}\u201D.',
      'tb.target.pens': 'Adds to this chart\u2019s pens.',
      'tb.add': 'Add selected ({n})',
      'tb.clear': 'Clear selection',
      'tb.selected': '{n} selected',
      'tb.tooMany': 'Select at most {max} tags.',
      'tb.full': 'This chart has room for {n} more pens.',
      'tb.trendOff': 'You can\u2019t add tags to the trend list here ({reason}).',
      'tb.added': 'Added {n} tags.',
      'tb.added1': 'Added {name}.',
      'tb.rejected': 'Not added:',
      'tb.duplicates': '{n} duplicates ignored.',
      'tb.failed': 'Adding failed: {message}',
      'tb.keys': 'Arrow keys move and open folders, Space selects, Enter adds the selection.',
      // tag browser: "Search all folders"
      'tb.searchAll': 'Search all folders',
      'tb.searchAllHelp': 'Search every folder instead of filtering the open one',
      'tb.search.placeholder': 'Search all tags',
      'tb.search.help': 'Finds tags in every folder by name or path. * and ? are wildcards.',
      'tb.search.short': 'Type at least 2 characters to search.',
      'tb.search.results': 'Search results',
      'tb.search.keys': 'Arrow keys move, Space selects, Enter adds the selection.',
      'tb.search.running': 'Searching all folders…',
      'tb.search.cancel': 'Cancel',
      'tb.search.cancelled': 'Search cancelled.',
      'tb.search.none': 'No tags match.',
      'tb.search.count': '{n} matching tags.',
      'tb.search.count1': '1 matching tag.',
      'tb.search.stopped.results': 'Showing the first {n} matches. Type more to narrow the search.',
      'tb.search.stopped.time': 'The search stopped after {s} s. Narrow it to find the rest.',
      'tb.search.stopped.size': 'The search stopped after {folders} folders. Narrow it to find the rest.',
      'tb.search.stopped.depth': 'Very deep folders were not searched.',
      'tb.search.stopped.errors': 'Some folders could not be searched.',
      'tb.search.failed': 'The search failed: {message}',
      'tb.search.retry': 'Try again',
      // annotation editor
      'an.titleAddNote': 'Add note',
      'an.titleAddRange': 'Add range',
      'an.titleEdit': 'Edit note',
      'an.titleEditRange': 'Edit range',
      'an.titleView': 'Note',
      'an.titleViewRange': 'Range',
      'an.type': 'Type',
      'an.type.note': 'Note',
      'an.type.range': 'Range',
      'an.pen': 'Pen',
      'an.time': 'Time',
      'an.start': 'Start',
      'an.end': 'End',
      'an.timeHelp': 'Time zone: {tz}',
      'an.text': 'Text',
      'an.count': '{n} / {max} characters',
      'an.color': 'Colour',
      'an.colorDefault': 'Default',
      'an.save': 'Save',
      'an.saving': 'Saving…',
      'an.cancel': 'Cancel',
      'an.close': 'Close',
      'an.delete': 'Delete',
      'an.deleteConfirm': 'Delete this note?',
      'an.author': 'By {author}',
      'an.authorUnknown': 'Author unknown',
      'an.created': 'created {time}',
      'an.editedBy': 'edited by {user}',
      'an.noPen': 'No pen on this plot has history: notes are stored with a tag’s history.',
      'an.readOnly': 'You can only change your own notes.',
      'an.readOnlyCap': 'Notes cannot be changed here: {reason}',
      'an.foreign': 'This note was written by another tool and cannot be changed here.',
      'an.invalidTime': 'Enter a valid date and time.',
      'an.overlap': 'This time occurs twice on this date (clock change); the entry keeps UTC{offset}.',
      'an.rangeOrder': 'The end must be after the start.',
      'an.textRequired': 'Enter a text.',
      'an.textLong': 'At most 1000 characters.',
      'an.failed': 'Not saved: {message}',
      'an.deleteFailed': 'Not deleted: {message}',
      'an.saved': 'Note added.',
      'an.savedEdit': 'Note saved.',
      'an.deleted': 'Note deleted.',
    });
    function t(key, vars) { return NS.i18n.t(key, vars, PART); }
    /** Operator text of a protocol error: the shared table first, then the gateway's message. */
    function errText(err) {
      var e = err || {};
      var code = typeof e === 'string' ? e : e.code;
      if (code && NS.i18n.has('error.' + code)) return NS.i18n.errorText(code, e.details || {}, PART);
      return String((e && e.message) || code || 'error');
    }
    function clean(s) {
      var str;
      try { str = String(s == null ? '' : s); } catch (e) { str = '(' + typeof s + ')'; }
      return str.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120);
    }

    /* ========================================================================
     * SECTION 2 / pure model (Node-tested through NS.chartPanels)
     * ----------------------------------------------------------------------
     * Plain-object helpers over the REDUCED props (api.props()).
     * Every edit returns new objects (the props are deep-frozen). The defaults
     * below are the chart schema's item defaults; the Node
     * test compares them with NS.chart.reduceProps so they cannot drift.
     * ====================================================================== */
    var AGGREGATIONS = ['LastValue', 'SimpleAverage', 'Average', 'Minimum', 'Maximum', 'MinMax', 'Range', 'Count', 'Sum',
      'StdDev', 'Variance', 'DurationOn', 'DurationOff', 'CountOn', 'CountOff', 'PctGood', 'PctBad'];
    var DISPLAY_TYPES = ['line', 'area', 'bar', 'scatter', 'step'];
    // the chart's display.interpolation enum (Power Chart curve types), in the order the editor lists them
    var INTERPOLATIONS = ['linear', 'spline', 'monotoneX', 'stepAfter', 'stepBefore', 'stepCenter', 'catmullRom', 'cardinal', 'natural',
      'basis', 'monotoneY', 'catmullRomOpen', 'cardinalOpen', 'basisOpen'];
    var BAD_STYLES = ['hatch', 'hold', 'none'];
    var DASHES = { solid: [], dashed: [6, 4], dotted: [2, 3] };
    var MAX_PLOTS = 8;                     // pens[].plot is 0..7 (schema)
    var PEN_COLUMN_IDS = ['current', 'minimum', 'maximum', 'average', 'xTrace', 'axis', 'plot', 'units', 'status'];
    var RANGE_COLUMN_IDS = ['first', 'last', 'delta', 'minimum', 'maximum', 'average', 'median', 'standardDeviation', 'sum',
      'lcl', 'ucl', 'count'];

    /**
     * The limits the chart draws for display.states.outOfBounds `o` (the chart's penStates rule, from the PenVM's meta,
     * so ChartApi needs no addition): engineering = the tag's EngLow / EngHigh with a configured side overriding it, manual =
     * the configured sides only; null when no limit is known or low >= high.
     */
    function oobLimits(o, meta) {
      if (!o) return null;
      var eng = o.source === 'engineering' && meta ? meta : null;
      var fin = function (x) { return typeof x === 'number' && isFinite(x); };
      var low = o.low != null ? o.low : eng && fin(eng.engLow) ? eng.engLow : null;
      var high = o.high != null ? o.high : eng && fin(eng.engHigh) ? eng.engHigh : null;
      if (low != null && high != null && !(high > low)) return null;
      return low == null && high == null ? null : { low: low, high: high };
    }
    /** display.states defaults (per-state styles). */
    function defaultStates() {
      return {
        bad: { style: 'hatch', color: '' },
        outOfBounds: { enabled: false, source: 'engineering', low: null, high: null, color: '', width: 0 },
        boolean: { enabled: false, onColor: '', offColor: '', fillOpacity: 0.15 },
      };
    }
    function defaultDisplay() {
      return { type: 'line', interpolation: 'linear', breakLine: true, width: 1.5, dash: [], fillOpacity: 0.2, radius: 3, states: defaultStates() };
    }
    function defaultPen(tagPath) {
      return { tagPath: tagPath || '', name: '', enabled: true, visible: true, aggregation: 'default', color: '', axis: '',
        plot: 0, units: '', format: '', display: defaultDisplay() };
    }
    function defaultOverride(tagPath) {
      return { tagPath: tagPath || '', name: '', color: '', visible: true, axis: '', plot: 0, units: '', format: '',
        display: defaultDisplay() };
    }
    function defaultAxis(name, position) {
      return { name: name || 'Axis 1', position: position || 'left', visible: true, label: { text: '', visible: true },
        color: '', format: '', scale: 'linear', width: 0,
        range: { mode: 'auto', min: null, max: null, includeZero: false, padding: 0.05 },
        grid: { visible: true, color: '', opacity: 0.5, dash: [] } };
    }
    function defaultPlot() { return { relativeWeight: 1, background: '', markers: [] }; }
    function defaultMarker(axis) {
      return { type: 'line', axis: axis || '', value: 0, min: 0, max: 0, color: '', opacity: 0.6, width: 1, dash: [4, 4],
        label: { text: '', position: 'right' } };
    }

    /** Deep copy of plain data (frozen reduced props -> writable); non-enumerable extras (pens[i].index) are dropped. */
    function copy(x) { return x == null || typeof x !== 'object' ? x : JSON.parse(JSON.stringify(x)); }
    /** Stable JSON (sorted keys): echo detection and change checks. */
    function stableJson(x) {
      if (x === undefined) return 'null';
      if (x === null || typeof x !== 'object') return JSON.stringify(x);
      if (Array.isArray(x)) return '[' + x.map(stableJson).join(',') + ']';
      return '{' + Object.keys(x).sort().map(function (k) { return JSON.stringify(k) + ':' + stableJson(x[k]); }).join(',') + '}';
    }
    /** New object with obj[path...] = value (path: array of keys / indices); intermediates copied, never mutated. */
    function setIn(obj, path, value) {
      if (!path.length) return value;
      var k = path[0];
      var base = obj == null ? (typeof k === 'number' ? [] : {}) : obj;
      var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
      out[k] = setIn(base[k], path.slice(1), value);
      return out;
    }
    function moveItem(arr, from, to) {
      var out = arr.slice();
      if (from < 0 || from >= out.length || to < 0 || to >= out.length || from === to) return out;
      var it = out.splice(from, 1)[0];
      out.splice(to, 0, it);
      return out;
    }
    /** "Axis 2", "Axis 3"…: the first `base N` not in `taken` (exact names, as the chart matches them). */
    function uniqueName(base, taken) {
      var set = {};
      (taken || []).forEach(function (n) { set[n] = true; });
      for (var i = 1; i < 1000; i++) { var n = base + ' ' + i; if (!set[n]) return n; }
      return base + ' ' + Date.now();
    }
    function normKey(p) { return NS.util.normKey(p); }

    /** Where "Add selected" / "Add pen" put tags (tagBrowser.addTo; auto = trend list when the chart has a trend group). */
    function trendGroupOf(props) { return NS.util.normTrendGroup(props.trendGroup, { kind: 'chart' }); }
    function addTarget(props) {
      var to = props.tagBrowser.addTo;
      if (to === 'pens' || to === 'trendList') return to === 'trendList' && trendGroupOf(props) == null ? 'pens' : to;
      return trendGroupOf(props) != null ? 'trendList' : 'pens';
    }

    /* ---- read scope mirror (the gateway decides, this only greys) ---- */
    function providerOf(key) { var m = /^\[([^\]]*)\]/.exec(key); return m ? m[1] : null; }
    /** True when normalized key `key` is `root` or below it ("[default]" contains every key of that provider). */
    function underRoot(key, root) {
      if (!root) return false;
      if (root.charAt(root.length - 1) === ']') return key.indexOf(root) === 0;
      return key === root || key.indexOf(root + '/') === 0;
    }
    /**
     * Mirror of ReadScope.allows(key, runtime=true) on the client with the snapshot's EFFECTIVE roots
     * (capabilities().readScope): 'in' | 'out' | 'unknown' (a path without a provider: only the gateway
     * knows its default provider, so it decides).
     */
    function scopeOf(path, scope) {
      var s = scope || {};
      if (!s.runtimePensAllowed) return 'out';
      var key = normKey(path);
      if (providerOf(key) == null) return 'unknown';
      var roots = Array.isArray(s.roots) ? s.roots : [];
      for (var i = 0; i < roots.length; i++) if (underRoot(key, normKey(roots[i]))) return 'in';
      return 'out';
    }
    /** A folder: 'in' (inside a root), 'ancestor' (contains a root: browse on), 'out'. */
    function folderScopeOf(path, scope) {
      var s = scope || {};
      if (!s.runtimePensAllowed) return 'out';
      var key = normKey(path);
      var roots = (Array.isArray(s.roots) ? s.roots : []).map(normKey);
      for (var i = 0; i < roots.length; i++) {
        if (underRoot(key, roots[i])) return 'in';
        var r = roots[i];
        var asFolder = key.charAt(key.length - 1) === ']' ? key : key + '/';
        if (r.indexOf(asFolder) === 0) return 'ancestor';
      }
      return 'out';
    }

    /**
     * Number field parsing: '' -> null when nullable; strict decimal syntax (NS.util.NUMERIC_RE); bounds
     * inclusive. Returns {ok, value} or {ok:false, error}.
     */
    function parseNum(text, o) {
      var opt = o || {};
      var s = String(text == null ? '' : text).trim();
      if (!s) return opt.nullable ? { ok: true, value: null } : { ok: false, error: t('num.invalid') };
      if (!NS.util.NUMERIC_RE.test(s)) return { ok: false, error: t('num.invalid') };
      var v = Number(s);
      if (!isFinite(v)) return { ok: false, error: t('num.invalid') };
      if (opt.integer && Math.floor(v) !== v) return { ok: false, error: t('num.integer') };
      var lo = opt.min, hi = opt.max;
      if (lo != null && hi != null && (v < lo || v > hi)) return { ok: false, error: t('num.range', { min: lo, max: hi }) };
      if (lo != null && v < lo) return { ok: false, error: t('num.min', { min: lo }) };
      if (hi != null && v > hi) return { ok: false, error: t('num.max', { max: hi }) };
      return { ok: true, value: v };
    }
    /**
     * '' (= automatic) or a colour the browser accepts: the hygiene rule of NS.props.color (no ; { } < > or
     * backslash) plus CSS.supports. Checked here without NS.props.color, which warns once per rejected value — a field
     * validated on every keystroke would log every partial "#0", "#00a"…
     */
    function validColor(s) {
      var v = String(s == null ? '' : s).trim();
      if (v === '') return true;
      if (/[;{}<>\\]/.test(v) || v.length > 64) return false;
      var css = W.CSS;
      return css && typeof css.supports === 'function' ? css.supports('color', v) : true;
    }
    /** #rrggbb for <input type=color> (named / rgb() colours via NS.theme.parseColor), else '#000000'. */
    function hexOf(s) {
      var c = s ? NS.theme.parseColor(String(s)) : null;
      if (!c) return '#000000';
      var hx = function (n) { var x = Math.round(Math.max(0, Math.min(255, n))).toString(16); return x.length < 2 ? '0' + x : x; };
      return '#' + hx(c.r) + hx(c.g) + hx(c.b);
    }
    /** A theme token colour for a colour field's "automatic" swatch (ChartApi.tokens(); #808080 when unknown). */
    function tokenColor(api, name) {
      try { var tk = api.tokens(); return (tk && tk[name]) || '#808080'; } catch (e) { return '#808080'; }
    }
    function dashName(d) {
      var j = JSON.stringify(d || []);
      for (var k in DASHES) if (hasOwn.call(DASHES, k) && JSON.stringify(DASHES[k]) === j) return k;
      return 'custom';
    }

    /**
     * Rows of the Pens tab. Static pens come from the (draft) `pens` array — ALL of them, disabled ones too
     * (the gateway lists only enabled pens) — matched to their view-model by key "p:<raw index>"; trend pens
     * are the api.pens() rows with source 'trend'. A view-model is used only when its tag path still matches
     * (between a structural write and the gateway's next chart.pens the keys can lag).
     *   staticRows: [{pos, pen, vm|null, key, label}]   trendRows: [{vm, key, label}]
     */
    function penRows(pens, vms, rawIndex) {
      var byKey = {};
      (vms || []).forEach(function (vm) { byKey[vm.key] = vm; });
      var staticRows = pens.map(function (pen, pos) {
        var raw = rawIndex && rawIndex[pos] != null ? rawIndex[pos] : pos;
        var vm = byKey['p:' + raw] || null;
        if (vm && normKey(vm.tagPath) !== normKey(pen.tagPath)) vm = null;
        var label = pen.name || (vm && vm.label) || NS.util.shortTagName(pen.tagPath) || pen.tagPath || '\u2014';
        return { pos: pos, pen: pen, vm: vm, key: 'p:' + raw, label: label };
      });
      var trendRows = (vms || []).filter(function (vm) { return vm.source === 'trend'; }).map(function (vm) {
        return { vm: vm, key: vm.key, label: vm.label || NS.util.shortTagName(vm.tagPath) };
      });
      return { staticRows: staticRows, trendRows: trendRows };
    }

    /**
     * Position of the static pen the editor works on: identified by normKey(tagPath), `pos` is only a hint (the
     * position it had when selected; it wins when it still holds that tag path, so duplicates stay apart).
     * Another writer (pen table, binding, script) may reorder / remove pens while the editor is open: the editor
     * follows the pen, never the position. -1 when the pen is gone.
     */
    function resolvePen(pens, key, pos) {
      var list = Array.isArray(pens) ? pens : [];
      var is = function (x) { return NS.util.isPlainObject(x) && normKey(x.tagPath) === key; };
      if (pos != null && is(list[pos])) return pos;
      for (var i = 0; i < list.length; i++) if (is(list[i])) return i;
      return -1;
    }
    /** Same for a named axis (name, position hint). */
    function resolveAxis(axes, name, pos) {
      var list = Array.isArray(axes) ? axes : [];
      var is = function (x) { return NS.util.isPlainObject(x) && x.name === name; };
      if (pos != null && is(list[pos])) return pos;
      for (var i = 0; i < list.length; i++) if (is(list[i])) return i;
      return -1;
    }

    /** Index of the trendPens.overrides entry for `tagPath` (normKey match, first wins like the chart), or -1. */
    function overrideIndex(trendPens, tagPath) {
      var k = normKey(tagPath);
      var list = trendPens && Array.isArray(trendPens.overrides) ? trendPens.overrides : [];
      for (var i = 0; i < list.length; i++) if (NS.util.isPlainObject(list[i]) && normKey(list[i].tagPath) === k) return i;
      return -1;
    }
    /** The effective override of a trend pen (a fresh default one when none is stored). */
    function overrideOf(trendPens, tagPath) {
      var i = overrideIndex(trendPens, tagPath);
      return i >= 0 ? trendPens.overrides[i] : defaultOverride(tagPath);
    }
    /** New trendPens with override[tagPath][path...] = value (the entry is created when missing). */
    function setOverride(trendPens, tagPath, path, value) {
      var i = overrideIndex(trendPens, tagPath);
      var list = (Array.isArray(trendPens.overrides) ? trendPens.overrides : []).slice();
      if (i < 0) { list.push(defaultOverride(tagPath)); i = list.length - 1; }
      list[i] = setIn(list[i], path, value);
      return Object.assign({}, trendPens, { overrides: list });
    }

    /**
     * What the chart actually uses for a trend pen (buildPens): the override merged over
     * trendPens.defaults — display = the override's when it is not the default display, axis / plot = the
     * override's when set (non-empty / non-zero), else the defaults'. The editor shows and edits this.
     * `defaults` (optional) replaces trendPens.defaults: a RAW trendPens may lack them, then the reduced ones
     * are given; an override without a display object uses the defaults' display.
     */
    /**
     * Which built-in choices a trend pen cannot get back while trendPens.defaults set them:
     * {axis, plot, display} — see the pen editor.
     */
    function defaultsLocks(trendPens) {
      var td = trendPens && NS.util.isPlainObject(trendPens.defaults) ? trendPens.defaults : {};
      return {
        axis: typeof td.axis === 'string' && td.axis !== '',
        plot: typeof td.plot === 'number' && td.plot > 0,
        display: NS.util.isPlainObject(td.display) && stableJson(td.display) !== stableJson(defaultDisplay()),
      };
    }
    function effectiveOverride(trendPens, tagPath, defaults) {
      var ov = overrideOf(trendPens, tagPath);
      var td = defaults || (NS.util.isPlainObject(trendPens.defaults) ? trendPens.defaults : {});
      var tdd = NS.util.isPlainObject(td.display) ? td.display : defaultDisplay();
      var own = NS.util.isPlainObject(ov.display) && stableJson(ov.display) !== stableJson(defaultDisplay());
      return Object.assign({}, ov, { display: own ? ov.display : copy(tdd), axis: ov.axis || td.axis || '', plot: ov.plot || td.plot || 0 });
    }

    /** Axis names in use (exact), for selects and uniqueness. */
    function axisNames(axes) { return (axes || []).map(function (a) { return a.name; }).filter(function (n) { return !!n; }); }
    /**
     * A new named axis on the side with fewer axes in use (api.axesInUse() of the plot; ties -> right).
     * Returns {axes, name}.
     */
    function addAxis(axes, inUse, plot) {
      var left = 0, right = 0;
      (inUse || []).forEach(function (a) { if (a.plot === (plot || 0)) { if (a.side === 'left') left++; else right++; } });
      var name = uniqueName('Axis', axisNames(axes));
      return { axes: (axes || []).concat([defaultAxis(name, right <= left ? 'right' : 'left')]), name: name };
    }
    /**
     * Renames an axis everywhere it is referenced (a rename updates the pens referencing it): pens,
     * trendPens.defaults/overrides and plot markers. Returns {axes, pens, trendPens, plots} (all new).
     */
    function renameAxis(s, from, to) {
      return {
        axes: renameAxisIn('axes', s.axes, from, to), pens: renameAxisIn('pens', s.pens, from, to),
        trendPens: renameAxisIn('trendPens', s.trendPens, from, to), plots: renameAxisIn('plots', s.plots, from, to),
      };
    }
    /** Deletes axis `idx`; pens (and overrides / defaults / markers) that used it fall back to automatic (''). */
    function deleteAxis(s, idx) {
      var name = s.axes[idx] && s.axes[idx].name;
      var out = renameAxis(s, name, '');
      // the axes list itself: drop only this entry (renameAxis also blanked same-named duplicates)
      out.axes = s.axes.filter(function (a, i) { return i !== idx; });
      return out;
    }
    /**
     * Adds a plot (an empty `plots` means one implicit plot, so the first add writes two). Returns {plots, index}.
     * `ids` {first, added} (optional): the stable ctgId of the materialised implicit plot and of the new
     * plot — generated once per click so the shown draft and the raw write carry the same ids.
     */
    function addPlot(plots, ids) {
      var first = defaultPlot();
      if (ids && ids.first) first.ctgId = ids.first;
      var list = plots && plots.length ? plots.slice() : [first];
      if (list.length >= MAX_PLOTS) return { plots: list, index: -1 };
      var added = defaultPlot();
      if (ids && ids.added) added.ctgId = ids.added;
      list.push(added);
      return { plots: list, index: list.length - 1 };
    }
    /** A new stable plot id (ctgId; the chart's reducer passes it through). */
    function newPlotId() { return 'pl' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36); }
    /** The stable id of a plot item (null for plots written without one, e.g. by an older version or the Designer). */
    function plotIdOf(pl) { return pl && typeof pl.ctgId === 'string' && pl.ctgId ? pl.ctgId : null; }
    /**
     * Removes plot `idx` (never the last one). Pens on it move to plot 0; pens on later plots
     * move down one, so they stay on the same plot. Same for trend overrides / defaults.
     */
    function removePlot(s, idx) {
      if (!s.plots.length || s.plots.length <= 1 || idx < 0 || idx >= s.plots.length) return null;
      var re = function (p) { return p === idx ? 0 : p > idx ? p - 1 : p; };
      return {
        plots: s.plots.filter(function (x, i) { return i !== idx; }),
        pens: s.pens.map(function (p) { var n = re(p.plot); return n === p.plot ? p : Object.assign({}, p, { plot: n }); }),
        trendPens: Object.assign({}, s.trendPens, {
          defaults: Object.assign({}, s.trendPens.defaults, { plot: re(s.trendPens.defaults.plot) }),
          overrides: s.trendPens.overrides.map(function (o) { var n = re(o.plot); return n === o.plot ? o : Object.assign({}, o, { plot: n }); }),
        }),
      };
    }

    /**
     * "Add pen" / tag browser (pens target) checks before writing (validate before writing; the
     * gateway remains the authority). Returns null or an error text.
     */
    function addPenError(path, ctx) {
      var p = String(path == null ? '' : path).trim();
      if (!p) return t('sp.add.empty');
      if (p.length > 1024) return errText('INVALID_PATH');
      var k = normKey(p);
      if ((ctx.existing || []).some(function (x) { return normKey(x) === k; })) return t('sp.add.dup');
      if (scopeOf(p, ctx.scope) === 'out') return ctx.scope && ctx.scope.runtimePensAllowed ? t('tb.outOfScope') + '.' : t('tb.noRuntime');
      if (ctx.max != null && ctx.count >= ctx.max) return t('sp.add.full', { max: ctx.max });
      return null;
    }

    /* ========================================================================
     * SECTION 2b / patch operations (ChartApi.patch)
     * ----------------------------------------------------------------------
     * Every edit of the settings panel and the tag browser is an OPERATION
     * op(value, ctx) -> value on one root. The DraftStore applies it twice:
     *   - to the REDUCED root (api.props(), full shape) for what the panel
     *     shows until the chart's props echo the write (ctx.raw false), and
     *   - to the RAW root inside ChartApi.patch (ctx.raw true, ctx.reduced =
     *     the reduced root with each array item's raw position in the non-
     *     enumerable `index`), which is what is written: keys the reducer does
     *     not know survive, and no default / clamp of an untouched field is
     *     persisted into the view.
     * So an operation finds its item BY IDENTITY in the value it is given
     * (static pen: normKey(tagPath); trend override: normKey(tagPath); axis:
     * name); a position is only a hint, mapped to the raw position through
     * ctx.reduced. Plots have no identity of their own: a plot is followed by a
     * PlotRef {pos, len, sig} (position, the plots count and the plot's JSON
     * when the editor last saw it) resolved on the reduced plots, then mapped
     * to its raw position. Raw values may hold anything (a binding wrote them):
     * every operation leaves entries it does not understand untouched.
     * ====================================================================== */
    function isObj(x) { return NS.util.isPlainObject(x); }
    /** The raw position of reduced item `pos` when it still names `key` (ctx.raw only), else the hint itself. */
    function rawHint(ctx, pos, key) {
      if (!ctx || !ctx.raw || pos == null) return pos;
      var r = Array.isArray(ctx.reduced) ? ctx.reduced[pos] : null;
      return r && typeof r.index === 'number' && normKey(r.tagPath) === key ? r.index : null;
    }
    /** The list an operation works on (a missing / wrong-kind raw value counts as empty). */
    function listOf(v) { return Array.isArray(v) ? v : []; }

    // ---- static pens (root `pens`) ----
    /** pens[pen key][path] = value. */
    function penFieldOp(key, hint, path, value) {
      return function (list, ctx) {
        var l = listOf(list);
        var i = resolvePen(l, key, rawHint(ctx, hint, key));
        return i < 0 ? list : setIn(l, [i].concat(path), value);
      };
    }
    /** Moves pen `fromKey` to the position of pen `toKey` (both by identity; reorder of the whole raw array). */
    function movePenOp(fromKey, fromHint, toKey, toHint) {
      return function (list, ctx) {
        var l = listOf(list);
        var i = resolvePen(l, fromKey, rawHint(ctx, fromHint, fromKey));
        var j = resolvePen(l, toKey, rawHint(ctx, toHint, toKey));
        return i < 0 || j < 0 ? list : moveItem(l, i, j);
      };
    }
    /** Appends a default pen per path that is not on the chart yet (normKey). */
    function addPensOp(paths, report) {
      return function (list) {
        var l = listOf(list).slice();
        var added = [], dups = [];
        paths.forEach(function (p) {
          if (resolvePen(l, normKey(p)) < 0) { l.push(defaultPen(p)); added.push(p); } else dups.push(p);
        });
        // `report` (optional): which paths this application really appended and which were on the chart
        // already (or named twice in the selection) — the tag browser fires 'add' and counts only the appended ones
        if (report) { report.added = added; report.duplicates = dups; }
        return l;
      };
    }
    /** Removes pen `key`. */
    function deletePenOp(key, hint) {
      return function (list, ctx) {
        var l = listOf(list);
        var i = resolvePen(l, key, rawHint(ctx, hint, key));
        return i < 0 ? list : l.filter(function (x, k) { return k !== i; });
      };
    }

    // ---- trend overrides (root `trendPens`) ----
    /** trendPens.overrides[tagPath][path] = value (the entry is created when missing). */
    function overrideFieldOp(tagPath, path, value) {
      return function (tp) { return setOverride(isObj(tp) ? tp : {}, tagPath, path, value); };
    }
    /**
     * display[field] = v of a trend pen: the whole EFFECTIVE display (override merged over trendPens.defaults,
     * effectiveOverride) with that field set; on the raw value the defaults come from the reduced root.
     */
    /** display[field] = v on a trend pen's EFFECTIVE display; `field` may be a path (['states', 'bad', 'style']). */
    function overrideDisplayOp(tagPath, field, v) {
      var path = Array.isArray(field) ? field : [field];
      return function (tp, ctx) {
        var t0 = isObj(tp) ? tp : {};
        var defaults = ctx && ctx.raw && isObj(ctx.reduced) ? ctx.reduced.defaults : null;
        var eff = effectiveOverride(t0, tagPath, defaults);
        return setOverride(t0, tagPath, ['display'], setIn(eff.display, path, v));
      };
    }

    // ---- axes (root `axes`, references in pens / trendPens / plots) ----
    function axisFieldOp(name, hint, path, value) {
      return function (list) {
        var l = listOf(list);
        var i = resolveAxis(l, name, hint);
        return i < 0 ? list : setIn(l, [i].concat(path), value);
      };
    }
    /** Appends axis `name` (default item) unless an axis of that name exists. */
    function addAxisOp(name, side) {
      return function (list) {
        var l = listOf(list);
        return resolveAxis(l, name) >= 0 ? list : l.concat([defaultAxis(name, side)]);
      };
    }
    /** Removes axis `name` (the entry at the hint when it has that name, else the first one). */
    function dropAxisOp(name, hint) {
      return function (list) {
        var l = listOf(list);
        var i = resolveAxis(l, name, hint);
        return i < 0 ? list : l.filter(function (x, k) { return k !== i; });
      };
    }
    /**
     * Rewrites every reference to axis `from` as `to` in ONE root (a rename updates the pens referencing
     * it): axes (the names), pens[].axis, trendPens.defaults.axis + overrides[].axis, plots[].markers[].axis.
     * Entries that are not objects stay as they are. to = '' blanks the references (delete: back to automatic).
     */
    function renameAxisIn(root, value, from, to) {
      var re = function (o, k) { return isObj(o) && o[k] === from ? Object.assign({}, o, (function () { var x = {}; x[k] = to; return x; })()) : o; };
      if (root === 'axes') return Array.isArray(value) ? value.map(function (a) { return re(a, 'name'); }) : value;
      if (root === 'pens') return Array.isArray(value) ? value.map(function (p) { return re(p, 'axis'); }) : value;
      if (root === 'trendPens') {
        if (!isObj(value)) return value;
        var out = Object.assign({}, value);
        if (isObj(value.defaults)) out.defaults = re(value.defaults, 'axis');
        if (Array.isArray(value.overrides)) out.overrides = value.overrides.map(function (o) { return re(o, 'axis'); });
        return out;
      }
      if (root === 'plots') {
        return Array.isArray(value) ? value.map(function (pl) {
          return isObj(pl) && Array.isArray(pl.markers) ? Object.assign({}, pl, { markers: pl.markers.map(function (m) { return re(m, 'axis'); }) }) : pl;
        }) : value;
      }
      return value;
    }
    function renameAxisOp(root, from, to) { return function (v) { return renameAxisIn(root, v, from, to); }; }

    // ---- plots (root `plots`; pens / trendPens keep plot numbers) ----
    /** A PlotRef for the editor of plot `pos` of the (reduced / draft) plots list ([] = the implicit single plot). */
    function plotRefOf(plots, pos) {
      var l = plots && plots.length ? plots : [defaultPlot()];
      return { pos: pos, len: l.length, sig: stableJson(l[pos] || null), id: plotIdOf(l[pos]) };
    }
    /**
     * Where plot `ref` is now in `plots` (reduced shape): its position while the plots count is unchanged (edits by
     * another writer in place keep it), else the one plot whose JSON is the remembered one; -1 when it is gone or
     * cannot be told apart (following the POSITION alone would send the edits to the next plot after another writer
     * removed an earlier one).
     */
    function resolvePlot(plots, ref) {
      var l = plots && plots.length ? plots : [defaultPlot()];
      if (!ref) return -1;
      if (ref.id) {
        // exact identity: the plot carrying that id, wherever it is now; none (or two) -> gone
        var at = -1;
        for (var k = 0; k < l.length; k++) {
          if (plotIdOf(l[k]) === ref.id) { if (at >= 0) return -1; at = k; }
        }
        return at;
      }
      if (l.length === ref.len) return ref.pos >= 0 && ref.pos < l.length ? ref.pos : -1;
      var hit = -1;
      for (var i = 0; i < l.length; i++) {
        if (stableJson(l[i]) === ref.sig) { if (hit >= 0) return -1; hit = i; }
      }
      return hit;
    }
    /**
     * plots[ref][path] = value. path may go into markers ['markers', k, ...]: k is the REDUCED marker position (what
     * the editor shows), mapped to the raw one. An implicit single plot ([] = one plot) is materialised first.
     */
    function plotFieldOp(ref, path, value) {
      return function (list, ctx) {
        var red = ctx && ctx.raw ? (Array.isArray(ctx.reduced) ? ctx.reduced : []) : listOf(list);
        var i = resolvePlot(red, ref);
        if (i < 0) return list;
        var p = path.slice();
        var at = i;
        if (ctx && ctx.raw) {
          var rp = red[i];
          at = rp && typeof rp.index === 'number' ? rp.index : i;
          if (p[0] === 'markers' && typeof p[1] === 'number') {
            var rm = rp && Array.isArray(rp.markers) ? rp.markers[p[1]] : null;
            if (rp && !rm) return list;                     // that marker is gone
            if (rm && typeof rm.index === 'number') p[1] = rm.index;
          }
        }
        var l = listOf(list).length ? listOf(list) : [defaultPlot()];
        // the raw list can be shorter than the reduced one says (a binding rewrote it): never write past its end
        // (setIn would leave holes / create a plot out of nothing)
        if (at >= l.length) return list;
        if (ctx && ctx.raw && p[0] === 'markers' && typeof p[1] === 'number') {
          var rawMarkers = isObj(l[at]) && Array.isArray(l[at].markers) ? l[at].markers : null;
          if (!rawMarkers || p[1] >= rawMarkers.length) return list;
        }
        return setIn(l, [at].concat(p), value);
      };
    }
    /** Appends a default marker to plot `ref`. */
    function addMarkerOp(ref, axis) {
      return function (list, ctx) {
        var red = ctx && ctx.raw ? (Array.isArray(ctx.reduced) ? ctx.reduced : []) : listOf(list);
        var i = resolvePlot(red, ref);
        if (i < 0) return list;
        var at = ctx && ctx.raw && red[i] && typeof red[i].index === 'number' ? red[i].index : i;
        var l = listOf(list).length ? listOf(list).slice() : [defaultPlot()];
        if (at >= l.length) return list;                     // raw shorter than the reduced list
        var pl = isObj(l[at]) ? l[at] : {};
        l[at] = Object.assign({}, pl, { markers: listOf(pl.markers).concat([defaultMarker(axis || '')]) });
        return l;
      };
    }
    /** Removes marker k (reduced position) of plot `ref`. */
    function removeMarkerOp(ref, k) {
      return function (list, ctx) {
        var red = ctx && ctx.raw ? (Array.isArray(ctx.reduced) ? ctx.reduced : []) : listOf(list);
        var i = resolvePlot(red, ref);
        if (i < 0) return list;
        var at = i, mk = k;
        if (ctx && ctx.raw && red[i]) {
          at = typeof red[i].index === 'number' ? red[i].index : i;
          var rm = Array.isArray(red[i].markers) ? red[i].markers[k] : null;
          if (!rm) return list;
          mk = typeof rm.index === 'number' ? rm.index : k;
        }
        var l = listOf(list);
        if (at >= l.length || !isObj(l[at]) || !Array.isArray(l[at].markers) || mk >= l[at].markers.length) return list;
        var out = l.slice();
        out[at] = Object.assign({}, l[at], { markers: l[at].markers.filter(function (x, j) { return j !== mk; }) });
        return out;
      };
    }
    /**
     * Appends a plot (an empty list = one implicit plot, so the first add writes two); never more than MAX_PLOTS.
     * `ids` as for addPlot: the same ids in both applications of the operation.
     */
    function addPlotOp(ids) {
      return function (list) { var r = addPlot(listOf(list), ids); return r.index < 0 ? list : r.plots; };
    }
    /**
     * Removes plot `ref` (never the last): {plots, pens, trendPens} operations. Pens on it move to plot 0, pens on
     * later plots move down one. Plot numbers in pens / overrides are REDUCED plot positions (the
     * chart's), so the renumbering uses the reduced position of the removed plot.
     */
    function removePlotOps(ref, reducedPlots) {
      var idx = resolvePlot(reducedPlots, ref);
      if (idx < 0 || !reducedPlots || reducedPlots.length <= 1) return null;
      var re = function (p) { return p === idx ? 0 : p > idx ? p - 1 : p; };
      var renum = function (o) {
        if (!isObj(o) || typeof o.plot !== 'number') return o;
        var n = re(o.plot);
        return n === o.plot ? o : Object.assign({}, o, { plot: n });
      };
      return {
        plots: function (list, ctx) {
          var red = ctx && ctx.raw ? (Array.isArray(ctx.reduced) ? ctx.reduced : []) : listOf(list);
          var i = resolvePlot(red, ref);
          if (i < 0 || red.length <= 1) return list;
          var at = ctx && ctx.raw && typeof red[i].index === 'number' ? red[i].index : i;
          if (at >= listOf(list).length) return list;            // raw shorter than the reduced list
          return listOf(list).filter(function (x, k) { return k !== at; });
        },
        pens: function (list) { return Array.isArray(list) ? list.map(renum) : list; },
        trendPens: function (tp) {
          if (!isObj(tp)) return tp;
          var out = Object.assign({}, tp);
          if (isObj(tp.defaults)) out.defaults = renum(tp.defaults);
          if (Array.isArray(tp.overrides)) out.overrides = tp.overrides.map(renum);
          return out;
        },
      };
    }

    /* ========================================================================
     * SECTION 3 / TagTree — the browse tree model (pure)
     * ----------------------------------------------------------------------
     * Nodes keyed by normKey(path); the root has key '' (the gateway's root:
     * tagBrowser.rootPath, or the provider list). A folder's children come
     * page by page from chart.browse {path, continuation, limit:100,
     * filterText}; `continuation` is opaque and null on the last page
     * ("Load more…" follows the continuation, never totalAvailable). rows()
     * flattens the expanded part into the visible row list the component
     * renders (role=tree), including the per-folder loading / error / empty /
     * "Load more…" rows. Every load has a generation: a reply for an older
     * request (reload, new filter) is dropped.
     * ====================================================================== */
    var PAGE_LIMIT = 100;
    var AUTO_PAGES = 20;                  // filtered pages fetched in a row while they come back empty
    function TagTree() {
      this.nodes = Object.create(null);
      this.nodes[''] = { key: '', path: '', name: '', type: 'Root', hasChildren: true, trendable: false, dataType: null,
        parent: null, depth: -1, expanded: true, loaded: false, loading: false, error: null, children: [], continuation: null,
        gen: 0, filtered: false, filter: '' };
      this.keep = null;                   // optional key -> bool: nodes never pruned (the selection)
    }
    TagTree.prototype.get = function (key) { return hasOwn.call(this.nodes, key) ? this.nodes[key] : null; };
    TagTree.prototype.root = function () { return this.nodes['']; };
    /** Marks a folder as loading and returns the generation the reply must carry. */
    TagTree.prototype.startLoad = function (key, append) {
      var n = this.get(key);
      if (!n) return -1;
      n.gen++;
      n.loading = true;
      if (!append) { n.error = null; }
      return n.gen;
    };
    /**
     * Applies a chart.browse reply (data {path, continuation, results|rows}). Stale generations are ignored.
     * `filter` = the filterText the page was requested with ('' / falsy = unfiltered; true = filtered, text
     * unknown): "Load more…" continues with the same filter state. A first page (not append)
     * drops the sub-trees of children that are no longer listed (bounded memory), except kept nodes.
     */
    TagTree.prototype.applyPage = function (key, gen, data, append, filter) {
      var n = this.get(key);
      if (!n || n.gen !== gen) return false;
      var self = this;
      var rows = (data && (Array.isArray(data.results) ? data.results : Array.isArray(data.rows) ? data.rows : [])) || [];
      var kids = append ? n.children.slice() : [];
      var seen = {};
      kids.forEach(function (k) { seen[k] = true; });
      rows.forEach(function (r) {
        if (!r || typeof r.path !== 'string' || !r.path) return;
        var k = normKey(r.path);
        if (!k || seen[k] || k === key) return;
        seen[k] = true;
        var old = self.get(k);
        var node = old || { key: k, expanded: false, loaded: false, loading: false, error: null, children: [], continuation: null, gen: 0, filtered: false, filter: '' };
        node.path = r.path;
        node.name = String(r.name == null ? NS.util.shortTagName(r.path) : r.name);
        node.type = String(r.type || 'Unknown');
        node.dataType = r.dataType == null ? null : String(r.dataType);
        node.hasChildren = !!r.hasChildren;
        node.trendable = !!r.trendable;
        node.parent = key;
        node.depth = n.depth + 1;
        self.nodes[k] = node;
        kids.push(k);
      });
      if (!append) {
        var now = {};
        kids.forEach(function (c) { now[c] = true; });
        n.children.forEach(function (c) { if (!now[c]) self.drop(c); });
      }
      n.children = kids;
      n.continuation = data && typeof data.continuation === 'string' && data.continuation ? data.continuation : null;
      n.loaded = true;
      n.loading = false;
      n.error = null;
      n.filtered = !!filter;
      n.filter = typeof filter === 'string' ? filter : '';
      return true;
    };
    /** Forgets node `key` and its sub-tree (kept nodes stay, detached). */
    TagTree.prototype.drop = function (key) {
      var n = this.get(key);
      if (!n || key === '') return;
      var self = this;
      n.children.forEach(function (c) { self.drop(c); });
      if (this.keep && this.keep(key)) { n.children = []; n.loaded = false; n.expanded = false; n.continuation = null; return; }
      delete this.nodes[key];
    };
    /** The folder must be browsed again before it is shown (its pages were for another filter). */
    TagTree.prototype.invalidate = function (key) {
      var n = this.get(key);
      if (!n) return;
      var self = this;
      n.gen++;                            // a reply in flight is stale now
      n.children.forEach(function (c) { self.drop(c); });
      n.children = [];
      n.continuation = null;
      n.loaded = false;
      n.loading = false;
      n.error = null;
      n.filtered = false;
      n.filter = '';
    };
    TagTree.prototype.failLoad = function (key, gen, error) {
      var n = this.get(key);
      if (!n || n.gen !== gen) return false;
      n.loading = false;
      n.error = error || { code: 'INTERNAL' };
      return true;
    };
    TagTree.prototype.setExpanded = function (key, on) {
      var n = this.get(key);
      if (!n || !n.hasChildren || key === '') return false;
      n.expanded = !!on;
      return true;
    };
    /** Visible rows in display order: {id, kind:'node'|'more'|'loading'|'error'|'empty', key (node or folder), depth}. */
    TagTree.prototype.rows = function () {
      var out = [];
      var self = this;
      (function walk(folderKey) {
        var f = self.get(folderKey);
        f.children.forEach(function (k) {
          var n = self.get(k);
          if (!n) return;
          out.push({ id: 'n:' + k, kind: 'node', key: k, depth: n.depth });
          if (n.hasChildren && n.expanded) walk(k);
        });
        var d = f.depth + 1;
        if (f.error) out.push({ id: 'err:' + folderKey, kind: 'error', key: folderKey, depth: d });
        else if (f.loading && !f.children.length) out.push({ id: 'load:' + folderKey, kind: 'loading', key: folderKey, depth: d });
        else if (f.loaded && !f.children.length && !f.continuation) out.push({ id: 'empty:' + folderKey, kind: 'empty', key: folderKey, depth: d });
        if (f.continuation && !f.error) out.push({ id: 'more:' + folderKey, kind: 'more', key: folderKey, depth: d, busy: f.loading });
      })('');
      return out;
    };
    /** Expanded folders (root included) — what "Reload" browses again. */
    TagTree.prototype.expandedKeys = function () {
      var out = [];
      var self = this;
      (function walk(k) {
        var n = self.get(k);
        if (!n) return;
        out.push(k);
        n.children.forEach(function (c) { var x = self.get(c); if (x && x.hasChildren && x.expanded) walk(c); });
      })('');
      return out;
    };
    /**
     * The folders the filter applies to: the open folders the user is looking into = expanded folders with
     * no expanded sub-folder (the root when nothing is expanded). Their ancestors stay unfiltered, so the
     * path down to them never disappears.
     */
    TagTree.prototype.filterTargets = function () {
      var self = this;
      return this.expandedKeys().filter(function (k) {
        var n = self.get(k);
        return !n.children.some(function (c) { var x = self.get(c); return x && x.hasChildren && x.expanded; });
      });
    };

    /* ========================================================================
     * SECTION 3b / TagSearchModel — "Search all folders" results (pure)
     * ----------------------------------------------------------------------
     * Gateway side: TagBrowseService "Recursive search".
     * chart.browse {path:'', search, limit} runs ONE bounded search on the
     * gateway (user's permissions, tagBrowser.rootPath, read scope) and
     * answers with the first page of its matches (tags only, sorted by path)
     * plus `search` {complete, stopped, folders, elapsedMs, maxResults, ...};
     * {search, continuation} pages through the stored matches (no new
     * search); {cancelSearch:true} stops it. Every search has a sequence
     * number: a reply for an older one (retyped, cancelled) is dropped, and a
     * reply whose search.stopped is 'superseded' / 'cancelled' carries no
     * rows. Hits have the TagTree node shape (key, path, name, type,
     * dataType, hasChildren, trendable) + folder, so the browser's selection
     * and selectable rules apply to them unchanged.
     * ====================================================================== */
    var SEARCH_PAGE = 100;
    var SEARCH_TIMEOUT_MS = 20000;        // the gateway's walk is bounded to 5 s + one permission read
    var SEARCH_DEBOUNCE_MS = 450;
    var SEARCH_RETRY_MS = 1200;           // one automatic retry after RATE_LIMITED / BUSY
    /**
     * True when `text` is worth a search: 2+ characters that are not * / ? / blanks, or 1+ with a wildcard
     * (the gateway accepts 1 literal character; the browser asks for a little more before walking every folder).
     */
    function searchable(text) {
      var s = String(text == null ? '' : text).trim();
      if (!s || s.length > 64) return false;
      var literal = s.replace(/[*?\s]/g, '').length;
      return /[*?]/.test(s) ? literal >= 1 : literal >= 2;
    }
    function TagSearchModel() {
      this.seq = 0;
      this.reset();
    }
    /** Back to "no search" (any reply in flight becomes stale). */
    TagSearchModel.prototype.reset = function () {
      this.seq++;
      this.status = 'idle';               // idle | running | done | cancelled | error
      this.text = '';
      this.keys = [];
      this.index = Object.create(null);
      this.continuation = null;
      this.total = 0;
      this.info = null;
      this.error = null;
      this.loadingMore = false;
    };
    /** A new search for `text`; returns the sequence its replies must carry. */
    TagSearchModel.prototype.start = function (text) {
      this.reset();
      this.status = 'running';
      this.text = String(text);
      return this.seq;
    };
    TagSearchModel.prototype.get = function (key) { return hasOwn.call(this.index, key) ? this.index[key] : null; };
    TagSearchModel.prototype.hits = function () { var self = this; return this.keys.map(function (k) { return self.index[k]; }); };
    /** Applies a reply page (append = "Load more…"). False when stale or not a result page. */
    TagSearchModel.prototype.apply = function (seq, data, append) {
      if (seq !== this.seq) return false;
      var d = data || {};
      var info = d.search && typeof d.search === 'object' ? d.search : {};
      if (info.stopped === 'superseded') return false;          // a newer search of this chart answers instead
      if (info.stopped === 'cancelled') { this.status = 'cancelled'; this.loadingMore = false; return true; }
      var self = this;
      if (!append) { this.keys = []; this.index = Object.create(null); }
      (Array.isArray(d.results) ? d.results : []).forEach(function (r) {
        if (!r || typeof r.path !== 'string' || !r.path) return;
        var k = normKey(r.path);
        if (!k || self.index[k]) return;
        self.index[k] = { key: k, path: r.path, name: String(r.name == null ? NS.util.shortTagName(r.path) : r.name),
          type: 'AtomicTag', dataType: r.dataType == null ? null : String(r.dataType), hasChildren: false, trendable: !!r.trendable,
          folder: typeof r.folder === 'string' ? r.folder : '' };
        self.keys.push(k);
      });
      this.continuation = typeof d.continuation === 'string' && d.continuation ? d.continuation : null;
      this.total = typeof d.totalAvailable === 'number' && isFinite(d.totalAvailable) ? d.totalAvailable : this.keys.length;
      if (!append || !this.info) this.info = info;
      this.status = 'done';
      this.error = null;
      this.loadingMore = false;
      return true;
    };
    /** A copy of a finished search (results, status, paging) for a re-mounted browser (SECTION 8). */
    TagSearchModel.prototype.copy = function () {
      var m = new TagSearchModel();
      m.status = this.status;
      m.text = this.text;
      m.keys = this.keys.slice();
      m.index = Object.assign(Object.create(null), this.index);
      m.continuation = this.continuation;
      m.total = this.total;
      m.info = this.info;
      m.error = this.error;
      return m;
    };
    /** A failed request (a failed "Load more…" keeps the rows and only reports). */
    TagSearchModel.prototype.fail = function (seq, error, append) {
      if (seq !== this.seq) return false;
      this.loadingMore = false;
      this.error = error || { code: 'INTERNAL' };
      if (!append) this.status = 'error';
      return true;
    };
    /** The user stopped the running search: its replies are stale from now on. */
    TagSearchModel.prototype.cancel = function () {
      if (this.status !== 'running') return false;
      this.seq++;
      this.status = 'cancelled';
      return true;
    };
    /** The status line: {text, tone ('' | 'error'), act ('cancel' | 'retry' | null)}. */
    TagSearchModel.prototype.statusLine = function () {
      if (this.status === 'running') return { text: t('tb.search.running'), tone: '', act: 'cancel' };
      if (this.status === 'cancelled') return { text: t('tb.search.cancelled'), tone: '', act: 'retry' };
      if (this.status === 'error') return { text: t('tb.search.failed', { message: errText(this.error) }), tone: 'error', act: 'retry' };
      if (this.status !== 'done') return null;
      var n = this.total;
      var i = this.info || {};
      var extra = this.error ? ' ' + t('tb.search.failed', { message: errText(this.error) }) : '';
      if (!n && i.complete !== false) return { text: t('tb.search.none') + extra, tone: this.error ? 'error' : '', act: null };
      // the count (singular / plural / none), then why an incomplete search stopped
      var text = !n ? t('tb.search.none') : n === 1 ? t('tb.search.count1') : t('tb.search.count', { n: n });
      switch (i.stopped) {
        case 'results': text = t('tb.search.stopped.results', { n: n }); break;
        case 'time': text += ' ' + t('tb.search.stopped.time', { s: Math.max(1, Math.round((Number(i.elapsedMs) || 0) / 1000)) }); break;
        case 'nodes': case 'folders': text += ' ' + t('tb.search.stopped.size', { folders: Number(i.folders) || 0 }); break;
        case 'depth': text += ' ' + t('tb.search.stopped.depth'); break;
        case 'errors': text += ' ' + t('tb.search.stopped.errors'); break;
        default: break;
      }
      return { text: text + extra, tone: this.error ? 'error' : '', act: null };
    };

    /* ========================================================================
     * SECTION 4 / DraftStore — debounced writes of patches
     * ----------------------------------------------------------------------
     * A pending edit is an OPERATION (SECTION 2b: op(value, ctx) -> value,
     * keyed by item: tag path, axis name, PlotRef), not a snapshot of the
     * whole root. Operations are applied at flush time to the CURRENT value of
     * the root, so a change another writer made meanwhile (tag browser, pen
     * table, colour picker, a binding, a script) is kept, and an operation
     * whose item is gone changes nothing.
     *   get(root)               the value the panel shows: base + pending ops
     *                           (reduced shape); base = the last written draft
     *                           until the chart's props echo it (or change
     *                           otherwise, or 3 s pass: a binding may have won),
     *                           else api.props()[root]
     *   edit(root, id, op, now?) queue an operation (a later one with the same id
     *                           replaces it); written after 300 ms of quiet, or
     *                           at once (structural edits: add, delete, move …)
     *   flush()                 one ChartApi.patch per pending root: the same
     *                           operations applied to the RAW root;
     *                           returns false when the chart refused one
     *                           (design mode, unknown key). onFlush(ok, written,
     *                           attempted) reports what was written / tried.
     * ====================================================================== */
    var DEBOUNCE_MS = 300;
    var ECHO_TTL_MS = 3000;
    function DraftStore(api, opts) {
      this.api = api;
      this.ops = Object.create(null);          // root -> [{id, fn}]
      this.written = Object.create(null);      // root -> {value, json, prev, at}
      this.timer = null;
      this.opts = opts || {};
      this.now = this.opts.now || function () { return Date.now(); };
    }
    /** The value pending patches apply to (see get). */
    DraftStore.prototype.base = function (root) {
      var cur = this.api.props()[root];
      var w = this.written[root];
      if (w) {
        var j = stableJson(cur);
        // echoed, or the props changed since the write (another writer / a binding): the props win
        if (j === w.json || j !== w.prev || this.now() - w.at > ECHO_TTL_MS) delete this.written[root];
        else return copy(w.value);
      }
      return copy(cur);
    };
    /** ctx of the shown (reduced-shape) application of operations. */
    DraftStore.prototype._shown = function (root) { return { raw: false, reduced: this.api.props()[root] }; };
    DraftStore.prototype.get = function (root) {
      var v = this.base(root);
      var list = this.ops[root];
      var ctx = this._shown(root);
      if (list) for (var i = 0; i < list.length; i++) v = list[i].fn(v, ctx);
      return v;
    };
    DraftStore.prototype.has = function (root) { return !!(this.ops[root] && this.ops[root].length); };
    DraftStore.prototype._schedule = function () {
      var self = this;
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(function () { self.timer = null; self.flush(); }, DEBOUNCE_MS);
    };
    DraftStore.prototype.edit = function (root, id, fn, immediate) {
      var list = (this.ops[root] || []).filter(function (o) { return id == null || o.id !== id; });
      list.push({ id: id, fn: fn });
      this.ops[root] = list;
      if (immediate) return this.flush();
      this._schedule();
      return true;
    };
    DraftStore.prototype.flush = function () {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      var ok = true;
      var roots = Object.keys(this.ops);
      var written = [];
      for (var i = 0; i < roots.length; i++) {
        var root = roots[i];
        var base = this.base(root);
        var value = base;
        var list = this.ops[root];
        delete this.ops[root];
        var shown = this._shown(root);
        for (var k = 0; k < list.length; k++) value = list[k].fn(value, shown);
        var json = stableJson(value);
        if (json === stableJson(base)) continue;                 // nothing changed (e.g. the item is gone)
        var prev = stableJson(this.api.props()[root]);
        var done = false;
        // the same operations on the RAW root: what is written
        var onRaw = applyOps(list);
        try { done = this.api.patch(root, onRaw) !== false; } catch (e) { log.warn('write failed', root, e); }
        if (done) { this.written[root] = { value: value, json: json, prev: prev, at: this.now() }; written.push(root); }
        else ok = false;
      }
      if (roots.length && this.opts.onFlush) this.opts.onFlush(ok, written, roots);
      return ok;
    };
    /** ChartApi.patch function applying `list` to the raw root (ctx.raw, ctx.reduced = the reduced root). */
    function applyOps(list) {
      return function (raw, reduced) {
        var ctx = { raw: true, reduced: reduced };
        var v = raw;
        for (var k = 0; k < list.length; k++) v = list[k].fn(v, ctx);
        return v;
      };
    }
    DraftStore.prototype.cancel = function () {
      if (this.timer) { clearTimeout(this.timer); this.timer = null; }
      this.ops = Object.create(null);
    };

    /* ========================================================================
     * SECTION 5 / styles (ctg-chart-panels-styles)
     * ----------------------------------------------------------------------
     * Every rule in :where() (zero specificity) and only the shared --ctg-*
     * tokens of ctg-common.js, so the Perspective themes (light / dark)
     * apply and project CSS always wins. Form controls reuse the common
     * .ctg-btn / .ctg-field / .ctg-input / .ctg-select classes.
     * ====================================================================== */
    var PANEL_CSS = [
      // the chart wraps every docked panel in div.ctg-chart__panel inside its flex-column dock; let that slot
      // fill the dock's height so a panel spans the plot area (ctg-chart-styles carries the same rule; this
      // zero-specificity copy is a harmless duplicate)
      ':where(.ctg-chart__dock>.ctg-chart__panel){display:flex;flex-direction:column;flex:1 1 auto;min-height:0;}',
      ':where(.ctg-pnl){display:flex;flex-direction:column;flex:1 1 auto;min-height:0;height:100%;max-width:100%;',
      'background:var(--ctg-surface);color:var(--ctg-text);font-family:var(--ctg-font);font-size:13px;line-height:1.35;}',
      ':where(.ctg-pnl--overlay){position:absolute;inset:0;z-index:30;width:auto !important;box-shadow:var(--ctg-shadow);}',
      // in the narrow layout the chart puts docked panels in its own sheet with a "‹ Back" head;
      // the narrow frame brings its own Back, so the chart's head (covered by the overlay but still tabbable) goes.
      // Browsers without :has() drop this rule and keep the covered head.
      ':where(.ctg-chart__sheet:has(>.ctg-chart__sheet-body .ctg-pnl--overlay)>.ctg-chart__sheet-head){display:none;}',
      ':where(.ctg-pnl__header){flex:none;display:flex;align-items:center;gap:4px;min-height:38px;padding:4px 6px 4px 10px;',
      'border-bottom:1px solid var(--ctg-border);}',
      ':where(.ctg-pnl__title){flex:1 1 auto;min-width:0;margin:0;font-size:14px;font-weight:600;white-space:nowrap;',
      'overflow:hidden;text-overflow:ellipsis;outline:none;}',
      ':where(.ctg-pnl__body){flex:1 1 auto;min-height:0;overflow:auto;padding:8px 10px;}',
      ':where(.ctg-pnl__footer){flex:none;display:flex;flex-wrap:wrap;align-items:center;gap:6px 8px;padding:8px 10px;',
      'border-top:1px solid var(--ctg-border);}',
      ':where(.ctg-pnl__spacer){flex:1 1 0;}',
      ':where(.ctg-pnl__notice){margin:4px 0 8px;padding:6px 8px;font-size:12.5px;border-left:3px solid var(--ctg-warn);',
      'background:var(--ctg-surface-2);border-radius:var(--ctg-radius);}',
      ':where(.ctg-pnl__error){color:var(--ctg-danger);}',
      ':where(.ctg-pnl__muted){color:var(--ctg-text-muted);}',
      ':where(.ctg-pnl__ibtn){display:inline-flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;',
      'padding:0;font:inherit;color:inherit;background:transparent;border:1px solid transparent;border-radius:var(--ctg-radius);',
      'cursor:pointer;}',
      ':where(.ctg-pnl__ibtn:hover:not(:disabled)){background:var(--ctg-surface-2);}',
      ':where(.ctg-pnl__ibtn:disabled){opacity:.4;cursor:default;}',
      ':where(.ctg-pnl__ibtn:focus-visible,.ctg-pnl__link:focus-visible,.ctg-sp-tab:focus-visible,.ctg-sp-name:focus-visible,',
      '.ctg-tbr-tree:focus-visible,.ctg-tbr-row:focus-visible){outline:2px solid var(--ctg-focus);outline-offset:-2px;}',
      ':where(.ctg-pnl__link){padding:2px 4px;font:inherit;color:var(--ctg-primary);background:transparent;border:0;',
      'border-radius:var(--ctg-radius);cursor:pointer;text-decoration:underline;}',
      ':where(.ctg-pnl__link:disabled){color:var(--ctg-text-muted);cursor:default;text-decoration:none;}',
      ':where(.ctg-pnl .ctg-icon){width:18px;height:18px;flex:none;fill:currentColor;}',
      ':where(.ctg-pnl .ctg-field){margin:0 0 8px;}',
      ':where(.ctg-pnl .ctg-field__label){font-size:12.5px;}',
      ':where(.ctg-pnl .ctg-input,.ctg-pnl .ctg-select){min-height:30px;padding:3px 6px;font-size:13px;}',
      ':where(.ctg-pnl .ctg-btn){min-height:30px;padding:3px 12px;font-size:13px;}',
      ':where(.ctg-pnl__check){display:flex;align-items:center;gap:8px;min-height:28px;margin:0 0 6px;font-size:13px;cursor:pointer;}',
      ':where(.ctg-pnl__check input){width:16px;height:16px;margin:0;flex:none;}',
      ':where(.ctg-pnl__section){margin:12px 0 6px;font-size:11.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;',
      'color:var(--ctg-text-muted);}',
      ':where(.ctg-pnl__section:first-child){margin-top:2px;}',
      ':where(.ctg-pnl__grid){display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0 10px;}',
      ':where(.ctg-pnl__row){display:flex;align-items:center;gap:6px;}',
      ':where(.ctg-pnl__status){min-height:18px;font-size:12.5px;}',
      ':where(.ctg-pnl fieldset){margin:0 0 10px;padding:6px 8px 2px;border:1px solid var(--ctg-border);border-radius:var(--ctg-radius);}',
      ':where(.ctg-pnl legend){padding:0 4px;font-size:12.5px;font-weight:600;}',
      // settings: tabs, lists
      ':where(.ctg-sp-tabs){flex:none;display:flex;gap:2px;padding:0 6px;border-bottom:1px solid var(--ctg-border);overflow-x:auto;}',
      ':where(.ctg-sp-tab){min-height:34px;padding:0 10px;font:inherit;font-size:13px;color:var(--ctg-text-muted);',
      'background:transparent;border:0;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;}',
      ':where(.ctg-sp-tab[aria-selected="true"]){color:var(--ctg-text);font-weight:600;border-bottom-color:var(--ctg-primary);}',
      ':where(.ctg-sp-list){list-style:none;margin:0 0 8px;padding:0;}',
      ':where(.ctg-sp-item){display:flex;align-items:center;gap:4px;min-height:32px;padding:1px 2px;border-radius:var(--ctg-radius);}',
      ':where(.ctg-sp-item:hover){background:var(--ctg-surface-2);}',
      ':where(.ctg-sp-item--drop){box-shadow:inset 0 2px 0 var(--ctg-primary);}',
      ':where(.ctg-sp-item--off .ctg-sp-name){color:var(--ctg-text-muted);text-decoration:line-through;}',
      ':where(.ctg-sp-grip){display:inline-flex;width:14px;color:var(--ctg-text-muted);cursor:grab;}',
      ':where(.ctg-sp-dot){width:12px;height:12px;flex:none;border-radius:3px;background:var(--ctg-pen,var(--ctg-text-muted));}',
      ':where(.ctg-sp-name){flex:1 1 auto;min-width:0;min-height:28px;padding:0 4px;font:inherit;text-align:left;color:inherit;',
      'background:transparent;border:0;border-radius:var(--ctg-radius);cursor:pointer;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;}',
      ':where(.ctg-sp-name:hover){text-decoration:underline;}',
      ':where(.ctg-sp-chip){flex:none;padding:0 6px;font-size:11.5px;color:var(--ctg-text-muted);border:1px solid var(--ctg-border);',
      'border-radius:8px;white-space:nowrap;}',
      ':where(.ctg-sp-chip--error){color:var(--ctg-danger);border-color:currentColor;}',
      ':where(.ctg-sp-color){display:flex;align-items:center;gap:4px;}',
      ':where(.ctg-sp-color .ctg-input){flex:1 1 auto;min-width:0;}',
      ':where(.ctg-sp-color input[type="color"]){flex:none;width:32px;height:30px;padding:1px;background:var(--ctg-input-bg);',
      'border:1px solid var(--ctg-border);border-radius:var(--ctg-radius);cursor:pointer;}',
      ':where(.ctg-sp-subhead){display:flex;align-items:center;gap:6px;margin:0 0 8px;}',
      ':where(.ctg-sp-subhead__name){flex:1 1 auto;min-width:0;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      ':where(.ctg-sp-danger){color:var(--ctg-danger);}',
      // tag browser
      ':where(.ctg-tbr-tools){flex:none;display:flex;align-items:center;gap:4px;padding:6px 8px 2px;}',
      ':where(.ctg-tbr-tools .ctg-input){flex:1 1 auto;min-width:0;}',
      ':where(.ctg-tbr-help){flex:none;padding:0 8px 4px;font-size:11.5px;color:var(--ctg-text-muted);}',
      ':where(.ctg-tbr-tree){flex:1 1 auto;min-height:0;overflow:auto;padding:2px 0;outline:none;}',
      ':where(.ctg-tbr-row){display:flex;align-items:center;gap:5px;min-height:26px;padding:1px 8px 1px calc(6px + var(--ctg-depth,0) * 16px);',
      'white-space:nowrap;cursor:default;user-select:none;}',
      ':where(.ctg-tbr-row:hover){background:var(--ctg-surface-2);}',
      ':where(.ctg-tbr-row[aria-selected="true"]){background:var(--ctg-surface-2);font-weight:600;}',
      '@supports (color:color-mix(in srgb,red 50%,blue)){:where(.ctg-tbr-row[aria-selected="true"]){',
      'background:color-mix(in srgb,var(--ctg-primary) 16%,transparent);}}',
      ':where(.ctg-tbr-row--muted){color:var(--ctg-text-muted);}',
      ':where(.ctg-tbr-row--msg){font-size:12.5px;color:var(--ctg-text-muted);}',
      ':where(.ctg-tbr-row--error){color:var(--ctg-danger);}',
      ':where(.ctg-tbr-row--more){color:var(--ctg-primary);cursor:pointer;}',
      ':where(.ctg-tbr-twisty){display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex:none;',
      'cursor:pointer;transition:transform .12s;}',
      ':where(.ctg-tbr-twisty--open){transform:rotate(90deg);}',
      ':where(.ctg-tbr-twisty .ctg-icon,.ctg-tbr-row .ctg-icon){width:16px;height:16px;}',
      ':where(.ctg-tbr-box){display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:none;',
      'border:1.5px solid currentColor;border-radius:3px;}',
      ':where(.ctg-tbr-box--on){color:var(--ctg-primary-text);background:var(--ctg-primary);border-color:var(--ctg-primary);}',
      ':where(.ctg-tbr-box .ctg-icon){width:12px;height:12px;}',
      ':where(.ctg-tbr-box--none){visibility:hidden;}',
      ':where(.ctg-tbr-name){min-width:0;overflow:hidden;text-overflow:ellipsis;}',
      ':where(.ctg-tbr-meta){margin-left:auto;padding-left:8px;font-size:11.5px;font-weight:400;color:var(--ctg-text-muted);}',
      ':where(.ctg-tbr-results){margin:0;padding:0 0 0 16px;font-size:12.5px;}',
      ':where(.ctg-tbr-footer-text){flex:1 1 100%;font-size:12px;color:var(--ctg-text-muted);}',
      // "Search all folders": the mode switch, the status line and two-line result rows
      ':where(.ctg-tbr-mode){flex:none;display:flex;align-items:center;gap:6px;padding:0 8px 2px;font-size:12px;}',
      ':where(.ctg-tbr-status){flex:none;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 8px;padding:0 8px 4px;',
      'font-size:11.5px;color:var(--ctg-text-muted);}',
      ':where(.ctg-tbr-status--error){color:var(--ctg-danger);}',
      ':where(.ctg-tbr-hit){display:flex;flex-direction:column;min-width:0;flex:1 1 auto;}',
      ':where(.ctg-tbr-hit .ctg-tbr-name){white-space:nowrap;}',
      ':where(.ctg-tbr-folder){min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;font-weight:400;',
      'color:var(--ctg-text-muted);}',
      '@media (pointer:coarse){:where(.ctg-tbr-row){min-height:40px;}:where(.ctg-pnl__ibtn){width:40px;height:40px;}',
      ':where(.ctg-sp-item){min-height:44px;}:where(.ctg-sp-tab){min-height:44px;}}',
      '@media (prefers-reduced-motion:reduce){:where(.ctg-tbr-twisty){transition:none;}}',
      // annotation editor
      ':where(.ctg-an-editor){width:min(380px,calc(100vw - 16px));}',
      ':where(.ctg-an-text){min-height:84px;resize:vertical;line-height:1.4;}',
      ':where(.ctg-an-pen){min-height:32px;display:flex;align-items:center;font-weight:600;overflow-wrap:anywhere;}',
      ':where(.ctg-an-swatches){display:flex;flex-wrap:wrap;gap:6px;}',
      ':where(.ctg-an-swatch){min-width:26px;height:26px;padding:0 6px;border:1px solid var(--ctg-border);border-radius:var(--ctg-radius);',
      'background:var(--ctg-surface);color:var(--ctg-text);font:inherit;font-size:12px;cursor:pointer;}',
      ':where(.ctg-an-swatch[aria-checked="true"]){box-shadow:0 0 0 2px var(--ctg-surface),0 0 0 4px var(--ctg-text);}',
      ':where(.ctg-an-swatch:focus-visible){outline:2px solid var(--ctg-focus);outline-offset:2px;}',
      ':where(.ctg-an-actions){display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:flex-end;width:100%;}',
      ':where(.ctg-an-delete){margin-right:auto;}',
      ':where(.ctg-an-confirm){margin-right:auto;font-weight:600;}',
      '@media (pointer:coarse){:where(.ctg-an-swatch){min-width:40px;height:40px;}}',
    ].join('');
    function ensureStyles() {
      try {
        NS.theme.ensureCommonStyles();
        NS.theme.ensureStyles('ctg-chart-panels-styles', PANEL_CSS, NS.loaded[PART]);
      } catch (e) { log.warn('styles', e); }
    }

    /* ========================================================================
     * SECTION 6 / small React pieces: icons, form controls, PanelFrame
     * ====================================================================== */
    var ICONS = {
      close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
      back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
      up: 'M7.41 15.41 12 10.83l4.59 4.58L18 14l-6-6-6 6z',
      down: 'M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z',
      chevron: 'M8.59 16.59 13.17 12 8.59 7.41 10 6l6 6-6 6z',
      edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
      trash: 'M6 19a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
      plus: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
      reload: 'M17.65 6.35A7.96 7.96 0 0 0 12 4a8 8 0 1 0 7.73 10h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
      grip: 'M9 4h2v2H9zm4 0h2v2h-2zM9 9h2v2H9zm4 0h2v2h-2zm-4 5h2v2H9zm4 0h2v2h-2zm-4 5h2v2H9zm4 0h2v2h-2z',
      check: 'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
      folder: 'M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z',
      provider: 'M4 5h16v4H4zm0 5h16v4H4zm0 5h16v4H4zM6 6.5h2v1H6zm0 5h2v1H6zm0 5h2v1H6z',
      udt: 'M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm13 0a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
      tag: 'M21.41 11.58 12.41 2.58A2 2 0 0 0 11 2H4a2 2 0 0 0-2 2v7c0 .55.22 1.05.59 1.42l9 9a2 2 0 0 0 2.82 0l7-7a2 2 0 0 0 0-2.84zM5.5 7A1.5 1.5 0 1 1 7 5.5 1.5 1.5 0 0 1 5.5 7z',
    };
    function Icon(name) {
      return h('svg', { className: 'ctg-icon', viewBox: '0 0 24 24', focusable: 'false', 'aria-hidden': 'true' },
        h('path', { d: ICONS[name] || '' }));
    }
    /** Icon-only button with aria-label + title. */
    function IconButton(p) {
      return h('button', {
        type: 'button', className: 'ctg-pnl__ibtn' + (p.className ? ' ' + p.className : ''), 'aria-label': p.label, title: p.label,
        disabled: !!p.disabled, onClick: p.onClick, 'data-ctg-act': p.act || undefined,
      }, Icon(p.icon));
    }
    function anchorOf(e) {
      var el = e && e.currentTarget;
      var r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
      return r ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null;
    }
    function ids(prefix) { return NS.util.uid(prefix); }

    /** Checkbox with its label (the whole row is the click target). */
    function Check(p) {
      return h('label', { className: 'ctg-pnl__check', title: p.title },
        h('input', { type: 'checkbox', checked: !!p.checked, disabled: !!p.disabled, onChange: function (e) { p.onChange(!!e.target.checked); },
          'data-ctg-field': p.field || undefined }),
        h('span', null, p.label));
    }
    /** <select> inside a labelled field; options [{value, label}] (values compared as strings). */
    function SelectField(p) {
      var id = p.id;
      var idx = -1;
      p.options.forEach(function (o, i) { if (String(o.value) === String(p.value)) idx = i; });
      return h(NS.ui.Field, { id: id, label: p.label, help: p.help },
        h('select', {
          id: id, className: 'ctg-select', value: idx < 0 ? '' : String(idx), disabled: !!p.disabled, 'data-ctg-field': p.field || undefined,
          onChange: function (e) { var o = p.options[Number(e.target.value)]; if (o) p.onChange(o.value); },
        }, (idx < 0 ? [h('option', { key: '_', value: '' }, '')] : []).concat(p.options.map(function (o, i) {
          return h('option', { key: i, value: String(i), disabled: !!o.disabled }, String(o.label));
        }))));
    }
    /** Text input that writes on every keystroke (the DraftStore debounces). */
    function TextField(p) {
      return h(NS.ui.Field, { id: p.id, label: p.label, help: p.help, error: p.error },
        h('input', {
          id: p.id, type: 'text', className: 'ctg-input', value: p.value == null ? '' : String(p.value), placeholder: p.placeholder,
          disabled: !!p.disabled, spellCheck: false, autoComplete: 'off', 'data-ctg-field': p.field || undefined,
          onChange: function (e) { p.onChange(e.target.value); },
        }));
    }

    /**
     * Text / number input with a local draft: shows what the user types, validates on every keystroke and
     * reports valid values through onCommit (live: `live` true) or only on blur / Enter (`live` false: tag
     * paths and axis names, which must not churn the gateway or the axis references per keystroke). Esc
     * reverts to the prop value. The draft follows the prop value whenever the field is not being edited.
     */
    class DraftInput extends RComponent {
      constructor(props) {
        super(props);
        this.state = { text: null, error: null };
        var self = this;
        this._change = function (e) { self._edit(e.target.value); };
        this._blur = function () { self._commit(); };
        this._key = function (e) {
          if (e.key === 'Enter') { e.preventDefault(); self._commit(); }
          else if (e.key === 'Escape' && self.state.text != null) { e.preventDefault(); e.stopPropagation(); self.setState({ text: null, error: null }); }
        };
      }
      _validate(text) { return this.props.validate ? this.props.validate(text) : { ok: true, value: text }; }
      _edit(text) {
        var r = this._validate(text);
        this.setState({ text: text, error: r.ok ? null : r.error });
        if (r.ok && this.props.live) this.props.onCommit(r.value);
      }
      _commit() {
        if (this.state.text == null) return;
        var r = this._validate(this.state.text);
        if (!r.ok) { this.setState({ error: r.error }); return; }
        if (!this.props.live) this.props.onCommit(r.value);
        this.setState({ text: null, error: r.error || null });
      }
      render() {
        var p = this.props;
        var shown = this.state.text != null ? this.state.text : (p.value == null ? '' : String(p.value));
        return h(NS.ui.Field, { id: p.id, label: p.label, help: p.help, error: this.state.error || p.error },
          h('input', {
            id: p.id, type: 'text', inputMode: p.numeric ? 'decimal' : undefined, className: 'ctg-input', value: shown,
            placeholder: p.placeholder, disabled: !!p.disabled, spellCheck: false, autoComplete: 'off', 'data-ctg-field': p.field || undefined,
            onChange: this._change, onBlur: this._blur, onKeyDown: this._key,
          }));
      }
    }
    /** Number field: DraftInput with parseNum bounds; live by default. */
    function NumberField(p) {
      return h(DraftInput, {
        id: p.id, label: p.label, value: p.value == null ? '' : p.value, numeric: true, live: p.live !== false, disabled: p.disabled,
        field: p.field, placeholder: p.placeholder, help: p.help,
        validate: function (s) { return parseNum(s, { min: p.min, max: p.max, integer: p.integer, nullable: p.nullable }); },
        onCommit: p.onCommit,
      });
    }
    /**
     * Colour: text (any CSS colour, validated with CSS.supports), the native picker, "Default" (clears the
     * explicit colour) and, when the ColorPicker panel (ctg-chart-tools.js) is registered, "More…" (opens it anchored).
     */
    function ColorField(p) {
      var id = p.id;
      var value = p.value || '';
      var kids = [
        h(DraftInput, {
          key: 'txt', id: id, label: p.label, value: value, live: true, field: p.field, disabled: p.disabled,
          placeholder: p.placeholder || t('sp.color.default'),
          validate: function (s) { return validColor(s) ? { ok: true, value: String(s).trim() } : { ok: false, error: t('sp.color.invalid') }; },
          onCommit: p.onChange,
        }),
        h('div', { key: 'row', className: 'ctg-sp-color' },
          h('input', {
            type: 'color', value: hexOf(value || p.fallback), disabled: !!p.disabled, 'aria-label': t('sp.color.picker') + ': ' + p.label,
            title: t('sp.color.picker'), onChange: function (e) { p.onChange(e.target.value); },
          }),
          h('button', { type: 'button', className: 'ctg-pnl__link', disabled: !!p.disabled || !value, onClick: function () { p.onChange(''); } },
            t('sp.color.default')),
          p.onMore ? h('button', { type: 'button', className: 'ctg-pnl__link', disabled: !!p.disabled, onClick: p.onMore }, t('sp.color.more')) : null),
      ];
      return h('div', { className: 'ctg-sp-colorfield', style: { marginBottom: '8px' } }, kids);
    }

    /**
     * Frame of a docked panel: role=dialog (non-modal, aria-labelledby the
     * title), Esc closes, key events stay inside (the chart's keyboard handling never sees them). Wide: a
     * side column of `width` px; narrow: a full overlay of the chart with "‹ Back". Narrow is the CHART's
     * decision: the frame is narrow exactly when the chart rendered it into its narrow-layout sheet (a
     * measurement of its own, with another threshold, could disagree near responsiveWidth and leave a 340 px
     * docked panel in the full-size sheet with two close controls). Focus moves
     * into the panel when the user opened it, and back to what opened it (`returnFocus`, recorded by the chart),
     * else its toolbar button, when it closes.
     */
    class PanelFrame extends RComponent {
      constructor(props) {
        super(props);
        this.state = { narrow: false };
        this.el = null;
        this.titleId = ids('ctg-pnl-title');
        var self = this;
        this._setEl = function (el) { self._attach(el); };
        this._key = function (e) {
          if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); self.props.onClose('escape'); }
          if (e.stopPropagation) e.stopPropagation();
        };
      }
      _attach(el) {
        if (el === this.el) return;
        if (this._off) { this._off(); this._off = null; }
        this.el = el;
        var root = el && el.closest ? el.closest('.ctg-chart') : null;
        this._chartRoot = root;
        if (this._alive) this._syncNarrow();
      }
      /** Narrow = rendered inside the chart's narrow-layout sheet (the chart moves the panel there and back). */
      _syncNarrow() {
        var inSheet = !!(this.el && this.el.closest && this.el.closest('.ctg-chart__sheet'));
        if (inSheet !== this.state.narrow) this.setState({ narrow: inSheet });
      }
      componentDidMount() {
        this._alive = true;
        this._syncNarrow();
        if (this.props.focusOnOpen && this.el && typeof document !== 'undefined') {
          var target = (this.el.querySelector && this.el.querySelector('[data-ctg-initial-focus]')) || this.el.querySelector && this.el.querySelector('h2');
          try { if (target) target.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
        }
      }
      componentWillUnmount() {
        this._alive = false;
        if (this._off) { this._off(); this._off = null; }
        // focus back to the toolbar button when the panel had it
        try {
          var active = typeof document !== 'undefined' ? document.activeElement : null;
          var inside = !active || active === document.body || (this.el && this.el.contains(active));
          // back to the control that opened the panel (the pen-table pencil, a More-menu entry's
          // menu button…) while it is still on the page; the toolbar button otherwise. The chart's closePanel
          // falls back to the More button or the plot when neither exists (narrow layout, settings button hidden).
          var rf = this.props.returnFocus;
          var target = rf && rf.isConnected !== false && typeof rf.focus === 'function' && !(this.el && this.el.contains && this.el.contains(rf))
            ? rf : this._chartRoot && this._chartRoot.querySelector('[data-ctg-panel="' + this.props.panel + '"]');
          if (inside && target && target.isConnected !== false) target.focus({ preventScroll: true });
        } catch (e) { /* ignore */ }
      }
      render() {
        var p = this.props;
        var narrow = this.state.narrow;
        // the dock is a flex COLUMN: only the width is set here (a flex-basis would size the height)
        var style = narrow ? {} : { width: p.width + 'px', maxWidth: '100%' };
        return h('div', {
          ref: this._setEl, className: 'ctg-pnl ctg-pnl--' + p.panel + (narrow ? ' ctg-pnl--overlay' : ''),
          role: 'dialog', 'aria-labelledby': this.titleId, 'data-ctg': p.dataCtg, 'data-ctg-narrow': narrow ? 'true' : 'false',
          style: style, onKeyDown: this._key,
        },
        h('div', { className: 'ctg-pnl__header' },
          narrow ? h(IconButton, { icon: 'back', label: t('cp.back'), act: 'back', onClick: function () { p.onClose('back'); } }) : null,
          h('h2', { id: this.titleId, className: 'ctg-pnl__title', tabIndex: -1 }, p.title),
          p.headerExtra || null,
          narrow ? null : h(IconButton, { icon: 'close', label: t('cp.close'), act: 'close', onClick: function () { p.onClose('close'); } })),
        p.children,
        p.footer ? h('div', { className: 'ctg-pnl__footer' }, p.footer) : null);
      }
    }
    /** Body notice (design mode, read-only, turned off). */
    function Notice(text, key) { return h('div', { key: key || 'notice', className: 'ctg-pnl__notice', role: 'note' }, text); }

    /* ========================================================================
     * SECTION 7 / SettingsPanel
     * ----------------------------------------------------------------------
     * Tabs per settingsPanel.tabs. Views: a list per tab, and an editor for one
     * pen / axis / plot. args from the chart: {source:'toolbar', anchorRect}
     * or (pen-table pencil) {tab:'pens', penKey}. Field edits are debounced 300 ms;
     * structural edits (add, delete, reorder, new axis / plot) are written at
     * once. onPensChange: add / remove / edit (edit once per pen per write).
     * Disabled entirely when !enabled, in design mode, or settingsPanel off.
     * The editor follows its item by identity (static pen: normKey(tagPath);
     * trend pen: tag path; axis: name), never by position, and every field edit
     * is a patch on that item (DraftStore), so other writers' changes to the
     * same root survive and an edit never lands on another pen.
     * ====================================================================== */
    var TABS = ['pens', 'axes', 'plots', 'columns'];
    /** What the settings panel shows from the chart: the props object (identity) + the rest as JSON. */
    function settingsSig(api) {
      return { props: api.props(), rest: JSON.stringify([api.capabilities(), api.limits().maxPens, api.axesInUse(),
        api.pens().map(function (vm) { return [vm.key, vm.tagPath, vm.label, vm.color, vm.status, vm.visible, vm.plot, vm.axisKey, vm.meta && vm.meta.engUnit]; })]) };
    }
    /** What the tag browser shows from the chart (see SettingsPanel.shouldComponentUpdate). */
    function browserSig(api) {
      var p = api.props();
      return JSON.stringify([api.capabilities(), addTarget(p), trendGroupOf(p), p.tagBrowser.rootPath, p.tagBrowser.width, p.toolbar.responsiveWidth, api.limits().maxPens,
        api.pens().map(function (vm) { return vm.tagPath; }), p.pens.map(function (x) { return x.tagPath; })]);
    }
    class SettingsPanel extends RComponent {
      constructor(props) {
        super(props);
        var self = this;
        // plotRef: the PlotRef of the open plot editor (SECTION 2b), followed by identity, not by position
        this.state = { tab: null, view: 'list', sel: null, axis: -1, axisName: null, plotRef: null, confirm: null, status: null, addText: '',
          addError: null, dragFrom: -1, dragOver: -1 };
        // all three arguments: an edit attempted but not written (changed and reverted inside the debounce) must
        // clear its pending "edit" event too (a 2-argument wrapper would drop `attempted`)
        this.drafts = new DraftStore(props.api, { onFlush: function (ok, written, attempted) { self._flushed(ok, written, attempted); } });
        this._edited = {};               // tagPath|source -> true, fired as onPensChange 'edit' after the next write
        this._opSeq = 0;                 // unique ids of structural operations (never replaced by a later one)
        this.idp = ids('ctg-sp');
        this._close = function (why) { self.drafts.flush(); self.props.close(why); };
        this._tabKey = function (e) { self._onTabKey(e); };
        this._applyArgs(props.args, true);
      }
      componentDidMount() {
        this._alive = true;
        ensureStyles();
        // the chart unmounts before this panel; it flushes our drafts while its API still writes
        var self = this;
        var api = this.props.api;
        this._offFlush = api && typeof api._flushOnUnmount === 'function' ? api._flushOnUnmount(function () { self.drafts.flush(); }) : null;
      }
      componentDidUpdate(prev) { if (prev.args !== this.props.args) this._applyArgs(this.props.args, false); }
      /**
       * The chart renders its open panels on every chart render (each live tick). The panel re-renders only
       * when something it shows changed: its own state, the args, the props object (a new one per prop
       * change), the pens' look / status, the capabilities or the axes in use. forceUpdate() (after a draft
       * edit) bypasses this.
       */
      shouldComponentUpdate(np, ns) {
        if (ns !== this.state || np.args !== this.props.args || np.api !== this.props.api) return true;
        var sig = settingsSig(np.api);
        return sig.props !== this._sig.props || sig.rest !== this._sig.rest;
      }
      componentWillUnmount() {
        this._alive = false;
        if (this._offFlush) { this._offFlush(); this._offFlush = null; }
        this.drafts.flush();
      }
      set(patch) { if (this._alive !== false) this.setState(patch); }

      /** Opens the tab / pen the chart asked for (pencil: {tab:'pens', penKey}). */
      _applyArgs(args, initial) {
        var a = args || {};
        var tabs = this._tabs();
        var tab = typeof a.tab === 'string' && tabs.indexOf(a.tab) >= 0 ? a.tab : (initial ? tabs[0] || null : this.state.tab);
        var patch = { tab: tab };
        if (typeof a.penKey === 'string' && a.penKey) { patch.tab = tabs.indexOf('pens') >= 0 ? 'pens' : tab; patch.view = 'pen'; patch.sel = this._selFromKey(a.penKey); }
        else if (!initial && a.tab) patch.view = 'list';
        if (initial) Object.assign(this.state, patch); else this.set(patch);
      }
      _selFromKey(key) {
        if (/^p:\d+$/.test(key)) {
          var raw = Number(key.slice(2));
          var pens = this.props.api.props().pens;
          for (var i = 0; i < pens.length; i++) if (pens[i].index === raw) return this._penSel(pens[i].tagPath, i);
          return pens[raw] ? this._penSel(pens[raw].tagPath, raw) : null;
        }
        var vm = this.props.api.pens().filter(function (x) { return x.key === key; })[0];
        return vm ? this._trendSel(vm.tagPath) : null;
      }
      /**
       * A static-pen selection: identity = normKey(tagPath); pos = hint; uid keys the editor (fresh local drafts).
       * next = the identity a pending tag-path edit gives it: it becomes `key` only once that write was made, and is
       * dropped when it was refused, so the editor never loses a pen that keeps its old path.
       */
      _penSel(tagPath, pos) {
        this._uid = (this._uid || 0) + 1;
        return { source: 'pens', key: normKey(tagPath), next: null, pos: pos, uid: this._uid };
      }
      /** The identity the selected static pen has in the draft: the pending new tag path, else its own. */
      _selKey(sel) { return sel.next || sel.key; }
      _trendSel(tagPath) {
        this._uid = (this._uid || 0) + 1;
        return { source: 'trend', tagPath: tagPath, uid: this._uid };
      }
      /** Current position of the selected static pen in `pens` (the draft), or -1 when it is gone. */
      _posOf(sel, pens) {
        var list = pens || this.drafts.get('pens');
        var i = resolvePen(list, this._selKey(sel), sel.pos);
        return i < 0 && sel.next ? resolvePen(list, sel.key, sel.pos) : i;
      }
      _tabs() {
        var tabs = this.props.api.capabilities().settingsPanel.tabs || {};
        return TABS.filter(function (k) { return tabs[k] !== false; });
      }
      _flushed(ok, written, attempted) {
        var self = this;
        this._settleSel(written, attempted);
        if (!ok) {
          // nothing (or not everything) was written: no "edit" events for it; the next successful write fires them
          this.set({ status: { tone: 'error', text: t('cp.saveFailed') } });
          return;
        }
        // one "edit" per pen per write, only for a root that was written and a pen still on it (a patch on a pen
        // removed meanwhile changes nothing and fires nothing)
        var pens = written.indexOf('pens') >= 0 ? this.drafts.get('pens') : null;
        var trend = written.indexOf('trendPens') >= 0;
        Object.keys(this._edited).forEach(function (k) {
          var i = k.lastIndexOf('|');
          var tagPath = k.slice(0, i), source = k.slice(i + 1);
          var root = source === 'pens' ? 'pens' : 'trendPens';
          if ((attempted || written).indexOf(root) < 0) return;
          delete self._edited[k];
          if (source === 'pens' ? pens && resolvePen(pens, normKey(tagPath)) >= 0 : trend) {
            self.props.api.fireEvent('onPensChange', { action: 'edit', tagPath: tagPath, source: source });
          }
        });
      }
      /**
       * After a flush: a pending tag-path edit of the selected pen becomes its identity once `pens` was written; when
       * the write was attempted but not made (refused, or the pen is gone) the old identity stays.
       */
      _settleSel(written, attempted) {
        var sel = this.state.sel;
        if (!sel || sel.source !== 'pens' || !sel.next || (attempted || written).indexOf('pens') < 0) return;
        var made = written.indexOf('pens') >= 0;
        var next = made ? Object.assign({}, sel, { key: sel.next, next: null }) : Object.assign({}, sel, { next: null });
        this.state.sel = next;                         // synchronous: the next render resolves with it
        this.set({ sel: next });
      }
      _state() {
        var d = this.drafts;
        return { pens: d.get('pens'), axes: d.get('axes'), plots: d.get('plots'), trendPens: d.get('trendPens'), penTable: d.get('penTable') };
      }
      /**
       * Structural edits (add, delete, reorder, rename, new axis / plot): one operation per root ({root: op}, SECTION
       * 2b), queued after the pending field edits and written at once (one ChartApi.patch per root). Returns false
       * when refused.
       */
      _writeAll(ops, id) {
        var self = this;
        Object.keys(ops).forEach(function (k) { self.drafts.edit(k, (id || 'struct') + '|' + k + '|' + (++self._opSeq), ops[k]); });
        var ok = this.drafts.flush();
        this.forceUpdate();
        return ok;
      }

      // ---- static pen edits -------------------------------------------------------------------------
      /** pens[the selected pen][path] = value, as a patch on that pen (by tag path) applied at write time. */
      _setPen(sel, path, value, immediate) {
        var pens = this.drafts.get('pens');
        var pos = this._posOf(sel, pens);
        if (pos < 0) return;
        var key = normKey(pens[pos].tagPath);               // the pen's identity in the draft (pending path edits applied)
        var isPath = path.length === 1 && path[0] === 'tagPath';
        this._edited[(isPath ? value : pens[pos].tagPath) + '|pens'] = true;
        // the pen is found by its tag path where the operation runs (draft or raw root); a pen gone meanwhile: no change
        this.drafts.edit('pens', 'p|' + key + '|' + path.join('.'), penFieldOp(key, sel.pos, path, value), immediate);
        // a new tag path is the pen's new identity once the write is made (_settleSel); until then both resolve
        if (isPath) {
          var next = Object.assign({}, sel, { next: normKey(value) === sel.key ? null : normKey(value), pos: pos });
          this.state.sel = next;
          this.set({ sel: next });
        }
        this.forceUpdate();
      }
      _setTrend(tagPath, path, value, immediate) {
        this._edited[tagPath + '|trend'] = true;
        this.drafts.edit('trendPens', 't|' + normKey(tagPath) + '|' + path.join('.'), overrideFieldOp(tagPath, path, value), immediate);
        this.forceUpdate();
      }
      /**
       * display[field] = v. Static pens patch the field; trend pens write the whole EFFECTIVE display (override
       * merged over trendPens.defaults, see effectiveOverride) computed at write time.
       */
      _setDisplay(sel, field, v) {
        var path = Array.isArray(field) ? field : [field];         // a path for display.states.*
        if (sel.source === 'pens') { this._setPen(sel, ['display'].concat(path), v); return; }
        var tagPath = sel.tagPath;
        this._edited[tagPath + '|trend'] = true;
        this.drafts.edit('trendPens', 't|' + normKey(tagPath) + '|display.' + path.join('.'), overrideDisplayOp(tagPath, path, v));
        this.forceUpdate();
      }
      /** Field setter for the selected pen (static: that pen by tag path; trend: its override). */
      _setter(sel) {
        var self = this;
        return function (path, value, immediate) {
          if (sel.source === 'pens') self._setPen(sel, path, value, immediate);
          else self._setTrend(sel.tagPath, path, value, immediate);
        };
      }
      _movePen(from, to) {
        var pens = this.drafts.get('pens');
        if (to < 0 || to >= pens.length || from === to || !pens[from] || !pens[to]) return;
        this._writeOk(this._writeAll({ pens: movePenOp(normKey(pens[from].tagPath), from, normKey(pens[to].tagPath), to) }));
      }
      _addPen() {
        var api = this.props.api;
        var path = String(this.state.addText || '').trim();
        var pens = this.drafts.get('pens');
        var err = addPenError(path, {
          existing: pens.map(function (p) { return p.tagPath; }), scope: api.capabilities().readScope,
          max: api.limits().maxPens, count: api.pens().length,
        });
        if (err) { this.set({ addError: err }); return; }
        if (!this._writeOk(this._writeAll({ pens: addPensOp([path]) }))) return;
        api.fireEvent('onPensChange', { action: 'add', tagPath: path, source: 'pens' });
        var msg = t('sp.add.added', { name: NS.util.shortTagName(path) || path });
        NS.a11y.announce(msg);
        this.set({ addText: '', addError: null, status: { tone: 'ok', text: msg } });
      }
      _writeOk(ok) {
        if (ok === false) { this.set({ status: { tone: 'error', text: t('cp.saveFailed') } }); return false; }
        return true;
      }
      /** Deletes the selected static pen (resolved by tag path when the confirm is accepted). */
      _deletePen(sel) {
        var pens = this.drafts.get('pens');
        var pos = this._posOf(sel, pens);
        if (pos < 0) { this.set({ view: 'list', sel: null, confirm: null }); return; }
        var pen = pens[pos];
        if (!this._writeOk(this._writeAll({ pens: deletePenOp(normKey(pen.tagPath), pos) }))) return;
        this.props.api.fireEvent('onPensChange', { action: 'remove', tagPath: pen.tagPath, source: 'pens' });
        this.set({ view: 'list', sel: null, confirm: null });
      }
      _removeTrend(tagPath) {
        var self = this;
        var api = this.props.api;
        this.set({ confirm: null, status: { tone: 'busy', text: t('tb.loading') } });
        api.request('chart.trendRemove', { tagPath: tagPath }).then(function (res) {
          // the event does not touch panel state: fired even when the panel closed meanwhile
          if (res && res.ok) api.fireEvent('onPensChange', { action: 'remove', tagPath: tagPath, source: 'trend' });
          if (!self._alive) return;
          if (res && res.ok) self.set({ view: 'list', sel: null, status: null });
          else self.set({ status: { tone: 'error', text: errText(res && res.error) } });
        });
      }
      _clearTrend(rows) {
        var self = this;
        var api = this.props.api;
        this.set({ confirm: null, status: { tone: 'busy', text: t('tb.loading') } });
        api.request('chart.trendClear', {}).then(function (res) {
          if (res && res.ok) rows.forEach(function (r) { api.fireEvent('onPensChange', { action: 'remove', tagPath: r.vm.tagPath, source: 'trend' }); });
          if (!self._alive) return;
          if (res && res.ok) {
            NS.a11y.announce(t('sp.pens.clearDone'));
            self.set({ status: { tone: 'ok', text: t('sp.pens.clearDone') } });
          } else self.set({ status: { tone: 'error', text: errText(res && res.error) } });
        });
      }
      /** The plot the selected pen is on (draft). */
      _plotOf(sel, s) {
        if (sel.source !== 'pens') return effectiveOverride(s.trendPens, sel.tagPath).plot || 0;
        var pos = this._posOf(sel, s.pens);
        return pos >= 0 ? s.pens[pos].plot || 0 : 0;
      }
      /** "New axis…" for the selected pen: a named axis on the free side, assigned to the pen. */
      _newAxisFor(sel) {
        var s = this._state();
        var r = addAxis(s.axes, this.props.api.axesInUse(), this._plotOf(sel, s));
        var added = r.axes[r.axes.length - 1];
        this.drafts.edit('axes', 'a+|' + r.name, addAxisOp(r.name, added.position));
        this._setter(sel)(['axis'], r.name, true);
        this.forceUpdate();
      }
      _newPlotFor(sel) {
        var r = addPlot(this.drafts.get('plots'));
        if (r.index < 0) { this.set({ status: { tone: 'error', text: t('sp.plots.max', { max: MAX_PLOTS }) } }); return; }
        this.drafts.edit('plots', 'pl+|' + (++this._opSeq), addPlotOp());
        this._setter(sel)(['plot'], r.index, true);
        this.forceUpdate();
      }

      // ---- keyboard: tabs (APG tabs, automatic activation) --------------------------------------
      _onTabKey(e) {
        var tabs = this._tabs();
        var i = tabs.indexOf(this.state.tab);
        var n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
        if (n == null || !tabs.length) return;
        e.preventDefault();
        n = (n + tabs.length) % tabs.length;
        this.set({ tab: tabs[n], view: 'list' });
        var btn = e.currentTarget && e.currentTarget.querySelector && e.currentTarget.querySelector('[data-ctg-tab="' + tabs[n] + '"]');
        if (btn) btn.focus();
      }

      render() {
        var self = this;
        var api = this.props.api;
        this._sig = settingsSig(api);
        var caps = api.capabilities();
        var props = api.props();
        var frame = function (body, footer) {
          return h(PanelFrame, {
            panel: 'settings', dataCtg: 'settings', title: t('sp.title'), width: 340, responsiveWidth: props.toolbar.responsiveWidth,
            onClose: self._close, focusOnOpen: (self.props.args || {}).source !== 'openOnStart', footer: footer,
            returnFocus: (self.props.args || {}).returnFocus || null,
          }, body);
        };
        var done = h(NS.ui.Button, { key: 'done', kind: 'primary', onClick: function () { self._close('done'); }, 'data-ctg-act': 'done' }, t('cp.done'));
        if (caps.designMode) return frame(h('div', { className: 'ctg-pnl__body' }, Notice(t('cp.designMode'))), done);
        if (!caps.enabled) return frame(h('div', { className: 'ctg-pnl__body' }, Notice(t('cp.readOnly'))), done);
        if (!caps.settingsPanel.enabled) return frame(h('div', { className: 'ctg-pnl__body' }, Notice(t('sp.off'))), done);
        var tabs = this._tabs();
        if (!tabs.length) return frame(h('div', { className: 'ctg-pnl__body' }, Notice(t('sp.noTabs'))), done);
        var tab = tabs.indexOf(this.state.tab) >= 0 ? this.state.tab : tabs[0];
        var tabIds = {};
        tabs.forEach(function (k) { tabIds[k] = self.idp + '-tab-' + k; });
        var tablist = h('div', { key: 'tabs', className: 'ctg-sp-tabs', role: 'tablist', 'aria-label': t('sp.tabs'), onKeyDown: this._tabKey },
          tabs.map(function (k) {
            var on = k === tab;
            return h('button', {
              key: k, id: tabIds[k], type: 'button', role: 'tab', className: 'ctg-sp-tab', 'aria-selected': on ? 'true' : 'false',
              'aria-controls': self.idp + '-panel', tabIndex: on ? 0 : -1, 'data-ctg-tab': k, 'data-ctg-initial-focus': on ? '1' : undefined,
              onClick: function () { self.set({ tab: k, view: 'list', status: null }); },
            }, t('sp.tab.' + k));
          }));
        var s = this._state();
        // a throw here lands in the chart's per-panel error boundary ("Panel error" + "Close panel")
        var content = tab === 'pens' ? this._renderPens(s, props, caps) : tab === 'axes' ? this._renderAxes(s, props)
          : tab === 'plots' ? this._renderPlots(s, props) : this._renderColumns(s);
        var st = this.state.status;
        var body = [tablist, h('div', {
          key: 'panel', id: this.idp + '-panel', role: 'tabpanel', 'aria-labelledby': tabIds[tab], className: 'ctg-pnl__body',
          'data-ctg-tabpanel': tab,
        }, content)];
        var footer = [
          h('div', { key: 'st', className: 'ctg-pnl__status' + (st && st.tone === 'error' ? ' ctg-pnl__error' : ''), role: 'status' }, st ? st.text : ''),
          h('div', { key: 'sp', className: 'ctg-pnl__spacer' }),
          done,
        ];
        return h(React.Fragment || 'div', null, frame(body, footer), this._renderConfirm());
      }

      _renderConfirm() {
        var c = this.state.confirm;
        if (!c) return null;
        var self = this;
        return h(NS.ui.Confirm, {
          key: 'confirm', anchorRect: c.anchorRect, text: c.text, confirmLabel: c.confirmLabel, tone: 'danger',
          onConfirm: function () { c.onConfirm(); }, onCancel: function () { self.set({ confirm: null }); },
        });
      }
      _ask(e, text, label, fn) {
        this.set({ confirm: { anchorRect: anchorOf(e), text: text, confirmLabel: label, onConfirm: fn } });
      }

      // ---- Pens tab ------------------------------------------------------------------------------
      _renderPens(s, props, caps) {
        var api = this.props.api;
        var vms = api.pens();
        var rawIndex = this.drafts.has('pens') || this.drafts.written.pens ? null : props.pens.map(function (p) { return p.index; });
        var rows = penRows(s.pens, vms, rawIndex);
        if (this.state.view === 'pen' && this.state.sel) return this._renderPenEditor(s, props, caps, rows);
        var self = this;
        var out = [];
        out.push(h('div', { key: 'h1', className: 'ctg-pnl__section' }, t('sp.pens.static', { n: rows.staticRows.length })));
        if (!rows.staticRows.length) out.push(h('p', { key: 'none', className: 'ctg-pnl__muted' }, t('sp.pens.none')));
        else {
          out.push(h('ul', { key: 'sl', className: 'ctg-sp-list', 'data-ctg': 'settings-pens' }, rows.staticRows.map(function (r, i) {
            var color = (r.vm && r.vm.color) || NS.props.color(r.pen.color) || null;
            var cls = 'ctg-sp-item' + (r.pen.enabled ? '' : ' ctg-sp-item--off') + (self.state.dragOver === i && self.state.dragFrom !== i ? ' ctg-sp-item--drop' : '');
            var status = r.vm && r.vm.status !== 'ok' && r.vm.status !== 'loading' ? r.vm.status : null;
            return h('li', {
              key: 'p' + i, className: cls, 'data-ctg-pen': r.key, draggable: true, title: r.pen.tagPath,
              onDragStart: function (e) { self.set({ dragFrom: i }); try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); } catch (x) { /* ignore */ } },
              onDragOver: function (e) { if (self.state.dragFrom >= 0) { e.preventDefault(); if (self.state.dragOver !== i) self.set({ dragOver: i }); } },
              onDragEnd: function () { self.set({ dragFrom: -1, dragOver: -1 }); },
              onDrop: function (e) { e.preventDefault(); var from = self.state.dragFrom; self.set({ dragFrom: -1, dragOver: -1 }); if (from >= 0) self._movePen(from, i); },
            },
            h('span', { className: 'ctg-sp-grip', title: t('sp.pens.drag'), 'aria-hidden': 'true' }, Icon('grip')),
            h('span', { className: 'ctg-sp-dot', style: color ? { '--ctg-pen': color } : undefined, 'aria-hidden': 'true' }),
            h('button', {
              type: 'button', className: 'ctg-sp-name', 'aria-label': t('sp.pens.edit', { name: r.label }), 'data-ctg-act': 'edit-pen',
              onClick: function () { self.set({ view: 'pen', sel: self._penSel(r.pen.tagPath, i), status: null }); },
            }, r.label),
            !r.pen.enabled ? h('span', { className: 'ctg-sp-chip' }, t('sp.pens.disabled')) : null,
            status ? h('span', { className: 'ctg-sp-chip ctg-sp-chip--error', title: api.t('chart.status.' + status) }, api.t('chart.status.' + status)) : null,
            h(IconButton, { icon: 'up', label: t('sp.pens.up', { name: r.label }), act: 'up', disabled: i === 0, onClick: function () { self._movePen(i, i - 1); } }),
            h(IconButton, { icon: 'down', label: t('sp.pens.down', { name: r.label }), act: 'down', disabled: i === rows.staticRows.length - 1,
              onClick: function () { self._movePen(i, i + 1); } }));
          })));
        }
        if (props.settingsPanel.allowAddPen) out.push(this._renderAddPen());
        var group = trendGroupOf(props);
        if (group != null) {
          var te = caps.trendEdit;
          out.push(h('div', { key: 'h2', className: 'ctg-pnl__section ctg-pnl__row' },
            h('span', { style: { flex: '1 1 auto' } }, t('sp.pens.trend', { group: group, n: rows.trendRows.length })),
            rows.trendRows.length ? h('button', {
              type: 'button', className: 'ctg-pnl__link', disabled: !te.allowed, 'data-ctg-act': 'clear-trend',
              title: te.allowed ? undefined : errText(te.reason || 'ACTION_DISABLED'),
              onClick: function (e) {
                self._ask(e, t('sp.pens.clearConfirm', { n: rows.trendRows.length, group: group }), t('sp.pens.clear'),
                  function () { self._clearTrend(rows.trendRows); });
              },
            }, t('sp.pens.clear')) : null));
          if (!rows.trendRows.length) out.push(h('p', { key: 'tnone', className: 'ctg-pnl__muted' }, t('sp.pens.trendNone')));
          else {
            out.push(h('ul', { key: 'tl', className: 'ctg-sp-list', 'data-ctg': 'settings-trend' }, rows.trendRows.map(function (r) {
              var status = r.vm.status !== 'ok' && r.vm.status !== 'loading' ? r.vm.status : null;
              return h('li', { key: r.key, className: 'ctg-sp-item', 'data-ctg-pen': r.key, title: r.vm.tagPath },
                h('span', { className: 'ctg-sp-dot', style: r.vm.color ? { '--ctg-pen': r.vm.color } : undefined, 'aria-hidden': 'true' }),
                h('button', {
                  type: 'button', className: 'ctg-sp-name', 'aria-label': t('sp.pens.edit', { name: r.label }), 'data-ctg-act': 'edit-pen',
                  onClick: function () { self.set({ view: 'pen', sel: self._trendSel(r.vm.tagPath), status: null }); },
                }, r.label),
                status ? h('span', { className: 'ctg-sp-chip ctg-sp-chip--error' }, api.t('chart.status.' + status)) : null);
            })));
          }
        }
        return out;
      }
      _renderAddPen() {
        var self = this;
        var id = this.idp + '-add';
        var submit = function (e) { if (e && e.preventDefault) e.preventDefault(); self._addPen(); };
        return h('form', { key: 'add', onSubmit: submit, 'data-ctg': 'settings-add' },
          h(NS.ui.Field, { id: id, label: t('sp.add.label'), help: t('sp.add.help'), error: this.state.addError },
            h('input', {
              id: id, type: 'text', className: 'ctg-input', value: this.state.addText, placeholder: t('sp.add.placeholder'),
              spellCheck: false, autoComplete: 'off', onChange: function (e) { self.set({ addText: e.target.value, addError: null }); },
            })),
          h('div', { className: 'ctg-pnl__row', style: { marginBottom: '8px' } },
            h(NS.ui.Button, { type: 'submit', kind: 'secondary', 'data-ctg-act': 'add-pen' }, Icon('plus'), t('sp.add.button'))));
      }

      _renderPenEditor(s, props, caps, rows) {
        var self = this;
        var api = this.props.api;
        var sel = this.state.sel;
        var back = h('div', { key: 'sub', className: 'ctg-sp-subhead' },
          h('button', { type: 'button', className: 'ctg-pnl__link', 'data-ctg-act': 'back', onClick: function () { self.set({ view: 'list', sel: null, status: null }); } },
            '\u2039 ' + t('sp.pen.back')));
        var trend = sel.source === 'trend';
        var row = null, vm = null, cfg;
        if (trend) {
          row = rows.trendRows.filter(function (r) { return normKey(r.vm.tagPath) === normKey(sel.tagPath); })[0] || null;
          vm = row ? row.vm : null;
          cfg = effectiveOverride(s.trendPens, sel.tagPath);
        } else {
          // by identity, never by position: another writer may have reordered / removed pens
          var pos = this._posOf(sel, s.pens);
          row = pos >= 0 ? rows.staticRows[pos] || null : null;
          vm = row ? row.vm : null;
          cfg = row ? row.pen : null;
        }
        if (!row || !cfg) return [back, h('p', { key: 'gone', className: 'ctg-pnl__muted' }, t('sp.pen.gone'))];
        var set = this._setter(sel);
        // keyed by the selection (not the position): another pen never inherits this editor's local field drafts
        var selId = (trend ? 't-' : 'p-') + (sel.uid || 0);
        var id = function (k) { return self.idp + '-pen-' + k; };
        var display = cfg.display;
        var type = display.type;
        // display edits write the whole display object (trend pens: the effective one, see effectiveOverride)
        var setDisp = function (field, v) { self._setDisplay(sel, field, v); };
        var names = axisNames(s.axes);
        var axisOpts = [{ value: '', label: t('sp.pen.axisAuto') }].concat(names.map(function (n) { return { value: n, label: n }; }));
        if (cfg.axis && names.indexOf(cfg.axis) < 0) axisOpts.push({ value: cfg.axis, label: cfg.axis });
        axisOpts.push({ value: '\u0000new', label: t('sp.pen.axisNew') });
        var plotCount = Math.max(1, s.plots.length);
        var plotOpts = [];
        for (var i = 0; i < plotCount; i++) plotOpts.push({ value: i, label: t('sp.pen.plotN', { n: i + 1 }) });
        // a trend pen whose trendPens.defaults set an axis / a plot / a style cannot be put back on
        // the automatic axis, plot 1 or the built-in style (an override stores '' / 0 / the built-in display, which
        // reads as "not set" and the defaults apply): those choices are disabled and the hint says why, instead of
        // writing an override the chart ignores.
        var lockedBy = trend ? defaultsLocks(s.trendPens) : null;
        if (lockedBy && lockedBy.axis) axisOpts[0] = { value: '', label: t('sp.pen.axisAuto'), disabled: true };
        if (lockedBy && lockedBy.plot) plotOpts[0] = { value: 0, label: t('sp.pen.plotN', { n: 1 }), disabled: true };
        if (plotCount < MAX_PLOTS) plotOpts.push({ value: -1, label: t('sp.pen.plotNew') });
        var dn = dashName(display.dash);
        var dashOpts = ['solid', 'dashed', 'dotted'].map(function (k) { return { value: k, label: t('sp.dash.' + k) }; });
        if (dn === 'custom') dashOpts.push({ value: 'custom', label: t('sp.dash.custom', { v: display.dash.join(',') }) });
        var label = row.label;
        var autoName = vm ? vm.label : NS.util.shortTagName(cfg.tagPath || sel.tagPath);
        var colorPanel = NS.chart.panels.get('color') && vm;
        var out = [back, h('div', { key: 'name', className: 'ctg-sp-subhead' },
          h('span', { className: 'ctg-sp-dot', style: vm && vm.color ? { '--ctg-pen': vm.color } : undefined, 'aria-hidden': 'true' }),
          h('span', { className: 'ctg-sp-subhead__name', title: cfg.tagPath || sel.tagPath }, label))];
        if (trend) out.push(h('p', { key: 'th', className: 'ctg-pnl__muted' }, t('sp.pen.trendHint')));
        if (lockedBy && (lockedBy.axis || lockedBy.plot || lockedBy.display)) {
          out.push(h('p', { key: 'tdl', className: 'ctg-pnl__muted', 'data-ctg': 'trend-defaults-lock' }, t('sp.pen.defaultsLock')));
        }
        if (vm && vm.status !== 'ok' && vm.status !== 'loading') {
          out.push(h('p', { key: 'stat', className: 'ctg-pnl__error' }, t('sp.pen.status', { text: api.t('chart.status.' + vm.status) })));
        }
        out.push(h(TextField, { key: 'nm', id: id('name'), label: t('sp.pen.name'), value: cfg.name, field: 'name',
          placeholder: t('sp.pen.namePh', { auto: autoName }), onChange: function (v) { set(['name'], v); } }));
        if (!trend && props.settingsPanel.allowEditTagPath) {
          out.push(h(DraftInput, {
            key: 'tp', id: id('tagPath'), label: t('sp.pen.tagPath'), value: cfg.tagPath, field: 'tagPath', live: false,
            validate: function (v) {
              var p = String(v).trim();
              if (normKey(p) === normKey(cfg.tagPath)) return { ok: true, value: p };
              var others = s.pens.filter(function (x, j) { return j !== pos; }).map(function (x) { return x.tagPath; });
              var err = addPenError(p, { existing: others, scope: caps.readScope });
              return err ? { ok: false, error: err } : { ok: true, value: p };
            },
            onCommit: function (v) { if (v !== cfg.tagPath) set(['tagPath'], v); },
          }));
        }
        if (!trend) out.push(h(Check, { key: 'en', label: t('sp.pen.enabled'), checked: cfg.enabled, field: 'enabled', onChange: function (v) { set(['enabled'], v); } }));
        out.push(h(Check, { key: 'vis', label: t('sp.pen.visible'), checked: cfg.visible, field: 'visible', onChange: function (v) { set(['visible'], v); } }));
        out.push(h('div', { key: 'ap', className: 'ctg-pnl__grid' },
          h(SelectField, { id: id('axis'), label: t('sp.pen.axis'), value: cfg.axis, options: axisOpts, field: 'axis',
            onChange: function (v) { if (v === '\u0000new') self._newAxisFor(sel); else set(['axis'], v); } }),
          h(SelectField, { id: id('plot'), label: t('sp.pen.plot'), value: Math.min(cfg.plot, plotCount - 1), options: plotOpts, field: 'plot',
            onChange: function (v) { if (v === -1) self._newPlotFor(sel); else set(['plot'], v); } })));
        out.push(h('div', { key: 'sh', className: 'ctg-pnl__section' }, t('sp.pen.style')));
        out.push(h('div', { key: 'ti', className: 'ctg-pnl__grid' },
          h(SelectField, { id: id('type'), label: t('sp.pen.type'), value: type, field: 'type',
            options: DISPLAY_TYPES.map(function (k) { return { value: k, label: t('sp.pen.type.' + k) }; }),
            onChange: function (v) { setDisp('type', v); } }),
          type === 'line' || type === 'area' ? h(SelectField, { id: id('interp'), label: t('sp.pen.interp'), value: display.interpolation, field: 'interpolation',
            options: INTERPOLATIONS.map(function (k) { return { value: k, label: t('sp.pen.interp.' + k) }; }),
            help: display.interpolation !== 'linear' && display.interpolation !== 'spline' && display.interpolation.indexOf('step') !== 0
              ? t('sp.pen.interpHelp') : undefined,
            onChange: function (v) { setDisp('interpolation', v); } }) : h('div', null)));
        out.push(h('div', { key: 'wd', className: 'ctg-pnl__grid' },
          h(NumberField, { id: id('width'), label: t('sp.pen.width'), value: display.width, min: 0.5, max: 8, field: 'width',
            onCommit: function (v) { setDisp('width', v); } }),
          h(SelectField, { id: id('dash'), label: t('sp.pen.dash'), value: dn, options: dashOpts, field: 'dash',
            onChange: function (v) { if (v !== 'custom') setDisp('dash', DASHES[v].slice()); } })));
        if (type === 'area' || type === 'bar' || type === 'scatter') {
          out.push(h('div', { key: 'fo', className: 'ctg-pnl__grid' },
            type !== 'scatter' ? h(NumberField, { id: id('fill'), label: t('sp.pen.fill'), value: display.fillOpacity, min: 0, max: 1, field: 'fillOpacity',
              onCommit: function (v) { setDisp('fillOpacity', v); } }) : h('div', null),
            type === 'scatter' ? h(NumberField, { id: id('radius'), label: t('sp.pen.radius'), value: display.radius, min: 1, max: 10, field: 'radius',
              onCommit: function (v) { setDisp('radius', v); } }) : h('div', null)));
        }
        out.push(h(Check, { key: 'bl', label: t('sp.pen.breakLine'), checked: display.breakLine, field: 'breakLine', onChange: function (v) { setDisp('breakLine', v); } }));
        out.push(h(ColorField, {
          key: 'col', id: id('color'), label: t('sp.pen.color'), value: cfg.color, fallback: vm && vm.color, field: 'color',
          onChange: function (v) { set(['color'], v); },
          onMore: colorPanel ? function (e) { self.drafts.flush(); api.panels.open('color', { penKey: vm.key, anchorRect: anchorOf(e), source: 'settings' }); } : null,
        }));
        this._renderStates(out, display, vm, id, setDisp);
        if (!trend) {
          out.push(h(SelectField, { key: 'agg', id: id('agg'), label: t('sp.pen.aggregation'), value: cfg.aggregation, field: 'aggregation',
            options: [{ value: 'default', label: t('sp.pen.aggDefault', { agg: props.query.aggregation }) }].concat(AGGREGATIONS.map(function (a) { return { value: a, label: a }; })),
            onChange: function (v) { set(['aggregation'], v); } }));
        }
        var metaUnits = vm && vm.meta && vm.meta.engUnit ? vm.meta.engUnit : '';
        out.push(h('div', { key: 'uf', className: 'ctg-pnl__grid' },
          h(TextField, { id: id('units'), label: t('sp.pen.units'), value: cfg.units, field: 'units', placeholder: metaUnits ? t('sp.pen.unitsPh', { units: metaUnits }) : '',
            onChange: function (v) { set(['units'], v); } }),
          h(TextField, { id: id('format'), label: t('sp.pen.format'), value: cfg.format, field: 'format', placeholder: t('sp.pen.formatPh'),
            onChange: function (v) { set(['format'], v); } })));
        if (trend) {
          var te = caps.trendEdit;
          out.push(h('div', { key: 'del', className: 'ctg-pnl__row' },
            h(NS.ui.Button, {
              kind: 'secondary', className: 'ctg-sp-danger', disabled: !te.allowed, 'data-ctg-act': 'remove-trend',
              title: te.allowed ? undefined : errText(te.reason || 'ACTION_DISABLED'),
              onClick: function (e) { self._ask(e, t('sp.pen.removeConfirm', { name: label }), t('sp.pen.remove'), function () { self._removeTrend(sel.tagPath); }); },
            }, Icon('trash'), t('sp.pen.remove'))));
        } else {
          out.push(h('div', { key: 'del', className: 'ctg-pnl__row' },
            h(NS.ui.Button, {
              kind: 'secondary', className: 'ctg-sp-danger', 'data-ctg-act': 'delete-pen',
              onClick: function (e) { self._ask(e, t('sp.pen.deleteConfirm', { name: label }), t('sp.pen.delete'), function () { self._deletePen(sel); }); },
            }, Icon('trash'), t('sp.pen.delete'))));
        }
        return [out[0], h('div', { key: 'ed-' + selId, 'data-ctg': 'pen-editor', 'data-ctg-pen': row.key }, out.slice(1))];
      }
      /**
       * Per-state styles of the pen (display.states): bad data look, out-of-bounds highlight (limits from the
       * tag's engineering range or manual), Boolean on / off colours. Fields appear as their switch turns on; the
       * limits the chart actually uses are shown (vm.states, resolved by the chart's buildPens).
       */
      _renderStates(out, display, vm, id, setDisp) {
        var st = display.states || defaultStates();
        var isBool = !!(vm && vm.isBool);
        var tk = {};
        try { tk = this.props.api.tokens() || {}; } catch (e) { tk = {}; }      // the swatches of the theme defaults
        out.push(h('div', { key: 'sth', className: 'ctg-pnl__section' }, t('sp.pen.states')));
        out.push(h('div', { key: 'stb', className: 'ctg-pnl__grid', 'data-ctg': 'pen-states-bad' },
          h(SelectField, { id: id('bad'), label: t('sp.pen.bad'), value: st.bad.style, field: 'states.bad.style',
            options: BAD_STYLES.map(function (k) { return { value: k, label: t('sp.pen.bad.' + k) }; }),
            onChange: function (v) { setDisp(['states', 'bad', 'style'], v); } }),
          st.bad.style !== 'none' ? h(ColorField, { id: id('badColor'), label: t('sp.pen.badColor'), value: st.bad.color, fallback: vm && vm.color,
            field: 'states.bad.color', onChange: function (v) { setDisp(['states', 'bad', 'color'], v); } }) : h('div', null)));
        if (!isBool) {
          var o = st.outOfBounds;
          out.push(h(Check, { key: 'oob', label: t('sp.pen.oob'), checked: o.enabled, field: 'states.outOfBounds.enabled',
            onChange: function (v) { setDisp(['states', 'outOfBounds', 'enabled'], v); } }));
          if (o.enabled) {
            var auto = t(o.source === 'engineering' ? 'sp.pen.oobAutoEng' : 'sp.pen.oobAutoNone');
            out.push(h('div', { key: 'oobs', className: 'ctg-pnl__grid' },
              h(SelectField, { id: id('oobSource'), label: t('sp.pen.oobSource'), value: o.source, field: 'states.outOfBounds.source',
                options: ['engineering', 'manual'].map(function (k) { return { value: k, label: t('sp.pen.oobSource.' + k) }; }),
                onChange: function (v) { setDisp(['states', 'outOfBounds', 'source'], v); } }),
              h(NumberField, { id: id('oobWidth'), label: t('sp.pen.oobWidth'), value: o.width, min: 0, max: 8, field: 'states.outOfBounds.width',
                onCommit: function (v) { setDisp(['states', 'outOfBounds', 'width'], v); } })));
            out.push(h('div', { key: 'oobl', className: 'ctg-pnl__grid' },
              h(NumberField, { id: id('oobLow'), label: t('sp.pen.oobLow', { auto: auto }), value: o.low, nullable: true, field: 'states.outOfBounds.low',
                onCommit: function (v) { setDisp(['states', 'outOfBounds', 'low'], v); } }),
              h(NumberField, { id: id('oobHigh'), label: t('sp.pen.oobHigh', { auto: auto }), value: o.high, nullable: true, field: 'states.outOfBounds.high',
                onCommit: function (v) { setDisp(['states', 'outOfBounds', 'high'], v); } })));
            if (o.low != null && o.high != null && !(o.low < o.high)) {
              out.push(h('p', { key: 'ooberr', className: 'ctg-pnl__error', role: 'alert' }, t('sp.pen.oobInvalid')));
            } else {
              var lim = oobLimits(o, vm && vm.meta);
              var fmt = function (x) { return x == null ? '—' : String(x); };
              if (lim) {
                out.push(h('p', { key: 'oobuse', className: 'ctg-pnl__muted', 'data-ctg': 'pen-states-limits' },
                  t('sp.pen.oobLimits', { low: fmt(lim.low), high: fmt(lim.high) })));
              }
            }
            out.push(h(ColorField, { key: 'oobc', id: id('oobColor'), label: t('sp.pen.oobColor'), value: o.color, fallback: tk.warn,
              field: 'states.outOfBounds.color', onChange: function (v) { setDisp(['states', 'outOfBounds', 'color'], v); } }));
          }
        }
        if (isBool || st.boolean.enabled) {
          var bo = st.boolean;
          out.push(h(Check, { key: 'bool', label: t('sp.pen.bool'), checked: bo.enabled, field: 'states.boolean.enabled',
            title: isBool ? undefined : t('sp.pen.boolOnly'), onChange: function (v) { setDisp(['states', 'boolean', 'enabled'], v); } }));
          if (!isBool) out.push(h('p', { key: 'boolonly', className: 'ctg-pnl__muted' }, t('sp.pen.boolOnly')));
          if (bo.enabled) {
            out.push(h('div', { key: 'boolc', className: 'ctg-pnl__grid' },
              h(ColorField, { id: id('boolOn'), label: t('sp.pen.boolOn'), value: bo.onColor, fallback: vm && vm.color, field: 'states.boolean.onColor',
                onChange: function (v) { setDisp(['states', 'boolean', 'onColor'], v); } }),
              h(ColorField, { id: id('boolOff'), label: t('sp.pen.boolOff'), value: bo.offColor, fallback: tk.textMuted, field: 'states.boolean.offColor',
                onChange: function (v) { setDisp(['states', 'boolean', 'offColor'], v); } })));
            out.push(h(NumberField, { key: 'boolf', id: id('boolFill'), label: t('sp.pen.boolFill'), value: bo.fillOpacity, min: 0, max: 1,
              field: 'states.boolean.fillOpacity', onCommit: function (v) { setDisp(['states', 'boolean', 'fillOpacity'], v); } }));
          }
        }
      }

      // ---- Axes tab ------------------------------------------------------------------------------
      _renderAxes(s) {
        var self = this;
        var api = this.props.api;
        // the axis editor follows its axis by name (another writer may reorder / remove axes)
        var ai = this.state.view === 'axis' ? resolveAxis(s.axes, this.state.axisName, this.state.axis) : -1;
        if (ai >= 0) return this._renderAxisEditor(s, ai);
        var out = [h('div', { key: 'h', className: 'ctg-pnl__section' }, t('sp.axes.named', { n: s.axes.length }))];
        if (!s.axes.length) out.push(h('p', { key: 'none', className: 'ctg-pnl__muted' }, t('sp.axes.none')));
        else {
          out.push(h('ul', { key: 'l', className: 'ctg-sp-list', 'data-ctg': 'settings-axes' }, s.axes.map(function (a, i) {
            return h('li', { key: i, className: 'ctg-sp-item' },
              h('button', { type: 'button', className: 'ctg-sp-name', 'data-ctg-act': 'edit-axis', onClick: function () { self.set({ view: 'axis', axis: i, axisName: a.name, status: null }); } },
                (a.name || '\u2014')),
              h('span', { className: 'ctg-sp-chip' }, t('sp.axes.side.' + a.position)));
          })));
        }
        out.push(h('div', { key: 'add', className: 'ctg-pnl__row', style: { marginBottom: '8px' } },
          h(NS.ui.Button, {
            kind: 'secondary', 'data-ctg-act': 'add-axis',
            onClick: function () {
              var r = addAxis(s.axes, api.axesInUse(), 0);
              self._writeAll({ axes: addAxisOp(r.name, r.axes[r.axes.length - 1].position) });
              self.set({ view: 'axis', axis: r.axes.length - 1, axisName: r.name });
            },
          }, Icon('plus'), t('sp.axes.add'))));
        var auto = api.axesInUse().filter(function (a) { return a.auto; });
        if (auto.length) {
          out.push(h('div', { key: 'ah', className: 'ctg-pnl__section' }, t('sp.axes.auto')));
          out.push(h('ul', { key: 'al', className: 'ctg-sp-list' }, auto.map(function (a) {
            return h('li', { key: a.key, className: 'ctg-sp-item ctg-pnl__muted' },
              t('sp.axes.autoRow', { units: a.units || t('sp.axes.noUnits'), side: t('sp.axes.side.' + a.side), plot: a.plot + 1 }));
          })));
        }
        return out;
      }
      /** axes[the edited axis][path] = value: a patch on that axis (by name, idx = hint) applied at write time. */
      _setAxis(idx, path, value) {
        var axes = this.drafts.get('axes');
        if (!axes[idx]) return;
        var name = axes[idx].name;
        this.drafts.edit('axes', 'a|' + name + '|' + path.join('.'), axisFieldOp(name, idx, path, value));
        this.forceUpdate();
      }
      _renderAxisEditor(s, idx) {
        var self = this;
        var a = s.axes[idx];
        var api = this.props.api;
        var id = function (k) { return self.idp + '-ax-' + k; };
        var set = function (path, v) { self._setAxis(idx, path, v); };
        var r = a.range;
        var users = s.pens.filter(function (p) { return p.axis && p.axis === a.name; }).map(function (p) { return p.name || NS.util.shortTagName(p.tagPath); });
        api.pens().forEach(function (vm) {
          if (vm.source === 'trend' && a.name && effectiveOverride(s.trendPens, vm.tagPath).axis === a.name) users.push(vm.label);
        });
        var out = [
          h('div', { key: 'sub', className: 'ctg-sp-subhead' },
            h('button', { type: 'button', className: 'ctg-pnl__link', 'data-ctg-act': 'back', onClick: function () { self.set({ view: 'list', status: null }); } },
              '\u2039 ' + t('sp.axis.back'))),
          h(DraftInput, {
            key: 'nm', id: id('name'), label: t('sp.axis.name'), value: a.name, live: false, field: 'axisName',
            validate: function (v) {
              var n = String(v).trim();
              if (!n) return { ok: false, error: t('sp.axis.nameEmpty') };
              if (n !== a.name && axisNames(s.axes).indexOf(n) >= 0) return { ok: false, error: t('sp.axis.nameTaken') };
              return { ok: true, value: n };
            },
            onCommit: function (n) {
              if (n === a.name) return;
              var ops = {};
              ['axes', 'pens', 'trendPens', 'plots'].forEach(function (r) { ops[r] = renameAxisOp(r, a.name, n); });
              if (self._writeOk(self._writeAll(ops, 'rename'))) self.set({ axisName: n });
            },
          }),
          users.length ? h('p', { key: 'users', className: 'ctg-pnl__muted' }, t('sp.axis.pens', { names: users.join(', ') })) : null,
          h('div', { key: 'pv', className: 'ctg-pnl__grid' },
            h(SelectField, { id: id('pos'), label: t('sp.axis.position'), value: a.position, field: 'position',
              options: [{ value: 'left', label: t('sp.axis.left') }, { value: 'right', label: t('sp.axis.right') }], onChange: function (v) { set(['position'], v); } }),
            h(SelectField, { id: id('scale'), label: t('sp.axis.scale'), value: a.scale, field: 'scale',
              options: [{ value: 'linear', label: t('sp.axis.scale.linear') }, { value: 'log', label: t('sp.axis.scale.log') }], onChange: function (v) { set(['scale'], v); } })),
          h(Check, { key: 'vis', label: t('sp.axis.visible'), checked: a.visible, field: 'axisVisible', onChange: function (v) { set(['visible'], v); } }),
          h(TextField, { key: 'lt', id: id('label'), label: t('sp.axis.label'), value: a.label.text, field: 'labelText', onChange: function (v) { set(['label', 'text'], v); } }),
          h(Check, { key: 'lv', label: t('sp.axis.labelVisible'), checked: a.label.visible, field: 'labelVisible', onChange: function (v) { set(['label', 'visible'], v); } }),
          h('div', { key: 'fw', className: 'ctg-pnl__grid' },
            h(TextField, { id: id('format'), label: t('sp.axis.format'), value: a.format, field: 'axisFormat', onChange: function (v) { set(['format'], v); } }),
            h(NumberField, { id: id('width'), label: t('sp.axis.width'), value: a.width, min: 0, max: 400, integer: true, field: 'axisWidth',
              onCommit: function (v) { set(['width'], v); } })),
          h(ColorField, { key: 'col', id: id('color'), label: t('sp.axis.color'), value: a.color, fallback: tokenColor(api, 'textMuted'), field: 'axisColor', onChange: function (v) { set(['color'], v); } }),
          h('div', { key: 'rh', className: 'ctg-pnl__section' }, t('sp.axis.range')),
          h(SelectField, { key: 'rm', id: id('rmode'), label: t('sp.axis.range'), value: r.mode, field: 'rangeMode',
            options: ['auto', 'manual', 'engineering'].map(function (k) { return { value: k, label: t('sp.axis.range.' + k) }; }),
            onChange: function (v) { set(['range', 'mode'], v); } }),
          r.mode === 'manual' ? h('div', { key: 'mm', className: 'ctg-pnl__grid' },
            h(NumberField, { id: id('min'), label: t('sp.axis.min'), value: r.min, nullable: true, field: 'rangeMin',
              onCommit: function (v) { set(['range', 'min'], v); } }),
            h(NumberField, { id: id('max'), label: t('sp.axis.max'), value: r.max, nullable: true, field: 'rangeMax',
              onCommit: function (v) { set(['range', 'max'], v); } })) : null,
          r.mode === 'manual' && r.min != null && r.max != null && !(r.min < r.max) ? h('p', { key: 'mmerr', className: 'ctg-pnl__error', role: 'alert' }, t('sp.axis.minMax')) : null,
          h('div', { key: 'iz', className: 'ctg-pnl__grid' },
            h(NumberField, { id: id('pad'), label: t('sp.axis.padding'), value: r.padding, min: 0, max: 0.5, field: 'padding',
              onCommit: function (v) { set(['range', 'padding'], v); } }),
            h('div', { style: { paddingTop: '20px' } },
              h(Check, { label: t('sp.axis.includeZero'), checked: r.includeZero, field: 'includeZero', onChange: function (v) { set(['range', 'includeZero'], v); } }))),
          h('div', { key: 'gh', className: 'ctg-pnl__section' }, t('sp.axis.grid')),
          h(Check, { key: 'gv', label: t('sp.axis.gridVisible'), checked: a.grid.visible, field: 'gridVisible', onChange: function (v) { set(['grid', 'visible'], v); } }),
          h('div', { key: 'go', className: 'ctg-pnl__grid' },
            h(NumberField, { id: id('gop'), label: t('sp.axis.gridOpacity'), value: a.grid.opacity, min: 0, max: 1, field: 'gridOpacity',
              onCommit: function (v) { set(['grid', 'opacity'], v); } }),
            h(SelectField, { id: id('gdash'), label: t('sp.axis.gridDash'), value: dashName(a.grid.dash), field: 'gridDash',
              options: ['solid', 'dashed', 'dotted'].map(function (k) { return { value: k, label: t('sp.dash.' + k) }; })
                .concat(dashName(a.grid.dash) === 'custom' ? [{ value: 'custom', label: t('sp.dash.custom', { v: a.grid.dash.join(',') }) }] : []),
              onChange: function (v) { if (v !== 'custom') set(['grid', 'dash'], DASHES[v].slice()); } })),
          h(ColorField, { key: 'gc', id: id('gcolor'), label: t('sp.axis.gridColor'), value: a.grid.color, fallback: tokenColor(api, 'text'), field: 'gridColor', onChange: function (v) { set(['grid', 'color'], v); } }),
          h('div', { key: 'del', className: 'ctg-pnl__row' },
            h(NS.ui.Button, {
              kind: 'secondary', className: 'ctg-sp-danger', 'data-ctg-act': 'delete-axis',
              onClick: function (e) {
                self._ask(e, t('sp.axis.deleteConfirm', { name: a.name }), t('sp.axis.delete'), function () {
                  var j = resolveAxis(self._state().axes, a.name, idx);   // the axis may have moved meanwhile
                  if (j >= 0) {
                    // the entry goes; references to the name fall back to automatic ('')
                    self._writeOk(self._writeAll({ axes: dropAxisOp(a.name, j), pens: renameAxisOp('pens', a.name, ''),
                      trendPens: renameAxisOp('trendPens', a.name, ''), plots: renameAxisOp('plots', a.name, '') }, 'delete'));
                  }
                  self.set({ view: 'list', axis: -1, axisName: null, confirm: null });
                });
              },
            }, Icon('trash'), t('sp.axis.delete'))),
        ];
        return [out[0], h('div', { key: 'ax-' + idx }, out.slice(1))];
      }

      // ---- Plots tab -----------------------------------------------------------------------------
      _renderPlots(s) {
        var self = this;
        if (this.state.view === 'plot' && this.state.plotRef) {
          // the editor follows its plot by identity (PlotRef); gone -> say so instead of editing another plot
          var pi = resolvePlot(s.plots, this.state.plotRef);
          if (pi >= 0) return this._renderPlotEditor(s, pi);
          return [h('div', { key: 'sub', className: 'ctg-sp-subhead' },
            h('button', { type: 'button', className: 'ctg-pnl__link', 'data-ctg-act': 'back', onClick: function () { self.set({ view: 'list', plotRef: null, status: null }); } },
              '\u2039 ' + t('sp.plot.back'))),
            h('p', { key: 'gone', className: 'ctg-pnl__muted', 'data-ctg': 'plot-gone' }, t('sp.plot.gone'))];
        }
        var plots = s.plots.length ? s.plots : null;
        var count = function (i) {
          return self.props.api.pens().filter(function (vm) { return vm.plot === i; }).length;
        };
        var out = [h('div', { key: 'h', className: 'ctg-pnl__section' }, t('sp.plots.list', { n: Math.max(1, s.plots.length) }))];
        if (!plots) out.push(h('p', { key: 'imp', className: 'ctg-pnl__muted' }, t('sp.plots.implicit')));
        out.push(h('ul', { key: 'l', className: 'ctg-sp-list', 'data-ctg': 'settings-plots' }, (plots || [defaultPlot()]).map(function (pl, i) {
          return h('li', { key: i, className: 'ctg-sp-item' },
            h('button', { type: 'button', className: 'ctg-sp-name', 'data-ctg-act': 'edit-plot', onClick: function () { self.set({ view: 'plot', plotRef: plotRefOf(s.plots, i), status: null }); } },
              t('sp.plots.row', { n: i + 1, w: pl.relativeWeight, pens: count(i) })));
        })));
        var full = Math.max(1, s.plots.length) >= MAX_PLOTS;
        out.push(h('div', { key: 'add', className: 'ctg-pnl__row' },
          h(NS.ui.Button, {
            kind: 'secondary', disabled: full, title: full ? t('sp.plots.max', { max: MAX_PLOTS }) : undefined, 'data-ctg-act': 'add-plot',
            onClick: function () {
              var ids = { first: newPlotId(), added: newPlotId() };
              var r = addPlot(s.plots, ids);
              if (r.index < 0) return;
              self._writeAll({ plots: addPlotOp(ids) });
              self.set({ view: 'plot', plotRef: plotRefOf(r.plots, r.index) });
            },
          }, Icon('plus'), t('sp.plots.add'))));
        return out;
      }
      /**
       * plots[the edited plot][path] = v as an operation applied at write time; the plot is followed by its PlotRef
       * (SECTION 2b), and the ref is refreshed from the draft after the edit (the plot's own JSON changed) so another
       * writer's later structural change still finds it. An implicit single plot is materialised first.
       */
      _setPlot(path, value, immediate, op) {
        var ref = this.state.plotRef;
        var plots = this.drafts.get('plots');
        var i = resolvePlot(plots, ref);
        if (i < 0) return;
        var cur = Object.assign({}, ref, { pos: i, len: Math.max(1, plots.length) });
        // the id coalesces repeated edits of one field of this plot (a later one replaces the pending one)
        this.drafts.edit('plots', 'pl|' + i + '|' + (op ? op.id : path.join('.')), op ? op.fn(cur) : plotFieldOp(cur, path, value), immediate);
        var after = this.drafts.get('plots');
        var nextRef = plotRefOf(after, i);
        this.state.plotRef = nextRef;
        this.set({ plotRef: nextRef });
        this.forceUpdate();
      }
      _renderPlotEditor(s, idx) {
        var self = this;
        var pl = s.plots[idx] || defaultPlot();
        // the remembered identity follows edits made by others in place (same count): the ref is refreshed here
        var ref = this.state.plotRef;
        if (ref && (ref.pos !== idx || ref.sig !== stableJson(s.plots.length ? s.plots[idx] : defaultPlot()))) {
          this.state.plotRef = plotRefOf(s.plots, idx);
        }
        var id = function (k) { return self.idp + '-pl-' + idx + '-' + k; };
        var names = axisNames(s.axes);
        var out = [
          h('div', { key: 'sub', className: 'ctg-sp-subhead' },
            h('button', { type: 'button', className: 'ctg-pnl__link', 'data-ctg-act': 'back', onClick: function () { self.set({ view: 'list', status: null }); } },
              '\u2039 ' + t('sp.plot.back')),
            h('span', { className: 'ctg-sp-subhead__name' }, t('sp.plot.title', { n: idx + 1 }))),
          null,
          h(NumberField, { key: 'w', id: id('w'), label: t('sp.plot.weight'), value: pl.relativeWeight, min: 0.1, max: 10, field: 'weight',
            onCommit: function (v) { self._setPlot(['relativeWeight'], v); } }),
          h(ColorField, { key: 'bg', id: id('bg'), label: t('sp.plot.background'), value: pl.background, fallback: tokenColor(self.props.api, 'surface'), field: 'background',
            onChange: function (v) { self._setPlot(['background'], v); } }),
          h('div', { key: 'mh', className: 'ctg-pnl__section' }, t('sp.plot.markers', { n: pl.markers.length })),
        ];
        pl.markers.forEach(function (m, k) {
          var mset = function (path, v) { self._setPlot(['markers', k].concat(path), v); };
          var mid = function (x) { return id('m' + k + '-' + x); };
          out.push(h('fieldset', { key: 'm' + k, 'data-ctg-marker': String(k) },
            h('legend', null, t('sp.plot.marker', { n: k + 1 })),
            h('div', { className: 'ctg-pnl__grid' },
              h(SelectField, { id: mid('type'), label: t('sp.marker.type'), value: m.type, field: 'markerType',
                options: [{ value: 'line', label: t('sp.marker.type.line') }, { value: 'band', label: t('sp.marker.type.band') }],
                onChange: function (v) { mset(['type'], v); } }),
              h(SelectField, { id: mid('axis'), label: t('sp.marker.axis'), value: m.axis, field: 'markerAxis',
                options: [{ value: '', label: t('sp.marker.axisFirst') }].concat(names.map(function (n) { return { value: n, label: n }; }))
                  .concat(m.axis && names.indexOf(m.axis) < 0 ? [{ value: m.axis, label: m.axis }] : []),
                onChange: function (v) { mset(['axis'], v); } })),
            m.type === 'band' ? h('div', { className: 'ctg-pnl__grid' },
              h(NumberField, { id: mid('min'), label: t('sp.marker.min'), value: m.min, field: 'markerMin', onCommit: function (v) { mset(['min'], v); } }),
              h(NumberField, { id: mid('max'), label: t('sp.marker.max'), value: m.max, field: 'markerMax', onCommit: function (v) { mset(['max'], v); } }))
              : h(NumberField, { id: mid('value'), label: t('sp.marker.value'), value: m.value, field: 'markerValue', onCommit: function (v) { mset(['value'], v); } }),
            h('div', { className: 'ctg-pnl__grid' },
              h(NumberField, { id: mid('op'), label: t('sp.marker.opacity'), value: m.opacity, min: 0, max: 1, field: 'markerOpacity', onCommit: function (v) { mset(['opacity'], v); } }),
              m.type === 'line' ? h(NumberField, { id: mid('w'), label: t('sp.marker.width'), value: m.width, min: 0, max: 20, field: 'markerWidth', onCommit: function (v) { mset(['width'], v); } })
                : h('div', null)),
            h(ColorField, { id: mid('col'), label: t('sp.marker.color'), value: m.color, fallback: tokenColor(self.props.api, 'textMuted'), field: 'markerColor', onChange: function (v) { mset(['color'], v); } }),
            h('div', { className: 'ctg-pnl__grid' },
              h(TextField, { id: mid('lt'), label: t('sp.marker.label'), value: m.label.text, field: 'markerLabel', onChange: function (v) { mset(['label', 'text'], v); } }),
              h(SelectField, { id: mid('lp'), label: t('sp.marker.labelPos'), value: m.label.position, field: 'markerLabelPos',
                options: [{ value: 'left', label: t('sp.marker.labelLeft') }, { value: 'right', label: t('sp.marker.labelRight') }],
                onChange: function (v) { mset(['label', 'position'], v); } })),
            h('div', { className: 'ctg-pnl__row', style: { marginBottom: '6px' } },
              h('button', {
                type: 'button', className: 'ctg-pnl__link ctg-sp-danger', 'data-ctg-act': 'remove-marker',
                onClick: function () { self._setPlot(null, null, true, { id: 'm-|' + k, fn: function (r) { return removeMarkerOp(r, k); } }); },
              }, t('sp.plot.markerRemove', { n: k + 1 })))));
        });
        out.push(h('div', { key: 'ma', className: 'ctg-pnl__row', style: { marginBottom: '12px' } },
          h(NS.ui.Button, { kind: 'secondary', 'data-ctg-act': 'add-marker',
            onClick: function () { self._setPlot(null, null, true, { id: 'm+|' + (++self._opSeq), fn: function (r) { return addMarkerOp(r, ''); } }); } }, Icon('plus'), t('sp.plot.markerAdd'))));
        var last = Math.max(1, s.plots.length) <= 1;
        out.push(h('div', { key: 'del', className: 'ctg-pnl__row' },
          h(NS.ui.Button, {
            kind: 'secondary', className: 'ctg-sp-danger', disabled: last, title: last ? t('sp.plot.removeLast') : undefined, 'data-ctg-act': 'remove-plot',
            onClick: function (e) {
              self._ask(e, t('sp.plot.removeConfirm', { n: idx + 1 }), t('sp.plot.remove'), function () {
                var ops = removePlotOps(self.state.plotRef, self._state().plots);
                if (ops) self._writeOk(self._writeAll(ops, 'plot-'));
                self.set({ view: 'list', plotRef: null, confirm: null });
              });
            },
          }, Icon('trash'), t('sp.plot.remove'))));
        return [out[0], h('div', { key: 'pl-' + idx }, out.slice(2))];
      }

      // ---- Columns tab ---------------------------------------------------------------------------
      _renderColumns(s) {
        var self = this;
        var pt = s.penTable;
        var box = function (group, ids2, legend, key) {
          return h('fieldset', { key: key, 'data-ctg': 'settings-' + key },
            h('legend', null, legend),
            ids2.map(function (c) {
              return h(Check, {
                key: c, label: t('sp.col.' + c), checked: pt[group][c] !== false, field: group + '.' + c,
                onChange: function (v) { self.drafts.edit('penTable', group + '.' + c, function (x) { return setIn(NS.util.isPlainObject(x) ? x : {}, [group, c], v); }); self.forceUpdate(); },
              });
            }));
        };
        return [box('columns', PEN_COLUMN_IDS, t('sp.cols.table'), 'columns'), box('rangeColumns', RANGE_COLUMN_IDS, t('sp.cols.range'), 'rangeColumns')];
      }
    }

    /* ========================================================================
     * SECTION 8 / TagBrowser
     * ----------------------------------------------------------------------
     * role=tree (aria-multiselectable) with one roving tab stop; rows are
     * treeitems (aria-level / aria-expanded / aria-selected). Keyboard: ↑/↓
     * move, →/← open / close (or go to the first child / the parent), Home /
     * End, Space toggles the selection (or opens a folder), Enter adds the
     * selection (on "Load more…": loads the next page). The visual checkbox is
     * a span (aria-hidden): treeitems carry no nested interactive controls.
     * Selectable = trendable (numeric / Boolean AtomicTag), not already on the
     * chart, and inside the read scope (mirror; the gateway decides). The add
     * target follows tagBrowser.addTo (auto: the trend list when trendGroup is
     * set, else `pens`).
     *
     * "Search all folders" (model in SECTION 3b): with the
     * switch on, the field searches every folder on the gateway (debounced;
     * Enter searches at once) and the tree is replaced by a listbox of the
     * matching tags (aria-multiselectable options, same keys, same selection:
     * a tag selected in the results stays selected in the tree and back).
     * Escape in the field clears it and cancels a running search; "Cancel"
     * in the status line stops it on the gateway ({cancelSearch:true}).
     *
     * The chart moves an open panel between its dock and the narrow-layout
     * sheet, which re-mounts it. What the user did in THIS opening (the mode,
     * the text, the ticked tags, a finished search's results) is kept per
     * opening (BROWSER_KEPT, keyed by the opening's args object, refreshed
     * after every update) and comes back after the move; a running search
     * is searched again. A new opening or another browse identity starts
     * clean: the chart gives every opening its own args
     * copy carrying a hidden `openingId`, which must match too (a caller
     * that re-opens with one constant args object is a new opening), and a
     * real close (the panel no longer open at unmount, as opposed to a
     * re-mount) drops the entry at once.
     * ====================================================================== */
    var BROWSER_KEPT = typeof WeakMap === 'function' ? new WeakMap() : null;
    class TagBrowser extends RComponent {
      constructor(props) {
        super(props);
        var self = this;
        this.state = { rev: 0, focus: null, selected: {}, filter: '', busy: false, result: null, searchAll: false };
        this.tree = this._newTree();
        this.search = new TagSearchModel();
        this.idp = ids('ctg-tb');
        this._rowEls = new Map();
        this._filterNow = NS.util.debounce(function () { self._applyFilter(); }, 300);
        this._searchNow = NS.util.debounce(function () { self._searchFromInput(); }, SEARCH_DEBOUNCE_MS);
        this._retryTimer = null;
        this._treeKey = function (e) { self._onKey(e); };
        this._hitKey = function (e) { self._onHitKey(e); };
        this._close = function (why) { self.props.close(why); };
        this._restore();
      }
      componentDidMount() {
        this._alive = true;
        ensureStyles();
        this._ident = this._identity();
        if (this._browseAllowed()) this._load('', false);
        // a search that was running when the panel moved (dock <-> narrow sheet) runs again here
        var resume = this._resume;
        this._resume = null;
        if (resume && this.state.searchAll && searchable(resume)) this._runSearch(resume, false);
        this._remember();
      }
      /**
       * Constructor: the state this opening had before a re-mount (see the section comment). React constructs the
       * new instance BEFORE the old one unmounts, so the snapshot is the old instance's latest (_remember),
       * copied: the old instance's unmount resets its own search model, never the one restored here.
       */
      _restore() {
        var args = this.props.args;
        var kept = BROWSER_KEPT && args && typeof args === 'object' ? BROWSER_KEPT.get(args) : null;
        if (!kept || kept.ident !== this._identity()) return;    // nothing kept, or logout / login, root or scope changed
        if (kept.opening !== args.openingId) return;             // another opening with the same args object
        this.state.filter = kept.filter;
        this.state.searchAll = kept.searchAll;
        this.state.selected = kept.selected;
        if (kept.search.status === 'running') this._resume = kept.search.text;   // runs again once mounted
        else if (kept.search.status !== 'idle') this.search = kept.search.copy();
      }
      /** After every mount / update: the snapshot a re-mount of this opening starts from. */
      _remember() {
        var args = this.props.args;
        if (!BROWSER_KEPT || !args || typeof args !== 'object') return;
        BROWSER_KEPT.set(args, { ident: this._ident, opening: args.openingId, filter: this.state.filter, searchAll: !!this.state.searchAll,
          selected: this.state.selected, search: this.search });
      }
      componentDidUpdate() {
        if (!this._alive) return;
        this._remember();
        // a new browse identity (gate off -> on: logout / login; rootPath or read scope changed): the tree and the
        // selection belong to the previous one -> start over
        var ident = this._identity();
        if (ident !== this._ident) {
          this._ident = ident;
          this.tree = this._newTree();
          this._stopSearch(true);                      // a search of the previous identity: its results are not this user's
          this.setState({ rev: this.state.rev + 1, focus: null, selected: {}, result: null, busy: false });
          if (this.state.searchAll && searchable(this.state.filter)) this._searchNow();   // ... the text is searched again for the new one
          return;                                     // the update that follows loads the new root
        }
        // the tag browser may become allowed after mount (snapshot arrived, user logged in)
        if (this._browseAllowed() && !this.tree.root().loaded && !this.tree.root().loading && !this.tree.root().error) this._load('', false);
      }
      _newTree() {
        var self = this;
        var tree = new TagTree();
        tree.keep = function (key) { return !!(self.state && self.state.selected[key]); };
        return tree;
      }
      /**
       * What the tree shown depends on: the gate, the read scope, tagBrowser.rootPath and the session USER
       * (capabilities().user, from the gateway's ctg.welcome), so a user switch in the same session with the same
       * gate and scope never keeps the previous user's tree and selection.
       */
      _identity() {
        var api = this.props.api;
        var caps = api.capabilities();
        return JSON.stringify([!caps.designMode && !!caps.tagBrowser.allowed, caps.readScope, api.props().tagBrowser.rootPath,
          caps.user == null ? null : String(caps.user)]);
      }
      componentWillUnmount() {
        this._filterNow.cancel();
        this._stopSearch(true);                        // a closed panel does not keep the gateway searching
        this._alive = false;
        // a real close (not a move between the dock and the sheet): this opening's state is not kept
        var args = this.props.args;
        var open = true;
        try { open = !!this.props.api.panels.isOpen('tagBrowser'); } catch (e) { open = false; }
        if (!open && BROWSER_KEPT && args && typeof args === 'object') BROWSER_KEPT.delete(args);
      }
      shouldComponentUpdate(np, ns) {
        if (ns !== this.state || np.args !== this.props.args || np.api !== this.props.api) return true;
        return browserSig(np.api) !== this._sig;
      }
      set(patch) { if (this._alive) this.setState(patch); }
      bump() { if (this._alive) this.setState({ rev: this.state.rev + 1 }); }
      _browseAllowed() {
        var caps = this.props.api.capabilities();
        return !caps.designMode && caps.tagBrowser.allowed;
      }

      /**
       * One chart.browse page for folder `key` (append = "Load more…"). The filter applies to filterTargets().
       * The gateway filters each PAGE, so a filtered page can come back empty with a
       * continuation: the next page is then fetched automatically (at most AUTO_PAGES in a row) instead of
       * showing an empty folder with only "Load more…".
       */
      _load(key, append, auto) {
        var self = this;
        var tree = this.tree;
        var n = tree.get(key);
        if (!n) return;
        var before = append ? n.children.length : 0;
        // "Load more…" continues with the filter the folder's pages were loaded with (a continuation belongs to
        // its query); a first page uses the current filter when the folder is a filter target
        var filterText = append ? (n.filtered ? n.filter : '') : this._filterFor(key);
        var filterOn = !!filterText;
        var body = { path: n.path, limit: PAGE_LIMIT };
        if (append && n.continuation) body.continuation = n.continuation;
        if (filterOn) body.filterText = filterText;
        var gen = tree.startLoad(key, append);
        this.bump();
        this.props.api.request('chart.browse', body).then(function (res) {
          if (!self._alive || tree !== self.tree) return;      // closed, or the tree was replaced (new identity)
          if (res && res.ok) {
            if (tree.applyPage(key, gen, res.data, append, filterText)) {
              var node = self.tree.get(key);
              var count = auto || 0;
              if (filterOn && node.children.length === before && node.continuation && count < AUTO_PAGES) {
                self._load(key, true, count + 1);
                return;
              }
            }
          } else tree.failLoad(key, gen, (res && res.error) || { code: 'INTERNAL' });
          self.bump();
        });
      }
      _toggle(key, open) {
        var n = this.tree.get(key);
        if (!n || !n.hasChildren) return;
        var want = open == null ? !n.expanded : open;
        this.tree.setExpanded(key, want);
        // opening: browse when not loaded, or when its pages were loaded with another filter than it gets now
        var stale = n.loaded && !n.loading && (n.filtered ? n.filter : '') !== this._filterFor(key);
        if (want && ((!n.loaded && !n.loading) || stale)) this._load(key, false);
        else this.bump();
      }
      /** The filterText a first page of folder `key` is browsed with now ('' = unfiltered). */
      _filterFor(key) {
        return this.state.filter && this.tree.filterTargets().indexOf(key) >= 0 ? this.state.filter.slice(0, 64) : '';
      }
      _reload() {
        var self = this;
        this.tree.expandedKeys().forEach(function (k) { self._load(k, false); });
      }
      _applyFilter() {
        var self = this;
        if (!this._alive) return;
        // open folders filtered before (or now) are browsed again; the others keep their pages. A COLLAPSED
        // folder still holding filtered pages is invalidated: it is browsed again when it is opened
        var targets = this.tree.filterTargets();
        Object.keys(this.tree.nodes).forEach(function (k) {
          var n = self.tree.get(k);
          if (!n) return;
          if ((n.filtered || targets.indexOf(k) >= 0) && (k === '' || n.expanded)) self._load(k, false);
          else if (n.filtered && k !== '') self.tree.invalidate(k);
        });
        this.bump();
      }

      // ---- "Search all folders" (SECTION 3b) -------------------------------------------------------------
      /** Switches between filtering the open folder (tree) and searching every folder (results list). */
      _setSearchAll(on) {
        on = !!on;
        if (on === this.state.searchAll) return;
        this._filterNow.cancel();
        this._stopSearch(true);
        this.set({ searchAll: on, focus: null });
        // the text typed so far applies to the new mode: a search of every folder, or the open folder's filter again
        if (on) { if (searchable(this.state.filter)) this._searchNow(); }
        else this._filterNow();
      }
      /** Debounced field input (or Enter, `force`) → a search, or no search while the text is too short. */
      _searchFromInput(force) {
        if (!this._alive || !this.state.searchAll) return;
        var text = this.state.filter.trim();
        var m = this.search;
        if (!force && text === m.text && (m.status === 'running' || m.status === 'done')) return;
        if (!searchable(text)) { this._stopSearch(true); this.bump(); return; }
        this._runSearch(text, false);
      }
      /** One search on the gateway (it supersedes this chart's previous one there). */
      _runSearch(text, retried) {
        var self = this;
        if (!this._browseAllowed()) return;
        this._clearRetry();
        var seq = this.search.start(text);
        this.bump();
        this.props.api.request('chart.browse', { path: '', search: text, limit: SEARCH_PAGE }, { timeoutMs: SEARCH_TIMEOUT_MS }).then(function (res) {
          if (!self._alive || seq !== self.search.seq) return;            // closed, retyped, cancelled or reset
          if (res && res.ok) {
            if (self.search.apply(seq, res.data, false)) {
              var line = self.search.statusLine();
              if (line) NS.a11y.announce(line.text);
            }
            self.bump();
            return;
          }
          var code = res && res.error && res.error.code;
          if (!retried && (code === 'RATE_LIMITED' || code === 'BUSY')) {
            // the gateway admits a few new searches per session per second and one at a time: once more, shortly
            self._retryTimer = setTimeout(function () {
              self._retryTimer = null;
              if (self._alive && seq === self.search.seq) self._runSearch(text, true);
            }, SEARCH_RETRY_MS);
            return;
          }
          self.search.fail(seq, (res && res.error) || { code: 'INTERNAL' }, false);
          self.bump();
        });
      }
      /** "Load more…": the next page of the stored matches (no new search on the gateway). */
      _searchMore() {
        var self = this;
        var m = this.search;
        if (m.status !== 'done' || !m.continuation || m.loadingMore) return;
        var seq = m.seq;
        m.loadingMore = true;
        this.bump();
        this.props.api.request('chart.browse', { path: '', search: m.text, continuation: m.continuation, limit: SEARCH_PAGE },
          { timeoutMs: SEARCH_TIMEOUT_MS }).then(function (res) {
          if (!self._alive || seq !== self.search.seq) return;
          if (res && res.ok) self.search.apply(seq, res.data, true);
          else self.search.fail(seq, (res && res.error) || { code: 'INTERNAL' }, true);
          self.bump();
        });
      }
      /** "Cancel" / Escape while searching: stops the search here and on the gateway. */
      _cancelSearch() {
        if (!this.search.cancel()) return;
        this._clearRetry();
        this.props.api.request('chart.browse', { cancelSearch: true });
        NS.a11y.announce(t('tb.search.cancelled'));
        this.bump();
      }
      /** "Try again" after a failed or cancelled search. */
      _retrySearch() {
        var text = this.search.text || this.state.filter.trim();
        if (searchable(text)) this._runSearch(text, false);
      }
      /**
       * Drops the search (mode off, new identity, unmount, text too short). `tellGateway`: a running search is
       * cancelled on the gateway too (it would otherwise run to its time budget for nobody).
       */
      _stopSearch(tellGateway) {
        this._searchNow.cancel();
        this._clearRetry();
        var running = this.search.status === 'running';
        this.search.reset();
        if (running && tellGateway && this._alive) this.props.api.request('chart.browse', { cancelSearch: true });
      }
      _clearRetry() {
        if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
      }
      /** Rows of the results list: one per hit, then "Load more…" when the gateway holds more matches. */
      _searchRows() {
        var rows = this.search.keys.map(function (k) { return { id: 'h:' + k, kind: 'hit', key: k }; });
        if (this.search.continuation) rows.push({ id: 'more:search', kind: 'more', key: '' });
        return rows;
      }

      // ---- selection ------------------------------------------------------------------------------
      /** {selectable, reason} of a tag node for the current chart (charted / not trendable / scope). */
      _status(n, ctx) {
        if (n.hasChildren && n.type !== 'AtomicTag') {
          var fs = folderScopeOf(n.path, ctx.scope);
          return { folder: true, muted: fs === 'out', reason: fs === 'out' ? (ctx.scope.runtimePensAllowed ? t('tb.folderOutOfScope') : t('tb.noRuntime')) : null };
        }
        if (ctx.charted[n.key]) return { charted: true, reason: t('tb.charted') };
        if (!n.trendable) return { muted: true, reason: t('tb.notTrendable') };
        var sc = scopeOf(n.path, ctx.scope);
        if (sc === 'out') return { muted: true, reason: ctx.scope.runtimePensAllowed ? t('tb.outOfScope') : t('tb.noRuntime') };
        if (ctx.locked) return { muted: false, reason: ctx.locked };
        return { selectable: true };
      }
      _ctx() {
        var api = this.props.api;
        var props = api.props();
        var caps = api.capabilities();
        var charted = {};
        api.pens().forEach(function (vm) { charted[normKey(vm.tagPath)] = true; });
        props.pens.forEach(function (p) { charted[normKey(p.tagPath)] = true; });
        var target = addTarget(props);
        var locked = null;
        if (caps.designMode) locked = t('cp.designMode');
        else if (!caps.enabled) locked = t('cp.readOnly');
        else if (target === 'trendList' && !caps.trendEdit.allowed) locked = t('tb.trendOff', { reason: errText(caps.trendEdit.reason || 'ACTION_DISABLED') });
        return { api: api, props: props, caps: caps, scope: caps.readScope, charted: charted, target: target, locked: locked,
          group: trendGroupOf(props) };
      }
      _toggleSel(n, ctx) {
        var st = this._status(n, ctx);
        if (!st.selectable) return;
        var sel = Object.assign({}, this.state.selected);
        if (sel[n.key]) delete sel[n.key];
        else sel[n.key] = { path: n.path, name: n.name, node: n };   // node: a search hit stays selected after the results go
        this.set({ selected: sel, result: null });
      }
      /** The node of a selected key: the tree's, the current search's, or the one kept with the selection. */
      _nodeOf(key) {
        var held = this.state.selected[key];
        return this.tree.get(key) || this.search.get(key) || (held && held.node) || null;
      }
      /** Selected tags still selectable now (a pen added elsewhere or a scope change drops them). */
      _selection(ctx) {
        var self = this;
        return Object.keys(this.state.selected).map(function (k) { return self._nodeOf(k); })
          .filter(function (n) { return n && self._status(n, ctx).selectable; });
      }

      // ---- add ----------------------------------------------------------------------------------
      _add() {
        var self = this;
        var ctx = this._ctx();
        var list = this._selection(ctx);
        var check = this._addCheck(ctx, list.length);
        if (!list.length || check || this.state.busy) return;
        var paths = list.map(function (n) { return n.path; });
        var api = ctx.api;
        if (ctx.target === 'trendList') {
          this.set({ busy: true, result: null });
          // the gateway lists a tag that already was in the trend list among `added` (its add is idempotent): those are
          // duplicates for the operator and fire no 'add' event
          var before = {};
          api.pens().forEach(function (vm) { if (vm.source === 'trend') before[normKey(vm.tagPath)] = true; });
          api.request('chart.trendAdd', { tagPaths: paths }).then(function (res) {
            var d = (res && res.ok && res.data) || {};
            var reported = Array.isArray(d.added) ? d.added : [];
            var added = reported.filter(function (p) { return !before[normKey(String(p))]; });
            var already = reported.filter(function (p) { return before[normKey(String(p))]; });
            // the tags were added on the gateway: the events fire even when the panel closed meanwhile
            added.forEach(function (p) { api.fireEvent('onPensChange', { action: 'add', tagPath: String(p), source: 'trend' }); });
            if (!self._alive) return;
            if (!res || !res.ok) { self.set({ busy: false, result: { error: errText(res && res.error) } }); return; }
            var rejected = Array.isArray(d.rejected) ? d.rejected : [];
            var dups = (Array.isArray(d.duplicates) ? d.duplicates : []).concat(already);
            self._finish(paths, added, rejected, dups);
          });
          return;
        }
        // pens target: one ChartApi.patch of `pens` appending a default item per tag; the pens already
        // there stay exactly as the view stores them. Only the tags really appended fire 'add' and count as
        // added; the others are reported as duplicates.
        var report = { added: [], duplicates: [] };
        if (api.patch('pens', addPensOp(paths, report)) === false) { this.set({ result: { error: t('cp.saveFailed') } }); return; }
        report.added.forEach(function (p) { api.fireEvent('onPensChange', { action: 'add', tagPath: p, source: 'pens' }); });
        this._finish(paths, report.added, [], report.duplicates);
      }
      _finish(sent, added, rejected, dups) {
        var sel = Object.assign({}, this.state.selected);
        sent.forEach(function (p) { delete sel[normKey(p)]; });
        var msg = added.length === 1 ? t('tb.added1', { name: NS.util.shortTagName(added[0]) }) : t('tb.added', { n: added.length });
        var rej = rejected.map(function (r) {
          return { tagPath: String((r && r.tagPath) || ''), text: r && r.code && NS.i18n.has('error.' + r.code) ? errText({ code: r.code }) : String((r && r.message) || (r && r.code) || '') };
        });
        var announce = msg + (rej.length ? ' ' + t('tb.rejected') + ' ' + rej.map(function (r) { return NS.util.shortTagName(r.tagPath) + ' \u2014 ' + r.text; }).join('; ') : '');
        NS.a11y.announce(announce);
        this.set({ busy: false, selected: sel, result: { added: added.length, text: msg, rejected: rej, duplicates: dups.length } });
      }
      /** Why "Add selected" is disabled (null = it can run). */
      _addCheck(ctx, n) {
        if (ctx.locked) return ctx.locked;
        var max = ctx.api.limits().maxPens;
        if (max && n > max) return t('tb.tooMany', { max: max });
        if (ctx.target === 'pens' && max) {
          var room = Math.max(0, max - ctx.api.pens().length);
          if (n > room) return t('tb.full', { n: room });
        }
        return null;
      }

      // ---- keyboard -------------------------------------------------------------------------------
      _onKey(e) {
        var rows = this._rows || [];
        if (!rows.length) return;
        var i = 0;
        for (var j = 0; j < rows.length; j++) if (rows[j].id === this.state.focus) { i = j; break; }
        var row = rows[i];
        var n = row.kind === 'node' ? this.tree.get(row.key) : null;
        var ctx = this._ctx();
        var go = null;
        switch (e.key) {
          case 'ArrowDown': go = Math.min(rows.length - 1, i + 1); break;
          case 'ArrowUp': go = Math.max(0, i - 1); break;
          case 'Home': go = 0; break;
          case 'End': go = rows.length - 1; break;
          case 'ArrowRight':
            if (n && n.hasChildren) {
              if (!n.expanded) this._toggle(n.key, true);
              else if (i + 1 < rows.length && rows[i + 1].depth > row.depth) go = i + 1;
            }
            break;
          case 'ArrowLeft':
            if (n && n.hasChildren && n.expanded) this._toggle(n.key, false);
            else {
              var parent = n ? n.parent : row.key;
              if (parent) for (var k = 0; k < rows.length; k++) if (rows[k].id === 'n:' + parent) { go = k; break; }
            }
            break;
          case ' ': case 'Spacebar':
            if (n && n.hasChildren && n.type !== 'AtomicTag') this._toggle(n.key);
            else if (n) this._toggleSel(n, ctx);
            break;
          case 'Enter':
            if (row.kind === 'more') this._load(row.key, true);
            else if (row.kind === 'error') this._load(row.key, false);
            else if (this._selection(ctx).length) this._add();
            else if (n && n.hasChildren) this._toggle(n.key);
            break;
          default: return;
        }
        e.preventDefault();
        if (go != null) this._focusRow(rows[go].id);
      }
      /** Keyboard of the results list: ↑/↓/Home/End move, Space selects, Enter adds (on "Load more…": loads). */
      _onHitKey(e) {
        var rows = this._hitRows || [];
        if (!rows.length) return;
        var i = 0;
        for (var j = 0; j < rows.length; j++) if (rows[j].id === this.state.focus) { i = j; break; }
        var row = rows[i];
        var n = row.kind === 'hit' ? this.search.get(row.key) : null;
        var go = null;
        switch (e.key) {
          case 'ArrowDown': go = Math.min(rows.length - 1, i + 1); break;
          case 'ArrowUp': go = Math.max(0, i - 1); break;
          case 'Home': go = 0; break;
          case 'End': go = rows.length - 1; break;
          case ' ': case 'Spacebar': if (n) this._toggleSel(n, this._ctx()); break;
          case 'Enter':
            if (row.kind === 'more') this._searchMore();
            else if (this._selection(this._ctx()).length) this._add();
            else if (n) this._toggleSel(n, this._ctx());
            break;
          default: return;
        }
        e.preventDefault();
        if (go != null) this._focusRow(rows[go].id);
      }
      _focusRow(id) {
        this.set({ focus: id });
        var el = this._rowEls.get(id);
        if (el && el.focus) { try { el.focus({ preventScroll: false }); } catch (x) { el.focus(); } }
      }
      _rowRef(id) {
        var self = this;
        if (!this._refFns) this._refFns = {};
        if (!this._refFns[id]) this._refFns[id] = function (el) { if (el) self._rowEls.set(id, el); else self._rowEls.delete(id); };
        return this._refFns[id];
      }

      /** The results list's option elements (same selectable rules, check box and tooltips as the tree). */
      _hitItems(rows, focus, ctx) {
        var self = this;
        return rows.map(function (r) {
          var common = {
            key: r.id, ref: self._rowRef(r.id), role: 'option', tabIndex: r.id === focus ? 0 : -1, 'data-ctg-row': r.kind,
            onFocus: function () { if (self.state.focus !== r.id) self.set({ focus: r.id }); },
          };
          if (r.kind === 'more') {
            return h('div', Object.assign(common, { className: 'ctg-tbr-row ctg-tbr-row--more', 'aria-selected': 'false',
              'aria-busy': self.search.loadingMore ? 'true' : undefined, onClick: function () { self._searchMore(); } }),
            self.search.loadingMore ? t('tb.loading') : t('tb.more'));
          }
          var n = self.search.get(r.key);
          var st = self._status(n, ctx);
          var on = !!self.state.selected[n.key] && st.selectable;
          var attrs = Object.assign(common, {
            className: 'ctg-tbr-row' + (st.muted ? ' ctg-tbr-row--muted' : ''), 'data-ctg-path': n.path, 'data-ctg-type': n.type,
            title: n.path + (st.reason ? ' \u2014 ' + st.reason : ''), 'aria-selected': on ? 'true' : 'false',
            onClick: function () { self._toggleSel(n, ctx); self.set({ focus: r.id }); },
          });
          if (!st.selectable) attrs['aria-disabled'] = 'true';
          return h('div', attrs,
            h('span', { className: 'ctg-tbr-box' + (on ? ' ctg-tbr-box--on' : '') + (st.selectable || st.charted ? '' : ' ctg-tbr-box--none'), 'aria-hidden': 'true' },
              on || st.charted ? Icon('check') : null),
            Icon('tag'),
            h('span', { className: 'ctg-tbr-hit' },
              h('span', { className: 'ctg-tbr-name' }, n.name),
              h('span', { className: 'ctg-tbr-folder' }, n.folder)),
            h('span', { className: 'ctg-tbr-meta' }, st.charted ? t('tb.charted') : (n.dataType || '')));
        });
      }

      render() {
        var self = this;
        var api = this.props.api;
        this._sig = browserSig(api);
        var props = api.props();
        var ctx = this._ctx();
        var caps = ctx.caps;
        var frame = function (body, footer) {
          return h(PanelFrame, {
            panel: 'tagBrowser', dataCtg: 'browser', title: t('tb.title'), width: props.tagBrowser.width, responsiveWidth: props.toolbar.responsiveWidth,
            onClose: self._close, focusOnOpen: (self.props.args || {}).source !== 'openOnStart', footer: footer,
            returnFocus: (self.props.args || {}).returnFocus || null,
            headerExtra: h(IconButton, { icon: 'reload', label: t('tb.reload'), act: 'reload', disabled: !self._browseAllowed(), onClick: function () { self._reload(); } }),
          }, body);
        };
        if (caps.designMode) return frame(h('div', { className: 'ctg-pnl__body' }, Notice(t('cp.designMode'))), null);
        if (!caps.tagBrowser.allowed) {
          var why = caps.tagBrowser.reason;
          var text = why === 'FORBIDDEN_ROLE' ? t('tb.denied') : why === 'AUTH_REQUIRED' ? t('tb.login') : why === 'ACTION_DISABLED' ? t('tb.off')
            : why === 'BOUND_BIDIRECTIONAL' ? t('tb.unsafe') : t('tb.unavailable', { code: clean(why || '?') });
          return frame(h('div', { className: 'ctg-pnl__body' }, Notice(text)), null);
        }
        var searching = !!this.state.searchAll;
        var rows = searching ? this._searchRows() : this.tree.rows();
        if (searching) this._hitRows = rows;
        else this._rows = rows;
        // ref callbacks only for the rows shown (bounded while the panel stays open)
        if (this._refFns) {
          var shown = {};
          rows.forEach(function (r) { shown[r.id] = true; });
          Object.keys(this._refFns).forEach(function (id) { if (!shown[id]) delete self._refFns[id]; });
        }
        var focus = this.state.focus;
        if (!rows.some(function (r) { return r.id === focus; })) focus = rows.length ? rows[0].id : null;
        var level = function (r) { return r.depth + 1; };
        var items = searching ? this._hitItems(rows, focus, ctx) : rows.map(function (r) {
          var common = {
            key: r.id, ref: self._rowRef(r.id), role: 'treeitem', 'aria-level': level(r),
            tabIndex: r.id === focus ? 0 : -1, style: { '--ctg-depth': r.depth }, 'data-ctg-row': r.kind,
            onFocus: function () { if (self.state.focus !== r.id) self.set({ focus: r.id }); },
          };
          if (r.kind === 'more') {
            var mf = self.tree.get(r.key);
            return h('div', Object.assign(common, { className: 'ctg-tbr-row ctg-tbr-row--more', 'aria-busy': mf && mf.loading ? 'true' : undefined,
              onClick: function () { self._load(r.key, true); } }), mf && mf.loading ? t('tb.loading') : t('tb.more'));
          }
          if (r.kind === 'loading') return h('div', Object.assign(common, { className: 'ctg-tbr-row ctg-tbr-row--msg', 'aria-disabled': 'true' }), t('tb.loading'));
          if (r.kind === 'empty') {
            var ef = self.tree.get(r.key);
            return h('div', Object.assign(common, { className: 'ctg-tbr-row ctg-tbr-row--msg', 'aria-disabled': 'true' }), ef && ef.filtered ? t('tb.emptyFiltered') : t('tb.empty'));
          }
          if (r.kind === 'error') {
            var f = self.tree.get(r.key);
            return h('div', Object.assign(common, { className: 'ctg-tbr-row ctg-tbr-row--error', 'data-code': f && f.error && f.error.code,
              title: t('tb.retry'), onClick: function () { self._load(r.key, false); } }),
            h('span', { className: 'ctg-tbr-name' }, errText(f && f.error)), h('span', { className: 'ctg-tbr-meta' }, t('tb.retry')));
          }
          var n = self.tree.get(r.key);
          var st = self._status(n, ctx);
          var folder = !!st.folder;
          var on = !!self.state.selected[n.key] && st.selectable;
          var attrs = Object.assign(common, {
            className: 'ctg-tbr-row' + (st.muted ? ' ctg-tbr-row--muted' : ''), 'data-ctg-path': n.path, 'data-ctg-type': n.type,
            title: n.path + (st.reason ? ' \u2014 ' + st.reason : ''),
            onClick: function () { if (folder) self._toggle(n.key); else self._toggleSel(n, ctx); self.set({ focus: r.id }); },
          });
          if (folder) attrs['aria-expanded'] = n.expanded ? 'true' : 'false';
          else if (st.selectable) attrs['aria-selected'] = on ? 'true' : 'false';
          else attrs['aria-disabled'] = 'true';
          var icon = n.type === 'Provider' ? 'provider' : n.type === 'UdtInstance' || n.type === 'UdtType' ? 'udt' : folder ? 'folder' : 'tag';
          return h('div', attrs,
            folder ? h('span', { className: 'ctg-tbr-twisty' + (n.expanded ? ' ctg-tbr-twisty--open' : ''), 'aria-hidden': 'true' }, Icon('chevron'))
              : h('span', { className: 'ctg-tbr-box' + (on ? ' ctg-tbr-box--on' : '') + (st.selectable || st.charted ? '' : ' ctg-tbr-box--none'), 'aria-hidden': 'true' },
                on || st.charted ? Icon('check') : null),
            Icon(icon),
            h('span', { className: 'ctg-tbr-name' }, n.name),
            h('span', { className: 'ctg-tbr-meta' }, st.charted ? t('tb.charted') : folder ? (n.type !== 'Folder' ? t('tb.type.' + n.type) : '') : (n.dataType || '')));
        });
        var filterId = this.idp + '-filter';
        var helpId = this.idp + '-help';
        var fieldLabel = searching ? t('tb.search.placeholder') : t('tb.filter');
        var line = searching ? this.search.statusLine() : null;
        var list;
        if (!searching) {
          list = h('div', {
            key: 'tree', className: 'ctg-tbr-tree', role: 'tree', 'aria-label': t('tb.tree'), 'aria-multiselectable': 'true',
            'aria-describedby': helpId + '-keys', title: t('tb.keys'), 'data-ctg': 'browser-tree', onKeyDown: this._treeKey,
          }, items);
        } else if (items.length) {
          list = h('div', {
            key: 'hits', className: 'ctg-tbr-tree', role: 'listbox', 'aria-label': t('tb.search.results'), 'aria-multiselectable': 'true',
            'aria-busy': this.search.status === 'running' ? 'true' : undefined, 'aria-describedby': helpId + '-keys',
            title: t('tb.search.keys'), 'data-ctg': 'browser-search', onKeyDown: this._hitKey,
          }, items);
        } else {
          // nothing to list yet: a hint while the text is too short (the status line covers running / none / errors)
          // only for text that is really too short (valid text waiting for the debounce is not "too short")
          var hint = this.search.status === 'idle' && this.state.filter.trim() && !searchable(this.state.filter) ? t('tb.search.short') : null;
          list = h('div', { key: 'hits', className: 'ctg-tbr-tree', 'data-ctg': 'browser-search' },
            hint ? h('div', { className: 'ctg-tbr-row ctg-tbr-row--msg' }, hint) : null);
        }
        var body = [
          h('div', { key: 'tools', className: 'ctg-tbr-tools' },
            h('input', {
              id: filterId, type: 'search', className: 'ctg-input', value: this.state.filter, placeholder: fieldLabel,
              'aria-label': fieldLabel, 'aria-describedby': helpId, 'data-ctg-initial-focus': '1', spellCheck: false, autoComplete: 'off',
              'data-ctg-field': 'browser-filter',
              onChange: function (e) {
                self.set({ filter: e.target.value });
                if (self.state.searchAll) self._searchNow();
                else self._filterNow();
              },
              onKeyDown: function (e) {
                if (e.key === 'ArrowDown' && focus) { e.preventDefault(); self._focusRow(focus); }
                else if (e.key === 'Enter' && self.state.searchAll) {
                  // search now (also: search again with the same text)
                  e.preventDefault();
                  self._searchNow.cancel();
                  self._searchFromInput(true);
                }
                // Escape in a non-empty filter clears it (as a search field does) instead of closing the
                // panel and throwing the selection away; an Escape on an empty filter still closes. In search mode it
                // also stops a running search.
                else if (e.key === 'Escape' && (self.state.filter || self.search.status === 'running')) {
                  e.preventDefault();
                  e.stopPropagation();
                  self.set({ filter: '' });
                  if (self.state.searchAll) { self._stopSearch(true); self.bump(); }
                  else self._filterNow();
                }
              },
            })),
          h('label', { key: 'mode', className: 'ctg-tbr-mode', title: t('tb.searchAllHelp') },
            h('input', { type: 'checkbox', checked: searching, 'data-ctg-act': 'search-all',
              onChange: function (e) { self._setSearchAll(!!e.target.checked); } }),
            t('tb.searchAll')),
          h('div', { key: 'help', id: helpId, className: 'ctg-tbr-help' }, searching ? t('tb.search.help') : t('tb.filterHelp')),
          line ? h('div', { key: 'status', className: 'ctg-tbr-status' + (line.tone === 'error' ? ' ctg-tbr-status--error' : ''),
            role: 'status', 'aria-live': 'polite', 'data-ctg': 'browser-search-status', 'data-ctg-state': this.search.status },
          h('span', null, line.text),
          line.act === 'cancel' ? h('button', { type: 'button', className: 'ctg-pnl__link', 'data-ctg-act': 'cancel-search',
            onClick: function () { self._cancelSearch(); } }, t('tb.search.cancel')) : null,
          line.act === 'retry' ? h('button', { type: 'button', className: 'ctg-pnl__link', 'data-ctg-act': 'retry-search',
            onClick: function () { self._retrySearch(); } }, t('tb.search.retry')) : null) : null,
          // keyboard help for screen readers (common .ctg-sr-only); sighted users get it as the list's tooltip
          h('div', { key: 'keys', id: helpId + '-keys', className: 'ctg-sr-only' }, searching ? t('tb.search.keys') : t('tb.keys')),
          list,
        ];
        var sel = this._selection(ctx);
        var check = this._addCheck(ctx, sel.length);
        var res = this.state.result;
        var resultEl = null;
        if (res) {
          resultEl = h('div', { key: 'res', className: 'ctg-tbr-footer-text', 'data-ctg': 'browser-result' },
            res.error ? h('div', { className: 'ctg-pnl__error', role: 'alert' }, t('tb.failed', { message: res.error })) : h('div', null, res.text),
            res.duplicates ? h('div', null, t('tb.duplicates', { n: res.duplicates })) : null,
            res.rejected && res.rejected.length ? h('div', { className: 'ctg-pnl__error' }, t('tb.rejected'),
              h('ul', { className: 'ctg-tbr-results', 'data-ctg': 'browser-rejected' }, res.rejected.map(function (r, i) {
                return h('li', { key: i, title: r.tagPath, 'data-ctg-path': r.tagPath }, NS.util.shortTagName(r.tagPath) + ' \u2014 ' + r.text);
              }))) : null);
        }
        var footer = [
          h('div', { key: 'target', className: 'ctg-tbr-footer-text' },
            ctx.target === 'trendList' ? t('tb.target.trend', { group: ctx.group }) : t('tb.target.pens')),
          check ? h('div', { key: 'chk', className: 'ctg-tbr-footer-text ctg-pnl__error', role: 'status' }, check) : null,
          resultEl,
          h('div', { key: 'sp', className: 'ctg-pnl__spacer' }),
          sel.length ? h('button', { key: 'clr', type: 'button', className: 'ctg-pnl__link', 'data-ctg-act': 'clear-selection',
            onClick: function () { self.set({ selected: {}, result: null }); } }, t('tb.clear')) : null,
          h(NS.ui.Button, {
            key: 'add', kind: 'primary', disabled: !sel.length || !!check || this.state.busy, 'aria-busy': this.state.busy ? 'true' : undefined,
            'data-ctg-act': 'add-selected', onClick: function () { self._add(); },
          }, this.state.busy ? h(NS.ui.Spinner, null) : null, t('tb.add', { n: sel.length })),
        ];
        return frame(body, footer);
      }
    }

    // the search model and the text rule, for tests (NS.chartPanels.TagBrowser.SearchModel / .searchable)
    TagBrowser.SearchModel = TagSearchModel;
    TagBrowser.searchable = searchable;

    /* ========================================================================
     * SECTION 8b / AnnotationEditor — add, edit and delete notes
     * ----------------------------------------------------------------------
     * Panel 'annotation' (dock 'none'): an
     * anchored NS.ui.Dialog at the click on the plot. The chart opens it in
     * annotate mode (click = note, drag = range, click a marker = that entry)
     * with args:
     *   {mode 'add'|'edit', type 'note'|'range', start, end, penKey,
     *    penKeys (the plot's pens with history), item (edit), anchorRect,
     *    onSaved({entry, replacedId}), onDeleted({id})}
     * Fields: pen (only the plot's pens; fixed when editing), type (add
     * only), time(s) to the second in the chart's time zone, text (≤ 1000,
     * counter), colour (palette or default). Save -> chart.annotationSave,
     * Delete (inline confirmation) -> chart.annotationDelete, both through
     * api.request (the gateway is the authority: gates, ownership, quota,
     * author). The callbacks let the chart draw the change at once (dashed)
     * and re-read until the historian shows it.
     *
     * Read-only view: no edit capability, Designer design mode, the chart
     * disabled, an entry without an id (written by another tool), or —
     * with annotations.edit.ownOnly — another author's entry without
     * moderation (mirrors the gateway's NOT_OWNER rule; text only).
     * ====================================================================== */
    var ANN_MAX_TEXT = 1000;
    var ANN_DEFAULT_RANGE_MS = 15 * 60 * 1000;      // a range typed from a click starts 15 min long
    var ANN_INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
    /** epoch ms -> the value of an <input type="datetime-local" step="1"> in zone tz. */
    function annInputValue(ms, tz) {
      return NS.util.isFiniteNum(ms) ? NS.time.format(ms, 'YYYY-MM-DDTHH:mm:ss', tz) : '';
    }
    /** An entry colour as stored: '#rrggbb', or '' = the chart's default (validColor('') is true, hexOf('') is black). */
    function annColorOf(c) { return c && String(c).trim() && validColor(c) ? hexOf(c) : ''; }
    /**
     * The value of such an input in zone tz -> epoch ms, or NaN. A wall time that occurs twice (the repeated hour of
     * a fall-back clock change) resolves with the UTC offset of `hint` (the instant the field was seeded with: the
     * edited entry's time, or the clicked time) when that offset fits; else the first occurrence (so an entry at
     * the second 01:30 is not moved to the first, one hour earlier).
     */
    function annParseInput(v, tz, hint) {
      var r = annResolve(v, tz, hint);
      return r ? r.ms : NaN;
    }
    /** {ms, overlap, offset} for an input value (see annParseInput), or null. */
    function annResolve(v, tz, hint) {
      var m = ANN_INPUT_RE.exec(String(v == null ? '' : v).trim());
      if (!m) return null;
      var r = NS.time.zonedToEpoch({ y: +m[1], M: +m[2], d: +m[3], h: +m[4], m: +m[5], s: m[6] ? +m[6] : 0 }, tz);
      if (!isFinite(r.ms)) return null;
      var ms = r.ms;
      if (r.note === 'overlap' && NS.util.isFiniteNum(hint)) {
        var wall = r.ms + NS.time.offset(r.ms, tz);
        var c = wall - NS.time.offset(hint, tz);
        if (NS.time.offset(c, tz) === wall - c) ms = c;
      }
      return { ms: ms, overlap: r.note === 'overlap', offset: NS.time.offset(ms, tz) };
    }
    /** "+HH:MM" / "−HH:MM" of an offset in ms. */
    function annOffsetText(off) {
      var mins = Math.round(off / 60000), a = Math.abs(mins);
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      return (mins < 0 ? '−' : '+') + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
    }
    /**
     * A field's epoch ms: the instant it was seeded with when its text is unchanged (exact, whatever the zone's
     * clock changes), else the parsed text resolved with that instant's offset.
     */
    function annFieldMs(text, seed, tz) {
      if (NS.util.isFiniteNum(seed) && String(text == null ? '' : text).trim() === annInputValue(seed, tz)) return seed;
      return annParseInput(text, tz, seed);
    }
    /**
     * May the session change entry `item` (null = a new entry)? caps = api.capabilities(); ownOnly = the
     * chart's annotations.edit.ownOnly. The gateway decides again (NOT_OWNER); this only greys the editor.
     */
    function annCanEdit(caps, item, ownOnly) {
      if (!caps || caps.designMode || !caps.enabled || !caps.annotations || !caps.annotations.editAllowed) return false;
      if (!item) return true;
      if (!item.id) return false;                                   // no storage id: the gateway cannot address it
      // an anonymous session owns nothing (all anonymous sessions share the gateway's
      // 'Unauthenticated' name; the gateway's AnnotationService.isOwn refuses them too).
      var own = !!item.author && !!caps.user && item.author === caps.user && caps.user !== 'Unauthenticated';
      return own || ownOnly === false || !!caps.annotations.moderateAllowed;
    }
    /**
     * The save body for the editor state (pure; Node-tested). Returns {body} or {error: field -> text key}.
     * s = {type, penTagPath, start, end, text, color}; item = the edited entry or null; tz = chart zone;
     * seed = {start, end}: the instants the fields were seeded with (default: the item's), kept exactly while the
     * field text is unchanged (so a text-only edit of a note in a repeated DST hour does not move it 1 h back).
     */
    function annSaveBody(s, item, tz, seed) {
      var err = {};
      var sd = seed || (item ? { start: item.start, end: item.end } : {});
      var start = annFieldMs(s.start, sd.start, tz);
      if (!isFinite(start)) err.start = 'an.invalidTime';
      var end = null;
      if (s.type === 'range') {
        end = annFieldMs(s.end, sd.end, tz);
        if (!isFinite(end)) err.end = 'an.invalidTime';
        else if (isFinite(start) && end <= start) err.end = 'an.rangeOrder';
      }
      var text = String(s.text == null ? '' : s.text).trim();
      if (!text) err.text = 'an.textRequired';
      else if (text.length > ANN_MAX_TEXT) err.text = 'an.textLong';
      if (!s.penTagPath) err.pen = 'an.noPen';
      if (Object.keys(err).length) return { error: err };
      var body = { tagPath: s.penTagPath, type: s.type === 'range' ? 'range' : 'note', start: start, text: text,
        color: annColorOf(s.color) };
      if (body.type === 'range') body.end = end;
      // the entry id is `annotationId`: `id` is the delegate envelope's request id
      if (item && item.id) { body.annotationId = item.id; body.oldStart = item.start; }
      return { body: body };
    }

    class AnnotationEditor extends RComponent {
      constructor(props) {
        super(props);
        var a = props.args || {};
        var api = props.api;
        var it = a.item || null;
        this.tz = api.timeZone();
        this.uid = NS.util.uid('ctg-an');
        // one position object for the dialog's lifetime (a new object per render would re-layout every time)
        this._position = { anchorRect: a.anchorRect || null };
        var start = NS.util.isFiniteNum(a.start) ? a.start : api.now();
        var end = NS.util.isFiniteNum(a.end) ? a.end : start + ANN_DEFAULT_RANGE_MS;
        this._seed = { start: start, end: end };          // exact instants behind the field texts
        this.state = {
          type: a.type === 'range' ? 'range' : 'note', penKey: a.penKey || (a.penKeys && a.penKeys[0]) || null,
          start: annInputValue(start, this.tz), end: annInputValue(end, this.tz),
          text: it ? String(it.text || '').slice(0, ANN_MAX_TEXT) : '', color: it && it.color ? it.color : '',
          busy: false, error: null, fieldErr: {}, confirmDelete: false,
        };
        var self = this;
        this._requestClose = function () { if (!self.state.busy) self.props.close(); };
      }
      componentDidMount() { this._alive = true; }
      componentWillUnmount() { this._alive = false; }
      set(patch) { if (this._alive) this.setState(patch); }
      /** Pen view-models the editor may attach the entry to (the plot's pens with history; the entry's own when editing). */
      _pens() {
        var a = this.props.args || {};
        var keys = Array.isArray(a.penKeys) ? a.penKeys : [];
        var all = this.props.api.pens();
        return keys.map(function (k) { return all.filter(function (vm) { return vm.key === k; })[0]; }).filter(Boolean);
      }
      _pen() {
        var k = this.state.penKey;
        var list = this._pens();
        for (var i = 0; i < list.length; i++) if (list[i].key === k) return list[i];
        var it = this.props.args && this.props.args.item;
        // an edited entry whose pen left the chart meanwhile: keep its tag (the gateway answers STALE_TARGET)
        return it ? { key: it.penKey, tagPath: it.tagPath, label: NS.util.shortTagName(it.tagPath) } : null;
      }
      _save() {
        var self = this;
        var api = this.props.api;
        var a = this.props.args || {};
        var it = a.item || null;
        if (this.state.busy) return;
        var pen = this._pen();
        var r = annSaveBody({ type: this.state.type, penTagPath: pen && pen.tagPath, start: this.state.start, end: this.state.end,
          text: this.state.text, color: this.state.color }, it, this.tz, this._seed);
        if (r.error) { this.set({ fieldErr: r.error, error: null }); return; }
        this.set({ busy: true, error: null, fieldErr: {} });
        var caps = api.capabilities();
        api.request('chart.annotationSave', r.body, { timeoutMs: 15000 }).then(function (res) {
          if (res && res.ok) {
            var d = res.data || {};
            var b = r.body;
            // reported even when the editor closed meanwhile: the entry exists on the gateway
            if (typeof a.onSaved === 'function') {
              try {
                a.onSaved({
                  entry: { id: typeof d.id === 'string' ? d.id : null, penKey: pen.key, tagPath: pen.tagPath, type: b.type, start: b.start,
                    end: b.type === 'range' ? b.end : null, text: b.text, author: it ? it.author : caps.user, color: b.color || null,
                    created: it && it.created ? it.created : Date.now(), ours: true },
                  replacedId: it ? it.id : null,
                });
              } catch (e) { log.warn('onSaved failed', e); }
            }
            NS.a11y.announce(t(it ? 'an.savedEdit' : 'an.saved'));
            if (self._alive) self.props.close();
            return;
          }
          self.set({ busy: false, error: t('an.failed', { message: errText(res && res.error) }) });
        });
      }
      _delete() {
        var self = this;
        var api = this.props.api;
        var a = this.props.args || {};
        var it = a.item;
        if (!it || !it.id || this.state.busy) return;
        this.set({ busy: true, error: null, confirmDelete: false });
        api.request('chart.annotationDelete', { tagPath: it.tagPath, annotationId: it.id, start: it.start }, { timeoutMs: 15000 }).then(function (res) {
          if (res && res.ok) {
            if (typeof a.onDeleted === 'function') { try { a.onDeleted({ id: it.id }); } catch (e) { log.warn('onDeleted failed', e); } }
            NS.a11y.announce(t('an.deleted'));
            if (self._alive) self.props.close();
            return;
          }
          self.set({ busy: false, error: t('an.deleteFailed', { message: errText(res && res.error) }) });
        });
      }
      _swatches(disabled) {
        var self = this;
        var pal = (this.props.api.props().appearance.palette || []).filter(validColor).slice(0, 10);
        var cur = annColorOf(this.state.color);
        var opts = [''].concat(pal.map(hexOf).filter(function (c, i, arr) { return arr.indexOf(c) === i; }));
        return h('div', { className: 'ctg-an-swatches', role: 'radiogroup', 'aria-label': t('an.color'), 'data-ctg': 'annotation-colors' },
          opts.map(function (c) {
            var on = c === cur;
            return h('button', {
              key: c || 'default', type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', disabled: disabled,
              className: 'ctg-an-swatch' + (c ? '' : ' ctg-an-swatch--default'), title: c || t('an.colorDefault'),
              'aria-label': c || t('an.colorDefault'), 'data-color': c,
              style: c ? { backgroundColor: NS.props.color(c) || undefined } : undefined,
              onClick: function () { self.set({ color: c }); },
            }, c ? null : t('an.colorDefault'));
          }));
      }
      render() {
        var self = this;
        var api = this.props.api;
        var a = this.props.args || {};
        var it = a.item || null;
        var caps = api.capabilities();
        if (caps.designMode) { closeSoon(this.props.close); return null; }
        var ownOnly = api.props().annotations.edit.ownOnly;
        var editable = annCanEdit(caps, it, ownOnly);
        var busy = this.state.busy;
        var dis = busy || !editable;
        var s = this.state;
        var fe = s.fieldErr || {};
        var id = function (k) { return self.uid + '-' + k; };
        var pens = this._pens();
        var pen = this._pen();
        var title = !editable && it ? t(it.type === 'range' ? 'an.titleViewRange' : 'an.titleView')
          : it ? t(it.type === 'range' ? 'an.titleEditRange' : 'an.titleEdit')
            : t(s.type === 'range' ? 'an.titleAddRange' : 'an.titleAddNote');
        var body = [];
        if (!editable) {
          var why = !it ? t('an.readOnlyCap', { reason: errText(caps.annotations.reason || 'ACTION_DISABLED') })
            : !it.id ? t('an.foreign') : !caps.annotations.editAllowed || caps.designMode || !caps.enabled
              ? t('an.readOnlyCap', { reason: errText(caps.annotations.reason || (caps.enabled ? 'ACTION_DISABLED' : 'DISABLED')) })
              : t('an.readOnly');
          body.push(h('p', { key: 'ro', className: 'ctg-pnl__muted', 'data-ctg': 'annotation-readonly' }, why));
        }
        if (!it && !pens.length) {
          body.push(h('p', { key: 'nopen', className: 'ctg-field__error', role: 'alert' }, t('an.noPen')));
        }
        if (!it) {
          body.push(h(NS.ui.Field, { key: 'type', id: id('type'), label: t('an.type') },
            h(NS.ui.Choice, { id: id('type'), ariaLabel: t('an.type'), value: s.type,
              options: [{ value: 'note', label: t('an.type.note'), disabled: dis }, { value: 'range', label: t('an.type.range'), disabled: dis }],
              onChange: function (v) { self.set({ type: v, fieldErr: {} }); } })));
        }
        body.push(h(NS.ui.Field, { key: 'pen', id: id('pen'), label: t('an.pen'), error: fe.pen ? t(fe.pen) : null },
          it || pens.length <= 1
            ? h('div', { id: id('pen'), className: 'ctg-an-pen', 'data-ctg': 'annotation-pen' }, pen ? pen.label : '—')
            : h('select', { id: id('pen'), className: 'ctg-select', value: s.penKey || '', disabled: dis, 'data-ctg': 'annotation-pen',
              onChange: function (e) { self.set({ penKey: e.target.value }); } },
            pens.map(function (vm) { return h('option', { key: vm.key, value: vm.key }, vm.label); }))));
        var timeField = function (k, label) {
          // a wall time that occurs twice says which one is kept (as the date range modal does)
          var rv = annResolve(s[k], self.tz, self._seed ? self._seed[k] : null);
          var help = rv && rv.overlap ? t('an.overlap', { offset: annOffsetText(rv.offset) })
            : k === 'start' ? t('an.timeHelp', { tz: self.tz }) : null;
          return h(NS.ui.Field, { key: k, id: id(k), label: label, error: fe[k] ? t(fe[k]) : null, help: help },
            h('input', { id: id(k), className: 'ctg-input', type: 'datetime-local', step: 1, value: s[k], disabled: dis,
              'data-ctg': 'annotation-' + k, onChange: function (e) { var p = {}; p[k] = e.target.value; self.set(p); } }));
        };
        var isRange = it ? it.type === 'range' : s.type === 'range';
        body.push(timeField('start', t(isRange ? 'an.start' : 'an.time')));
        if (isRange) body.push(timeField('end', t('an.end')));
        body.push(h(NS.ui.Field, { key: 'text', id: id('text'), label: t('an.text'), error: fe.text ? t(fe.text) : null,
          help: t('an.count', { n: s.text.length, max: ANN_MAX_TEXT }) },
          h('textarea', { id: id('text'), className: 'ctg-input ctg-an-text', rows: 4, maxLength: ANN_MAX_TEXT, value: s.text,
            readOnly: dis, 'data-ctg': 'annotation-text', spellCheck: true,
            onChange: function (e) { self.set({ text: String(e.target.value).slice(0, ANN_MAX_TEXT) }); },
            onKeyDown: function (e) { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (editable) self._save(); } } })));
        if (editable) body.push(h(NS.ui.Field, { key: 'color', id: id('color'), label: t('an.color') }, this._swatches(dis)));
        if (it) {
          var meta = [it.author ? t('an.author', { author: it.author }) : t('an.authorUnknown')];
          if (NS.util.isFiniteNum(it.created)) meta.push(t('an.created', { time: NS.time.format(it.created, 'YYYY-MM-DD HH:mm', this.tz) }));
          if (it.editedBy) meta.push(t('an.editedBy', { user: it.editedBy }));
          body.push(h('p', { key: 'meta', className: 'ctg-pnl__muted', 'data-ctg': 'annotation-meta' }, meta.join(' · ')));
        }
        if (s.error) body.push(h('p', { key: 'err', className: 'ctg-field__error', role: 'alert', 'data-ctg': 'annotation-error' }, s.error));
        var footer;
        if (s.confirmDelete) {
          footer = h('div', { className: 'ctg-an-actions', role: 'group', 'aria-label': t('an.deleteConfirm') },
            h('span', { className: 'ctg-an-confirm' }, t('an.deleteConfirm')),
            h(NS.ui.Button, { kind: 'secondary', onClick: function () { self.set({ confirmDelete: false }); } }, t('an.cancel')),
            h(NS.ui.Button, { kind: 'danger', 'data-ctg-act': 'annotation-delete-confirm', onClick: function () { self._delete(); } }, t('an.delete')));
        } else {
          footer = h('div', { className: 'ctg-an-actions' },
            it && editable ? h(NS.ui.Button, { kind: 'danger', disabled: busy, 'data-ctg-act': 'annotation-delete', className: 'ctg-an-delete',
              onClick: function () { self.set({ confirmDelete: true }); } }, t('an.delete')) : null,
            h(NS.ui.Button, { kind: 'secondary', disabled: busy, 'data-ctg-act': 'annotation-cancel', onClick: this._requestClose },
              t(editable ? 'an.cancel' : 'an.close')),
            editable ? h(NS.ui.Button, { kind: 'primary', disabled: busy || (!it && !pens.length), 'data-ctg-act': 'annotation-save',
              'aria-busy': busy ? 'true' : undefined, onClick: function () { self._save(); } }, busy ? t('an.saving') : t('an.save')) : null);
        }
        return h(NS.ui.Dialog, {
          title: title, className: 'ctg-an-editor', position: this._position, busy: busy,
          initialFocus: editable ? 'textarea' : '[data-ctg-act="annotation-cancel"]', onRequestClose: this._requestClose, footer: footer,
        }, h('div', { 'data-ctg': 'annotation-editor', 'data-mode': it ? 'edit' : 'add', 'data-chart-id': api.id,
          'data-ann-id': it && it.id ? it.id : '' }, body));
      }
    }
    /** Closes on the next tick (closing inside render would set state of the chart during its render). */
    function closeSoon(close) { setTimeout(function () { try { close(); } catch (e) { /* ignore */ } }, 0); }

    /* ========================================================================
     * SECTION 9 / registration + NS.chartPanels (test surface)
     * ----------------------------------------------------------------------
     * The chart renders an open panel with def.render(api, args, close) inside
     * its own error boundary, on every chart render; returning a component
     * element keeps the panel's state across those renders (same type, same
     * slot). Built-in slot names: 'settings' (right group button),
     * 'tagBrowser' (Tags button, left).
     * ====================================================================== */
    NS.chart.panels.register('settings', {
      dock: 'right',
      button: { label: NS.i18n.t('chart.btn.settings'), icon: 'settings', title: t('sp.title') },
      render: function (api, args, close) { return h(SettingsPanel, { api: api, args: args, close: close }); },
    });
    NS.chart.panels.register('tagBrowser', {
      dock: 'left',
      button: { label: NS.i18n.t('chart.btn.tags'), icon: 'tags', title: t('tb.title') },
      render: function (api, args, close) { return h(TagBrowser, { api: api, args: args, close: close }); },
    });
    // no toolbar button (the chart opens it from the plot in annotate mode); one element per OPENING so a new
    // click on the plot remounts the editor with that click's time / pen instead of keeping the previous draft
    var annOpenGen = typeof WeakMap === 'function' ? new WeakMap() : null;
    var annOpenSeq = 0;
    NS.chart.panels.register('annotation', {
      dock: 'none',
      render: function (api, args, close) {
        if (api.capabilities().designMode) return null;
        var key = 'annotation';
        if (args && typeof args === 'object' && annOpenGen) {
          var g = annOpenGen.get(args);
          if (g == null) { g = ++annOpenSeq; annOpenGen.set(args, g); }
          key += ':' + g;
        }
        ensureStyles();
        return h(AnnotationEditor, { key: key, api: api, args: args || {}, close: close });
      },
    });

    NS.chartPanels = {
      // pure model (Node tests)
      defaultPen: defaultPen, defaultOverride: defaultOverride, defaultAxis: defaultAxis, defaultPlot: defaultPlot,
      defaultMarker: defaultMarker, defaultDisplay: defaultDisplay, AGGREGATIONS: AGGREGATIONS, DASHES: DASHES,
      INTERPOLATIONS: INTERPOLATIONS, BAD_STYLES: BAD_STYLES, defaultStates: defaultStates, oobLimits: oobLimits,        // per-state styles
      PEN_COLUMN_IDS: PEN_COLUMN_IDS, RANGE_COLUMN_IDS: RANGE_COLUMN_IDS, MAX_PLOTS: MAX_PLOTS,
      copy: copy, stableJson: stableJson, setIn: setIn, moveItem: moveItem, uniqueName: uniqueName,
      addTarget: addTarget, scopeOf: scopeOf, folderScopeOf: folderScopeOf, parseNum: parseNum, validColor: validColor,
      hexOf: hexOf, dashName: dashName, penRows: penRows, overrideIndex: overrideIndex, overrideOf: overrideOf,
      setOverride: setOverride, effectiveOverride: effectiveOverride, defaultsLocks: defaultsLocks, addAxis: addAxis, renameAxis: renameAxis, deleteAxis: deleteAxis, addPlot: addPlot,
      removePlot: removePlot, addPenError: addPenError, TagTree: TagTree, DraftStore: DraftStore,
      // patch operations (SECTION 2b)
      resolvePen: resolvePen, resolveAxis: resolveAxis, penFieldOp: penFieldOp, movePenOp: movePenOp, addPensOp: addPensOp,
      deletePenOp: deletePenOp, overrideFieldOp: overrideFieldOp, overrideDisplayOp: overrideDisplayOp, axisFieldOp: axisFieldOp,
      addAxisOp: addAxisOp, dropAxisOp: dropAxisOp, renameAxisIn: renameAxisIn, renameAxisOp: renameAxisOp, plotRefOf: plotRefOf,
      resolvePlot: resolvePlot, plotIdOf: plotIdOf, newPlotId: newPlotId, plotFieldOp: plotFieldOp, addMarkerOp: addMarkerOp, removeMarkerOp: removeMarkerOp, addPlotOp: addPlotOp,
      removePlotOps: removePlotOps,
      // components
      SettingsPanel: SettingsPanel, TagBrowser: TagBrowser, PanelFrame: PanelFrame, DraftInput: DraftInput,
      // annotation editor
      AnnotationEditor: AnnotationEditor, annInputValue: annInputValue, annParseInput: annParseInput, annCanEdit: annCanEdit,
      annSaveBody: annSaveBody, annColorOf: annColorOf,
      PANEL_CSS: PANEL_CSS, DEBOUNCE_MS: DEBOUNCE_MS,
    };
  }
})();
