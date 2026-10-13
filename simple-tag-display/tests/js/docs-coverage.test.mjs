// =============================================================================
// docs-coverage.test.mjs — the documentation keeps up with the code, and the public repository stays clean
// =============================================================================
// Run:  node --test "simple-tag-display/tests/js/*.test.mjs"
//
// Documentation drifts silently: a prop is added to a schema, a setting to ModuleSettings, an error code to the
// enum, and nobody notices that the docs never mention it. These checks make that drift a failing test:
//
//   1. The generated property and event tables in docs/user-guide/components/<component>/properties.md and
//      events.md are exactly what tools/gen-prop-docs.mjs produces from the shipped schemas, and every top-level prop
//      and every event sits in exactly one generated block (fix: run the generator / add a block).
//   2. Every path of both props schemas (`setpoint.access.roles`, `pens[].color`, ...) appears, in backticks, on
//      its component's properties.md; every event and every event field on its events.md.
//   3. Every `ctg.*` system property the gateway reads (ModuleSettings and the debug-only hooks) is documented in
//      docs/user-guide/gateway-settings.md.
//   4. Every ErrorCode constant is listed in docs/user-guide/troubleshooting.md.
//   4b. The other direction: every code in the troubleshooting error table exists in ErrorCode.java with the HTTP
//      status shown, and every setting named in the settings tables is read by the gateway, so a renamed or removed
//      code or setting leaves no stale row behind.
//   5. Every delegate message name in Protocol.java is in docs/developer-guide/01-architecture.md.
//   6. Every relative link in README.md and docs/**.md points at an existing file that git does not ignore (so it
//      also exists in a fresh clone), and every #anchor at an existing heading (GitHub's slug rules).
//   6b. Navigation: every markdown page under docs/ is in the page list of tools/gen-docs-nav.mjs and carries the
//      breadcrumb and the Previous / Back to index / Next footer that tool writes (fix: run the tool).
//   7. Public-repo hygiene: no private IPv4 addresses, nothing that looks like an Ignition API key, no site
//      identifiers or local user paths in any tracked text file.
//   8. No internal development-process references (work-package and fix-round ids, private design notes, local
//      reports, test-plan ids) in any tracked text file: comments explain the code, not the history of the project.
//
// The source files are read as text (no Gradle build needed), the same way resource-urls.test.mjs reads Java.
// Each checker is also run against a bad sample, so a regex slip cannot turn a check into a no-op.
// No dependencies: node:test + node:assert only.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TARGETS, KINDS, REPO_DIR, MODULE_DIR, loadPropsSchema, loadEventSchemas, schemaPaths, regenerate, boundsOf,
} from '../../tools/gen-prop-docs.mjs';
import { PAGES, renderPage, listProblems, DOCS_DIR as NAV_DOCS_DIR, TOP_BEGIN, BOTTOM_BEGIN } from '../../tools/gen-docs-nav.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
assert.equal(path.resolve(here, '..', '..'), MODULE_DIR, 'generator and test agree on the module folder');

const DOCS_DIR = path.join(REPO_DIR, 'docs');
const JAVA_COMMON = path.join(MODULE_DIR, 'common', 'src', 'main', 'java', 'com', 'example', 'simpletagdisplay', 'common');
const JAVA_GATEWAY = path.join(MODULE_DIR, 'gateway', 'src', 'main', 'java');

const read = (f) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const doc = (name) => read(path.join(DOCS_DIR, name));

/** Every file below `dir` whose name passes `keep`. */
function walk(dir, keep) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    // OneDrive folders can be cloud reparse points that Node reports as symbolic links: ask stat, not the dirent
    if (e.isDirectory() || (e.isSymbolicLink() && statSync(p).isDirectory())) out.push(...walk(p, keep));
    else if (keep(e.name)) out.push(p);
  }
  return out;
}

