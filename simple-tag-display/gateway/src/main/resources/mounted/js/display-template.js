/* ============================================================================
 * display-template.js — Display Template component (palette "Display Template")
 * ============================================================================
 *
 * Part id: 'display' (needs 'common'). Component id
 * com.example.simpletagdisplay.SimpleTagDisplay (unchanged since v1).
 *
 * WHAT THE OPERATOR SEES
 *   A tag's label and its live value, formatted like Perspective formats it
 *   (tag Format String / number pattern, session locale and time zone), with
 *   engineering units, quality cues, alarm colours (live priority, else manual
 *   thresholds) and neutral out-of-range marking. Right-click / long-press /
 *   Shift+F10 opens an instant menu (Trend Tag, trend page / popup, Set Value,
 *   Tag Configuration, Change History, Copy Tag Path, custom items). A
 *   writable value can be changed in a dialog ('popup'), in place ('direct')
 *   or after a deliberate gesture ('protected').
 *
 * WHERE THE DATA COMES FROM
 *   Nothing is polled. Each component gets a DisplayTemplateDelegate (SECTION 5)
 *   paired with a Java delegate on the gateway that subscribes the tag with the
 *   session user's permissions and pushes dt.snapshot / dt.values. Every action
 *   (write, config edit, trend, change history) is a delegate request that the
 *   gateway re-checks from TRUSTED props (never from what the browser sends);
 *   what this file shows about permissions (snap.capabilities) is advisory.
 *
 * FILE MAP
 *   SECTION 1  strings (NS.i18n part 'display')
 *   SECTION 2  DT_DEFAULTS, field rules, props reducer, v1 detection
 *   SECTION 3  pure evaluation: value text, bounds, alarms, data state, write
 *              guards, step guard, menu model (NS.dt.*, Node-tested)
 *   SECTION 4  the ctg-dt-styles sheet (zero-specificity :where() rules + tokens)
 *   SECTION 5  DisplayTemplateDelegate (snapshot merge + requests)
 *   SECTION 6  small React pieces (icons, indicator, spin buttons)
 *   SECTION 7  DtSetpointDialog   (popup mode and "Set Value…")
 *   SECTION 8  DtConfigDialog     ("Tag Configuration…")
 *   SECTION 9  DtHistoryDialog    ("Change History…")
 *   SECTION 10 DisplayTemplate component (state machine, menu, editing, render)
 *   SECTION 11 component meta + registration
 *
 * USER DOCUMENTATION: docs/user-guide/components/display-template/ (properties,
 * menu and setpoints, styling, events).
 *
 * CODE RULES: no innerHTML (React children only, icons are
 * createElement('svg')); no polling; colours reach CSS only as style objects
 * after NS.props.color (CSS.supports); every async continuation checks that
 * the component is still mounted.
 * ============================================================================ */
