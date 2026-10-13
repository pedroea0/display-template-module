#!/usr/bin/env node
// =============================================================================
// migrate-v1-views.mjs — offline v1 → v2 migration of Display Template / CTG Chart views
// =============================================================================
// v2.0.0 is a clean break of both components' prop shapes (grouped props, no
// v1 aliases), and a Perspective ComponentDescriptor has no migration hook, so
// existing views are converted offline by this script.
//
//   node simple-tag-display/tools/migrate-v1-views.mjs <input> [options]
//
//   <input>  one of: the gateway's data/projects folder, one project folder, a
//            views folder, a single view.json, or a project-export .zip
//            (Gateway → Projects → Export, or GET /data/api/v1/projects/export/<name>)
//
// What it does, per file:
//   1. Every component of type com.example.simpletagdisplay.SimpleTagDisplay /
//      .CtgChart (at any depth of the view's component tree) is classified by
//      its prop signature (v1, v2, mixed or bare) and v1 props are rewritten to
//      the revision-2 schemas (SECTION 3/4). Values equal to the v2 default are
//      dropped, so the component follows future default changes.
//   2. The component's own `propConfig` entries (bindings, persistence, access,
//      onChange scripts) on v1 keys are moved to the v2 key when the mapping is
//      1:1, otherwise left in place and reported as "manual" (SECTION 5).
//   3. External references: every string in every view.json (bindings of other
//      components, event scripts, message handlers, custom methods) and every
//      ignition/script-python/**/*.py is searched for `props.<v1Key>` and each
//      hit is reported as "manual" (SECTION 6).
//
// Modes:
//   --dry-run (default)  print a summary of every change; write nothing
//   --write              folders: rewrite changed view.json files in place, the
//                        original kept once as view.json.v1.bak; zip: write a new
//                        archive (--out, default <input>-v2.zip), input untouched
//   --report <file>      also write the full JSON report
//
// Running it again over migrated output changes nothing (idempotent): every
// migrated component keeps at least one v2 key (a "marker", even when it equals
// the v2 default), so it classifies as v2 and is skipped. Components with no
// version-specific key ("bare") are migrated only when their view also holds a v1
// component (--bare auto, the default); see migrateView(). Exit codes: 0 done, 1 usage or fatal
// error, 2 done but some files could not be read or parsed (listed in the report).
//
// No dependencies (Node >= 18; tested on Node 24). Zip support: ./lib/mini-zip.mjs.
// =============================================================================
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, renameSync, copyFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip, writeZip, entryData } from './lib/mini-zip.mjs';
import { isMain } from './lib/is-main.mjs';

export const TOOL_VERSION = '2.0.0';
const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA_DIR = path.resolve(here, '..', 'common', 'src', 'main', 'resources', 'schemas');

export const TYPE_DISPLAY = 'com.example.simpletagdisplay.SimpleTagDisplay';
export const TYPE_CHART = 'com.example.simpletagdisplay.CtgChart';