/** Inline-code spans of a markdown text (the docs name every prop, setting and code in backticks). */
function codeSpans(md) {
  const set = new Set();
  for (const m of md.matchAll(/`([^`\n]+)`/g)) set.add(m[1].trim());
  return set;
}

/** Items of `wanted` that are not mentioned as `item` (alone in a code span, or followed by `=` / ` ` inside one). */
export function missingFrom(md, wanted) {
  const spans = codeSpans(md);
  const all = [...spans].join('\n');
  return wanted.filter((w) => !spans.has(w) && !new RegExp('(^|[\\s(/])' + escapeRe(w) + '($|[\\s=/,)])', 'm').test(all));
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ---------------------------------------------------------------------------------------------------------------------
// 1 + 2. Props and events
// ---------------------------------------------------------------------------------------------------------------------

test('generated prop and event tables are up to date (run tools/gen-prop-docs.mjs)', () => {
  for (const t of TARGETS) {
    for (const kind of KINDS) {
      const current = read(t[kind]);
      assert.equal(current, regenerate(t.id, kind, current), path.relative(REPO_DIR, t[kind]) + ' is out of date');
    }
  }
});

test('the generator refuses a page whose blocks miss, repeat or invent a prop or event', () => {
  const block = (names) => '<!-- BEGIN GENERATED: props displaytemplate ' + names + ' -->\n<!-- END GENERATED: props displaytemplate ' + names + ' -->\n';
  const all = Object.keys(loadPropsSchema('displaytemplate').properties);
  assert.ok(regenerate('displaytemplate', 'props', block(all.join(','))).includes('`setpoint.access.roles`'));
  assert.throws(() => regenerate('displaytemplate', 'props', block(all.slice(1).join(','))), /tagPath is in no block/);
  assert.throws(() => regenerate('displaytemplate', 'props', block(all.join(',')) + block('label')), /label is in 2 blocks/);
  assert.throws(() => regenerate('displaytemplate', 'props', block(all.join(',') + ',nope')), /nope is not in the schema/);
  assert.throws(() => regenerate('displaytemplate', 'props', 'no markers'), /no "props displaytemplate" block/);
  assert.throws(() => regenerate('displaytemplate', 'events', '<!-- BEGIN GENERATED: events displaytemplate onMenuAction -->'),
    /has no matching/);
});

test('every schema path of both components is documented on its properties page', () => {
  for (const t of TARGETS) {
    const md = read(t.props);
    const paths = schemaPaths(loadPropsSchema(t.id));
    assert.ok(paths.length > 150, t.id + ': schema walk found ' + paths.length + ' paths');
    assert.deepEqual(missingFrom(md, paths), [], path.relative(REPO_DIR, t.props) + ' misses schema paths');
  }
});

test('every row of the generated property tables has a description (schema text or a generator fallback)', () => {
  for (const t of TARGETS) {
    const rows = read(t.props).split('\n').filter((l) => /^\| `[^`]+` \|/.test(l));
    assert.ok(rows.length > 150, t.id + ': found ' + rows.length + ' rows');
    // the last cell is the description; "One of …" / "Range …" alone is a constraint, not a description
    const bare = rows.filter((l) => {
      const cells = l.split(/(?<!\\)\|/);
      const desc = (cells[cells.length - 2] || '').trim();
      return desc === '' || /^(One of `|(Range|Minimum|Maximum) -?\d)/.test(desc);
    }).map((l) => l.split('|')[1].trim());
    assert.deepEqual(bare, [], path.relative(REPO_DIR, t.props) + ': rows without a description (add one to the schema '
      + 'or to FIXED_DESCRIPTIONS in tools/gen-prop-docs.mjs)');
  }
});

test('every component event and every payload field is documented on its events page', () => {
  for (const t of TARGETS) {
    const md = read(t.events);
    const events = loadEventSchemas(t.id);
    assert.equal(events.length, 4, t.id + ' declares 4 events');
    for (const ev of events) {
      assert.deepEqual(missingFrom(md, [ev.name]), [], t.id + ': event ' + ev.name);
      assert.deepEqual(missingFrom(md, Object.keys(ev.schema.properties)), [], t.id + '.' + ev.name + ' fields');
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// 3. Gateway settings
// ---------------------------------------------------------------------------------------------------------------------

/** Delegate message names declared in Protocol.java (`ctg.hello`, `dt.write`, ...). */
function protocolMessages() {
  const src = read(path.join(JAVA_COMMON, 'protocol', 'Protocol.java'));
  return [...src.matchAll(/String\s+[A-Z_]+\s*=\s*"((?:ctg|dt|chart)\.[A-Za-z.]+)"/g)].map((m) => m[1]);
}

/** Every `"ctg.*"` string literal in the gateway sources that is not a message name: the system properties read. */
function gatewayProperties() {
  const messages = new Set(protocolMessages());
  const props = new Set();
  for (const f of walk(JAVA_GATEWAY, (n) => n.endsWith('.java'))) {
    for (const m of read(f).matchAll(/"(ctg\.[A-Za-z][A-Za-z0-9.]*)"/g)) {
      if (!messages.has(m[1]) && !m[1].endsWith('.')) props.add(m[1]);
    }
  }
  return [...props].sort();
}

test('every ctg.* system property the gateway reads is documented in gateway-settings.md', () => {
  const props = gatewayProperties();
  assert.ok(props.length >= 50, 'found ' + props.length + ' properties');
  for (const p of ['ctg.write.requireAuthenticated', 'ctg.settings.rev', 'ctg.debug.historyDelayMs', 'ctg.session.sweepMs']) {
    assert.ok(props.includes(p), 'the scan finds ' + p);
  }
  assert.deepEqual(missingFrom(doc('user-guide/gateway-settings.md'), props), [], 'undocumented settings');
});

// ---------------------------------------------------------------------------------------------------------------------
// 4 + 5. Error codes and messages
// ---------------------------------------------------------------------------------------------------------------------

function errorCodes() {
  const src = read(path.join(JAVA_COMMON, 'protocol', 'ErrorCode.java'));
  return [...src.matchAll(/^\s{4}([A-Z][A-Z0-9_]+)\(/gm)].map((m) => m[1]);
}

test('every ErrorCode is listed in troubleshooting.md', () => {
  const codes = errorCodes();
  assert.ok(codes.length >= 50, 'found ' + codes.length + ' codes');
  assert.ok(codes.includes('BOUND_BIDIRECTIONAL') && codes.includes('BAD_REQUEST'));
  assert.deepEqual(missingFrom(doc('user-guide/troubleshooting.md'), codes), [], 'undocumented error codes');
});

/** {NAME: httpStatus} of every ErrorCode constant (`NAME(retryable, httpStatus, "text")`). */
function errorCodeStatus() {
  const src = read(path.join(JAVA_COMMON, 'protocol', 'ErrorCode.java'));
  return Object.fromEntries([...src.matchAll(/^\s{4}([A-Z][A-Z0-9_]+)\(\s*(?:true|false)\s*,\s*(\d+)/gm)]
    .map((m) => [m[1], Number(m[2])]));
}

/**
 * Rows of the first markdown table after `heading`: [{names: [codes in the first cell], cells: [...]}]. The table
 * ends at the first non-table line, so a second table further down the section is not included.
 */
export function firstTableAfter(md, heading) {
  const lines = md.split('\n');
  let i = lines.findIndex((l) => l.trim() === heading);
  if (i < 0) return [];
  while (i < lines.length && !lines[i].startsWith('|')) i++;
  const rows = [];
  for (i += 2; i < lines.length && lines[i].startsWith('|'); i++) {
    const cells = lines[i].split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim());
    rows.push({ names: [...cells[0].matchAll(/`([^`]+)`/g)].map((m) => m[1]), cells });
  }
  return rows;
}

