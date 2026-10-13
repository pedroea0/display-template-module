/* ============================================================================
 * ctg-chart-tools.js — Click To Graph Chart add-on: tools (date range, colour picker, export)
 * ============================================================================
 *
 * Part id: 'chartTools' (needs 'common' and 'chart'). Loaded as its own browser
 * resource, separate from the chart engine: the three tools register into
 * NS.chart.panels whenever this file loads, and the chart shows their toolbar
 * entries once they are registered.
 *
 *   slot 'dateRange'  DateRangeModal   the date pill opens it
 *   slot 'color'      ColorPicker      the pen-table swatch opens it with
 *                                      args {penKey, anchorRect}; an embedding
 *                                      panel may pass args.onPick (SECTION 6)
 *   slot 'export'     ExportMenu       the toolbar Export button opens it
 *
 * Everything here talks to the chart ONLY through the frozen ChartApi that
 * render(api, args, close) receives — never through engine internals — plus
 * the shared NS.* library of ctg-common.js (NS.ui overlays, NS.time zone
 * maths, NS.i18n, NS.theme). Prop changes are whole-object writes of ONE root
 * key built from the RAW prop value (api.patch: what the view stores stays,
 * only the edit changes), never nested paths.
 *
 *   SECTION 1   strings (NS.i18n part 'chartTools')
 *   SECTION 2   shared helpers: gates, clone, deferred close, downloads, toasts
 *   SECTION 3   date-range model (pure): local-time fields, validation, presets
 *   SECTION 4   DateRangeModal (Realtime | Historical tabs)
 *   SECTION 5   colour model (pure): hex parsing, swatches, the prop write
 *   SECTION 6   ColorPicker (anchored dialog: swatch grid, hex, native, default)
 *   SECTION 7   export model (pure): CSV cells/injection guard, rows, file names
 *   SECTION 8   ExportMenu (CSV visible/loaded/raw, PNG)
 *   SECTION 9   stylesheet, registration, NS.chart.tools (Node-tested helpers)
 *
 * Availability (see also the schema's `enabled` description):
 *   - nothing opens in Designer design mode (the chart refuses panels.open
 *     there; each render() also returns null defensively);
 *   - every tool closes itself when its toolbar toggle / capability is off
 *     (toolbar.buttons.dateRange, toolbar.buttons.export + export.csv/png,
 *     penTable.allowColorChange);
 *   - `enabled = false` disables what CHANGES the chart's configuration (the
 *     colour picker); the date range and export are viewing actions and stay,
 *     exactly as the schema's `enabled` description and the chart's toolbar
 *     define them.
 *   - export is hidden in the Perspective mobile app: the chart's
 *     capabilities().nativeApp plus Perspective's own ClientStore.nativeType.
 * ============================================================================ */
