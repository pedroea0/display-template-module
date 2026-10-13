/* ============================================================================
 * ctg-common.js — shared runtime of the Display Template / Click-to-Graph module
 * ============================================================================
 *
 * Part id: 'common'. Loaded by Perspective as a browser resource of both
 * components (SimpleTagDisplayModule.BROWSER_RESOURCES), served from
 * /res/simpletagdisplay/js/ctg-common.js?v=<RESOURCE_VERSION>.
 *
 * NAMESPACE AND LOAD PROTOCOL
 *   Every file of the module is one IIFE that touches exactly one global,
 *   window.__CTG ("NS"). No top-level const/class leaks, so a second copy of a
 *   file (old and new ?v= on one page after an upgrade) cannot throw
 *   "Identifier has already been declared" — the first copy wins and the second
 *   only warns.
 *
 *   Files register an init in NS._queue as {part, needs:[...], init(NS)}.
 *   NS._drain() (defined here) runs every queued init whose needs are all in
 *   NS.ready, marks the part ready and repeats until nothing more can run. So
 *   the injection order Perspective picks does not matter: a part
 *   loaded before its dependencies simply waits in the queue.
 *
 * WHAT LIVES HERE (a stable API: the other parts depend on these names)
 *   Pure, DOM-free helpers (Node-testable through tests/js/_stubs.mjs):
 *     NS.util      clamp, looseEqual, debounce, rafThrottle, uid, shortTagName,
 *                  interpolate, normKey, normTrendGroup, framedCrossOrigin, ...
 *     NS.log       named loggers; debug only with localStorage['ctg.debug']==='1';
 *                  history tokens are redacted from everything logged
 *     NS.i18n      per-part string tables (register / t / errorText)
 *     NS.time      time-zone aware formatting and calendar maths
 *     NS.format    number patterns, value text, strict input parsing
 *     NS.quality   quality level of a pushed quality object / code / name
 *     NS.alarm     alarm priority names <-> 0..4
 *     NS.props     reducer helpers: merge, coerce, style, colour hygiene
 *     NS.clock     one page-wide gateway clock (median of 5 offset samples)
 *   Browser runtime:
 *     NS.theme     shared --ctg-* tokens + overlay stylesheet, tokens(el),
 *                  isDark(), onChange(), contrast()
 *     NS.conn      page-wide Perspective connection monitor + gateway watchdog
 *     NS.events    guarded component-event firing
 *     NS.delegate  CtgDelegateBase — browser half of the delegate protocol
 *     NS.overlay   single page-wide overlay manager (menus, dialogs, bubbles)
 *     NS.ui        Portal, Menu, Dialog, Popover, Confirm, Bubble, Toast,
 *                  longPress, Spinner, Choice, Field, Button, FocusTrap
 *     NS.nav       popups and page navigation from a component
 *     NS.resize    one shared, rAF-coalesced ResizeObserver
 *     NS.a11y      one shared screen-reader live region
 *     NS.registerComponent(meta)  guarded ComponentRegistry.register
 *     NS.debug     diagnostics for tests and soak sampling
 *
 * THE DELEGATE PROTOCOL IN ONE PARAGRAPH (details:
 * docs/developer-guide/01-architecture.md)
 *   Each component instance gets a ComponentStoreDelegate (createDelegate in
 *   its meta) paired with a Java ComponentModelDelegate on the gateway. They
 *   exchange "model events" over Perspective's websocket. On mount the client
 *   sends ctg.hello; the gateway answers ctg.welcome plus a full snapshot, then
 *   pushes deltas. Every push carries {v, epoch, seq, serverNow}: a new epoch
 *   means the gateway delegate restarted, a seq gap means a push was lost —
 *   both trigger a resync hello. Requests carry an id and are answered with
 *   ctg.reply; request() never rejects, it resolves {ok, data | error}.
 *
 * CODE RULES: no innerHTML anywhere (React children and
 * textContent only); no setInterval for data refresh (the only timers are UI
 * timers and the self-rescheduling watchdog); colours reach CSS only as style
 * objects after CSS.supports (NS.props.color).
 * ============================================================================ */