test('every code in the troubleshooting error table exists, with its HTTP status', () => {
  const status = errorCodeStatus();
  assert.ok(Object.keys(status).length >= 50, 'parsed ' + Object.keys(status).length + ' codes with a status');
  const rows = firstTableAfter(doc('user-guide/troubleshooting.md'), '## Error codes');
  assert.ok(rows.length >= 40, 'found ' + rows.length + ' rows');
  const bad = [];
  for (const r of rows) {
    for (const code of r.names) {
      if (!(code in status)) {
        bad.push(code + ': not in ErrorCode.java');
        continue;
      }
      const want = status[code] === 0 ? '–' : String(status[code]);
      if (r.cells[1] !== want) bad.push(code + ': HTTP ' + r.cells[1] + ', ErrorCode says ' + want);
    }
  }
  assert.deepEqual(bad, []);
});

test('every setting named in the settings tables exists in the gateway sources', () => {
  const props = new Set(gatewayProperties());
  const md = doc('user-guide/gateway-settings.md');
  const named = [];
  for (const line of md.split('\n')) {
    if (!line.startsWith('| `ctg.')) continue;
    const first = line.split('|')[1];
    for (const m of first.matchAll(/`(ctg\.[A-Za-z0-9.]+)`/g)) named.push(m[1]);
  }
  assert.ok(named.length >= 50, 'found ' + named.length + ' documented settings');
  assert.deepEqual(named.filter((n) => !props.has(n)), [], 'documented but not read by the gateway');
});