(function () {
  'use strict';

  var NS = window.__CTG = window.__CTG || {};
  NS.loaded = NS.loaded || {};
  NS.ready = NS.ready || {};
  NS._queue = NS._queue || [];

  var PART = 'chartTools';
  var src = document.currentScript && document.currentScript.src;
  var BUILD = (src && new URL(src, location.href).searchParams.get('v')) || 'dev';
  if (NS.loaded[PART]) {
    if (NS.loaded[PART] !== BUILD) {
      console.warn('[CTG]', PART, BUILD, 'ignored; page runs', NS.loaded[PART], '- reload the page');
    }
    return;
  }
  NS.loaded[PART] = BUILD;

  NS._queue.push({ part: PART, needs: ['common', 'chart'], init: initTools });
  if (NS._drain) NS._drain();

  function initTools(NS) {
    var W = window;
    var PC = W.PerspectiveClient;
    var React = W.React;
    var h = React.createElement;
    var RComponent = (React && React.Component) || PC.Component;
    var hasOwn = Object.prototype.hasOwnProperty;
    var log = NS.log('ctg.chart.tools');

    var SECOND = 1000;
    var MINUTE = 60 * SECOND;
    var HOUR = 60 * MINUTE;
    var DAY = 24 * HOUR;
    var UNITS = ['seconds', 'minutes', 'hours', 'days', 'weeks', 'months', 'years'];

    /* ========================================================================
     * SECTION 1 / strings — every user-facing text of this part
     * ====================================================================== */
    NS.i18n.register(PART, {
      // date range modal
      'tools.date.title': 'Date range',
      'tools.date.tabs': 'Range type',
      'tools.date.tab.realtime': 'Realtime',
      'tools.date.tab.historical': 'Historical',
      'tools.date.showLast': 'Show the last',
      'tools.date.amount': 'Amount',
      'tools.date.unit': 'Unit',
      'tools.date.presets': 'Quick picks',
      'tools.date.from': 'From {start} to now',
      'tools.date.refresh': 'Refreshes every {every}.',
      'tools.date.refreshOff': 'Auto refresh off.',
      'tools.date.start': 'Start',
      'tools.date.end': 'End',
      'tools.date.zone': 'Times are in {zone}.',
      'tools.date.quick': 'Quick ranges',
      'tools.date.now': 'Now',
      'tools.date.lastShift': 'Last shift (−8 h)',
      'tools.date.today': 'Today',
      'tools.date.yesterday': 'Yesterday',
      'tools.date.apply': 'Apply',
      'tools.date.cancel': 'Cancel',
      'tools.date.failed': 'The date range could not be changed.',
      'tools.date.err.value': 'Enter a whole number of 1 or more.',
      'tools.date.err.empty': 'Enter a date and time.',
      'tools.date.err.invalid': 'Enter a valid date and time.',
      'tools.date.err.startFuture': 'The start must be in the past.',
      'tools.date.err.order': 'The end must be after the start.',
      'tools.date.err.short': 'The range must be at least 1 second long.',
      'tools.date.err.tooLong': 'The range is longer than the gateway allows ({days} days).',
      'tools.date.err.tooLongRaw': 'Raw data is limited to {days} days: choose a shorter range or aggregated data.',
      'tools.date.note.gap': '{time} does not exist on this date; using {used}.',
      'tools.date.note.overlap': '{time} occurs twice on this date; using the first one (UTC{offset}).',
      'tools.date.note.future': 'The end is in the future: the chart shows data up to now.',
      'tools.unit.seconds': 'seconds', 'tools.unit.second': 'second',
      'tools.unit.minutes': 'minutes', 'tools.unit.minute': 'minute',
      'tools.unit.hours': 'hours', 'tools.unit.hour': 'hour',
      'tools.unit.days': 'days', 'tools.unit.day': 'day',
      'tools.unit.weeks': 'weeks', 'tools.unit.week': 'week',
      'tools.unit.months': 'months', 'tools.unit.month': 'month',
      'tools.unit.years': 'years', 'tools.unit.year': 'year',
      'tools.short.seconds': '{n} s', 'tools.short.minutes': '{n} min', 'tools.short.hours': '{n} h',
      'tools.short.days': '{n} d', 'tools.short.weeks': '{n} wk', 'tools.short.months': '{n} mo', 'tools.short.years': '{n} y',
      'tools.every.ms': '{n} ms',
      'tools.every.s': '{n} s',
      'tools.every.min': '{n} min',
      // colour picker
      'tools.color.title': 'Colour: {name}',
      'tools.color.titlePlain': 'Colour',
      'tools.color.swatches': 'Colours',
      'tools.color.hex': 'Hex colour',
      'tools.color.hexHelp': '#RGB or #RRGGBB',
      'tools.color.hexInvalid': 'Use #RGB or #RRGGBB (for example #2F7ED8).',
      'tools.color.apply': 'Apply',
      'tools.color.more': 'More…',
      'tools.color.moreTitle': 'Pick any colour',
      'tools.color.default': 'Default',
      'tools.color.defaultTitle': 'Use the automatic colour of this pen',
      'tools.color.failed': 'The colour could not be changed.',
      // export
      'tools.export.menu': 'Export',
      'tools.export.csv': 'Export CSV',
      'tools.export.png': 'Export PNG',
      'tools.export.cancel': 'Cancel export',
      // a raw export outlives its menu; the chart's unmount cancels it with a notice
      'tools.export.background': 'The export continues; the file is saved when the data arrives.',
      'tools.export.cancelled': 'Export cancelled.',
      'tools.export.busy': 'Exporting CSV…',
      'tools.export.busyHint': 'Loading raw data',
      'tools.export.hint.visible': 'Visible range',
      'tools.export.hint.loaded': 'All loaded data',
      'tools.export.hint.raw': 'Raw samples of the visible range',
      'tools.export.hint.png': 'Image of the chart',
      'tools.export.native': 'Export is not available in the mobile app',
      'tools.export.done': 'Exported {rows} rows to {file}.',
      'tools.export.donePng': 'Exported {file}.',
      'tools.export.empty': 'There is no data to export in this range.',
      'tools.export.noImage': 'There is nothing to export yet.',
      'tools.export.failed': 'Export failed: {message}',
      'tools.export.rawPartial': 'Raw export: no data for {pens}.',
      'tools.export.rawAggregated': 'Raw export: {pens} had too many raw points, aggregated data was exported.',
      'tools.export.aggregated': 'Aggregated data exported for {pens}: one row per bucket value, stamped with the bucket start (MinMax: two rows per bucket).',
      'tools.export.rawTooLong': 'Raw export is limited to {days} days, so the visible data was exported. Zoom in to export raw samples.',
      'tools.export.rawFallback': 'Raw samples are not available for this range, so the visible data was exported.',
      'tools.export.time': 'Time',
      'tools.export.pen': 'Pen',
      'tools.export.value': 'Value',
      'tools.export.quality': 'Quality',
      'tools.export.qualitySuffix': '{label} quality',
      // the raw CSV's quality words, the fallback file name and the canvas failure go through NS.i18n too
      'tools.export.good': 'Good',
      'tools.export.bad': 'Bad',
      'tools.export.fileFallback': 'chart',
      'tools.export.canvasFailed': 'the image could not be created',
    });
    function t(key, vars) { return NS.i18n.t(key, vars, PART); }

    /* ========================================================================
     * SECTION 2 / shared helpers
     * ----------------------------------------------------------------------
     * Gates read only api.capabilities() / api.props(). A tool whose gate is
     * closed renders nothing and closes itself after the current render (a
     * close() inside render would be a setState during render).
     * ====================================================================== */
    /** JSON deep copy of a reduced (frozen) props value: plain, mutable, no non-enumerable extras. */
    function clone(x) { return x == null ? x : JSON.parse(JSON.stringify(x)); }

    /** Calls close() once, after the current render pass. */
    function closeLater(close) {
      Promise.resolve().then(function () { try { close(); } catch (e) { log.warn('close failed', e); } });
    }

    /** Perspective's own native-app type ('none' | 'ios' | 'android' | 'workstation'); null when unknown. */
    function perspectiveNativeType() {
      try {
        var cs = PC && PC.ClientStore;
        var v = cs && cs.nativeType;
        return typeof v === 'string' ? v : null;
      } catch (e) { return null; }
    }
    /**
     * True inside the Perspective mobile app. The chart's capabilities().nativeApp reads
     * session.props.device.type (the browser reports "browser"; the app supplies its own device data);
     * Perspective's ClientStore.nativeType ('ios' | 'android') is the second, client-side signal.
     */
    function inMobileApp(caps) {
      if (caps && caps.nativeApp) return true;
      var nt = perspectiveNativeType();
      return nt === 'ios' || nt === 'android';
    }

    /**
     * Whether a tool may show now: {ok, reason}. Design mode and the chart's own capability flags first,
     * then the tool's toggle. `args.onPick` (an embedding panel owns the colour) skips the pen-table toggle.
     */
    function toolGate(api, name, args) {
      var caps = api.capabilities();
      var p = api.props();
      if (caps.designMode) return { ok: false, reason: 'designMode' };
      if (name === 'dateRange') return p.toolbar.buttons.dateRange ? { ok: true } : { ok: false, reason: 'toggle' };
      if (name === 'export') {
        if (!p.toolbar.buttons.export) return { ok: false, reason: 'toggle' };
        if (!(p.export.csv.enabled || p.export.png.enabled)) return { ok: false, reason: 'toggle' };
        return { ok: true };
      }
      if (name === 'color') {
        if (!caps.enabled) return { ok: false, reason: 'disabled' };
        if (!(args && typeof args.onPick === 'function') && !p.penTable.allowColorChange) return { ok: false, reason: 'toggle' };
        return { ok: true };
      }
      return { ok: false, reason: 'unknown' };
    }

    /** The toolbar element under an anchor rect (so a second click on it toggles instead of re-opening). */
    function anchorElement(rect) {
      if (!rect || typeof document.elementFromPoint !== 'function') return null;
      try {
        var x = (rect.left + (rect.right != null ? rect.right : rect.left + (rect.width || 0))) / 2;
        var y = (rect.top + (rect.bottom != null ? rect.bottom : rect.top + (rect.height || 0))) / 2;
        var el = document.elementFromPoint(x, y);
        return el ? (el.closest ? el.closest('button,[role="button"],[data-ctg-panel]') || el : el) : null;
      } catch (e) { return null; }
    }

    function toast(text, tone) {
      try { NS.ui.Toast.show({ key: 'ctg-chart-tools', text: text, tone: tone || 'error', durationMs: 8000 }); } catch (e) { log.warn(text); }
    }

    /**
     * Saves a Blob as a file: an <a download> click; where the attribute is missing (old embedded
     * browsers) the blob URL opens in a new tab instead. The URL is revoked a minute later (revoking at
     * once can cancel the download in some browsers). Throws when neither works (popup blocked).
     */
    function downloadBlob(blob, fileName) {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      try {
        if ('download' in a) {
          a.href = url;
          a.download = fileName;
          a.rel = 'noopener';
          a.style.display = 'none';
          document.body.appendChild(a);
          a.click();
          if (a.parentNode) a.parentNode.removeChild(a);
        } else {
          // no 'noopener' feature: with it window.open() returns null by spec even when the tab opened;
          // the opener link is cut by hand instead. null here really means a popup blocker.
          var w = W.open(url, '_blank');
          if (!w) throw new Error('blocked');
          try { w.opener = null; } catch (e) { /* ignore */ }
        }
      } finally {
        setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 60000);
      }
    }

    /* ========================================================================
     * SECTION 3 / date-range model (pure; Node-tested)
     * ----------------------------------------------------------------------
     * The modal edits a DRAFT {tab, rtValue, rtUnit, startText, endText}; the
     * text fields hold <input type="datetime-local" step="1"> values
     * ("YYYY-MM-DDTHH:mm:ss") meaning wall time in the CHART time zone
     * (api.timeZone(), e.g. the session's zone) — not the browser's. They are
     * converted with NS.time.zonedToEpoch, which reports DST gaps (the time is
     * moved forward, a note says so) and overlaps (the first occurrence, a
     * note says so). evaluateRange() is the single
     * source of truth for errors, notes, the resulting window and the
     * timeRange object to write.
     * ====================================================================== */
    var LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

    /** Epoch ms -> datetime-local value in tz ("YYYY-MM-DDTHH:mm:ss"). */
    function toLocalInput(ms, tz) {
      return typeof ms === 'number' && isFinite(ms) ? NS.time.format(ms, 'YYYY-MM-DD[T]HH:mm:ss', tz) : '';
    }
    /** datetime-local value -> {y, M, d, h, m, s, ms} or null (also null for impossible dates such as 02-30). */
    function parseLocalInput(text) {
      var m = LOCAL_RE.exec(String(text == null ? '' : text).trim());
      if (!m) return null;
      var f = { y: +m[1], M: +m[2], d: +m[3], h: +m[4], m: +m[5], s: m[6] ? +m[6] : 0, ms: m[7] ? +(m[7] + '00').slice(0, 3) : 0 };
      if (f.y < 1970 || f.y > 9999 || f.M < 1 || f.M > 12 || f.h > 23 || f.m > 59 || f.s > 59) return null;
      var dim = new Date(Date.UTC(2000, 0, 1));
      dim.setUTCFullYear(f.y, f.M, 0);                        // day 0 of the next month = last day of this month
      if (f.d < 1 || f.d > dim.getUTCDate()) return null;
      return f;
    }
    /** "02:30" (or "02:30:15" when seconds are set) of parsed fields. */
    function fieldsTime(f) {
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      return pad(f.h) + ':' + pad(f.m) + (f.s ? ':' + pad(f.s) : '');
    }
    /** "+05:30" style offset of tz at ms. */
    function offsetText(ms, tz) {
      var off = Math.round(NS.time.offset(ms, tz) / 60000);
      var a = Math.abs(off);
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      return (off < 0 ? '−' : '+') + pad(Math.floor(a / 60)) + ':' + pad(a % 60);
    }

    /** "15 min" style label of a preset (its own label wins). */
    function presetLabel(pr) {
      if (pr && pr.label) return String(pr.label);
      return t('tools.short.' + pr.unit, { n: pr.value });
    }
    /** "8 hours" / "1 hour". */
    function unitWord(n, unit) { return t('tools.unit.' + (n === 1 ? unit.replace(/s$/, '') : unit)); }
    /** "Refreshes every 1 s." / "Auto refresh off." */
    function refreshText(rr) {
      if (!(rr > 0)) return t('tools.date.refreshOff');
      var every = rr < SECOND ? t('tools.every.ms', { n: rr })
        : rr < MINUTE ? t('tools.every.s', { n: Math.round(rr / 100) / 10 })
          : t('tools.every.min', { n: Math.round(rr / 6000) / 10 });
      return t('tools.date.refresh', { every: every });
    }

    /**
     * Maximum span for this chart's query settings, in days: raw-only charts (query.mode "raw" without
     * the aggregate fallback) are bound by limits.maxRawRangeDays; everything else may be aggregated and
     * is bound by limits.maxRangeDays (the same rule as the chart's planQuery).
     */
    function spanLimit(p, L) {
      var rawOnly = p.query.mode === 'raw' && p.query.onTooManyPoints !== 'aggregate';
      return { days: rawOnly ? L.maxRawRangeDays : L.maxRangeDays, raw: rawOnly };
    }

    /**
     * The modal's initial draft. Realtime fields from timeRange.realtime; historical fields from the
     * configured historical window, or (realtime charts) from what is visible now, so "Historical" starts
     * at the current view — Power Chart behaviour.
     */
    function initialDraft(p, ctx) {
      var tr = p.timeRange;
      var tz = ctx.tz;
      var s = null, e = null;
      if (tr.mode === 'historical' && ctx.window && ctx.window.start != null) { s = ctx.window.start; e = ctx.window.end; }
      else if (ctx.viewport && ctx.viewport.min != null && ctx.viewport.max != null) { s = ctx.viewport.min; e = ctx.viewport.max; }
      if (!(s < e)) { e = ctx.now; s = e - 8 * HOUR; }
      return {
        tab: tr.mode === 'historical' ? 'historical' : 'realtime',
        rtValue: String(tr.realtime.value), rtUnit: tr.realtime.unit,
        startText: toLocalInput(Math.floor(s / SECOND) * SECOND, tz), endText: toLocalInput(Math.floor(e / SECOND) * SECOND, tz),
      };
    }

    /** One historical field -> {ms, error, note}. */
    function evalLocal(text, tz) {
      if (!String(text == null ? '' : text).trim()) return { ms: null, error: t('tools.date.err.empty'), note: null };
      var f = parseLocalInput(text);
      if (!f) return { ms: null, error: t('tools.date.err.invalid'), note: null };
      var r = NS.time.zonedToEpoch(f, tz);
      if (!isFinite(r.ms)) return { ms: null, error: t('tools.date.err.invalid'), note: null };
      var note = null;
      if (r.note === 'gap') {
        var usedPat = f.s || (r.ms % MINUTE) ? 'HH:mm:ss' : 'HH:mm';
        note = t('tools.date.note.gap', { time: fieldsTime(f), used: NS.time.format(r.ms, usedPat, tz) });
      } else if (r.note === 'overlap') {
        note = t('tools.date.note.overlap', { time: fieldsTime(f), offset: offsetText(r.ms, tz) });
      }
      return { ms: r.ms, error: null, note: note, gap: r.note === 'gap', overlap: r.note === 'overlap' };
    }

    /**
     * Validates a draft: start < end, span >= 1 s, span <= the gateway limit for the
     * chart's query mode, realtime amount a whole number >= 1, the start not in the future.
     * The span checks use the window the chart will SHOW, [start, min(end, now)] (a start
     * 1 h ago with an end 401 days in the future is a 1 h window, not "longer than 400 days"; a start just before now
     * with a future end can be shorter than 1 s); the end > start order check uses the typed values.
     * ctx = {p, now, tz, limits}. Returns {valid, errors:{value, start, end, range}, notes:{start, end},
     * window:{start, end, span} | null, timeRange (the whole reduced-shape object) | null, patch (the partial object
     * written with ChartApi.patch: mode + realtime {value, unit} or mode + historical {startDate, endDate}) | null}.
     */
    function evaluateRange(draft, ctx) {
      var p = ctx.p, tz = ctx.tz, now = ctx.now;
      var lim = spanLimit(p, ctx.limits);
      var errors = { value: null, start: null, end: null, range: null };
      var notes = { start: null, end: null };
      var win = null, tr = null, patch = null;
      var tooLong = function () {
        return t(lim.raw ? 'tools.date.err.tooLongRaw' : 'tools.date.err.tooLong', { days: lim.days });
      };
      var base = clone(p.timeRange);
      // keep the stored dates as Date objects (the schema type is "date"; the reducer reads both)
      var hist = function (s, e) { return { startDate: s == null ? null : new Date(s), endDate: e == null ? null : new Date(e) }; };
      if (draft.tab === 'realtime') {
        var txt = String(draft.rtValue == null ? '' : draft.rtValue).trim();
        var n = /^\d{1,7}$/.test(txt) ? Number(txt) : NaN;
        var unit = UNITS.indexOf(draft.rtUnit) >= 0 ? draft.rtUnit : 'hours';
        if (!(n >= 1)) errors.value = t('tools.date.err.value');
        else {
          var start = NS.time.subtractCalendar(now, n, unit, tz);
          if (!isFinite(start)) errors.value = t('tools.date.err.value');
          else {
            win = { start: start, end: now, span: now - start };
            if (win.span > lim.days * DAY) errors.range = tooLong();
          }
        }
        if (!errors.value && !errors.range) {
          tr = Object.assign(base, { mode: 'realtime', realtime: { value: n, unit: unit },
            historical: hist(p.timeRange.historical.startDate, p.timeRange.historical.endDate) });
          patch = { mode: 'realtime', realtime: { value: n, unit: unit } };
        }
      } else {
        var s = evalLocal(draft.startText, tz);
        var e = evalLocal(draft.endText, tz);
        errors.start = s.error; errors.end = e.error;
        notes.start = s.note; notes.end = e.note;
        if (!s.error && s.ms >= now) errors.start = t('tools.date.err.startFuture');
        if (!s.error && !e.error) {
          var shownEnd = Math.min(e.ms, now);           // the chart shows data up to now
          if (!(e.ms > s.ms)) errors.end = t('tools.date.err.order');
          else if (shownEnd - s.ms < SECOND) errors.end = t('tools.date.err.short');
          else if (shownEnd - s.ms > lim.days * DAY) errors.range = tooLong();
          // (one second of slack: an end filled with "now" a moment ago is not "in the future")
          if (!errors.end && e.ms > now + SECOND && !notes.end) notes.end = t('tools.date.note.future');
          win = { start: s.ms, end: shownEnd, span: shownEnd - s.ms };
        }
        if (!errors.start && !errors.end && !errors.range) {
          tr = Object.assign(base, { mode: 'historical', historical: hist(s.ms, e.ms) });
          patch = { mode: 'historical', historical: hist(s.ms, e.ms) };
        }
      }
      var valid = !errors.value && !errors.start && !errors.end && !errors.range && !!tr;
      return { valid: valid, errors: errors, notes: notes, window: win, timeRange: valid ? tr : null, patch: valid ? patch : null };
    }

    /** True when `tr` describes the same window as the chart's current props (mode + its own fields). */
    function sameWindow(p, tr) {
      var cur = p.timeRange;
      if (cur.mode !== tr.mode) return false;
      if (tr.mode === 'realtime') return cur.realtime.value === tr.realtime.value && cur.realtime.unit === tr.realtime.unit;
      var ms = function (d) { return d == null ? null : typeof d === 'number' ? d : d.getTime(); };
      return cur.historical.startDate === ms(tr.historical.startDate) && cur.historical.endDate === ms(tr.historical.endDate);
    }

    /** Quick-range buttons of the Historical tab -> new {startText?, endText?} for the draft. */
    function quickRange(kind, draft, now, tz) {
      var midnight = function (ms) {
        var f = NS.time.parts(ms, tz);
        return NS.time.zonedToEpoch({ y: f.y, M: f.M, d: f.d, h: 0, m: 0, s: 0 }, tz).ms;
      };
      var nowS = Math.floor(now / SECOND) * SECOND;
      if (kind === 'now') return { endText: toLocalInput(nowS, tz) };
      if (kind === 'lastShift') {
        var e = evalLocal(draft.endText, tz);
        var end = e.error ? nowS : Math.min(e.ms, nowS);
        return { startText: toLocalInput(end - 8 * HOUR, tz), endText: toLocalInput(end, tz) };
      }
      var today = midnight(now);
      if (kind === 'today') return { startText: toLocalInput(today, tz), endText: toLocalInput(nowS, tz) };
      if (kind === 'yesterday') {
        var y = NS.time.subtractCalendar(today, 1, 'days', tz);
        return { startText: toLocalInput(y, tz), endText: toLocalInput(today, tz) };
      }
      return {};
    }

    /* ========================================================================
     * SECTION 4 / DateRangeModal
     * ----------------------------------------------------------------------
     * NS.ui.Dialog (portal to body, aria-modal, focus trap, Esc through the
     * page overlay manager, focus returns to the opener = the date pill).
     * Tabs Realtime | Historical (APG tabs: roving tabindex, arrow keys).
     * Enter in a field applies; Apply stays disabled while the draft is
     * invalid; every error sits next to its field (aria-describedby).
     * Apply: one ChartApi.patch('timeRange', {mode, realtime | historical})
     * (only these fields change in the RAW prop; nothing the reducer
     * fills in or clamps is persisted) — the engine then reloads with a
     * reset viewport by itself and this modal fires
     * onRangeChange. Re-applying the SAME window resets the zoom instead (the
     * chart fires onRangeChange for that itself).
     * ====================================================================== */
    class DateRangeModal extends RComponent {
      constructor(props) {
        super(props);
        var api = props.api;
        this.uid = NS.util.uid('ctg-dr');
        this.state = initialDraft(api.props(), {
          tz: api.timeZone(), now: api.now(), viewport: api.viewport.get(), window: api.status().window,
        });
        var self = this;
        this._onKeyDown = function (e) {
          if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
          var tag = e.target && e.target.tagName;
          if (tag !== 'INPUT' && tag !== 'SELECT') return;     // buttons keep their own Enter
          e.preventDefault();
          self._apply();
        };
        this._requestClose = function () { self.props.close(); };
      }
      _ctx() {
        var api = this.props.api;
        return { p: api.props(), now: api.now(), tz: api.timeZone(), limits: api.limits() };
      }
      _apply() {
        // one apply per opening: a second activation in the same tick (double click, Enter + click)
        // would otherwise write timeRange twice and reload the chart back to back
        if (this._applied) return false;
        var api = this.props.api;
        var ctx = this._ctx();
        var r = evaluateRange(this.state, ctx);
        if (!r.valid) return false;
        if (sameWindow(ctx.p, r.timeRange)) {
          this._applied = true;
          api.viewport.reset();                 // fires onRangeChange (debounced) itself
        } else if (api.patch('timeRange', r.patch)) {
          this._applied = true;
          api.fireEvent('onRangeChange', { mode: r.timeRange.mode, start: Math.round(r.window.start), end: Math.round(r.window.end) });
        } else {
          // refused (design mode, unmounted chart, store error): keep the modal and the user's draft open
          log.debug('timeRange write refused');
          toast(t('tools.date.failed'));
          return false;
        }
        this.props.close();
        return true;
      }
      _setTab(tab) {
        if (tab !== this.state.tab) this.setState({ tab: tab });
      }
      _renderTabs() {
        var self = this;
        var tabs = ['realtime', 'historical'];
        return h('div', {
          className: 'ctg-tools-tabs', role: 'tablist', 'aria-label': t('tools.date.tabs'),
          onKeyDown: function (e) {
            var dir = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            var to = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs[1] : dir ? tabs[(tabs.indexOf(self.state.tab) + dir + 2) % 2] : null;
            if (!to) return;
            e.preventDefault();
            self._setTab(to);
            var btn = e.currentTarget.querySelector('[data-tab="' + to + '"]');
            if (btn) btn.focus();
          },
        }, tabs.map(function (tab) {
          var on = self.state.tab === tab;
          return h('button', {
            key: tab, type: 'button', role: 'tab', id: self.uid + '-tab-' + tab, 'data-tab': tab, className: 'ctg-tools-tab',
            'aria-selected': on ? 'true' : 'false', 'aria-controls': self.uid + '-panel-' + tab, tabIndex: on ? 0 : -1,
            onClick: function () { self._setTab(tab); },
          }, t('tools.date.tab.' + tab));
        }));
      }
      _renderRealtime(r, p, ctx) {
        var self = this;
        var st = this.state;
        var idV = this.uid + '-value', idU = this.uid + '-unit';
        var presets = (p.timeRange.presets || []).map(function (pr, i) {
          var on = String(pr.value) === String(st.rtValue).trim() && pr.unit === st.rtUnit;
          return h('button', {
            key: i, type: 'button', className: 'ctg-tools-chip', 'aria-pressed': on ? 'true' : 'false', 'data-preset': i,
            onClick: function () { self.setState({ rtValue: String(pr.value), rtUnit: pr.unit }); },
          }, presetLabel(pr));
        });
        var help = r.window && !r.errors.value ? t('tools.date.from', { start: NS.time.format(r.window.start, 'YYYY-MM-DD HH:mm:ss', ctx.tz) }) : null;
        return h('div', null,
          h('div', { className: 'ctg-tools-legend', id: this.uid + '-showlast' }, t('tools.date.showLast')),
          h('div', { className: 'ctg-tools-row', role: 'group', 'aria-labelledby': this.uid + '-showlast' },
            h(NS.ui.Field, { id: idV, label: t('tools.date.amount'), error: r.errors.value },
              h('input', {
                id: idV, className: 'ctg-input', type: 'number', min: 1, step: 1, inputMode: 'numeric', value: st.rtValue,
                'data-ctg-first': '1', 'data-ctg-field': 'rtValue',
                onChange: function (e) { self.setState({ rtValue: e.target.value }); },
              })),
            h(NS.ui.Field, { id: idU, label: t('tools.date.unit') },
              h('select', {
                id: idU, className: 'ctg-select', value: st.rtUnit, 'data-ctg-field': 'rtUnit',
                onChange: function (e) { self.setState({ rtUnit: e.target.value }); },
              }, UNITS.map(function (u) { return h('option', { key: u, value: u }, unitWord(Number(st.rtValue) === 1 ? 1 : 2, u)); })))),
          r.errors.range ? h('div', { className: 'ctg-tools-error', role: 'alert', id: this.uid + '-range' }, r.errors.range) : null,
          help ? h('div', { className: 'ctg-tools-help' }, help) : null,
          presets.length ? h('div', { className: 'ctg-tools-legend', id: this.uid + '-presets' }, t('tools.date.presets')) : null,
          presets.length ? h('div', { className: 'ctg-tools-chips', role: 'group', 'aria-labelledby': this.uid + '-presets' }, presets) : null,
          h('div', { className: 'ctg-tools-help' }, refreshText(p.timeRange.refreshRate)));
      }
      _renderHistorical(r, p, ctx) {
        var self = this;
        var st = this.state;
        var idS = this.uid + '-start', idE = this.uid + '-end';
        var note = function (text) { return text ? h('span', { className: 'ctg-tools-note' }, text) : null; };
        var quick = ['now', 'lastShift', 'today', 'yesterday'].map(function (k) {
          return h('button', {
            key: k, type: 'button', className: 'ctg-tools-chip', 'data-quick': k,
            onClick: function () { self.setState(quickRange(k, self.state, self.props.api.now(), ctx.tz)); },
          }, t('tools.date.' + k));
        });
        return h('div', null,
          h('div', { className: 'ctg-tools-row ctg-tools-row--dates' },
            h(NS.ui.Field, { id: idS, label: t('tools.date.start'), error: r.errors.start, help: note(r.notes.start) },
              h('input', {
                id: idS, className: 'ctg-input', type: 'datetime-local', step: 1, value: st.startText, 'data-ctg-first': '1',
                'data-ctg-field': 'start', onChange: function (e) { self.setState({ startText: e.target.value }); },
              })),
            h(NS.ui.Field, { id: idE, label: t('tools.date.end'), error: r.errors.end, help: note(r.notes.end) },
              h('input', {
                id: idE, className: 'ctg-input', type: 'datetime-local', step: 1, value: st.endText, 'data-ctg-field': 'end',
                onChange: function (e) { self.setState({ endText: e.target.value }); },
              }))),
          r.errors.range ? h('div', { className: 'ctg-tools-error', role: 'alert', id: this.uid + '-range' }, r.errors.range) : null,
          h('div', { className: 'ctg-tools-legend', id: this.uid + '-quick' }, t('tools.date.quick')),
          h('div', { className: 'ctg-tools-chips', role: 'group', 'aria-labelledby': this.uid + '-quick' }, quick),
          h('div', { className: 'ctg-tools-help' }, t('tools.date.zone', { zone: ctx.tz })));
      }
      render() {
        var api = this.props.api;
        if (!toolGate(api, 'dateRange').ok) { closeLater(this.props.close); return null; }
        var ctx = this._ctx();
        var p = ctx.p;
        var r = evaluateRange(this.state, ctx);
        var tab = this.state.tab;
        var self = this;
        var footer = [
          h(NS.ui.Button, { key: 'c', kind: 'secondary', 'data-ctg-cancel': '1', onClick: this._requestClose }, t('tools.date.cancel')),
          h(NS.ui.Button, {
            key: 'a', kind: 'primary', 'data-ctg-apply': '1', disabled: !r.valid,
            'aria-describedby': r.errors.range ? this.uid + '-range' : undefined,
            onClick: function () { self._apply(); },
          }, t('tools.date.apply')),
        ];
        return h(NS.ui.Dialog, {
          title: t('tools.date.title'), className: 'ctg-tools-date', width: 'min(460px, calc(100vw - 32px))',
          initialFocus: '[data-ctg-first]', onRequestClose: this._requestClose, onKeyDown: this._onKeyDown, footer: footer,
        }, h('div', { 'data-ctg': 'date-modal', 'data-chart-id': api.id },
          this._renderTabs(),
          h('div', {
            role: 'tabpanel', id: this.uid + '-panel-' + tab, 'aria-labelledby': this.uid + '-tab-' + tab, 'data-tabpanel': tab,
            // a fresh subtree per tab, so the first field of the new tab mounts cleanly
            key: tab,
          }, tab === 'realtime' ? this._renderRealtime(r, p, ctx) : this._renderHistorical(r, p, ctx))));
      }
    }

    /* ========================================================================
     * SECTION 5 / colour model (pure; Node-tested)
     * ----------------------------------------------------------------------
     * Colours reach the chart only as validated "#RRGGBB" strings (the chart
     * checks them again with CSS.supports before drawing).
     * A static pen's colour lives in pens[i].color; a trend pen's in the
     * trendPens.overrides entry matched on normKey(tagPath) — both written
     * with ChartApi.patch on the RAW root: only that one field changes; other
     * pens keep exactly what the view stores.
     * ====================================================================== */
    /** Eight extra swatches that keep >= 3:1 contrast on #FFFFFF, #1E1E1E and #323232 plot backgrounds. */
    var EXTRA_COLORS = ['#1E88E5', '#2CA02C', '#9467BD', '#F4511E', '#B8860B', '#0097A7', '#7F7F7F', '#689F38'];
    var SWATCH_COLS = 6;

    /** "#abc" / "abc" / "#AABBCC" -> "#AABBCC"; anything else -> null. */
    function normalizeHex(s) {
      var m = /^\s*#?([0-9a-f]{3}|[0-9a-f]{6})\s*$/i.exec(String(s == null ? '' : s));
      if (!m) return null;
      var x = m[1];
      if (x.length === 3) x = x.charAt(0) + x.charAt(0) + x.charAt(1) + x.charAt(1) + x.charAt(2) + x.charAt(2);
      return '#' + x.toUpperCase();
    }
    /** Swatch list: the chart palette (valid hex only) then the extras, de-duplicated case-insensitively. */
    function swatchColors(palette) {
      var seen = {}, out = [];
      (palette || []).concat(EXTRA_COLORS).forEach(function (c) {
        var x = normalizeHex(c);
        if (x && !seen[x]) { seen[x] = true; out.push(x); }
      });
      return out;
    }
    /** The pen's EXPLICIT colour from props ('' = automatic): pens[i].color or its trend override. */
    function explicitColor(p, vm) {
      if (!vm) return '';
      if (vm.source === 'trend') {
        var k = NS.util.normKey(vm.tagPath);
        for (var i = 0; i < p.trendPens.overrides.length; i++) {
          var ov = p.trendPens.overrides[i];
          if (NS.util.normKey(ov.tagPath) === k) return ov.color || '';
        }
        return '';
      }
      for (var j = 0; j < p.pens.length; j++) if (p.pens[j].index === vm.index) return p.pens[j].color || '';
      return '';
    }
    /**
     * The ChartApi.patch that gives pen `vm` the colour `color` ('' = back to automatic):
     * {key:'pens'|'trendPens', fn(raw) -> raw} or null when there is nothing to write (an invalid colour, a static pen
     * without a raw index, or clearing a trend pen that has no override). fn edits the RAW root only where needed:
     *   pens       the pen at its raw index (vm.index, the reducer's index) while it still names vm's tag, else the
     *              first raw entry with that normKey(tagPath); a pen that is gone changes nothing
     *   trendPens  the first override matched on normKey(tagPath) (created with {tagPath, color} when missing)
     * Every other pen / override and every field the reducer would fill in stays exactly as stored (writing
     * the whole reduced array back would persist the reducer's normalisation of every pen).
     */
    function colorPatch(p, vm, color) {
      if (!vm) return null;
      var c = color ? normalizeHex(color) : '';
      if (color && !c) return null;
      var k = NS.util.normKey(vm.tagPath);
      var same = function (x) { return NS.util.isPlainObject(x) && NS.util.normKey(x.tagPath) === k; };
      if (vm.source === 'trend') {
        if (!c && !explicitColor(p, vm)) return null;
        return { key: 'trendPens', fn: function (tp) {
          if (!Array.isArray(tp.overrides)) tp.overrides = [];
          for (var i = 0; i < tp.overrides.length; i++) {
            if (same(tp.overrides[i])) { tp.overrides[i].color = c; return tp; }
          }
          if (c) tp.overrides.push({ tagPath: vm.tagPath, color: c });
          return tp;
        } };
      }
      if (typeof vm.index !== 'number') return null;
      return { key: 'pens', fn: function (pens) {
        var i = same(pens[vm.index]) ? vm.index : -1;
        for (var j = 0; i < 0 && j < pens.length; j++) if (same(pens[j])) i = j;
        if (i >= 0) pens[i].color = c;
        return pens;
      } };
    }

    /* ========================================================================
     * SECTION 6 / ColorPicker
     * ----------------------------------------------------------------------
     * An ANCHORED NS.ui.Dialog next to the swatch (placeNear: flipped and
     * clamped into the visual viewport). A dialog rather than a transient
     * popover on purpose: the page overlay manager closes transients on window
     * blur, and the native colour chooser ("More…") blurs the window. Clicking
     * outside (the transparent backdrop) or Esc closes it.
     *
     * args: {penKey, anchorRect, value?, onPick?, title?}
     *   onPick(color)  an embedding panel receives the
     *                  colour ('' = automatic) instead of a prop write
     *   value          initial colour for onPick callers
     * Picking a swatch, Enter in the hex field, Apply or Default applies and
     * closes; the native chooser applies live (debounced) and keeps it open.
     * A direct pick writes pens / trendPens and fires onPensChange {action:
     * "edit", tagPath, source}.
     * ====================================================================== */
    class ColorPicker extends RComponent {
      constructor(props) {
        super(props);
        this.uid = NS.util.uid('ctg-cp');
        // one position object for the dialog's lifetime (a new object per render would re-layout every time)
        this._position = { anchorRect: (props.args && props.args.anchorRect) || null };
        var cur = this._current();
        this.state = { hex: cur || '', hexError: null };
        var self = this;
        this._requestClose = function () { self.props.close(); };
        this._liveTimer = null;
        this._pendingNative = null;     // a native pick still inside the 200 ms debounce
        this._done = false;             // a closing apply happened: later activations are ignored
        this._onNative = function (e) {
          var v = normalizeHex(e.target.value);
          if (!v || self._done) return;
          self.setState({ hex: v, hexError: null });
          self._pendingNative = v;
          if (self._liveTimer) clearTimeout(self._liveTimer);
          self._liveTimer = setTimeout(function () {
            self._liveTimer = null;
            var pv = self._pendingNative;
            self._pendingNative = null;
            if (self._alive && pv) self._apply(pv, true);
          }, 200);
        };
      }
      componentDidMount() { this._alive = true; }
      componentWillUnmount() {
        this._alive = false;
        if (this._liveTimer) clearTimeout(this._liveTimer);
        this._liveTimer = null;
        // The native chooser applies live, so a pick made just before Esc / an outside click is kept:
        // flush it once — unless the tool may no longer change colours (gate closed it, design mode,
        // chart disabled) or the chart itself is going away (write refused -> no toast).
        var pv = this._pendingNative;
        this._pendingNative = null;
        if (pv && !this._done) {
          var gate;
          try { gate = toolGate(this.props.api, 'color', this.props.args); } catch (e) { gate = { ok: false }; }
          if (gate.ok) this._apply(pv, true, true);
        }
      }
      _vm() {
        var key = this.props.args && this.props.args.penKey;
        if (key == null) return null;
        var list = this.props.api.pens();
        for (var i = 0; i < list.length; i++) if (list[i].key === key) return list[i];
        return null;
      }
      /** The colour shown as selected: args.value (embedding callers), else the pen's explicit colour. */
      _current() {
        var a = this.props.args || {};
        if (a.value != null) return normalizeHex(a.value) || '';
        return normalizeHex(explicitColor(this.props.api.props(), this._vm())) || '';
      }
      /**
       * Applies `color` ('' = automatic). keepOpen for the live native chooser; quiet suppresses the
       * failure toast (the unmount flush). A closing apply happens once per opening: a second
       * activation in the same tick (double click, Enter + click) is ignored.
       */
      _apply(color, keepOpen, quiet) {
        if (this._done) return;
        if (!keepOpen) {
          this._done = true;
          // a closing pick supersedes a native pick still inside the debounce
          if (this._liveTimer) { clearTimeout(this._liveTimer); this._liveTimer = null; }
          this._pendingNative = null;
        }
        var a = this.props.args || {};
        var api = this.props.api;
        if (typeof a.onPick === 'function') {
          try { a.onPick(color); } catch (e) { log.warn('onPick failed', e); }
        } else {
          var vm = this._vm();
          var w = colorPatch(api.props(), vm, color);
          if (w) {
            if (api.patch(w.key, w.fn)) api.fireEvent('onPensChange', { action: 'edit', tagPath: vm.tagPath, source: vm.source });
            else if (!quiet) toast(t('tools.color.failed'));
          }
        }
        if (!keepOpen) this.props.close();
      }
      _applyHex() {
        var v = normalizeHex(this.state.hex);
        if (!v) { this.setState({ hexError: t('tools.color.hexInvalid') }); return; }
        this._apply(v);
      }
      _renderSwatches(colors, selected) {
        var self = this;
        var sel = colors.indexOf(selected);
        var focusAt = function (grid, i) {
          var n = grid && grid.querySelectorAll('[role="option"]')[i];
          if (n) n.focus();
        };
        return h('div', {
          className: 'ctg-tools-swatches', role: 'listbox', 'aria-label': t('tools.color.swatches'), 'data-ctg': 'color-swatches',
          onKeyDown: function (e) {
            var opts = e.currentTarget.querySelectorAll('[role="option"]');
            var i = Array.prototype.indexOf.call(opts, document.activeElement);
            if (i < 0) i = sel < 0 ? 0 : sel;
            var n = colors.length;
            var to = null;
            if (e.key === 'ArrowRight') to = Math.min(n - 1, i + 1);
            else if (e.key === 'ArrowLeft') to = Math.max(0, i - 1);
            else if (e.key === 'ArrowDown') to = Math.min(n - 1, i + SWATCH_COLS);
            else if (e.key === 'ArrowUp') to = Math.max(0, i - SWATCH_COLS);
            else if (e.key === 'Home') to = 0;
            else if (e.key === 'End') to = n - 1;
            else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); self._apply(colors[i]); return; }
            if (to == null) return;
            e.preventDefault();
            focusAt(e.currentTarget, to);
          },
        }, colors.map(function (c, i) {
          var on = i === sel;
          return h('div', {
            key: c, role: 'option', className: 'ctg-tools-swatch', 'aria-selected': on ? 'true' : 'false', 'aria-label': c, title: c,
            'data-color': c, tabIndex: on || (sel < 0 && i === 0) ? 0 : -1,
            style: { backgroundColor: NS.props.color(c) || undefined },
            onClick: function () { self._apply(c); },
          });
        }));
      }
      render() {
        var api = this.props.api;
        var args = this.props.args || {};
        var embedded = typeof args.onPick === 'function';
        var vm = this._vm();
        if (!toolGate(api, 'color', args).ok || (!vm && !embedded)) { closeLater(this.props.close); return null; }
        var self = this;
        var p = api.props();
        var colors = swatchColors(p.appearance.palette);
        var current = this._current();
        var shown = current || normalizeHex(vm && vm.color) || '';
        var idHex = this.uid + '-hex';
        var title = args.title ? String(args.title) : vm ? t('tools.color.title', { name: vm.label }) : t('tools.color.titlePlain');
        var native = normalizeHex(this.state.hex) || shown || '#000000';
        return h(NS.ui.Dialog, {
          title: title, className: 'ctg-tools-color', position: this._position,
          initialFocus: '[role="option"][tabindex="0"]', onRequestClose: this._requestClose,
        }, h('div', { 'data-ctg': 'color-picker', 'data-pen-key': vm ? vm.key : '', 'data-chart-id': api.id },
          this._renderSwatches(colors, current || shown),
          h(NS.ui.Field, { id: idHex, label: t('tools.color.hex'), help: t('tools.color.hexHelp'), error: this.state.hexError },
            h('input', {
              id: idHex, className: 'ctg-input', type: 'text', value: this.state.hex, spellCheck: false, autoComplete: 'off',
              maxLength: 7, placeholder: shown || '#RRGGBB', 'data-ctg-field': 'hex',
              onChange: function (e) { self.setState({ hex: e.target.value, hexError: null }); },
              onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); self._applyHex(); } },
            })),
          h('div', { className: 'ctg-tools-color__actions' },
            h('label', { className: 'ctg-btn ctg-btn--secondary ctg-tools-native', title: t('tools.color.moreTitle') },
              h('input', { type: 'color', value: native, onChange: this._onNative, 'aria-label': t('tools.color.moreTitle'), 'data-ctg-field': 'native' }),
              t('tools.color.more')),
            h(NS.ui.Button, {
              // enabled whenever the pen HAS an explicit colour, also one that is not hex ('crimson',
              // 'rgb(…)', 'var(--x)'), so such pens can be returned to automatic from the picker too
              kind: 'secondary', 'data-ctg-default': '1', title: t('tools.color.defaultTitle'),
              disabled: !current && !embedded && !(vm && String(explicitColor(p, vm) || '') !== ''),
              onClick: function () { self._apply(''); },
            }, t('tools.color.default')),
            h(NS.ui.Button, { kind: 'primary', 'data-ctg-apply': '1', onClick: function () { self._applyHex(); } }, t('tools.color.apply')))));
      }
    }

    /* ========================================================================
     * SECTION 7 / export model (pure; Node-tested)
     * ----------------------------------------------------------------------
     * CSV per RFC 4180 (comma, CRLF, quotes doubled), UTF-8 with a BOM so
     * spreadsheet programs detect the encoding. Numbers are written with a
     * '.' decimal point and full precision (String(number)), never localised
     * or grouped; bad-quality samples are empty cells (a quality column per
     * pen with export.csv.includeQuality). CSV injection guard: a TEXT cell
     * (pen labels, headers, quality words) is prefixed with an apostrophe when
     * it starts with = + - @ TAB CR LF (OWASP), and also when such a
     * trigger follows leading whitespace (" =1+1",
     * "\n=1+1": some importers trim before evaluating) or is a full-width /
     * look-alike form that spreadsheet apps normalise (U+FF1D ＝, U+FF0B ＋,
     * U+FF0D －, U+FF20 ＠, the minus sign U+2212, small plus / hyphen-minus
     * U+FE62 / U+FE63) — numeric cells are never touched, so negative values
     * stay numbers (OWASP CSV injection).
     * ====================================================================== */
    var INJECTION_RE = /^[\s\u00a0\u2000-\u200b\u3000\ufeff]*[=+\-@\uff1d\uff0b\uff0d\uff20\u2212\ufe62\ufe63]|^[\t\r\n]/;
    /** One text cell: injection-guarded, quoted when needed. */
    function csvText(s) {
      var x = String(s == null ? '' : s);
      if (INJECTION_RE.test(x)) x = "'" + x;
      return /[",\r\n]/.test(x) || /^\s|\s$/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x;
    }
    /** One value cell: finite numbers verbatim, booleans 1/0, null / '' / non-finite empty, strings as text. */
    function csvValue(v) {
      if (v == null || v === '') return '';
      if (typeof v === 'number') return isFinite(v) ? String(v) : '';
      if (typeof v === 'boolean') return v ? '1' : '0';
      return csvText(v);
    }
    /** "2026-10-09T03:00:00.000+02:00" in tz. */
    function isoInZone(ms, tz) {
      return NS.time.format(ms, 'YYYY-MM-DD[T]HH:mm:ss.SSS', tz) + offsetText(ms, tz).replace('−', '-');
    }
    /** Time cell per export.csv.timeFormat: 'iso' (chart zone + offset), 'epoch' (ms) or an NS.time pattern. */
    function csvTime(ms, fmt, tz) {
      if (typeof ms !== 'number' || !isFinite(ms)) return '';
      var f = String(fmt == null ? 'iso' : fmt).trim();
      if (!f || f === 'iso') return isoInZone(ms, tz);
      if (f === 'epoch') return String(Math.round(ms));
      return csvText(NS.time.format(ms, f, tz));
    }
    /**
     * CSV text parts (one string per line, CRLF included) for {header, rows} as returned by
     * api.series.rows: column 0 is the time; text columns (`textCols`, e.g. the pen name of the tall
     * layout) are guarded text, every other column a value. Returns an array (Blob parts: no giant join).
     */
    function csvParts(table, opts) {
      var o = opts || {};
      var textCols = o.textCols || {};
      var parts = ['﻿' + table.header.map(csvText).join(',') + '\r\n'];
      var rows = table.rows || [];
      for (var r = 0; r < rows.length; r++) {
        var row = rows[r];
        var cells = new Array(row.length);
        cells[0] = csvTime(row[0], o.timeFormat, o.tz);
        for (var c = 1; c < row.length; c++) cells[c] = textCols[c] ? csvText(row[c]) : csvValue(row[c]);
        parts.push(cells.join(',') + '\r\n');
      }
      return parts;
    }
    /** Columns of a series.rows / rawTable table that hold text (tall layout: pen name, quality words). */
    function textColumns(header, layout, includeQuality) {
      var tc = {};
      if (layout === 'tall') { tc[1] = true; if (includeQuality) tc[3] = true; }
      else if (includeQuality) for (var i = 2; i < header.length; i += 2) tc[i] = true;
      return tc;
    }
    /**
     * The raw-source table: fetchRaw pens -> the same {header, rows} shapes as api.series.rows ('wide' =
     * one time column plus one column per pen, '' where a pen has no sample at that time; 'tall' = time,
     * pen, value), real samples only, null = bad quality. `labels` maps pen key -> column label.
     */
    function rawTable(pens, labels, layout, includeQuality) {
      var q = !!includeQuality;
      var good = t('tools.export.good'), bad = t('tools.export.bad');
      // samples with a non-finite timestamp are skipped and each pen is merged in time order: a NaN time would
      // stall that pen's merge cursor (dropping its later samples) and unsorted input would give unsorted rows
      var list = (pens || []).filter(function (pn) { return pn && labels[pn.key] != null; }).map(sortedFinite);
      if (layout === 'tall') {
        var rows = [];
        list.forEach(function (pn) {
          for (var i = 0; i < pn.t.length; i++) {
            var r = [pn.t[i], labels[pn.key].name, pn.v[i]];
            if (q) r.push(pn.v[i] === null ? bad : good);
            rows.push(r);
          }
        });
        rows.sort(function (a, b) { return a[0] - b[0]; });
        return { header: q ? [t('tools.export.time'), t('tools.export.pen'), t('tools.export.value'), t('tools.export.quality')]
          : [t('tools.export.time'), t('tools.export.pen'), t('tools.export.value')], rows: rows };
      }
      // wide: k-way merge over the per-pen sorted time columns (equal times share one row)
      var header = [t('tools.export.time')];
      list.forEach(function (pn) {
        header.push(labels[pn.key].column);
        if (q) header.push(t('tools.export.qualitySuffix', { label: labels[pn.key].column }));
      });
      var idx = list.map(function () { return 0; });
      var out = [];
      for (;;) {
        var tmin = Infinity;
        for (var k = 0; k < list.length; k++) if (idx[k] < list[k].t.length && list[k].t[idx[k]] < tmin) tmin = list[k].t[idx[k]];
        if (tmin === Infinity) break;
        var row = [tmin];
        for (var j = 0; j < list.length; j++) {
          var pn = list[j];
          if (idx[j] < pn.t.length && pn.t[idx[j]] === tmin) {
            var v;
            if (pn.downgraded) {
              // a downgraded (aggregated) pen: equal stamps are the two rows of a MinMax bucket, not a re-sent
              // sample — every row is kept (otherwise the wide layout would drop the min or the max)
              // (the next one, at the same time, gets the next row; the other pens are blank there)
              v = pn.v[idx[j]]; idx[j]++;
            } else {
              // duplicate timestamps of one raw pen: the last sample at that time wins
              while (idx[j] < pn.t.length && pn.t[idx[j]] === tmin) { v = pn.v[idx[j]]; idx[j]++; }
            }
            row.push(v);
            if (q) row.push(v === null ? bad : good);
          } else {
            row.push('');
            if (q) row.push('');
          }
        }
        out.push(row);
      }
      return { header: header, rows: out };
    }
    /**
     * A pen's raw columns with only finite timestamps, in time order (stable: samples with equal times keep their
     * order, so "the last sample at that time wins" still holds). Already sorted, finite input is returned as is.
     */
    function sortedFinite(pn) {
      var t = pn.t || [], v = pn.v || [];
      var ok = true;
      for (var i = 0; i < t.length && ok; i++) ok = typeof t[i] === 'number' && isFinite(t[i]) && (i === 0 || t[i] >= t[i - 1]);
      if (ok) return pn;
      var idx = [];
      for (var j = 0; j < t.length; j++) if (typeof t[j] === 'number' && isFinite(t[j])) idx.push(j);
      idx.sort(function (a, b) { return t[a] - t[b] || a - b; });
      return { key: pn.key, status: pn.status, downgraded: pn.downgraded,
        t: idx.map(function (x) { return t[x]; }), v: idx.map(function (x) { return v[x]; }) };
    }

    /**
     * File name (without extension) from export.fileName: tokens {title} {start} {end} (start/end as
     * yyyyMMdd-HHmmss in the chart zone); characters not allowed in file names become '_'; at most 120
     * characters; never empty (tools.export.fileFallback, "chart").
     */
    var RESERVED_NAME_RE = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
    function exportFileName(tpl, vars, tz) {
      var stamp = function (ms) { return typeof ms === 'number' && isFinite(ms) ? NS.time.format(ms, 'YYYYMMDD-HHmmss', tz) : ''; };
      var fallback = t('tools.export.fileFallback');
      var title = String(vars.title == null ? '' : vars.title).trim() || fallback;
      var s = String(tpl == null || tpl === '' ? '{title}_{start}' : tpl).replace(/\{(title|start|end)\}/g, function (m, k) {
        return k === 'title' ? title : stamp(vars[k]);
      });
      s = s.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
      // at most 120 characters, counted in code points so a surrogate pair (emoji) is never cut in
      // half; a lone surrogate already in the title becomes '_' (not a valid file-name character)
      s = Array.from(s).slice(0, 120).map(function (c) {
        return c.length === 1 && c.charCodeAt(0) >= 0xD800 && c.charCodeAt(0) <= 0xDFFF ? '_' : c;
      }).join('').replace(/[\s.]+$/, '');
      // Windows device names (CON, NUL, COM1, LPT1, ..., also with an extension) cannot be saved as files
      if (RESERVED_NAME_RE.test(s)) s = '_' + s;
      return s || fallback;
    }

    /* ========================================================================
     * SECTION 8 / ExportMenu
     * ----------------------------------------------------------------------
     * An NS.ui.Menu (role=menu, arrow keys / Home / End / typeahead, Esc,
     * single transient page-wide) under the Export button. Items: Export CSV
     * (export.csv.*: source visible | loaded | raw, layout wide | tall, time
     * format, quality columns) and Export PNG (api.plots.snapshot at
     * export.png.scale, legend per includeLegend). Raw CSV re-queries the
     * visible window through api.history.fetchRaw (history queue priority
     * "user"): the item turns busy and a Cancel item aborts. Closing the
     * menu (Esc, an outside click, the window losing focus, a scroll) does
     * NOT abort it (an Alt-Tab must not silently lose a long export):
     * the file is saved when it arrives; the chart's unmount aborts it with
     * an 'Export cancelled' toast. A visible window longer than limits.maxRawRangeDays (or a
     * raw reply that came back aggregated and empty) exports the visible
     * data instead, with a notice. In the mobile app both items are disabled with "Export is
     * not available in the mobile app" (the chart already hides the button
     * there). Failures are toasts; success is announced politely.
     * ====================================================================== */
    class ExportMenu extends RComponent {
      constructor(props) {
        super(props);
        var a = props.args || {};
        this._anchor = anchorElement(a.anchorRect);
        this.state = { busy: false };
        this._ctl = null;
        this._job = null;                  // the running raw export: {ctl, cancelled}
        var self = this;
        this._onClose = function () {
          // a running raw export continues without the menu (its file is saved when it arrives)
          if (self._job && !self._job.cancelled) NS.a11y.announce(t('tools.export.background'));
          self.props.close();
        };
      }
      componentDidMount() { this._alive = true; }
      componentWillUnmount() { this._alive = false; }
      /** The Cancel item: the one explicit way to stop a raw export. */
      _abort() {
        if (this._job) this._job.cancelled = true;
        if (this._ctl) { try { this._ctl.abort(); } catch (e) { /* ignore */ } this._ctl = null; }
      }
      _finish() { if (this._alive) this.props.close(); }
      _fileName(ext) {
        var api = this.props.api;
        var p = api.props();
        var v = api.viewport.get();
        return exportFileName(p.export.fileName, { title: p.title.text, start: v.min, end: v.max }, api.timeZone()) + '.' + ext;
      }
      _save(blob, name, doneText) {
        try {
          downloadBlob(blob, name);
          NS.a11y.announce(doneText);
          return true;
        } catch (e) {
          toast(t('tools.export.failed', { message: (e && e.message) || String(e) }));
          return false;
        }
      }
      _csv() {
        var self = this;
        var api = this.props.api;
        var p = api.props();
        var c = p.export.csv;
        var tz = api.timeZone();
        var opts = { timeFormat: c.timeFormat, tz: tz, textCols: null };
        var write = function (table) {
          if (!table.rows.length) { toast(t('tools.export.empty'), 'info'); return false; }
          opts.textCols = textColumns(table.header, c.layout, c.includeQuality);
          var name = self._fileName('csv');
          return self._save(new Blob(csvParts(table, opts), { type: 'text/csv;charset=utf-8' }), name,
            t('tools.export.done', { rows: table.rows.length, file: name }));
        };
        var visibleRows = function () {
          return api.series.rows({ source: 'visible', layout: c.layout, includeQuality: c.includeQuality });
        };
        if (c.source !== 'raw') {
          var tbl = c.source === 'loaded'
            ? api.series.rows({ source: 'loaded', layout: c.layout, includeQuality: c.includeQuality }) : visibleRows();
          // say when the file holds buckets, not samples (the pen table marks them with an approx sign)
          if (write(tbl) && tbl.aggregated && tbl.aggregated.length) {
            toast(t('tools.export.aggregated', { pens: tbl.aggregated.join(', ') }), 'warn');
          }
          this._finish();
          return;
        }
        // raw: re-query the visible window (shown pens with data, as for the other sources)
        var vms = api.pens().filter(function (vm) { return vm.visible && vm.status === 'ok'; });
        if (!vms.length) { toast(t('tools.export.empty'), 'info'); this._finish(); return; }
        var vp = api.viewport.get();
        // A window over limits.maxRawRangeDays is never raw: the gateway would downgrade the WHOLE window to
        // aggregated buckets that can come back empty. Export what is on screen instead.
        var rawDays = Number(api.limits().maxRawRangeDays);
        var start = Math.floor(vp.min), end = Math.ceil(vp.max);
        if (rawDays > 0) {
          var lim = rawDays * DAY;
          // a viewport of exactly the limit (the chart's own zoom clamp) must not tip over it by rounding
          if (end - start > lim && vp.max - vp.min <= lim) start = end - lim;
          if (end - start > lim) {
            if (write(visibleRows())) toast(t('tools.export.rawTooLong', { days: rawDays }), 'warn');
            this._finish();
            return;
          }
        }
        var labels = {};
        vms.forEach(function (vm) { labels[vm.key] = { name: vm.label, column: vm.label + (vm.units ? ' (' + vm.units + ')' : '') }; });
        var ctl = typeof AbortController === 'function' ? new AbortController() : null;
        var fail = function (e) {
          toast(t('tools.export.failed', { message: (e && e.message) || String(e) }));
          self._finish();
        };
        var sent;
        try {
          sent = api.history.fetchRaw({ start: start, end: end, penKeys: vms.map(function (vm) { return vm.key; }),
            signal: ctl ? ctl.signal : undefined });
        } catch (e) {                                            // e.g. a detached chart that throws instead of resolving
          fail(e);
          return;
        }
        var job = { ctl: ctl, cancelled: false };
        this._job = job;
        this._ctl = ctl;
        this.setState({ busy: true });
        var done = function () { if (self._job === job) { self._job = null; self._ctl = null; } };
        Promise.resolve(sent).then(function (res) {
          if (job.cancelled) return;                                   // the Cancel item
          done();
          res = res || {};
          if (res.error === 'ABORTED' || res.error === 'DETACHED') {
            // not the Cancel item: the chart went away; say so rather than drop the export silently
            toast(t('tools.export.cancelled'), 'info');
            self._finish();
            return;
          }
          if (res.error && !(res.pens || []).some(function (pn) { return pn.status === 'ok'; })) {
            toast(t('tools.export.failed', { message: res.error }));
            self._finish();
            return;
          }
          var bad = [], agg = [];
          (res.pens || []).forEach(function (pn) {
            if (!labels[pn.key]) return;
            if (pn.status !== 'ok') bad.push(labels[pn.key].name + ' (' + pn.status + ')');
            else if (pn.downgraded) agg.push(labels[pn.key].name);
          });
          var ok = (res.pens || []).filter(function (pn) { return pn.status === 'ok'; });
          try {
            var table = rawTable(ok, labels, c.layout, c.includeQuality);
            if (!table.rows.length && (agg.length || res.downgraded || (res.window && res.window.downgraded))) {
              // the gateway answered with aggregated data and no samples: the on-screen data is the better file
              if (write(visibleRows())) toast(t('tools.export.rawFallback'), 'warn');
            } else if (write(table)) {
              if (bad.length) toast(t('tools.export.rawPartial', { pens: bad.join(', ') }), 'warn');
              else if (agg.length) toast(t('tools.export.rawAggregated', { pens: agg.join(', ') }), 'warn');
            }
          } catch (e) { fail(e); return; }
          self._finish();
        }, function (e) {
          if (job.cancelled) return;
          done();
          fail(e);
        });
      }
      _png() {
        var self = this;
        var api = this.props.api;
        var p = api.props();
        var canvas = null;
        try { canvas = api.plots.snapshot({ scale: p.export.png.scale, includeLegend: p.export.png.includeLegend }); } catch (e) {
          toast(t('tools.export.failed', { message: (e && e.message) || String(e) }));
          this._finish();
          return;
        }
        if (!canvas || typeof canvas.toBlob !== 'function') { toast(t('tools.export.noImage'), 'info'); this._finish(); return; }
        var name = this._fileName('png');
        // toBlob is asynchronous: the menu closes now, the file follows (no component state is touched)
        canvas.toBlob(function (blob) {
          if (!blob) { toast(t('tools.export.failed', { message: t('tools.export.canvasFailed') })); return; }
          self._save(blob, name, t('tools.export.donePng', { file: name }));
        }, 'image/png');
        this._finish();
      }
      render() {
        var api = this.props.api;
        if (!toolGate(api, 'export').ok) { closeLater(this.props.close); return null; }
        var self = this;
        var caps = api.capabilities();
        var p = api.props();
        var mobile = inMobileApp(caps);
        var a = this.props.args || {};
        var r = a.anchorRect;
        var busy = this.state.busy;
        var hint = { visible: 'tools.export.hint.visible', loaded: 'tools.export.hint.loaded', raw: 'tools.export.hint.raw' }[p.export.csv.source];
        var items = [
          {
            id: 'csv', label: busy ? t('tools.export.busy') : t('tools.export.csv'), hint: busy ? t('tools.export.busyHint') : t(hint),
            hidden: !p.export.csv.enabled, disabled: mobile, busy: busy, keepOpen: p.export.csv.source === 'raw',
            title: mobile ? t('tools.export.native') : undefined, onSelect: function () { self._csv(); },
          },
          {
            id: 'png', label: t('tools.export.png'), hint: t('tools.export.hint.png'), hidden: !p.export.png.enabled,
            disabled: mobile || busy, title: mobile ? t('tools.export.native') : undefined, onSelect: function () { self._png(); },
          },
          { id: 'cancel', label: t('tools.export.cancel'), hidden: !busy, separatorBefore: true, onSelect: function () { self._abort(); } },
        ];
        return h(NS.ui.Menu, {
          x: r ? r.left : Math.round((W.innerWidth || 800) / 2), y: r ? (r.bottom != null ? r.bottom : r.top + (r.height || 0)) + 2 : Math.round((W.innerHeight || 600) / 3),
          items: items, ariaLabel: t('tools.export.menu'), className: 'ctg-tools-export', openedByKeyboard: true,
          returnFocus: this._anchor || undefined, ignoreEls: this._anchor ? [this._anchor] : undefined, onClose: this._onClose,
        });
      }
    }

    /* ========================================================================
     * SECTION 9 / stylesheet, registration, NS.chart.tools
     * ----------------------------------------------------------------------
     * Every rule in :where() (zero specificity: project classes win) and only
     * the shared --ctg-* tokens of ctg-common.js, so both themes work
     * without a token of our own. Panels render inside the chart's per-panel
     * error boundary; a render error shows "Panel error" there.
     * ====================================================================== */
    var TOOLS_CSS = [
      ':where(.ctg-tools-legend){margin:0 0 6px;font-size:13px;font-weight:600;}',
      ':where(.ctg-tools-tabs){display:flex;margin:0 0 12px;border-bottom:1px solid var(--ctg-border);}',
      ':where(.ctg-tools-tab){flex:1 1 0;min-height:36px;padding:6px 12px;font:inherit;font-weight:600;',
      'color:var(--ctg-text-muted);background:transparent;border:0;border-bottom:3px solid transparent;cursor:pointer;}',
      ':where(.ctg-tools-tab[aria-selected="true"]){color:var(--ctg-text);border-bottom-color:var(--ctg-primary);}',
      ':where(.ctg-tools-tab:focus-visible,.ctg-tools-chip:focus-visible,.ctg-tools-swatch:focus-visible){',
      'outline:2px solid var(--ctg-focus);outline-offset:2px;}',
      ':where(.ctg-tools-row){display:flex;flex-wrap:wrap;gap:0 10px;}',
      ':where(.ctg-tools-row>.ctg-field){flex:1 1 140px;min-width:0;}',
      ':where(.ctg-tools-row--dates>.ctg-field){flex-basis:190px;}',
      ':where(.ctg-tools-chips){display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px;}',
      ':where(.ctg-tools-chip){min-height:30px;padding:2px 12px;font:inherit;font-size:13px;color:var(--ctg-text);',
      'background:var(--ctg-surface-2);border:1px solid var(--ctg-border);border-radius:999px;cursor:pointer;}',
      ':where(.ctg-tools-chip[aria-pressed="true"]){color:var(--ctg-primary-text);background:var(--ctg-primary);',
      'border-color:var(--ctg-primary);}',
      ':where(.ctg-tools-help){margin:0 0 8px;font-size:12px;color:var(--ctg-text-muted);}',
      ':where(.ctg-tools-note){color:var(--ctg-warn);}',
      ':where(.ctg-tools-error){margin:0 0 8px;font-size:12px;color:var(--ctg-danger);}',
      ':where(.ctg-tools-color){width:min(300px,calc(100vw - 16px));}',
      ':where(.ctg-tools-swatches){display:grid;grid-template-columns:repeat(6,32px);gap:8px;margin:4px 0 12px;}',
      ':where(.ctg-tools-swatch){width:32px;height:32px;border:1px solid var(--ctg-border);border-radius:var(--ctg-radius);',
      'cursor:pointer;outline:none;}',
      ':where(.ctg-tools-swatch[aria-selected="true"]){box-shadow:0 0 0 2px var(--ctg-surface),0 0 0 4px var(--ctg-text);}',
      ':where(.ctg-tools-color__actions){display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;}',
      ':where(.ctg-tools-native){position:relative;}',
      ':where(.ctg-tools-native input[type="color"]){width:22px;height:22px;padding:0;border:0;background:transparent;cursor:pointer;}',
      '@media (pointer:coarse){:where(.ctg-tools-swatches){grid-template-columns:repeat(6,44px);}',
      ':where(.ctg-tools-swatch){width:44px;height:44px;}:where(.ctg-tools-chip,.ctg-tools-tab){min-height:44px;}}',
    ].join('');
    NS.theme.ensureStyles('ctg-chart-tools-styles', TOOLS_CSS);

    /**
     * def.render for a tool: a stable element per OPENING (React keeps its state while it stays open).
     * The chart stores one args object per panels.open() call, so a second open() of an open tool with
     * new args (another pen's swatch, another anchor) gets a new key: the tool remounts with that pen's
     * colour, anchor and draft instead of keeping the first opening's state.
     */
    var openGen = typeof WeakMap === 'function' ? new WeakMap() : null;
    var openSeq = 0;
    function openKey(name, args) {
      if (!args || typeof args !== 'object' || !openGen) return name;
      var g = openGen.get(args);
      if (g == null) { g = ++openSeq; openGen.set(args, g); }
      return name + ':' + g;
    }
    function panelDef(Comp, name) {
      return {
        dock: 'none',
        render: function (api, args, close) {
          if (api.capabilities().designMode) return null;
          return h(Comp, { key: openKey(name, args), api: api, args: args || {}, close: close });
        },
      };
    }
    NS.chart.panels.register('dateRange', panelDef(DateRangeModal, 'dateRange'));
    NS.chart.panels.register('color', panelDef(ColorPicker, 'color'));
    NS.chart.panels.register('export', panelDef(ExportMenu, 'export'));

    // Pure helpers for Node tests (tests/js/chart-tools.test.mjs) and for other add-on parts (colour writes, hex checks).
    NS.chart.tools = {
      UNITS: UNITS, EXTRA_COLORS: EXTRA_COLORS,
      toLocalInput: toLocalInput, parseLocalInput: parseLocalInput, initialDraft: initialDraft, evaluateRange: evaluateRange,
      sameWindow: sameWindow, quickRange: quickRange, spanLimit: spanLimit, presetLabel: presetLabel, refreshText: refreshText,
      normalizeHex: normalizeHex, swatchColors: swatchColors, explicitColor: explicitColor, colorPatch: colorPatch,
      csvText: csvText, csvValue: csvValue, csvTime: csvTime, csvParts: csvParts, textColumns: textColumns, rawTable: rawTable,
      exportFileName: exportFileName, inMobileApp: inMobileApp, toolGate: toolGate,
      DateRangeModal: DateRangeModal, ColorPicker: ColorPicker, ExportMenu: ExportMenu,
    };
  }
})();