(function () {
  'use strict';

  var NS = window.__CTG = window.__CTG || {};
  NS.loaded = NS.loaded || {};
  NS.ready = NS.ready || {};
  NS.failed = NS.failed || {};
  NS._queue = NS._queue || [];

  var PART = 'common';
  var src = document.currentScript && document.currentScript.src;
  var BUILD = (src && new URL(src, location.href).searchParams.get('v')) || 'dev';
  if (NS.loaded[PART]) {
    if (NS.loaded[PART] !== BUILD) {
      console.warn('[CTG]', PART, BUILD, 'ignored; page runs', NS.loaded[PART], '- reload the page');
    }
    return;
  }
  NS.loaded[PART] = BUILD;
  NS.build = BUILD;

  /* ==========================================================================
   * SECTION 0 / Boot queue
   * ======================================================================== */

  /**
   * Runs every queued part whose needs are ready, repeatedly, until no more
   * progress. Each init is isolated: a failing part is reported and left out
   * (NS.failed[part]); it never blocks unrelated parts.
   */
  NS._drain = function () {
    var progressed = true;
    while (progressed) {
      progressed = false;
      for (var i = 0; i < NS._queue.length; i++) {
        var item = NS._queue[i];
        var needs = item.needs || [];
        var ok = true;
        for (var k = 0; k < needs.length; k++) {
          if (!NS.ready[needs[k]]) { ok = false; break; }
        }
        if (!ok) continue;
        NS._queue.splice(i, 1);
        i--;
        progressed = true;
        try {
          item.init(NS);
          NS.ready[item.part] = true;
        } catch (e) {
          NS.failed[item.part] = e;
          console.error('[CTG] init of part "' + item.part + '" failed', e);
        }
      }
    }
  };

  NS._queue.push({ part: PART, needs: [], init: initCommon });
  NS._drain();

  function initCommon(NS) {
    var PC = window.PerspectiveClient;
    var React = window.React;
    var h = React && React.createElement;
    var hasOwn = Object.prototype.hasOwnProperty;

    /* ========================================================================
     * SECTION 1 / NS.util — small pure helpers (DOM-free; Node-testable)
     * ====================================================================== */
    var uidCounter = 0;
    /** Strict decimal number syntax (no hex, no "1d", no grouping). */
    var NUMERIC_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

    function isPlainObject(x) {
      if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
      var p = Object.getPrototypeOf(x);
      return p === null || p === Object.prototype || Object.getPrototypeOf(p) === null;
    }

    /* Animation-frame scheduling; a 16 ms timer where requestAnimationFrame does not exist (Node tests). */
    function nextFrame(fn) {
      if (typeof window.requestAnimationFrame === 'function') {
        var id = window.requestAnimationFrame(fn);
        return function () { window.cancelAnimationFrame(id); };
      }
      var t = setTimeout(fn, 16);
      return function () { clearTimeout(t); };
    }

    /** Number view of a value for looseEqual: numbers, booleans (1/0), numeric strings; else undefined. */
    function looseNumber(x) {
      if (typeof x === 'number') return x;
      if (typeof x === 'boolean') return x ? 1 : 0;
      if (typeof x === 'string') {
        var s = x.trim();
        return NUMERIC_RE.test(s) ? Number(s) : undefined;
      }
      if (typeof x === 'bigint') return Number(x);
      return undefined;
    }

    NS.util = {
      NUMERIC_RE: NUMERIC_RE,
      clamp: function (n, lo, hi) { return n < lo ? lo : n > hi ? hi : n; },
      isFiniteNum: function (x) { return typeof x === 'number' && isFinite(x); },
      isPlainObject: isPlainObject,
      uid: function (prefix) { return (prefix || 'ctg') + '-' + (++uidCounter).toString(36); },
      nextFrame: nextFrame,

      /** Tag name of a path: after the provider bracket, last '/' segment. */
      shortTagName: function (path) {
        var s = String(path == null ? '' : path);
        s = s.slice(s.lastIndexOf(']') + 1);
        return s.slice(s.lastIndexOf('/') + 1);
      },

      /**
       * Client-side lookup key: JS-trimmed (Unicode whitespace), fully lower-case.
       * NOT equivalent to the gateway's TagPaths.normalizedKey, which parses the path, resolves the
       * provider and lower-cases toStringFull(): ' CTG/Temp ', 'CTG/Temp.Value' or a path
       * without a provider give different keys on the two sides. Only compare normKey values with each
       * other, never with a key the gateway computed; prefer keys the gateway sends.
       */
      normKey: function (path) { return String(path == null ? '' : path).trim().toLowerCase(); },

      /**
       * trendGroup normalisation shared with the gateway (TagPaths.normTrendGroup):
       * trim code units <= U+0020 at both ends (Java String.trim() semantics, NOT JS trim(), which
       * strips Unicode spaces but keeps control characters); null/empty -> 'default' for a display,
       * null ("ignore the trend list") for a chart; code units outside [A-Za-z0-9_.-] -> '_';
       * at most 64 code units. Shared vectors: tests/vectors/trend-group.json.
       */
      normTrendGroup: function (g, opts) {
        var chart = opts && opts.kind === 'chart';
        var s = g == null ? '' : String(g).replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, '');
        if (!s) return chart ? null : 'default';
        return s.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64);
      },

      /**
       * Option/value equality used for state labels and setpoint options:
       * numbers compare numerically; a numeric string equals a number ("1" == 1) only when it is
       * strictly numeric; booleans equal 1/0; two strings compare exactly (case-sensitive);
       * null equals only null/undefined; objects only by identity.
       */
      looseEqual: function (a, b) {
        if (a === b) return true;
        if (a == null || b == null) return a == null && b == null;
        if (typeof a === 'string' && typeof b === 'string') return false;
        var x = looseNumber(a), y = looseNumber(b);
        if (x === undefined || y === undefined) return false;
        return x === y || (x !== x && y !== y);   // NaN equals NaN here (option matching)
      },

      /** Trailing-edge debounce; the returned function has .cancel(). */
      debounce: function (fn, ms) {
        var t = null;
        var d = function () {
          var self = this, args = arguments;
          if (t) clearTimeout(t);
          t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
        };
        d.cancel = function () { if (t) clearTimeout(t); t = null; };
        return d;
      },

      /** At most one call per animation frame, with the latest arguments; .cancel(). */
      rafThrottle: function (fn) {
        var cancel = null, self = null, args = null;
        var t = function () {
          self = this; args = arguments;
          if (cancel) return;
          cancel = nextFrame(function () { cancel = null; fn.apply(self, args); });
        };
        t.cancel = function () { if (cancel) { cancel(); cancel = null; } };
        return t;
      },

      /** Shallow-equal of two plain objects (own enumerable keys, ===). */
      shallowEqual: function (a, b) {
        if (a === b) return true;
        if (!a || !b) return false;
        var ka = Object.keys(a), kb = Object.keys(b);
        if (ka.length !== kb.length) return false;
        for (var i = 0; i < ka.length; i++) if (a[ka[i]] !== b[ka[i]]) return false;
        return true;
      },

      /**
       * Replaces {name} placeholders (e.g. {tagPath} {tagName} {trendGroup}); values are
       * URI-component encoded unless encode === false. Unknown placeholders stay as written.
       */
      interpolate: function (tpl, vars, encode) {
        return String(tpl == null ? '' : tpl).replace(/\{(\w+)\}/g, function (m, k) {
          if (!vars || !hasOwn.call(vars, k) || vars[k] == null) return m;
          return encode === false ? String(vars[k]) : encodeURIComponent(String(vars[k]));
        });
      },

      /**
       * True when this page runs inside a frame whose top-level page is on another origin (clickjacking
       * guard): editing is then disabled unless the gateway allows it (welcome.allowCrossOriginFrames).
       * Cross-origin access to top.location throws, which is itself the answer.
       */
      framedCrossOrigin: function () {
        try {
          var top = window.top;
          if (!top || top === window || top === window.self) return false;
          var loc = window.location || (typeof location !== 'undefined' ? location : null);
          var own = loc && loc.origin;
          var ancestors = loc && loc.ancestorOrigins;
          if (ancestors && ancestors.length) {
            for (var i = 0; i < ancestors.length; i++) if (ancestors[i] !== own) return true;
          }
          try {
            var o = top.location.origin;
            return !o || o !== own;
          } catch (e) {
            return true;
          }
        } catch (e) {
          return true;
        }
      },
    };

    /* ========================================================================
     * SECTION 2 / NS.log — named loggers with token redaction
     * ----------------------------------------------------------------------
     * debug() prints only when localStorage['ctg.debug'] === '1' (read per
     * call, so it can be switched on in a running page). Every argument is
     * passed through redact(): history tokens (X-CTG-Token values, `token`
     * fields, chart.token payloads) never reach the console.
     * ====================================================================== */
    var TOKEN_KEY = /^(token|x-ctg-token)$/i;
    function debugOn() {
      try { return !!window.localStorage && window.localStorage.getItem('ctg.debug') === '1'; } catch (e) { return false; }
    }
    function redact(arg) {
      if (typeof arg === 'string') {
        return arg.replace(/("?(?:x-ctg-token|token)"?\s*[:=]\s*"?)[A-Za-z0-9_\-]{8,}/gi, '$1***');
      }
      if (arg && typeof arg === 'object' && !(arg instanceof Error)) {
        try {
          return JSON.parse(JSON.stringify(arg, function (k, v) { return TOKEN_KEY.test(k) && v ? '***' : v; }));
        } catch (e) { return '[unserializable]'; }
      }
      return arg;
    }
    NS.log = function (name) {
      var tag = '[' + (name || 'ctg') + ']';
      function out(fn, args) {
        var a = [tag];
        for (var i = 0; i < args.length; i++) a.push(redact(args[i]));
        fn.apply(console, a);
      }
      return {
        debug: function () { if (debugOn()) out(console.debug, arguments); },
        info: function () { out(console.info, arguments); },
        warn: function () { out(console.warn, arguments); },
        error: function () { out(console.error, arguments); },
      };
    };
    NS.log.redact = redact;
    NS.log.debugEnabled = debugOn;
    var log = NS.log('ctg.common');
    var warned = {};
    /** One console warning per key per page (bad colours, bad time zones, ...). */
    function warnOnce(key) {
      if (warned[key]) return;
      warned[key] = true;
      log.warn.apply(null, Array.prototype.slice.call(arguments, 1));
    }

    /* ========================================================================
     * SECTION 3 / NS.i18n — per-part string tables
     * ----------------------------------------------------------------------
     * Each part registers its own English table (NS.i18n.register(part, {...})).
     * t(key, vars, part) looks the key up in `part` first (so a part can
     * override a shared string for its own context), then in 'common', then
     * in every other part in registration order — deterministic whatever the
     * injection order. errorText(code, details, part) is the operator text for
     * a protocol error code when the gateway's message is absent.
     * ====================================================================== */
    var tables = {};
    var tableOrder = [];
    function lookup(table, key) {
      return table && hasOwn.call(table, key) ? table[key] : undefined;
    }
    function fill(s, vars) {
      return String(s).replace(/\{(\w+)\}/g, function (m, k) {
        return vars && vars[k] != null ? String(vars[k]) : m;
      });
    }
    NS.i18n = {
      register: function (part, table) {
        if (!tables[part]) tableOrder.push(part);
        tables[part] = Object.assign({}, tables[part] || {}, table || {});
      },
      has: function (key, part) {
        if (part && lookup(tables[part], key) !== undefined) return true;
        for (var i = 0; i < tableOrder.length; i++) if (lookup(tables[tableOrder[i]], key) !== undefined) return true;
        return false;
      },
      t: function (key, vars, part) {
        var s = part ? lookup(tables[part], key) : undefined;
        if (s === undefined) s = lookup(tables.common, key);
        for (var i = 0; s === undefined && i < tableOrder.length; i++) s = lookup(tables[tableOrder[i]], key);
        if (s === undefined) return key;
        return typeof s === 'function' ? String(s(vars || {})) : fill(s, vars);
      },
      errorText: function (code, details, part) {
        var k = 'error.' + code;
        if (!NS.i18n.has(k, part)) return NS.i18n.t('error.UNKNOWN', { code: code }, part);
        return NS.i18n.t(k, details || {}, part);
      },
    };

    var NO_CONFIRMATION = 'No confirmation received. The value may or may not have been written. ' +
      'Check the current value before trying again.';
    NS.i18n.register('common', {
      // connection / page level
      'conn.disconnected': 'Disconnected',
      'conn.notConnected': 'Not connected',
      'conn.noResponse': 'Gateway service not responding',
      'conn.stale': 'Connection to the gateway lost. The value may be out of date.',
      'frame.blocked': 'Editing is disabled inside a frame from another site.',
      'reload.toast': 'The Display Template / CTG module was updated. Reload the page to use the new version.',
      'reload.mustToast': 'The Display Template / CTG module was updated and this page must be reloaded.',
      'reload.action': 'Reload',
      // shared UI words
      'ui.close': 'Close',
      'ui.cancel': 'Cancel',
      'ui.confirm': 'Confirm',
      'ui.ok': 'OK',
      'ui.dismiss': 'Dismiss',
      'ui.loading': 'Loading\u2026',
      'ui.notifications': 'Notifications',
      'ui.menu': 'Actions',
      // strict input parsing
      'input.empty': 'Enter a value',
      'input.grouping': 'Remove thousands separators',
      'input.groupingDot': "Remove thousands separators (use '{decimal}' for decimals)",
      'input.notNumber': 'Enter a number',
      'input.notInteger': 'Enter a whole number',
      'input.tooLarge': 'Value is too large for a {type} tag',
      'input.tooLong': 'Too long (max {max} characters)',
      'input.between': 'Must be between {low} and {high}.',
      'input.betweenExclusive': 'Must be greater than {low} and less than {high}.',
      'input.atLeast': 'Must be at least {low}.',
      'input.atMost': 'Must be at most {high}.',
      'input.above': 'Must be greater than {low}.',
      'input.below': 'Must be less than {high}.',
      'input.notBoolean': 'Choose true or false',
      'input.choose': 'Choose a value',
      'input.unsupported': "Values of this type can't be written here.",
      // protocol error codes (errorText)
      'error.UNKNOWN': 'Something went wrong ({code}).',
      'error.BAD_REQUEST': 'The request was not valid.',
      'error.UNKNOWN_MESSAGE': 'The gateway module does not know this request. Reload the page.',
      'error.PROTOCOL_MISMATCH': 'The module was updated. Reload the page.',
      'error.RATE_LIMITED': 'Too many requests. Wait a moment.',
      'error.MODULE_STOPPING': 'The gateway module is restarting.',
      'error.INTERNAL': 'Something went wrong on the gateway.',
      'error.DISABLED': 'Editing is turned off for this value.',
      'error.WRITE_DISABLED': 'Editing is turned off for this value.',
      'error.ACTION_DISABLED': 'This action is turned off.',
      'error.NO_TAG_PATH': 'No tag is configured.',
      'error.INVALID_PATH': 'The tag path is not valid.',
      'error.STALE_TARGET': 'The tag changed while this dialog was open. Close it and try again.',
      'error.AUTH_REQUIRED': 'Log in to change this value.',
      'error.FORBIDDEN_ROLE': "You don't have permission to change this value.",
      'error.DESIGNER_READ_ONLY': 'The Designer is in read-only mode. Switch to Read/Write to write tags.',
      'error.TAG_NOT_FOUND': 'Tag not found.',
      'error.ACCESS_DENIED': "You don't have access to this tag.",
      'error.READ_ONLY': 'This tag is read-only.',
      'error.WRITE_DENIED': 'The tag provider denied the change.',
      'error.EDIT_DENIED': 'The tag provider denied the change.',
      'error.INVALID_VALUE': 'That value is not valid for this tag.',
      'error.UNSUPPORTED_TYPE': "Values of this type can't be written here.",
      'error.NOT_AN_OPTION': 'Choose one of the listed values.',
      'error.OUT_OF_RANGE': function (d) {
        if (d.low != null && d.high != null) return fill('Must be between {low} and {high}.', d);
        if (d.low != null) return fill('Must be at least {low}.', d);
        if (d.high != null) return fill('Must be at most {high}.', d);
        return 'The value is outside the allowed range.';
      },
      'error.TIMEOUT': NO_CONFIRMATION,
      'error.CLIENT_TIMEOUT': NO_CONFIRMATION,
      'error.WRITE_FAILED': function (d) {
        return d.quality != null ? fill('Write failed (quality {quality}).', d) : 'Write failed.';
      },
      'error.PROVIDER_UNRESOLVED': 'Could not find the tag provider.',
      'error.NO_HISTORY': 'No history available for this tag.',
      'error.TREND_LIST_FULL': function (d) {
        return d.max != null ? fill('The trend list is full ({max} tags).', d) : 'The trend list is full.';
      },
      'error.BROWSE_ROOT_VIOLATION': 'This folder is outside the area this chart may browse.',
      'error.TOKEN_INVALID': 'Chart data access expired. It renews automatically.',
      'error.TOKEN_EXPIRED': 'Chart data access expired. It renews automatically.',
      'error.SESSION_MISMATCH': 'The request did not come from this session. Reload the page.',
      'error.UNSUPPORTED_MEDIA_TYPE': 'The request was not valid.',
      'error.BODY_TOO_LARGE': 'The request is too large.',
      'error.TOO_MANY_PENS': 'Too many pens in one request.',
      'error.RANGE_INVALID': 'The time range is not valid.',
      'error.RANGE_TOO_LARGE': 'The time range is too large. Choose a shorter range or aggregated data.',
      'error.TOO_MANY_REQUESTS': 'Too many requests. Wait a moment.',
      'error.BUSY': 'The gateway is busy. Trying again shortly.',
      'error.HISTORY_QUERY_FAILED': 'The historian could not answer this query.',
      'error.OUT_OF_SCOPE': 'This tag is outside the area this screen may use.',
      'error.LIMITS_INVALID': 'The allowed range for this value is misconfigured.',
      'error.LIMITS_UNAVAILABLE': 'The allowed range for this value is not available right now. Try again later.',
      'error.AUTH_CHANGED': 'The logged-in user changed. Try again.',
      'error.BAD_QUALITY': "The tag's quality is bad, so it can't be changed right now.",
      'error.STEP_TOO_LARGE': function (d) {
        return d.max != null ? fill('Change is larger than allowed (max \u00B1{max}).', d) : 'Change is larger than allowed.';
      },
      'error.AUDIT_UNAVAILABLE': 'No audit log is configured for this project.',
      'error.BOUND_BIDIRECTIONAL': "Editing is turned off: this screen's configuration is not safe (ask the integrator).",
      'error.NOT_OWNER': 'You can only change your own notes.',
      'error.LENGTH_REQUIRED': 'The request was not valid.',
      'error.ANNOTATIONS_UNSUPPORTED': 'Notes are not supported by this historian.',
      'error.ANNOTATION_NOT_FOUND': 'This note no longer exists.',
      // client-only codes
      'error.DISCONNECTED': 'Not connected to the gateway. Nothing was written.',
      'error.DETACHED': '',
    });

    /* ========================================================================
     * SECTION 4 / NS.time — time-zone aware formatting (DOM-free)
     * ----------------------------------------------------------------------
     * Everything is built on Intl.DateTimeFormat#formatToParts with an IANA
     * zone, so the session's time zone (not the browser's) drives what users
     * see. Tokens: YYYY YY MMMM MMM MM M DD D HH H hh h mm ss SSS A ZZ;
     * [text] is a literal. zonedToEpoch turns zone wall time into epoch ms and
     * reports DST gaps (moved forward) and overlaps (earlier instant chosen).
     * ====================================================================== */
    var DAY_MS = 86400000;
    var UNIT_MS = {
      ms: 1, seconds: 1000, minutes: 60000, hours: 3600000, days: DAY_MS, weeks: 7 * DAY_MS,
      months: 30 * DAY_MS, years: 365 * DAY_MS,
    };
    var UNIT_ALIAS = {
      ms: 'ms', millisecond: 'ms', milliseconds: 'ms',
      s: 'seconds', sec: 'seconds', second: 'seconds', seconds: 'seconds',
      min: 'minutes', minute: 'minutes', minutes: 'minutes',
      h: 'hours', hour: 'hours', hours: 'hours',
      d: 'days', day: 'days', days: 'days',
      w: 'weeks', week: 'weeks', weeks: 'weeks',
      mo: 'months', month: 'months', months: 'months',
      y: 'years', year: 'years', years: 'years',
    };
    var dtfCache = new Map();
    var zoneValid = new Map();
    var monthNameCache = new Map();
    var TIME_TOKENS = /\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|HH|H|hh|h|mm|ss|SSS|A|ZZ/g;

    function browserZone() {
      try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
    }
    function isValidZone(tz) {
      if (typeof tz !== 'string' || !tz) return false;
      if (zoneValid.has(tz)) return zoneValid.get(tz);
      var ok = true;
      try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (e) { ok = false; }
      zoneValid.set(tz, ok);
      return ok;
    }
    function dtf(tz) {
      var key = tz || '';
      var f = dtfCache.get(key);
      if (!f) {
        f = new Intl.DateTimeFormat('en-US', {
          timeZone: tz || undefined, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric',
          hour: 'numeric', minute: 'numeric', second: 'numeric', era: 'short',
        });
        dtfCache.set(key, f);
      }
      return f;
    }
    /** Wall-clock fields of epoch ms in a zone: {y, M (1-12), d, h, m, s, ms}. Invalid zone -> browser zone. */
    function zoneParts(ms, tz) {
      var zone = isValidZone(tz) ? tz : undefined;
      var p = {};
      var arr = dtf(zone).formatToParts(new Date(ms));
      for (var i = 0; i < arr.length; i++) p[arr[i].type] = arr[i].value;
      var y = Number(p.year);
      if (p.era && /^B/i.test(p.era)) y = 1 - y;      // 1 BC = year 0 (astronomical numbering)
      return {
        y: y, M: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, m: Number(p.minute),
        s: Number(p.second), ms: ((ms % 1000) + 1000) % 1000,
      };
    }
    function utcOf(f) {
      var d = new Date(0);
      d.setUTCFullYear(f.y, f.M - 1, f.d);           // setUTCFullYear keeps years 0..99 literal
      d.setUTCHours(f.h || 0, f.m || 0, f.s || 0, f.ms || 0);
      return d.getTime();
    }
    /** Offset of the zone at an instant, in ms (wall time - UTC). */
    function zoneOffset(ms, tz) { return utcOf(zoneParts(ms, tz)) - ms; }
    function pad(n, w) {
      var s = String(Math.abs(n));
      while (s.length < w) s = '0' + s;
      return (n < 0 ? '-' : '') + s;
    }
    function monthName(M, locale, style) {
      var key = (locale || 'en-US') + '|' + style;
      var arr = monthNameCache.get(key);
      if (!arr) {
        arr = [];
        var f;
        try { f = new Intl.DateTimeFormat(locale || 'en-US', { month: style, timeZone: 'UTC' }); } catch (e) {
          f = new Intl.DateTimeFormat('en-US', { month: style, timeZone: 'UTC' });
        }
        for (var i = 0; i < 12; i++) arr.push(f.format(Date.UTC(2000, i, 15)));
        monthNameCache.set(key, arr);
      }
      return arr[M - 1] || '';
    }
    function sessionPropsOf(store) {
      try {
        if (store && store.view && store.view.page && store.view.page.sessionProps) return store.view.page.sessionProps;
      } catch (e) { /* fall through */ }
      var c = window.__client;
      return c && c.page && c.page.sessionProps ? c.page.sessionProps : null;
    }
    function readSessionProp(store, path) {
      var sp = sessionPropsOf(store);
      if (!sp) return null;
      try {
        var v = typeof sp.read === 'function' ? sp.read(path) : null;
        if (v && typeof v === 'object' && !Array.isArray(v)) v = v.id || v.value || null;
        return v == null ? null : String(v);
      } catch (e) { return null; }
    }

    NS.time = {
      UNIT_MS: UNIT_MS,
      DEFAULT_PATTERN: 'YYYY-MM-DD HH:mm:ss',
      browserZone: browserZone,
      isValidZone: isValidZone,
      parts: zoneParts,
      offset: zoneOffset,

      /** Formats epoch ms in `tz` (IANA; invalid -> browser zone) with the token subset above. */
      format: function (ms, pattern, tz, locale) {
        if (typeof ms !== 'number' || !isFinite(ms)) return '';
        var p = zoneParts(ms, tz);
        var pat = pattern == null || pattern === '' ? NS.time.DEFAULT_PATTERN : String(pattern);
        return pat.replace(TIME_TOKENS, function (m, lit) {
          if (lit !== undefined) return lit;
          switch (m) {
            case 'YYYY': return pad(p.y, 4);
            case 'YY': return pad(((p.y % 100) + 100) % 100, 2);
            case 'MMMM': return monthName(p.M, locale, 'long');
            case 'MMM': return monthName(p.M, locale, 'short');
            case 'MM': return pad(p.M, 2);
            case 'M': return String(p.M);
            case 'DD': return pad(p.d, 2);
            case 'D': return String(p.d);
            case 'HH': return pad(p.h, 2);
            case 'H': return String(p.h);
            case 'hh': return pad(p.h % 12 || 12, 2);
            case 'h': return String(p.h % 12 || 12);
            case 'mm': return pad(p.m, 2);
            case 'ss': return pad(p.s, 2);
            case 'SSS': return pad(p.ms, 3);
            case 'A': return p.h < 12 ? 'AM' : 'PM';
            case 'ZZ': {
              var off = Math.round(zoneOffset(ms, tz) / 60000);
              var a = Math.abs(off);
              return (off < 0 ? '-' : '+') + pad(Math.floor(a / 60), 2) + pad(a % 60, 2);
            }
            default: return m;
          }
        });
      },

      /**
       * Zone wall time -> epoch ms. f = {y, M (1-12), d, h, m, s, ms}. Returns {ms, note}:
       * note 'gap' when that wall time does not exist (spring forward: the instant one gap later is
       * returned, i.e. the time is moved forward), 'overlap' when it exists twice (fall back: the
       * earlier instant), 'invalid' for non-numeric input (ms NaN), else null.
       */
      zonedToEpoch: function (f, tz) {
        if (!f || ![f.y, f.M, f.d].every(isFinite)) return { ms: NaN, note: 'invalid' };
        var fields = { y: +f.y, M: +f.M, d: +f.d, h: +(f.h || 0), m: +(f.m || 0), s: +(f.s || 0), ms: +(f.ms || 0) };
        if (![fields.h, fields.m, fields.s, fields.ms].every(isFinite)) return { ms: NaN, note: 'invalid' };
        var guess = utcOf(fields);
        var offs = [];
        [guess - DAY_MS, guess, guess + DAY_MS].forEach(function (t) {
          var o = zoneOffset(t, tz);
          if (offs.indexOf(o) < 0) offs.push(o);
        });
        var cands = offs.map(function (o) { return guess - o; })
          .filter(function (t) { return zoneOffset(t, tz) === guess - t; })
          .sort(function (a, b) { return a - b; });
        if (!cands.length) {
          return { ms: Math.max.apply(null, offs.map(function (o) { return guess - o; })), note: 'gap' };
        }
        return { ms: cands[0], note: cands.length > 1 ? 'overlap' : null };
      },

      /**
       * ms minus `value` units. seconds/minutes/hours are exact durations; days and weeks keep the
       * wall-clock time in `tz` (a "day" across a DST change is 23/25 h); months and years clamp the
       * day of month (Mar 31 - 1 month = Feb 28/29). Negative values add. Unknown unit -> NaN.
       */
      subtractCalendar: function (ms, value, unit, tz) {
        var u = UNIT_ALIAS[String(unit || '').toLowerCase()];
        var n = Number(value);
        if (!u || !isFinite(n) || typeof ms !== 'number' || !isFinite(ms)) return NaN;
        if (u === 'ms' || u === 'seconds' || u === 'minutes' || u === 'hours') return ms - n * UNIT_MS[u];
        var p = zoneParts(ms, tz);
        if (u === 'days' || u === 'weeks') {
          var nd = new Date(Date.UTC(2000, 0, 1));
          nd.setUTCFullYear(p.y, p.M - 1, p.d - n * (u === 'weeks' ? 7 : 1));
          p.y = nd.getUTCFullYear(); p.M = nd.getUTCMonth() + 1; p.d = nd.getUTCDate();
        } else {
          var total = p.y * 12 + (p.M - 1) - Math.round(n) * (u === 'years' ? 12 : 1);
          p.y = Math.floor(total / 12);
          p.M = total - p.y * 12 + 1;
          var dim = new Date(Date.UTC(2000, 0, 1));
          dim.setUTCFullYear(p.y, p.M, 0);          // day 0 of next month = last day of this month
          p.d = Math.min(p.d, dim.getUTCDate());
        }
        return NS.time.zonedToEpoch(p, tz).ms;
      },

      /**
       * Resolves a time-zone setting to an IANA zone: 'session' (default) -> session prop timeZoneId,
       * 'gateway' -> session prop gateway.timezone, 'browser' -> the browser's zone, else the IANA name
       * itself. Anything invalid falls back to the session zone (one console warning), then the browser.
       */
      resolveZone: function (setting, store) {
        var s = setting == null ? 'session' : String(setting).trim();
        var session = readSessionProp(store, 'timeZoneId');
        var sessionZone = isValidZone(session) ? session : browserZone();
        if (!s || s === 'session') return sessionZone;
        if (s === 'browser') return browserZone();
        if (s === 'gateway') {
          var gw = readSessionProp(store, 'gateway.timezone');
          return isValidZone(gw) ? gw : sessionZone;
        }
        if (isValidZone(s)) return s;
        warnOnce('tz:' + s, 'invalid time zone', JSON.stringify(s), '- using the session time zone');
        return sessionZone;
      },
    };

    /* ========================================================================
     * SECTION 5 / NS.format — numbers, value text and strict input parsing
     * ----------------------------------------------------------------------
     * number(v, pattern, locale): Perspective's own NumberFormat (the Numeric
     * Entry Field's code path, so users get the familiar pattern behaviour)
     * for pure numeric patterns; our Intl port of the Java DecimalFormat
     * subset (patternToIntl) for patterns with quoted or unquoted literal
     * text, and whenever PerspectiveClient.NumberFormat is unavailable (Node
     * tests) or fails. formatter(pattern, locale) returns a cached port
     * function for hot paths (chart axes, pen tables).
     * ====================================================================== */
    var DEFAULT_NUMBER_PATTERN = '#,##0.##';
    var patternCache = new Map();
    var intlCache = new Map();
    var sepCache = new Map();
    var MAX_INT8 = BigInt('9223372036854775807');
    var MIN_INT8 = BigInt('-9223372036854775808');
    var INT_RANGES = {
      Int1: [-128, 127], Int2: [-32768, 32767], Int4: [-2147483648, 2147483647],
    };
    var FLOAT4_MAX = 3.4028234663852886e38;

    function normLocale(l) {
      if (typeof l !== 'string' || !l.trim()) return 'en-US';
      var s = l.trim().replace(/_/g, '-');
      try { return Intl.getCanonicalLocales(s)[0] || 'en-US'; } catch (e) { return 'en-US'; }
    }
    function separators(locale) {
      var loc = normLocale(locale);
      var s = sepCache.get(loc);
      if (!s) {
        s = { decimal: '.', group: ',' };
        try {
          new Intl.NumberFormat(loc).formatToParts(12345.6).forEach(function (p) {
            if (p.type === 'decimal') s.decimal = p.value;
            if (p.type === 'group') s.group = p.value;
          });
        } catch (e) { /* keep defaults */ }
        sepCache.set(loc, s);
      }
      return s;
    }

    /**
     * Parses one sub-pattern (no ';') into {prefix, suffix, core, multiplier}. Quoted text ('...',
     * '' = one quote) is literal; % and ‰ in the prefix/suffix scale the value by 100/1000.
     */
    function parseSubPattern(p) {
      var prefix = '', suffix = '', core = '', multiplier = 1, state = 0, i = 0;   // 0 prefix, 1 core, 2 suffix
      function literal(text) {
        if (state === 1) state = 2;
        if (state === 0) prefix += text; else suffix += text;
      }
      while (i < p.length) {
        var c = p.charAt(i);
        if (c === "'") {
          if (p.charAt(i + 1) === "'") { literal("'"); i += 2; continue; }      // '' outside quotes = one quote
          var lit = '';
          i++;
          while (i < p.length) {                                                // quoted section: '' = one quote
            if (p.charAt(i) === "'") {
              if (p.charAt(i + 1) === "'") { lit += "'"; i += 2; continue; }
              i++;
              break;
            }
            lit += p.charAt(i++);
          }
          literal(lit);
          continue;
        }
        var isCore = /[0#,.]/.test(c) || (state === 1 && /[Ee]/.test(c) && /^[Ee][+-]?0/.test(p.slice(i)));
        if (isCore && state < 2) {
          state = 1;
          if (/[Ee]/.test(c)) {
            var m = /^[Ee][+-]?0+/.exec(p.slice(i));
            core += 'E';
            i += m[0].length;
            continue;
          }
          core += c;
          i++;
          continue;
        }
        if (c === '%') multiplier = 100;
        else if (c === '\u2030') multiplier = 1000;
        literal(c);
        i++;
      }
      return { prefix: prefix, suffix: suffix, core: core, multiplier: multiplier };
    }

    /**
     * Java DecimalFormat subset -> Intl options (+ literal prefix/suffix), cached per pattern:
     * grouping (',' in the integer part), minimum integer digits ('0's), min/max fraction digits
     * ('0' / '#'), percent / per-mille, scientific ('E0'; '##0.##E0' -> engineering), a negative
     * sub-pattern after ';' (its prefix/suffix), quoted literals. Never throws.
     */
    function patternToIntl(pattern) {
      var key = typeof pattern === 'string' ? pattern : '';
      var cached = patternCache.get(key);
      if (cached) return cached;
      var src = key.trim() ? key : DEFAULT_NUMBER_PATTERN;
      // split on the first unquoted ';'
      var inQuote = false, cut = -1;
      for (var i = 0; i < src.length; i++) {
        var c = src.charAt(i);
        if (c === "'") inQuote = !inQuote;
        else if (c === ';' && !inQuote) { cut = i; break; }
      }
      var pos = parseSubPattern(cut < 0 ? src : src.slice(0, cut));
      var neg = cut < 0 ? null : parseSubPattern(src.slice(cut + 1));
      var core = pos.core || '#,##0.##';
      var exp = core.indexOf('E');
      var mant = exp >= 0 ? core.slice(0, exp) : core;
      var dot = mant.indexOf('.');
      var intPart = dot >= 0 ? mant.slice(0, dot) : mant;
      var fracPart = dot >= 0 ? mant.slice(dot + 1).replace(/[^0#]/g, '') : '';
      var minInt = (intPart.match(/0/g) || []).length;
      var minFrac = (fracPart.match(/0/g) || []).length;
      var maxFrac = fracPart.length;
      var options = {
        useGrouping: intPart.indexOf(',') >= 0 && exp < 0,
        minimumIntegerDigits: Math.min(21, Math.max(1, minInt)),
        minimumFractionDigits: Math.min(20, minFrac),
        maximumFractionDigits: Math.min(20, Math.max(minFrac, maxFrac)),
      };
      if (exp >= 0) {
        options.notation = /#/.test(intPart) && intPart.replace(/[^0#]/g, '').length === 3 ? 'engineering' : 'scientific';
      }
      var spec = {
        options: options,
        multiplier: pos.multiplier,
        posPrefix: pos.prefix,
        posSuffix: pos.suffix,
        negPrefix: neg ? neg.prefix : '-' + pos.prefix,
        negSuffix: neg ? neg.suffix : pos.suffix,
        stripLeadingZero: minInt === 0 && dot === 0,    // '.00' prints .5 like DecimalFormat
        key: JSON.stringify([options, pos.multiplier]),
      };
      if (patternCache.size > 500) patternCache.clear();
      patternCache.set(key, spec);
      return spec;
    }

    function intlFor(locale, spec) {
      var k = locale + '|' + spec.key;
      var nf = intlCache.get(k);
      if (!nf) {
        try { nf = new Intl.NumberFormat(locale, spec.options); } catch (e) { nf = new Intl.NumberFormat('en-US'); }
        if (intlCache.size > 500) intlCache.clear();
        intlCache.set(k, nf);
      }
      return nf;
    }
    /**
     * "-0" / "-0.00" (a negative value that rounds to zero) reads as an error to operators, so the
     * sign is dropped. "Rounds to zero" is decided by comparing with the SAME formatter's text for 0,
     * never by looking for ASCII digits: ar/fa/bn/mr locales print native digits, and an ASCII test
     * there would strip (or never add) the minus of every negative value.
     * signless(text): the text without minus signs and the bidi marks Intl puts around them. Parentheses
     * count as a sign too: Perspective's accounting token prints -0.001 as "(0.00)", which must become the
     * plain zero text like "-0.00" does.
     */
    var NATIVE_DIGIT_RE = /\p{Nd}/u;      // a decimal digit of any script
    function signless(text) { return String(text).replace(/[-\u2212\u061C\u200E\u200F()]/g, ''); }
    function nonFiniteText(v) { return v !== v ? 'NaN' : v > 0 ? '\u221E' : '\u2212\u221E'; }

    /** Our port: formats a finite number with a DecimalFormat-subset pattern. */
    function numberIntl(v, pattern, locale) {
      if (typeof v !== 'number') v = Number(v);
      if (!isFinite(v)) return nonFiniteText(v);
      var spec = patternToIntl(pattern);
      var negative = v < 0 || (v === 0 && 1 / v < 0);
      var s, zero = null;
      try {
        var nf = intlFor(normLocale(locale), spec);
        s = nf.format(Math.abs(v) * spec.multiplier);
        if (negative) zero = nf.format(0);
      } catch (e) { s = String(Math.abs(v)); zero = '0'; }
      if (spec.stripLeadingZero) {
        // the locale's own zero digit (ASCII 0, Arabic-Indic U+0660, Persian U+06F0, ...)
        var zd = '0';
        try { zd = intlFor(normLocale(locale), spec).format(0).charAt(0) || '0'; } catch (e) { /* keep '0' */ }
        var strip = function (x) { return x.charAt(0) === zd && x.length > 1 && !NATIVE_DIGIT_RE.test(x.charAt(1)) ? x.slice(1) : x; };
        s = strip(s);
        if (zero != null) zero = strip(zero);
      }
      if (negative && s !== zero) return spec.negPrefix + s + spec.negSuffix;
      return spec.posPrefix + s + spec.posSuffix;
    }

    /**
     * Letters Perspective's NumberFormat would misread or drop: anything except the exponent and its
     * numeral-style tokens (a = abbreviate, o = ordinal, b/ib/mb = bytes). Such patterns, and every
     * pattern with a quoted literal, use our port so literal text survives.
     */
    function perspectiveCanFormat(pattern) {
      if (!PC || typeof PC.NumberFormat !== 'function' || !PC.NumberFormatType) return false;
      if (pattern.indexOf("'") >= 0 || pattern.indexOf(';') >= 0 || pattern.indexOf('\u2030') >= 0) return false;
      var letters = pattern.replace(/[^A-Za-z]/g, '');
      return letters === '' || /^(E|e|a|A|o|b|ib|mb)$/.test(letters);
    }

    /** Units/bigint grouping helper: does the pattern ask for grouping? */
    function patternGroups(pattern) { return patternToIntl(pattern).options.useGrouping; }

    function buildFixedPattern(d, grouping) {
      var n = Math.trunc(Number(d));
      n = isFinite(n) ? NS.util.clamp(n, 0, 15) : 0;
      return (grouping ? '#,##0' : '0') + (n ? '.' + '0'.repeat(n) : '');
    }

    function perspectiveFormat(v, pat, loc) {
      var nf = new PC.NumberFormat(v);
      nf.type = PC.NumberFormatType.NUMBER;
      return nf.format(pat, '', loc);
    }
    var pZeroCache = new Map();
    /** Perspective's text for 0 with this pattern/locale (cached); null when it cannot format 0. */
    function perspectiveZero(pat, loc) {
      var k = loc + '|' + pat;
      if (pZeroCache.has(k)) return pZeroCache.get(k);
      var z = null;
      try { z = perspectiveFormat(0, pat, loc); } catch (e) { z = null; }
      if (typeof z !== 'string' || z === '') z = null;
      if (pZeroCache.size > 500) pZeroCache.clear();
      pZeroCache.set(k, z);
      return z;
    }

    function formatNumber(v, pattern, locale) {
      if (typeof v !== 'number') {
        if (typeof v === 'string' && NUMERIC_RE.test(v.trim())) v = Number(v.trim());
        else if (typeof v === 'bigint') v = Number(v);
        else return v == null ? '' : String(v);
      }
      if (!isFinite(v)) return nonFiniteText(v);
      var pat = typeof pattern !== 'string' || pattern.trim() === '' ? DEFAULT_NUMBER_PATTERN : pattern;
      var loc = normLocale(locale);
      if (perspectiveCanFormat(pat)) {
        try {
          var out = perspectiveFormat(v, pat, loc);
          if (typeof out === 'string' && out !== '') {
            if (!(v < 0 || (v === 0 && 1 / v < 0))) return out;
            var zero = perspectiveZero(pat, loc);
            return zero != null && signless(out) === signless(zero) ? zero : out;
          }
        } catch (e) {
          warnOnce('nf:' + pat, 'Perspective NumberFormat failed for pattern', JSON.stringify(pat), '- using the built-in formatter');
        }
      }
      return numberIntl(v, pat, loc);
    }

    /** Session locale (session prop `locale`), canonicalised; 'en-US' when unknown. */
    function sessionLocale(store) {
      return normLocale(readSessionProp(store, 'locale') || (typeof navigator !== 'undefined' && navigator.language) || 'en-US');
    }

    /* ---- value text -------------------------------------------------------- */
    function formatScalar(v, o, depth) {
      if (v === null || v === undefined) return o.nullText;
      if (typeof v === 'boolean') return v ? (o.trueText || 'true') : (o.falseText || 'false');
      if (typeof v === 'number') return formatNumber(v, o.pattern, o.locale);
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return formatArray(v, o, depth + 1);
      if (isPlainObject(v) && isPlainObject(v.dataset)) return datasetText(v.dataset);
      return jsonText(v);
    }
    function formatArray(arr, o, depth) {
      if (depth > 3) return '[\u2026]';
      var max = Math.max(1, Math.trunc(Number(o.maxArrayItems)) || 10);
      var parts = [];
      for (var i = 0; i < arr.length && i < max; i++) parts.push(formatScalar(arr[i], o, depth));
      var more = arr.length - parts.length;
      return parts.join(', ') + (more > 0 ? ' \u2026 (+' + more + ')' : '');
    }
    function datasetText(ds) {
      return 'Dataset [' + (Number(ds.rows) || 0) + ' \u00D7 ' + (Number(ds.cols) || 0) + ']';
    }
    function jsonText(v) {
      var s;
      try { s = JSON.stringify(v); } catch (e) { s = String(v); }
      s = s == null ? String(v) : s;
      return s.length > 200 ? s.slice(0, 199) + '\u2026' : s;
    }

    /**
     * Value text of a pushed value (pure, shared with the chart):
     * enc = {v, t, type, q, bigint?, nonFinite?, truncated?}; opts = {format, decimals, dateFormat,
     * nullText, loadingText, maxArrayItems, trueText, falseText, states[{value,label}], unmatchedText,
     * tagFormat, locale, timeZone}. Returns {text, kind, numeric, state, approximate}. Never throws.
     * kind: loading | nonFinite | null | state | boolean | number | date | string | array | dataset | object.
     */
    function formatValue(enc, opts) {
      var o = opts || {};
      var nullText = o.nullText != null ? String(o.nullText) : '\u2014';
      var res = { text: '', kind: 'loading', numeric: null, state: null, approximate: false };
      if (enc == null || typeof enc !== 'object') { res.text = o.loadingText != null ? String(o.loadingText) : '\u2026'; return res; }
      var v = enc.v;
      var decimals = o.decimals == null || o.decimals === '' ? null : Math.trunc(Number(o.decimals));
      if (decimals != null && !isFinite(decimals)) decimals = null;
      var basePattern = (typeof o.format === 'string' && o.format.trim()) ? o.format
        : (typeof o.tagFormat === 'string' && o.tagFormat.trim()) ? o.tagFormat : DEFAULT_NUMBER_PATTERN;
      var pattern = decimals != null ? buildFixedPattern(decimals, patternGroups(basePattern)) : basePattern;
      var fo = {
        pattern: pattern, locale: o.locale, nullText: nullText, trueText: o.trueText, falseText: o.falseText,
        maxArrayItems: o.maxArrayItems,
      };
      try {
        if (v === null || v === undefined) {
          if (enc.nonFinite) {
            var nf = String(enc.nonFinite);
            res.numeric = nf === 'Infinity' ? Infinity : nf === '-Infinity' ? -Infinity : NaN;
            res.text = nonFiniteText(res.numeric);
            res.kind = 'nonFinite';
            return res;
          }
          res.text = nullText; res.kind = 'null';
          return res;
        }
        var states = Array.isArray(o.states) ? o.states : [];
        if (states.length) {
          for (var i = 0; i < states.length; i++) {
            var st = states[i];
            if (st && hasOwn.call(st, 'value') && NS.util.looseEqual(st.value, v)) {
              res.text = st.label == null ? String(v) : String(st.label);
              res.kind = 'state'; res.state = st;
              res.numeric = looseNumber(v) === undefined ? null : looseNumber(v);
              return res;
            }
          }
          if (o.unmatchedText != null && o.unmatchedText !== '') {
            res.text = String(o.unmatchedText); res.kind = 'state';
            // the value stays numeric for threshold alarms (an unexpected fault code must not lose its alarm
            // colour just because no state matches it)
            res.numeric = looseNumber(v) === undefined ? null : looseNumber(v);
            return res;
          }
        }
        if (enc.type === 'Boolean' || typeof v === 'boolean') {
          var b = typeof v === 'boolean' ? v
            : typeof v === 'string' ? /^\s*(true|1|on|yes)\s*$/i.test(v)    // the words parseInput accepts
              : NS.util.looseEqual(v, true);
          res.text = b ? (o.trueText || 'true') : (o.falseText || 'false');
          res.kind = 'boolean'; res.numeric = b ? 1 : 0;
          return res;
        }
        if (enc.bigint && typeof v === 'string' && /^[+-]?\d+$/.test(v.trim())) {
          var big = BigInt(v.trim());
          var groups = patternGroups(pattern);
          try {
            res.text = big.toLocaleString(normLocale(o.locale), { useGrouping: groups });
          } catch (e) { res.text = big.toString(); }
          res.kind = 'number'; res.numeric = Number(big); res.approximate = true;
          return res;
        }
        if (enc.type === 'DateTime' && typeof v === 'number') {
          res.text = NS.time.format(v, o.dateFormat || NS.time.DEFAULT_PATTERN, o.timeZone, o.locale);
          res.kind = 'date'; res.numeric = v;
          return res;
        }
        if (typeof v === 'number') {
          res.text = formatNumber(v, pattern, o.locale);
          res.kind = isFinite(v) ? 'number' : 'nonFinite'; res.numeric = v;
          return res;
        }
        if (typeof v === 'string') {
          res.text = enc.truncated ? v + '\u2026' : v;
          res.kind = 'string';
          return res;
        }
        if (Array.isArray(v)) { res.text = formatArray(v, fo, 0); res.kind = 'array'; return res; }
        if (isPlainObject(v) && isPlainObject(v.dataset)) { res.text = datasetText(v.dataset); res.kind = 'dataset'; return res; }
        res.text = enc.truncated && enc.summary ? String(enc.summary) : jsonText(v);
        res.kind = 'object';
        return res;
      } catch (e) {
        warnOnce('fmt-value', 'value formatting failed', e);
        res.text = String(v); res.kind = 'string';
        return res;
      }
    }

    /* ---- strict input parsing ---------------------------------------------- */
    function dataTypeFamily(dt) {
      var t = String(dt == null ? '' : dt);
      if (!t) return 'float';
      if (/Array$/i.test(t) || /^(DateTime|DataSet|Document|Dataset)$/i.test(t)) return 'unsupported';
      if (/^(Int[1248]|Integer|Short|Long|Byte)$/i.test(t)) return 'int';
      if (/^(Float[48]|Double|Float|Number)$/i.test(t)) return 'float';
      if (/^Boolean$/i.test(t)) return 'boolean';
      if (/^(String|Text)$/i.test(t)) return 'string';
      return 'unsupported';
    }
    /** Canonical Ignition integer type of an int-family name (aliases Byte/Short/Integer/Long, any case). */
    function intTypeName(dt) {
      var t = String(dt == null ? '' : dt).toLowerCase();
      return { int1: 'Int1', byte: 'Int1', int2: 'Int2', short: 'Int2', int4: 'Int4', integer: 'Int4' }[t] || 'Int8';
    }
    function inputFail(code, key, vars) { return { ok: false, code: code, error: NS.i18n.t(key, vars) }; }
    function checkLimits(num, opts) {
      var lim = opts && opts.limits;
      if (!lim) return null;
      var low = NS.util.isFiniteNum(lim.low) ? lim.low : null;
      var high = NS.util.isFiniteNum(lim.high) ? lim.high : null;
      if (low != null && high != null && low > high) return null;     // misconfigured: the gateway decides
      var inclusive = lim.inclusive !== false;
      var fmt = typeof opts.formatLimit === 'function' ? opts.formatLimit : function (n) { return String(n); };
      var tooLow = low != null && (inclusive ? num < low : num <= low);
      var tooHigh = high != null && (inclusive ? num > high : num >= high);
      if (!tooLow && !tooHigh) return null;
      var vars = { low: low == null ? '' : fmt(low), high: high == null ? '' : fmt(high) };
      if (low != null && high != null) return inputFail('OUT_OF_RANGE', inclusive ? 'input.between' : 'input.betweenExclusive', vars);
      if (tooLow) return inputFail('OUT_OF_RANGE', inclusive ? 'input.atLeast' : 'input.above', vars);
      return inputFail('OUT_OF_RANGE', inclusive ? 'input.atMost' : 'input.below', vars);
    }

    /**
     * Strict, locale-aware parse of an operator's text (advisory; the gateway re-validates).
     * Returns {ok:true, value} or {ok:false, code, error}. Never NaN, never throws.
     * - trimmed; empty -> 'Enter a value'
     * - decimal separator: '.' always, ',' only when the locale's decimal separator is ','; any
     *   grouping character -> 'Remove thousands separators' (so '1,500' in en-US is never 1.5, and
     *   '1.500' in a comma-decimal locale such as de-DE is never 1.5 either)
     * - Float: strict decimal syntax, finite; Int: digits only, within the type width; Int8 beyond
     *   ±(2^53-1) is returned as a canonical digit string
     * - opts.limits {low, high, inclusive} and opts.maxLength (strings); opts.formatLimit(n) formats
     *   the limits in messages.
     */
    function parseInput(text, dataType, locale, opts) {
      var family = dataTypeFamily(dataType);
      var raw = text == null ? '' : String(text);
      if (family === 'unsupported') return inputFail('UNSUPPORTED', 'input.unsupported');
      if (family === 'string') {
        var max = opts && opts.maxLength != null ? Math.trunc(Number(opts.maxLength)) : null;
        if (max != null && isFinite(max) && max >= 0 && raw.length > max) return inputFail('TOO_LONG', 'input.tooLong', { max: max });
        return { ok: true, value: raw };
      }
      var t = raw.trim();
      if (!t) return inputFail('EMPTY', 'input.empty');
      if (family === 'boolean') {
        var lower = t.toLowerCase();
        if (/^(true|1|on|yes)$/.test(lower)) return { ok: true, value: true };
        if (/^(false|0|off|no)$/.test(lower)) return { ok: true, value: false };
        return inputFail('NOT_BOOLEAN', 'input.notBoolean');
      }
      var seps = separators(locale);
      var commaDecimal = seps.decimal === ',';
      var hasGroupingChar = /[\s\u00A0\u202F\u2009'\u2019_]/.test(t) ||
        (!commaDecimal && t.indexOf(',') >= 0) ||
        (t.indexOf(',') >= 0 && t.indexOf('.') >= 0) ||
        (seps.group && seps.group !== '.' && seps.group !== ',' && t.indexOf(seps.group) >= 0);
      if (hasGroupingChar) return inputFail('GROUPING', 'input.grouping');
      // Comma-decimal locales group with '.' (de-DE "1.500" = 1500). '.' stays a decimal point, but text
      // that is well-formed '.'-grouping ("1.500", "12.345.678") is ambiguous there and is rejected
      // instead of silently becoming 1.5. "1.5", "0.500", "1000.25" still parse.
      if (commaDecimal && /^[+-]?[1-9]\d{0,2}(\.\d{3})+$/.test(t)) {
        return inputFail('GROUPING', 'input.groupingDot', { decimal: seps.decimal });
      }
      var norm = commaDecimal ? t.replace(',', '.') : t;
      if (family === 'int') {
        if (!/^[+-]?\d+$/.test(norm)) return inputFail('NOT_INTEGER', 'input.notInteger');
        var big = BigInt(norm.replace(/^\+/, ''));
        var type = intTypeName(dataType);      // canonical name in the message ('Int2', not 'short')
        var range = INT_RANGES[type];
        var lo = range ? BigInt(range[0]) : MIN_INT8;
        var hi = range ? BigInt(range[1]) : MAX_INT8;
        if (big < lo || big > hi) return inputFail('TOO_LARGE', 'input.tooLarge', { type: type });
        var num = Number(big);
        var lim = checkLimits(num, opts);
        if (lim) return lim;
        var safe = big <= BigInt(Number.MAX_SAFE_INTEGER) && big >= BigInt(-Number.MAX_SAFE_INTEGER);
        return { ok: true, value: safe ? (num === 0 ? 0 : num) : big.toString() };
      }
      if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(norm)) return inputFail('NOT_NUMBER', 'input.notNumber');
      var f = Number(norm);
      if (!isFinite(f)) return inputFail('NOT_NUMBER', 'input.notNumber');
      if (/^Float4$/i.test(String(dataType)) && Math.abs(f) > FLOAT4_MAX) {
        return inputFail('TOO_LARGE', 'input.tooLarge', { type: 'Float4' });
      }
      var lf = checkLimits(f, opts);
      if (lf) return lf;
      return { ok: true, value: f === 0 ? 0 : f };
    }

    NS.format = {
      DEFAULT_PATTERN: DEFAULT_NUMBER_PATTERN,
      number: formatNumber,
      numberIntl: numberIntl,
      /** Cached port formatter for hot paths: formatter(pattern, locale)(v) -> text. */
      formatter: function (pattern, locale) {
        var loc = normLocale(locale);
        return function (v) { return numberIntl(v, pattern, loc); };
      },
      patternToIntl: patternToIntl,
      buildFixedPattern: buildFixedPattern,
      value: formatValue,
      date: function (ms, fmt, tz, locale) { return NS.time.format(ms, fmt || NS.time.DEFAULT_PATTERN, tz, locale); },
      parseInput: parseInput,
      dataTypeFamily: dataTypeFamily,
      decimalSeparator: function (locale) { return separators(locale).decimal; },
      groupSeparator: function (locale) { return separators(locale).group; },
      normLocale: normLocale,
      locale: sessionLocale,
      nonFiniteText: nonFiniteText,
    };

    /* ========================================================================
     * SECTION 6 / NS.quality and NS.alarm — tiny classification helpers
     * ----------------------------------------------------------------------
     * Quality arrives as {code, name, level} (backend ValueCodec, level lower
     * case), but a bare Ignition QualityCode int or name is accepted too: the
     * level is in bits 30-31 of the code (0 good, 1 uncertain, 2 bad, 3
     * error), e.g. Bad_AccessDenied -2147483134 = 0x80000202 -> bad.
     * ====================================================================== */
    var LEVELS = ['good', 'uncertain', 'bad', 'error'];
    function levelOfCode(code) { return LEVELS[(code >>> 30) & 3]; }
    function levelOfName(name) {
      var m = /^(good|uncertain|bad|error)/i.exec(String(name).trim());
      return m ? m[1].toLowerCase() : 'uncertain';
    }
    NS.quality = {
      LEVELS: LEVELS,
      /** 'good' | 'uncertain' | 'bad' | 'error' (missing quality counts as good). */
      level: function (q) {
        if (q == null) return 'good';
        if (typeof q === 'number') return isFinite(q) ? levelOfCode(q) : 'error';
        if (typeof q === 'string') return levelOfName(q);
        if (typeof q === 'object') {
          if (typeof q.level === 'string' && LEVELS.indexOf(q.level.toLowerCase()) >= 0) return q.level.toLowerCase();
          if (typeof q.code === 'number' && isFinite(q.code)) return levelOfCode(q.code);
          if (q.name != null) return levelOfName(q.name);
        }
        return 'uncertain';
      },
      isGood: function (q) { return NS.quality.level(q) === 'good'; },
      /** Quality name for labels and aria text, e.g. "Bad_NotConnected". */
      label: function (q) {
        if (q == null) return 'Good';
        if (typeof q === 'string') return q;
        if (typeof q === 'number') return String(q);
        if (q.name) return String(q.name);
        var l = NS.quality.level(q);
        return l.charAt(0).toUpperCase() + l.slice(1);
      },
    };

    var PRIORITIES = Object.freeze(['Diagnostic', 'Low', 'Medium', 'High', 'Critical']);
    NS.alarm = {
      PRIORITIES: PRIORITIES,
      /** 0..4 from a priority name (any case) or an int / numeric string 0..4; else null. */
      priority: function (x) {
        if (x == null || x === '') return null;
        if (typeof x === 'number' || (typeof x === 'string' && /^\s*\d+\s*$/.test(x))) {
          var n = Number(x);
          return n >= 0 && n <= 4 && Math.trunc(n) === n ? n : null;
        }
        var s = String(x).trim().toLowerCase();
        for (var i = 0; i < PRIORITIES.length; i++) if (PRIORITIES[i].toLowerCase() === s) return i;
        return null;
      },
      name: function (x) {
        var p = NS.alarm.priority(x);
        return p == null ? null : PRIORITIES[p];
      },
    };

    /* ========================================================================
     * SECTION 7 / NS.props — reducer helpers (never throw)
     * ----------------------------------------------------------------------
     * merge(defaults, raw): objects merge recursively, arrays and scalars
     *   replace, undefined keeps the default; an object default never takes a
     *   non-object value (a mistyped group falls back to its defaults).
     * coerce(value, rule): schema-lite field coercion (see below).
     * style(tree, path) | style(rawStyleObj): {className, style} with
     *   Perspective's own psc- class mapping.
     * color(v): a colour string only after CSS.supports (no CSS injection
     *   through a colour prop).
     * ====================================================================== */
    function unsafeKey(k) { return k === '__proto__' || k === 'constructor' || k === 'prototype'; }
    function merge(d, r) {
      if (r === undefined) return d;
      if (isPlainObject(d)) {
        if (!isPlainObject(r)) return d;
        var out = {};
        var k;
        for (k in d) if (hasOwn.call(d, k)) out[k] = merge(d[k], r[k]);
        // '__proto__' (an own key after JSON.parse) would re-point out's prototype: never copied
        for (k in r) if (hasOwn.call(r, k) && !hasOwn.call(d, k) && !unsafeKey(k)) out[k] = r[k];
        return out;
      }
      return r;
    }

    function cssColor(v) {
      if (typeof v !== 'string') return null;
      var s = v.trim();
      if (!s) return null;
      if (/^--[A-Za-z0-9_-]+$/.test(s)) return 'var(' + s + ')';
      if (/[;{}<>\\]/.test(s)) { warnOnce('color:' + s, 'ignored unsafe colour', JSON.stringify(s)); return null; }
      var css = window.CSS;
      if (css && typeof css.supports === 'function') {
        if (css.supports('color', s)) return s;
        warnOnce('color:' + s, 'ignored invalid colour', JSON.stringify(s));
        return null;
      }
      return s;   // no CSS object (Node tests): the hygiene regex above is the only check
    }

    /**
     * rule = {type:'number'|'integer'|'string'|'boolean'|'enum'|'array'|'object'|'color'|'any',
     *         default, min, max, values (enum), nullable, maxLength, item (rule or fn: returns
     *         undefined to drop an array item)}.
     */
    function coerce(value, rule) {
      var r = rule || {};
      var dflt = r.default;
      if (value === undefined) return dflt;
      if (value === null) return r.nullable ? null : dflt;
      switch (r.type) {
        case 'number':
        case 'integer': {
          var n = typeof value === 'number' ? value
            : typeof value === 'string' && NUMERIC_RE.test(value.trim()) ? Number(value.trim()) : NaN;
          if (!isFinite(n)) return dflt;
          if (r.type === 'integer') n = Math.trunc(n);
          if (r.min != null && n < r.min) n = r.min;
          if (r.max != null && n > r.max) n = r.max;
          return n;
        }
        case 'string': {
          var s = typeof value === 'string' ? value
            : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
          if (s === undefined) return dflt;
          return r.maxLength != null && s.length > r.maxLength ? s.slice(0, r.maxLength) : s;
        }
        case 'boolean':
          if (typeof value === 'boolean') return value;
          if (value === 'true' || value === 1) return true;
          if (value === 'false' || value === 0) return false;
          return dflt;
        case 'enum':
          return Array.isArray(r.values) && r.values.indexOf(value) >= 0 ? value : dflt;
        case 'array': {
          if (!Array.isArray(value)) return dflt;
          if (!r.item) return value.slice();
          var out = [];
          for (var i = 0; i < value.length; i++) {
            var it = typeof r.item === 'function' ? r.item(value[i], i) : coerce(value[i], r.item);
            if (it !== undefined) out.push(it);
          }
          return out;
        }
        case 'object':
          return isPlainObject(value) ? value : dflt;
        case 'color': {
          var c = cssColor(value);
          return c == null ? dflt : c;
        }
        default:
          return value;
      }
    }

    function camel(k) { return String(k).replace(/-([a-z])/g, function (m, c) { return c.toUpperCase(); }); }
    /** v1-compatible fallback when Perspective's style helpers are unavailable. */
    function cssProps(styleObj) {
      var res = { className: '', style: {} };
      if (!isPlainObject(styleObj)) return res;
      var cls = styleObj.classes;
      var list = Array.isArray(cls) ? cls : typeof cls === 'string' ? cls.split(/\s+/) : [];
      res.className = list.filter(function (c) { return typeof c === 'string' && c; })
        .map(function (c) { return /^(ia_|psc-)/.test(c) ? c : 'psc-' + c; }).join(' ');
      for (var k in styleObj) {
        if (!hasOwn.call(styleObj, k) || k === 'classes') continue;
        var v = styleObj[k];
        if (typeof v === 'number') res.style[camel(k)] = v;
        else if (typeof v === 'string' && !/[;{}<>]/.test(v)) res.style[camel(k)] = /^--[A-Za-z0-9_-]+$/.test(v.trim()) ? 'var(' + v.trim() + ')' : v;
      }
      return res;
    }
    function fromStyleProps(sp) {
      if (!sp || typeof sp !== 'object') return null;
      return { className: typeof sp.className === 'string' ? sp.className : '', style: isPlainObject(sp.style) ? sp.style : (sp.style || {}) };
    }
    function styleFromRaw(raw) {
      if (!isPlainObject(raw)) return { className: '', style: {} };
      if (PC && PC.PropertyTree && typeof PC.PropertyTree.parseStyle === 'function') {
        try {
          var st = PC.PropertyTree.parseStyle(raw);
          var r = st && typeof st.toStyleProps === 'function' ? fromStyleProps(st.toStyleProps()) : null;
          if (r) return r;
        } catch (e) { /* fall back */ }
      }
      return cssProps(raw);
    }

    NS.props = {
      merge: merge,
      coerce: coerce,
      color: cssColor,
      cssProps: cssProps,
      /**
       * style(tree, path): tree.readStyle(path).toStyleProps() (psc- classes, colour variables),
       * falling back to PropertyTree.parseStyle(tree.read(path)) and then to cssProps.
       * style(rawStyleObj): the same for a plain style object. Always {className, style}.
       */
      style: function (a, path) {
        if (a && typeof a.readStyle === 'function' && path != null) {
          try {
            var st = a.readStyle(path);
            var r = st && typeof st.toStyleProps === 'function' ? fromStyleProps(st.toStyleProps()) : null;
            if (r) return r;
          } catch (e) { /* fall back */ }
          var raw;
          try { raw = a.read(path); } catch (e) { raw = null; }
          return styleFromRaw(raw);
        }
        return styleFromRaw(a);
      },
    };

    /* ========================================================================
     * SECTION 8 / NS.clock — one page-wide gateway clock
     * ----------------------------------------------------------------------
     * offset = gateway ms - browser ms, the median of the last 5 samples.
     *   push sample:    serverNow - receivedAt
     *   request sample: serverNow - (sentAt + receivedAt) / 2   (RTT-centred)
     * NS.clock.now() is "now" on the gateway's clock.
     * ====================================================================== */
    var samples = [];
    var offsetMs = 0;
    NS.clock = {
      sample: function (serverNow, sentAt, receivedAt) {
        if (!NS.util.isFiniteNum(serverNow)) return;
        var rx = NS.util.isFiniteNum(receivedAt) ? receivedAt : Date.now();
        var local = NS.util.isFiniteNum(sentAt) ? (sentAt + rx) / 2 : rx;
        samples.push(serverNow - local);
        if (samples.length > 5) samples.shift();
        var sorted = samples.slice().sort(function (a, b) { return a - b; });
        offsetMs = sorted[Math.floor(sorted.length / 2)];
      },
      offset: function () { return offsetMs; },
      now: function () { return Date.now() + offsetMs; },
    };

    /* ========================================================================
     * SECTION 9 / NS.theme — shared tokens, overlay stylesheet, theme watch
     * ----------------------------------------------------------------------
     * One token set on :root, every value resolving through the active
     * Perspective theme's variables, so light and dark themes both work.
     * The sheet is wrapped in :where() (zero specificity): a
     * project stylesheet or theme rule always wins without !important.
     * ensureStyles replaces a sheet whose data-ctg-build differs (a module
     * upgrade never keeps the old rules).
     * The page-level theme watcher keeps <html data-ctg-scheme="light|dark">
     * current, so parts can give tokens dark values in plain CSS:
     *   :where(:root[data-ctg-scheme="dark"]) { --dt-low-color: #8FA9C8; }
     * ====================================================================== */
    var TOKENS_CSS = [
      ':where(:root){',
      '--ctg-surface:var(--contextBackground,var(--containerRoot,#FFFFFF));',
      '--ctg-surface-2:var(--container,#F3F4F5);',
      '--ctg-text:var(--label,#323232);',
      '--ctg-text-muted:var(--label--disabled,#767676);',
      '--ctg-border:var(--border,#A1A1A1);',
      '--ctg-input-bg:var(--input,#FFFFFF);',
      '--ctg-input-text:var(--label,#323232);',
      '--ctg-primary:var(--callToAction,#0C7BB3);',
      '--ctg-primary-text:#FFFFFF;',
      '--ctg-danger:var(--error,#DA1E28);',
      '--ctg-warn:var(--warning,#AD5F00);',
      '--ctg-success:var(--success,#038537);',
      '--ctg-focus:var(--focus,var(--callToAction,#0C7BB3));',
      '--ctg-backdrop:rgba(0,0,0,.4);',
      '--ctg-shadow:0 4px 16px rgba(0,0,0,.25);',
      '--ctg-radius:var(--borderRadius,4px);',
      '--ctg-font:var(--font-NotoSans,inherit);',
      '--ctg-z:12000;}',
      // dark schemes: the light call-to-action blue needs dark text to reach 4.5:1
      ':where(:root[data-ctg-scheme="dark"]){--ctg-primary-text:#000000;--ctg-backdrop:rgba(0,0,0,.6);',
      '--ctg-shadow:0 4px 16px rgba(0,0,0,.7);}',
    ].join('');

    var OVERLAY_CSS = [
      // portal wrapper: a zero-size fixed layer above Perspective's popups
      ':where(.ctg-portal-guard){position:fixed;top:0;left:0;width:0;height:0;z-index:var(--ctg-z,12000);',
      'font-family:var(--ctg-font);font-size:14px;line-height:1.35;color:var(--ctg-text);text-align:left;',
      'letter-spacing:normal;text-transform:none;font-weight:normal;}',
      ':where(.ctg-portal-guard *,.ctg-portal-guard *::before,.ctg-portal-guard *::after){box-sizing:border-box;}',
      // menu
      ':where(.ctg-menu){position:fixed;min-width:180px;max-width:min(360px,calc(100vw - 8px));overflow:auto;',
      'padding:4px 0;background:var(--ctg-surface);color:var(--ctg-text);border:1px solid var(--ctg-border);',
      'border-radius:var(--ctg-radius);box-shadow:var(--ctg-shadow);outline:none;}',
      ':where(.ctg-menu__header){padding:6px 12px 8px;margin-bottom:4px;border-bottom:1px solid var(--ctg-border);}',
      ':where(.ctg-menu__header-title){font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      ':where(.ctg-menu__header-sub){font-size:12px;color:var(--ctg-text-muted);overflow:hidden;text-overflow:ellipsis;',
      'white-space:nowrap;}',
      ':where(.ctg-menu__item){display:flex;align-items:center;gap:8px;min-height:32px;padding:6px 12px;cursor:pointer;',
      'user-select:none;-webkit-user-select:none;outline:none;}',
      ':where(.ctg-menu__item:hover,.ctg-menu__item:focus){background:var(--ctg-surface-2);}',
      ':where(.ctg-menu__item:focus-visible){outline:2px solid var(--ctg-focus);outline-offset:-2px;}',
      ':where(.ctg-menu__item--disabled){cursor:default;color:var(--ctg-text-muted);}',
      ':where(.ctg-menu__item--busy){cursor:progress;}',
      ':where(.ctg-menu__label){display:flex;flex-direction:column;flex:1 1 auto;min-width:0;}',
      ':where(.ctg-menu__hint){font-size:12px;color:var(--ctg-text-muted);}',
      // the muted hint is 4.0:1 on a hovered / focused item's --ctg-surface-2 in the
      // light theme (#767676 on #F3F4F5, WCAG AA needs 4.5:1). There it takes the item's text colour (12.0:1); the
      // smaller size keeps it secondary. Not color-mix(): checkers (axe) and older embedded browsers read plain colours.
      ':where(.ctg-menu__item:hover .ctg-menu__hint,.ctg-menu__item:focus .ctg-menu__hint){color:var(--ctg-text);}',
      ':where(.ctg-menu__separator){height:1px;margin:4px 0;background:var(--ctg-border);}',
      // dialog
      ':where(.ctg-dialog-backdrop){position:fixed;display:flex;align-items:center;justify-content:center;',
      'padding:16px;background:var(--ctg-backdrop);}',
      ':where(.ctg-dialog-backdrop--anchored){display:block;padding:0;background:transparent;}',
      ':where(.ctg-dialog){position:relative;display:flex;flex-direction:column;width:min(360px,calc(100vw - 32px));',
      'max-width:100%;max-height:100%;background:var(--ctg-surface);color:var(--ctg-text);',
      'border:1px solid var(--ctg-border);border-radius:var(--ctg-radius);box-shadow:var(--ctg-shadow);',
      'outline:none;overflow:hidden;}',
      ':where(.ctg-dialog--anchored){position:absolute;}',
      ':where(.ctg-dialog__header){display:flex;align-items:center;gap:8px;padding:10px 8px 6px 16px;}',
      ':where(.ctg-dialog__title){flex:1 1 auto;min-width:0;margin:0;font-size:16px;font-weight:600;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:inherit;}',
      ':where(.ctg-dialog__body){flex:1 1 auto;min-height:0;padding:4px 16px 12px;overflow:auto;}',
      ':where(.ctg-dialog__footer){display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;padding:10px 16px;',
      'border-top:1px solid var(--ctg-border);}',
      // buttons
      ':where(.ctg-btn){display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;',
      'padding:4px 14px;font:inherit;font-weight:600;line-height:1.2;color:var(--ctg-text);',
      'background:var(--ctg-surface);border:1px solid var(--ctg-border);border-radius:var(--ctg-radius);cursor:pointer;}',
      ':where(.ctg-btn--primary){color:var(--ctg-primary-text);background:var(--ctg-primary);border-color:var(--ctg-primary);}',
      ':where(.ctg-btn--danger){color:#FFFFFF;background:var(--ctg-danger);border-color:var(--ctg-danger);}',
      ':where(.ctg-btn--icon,.ctg-dialog__close){min-width:32px;min-height:32px;padding:0 6px;font-size:20px;',
      'font-weight:normal;line-height:1;color:inherit;background:transparent;border:1px solid transparent;',
      'border-radius:var(--ctg-radius);cursor:pointer;}',
      ':where(.ctg-btn:disabled,.ctg-btn[aria-disabled="true"]){opacity:.55;cursor:not-allowed;}',
      ':where(.ctg-btn:focus-visible,.ctg-input:focus-visible,.ctg-select:focus-visible,',
      '.ctg-choice__option:focus-visible,.ctg-popover:focus-visible,.ctg-dialog:focus-visible){',
      'outline:2px solid var(--ctg-focus);outline-offset:2px;}',
      // fields
      ':where(.ctg-field){display:flex;flex-direction:column;gap:4px;margin:0 0 12px;}',
      ':where(.ctg-field__label){font-size:13px;font-weight:600;}',
      ':where(.ctg-field__help){font-size:12px;color:var(--ctg-text-muted);}',
      ':where(.ctg-field__error){font-size:12px;color:var(--ctg-danger);}',
      ':where(.ctg-input,.ctg-select){width:100%;min-height:32px;padding:4px 8px;font:inherit;',
      'color:var(--ctg-input-text);background:var(--ctg-input-bg);border:1px solid var(--ctg-border);',
      'border-radius:var(--borderRadiusInput,var(--ctg-radius));}',
      ':where(.ctg-input[aria-invalid="true"],.ctg-select[aria-invalid="true"]){border-color:var(--ctg-danger);}',
      ':where(.ctg-choice){display:flex;flex-wrap:wrap;gap:6px;}',
      ':where(.ctg-choice__option){min-height:32px;padding:4px 12px;font:inherit;color:var(--ctg-text);',
      'background:var(--ctg-surface);border:1px solid var(--ctg-border);border-radius:var(--ctg-radius);cursor:pointer;}',
      ':where(.ctg-choice__option[aria-checked="true"]){color:var(--ctg-primary-text);background:var(--ctg-primary);',
      'border-color:var(--ctg-primary);}',
      ':where(.ctg-choice__option:disabled){opacity:.5;cursor:not-allowed;}',
      ':where(.ctg-status){min-height:1.35em;font-size:13px;}',
      ':where(.ctg-status--error){color:var(--ctg-danger);}',
      ':where(.ctg-status--ok){color:var(--ctg-success);}',
      ':where(.ctg-status--busy){color:var(--ctg-text-muted);}',
      // bubble and popover
      ':where(.ctg-bubble){position:fixed;max-width:min(320px,calc(100vw - 16px));padding:6px 10px;font-size:13px;',
      'color:var(--ctg-text);background:var(--ctg-surface);border:1px solid var(--ctg-border);',
      'border-left:4px solid var(--ctg-primary);border-radius:var(--ctg-radius);box-shadow:var(--ctg-shadow);}',
      ':where(.ctg-bubble--error){border-left-color:var(--ctg-danger);}',
      ':where(.ctg-bubble--ok){border-left-color:var(--ctg-success);}',
      ':where(.ctg-bubble--warn){border-left-color:var(--ctg-warn);}',
      ':where(.ctg-popover){position:fixed;max-width:min(360px,calc(100vw - 16px));padding:12px;color:var(--ctg-text);',
      'background:var(--ctg-surface);border:1px solid var(--ctg-border);border-radius:var(--ctg-radius);',
      'box-shadow:var(--ctg-shadow);outline:none;}',
      ':where(.ctg-confirm__text){margin:0 0 12px;}',
      ':where(.ctg-confirm__actions){display:flex;justify-content:flex-end;gap:8px;}',
      // toast (page level, outside the portal guard)
      ':where(.ctg-toast-host){position:fixed;left:50%;bottom:16px;transform:translateX(-50%);',
      'z-index:var(--ctg-z,12000);display:flex;flex-direction:column;align-items:center;gap:8px;',
      'max-width:calc(100vw - 32px);font-family:var(--ctg-font);font-size:14px;line-height:1.35;}',
      ':where(.ctg-toast){display:flex;align-items:center;gap:12px;padding:8px 8px 8px 14px;color:var(--ctg-surface);',
      'background:var(--ctg-text);border-radius:var(--ctg-radius);box-shadow:var(--ctg-shadow);}',
      ':where(.ctg-toast .ctg-btn){color:inherit;background:transparent;border-color:currentColor;}',
      ':where(.ctg-toast .ctg-btn--icon){border-color:transparent;}',
      // spinner + screen-reader-only
      ':where(.ctg-spinner){display:inline-block;width:1em;height:1em;flex:0 0 auto;border:2px solid currentColor;',
      'border-right-color:transparent;border-radius:50%;opacity:.8;vertical-align:-2px;',
      'animation:ctg-spin .8s linear infinite;}',
      '@keyframes ctg-spin{to{transform:rotate(360deg);}}',
      ':where(.ctg-sr-only){position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;',
      'clip:rect(0,0,0,0);white-space:nowrap;border:0;}',
      '@media (pointer:coarse){:where(.ctg-menu__item){min-height:44px;}',
      ':where(.ctg-btn,.ctg-choice__option,.ctg-input,.ctg-select){min-height:44px;}}',
      '@media (prefers-reduced-motion:reduce){:where(.ctg-spinner){animation:none;border-right-color:currentColor;',
      'opacity:.5;}}',
    ].join('');

    var COMMON_STYLE_ID = 'ctg-common-styles';
    var TOKEN_NAMES = {
      text: '--ctg-text', textMuted: '--ctg-text-muted', border: '--ctg-border', primary: '--ctg-primary',
      primaryText: '--ctg-primary-text', danger: '--ctg-danger', warn: '--ctg-warn', success: '--ctg-success',
      surface: '--ctg-surface', surface2: '--ctg-surface-2', inputBg: '--ctg-input-bg', inputText: '--ctg-input-text',
      focus: '--ctg-focus', font: '--ctg-font', radius: '--ctg-radius',
    };
    var TOKEN_FALLBACK = {
      text: '#323232', textMuted: '#767676', border: '#A1A1A1', primary: '#0C7BB3', primaryText: '#FFFFFF',
      danger: '#DA1E28', warn: '#AD5F00', success: '#038537', surface: '#FFFFFF', surface2: '#F3F4F5',
      inputBg: '#FFFFFF', inputText: '#323232', focus: '#0C7BB3', font: 'sans-serif', radius: '4px',
    };

    function hasDocument() { return typeof document !== 'undefined' && !!document.head; }

    function ensureStyles(id, cssText, build) {
      var b = build || NS.build;
      var el = document.getElementById(id);
      if (el && el.getAttribute('data-ctg-build') === b) return el;
      if (!el) {
        el = document.createElement('style');
        el.id = id;
        document.head.appendChild(el);
      }
      el.setAttribute('data-ctg-build', b);
      el.textContent = cssText;   // plain text node: no HTML parsing
      return el;
    }
    function ensureCommonStyles() {
      if (!hasDocument()) return null;
      var el = ensureStyles(COMMON_STYLE_ID, TOKENS_CSS + OVERLAY_CSS, NS.build);
      startThemeWatch(null);
      return el;
    }

    /* ---- colours: parse, luminance, contrast -------------------------------- */
    var colorCtx = null;
    function parseColor(str) {
      if (typeof str !== 'string') return null;
      var s = str.trim();
      var m = /^#([0-9a-f]{3,8})$/i.exec(s);
      if (m) {
        var hx = m[1];
        if (hx.length === 3 || hx.length === 4) hx = hx.split('').map(function (c) { return c + c; }).join('');
        if (hx.length !== 6 && hx.length !== 8) return null;
        return {
          r: parseInt(hx.slice(0, 2), 16), g: parseInt(hx.slice(2, 4), 16), b: parseInt(hx.slice(4, 6), 16),
          a: hx.length === 8 ? parseInt(hx.slice(6, 8), 16) / 255 : 1,
        };
      }
      m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
      if (m) {
        var a = m[4] == null ? 1 : /%$/.test(m[4]) ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
        return { r: +m[1], g: +m[2], b: +m[3], a: a };
      }
      // anything else (names, hsl(), color-mix()): let the canvas normalise it
      if (!hasDocument() || /[;{}<>]/.test(s)) return null;
      try {
        if (!colorCtx) colorCtx = document.createElement('canvas').getContext('2d');
        colorCtx.fillStyle = '#010203';
        colorCtx.fillStyle = s;
        var norm = colorCtx.fillStyle;
        if (norm === '#010203' && !/^#010203$/i.test(s)) return null;
        return norm === s ? null : parseColor(norm);
      } catch (e) { return null; }
    }
    function luminance(c) {
      function ch(v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
      return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
    }
    /** WCAG contrast ratio of two CSS colours (null when either cannot be parsed). */
    function contrast(fg, bg) {
      var a = typeof fg === 'string' ? parseColor(fg) : fg;
      var b = typeof bg === 'string' ? parseColor(bg) : bg;
      if (!a || !b) return null;
      var l1 = luminance(a), l2 = luminance(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }
    function computedVar(el, name) {
      try {
        var target = el || document.documentElement;
        return String(window.getComputedStyle(target).getPropertyValue(name) || '').trim();
      } catch (e) { return ''; }
    }
    function tokens(el) {
      ensureCommonStyles();
      var out = {};
      for (var k in TOKEN_NAMES) {
        if (!hasOwn.call(TOKEN_NAMES, k)) continue;
        var v = hasDocument() ? computedVar(el, TOKEN_NAMES[k]) : '';
        out[k] = v || TOKEN_FALLBACK[k];
      }
      return out;
    }
    function isDark(el) {
      if (!hasDocument()) return false;
      ensureCommonStyles();
      var candidates = [computedVar(el, '--ctg-surface'), computedVar(el, '--neutral-10')];
      try { candidates.push(window.getComputedStyle(document.body).backgroundColor); } catch (e) { /* ignore */ }
      for (var i = 0; i < candidates.length; i++) {
        var c = parseColor(candidates[i]);
        if (c && c.a > 0.5) return luminance(c) < 0.25;
      }
      return false;
    }

    /* ---- page-level theme watcher -------------------------------------------- */
    var themeWatch = { started: false, sp: null, spOff: null, theme: null, listeners: [], settleCancel: null };
    function readTheme(store) { return readSessionProp(store, 'theme'); }
    function applyScheme() {
      if (!hasDocument() || !document.documentElement) return;
      var scheme = isDark() ? 'dark' : 'light';
      if (document.documentElement.getAttribute('data-ctg-scheme') !== scheme) {
        document.documentElement.setAttribute('data-ctg-scheme', scheme);
      }
    }
    function emitTheme(reason) {
      applyScheme();
      var info = { theme: themeWatch.theme, dark: isDark(), reason: reason };
      themeWatch.listeners.slice().forEach(function (fn) {
        try { fn(info); } catch (e) { log.warn('theme listener failed', e); }
      });
    }
    /**
     * A theme switch swaps Perspective's theme stylesheet asynchronously. Notify on the next frame
     * (most changes are visible by then) and once more when the resolved surface colour actually
     * changes (polled per frame for up to 2 s), so canvas colours are never read too early.
     */
    function themeChanged(reason) {
      if (themeWatch.settleCancel) themeWatch.settleCancel();
      var before = computedVar(null, '--ctg-surface');
      var started = Date.now();
      var first = true;
      function step() {
        themeWatch.settleCancel = null;
        var now = computedVar(null, '--ctg-surface');
        if (first) { first = false; emitTheme(reason); }
        if (now !== before) { emitTheme(reason); return; }
        if (Date.now() - started < 2000) themeWatch.settleCancel = nextFrame(step);
      }
      themeWatch.settleCancel = nextFrame(step);
    }
    /**
     * Starts the page-level theme watch (idempotent; called on every overlay open, delegate attach and
     * onChange). The OS colour-scheme listener starts once. The Perspective theme comes from the session
     * props tree (sessionProps.subscribe); that tree is only usable once the session
     * runs and Perspective may replace it, so each call re-subscribes when the current tree differs from
     * the subscribed one. (page.theme is a plain getter, not a mobx observable: not usable.)
     */
    function startThemeWatch(store) {
      if (!hasDocument()) return;
      if (!themeWatch.started) {
        themeWatch.started = true;
        try {
          var mq = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)');
          if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', function () { themeChanged('os'); });
        } catch (e) { /* ignore */ }
        applyScheme();
      }
      var sp = sessionPropsOf(store);
      if (!sp || sp === themeWatch.sp || typeof sp.subscribe !== 'function') return;
      if (themeWatch.spOff) { try { themeWatch.spOff(); } catch (e) { /* ignore */ } }
      themeWatch.sp = sp;
      themeWatch.theme = readTheme(store);
      try {
        var off = sp.subscribe(function () {
          var t = readTheme(store);
          if (t !== themeWatch.theme) { themeWatch.theme = t; themeChanged('session'); }
        });
        themeWatch.spOff = typeof off === 'function' ? off : null;
      } catch (e) { log.debug('session props subscription unavailable', e); }
      applyScheme();
    }

    NS.theme = {
      TOKENS_CSS: TOKENS_CSS,
      OVERLAY_CSS: OVERLAY_CSS,
      COMMON_STYLE_ID: COMMON_STYLE_ID,
      ensureStyles: ensureStyles,
      ensureCommonStyles: ensureCommonStyles,
      /** Resolved --ctg-* values for canvas drawing: {text, textMuted, border, primary, ...}. */
      tokens: tokens,
      isDark: isDark,
      scheme: function () { return isDark() ? 'dark' : 'light'; },
      parseColor: parseColor,
      luminance: luminance,
      contrast: contrast,
      /**
       * cb({theme, dark, reason}) after the Perspective theme (session prop `theme`) or the OS colour
       * scheme changed and the new theme CSS applied; returns a disposer. One page-wide subscription.
       */
      onChange: function (store, cb) {
        startThemeWatch(store);
        themeWatch.listeners.push(cb);
        return function () {
          var i = themeWatch.listeners.indexOf(cb);
          if (i >= 0) themeWatch.listeners.splice(i, 1);
        };
      },
    };
    // Tokens exist from load on, so a chart can read canvas colours before any overlay opened.
    try { ensureCommonStyles(); } catch (e) { log.warn('could not inject the common stylesheet', e); }

    /* ========================================================================
     * SECTION 10 / NS.conn — connection monitor and gateway watchdog
     * ----------------------------------------------------------------------
     * Perspective drops model events in both directions while disconnected,
     * so every delegate must know the connection state: to mark itself stale
     * at once and to re-hello (resync) when the socket comes back.
     * Source: window.__client (the ClientStore): connection.connected and
     * state.state, observed with a mobx reaction (the page's global mobx 5);
     * fallback: a 1 s poll (UI state only, not a data refresh).
     *
     * WATCHDOG. The socket can be up while our gateway service
     * does not answer (stuck queue, module restarting). While any CTG
     * component is mounted, one ctg.ping goes out every 15 s through an
     * attached, ready delegate; no reply within 8 s -> every CTG component is
     * STALE ("Gateway service not responding") until a reply arrives again
     * (re-probed every 5 s while stale). Any ctg.reply or ctg.welcome proves
     * the request path and clears it. The same self-rescheduling tick checks
     * each delegate's push silence (CtgDelegateBase.silenceLimitMs; the
     * display uses 75 s).
     * ====================================================================== */
    var connListeners = [];
    var connState = { connected: true, state: 'unknown' };
    var connStarted = false;
    function readConn() {
      var c = window.__client;
      if (!c) return { connected: true, state: 'unknown' };
      var st = c.state && c.state.state != null ? String(c.state.state) : 'unknown';
      var connected = !!(c.connection && c.connection.connected) && !/DISCONNECTED|RECONNECTING/.test(st);
      return { connected: connected, state: st };
    }
    function connChanged() {
      var next = readConn();
      if (next.connected === connState.connected && next.state === connState.state) return;
      var was = connState.connected;
      connState = next;
      log.debug('connection', next);
      if (next.connected && !was) wd.lastPingAt = 0;     // probe the service right after a reconnect
      connListeners.slice().forEach(function (fn) {
        try { fn(connState); } catch (e) { log.error('conn listener failed', e); }
      });
    }
    function startConn() {
      if (connStarted) return;
      connStarted = true;
      connState = readConn();
      var mobx = window.mobx;
      var c = window.__client;
      if (mobx && typeof mobx.reaction === 'function' && c) {
        try {
          mobx.reaction(function () {
            return [c.connection && c.connection.connected, c.state && c.state.state];
          }, connChanged);
          return;
        } catch (e) {
          log.warn('mobx reaction unavailable, polling the connection state', e);
        }
      }
      setInterval(connChanged, 1000);   // fallback only: UI state poll, not a data refresh
    }

    var WD_CONFIG = { intervalMs: 15000, timeoutMs: 8000, staleRetryMs: 5000, tickMs: 5000 };
    var wd = {
      running: false, stale: false, since: 0, lastOkAt: 0, lastPingAt: 0, inFlight: false, timer: null,
      pings: 0, timeouts: 0, listeners: [],
    };
    function wdState() {
      return { running: wd.running, stale: wd.stale, since: wd.since, lastOkAt: wd.lastOkAt, pings: wd.pings, timeouts: wd.timeouts };
    }
    function wdSetStale(stale) {
      if (wd.stale === stale) return;
      wd.stale = stale;
      wd.since = Date.now();
      if (stale) log.warn(NS.i18n.t('conn.noResponse'));
      else log.info('gateway service answering again');
      var st = wdState();
      wd.listeners.slice().forEach(function (fn) { try { fn(st); } catch (e) { log.warn('watchdog listener failed', e); } });
      NS.debug.delegates.forEach(function (d) { d.changed(); });
    }
    function wdAlive() {
      wd.lastOkAt = Date.now();
      wdSetStale(false);
    }
    function wdSchedule(ms) {
      if (wd.timer) clearTimeout(wd.timer);
      wd.timer = setTimeout(wdTick, Math.max(50, ms));
    }
    function wdPick() {
      var found = null;
      NS.debug.delegates.forEach(function (d) {
        if (!found && d._attached && d.state.phase === 'ready' && d.state.connected) found = d;
      });
      return found;
    }
    function wdPing() {
      var d = wdPick();
      if (!d || !NS.conn.get().connected) return;   // nothing to probe through; the connection monitor covers offline
      wd.inFlight = true;
      wd.lastPingAt = Date.now();
      wd.pings++;
      d.request('ctg.ping', {}, { timeoutMs: WD_CONFIG.timeoutMs }).then(function (r) {
        wd.inFlight = false;
        if (r.ok) { wdAlive(); return; }
        var code = r.error && r.error.code;
        if (code === 'CLIENT_TIMEOUT') { wd.timeouts++; wdSetStale(true); return; }
        if (code === 'DETACHED' || code === 'DISCONNECTED') { wd.lastPingAt = 0; return; }   // retry on the next tick
        wdAlive();   // any gateway answer (even RATE_LIMITED) proves the service is processing requests
      });
    }
    function wdTick() {
      wd.timer = null;
      if (!wd.running) return;
      var now = Date.now();
      NS.debug.delegates.forEach(function (d) { d._checkSilence(now); });
      var due = (wd.stale ? WD_CONFIG.staleRetryMs : WD_CONFIG.intervalMs) - (now - wd.lastPingAt);
      if (!wd.inFlight && due <= 0) {
        wdPing();
        due = wd.stale ? WD_CONFIG.staleRetryMs : WD_CONFIG.intervalMs;
      }
      wdSchedule(Math.min(WD_CONFIG.tickMs, due > 0 ? due : WD_CONFIG.tickMs));
    }
    /** Starts the watchdog while delegates are attached; stops (and clears STALE) when none are. */
    function wdEnsure() {
      var any = NS.debug.delegates.size > 0;
      if (any && !wd.running) {
        wd.running = true;
        wd.lastPingAt = Date.now();          // the first probe after one interval: hellos are in flight now
        wdSchedule(WD_CONFIG.tickMs);
      } else if (!any && wd.running) {
        wd.running = false;
        if (wd.timer) { clearTimeout(wd.timer); wd.timer = null; }
        wd.inFlight = false;
        wdSetStale(false);
      }
    }

    NS.conn = {
      get: function () { startConn(); return connState; },
      subscribe: function (fn) {
        startConn();
        connListeners.push(fn);
        return function () {
          var i = connListeners.indexOf(fn);
          if (i >= 0) connListeners.splice(i, 1);
        };
      },
      watchdog: {
        /** Live tuning (tests): {intervalMs, timeoutMs, staleRetryMs, tickMs}. */
        config: WD_CONFIG,
        state: wdState,
        isStale: function () { return wd.stale; },
        subscribe: function (fn) {
          wd.listeners.push(fn);
          return function () { var i = wd.listeners.indexOf(fn); if (i >= 0) wd.listeners.splice(i, 1); };
        },
        /** Probe now (e.g. after a long sleep of the tab). */
        checkNow: function () { if (wd.running && !wd.inFlight) { wd.lastPingAt = 0; wdSchedule(0); } },
        _alive: wdAlive,
      },
    };

    /* ========================================================================
     * SECTION 11 / NS.events — component events (client-fired)
     * ----------------------------------------------------------------------
     * Only when events are enabled (runtime and Designer preview; not design
     * mode). Payloads must be flat plain objects. NOTE: any page script can
     * fire a component event with any payload; never treat a client-fired
     * event as proof that something happened on the gateway — the audit
     * trail is the authority.
     * ====================================================================== */
    NS.events = {
      canInteract: function (props) {
        if (!props || props.eventsEnabled === false) return false;
        var c = window.__client;
        return !(c && c.isDesigner && c.isPreviewing === false);
      },
      fire: function (props, name, payload) {
        if (!NS.events.canInteract(props) || !props.componentEvents) return false;
        try {
          props.componentEvents.fireComponentEvent(name, payload || {});
          return true;
        } catch (e) {
          log.warn('fireComponentEvent failed', name, e);
          return false;
        }
      },
    };

    /* ========================================================================
     * SECTION 12 / NS.delegate.CtgDelegateBase — browser half of the protocol
     * ----------------------------------------------------------------------
     * state (what mapStateToProps exposes, plus subclass extras):
     *   phase      'idle' | 'helloSent' | 'ready' | 'noResponse'
     *   connected  Perspective connection state (NS.conn)
     *   epoch      gateway delegate instance id of the last accepted push
     *   welcome    last ctg.welcome payload ({user, scope, staleClient, ...})
     *   reload     null | {reason} — the gateway asked for a page reload
     *   awaitingSnapshot  true after an epoch change / seq gap until the
     *              resync snapshot arrives
     *   silent     no push for silenceLimitMs (subclass opt-in; 0 = off)
     * mapped extras: stale (isStale()), staleReason (staleReason()).
     * mapStateToProps() returns the SAME object until something changes, so
     * the Perspective HOC re-renders only on real changes.
     * ====================================================================== */
    /*
     * Diagnostics: the set of currently attached delegates. Membership follows
     * attach()/detach() exactly, so the size is the number of mounted CTG
     * components on the page (the soak test samples it to detect leaks).
     * Test harnesses reach a component's store through delegate.component.
     */
    NS.debug = NS.debug || {};
    NS.debug.delegates = NS.debug.delegates || new Set();

    var framedCache = null;            // framing never changes during a page's life
    var HELLO_RESEND_MS = 5000;
    var HELLO_TRIES = 3;
    var HELLO_SLOW_RETRY_MS = 15000;
    var DEFAULT_TIMEOUT_MS = 8000;
    var dlog = NS.log('ctg.delegate');

    /** 8 random [a-z0-9] characters (crypto when available) that make a delegate instance's request ids unique. */
    function idNonce() {
      var A = 'abcdefghijklmnopqrstuvwxyz0123456789';
      var out = '';
      var bytes = null;
      try {
        var c = (typeof globalThis !== 'undefined' && globalThis.crypto) || null;
        if (c && typeof c.getRandomValues === 'function') bytes = c.getRandomValues(new Uint8Array(8));
      } catch (e) { bytes = null; }
      for (var i = 0; i < 8; i++) {
        out += A.charAt((bytes ? bytes[i] : Math.floor(Math.random() * 256)) % A.length);
      }
      return out;
    }

    if (!PC || typeof PC.ComponentStoreDelegate !== 'function') {
      throw new Error('PerspectiveClient.ComponentStoreDelegate is not available');
    }

    class CtgDelegateBase extends PC.ComponentStoreDelegate {
      /**
       * @param store Perspective ComponentStore
       * @param kind  'dt' | 'chart' (sent in ctg.hello.component)
       */
      constructor(store, kind) {
        super(store);
        this.kind = kind;
        this.state = {
          phase: 'idle', connected: true, epoch: null, lastSeq: 0,
          welcome: null, reload: null, awaitingSnapshot: false, silent: false,
        };
        /** Date.now() of the last gateway push (any message); liveness bookkeeping, not rendered. */
        this.lastPushAt = 0;
        /** > 0: STALE ("silent") after this long without any push (display: 75 s; the gateway sends ctg.hb). */
        this.silenceLimitMs = 0;
        this._mapped = null;
        this._pending = new Map();
        this._n = 0;
        this._attached = false;
        this._helloTimer = null;
        this._helloTries = 0;
        this._connOff = null;
        var addr = store && store.addressPathString ? String(store.addressPathString) : NS.util.uid('c');
        // a random per-instance nonce. The address alone repeats after a page reload while the gateway
        // delegate (and its idempotency cache of the last MUTATE replies) survives, so a new write reusing
        // 'dt0:2:0-1' would be answered with the old write's reply and never execute.
        this._idPrefix = kind + addr.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 36) + '-' + idNonce() + '-';
      }

      // ---- HOC contract --------------------------------------------------
      mapStateToProps() {
        if (!this._mapped) {
          this._mapped = Object.assign({}, this.state, this.extraState(),
            { stale: this.isStale(), staleReason: this.staleReason() });
        }
        return this._mapped;
      }

      /** Subclass state merged into mapStateToProps(). */
      extraState() { return {}; }

      /** Merge a patch into state; notify() only when a value actually changed. */
      setState(patch) {
        var changed = false;
        for (var k in patch) {
          if (hasOwn.call(patch, k) && this.state[k] !== patch[k]) { changed = true; break; }
        }
        if (!changed) return;
        this.state = Object.assign({}, this.state, patch);
        this.changed();
      }

      /** Subclass extras changed: drop the cached props object and re-render. */
      changed() {
        this._mapped = null;
        try { this.notify(); } catch (e) { dlog.warn('notify failed', e); }
      }

      // ---- lifecycle (called by the component) ---------------------------
      /** componentDidMount: start watching the connection and say hello. */
      attach() {
        if (this._attached) return;
        this._attached = true;
        NS.debug.delegates.add(this);
        var self = this;
        // A remount starts the handshake afresh: an earlier noResponse must not put it on the slow
        // retry cadence or show "no response" before the first new hello had a chance.
        this._helloTries = 0;
        this.setState({ connected: NS.conn.get().connected });
        if (this.state.phase === 'noResponse') this.setState({ phase: 'idle' });
        this._connOff = NS.conn.subscribe(function (c) { self._onConnection(c); });
        this._sendHello(false);
        wdEnsure();
        startThemeWatch(this.component);
      }

      /** componentWillUnmount: stop timers, settle pending requests with DETACHED. */
      detach() {
        if (!this._attached) return;
        this._attached = false;
        NS.debug.delegates.delete(this);
        if (this._connOff) { this._connOff(); this._connOff = null; }
        this._clearHelloTimer();
        var pend = Array.from(this._pending.values());
        this._pending.clear();
        pend.forEach(function (p) { clearTimeout(p.timer); p.resolve(fail('DETACHED')); });
        wdEnsure();
      }

      // ---- requests --------------------------------------------------------
      /**
       * Sends a request and resolves {ok:true, data} | {ok:false, error:{code, message, retryable, details}}.
       * Never rejects. DISCONNECTED immediately when the socket is down (Perspective would drop the
       * event); CLIENT_TIMEOUT after timeoutMs (write/configEdit callers pass 15000; default 8000) —
       * for writes that means "outcome unknown". opts.reuseId re-sends under a previous id (the gateway's
       * idempotency cache answers a duplicate with the original reply).
       * Note: Perspective batches outgoing model events into one sync frame at a time, so back-to-back
       * requests see ~100 ms each; timeouts are sized far above that.
       */
      request(name, body, opts) {
        var self = this;
        var timeoutMs = (opts && opts.timeoutMs) || DEFAULT_TIMEOUT_MS;
        if (!this._attached) return Promise.resolve(fail('DETACHED'));
        if (!NS.conn.get().connected) return Promise.resolve(fail('DISCONNECTED'));
        var id = (opts && opts.reuseId) || this._idPrefix + (++this._n);
        var prior = this._pending.get(id);
        if (prior) { clearTimeout(prior.timer); this._pending.delete(id); prior.resolve(fail('CLIENT_TIMEOUT')); }
        var msg = Object.assign({}, body || {}, { v: 2, id: id, build: NS.build });
        return new Promise(function (resolve) {
          var sentAt = Date.now();
          var timer = setTimeout(function () {
            if (self._pending.delete(id)) resolve(fail('CLIENT_TIMEOUT'));
          }, timeoutMs);
          self._pending.set(id, { resolve: resolve, timer: timer, sentAt: sentAt, name: name });
          self._fire(name, msg);
        });
      }

      /** The id the last request() call used (for a later reuseId retry). */
      lastRequestId() { return this._n ? this._idPrefix + this._n : null; }

      /** ctg.ping round trip (clock sample + liveness); resolves like request(). */
      ping(timeoutMs) { return this.request('ctg.ping', {}, { timeoutMs: timeoutMs || DEFAULT_TIMEOUT_MS }); }

      _fire(name, msg) {
        try {
          dlog.debug('->', name, msg);
          this.fireEvent(name, msg);
        } catch (e) {
          dlog.warn('fireEvent failed', name, e);
        }
      }

      // ---- handshake ---------------------------------------------------------
      _sendHello(resync) {
        if (!this._attached) return;
        this._clearHelloTimer();
        this.setState({ phase: this.state.phase === 'noResponse' ? 'noResponse' : 'helloSent' });
        this._fire('ctg.hello', { v: 2, component: this.kind, resync: !!resync, clientBuild: NS.build });
        var self = this;
        var slow = this._helloTries >= HELLO_TRIES;
        this._helloTimer = setTimeout(function () {
          self._helloTimer = null;
          if (!self._attached || self.state.phase === 'ready') return;
          self._helloTries++;
          if (self._helloTries >= HELLO_TRIES) self.setState({ phase: 'noResponse' });
          self._sendHello(true);
        }, slow ? HELLO_SLOW_RETRY_MS : HELLO_RESEND_MS);
      }

      _clearHelloTimer() {
        if (this._helloTimer) { clearTimeout(this._helloTimer); this._helloTimer = null; }
      }

      _onConnection(c) {
        var was = this.state.connected;
        this.setState({ connected: c.connected });
        if (c.connected && !was) {
          // Pushes were dropped while offline: ask for a full snapshot.
          this._helloTries = 0;
          this.setState({ phase: 'helloSent' });
          this._sendHello(true);
        }
      }

      /** Watchdog tick: flag/unflag push silence (silenceLimitMs > 0 only). */
      _checkSilence(now) {
        var silent = this.silenceLimitMs > 0 && this.state.phase === 'ready' && this.lastPushAt > 0 &&
          now - this.lastPushAt > this.silenceLimitMs;
        if (silent !== this.state.silent) this.setState({ silent: silent });
      }

      // ---- inbound -----------------------------------------------------------
      /** Called by Perspective for every gateway -> client model event of this component. */
      handleEvent(name, payload) {
        if (!payload || typeof payload !== 'object') return;
        var receivedAt = Date.now();
        dlog.debug('<-', name, payload);
        if (payload.v !== 2) {
          this.setState({ reload: { reason: 'protocol' } });
          staleNotice(true);
          return;
        }
        this.lastPushAt = receivedAt;
        if (this.state.silent) this.setState({ silent: false });
        // epoch: a new gateway delegate instance (view restart, module restart)
        if (this.state.epoch !== null && payload.epoch !== this.state.epoch) {
          this.setState({ epoch: payload.epoch, lastSeq: payload.seq || 0, awaitingSnapshot: true });
          this.onEpochChange();
          if (name !== 'ctg.welcome' && name !== this.snapshotName()) this._sendHello(true);
        } else {
          var gap = this.state.epoch !== null && typeof payload.seq === 'number' && payload.seq !== this.state.lastSeq + 1;
          this.setState({ epoch: payload.epoch, lastSeq: typeof payload.seq === 'number' ? payload.seq : this.state.lastSeq });
          if (gap && name !== 'ctg.welcome' && name !== this.snapshotName()) {
            dlog.debug('seq gap, resync', this._idPrefix);
            this.setState({ awaitingSnapshot: true });
            this._sendHello(true);
          }
        }

        switch (name) {
          case 'ctg.welcome':
            this._clearHelloTimer();
            this._helloTries = 0;
            NS.clock.sample(payload.serverNow, undefined, receivedAt);
            this.setState({ phase: 'ready', welcome: stripEnvelope(payload) });
            wdAlive();
            if (payload.staleClient) staleNotice(false);
            return;
          case 'ctg.reload':
            this.setState({ reload: { reason: payload.reason || 'build' } });
            staleNotice(true);
            return;
          case 'ctg.reply': {
            var p = this._pending.get(payload.id);
            wdAlive();
            if (!p) return;   // late reply after a client timeout / detach
            this._pending.delete(payload.id);
            clearTimeout(p.timer);
            NS.clock.sample(payload.serverNow, p.sentAt, receivedAt);
            p.resolve(payload.ok ? { ok: true, data: payload.data || {} }
              : { ok: false, error: normalizeError(payload.error) });
            return;
          }
          case 'ctg.error':
            dlog.warn('gateway error', payload.error);
            return;
          case 'ctg.hb':
            NS.clock.sample(payload.serverNow, undefined, receivedAt);
            return;
          default:
            NS.clock.sample(payload.serverNow, undefined, receivedAt);
            if (name === this.snapshotName() && this.state.awaitingSnapshot) this.setState({ awaitingSnapshot: false });
            this.onMessage(name, stripEnvelope(payload));
        }
      }

      /** Subclass hook: a component message (snapshot / delta) without the envelope fields. */
      onMessage(name, payload) { }

      /** Subclass hook: the gateway delegate restarted; drop component state, a snapshot follows. */
      onEpochChange() { }

      /** Name of the subclass snapshot message ('dt.snapshot' / 'chart.snapshot'). */
      snapshotName() { return this.kind === 'chart' ? 'chart.snapshot' : 'dt.snapshot'; }

      /** True when what the component shows may be out of date. */
      isStale() { return this.staleReason() !== null; }

      /**
       * True when editing must be disabled because the page is framed by another site
       * and the gateway does not allow it (ctg.welcome.allowCrossOriginFrames). Reason text:
       * NS.i18n 'frame.blocked'.
       */
      frameBlocked() {
        if (framedCache === null) framedCache = NS.util.framedCrossOrigin();
        return framedCache && !(this.state.welcome && this.state.welcome.allowCrossOriginFrames === true);
      }

      /**
       * Why the component is stale, most fundamental first: 'disconnected' (socket down),
       * 'reload' (protocol/build mismatch), 'noResponse' (no welcome after 3 hellos), 'resync' (awaiting
       * the snapshot after an epoch change / seq gap), 'connecting' (hello sent, no welcome yet),
       * 'watchdog' (gateway service not answering pings), 'silent' (no push for silenceLimitMs); null
       * when live. Text for each: NS.i18n 'conn.*'.
       */
      staleReason() {
        var s = this.state;
        if (!s.connected) return 'disconnected';
        if (s.reload) return 'reload';
        if (s.phase === 'noResponse') return 'noResponse';
        if (s.awaitingSnapshot) return 'resync';
        if (s.phase !== 'ready') return 'connecting';
        if (wd.stale) return 'watchdog';
        if (s.silent) return 'silent';
        return null;
      }
    }

    function fail(code) {
      return { ok: false, error: { code: code, message: NS.i18n.errorText(code), retryable: code !== 'DETACHED', details: null } };
    }
    function normalizeError(e) {
      e = e || {};
      var code = e.code || 'INTERNAL';
      var details = e.details || null;
      return { code: code, message: e.message || NS.i18n.errorText(code, details), retryable: !!e.retryable, details: details };
    }
    function stripEnvelope(p) {
      var o = {};
      for (var k in p) {
        if (k !== 'v' && k !== 'epoch' && k !== 'seq' && k !== 'serverNow') o[k] = p[k];
      }
      return o;
    }
    /** Page-level "module updated" toast: one per page; `must` upgrades the text. */
    var staleShown = null;
    function staleNotice(must) {
      if (staleShown === 'must' || (staleShown && !must)) return;
      staleShown = must ? 'must' : 'should';
      var text = NS.i18n.t(must ? 'reload.mustToast' : 'reload.toast');
      log.warn(text);
      if (!hasDocument() || !document.body) return;
      NS.ui.Toast.show({
        key: 'ctg-stale', text: text, actionLabel: NS.i18n.t('reload.action'),
        onAction: function () { try { window.location.reload(); } catch (e) { /* ignore */ } },
      });
    }

    NS.delegate = { CtgDelegateBase: CtgDelegateBase };

    /* ========================================================================
     * SECTION 13 / NS.overlay — the single page-wide overlay manager
     * ----------------------------------------------------------------------
     * Kinds: 'menu', 'popover', 'bubble' are TRANSIENT — one at a time page
     * wide (opening a menu/popover closes every transient, including the
     * chart's; opening a bubble closes only other bubbles, so a late
     * write-result bubble never cancels an open menu or Confirm);
     * 'dialog' handles stack (chart settings -> confirm). While anything is
     * open, capture listeners on window close transients on Escape, a pointer
     * down or right-click outside them, scroll outside them, resize and window
     * blur; Escape goes to the topmost transient, else to the topmost dialog.
     * Dialogs are never closed by the manager directly: it calls their
     * onRequestClose(reason) and the owner decides (a write in flight keeps
     * running).
     *
     * handle = NS.overlay.open(owner, {kind, onClose(reason), onRequestClose?(reason), ignoreEls?})
     *   handle.setElement(el)   the overlay's DOM element (for "outside" tests)
     * NS.overlay.close(handle, reason)  idempotent; calls onClose(reason) once
     * ====================================================================== */
    var ovStack = [];
    var ovListening = false;
    /** Until when the click/contextmenu that follows a fired long-press is swallowed (see NS.ui.longPress). */
    var longPressSwallowUntil = 0;
    var TRANSIENT = { menu: true, popover: true, bubble: true };

    function ovContains(hd, node) {
      if (!node) return false;
      if (hd.el && hd.el.contains && hd.el.contains(node)) return true;
      var ign = hd.ignoreEls || [];
      for (var i = 0; i < ign.length; i++) if (ign[i] && ign[i].contains && ign[i].contains(node)) return true;
      return false;
    }
    function ovTop(pred) {
      for (var i = ovStack.length - 1; i >= 0; i--) if (pred(ovStack[i])) return ovStack[i];
      return null;
    }
    function ovRequest(hd, reason) {
      if (typeof hd.onRequestClose === 'function') {
        try { hd.onRequestClose(reason); } catch (e) { log.warn('overlay onRequestClose failed', e); }
      } else {
        ovClose(hd, reason);
      }
    }
    function closeTransients(reason, exceptTarget) {
      ovStack.slice().reverse().forEach(function (hd) {
        if (TRANSIENT[hd.kind] && !(exceptTarget && ovContains(hd, exceptTarget))) ovClose(hd, reason);
      });
    }
    var ovHandlers = {
      keydown: function (e) {
        if (e.key !== 'Escape' && e.key !== 'Esc') return;
        var hd = ovTop(function (x) { return TRANSIENT[x.kind]; }) || ovTop(function (x) { return x.kind === 'dialog'; });
        if (!hd) return;
        e.preventDefault();
        e.stopPropagation();      // Perspective popups must not also close on this Escape
        ovRequest(hd, 'escape');
      },
      pointerdown: function (e) { closeTransients('outside', e.target); },
      contextmenu: function (e) {
        if (Date.now() < longPressSwallowUntil) return;   // Android's contextmenu after our long-press opened a menu
        closeTransients('contextmenu', e.target);
      },
      scroll: function (e) {
        var t = e.target && e.target.nodeType === 1 ? e.target : null;
        closeTransients('scroll', t);
      },
      // a resize while the user types in a transient (on-screen keyboard opening) keeps that one open
      resize: function () {
        var a = document.activeElement;
        var typing = a && (/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) || a.isContentEditable);
        closeTransients('resize', typing ? a : null);
      },
      blur: function (e) { if (e.target === window) closeTransients('blur'); },
    };
    function ovListen(on) {
      if (on === ovListening || typeof window.addEventListener !== 'function') return;
      ovListening = on;
      var fn = on ? 'addEventListener' : 'removeEventListener';
      window[fn]('keydown', ovHandlers.keydown, true);
      window[fn]('pointerdown', ovHandlers.pointerdown, true);
      window[fn]('contextmenu', ovHandlers.contextmenu, true);
      window[fn]('scroll', ovHandlers.scroll, true);
      window[fn]('resize', ovHandlers.resize);
      window[fn]('blur', ovHandlers.blur);
    }
    function ovOpen(owner, opts) {
      var o = opts || {};
      var kind = o.kind || 'menu';
      ensureCommonStyles();
      // A bubble (often a late, unrequested write result) replaces only other bubbles: it must never
      // pull a menu from under the cursor or silently cancel another component's Confirm popover.
      if (kind === 'bubble') NS.overlay.closeAll('bubble', 'replaced');
      else if (TRANSIENT[kind]) closeTransients('replaced');
      var hd = {
        id: NS.util.uid('ov'), kind: kind, owner: owner, el: null, open: true, openedAt: Date.now(),
        onClose: o.onClose, onRequestClose: o.onRequestClose, ignoreEls: o.ignoreEls || [],
        setElement: function (el) { this.el = el || null; },
      };
      ovStack.push(hd);
      ovListen(true);
      return hd;
    }
    function ovClose(hd, reason) {
      if (!hd || !hd.open) return false;
      hd.open = false;
      var i = ovStack.indexOf(hd);
      if (i >= 0) ovStack.splice(i, 1);
      if (!ovStack.length) ovListen(false);
      if (typeof hd.onClose === 'function') {
        try { hd.onClose(reason || 'close'); } catch (e) { log.warn('overlay onClose failed', e); }
      }
      return true;
    }

    NS.overlay = {
      open: ovOpen,
      close: ovClose,
      /** Closes every overlay of `kind` (all when omitted), topmost first. */
      closeAll: function (kind, reason) {
        ovStack.slice().reverse().forEach(function (hd) { if (!kind || hd.kind === kind) ovClose(hd, reason || 'closeAll'); });
      },
      /** Closes every overlay a component opened (unmount, eventsEnabled turning false). */
      closeOwner: function (owner, reason) {
        ovStack.slice().reverse().forEach(function (hd) { if (hd.owner === owner) ovClose(hd, reason || 'owner'); });
      },
      isOpen: function (kind) { return ovStack.some(function (hd) { return !kind || hd.kind === kind; }); },
      count: function (kind) { return ovStack.filter(function (hd) { return !kind || hd.kind === kind; }).length; },
    };
    NS.debug.overlays = function () { return ovStack.map(function (hd) { return { id: hd.id, kind: hd.kind }; }); };

    /* ========================================================================
     * SECTION 14 / NS.ui — overlay components (React, no JSX, no innerHTML)
     * ----------------------------------------------------------------------
     * Everything renders through Portal into document.body (escapes
     * overflow:hidden, transforms and stacking contexts of the component and
     * of Perspective popups) inside div.ctg-portal-guard, which
     * stops React's synthetic events from bubbling back to the component's
     * root (portals bubble through the React tree). Pure placement
     * helpers (placeAt / placeNear) are exported for Node tests.
     * ====================================================================== */
    var RComponent = (React && React.Component) || PC.Component;
    var GUARD_EVENTS = ['onClick', 'onMouseDown', 'onMouseUp', 'onPointerDown', 'onPointerUp', 'onContextMenu',
      'onDoubleClick', 'onKeyDown', 'onKeyUp', 'onFocus', 'onBlur', 'onWheel', 'onTouchStart', 'onTouchEnd'];
    var GUARD_PROPS = { className: 'ctg-portal-guard' };
    GUARD_EVENTS.forEach(function (n) { GUARD_PROPS[n] = function (e) { e.stopPropagation(); }; });
    var MARGIN = 4;

    /** The visible area for fixed positioning: the visual viewport when available (pinch zoom, on-screen keyboards). */
    function viewport() {
      var vv = window.visualViewport;
      if (vv && vv.width > 0 && vv.height > 0) {
        return { left: vv.offsetLeft || 0, top: vv.offsetTop || 0, width: vv.width, height: vv.height };
      }
      var w = window.innerWidth || (document.documentElement && document.documentElement.clientWidth) || 1024;
      var hh = window.innerHeight || (document.documentElement && document.documentElement.clientHeight) || 768;
      return { left: 0, top: 0, width: w, height: hh };
    }
    /**
     * Menu placement at a point: left clamped into the viewport; opens upwards when it
     * would cross the bottom edge; never above the top margin. Returns {left, top, maxHeight}.
     */
    function placeAt(x, y, w, hgt, vp) {
      var v = vp || viewport();
      var maxH = Math.max(40, v.height - 2 * MARGIN);
      var hh = Math.min(hgt, maxH);
      var left = NS.util.clamp(x, v.left + MARGIN, Math.max(v.left + MARGIN, v.left + v.width - w - MARGIN));
      var top = y + hh > v.top + v.height - MARGIN ? Math.max(v.top + MARGIN, y - hh) : Math.max(v.top + MARGIN, y);
      if (top + hh > v.top + v.height - MARGIN) top = Math.max(v.top + MARGIN, v.top + v.height - MARGIN - hh);
      return { left: Math.round(left), top: Math.round(top), maxHeight: Math.round(maxH) };
    }
    /**
     * Placement next to an anchor rect: preferred side ('bottom' | 'top' | 'right' | 'left'), flipped
     * to the opposite side when it does not fit there and fits better on the other, then clamped into
     * the viewport. align 'start' | 'center' | 'end' along the cross axis. Returns {left, top, placement}.
     */
    function placeNear(anchor, w, hgt, placement, vp, offset, align) {
      var v = vp || viewport();
      var a = anchor || { left: v.left + v.width / 2, top: v.top + v.height / 2, right: v.left + v.width / 2, bottom: v.top + v.height / 2 };
      var right = a.right != null ? a.right : a.left + (a.width || 0);
      var bottom = a.bottom != null ? a.bottom : a.top + (a.height || 0);
      var off = offset == null ? 6 : offset;
      var side = placement || 'bottom';
      var space = {
        bottom: v.top + v.height - bottom - off, top: a.top - v.top - off,
        right: v.left + v.width - right - off, left: a.left - v.left - off,
      };
      var opposite = { bottom: 'top', top: 'bottom', right: 'left', left: 'right' };
      var need = side === 'bottom' || side === 'top' ? hgt : w;
      if (space[side] < need && space[opposite[side]] > space[side]) side = opposite[side];
      var left, top;
      var al = align || 'start';
      if (side === 'bottom' || side === 'top') {
        top = side === 'bottom' ? bottom + off : a.top - off - hgt;
        left = al === 'center' ? (a.left + right) / 2 - w / 2 : al === 'end' ? right - w : a.left;
      } else {
        left = side === 'right' ? right + off : a.left - off - w;
        top = al === 'center' ? (a.top + bottom) / 2 - hgt / 2 : al === 'end' ? bottom - hgt : a.top;
      }
      left = NS.util.clamp(left, v.left + MARGIN, Math.max(v.left + MARGIN, v.left + v.width - w - MARGIN));
      top = NS.util.clamp(top, v.top + MARGIN, Math.max(v.top + MARGIN, v.top + v.height - hgt - MARGIN));
      return { left: Math.round(left), top: Math.round(top), placement: side };
    }

    var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),' +
      'textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
    function focusables(el) {
      if (!el || !el.querySelectorAll) return [];
      return Array.prototype.filter.call(el.querySelectorAll(FOCUSABLE), function (n) {
        return !n.hasAttribute('disabled') && !(n.getAttribute && n.getAttribute('aria-hidden') === 'true') &&
          (n.offsetParent !== null || (n.getClientRects && n.getClientRects().length > 0));
      });
    }
    /** Keeps Tab / Shift+Tab inside `el` (call from onKeyDown). Returns true when it handled the key. */
    function trapFocus(e, el) {
      if (!e || e.key !== 'Tab' || !el) return false;
      var list = focusables(el);
      var active = document.activeElement;
      if (!list.length) { e.preventDefault(); if (el.focus) el.focus(); return true; }
      var first = list[0], last = list[list.length - 1];
      var inside = el.contains(active);
      if (e.shiftKey && (active === first || !inside || active === el)) { e.preventDefault(); last.focus(); return true; }
      if (!e.shiftKey && (active === last || !inside)) { e.preventDefault(); first.focus(); return true; }
      return false;
    }
    function focusEl(el) {
      if (!el || typeof el.focus !== 'function') return false;
      try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) { return false; } }
      return true;
    }
    /** Focus the requested element: a selector inside `root`, a function returning an element, or an element. */
    function resolveFocusTarget(spec, root) {
      if (!spec) return null;
      if (typeof spec === 'function') { try { return spec(root); } catch (e) { return null; } }
      if (typeof spec === 'string') { try { return root && root.querySelector(spec); } catch (e) { return null; } }
      return spec.nodeType === 1 ? spec : null;
    }
    /** On unmount: give focus back when it is inside the overlay (or lost to body). */
    function restoreFocus(overlayEl, target) {
      var active = document.activeElement;
      var lost = !active || active === document.body || (overlayEl && overlayEl.contains(active));
      if (lost && target && target.isConnected !== false && document.contains(target)) focusEl(target);
    }

    /**
     * Where overlays mount: document.body, or the element in native fullscreen. While an element is
     * in the browser's top layer only its subtree is painted, so a menu / dialog / colour picker / toast portaled
     * to body would open out of sight behind a fullscreen chart (and a modal would take the focus invisibly). Media elements
     * cannot hold children: body then. Overlays re-render with their owner when it enters or leaves fullscreen.
     */
    function portalHost() {
      var fs = typeof document !== 'undefined' ? document.fullscreenElement : null;
      if (fs && fs.nodeType === 1 && !/^(VIDEO|AUDIO|IFRAME|CANVAS|IMG|OBJECT|EMBED)$/i.test(String(fs.tagName || ''))) return fs;
      return document.body;
    }
    function Portal(props) {
      var RD = window.ReactDOM;
      if (!RD || typeof RD.createPortal !== 'function' || !document.body) return null;
      return RD.createPortal(h('div', GUARD_PROPS, props.children), portalHost());
    }

    /* ---- Menu (APG menu pattern) ------------------------------------------- */
    class Menu extends RComponent {
      constructor(props) {
        super(props);
        this.state = { pos: null };
        this.el = null;
        this._items = [];
        this._typed = '';
        this._typedAt = 0;
        var self = this;
        this._setEl = function (el) { self.el = el; if (self._h) self._h.setElement(el); };
        this._onKey = this._onKey.bind(this);
      }
      componentDidMount() {
        var self = this;
        this._prevFocus = document.activeElement;
        this._h = NS.overlay.open(this, {
          kind: 'menu', ignoreEls: this.props.ignoreEls,
          onClose: function (reason) { self._closed(reason); },
        });
        this._h.setElement(this.el);
        this._place();
        this._initialFocus();
      }
      componentDidUpdate(prev) {
        if (prev.x !== this.props.x || prev.y !== this.props.y || (prev.items || []).length !== (this.props.items || []).length) this._place();
        this._initialFocus();
      }
      /** Once placed (rendered hidden until measured; hidden elements cannot take focus). */
      _initialFocus() {
        if (this._focused || !this.state.pos) return;
        this._focused = true;
        var items = this._focusableItems();
        if (this.props.openedByKeyboard && items.length) focusEl(items[0]);
        else focusEl(this.el);
      }
      componentWillUnmount() {
        this._unmounting = true;
        NS.overlay.close(this._h, 'unmount');
        restoreFocus(this.el, this.props.returnFocus || this._prevFocus);
      }
      _closed(reason) {
        if (reason === 'escape' || reason === 'select' || reason === 'tab') {
          focusEl(this.props.returnFocus || this._prevFocus);
        }
        if (!this._unmounting && this.props.onClose) this.props.onClose(reason);
      }
      _place() {
        if (!this.el) return;
        var r = this.el.getBoundingClientRect();
        var pos = placeAt(Number(this.props.x) || 0, Number(this.props.y) || 0, r.width, r.height);
        if (!this.state.pos || this.state.pos.left !== pos.left || this.state.pos.top !== pos.top) this.setState({ pos: pos });
      }
      _focusableItems() {
        return this.el ? Array.prototype.slice.call(this.el.querySelectorAll('.ctg-menu__item')) : [];
      }
      _move(delta, absolute) {
        var list = this._focusableItems();
        if (!list.length) return;
        var i = list.indexOf(document.activeElement);
        var n = absolute != null ? absolute : i < 0 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length;
        focusEl(list[n]);
      }
      _activate(item) {
        if (!item || item.disabled || item.busy) return;
        try { if (item.onSelect) item.onSelect(item); } catch (e) { log.warn('menu item failed', item.id, e); }
        if (!item.keepOpen) NS.overlay.close(this._h, 'select');
      }
      _onKey(e) {
        var k = e.key;
        if (k === 'ArrowDown') { e.preventDefault(); this._move(1); }
        else if (k === 'ArrowUp') { e.preventDefault(); this._move(-1); }
        else if (k === 'Home') { e.preventDefault(); this._move(0, 0); }
        else if (k === 'End') { e.preventDefault(); this._move(0, this._focusableItems().length - 1); }
        else if (k === 'Enter' || k === ' ' || k === 'Spacebar') {
          e.preventDefault();
          var idx = this._focusableItems().indexOf(document.activeElement);
          if (idx >= 0) this._activate(this._items[idx]);
        } else if (k === 'Tab') {
          e.preventDefault();
          NS.overlay.close(this._h, 'tab');
        } else if (k && k.length === 1 && /\S/.test(k) && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // first-letter typeahead (repeated letters cycle; a pause > 700 ms starts over)
          var now = Date.now();
          this._typed = now - this._typedAt > 700 ? k.toLowerCase() : this._typed + k.toLowerCase();
          this._typedAt = now;
          var list = this._focusableItems();
          var start = list.indexOf(document.activeElement);
          var q = this._typed.length > 1 && this._typed.split('').every(function (c) { return c === this._typed[0]; }, this)
            ? this._typed[0] : this._typed;
          for (var j = 1; j <= this._items.length; j++) {
            var n = (start + j + this._items.length) % this._items.length;
            if (String(this._items[n].label || '').toLowerCase().indexOf(q) === 0) { focusEl(list[n]); break; }
          }
        }
      }
      render() {
        var self = this;
        var p = this.props;
        var items = (p.items || []).filter(function (it) { return it && !it.hidden; });
        this._items = items;
        var pos = this.state.pos;
        var style = {
          left: pos ? pos.left : (Number(p.x) || 0), top: pos ? pos.top : (Number(p.y) || 0),
          maxHeight: pos ? pos.maxHeight : undefined, visibility: pos ? 'visible' : 'hidden',
        };
        var children = [];
        if (p.header) {
          var hdr = typeof p.header === 'object' && !(React && React.isValidElement && React.isValidElement(p.header)) && p.header.title != null
            ? [h('div', { key: 't', className: 'ctg-menu__header-title' }, String(p.header.title)),
              p.header.subtitle ? h('div', { key: 's', className: 'ctg-menu__header-sub', title: String(p.header.subtitle) }, String(p.header.subtitle)) : null]
            : p.header;
          children.push(h('div', { key: '__hdr', className: 'ctg-menu__header', role: 'presentation' }, hdr));
        }
        items.forEach(function (it, i) {
          if (it.separatorBefore && i > 0) children.push(h('div', { key: 'sep' + i, className: 'ctg-menu__separator', role: 'separator' }));
          var cls = 'ctg-menu__item' + (it.disabled ? ' ctg-menu__item--disabled' : '') + (it.busy ? ' ctg-menu__item--busy' : '');
          children.push(h('div', {
            key: it.id || i, className: cls, role: 'menuitem', tabIndex: -1,
            'aria-disabled': it.disabled ? 'true' : undefined, 'aria-busy': it.busy ? 'true' : undefined,
            'data-id': it.id, title: it.title,
            onClick: function () { self._activate(it); },
            onMouseEnter: function (e) { focusEl(e.currentTarget); },
          },
          h('span', { className: 'ctg-menu__label' },
            h('span', null, String(it.label == null ? '' : it.label)),
            it.hint ? h('span', { className: 'ctg-menu__hint' }, String(it.hint)) : null),
          it.busy ? h(Spinner, null) : null));
        });
        return h(Portal, null, h('div', {
          ref: this._setEl, className: 'ctg-menu' + (p.className ? ' ' + p.className : ''), role: 'menu',
          'aria-label': p.ariaLabel || NS.i18n.t('ui.menu'), tabIndex: -1, style: style,
          onKeyDown: this._onKey,
          onContextMenu: function (e) { e.preventDefault(); },
        }, children));
      }
    }

    /* ---- Dialog (dialog frame, kept inside the visualViewport) -------------- */
    class Dialog extends RComponent {
      constructor(props) {
        super(props);
        this.state = { vp: viewport(), anchorPos: null };
        this.el = null;
        this.titleId = NS.util.uid('ctg-dlg-title');
        var self = this;
        this._setEl = function (el) { self.el = el; if (self._h) self._h.setElement(el); };
        this._relayout = NS.util.rafThrottle(function () { self._layout(); });
        this._onKey = function (e) { trapFocus(e, self.el); if (self.props.onKeyDown) self.props.onKeyDown(e); };
        this._onFocusIn = function (e) {
          var t = e.target;
          if (t && /^(INPUT|SELECT|TEXTAREA)$/.test(t.tagName) && t.scrollIntoView) {
            try { t.scrollIntoView({ block: 'nearest' }); } catch (err) { /* ignore */ }
          }
        };
        this._downOnBackdrop = false;
      }
      componentDidMount() {
        var self = this;
        this._prevFocus = document.activeElement;
        this._h = NS.overlay.open(this, {
          kind: 'dialog',
          onRequestClose: function (reason) { self._request(reason); },
          // closed by the manager (closeAll / closeOwner): ask the owner to unmount us
          onClose: function (reason) { if (!self._unmounting && reason !== 'unmount') self._request(reason); },
        });
        this._h.setElement(this.el);
        var vv = window.visualViewport;
        if (vv && vv.addEventListener) {
          vv.addEventListener('resize', this._relayout);
          vv.addEventListener('scroll', this._relayout);
        }
        window.addEventListener('resize', this._relayout);
        if (this.el) this.el.addEventListener('focusin', this._onFocusIn);
        this._layout();
        this._initialFocus();
      }
      componentDidUpdate(prev) {
        if (prev.position !== this.props.position) this._layout();
        this._initialFocus();
      }
      /**
       * Initial focus: the requested element, else the first control of the body, then the footer, then
       * the dialog itself; an input's text is selected. Waits until an anchored dialog has been placed.
       */
      _initialFocus() {
        if (this._focused) return;
        var anchored = this.props.position && typeof this.props.position === 'object' && this.props.position.anchorRect;
        if (anchored && !this.state.anchorPos) return;
        this._focused = true;
        var body = this.el && this.el.querySelector('.ctg-dialog__body');
        var footer = this.el && this.el.querySelector('.ctg-dialog__footer');
        var target = resolveFocusTarget(this.props.initialFocus, this.el) || focusables(body)[0] || focusables(footer)[0] || this.el;
        focusEl(target);
        if (target && target.select && /^(INPUT|TEXTAREA)$/.test(target.tagName)) { try { target.select(); } catch (e) { /* ignore */ } }
      }
      componentWillUnmount() {
        this._unmounting = true;
        NS.overlay.close(this._h, 'unmount');
        var vv = window.visualViewport;
        if (vv && vv.removeEventListener) {
          vv.removeEventListener('resize', this._relayout);
          vv.removeEventListener('scroll', this._relayout);
        }
        window.removeEventListener('resize', this._relayout);
        this._relayout.cancel();
        if (this.el) this.el.removeEventListener('focusin', this._onFocusIn);
        restoreFocus(this.el, this.props.returnFocus || this._prevFocus);
      }
      _request(reason) {
        if (this.props.onRequestClose) this.props.onRequestClose(reason);
      }
      _layout() {
        var vp = viewport();
        var pos = this.props.position;
        var anchorPos = null;
        if (pos && typeof pos === 'object' && pos.anchorRect && this.el) {
          var r = this.el.getBoundingClientRect();
          var p = placeNear(pos.anchorRect, r.width, r.height, 'bottom', vp, 4, 'start');
          anchorPos = { left: p.left - vp.left, top: p.top - vp.top };
        }
        var cur = this.state.vp;
        var same = cur.left === vp.left && cur.top === vp.top && cur.width === vp.width && cur.height === vp.height &&
          JSON.stringify(anchorPos) === JSON.stringify(this.state.anchorPos);
        if (!same) this.setState({ vp: vp, anchorPos: anchorPos });
      }
      render() {
        var self = this;
        var p = this.props;
        var vp = this.state.vp;
        var anchored = !!(p.position && typeof p.position === 'object' && p.position.anchorRect);
        var backdropStyle = { left: vp.left, top: vp.top, width: vp.width, height: vp.height };
        var dlgStyle = Object.assign({}, p.style || {});
        if (p.width) dlgStyle.width = p.width;
        if (anchored) {
          dlgStyle.left = this.state.anchorPos ? this.state.anchorPos.left : 0;
          dlgStyle.top = this.state.anchorPos ? this.state.anchorPos.top : 0;
          dlgStyle.maxHeight = Math.max(80, vp.height - 2 * MARGIN);
          if (!this.state.anchorPos) dlgStyle.visibility = 'hidden';
        } else {
          dlgStyle.maxHeight = Math.max(80, vp.height - 32);
        }
        var dismiss = p.dismissOnBackdrop !== false;
        return h(Portal, null, h('div', {
          className: 'ctg-dialog-backdrop' + (anchored ? ' ctg-dialog-backdrop--anchored' : ''),
          style: backdropStyle,
          onPointerDown: function (e) { self._downOnBackdrop = e.target === e.currentTarget; },
          onClick: function (e) {
            if (dismiss && self._downOnBackdrop && e.target === e.currentTarget) self._request('backdrop');
            self._downOnBackdrop = false;
          },
        }, h('div', {
          ref: this._setEl,
          className: 'ctg-dialog' + (anchored ? ' ctg-dialog--anchored' : '') + (p.className ? ' ' + p.className : ''),
          role: p.role || 'dialog', 'aria-modal': 'true', 'aria-labelledby': this.titleId,
          'aria-describedby': p.ariaDescribedBy || undefined, 'aria-busy': p.busy ? 'true' : undefined,
          tabIndex: -1, style: dlgStyle, onKeyDown: this._onKey,
        },
        h('div', { className: 'ctg-dialog__header' },
          h('h2', { id: this.titleId, className: 'ctg-dialog__title', title: typeof p.title === 'string' ? p.title : undefined }, p.title),
          p.closeButton === false ? null : h('button', {
            type: 'button', className: 'ctg-dialog__close ctg-btn--icon', 'aria-label': NS.i18n.t('ui.close'),
            title: NS.i18n.t('ui.close'), onClick: function () { self._request('close'); },
          }, '\u00D7')),
        h('div', { className: 'ctg-dialog__body' }, p.children),
        p.footer ? h('div', { className: 'ctg-dialog__footer' }, p.footer) : null)));
      }
    }

    /* ---- Popover (anchored panel; flip + clamp) ------------------------------ */
    class Popover extends RComponent {
      constructor(props) {
        super(props);
        this.state = { pos: null };
        this.el = null;
        var self = this;
        this._setEl = function (el) { self.el = el; if (self._h) self._h.setElement(el); };
        this._onKey = function (e) {
          if (self.props.trapFocus !== false) trapFocus(e, self.el);
          if (self.props.onKeyDown) self.props.onKeyDown(e);
        };
      }
      componentDidMount() {
        var self = this;
        this._prevFocus = document.activeElement;
        this._h = NS.overlay.open(this, {
          kind: 'popover', ignoreEls: this.props.ignoreEls,
          onClose: function (reason) { if (!self._unmounting && self.props.onClose) self.props.onClose(reason); },
        });
        this._h.setElement(this.el);
        this._place();
        this._initialFocus();
      }
      componentDidUpdate(prev) {
        if (prev.anchorRect !== this.props.anchorRect || prev.placement !== this.props.placement) this._place();
        this._initialFocus();
      }
      _initialFocus() {
        if (this._focused || !this.state.pos) return;
        this._focused = true;
        focusEl(resolveFocusTarget(this.props.initialFocus, this.el) || focusables(this.el)[0] || this.el);
      }
      componentWillUnmount() {
        this._unmounting = true;
        NS.overlay.close(this._h, 'unmount');
        restoreFocus(this.el, this.props.returnFocus || this._prevFocus);
      }
      _place() {
        if (!this.el) return;
        var r = this.el.getBoundingClientRect();
        var pos = placeNear(this.props.anchorRect, r.width, r.height, this.props.placement, null, this.props.offset, this.props.align);
        var cur = this.state.pos;
        if (!cur || cur.left !== pos.left || cur.top !== pos.top || cur.placement !== pos.placement) this.setState({ pos: pos });
      }
      render() {
        var p = this.props;
        var pos = this.state.pos;
        return h(Portal, null, h('div', {
          ref: this._setEl, className: 'ctg-popover' + (p.className ? ' ' + p.className : ''),
          role: p.role || 'dialog', 'aria-label': p.ariaLabel, 'aria-labelledby': p.ariaLabelledBy,
          'aria-describedby': p.ariaDescribedBy, 'data-placement': pos ? pos.placement : undefined, tabIndex: -1,
          style: { left: pos ? pos.left : 0, top: pos ? pos.top : 0, visibility: pos ? 'visible' : 'hidden' },
          onKeyDown: this._onKey,
        }, p.children));
      }
    }

    /* ---- Confirm (discrete-command confirmation; chart pen removal) --------- */
    class Confirm extends RComponent {
      constructor(props) {
        super(props);
        this._done = false;
        this.textId = NS.util.uid('ctg-cfm');
        var self = this;
        this._finish = function (ok) {
          if (self._done) return;
          self._done = true;
          var fn = ok ? self.props.onConfirm : self.props.onCancel;
          try { if (fn) fn(); } catch (e) { log.warn('confirm callback failed', e); }
        };
      }
      componentWillUnmount() { this._finish(false); }    // closed by its owner without an answer = cancel
      render() {
        var self = this;
        var p = this.props;
        var buttons = h('div', { className: 'ctg-confirm__actions' },
          h(Button, { kind: 'secondary', 'data-ctg-cancel': '1', onClick: function () { self._finish(false); } },
            p.cancelLabel || NS.i18n.t('ui.cancel')),
          h(Button, { kind: p.tone === 'danger' ? 'danger' : 'primary', 'data-ctg-confirm': '1', onClick: function () { self._finish(true); } },
            p.confirmLabel || NS.i18n.t('ui.confirm')));
        var text = h('div', { id: this.textId, className: 'ctg-confirm__text' }, p.text);
        if (p.anchorRect) {
          return h(Popover, {
            anchorRect: p.anchorRect, placement: p.placement || 'bottom', role: 'alertdialog', className: 'ctg-confirm',
            ariaDescribedBy: this.textId, ariaLabel: p.ariaLabel || NS.i18n.t('ui.confirm'), returnFocus: p.returnFocus,
            initialFocus: '[data-ctg-cancel]', onClose: function () { self._finish(false); },
          }, text, buttons);
        }
        return h(Dialog, {
          title: p.title || NS.i18n.t('ui.confirm'), role: 'alertdialog', className: 'ctg-confirm', ariaDescribedBy: this.textId,
          initialFocus: '[data-ctg-cancel]', returnFocus: p.returnFocus,
          onRequestClose: function () { self._finish(false); },
        }, text, buttons);
      }
    }

    /* ---- Bubble (transient message next to the value; role status/alert) ---- */
    class Bubble extends RComponent {
      constructor(props) {
        super(props);
        this.state = { pos: null };
        this.el = null;
        var self = this;
        this._setEl = function (el) { self.el = el; if (self._h) self._h.setElement(el); };
      }
      componentDidMount() {
        var self = this;
        this._h = NS.overlay.open(this, {
          kind: 'bubble',
          onClose: function (reason) { if (!self._unmounting && self.props.onClose) self.props.onClose(reason); },
        });
        this._h.setElement(this.el);
        this._place();
        this._arm();
        NS.a11y.announce(this.props.text, this.props.tone === 'error' ? 'assertive' : 'polite');
      }
      componentDidUpdate(prev) {
        if (prev.text !== this.props.text) {
          this._arm();
          NS.a11y.announce(this.props.text, this.props.tone === 'error' ? 'assertive' : 'polite');
        }
        if (prev.anchorRect !== this.props.anchorRect || prev.text !== this.props.text) this._place();
      }
      componentWillUnmount() {
        this._unmounting = true;
        if (this._timer) clearTimeout(this._timer);
        NS.overlay.close(this._h, 'unmount');
      }
      _arm() {
        var self = this;
        if (this._timer) clearTimeout(this._timer);
        var ms = this.props.durationMs == null ? 6000 : Number(this.props.durationMs);
        this._timer = ms > 0 ? setTimeout(function () { NS.overlay.close(self._h, 'timeout'); }, ms) : null;
      }
      _place() {
        if (!this.el) return;
        var r = this.el.getBoundingClientRect();
        var pos = placeNear(this.props.anchorRect, r.width, r.height, this.props.placement || 'bottom', null, 4, 'start');
        var cur = this.state.pos;
        if (!cur || cur.left !== pos.left || cur.top !== pos.top) this.setState({ pos: pos });
      }
      render() {
        var p = this.props;
        var pos = this.state.pos;
        var tone = p.tone || 'info';
        return h(Portal, null, h('div', {
          ref: this._setEl, className: 'ctg-bubble ctg-bubble--' + tone, role: tone === 'error' ? 'alert' : 'status',
          style: { left: pos ? pos.left : 0, top: pos ? pos.top : 0, visibility: pos ? 'visible' : 'hidden' },
        }, String(p.text == null ? '' : p.text)));
      }
    }

    /* ---- Toast (page level, plain DOM: no component owns it) ----------------- */
    var toasts = new Map();
    var toastHost = null;
    function toastHostEl() {
      if (toastHost && toastHost.isConnected) return toastHost;
      ensureCommonStyles();
      toastHost = document.createElement('div');
      toastHost.className = 'ctg-toast-host';
      toastHost.setAttribute('role', 'region');
      toastHost.setAttribute('aria-label', NS.i18n.t('ui.notifications'));
      document.body.appendChild(toastHost);
      return toastHost;
    }
    var Toast = {
      /**
       * Shows (or updates, when `key` is already shown) a page-level toast; de-duplicated by key.
       * {key, text, actionLabel, onAction, durationMs (0 = until dismissed), tone}. Returns {close()}.
       */
      show: function (o) {
        var opt = o || {};
        var key = opt.key || NS.util.uid('toast');
        if (!hasDocument() || !document.body) return { close: function () { } };
        var rec = toasts.get(key);
        if (!rec) {
          var el = document.createElement('div');
          el.className = 'ctg-toast' + (opt.tone ? ' ctg-toast--' + opt.tone : '');
          el.setAttribute('role', 'status');
          el.setAttribute('aria-live', 'polite');
          el.setAttribute('data-key', key);
          var text = document.createElement('span');
          text.className = 'ctg-toast__text';
          el.appendChild(text);
          rec = { el: el, text: text, action: null, timer: null };
          var dismiss = document.createElement('button');
          dismiss.type = 'button';
          dismiss.className = 'ctg-btn ctg-btn--icon ctg-toast__close';
          dismiss.setAttribute('aria-label', NS.i18n.t('ui.dismiss'));
          dismiss.textContent = '\u00D7';
          dismiss.addEventListener('click', function () { Toast.close(key); });
          rec.dismiss = dismiss;
          el.appendChild(dismiss);
          toastHostEl().appendChild(el);
          toasts.set(key, rec);
        }
        rec.text.textContent = String(opt.text == null ? '' : opt.text);
        if (opt.actionLabel && !rec.action) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ctg-btn ctg-toast__action';
          rec.el.insertBefore(btn, rec.dismiss);
          rec.action = btn;
        }
        if (rec.action) {
          rec.action.textContent = String(opt.actionLabel || '');
          rec.action.onclick = function () {
            try { if (opt.onAction) opt.onAction(); } finally { Toast.close(key); }
          };
        }
        if (rec.timer) clearTimeout(rec.timer);
        rec.timer = opt.durationMs > 0 ? setTimeout(function () { Toast.close(key); }, opt.durationMs) : null;
        return { close: function () { Toast.close(key); } };
      },
      close: function (key) {
        var rec = toasts.get(key);
        if (!rec) return;
        toasts.delete(key);
        if (rec.timer) clearTimeout(rec.timer);
        if (rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
      },
      count: function () { return toasts.size; },
    };

    /* ---- small building blocks ------------------------------------------------ */
    function Spinner(props) {
      return h('span', { className: 'ctg-spinner' + (props && props.className ? ' ' + props.className : ''), 'aria-hidden': 'true' });
    }
    /** button.ctg-btn.ctg-btn--<kind> (primary | secondary | danger | icon); other props pass through. */
    function Button(props) {
      var p = Object.assign({}, props);
      var kind = p.kind || 'secondary';
      delete p.kind;
      p.type = p.type || 'button';
      p.className = 'ctg-btn ctg-btn--' + kind + (props.className ? ' ' + props.className : '');
      var children = p.children;
      delete p.children;
      return h('button', p, children);
    }
    /**
     * label + control + help + error (role=alert). Pass the control's id as `id`; a single element child
     * gets aria-describedby (help + error) and aria-invalid (when there is an error) unless it sets them.
     */
    function Field(props) {
      var id = props.id;
      var helpId = props.help && id ? id + '-help' : null;
      var errId = props.error && id ? id + '-error' : null;
      var child = props.children;
      if (React && React.isValidElement && React.isValidElement(child) && (helpId || errId)) {
        var extra = {};
        if (child.props['aria-describedby'] == null) extra['aria-describedby'] = [helpId, errId].filter(Boolean).join(' ');
        if (props.error && child.props['aria-invalid'] == null) extra['aria-invalid'] = 'true';
        child = React.cloneElement(child, extra);
      }
      return h('div', { className: 'ctg-field' + (props.className ? ' ' + props.className : '') },
        props.label != null ? h('label', { className: 'ctg-field__label', htmlFor: id }, props.label) : null,
        child,
        props.help ? h('div', { className: 'ctg-field__help', id: helpId || undefined }, props.help) : null,
        props.error ? h('div', { className: 'ctg-field__error', role: 'alert', id: errId || undefined }, props.error) : null);
    }
    /**
     * Radio group of buttons (APG radio pattern, roving tabindex): options [{value, label, disabled}],
     * value, onChange(value), name/ariaLabel. Arrow keys move and select; selection uses looseEqual.
     */
    function Choice(props) {
      var opts = props.options || [];
      var sel = -1;
      opts.forEach(function (o, i) { if (sel < 0 && o && NS.util.looseEqual(o.value, props.value)) sel = i; });
      function pick(i) { var o = opts[i]; if (o && !o.disabled && props.onChange) props.onChange(o.value, o); }
      function onKey(e) {
        var dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
        if (!dir) return;
        e.preventDefault();
        var start = sel < 0 ? (dir > 0 ? -1 : 0) : sel;
        for (var j = 1; j <= opts.length; j++) {
          var n = (start + dir * j + opts.length * 2) % opts.length;
          if (!opts[n].disabled) {
            pick(n);
            var group = e.currentTarget;
            var btn = group && group.querySelectorAll('.ctg-choice__option')[n];
            focusEl(btn);
            break;
          }
        }
      }
      var firstEnabled = -1;
      opts.forEach(function (o, i) { if (firstEnabled < 0 && !o.disabled) firstEnabled = i; });
      return h('div', {
        className: 'ctg-choice' + (props.className ? ' ' + props.className : ''), role: 'radiogroup',
        'aria-label': props.ariaLabel || props.name, id: props.id, onKeyDown: onKey,
      }, opts.map(function (o, i) {
        var checked = i === sel;
        return h('button', {
          key: i, type: 'button', className: 'ctg-choice__option', role: 'radio', 'aria-checked': checked ? 'true' : 'false',
          disabled: !!o.disabled, tabIndex: checked || (sel < 0 && i === firstEnabled) ? 0 : -1,
          onClick: function () { pick(i); },
        }, String(o.label == null ? o.value : o.label));
      }));
    }

    /**
     * Touch/pen long-press on a DOM element (iOS fires no contextmenu): fires onLongPress({x, y,
     * pointerType}) after `ms` (550) of a still press; cancelled by moving more than `moveTolerance`
     * (8 px), lifting, pointercancel or any scroll. After it fires, the follow-up click/contextmenu
     * (Android sends both) is swallowed for `swallowMs` (800). Returns a disposer.
     */
    /*
     * Page-level part of longPress, shared by every instance (250 displays must not mean 750 window
     * listeners and 250 cancel calls per scroll event): one capture listener each for scroll (cancels
     * only the presses currently being held), click and contextmenu (swallowed until lpSwallowUntil).
     * Installed with the first instance, removed with the last.
     */
    var lpInstances = 0;
    var lpPressing = new Set();      // cancel functions of presses whose timer is running
    var lpSwallowUntil = 0;
    function lpOnScroll() {
      if (!lpPressing.size) return;
      Array.from(lpPressing).forEach(function (cancel) { cancel(); });
    }
    function lpSwallow(e) {
      if (Date.now() < lpSwallowUntil) {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.type === 'click') lpSwallowUntil = 0;
      }
    }
    function lpListen(delta) {
      var before = lpInstances;
      lpInstances = Math.max(0, lpInstances + delta);
      if (typeof window.addEventListener !== 'function') return;
      if (before === 0 && lpInstances > 0) {
        window.addEventListener('scroll', lpOnScroll, true);
        window.addEventListener('click', lpSwallow, true);
        window.addEventListener('contextmenu', lpSwallow, true);
      } else if (before > 0 && lpInstances === 0) {
        window.removeEventListener('scroll', lpOnScroll, true);
        window.removeEventListener('click', lpSwallow, true);
        window.removeEventListener('contextmenu', lpSwallow, true);
        lpPressing.clear();
      }
    }

    NS.debug.longPress = function () { return { instances: lpInstances, pressing: lpPressing.size }; };

    function longPress(el, opts) {
      if (!el || typeof el.addEventListener !== 'function') return function () { };
      var o = opts || {};
      var ms = o.ms > 0 ? o.ms : 550;
      var tol = o.moveTolerance > 0 ? o.moveTolerance : 8;
      var types = o.pointerTypes || ['touch', 'pen'];
      var swallowMs = o.swallowMs > 0 ? o.swallowMs : 800;
      var timer = null, start = null, pid = null, disposed = false;
      function cancel() {
        if (timer) clearTimeout(timer);
        timer = null; start = null; pid = null;
        lpPressing.delete(cancel);
      }
      function onDown(e) {
        if (types.indexOf(e.pointerType) < 0 || (e.button != null && e.button > 0)) return;
        cancel();
        start = { x: e.clientX, y: e.clientY };
        pid = e.pointerId;
        var pt = { x: e.clientX, y: e.clientY, pointerType: e.pointerType };
        lpPressing.add(cancel);
        timer = setTimeout(function () {
          timer = null; start = null; pid = null;
          lpPressing.delete(cancel);
          lpSwallowUntil = Date.now() + swallowMs;
          longPressSwallowUntil = lpSwallowUntil;
          try { o.onLongPress && o.onLongPress(pt); } catch (err) { log.warn('long-press handler failed', err); }
        }, ms);
      }
      function onMove(e) {
        if (!start || e.pointerId !== pid) return;
        if (Math.abs(e.clientX - start.x) > tol || Math.abs(e.clientY - start.y) > tol) cancel();
      }
      function onEnd(e) { if (pid == null || e.pointerId === pid) cancel(); }
      el.addEventListener('pointerdown', onDown);
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onEnd);
      el.addEventListener('pointercancel', onEnd);
      el.addEventListener('lostpointercapture', onEnd);
      lpListen(1);
      return function () {
        if (disposed) return;
        disposed = true;
        cancel();
        el.removeEventListener('pointerdown', onDown);
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onEnd);
        el.removeEventListener('pointercancel', onEnd);
        el.removeEventListener('lostpointercapture', onEnd);
        lpListen(-1);
      };
    }

    NS.ui = {
      Portal: Portal,
      portalHost: portalHost,
      Menu: Menu,
      Dialog: Dialog,
      Popover: Popover,
      Confirm: Confirm,
      Bubble: Bubble,
      Toast: Toast,
      Spinner: Spinner,
      Button: Button,
      Field: Field,
      Choice: Choice,
      longPress: longPress,
      FocusTrap: { focusables: focusables, trap: trapFocus, focus: focusEl },
      viewport: viewport,
      placeAt: placeAt,
      placeNear: placeNear,
    };

    /* ========================================================================
     * SECTION 15 / NS.nav — popups and page navigation
     * ----------------------------------------------------------------------
     * Purely client-side, like system.perspective.openPopup / navigate (the
     * gateway only relays those to the same client store). Every function
     * returns {ok, method, error} and never throws.
     * ====================================================================== */
    var PAGE_PATH_RE = /^\/(?!\/)/;
    function clientOf(store) {
      try {
        if (store && store.view && store.view.page && store.view.page.parent) return store.view.page.parent;
      } catch (e) { /* fall through */ }
      return window.__client || null;
    }
    NS.nav = {
      client: clientOf,
      isDesigner: function (store) {
        var c = clientOf(store);
        return !!(c && (c.isDesigner === true || c.scope === 'D'));
      },
      /** A same-origin page path: starts with exactly one '/', no backslash or control character. */
      isPagePath: function (path) {
        return typeof path === 'string' && PAGE_PATH_RE.test(path) && !/[\\\u0000-\u001f]/.test(path);
      },
      /**
       * Opens (or focuses, when its id is already open) a Perspective popup:
       * cfg = {id, viewPath, params, title, showCloseIcon, draggable, resizable, modal, overlayDismiss,
       * viewportBound, position:{left, top, width, height}}. mounts.activatePopup first; fallback the
       * built-in 'popup' client action. Works in Designer preview where the client supports it.
       */
      openPopup: function (store, cfg) {
        var c = clientOf(store);
        var o = cfg || {};
        if (!o.viewPath) return { ok: false, method: 'none', error: 'NO_VIEW' };
        var id = String(o.id || NS.util.uid('ctg-popup'));
        // Perspective's popup store hands `viewParams` to the view (ViewPopup reads props.viewParams; the Popup
        // action's config uses the same key). `params` alone reaches nobody; both are sent.
        var params = o.params || {};
        var spec = {
          id: id, viewPath: String(o.viewPath), viewParams: params, params: params, title: o.title == null ? '' : String(o.title),
          showCloseIcon: o.showCloseIcon !== false, draggable: o.draggable !== false, resizable: !!o.resizable,
          modal: !!o.modal, overlayDismiss: !!o.overlayDismiss, viewportBound: !!o.viewportBound,
        };
        if (o.position) { spec.positionType = 'exact'; spec.position = o.position; }
        try {
          var mounts = c && c.mounts;
          if (mounts) {
            var open = mounts.activePopups;
            var existing = open && typeof open.some === 'function' && open.some(function (p) { return p && p.id === id; });
            if (existing && typeof mounts.focusPopup === 'function') { mounts.focusPopup(id); return { ok: true, method: 'focus', id: id }; }
            if (typeof mounts.activatePopup === 'function') { mounts.activatePopup(spec); return { ok: true, method: 'mounts', id: id }; }
          }
        } catch (e) {
          log.debug('activatePopup failed, trying the popup action', e);
        }
        try {
          var reg = PC && PC.ActionRegistry;
          var action = reg && reg.get && reg.get('popup');
          if (action && store) {
            action.create(store, { config: Object.assign({ type: 'open' }, spec) })();
            return { ok: true, method: 'action', id: id };
          }
        } catch (e) {
          log.warn('could not open popup', spec.viewPath, e);
          return { ok: false, method: 'none', error: 'FAILED' };
        }
        return { ok: false, method: 'none', error: 'UNAVAILABLE' };
      },
      closePopup: function (store, id) {
        var c = clientOf(store);
        try { if (c && c.mounts && c.mounts.closePopup) { c.mounts.closePopup(id); return { ok: true }; } } catch (e) { /* ignore */ }
        return { ok: false };
      },
      /**
       * Navigates to a page path of this project ({path, newTab}); skipped in the Designer (console
       * info). newTab opens basename + path with noopener. Invalid paths are refused (INVALID_PATH).
       */
      navigate: function (store, opts) {
        var o = opts || {};
        var path = o.path;
        if (!NS.nav.isPagePath(path)) return { ok: false, error: 'INVALID_PATH' };
        var c = clientOf(store);
        if (NS.nav.isDesigner(store)) { log.info('navigation skipped in the Designer:', path); return { ok: false, error: 'DESIGNER' }; }
        try {
          if (o.newTab) {
            var base = c && typeof c.getBasename === 'function' ? c.getBasename() : '';
            window.open(base + path, '_blank', 'noopener');
            return { ok: true, method: 'newTab' };
          }
          if (c && c.history && typeof c.history.push === 'function') { c.history.push(path); return { ok: true, method: 'history' }; }
        } catch (e) {
          log.warn('navigation failed', path, e);
          return { ok: false, error: 'FAILED' };
        }
        return { ok: false, error: 'UNAVAILABLE' };
      },
    };

    /* ========================================================================
     * SECTION 16 / NS.resize — one shared ResizeObserver for the page
     * ----------------------------------------------------------------------
     * Uses entry.contentRect (layout pixels, unaffected by CSS transforms),
     * coalesces all entries into one requestAnimationFrame and ignores
     * changes below 1 px (no "ResizeObserver loop" warnings).
     * ====================================================================== */
    var roTargets = new Map();     // element -> {cbs: Set, w, h}
    var roPending = new Map();
    var roObserver = null;
    var roFlush = null;
    function roDeliver() {
      roFlush = null;
      var batch = Array.from(roPending.entries());
      roPending.clear();
      batch.forEach(function (pair) {
        var rec = roTargets.get(pair[0]);
        var r = pair[1];
        if (!rec || (Math.abs(r.width - rec.w) < 1 && Math.abs(r.height - rec.h) < 1)) return;
        rec.w = r.width; rec.h = r.height;
        rec.cbs.forEach(function (cb) {
          try { cb({ width: r.width, height: r.height, top: r.top || 0, left: r.left || 0 }); } catch (e) { log.warn('resize callback failed', e); }
        });
      });
    }
    function roQueue(el, rect) {
      roPending.set(el, rect);
      if (!roFlush) roFlush = nextFrame(roDeliver);
    }
    NS.resize = {
      observe: function (el, cb) {
        if (!el || typeof cb !== 'function') return function () { };
        var rec = roTargets.get(el);
        if (!rec) { rec = { cbs: new Set(), w: -1, h: -1 }; roTargets.set(el, rec); }
        rec.cbs.add(cb);
        if (typeof window.ResizeObserver === 'function') {
          if (!roObserver) {
            roObserver = new window.ResizeObserver(function (entries) {
              entries.forEach(function (en) { roQueue(en.target, en.contentRect); });
            });
          }
          if (rec.cbs.size === 1) roObserver.observe(el);
          else if (rec.w >= 0) {
            var known = { width: rec.w, height: rec.h };
            nextFrame(function () { try { cb(known); } catch (e) { log.warn('resize callback failed', e); } });
          }
        } else {
          // fallback: window resize + one initial measurement (offset sizes ignore transforms too)
          var measure = function () { roQueue(el, { width: el.offsetWidth || 0, height: el.offsetHeight || 0 }); };
          rec.fallback = rec.fallback || measure;
          window.addEventListener('resize', rec.fallback);
          measure();
        }
        return function () {
          var r = roTargets.get(el);
          if (!r) return;
          r.cbs.delete(cb);
          if (r.cbs.size) return;
          roTargets.delete(el);
          roPending.delete(el);
          if (roObserver) roObserver.unobserve(el);
          if (r.fallback) window.removeEventListener('resize', r.fallback);
        };
      },
      /** Number of observed elements (leak checks). */
      count: function () { return roTargets.size; },
    };

    /* ========================================================================
     * SECTION 17 / NS.a11y — one shared screen-reader live region per page
     * ----------------------------------------------------------------------
     * Live values are never aria-live (too noisy); write results, validation
     * messages and bubbles are announced here. The text is
     * cleared first and set on the next tick so a repeated message is read
     * again.
     * ====================================================================== */
    var liveRegions = {};
    function liveRegion(politeness) {
      var el = liveRegions[politeness];
      if (el && el.isConnected) return el;
      el = document.createElement('div');
      el.className = 'ctg-sr-only';
      el.setAttribute('aria-live', politeness);
      el.setAttribute('aria-atomic', 'true');
      el.setAttribute('data-ctg-live', politeness);
      document.body.appendChild(el);
      liveRegions[politeness] = el;
      return el;
    }
    NS.a11y = {
      announce: function (text, politeness) {
        if (!hasDocument() || !document.body || text == null || text === '') return;
        ensureCommonStyles();
        var el = liveRegion(politeness === 'assertive' ? 'assertive' : 'polite');
        el.textContent = '';
        setTimeout(function () { el.textContent = String(text); }, 50);
      },
    };

    /* ========================================================================
     * SECTION 18 / Component registration
     * ----------------------------------------------------------------------
     * ComponentRegistry.register is first-wins: a stale meta from
     * an older copy stays until a full page reload; the welcome's staleClient
     * flag tells the user (page toast, SECTION 12).
     * ====================================================================== */
    NS.registerComponent = function (meta) {
      try {
        PC.ComponentRegistry.register(meta);
        return true;
      } catch (e) {
        log.error('component registration failed', meta && meta.getComponentType && meta.getComponentType(), e);
        return false;
      }
    };
  }
})();