test('the table parser and the bounds wording handle the edge cases', () => {
  const rows = firstTableAfter('## Error codes\n\ntext\n\n| Code | HTTP |\n|---|---|\n| `A` / `B` | 400 |\n| `C` | – |\n\n| `D` | x |', '## Error codes');
  assert.deepEqual(rows.map((r) => r.names), [['A', 'B'], ['C']]);
  assert.deepEqual(boundsOf({ minimum: 1 }), ['Minimum 1.']);
  assert.deepEqual(boundsOf({ maximum: 100 }), ['Maximum 100.']);
  assert.deepEqual(boundsOf({ minimum: 1, maximum: 9 }), ['Range 1 to 9.']);
  assert.deepEqual(boundsOf({ exclusiveMinimum: 0, maximum: 100 }), ['Maximum 100.', 'Greater than 0.']);
  assert.deepEqual(boundsOf({ minimum: 0, exclusiveMinimum: true }), ['Greater than 0.']);
  assert.deepEqual(boundsOf({}), []);
});

test('every delegate message is in the architecture catalogue', () => {
  const msgs = protocolMessages();
  assert.ok(msgs.length >= 25, 'found ' + msgs.length + ' messages');
  assert.deepEqual(missingFrom(doc('developer-guide/01-architecture.md'), msgs), [], 'undocumented messages');
});

// ---------------------------------------------------------------------------------------------------------------------
// 6. Links
// ---------------------------------------------------------------------------------------------------------------------

/** GitHub heading slug: lower case, punctuation removed (except - and _), spaces to dashes. */
export function slug(heading) {
  return heading.trim().toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Anchors of a markdown file: headings outside fenced code blocks, duplicates suffixed -1, -2 like GitHub. */
export function anchors(md) {
  const seen = new Map();
  const out = new Set();
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const base = slug(m[2]);
    const n = seen.get(base) || 0;
    seen.set(base, n + 1);
    out.add(n ? base + '-' + n : base);
  }
  return out;
}