// =============================================================================
// SECTION 0 — Small helpers (plain objects, dotted paths, deep equality)
// =============================================================================
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => has(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

function getPath(obj, dotted) {
  let cur = obj;
  for (const seg of dotted.split('.')) {
    if (!has(cur, seg)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

function setPath(obj, dotted, value) {
  const segs = dotted.split('.');
  let cur = obj;
  for (const seg of segs.slice(0, -1)) {
    if (!isObj(cur[seg])) cur[seg] = {};
    cur = cur[seg];
  }
  cur[segs[segs.length - 1]] = value;
}

/** Short printable form of a value for the console summary. */
function show(v) {
  const s = JSON.stringify(v);
  return s === undefined ? 'undefined' : s.length > 70 ? s.slice(0, 67) + '...' : s;
}

// =============================================================================
// SECTION 1 — v2 schemas (defaults, valid paths, key order)
// =============================================================================
// The v2 props schemas in common/src/main/resources/schemas are the single
// source for v2 names and defaults, so the migrator reads them
// instead of keeping a second copy that could drift.

export function loadSchemas(dir = DEFAULT_SCHEMA_DIR) {
  const read = (f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
  return { display: read('displaytemplate.props.json'), chart: read('ctgchart.props.json') };
}

/** Schema node at a dotted path, or null. Paths below a style ($ref) or free-form object return that node. */
function schemaNode(schema, dotted) {
  let node = schema;
  for (const seg of dotted.split('.')) {
    if (!node.properties) return node.$ref || node.type === 'object' ? node : null;
    node = node.properties[seg];
    if (!node) return null;
  }
  return node;
}

/** Effective default at a node: its own `default`, else the assembly of its children's defaults. */
function defaultOf(node) {
  if (!node) return undefined;
  if (has(node, 'default')) return node.default;
  if (node.properties) {
    const out = {};
    for (const [k, child] of Object.entries(node.properties)) {
      const d = defaultOf(child);
      if (d !== undefined) out[k] = d;
    }
    return out;
  }
  return undefined;
}

/** Copy of `obj` with keys in schema order (unknown keys last), recursively. */
function orderLike(obj, node) {
  if (!isObj(obj) || !node || !node.properties) return obj;
  const out = {};
  for (const k of Object.keys(node.properties)) if (has(obj, k)) out[k] = orderLike(obj[k], node.properties[k]);
  for (const k of Object.keys(obj)) if (!has(out, k)) out[k] = obj[k];
  return out;
}

/** Remove objects left empty after defaults were dropped. */
function pruneEmpty(obj) {
  for (const k of Object.keys(obj)) {
    if (isObj(obj[k])) {
      pruneEmpty(obj[k]);
      if (Object.keys(obj[k]).length === 0) delete obj[k];
    }
  }
  return obj;
}

// =============================================================================
// SECTION 2 — v1 shapes (from the v1.1.5 schemas and reducers)
// =============================================================================
// Absent v1 keys take the v1 schema defaults first: a v1 view that
// never stored a key behaved like the v1 default, so that default is what gets
// mapped (e.g. verticalAlign "top", showUnits false).

export const V1_DISPLAY_DEFAULTS = Object.freeze({
  tagPath: '', showTagName: true, showTagValue: true, tagNameLabel: '', valuePrecision: 1,
  row: false, evenRow: false, verticalAlign: 'top', showUnits: false,
  boolean: { textOnTrue: '', textOnFalse: '' },
  bounds: { enabled: false, minColor: '#FF0000', maxColor: '#00FF00', minInclusive: false, maxInclusive: false },
  setpoint: false,
  tagNameStyle: { classes: '' }, tagValueStyle: { classes: '' }, style: { classes: '' },
});

export const V1_CHART_DEFAULTS = Object.freeze({
  mode: 'realtime', rangeHours: 24, pointCount: 300, rawHistory: false, freeRangePanZoom: true,
  refreshRate: 1000, startDate: null, endDate: null, dateFormat: 'YYYY/MM/DD', timeFormat: 'h:mm A',
  // The v1 schema declared the first five flags; the v1 reducer read the other four. Both may be stored.
  visibility: {
    showDateRangeSelector: true, showPenControlDisplay: true, showRefreshButton: true, showZoomButton: true,
    showFullscreenButton: true, showModeToggle: true, showRangePresets: true, showRefreshRateControl: true, showLegend: true,
  },
  interaction: { mode: 'panAndZoom', xTraceVisible: true },
  style: { classes: '' },
});

const DISPLAY_V1_ROOTS = new Set(['showTagName', 'showTagValue', 'tagNameLabel', 'valuePrecision', 'row', 'evenRow',
  'verticalAlign', 'showUnits', 'boolean', 'tagNameStyle', 'tagValueStyle']);
// bounds.min / bounds.max: the public v1.0.0 schema (manual limits, defaults 0 / 100); 1.1.x dropped them from the schema
// but views created under 1.0.0 still store them (without these keys such a view classified as 'mixed' and kept them,
// which is invalid in v2)
const BOUNDS_V1_KEYS = new Set(['minColor', 'maxColor', 'minInclusive', 'maxInclusive', 'min', 'max']);
// Root keys of pre-1.0 builds (the early Simple-Tag-Display module): no v2 counterpart, dropped with a warning
const PRE_V1_DISPLAY_ROOTS = new Set(['tagNameFont', 'tagValueFont', 'tagNameJustify', 'tagValueJustify']);
const CHART_V1_ROOTS = new Set(['mode', 'rangeHours', 'pointCount', 'rawHistory', 'freeRangePanZoom', 'refreshRate',
  'startDate', 'endDate', 'dateFormat', 'timeFormat', 'visibility']);
const CHART_V1_INTERACTION_MODES = new Set(['panAndZoom', 'selection']);

// =============================================================================
// SECTION 3 — Classification (which props shape does a component carry?)
// =============================================================================
/**
 * @returns {'v1'|'v2'|'mixed'|'bare'} `bare` = only keys both versions share (tagPath, style, bounds.enabled)
 *   or no props at all; handled per --bare (auto: follows the view; v1; skip).
 */
export function classify(kind, props, propConfig, schemas) {
  props = isObj(props) ? props : {};
  let v1 = false;
  let v2 = false;
  const v2Roots = new Set(Object.keys(schemas[kind].properties));
  for (const [key, val] of Object.entries(props)) {
    if (kind === 'display') {
      if (DISPLAY_V1_ROOTS.has(key) || PRE_V1_DISPLAY_ROOTS.has(key)) {
        v1 = true;
      } else if (key === 'setpoint') {                    // v1: boolean, v2: object
        if (typeof val === 'boolean') v1 = true;
        else if (isObj(val)) v2 = true;
      } else if (key === 'bounds' && isObj(val)) {        // both versions have bounds.enabled
        for (const k of Object.keys(val)) {
          if (BOUNDS_V1_KEYS.has(k)) v1 = true;
          else if (k !== 'enabled') v2 = true;
        }
      } else if (key !== 'tagPath' && key !== 'style' && v2Roots.has(key)) {
        v2 = true;
      }
    } else {
      if (CHART_V1_ROOTS.has(key)) v1 = true;
      else if (key === 'interaction' && isObj(val)) {
        for (const [k, x] of Object.entries(val)) {
          if (k === 'xTraceVisible' || (k === 'mode' && CHART_V1_INTERACTION_MODES.has(x))) v1 = true;
          else v2 = true;
        }
      } else if (key !== 'style' && v2Roots.has(key)) v2 = true;
    }
  }
  // A binding on a v1-only key is a v1 signature as well (the static value may be missing).
  for (const key of Object.keys(isObj(propConfig) ? propConfig : {})) {
    if (!key.startsWith('props.')) continue;
    const p = key.slice(6);
    const root = p.split('.')[0];
    // (A binding on props.setpoint alone is no signature: v2 binds the whole setpoint object the same way.)
    if (kind === 'display' && (DISPLAY_V1_ROOTS.has(root) || PRE_V1_DISPLAY_ROOTS.has(root) || (root === 'bounds' && BOUNDS_V1_KEYS.has(p.split('.')[1])))) v1 = true;
    if (kind === 'chart' && (CHART_V1_ROOTS.has(root) || p === 'interaction.xTraceVisible')) v1 = true;
  }
  return v1 && v2 ? 'mixed' : v1 ? 'v1' : v2 ? 'v2' : 'bare';
}

// =============================================================================
// SECTION 4 — Prop mapping (v1 key → v2 path, per component)
// =============================================================================
// A mapper returns a plan: `assign` = [{to, value, from, keep}] (keep = write even
// when equal to the v2 default, used for bound keys), `drop` = [{from, reason}],
// plus warnings and notes. It never touches the component; SECTION 5 applies it.

function typed(v, type, fallback, key, plan) {
  if (v === undefined) return undefined;                 // absent and not filled (mixed component): nothing to map
  if (type === 'integer' ? Number.isFinite(v) : typeof v === type) return v;
  plan.warnings.push(`${key}: v1 value ${show(v)} is not a ${type}; the v1 default ${show(fallback)} was used`);
  return fallback;
}

/** Display Template: v1 (flat) → v2 (grouped, revision 2 names). */
export function mapDisplay(stored, ctx) {
  const plan = { assign: [], drop: [], warnings: [], notes: [], manualBindings: {} };
  const D = V1_DISPLAY_DEFAULTS;
  // Mixed components: only keys the view really stored are mapped (no v1 defaults over existing v2 groups).
  const fill = ctx.fillDefaults;
  const val = (k) => (has(stored, k) ? stored[k] : fill ? D[k] : undefined);
  const sub = (g, k) => (isObj(stored[g]) && has(stored[g], k) ? stored[g][k] : fill ? D[g][k] : undefined);
  const set = (to, value, from) => value !== undefined && plan.assign.push({ to, value, from, keep: ctx.isBound(from) });

  if (has(stored, 'tagPath') || ctx.isBound('tagPath')) set('tagPath', stored.tagPath ?? '', 'tagPath');
  set('label.visible', typed(val('showTagName'), 'boolean', D.showTagName, 'showTagName', plan), 'showTagName');
  set('label.text', typed(val('tagNameLabel'), 'string', D.tagNameLabel, 'tagNameLabel', plan), 'tagNameLabel');
  if (val('tagNameStyle') !== undefined) set('label.style', clone(val('tagNameStyle')), 'tagNameStyle');
  set('value.visible', typed(val('showTagValue'), 'boolean', D.showTagValue, 'showTagValue', plan), 'showTagValue');

  // valuePrecision: v1's default 1 applied to every tag; v2 null = "tag's own format". Written only when stored.
  if (has(stored, 'valuePrecision')) {
    const n = typed(stored.valuePrecision, 'integer', D.valuePrecision, 'valuePrecision', plan);
    const dec = Math.min(15, Math.max(0, Math.round(n)));
    if (dec !== n) plan.warnings.push(`valuePrecision ${show(n)} was clamped/rounded to value.decimals ${dec}`);
    set('value.decimals', dec, 'valuePrecision');
  } else if (ctx.isBound('valuePrecision')) {
    set('value.decimals', null, 'valuePrecision');
  }
  if (val('tagValueStyle') !== undefined) set('value.style', clone(val('tagValueStyle')), 'tagValueStyle');

  // showUnits: v1 default false → written as false when absent, to keep the v1 look (v2 default true).
  set('units.visible', typed(val('showUnits'), 'boolean', D.showUnits, 'showUnits', plan), 'showUnits');

  if (isObj(stored.boolean) || fill) {
    set('states.boolean.trueText', typed(sub('boolean', 'textOnTrue'), 'string', '', 'boolean.textOnTrue', plan), 'boolean.textOnTrue');
    set('states.boolean.falseText', typed(sub('boolean', 'textOnFalse'), 'string', '', 'boolean.textOnFalse', plan), 'boolean.textOnFalse');
  }

  const row = val('row');
  if (row !== undefined) set('layout.direction', typed(row, 'boolean', false, 'row', plan) ? 'row' : 'column', 'row');
  set('layout.evenSplit', typed(val('evenRow'), 'boolean', D.evenRow, 'evenRow', plan), 'evenRow');
  let va = val('verticalAlign');
  if (va !== undefined && !['top', 'center', 'bottom'].includes(va)) {
    plan.warnings.push(`verticalAlign ${show(va)} is not top/center/bottom; "top" (the v1 default) was used`);
    va = 'top';
  }
  set('layout.verticalAlign', va, 'verticalAlign');

  // Bounds: the v1 look is a background colour from EngLow/EngHigh (v2 default is a neutral border + glyph).
  const b = isObj(stored.bounds) ? stored.bounds : {};
  if (has(b, 'min') || has(b, 'max')) {
    // v1.0.0 manual limits: 1.1.x ignored them (it read the tag's EngLow/EngHigh); not carried over
    plan.warnings.push(`bounds.min / bounds.max (${show(b.min)} / ${show(b.max)}) are v1.0.0 manual limits that 1.1.x ` +
      'already ignored (it used the tag\'s EngLow/EngHigh); they were dropped. To keep fixed limits, set bounds.low / ' +
      'bounds.high in v2 (see docs/user-guide/upgrading-from-v1.md)');
    // (with bounds disabled the branch below drops every bounds key; enabled, they are dropped here)
    if (b.enabled === true || ctx.isBound('bounds.enabled') || ctx.isBound('bounds')) {
      ['min', 'max'].forEach((k) => { if (has(b, k)) plan.drop.push({ from: `bounds.${k}`, reason: 'v1.0.0 manual limit (ignored since 1.1.0)' }); });
    }
  }
  for (const k of PRE_V1_DISPLAY_ROOTS) {
    if (has(stored, k)) {
      plan.drop.push({ from: k, reason: 'pre-1.0 prop with no v2 counterpart' });
      plan.warnings.push(`${k} (a pre-1.0 prop) has no v2 counterpart and was dropped; use tagNameStyle / tagValueStyle ` +
        'classes in v1 or the v2 label / value styles instead');
    }
  }
  if (b.enabled === true || ctx.isBound('bounds.enabled') || ctx.isBound('bounds')) {
    const bd = (k) => (has(b, k) ? b[k] : D.bounds[k]);
    set('bounds.enabled', b.enabled === true, 'bounds.enabled');
    plan.assign.push({ to: 'bounds.appearance', value: 'background', from: 'bounds.enabled', keep: true });
    set('bounds.lowColor', typed(bd('minColor'), 'string', D.bounds.minColor, 'bounds.minColor', plan), 'bounds.minColor');
    set('bounds.highColor', typed(bd('maxColor'), 'string', D.bounds.maxColor, 'bounds.maxColor', plan), 'bounds.maxColor');
    const minInc = bd('minInclusive') === true;
    const maxInc = bd('maxInclusive') === true;
    plan.assign.push({ to: 'bounds.inclusive', value: minInc && maxInc, from: 'bounds.minInclusive', keep: false });
    if (minInc !== maxInc) {
      plan.warnings.push(`bounds.minInclusive (${minInc}) and bounds.maxInclusive (${maxInc}) differ; v2 has one ` +
        `bounds.inclusive, set to ${minInc && maxInc} (a value exactly at the ${minInc ? 'low' : 'high'} limit now counts as out of range)`);
    }
  } else if (isObj(stored.bounds)) {
    for (const k of Object.keys(stored.bounds)) {
      if (k === 'enabled' || BOUNDS_V1_KEYS.has(k)) plan.drop.push({ from: `bounds.${k}`, reason: 'bounds disabled in v1' });
    }
  }

  // Setpoint: keep v1 behaviour (no login check, no limit check) and say what still blocks it.
  if (stored.setpoint === true || (ctx.isBound('setpoint') && typeof stored.setpoint === 'boolean')) {
    set('setpoint.enabled', stored.setpoint === true, 'setpoint');
    plan.assign.push({ to: 'setpoint.access.requireLogin', value: false, from: 'setpoint', keep: true });
    plan.assign.push({ to: 'setpoint.limits.useEngLimits', value: false, from: 'setpoint', keep: true });
    plan.warnings.push('setpoint: written with access.requireLogin=false (v1 had no login check; also the v2 default ' +
      'since 2.0.0). The tag\'s own Write Permissions still apply, and a gateway administrator can require a login ' +
      'for every write with ctg.write.requireAuthenticated=true (default false); see docs/user-guide/upgrading-from-v1.md');
    plan.warnings.push('setpoint: limits.useEngLimits=false keeps v1 behaviour (v1 never checked limits); review the ' +
      'tag\'s engineering limits and turn the check on');
  } else if (has(stored, 'setpoint') && typeof stored.setpoint === 'boolean') {
    plan.drop.push({ from: 'setpoint', reason: 'false = v2 default (setpoint.enabled false)' });
  }

  if (val('style') !== undefined) set('style', clone(val('style')), 'style');
  return plan;
}

/** "Largest integer unit" for a v1 rangeHours value. Months/years are not fixed lengths, so never used. */
export function rangeHoursToRealtime(hours, warnings = []) {
  let secs = Math.round(Number(hours) * 3600);
  if (Math.abs(secs - Number(hours) * 3600) > 1e-6) warnings.push(`rangeHours ${hours} rounded to ${secs} s`);
  if (!(secs >= 1)) {
    warnings.push(`rangeHours ${show(hours)} is below one second; 1 second was used`);
    secs = 1;
  }
  for (const [unit, size] of [['weeks', 604800], ['days', 86400], ['hours', 3600], ['minutes', 60], ['seconds', 1]]) {
    if (secs % size === 0) return { value: secs / size, unit };
  }
  return { value: secs, unit: 'seconds' };
}

/** v1 startDate/endDate (ISO string or null) → v2 date (epoch ms) or null. */
function toDate(v, key, plan) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const ms = typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) {
    plan.warnings.push(`${key} ${show(v)} is not a date; left empty (null)`);
    return null;
  }
  if (!/(Z|[+-]\d\d:?\d\d)$/i.test(v.trim()) && /T|\d:\d/.test(v)) {
    plan.notes.push(`${key} ${show(v)} has no time zone; read as local time of this machine (${new Date(ms).toISOString()})`);
  }
  return ms;
}

/** CTG Chart: v1 (flat) → v2 (Power-Chart-shaped groups, revision 2 names). */
export function mapChart(stored, ctx) {
  const plan = { assign: [], drop: [], warnings: [], notes: [], manualBindings: {} };
  const D = V1_CHART_DEFAULTS;
  const fill = ctx.fillDefaults;
  const val = (k) => (has(stored, k) ? stored[k] : fill ? D[k] : undefined);
  const set = (to, value, from) => value !== undefined && plan.assign.push({ to, value, from, keep: ctx.isBound(from) });

  const mode = val('mode');
  if (mode !== undefined) {
    const ok = mode === 'realtime' || mode === 'historical';
    if (!ok) plan.warnings.push(`mode ${show(mode)} is not realtime/historical; "realtime" was used`);
    set('timeRange.mode', ok ? mode : 'realtime', 'mode');
  }

  const rh = val('rangeHours');
  if (ctx.isBound('rangeHours') && typeof rh === 'number' && rh < 1) {
    // v2 needs realtime.value >= 1: hours cannot hold this static value, so the static value moves to a
    // smaller unit and the binding (which still produces hours) is left for the user.
    set('timeRange.realtime', rangeHoursToRealtime(rh, plan.warnings), 'rangeHours');
    plan.assign[plan.assign.length - 1].keep = true;
    plan.manualBindings.rangeHours = `static value ${rh} h is below v2's minimum of 1, so the binding cannot move to ` +
      'timeRange.realtime.value with unit "hours"; rebind timeRange.realtime (e.g. {value: <minutes>, unit: "minutes"})';
  } else if (ctx.isBound('rangeHours')) {
    // The binding moves to timeRange.realtime.value, so the unit must stay hours.
    set('timeRange.realtime', { value: typeof rh === 'number' ? rh : 24, unit: 'hours' }, 'rangeHours');
    plan.assign[plan.assign.length - 1].keep = true;
  } else if (rh !== undefined) {
    set('timeRange.realtime', rangeHoursToRealtime(typed(rh, 'number', D.rangeHours, 'rangeHours', plan), plan.warnings), 'rangeHours');
  }

  const rr = val('refreshRate');
  if (rr !== undefined) {
    let ms = Math.round(typed(rr, 'number', D.refreshRate, 'refreshRate', plan));
    const orig = ms;
    if (ms < 0) ms = 0;
    else if (ms > 0 && ms < 250) ms = 250;
    else if (ms > 3600000) ms = 3600000;
    if (ms !== orig) plan.warnings.push(`refreshRate ${orig} ms is outside v2's range; ${ms} ms was used (0 = off, else 250–3600000)`);
    set('timeRange.refreshRate', ms, 'refreshRate');
  }

  for (const [k, to] of [['startDate', 'timeRange.historical.startDate'], ['endDate', 'timeRange.historical.endDate']]) {
    const v = val(k);
    if (v !== undefined) set(to, toDate(v, k, plan), k);
  }

  const pc = val('pointCount');
  if (pc !== undefined) {
    const n = Math.round(typed(pc, 'number', D.pointCount, 'pointCount', plan));
    const clamped = n === 0 ? 0 : Math.min(5000, Math.max(10, n));
    if (clamped !== n) plan.warnings.push(`pointCount ${n} clamped to ${clamped} (v2 range 10–5000, 0 = auto)`);
    set('query.pointCount', clamped, 'pointCount');
  }

  const raw = val('rawHistory') === true;
  if (raw) set('query.mode', 'raw', 'rawHistory');
  else if (has(stored, 'rawHistory')) plan.drop.push({ from: 'rawHistory', reason: 'false: v2 query.mode "auto" aggregates' });
  if (!raw && getPath(stored, 'query.aggregation') === undefined
      && (has(stored, 'pointCount') || has(stored, 'rangeHours') || fill)) {
    if (ctx.keepAggregation) set('query.aggregation', 'LastValue', 'rawHistory');
    else plan.notes.push('history aggregation is now MinMax (v2 default; v1 used LastValue). Use --keep-aggregation to keep LastValue');
  }

  set('interaction.panAndZoom.freeRange', typed(val('freeRangePanZoom'), 'boolean', true, 'freeRangePanZoom', plan), 'freeRangePanZoom');

  // Visibility flags follow the v1 RUNTIME (the v1 reducer), so a migrated chart looks like it did in v1.
  // The v1 schema declared showDateRangeSelector/showPenControlDisplay, but the reducer never read them: a
  // stored false had no visible effect in v1 and is not carried over (warning). v1 had no fullscreen
  // button at all, so showFullscreenButton:false is carried over (hiding it is closer to v1).
  const vis = isObj(stored.visibility) ? stored.visibility : {};
  const flag = (k) => (has(vis, k) ? vis[k] !== false : undefined);
  // The v1 reducer showed the date-range pill when EITHER reducer flag was not false.
  const presetsOrMode = flag('showRangePresets') === undefined && flag('showModeToggle') === undefined ? undefined
    : (flag('showRangePresets') ?? true) || (flag('showModeToggle') ?? true);
  // The v1 reducer showed the refresh-rate input unless the flag was false; v2 hides it by default.
  const refreshRate = flag('showRefreshRateControl') ?? (fill ? true : undefined);
  const visMap = [
    ['toolbar.buttons.dateRange', presetsOrMode, 'visibility.showRangePresets'],
    ['toolbar.buttons.refresh', flag('showRefreshButton'), 'visibility.showRefreshButton'],
    ['toolbar.buttons.resetZoom', flag('showZoomButton'), 'visibility.showZoomButton'],
    ['toolbar.buttons.fullscreen', flag('showFullscreenButton'), 'visibility.showFullscreenButton'],
    ['toolbar.buttons.refreshRate', refreshRate, 'visibility.showRefreshRateControl'],
    ['penTable.visible', flag('showLegend'), 'visibility.showLegend'],
  ];
  for (const [to, v, from] of visMap) set(to, v, from);
  for (const [k, to] of [['showDateRangeSelector', 'toolbar.buttons.dateRange'], ['showPenControlDisplay', 'penTable.visible']]) {
    if (vis[k] === false) {
      plan.warnings.push(`visibility.${k} false was ignored by v1 (the element was shown) and is not carried over; ` +
        `set ${to} = false to hide it in v2`);
    }
  }
  for (const k of Object.keys(vis)) {
    if (!has(D.visibility, k)) plan.warnings.push(`visibility.${k} is not a known v1 flag; dropped`);
  }

  // dateFormat/timeFormat: never read by the v1 reducer; a customised pair becomes a fixed axis format.
  const df = val('dateFormat');
  const tf = val('timeFormat');
  if ((df !== undefined && df !== D.dateFormat) || (tf !== undefined && tf !== D.timeFormat)) {
    const fmt = [df ?? D.dateFormat, tf ?? D.timeFormat].filter(Boolean).join(' ');
    set('timeAxis.format', fmt, 'dateFormat');
    plan.warnings.push(`dateFormat/timeFormat → timeAxis.format ${show(fmt)} (v1 ignored them; v2 applies them and ` +
      'no longer adapts the axis to the zoom level; clear timeAxis.format for "auto")');
  } else {
    for (const k of ['dateFormat', 'timeFormat']) if (has(stored, k)) plan.drop.push({ from: k, reason: 'v1 default (unused by v1)' });
  }

  // interaction.mode / xTraceVisible: dropped (v2 picks the mode on the toolbar; default X-Trace).
  if (isObj(stored.interaction)) {
    const im = stored.interaction;
    if (has(im, 'mode') && CHART_V1_INTERACTION_MODES.has(im.mode)) {
      plan.drop.push({ from: 'interaction.mode', reason: 'v2 interaction.mode has other values' });
      if (im.mode !== 'panAndZoom') plan.warnings.push(`interaction.mode ${show(im.mode)} dropped; v2 starts in X-Trace (toolbar picks Pan/Zoom/Range)`);
    }
    if (has(im, 'xTraceVisible')) {
      plan.drop.push({ from: 'interaction.xTraceVisible', reason: 'no v2 equivalent' });
      if (im.xTraceVisible === false) plan.warnings.push('interaction.xTraceVisible false dropped; use toolbar.buttons.xTrace / interaction.xTrace.infoBox.visible');
    }
  }

  if (val('style') !== undefined) set('style', clone(val('style')), 'style');
  return plan;
}

// =============================================================================
// SECTION 5 — Bindings (propConfig) and applying a plan to one component
// =============================================================================
// propConfig keys are "props.<path>". An entry (binding + persistent/access/
// onChange) moves as a whole when the v1 key has a 1:1 v2 key; otherwise it
// stays where it is and is reported as manual (a binding writing a v1 key is
// harmless at runtime: the v2 reducer ignores it, and it keeps the v1 badge on).

const DISPLAY_BINDINGS = {
  exact: {
    tagPath: 'tagPath', showTagName: 'label.visible', showTagValue: 'value.visible', tagNameLabel: 'label.text',
    valuePrecision: 'value.decimals', evenRow: 'layout.evenSplit', verticalAlign: 'layout.verticalAlign',
    showUnits: 'units.visible', 'boolean.textOnTrue': 'states.boolean.trueText', 'boolean.textOnFalse': 'states.boolean.falseText',
    'bounds.enabled': 'bounds.enabled', 'bounds.minColor': 'bounds.lowColor', 'bounds.maxColor': 'bounds.highColor',
    setpoint: 'setpoint.enabled',
  },
  prefix: { tagNameStyle: 'label.style', tagValueStyle: 'value.style', style: 'style' },
  manual: {
    row: 'boolean row → layout.direction "row"/"column": rebind layout.direction with an expression such as if({…}, "row", "column")',
    boolean: 'v1 object → states.boolean {trueText, falseText}: rebind the two leaves',
    bounds: 'v1 object → v2 bounds (lowColor/highColor/inclusive/appearance): rebind the leaves',
    'bounds.minInclusive': 'v2 has one bounds.inclusive (minInclusive && maxInclusive): rebind bounds.inclusive',
    'bounds.maxInclusive': 'v2 has one bounds.inclusive (minInclusive && maxInclusive): rebind bounds.inclusive',
  },
};
const CHART_BINDINGS = {
  exact: {
    mode: 'timeRange.mode', rangeHours: 'timeRange.realtime.value', refreshRate: 'timeRange.refreshRate',
    startDate: 'timeRange.historical.startDate', endDate: 'timeRange.historical.endDate', pointCount: 'query.pointCount',
    freeRangePanZoom: 'interaction.panAndZoom.freeRange',
    'visibility.showRefreshButton': 'toolbar.buttons.refresh',
    'visibility.showZoomButton': 'toolbar.buttons.resetZoom', 'visibility.showFullscreenButton': 'toolbar.buttons.fullscreen',
    'visibility.showRefreshRateControl': 'toolbar.buttons.refreshRate', 'visibility.showLegend': 'penTable.visible',
  },
  prefix: { style: 'style' },
  manual: {
    rawHistory: 'boolean rawHistory → query.mode "raw"/"auto": rebind query.mode with an expression such as if({…}, "raw", "auto")',
    dateFormat: 'dateFormat/timeFormat → one timeAxis.format pattern: rebind timeAxis.format',
    timeFormat: 'dateFormat/timeFormat → one timeAxis.format pattern: rebind timeAxis.format',
    visibility: 'v1 object → toolbar.buttons.* / penTable.visible: rebind the leaves',
    'visibility.showRangePresets': 'combined into toolbar.buttons.dateRange: rebind that key',
    'visibility.showModeToggle': 'combined into toolbar.buttons.dateRange: rebind that key',
    'visibility.showDateRangeSelector': 'v1 ignored this flag (the pill was always shown): remove the binding, or ' +
      'rebind toolbar.buttons.dateRange if it should now take effect',
    'visibility.showPenControlDisplay': 'v1 ignored this flag (the legend followed showLegend): remove the binding, or ' +
      'rebind penTable.visible if it should now take effect',
    interaction: 'v1 interaction {mode, xTraceVisible} has no v2 equivalent: remove the binding',
    'interaction.mode': 'v1 interaction.mode (panAndZoom/selection) has no v2 equivalent: remove the binding',
    'interaction.xTraceVisible': 'no v2 equivalent: remove the binding (see toolbar.buttons.xTrace)',
  },
};
const BINDING_WARNINGS = {
  'setpoint.enabled': 'setpoint.enabled is a security key: with ctg.security.rejectBoundGates=true (the default) the ' +
    'gateway fails a bound gate closed, so writes stay disabled until the binding is removed (docs/user-guide/security-and-permissions.md)',
  'timeRange.realtime.value': 'rangeHours binding moved to timeRange.realtime.value with unit "hours"; v2 needs a value ≥ 1, ' +
    'so a binding that produced fractions of an hour must be changed (e.g. minutes)',
  'timeRange.refreshRate': 'refreshRate binding moved; v2 rejects 1–249 ms (v1 accepted them)',
  'query.pointCount': 'pointCount binding moved; v2 accepts 0 (auto) or 10–5000',
};

/** Where a v1 propConfig path goes: {to} | {manual} | null (not a v1 path: leave alone). */
export function bindingTarget(kind, p) {
  const t = kind === 'display' ? DISPLAY_BINDINGS : CHART_BINDINGS;
  if (has(t.exact, p)) return { to: t.exact[p] };
  for (const [from, to] of Object.entries(t.prefix)) {
    if (p === from || p.startsWith(from + '.')) return { to: to + p.slice(from.length) };
  }
  if (has(t.manual, p)) return { manual: t.manual[p] };
  return null;
}

/**
 * Migrate one component object in place.
 * @returns {object|null} component report, or null when the component is not one of ours.
 */
export function migrateComponent(comp, opts, schemas, where) {
  const kind = comp.type === TYPE_DISPLAY ? 'display' : comp.type === TYPE_CHART ? 'chart' : null;
  if (!kind) return null;
  const schema = schemas[kind];
  const props = isObj(comp.props) ? comp.props : {};
  const propConfig = isObj(comp.propConfig) ? comp.propConfig : {};
  const report = { where, type: kind === 'display' ? 'Display Template' : 'CTG Chart', name: comp.meta?.name ?? '',
    signature: classify(kind, props, propConfig, schemas), status: '', changes: [], warnings: [], notes: [], manual: [] };

  if (report.signature === 'v2') {
    report.status = 'already v2';
    noteAmbiguousBindings(kind, propConfig, report);
    return report;
  }
  if (report.signature === 'bare' && opts.bare !== 'v1') {
    report.status = `skipped (bare${opts.bareReason ? ', ' + opts.bareReason : ''})`;
    return report;
  }
  if (report.signature !== 'v1' && classify(kind, props, null, schemas) === 'v2') {
    return migrateLeftoverConfig(comp, kind, propConfig, report, schema);
  }
  if (report.signature === 'bare') report.notes.push('no v1 or v2 keys stored: migrated as a v1 component with v1 defaults');
  if (report.signature === 'mixed') report.warnings.push('has both v1 and v2 keys: only the stored v1 keys were mapped; existing v2 values win');

  // Bound v1 paths (incl. ancestors: a binding on props.bounds covers bounds.minColor).
  const boundPaths = Object.keys(propConfig).filter((k) => k.startsWith('props.') && propConfig[k]?.binding).map((k) => k.slice(6));
  const isBound = (p) => boundPaths.some((b) => p === b || p.startsWith(b + '.'));
  const ctx = { fillDefaults: report.signature !== 'mixed', keepAggregation: !!opts.keepAggregation, isBound };
  const plan = (kind === 'display' ? mapDisplay : mapChart)(props, ctx);
  report.warnings.push(...plan.warnings);
  report.notes.push(...plan.notes);

  // 1. Start from the keys that are not v1 (v2 values of mixed components, unknown keys).
  const consumed = (key) => (kind === 'display'
    ? DISPLAY_V1_ROOTS.has(key) || PRE_V1_DISPLAY_ROOTS.has(key) || key === 'tagPath' || key === 'style' || (key === 'setpoint' && !isObj(props.setpoint))
    : CHART_V1_ROOTS.has(key) || key === 'style');
  const out = {};
  for (const [key, v] of Object.entries(props)) {
    if (consumed(key)) continue;
    if (kind === 'display' && key === 'bounds' && isObj(v)) {
      const rest = Object.fromEntries(Object.entries(v).filter(([k]) => !BOUNDS_V1_KEYS.has(k) && k !== 'enabled'));
      if (report.signature === 'mixed' && has(v, 'enabled') && !Object.keys(v).some((k) => BOUNDS_V1_KEYS.has(k))) rest.enabled = v.enabled;
      if (Object.keys(rest).length) out.bounds = clone(rest);
      continue;
    }
    if (kind === 'chart' && key === 'interaction' && isObj(v)) {
      const rest = Object.fromEntries(Object.entries(v).filter(([k, x]) => k !== 'xTraceVisible' && !(k === 'mode' && CHART_V1_INTERACTION_MODES.has(x))));
      if (Object.keys(rest).length) out.interaction = clone(rest);
      continue;
    }
    out[key] = clone(v);
    if (!has(schema.properties, key)) report.warnings.push(`unknown prop "${key}" kept as is (not in the v1 or v2 schema)`);
  }

  // 2. Apply the plan.
  for (const a of plan.assign) {
    const existing = getPath(out, a.to);
    if (existing !== undefined) {
      if (!deepEqual(existing, a.value)) report.warnings.push(`${a.from} → ${a.to}: the component already has ${show(existing)}; kept (v1 value ${show(a.value)} ignored)`);
      continue;
    }
    const isDefault = deepEqual(a.value, defaultOf(schemaNode(schema, a.to)));
    if (isDefault && !a.keep) {
      if (has(props, a.from.split('.')[0])) report.changes.push({ op: 'default', from: a.from, to: a.to, value: a.value });
      continue;
    }
    setPath(out, a.to, clone(a.value));
    if (a.from === a.to && deepEqual(getPath(props, a.from), a.value)) continue;   // same key, same value: not a change
    report.changes.push({ op: 'set', from: a.from, to: a.to, value: a.value, implicit: !has(props, a.from.split('.')[0]) || undefined });
  }
  for (const d of plan.drop) report.changes.push({ op: 'drop', from: d.from, reason: d.reason });
  if (kind === 'display' && isObj(props.bounds)) {
    for (const k of Object.keys(props.bounds)) {
      if (!BOUNDS_V1_KEYS.has(k) && k !== 'enabled' && !has(schemaNode(schema, 'bounds').properties, k)) {
        report.warnings.push(`unknown prop "bounds.${k}" kept as is`);
      }
    }
  }

  // 3. Idempotence marker: a component whose every mapped value equals the v2 default would come out with
  // only shared keys (tagPath/style) and classify as "bare" on the next run, where v1 defaults would be
  // filled in again. Keep one v2 key (the first MARKERS entry the plan assigned) even though it is a default.
  // A mixed component whose only v2 content was empty objects (pruned away) may have no assignment at all:
  // then the first marker is written with its v2 schema default (otherwise the component would carry no marker).
  pruneEmpty(out);
  if (classify(kind, out, null, schemas) === 'bare') {
    const a = MARKERS[kind].map((to) => plan.assign.find((x) => x.to === to)).find(Boolean)
      || plan.assign.find((x) => !['tagPath', 'style', 'bounds.enabled'].includes(x.to) && !x.to.startsWith('style.'));
    if (a) {
      setPath(out, a.to, clone(a.value));
      report.changes = report.changes.filter((c) => !(c.op === 'default' && c.to === a.to));
      report.changes.push({ op: 'set', from: a.from, to: a.to, value: a.value, marker: true });
    } else if (report.signature === 'mixed') {
      const to = MARKERS[kind][0];
      const value = defaultOf(schemaNode(schema, to));
      setPath(out, to, clone(value));
      report.changes.push({ op: 'set', from: null, to, value, marker: true });
    }
  }

  // 4. propConfig: move 1:1 entries, report the rest. The decision for a rangeHours binding depends only on the
  // unit the component ends up with, never on the static value: when the stored v2 unit is
  // "hours" (an existing v2 timeRange.realtime won over the converted v1 value), the binding moves exactly as a
  // second run — which no longer sees the static value — would move it; the static-value message applies only
  // when the converted smaller unit really landed.
  const unit = realtimeUnit(kind, out, schema);
  if (unit === 'hours') delete plan.manualBindings.rangeHours;
  const newConfig = migratePropConfig(kind, propConfig, report, props, false, plan.manualBindings, unit);
  const finalProps = orderLike(out, schema);
  const configChanged = !deepEqual(Object.keys(newConfig), Object.keys(propConfig));
  if (deepEqual(finalProps, props) && !configChanged) {
    report.status = 'unchanged';
    return report;
  }
  comp.props = finalProps;
  if (has(comp, 'propConfig') || Object.keys(newConfig).length) comp.propConfig = newConfig;
  report.status = report.signature === 'mixed' ? 'migrated (mixed)' : 'migrated';
  return report;
}

// v2 keys kept as an idempotence marker when everything else equals the v2 default (both are always
// assigned when v1 defaults are filled in).
const MARKERS = { display: ['units.visible', 'layout.verticalAlign'], chart: ['timeRange.mode', 'query.pointCount'] };

// Keys whose name exists in v1 AND v2 with a different shape: a binding on them cannot be classified from
// the key alone (v2 binds the whole setpoint/bounds/interaction object the same way).
const AMBIGUOUS_KEYS = { display: new Set(['setpoint', 'bounds']), chart: new Set(['interaction', 'interaction.mode']) };

/**
 * Move 1:1 propConfig entries to their v2 key; leave (and report) the rest. Returns the new propConfig.
 * @param {boolean} v2Props the component's props are already v2: ambiguous keys belong to v2 and are left alone
 */
function migratePropConfig(kind, propConfig, report, props, v2Props, overrides = {}, unit = 'hours') {
  const newConfig = {};
  for (const [key, entry] of Object.entries(propConfig)) {
    const p = key.startsWith('props.') ? key.slice(6) : null;
    let t = p !== null ? bindingTarget(kind, p) : null;
    const isBinding = !!entry?.binding;
    if (p !== null && has(overrides, p) && t?.to) t = { manual: isBinding ? overrides[p] : nonBindingManual(p, unit) };
    // A v1 rangeHours binding produces hours: it may only move next to unit "hours" (every run, every path,
    // so a binding left MANUAL by run 1 stays MANUAL on run 2). A config without a binding (onChange script,
    // persistence, access) produces nothing, but whatever it does with the value now sees <unit>.
    if (t?.to === 'timeRange.realtime.value' && unit !== 'hours') t = { manual: isBinding ? rangeHoursManual(unit) : nonBindingManual(p, unit) };
    // The target must be free: no binding on an ancestor or descendant of it (two bindings would fight over one
    // value), and a rangeHours binding also needs an unbound realtime unit (the binding produces hours, a bound
    // unit may say otherwise).
    if (t?.to) {
      const clash = boundOverlap(propConfig, newConfig, key, 'props.' + t.to)
        || (t.to === 'timeRange.realtime.value' ? boundOverlap(propConfig, newConfig, key, 'props.timeRange.realtime.unit') : null);
      if (clash) t = { manual: `${clash} is bound, which overlaps props.${t.to}; merge the two bindings by hand` };
    }
    if (t && AMBIGUOUS_KEYS[kind].has(p)) {
      if (v2Props) t = null;
      else if (p === 'setpoint' && typeof props.setpoint !== 'boolean') {
        t = isObj(props.setpoint) ? null : { manual: 'no static value tells whether this binding returns a v1 boolean ' +
          '(→ rebind props.setpoint.enabled) or a v2 setpoint object (→ keep); check the binding by hand' };
      }
    }
    if (!t || (t.to && 'props.' + t.to === key)) {
      if (!has(newConfig, key)) newConfig[key] = entry;
      continue;
    }
    const what = entry?.binding ? `binding (${entry.binding.type})` : 'property config';
    const target = t.to ? 'props.' + t.to : null;
    if (t.manual || has(newConfig, target) || has(propConfig, target)) {
      newConfig[key] = entry;
      report.manual.push({ key, what, reason: t.manual || `${target} already has a property config; merge by hand` });
      continue;
    }
    newConfig[target] = entry;
    report.changes.push({ op: 'binding', from: key, to: target, what });
    if (entry?.binding && BINDING_WARNINGS[t.to]) report.warnings.push(BINDING_WARNINGS[t.to]);
  }
  return newConfig;
}

/**
 * A bound propConfig key (other than `self`) that is `target`, an ancestor or a descendant of it, among the original
 * and the already moved entries; null when there is none.
 */
function boundOverlap(propConfig, newConfig, self, target) {
  for (const cfg of [propConfig, newConfig]) {
    for (const [k, e] of Object.entries(cfg)) {
      if (k === self || !e?.binding) continue;
      if (k === target || target.startsWith(k + '.') || k.startsWith(target + '.')) return k;
    }
  }
  return null;
}

/** Reason for a property config without a binding (onChange / persistence / access) on rangeHours. */
function nonBindingManual(p, unit) {
  return `property config (no binding) on ${p}: the value now lives in timeRange.realtime with unit ${show(unit)}, ` +
    'not hours; move the onChange/persistence/access config to props.timeRange.realtime by hand';
}

/** Effective timeRange.realtime.unit of (v2) chart props: the stored unit, else the schema default. */
function realtimeUnit(kind, props, schema) {
  if (kind !== 'chart') return 'hours';
  const u = getPath(props, 'timeRange.realtime.unit');
  if (u !== undefined) return u;
  const d = defaultOf(schemaNode(schema, 'timeRange.realtime'));
  return isObj(d) && d.unit !== undefined ? d.unit : 'hours';
}

function rangeHoursManual(unit) {
  return `timeRange.realtime.unit is ${show(unit)}, but a v1 rangeHours binding produces hours, so it cannot move to ` +
    'timeRange.realtime.value; rebind timeRange.realtime (e.g. {value: <minutes>, unit: "minutes"})';
}

/**
 * Props already v2, but v1 property configs left (typically the "manual" bindings of an earlier run, or a
 * binding added to a v1 key afterwards): the props stay as they are, 1:1 entries still move, the rest is
 * reported again so it is never forgotten.
 */
function migrateLeftoverConfig(comp, kind, propConfig, report, schema) {
  report.signature = 'v2';
  noteAmbiguousBindings(kind, propConfig, report);
  const props = comp.props || {};
  const newConfig = migratePropConfig(kind, propConfig, report, props, true, {}, realtimeUnit(kind, props, schema));
  if (deepEqual(Object.keys(newConfig), Object.keys(propConfig))) {
    report.status = 'already v2 (v1 bindings left)';
    return report;
  }
  comp.propConfig = newConfig;
  report.status = 'migrated (bindings only)';
  return report;
}

/**
 * Bindings on setpoint/bounds/interaction(.mode) of a component whose props are v2: the binding may still
 * return a v1-shaped value (left in place by an earlier run, where it was reported MANUAL) and would then
 * overwrite the v2 object at runtime. The key alone cannot tell, so every run lists it as a note.
 */
function noteAmbiguousBindings(kind, propConfig, report) {
  for (const [key, entry] of Object.entries(propConfig)) {
    if (!entry?.binding || !key.startsWith('props.') || !AMBIGUOUS_KEYS[kind].has(key.slice(6))) continue;
    report.notes.push(`check by hand: the ${entry.binding.type ?? ''} binding on ${key} must return the v2 shape ` +
      '(a v1-shaped value would overwrite the v2 object at runtime)');
  }
}

/** Visit every component of a view (root and nested `children`, any depth). */
function walkComponents(node, where, visit) {
  if (!isObj(node)) return;
  const label = `${where}${node.meta?.name ? node.meta.name : '?'}`;
  visit(node, label);
  if (Array.isArray(node.children)) node.children.forEach((c) => walkComponents(c, label + '/', visit));
}

/**
 * Migrate a parsed view.json in place.
 * @returns {{components: object[], changed: boolean}}
 */
export function migrateView(view, opts = {}, schemas = loadSchemas()) {
  const components = [];
  let changed = false;
  if (isObj(view) && isObj(view.root)) {
    // Bare components (no version-specific key) cannot be told apart: a v2 display that stores only tagPath
    // looks exactly like a v1 one. They take the version of their view:
    //   --bare auto (default): migrated only when the view holds a v1 (or mixed) component, else skipped
    //                          (listed as AMBIGUOUS; rerun with --bare v1 for views that really are v1);
    //   --bare v1:             migrated, except in a view holding v2 components and no v1 ones;
    //   --bare skip:           never touched.
    const sigs = [];
    walkComponents(view.root, '', (comp) => {
      const kind = comp.type === TYPE_DISPLAY ? 'display' : comp.type === TYPE_CHART ? 'chart' : null;
      if (kind) sigs.push(classify(kind, comp.props, comp.propConfig, schemas));
    });
    const viewHasV1 = sigs.includes('v1') || sigs.includes('mixed');
    const bare = opts.bare || 'auto';
    let compOpts = { ...opts, bare };
    if (bare !== 'skip' && sigs.includes('v2') && !viewHasV1) {
      compOpts = { ...opts, bare: 'skip', bareReason: 'view holds only v2 components' };
    } else if (bare === 'auto') {
      compOpts = viewHasV1 ? { ...opts, bare: 'v1' }
        : { ...opts, bare: 'skip', bareReason: 'ambiguous: no v1 component in this view; rerun with --bare v1 if it is a v1 view' };
    }
    walkComponents(view.root, '', (comp, where) => {
      const r = migrateComponent(comp, compOpts, schemas, where);
      if (r) {
        components.push(r);
        if (r.status.startsWith('migrated')) changed = true;
      }
    });
  }
  return { components, changed };
}

// =============================================================================
// SECTION 6 — External references
// =============================================================================
// v1 keys referenced from anywhere except the component's own props: bindings
// on other components ("{../CTG-Chart.props.rangeHours}"), event scripts
// ("self.getSibling('DisplayTemplate').props.setpoint = True"), message
// handlers, custom methods, and project library scripts. Generic names (mode,
// row, setpoint, …) also exist on other component types, so their hits are
// marked confidence "low" — the report cannot know which component a path
// resolves to.

const REF_KEYS = [
  // [v1 path, component, confidence, noDotAfter] — noDotAfter: v2 has an object of that name (props.setpoint.enabled is fine)
  ['showTagName', 'display', 'high'], ['showTagValue', 'display', 'high'], ['tagNameLabel', 'display', 'high'],
  ['valuePrecision', 'display', 'high'], ['evenRow', 'display', 'high'], ['showUnits', 'display', 'high'],
  ['tagNameStyle', 'display', 'high'], ['tagValueStyle', 'display', 'high'],
  ['boolean.textOnTrue', 'display', 'high'], ['boolean.textOnFalse', 'display', 'high'],
  ['bounds.minColor', 'display', 'high'], ['bounds.maxColor', 'display', 'high'],
  ['bounds.minInclusive', 'display', 'high'], ['bounds.maxInclusive', 'display', 'high'],
  ['row', 'display', 'low'], ['verticalAlign', 'display', 'low'], ['boolean', 'display', 'low'],
  ['setpoint', 'display', 'low', true],
  ['rangeHours', 'chart', 'high'], ['rawHistory', 'chart', 'high'], ['freeRangePanZoom', 'chart', 'high'],
  ['visibility', 'chart', 'high'], ['interaction.xTraceVisible', 'chart', 'high'],
  ['mode', 'chart', 'low'], ['pointCount', 'chart', 'low'], ['refreshRate', 'chart', 'low'],
  ['startDate', 'chart', 'low'], ['endDate', 'chart', 'low'], ['dateFormat', 'chart', 'low'], ['timeFormat', 'chart', 'low'],
];
const REF_PATTERNS = REF_KEYS.map(([key, component, confidence, noDot]) => ({
  key, component, confidence,
  re: new RegExp(`\\bprops\\.${key.replace(/\./g, '\\.')}(?![\\w${noDot ? '.' : ''}])`, 'g'),
}));

/** `props["x"]` / `props['x']` → `props.x`, and no blanks around dots, so one pattern covers Python and expressions. */
function normalizeRefLine(line) {
  return line.replace(/\[\s*(['"])([A-Za-z_]\w*)\1\s*\]/g, '.$2').replace(/\s*\.\s*(?=[A-Za-z_])/g, '.');
}

/** Hits of v1 keys in one text. Overlapping hits at one position keep the longest key. */
export function scanText(text, base) {
  const hits = [];
  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = normalizeRefLine(rawLine);
    const byPos = new Map();
    for (const p of REF_PATTERNS) {
      p.re.lastIndex = 0;
      for (let m; (m = p.re.exec(line));) {
        const prev = byPos.get(m.index);
        if (!prev || prev.key.length < p.key.length) byPos.set(m.index, p);
      }
    }
    for (const p of [...byPos.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1])) {
      hits.push({ ...base, line: i + 1, key: p.key, component: p.component, confidence: p.confidence, text: rawLine.trim().slice(0, 200) });
    }
  });
  return hits;
}

/** Scan every string of a parsed view except static component props (data, not code). */
export function scanViewRefs(view, file) {
  const hits = [];
  const visit = (v, loc, inProps) => {
    if (typeof v === 'string') {
      if (!inProps && v.includes('props')) hits.push(...scanText(v, { file, location: loc }));
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => visit(x, `${loc}[${i}]`, inProps));
    } else if (isObj(v)) {
      const isComponent = typeof v.type === 'string' && (has(v, 'meta') || has(v, 'props'));
      for (const [k, x] of Object.entries(v)) {
        const name = isComponent && k === 'children' ? 'children' : k;
        visit(x, loc ? `${loc}/${name}` : name, inProps || (isComponent && k === 'props'));
      }
    }
  };
  visit(view, '', false);
  return hits;
}

// =============================================================================
// SECTION 7 — Files, folders and zips
// =============================================================================
const isViewName = (n) => /(^|[\\/.])view\.json$/i.test(n);   // view.json, or a single exported <name>.view.json
const isScriptName = (n) => /(^|[\\/])script-python[\\/].*\.py$/i.test(n);

function collectFiles(root) {
  const st = statSync(root);
  if (st.isFile()) return [root];
  const out = [];
  const walk = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name === '.git' || ent.name === 'node_modules') continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (isViewName(p) || isScriptName(p)) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

/** Re-serialise a view the way it was written (indent, line endings, BOM, final newline). */
function serializeLike(original, obj) {
  const bom = original.startsWith('\uFEFF') ? '\uFEFF' : '';
  const m = /\n([ \t]+)"/.exec(original);
  const indent = m ? m[1] : 2;
  let s = JSON.stringify(obj, null, indent);
  if (/\r\n/.test(original)) s = s.replace(/\n/g, '\r\n');
  if (/\r?\n$/.test(original)) s += /\r\n/.test(original) ? '\r\n' : '\n';
  return bom + s;
}

/**
 * Process one document (view.json or script text).
 * @returns {{view?: object, newText?: string, refs: object[], error?: string}}
 */
export function processDocument(name, text, opts, schemas) {
  if (isScriptName(name)) return { refs: scanText(text, { file: name, location: 'script' }) };
  let view;
  try {
    view = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    return { refs: [], error: `invalid JSON: ${e.message}` };
  }
  const refs = scanViewRefs(view, name);
  const res = migrateView(view, opts, schemas);
  return { view: { file: name, components: res.components }, refs, newText: res.changed ? serializeLike(text, view) : undefined };
}

/**
 * Do two paths name the same file? Resolves 8.3 short names and links (realpath), compares case-insensitively
 * on Windows/macOS, and compares the file identity (dev + inode) when both exist.
 */
export function sameFile(a, b) {
  const norm = (p) => {
    let r = path.resolve(p);
    try { r = realpathSync.native(r); } catch { /* does not exist yet */ }
    return process.platform === 'win32' || process.platform === 'darwin' ? r.toLowerCase() : r;
  };
  if (norm(a) === norm(b)) return true;
  if (existsSync(a) && existsSync(b)) {
    const sa = statSync(a, { bigint: true });
    const sb = statSync(b, { bigint: true });
    return sa.ino !== 0n && sa.dev === sb.dev && sa.ino === sb.ino;
  }
  return false;
}

function rel(base, p) {
  const r = path.relative(base, p);
  return (r || path.basename(p)).split(path.sep).join('/');
}

/**
 * Run the migration (library entry point; the CLI wraps it).
 * @param {object} opts {input, write, out, report, keepAggregation, bare, schemaDir}
 * @returns {object} the JSON report
 */
export function run(opts) {
  const schemas = loadSchemas(opts.schemaDir);
  const input = path.resolve(opts.input);
  if (!existsSync(input)) throw new Error(`input not found: ${input}`);
  const isZip = statSync(input).isFile() && /\.zip$/i.test(input);
  const report = {
    tool: 'migrate-v1-views', version: TOOL_VERSION, generatedAt: new Date().toISOString(),
    input, mode: opts.write ? 'write' : 'dry-run', options: { keepAggregation: !!opts.keepAggregation, bare: opts.bare || 'auto' },
    output: null, summary: null, views: [], externalReferences: [], errors: [], backups: [],
  };
  const take = (name, text) => {
    const r = processDocument(name, text, opts, schemas);
    if (r.error) report.errors.push({ file: name, error: r.error });
    if (r.view && r.view.components.length) report.views.push({ ...r.view, changed: r.newText !== undefined });
    report.externalReferences.push(...r.refs);
    return r.newText;
  };

  if (isZip) {
    const zip = readZip(readFileSync(input));
    const outEntries = [];
    let changed = 0;
    for (const e of zip.entries) {
      if (!e.isDir && (isViewName(e.name) || isScriptName(e.name))) {
        let newText;
        try {
          newText = take(e.name, entryData(e).toString('utf8'));
        } catch (err) {
          report.errors.push({ file: e.name, error: err.message });
        }
        if (newText !== undefined) {
          changed++;
          outEntries.push({ ...e, data: Buffer.from(newText, 'utf8') });
          continue;
        }
      }
      outEntries.push(e);
    }
    if (opts.write) {
      const out = path.resolve(opts.out || input.replace(/\.zip$/i, '') + '-v2.zip');
      if (sameFile(out, input)) throw new Error('--out must differ from the input archive');
      writeFileSync(out + '.tmp', writeZip(outEntries, zip.comment));
      renameSync(out + '.tmp', out);
      report.output = { zip: out, changedEntries: changed };
    }
  } else {
    const base = statSync(input).isDirectory() ? input : path.dirname(input);
    for (const file of collectFiles(input)) {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch (err) {
        report.errors.push({ file: rel(base, file), error: err.message });
        continue;
      }
      const newText = take(rel(base, file), text);
      if (newText !== undefined && opts.write) {
        const bak = file + '.v1.bak';
        if (!existsSync(bak)) {
          copyFileSync(file, bak);                       // the original bytes, not the decoded text
          report.backups.push(rel(base, bak));
        }
        writeFileSync(file + '.tmp', newText);
        renameSync(file + '.tmp', file);
      }
    }
  }

  const comps = report.views.flatMap((v) => v.components);
  const migrated = comps.filter((c) => c.status.startsWith('migrated'));
  report.summary = {
    viewsWithComponents: report.views.length,
    viewsChanged: report.views.filter((v) => v.changed).length,
    components: comps.length,
    migrated: { display: migrated.filter((c) => c.type === 'Display Template').length, chart: migrated.filter((c) => c.type === 'CTG Chart').length },
    alreadyV2: comps.filter((c) => c.status.startsWith('already v2')).length,
    bareSkipped: comps.filter((c) => c.status.startsWith('skipped (bare')).length,
    warnings: comps.reduce((n, c) => n + c.warnings.length, 0),
    manualBindings: comps.reduce((n, c) => n + c.manual.length, 0),
    externalReferences: report.externalReferences.length,
    errors: report.errors.length,
  };
  if (opts.report) writeFileSync(path.resolve(opts.report), JSON.stringify(report, null, 2) + '\n');
  return report;
}

// =============================================================================
// SECTION 8 — Console summary and CLI
// =============================================================================
export function formatSummary(report, { verbose = false } = {}) {
  const L = [];
  L.push(`migrate-v1-views ${report.version} — ${report.mode === 'write' ? 'WRITE' : 'DRY RUN (nothing written; add --write to apply)'}`);
  L.push(`input: ${report.input}`);
  for (const v of report.views) {
    L.push('', `${v.file}${v.changed ? '' : '  (no change)'}`);
    for (const c of v.components) {
      L.push(`  ${c.type} "${c.where}": ${c.status}`);
      for (const ch of c.changes) {
        if (ch.op === 'set') L.push(`    ~ ${ch.from} → ${ch.to} = ${show(ch.value)}${ch.implicit ? '  (v1 default)' : ''}${ch.marker ? '  (kept as v2 marker)' : ''}`);
        else if (ch.op === 'binding') L.push(`    ⇢ ${ch.from} → ${ch.to}  [${ch.what}]`);
        else if (verbose && ch.op === 'default') L.push(`    = ${ch.from} → ${ch.to}: equals the v2 default, not written`);
        else if (verbose && ch.op === 'drop') L.push(`    - ${ch.from}: dropped (${ch.reason})`);
      }
      for (const w of c.warnings) L.push(`    ! ${w}`);
      for (const n of c.notes) L.push(`    i ${n}`);
      for (const m of c.manual) L.push(`    MANUAL ${m.key} [${m.what}]: ${m.reason}`);
    }
  }
  if (report.externalReferences.length) {
    L.push('', 'External references to v1 props (MANUAL: update these by hand):');
    for (const r of report.externalReferences) {
      L.push(`  ${r.file}:${r.location === 'script' ? r.line : `${r.location} (line ${r.line})`}  props.${r.key} [${r.component}, ${r.confidence}]  ${r.text}`);
    }
  }
  for (const e of report.errors) L.push(`ERROR ${e.file}: ${e.error}`);
  if (report.output) L.push('', `wrote ${report.output.zip} (${report.output.changedEntries} view(s) changed)`);
  if (report.backups.length) L.push('', `backups: ${report.backups.length} × view.json.v1.bak (kept once; never overwritten)`);
  const s = report.summary;
  const ambiguous = report.views.flatMap((v) => v.components.filter((c) => c.status.includes('ambiguous')).map((c) => `${v.file}  ${c.where}`));
  if (ambiguous.length) {
    L.push('', `AMBIGUOUS: ${ambiguous.length} component(s) store no v1 or v2 key and their view holds no v1 component, ` +
      'so they were NOT migrated. If these are v1 views, rerun on them with --bare v1:');
    for (const a of ambiguous) L.push(`  ${a}`);
  }
  L.push('', `summary: ${s.viewsChanged}/${s.viewsWithComponents} view(s) changed, ${s.migrated.display} display(s) + ` +
    `${s.migrated.chart} chart(s) migrated, ${s.alreadyV2} already v2, ${s.bareSkipped} bare skipped, ${s.warnings} warning(s), ${s.manualBindings} manual ` +
    `binding(s), ${s.externalReferences} external reference(s), ${s.errors} error(s)`);
  return L.join('\n');
}

const USAGE = `Usage: node simple-tag-display/tools/migrate-v1-views.mjs <input> [options]

  <input>               data/projects folder, a project folder, a views folder, one view.json,
                        or a project-export .zip
  --dry-run             report only (default)
  --write               apply: folders in place (view.json.v1.bak kept), zips to --out
  --out <file.zip>      output archive for a zip input (default <input>-v2.zip)
  --report <file.json>  write the full JSON report
  --keep-aggregation    keep v1's LastValue history aggregation (default: v2 MinMax)
  --bare <auto|v1|skip> components with no v1/v2 key (only tagPath/style): auto (default) migrates them
                        only in a view that also holds a v1 component; v1 also migrates them in views
                        with no versioned component; skip never touches them
  --verbose             also list values dropped because they equal the v2 default
  --help

Exit codes: 0 done, 1 usage or fatal error, 2 done but some files could not be read or parsed.`;

export function parseArgs(argv) {
  const o = { write: false, bare: 'auto' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--write') o.write = true;
    else if (a === '--dry-run') o.write = false;
    else if (a === '--out') o.out = next();
    else if (a === '--report') o.report = next();
    else if (a === '--keep-aggregation') o.keepAggregation = true;
    else if (a === '--verbose') o.verbose = true;
    else if (a === '--schemas') o.schemaDir = next();
    else if (a === '--bare') {
      o.bare = next();
      if (!['auto', 'v1', 'skip'].includes(o.bare)) throw new Error('--bare must be auto, v1 or skip');
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (o.input) throw new Error(`only one input allowed (got "${o.input}" and "${a}")`);
    else o.input = a;
  }
  return o;
}

export function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`error: ${e.message}\n\n${USAGE}`);
    return 1;
  }
  if (opts.help || !opts.input) {
    (opts.help ? console.log : console.error)(USAGE);
    return opts.help ? 0 : 1;
  }
  try {
    const report = run(opts);
    console.log(formatSummary(report, opts));
    return report.errors.length ? 2 : 0;
  } catch (e) {
    console.error(`error: ${e.message}`);
    return 1;
  }
}

if (isMain(import.meta.url)) {             // real paths: a symlink / junction start runs main() too
  process.exitCode = main();
}
