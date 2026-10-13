#!/usr/bin/env node
// =====================================================================================================================
//  gen-prop-docs.mjs - generate the property and event tables of docs/user-guide/ from the shipped JSON schemas
// =====================================================================================================================
//
//  Usage (from the repository root or anywhere; paths are resolved from this file):
//      node simple-tag-display/tools/gen-prop-docs.mjs            rewrite the generated blocks in place
//      node simple-tag-display/tools/gen-prop-docs.mjs --check    exit 1 when a generated block is out of date
//
//  WHY GENERATED
//  The two props schemas (common/src/main/resources/schemas/*.props.json) are the single source of truth for prop
//  names, types, defaults, ranges and descriptions: the Designer's property editor shows the same descriptions. Hand-
//  written tables drift; generated ones cannot, because tests/js/docs-coverage.test.mjs regenerates every block in
//  memory and fails when the file on disk differs (and when any schema path is missing from the docs).
//
//  WHAT IT TOUCHES
//  Only the text between a pair of markers in the User Guide's component pages:
//      docs/user-guide/components/<component>/properties.md
//          <!-- BEGIN GENERATED: props displaytemplate label,value --> ... <!-- END GENERATED: props displaytemplate label,value -->
//      docs/user-guide/components/<component>/events.md
//          <!-- BEGIN GENERATED: events displaytemplate onSetpointWrite --> ... <!-- END GENERATED: events displaytemplate onSetpointWrite -->
//  (the same for "ctgchart"). The list after the component id names the top-level props (or the events) a block holds;
//  a block without a list holds all of them. Every top-level prop and every event must be in exactly one block of its
//  page, so a prop added to a schema fails --check until a block (with a hand-written intro above it) takes it.
//  Everything outside the markers is hand-written prose and is never changed.
//
//  OUTPUT SHAPE
//  A props block is one table with every path of its top-level props, in schema order. Paths use the notation of the
//  property tree: `setpoint.access.roles`, array items as `pens[].color`. An events block is the event's description
//  and a table of its payload fields. Headings (and so the link anchors) are hand-written around the blocks.
//  A description that starts with [S] marks a gateway-read security key
//  (docs/user-guide/security-and-permissions.md, "Trusted props").
//
//  No dependencies; Node 18+.
// =====================================================================================================================

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MODULE_DIR = path.resolve(HERE, '..');
export const REPO_DIR = path.resolve(MODULE_DIR, '..');
export const SCHEMA_DIR = path.join(MODULE_DIR, 'common', 'src', 'main', 'resources', 'schemas');

/** Which schema feeds which pages. `id` is the marker name and the schema/event file prefix. */
const COMPONENTS_DIR = path.join(REPO_DIR, 'docs', 'user-guide', 'components');
export const TARGETS = [
  {
    id: 'displaytemplate',
    props: path.join(COMPONENTS_DIR, 'display-template', 'properties.md'),
    events: path.join(COMPONENTS_DIR, 'display-template', 'events.md'),
  },
  {
    id: 'ctgchart',
    props: path.join(COMPONENTS_DIR, 'ctg-chart', 'properties.md'),
    events: path.join(COMPONENTS_DIR, 'ctg-chart', 'events.md'),
  },
];
export const KINDS = ['props', 'events'];

// ---------------------------------------------------------------------------------------------------------------------
// Schema walking
// ---------------------------------------------------------------------------------------------------------------------

/** Loads `<id>.props.json`. */
export function loadPropsSchema(id) {
  return JSON.parse(readFileSync(path.join(SCHEMA_DIR, id + '.props.json'), 'utf8'));
}