/** Relative links of a markdown file (outside code), as {target, anchor, raw}. */
function links(md) {
  const out = [];
  let fence = false;
  for (const line of md.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const text = line.replace(/`[^`]*`/g, '');
    for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      const raw = m[1];
      if (/^[a-z]+:/i.test(raw)) continue;          // http:, https:, mailto:
      const [target, anchor] = raw.split('#');
      out.push({ raw, target: decodeURIComponent(target), anchor: anchor || null });
    }
  }
  return out;
}

/** The published markdown: the repository README and every page under docs/. */
function markdownFiles() {
  return [path.join(REPO_DIR, 'README.md'), ...walk(DOCS_DIR, (n) => n.endsWith('.md'))].filter((f) => existsSync(f));
}

/**
 * The paths among `absPaths` that git ignores. Such a file can exist in a working copy (local notes, build output)
 * but never in a clone, so a link to it is broken for every reader of the repository. Tracked files are never
 * reported (git check-ignore consults the index).
 */
export function gitIgnored(absPaths) {
  const rel = [...new Set(absPaths)].map((p) => path.relative(REPO_DIR, p).split(path.sep).join('/'));
  if (!rel.length) return new Set();
  let out;
  try {
    out = execFileSync('git', ['check-ignore', '-z', '--stdin'], { cwd: REPO_DIR, input: rel.join('\0'), encoding: 'utf8' });
  } catch (e) {
    if (e.status !== 1) throw e;                    // 1 = nothing is ignored
    out = e.stdout || '';
  }
  return new Set(out.split('\0').filter(Boolean).map((r) => path.resolve(REPO_DIR, r)));
}

/** Broken links of one file: [] when every target and anchor exists and no target is git-ignored. */
export function brokenLinks(file, md, ignored = new Set()) {
  const bad = [];
  for (const l of links(md)) {
    const target = l.target ? path.resolve(path.dirname(file), l.target) : file;
    if (!existsSync(target)) { bad.push(l.raw + ' (no such file)'); continue; }
    if (ignored.has(target)) { bad.push(l.raw + ' (ignored by git: missing in a clone)'); continue; }
    if (l.anchor && statSync(target).isFile() && target.endsWith('.md')) {
      if (!anchors(read(target)).has(l.anchor)) bad.push(l.raw + ' (no such heading)');
    }
  }
  return bad;
}

test('the slug and link checkers catch bad samples', () => {
  assert.equal(slug('One global: `window.__CTG`'), 'one-global-window__ctg');
  assert.equal(slug('What changed in 2.0.0'), 'what-changed-in-200');
  assert.equal(slug('Floor policy: writes and tag configuration edits'), 'floor-policy-writes-and-tag-configuration-edits');
  const a = anchors('# A\n## A\n```\n# not a heading\n```\n### B c');
  assert.deepEqual([...a], ['a', 'a-1', 'b-c']);
  const self = path.join(DOCS_DIR, 'user-guide', 'security-and-permissions.md');
  assert.deepEqual(brokenLinks(self, '[ok](#trusted-props) [x](nope.md) [y](#no-such-heading) [z](https://x)'),
    ['nope.md (no such file)', '#no-such-heading (no such heading)']);
  // a link to a file that exists here but is git-ignored (local notes, build output) is broken in a clone
  const glossary = path.join(DOCS_DIR, 'user-guide', 'glossary.md');
  assert.deepEqual(brokenLinks(self, '[g](glossary.md)', new Set([glossary])), ['glossary.md (ignored by git: missing in a clone)']);
  assert.deepEqual([...gitIgnored([glossary])], [], 'a tracked page is never reported as ignored');
  assert.deepEqual([...gitIgnored([path.join(REPO_DIR, 'simple-tag-display', 'build', 'x.modl')])],
    [path.join(REPO_DIR, 'simple-tag-display', 'build', 'x.modl')], 'build output is ignored');
  assert.deepEqual(missingFrom('`setpoint.enabled` and `ctg.write.allowedRoots=[default]A`',
    ['setpoint.enabled', 'ctg.write.allowedRoots', 'setpoint']), ['setpoint']);
});