(function () {
  'use strict';

  var NS = window.__CTG = window.__CTG || {};
  NS.loaded = NS.loaded || {};
  NS.ready = NS.ready || {};
  NS._queue = NS._queue || [];

  var PART = 'display';
  var src = document.currentScript && document.currentScript.src;
  var BUILD = (src && new URL(src, location.href).searchParams.get('v')) || 'dev';
  if (NS.loaded[PART]) {
    if (NS.loaded[PART] !== BUILD) {
      console.warn('[CTG]', PART, BUILD, 'ignored; page runs', NS.loaded[PART], '- reload the page');
    }
    return;
  }
  NS.loaded[PART] = BUILD;

  NS._queue.push({ part: PART, needs: ['common'], init: initDisplay });
  if (NS._drain) NS._drain();   // ctg-common.js drains the queue itself when it loads later

  function initDisplay(NS) {
    var PC = window.PerspectiveClient;
    var React = window.React;
    var h = React.createElement;
    var hasOwn = Object.prototype.hasOwnProperty;
    var isPlainObject = NS.util.isPlainObject;
    var COMPONENT_ID = 'com.example.simpletagdisplay.SimpleTagDisplay';
    var log = NS.log('ctg.dt');
    /**
     * Overlay event wall. The menu, dialogs, confirm and bubble render through
     * NS.ui.Portal into document.body, but React bubbles their synthetic events up the REACT tree: through this
     * display's root and then through every Perspective ancestor (containers with events.dom.* scripts).
     * ctg-common's portal guard stops only GUARD_EVENTS, so the overlays are rendered inside a
     * display-owned host (a display:contents span, no box) that stops every bubbling React event. Events of the
     * overlays' own elements have already run when they reach the host. Not coverable by stopPropagation:
     * enter/leave events (React dispatches onMouseEnter/Leave and onPointerEnter/Leave to each fiber between the
     * two targets, it does not bubble them).
     */
    var OVERLAY_STOP_EVENTS = [
      'onClick', 'onAuxClick', 'onContextMenu', 'onDoubleClick', 'onMouseDown', 'onMouseUp', 'onMouseMove', 'onMouseOver', 'onMouseOut',
      'onPointerDown', 'onPointerUp', 'onPointerMove', 'onPointerOver', 'onPointerOut', 'onPointerCancel',
      'onGotPointerCapture', 'onLostPointerCapture',
      'onKeyDown', 'onKeyUp', 'onKeyPress', 'onFocus', 'onBlur',
      'onChange', 'onInput', 'onBeforeInput', 'onSelect', 'onSubmit', 'onReset',
      'onCompositionStart', 'onCompositionUpdate', 'onCompositionEnd', 'onCopy', 'onCut', 'onPaste',
      'onDrag', 'onDragEnd', 'onDragEnter', 'onDragExit', 'onDragLeave', 'onDragOver', 'onDragStart', 'onDrop',
      'onTouchStart', 'onTouchMove', 'onTouchEnd', 'onTouchCancel', 'onWheel',
      'onAnimationStart', 'onAnimationEnd', 'onAnimationIteration', 'onTransitionEnd',
    ];
    var OVERLAY_HOST_PROPS = { key: 'overlays', className: 'dt-overlay-host', style: { display: 'contents' } };
    OVERLAY_STOP_EVENTS.forEach(function (n) { OVERLAY_HOST_PROPS[n] = function (e) { if (e && e.stopPropagation) e.stopPropagation(); }; });

    /* ========================================================================
     * SECTION 1 / Strings (each part registers its own table)
     * ----------------------------------------------------------------------
     * Shared texts (error codes, input validation, connection states) live in
     * ctg-common.js; the keys below are display-only or display-worded
     * overrides. t()/errText() always look in the 'display' table first.
     * ====================================================================== */
    NS.i18n.register(PART, {
      // data states
      'dt.unconfigured': '\u2014',
      'dt.unconfiguredDesigner': 'Set tagPath',
      'dt.invalidPath': 'Invalid tag path',
      'dt.notFound': 'Tag not found',
      'dt.accessDenied': 'No access',
      'dt.invalidPath.title': 'The tag path {tagPath} is not valid (a tag, not a property or alarm path, is required).',
      'dt.notFound.title': 'Tag {tagPath} was not found on the gateway.',
      'dt.accessDenied.title': 'You do not have permission to read {tagPath}.',
      'dt.badQuality': 'Bad quality',
      'dt.silent': 'No updates from the gateway for a while. The value may be out of date.',
      'dt.quality': 'Quality: {name}',
      'dt.v1Badge': 'v1 props: run tools/migrate-v1-views.mjs',
      'dt.v1Warn': 'Display Template: this view still uses v1 props ({keys}). They are ignored; run simple-tag-display/tools/migrate-v1-views.mjs.',
      // Designer preview: shown while the gateway has not sent a value yet, in design mode only
      'dt.placeholder.title': 'Preview value: the gateway has not sent this tag’s value yet.',
      // Designer-only hint when a gateway setting is stricter than this display's own access
      'dt.gwBadge': 'Gateway rule',
      'dt.gwOverrides': 'Gateway settings are stricter than this display’s own access settings ({what}): {settings}. ' +
        'At runtime the gateway setting decides. See docs/user-guide/gateway-settings.md.',
      'dt.gwWhat.write': 'setpoint',
      'dt.gwWhat.configEdit': 'tag configuration',
      // a GATEWAY setting refused what this display itself allows: name the setting (bubble, tooltip, menu)
      'gw.ctg.write.requireAuthenticated': 'This gateway requires a login for every write (gateway setting ctg.write.requireAuthenticated).',
      'gw.ctg.write.requiredRoles.AUTH_REQUIRED': 'Log in: this gateway lets only users with certain roles write (gateway setting ctg.write.requiredRoles).',
      'gw.ctg.write.requiredRoles': 'This gateway lets only users with certain roles write, and you have none of them (gateway setting ctg.write.requiredRoles).',
      'gw.ctg.configEdit.requiredRoles.AUTH_REQUIRED': 'Log in: this gateway lets only users with certain roles change tag configuration (gateway setting ctg.configEdit.requiredRoles).',
      'gw.ctg.configEdit.requiredRoles': 'This gateway lets only users with certain roles change tag configuration, and you have none of them (gateway setting ctg.configEdit.requiredRoles).',
      'gw.ctg.write.deniedProviders': 'This gateway does not allow changes to tags of this tag provider (gateway setting ctg.write.deniedProviders).',
      'gw.ctg.write.allowedRoots': 'This gateway allows changes only to tags in certain folders, and this tag is outside them (gateway setting ctg.write.allowedRoots).',
      // accessible names
      'aria.value': '{label}, {value}',
      'aria.quality': '{level} quality',
      'aria.alarm': '{priority} priority alarm',
      'aria.alarmUnacked': '{priority} priority alarm, unacknowledged',
      'aria.low': 'below low limit',
      'aria.high': 'above high limit',
      'aria.stale': 'not connected',
      'aria.hintPopup': 'Press Enter to change.',
      'aria.hintProtected': 'Double-click or press Enter to edit.',
      'aria.hintDirect': 'Type a new value and press Enter.',
      'aria.hintMenu': 'Shift+F10 for actions.',
      'aria.menu': 'Actions for {label}',
      // menu
      'menu.noHistory': 'No history available',
      'menu.history.disabled': 'History is not enabled for this tag',
      'menu.history.noProvider': 'No history provider is set for this tag',
      'menu.history.providerMissing': "History provider '{provider}' not found",
      'menu.history.unsupportedType': 'Cannot trend {type} tags',
      'menu.loginToTrend': 'Log in to trend',
      'menu.loginRequired': 'Log in required',
      'menu.notPermitted': 'Not permitted',
      'menu.listFull': 'Trend list full ({max})',
      'menu.cannotTrend': 'Cannot trend {type} tags',
      'menu.designerReadOnly': 'Designer is read-only',
      'menu.notConnected': 'Not connected',
      'menu.loading': 'Loading\u2026',
      'menu.noAudit': 'No audit log is configured',
      'menu.cannotWriteType': 'Cannot write {type} values',
      'menu.notWritable': 'Not writable',
      'guard.writeDenied': "This tag's write permissions do not include you.",
      // bubbles
      'bubble.copied': 'Copied',
      'bubble.copyFailed': 'Could not copy to the clipboard',
      'bubble.saved': 'Saved',
      'bubble.added': 'Added to the trend',
      'bubble.removed': 'Removed from the trend',
      'bubble.invalidPage': 'Invalid page path',
      'bubble.popupFailed': 'Could not open the popup',
      'trend.popupTitle': 'Trend - {label}',
      'bubble.readBack': 'Written, but the tag reads {value}.',
      'bubble.currentChanged': 'Current value changed to {value}',
      'bubble.writeFailed': 'Not written: {message}',
      'bubble.written': 'Written',
      'bubble.badQuality': "The tag's quality is bad, so it can't be changed right now.",
      // setpoint dialog
      'sp.title': 'Set {label}',
      'sp.current': 'Current',
      'sp.new': 'New value',
      'sp.range': 'Allowed range',
      'sp.rangeBetween': '{low} \u2013 {high}',
      'sp.rangeAtLeast': 'at least {low}',
      'sp.rangeAtMost': 'at most {high}',
      'sp.inclusive': '(inclusive)',
      'sp.exclusive': '(limits not included)',
      'sp.maxStep': 'Max change \u00B1{max} per write',
      'sp.write': 'Write',
      'sp.writing': 'Writing\u2026',
      'sp.written': 'Written',
      'sp.notConnected': 'Not connected',
      'sp.targetChanged': 'The tag or permissions changed while this dialog was open. Close and try again.',
      // the inline editor's own wording (no dialog), and a value pushed shortened
      'sp.editTargetChanged': 'The tag changed while you were editing. Nothing was written.',
      'sp.truncated': 'This value is too long to edit here (only its first {max} characters reach the browser).',
      // the editors are single-line inputs, which drop line breaks without a trace
      'sp.multiline': 'This value has line breaks and cannot be edited here.',
      'sp.unsupported': 'Values of this type ({type}) cannot be written here.',
      'sp.choose': 'Choose a value',
      'sp.negate': 'Change sign',
      'sp.decrease': 'Decrease',
      'sp.increase': 'Increase',
      'sp.stepTooLarge': 'Change is larger than allowed (max \u00B1{max}).',
      'sp.stepUnknown': 'Current value unknown \u2014 the step limit (max \u00B1{max}) cannot be checked.',
      'sp.confirmSet': 'Set {label} to {value}?',
      'sp.confirmChange': 'Change {label} from {from} to {to} ({pct})?',
      'sp.confirmTitle': 'Confirm change',
      'sp.unchanged': 'Unchanged',
      'sp.editAgain': 'Change the value to try again.',
      // config dialog
      'cfg.title': 'Tag configuration \u2014 {label}',
      'cfg.notice': "Changes the tag's configuration on the gateway for every user and screen.",
      'cfg.engUnit': 'Engineering units',
      'cfg.engLow': 'Engineering low',
      'cfg.engHigh': 'Engineering high',
      'cfg.was': 'was {value}',
      'cfg.apply': 'Apply',
      'cfg.saving': 'Saving\u2026',
      'cfg.nothing': 'Nothing to save',
      'cfg.lowHigh': 'Engineering Low must be below Engineering High',
      'cfg.unitTooLong': 'At most 64 characters',
      'cfg.unitControl': 'Remove control characters',
      'cfg.udtHint': 'If this tag is part of a UDT, edit the UDT definition instead.',
      // change history dialog
      'hist.title': 'Change history \u2014 {label}',
      'hist.time': 'Time',
      'hist.user': 'User',
      'hist.change': 'Change',
      'hist.result': 'Result',
      'hist.loading': 'Loading the change history\u2026',
      'hist.empty': 'No changes recorded for this tag.',
      'hist.refresh': 'Refresh',
      'hist.write': 'Value',
      'hist.edit': 'Configuration',
      'hist.ok': 'OK',
      'hist.bad': 'Failed',
      'hist.uncertain': 'Unconfirmed',
      'hist.limit': 'Newest {n} entries',
      // display-worded error texts (STEP_TOO_LARGE also covers a step guard with an unknown current value)
      'error.STEP_TOO_LARGE': function (d) {
        var max = d && d.max != null ? d.max : null;
        if (d && (d.delta == null || d.previous === 'notFinite')) {
          return max != null ? 'Current value unknown \u2014 the step limit (max \u00B1' + max + ') cannot be checked. Nothing was written.'
            : 'Current value unknown \u2014 the step limit cannot be checked. Nothing was written.';
        }
        return max != null ? 'Change is larger than allowed (max \u00B1' + max + ').' : 'Change is larger than allowed.';
      },
    });
    function t(key, vars) { return NS.i18n.t(key, vars, PART); }
    /**
     * The text for a refusal that came from a GATEWAY setting ({setting} in the reply details
     * or the capability) while the display's own access rule allows the action. Names the setting so the integrator
     * knows where to look ('' = not a known gateway setting: the caller uses the plain error text).
     */
    function gatewaySettingText(code, setting) {
      if (typeof setting !== 'string' || !/^ctg\.[A-Za-z.]+$/.test(setting)) return '';
      var k = 'gw.' + setting;
      if (code && NS.i18n.has(k + '.' + code, PART)) return t(k + '.' + code);
      return NS.i18n.has(k, PART) ? t(k) : '';
    }
    /** errText of a capability's refusal: {code: reason, details: {setting}} (setting only when a gateway setting refused). */
    function capErr(cap) {
      return { code: cap && cap.reason, details: cap && cap.setting ? { setting: cap.setting } : null };
    }
    /**
     * Operator text of an error. The gateway sends only the generic default message of each code
     * (ErrorCode.defaultMessage), so our table is preferred: it is details-aware ("Must be between 0 and
     * 100.") and localisable. Unknown codes fall back to the gateway text, then to the generic text.
     */
    function errText(err) {
      if (!err) return '';
      var code = err.code || 'INTERNAL';
      var gw = gatewaySettingText(code, err.details && err.details.setting);
      if (gw) return gw;
      if (NS.i18n.has('error.' + code, PART)) return NS.i18n.errorText(code, err.details || {}, PART);
      return err.message || NS.i18n.errorText(code, err.details || {}, PART);
    }

    /* ========================================================================
     * SECTION 2 / Props: defaults, field rules, reducer, v1 detection
     * ----------------------------------------------------------------------
     * DT_DEFAULTS is the object-level default of the schema (checked
     * against the shipped schema by tests/js/dt-reducer.test.mjs).
     * The reducer walks DT_DEFAULTS: every known key is coerced by an explicit
     * rule (DT_RULES: enums, ranges, nullable numbers, colours, array items)
     * or by the type of its default; unknown keys are dropped. It
     * never throws, so a bad binding can never crash render. Each root
     * group is memoised on its raw JSON: the reducer runs on every props-tree
     * change, and 250 displays must stay cheap.
     * ====================================================================== */
    function deepFreeze(o) {
      if (o && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        Object.keys(o).forEach(function (k) { deepFreeze(o[k]); });
      }
      return o;
    }
    var ACCESS_DEFAULT = function (requireLogin) { return { roles: [], securityLevels: [], requireLogin: requireLogin }; };
    var STYLE0 = function () { return { classes: '' }; };
    var DT_DEFAULTS = deepFreeze({
      tagPath: '',
      enabled: true,
      trendGroup: 'default',
      label: { visible: true, text: '', suffix: ':', pathTooltip: true, style: STYLE0() },
      value: { visible: true, format: '', decimals: null, dateFormat: 'YYYY-MM-DD HH:mm:ss', nullText: '\u2014',
        loadingText: '\u2026', maxArrayItems: 10, style: STYLE0() },
      units: { visible: true, text: '', placement: 'value', style: STYLE0() },
      states: { boolean: { trueText: '', falseText: '' }, options: [], useSetpointOptions: true, unmatchedText: '' },
      quality: { indicator: 'icon', markUncertain: true, hideValueOnBad: false, badText: '' },
      bounds: { enabled: false, low: null, high: null, useAlarmLimits: true, lowAlarmName: '', highAlarmName: '',
        useEngLimits: true, inclusive: true, compareDisplayed: false, appearance: 'border', glyphVisible: true,
        applyTo: 'value', lowColor: '', lowTextColor: '', highColor: '', highTextColor: '' },
      alarms: { colorMode: 'auto', basis: 'activeOrUnacked', minPriority: 'Low', indicatorVisible: true, blink: 'indicator',
        appearance: 'background', applyTo: 'value',
        colors: { critical: '', criticalText: '', high: '', highText: '', medium: '', mediumText: '', low: '', lowText: '',
          diagnostic: '', diagnosticText: '' },
        thresholds: [] },
      // no login needed by default (native Perspective write parity; tag write permissions apply)
      setpoint: { enabled: false, access: ACCESS_DEFAULT(false),
        limits: { useEngLimits: true, low: null, high: null, inclusive: true },
        maxStep: null, maxStepPercent: null, options: [], maxStringLength: 255, allowOnBadQuality: false,
        mode: 'popup', confirm: 'discrete', confirmAbovePercent: null, verifyMs: 3000,
        color: '', style: STYLE0(), editIconVisible: false, optionsControl: 'auto',
        spinner: { enabled: false, increment: 1 }, commitOnBlur: false, placeholder: '', whenNotAllowed: 'disable',
        popup: { title: '', position: 'center', tagPathVisible: true, limitsVisible: true, dismissOnBackdrop: true,
          closeOnSuccess: true } },
      menu: { enabled: true, whenNotAllowed: 'disable', headerVisible: true, longPressMs: 550,
        trend: { enabled: true, access: ACCESS_DEFAULT(false), addLabel: 'Trend Tag', removeLabel: 'Remove from Trend' },
        trendPage: { enabled: false, label: 'Go to Trend Page', pagePath: '', newTab: false, addTag: true },
        trendPopup: { enabled: false, label: 'Open Trend Popup', mode: 'trendList', viewPath: '', id: '', title: '',
          params: {}, addTag: true,
          popup: { width: 800, height: 450, position: 'center', modal: false, draggable: true, resizable: true,
            showCloseIcon: true, overlayDismiss: false, viewportBound: true } },
        configEdit: { enabled: false, access: ACCESS_DEFAULT(true), label: 'Tag Configuration\u2026' },
        changeHistory: { enabled: false, access: ACCESS_DEFAULT(true), label: 'Change History\u2026', limit: 20 },
        setValue: { enabled: true, label: 'Set Value\u2026' },
        copyPath: { enabled: false, label: 'Copy Tag Path' },
        items: [] },
      layout: { direction: 'column', evenSplit: false, verticalAlign: 'center', gap: '',
        autoFontSize: { enabled: true, labelScale: 0.12, valueScale: 0.15, min: 8, max: 96 } },
      style: STYLE0(),
    });

    var PRIORITY_ENUM = ['Diagnostic', 'Low', 'Medium', 'High', 'Critical'];
    function enumRule(values) { return { type: 'enum', values: values }; }
    var NULLABLE_NUM = { type: 'number', nullable: true };
    var COLOR = { type: 'color' };
    function strList(v) {
      return Array.isArray(v) ? v.filter(function (x) { return typeof x === 'string'; }) : undefined;
    }
    function accessItem(raw, requireLoginDefault) {
      var a = isPlainObject(raw) ? raw : {};
      return {
        roles: strList(a.roles) || [],
        securityLevels: strList(a.securityLevels) || [],
        requireLogin: typeof a.requireLogin === 'boolean' ? a.requireLogin : requireLoginDefault,
      };
    }
    /** setpoint.options / states.options item: needs a `value` key. */
    function optionItem(withDisabled) {
      return function (it) {
        if (!isPlainObject(it) || !hasOwn.call(it, 'value')) return undefined;
        var label = typeof it.label === 'string' || typeof it.label === 'number' ? it.label : '';
        var o = { value: it.value, label: label };
        if (withDisabled) o.isDisabled = it.isDisabled === true;
        else o.style = isPlainObject(it.style) ? it.style : STYLE0();
        return o;
      };
    }
    function thresholdItem(it) {
      if (!isPlainObject(it)) return undefined;
      var p = PRIORITY_ENUM.indexOf(it.priority) >= 0 ? it.priority : it.priority === undefined ? 'Medium' : null;
      if (!p) return undefined;    // unknown priority: dropped
      return {
        priority: p,
        above: NS.props.coerce(it.above, { type: 'number', nullable: true, default: null }),
        below: NS.props.coerce(it.below, { type: 'number', nullable: true, default: null }),
        inclusive: it.inclusive !== false,
      };
    }
    function menuItem(it) {
      if (!isPlainObject(it) || typeof it.id !== 'string' || !it.id || it.label == null) return undefined;
      return {
        id: it.id, label: String(it.label), enabled: it.enabled !== false, separatorBefore: it.separatorBefore === true,
        access: accessItem(it.access, false),
      };
    }

    /** Explicit rules (everything else is coerced by the type of its default). */
    var DT_RULES = {
      tagPath: { type: 'string', maxLength: 1024 },
      trendGroup: { type: 'string', maxLength: 256 },
      'value.decimals': { type: 'integer', nullable: true, min: 0, max: 15 },
      'value.maxArrayItems': { type: 'integer', min: 1, max: 100 },
      'units.placement': enumRule(['value', 'label']),
      'states.options': { type: 'array', item: optionItem(false) },
      'quality.indicator': enumRule(['icon', 'style', 'none']),
      'bounds.low': NULLABLE_NUM, 'bounds.high': NULLABLE_NUM,
      'bounds.lowAlarmName': { type: 'string', maxLength: 255 }, 'bounds.highAlarmName': { type: 'string', maxLength: 255 },
      'bounds.appearance': enumRule(['border', 'background', 'text']),
      'bounds.applyTo': enumRule(['value', 'component']),
      'bounds.lowColor': COLOR, 'bounds.lowTextColor': COLOR, 'bounds.highColor': COLOR, 'bounds.highTextColor': COLOR,
      'alarms.colorMode': enumRule(['auto', 'live', 'thresholds', 'off']),
      'alarms.basis': enumRule(['active', 'activeOrUnacked']),
      'alarms.minPriority': enumRule(PRIORITY_ENUM),
      'alarms.blink': enumRule(['indicator', 'value', 'off']),
      'alarms.appearance': enumRule(['background', 'text', 'border']),
      'alarms.applyTo': enumRule(['value', 'component']),
      'alarms.thresholds': { type: 'array', item: thresholdItem },
      'setpoint.limits.low': NULLABLE_NUM, 'setpoint.limits.high': NULLABLE_NUM,
      'setpoint.maxStep': NULLABLE_NUM, 'setpoint.maxStepPercent': { type: 'number', nullable: true, max: 100 },
      'setpoint.options': { type: 'array', item: optionItem(true) },
      'setpoint.maxStringLength': { type: 'integer', min: 1, max: 4096 },
      'setpoint.mode': enumRule(['popup', 'direct', 'protected']),
      'setpoint.confirm': enumRule(['never', 'discrete', 'always']),
      'setpoint.confirmAbovePercent': NULLABLE_NUM,
      'setpoint.verifyMs': { type: 'integer', min: 0, max: 60000 },
      'setpoint.color': COLOR,
      'setpoint.optionsControl': enumRule(['auto', 'buttons', 'dropdown']),
      'setpoint.whenNotAllowed': enumRule(['disable', 'hide']),
      'setpoint.popup.position': enumRule(['center', 'anchored']),
      'menu.whenNotAllowed': enumRule(['disable', 'hide']),
      'menu.longPressMs': { type: 'integer', min: 300, max: 2000 },
      'menu.trendPopup.mode': enumRule(['trendList', 'singleTag']),
      'menu.trendPopup.params': { type: 'object' },
      'menu.trendPopup.popup.width': { type: 'number', min: 200 },
      'menu.trendPopup.popup.height': { type: 'number', min: 150 },
      'menu.trendPopup.popup.position': enumRule(['center', 'pointer']),
      'menu.changeHistory.limit': { type: 'integer', min: 1, max: 50 },
      'menu.items': { type: 'array', item: menuItem },
      'layout.direction': enumRule(['column', 'row']),
      'layout.verticalAlign': enumRule(['top', 'center', 'bottom']),
      'layout.autoFontSize.labelScale': { type: 'number', min: 0.02, max: 1 },
      'layout.autoFontSize.valueScale': { type: 'number', min: 0.02, max: 1 },
      'layout.autoFontSize.min': { type: 'number', min: 4 },
      'layout.autoFontSize.max': { type: 'number', min: 8 },
    };
    ['alarms.colors.critical', 'alarms.colors.criticalText', 'alarms.colors.high', 'alarms.colors.highText',
      'alarms.colors.medium', 'alarms.colors.mediumText', 'alarms.colors.low', 'alarms.colors.lowText',
      'alarms.colors.diagnostic', 'alarms.colors.diagnosticText'].forEach(function (p) { DT_RULES[p] = COLOR; });
    // access objects: lists of strings, Boolean requireLogin; the gateway reads them itself (trusted)
    // requireLogin defaults: setpoint false (native write parity); configEdit / changeHistory stay true (they change a tag for every
    // screen / reveal who changed what: more sensitive than a write)
    var ACCESS_PATHS = { 'setpoint.access': false, 'menu.trend.access': false, 'menu.configEdit.access': true,
      'menu.changeHistory.access': true };
    /** Style props: kept as objects; resolved to {className, style} separately (NS.props.style). */
    var STYLE_PATHS = { 'label.style': 1, 'value.style': 1, 'units.style': 1, 'setpoint.style': 1, style: 1 };

    /** Exclusive minimums of the schema (exclusiveMinimum: 0): non-positive means "off" (null) / default. */
    function positiveOr(v, dflt) { return typeof v === 'number' && v > 0 ? v : dflt; }

    function coerceNode(def, raw, path) {
      var rule = DT_RULES[path];
      if (rule) {
        var r = Object.assign({ default: def }, rule);
        var v = NS.props.coerce(raw, r);
        if (rule.type === 'color' && v == null) v = '';
        return v;
      }
      if (hasOwn.call(ACCESS_PATHS, path)) return accessItem(raw, ACCESS_PATHS[path]);
      if (STYLE_PATHS[path]) return isPlainObject(raw) ? raw : def;
      if (isPlainObject(def)) {
        var src = isPlainObject(raw) ? raw : {};
        var out = {};
        for (var k in def) {
          if (hasOwn.call(def, k)) out[k] = coerceNode(def[k], hasOwn.call(src, k) ? src[k] : undefined, path + '.' + k);
        }
        return out;
      }
      if (Array.isArray(def)) return Array.isArray(raw) ? raw.slice() : def.slice();
      if (typeof def === 'boolean') return NS.props.coerce(raw, { type: 'boolean', default: def });
      if (typeof def === 'number') return NS.props.coerce(raw, { type: 'number', default: def });
      if (typeof def === 'string') return NS.props.coerce(raw, { type: 'string', default: def });
      return raw === undefined ? def : raw;
    }

    /** Coerces one root group (pure; exported for the Node tests as NS.dt.coerceGroup). */
    function coerceGroup(key, raw) {
      var out = coerceNode(DT_DEFAULTS[key], raw, key);
      if (key === 'setpoint') {
        out.maxStep = positiveOr(out.maxStep, null);
        out.maxStepPercent = positiveOr(out.maxStepPercent, null);
        out.confirmAbovePercent = positiveOr(out.confirmAbovePercent, null);
        out.spinner.increment = positiveOr(out.spinner.increment, 1);
      }
      if (key === 'layout' && out.autoFontSize.max < out.autoFontSize.min) out.autoFontSize.max = out.autoFontSize.min;
      return out;
    }

    /** Keys whose presence in the raw props marks a v1 view. */
    var V1_KEYS = ['showTagName', 'valuePrecision', 'tagNameLabel', 'showUnits', 'row', 'evenRow', 'tagNameStyle',
      'tagValueStyle', 'showTagValue'];
    var ROOT_GROUPS = ['label', 'value', 'units', 'states', 'quality', 'bounds', 'alarms', 'setpoint', 'menu', 'layout', 'style'];
    var SCALARS = ['tagPath', 'enabled', 'trendGroup'];

    function hasFontSize(st) {
      return isPlainObject(st) && (st.fontSize != null && st.fontSize !== '' || st['font-size'] != null && st['font-size'] !== '');
    }

    /**
     * Reducer factory: one memo per component (getPropsReducer is called with the component's tree).
     * Returns cfg = coerced groups + {styles, tagPathTrimmed, fontOverride, v1Keys}.
     */
    function makeReducer() {
      var memo = {};
      var styleMemo = {};
      var last = null;
      function readRaw(tree, key) {
        try { return tree.read(key); } catch (e) { return undefined; }
      }
      function styleOf(tree, path, raw) {
        var j = JSON.stringify(raw === undefined ? null : raw);
        var m = styleMemo[path];
        if (m && m.json === j) return m.out;
        var viaTree = path.indexOf('#') < 0 && tree && typeof tree.readStyle === 'function';
        // a v1 view keeps a scalar where the v2 group lives (setpoint: true): Perspective's PropertyTree logs a
        // console error for readStyle('setpoint.style') under a non-object node, so only walk into object parents
        var dot = path.lastIndexOf('.');
        if (viaTree && raw === undefined && dot > 0 && !isPlainObject(readRaw(tree, path.slice(0, dot)))) viaTree = false;
        var out = viaTree ? NS.props.style(tree, path) : NS.props.style(raw);
        styleMemo[path] = { json: j, out: out };
        return out;
      }
      return function reduce(tree) {
        var changed = !last;
        var cfg = {};
        SCALARS.forEach(function (k) {
          var raw = readRaw(tree, k);
          var m = memo[k];
          if (m && m.raw === raw) { cfg[k] = m.out; return; }
          var out = coerceNode(DT_DEFAULTS[k], raw, k);
          memo[k] = { raw: raw, out: out };
          cfg[k] = out;
          changed = true;
        });
        var rawGroups = {};
        ROOT_GROUPS.forEach(function (k) {
          var raw = readRaw(tree, k);
          rawGroups[k] = raw;
          var j;
          try { j = JSON.stringify(raw === undefined ? null : raw); } catch (e) { j = String(Math.random()); }
          var m = memo[k];
          if (m && m.json === j) { cfg[k] = m.out; return; }
          var out = coerceGroup(k, raw);
          memo[k] = { json: j, out: out };
          cfg[k] = out;
          changed = true;
        });
        // v1 signature (clean break: detected, never read)
        var v1 = [];
        V1_KEYS.forEach(function (k) { if (readRaw(tree, k) !== undefined) v1.push(k); });
        if (typeof rawGroups.setpoint === 'boolean') v1.push('setpoint');
        var v1Key = v1.join(',');
        // nothing changed (styles derive from the memoised groups): the same object keeps re-renders cheap
        if (!changed && last && last.v1Keys.join(',') === v1Key) return last;
        cfg.trendGroup = NS.util.normTrendGroup(cfg.trendGroup, { kind: 'dt' });
        cfg.tagPathTrimmed = String(cfg.tagPath || '').trim();
        cfg.styles = {
          label: styleOf(tree, 'label.style', rawAt(rawGroups, 'label.style')),
          value: styleOf(tree, 'value.style', rawAt(rawGroups, 'value.style')),
          units: styleOf(tree, 'units.style', rawAt(rawGroups, 'units.style')),
          setpoint: styleOf(tree, 'setpoint.style', rawAt(rawGroups, 'setpoint.style')),
          states: cfg.states.options.map(function (o, i) { return styleOf(tree, 'states#' + i, o.style); }),
        };
        cfg.fontOverride = {
          label: hasFontSize(rawGroups.style) || hasFontSize(rawAt(rawGroups, 'label.style')),
          value: hasFontSize(rawGroups.style) || hasFontSize(rawAt(rawGroups, 'value.style')),
        };
        cfg.v1Keys = v1;
        last = cfg;
        return cfg;
      };
    }
    function rawAt(groups, path) {
      var parts = path.split('.');
      var v = groups[parts[0]];
      for (var i = 1; i < parts.length; i++) v = isPlainObject(v) ? v[parts[i]] : undefined;
      return v;
    }

    /* ========================================================================
     * SECTION 3 / Pure evaluation (NS.dt.*; DOM-free, Node-tested)
     * ----------------------------------------------------------------------
     * Everything the renderer needs is computed here from three inputs:
     *   cfg   the reducer output (SECTION 2)
     *   d     the delegate's mapped state: {snap, stale, staleReason, phase, ...}
     *   env   {locale, timeZone, canInteract, designMode, designer, frameBlocked}
     * resolve() returns a view model (texts, classes, guards, aria label), so
     * the component's render() is a straight translation into elements and
     * every rule below can be unit-tested without a browser.
     * ====================================================================== */
    var STATUS_STATE = {
      noTagPath: 'UNCONFIGURED', invalidPath: 'INVALID_PATH', notFound: 'NOT_FOUND', accessDenied: 'ACCESS_DENIED',
      loading: 'LOADING', ok: 'LIVE',
    };
    var ERROR_STATES = { INVALID_PATH: 'dt.invalidPath', NOT_FOUND: 'dt.notFound', ACCESS_DENIED: 'dt.accessDenied' };
    var PRIORITY_KEYS = ['diagnostic', 'low', 'medium', 'high', 'critical'];

    /** Data state of the display (STALE is an orthogonal flag). */
    function dataState(snap) {
      if (!snap) return 'CONNECTING';
      return STATUS_STATE[snap.status] || 'LOADING';
    }

    /** Value/state options shown for the value: states.options, else setpoint.options labels (useSetpointOptions). */
    function stateOptions(cfg) {
      if (cfg.states.options.length) return cfg.states.options;
      if (cfg.states.useSetpointOptions && cfg.setpoint.options.length) {
        return cfg.setpoint.options.map(function (o) { return { value: o.value, label: o.label === '' ? String(o.value) : o.label }; });
      }
      return [];
    }

    /** Options for NS.format.value. */
    function formatOpts(cfg, snap, env) {
      var v = cfg.value;
      return {
        format: v.format, decimals: v.decimals, dateFormat: v.dateFormat, nullText: v.nullText, loadingText: v.loadingText,
        maxArrayItems: v.maxArrayItems, trueText: cfg.states.boolean.trueText, falseText: cfg.states.boolean.falseText,
        states: stateOptions(cfg), unmatchedText: cfg.states.unmatchedText,
        tagFormat: snap && snap.meta && typeof snap.meta.formatString === 'string' ? snap.meta.formatString : '',
        locale: env && env.locale, timeZone: env && env.timeZone,
      };
    }

    /** The number pattern the value is shown with (also used for limits and confirm texts). */
    function valuePattern(cfg, snap) {
      var o = formatOpts(cfg, snap, null);
      var base = o.format && o.format.trim() ? o.format : o.tagFormat && o.tagFormat.trim() ? o.tagFormat : NS.format.DEFAULT_PATTERN;
      if (o.decimals == null) return base;
      return NS.format.buildFixedPattern(o.decimals, NS.format.patternToIntl(base).options.useGrouping);
    }
    function fmtNum(n, cfg, snap, env) {
      return NS.format.number(n, valuePattern(cfg, snap), env && env.locale);
    }
    /** Fraction digits needed to write x exactly (exponent forms included: 1e-7 -> 7, 2.5e-7 -> 8). */
    function decimalsOf(x) {
      if (typeof x !== 'number' || !isFinite(x)) return 0;
      var s = String(x);
      var m = /e([+-]\d+)$/i.exec(s);
      var base = m ? s.slice(0, m.index) : s;
      var dot = base.indexOf('.');
      var d = dot >= 0 ? base.length - dot - 1 : 0;
      return Math.max(0, d - (m ? Number(m[1]) : 0));
    }
    /**
     * A number on the WRITE path (confirm texts, allowed range, refusals, max step): the display pattern, but with
     * as many fraction digits as the number needs. Rounded with the display pattern, the Confirm would
     * name a value other than the one written ("Set to 72.4?" writing 72.36, "Set to 73?" for 72.6) and a refusal
     * would state a limit the operator cannot enter ("max ±0.3" for 0.25). Scientific / percent patterns stay as they
     * are; a Float4 uses its shortest single-precision text.
     */
    function fmtExact(n, cfg, snap, env) {
      var x = Number(n);
      if (!isFinite(x)) return fmtNum(n, cfg, snap, env);
      var pat = valuePattern(cfg, snap);
      var spec = NS.format.patternToIntl(pat);
      if (spec.options.notation || (spec.multiplier && spec.multiplier !== 1)) return fmtNum(n, cfg, snap, env);
      var need = Math.min(15, decimalsOf(isFloat4(snap) ? Number(shortNum(x, true)) : Number(x.toPrecision(15))));
      if (need <= (spec.options.maximumFractionDigits || 0)) return fmtNum(n, cfg, snap, env);
      return NS.format.number(x, NS.format.buildFixedPattern(need, spec.options.useGrouping), env && env.locale);
    }

    /** x rounded the way the pattern displays it (bounds.compareDisplayed, read-back tolerance). */
    function displayedNumber(x, pattern) {
      var spec = NS.format.patternToIntl(pattern);
      if (spec.options.notation || !isFinite(x)) return x;
      var d = spec.options.maximumFractionDigits;
      var m = spec.multiplier || 1;
      var f = Math.pow(10, d);
      return Math.round(x * m * f) / f / m;
    }
    /** Half a unit of the last displayed digit (read-back check). */
    function displayTolerance(x, pattern) {
      var spec = NS.format.patternToIntl(pattern);
      var rel = Math.abs(x) * 1e-6;   // Float4 tags round-trip with ~7 significant digits
      if (spec.options.notation) return Math.max(rel, Math.abs(x) * Math.pow(10, -spec.options.maximumFractionDigits) / 2);
      return Math.max(rel, 0.5 * Math.pow(10, -spec.options.maximumFractionDigits) / (spec.multiplier || 1));
    }

    function finite(x) { return typeof x === 'number' && isFinite(x) ? x : null; }

    /**
     * Bounds: each side = override → setpoint of the named tag alarm → EngLow/High.
     * Returns {state:'low'|'high'|null, low, high}; null when bounds are off or the value is not a number.
     */
    function evalBounds(cfg, snap, valueRes, pattern) {
      var b = cfg.bounds;
      if (!b.enabled || !snap || !valueRes || valueRes.kind !== 'number') return null;
      var x = finite(valueRes.numeric);
      if (x == null) return null;
      if (b.compareDisplayed && pattern) x = displayedNumber(x, pattern);
      var lim = snap.alarms && snap.alarms.limits ? snap.alarms.limits : {};
      var meta = snap.meta || {};
      function side(override, name, alarmLimit, eng) {
        if (finite(override) != null) return override;
        if (b.useAlarmLimits && name && alarmLimit && finite(alarmLimit.value) != null) return alarmLimit.value;
        if (b.useEngLimits && finite(eng) != null) return eng;
        return null;
      }
      var low = side(b.low, b.lowAlarmName, lim.low, meta.engLow);
      var high = side(b.high, b.highAlarmName, lim.high, meta.engHigh);
      if (low != null && high != null && low > high) return { state: null, low: low, high: high, invalid: true };
      var state = null;
      if (low != null && (b.inclusive ? x < low : x <= low)) state = 'low';
      else if (high != null && (b.inclusive ? x > high : x >= high)) state = 'high';
      return { state: state, low: low, high: high };
    }

    /**
     * Alarm colour: live priority when the gateway subscribed the tag's
     * alarm state (alarms.live), else the manual thresholds; filtered by minPriority.
     * Returns {priority 0..4, name, key, unacked, source:'live'|'thresholds'} or null.
     */
    function evalAlarm(cfg, snap, valueRes) {
      var a = cfg.alarms;
      if (a.colorMode === 'off' || !snap) return null;
      var al = snap.alarms;
      var liveAvailable = (a.colorMode === 'auto' || a.colorMode === 'live') && !!al &&
        (al.live === true || (al.live === undefined && al.hasActive != null));
      var min = NS.alarm.priority(a.minPriority);
      if (min == null) min = 1;
      var res = null;
      if (liveAvailable) {
        var active = NS.alarm.priority(al.highestActivePriority);
        var unackedP = NS.alarm.priority(al.highestUnackedPriority);
        // minPriority applies to each candidate BEFORE the higher one is picked. With basis
        // 'activeOrUnacked' the colour is the higher of the active and the unacknowledged priority, and the display
        // blinks while any unacknowledged alarm at or above minPriority remains. Filtering after the pick would let an
        // active Low alarm hide an unacknowledged High one (Low colour, no blink), and an active Diagnostic one an
        // unacknowledged Critical one (no indication at all, since minPriority then drops Diagnostic).
        var act = active != null && active >= min ? active : null;
        var un = al.hasUnacked && unackedP != null && unackedP >= min ? unackedP : null;
        var p;
        var unacked;
        if (a.basis === 'active') {
          // the snapshot carries only the highest active and the highest unacknowledged priority
          // (unacknowledged covers cleared alarms too), so whether the ACTIVE alarm is acknowledged cannot be told:
          // a guess such as un === p would blink for an acknowledged alarm next to a cleared-unacked one of the same
          // priority, and miss an unacknowledged active one below a cleared-unacked higher one. 'active' colours
          // by the active alarm and never blinks; 'activeOrUnacked' (default) blinks while anything is unacknowledged.
          p = act;
          unacked = false;
        } else {
          p = act == null ? un : un == null ? act : Math.max(act, un);
          unacked = un != null;
        }
        if (p != null) res = { priority: p, unacked: unacked, source: 'live' };
      } else if (a.colorMode === 'auto' || a.colorMode === 'thresholds') {
        var x = valueRes && (valueRes.kind === 'number' || valueRes.kind === 'state' || valueRes.kind === 'boolean')
          ? finite(valueRes.numeric) : null;
        if (x != null) {
          var best = null;
          a.thresholds.forEach(function (th) {
            var tp = NS.alarm.priority(th.priority);
            if (tp == null) return;
            var hit = (th.above != null && (th.inclusive ? x >= th.above : x > th.above)) ||
              (th.below != null && (th.inclusive ? x <= th.below : x < th.below));
            if (hit && (best == null || tp > best)) best = tp;   // ties: the first one wins
          });
          if (best != null) res = { priority: best, unacked: false, source: 'thresholds' };
        }
      }
      if (!res || res.priority < min) return null;
      res.name = NS.alarm.PRIORITIES[res.priority];
      res.key = PRIORITY_KEYS[res.priority];
      return res;
    }

    /** What kind of control a write needs: 'options' | 'boolean' | 'int' | 'float' | 'string' | 'unsupported'. */
    function writeKind(cfg, snap) {
      if (cfg.setpoint.options.length) return 'options';
      var dt = snap && snap.meta ? snap.meta.dataType : null;
      if (dt == null && snap && snap.value) dt = snap.value.type;
      return NS.format.dataTypeFamily(dt);
    }

    function staleText(reason) {
      if (reason === 'watchdog' || reason === 'noResponse') return NS.i18n.t('conn.noResponse');
      if (reason === 'silent') return t('dt.silent');   // own text: not the watchdog's
      if (reason === 'reload') return NS.i18n.t('reload.mustToast');
      return NS.i18n.t('conn.stale');
    }

    /**
     * Edit guard: may this user start a write now, and if not, why?
     * {show (writable affordance visible), allowed, code, text, kind}. Advisory: the gateway decides.
     */
    /**
     * Design-mode preview: refusal codes that depend on the viewer (the Designer user and its
     * communication mode) or on a reply that has not arrived yet. They do not change how the display LOOKS in design
     * mode; data and configuration problems (no tag, bad quality, stale, unsupported type…) still show as at runtime.
     */
    var PREVIEW_AS_ALLOWED = { LOADING: 1, DESIGNER_READ_ONLY: 1, AUTH_REQUIRED: 1, FORBIDDEN_ROLE: 1, WRITE_DENIED: 1 };
    function writeGuard(cfg, d, env) {
      var snap = d && d.snap;
      var e = env || {};
      var sp = cfg.setpoint;
      var kind = writeKind(cfg, snap);
      var g = { show: false, allowed: false, code: null, text: '', kind: kind, preview: false };
      if (!sp.enabled || !cfg.enabled) return g;
      var state = dataState(snap);
      var caps = snap && snap.capabilities && snap.capabilities.write;
      var q = snap && snap.value ? NS.quality.level(snap.value.q) : 'good';
      var code = null;
      if (d && d.stale) code = 'STALE';
      else if (e.frameBlocked) code = 'FRAME';
      else if (state === 'CONNECTING' || state === 'LOADING') code = 'LOADING';
      else if (state === 'UNCONFIGURED') code = 'NO_TAG_PATH';
      else if (state === 'INVALID_PATH') code = 'INVALID_PATH';
      else if (state === 'NOT_FOUND') code = 'TAG_NOT_FOUND';
      else if (state === 'ACCESS_DENIED') code = 'ACCESS_DENIED';
      else if (kind === 'unsupported') code = 'UNSUPPORTED_TYPE';
      else if (!caps) code = 'LOADING';
      else if (!caps.allowed) code = caps.reason || 'LOADING';
      else if ((q === 'bad' || q === 'error') && !sp.allowOnBadQuality) code = 'BAD_QUALITY';
      // a String the gateway pushed shortened (ValueCodec MAX_STRING) must never seed an editor: a
      // partial edit would write the shortened text back and silently drop the rest of the value
      else if (kind === 'string' && snap && snap.value && snap.value.truncated) code = 'VALUE_TRUNCATED';
      // a String with CR / LF cannot be edited in the single-line editors (the browser strips the line
      // breaks from an <input>, so appending one character would rewrite "line1 LF line2" as "line1line2X")
      else if (kind === 'string' && snap && snap.value && typeof snap.value.v === 'string' && /[\r\n]/.test(snap.value.v)) code = 'VALUE_MULTILINE';
      // Designer preview parity: in the Designer's design mode (no interaction) the display looks like it
      // does for an operator at runtime: the setpoint colour, setpoint style, edit icon and direct-mode field show from
      // the props alone. Reasons that depend on WHO is looking or on data that has not arrived yet (the Designer user,
      // its read-only communication mode, a capability reply still on its way) do not grey it out. Nothing is
      // interactive in design mode (canInteract false gates every handler); preview mode follows the runtime rules.
      if (e.canInteract === false) {
        g.preview = true;
        if (code !== null && PREVIEW_AS_ALLOWED[code]) code = null;
      }
      g.code = code;
      g.allowed = code === null;
      g.show = g.allowed || sp.whenNotAllowed !== 'hide';
      if (code === 'STALE') g.text = staleText(d.staleReason);
      else if (code === 'FRAME') g.text = NS.i18n.t('frame.blocked');
      else if (code === 'LOADING') g.text = t('menu.loading');
      else if (code === 'UNSUPPORTED_TYPE') g.text = t('menu.cannotWriteType', { type: (snap && snap.meta && snap.meta.dataType) || '?' });
      // advisory capability WRITE_DENIED = the tag's own Write Permissions exclude this user (.CanWrite false):
      // phrased as a rule, not as the outcome of an attempt ("The tag provider denied the change.")
      else if (code === 'WRITE_DENIED') g.text = t('guard.writeDenied');
      else if (code === 'VALUE_TRUNCATED') g.text = t('sp.truncated', { max: snap && snap.value && typeof snap.value.v === 'string' ? snap.value.v.length : 4096 });
      else if (code === 'VALUE_MULTILINE') g.text = t('sp.multiline');
      else if (code && caps && !caps.allowed && code === caps.reason) g.text = errText(capErr(caps));   // names a gateway setting
      else if (code) g.text = errText({ code: code });
      return g;
    }

    /**
     * Setpoint dialog: why Write is off right now ('' = it is not). "The tag or permissions changed…" only when
     * the dialog's own target is gone (other tag, setpoint/component disabled); an advisory capability that turns
     * off (BAD_QUALITY dip, LIMITS_UNAVAILABLE, WRITE_DENIED, FORBIDDEN_*…) shows its own reason, because several
     * of them clear by themselves and Write comes back without closing the dialog.
     */
    function dialogBlock(cfg, d, env, tagPath) {
      var snap = d && d.snap;
      if (!snap || snap.tagPath !== tagPath || !cfg.enabled || !cfg.setpoint.enabled) return t('sp.targetChanged');
      if (d.stale) return t('sp.notConnected');
      var g = writeGuard(cfg, d, env);
      if (g.allowed) return '';
      return g.code ? g.text || errText({ code: g.code }) : t('sp.targetChanged');
    }
    /**
     * Request-id reuse after a failed write: only after CLIENT_TIMEOUT, where the
     * gateway's real outcome may still be pending (or already cached), so pressing Write again for the same value
     * attaches to / receives that original reply instead of writing twice. After any reply FROM THE GATEWAY the id
     * is dropped, including a gateway TIMEOUT: the gateway's idempotency cache stores that reply too and would
     * answer every retry with the same TIMEOUT, so nothing would ever be written. A reflex
     * double submit after a timeout is still blocked by mustEdit (the value has to be edited first).
     */
    function keepsRequestId(code) { return code === 'CLIENT_TIMEOUT'; }
    /** Keys that move the selection of a closed native select (they browse). */
    var SELECT_NAV_KEYS = { ArrowUp: true, ArrowDown: true, Up: true, Down: true, Home: true, End: true, PageUp: true,
      PageDown: true, ArrowLeft: true, ArrowRight: true };
    /** A write reply whose outcome is unknown (the value may or may not have been written). */
    function outcomeUnknown(code) { return code === 'CLIENT_TIMEOUT' || code === 'TIMEOUT'; }
    /**
     * Codes that prove the gateway's write handler never saw the attempt, so the attempt changed nothing about any
     * earlier request id: DISCONNECTED / DETACHED (nothing was sent), RATE_LIMITED and MODULE_STOPPING (refused by the
     * delegate before the request id is claimed in its idempotency map; CtgDelegateBase.handleEvent/dispatch).
     */
    var NOT_PROCESSED = { DISCONNECTED: true, DETACHED: true, RATE_LIMITED: true, MODULE_STOPPING: true };
    /**
     * The id the dialog remembers after a write attempt. 'prev' = remembered before the
     * attempt ({key, id} | null), 'attempt' = what this attempt sent ({key, id} | null when nothing went out),
     * 'code' = the error code (undefined on success).
     *  - success, or any reply the gateway's write handler produced (TIMEOUT included) → null: a retry is a new write;
     *  - CLIENT_TIMEOUT → the attempt's id: its outcome is unknown, a same-value retry must attach to it;
     *  - NOT_PROCESSED → prev, unchanged. Dropping the unknown id when a retry after CLIENT_TIMEOUT is refused this
     *    way (rate limit, socket down, module restarting) would let the NEXT press write a second time while the
     *    first write may already have landed.
     */
    function requestMemoAfter(prev, attempt, code) {
      if (!code) return null;
      if (keepsRequestId(code)) return attempt || prev || null;
      if (NOT_PROCESSED[code] === true) return prev || null;
      return null;
    }

    /** Effective limits for the step / confirm rules: snap.writeLimits {low, high, inclusive} or null. */
    function writeLimits(snap) {
      var wl = snap && snap.writeLimits;
      return wl && typeof wl === 'object' ? { low: finite(wl.low), high: finite(wl.high), inclusive: wl.inclusive !== false } : null;
    }
    function currentNumber(snap) {
      var v = snap && snap.value;
      if (!v) return null;
      if (v.bigint && typeof v.v === 'string') return Number(v.v);
      return finite(v.v);
    }

    /** Effective largest change per write: min(maxStep, maxStepPercent of the write range); null = no guard. */
    function maxStepOf(cfg, snap) {
      var sp = cfg.setpoint;
      var max = Infinity;
      if (sp.maxStep != null) max = Math.min(max, sp.maxStep);
      var wl = writeLimits(snap);
      if (sp.maxStepPercent != null && wl && wl.low != null && wl.high != null && wl.high > wl.low) {
        max = Math.min(max, sp.maxStepPercent / 100 * (wl.high - wl.low));
      }
      return max === Infinity ? null : max;
    }

    /**
     * Client mirror of the gateway step guard. Advisory.
     * {ok:true} | {ok:false, max, delta} | {ok:false, max, unknown:true}.
     */
    function stepCheck(cfg, snap, next) {
      var max = maxStepOf(cfg, snap);
      if (max == null) return { ok: true };
      var cur = currentNumber(snap);
      var n = typeof next === 'string' ? Number(next) : next;
      if (cur == null || !isFinite(n)) return { ok: false, max: max, unknown: true };
      var delta = Math.abs(n - cur);
      return delta > max ? { ok: false, max: max, delta: delta } : { ok: true };
    }

    /** confirmAbovePercent (UI only): {pct, from, to} when the change needs a confirmation, else null. */
    function bigChange(cfg, snap, next) {
      var lim = cfg.setpoint.confirmAbovePercent;
      var wl = writeLimits(snap);
      var cur = currentNumber(snap);
      var n = typeof next === 'string' ? Number(next) : next;
      if (lim == null || !wl || wl.low == null || wl.high == null || wl.high <= wl.low || cur == null || !isFinite(n)) return null;
      var pct = (n - cur) / (wl.high - wl.low) * 100;
      return Math.abs(pct) > lim ? { pct: pct, from: cur, to: n } : null;
    }

    /** "+100 %" / "−12.5 %" (sign always shown). */
    function pctText(p, locale) {
      var s = NS.format.number(Math.abs(p), '0.#', locale);
      return (p < 0 ? '\u2212' : '+') + s + '\u00A0%';
    }

    /** Text of the allowed range for the dialog ("0 – 100 degF (inclusive)"), or '' when unbounded. */
    function rangeText(cfg, snap, env, units) {
      var wl = writeLimits(snap);
      if (!wl || (wl.low == null && wl.high == null)) return '';
      var f = function (n) { return fmtExact(n, cfg, snap, env) + (units ? '\u00A0' + units : ''); };
      var core = wl.low != null && wl.high != null ? t('sp.rangeBetween', { low: f(wl.low), high: f(wl.high) })
        : wl.low != null ? t('sp.rangeAtLeast', { low: f(wl.low) }) : t('sp.rangeAtMost', { high: f(wl.high) });
      return core + ' ' + t(wl.inclusive ? 'sp.inclusive' : 'sp.exclusive');
    }

    /** Units shown for this value: override, else the tag's EngUnit; '' when none. */
    function unitsText(cfg, snap) {
      if (cfg.units.text) return cfg.units.text;
      var u = snap && snap.meta && snap.meta.engUnit;
      return typeof u === 'string' ? u : '';
    }

    /** Flattens Perspective's securityLevels tree into "Authenticated/Roles/Operator" paths. */
    function levelPaths(levels, prefix, out) {
      (Array.isArray(levels) ? levels : []).forEach(function (l) {
        if (!l || typeof l.name !== 'string') return;
        var p = prefix ? prefix + '/' + l.name : l.name;
        out.push(p);
        levelPaths(l.children, p, out);
      });
      return out;
    }
    /** Advisory access check for custom menu items (client-only, F-05b). Returns null or a reason code. */
    function accessDenied(access, user) {
      if (!access) return null;
      var u = user || { authenticated: false, roles: [], levels: [] };
      if (access.requireLogin && !u.authenticated) return 'AUTH_REQUIRED';
      if (access.roles.length && !access.roles.some(function (r) { return u.roles.indexOf(r) >= 0; })) {
        return u.authenticated ? 'FORBIDDEN_ROLE' : 'AUTH_REQUIRED';
      }
      if (access.securityLevels.length && !access.securityLevels.some(function (l) { return u.levels.indexOf(l) >= 0; })) {
        return u.authenticated ? 'FORBIDDEN_ROLE' : 'AUTH_REQUIRED';
      }
      return null;
    }

    function historyHint(snap) {
      var hs = snap && snap.history;
      var reason = hs && hs.reason;
      var type = (snap && snap.meta && snap.meta.dataType) || '?';
      if (reason === 'disabled') return t('menu.history.disabled');
      if (reason === 'noProvider') return t('menu.history.noProvider');
      if (reason === 'providerMissing') return t('menu.history.providerMissing', { provider: hs.provider || '?' });
      if (reason === 'unsupportedType') return t('menu.history.unsupportedType', { type: type });
      return '';
    }

    /**
     * The menu model: header + items [{id, kind, label, hint, disabled,
     * separatorBefore, data}]. Opens instantly from cached pushes (capabilities, trend, history).
     * ctx = {stale, staleReason, frameBlocked, guard (writeGuard result), user, busy:{id:true}}.
     */
    function menuModel(cfg, snap, ctx) {
      var c = ctx || {};
      var m = cfg.menu;
      var caps = (snap && snap.capabilities) || {};
      var loaded = !!(snap && snap.capabilities);
      var groups = [];
      /** Common reason of every item that needs the gateway: "Not connected" first, then "Loading…". */
      function gw() {
        if (c.stale) return { hint: t('menu.notConnected') };
        if (!loaded) return { hint: t('menu.loading') };
        return null;
      }
      var label = cfg.label.text || (snap && snap.tagName) || NS.util.shortTagName(cfg.tagPathTrimmed);

      // -- trend group ----------------------------------------------------------------------------------
      var tg = [];
      if (m.trend.enabled) {
        var tr = snap && snap.trend ? snap.trend : null;
        var trending = !!(tr && tr.trending);
        var it = { id: 'trend', kind: 'trend', label: trending ? m.trend.removeLabel : m.trend.addLabel, data: { remove: trending } };
        var g = gw();
        if (g) { it.disabled = true; it.hint = g.hint; }
        else {
          var cap = caps.trend || {};
          var code = cap.allowed ? null : (cap.reason || 'LOADING');
          if (!code && !trending && tr && tr.max != null && tr.count >= tr.max) code = 'TREND_LIST_FULL';
          if (code) {
            it.disabled = true;
            if (code === 'NO_HISTORY') { it.label = t('menu.noHistory'); it.hint = historyHint(snap); }
            else if (code === 'AUTH_REQUIRED') it.hint = t('menu.loginToTrend');
            else if (code === 'FORBIDDEN_ROLE') it.hint = t('menu.notPermitted');
            else if (code === 'TREND_LIST_FULL') it.hint = t('menu.listFull', { max: tr ? tr.max : '?' });
            else if (code === 'UNSUPPORTED_TYPE') it.hint = t('menu.cannotTrend', { type: (snap.meta && snap.meta.dataType) || '?' });
            else if (code === 'LOADING') it.hint = t('menu.loading');
            else it.hint = errText({ code: code });
            it.code = code;
          }
        }
        tg.push(it);
      }
      if (m.trendPage.enabled) tg.push({ id: 'trendPage', kind: 'trendPage', label: m.trendPage.label });
      if (m.trendPopup.enabled) tg.push({ id: 'trendPopup', kind: 'trendPopup', label: m.trendPopup.label });
      groups.push(tg);

      // -- edit group -------------------------------------------------------------------------------------
      var eg = [];
      if (cfg.setpoint.enabled && m.setValue.enabled) {
        var guard = c.guard || { allowed: false, text: '' };
        eg.push({ id: 'setValue', kind: 'setValue', label: m.setValue.label, disabled: !guard.allowed,
          hint: guard.allowed ? '' : guard.text, code: guard.code });
      }
      if (m.configEdit.enabled) {
        var ci = { id: 'configEdit', kind: 'configEdit', label: m.configEdit.label };
        var gc = gw();
        if (gc) { ci.disabled = true; ci.hint = gc.hint; }
        else if (c.frameBlocked) { ci.disabled = true; ci.hint = NS.i18n.t('frame.blocked'); }
        else if (!caps.configEdit || !caps.configEdit.allowed) {
          var cc = caps.configEdit && caps.configEdit.reason;
          ci.disabled = true; ci.code = cc || 'LOADING';
          ci.hint = gatewaySettingText(cc, caps.configEdit && caps.configEdit.setting) || (cc === 'AUTH_REQUIRED' ? t('menu.loginRequired') : cc === 'FORBIDDEN_ROLE' ? t('menu.notPermitted')
            : cc === 'DESIGNER_READ_ONLY' ? t('menu.designerReadOnly') : cc ? errText({ code: cc }) : t('menu.loading'));
        }
        eg.push(ci);
      }
      if (m.changeHistory.enabled) {
        var hi = { id: 'changeHistory', kind: 'changeHistory', label: m.changeHistory.label };
        var gh = gw();
        if (gh) { hi.disabled = true; hi.hint = gh.hint; }
        else if (c.frameBlocked) { hi.disabled = true; hi.hint = NS.i18n.t('frame.blocked'); }
        else if (!caps.changeHistory || !caps.changeHistory.allowed) {
          var hc = caps.changeHistory && caps.changeHistory.reason;
          hi.disabled = true; hi.code = hc || 'LOADING';
          hi.hint = hc === 'AUTH_REQUIRED' ? t('menu.loginRequired') : hc === 'FORBIDDEN_ROLE' ? t('menu.notPermitted')
            : hc === 'AUDIT_UNAVAILABLE' ? t('menu.noAudit') : hc ? errText({ code: hc }) : t('menu.loading');
        }
        eg.push(hi);
      }
      groups.push(eg);

      // -- copy + custom ----------------------------------------------------------------------------------
      if (m.copyPath.enabled) groups.push([{ id: 'copyPath', kind: 'copyPath', label: m.copyPath.label }]);
      var cg = [];
      m.items.forEach(function (ci2) {
        var it2 = { id: 'custom:' + ci2.id, kind: 'custom', label: ci2.label, data: { action: ci2.id },
          separatorBefore: ci2.separatorBefore };
        if (!ci2.enabled) it2.disabled = true;
        var deny = accessDenied(ci2.access, c.user);
        if (deny) { it2.disabled = true; it2.hint = deny === 'AUTH_REQUIRED' ? t('menu.loginRequired') : t('menu.notPermitted'); }
        cg.push(it2);
      });
      groups.push(cg);

      var items = [];
      groups.forEach(function (grp) {
        var visible = grp.filter(function (it3) { return !(it3.disabled && m.whenNotAllowed === 'hide'); });
        visible.forEach(function (it3, i) {
          if (i === 0 && items.length) it3.separatorBefore = true;
          if (c.busy && c.busy[it3.id]) { it3.busy = true; }
          items.push(it3);
        });
      });
      return {
        header: m.headerVisible ? { title: label, subtitle: (snap && snap.tagPath) || cfg.tagPathTrimmed } : null,
        ariaLabel: t('aria.menu', { label: label }),
        items: items,
      };
    }

    /**
     * The view model of one render. Pure.
     */
    function resolve(cfg, d, env) {
      var e = env || {};
      var snap = d ? d.snap : null;
      var state = dataState(snap);
      var stale = !!(d && d.stale);
      var vm = {
        state: state, stale: stale, staleReason: d ? d.staleReason || null : null, staleText: stale ? staleText(d.staleReason) : '',
        tagPath: (snap && snap.tagPath) || cfg.tagPathTrimmed,
        tagName: (snap && snap.tagName) || NS.util.shortTagName(cfg.tagPathTrimmed),
        qLevel: 'good', qName: '', qualityMark: null, kind: 'loading', numeric: null, bounds: null, alarm: null,
        rootClasses: [], valueTitle: '', labelTitle: '', valueText: '', unitsText: '', unitsPlacement: cfg.units.placement,
        stateStyle: null,
      };
      vm.labelText = cfg.label.text || vm.tagName || (state === 'UNCONFIGURED' ? t('dt.unconfigured') : '');
      var classes = ['dt-root', 'simple-tag-display-component', cfg.layout.direction === 'row' ? 'dt--row' : 'dt--column',
        'dt--valign-' + cfg.layout.verticalAlign];
      if (cfg.layout.evenSplit) classes.push('dt--even');
      if (e.designMode) classes.push('dt--design');
      if (!cfg.enabled) classes.push('dt--disabled');

      var pattern = valuePattern(cfg, snap);
      if ((state === 'CONNECTING' || state === 'LOADING') && e.designMode && cfg.tagPathTrimmed) {
        // design mode shows a representative value until the gateway's first one arrives, so the
        // configured format, colours and font sizes can be judged at once (never at runtime / in preview mode)
        var so = stateOptions(cfg);
        vm.valueText = so.length ? so[0].label : NS.format.number(123.4, pattern, e.locale);
        vm.valueTitle = t('dt.placeholder.title');
        vm.placeholder = true;
        classes.push('dt--placeholder');
      } else if (state === 'CONNECTING' || state === 'LOADING') {
        vm.valueText = cfg.value.loadingText;
        classes.push('dt--loading');
      } else if (state === 'UNCONFIGURED') {
        vm.valueText = e.designer ? t('dt.unconfiguredDesigner') : t('dt.unconfigured');
        classes.push('dt--unconfigured');
      } else if (ERROR_STATES[state]) {
        vm.valueText = t(ERROR_STATES[state]);
        vm.valueTitle = t(ERROR_STATES[state] + '.title', { tagPath: vm.tagPath });
        classes.push('dt--error');
      } else {
        var res = NS.format.value(snap.value, formatOpts(cfg, snap, e));
        vm.kind = res.kind;
        vm.numeric = res.numeric;
        vm.valueText = res.text;
        vm.approximate = res.approximate;
        if (res.kind === 'state' && res.state) {
          var si = cfg.states.options.indexOf(res.state);
          vm.stateStyle = si >= 0 ? si : null;
        }
        var q = snap.value ? snap.value.q : null;
        vm.qLevel = NS.quality.level(q);
        vm.qName = NS.quality.label(q);
        if (vm.qLevel === 'bad' || vm.qLevel === 'error') vm.qualityMark = 'bad';
        else if (vm.qLevel === 'uncertain' && cfg.quality.markUncertain) vm.qualityMark = 'uncertain';
        if (cfg.quality.indicator === 'none') vm.qualityMark = null;
        classes.push('dt--q-' + (vm.qLevel === 'error' ? 'bad' : vm.qLevel));
        if (vm.qualityMark) classes.push('dt--qmark-' + vm.qualityMark);
        if (res.kind === 'nonFinite') classes.push('dt--nonfinite');
        if ((vm.qLevel === 'bad' || vm.qLevel === 'error') && cfg.quality.hideValueOnBad) {
          vm.valueText = cfg.quality.badText || t('dt.badQuality');
          vm.kind = 'hidden';
        }
        if (snap.value && snap.value.truncated) vm.valueTitle = res.text;
        if (vm.kind === 'number' && cfg.units.visible) vm.unitsText = unitsText(cfg, snap);
        // a value hidden by quality.hideValueOnBad is untrusted, so nothing is derived from it either —
        // no bounds glyph/colour and no threshold alarm colour (the live alarm state from the gateway still shows).
        var hidden = vm.kind === 'hidden';
        vm.bounds = hidden ? null : evalBounds(cfg, snap, res, pattern);
        vm.alarm = evalAlarm(cfg, snap, hidden ? null : res);
      }
      if (vm.bounds && vm.bounds.state) {
        classes.push('dt--' + vm.bounds.state, 'dt--bounds-' + (cfg.bounds.appearance === 'background' ? 'bg' : cfg.bounds.appearance));
        if (cfg.bounds.applyTo === 'component') classes.push('dt--bounds-on-root');
        if (cfg.bounds.glyphVisible) classes.push('dt--bounds-glyph');
      }
      if (vm.alarm) {
        classes.push('dt--alarm', 'dt--alarm-' + vm.alarm.key,
          'dt--alarm-' + (cfg.alarms.appearance === 'background' ? 'bg' : cfg.alarms.appearance));
        if (cfg.alarms.applyTo === 'component') classes.push('dt--alarm-on-root');
        if (vm.alarm.unacked) {
          classes.push('dt--alarm-unacked');
          // 'indicator' blinks the marker only (or the outline when the marker is hidden): the value stays readable
          if (cfg.alarms.blink === 'value') classes.push('dt--blink-value');
          else if (cfg.alarms.blink === 'indicator') classes.push(cfg.alarms.indicatorVisible ? 'dt--blink-indicator' : 'dt--blink-outline');
        }
      }
      if (stale) classes.push('dt--stale');
      vm.guard = writeGuard(cfg, d, e);
      if (vm.guard.show) classes.push(vm.guard.allowed ? 'dt--setpoint' : 'dt--setpoint-denied');
      if (snap && snap.trend && snap.trend.trending) classes.push('dt--trending');
      vm.menuEnabled = cfg.enabled && cfg.menu.enabled && e.canInteract !== false;
      if (vm.menuEnabled) classes.push('dt--has-menu');
      vm.rootClasses = classes;

      // label (units in the label: "Temp (degF)"; suffix only in row layout)
      var lt = vm.labelText;
      if (vm.unitsText && cfg.units.placement === 'label') lt += ' (' + vm.unitsText + ')';
      if (cfg.layout.direction === 'row' && cfg.label.suffix && lt) lt += cfg.label.suffix;
      vm.labelDisplay = lt;
      if (cfg.label.pathTooltip && vm.tagPath) vm.labelTitle = vm.tagPath;
      // placement 'label' with a hidden label would drop the units from the screen: they go to the value then
      vm.unitsInValue = !!vm.unitsText && (cfg.units.placement === 'value' || !cfg.label.visible);

      // accessible name: no aria-live on values; this is read on focus
      var parts = [t('aria.value', { label: vm.labelText || vm.tagName || '', value: vm.valueText + (vm.unitsText ? ' ' + vm.unitsText : '') })];
      if (vm.qualityMark) {
        var qText = t('aria.quality', { level: vm.qLevel === 'error' ? 'Bad' : vm.qLevel.charAt(0).toUpperCase() + vm.qLevel.slice(1) });
        if (!(vm.kind === 'hidden' && vm.valueText === qText)) parts.push(qText);   // not twice ("Bad quality, Bad quality")
      }
      if (vm.alarm) parts.push(t(vm.alarm.unacked ? 'aria.alarmUnacked' : 'aria.alarm', { priority: vm.alarm.name }));
      if (vm.bounds && vm.bounds.state) parts.push(t('aria.' + vm.bounds.state));
      if (stale) parts.push(t('aria.stale'));
      if (vm.guard.show && vm.guard.allowed) {
        parts.push(t(cfg.setpoint.mode === 'protected' ? 'aria.hintProtected' : cfg.setpoint.mode === 'direct' ? 'aria.hintDirect' : 'aria.hintPopup'));
      }
      if (vm.menuEnabled) parts.push(t('aria.hintMenu'));
      vm.ariaLabel = parts.join(', ');
      if (stale && !vm.valueTitle) vm.valueTitle = vm.staleText;
      vm.gwHint = e.designer ? gatewayHint(cfg, snap) : '';
      return vm;
    }
    /**
     * Designer-only hint: the gateway lists, in Designer sessions only, the gateway settings that
     * make this display's own access config stricter for its tag (capabilities.<action>.overrides). '' = none.
     */
    function gatewayHint(cfg, snap) {
      var caps = snap && snap.capabilities;
      if (!caps || !cfg.enabled) return '';
      var parts = [];
      [['write', cfg.setpoint.enabled], ['configEdit', cfg.menu.enabled && cfg.menu.configEdit.enabled]].forEach(function (a) {
        var c = caps[a[0]];
        var list = c && Array.isArray(c.overrides) ? c.overrides.filter(function (x) { return typeof x === 'string' && /^ctg\.[A-Za-z.]+$/.test(x); }) : [];
        if (a[1] && list.length) parts.push(t('dt.gwOverrides', { what: t('dt.gwWhat.' + a[0]), settings: list.join(', ') }));
      });
      return parts.join(' ');
    }

    /* ========================================================================
     * SECTION 4 / The ctg-dt-styles sheet
     * (user documentation: docs/user-guide/components/display-template/styling.md)
     * ----------------------------------------------------------------------
     * Every rule is wrapped in :where() (zero specificity): inline styles
     * (value.style, style) beat any class, and any class (psc-* project style
     * classes, theme or stylesheet rules) beats these defaults — independent
     * of load order. Rule ORDER implements the visual precedence:
     * setpoint < bounds < alarm < quality outline < stale.
     * Tokens are custom properties on :root; dark values come from
     * <html data-ctg-scheme="dark"> (kept current by ctg-common's theme
     * watch). Instance colours (setpoint.color, bounds/alarm colours) are
     * set as inline custom properties on the root, never concatenated here.
     * ====================================================================== */
    var ALARM_TOKENS = {
      critical: ['#B3261E', '#FFFFFF', '#B3261E', '#FF8A80'],
      high: ['#B54700', '#FFFFFF', '#B54700', '#FFB06B'],
      medium: ['#F2C200', '#1A1A1A', '#8A6D00', '#F2C200'],
      low: ['#1F5FA8', '#FFFFFF', '#1F5FA8', '#8EC1FF'],
      diagnostic: ['#5E5E5E', '#FFFFFF', '#5E5E5E', '#BDBDBD'],
    };
    function buildCss() {
      var W = function (sel, body) { return ':where(' + sel + '){' + body + '}'; };
      var css = [];
      // ---- tokens ---------------------------------------------------------------------------------------------
      var tok = ['--dt-padding:10px', '--dt-radius:var(--borderRadius,4px)', '--dt-gap-column:5px', '--dt-gap-row:8px',
        '--dt-label-color:inherit', '--dt-value-color:inherit', '--dt-units-color:inherit',
        '--dt-text-align:center',
        '--dt-setpoint-color:var(--callToAction,#0C7BB3)', '--dt-focus-ring:var(--focus,var(--callToAction,#0C7BB3))',
        '--dt-disabled-color:var(--label--disabled,#767676)', '--dt-stale-opacity:.55',
        '--dt-uncertain-color:#B0479F', '--dt-bad-color:#A0309A', '--dt-error-color:#A0309A',
        '--dt-low-color:#4F6D8F', '--dt-high-color:#6A5ACD', '--dt-low-fg:#FFFFFF', '--dt-high-fg:#FFFFFF',
        '--dt-blink-period:1s', '--dt-write-ok-color:var(--success,#038537)', '--dt-write-fail-color:var(--error,#DA1E28)',
        '--dt-write-warn-color:var(--warning,#AD5F00)'];
      var dark = ['--dt-low-color:#8FA9C8', '--dt-high-color:#A99CF0', '--dt-low-fg:#10161D', '--dt-high-fg:#14112B',
        '--dt-bad-color:#E07BD8', '--dt-uncertain-color:#E79AE0', '--dt-error-color:#E07BD8'];
      Object.keys(ALARM_TOKENS).forEach(function (p) {
        var v = ALARM_TOKENS[p];
        tok.push('--dt-alarm-' + p + '-bg:' + v[0], '--dt-alarm-' + p + '-fg:' + v[1], '--dt-alarm-' + p + '-text:' + v[2]);
        dark.push('--dt-alarm-' + p + '-text:' + v[3]);
      });
      // Overlay layer: ctg-common's --ctg-z (12000) sits BELOW Perspective 8.3's popup pane
      // (.popups-pane gets an inline z-index of 12560), so a dialog opened from a display inside a MODAL popup would
      // be drawn under the popup's modal shade: keys would still reach it, clicks would not. Raised here (same zero
      // specificity, later sheet) until the common token itself is raised; a project theme can still set it.
      tok.push('--ctg-z:100000');
      css.push(W(':root', tok.join(';')));
      css.push(W(':root[data-ctg-scheme="dark"]', dark.join(';')));

      // ---- layout -----------------------------------------------------------------------------------------------
      css.push(W('.dt-root', 'position:relative;display:flex;box-sizing:border-box;min-width:0;min-height:0;overflow:hidden;' +
        'padding:var(--dt-padding);border-radius:var(--dt-radius);background-color:transparent;color:inherit;' +
        'font-family:inherit;text-align:var(--std-text-align,var(--dt-text-align));line-height:1.2;' +
        // the label and value sizes/weights are RELATIVE to the root's, so a Perspective style class or
        // project CSS on the root (style.classes, zero-specificity defaults lose to it) changes them too, not only
        // its colour. Defaults: 14px root -> label 12px bold, value 14px normal.
        'font-size:var(--dt-font-size,14px);font-weight:var(--dt-font-weight,normal)'));
      css.push(W('.dt-root.dt--column', 'flex-direction:column;align-items:stretch;justify-content:center;gap:var(--dt-gap,var(--dt-gap-column))'));
      css.push(W('.dt-root.dt--column.dt--valign-top', 'justify-content:flex-start'));
      css.push(W('.dt-root.dt--column.dt--valign-bottom', 'justify-content:flex-end'));
      css.push(W('.dt-root.dt--row', 'flex-direction:row;align-items:center;justify-content:center;gap:var(--dt-gap,var(--dt-gap-row))'));
      css.push(W('.dt-root.dt--row.dt--valign-top', 'align-items:flex-start'));
      css.push(W('.dt-root.dt--row.dt--valign-bottom', 'align-items:flex-end'));
      css.push(W('.dt-root.dt--even .dt-label,.dt-root.dt--even .dt-value', 'flex:1 1 0'));
      css.push(W('.dt-root.dt--has-menu', '-webkit-touch-callout:none;-webkit-user-select:none;user-select:none'));
      css.push(W('.dt-label', 'min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dt-label-color);' +
        'font-size:var(--std-name-size,var(--dt-label-size,calc(12em / 14)));' +
        'font-weight:var(--std-font-weight,var(--dt-label-weight,bolder))'));
      css.push(W('.dt-value', 'position:relative;min-width:0;box-sizing:border-box;white-space:nowrap;overflow:hidden;' +
        'text-overflow:ellipsis;padding:0 4px;border:1px solid transparent;border-radius:var(--dt-radius);' +
        'color:var(--dt-value-color);font-size:var(--std-value-size,var(--dt-value-size,1em));' +
        'font-weight:var(--dt-value-weight,inherit);font-variant-numeric:tabular-nums'));
      css.push(W('.dt-units', 'margin-left:.3em;color:var(--dt-units-color);font-size:.8em;opacity:.85'));
      css.push(W('.dt-value-text', 'white-space:pre'));
      css.push(W('.dt-value:focus-visible,.dt-input:focus-visible,.dt-select:focus-visible,.dt-spin:focus-visible',
        'outline:2px solid var(--dt-focus-ring);outline-offset:2px'));
      css.push(W('.dt-root:focus-visible', 'outline:2px solid var(--dt-focus-ring);outline-offset:-2px'));

      // ---- small inline glyphs ---------------------------------------------------------------------------------
      css.push(W('.dt-icon', 'display:inline-block;width:.85em;height:.85em;vertical-align:-.1em;flex:0 0 auto'));
      css.push(W('.dt-quality-icon', 'margin-left:.3em;color:var(--dt-uncertain-color)'));
      css.push(W('.dt--qmark-bad .dt-quality-icon', 'color:var(--dt-bad-color)'));
      css.push(W('.dt-stale-icon', 'margin-left:.3em;color:var(--dt-disabled-color)'));
      css.push(W('.dt-edit-icon', 'margin-left:.3em;color:var(--dt-setpoint-color)'));
      css.push(W('.dt--setpoint-denied .dt-edit-icon', 'color:var(--dt-disabled-color)'));
      css.push(W('.dt-alarm-indicator', 'display:inline-block;width:1.05em;height:1.05em;margin-left:.35em;vertical-align:-.15em'));
      css.push(W('.dt-bounds-glyph', 'margin-left:.25em;font-size:.8em'));
      css.push(W('.dt--low .dt-bounds-glyph', 'color:var(--dt-low-color)'));
      css.push(W('.dt--high .dt-bounds-glyph', 'color:var(--dt-high-color)'));
      css.push(W('.dt-gw-badge', 'position:absolute;top:1px;left:1px;padding:0 4px;font-size:9px;line-height:14px;' +
        'font-weight:normal;color:#FFFFFF;background:var(--ctg-warn,#AD5F00);border-radius:3px;z-index:1;cursor:help'));
      css.push(W('.dt-v1-badge', 'position:absolute;top:1px;right:1px;padding:0 4px;font-size:9px;line-height:14px;' +
        'font-weight:normal;color:#FFFFFF;background:var(--ctg-warn,#AD5F00);border-radius:3px;pointer-events:none;z-index:1'));

      // ---- states, in precedence order (later = stronger at equal specificity) ----------------------------------
      css.push(W('.dt--loading .dt-value-text', 'opacity:.7'));
      css.push(W('.dt--unconfigured .dt-value-text', 'opacity:.6;font-style:italic'));
      css.push(W('.dt--design.dt--unconfigured .dt-value-text', 'opacity:.8'));
      // setpoint affordance (7)
      css.push(W('.dt--setpoint .dt-value', 'color:var(--dt-setpoint-color);cursor:pointer'));
      css.push(W('.dt--setpoint .dt-value:hover', 'background-color:var(--ctg-surface-2,rgba(0,0,0,.06))'));
      css.push(W('.dt--setpoint-denied .dt-value', 'color:var(--dt-setpoint-color);cursor:not-allowed'));
      css.push(W('.dt--setpoint-denied .dt-value-text', 'opacity:.5'));
      // bounds (6): neutral colours, never alarm hues
      ['low', 'high'].forEach(function (s) {
        var c = 'var(--dt-' + s + '-color)';
        css.push(W('.dt--' + s + '.dt--bounds-border:not(.dt--bounds-on-root) .dt-value', 'box-shadow:inset 0 0 0 2px ' + c));
        css.push(W('.dt--' + s + '.dt--bounds-border.dt--bounds-on-root', 'box-shadow:inset 0 0 0 2px ' + c));
        css.push(W('.dt--' + s + '.dt--bounds-bg:not(.dt--bounds-on-root) .dt-value', 'background-color:' + c + ';color:var(--dt-' + s + '-fg)'));
        css.push(W('.dt--' + s + '.dt--bounds-bg.dt--bounds-on-root', 'background-color:' + c + ';color:var(--dt-' + s + '-fg)'));
        css.push(W('.dt--' + s + '.dt--bounds-bg .dt-bounds-glyph', 'color:inherit'));
        css.push(W('.dt--' + s + '.dt--bounds-text:not(.dt--bounds-on-root) .dt-value', 'color:' + c));
        css.push(W('.dt--' + s + '.dt--bounds-text.dt--bounds-on-root', 'color:' + c));
      });
      // alarm (5): beats bounds and setpoint
      Object.keys(ALARM_TOKENS).forEach(function (p) {
        var bg = 'var(--dt-alarm-' + p + '-bg)', fg = 'var(--dt-alarm-' + p + '-fg)', tx = 'var(--dt-alarm-' + p + '-text)';
        var a = '.dt--alarm-' + p;
        css.push(W(a, '--dt-blink-color:' + bg));
        css.push(W(a + '.dt--alarm-bg:not(.dt--alarm-on-root) .dt-value', 'background-color:' + bg + ';color:' + fg + ';box-shadow:none'));
        css.push(W(a + '.dt--alarm-bg.dt--alarm-on-root', 'background-color:' + bg + ';color:' + fg));
        css.push(W(a + '.dt--alarm-bg.dt--alarm-on-root .dt-value', 'color:inherit'));
        css.push(W(a + '.dt--alarm-text:not(.dt--alarm-on-root) .dt-value', 'color:' + tx));
        css.push(W(a + '.dt--alarm-text.dt--alarm-on-root', 'color:' + tx));
        css.push(W(a + '.dt--alarm-text.dt--alarm-on-root .dt-value', 'color:inherit'));
        css.push(W(a + '.dt--alarm-border:not(.dt--alarm-on-root) .dt-value', 'box-shadow:inset 0 0 0 2px ' + bg));
        css.push(W(a + '.dt--alarm-border.dt--alarm-on-root', 'box-shadow:inset 0 0 0 2px ' + bg));
        css.push(W(a + ' .dt-alarm-indicator .dt-ind-shape', 'fill:' + bg + ';stroke:' + fg));
        css.push(W(a + ' .dt-alarm-indicator .dt-ind-num', 'fill:' + fg));
      });
      css.push(W('.dt--alarm-bg:not(.dt--alarm-on-root) .dt-value .dt-alarm-indicator .dt-ind-shape,' +
        '.dt--alarm-bg.dt--alarm-on-root .dt-alarm-indicator .dt-ind-shape', 'stroke-width:1.5'));
      // quality (4): an outline that never hides the value, magenta (alarm hues reserved)
      css.push(W('.dt--qmark-uncertain .dt-value', 'border-color:var(--dt-uncertain-color);border-style:dashed'));
      css.push(W('.dt--qmark-bad .dt-value', 'border-color:var(--dt-bad-color);border-style:solid'));
      css.push(W('.dt--nonfinite .dt-value-text', 'font-style:italic'));
      // error statuses (3)
      css.push(W('.dt--error .dt-value', 'color:var(--dt-error-color);font-size:min(var(--std-value-size,var(--dt-value-size,1em)),1em)'));
      // stale (2): combined with everything above, not replacing it
      css.push(W('.dt--stale .dt-value-text,.dt--stale .dt-units', 'opacity:var(--dt-stale-opacity);text-decoration:underline dashed;' +
        'text-decoration-thickness:1px;text-underline-offset:3px'));
      // blink (unacknowledged alarms: the marker by default, never under reduced motion)
      css.push('@keyframes ctg-dt-blink{50%{opacity:.25}}');
      css.push('@keyframes ctg-dt-blink-outline{0%{box-shadow:inset 0 0 0 2px var(--dt-blink-color)}' +
        '50%{box-shadow:inset 0 0 0 2px transparent}}');
      css.push(W('.dt--blink-indicator .dt-alarm-indicator', 'animation:ctg-dt-blink var(--dt-blink-period) steps(1) infinite'));
      css.push(W('.dt--blink-outline:not(.dt--alarm-on-root) .dt-value,.dt--blink-outline.dt--alarm-on-root',
        'animation:ctg-dt-blink-outline var(--dt-blink-period) steps(1) infinite'));
      css.push(W('.dt--blink-value:not(.dt--alarm-on-root) .dt-value,.dt--blink-value.dt--alarm-on-root',
        'animation:ctg-dt-blink var(--dt-blink-period) steps(1) infinite'));
      // write feedback
      css.push('@keyframes ctg-dt-flash{0%{box-shadow:inset 0 0 0 2px var(--dt-flash-color)}70%{box-shadow:inset 0 0 0 2px var(--dt-flash-color)}' +
        '100%{box-shadow:inset 0 0 0 2px transparent}}');
      css.push(W('.dt--write-ok', '--dt-flash-color:var(--dt-write-ok-color)'));
      css.push(W('.dt--write-failed', '--dt-flash-color:var(--dt-write-fail-color)'));
      css.push(W('.dt--write-ok .dt-value,.dt--write-failed .dt-value', 'animation:ctg-dt-flash 1.2s ease-out 1'));
      css.push(W('.dt--writing .dt-value', 'cursor:progress'));
      css.push(W('.dt-writing-spinner', 'margin-left:.35em;width:.8em;height:.8em'));
      css.push('@media (prefers-reduced-motion:reduce){' +
        W('.dt--blink-indicator .dt-alarm-indicator,.dt--blink-value .dt-value,.dt--blink-value.dt--alarm-on-root,' +
          '.dt--blink-outline .dt-value,.dt--blink-outline.dt--alarm-on-root,.dt--write-ok .dt-value,.dt--write-failed .dt-value',
        'animation:none') +
        W('.dt--alarm-unacked:not(.dt--alarm-on-root) .dt-value,.dt--alarm-unacked.dt--alarm-on-root',
          'outline:2px solid var(--dt-blink-color);outline-offset:-2px') + '}');

      // ---- inline editor (direct / protected) -------------------------------------------------------------------
      css.push(W('.dt-value.dt-value--editor', 'display:flex;align-items:center;gap:4px;overflow:visible;text-overflow:clip'));
      css.push(W('.dt--column .dt-value.dt-value--editor', 'justify-content:center'));
      css.push(W('.dt-input', 'flex:1 1 auto;min-width:3ch;width:100%;box-sizing:border-box;margin:0;padding:0 2px;font:inherit;' +
        'font-variant-numeric:tabular-nums;color:var(--dt-setpoint-color);background:transparent;border:0;' +
        'border-bottom:1px solid transparent;border-radius:0;text-align:inherit;outline:none'));
      css.push(W('.dt-input:focus', 'border-bottom-color:var(--dt-setpoint-color);background:var(--ctg-input-bg,transparent);' +
        'color:var(--ctg-input-text,inherit)'));
      css.push(W('.dt-input[readonly]', 'cursor:pointer'));
      css.push(W('.dt--setpoint-denied .dt-input', 'cursor:not-allowed'));
      css.push(W('.dt-input--invalid', 'border-bottom:2px solid var(--dt-write-fail-color)'));
      // direct mode at rest (after the .dt-input rules: equal zero specificity, so order decides): the read-only input is as wide as its text, centred like the plain value
      css.push(W('.dt-value.dt-value--direct', 'display:flex;align-items:baseline;justify-content:center;overflow:hidden'));
      css.push(W('.dt-root.dt--row .dt-value.dt-value--direct', 'justify-content:flex-start'));
      css.push(W('.dt-value--direct .dt-input', 'flex:0 1 auto;width:auto;min-width:2ch;field-sizing:content'));
      // the idle (read-only) direct input IS the value, so it takes the value's colour — setpoint,
      // bounds, alarm text / background fg, value.style and value.style classes all land on .dt-value and are
      // inherited — and the value's dimming cues (stale, setpoint denied). The .dt-input colour above applies to the
      // input itself and would beat every inherited one (a value in Critical alarm would stay setpoint blue).
      css.push(W('.dt-value--direct .dt-input[readonly]', 'color:inherit'));
      css.push(W('.dt--setpoint-denied .dt-value--direct .dt-input[readonly]', 'opacity:.5'));
      css.push(W('.dt--stale .dt-value--direct .dt-input[readonly]', 'opacity:var(--dt-stale-opacity);text-decoration:underline dashed;' +
        'text-decoration-thickness:1px;text-underline-offset:3px'));
      css.push(W('.dt-select', 'flex:1 1 auto;min-width:4ch;max-width:100%;margin:0;padding:0 2px;font:inherit;' +
        'color:var(--ctg-input-text,inherit);background:var(--ctg-input-bg,transparent);border:1px solid var(--ctg-border,#A1A1A1);' +
        'border-radius:var(--borderRadiusInput,3px)'));
      css.push(W('.dt-spin', 'flex:0 0 auto;min-width:1.6em;height:1.6em;padding:0;font:inherit;font-size:.9em;line-height:1;' +
        'color:var(--ctg-text,inherit);background:var(--ctg-surface,transparent);border:1px solid var(--ctg-border,#A1A1A1);' +
        'border-radius:var(--ctg-radius,4px);cursor:pointer'));
      css.push('@media (pointer:coarse){' + W('.dt-spin', 'min-width:44px;height:44px') + '}');

      // ---- dialogs (setpoint, configuration, change history) ---------------------------------------------------
      css.push(W('.dt-dlg__path', 'margin:-2px 0 10px;font-size:12px;color:var(--ctg-text-muted);overflow-wrap:anywhere'));
      css.push(W('.dt-dlg__current', 'display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;margin:0 0 12px'));
      css.push(W('.dt-dlg__current-label', 'font-size:13px;font-weight:600;min-width:6.5em'));
      css.push(W('.dt-dlg__current-value', 'font-size:18px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere'));
      css.push(W('.dt-dlg__badge', 'display:inline-flex;align-items:center;gap:4px;font-size:12px;color:var(--ctg-text-muted)'));
      css.push(W('.dt-dlg__dot', 'display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--ctg-success)'));
      css.push(W('.dt-dlg__dot--uncertain', 'background:var(--dt-uncertain-color)'));
      css.push(W('.dt-dlg__dot--bad', 'background:var(--dt-bad-color)'));
      css.push(W('.dt-dlg__dot--stale', 'background:var(--ctg-text-muted)'));
      css.push(W('.dt-dlg__inputrow', 'display:flex;align-items:center;gap:6px'));
      css.push(W('.dt-dlg__inputrow .ctg-input', 'flex:1 1 auto;min-width:0;font-variant-numeric:tabular-nums'));
      css.push(W('.dt-dlg__units', 'flex:0 0 auto;font-size:13px;color:var(--ctg-text-muted)'));
      css.push(W('.dt-dlg__notice', 'margin:0 0 12px;padding:8px 10px;font-size:13px;background:var(--ctg-surface-2);' +
        'border-left:4px solid var(--ctg-primary);border-radius:var(--ctg-radius)'));
      css.push(W('.dt-dlg__status', 'min-height:1.35em;margin-top:2px'));
      css.push(W('.ctg-status--warn', 'color:var(--ctg-warn)'));
      css.push(W('.dt-dlg--history', 'width:min(640px,calc(100vw - 32px))'));
      css.push(W('.dt-hist', 'width:100%;border-collapse:collapse;font-size:13px'));
      css.push(W('.dt-hist th', 'position:sticky;top:0;text-align:left;font-weight:600;padding:6px 8px;background:var(--ctg-surface);' +
        'border-bottom:1px solid var(--ctg-border)'));
      css.push(W('.dt-hist td', 'padding:6px 8px;vertical-align:top;border-bottom:1px solid var(--ctg-surface-2);overflow-wrap:anywhere'));
      css.push(W('.dt-hist td.dt-hist__time', 'white-space:nowrap;font-variant-numeric:tabular-nums'));
      css.push(W('.dt-hist__res--bad', 'color:var(--ctg-danger)'));
      css.push(W('.dt-hist__res--uncertain', 'color:var(--ctg-warn)'));
      css.push(W('.dt-hist__muted', 'color:var(--ctg-text-muted);font-size:12px'));
      css.push(W('.dt-hist__wrap', 'max-height:min(60vh,420px);overflow:auto'));
      return css.join('\n');
    }
    var DT_STYLE_ID = 'ctg-dt-styles';
    var DT_CSS = null;
    function ensureDtStyles() {
      if (!DT_CSS) DT_CSS = buildCss();
      try { NS.theme.ensureCommonStyles(); NS.theme.ensureStyles(DT_STYLE_ID, DT_CSS, NS.loaded[PART]); } catch (e) { log.warn('styles', e); }
    }

    /* ========================================================================
     * SECTION 5 / DisplayTemplateDelegate — the browser half of one display
     * ----------------------------------------------------------------------
     * snap = the last dt.snapshot with every later dt.values section merged in
     * (each present top-level key replaces that section; unknown keys kept for
     * forward compatibility). valueSeq counts value updates (read-back check,
     * "current value changed" hints). Requests always carry expectedTagPath =
     * the tag the operator SAW (captured by the caller), so the gateway's
     * STALE_TARGET is the authority when the tag changed meanwhile.
     * silenceLimitMs: STALE after 75 s without any push (the gateway sends a
     * ctg.hb heartbeat after 30 s of silence) — derived from the gateway's
     * ctg.display.heartbeatMs when the gateway reports it (timingOf).
     * ====================================================================== */
    var WRITE_TIMEOUT_MS = 15000;     // write / configEdit 15 s, everything else 8 s (minimums)
    var READ_TIMEOUT_MS = 8000;
    var SILENCE_LIMIT_MS = 75000;

    /**
     * The gateway's timing: the snapshot's live `timing` section, else ctg.welcome.limits, else {}.
     * {heartbeatMs, heartbeatCheckMs, readTimeoutMs, writeTimeoutMs} = ctg.display.heartbeatMs, the gateway's
     * heartbeat check period, ctg.read.timeoutMs, ctg.write.timeoutMs.
     */
    function timingOf(d) {
      var tm = d && d.snap && d.snap.timing;
      if (!tm || typeof tm !== 'object') tm = d && d.state && d.state.welcome && d.state.welcome.limits;
      return tm && typeof tm === 'object' ? tm : {};
    }
    function posNum(x) { return typeof x === 'number' && isFinite(x) && x > 0 ? x : null; }
    /**
     * Client deadlines derived from the gateway's settings instead of fixed constants: a write first
     * re-reads the tag (ctg.read.timeoutMs), then writes (ctg.write.timeoutMs), so its worst case is the sum; the
     * client waits that plus a transfer margin, so the gateway's own answer (ok, or TIMEOUT audited UNCERTAIN) arrives
     * before the client gives up. Never shorter than the WRITE_TIMEOUT_MS / READ_TIMEOUT_MS minimums.
     */
    function writeDeadlineMs(tm) {
      var r = posNum(tm.readTimeoutMs), w = posNum(tm.writeTimeoutMs);
      return r != null && w != null ? Math.max(WRITE_TIMEOUT_MS, r + w + 5000) : WRITE_TIMEOUT_MS;
    }
    function readDeadlineMs(tm) {
      var r = posNum(tm.readTimeoutMs);
      return r != null ? Math.max(READ_TIMEOUT_MS, r + 3000) : READ_TIMEOUT_MS;
    }
    /**
     * Push silence that counts as STALE: a heartbeat can arrive up to heartbeatMs + heartbeatCheckMs after the last
     * push, so a healthy display on a static tag must not be flagged before two heartbeats could have been missed.
     * 75 s at the default 30 s heartbeat; 255 s at 120 s (a fixed 75 s would make displays on static tags flap
     * "Gateway service not responding" for ~45 s of every 2 min).
     */
    function silenceLimitOf(tm) {
      var hb = posNum(tm.heartbeatMs);
      var chk = posNum(tm.heartbeatCheckMs) || 5000;
      return hb != null ? Math.max(SILENCE_LIMIT_MS, 2 * hb + chk + 10000) : SILENCE_LIMIT_MS;
    }

    class DisplayTemplateDelegate extends NS.delegate.CtgDelegateBase {
      constructor(store) {
        super(store, 'dt');
        this.snap = null;
        this.valueSeq = 0;
        this.silenceLimitMs = SILENCE_LIMIT_MS;
      }

      /** Watchdog tick: the silence limit follows the gateway's heartbeat setting. */
      _checkSilence(now) {
        var tm = timingOf(this);
        if (posNum(tm.heartbeatMs) != null) this.silenceLimitMs = silenceLimitOf(tm);   // else the default stays
        return super._checkSilence(now);
      }

      extraState() { return { snap: this.snap, valueSeq: this.valueSeq }; }

      onMessage(name, payload) {
        if (name === 'dt.snapshot') {
          this.snap = payload;
          this.valueSeq++;
          this.changed();
        } else if (name === 'dt.values') {
          if (!this.snap) return;            // a snapshot always comes first after hello
          var next = Object.assign({}, this.snap);
          for (var k in payload) if (hasOwn.call(payload, k)) next[k] = payload[k];
          if (hasOwn.call(payload, 'value')) this.valueSeq++;
          this.snap = next;
          this.changed();
        }
      }

      onEpochChange() {
        this.snap = null;                    // the resync snapshot follows; never show the old tag's data meanwhile
        this.changed();
      }

      /** dt.write → {ok, data:{tagPath, written, previous, quality, auditId}} | {ok:false, error}; also returns the id. */
      write(expectedTagPath, value, opts) {
        var o = opts || {};
        var body = { expectedTagPath: expectedTagPath, value: value, ui: o.ui || 'unknown' };
        if (o.display != null) body.display = String(o.display).slice(0, 64);
        var before = this._n;
        var p = this.request('dt.write', body, { timeoutMs: writeDeadlineMs(timingOf(this)), reuseId: o.reuseId || undefined });
        // the id actually sent (null when nothing went out: DISCONNECTED / DETACHED never reach the gateway,
        // so their id must never be reused for a later, different value)
        var sent = o.reuseId || (this._n !== before ? this.lastRequestId() : null);
        return { promise: p, id: sent };
      }
      configEdit(expectedTagPath, changes) {
        return this.request('dt.configEdit', { expectedTagPath: expectedTagPath, changes: changes }, { timeoutMs: writeDeadlineMs(timingOf(this)) });
      }
      trendAdd(expectedTagPath) {
        return this.request('dt.trendAdd', { expectedTagPath: expectedTagPath }, { timeoutMs: readDeadlineMs(timingOf(this)) });
      }
      trendRemove(expectedTagPath) {
        return this.request('dt.trendRemove', { expectedTagPath: expectedTagPath }, { timeoutMs: readDeadlineMs(timingOf(this)) });
      }
      auditQuery(expectedTagPath) {
        return this.request('dt.auditQuery', { expectedTagPath: expectedTagPath }, { timeoutMs: readDeadlineMs(timingOf(this)) });
      }
    }

    /* ========================================================================
     * SECTION 6 / Small React pieces (no innerHTML: SVG built with createElement)
     * ====================================================================== */
    var ICON_PATHS = {
      edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0' +
        'l-1.83 1.83 3.75 3.75 1.83-1.83z',
      uncertain: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
      bad: 'M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59' +
        ' 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z',
      stale: 'M19.35 10.04A7.49 7.49 0 0 0 12 4c-1.48 0-2.85.43-4.01 1.17l1.46 1.46A5.497 5.497 0 0 1 17.5 11h.5c1.65 0 3 1.35' +
        ' 3 3 0 1.13-.64 2.11-1.56 2.62l1.45 1.45C22.16 17.16 23 15.68 23 14c0-2.64-2.05-4.78-4.65-4.96zM3 5.27l2.75 2.74' +
        'C2.56 8.15 0 10.77 0 14c0 3.31 2.69 6 6 6h11.73l2 2L21 20.73 4.27 4 3 5.27zM7.73 10l8 8H6c-2.21 0-4-1.79-4-4' +
        's1.79-4 4-4h1.73z',
    };
    /** Inline SVG icon; decorative unless `label` is given (then role=img with an accessible name). */
    function Icon(name, className, label) {
      var a = { className: 'dt-icon ' + (className || ''), viewBox: '0 0 24 24', focusable: 'false', fill: 'currentColor' };
      if (label) { a.role = 'img'; a['aria-label'] = label; } else a['aria-hidden'] = 'true';
      return h('svg', a, label ? h('title', null, label) : null, h('path', { d: ICON_PATHS[name] }));
    }

    /**
     * Alarm priority marker: shape + number, so priority is never shown by colour
     * alone — ◆1 Critical, ▲2 High, ●3 Medium, ▼4 Low, ■D Diagnostic. aria-hidden: the value's aria-label
     * carries the text.
     */
    var INDICATOR = {
      4: { shape: 'polygon', attrs: { points: '10,1 19,10 10,19 1,10' }, num: '1', y: 10.5 },
      3: { shape: 'polygon', attrs: { points: '10,1.5 19,18 1,18' }, num: '2', y: 12.5 },
      2: { shape: 'circle', attrs: { cx: 10, cy: 10, r: 8.5 }, num: '3', y: 10.5 },
      1: { shape: 'polygon', attrs: { points: '1,2 19,2 10,18.5' }, num: '4', y: 8 },
      0: { shape: 'rect', attrs: { x: 2, y: 2, width: 16, height: 16, rx: 1.5 }, num: 'D', y: 10.5 },
    };
    function AlarmIndicator(alarm) {
      var s = INDICATOR[alarm.priority];
      if (!s) return null;
      return h('svg', { key: 'ind', className: 'dt-alarm-indicator', viewBox: '0 0 20 20', 'aria-hidden': 'true', focusable: 'false',
        'data-priority': alarm.name },
      h(s.shape, Object.assign({ className: 'dt-ind-shape', strokeWidth: 1 }, s.attrs)),
      h('text', { className: 'dt-ind-num', x: 10, y: s.y, textAnchor: 'middle', dominantBaseline: 'central', fontSize: 10,
        fontWeight: 700, fontFamily: 'inherit' }, s.num));
    }

    /** True when the tag is a Float4 (single precision; its value reaches the browser widened to a double). */
    function isFloat4(snap) {
      var dt = snap && snap.meta && snap.meta.dataType;
      if (dt == null && snap && snap.value) dt = snap.value.type;
      return dt === 'Float4';
    }
    /**
     * Shortest text of a number for editing. A Float4 value arrives widened to a double (72.3 → 72.30000305175781):
     * this prints the shortest decimal that rounds back to the same single-precision float (72.3) instead of
     * 15 significant digits ("72.3000030517578", a value the operator never set).
     */
    function shortNum(n, float4) {
      // integers are never rounded (exact for every safe integer) — toPrecision(15) would turn the Int8
      // 1760000000000123 into ...120, so an unedited Write would change the tag and the spinner would get stuck
      if (Number.isInteger(n)) return plainNum(n);
      if (float4 && Math.fround(n) === n) {
        for (var p = 1; p <= 9; p++) {
          var c = Number(n.toPrecision(p));
          if (Math.fround(c) === n) return plainNum(c);
        }
      }
      return plainNum(Number(n.toPrecision(15)));
    }
    /** A number as plain decimal text (never "1e-7": the editors parse plain decimals only). */
    function plainNum(x) {
      var s = String(x);
      if (!/e/i.test(s) || !isFinite(x) || Math.abs(x) >= 1e21) return s;
      return x.toFixed(Math.min(100, decimalsOf(x)));
    }
    /**
     * True when the root's computed font-size differs from the module default (--dt-font-size, 14px): a style class,
     * project CSS or an inline style.fontSize set it. A non-px token value cannot be compared: false.
     */
    function rootFontIsExplicit(el) {
      if (!el || typeof window === 'undefined' || !window.getComputedStyle) return false;
      try {
        var cs = window.getComputedStyle(el);
        var tok = String(cs.getPropertyValue('--dt-font-size') || '').trim();
        var ref = tok === '' ? 14 : /^[\d.]+px$/.test(tok) ? parseFloat(tok) : NaN;
        var cur = parseFloat(cs.fontSize);
        return isFinite(ref) && isFinite(cur) && Math.abs(cur - ref) > 0.01;
      } catch (e) {
        return false;
      }
    }
    /**
     * Default popup id of "Open Trend Popup": trendList mode shows the group, so one popup per group
     * ('ctg-trend-<group>'); singleTag mode shows ONE tag, so the id names the tag too — with a shared id the second
     * display would only focus the first display's popup (its tag and title). An explicit menu.trendPopup.id is used
     * as is (displays that share it share one popup).
     */
    function trendPopupId(tp, v) {
      if (tp.id) return tp.id;
      var base = 'ctg-trend-' + v.trendGroup;
      if (tp.mode !== 'singleTag') return base;
      var s = NS.util.normKey(v.tagPath || ''), h = 0x811c9dc5;
      for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      return base + '-' + h.toString(36);
    }
    /** Raw editable text of the current value: no grouping, locale decimal. */
    function editText(snap, locale) {
      var v = snap && snap.value;
      if (!v || v.v == null) return '';
      if (v.bigint && typeof v.v === 'string') return v.v;
      if (typeof v.v === 'number') {
        if (!isFinite(v.v)) return '';
        var s = shortNum(v.v, isFloat4(snap));
        return NS.format.decimalSeparator(locale) === ',' ? s.replace('.', ',') : s;
      }
      if (typeof v.v === 'string') return v.v;
      if (typeof v.v === 'boolean') return String(v.v);
      return '';
    }
    /** Text for a number the operator will edit (spinner results): same rules as editText. */
    function numEditText(n, locale, float4) {
      var s = shortNum(Number(n), float4);
      return NS.format.decimalSeparator(locale) === ',' ? s.replace('.', ',') : s;
    }
    /** ArrowUp/Down and −/+: step the typed number, clamped to the write limits; null when the text is not a number. */
    function stepText(text, dir, increment, snap, locale, kind) {
      var dt = kind === 'int' ? 'Int8' : 'Float8';
      var p = NS.format.parseInput(text === '' ? '0' : text, dt, locale);
      if (!p.ok) return null;
      var big = bigStep(p.value, dir, increment, snap, kind);
      if (big != null) return big;
      var n = Number(p.value) + dir * increment;
      // an integer rounds in the direction of travel (Math.round would make a 0.5 step down from 2 land on 2
      // again, and any step below 0.5 would never move)
      if (kind === 'int') n = dir > 0 ? Math.ceil(n) : Math.floor(n);
      var wl = writeLimits(snap);
      if (wl && wl.inclusive && kind === 'int') {
        // an integer clamps to the nearest whole number inside fractional limits (0.5 .. 10.5 -> 1 .. 10);
        // landing on 0.5 itself would be an invalid entry ('Enter a whole number'). No valid integer at all: no clamp.
        var lo = wl.low != null ? Math.ceil(wl.low) : null, hi = wl.high != null ? Math.floor(wl.high) : null;
        if (lo == null || hi == null || lo <= hi) {
          if (lo != null && n < lo) n = lo;
          if (hi != null && n > hi) n = hi;
        }
      } else if (wl && wl.inclusive) {
        if (wl.low != null && n < wl.low) n = wl.low;
        if (wl.high != null && n > wl.high) n = wl.high;
      } else if (wl) {
        // exclusive limits are never valid values themselves, so a step never lands on one. An
        // integer stops at the nearest valid integer inside; a float that would cross keeps its value (when that
        // value was inside), else it is clamped to the limit (it was already outside).
        var orig = Number(p.value);
        var inside = function (x) { return (wl.low == null || x > wl.low) && (wl.high == null || x < wl.high); };
        if (kind === 'int') {
          if (wl.low != null && n <= wl.low) n = Math.floor(wl.low) + 1;
          if (wl.high != null && n >= wl.high) n = Math.ceil(wl.high) - 1;
        } else if (!inside(n)) {
          if (inside(orig)) n = orig;
          else if (wl.low != null && n < wl.low) n = wl.low;
          else if (wl.high != null && n > wl.high) n = wl.high;
        }
      }
      // decimals of the increment, so 0.1 steps do not print 0.30000000000000004 (exponent forms such as 1e-7
      // counted too: '1e-7' has no '.', so toFixed(6) alone would round the step away)
      var dec = decimalsOf(increment);
      n = Number(n.toFixed(Math.min(100, Math.max(dec, 0) + 6)));
      return numEditText(n, locale, isFloat4(snap));
    }
    /**
     * Integer step beyond 2^53: a bigint text (or a parsed value past Number.MAX_SAFE_INTEGER) steps
     * with BigInt arithmetic — Number() loses the low digits, so +1 on 9007199254740993 would write 9007199254740990.
     * Clamped to the write limits' whole numbers. Null when the ordinary Number path is exact (or BigInt is missing).
     */
    function bigStep(value, dir, increment, snap, kind) {
      if (kind !== 'int' || typeof BigInt !== 'function' || !Number.isInteger(increment)) return null;
      var s = typeof value === 'bigint' ? value.toString() : String(value);
      if (!/^[-+]?\d+$/.test(s)) return null;
      if (Math.abs(Number(s)) <= Number.MAX_SAFE_INTEGER && typeof value !== 'bigint' && typeof value !== 'string') return null;
      if (Math.abs(Number(s)) <= Number.MAX_SAFE_INTEGER - Math.abs(increment)) return null;
      var n = BigInt(s.replace(/^\+/, '')) + BigInt(dir * increment);
      var wl = writeLimits(snap);
      if (wl) {
        var lo = wl.low == null ? null : BigInt(wl.inclusive ? Math.ceil(wl.low) : Math.floor(wl.low) + 1);
        var hi = wl.high == null ? null : BigInt(wl.inclusive ? Math.floor(wl.high) : Math.ceil(wl.high) - 1);
        if (lo == null || hi == null || lo <= hi) {
          if (lo != null && n < lo) n = lo;
          if (hi != null && n > hi) n = hi;
        }
      }
      return n.toString();
    }
    /** ± toggle (iOS numeric keypads have no minus key). */
    function negateText(text) {
      var s = String(text || '').trim();
      if (s.charAt(0) === '-') return s.slice(1);
      if (s.charAt(0) === '+') return '-' + s.slice(1);
      return '-' + s;
    }
    /** inputmode for numeric entry: numeric/decimal only when the low write limit is known and >= 0 (iOS numeric keypads have no minus key). */
    function numericInputMode(kind, snap) {
      var wl = writeLimits(snap);
      var nonNegative = !!(wl && wl.low != null && wl.low >= 0);
      if (!nonNegative) return { inputMode: 'text', needsSign: true };
      return { inputMode: kind === 'int' ? 'numeric' : 'decimal', needsSign: false };
    }
    /** Value labels of a Boolean / options write ([{value, label, disabled}]). */
    function choiceOptions(cfg, kind) {
      if (kind === 'boolean') {
        return [{ value: true, label: cfg.states.boolean.trueText || 'true' },
          { value: false, label: cfg.states.boolean.falseText || 'false' }];
      }
      return cfg.setpoint.options.map(function (o) {
        return { value: o.value, label: o.label === '' ? String(o.value) : String(o.label), disabled: o.isDisabled };
      });
    }
    /** Index of the current value among the write choices; -1 when it matches none. */
    function choiceIndex(cfg, kind, snap) {
      var opts = choiceOptions(cfg, kind);
      var cur = snap && snap.value ? snap.value.v : undefined;
      for (var i = 0; i < opts.length; i++) if (NS.util.looseEqual(opts[i].value, cur)) return i;
      return -1;
    }
    function useButtons(cfg, n) {
      var c = cfg.setpoint.optionsControl;
      return c === 'buttons' || (c === 'auto' && n <= 5);
    }
    /** Display text of a value about to be written (confirm texts). */
    function choiceLabel(cfg, kind, value) {
      var opts = choiceOptions(cfg, kind);
      for (var i = 0; i < opts.length; i++) if (NS.util.looseEqual(opts[i].value, value)) return opts[i].label;
      return String(value);
    }

    /* ========================================================================
     * SECTION 7 / DtSetpointDialog — popup mode and "Set Value…"
     * ----------------------------------------------------------------------
     *   ┌ Set Temp SP ───────────────────────────── [×] ┐
     *   │ [default]CTG/TempSP                             │  popup.tagPathVisible
     *   │ Current   75.0 degF   ● Good                    │  live; "Not connected" while stale
     *   │ New value [ 75.0        ] [−][+][±] degF        │  number | text | buttons | select
     *   │ Allowed range 0 – 100 degF (inclusive)          │  popup.limitsVisible && snap.writeLimits
     *   │ Max change ±10 per write                        │  maxStep / maxStepPercent
     *   │ ⚠ Must be between 0 and 100.                    │  validation, after the first edit/submit
     *   │ Writing…  /  ✕ The tag provider denied …        │  status (aria-live)
     *   │                         [ Cancel ]  [ Write ]   │
     * Rules: Boolean/option buttons are a SELECTION, Write commits;
     * Write is a no-op while busy (no double submit); after a timeout the
     * outcome is unknown, so Write stays off until the operator edits again and
     * nothing is ever retried automatically; the same request id is reused when
     * Write is pressed again for an unchanged value (gateway idempotency).
     * The dialog keeps the target it was opened for: a later tag/permission
     * change disables Write; the gateway's STALE_TARGET is the authority.
     * The write itself is owned by the component, so Cancel while writing just
     * closes the dialog and the result still shows on the value.
     * ====================================================================== */
    class DtSetpointDialog extends PC.Component {
      constructor(props) {
        super(props);
        var snap = props.d.snap;
        var kind = writeKind(props.cfg, snap);
        var choice = null;
        if (kind === 'options' || kind === 'boolean') {
          var cur = snap && snap.value ? snap.value.v : null;
          var opts = choiceOptions(props.cfg, kind);
          for (var i = 0; i < opts.length; i++) if (NS.util.looseEqual(opts[i].value, cur)) { choice = i; break; }
        }
        this.state = {
          kind: kind, text: kind === 'string' || kind === 'int' || kind === 'float' ? editText(snap, props.env.locale) : '',
          choice: choice, touched: false, busy: false, status: null, mustEdit: false, lastSent: null, invalidFromGateway: false,
          confirm: null,
        };
        this.inputId = NS.util.uid('dt-sp-in');
        this.helpId = NS.util.uid('dt-sp-help');
        this.statusId = NS.util.uid('dt-sp-status');
        this.inputEl = null;
        this._alive = false;
        var self = this;
        this._setInput = function (el) { self.inputEl = el; };
        this._focusInitial = function (root) {
          if (self.inputEl) return self.inputEl;
          return root && (root.querySelector('.ctg-choice__option[aria-checked="true"]') || root.querySelector('.ctg-choice__option:not([disabled])') ||
            root.querySelector('select'));
        };
      }
      componentDidMount() { this._alive = true; }
      componentWillUnmount() { this._alive = false; }

      _setText(text) { this.setState({ text: text, touched: true, mustEdit: false, status: null, invalidFromGateway: false }); }
      _setChoice(i) { this.setState({ choice: i, touched: true, mustEdit: false, status: null, invalidFromGateway: false }); }

      /** {ok, value, error} of the current input (advisory; the gateway re-validates everything). */
      _validate() {
        var p = this.props, s = this.state, cfg = p.cfg, snap = p.d.snap, env = p.env;
        if (s.kind === 'unsupported') return { ok: false, error: t('sp.unsupported', { type: (snap && snap.meta && snap.meta.dataType) || '?' }) };
        if (s.kind === 'options' || s.kind === 'boolean') {
          var opts = choiceOptions(cfg, s.kind);
          var o = s.choice != null ? opts[s.choice] : null;
          if (!o || o.disabled) return { ok: false, error: t('sp.choose') };
          return { ok: true, value: o.value, label: o.label };
        }
        var dt = s.kind === 'string' ? 'String' : (snap && snap.meta && snap.meta.dataType) || (s.kind === 'int' ? 'Int4' : 'Float8');
        var units = unitsText(cfg, snap);
        var r = NS.format.parseInput(s.text, dt, env.locale, {
          limits: writeLimits(snap), maxLength: cfg.setpoint.maxStringLength,
          formatLimit: function (n) { return fmtExact(n, cfg, snap, env) + (units ? '\u00A0' + units : ''); },
        });
        if (!r.ok) return { ok: false, error: r.error, code: r.code };
        if (s.kind === 'int' || s.kind === 'float') {
          var st = stepCheck(cfg, snap, r.value);
          if (!st.ok) {
            var mx = fmtExact(st.max, cfg, snap, env) + (units ? '\u00A0' + units : '');
            return { ok: false, error: st.unknown ? t('sp.stepUnknown', { max: mx }) : t('sp.stepTooLarge', { max: mx }), code: 'STEP_TOO_LARGE' };
          }
        }
        return { ok: true, value: r.value };
      }

      /** Why Write is off right now even with a valid input ('' = it is not). */
      _blocked() {
        var p = this.props;
        return dialogBlock(p.cfg, p.d, p.env, p.target.tagPath);
      }

      _submit() {
        var s = this.state;
        if (s.busy) return;                                   // no double submit
        if (!s.touched) this.setState({ touched: true });
        var v = this._validate();
        if (!v.ok || this._blocked() || s.mustEdit) { this._focusInput(); return; }
        var p = this.props, cfg = p.cfg, snap = p.d.snap, env = p.env;
        var self = this;
        var label = p.vm.labelText || p.vm.tagName;
        var units = unitsText(cfg, snap);
        var shown = s.kind === 'options' || s.kind === 'boolean' ? v.label
          : (s.kind === 'string' ? '"' + v.value + '"' : fmtExact(Number(v.value), cfg, snap, env) + (units ? '\u00A0' + units : ''));
        var big = (s.kind === 'int' || s.kind === 'float') ? bigChange(cfg, snap, v.value) : null;
        if (big) {
          var f = function (n) { return fmtExact(n, cfg, snap, env) + (units ? '\u00A0' + units : ''); };
          this.setState({ confirm: { text: t('sp.confirmChange', { label: label, from: f(big.from), to: f(big.to), pct: pctText(big.pct, env.locale) }),
            value: v.value } });
          return;
        }
        if (cfg.setpoint.confirm === 'always' && s.kind !== 'options' && s.kind !== 'boolean') {
          this.setState({ confirm: { text: t('sp.confirmSet', { label: label, value: shown }), value: v.value } });
          return;
        }
        self._send(v.value);
      }

      _send(value) {
        var self = this;
        var s = this.state;
        var key = JSON.stringify(value);
        var prev = s.lastSent;
        var reuse = prev && prev.key === key ? prev.id : null;
        this.setState({ busy: true, status: { tone: 'busy', text: t('sp.writing') }, confirm: null });
        var req = this.props.submit(value, { display: s.kind === 'options' || s.kind === 'boolean' ? '' : s.text, reuseId: reuse });
        var attempt = req.id ? { key: key, id: req.id } : null;
        this.setState({ lastSent: attempt || prev });         // nothing went out: the remembered id stays
        req.promise.then(function (res) {
          if (!self._alive) return;
          if (res.ok) {
            if (self.props.cfg.setpoint.popup.closeOnSuccess) { self.props.onClose('success'); return; }
            var written = res.data && res.data.written !== undefined ? res.data.written : value;
            var ns = { busy: false, status: { tone: 'ok', text: t('sp.written') }, touched: false, lastSent: null };
            if (self.state.kind === 'int' || self.state.kind === 'float') ns.text = typeof written === 'string' ? written : numEditText(written, self.props.env.locale, isFloat4(self.props.d.snap));
            if (self.state.kind === 'string') ns.text = String(written);
            self.setState(ns);
            NS.a11y.announce(t('sp.written'), 'polite');
            return;
          }
          var err = res.error || {};
          var timeout = err.code === 'CLIENT_TIMEOUT' || err.code === 'TIMEOUT';
          var text = errText(err);
          self.setState({
            busy: false, status: { tone: 'error', text: timeout ? text + ' ' + t('sp.editAgain') : text },
            mustEdit: timeout, invalidFromGateway: /^(OUT_OF_RANGE|INVALID_VALUE|NOT_AN_OPTION|STEP_TOO_LARGE)$/.test(err.code || ''),
            lastSent: requestMemoAfter(prev, attempt, err.code),
          });
          NS.a11y.announce(text, 'assertive');
          self._focusInput();
        });
      }

      _focusInput() {
        var el = this.inputEl;
        if (el && el.focus) { try { el.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
      }

      _onKeyDown(e) {
        var s = this.state;
        if (e.key === 'Enter' && e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) {
          e.preventDefault();
          this._submit();
          return;
        }
        if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && e.target === this.inputEl && (s.kind === 'int' || s.kind === 'float')) {
          e.preventDefault();
          this._spin(e.key === 'ArrowUp' ? 1 : -1);
        }
      }
      _spin(dir) {
        if (this.state.busy) return;
        var nt = stepText(this.state.text, dir, this.props.cfg.setpoint.spinner.increment, this.props.d.snap, this.props.env.locale, this.state.kind);
        if (nt != null) this._setText(nt);
      }

      render() {
        var self = this;
        var p = this.props, s = this.state, cfg = p.cfg, snap = p.d.snap, env = p.env, vm = p.vm, sp = cfg.setpoint;
        var units = unitsText(cfg, snap);
        var title = sp.popup.title || t('sp.title', { label: vm.labelText || vm.tagName });
        var v = this._validate();
        var blocked = this._blocked();
        var showErr = (s.touched || s.invalidFromGateway) && !v.ok ? v.error : '';
        var canWrite = v.ok && !blocked && !s.busy && !s.mustEdit;
        var children = [];

        if (sp.popup.tagPathVisible) children.push(h('div', { key: 'path', className: 'dt-dlg__path' }, p.target.tagPath));

        // current value, live, with a quality badge (or "Not connected")
        var qLevel = p.d.stale ? 'stale' : vm.qLevel === 'error' ? 'bad' : vm.qLevel;
        var qText = p.d.stale ? t('sp.notConnected') : vm.qName || 'Good';
        children.push(h('div', { key: 'cur', className: 'dt-dlg__current' },
          h('span', { className: 'dt-dlg__current-label' }, t('sp.current')),
          h('span', { className: 'dt-dlg__current-value', 'data-dt-current': '1' }, vm.valueText + (vm.unitsText ? '\u00A0' + vm.unitsText : '')),
          h('span', { className: 'dt-dlg__badge' },
            h('span', { className: 'dt-dlg__dot' + (qLevel === 'good' ? '' : ' dt-dlg__dot--' + qLevel), 'aria-hidden': 'true' }), qText)));

        // the control
        var help = [];
        var rt = sp.popup.limitsVisible ? rangeText(cfg, snap, env, units) : '';
        if (rt) help.push(t('sp.range') + ' ' + rt);
        var mx = maxStepOf(cfg, snap);
        if (mx != null) help.push(t('sp.maxStep', { max: fmtExact(mx, cfg, snap, env) + (units ? '\u00A0' + units : '') }));
        var control;
        if (s.kind === 'options' || s.kind === 'boolean') {
          var opts = choiceOptions(cfg, s.kind);
          if (useButtons(cfg, opts.length)) {
            control = h(NS.ui.Choice, {
              id: this.inputId, options: opts, value: s.choice != null && opts[s.choice] ? opts[s.choice].value : undefined,
              ariaLabel: t('sp.new'), onChange: function (val) {
                for (var i = 0; i < opts.length; i++) if (NS.util.looseEqual(opts[i].value, val)) { self._setChoice(i); return; }
              },
            });
          } else {
            control = h('select', {
              id: this.inputId, ref: this._setInput, className: 'ctg-select', value: s.choice == null ? '' : String(s.choice),
              disabled: s.busy, 'aria-invalid': showErr ? 'true' : undefined,
              onChange: function (e) { self._setChoice(e.target.value === '' ? null : Number(e.target.value)); },
            }, [h('option', { key: 'none', value: '', disabled: true }, t('sp.choose'))].concat(opts.map(function (o, i) {
              return h('option', { key: i, value: String(i), disabled: !!o.disabled }, o.label);
            })));
          }
        } else if (s.kind === 'unsupported') {
          control = h('div', { className: 'ctg-status ctg-status--error' }, v.error);
        } else {
          var isNum = s.kind === 'int' || s.kind === 'float';
          var im = isNum ? numericInputMode(s.kind, snap) : { inputMode: 'text', needsSign: false };
          var input = h('input', {
            id: this.inputId, ref: this._setInput, className: 'ctg-input', type: 'text', value: s.text,
            inputMode: im.inputMode, autoComplete: 'off', spellCheck: false, readOnly: s.busy,
            maxLength: s.kind === 'string' ? sp.maxStringLength : undefined, placeholder: sp.placeholder || undefined,
            'aria-invalid': showErr || s.invalidFromGateway ? 'true' : undefined,
            'aria-describedby': [this.helpId, this.statusId].join(' '),
            onChange: function (e) { self._setText(e.target.value); },
          });
          var row = [input];
          if (isNum && sp.spinner.enabled) {
            row.push(h('button', { key: 'dec', type: 'button', className: 'ctg-btn ctg-btn--secondary dt-spin', 'aria-label': t('sp.decrease'),
              disabled: s.busy, onClick: function () { self._spin(-1); } }, '\u2212'));
            row.push(h('button', { key: 'inc', type: 'button', className: 'ctg-btn ctg-btn--secondary dt-spin', 'aria-label': t('sp.increase'),
              disabled: s.busy, onClick: function () { self._spin(1); } }, '+'));
          }
          if (isNum && im.needsSign) {
            row.push(h('button', { key: 'neg', type: 'button', className: 'ctg-btn ctg-btn--secondary dt-spin dt-sign', 'aria-label': t('sp.negate'),
              title: t('sp.negate'), disabled: s.busy, onClick: function () { self._setText(negateText(self.state.text)); self._focusInput(); } }, '\u00B1'));
          }
          if (units && isNum) row.push(h('span', { key: 'u', className: 'dt-dlg__units' }, units));
          control = h('div', { className: 'dt-dlg__inputrow' }, row);
        }
        children.push(h('div', { key: 'field', className: 'ctg-field' },
          h('label', { className: 'ctg-field__label', htmlFor: this.inputId }, t('sp.new')),
          control,
          help.length ? h('div', { className: 'ctg-field__help', id: this.helpId }, help.map(function (x, i) { return h('div', { key: i }, x); })) : null,
          showErr ? h('div', { className: 'ctg-field__error', role: 'alert' }, showErr) : null));

        // status: writing / written / gateway error / why Write is off
        var st = s.status;
        if (!st && blocked) st = { tone: 'error', text: blocked };
        children.push(h('div', { key: 'status', id: this.statusId, className: 'ctg-status dt-dlg__status' + (st ? ' ctg-status--' + st.tone : ''),
          'aria-live': 'polite' }, st ? [st.tone === 'busy' ? h(NS.ui.Spinner, { key: 's' }) : null, h('span', { key: 't' }, ' ' + st.text)] : null));

        var footer = [
          h(NS.ui.Button, { key: 'c', kind: 'secondary', onClick: function () { p.onClose('cancel'); } }, NS.i18n.t('ui.cancel')),
          h(NS.ui.Button, { key: 'w', kind: 'primary', 'data-dt-write': '1', disabled: !canWrite, 'aria-disabled': canWrite ? undefined : 'true',
            onClick: function () { self._submit(); } }, s.busy ? [h(NS.ui.Spinner, { key: 's' }), ' ' + t('sp.writing')] : t('sp.write')),
        ];
        return h(React.Fragment, null,
          h(NS.ui.Dialog, {
            title: title, className: 'dt-dlg dt-dlg--setpoint', busy: s.busy, position: p.position,
            dismissOnBackdrop: sp.popup.dismissOnBackdrop, initialFocus: this._focusInitial, returnFocus: p.returnFocus,
            ariaDescribedBy: this.helpId, footer: footer, onRequestClose: function (reason) { p.onClose(reason); },
            onKeyDown: function (e) { self._onKeyDown(e); },
          }, children),
          s.confirm ? h(NS.ui.Confirm, {
            key: 'confirm', title: t('sp.confirmTitle'), text: s.confirm.text, confirmLabel: t('sp.write'),
            onConfirm: function () {
              var val = self.state.confirm.value;
              self.setState({ confirm: null });
              // the target, permissions or connection may have changed while the Confirm was open: re-check like
              // the inline path does (the status line then shows why Write is off; nothing is sent)
              if (self._blocked() || self.state.busy) { self._focusInput(); return; }
              self._send(val);
            },
            onCancel: function () { if (self._alive) self.setState({ confirm: null }); self._focusInput(); },
          }) : null);
      }
    }

    /* ========================================================================
     * SECTION 8 / DtConfigDialog — "Tag Configuration…"
     * ----------------------------------------------------------------------
     * Edits EngUnit / EngLow / EngHigh of the tag for every user and screen;
     * only changed keys are sent (dt.configEdit). The gateway checks the
     * configEdit gates, the floor policy and the provider's Edit permission;
     * on success it re-reads the meta and pushes it, so the units/limits on
     * screen update by themselves.
     * ====================================================================== */
    function numText(n, locale) { return finite(n) == null ? '' : numEditText(n, locale); }
    class DtConfigDialog extends PC.Component {
      constructor(props) {
        super(props);
        var meta = (props.d.snap && props.d.snap.meta) || {};
        var loc = props.env.locale;
        this.initial = { unit: typeof meta.engUnit === 'string' ? meta.engUnit : '', low: numText(meta.engLow, loc), high: numText(meta.engHigh, loc) };
        this.state = { unit: this.initial.unit, low: this.initial.low, high: this.initial.high, touched: false, busy: false, status: null };
        this.ids = { unit: NS.util.uid('dt-cfg-u'), low: NS.util.uid('dt-cfg-l'), high: NS.util.uid('dt-cfg-h') };
        this._alive = false;
      }
      componentDidMount() { this._alive = true; }
      componentWillUnmount() { this._alive = false; }

      _parse(text) { return NS.format.parseInput(text, 'Float8', this.props.env.locale); }

      /** {errors:{unit,low,high}, changes, error} */
      _validate() {
        var s = this.state, i = this.initial;
        var errors = {};
        var changes = {};
        if (s.unit.length > 64) errors.unit = t('cfg.unitTooLong');
        else if (/[\u0000-\u001f\u007f]/.test(s.unit)) errors.unit = t('cfg.unitControl');
        else if (s.unit !== i.unit) changes.engUnit = s.unit;
        var lo = this._parse(s.low), hi = this._parse(s.high);
        if (!lo.ok) errors.low = lo.error;
        if (!hi.ok) errors.high = hi.error;
        var meta = (this.props.d.snap && this.props.d.snap.meta) || {};
        if (lo.ok && s.low !== i.low) changes.engLow = lo.value;
        if (hi.ok && s.high !== i.high) changes.engHigh = hi.value;
        // numeric equality: "100" and "100.0" are no change
        if (changes.engLow !== undefined && finite(meta.engLow) === changes.engLow) delete changes.engLow;
        if (changes.engHigh !== undefined && finite(meta.engHigh) === changes.engHigh) delete changes.engHigh;
        var error = '';
        var nothing = false;
        if (lo.ok && hi.ok && !errors.low && !errors.high && lo.value >= hi.value) error = t('cfg.lowHigh');
        else if (!Object.keys(errors).length && !Object.keys(changes).length) { error = t('cfg.nothing'); nothing = true; }
        return { errors: errors, changes: changes, error: error, nothing: nothing, ok: !Object.keys(errors).length && !error };
      }
      _blocked() {
        var p = this.props, snap = p.d.snap;
        var cap = snap && snap.capabilities && snap.capabilities.configEdit;
        if (!snap || snap.tagPath !== p.target.tagPath || !p.cfg.enabled || !p.cfg.menu.configEdit.enabled) return t('sp.targetChanged');
        if (p.d.stale) return t('sp.notConnected');
        if (p.env.frameBlocked) return NS.i18n.t('frame.blocked');
        if (cap && !cap.allowed) return cap.reason ? errText(capErr(cap)) : t('menu.loading');
        return '';
      }
      _submit() {
        var self = this;
        if (this.state.busy) return;
        this.setState({ touched: true });
        var v = this._validate();
        if (!v.ok || this._blocked()) return;
        this.setState({ busy: true, status: { tone: 'busy', text: t('cfg.saving') } });
        this.props.submit(v.changes).then(function (res) {
          if (!self._alive) return;
          if (res.ok) { self.props.onClose('success'); return; }
          var err = res.error || {};
          var text = errText(err);
          if (err.code === 'WRITE_FAILED' || err.code === 'EDIT_DENIED') text += ' ' + t('cfg.udtHint');
          self.setState({ busy: false, status: { tone: 'error', text: text } });
          NS.a11y.announce(text, 'assertive');
        });
      }
      render() {
        var self = this;
        var p = this.props, s = this.state, i = this.initial;
        var v = this._validate();
        var blocked = this._blocked();
        var show = s.touched;
        function field(key, labelKey, inputMode) {
          var err = show ? v.errors[key] : '';
          return h(NS.ui.Field, { key: key, id: self.ids[key], label: t(labelKey), error: err,
            help: i[key] !== '' ? t('cfg.was', { value: i[key] }) : null },
          h('input', {
            id: self.ids[key], className: 'ctg-input', type: 'text', value: s[key], inputMode: inputMode, autoComplete: 'off',
            spellCheck: false, readOnly: s.busy, maxLength: key === 'unit' ? 64 : undefined, placeholder: i[key],
            onChange: function (e) { var o = { status: null, touched: true }; o[key] = e.target.value; self.setState(o); },
            onKeyDown: function (e) { if (e.key === 'Enter') { e.preventDefault(); self._submit(); } },
          }));
        }
        var st = s.status || (blocked ? { tone: 'error', text: blocked } : show && v.error ? { tone: v.nothing ? 'busy' : 'error', text: v.error } : null);
        // "nothing changed" keeps Apply clickable: pressing it explains instead of silently doing nothing
        var canApply = (v.ok || v.nothing) && !blocked && !s.busy;
        return h(NS.ui.Dialog, {
          title: t('cfg.title', { label: p.vm.labelText || p.vm.tagName }), className: 'dt-dlg dt-dlg--config', busy: s.busy,
          returnFocus: p.returnFocus, onRequestClose: function (r) { p.onClose(r); },
          footer: [
            h(NS.ui.Button, { key: 'c', kind: 'secondary', onClick: function () { p.onClose('cancel'); } }, NS.i18n.t('ui.cancel')),
            h(NS.ui.Button, { key: 'a', kind: 'primary', 'data-dt-apply': '1', disabled: !canApply, onClick: function () { self._submit(); } },
              s.busy ? [h(NS.ui.Spinner, { key: 's' }), ' ' + t('cfg.saving')] : t('cfg.apply')),
          ],
        },
        h('div', { className: 'dt-dlg__path' }, p.target.tagPath),
        h('div', { className: 'dt-dlg__notice', role: 'note' }, t('cfg.notice')),
        field('unit', 'cfg.engUnit', 'text'),
        field('low', 'cfg.engLow', 'text'),
        field('high', 'cfg.engHigh', 'text'),
        h('div', { className: 'ctg-status dt-dlg__status' + (st ? ' ctg-status--' + st.tone : ''), 'aria-live': 'polite' },
          st ? [st.tone === 'busy' && s.busy ? h(NS.ui.Spinner, { key: 's' }) : null, h('span', { key: 't' }, ' ' + st.text)] : null));
      }
    }

    /* ========================================================================
     * SECTION 9 / DtHistoryDialog — "Change History…"
     * ----------------------------------------------------------------------
     * Read-only table of the newest setpoint writes and configuration edits of
     * this tag, read from the project's audit profile by dt.auditQuery (the
     * gateway re-checks the change-history gate AND the user's Read
     * permission on the tag before querying; rows are newest first, at most
     * menu.changeHistory.limit). Audit values look like
     * "72.5 (was 71.0) [ui=popup] [auditId=…]"; the auditId is moved to the
     * row's tooltip so the table stays readable.
     * ====================================================================== */
    // the auditId suffix is recognised only in the module's own shape (a UUID, as the gateway's anchored
    // AuditQueryService.AUDIT_ID); the row tooltip shows only the gateway-validated r.auditId, never a client parse,
    // so "[auditId=forged]" typed into a String value (or a native tag-write record) is never shown as the id.
    var AUDIT_VALUE_RE = /^([\s\S]*?)(?:\s*\[ui=([^\]]*)\])?(?:\s*\[auditId=([0-9a-fA-F-]{36})(?:, late=true)?\])?\s*$/;
    function splitAuditValue(v) {
      var m = AUDIT_VALUE_RE.exec(String(v == null ? '' : v));
      return { text: m ? m[1] : String(v), ui: m && m[2] ? m[2] : '', auditId: m && m[3] ? m[3] : '' };
    }
    class DtHistoryDialog extends PC.Component {
      constructor(props) {
        super(props);
        this.state = { loading: true, rows: null, error: null };
        this._alive = false;
        this._seq = 0;
      }
      componentDidMount() { this._alive = true; this._load(); }
      componentWillUnmount() { this._alive = false; }
      _load() {
        var self = this;
        var seq = ++this._seq;
        this.setState({ loading: true, error: null });
        this.props.query().then(function (res) {
          if (!self._alive || seq !== self._seq) return;
          if (res.ok) self.setState({ loading: false, rows: (res.data && Array.isArray(res.data.rows)) ? res.data.rows : [] });
          else self.setState({ loading: false, error: errText(res.error), rows: null });
        });
      }
      render() {
        var self = this;
        var p = this.props, s = this.state;
        var tz = p.env.timeZone;
        var body;
        if (s.loading && !s.rows) body = h('div', { className: 'ctg-status ctg-status--busy', 'aria-live': 'polite' }, h(NS.ui.Spinner, null), ' ' + t('hist.loading'));
        else if (s.error) body = h('div', { className: 'ctg-status ctg-status--error', role: 'alert' }, s.error);
        else if (!s.rows.length) body = h('div', { className: 'ctg-status' }, t('hist.empty'));
        else {
          body = h('div', { className: 'dt-hist__wrap' }, h('table', { className: 'dt-hist' },
            h('thead', null, h('tr', null,
              h('th', { scope: 'col' }, t('hist.time')), h('th', { scope: 'col' }, t('hist.user')),
              h('th', { scope: 'col' }, t('hist.change')), h('th', { scope: 'col' }, t('hist.result')))),
            h('tbody', null, s.rows.map(function (r, i) {
              var parts = splitAuditValue(r.value);
              var status = String(r.status || '').toLowerCase();
              var res = status === 'good' ? 'ok' : status === 'uncertain' ? 'uncertain' : 'bad';
              var what = /edit/i.test(String(r.action || '')) ? t('hist.edit') : t('hist.write');
              return h('tr', { key: i, title: r.auditId ? 'auditId ' + r.auditId : undefined },
                h('td', { className: 'dt-hist__time' }, NS.util.isFiniteNum(r.t) ? NS.time.format(r.t, 'YYYY-MM-DD HH:mm:ss', tz) : ''),
                h('td', null, String(r.user == null ? '' : r.user)),
                h('td', null, h('div', null, parts.text), h('div', { className: 'dt-hist__muted' }, what + (parts.ui ? ' \u00B7 ' + parts.ui : ''))),
                h('td', { className: 'dt-hist__res--' + res }, t('hist.' + res)));
            }))));
        }
        return h(NS.ui.Dialog, {
          title: t('hist.title', { label: p.vm.labelText || p.vm.tagName }), className: 'dt-dlg dt-dlg--history',
          width: 'min(640px, calc(100vw - 32px))', busy: s.loading, returnFocus: p.returnFocus,
          onRequestClose: function (r) { p.onClose(r); },
          footer: [
            h(NS.ui.Button, { key: 'r', kind: 'secondary', disabled: s.loading, onClick: function () { self._load(); } }, t('hist.refresh')),
            h(NS.ui.Button, { key: 'c', kind: 'primary', onClick: function () { p.onClose('close'); } }, NS.i18n.t('ui.close')),
          ],
        },
        h('div', { className: 'dt-dlg__path' }, p.target.tagPath + ' \u00B7 ' + t('hist.limit', { n: p.cfg.menu.changeHistory.limit })),
        body);
      }
    }

    /* ========================================================================
     * SECTION 10 / DisplayTemplate — the component
     * ----------------------------------------------------------------------
     * Interaction state machine:
     *   IDLE ─click/Enter (popup) or Set Value…──► DIALOG ─Write─► (writing) ─ok─► IDLE + flash
     *     ├─focus (direct) / dblclick, F2, 1 s mouse hold, double-tap (protected)─► EDITING ─Enter─► writing
     *     ├─right-click / long-press / Shift+F10 / ContextMenu key──► MENU ──select──► action
     *     └─Tag Configuration… / Change History…──► dialog
     * Every entry is guarded by eventsEnabled && enabled && !STALE (+ the
     * write guard for editing); a failing guard with whenNotAllowed:"disable"
     * explains itself in a bubble instead. Writes are owned here (not by the
     * dialog), so a write in flight survives Cancel and its result still shows
     * on the value (flash, or bubble + dt--write-failed).
     * Root DOM events come through this.props.domEvents.addListener (keeps
     * Perspective's own handlers and user-configured DOM events); our
     * React handlers live on the inner value element only.
     * ====================================================================== */

    /* ---- one page-wide session-props watch (locale / time zone) ------------ */
    var sw = { sp: null, off: null, val: null, store: null, listeners: [] };
    function sessionPropsOf(store) {
      try { if (store && store.view && store.view.page && store.view.page.sessionProps) return store.view.page.sessionProps; } catch (e) { /* ignore */ }
      var c = window.__client;
      return c && c.page && c.page.sessionProps ? c.page.sessionProps : null;
    }
    function readSessionEnv(store) {
      return { locale: NS.format.locale(store), timeZone: NS.time.resolveZone('session', store) };
    }
    function sessionEnv(store) {
      var sp = sessionPropsOf(store);
      if (sp && sp !== sw.sp && typeof sp.subscribe === 'function') {
        if (sw.off) { try { sw.off(); } catch (e) { /* ignore */ } }
        sw.sp = sp;
        sw.store = store;
        try {
          var off = sp.subscribe(function () {
            var next = readSessionEnv(sw.store);
            if (!sw.val || next.locale !== sw.val.locale || next.timeZone !== sw.val.timeZone) {
              sw.val = next;
              sw.listeners.slice().forEach(function (fn) { try { fn(next); } catch (e) { log.warn('session listener failed', e); } });
            }
          });
          sw.off = typeof off === 'function' ? off : null;
        } catch (e) { log.debug('session props subscription unavailable', e); }
        sw.val = readSessionEnv(store);
      }
      if (!sw.val) sw.val = readSessionEnv(store);
      return sw.val;
    }
    function onSessionEnv(fn) {
      sw.listeners.push(fn);
      return function () { var i = sw.listeners.indexOf(fn); if (i >= 0) sw.listeners.splice(i, 1); };
    }

    /** Perspective's auth status of this client (advisory checks for custom items, F-05b). */
    function clientUser(store) {
      var c = NS.nav.client(store);
      var ws = c && c.auth && c.auth.webAuthStatus;
      if (!ws) return { authenticated: false, roles: [], levels: [] };
      var roles = ws.user && ws.user.roles ? Array.prototype.slice.call(ws.user.roles).map(String) : [];
      return { authenticated: !!ws.authenticated, roles: roles, levels: levelPaths(ws.securityLevels ? Array.prototype.slice.call(ws.securityLevels) : [], '', []) };
    }

    var v1Warned = {};
    /** Page-wide newest successful write per tag (normKey → token): a later write supersedes an older read-back check. */
    var lastVerify = {};
    var verifySeq = 0;
    var FLASH_MS = 1200;
    var DOUBLE_TAP_MS = 300;
    var DOUBLE_TAP_PX = 10;
    var MOUSE_HOLD_MS = 1000;     // protected mode: Numeric Entry Field parity
    var TAP_MOVE_PX = 8;

    class DisplayTemplate extends PC.Component {
      constructor(props) {
        super(props);
        this.state = {
          menu: null, dialog: null, edit: null, confirm: null, bubble: null, flash: null, busyItems: {}, writing: false,
          fontSizes: null, sessionRev: 0,
        };
        this.rootEl = null;
        this.valueEl = null;
        this.inputEl = null;
        this._mounted = false;
        this._timers = new Set();
        this._writing = 0;
        this._bubbleN = 0;
        this._dialogN = 0;
        this._verify = null;
        this._lastTap = null;
        this._hold = null;
        this._emitRef = null;
        this._lpDispose = null;
        this._lpMs = 0;
        this._roDispose = null;
        var self = this;
        this._setRoot = function (el) {
          if (self._emitRef) { try { self._emitRef(el); } catch (e) { /* Perspective ref */ } }
          if (el === self.rootEl) return;
          self.rootEl = el;
          self._bindRoot();
        };
        this._setValue = function (el) { self.valueEl = el; };
        this._setInput = function (el) { self.inputEl = el; };
        this._onContextMenu = this._onContextMenu.bind(this);
        this._onRootKeyDown = this._onRootKeyDown.bind(this);
      }

      // ---- lifecycle ---------------------------------------------------------------------------------------------
      componentDidMount() {
        var self = this;
        this._mounted = true;
        ensureDtStyles();
        var d = this._d();
        if (d && d.attach) d.attach();
        var de = this.props.domEvents;
        this._offCtx = de && de.addListener ? de.addListener('onContextMenu', this._onContextMenu) : null;
        this._offKey = de && de.addListener ? de.addListener('onKeyDown', this._onRootKeyDown) : null;
        sessionEnv(this.props.store);
        this._offSession = onSessionEnv(function () { if (self._mounted) self.setState(function (s) { return { sessionRev: s.sessionRev + 1 }; }); });
        this._bindRoot();
        this._warnV1();
      }

      componentDidUpdate(prevProps) {
        var p = this.props;
        var cfg = p.props;
        var pd = prevProps.delegate || {};
        var d = p.delegate || {};
        // eventsEnabled / enabled / menu turning off: close everything the user had open
        var canNow = NS.events.canInteract(p) && cfg.enabled;
        if (!canNow && (this.state.menu || this.state.dialog || this.state.edit || this.state.confirm)) {
          this.setState({ menu: null, dialog: null, edit: null, confirm: null });
        } else if (this.state.menu && !cfg.menu.enabled) {
          this.setState({ menu: null });
        }
        if (prevProps.props !== cfg) { this._bindRoot(); this._warnV1(); }
        // inline edit: the target gone underneath → cancel. An advisory guard that turns off
        // (a Bad-quality dip, a capability reload, a frame block…) does not throw the typed text away with the
        // dialog's "close and try again" wording: the editor stays, marked blocked with the real reason, and a commit
        // is refused with it until the guard clears.
        var e = this.state.edit;
        if (e && !e.busy) {
          var g = writeGuard(cfg, d, this._env());
          var snap = d.snap;
          var blocked = !g.allowed && g.code && g.code !== 'STALE' ? (g.text || errText({ code: g.code })) : null;
          if (!snap || snap.tagPath !== e.target.tagPath || !cfg.setpoint.enabled || (!g.allowed && !g.code)) {
            this.setState({ edit: null, confirm: null });
            this._bubble(t('sp.editTargetChanged'), 'error');
            e = null;
          } else if ((e.blocked || null) !== blocked) {
            e = Object.assign({}, e, { blocked: blocked });
            this.setState({ edit: e });
            if (blocked) this._bubble(blocked, 'warn');
          }
        }
        if (e && !e.busy) {
          if (d.valueSeq !== pd.valueSeq) {
            var env = this._env();
            var txt = resolve(cfg, d, env).valueText;
            // Live updates never overwrite what the operator is working with — with ONE narrow
            // exception: a text editor that is untouched AND still has its whole text selected
            // (the state edit mode opens in) takes the live value, so the first keystroke / ArrowUp never starts
            // from a value the tag no longer has. Placing the caret, selecting part of the text or typing ends
            // the exception; <select> editors never follow. Otherwise only the "Current value changed" hint.
            var el = this.inputEl;
            var focused = !!(el && document.activeElement === el);
            var allSelected = !!(focused && el.value && el.selectionStart === 0 && el.selectionEnd === el.value.length);
            var follow = e.text !== undefined && e.text === e.initial && (allSelected || !el);
            if (follow) {
              var ne = Object.assign({}, e, { shownText: txt });
              ne.text = editText(snap, env.locale); ne.initial = ne.text;
              var self2 = this;
              if (ne.text !== e.text) this.setState({ edit: ne }, function () { if (allSelected) self2._focusEditor(true); });
              else if (txt !== e.shownText) this.setState({ edit: ne });
            } else if (txt !== e.shownText) {
              this.setState({ edit: Object.assign({}, e, { shownText: txt }) });
              this._bubble(t('bubble.currentChanged', { value: txt + (unitsText(cfg, snap) ? '\u00A0' + unitsText(cfg, snap) : '') }), 'info', 4000);
            }
          }
        }
      }

      componentWillUnmount() {
        this._mounted = false;
        if (this._offCtx) this._offCtx();
        if (this._offKey) this._offKey();
        if (this._offSession) this._offSession();
        if (this._lpDispose) this._lpDispose();
        if (this._roDispose) this._roDispose();
        this._clearHold();
        this._clearVerify();
        this._timers.forEach(function (tm) { clearTimeout(tm); });
        this._timers.clear();
        var d = this._d();
        if (d && d.detach) d.detach();
      }

      // ---- helpers -----------------------------------------------------------------------------------------------
      _d() { return this.props.store && this.props.store.delegate; }
      /**
       * Portal events stay out of the designer's DOM-event scripts. Our menu / dialogs / bubbles render
       * through NS.ui.Portal into document.body, and React bubbles portal events through the React tree to this
       * root, where Perspective's emitted handlers (events.dom.onMouseOver, onKeyPress, …) live. ctg-common's
       * portal guard stops only part of the bubbling events, so every on* handler emitted for the root
       * ignores an event whose target is outside the root's own DOM subtree. Wrappers are cached per handler so
       * React does not see a new function on every render.
       */
      _guardRootHandlers(rootProps) {
        var self = this;
        var cache = this._handlerCache || (this._handlerCache = {});
        Object.keys(rootProps).forEach(function (k) {
          var fn = rootProps[k];
          if (typeof fn !== 'function' || !/^on[A-Z]/.test(k)) return;
          var c = cache[k];
          if (!c || c.orig !== fn) {
            c = cache[k] = { orig: fn, wrapped: null };
            var entry = c;
            entry.wrapped = function (e) {
              var root = self.rootEl;
              var tg = e && e.target;
              if (root && tg && typeof tg.nodeType === 'number' && tg !== root && !root.contains(tg)) return undefined;
              return entry.orig.apply(this, arguments);
            };
          }
          rootProps[k] = c.wrapped;
        });
      }
      _later(fn, ms) {
        var self = this;
        var tm = setTimeout(function () { self._timers.delete(tm); if (self._mounted) fn(); }, ms);
        this._timers.add(tm);
        return tm;
      }
      _env() {
        var p = this.props;
        var se = sw.val || readSessionEnv(p.store);
        var d = this._d();
        return {
          locale: se.locale, timeZone: se.timeZone, canInteract: NS.events.canInteract(p), designMode: p.eventsEnabled === false,
          designer: NS.nav.isDesigner(p.store), frameBlocked: !!(d && d.frameBlocked && d.frameBlocked()),
        };
      }
      _warnV1() {
        var keys = this.props.props.v1Keys;
        if (!keys || !keys.length) return;
        var view = '';
        try { view = String(this.props.store.view.resourcePath || ''); } catch (e) { /* ignore */ }
        if (v1Warned[view]) return;
        v1Warned[view] = true;
        log.warn(t('dt.v1Warn', { keys: keys.join(', ') }), view ? '(view ' + view + ')' : '');
      }
      /** Long-press (touch/pen menu) and the auto font size observer follow the root element and the props. */
      _bindRoot() {
        var self = this;
        var cfg = this.props.props;
        var el = this.rootEl;
        var wantLp = !!el && cfg.menu.enabled && cfg.enabled && NS.events.canInteract(this.props);
        if (this._lpDispose && (!wantLp || this._lpEl !== el || this._lpMs !== cfg.menu.longPressMs)) { this._lpDispose(); this._lpDispose = null; }
        if (wantLp && !this._lpDispose) {
          this._lpEl = el;
          this._lpMs = cfg.menu.longPressMs;
          this._lpDispose = NS.ui.longPress(el, { ms: cfg.menu.longPressMs, onLongPress: function (pt) { self._clearHold(); self._openMenu(pt.x, pt.y, false); } });
        }
        var wantRo = !!el && cfg.layout.autoFontSize.enabled;
        if (this._roDispose && (!wantRo || this._roEl !== el)) { this._roDispose(); this._roDispose = null; }
        if (wantRo && !this._roDispose) {
          this._roEl = el;
          this._roDispose = NS.resize.observe(el, function (r) { self._onResize(r); });
        }
        if (!wantRo && this.state.fontSizes) this.setState({ fontSizes: null });
        // a class change does not resize the box: re-decide auto sizing against the new root font.
        // The same for the autoFontSize settings and the root style. A view is static at runtime, but in
        // the Designer these props change while the box keeps its size, and the old sizes would stay until a resize.
        var cls = JSON.stringify([(cfg.style && cfg.style.classes) || '', cfg.layout.autoFontSize, cfg.style || null]);
        if (wantRo && this._roRect && cls !== this._roClasses) { this._roClasses = cls; this._onResize(this._roRect); }
        else this._roClasses = cls;
      }
      /** Auto font size (v1 formula): clamp(floor(min(w, h) × scale), min, max), published as CSS variables. */
      _onResize(rect) {
        if (!this._mounted) return;
        var a = this.props.props.layout.autoFontSize;
        // the component's own box (what the Designer sizes), i.e. the content box plus the root padding
        var w = rect.width, hh = rect.height;
        try {
          var cs = window.getComputedStyle(this.rootEl);
          w += (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
          hh += (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        } catch (e) { /* keep the content box */ }
        var base = Math.min(w, hh);
        if (!(base > 0)) return;
        this._roRect = rect;
        // a root font-size from a style class or project CSS (anything but the module default
        // --dt-font-size) is an explicit choice like an inline style.fontSize: auto sizing steps aside, and the
        // em-relative label/value defaults follow the root.
        if (rootFontIsExplicit(this.rootEl)) {
          if (this.state.fontSizes) this.setState({ fontSizes: null });
          return;
        }
        var fs = {
          label: NS.util.clamp(Math.floor(base * a.labelScale), a.min, a.max),
          value: NS.util.clamp(Math.floor(base * a.valueScale), a.min, a.max),
        };
        var cur = this.state.fontSizes;
        if (!cur || cur.label !== fs.label || cur.value !== fs.value) this.setState({ fontSizes: fs });
      }
      _rect(el) {
        var r = (el || this.valueEl || this.rootEl);
        return r && r.getBoundingClientRect ? r.getBoundingClientRect() : null;
      }
      _bubble(text, tone, durationMs) {
        if (!text) return;
        this._bubbleN++;
        this.setState({ bubble: { text: text, tone: tone || 'info', key: this._bubbleN, anchorRect: this._rect(), durationMs: durationMs } });
      }
      _flash(kind) {
        var self = this;
        if (this._flashTimer) { clearTimeout(this._flashTimer); this._timers.delete(this._flashTimer); }
        this.setState({ flash: null }, function () {
          if (!self._mounted) return;
          self.setState({ flash: kind });
          self._flashTimer = self._later(function () { self.setState({ flash: null }); }, FLASH_MS);
        });
      }
      _guard() { return writeGuard(this.props.props, this.props.delegate || {}, this._env()); }
      /** A failing guard explains itself (whenNotAllowed 'disable'); returns true when the action may go on. */
      _checkGuard() {
        var g = this._guard();
        if (g.preview) return false;                          // design mode: the look of runtime, never an action
        if (g.allowed) return true;
        if (g.show && g.text) this._bubble(g.text, 'error');
        return false;
      }

      // ---- menu --------------------------------------------------------------------------------------------------
      _menuAllowed() {
        var cfg = this.props.props;
        if (!NS.events.canInteract(this.props) || !cfg.enabled || !cfg.menu.enabled) return false;
        try { if (this.props.store.meta.readBoolean('contextMenu.enabled', false)) return false; } catch (e) { /* no meta */ }
        return true;
      }
      _menuModel() {
        var cfg = this.props.props;
        var d = this.props.delegate || {};
        var env = this._env();
        return menuModel(cfg, d.snap, {
          stale: d.stale, staleReason: d.staleReason, frameBlocked: env.frameBlocked, guard: writeGuard(cfg, d, env),
          user: clientUser(this.props.store), busy: this.state.busyItems,
        });
      }
      _onContextMenu(e) {
        if (!this._menuAllowed()) return;                     // the native menu (or Perspective's) stays untouched
        if (e && e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) && !this._ownIdleInput(e.target)) return;   // text editing menu while typing
        if (!this._menuModel().items.length) return;
        e.preventDefault();
        e.stopPropagation();
        this._clearHold();
        this._openMenu(e.clientX, e.clientY, false);
      }
      /**
       * The direct-mode value IS an input (read-only while idle), so a right-click on the value would never
       * reach the display menu (the browser's Cut/Copy/Paste menu would show instead). Our own input counts as the value
       * while it is idle or the editor is untouched (an edit the operator has not typed in yet); the native menu
       * only while the operator is actually editing text.
       */
      _ownIdleInput(target) {
        if (!target || target !== this.inputEl) return false;
        var ed = this.state.edit;
        if (!ed) return true;
        if (ed.kind === 'options' || ed.kind === 'boolean') return false;
        if (ed.touched || ed.text !== ed.initial) return false;
        this._cancelEdit(false);                              // the edit the right button's focus just opened
        return true;
      }
      _onRootKeyDown(e) {
        if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
          if (!this._menuAllowed() || !this._menuModel().items.length) return;
          // like a right-click, the menu key leaves an inline edit the operator typed in to the input
          // (moving focus into the display menu would commit it under commitOnBlur, or throw it away)
          if (e.target && e.target === this.inputEl && this.state.edit && !this._ownIdleInput(e.target)) return;
          e.preventDefault();
          e.stopPropagation();
          var r = this._rect();
          this._openMenu(r ? r.left : 0, r ? r.bottom : 0, true);
        }
      }
      _openMenu(x, y, keyboard) {
        if (!this._menuAllowed()) return;
        this._menuPoint = { x: x, y: y };
        this.setState({ menu: { x: x, y: y, keyboard: !!keyboard, key: Date.now() }, bubble: null });
      }
      _closeMenu() { this._quietFocus(); if (this._mounted) this.setState({ menu: null, busyItems: {} }); }
      /**
       * A menu or dialog closing gives focus back to the idle direct input (the value wrapper is not
       * focusable in direct mode, so focus would fall to <body>); that returning focus must not begin an edit.
       */
      _quietFocus() { this._quietFocusUntil = Date.now() + 1000; }
      /** Where a closing menu / dialog returns focus: the idle direct input, else the value element. */
      _returnFocusEl() {
        var el = this.inputEl;
        // (by the element, not its readOnly: the menu renders before the cancelled edit's input is committed read-only)
        if (this.props.props.setpoint.mode === 'direct' && el && el.tagName === 'INPUT' && el.isConnected !== false) return el;
        return this.valueEl || undefined;
      }

      _onMenuSelect(item) {
        switch (item.kind) {
          case 'trend': this._trend(item); break;
          case 'trendPage': this._trendPage(); break;
          case 'trendPopup': this._trendPopup(); break;
          case 'setValue': this._openDialog('setpoint'); break;
          case 'configEdit': this._openDialog('config'); break;
          case 'changeHistory': this._openDialog('history'); break;
          case 'copyPath': this._copyPath(); break;
          case 'custom': this._fireMenuAction(item.data.action); break;
          default: break;
        }
      }

      /** Trend Tag / Remove from Trend: the item spins until the reply; the result arrives as a push (all tabs). */
      _trend(item) {
        var self = this;
        var d = this._d();
        var snap = this.props.delegate && this.props.delegate.snap;
        if (!d || !snap) return;
        var remove = !!(item.data && item.data.remove);
        var busy = {}; busy[item.id] = true;
        this.setState({ busyItems: busy });
        (remove ? d.trendRemove(snap.tagPath) : d.trendAdd(snap.tagPath)).then(function (res) {
          if (!self._mounted) return;
          self.setState({ menu: null, busyItems: {} });
          if (res.ok) self._bubble(t(remove ? 'bubble.removed' : 'bubble.added'), 'ok', 2500);
          else if (res.error && res.error.code !== 'DETACHED') self._bubble(errText(res.error), 'error');
        });
      }
      /** Adds the tag to the trend list first when asked and allowed; resolves either way (errors only bubble). */
      _maybeAddToTrend(addTag) {
        var self = this;
        var d = this._d();
        var snap = this.props.delegate && this.props.delegate.snap;
        var caps = snap && snap.capabilities;
        if (!addTag || !d || !snap || !caps || !caps.trend || !caps.trend.allowed || (snap.trend && snap.trend.trending) || !this.props.props.menu.trend.enabled) {
          return Promise.resolve(null);
        }
        return d.trendAdd(snap.tagPath).then(function (res) {
          if (self._mounted && !res.ok && res.error && res.error.code !== 'DETACHED') self._bubble(errText(res.error), 'error');
          return res;
        });
      }
      _vars() {
        var cfg = this.props.props;
        var snap = this.props.delegate && this.props.delegate.snap;
        return { tagPath: (snap && snap.tagPath) || cfg.tagPathTrimmed, tagName: (snap && snap.tagName) || NS.util.shortTagName(cfg.tagPathTrimmed),
          trendGroup: cfg.trendGroup };
      }
      _fireMenuAction(action) {
        var v = this._vars();
        NS.events.fire(this.props, 'onMenuAction', { action: action, tagPath: v.tagPath, tagName: v.tagName, trendGroup: v.trendGroup });
      }
      /** "Go to Trend Page": optional trendAdd, then same-origin page navigation, then the event. */
      _trendPage() {
        var self = this;
        var tp = this.props.props.menu.trendPage;
        var v = this._vars();
        var path = tp.pagePath ? NS.util.interpolate(tp.pagePath, v, true) : '';
        if (path && (!NS.nav.isPagePath(tp.pagePath) || !NS.nav.isPagePath(path))) {     // same-origin page paths only: ^/(?!/)
          this._bubble(t('bubble.invalidPage'), 'error');
          return;
        }
        this._maybeAddToTrend(tp.addTag).then(function () {
          if (!self._mounted) return;
          if (path) {
            var r = NS.nav.navigate(self.props.store, { path: path, newTab: tp.newTab });
            if (!r.ok && r.error !== 'DESIGNER') self._bubble(t('bubble.invalidPage'), 'error');
          }
          self._fireMenuAction('trendPage');
        });
      }
      /** "Open Trend Popup" (trendList / singleTag modes): one popup per trend group, focused when already open. */
      _trendPopup() {
        var self = this;
        var tp = this.props.props.menu.trendPopup;
        var v = this._vars();
        var single = tp.mode === 'singleTag';
        var pt = this._menuPoint || { x: 0, y: 0 };
        this._maybeAddToTrend(!single && tp.addTag).then(function () {
          if (!self._mounted) return;
          if (tp.viewPath) {
            var vp = NS.ui.viewport();
            var w = Math.min(tp.popup.width, vp.width - 16), hh = Math.min(tp.popup.height, vp.height - 16);
            var left = tp.popup.position === 'pointer' ? pt.x : vp.left + (vp.width - w) / 2;
            var top = tp.popup.position === 'pointer' ? pt.y : vp.top + (vp.height - hh) / 2;
            left = NS.util.clamp(left, vp.left + 8, Math.max(vp.left + 8, vp.left + vp.width - w - 8));
            top = NS.util.clamp(top, vp.top + 8, Math.max(vp.top + 8, vp.top + vp.height - hh - 8));
            var params = Object.assign({}, tp.params, { tagPath: v.tagPath, tagName: v.tagName, trendGroup: v.trendGroup,
              mode: tp.mode });
            var r = NS.nav.openPopup(self.props.store, {
              id: trendPopupId(tp, v), viewPath: tp.viewPath, params: params,
              title: tp.title || t('trend.popupTitle', { label: self.props.props.label.text || v.tagName }),
              showCloseIcon: tp.popup.showCloseIcon, draggable: tp.popup.draggable, resizable: tp.popup.resizable,
              modal: tp.popup.modal, overlayDismiss: tp.popup.overlayDismiss, viewportBound: tp.popup.viewportBound,
              position: { left: Math.round(left), top: Math.round(top), width: Math.round(w), height: Math.round(hh) },
            });
            if (!r.ok) self._bubble(t('bubble.popupFailed'), 'error');
          }
          self._fireMenuAction('trendPopup');
        });
      }
      /** Copy Tag Path: copies synchronously inside the click (no await before the copy: it needs the user gesture). */
      _copyPath() {
        var self = this;
        var text = this._vars().tagPath;
        var ok = false;
        try {
          if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext !== false) {
            navigator.clipboard.writeText(text).then(function () { if (self._mounted) self._bubble(t('bubble.copied'), 'ok', 2000); },
              function () { if (self._mounted) self._bubble(copyFallback(text) ? t('bubble.copied') : t('bubble.copyFailed'), 'info', 2500); });
            ok = null;
          } else ok = copyFallback(text);
        } catch (e) { ok = copyFallback(text); }
        if (ok !== null) this._bubble(ok ? t('bubble.copied') : t('bubble.copyFailed'), ok ? 'ok' : 'error', 2000);
        this._fireMenuAction('copyPath');
      }

      // ---- dialogs -----------------------------------------------------------------------------------------------
      _openDialog(kind) {
        var d = this.props.delegate || {};
        var snap = d.snap;
        if (!snap) return;
        if (kind === 'setpoint' && !this._checkGuard()) return;
        var cfg = this.props.props;
        var pos = kind === 'setpoint' && cfg.setpoint.popup.position === 'anchored' ? { anchorRect: this._rect() } : 'center';
        this._dialogN++;
        this.setState({ menu: null, edit: null, dialog: { kind: kind, id: this._dialogN, target: { tagPath: snap.tagPath, tagName: snap.tagName },
          position: pos } });
      }
      _closeDialog() { this._quietFocus(); if (this._mounted) this.setState({ dialog: null }); }

      // ---- writes ------------------------------------------------------------------------------------------------
      /**
       * The one write path of the component. opts = {target, ui, display, reuseId, source:'dialog'|'inline', dialogId}.
       * Returns {promise, id}. Success → flash + read-back check; a failure is shown here only when its dialog
       * is gone (the dialog / inline editor shows its own errors).
       */
      _write(value, opts) {
        var self = this;
        var d = this._d();
        var r = d.write(opts.target.tagPath, value, { ui: opts.ui, display: opts.display, reuseId: opts.reuseId });
        this._writing++;
        this.setState({ writing: true });
        r.promise.then(function (res) {
          self._writing--;
          if (!self._mounted) return;
          self.setState({ writing: self._writing > 0 });
          if (res.ok) {
            self._flash('ok');
            self._startVerify(value, res.data, opts.target);
            return;
          }
          var err = res.error || {};
          if (err.code === 'DETACHED') return;
          var dialogGone = opts.source === 'dialog' && !(self.state.dialog && self.state.dialog.id === opts.dialogId);
          if (dialogGone) {
            // a timeout proves nothing was refused — the value may well have been written. No
            // "Not written:" prefix and no failure flash for it: the outcome-unknown text, in the warning tone.
            if (outcomeUnknown(err.code)) {
              self._bubble(errText(err), 'warn', 10000);
              return;
            }
            self._flash('failed');
            self._bubble(t('bubble.writeFailed', { message: errText(err) }), 'error');
          }
        });
        return r;
      }
      /**
       * Read-back check: warn when the tag does not hold the written value verifyMs after the reply.
       * The check runs at the END of the window, not on the first matching push: a device that accepts a
       * value and snaps back (PLC clamp, interlock, a script resetting it) shows the written value for a
       * moment, and that brief match must not hide the fact that the value did not stick.
       * A later successful write of the same tag from this page (another display, the same operator) supersedes
       * the check: the value then differs on purpose and a warning would only be noise.
       */
      _startVerify(value, data, target) {
        var self = this;
        var ms = this.props.props.setpoint.verifyMs;
        this._clearVerify();
        var key = NS.util.normKey(target.tagPath);
        // with verifyMs 0 there is no check of our own, but the write still supersedes any pending check of
        // the same tag: removing the entry does that (a pending token no longer matches) without leaving one
        if (!ms) { delete lastVerify[key]; return; }
        var token = ++verifySeq;
        lastVerify[key] = token;
        var written = data && data.written !== undefined ? data.written : value;
        this._verify = { value: written, tagPath: target.tagPath, key: key, token: token };
        this._verifyTimer = this._later(function () {
          if (!self._verify) return;
          var superseded = lastVerify[key] !== token;
          if (!superseded) delete lastVerify[key];
          var stillSame = self.props.delegate && self.props.delegate.snap && self.props.delegate.snap.tagPath === self._verify.tagPath;
          if (stillSame && !superseded && !self._verifyMatches()) {
            var vm = resolve(self.props.props, self.props.delegate, self._env());
            self._bubble(t('bubble.readBack', { value: vm.valueText + (vm.unitsText ? '\u00A0' + vm.unitsText : '') }), 'warn', 8000);
          }
          self._verify = null;
        }, ms);
      }
      _clearVerify() {
        // our pending check is cancelled (new write, unmount): drop its page-wide entry unless a newer write owns it
        var vf = this._verify;
        if (vf && lastVerify[vf.key] === vf.token) delete lastVerify[vf.key];
        this._verify = null;
        if (this._verifyTimer) { clearTimeout(this._verifyTimer); this._timers.delete(this._verifyTimer); this._verifyTimer = null; }
      }
      _verifyMatches() {
        var vf = this._verify;
        var snap = this.props.delegate && this.props.delegate.snap;
        var cur = snap && snap.value;
        if (!vf || !cur) return false;
        var w = vf.value;
        if (cur.bigint || typeof w === 'string' && /^[+-]?\d+$/.test(w)) return String(cur.v) === String(w);
        if (typeof w === 'number' && typeof cur.v === 'number') {
          return Math.abs(cur.v - w) <= displayTolerance(w, valuePattern(this.props.props, snap));
        }
        if (typeof w === 'string' && typeof cur.v === 'string') return w === cur.v;
        return NS.util.looseEqual(w, cur.v);
      }

      // ---- inline editing (direct / protected) ---------------------------------------------------------------------
      _beginEdit(seed) {
        if (this.state.edit || this.state.dialog) return;
        if (!this._checkGuard()) return;
        var cfg = this.props.props;
        var d = this.props.delegate || {};
        var snap = d.snap;
        var env = this._env();
        var g = this._guard();
        var e = { kind: g.kind, target: { tagPath: snap.tagPath, tagName: snap.tagName }, busy: false, invalid: false,
          shownText: resolve(cfg, d, env).valueText };
        if (g.kind === 'options' || g.kind === 'boolean') {
          e.choice = choiceIndex(cfg, g.kind, snap);
          e.initialChoice = e.choice;
        } else {
          e.text = editText(snap, env.locale);
          e.initial = e.text;
          // a printable key on the focused idle direct input starts the edit with that key
          if (typeof seed === 'string' && seed !== '') { e.text = seed; e.touched = true; }
        }
        var self = this;
        var seeded = typeof seed === 'string' && seed !== '' && e.text === seed;
        this.setState({ edit: e, bubble: null }, function () { self._focusEditor(!seeded, seeded); });
      }
      /**
       * Whether `value` (parsed) / the edit's choice is what the tag holds NOW. "Nothing to write" is
       * decided against the live value, not the text the editor opened with: after "Current value changed to 55",
       * confirming the 50 still in the editor writes 50 instead of closing the editor and writing nothing.
       */
      _sameAsLive(ed, value) {
        var cfg = this.props.props;
        var snap = this.props.delegate && this.props.delegate.snap;
        var cur = snap && snap.value;
        if (!cur || cur.v == null) return false;
        if (ed.kind === 'options' || ed.kind === 'boolean') return ed.choice >= 0 && choiceIndex(cfg, ed.kind, snap) === ed.choice;
        if (ed.kind === 'string') return !cur.truncated && typeof cur.v === 'string' && String(value) === cur.v;
        if (cur.bigint || typeof value === 'string') return String(cur.v) === String(value);
        var n = currentNumber(snap);
        return n != null && Number(value) === n;
      }
      /** After the inline editor closed by a commit: the value element gets focus back (as Escape does). */
      _refocusValue(had) {
        var self = this;
        if (!had || this.props.props.setpoint.mode === 'direct') return;   // direct: the same input stays mounted
        this._later(function () {
          var a = typeof document !== 'undefined' ? document.activeElement : null;
          if (a && a !== document.body && a.isConnected !== false) return;  // the operator moved on meanwhile
          if (self.valueEl && self.valueEl.focus) { try { self.valueEl.focus({ preventScroll: true }); } catch (err) { /* ignore */ } }
        }, 0);
      }
      _focusEditor(select, caretEnd) {
        var el = this.inputEl;
        if (!el || !el.focus) return;
        try { el.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
        if (select && el.select) { try { el.select(); } catch (err) { /* ignore */ } }
        else if (caretEnd && el.setSelectionRange && typeof el.value === 'string') { try { el.setSelectionRange(el.value.length, el.value.length); } catch (err) { /* ignore */ } }
      }
      _cancelEdit(keepFocus) {
        if (!this.state.edit) return;
        this.setState({ edit: null, confirm: null });
        var self = this;
        if (keepFocus) this._later(function () { if (self.valueEl && self.valueEl.focus) { try { self.valueEl.focus({ preventScroll: true }); } catch (e) { /* ignore */ } } }, 0);
      }
      _editKeyDown(e) {
        var ed = this.state.edit;
        if (!ed) return;
        if ((ed.kind === 'options' || ed.kind === 'boolean') && (SELECT_NAV_KEYS[e.key] === true ||
            (typeof e.key === 'string' && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey))) {   // + type-ahead
          var self = this;
          this._selectNav = true;              // the change event this key causes is a selection, not a commit
          this._later(function () { self._selectNav = false; }, 0);
          return;
        }
        if (e.key === 'Enter') { e.preventDefault(); this._commitEdit(false); }
        else if (e.key === 'Escape' || e.key === 'Esc') { e.preventDefault(); e.stopPropagation(); this._cancelEdit(true); }
        else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && (ed.kind === 'int' || ed.kind === 'float')) {
          e.preventDefault();
          this._spin(e.key === 'ArrowUp' ? 1 : -1);
        }
      }
      _spin(dir) {
        var ed = this.state.edit;
        if (!ed || ed.busy) return;
        var nt = stepText(ed.text, dir, this.props.props.setpoint.spinner.increment, this.props.delegate.snap, this._env().locale, ed.kind);
        if (nt != null) this.setState({ edit: Object.assign({}, ed, { text: nt, invalid: false, touched: true }) });
      }
      _editBlur() {
        var self = this;
        // a click on our own −/+/± buttons or an open Confirm keeps the editor (focus moves back / to the Confirm)
        this._later(function () {
          var ed = self.state.edit;
          if (!ed || ed.busy || self.state.confirm) return;
          var a = document.activeElement;
          if (a && self.valueEl && self.valueEl.contains(a)) return;
          // dirty = the operator changed something (typing back the opening text counts); _commitEdit then writes
          // only when it differs from the LIVE value. An untouched editor never writes on blur, even
          // after the live value moved (that would put a stale value back).
          var dirty = ed.kind === 'options' || ed.kind === 'boolean' ? ed.choice !== ed.initialChoice : !!ed.touched || ed.text !== ed.initial;
          if (self.props.props.setpoint.commitOnBlur && dirty) self._commitEdit(true);
          else self._cancelEdit(false);
        }, 0);
      }
      /** Validates the typed value (strict input rules + step guard); {ok, value} or {ok:false, error}. */
      _parseEdit(ed) {
        var cfg = this.props.props;
        var snap = this.props.delegate.snap;
        var env = this._env();
        var units = unitsText(cfg, snap);
        var dt = ed.kind === 'string' ? 'String' : (snap && snap.meta && snap.meta.dataType) || (ed.kind === 'int' ? 'Int4' : 'Float8');
        var r = NS.format.parseInput(ed.text, dt, env.locale, {
          limits: writeLimits(snap), maxLength: cfg.setpoint.maxStringLength,
          formatLimit: function (n) { return fmtExact(n, cfg, snap, env) + (units ? '\u00A0' + units : ''); },
        });
        if (!r.ok) return r;
        if (ed.kind === 'int' || ed.kind === 'float') {
          var st = stepCheck(cfg, snap, r.value);
          if (!st.ok) {
            var mx = fmtExact(st.max, cfg, snap, env) + (units ? '\u00A0' + units : '');
            return { ok: false, error: st.unknown ? t('sp.stepUnknown', { max: mx }) : t('sp.stepTooLarge', { max: mx }) };
          }
        }
        return r;
      }
      _commitEdit(fromBlur) {
        var ed = this.state.edit;
        if (!ed || ed.busy) return;
        var cfg = this.props.props;
        var snap = this.props.delegate.snap;
        var env = this._env();
        if (ed.blocked) {                                   // an advisory guard is off: its own reason
          if (fromBlur) this._cancelEdit(false);
          this._bubble(ed.blocked, 'error');
          return;
        }
        if (ed.kind === 'options' || ed.kind === 'boolean') {
          // nothing to write only when the choice is the LIVE value, not merely the opening one
          if (ed.choice < 0 || this._sameAsLive(ed)) { this._cancelEdit(!fromBlur); return; }
          this._confirmChoice(ed.choice, fromBlur);
          return;
        }
        if (ed.text === ed.initial && editText(snap, env.locale) === ed.initial) { this._cancelEdit(!fromBlur); return; }   // nothing typed, value unchanged
        var r = this._parseEdit(ed);
        if (!r.ok) {
          if (fromBlur) { this._cancelEdit(false); this._bubble(r.error, 'error'); return; }
          this.setState({ edit: Object.assign({}, ed, { invalid: true }) });
          this._bubble(r.error, 'error');
          return;
        }
        if (this._sameAsLive(ed, r.value)) { this._cancelEdit(!fromBlur); return; }     // the tag already holds it
        var label = this.props.props.label.text || (snap && snap.tagName) || '';
        var units = unitsText(cfg, snap);
        var f = function (n) { return fmtExact(n, cfg, snap, env) + (units ? '\u00A0' + units : ''); };
        var self = this;
        var big = ed.kind === 'string' ? null : bigChange(cfg, snap, r.value);
        if (big || cfg.setpoint.confirm === 'always') {
          var text = big ? t('sp.confirmChange', { label: label, from: f(big.from), to: f(big.to), pct: pctText(big.pct, env.locale) })
            : t('sp.confirmSet', { label: label, value: ed.kind === 'string' ? '"' + r.value + '"' : f(Number(r.value)) });
          this.setState({ confirm: { text: text, confirmLabel: t('sp.write'), anchorRect: this._rect(),
            onConfirm: function () { self._sendEdit(r.value); }, onCancel: function () { self._focusEditor(false); } } });
          return;
        }
        this._sendEdit(r.value, fromBlur);
      }
      /** The inline select changed: browse (keyboard on the closed list) or commit (a pick). */
      _choiceChanged(i) {
        var ed = this.state.edit;
        if (!ed || ed.busy) return;
        if (this._selectNav) {
          var opts = choiceOptions(this.props.props, ed.kind);
          if (opts[i] && !opts[i].disabled) this.setState({ edit: Object.assign({}, ed, { choice: i }) });
          return;
        }
        this._confirmChoice(i);
      }
      /** Boolean / option chosen in place: a selection only; Confirm commits unless confirm:"never". */
      _confirmChoice(i, fromBlur) {
        var self = this;
        var cfg = this.props.props;
        var ed = this.state.edit;
        var opts = choiceOptions(cfg, ed.kind);
        var o = opts[i];
        if (!o || o.disabled) return;
        if (ed.blocked) { this._bubble(ed.blocked, 'error'); return; }
        if (cfg.setpoint.confirm === 'never') { this._sendEdit(o.value, fromBlur); return; }
        var snap = this.props.delegate.snap;
        var label = cfg.label.text || (snap && snap.tagName) || '';
        this.setState({ edit: Object.assign({}, ed, { choice: i }), confirm: { text: t('sp.confirmSet', { label: label, value: o.label }),
          confirmLabel: o.label, anchorRect: this._rect(),
          onConfirm: function () { self._sendEdit(o.value); },
          onCancel: function () {
            var cur = self.state.edit;
            if (cur) self.setState({ edit: Object.assign({}, cur, { choice: cur.initialChoice }) });
            self._focusEditor(false);
          } } });
      }
      _sendEdit(value, fromBlur) {
        var self = this;
        var ed = this.state.edit;
        if (!ed || ed.busy) return;
        var mode = this.props.props.setpoint.mode;
        this.setState({ edit: Object.assign({}, ed, { busy: true }), confirm: null });
        var r = this._write(value, { target: ed.target, ui: mode === 'popup' ? 'popup' : mode, source: 'inline',
          display: ed.kind === 'options' || ed.kind === 'boolean' ? '' : ed.text });
        r.promise.then(function (res) {
          if (!self._mounted) return;
          var cur = self.state.edit;
          // the editor closing on success / timeout would drop keyboard focus to <body>; it goes back to
          // the value like Escape (not for a commitOnBlur commit: the operator moved on)
          var refocus = !fromBlur;
          if (res.ok) { self.setState({ edit: null }); self._refocusValue(refocus); return; }
          var err = res.error || {};
          if (err.code === 'DETACHED') return;
          var timeout = err.code === 'CLIENT_TIMEOUT' || err.code === 'TIMEOUT';
          if (timeout || !cur) {
            self.setState({ edit: null });
            self._refocusValue(refocus);
            if (timeout) { self._bubble(errText(err), 'warn', 10000); return; }   // outcome unknown: no failure flash
            self._flash('failed');
            self._bubble(errText(err), 'error', 10000);
            return;
          }
          // stay in edit with the text intact
          self.setState({ edit: Object.assign({}, cur, { busy: false, invalid: /^(OUT_OF_RANGE|INVALID_VALUE|NOT_AN_OPTION|STEP_TOO_LARGE)$/.test(err.code || ''),
            choice: cur.kind === 'options' || cur.kind === 'boolean' ? cur.initialChoice : cur.choice }) }, function () { self._focusEditor(false); });
          self._bubble(errText(err), 'error');
        });
      }

      // ---- value element events --------------------------------------------------------------------------------
      _valueClick(e) {
        var cfg = this.props.props;
        var g = this._guard();
        if (!g.show || this.state.edit) return;
        if (cfg.setpoint.mode === 'popup') { e.preventDefault(); this._openDialog('setpoint'); return; }
        if (!g.allowed) this._checkGuard();                   // direct / protected: explain once per click
      }
      _valueKeyDown(e) {
        if (this.state.edit) return;
        var cfg = this.props.props;
        var g = this._guard();
        if (!g.show) return;
        var mode = cfg.setpoint.mode;
        if ((e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') && mode === 'popup') { e.preventDefault(); this._openDialog('setpoint'); }
        else if ((e.key === 'Enter' || e.key === 'F2') && mode === 'protected') { e.preventDefault(); this._beginEdit(); }
      }
      _valueDblClick(e) {
        if (this.props.props.setpoint.mode !== 'protected' || this.state.edit) return;
        e.preventDefault();
        this._beginEdit();
      }
      _clearHold() {
        if (this._hold) { clearTimeout(this._hold.timer); this._timers.delete(this._hold.timer); this._hold = null; }
      }
      _valuePointerDown(e) {
        var cfg = this.props.props;
        if (cfg.setpoint.mode !== 'protected' || this.state.edit || e.pointerType !== 'mouse' || e.button !== 0) return;
        if (!this._guard().show) return;
        var self = this;
        this._clearHold();
        var tm = this._later(function () { self._hold = null; self._beginEdit(); }, MOUSE_HOLD_MS);
        this._hold = { timer: tm, x: e.clientX, y: e.clientY };
      }
      _valuePointerMove(e) {
        if (this._hold && (Math.abs(e.clientX - this._hold.x) > TAP_MOVE_PX || Math.abs(e.clientY - this._hold.y) > TAP_MOVE_PX)) this._clearHold();
      }
      _valuePointerUp(e) {
        this._clearHold();
        var cfg = this.props.props;
        if (cfg.setpoint.mode !== 'protected' || e.pointerType === 'mouse' || this.state.edit) return;
        // touch double-tap (≤ 300 ms, ≤ 10 px) enters protected edit; long-press stays the menu
        var now = Date.now();
        var last = this._lastTap;
        if (last && now - last.t <= DOUBLE_TAP_MS && Math.abs(e.clientX - last.x) <= DOUBLE_TAP_PX && Math.abs(e.clientY - last.y) <= DOUBLE_TAP_PX) {
          this._lastTap = null;
          if (e.cancelable) e.preventDefault();
          this._beginEdit();
          return;
        }
        this._lastTap = { t: now, x: e.clientX, y: e.clientY };
      }
      _directFocus(seed) {
        if (this._quietFocusUntil && Date.now() < this._quietFocusUntil && seed === undefined) { this._quietFocusUntil = 0; return; }
        this._quietFocusUntil = 0;
        var g = this._guard();
        if (this.props.props.setpoint.mode === 'direct' && !this.state.edit && g.allowed && !g.preview) this._beginEdit(seed);
      }

      // ---- render ------------------------------------------------------------------------------------------------
      _rootVars(cfg) {
        var v = {};
        var fs = this.state.fontSizes;
        if (fs && cfg.layout.autoFontSize.enabled) { v['--dt-label-size'] = fs.label + 'px'; v['--dt-value-size'] = fs.value + 'px'; }
        var st = cfg.style || {};
        var rootFont = st.fontSize != null && st.fontSize !== '' ? st.fontSize : st['font-size'];
        if (rootFont != null && rootFont !== '') {
          var fsz = typeof rootFont === 'number' ? rootFont + 'px' : String(rootFont);
          if (!/[;{}<>]/.test(fsz)) { v['--std-name-size'] = fsz; v['--std-value-size'] = fsz; }
        }
        var fw = st.fontWeight != null ? st.fontWeight : st['font-weight'];
        if (fw != null && fw !== '' && !/[;{}<>]/.test(String(fw))) v['--std-font-weight'] = String(fw);
        if (cfg.layout.gap && !/[;{}<>]/.test(cfg.layout.gap)) v['--dt-gap'] = cfg.layout.gap;
        if (cfg.setpoint.color) v['--dt-setpoint-color'] = cfg.setpoint.color;
        var b = cfg.bounds;
        if (b.lowColor) v['--dt-low-color'] = b.lowColor;
        if (b.lowTextColor) v['--dt-low-fg'] = b.lowTextColor;
        if (b.highColor) v['--dt-high-color'] = b.highColor;
        if (b.highTextColor) v['--dt-high-fg'] = b.highTextColor;
        var ac = cfg.alarms.colors;
        PRIORITY_KEYS.forEach(function (p) {
          if (ac[p]) { v['--dt-alarm-' + p + '-bg'] = ac[p]; v['--dt-alarm-' + p + '-text'] = ac[p]; }
          if (ac[p + 'Text']) v['--dt-alarm-' + p + '-fg'] = ac[p + 'Text'];
        });
        return v;
      }

      _renderValueContent(cfg, vm, env) {
        var self = this;
        var ed = this.state.edit;
        var mode = cfg.setpoint.mode;
        var parts = [];
        var editing = !!ed;
        var directIdle = !editing && mode === 'direct' && vm.guard.show && vm.guard.kind !== 'options' && vm.guard.kind !== 'boolean' &&
          vm.guard.kind !== 'unsupported' && vm.state === 'LIVE';
        if (editing) {
          var busy = ed.busy;
          if (ed.kind === 'options' || ed.kind === 'boolean') {
            var opts = choiceOptions(cfg, ed.kind);
            parts.push(h('select', {
              key: 'sel', ref: this._setInput, className: 'dt-select', value: ed.choice < 0 ? '' : String(ed.choice), disabled: busy,
              'aria-label': t('sp.new') + ' \u2014 ' + (vm.labelText || vm.tagName),
              // a change caused by the keyboard on the closed list (ArrowUp/Down, Home/End, PageUp/Down
              // in Chromium on Windows/Linux) is a selection only; Enter, blur (commitOnBlur) or a pick from the
              // opened list commits, so an arrow key never writes (confirm 'never') or opens a Confirm.
              onChange: function (e) { self._choiceChanged(Number(e.target.value)); },
              onKeyDown: function (e) { self._editKeyDown(e); }, onBlur: function () { self._editBlur(); },
            }, [ed.choice < 0 ? h('option', { key: 'none', value: '', disabled: true }, t('sp.choose')) : null].concat(opts.map(function (o, i) {
              return h('option', { key: i, value: String(i), disabled: !!o.disabled }, o.label);
            }))));
          } else {
            var isNum = ed.kind === 'int' || ed.kind === 'float';
            var im = isNum ? numericInputMode(ed.kind, this.props.delegate.snap) : { inputMode: 'text', needsSign: false };
            parts.push(h('input', {
              key: 'in', ref: this._setInput, className: 'dt-input' + (ed.invalid ? ' dt-input--invalid' : ''), type: 'text', value: ed.text,
              inputMode: im.inputMode, autoComplete: 'off', spellCheck: false, readOnly: busy,
              maxLength: ed.kind === 'string' ? cfg.setpoint.maxStringLength : undefined, placeholder: cfg.setpoint.placeholder || undefined,
              'aria-invalid': ed.invalid ? 'true' : undefined, 'aria-label': t('sp.new') + ' \u2014 ' + (vm.labelText || vm.tagName),
              onChange: function (e) { var cur = self.state.edit; if (cur) self.setState({ edit: Object.assign({}, cur, { text: e.target.value, invalid: false, touched: true }) }); },
              onKeyDown: function (e) { self._editKeyDown(e); }, onBlur: function () { self._editBlur(); },
            }));
            var keep = function (e) { e.preventDefault(); };       // buttons must not steal focus (blur would cancel the edit)
            if (isNum && cfg.setpoint.spinner.enabled) {
              parts.push(h('button', { key: 'dec', type: 'button', className: 'dt-spin', 'aria-label': t('sp.decrease'), tabIndex: -1, disabled: busy,
                onMouseDown: keep, onClick: function () { self._spin(-1); } }, '\u2212'));
              parts.push(h('button', { key: 'inc', type: 'button', className: 'dt-spin', 'aria-label': t('sp.increase'), tabIndex: -1, disabled: busy,
                onMouseDown: keep, onClick: function () { self._spin(1); } }, '+'));
            }
            if (isNum && im.needsSign) {
              parts.push(h('button', { key: 'neg', type: 'button', className: 'dt-spin dt-sign', 'aria-label': t('sp.negate'), title: t('sp.negate'),
                tabIndex: -1, disabled: busy, onMouseDown: keep,
                onClick: function () { var cur = self.state.edit; if (cur) self.setState({ edit: Object.assign({}, cur, { text: negateText(cur.text), touched: true }) }); } }, '\u00B1'));
            }
          }
          if (busy) parts.push(h(NS.ui.Spinner, { key: 'busy', className: 'dt-writing-spinner' }));
        } else if (directIdle) {
          // direct mode: always an input (Numeric Entry Field "direct"); focus enters edit with the raw value
          // same key as the editing input: the element (and its focus) survives entering / leaving edit
          parts.push(h('input', {
            key: 'in', ref: this._setInput, className: 'dt-input', type: 'text', readOnly: true, value: vm.valueText,
            size: Math.max(2, String(vm.valueText).length),
            tabIndex: env.canInteract ? 0 : -1, title: vm.guard.allowed ? undefined : vm.guard.text,
            'aria-label': vm.ariaLabel, 'aria-disabled': vm.guard.allowed ? undefined : 'true',
            // a right / middle button press must not focus the idle input (focus begins a direct edit)
            onMouseDown: function (e) {
              if (e.button !== 0) { e.preventDefault(); return; }
              self._quietFocusUntil = 0;                       // a real click always edits
            },
            // the input keeps focus after a write / Escape, and a click on a focused element fires no focus
            // event: the click itself begins the edit (on click, not on mousedown, so the select-all the edit starts
            // with is not undone by the press placing the caret; when the press focused the input, the edit is open
            // already and this re-renders as the editing input without this handler)
            onClick: function (e) { if (!e || !e.button) self._directFocus(null); },
            onFocus: function () { self._directFocus(); },
            onKeyDown: function (e) {
              if (e.key === 'Enter' || e.key === 'F2') { e.preventDefault(); self._directFocus(null); return; }
              // a printable key on the focused idle input begins the edit with it (read-only: it was dropped)
              if (typeof e.key === 'string' && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                e.preventDefault();
                self._directFocus(e.key);
              }
            },
          }));
        } else {
          parts.push(h('span', { key: 'txt', className: 'dt-value-text' }, vm.valueText));
        }
        if (vm.unitsInValue && !(editing && (ed.kind === 'options' || ed.kind === 'boolean'))) {
          parts.push(h('span', { key: 'u', className: 'dt-units ' + (cfg.styles.units.className || ''), style: cfg.styles.units.style }, vm.unitsText));
        }
        if (vm.bounds && vm.bounds.state && cfg.bounds.glyphVisible) {
          parts.push(h('span', { key: 'bg', className: 'dt-bounds-glyph', 'aria-hidden': 'true' }, vm.bounds.state === 'low' ? '\u25BC' : '\u25B2'));
        }
        if (vm.alarm && cfg.alarms.indicatorVisible) parts.push(AlarmIndicator(vm.alarm));
        if (vm.qualityMark && cfg.quality.indicator === 'icon') {
          parts.push(h('span', { key: 'q', className: 'dt-quality-icon-wrap' }, Icon(vm.qualityMark === 'bad' ? 'bad' : 'uncertain', 'dt-quality-icon',
            t('dt.quality', { name: vm.qName }))));
        }
        if (vm.stale) parts.push(h('span', { key: 'st', className: 'dt-stale-wrap' }, Icon('stale', 'dt-stale-icon', vm.staleText)));
        if (cfg.setpoint.editIconVisible && vm.guard.show && !editing) parts.push(h('span', { key: 'ed', className: 'dt-edit-wrap' }, Icon('edit', 'dt-edit-icon')));
        if (this.state.writing && !editing) parts.push(h(NS.ui.Spinner, { key: 'w', className: 'dt-writing-spinner' }));
        return { parts: parts, editing: editing, directIdle: directIdle };
      }

      render() {
        var self = this;
        var p = this.props;
        var cfg = p.props;
        var d = p.delegate || {};
        var env = this._env();
        var vm = resolve(cfg, d, env);
        var classes = vm.rootClasses.slice();
        if (this.state.edit) classes.push('dt--editing');
        if (this.state.writing || (this.state.edit && this.state.edit.busy)) classes.push('dt--writing');
        if (this.state.flash === 'ok') classes.push('dt--write-ok');
        if (this.state.flash === 'failed') classes.push('dt--write-failed');
        var rootProps = p.emit({ classes: classes });
        if (rootProps.ref && rootProps.ref !== this._setRoot) this._emitRef = rootProps.ref;
        rootProps.ref = this._setRoot;
        this._guardRootHandlers(rootProps);
        rootProps.style = Object.assign({}, this._rootVars(cfg), rootProps.style || {});
        rootProps['data-dt-state'] = vm.state;
        rootProps['data-dt-phase'] = d.phase || 'idle';
        if (vm.stale) { rootProps['data-dt-stale'] = vm.staleReason || 'stale'; if (!rootProps.title) rootProps.title = vm.staleText; }

        var children = [];
        if (vm.gwHint) children.push(h('span', { key: 'gw', className: 'dt-gw-badge', 'data-dt': 'gw-hint', title: vm.gwHint }, t('dt.gwBadge')));
        if (env.designer && cfg.v1Keys.length) children.push(h('span', { key: 'v1', className: 'dt-v1-badge', title: t('dt.v1Warn', { keys: cfg.v1Keys.join(', ') }) }, t('dt.v1Badge')));
        if (cfg.label.visible) {
          children.push(h('div', {
            key: 'l', className: 'dt-label std-tag-name' + (cfg.styles.label.className ? ' ' + cfg.styles.label.className : ''),
            style: cfg.styles.label.style, title: vm.labelTitle || (vm.labelDisplay && vm.labelDisplay.length > 24 ? vm.labelDisplay : undefined),
          }, vm.labelDisplay));
        }
        if (cfg.value.visible) {
          var content = this._renderValueContent(cfg, vm, env);
          var interactive = env.canInteract && cfg.enabled;
          var styleParts = [];
          if (vm.guard.show) styleParts.push(cfg.styles.setpoint.style);
          if (vm.stateStyle != null && cfg.styles.states[vm.stateStyle]) styleParts.push(cfg.styles.states[vm.stateStyle].style);
          styleParts.push(cfg.styles.value.style);
          var vcls = 'dt-value std-tag-value' + (cfg.styles.value.className ? ' ' + cfg.styles.value.className : '') +
            (vm.guard.show && cfg.styles.setpoint.className ? ' ' + cfg.styles.setpoint.className : '') +
            (vm.stateStyle != null && cfg.styles.states[vm.stateStyle] && cfg.styles.states[vm.stateStyle].className ? ' ' + cfg.styles.states[vm.stateStyle].className : '') +
            (content.editing ? ' dt-value--editor' : '') + (content.directIdle ? ' dt-value--direct' : '');
          var vprops = {
            key: 'v', ref: this._setValue, className: vcls, style: Object.assign.apply(null, [{}].concat(styleParts)),
            title: vm.valueTitle || (vm.guard.show && !vm.guard.allowed ? vm.guard.text : undefined) ||
              (vm.kind === 'string' && vm.valueText.length > 24 ? vm.valueText : undefined),
          };
          var mode = cfg.setpoint.mode;
          if (interactive && !content.editing && !content.directIdle) {
            // focusable only when there is something to do with the keyboard (edit, or Shift+F10 for the menu)
            if (vm.guard.show || vm.menuEnabled) vprops.tabIndex = 0;
            vprops['aria-label'] = vm.ariaLabel;
            if (vm.guard.show && (mode === 'popup' || mode === 'protected' || vm.guard.kind === 'options' || vm.guard.kind === 'boolean')) {
              vprops.role = 'button';
              if (!vm.guard.allowed) vprops['aria-disabled'] = 'true';
            } else {
              vprops.role = 'group';
            }
          } else if (!interactive) {
            vprops['aria-label'] = vm.ariaLabel;
            vprops.role = 'group';
            if (env.designMode) vprops.tabIndex = -1;
          }
          if (interactive) {
            vprops.onClick = function (e) {
              // direct mode with options/Boolean: a click starts the select editor
              if (mode === 'direct' && (vm.guard.kind === 'options' || vm.guard.kind === 'boolean') && !self.state.edit) {
                if (self._checkGuard()) self._beginEdit();
                return;
              }
              self._valueClick(e);
            };
            vprops.onKeyDown = function (e) {
              if (mode === 'direct' && (vm.guard.kind === 'options' || vm.guard.kind === 'boolean') && !self.state.edit &&
                (e.key === 'Enter' || e.key === ' ' || e.key === 'F2')) { e.preventDefault(); if (self._checkGuard()) self._beginEdit(); return; }
              self._valueKeyDown(e);
            };
            vprops.onDoubleClick = function (e) { self._valueDblClick(e); };
            vprops.onPointerDown = function (e) { self._valuePointerDown(e); };
            vprops.onPointerMove = function (e) { self._valuePointerMove(e); };
            vprops.onPointerUp = function (e) { self._valuePointerUp(e); };
            vprops.onPointerCancel = function () { self._clearHold(); };
            vprops.onPointerLeave = function () { self._clearHold(); };
          }
          children.push(h('div', vprops, content.parts));
        }

        // overlays (portals to document.body, owned by this component), inside the event wall (OVERLAY_HOST_PROPS)
        var st = this.state;
        var bodyChildren = children;
        children = [];
        if (st.menu) {
          var model = this._menuModel();
          children.push(h(NS.ui.Menu, {
            key: 'menu:' + st.menu.key, x: st.menu.x, y: st.menu.y, header: model.header, ariaLabel: model.ariaLabel,
            openedByKeyboard: st.menu.keyboard, returnFocus: this._returnFocusEl(), className: 'dt-menu',
            items: model.items.map(function (it) {
              return Object.assign({}, it, { keepOpen: it.kind === 'trend', onSelect: function () { self._onMenuSelect(it); } });
            }),
            onClose: function () { self._closeMenu(); },
          }));
        }
        if (st.dialog) {
          var dlg = st.dialog;
          var common = { key: 'dlg:' + dlg.id, cfg: cfg, d: d, vm: vm, env: env, target: dlg.target, returnFocus: this._returnFocusEl(),
            onClose: function () { self._closeDialog(); } };
          if (dlg.kind === 'setpoint') {
            children.push(h(DtSetpointDialog, Object.assign(common, {
              position: dlg.position,
              submit: function (value, info) {
                return self._write(value, { target: dlg.target, ui: 'popup', display: info.display, reuseId: info.reuseId, source: 'dialog', dialogId: dlg.id });
              },
            })));
          } else if (dlg.kind === 'config') {
            children.push(h(DtConfigDialog, Object.assign(common, {
              onClose: function (reason) { self._closeDialog(); if (reason === 'success') self._bubble(t('bubble.saved'), 'ok', 2500); },
              submit: function (changes) { return self._d().configEdit(dlg.target.tagPath, changes); },
            })));
          } else if (dlg.kind === 'history') {
            children.push(h(DtHistoryDialog, Object.assign(common, { query: function () { return self._d().auditQuery(dlg.target.tagPath); } })));
          }
        }
        if (st.confirm) {
          var cf = st.confirm;
          children.push(h(NS.ui.Confirm, {
            key: 'confirm', anchorRect: cf.anchorRect, text: cf.text, confirmLabel: cf.confirmLabel, returnFocus: this.inputEl || this.valueEl || undefined,
            onConfirm: function () { self.setState({ confirm: null }); cf.onConfirm(); },
            onCancel: function () { if (self._mounted) self.setState({ confirm: null }); if (cf.onCancel) cf.onCancel(); },
          }));
        }
        if (st.bubble) {
          children.push(h(NS.ui.Bubble, {
            key: 'bubble:' + st.bubble.key, anchorRect: st.bubble.anchorRect, text: st.bubble.text, tone: st.bubble.tone,
            durationMs: st.bubble.durationMs, onClose: function () { if (self._mounted) self.setState({ bubble: null }); },
          }));
        }
        if (children.length) bodyChildren.push(h('span', OVERLAY_HOST_PROPS, children));
        return h('div', rootProps, bodyChildren);
      }
    }

    /** Hidden-textarea copy for browsers without the async clipboard (or a refused permission). */
    function copyFallback(text) {
      var ta = null;
      try {
        ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        ta.style.top = '0';
        document.body.appendChild(ta);
        ta.select();
        return !!document.execCommand('copy');
      } catch (e) {
        return false;
      } finally {
        if (ta && ta.parentNode) ta.parentNode.removeChild(ta);
      }
    }

    /* ========================================================================
     * SECTION 11 / Component meta + registration
     * ====================================================================== */
    var reducers = typeof WeakMap === 'function' ? new WeakMap() : null;
    class DisplayTemplateMeta {
      getComponentType() { return COMPONENT_ID; }
      getViewComponent() { return DisplayTemplate; }
      getDefaultSize() { return { width: 160, height: 64 }; }
      createDelegate(store) { return new DisplayTemplateDelegate(store); }
      /** One memoising reducer per props tree (the meta is shared by every instance). */
      getPropsReducer(tree) {
        var r = reducers && tree && typeof tree === 'object' ? reducers.get(tree) : null;
        if (!r) {
          r = makeReducer();
          if (reducers && tree && typeof tree === 'object') reducers.set(tree, r);
        }
        try {
          return r(tree);
        } catch (e) {
          log.error('props reducer failed; using defaults', e);
          return makeReducer()({ read: function () { return undefined; } });
        }
      }
    }

    NS.dt = {
      DEFAULTS: DT_DEFAULTS,
      RULES: DT_RULES,
      coerceGroup: coerceGroup,
      makeReducer: makeReducer,
      dataState: dataState,
      formatOpts: formatOpts,
      valuePattern: valuePattern,
      displayedNumber: displayedNumber,
      displayTolerance: displayTolerance,
      evalBounds: evalBounds,
      evalAlarm: evalAlarm,
      writeKind: writeKind,
      writeGuard: writeGuard,
      dialogBlock: dialogBlock,
      verifyEntries: function () { return Object.keys(lastVerify).length; },
      keepsRequestId: keepsRequestId,
      requestMemoAfter: requestMemoAfter,
      OVERLAY_STOP_EVENTS: OVERLAY_STOP_EVENTS,
      maxStepOf: maxStepOf,
      stepCheck: stepCheck,
      bigChange: bigChange,
      rangeText: rangeText,
      fmtExact: fmtExact,
      decimalsOf: decimalsOf,
      trendPopupId: trendPopupId,
      menuModel: menuModel,
      accessDenied: accessDenied,
      levelPaths: levelPaths,
      resolve: resolve,
      editText: editText,
      stepText: stepText,
      negateText: negateText,
      numericInputMode: numericInputMode,
      splitAuditValue: splitAuditValue,
      timingOf: timingOf,
      rootFontIsExplicit: rootFontIsExplicit,
      css: function () { return DT_CSS || (DT_CSS = buildCss()); },
      writeDeadlineMs: writeDeadlineMs,
      readDeadlineMs: readDeadlineMs,
      silenceLimitOf: silenceLimitOf,
      outcomeUnknown: outcomeUnknown,
      staleText: staleText,
      errText: errText,
      DisplayTemplateDelegate: DisplayTemplateDelegate,
      DisplayTemplate: DisplayTemplate,
      DtSetpointDialog: DtSetpointDialog,   // exported for unit tests (request-id rule)
      DtHistoryDialog: DtHistoryDialog,     // exported for unit tests (auditId tooltip)
    };
    NS.registerComponent(new DisplayTemplateMeta());
  }
})();