/** Loads every `events/<id>.<event>.json` as [{name, schema}], sorted by name. */
export function loadEventSchemas(id) {
  const dir = path.join(SCHEMA_DIR, 'events');
  return readdirSync(dir)
    .filter((f) => f.startsWith(id + '.') && f.endsWith('.json'))
    .map((f) => ({ name: f.slice(id.length + 1, -5), schema: JSON.parse(readFileSync(path.join(dir, f), 'utf8')) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Flattens a props schema into rows in document order: {path, top, node}. Objects contribute their own row and then
 * their properties; arrays contribute their own row and then the properties of their item object as `name[].x`.
 */
export function flattenSchema(schema) {
  const rows = [];
  const visit = (node, p, top) => {
    rows.push({ path: p, top, node });
    if (node && node.properties) {
      for (const [k, v] of Object.entries(node.properties)) visit(v, p + '.' + k, top);
    }
    if (node && node.items && node.items.properties) {
      for (const [k, v] of Object.entries(node.items.properties)) visit(v, p + '[].' + k, top);
    }
  };
  for (const [k, v] of Object.entries(schema.properties || {})) visit(v, k, k);
  return rows;
}

/** Every documented path of a props schema (what the coverage test looks for). */
export function schemaPaths(schema) {
  return flattenSchema(schema).map((r) => r.path);
}

// ---------------------------------------------------------------------------------------------------------------------
// Cell rendering
// ---------------------------------------------------------------------------------------------------------------------

const STYLE_REF = 'urn:ignition-schema:schemas/style-properties.schema.json';

/** Markdown-safe table cell: pipes escaped, line breaks flattened. */
function cell(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function typeOf(node) {
  if (!node) return 'any';
  if (node.$ref === STYLE_REF) return 'style';
  let t = Array.isArray(node.type) ? node.type.join(' \\| ') : node.type;
  if (!t) return 'any';
  if (node.format === 'color') t += ' (colour)';
  if (t === 'array' && node.items) {
    const it = node.items.$ref === STYLE_REF ? 'style' : node.items.properties ? 'object' : (node.items.type || 'any');
    t = 'array of ' + (Array.isArray(it) ? it.join('/') : it) + (node.items.format === 'color' ? ' (colour)' : '');
  }
  return t;
}

/** Defaults: scalars always; objects never (their leaves carry the defaults); short arrays inline. */
function defaultOf(node) {
  if (!node || !('default' in node)) return '';
  const d = node.default;
  if (d !== null && typeof d === 'object' && !Array.isArray(d)) {
    if (node.$ref === STYLE_REF) return '';
    return node.properties ? '' : '`' + cell(JSON.stringify(d)) + '`';
  }
  const json = JSON.stringify(d);
  if (Array.isArray(d) && json.length > 60) return '(' + d.length + ' entries, see schema)';
  return '`' + cell(json) + '`';
}

/**
 * The numeric bounds of a schema node as sentences: "Range 1 to 100." when both inclusive bounds exist, otherwise
 * "Minimum 1." / "Maximum 100.", plus "Greater than 0." / "Less than 10." for exclusive bounds (draft-06+ numbers;
 * a draft-04 boolean exclusiveMinimum turns the inclusive bound into an exclusive one).
 */
export function boundsOf(node) {
  const out = [];
  let lo = node.minimum;
  let hi = node.maximum;
  let xlo = typeof node.exclusiveMinimum === 'number' ? node.exclusiveMinimum : undefined;
  let xhi = typeof node.exclusiveMaximum === 'number' ? node.exclusiveMaximum : undefined;
  if (node.exclusiveMinimum === true && lo !== undefined) { xlo = lo; lo = undefined; }
  if (node.exclusiveMaximum === true && hi !== undefined) { xhi = hi; hi = undefined; }
  if (lo !== undefined && hi !== undefined) out.push('Range ' + lo + ' to ' + hi + '.');
  else if (lo !== undefined) out.push('Minimum ' + lo + '.');
  else if (hi !== undefined) out.push('Maximum ' + hi + '.');
  if (xlo !== undefined) out.push('Greater than ' + xlo + '.');
  if (xhi !== undefined) out.push('Less than ' + xhi + '.');
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Fallback descriptions
// ---------------------------------------------------------------------------------------------------------------------
//  Many leaves of the schemas carry no description because their meaning is obvious in the Designer's property tree
//  (a toolbar button flag, the text of a menu item, a colour). A reader of the docs has no tree around the row, so a
//  row without a description gets a short generic sentence derived from its path. The schema description always wins;
//  a fallback never adds a [S] marker (only the schema decides what is a security key).

const ALARM_PRIORITIES = ['critical', 'high', 'medium', 'low', 'diagnostic'];
const RANGE_COLUMN_NAMES = {
  first: 'First (value at the brush start)', last: 'Last', delta: 'Delta (last minus first)', minimum: 'Minimum',
  maximum: 'Maximum', average: 'Average (time-weighted)', median: 'Median', standardDeviation: 'Standard deviation',
  sum: 'Sum', lcl: 'LCL (lower control limit)', ucl: 'UCL (upper control limit)', count: 'Count (number of samples)',
};
const COLUMN_NAMES = { minimum: 'Minimum', maximum: 'Maximum', axis: 'Axis', plot: 'Plot', units: 'Units' };
const TOOLBAR_BUTTONS = {
  dateRange: 'date range pill (opens the date range dialog)', xTrace: 'X-Trace mode', pan: 'Pan mode',
  zoom: 'Zoom mode', rangeBrush: 'Range (brush) mode', refresh: 'Refresh', resetZoom: 'Reset zoom',
  export: 'Export menu (CSV / PNG)', fullscreen: 'Fullscreen',
};
const POPUP_FLAGS = {
  modal: 'Modal popup: the rest of the page cannot be used while it is open.',
  draggable: 'The user can move the popup by its title bar.',
  resizable: 'The user can resize the popup.',
  showCloseIcon: 'Show the close (×) icon in the popup title bar.',
  overlayDismiss: 'A click outside the popup closes it.',
  viewportBound: 'Keep the popup inside the browser window.',
};
const FIXED_DESCRIPTIONS = {
  'states.boolean': 'Texts shown for Boolean values.',
  'alarms.thresholds[].inclusive': 'A value equal to above / below counts as crossing it.',
  'setpoint.spinner': 'Adds − / + buttons to numeric inputs.',
  'menu.trend.addLabel': 'Text of the item that adds the tag to the trend list.',
  'menu.trend.removeLabel': 'Text of the item that removes the tag from the trend list.',
  'menu.trendPage.enabled': "Show 'Go to Trend Page'.",
  'menu.trendPopup.enabled': "Show 'Open Trend Popup'.",
  'menu.setValue.enabled': "Show 'Set Value…' (only on a setpoint).",
  'menu.copyPath': "'Copy Tag Path' item: copies the tag path to the clipboard.",
  'menu.items[].id': 'Identifier passed to onMenuAction as action.',
  'menu.items[].label': 'Text of the item.',
  'menu.items[].enabled': 'Show the item.',
  'menu.items[].separatorBefore': 'Draw a separator line above the item.',
  'layout': 'Arrangement of label and value, and automatic font sizing.',
  'layout.autoFontSize.enabled': 'Scale the label and value fonts with the component size. A font-size set in style, label.style, value.style, a class or project CSS switches it off.',
  'pens[].display': 'How the pen is drawn: type, curve, line, fill, points and per-state styles.',
  'timeRange.realtime': 'Length of the realtime window: the last value × unit.',
  'timeRange.historical': 'Fixed window for historical mode.',
  'query.chunking': 'Load long raw windows in pieces, newest first, with progress and Cancel.',
  'axes[].label': 'Axis title.',
  'axes[].label.visible': 'Show the axis title.',
  'axes[].range': 'Value range of the axis.',
  'axes[].grid': 'Horizontal grid lines of this axis.',
  'plots[].markers[].type': 'line = a horizontal line at value; band = a shaded band from min to max.',
  'plots[].markers[].value': "Value of a line marker, on the marker's axis.",
  'plots[].markers[].min': 'Lower edge of a band marker.',
  'plots[].markers[].max': 'Upper edge of a band marker.',
  'plots[].markers[].width': 'Line width in px.',
  'plots[].markers[].label': 'Optional text drawn at the marker.',
  'plots[].markers[].label.text': 'Marker text. Empty = no label.',
  'plots[].markers[].label.position': 'Side of the plot where the label is drawn.',
  'timeAxis': 'The shared time (x) axis.',
  'timeAxis.visible': 'Show the time axis labels.',
  'timeAxis.grid': 'Vertical grid lines.',
  'timeAxis.grid.visible': 'Draw vertical grid lines.',
  'interaction': 'Mouse, touch and keyboard behaviour: modes, X-Trace, range brush.',
  'interaction.panAndZoom': 'Pan and zoom behaviour.',
  'interaction.xTrace': 'X-Trace cursor: pinned cursors, info box and line style.',
  'interaction.xTrace.infoBox': "The box with every pen's value at the cursor.",
  'interaction.xTrace.infoBox.visible': 'Show the info box.',
  'interaction.xTrace.line': 'Style of the cursor line.',
  'interaction.xTrace.line.width': 'Cursor line width in px.',
  'axes[].range.min': 'Lower end of a manual range. null = automatic on that side.',
  'axes[].range.max': 'Upper end of a manual range. null = automatic on that side.',
  'interaction.xTrace.values[].time': 'Fixed time of the cursor (epoch ms).',
  'interaction.xTrace.values[].fromEndMs': 'Distance of the cursor before the live edge (ms); the cursor moves with now.',
  'interaction.rangeBrush.values[].start': 'Brush start (epoch ms).',
  'interaction.rangeBrush.values[].end': 'Brush end (epoch ms).',
  'interaction.rangeBrush': 'Range brush mode: brushes, statistics and colours.',
  'interaction.rangeBrush.values[].id': 'Identifier of the brush (set by the chart).',
  'interaction.rangeBrush.values[].plot': 'Index of the plot the brush rectangle is drawn on.',
  'interaction.rangeBrush.active': 'Look of the selected brush.',
  'interaction.rangeBrush.inactive': 'Look of the other brushes.',
  'interaction.rangeBrush.controlLimits': 'How the LCL / UCL columns are computed.',
  'penTable.visible': 'Show the pen table.',
  'toolbar': 'The toolbar above the plot.',
  'toolbar.visible': 'Show the toolbar.',
  'settingsPanel': 'The settings panel (toolbar ⚙) where users change pens, axes, plots and columns.',
  'settingsPanel.tabs': 'Tabs shown in the settings panel.',
  'settingsPanel.allowEditTagPath': "Allow changing a pen's tag path in the Pens tab. Runtime pens must be inside readScope.",
  'export': "The toolbar's export menu.",
  'export.csv': 'CSV export.',
  'export.csv.enabled': 'Offer CSV export.',
  'export.png': 'PNG image export.',
  'export.png.enabled': 'Offer PNG export.',
  'annotations.types': 'Which kinds of annotation are shown and can be added.',
  'appearance': 'Colours, fonts and general look.',
  'outputs.range.start': 'READ-ONLY: start of the visible window (epoch ms).',
  'outputs.range.end': 'READ-ONLY: end of the visible window (epoch ms).',
  'outputs.range.followLive': 'READ-ONLY: true while the chart follows the live edge.',
  'outputs.status.state': 'READ-ONLY: loading, live, paused, historical, stale, error or empty.',
  'outputs.status.message': 'READ-ONLY: the banner or state text shown to the user; empty when there is none.',
  'timeRange.presets[].value': 'Amount of the quick pick, in unit.',
  'timeRange.presets[].unit': 'Unit of the quick pick.',
  'axes[].position': 'Side of the plot the axis is drawn on.',
  'interaction.rangeBrush.max': 'Most brushes at once.',
  'interaction.rangeBrush.controlLimits.sigma': 'Multiplier of the spread for LCL / UCL (3 = three sigma).',
  'penTable.position': 'Where the pen table sits: below the plots or to their right.',
  'alarms.thresholds[].priority': 'Priority (colour and marker) shown while the value crosses this threshold.',
  'menu.trendPopup.popup.width': 'Popup width in px.',
  'menu.trendPopup.popup.height': 'Popup height in px.',
  'menu.trendPopup.popup.position': 'center = centred in the window; pointer = opens at the right-click position.',
  'layout.verticalAlign': 'Vertical position of the content inside the component box.',
  'layout.autoFontSize.labelScale': "Label font size as a fraction of the component's smaller side (width or height).",
  'layout.autoFontSize.valueScale': "Value font size as a fraction of the component's smaller side (width or height).",
  'layout.autoFontSize.min': 'Smallest font size in px.',
  'layout.autoFontSize.max': 'Largest font size in px.',
  'outputs.status.lastUpdate': 'READ-ONLY: time of the last successful update (epoch ms), written at most every 10 s.',
};

/** Generic description for a row whose schema node has none (see above); '' when none applies. */
export function fallbackOf(p, byPath) {
  if (FIXED_DESCRIPTIONS[p]) return FIXED_DESCRIPTIONS[p];
  // trendPens.defaults.* and trendPens.overrides[].* mirror the pen options
  const tp = /^trendPens\.(?:defaults|overrides\[\])\.(.+)$/.exec(p);
  if (tp) {
    const twin = 'pens[].' + tp[1];
    const node = byPath && byPath.get(twin);
    const desc = ((node && node.description) || FIXED_DESCRIPTIONS[twin] || '').replace(/^\[S\]\s*/, '');
    return 'As `' + twin + '`' + (desc ? ': ' + desc : '.');
  }
  let m;
  if (/\.access\.roles$/.test(p)) return 'The user needs at least one of these roles (exact, case-sensitive names). Empty = no role requirement.';
  if (/\.access\.securityLevels$/.test(p)) return 'The user needs at least one of these security levels, e.g. Authenticated/Roles/Operator. Empty = no requirement.';
  if (/\.access\.requireLogin$/.test(p)) return 'Require a logged-in user.';
  if (/^menu\.\w+\.label$/.test(p)) return 'Text of the menu item.';
  if ((m = /^menu\.trendPopup\.popup\.(\w+)$/.exec(p)) && POPUP_FLAGS[m[1]]) return POPUP_FLAGS[m[1]];
  if ((m = /^alarms\.colors\.([a-z]+?)(Text)?$/.exec(p)) && ALARM_PRIORITIES.includes(m[1])) {
    const pr = m[1][0].toUpperCase() + m[1].slice(1);
    return m[2] ? 'Text colour on the ' + pr + ' alarm background. Empty = the built-in colour.'
      : 'Colour for ' + pr + ' alarms: the background, or the text / border colour with alarms.appearance text / border. Empty = the built-in colour.';
  }
  if ((m = /^penTable\.rangeColumns\.(\w+)$/.exec(p)) && RANGE_COLUMN_NAMES[m[1]]) {
    return 'Show the ' + RANGE_COLUMN_NAMES[m[1]] + ' column of the range brush statistics.';
  }
  if ((m = /^penTable\.columns\.(\w+)$/.exec(p)) && COLUMN_NAMES[m[1]]) return 'Show the ' + COLUMN_NAMES[m[1]] + ' column.';
  if ((m = /^toolbar\.buttons\.(\w+)$/.exec(p)) && TOOLBAR_BUTTONS[m[1]]) return 'Show the ' + TOOLBAR_BUTTONS[m[1]] + ' button.';
  if ((m = /^settingsPanel\.tabs\.(\w+)$/.exec(p))) return 'Show the ' + m[1][0].toUpperCase() + m[1].slice(1) + ' tab.';
  if (/\.dash$/.test(p)) return 'Dash pattern in px, e.g. [6, 3]. Empty = solid.';
  if (/\.opacity$/.test(p)) return 'Opacity (0 = invisible, 1 = opaque).';
  if (/(?:^|\.)color$/.test(p)) return 'Colour. Empty = the theme default.';
  return '';
}

function notesOf(node, p, byPath) {
  const parts = [];
  let desc = (node && node.description) || (p ? fallbackOf(p, byPath) : '');
  if (desc.startsWith('[S]')) desc = '**[S]**' + desc.slice(3);
  if (desc) parts.push(desc);
  if (node && node.enum) parts.push('One of ' + node.enum.map((e) => '`' + JSON.stringify(e).replace(/^"|"$/g, '') + '`').join(', ') + '.');
  if (node) parts.push(...boundsOf(node));
  if (node && node.maxLength !== undefined) parts.push('Max length ' + node.maxLength + '.');
  if (node && node.items && node.items.enum) parts.push('Items: ' + node.items.enum.map((e) => '`' + e + '`').join(', ') + '.');
  if (node && node.minItems !== undefined) parts.push('At least ' + node.minItems + ' item(s).');
  if (node && node.maxItems !== undefined) parts.push('At most ' + node.maxItems + ' item(s).');
  if (node && node.$ref === STYLE_REF) parts.push('Perspective style object (inline style + `classes`).');
  return cell(parts.join(' '));
}

// ---------------------------------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------------------------------

/** The generated props table for the given top-level props of one schema (markdown, no trailing newline). */
export function renderProps(schema, tops) {
  const want = tops ? new Set(tops) : null;
  const out = ['| Prop | Type | Default | Description |', '|---|---|---|---|'];
  const rows = flattenSchema(schema);
  const byPath = new Map(rows.map((r) => [r.path, r.node]));
  for (const r of rows) {
    if (want && !want.has(r.top)) continue;
    out.push('| `' + r.path + '` | ' + typeOf(r.node) + ' | ' + defaultOf(r.node) + ' | ' + notesOf(r.node, r.path, byPath) + ' |');
  }
  return out.join('\n');
}

/** The generated description and payload table of the given events (markdown, no trailing newline). */
export function renderEvents(events, names) {
  const out = [];
  for (const ev of events) {
    if (names && !names.includes(ev.name)) continue;
    if (out.length) out.push('');
    if (ev.schema.description) out.push(cell(ev.schema.description), '');
    out.push('| Field | Type | Description |', '|---|---|---|');
    for (const [k, v] of Object.entries(ev.schema.properties || {})) {
      out.push('| `' + k + '` | ' + typeOf(v) + ' | ' + cell(v.description || '') + ' |');
    }
  }
  return out.join('\n');
}

const BLOCK = /<!-- BEGIN GENERATED: (props|events) ([A-Za-z]+)(?: ([A-Za-z0-9_,]+))? -->/g;
const NOTE = '<!-- Generated by simple-tag-display/tools/gen-prop-docs.mjs from the schemas. Do not edit by hand. -->';

/** The marker blocks of one kind and component in a text: [{names|null, begin, end}] (throws on a missing END). */
export function findBlocks(text, kind, id) {
  const out = [];
  for (const m of text.matchAll(BLOCK)) {
    if (m[1] !== kind || m[2] !== id) continue;
    const endMarker = '<!-- END GENERATED: ' + kind + ' ' + id + (m[3] ? ' ' + m[3] : '') + ' -->';
    const j = text.indexOf(endMarker, m.index);
    if (j < 0) throw new Error('marker "' + m[0] + '" has no matching "' + endMarker + '"');
    out.push({ names: m[3] ? m[3].split(',') : null, begin: m.index + m[0].length, end: j });
  }
  return out;
}

/** Every top-level prop (or event) must sit in exactly one block, and every name in a block must exist. */
export function checkCoverage(kind, id, blocks, all) {
  if (!blocks.length) throw new Error('no "' + kind + ' ' + id + '" block found');
  const seen = new Map();
  for (const b of blocks) for (const n of (b.names || all)) seen.set(n, (seen.get(n) || 0) + 1);
  const problems = [];
  for (const n of all) {
    if (!seen.has(n)) problems.push(n + ' is in no block');
    else if (seen.get(n) > 1) problems.push(n + ' is in ' + seen.get(n) + ' blocks');
  }
  for (const n of seen.keys()) if (!all.includes(n)) problems.push(n + ' is not in the schema');
  if (problems.length) throw new Error(kind + ' ' + id + ': ' + problems.join('; '));
}

/** The full expected content of one generated page (`kind` = props | events), given its current text. */
export function regenerate(id, kind, text) {
  const t = text.replace(/\r\n/g, '\n');
  const blocks = findBlocks(t, kind, id);
  let all;
  let render;
  if (kind === 'props') {
    const schema = loadPropsSchema(id);
    all = Object.keys(schema.properties || {});
    render = (names) => renderProps(schema, names);
  } else {
    const events = loadEventSchemas(id);
    all = events.map((e) => e.name);
    render = (names) => renderEvents(events, names);
  }
  checkCoverage(kind, id, blocks, all);
  let out = '';
  let at = 0;
  for (const b of blocks) {
    out += t.slice(at, b.begin) + '\n' + NOTE + '\n\n' + render(b.names) + '\n\n';
    at = b.end;
  }
  return out + t.slice(at);
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------------

function main(argv) {
  const check = argv.includes('--check');
  let stale = 0;
  for (const target of TARGETS) {
    for (const kind of KINDS) {
      const file = target[kind];
      const current = readFileSync(file, 'utf8');
      const next = regenerate(target.id, kind, current);
      if (next === current.replace(/\r\n/g, '\n')) {
        console.log('up to date  ' + path.relative(REPO_DIR, file));
        continue;
      }
      if (check) {
        stale++;
        console.log('OUT OF DATE ' + path.relative(REPO_DIR, file) + '  (run: node simple-tag-display/tools/gen-prop-docs.mjs)');
      } else {
        writeFileSync(file, next);
        console.log('written     ' + path.relative(REPO_DIR, file));
      }
    }
  }
  return stale ? 1 : 0;
}

if (isMain(import.meta.url)) {             // real paths: a symlink / junction start runs main() too
  process.exitCode = main(process.argv.slice(2));
}