test('every relative link and anchor in README and docs resolves, also in a fresh clone', () => {
  const files = markdownFiles();
  assert.ok(files.length >= 35, 'found ' + files.length + ' markdown files');
  assert.ok(files.some((f) => f.endsWith(path.join('samples', 'setpoint-log-script.md'))), 'the walk enters every folder');
  const texts = new Map(files.map((f) => [f, read(f)]));
  const targets = [];
  for (const [f, md] of texts) {
    for (const l of links(md)) if (l.target) targets.push(path.resolve(path.dirname(f), l.target));
  }
  const ignored = gitIgnored(targets.filter((t) => existsSync(t)));
  const bad = [];
  for (const [f, md] of texts) {
    for (const b of brokenLinks(f, md, ignored)) bad.push(path.relative(REPO_DIR, f) + ': ' + b);
  }
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// 6b. Navigation (breadcrumb + footer)
// ---------------------------------------------------------------------------------------------------------------------

test('the navigation tool and this test agree on the docs folder', () => {
  assert.equal(NAV_DOCS_DIR, DOCS_DIR);
});

test('every docs page is in the navigation list and has an up-to-date breadcrumb and footer (run tools/gen-docs-nav.mjs)', () => {
  assert.deepEqual(listProblems(), []);
  assert.ok(PAGES.length >= 35, 'pages: ' + PAGES.length);
  const stale = [];
  for (const page of PAGES) {
    const current = read(path.join(DOCS_DIR, page.file));
    if (current !== renderPage(page, current)) stale.push(page.file);
    // the breadcrumb opens the page and the H1 follows it; the footer closes it with a link back to the index
    assert.ok(current.startsWith(TOP_BEGIN), page.file + ': breadcrumb first');
    assert.match(current, /<!-- \/nav:top -->\n\n# /, page.file + ': H1 right after the breadcrumb');
    assert.ok(current.includes(BOTTOM_BEGIN), page.file + ': footer');
    if (page.parent) assert.match(current, /\[Back to index\]\(/, page.file + ': back to index');
  }
  assert.deepEqual(stale, []);
});

test('the navigation renderer replaces its blocks instead of stacking them', () => {
  const page = PAGES.find((p) => p.file === 'user-guide/glossary.md');
  const once = renderPage(page, '# Glossary\n\ntext\n');
  assert.equal(renderPage(page, once), once);
  assert.match(once, /\[Docs home\]\(\.\.\/README\.md\) › \[User Guide\]\(README\.md\) › \*\*Glossary\*\*/);
  assert.match(once, /← Previous: \[FAQ\]\(faq\.md\) · \[Back to index\]\(README\.md\) · Next: \[Samples\]\(samples\/README\.md\) →/);
});

// ---------------------------------------------------------------------------------------------------------------------
// 7. Public-repo hygiene
// ---------------------------------------------------------------------------------------------------------------------

const PRIVATE_IP = /\b(10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/;
// Ignition API keys are "<name>:<long secret>"; placeholders like "your-key-name:your-secret" are fine.
const API_KEY = /\b[A-Za-z0-9_-]{2,40}:[A-Za-z0-9_-]{30,}\b/;

test('the hygiene patterns catch bad samples', () => {
  assert.ok(PRIVATE_IP.test('http://10.1.2.3:8088'));
  assert.ok(PRIVATE_IP.test('192.168.1.20'));
  assert.ok(!PRIVATE_IP.test('version 2.0.0.1 or 127.0.0.1'));
  assert.ok(API_KEY.test('demo:Zk3mT9vQw8xR2yL5nB7cD1fG4hJ6kM0pS'));
  assert.ok(!API_KEY.test('your-key-name:your-secret'));
});

test('README and docs contain no private addresses or API keys', () => {
  const bad = [];
  for (const f of [...markdownFiles(), ...walk(DOCS_DIR, (n) => n.endsWith('.json'))]) {
    read(f).split('\n').forEach((line, i) => {
      if (PRIVATE_IP.test(line) || API_KEY.test(line)) bad.push(path.relative(REPO_DIR, f) + ':' + (i + 1));
    });
  }
  assert.deepEqual(bad, []);
});

// The scan covers every tracked text file, not only the docs: exported views, scripts and notes can carry a real site's
// tag provider and equipment paths or a local user path. The site denylist holds only SHA-256 hashes of lower-cased
// words, so this public test does not name what it guards against.
const SITE_WORD_HASHES = new Set([
  '696a538a77f97e06131e99062d6cd4d7916618f3e0752d7d2391a5e27c113f25',
  '095442740af2d17cbfa967cc7788e73fb2b9130584227b06cbec93d3fc8cc3cf',
  '4dd0e5b84ba9fbbdcb5a44c4ee373c516bf7a039552c06a6513b13524f4abf5e',   // ctg_hygiene_canary (self-test only)
]);
// a real Windows profile path (placeholders such as C:\Users\<you> or %USERPROFILE% are fine)
const USER_PATH = /[A-Za-z]:[\\/]+Users[\\/]+(?![<%${]|you\b|Public\b|Default\b|USERNAME\b)[A-Za-z0-9._-]{2,}/i;
const BINARY_EXT = /\.(min\.js|jks|p7b|pfx|cer|modl|png|jpe?g|gif|ico|svgz|jar|gz|zip|class|pptx|docx|pdf)$/i;
const SELF = path.relative(REPO_DIR, fileURLToPath(import.meta.url)).split(path.sep).join('/');

function siteWords(line) {
  const hits = [];
  for (const m of line.matchAll(/[A-Za-z0-9_]+/g)) {
    if (SITE_WORD_HASHES.has(createHash('sha256').update(m[0].toLowerCase()).digest('hex'))) hits.push(m[0]);
  }
  return hits;
}

/** Problems of one tracked text file: [{line, kind}] (private IPs are allowed in unit-test fixtures). */
export function hygieneProblems(rel, text) {
  const out = [];
  const fixture = /(^|\/)src\/test\//.test(rel);
  text.split('\n').forEach((line, i) => {
    if (siteWords(line).length) out.push({ line: i + 1, kind: 'site identifier' });
    if (USER_PATH.test(line)) out.push({ line: i + 1, kind: 'local user path' });
    if (API_KEY.test(line)) out.push({ line: i + 1, kind: 'API key' });
    if (!fixture && PRIVATE_IP.test(line)) out.push({ line: i + 1, kind: 'private address' });
  });
  return out;
}

test('the all-files hygiene scan catches bad samples', () => {
  assert.deepEqual(hygieneProblems('views/x.json', '"TagPath": "[CTG_Hygiene_Canary]Line 1/Value"').map((p) => p.kind), ['site identifier']);
  assert.deepEqual(hygieneProblems('notes/x.md', 'cd "C:\\Users\\jdoe\\Desktop\\repo"').map((p) => p.kind), ['local user path']);
  assert.deepEqual(hygieneProblems('docs/x.md', 'C:\\Users\\<you>\\repo and %USERPROFILE% and C:\\Users\\Public').length, 0);
  assert.deepEqual(hygieneProblems('a/src/test/X.java', 'setHost("10.0.0.5")').length, 0, 'unit-test fixture addresses');
  assert.deepEqual(hygieneProblems('a/main/X.java', 'http://10.0.0.5:8088').map((p) => p.kind), ['private address']);
});

/** Every git-tracked text file except this one, as [{rel, text}]: binaries (by extension or a NUL byte) are skipped. */
function trackedTextFiles() {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_DIR, encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.ok(files.length > 100, 'tracked files: ' + files.length);
  const out = [];
  for (const rel of files) {
    if (rel === SELF || BINARY_EXT.test(rel)) continue;
    let buf;
    try { buf = readFileSync(path.join(REPO_DIR, rel)); } catch { continue; }   // deleted in the working tree
    if (buf.includes(0)) continue;
    out.push({ rel, text: buf.toString('utf8').replace(/\r\n/g, '\n') });
  }
  assert.ok(out.length > 100, 'scanned ' + out.length);
  return out;
}

test('every tracked text file is free of site identifiers, local user paths, private addresses and API keys', () => {
  const bad = [];
  for (const { rel, text } of trackedTextFiles()) {
    for (const p of hygieneProblems(rel, text)) bad.push(rel + ':' + p.line + ' ' + p.kind);
  }
  assert.deepEqual(bad, []);
});

// ---------------------------------------------------------------------------------------------------------------------
// 8. No internal development-process references
// ---------------------------------------------------------------------------------------------------------------------
// Comments, test titles, messages and docs must make sense to a reader who has only this repository. Ids that point
// into private working notes (work packages, fix rounds, change requests, design-document sections, test-plan and
// security-matrix ids) or at files that are not published mean nothing to that reader: say what the code does and why.
//
// Not scanned: binaries and minified third-party code (BINARY_EXT; e.g. uplot.min.js) and this file, which defines the
// patterns and their bad samples. The test fixtures (tests/js/fixtures, tests/vectors) are scanned: they hold no such
// strings. Files that must name these things on purpose are listed in INTERNAL_REF_ALLOW with the reason and the lines
// that are skipped; everything else in them is still checked.

const INTERNAL_REFS = [
  ['work-package id', /\bWP\d+[ab]?\b/],
  ['fix-round id', /\bFIX[A-I]\b/],
  ['change-request id', /\bCCR-[A-Z0-9]/],
  ['work-package name', /\b(?:AUTHDEF|CHARTX|BACKX|SQLHIST)\b/],
  ['design-document reference', /\bDESIGN(?: §| [A-Z]{1,2}-\d|\.md\b)/],
  ['private notes file', /\b(?:backend|display|chart)\.md\b/],
  ['unpublished report or backlog', /\bV2_REPORT\b|\bBACKLOG\b/],
  ['process role', /\b[Oo]rchestrator\b/],
  ['owner decision', /\bowner(?:'s)? decision\b|\bproject owner\b/i],
  ['security-matrix id', /\bSEC-\d+[a-z]?\b/],
  ['test-plan id', /\bT-[A-Z]+-\d/],
  ['private working folder', /(?:^|[\s`'"(])\.work\//],
];

const INTERNAL_REF_ALLOW = {
  '.gitignore': {
    reason: 'its patterns name the local notes and working folders that must stay out of the repository',
    skip: (line) => !line.trimStart().startsWith('#'),      // patterns are skipped; comments are still checked
  },
};

/** Internal references in one tracked text file: [{line, kind, match}]. */
export function internalRefs(rel, text) {
  const allow = INTERNAL_REF_ALLOW[rel];
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (allow && allow.skip(line)) return;
    for (const [kind, re] of INTERNAL_REFS) {
      const m = re.exec(line);
      if (m) out.push({ line: i + 1, kind, match: m[0].trim() });
    }
  });
  return out;
}

test('the internal-reference patterns catch bad samples and leave ordinary code alone', () => {
  const kinds = (s) => internalRefs('x/y.js', s).map((h) => h.kind);
  const bad = {
    'see WP11 for the mapping': 'work-package id', 'WP1b security foundation': 'work-package id',
    'fixed in FIXC': 'fix-round id', 'CCR-SEARCH-1 declined': 'change-request id', 'per CCR-7': 'change-request id',
    'the CHARTX strip': 'work-package name', 'SQLHIST fallback': 'work-package name',
    'DESIGN §5': 'design-document reference', '(DESIGN I-26)': 'design-document reference',
    'per DESIGN.md': 'design-document reference', 'see backend.md §3': 'private notes file',
    'chart.md §2.7': 'private notes file', 'display.md §10': 'private notes file',
    'V2_REPORT.md §9': 'unpublished report or backlog', 'BACKLOG #26': 'unpublished report or backlog',
    'the orchestrator chose': 'process role', 'reversed by the project owner': 'owner decision',
    "the owner's decision": 'owner decision', 'security matrix SEC-12': 'security-matrix id',
    'SEC-6b': 'security-matrix id', 'misses T-STRESS-9': 'test-plan id', '(T-CHUNK-1 logic)': 'test-plan id',
    'node .work/scenarios/soak.mjs': 'private working folder',
  };
  for (const [sample, kind] of Object.entries(bad)) assert.deepEqual(kinds(sample), [kind], sample);
  const ok = ['FIXED_DESCRIPTIONS[p]', 'const WPF = 1;', 'UTF-8, ISO-8601 and GMT-5', 'X-CTG-Limit: capacity',
    'ACCEPT_BACKLOG = 50', 'designer.md#manual-checklist', 'display-template/README.md', 'ctg-chart.js SECTION 14a',
    'Sec-Fetch-Site: cross-site', 'annotations.edit.ownOnly: the owner of a note', 'a.work/b', 'Math.round(x)',
    'design mode', 'POST-1 and HTTP-2', 'fix #4: a colour patch'];
  for (const sample of ok) assert.deepEqual(kinds(sample), [], sample);
  // the allow-list skips only the lines it names
  assert.deepEqual(internalRefs('.gitignore', '/BACKLOG.md\n.work/\n# kept out (WP13)').map((h) => h.line), [3]);
});

test('tracked source and docs contain no internal development-process references', () => {
  const files = trackedTextFiles();
  const tracked = new Set(files.map((f) => f.rel));
  for (const [rel, a] of Object.entries(INTERNAL_REF_ALLOW)) {
    assert.ok(tracked.has(rel), 'allow-list entry ' + rel + ' is not a tracked text file (remove it)');
    assert.ok(a.reason, 'allow-list entry ' + rel + ' states its reason');
  }
  const report = [];
  for (const { rel, text } of files) {
    const hits = internalRefs(rel, text);
    if (!hits.length) continue;
    const shown = hits.slice(0, 5).map((h) => h.line + ' ' + JSON.stringify(h.match)).join(', ');
    report.push(rel + ': ' + hits.length + ' (' + shown + (hits.length > 5 ? ', ...' : '') + ')');
  }
  assert.deepEqual(report, [], 'internal references (rewrite them as plain explanations): ' + report.length + ' files');
});
