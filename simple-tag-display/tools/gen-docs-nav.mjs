#!/usr/bin/env node
// =====================================================================================================================
//  gen-docs-nav.mjs - write the breadcrumb and the Previous / Back to index / Next footer of every page under docs/
// =====================================================================================================================
//
//  Usage (from anywhere; paths are resolved from this file):
//      node simple-tag-display/tools/gen-docs-nav.mjs            rewrite the navigation blocks in place
//      node simple-tag-display/tools/gen-docs-nav.mjs --check    exit 1 when a block is missing or out of date
//
//  WHY GENERATED
//  The docs are read on github.com, where a page has no sidebar. Every page therefore starts with a breadcrumb
//  (Docs home › User Guide › Click To Graph Chart › Properties) and ends with Previous / Back to index / Next links.
//  Written by hand, those links drift every time a page is added, renamed or reordered; generated from the one PAGES
//  list below they cannot. tests/js/docs-coverage.test.mjs runs the --check logic and also fails when a markdown file
//  under docs/ is missing from PAGES.
//
//  WHAT IT TOUCHES
//  Only the two marked blocks of each page; everything else is hand-written and never changed:
//      <!-- nav:top --> ... <!-- /nav:top -->            first lines of the page, before the H1
//      <!-- nav:bottom --> ... <!-- /nav:bottom -->      last lines of the page
//  A page without the blocks gets them added.
//
//  ADDING A PAGE
//  Add one entry to PAGES at the place it belongs in the reading order, with its parent (the index page that lists
//  it), then run the tool. Previous / Next follow the order of PAGES within each guide.
//
//  No dependencies; Node 18+.
// =====================================================================================================================

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/is-main.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_DIR = path.resolve(HERE, '..', '..');
export const DOCS_DIR = path.join(REPO_DIR, 'docs');

const UG = 'user-guide/';
const DT = UG + 'components/display-template/';
const CH = UG + 'components/ctg-chart/';
const SA = UG + 'samples/';
const DG = 'developer-guide/';

/**
 * Every page under docs/, in reading order. `crumb` is the short name used in breadcrumbs and footers, `parent` the
 * index page that lists it (null for the home page), `guide` the chain Previous / Next walk along.
 */
export const PAGES = [
  { file: 'README.md', crumb: 'Docs home', parent: null, guide: 'home' },

  { file: UG + 'README.md', crumb: 'User Guide', parent: 'README.md', guide: 'user' },
  { file: UG + 'getting-started.md', crumb: 'Getting started', parent: UG + 'README.md', guide: 'user' },
  { file: DT + 'README.md', crumb: 'Display Template', parent: UG + 'README.md', guide: 'user' },
  { file: DT + 'menu-and-setpoints.md', crumb: 'Menu and setpoints', parent: DT + 'README.md', guide: 'user' },
  { file: DT + 'styling.md', crumb: 'Styling', parent: DT + 'README.md', guide: 'user' },
  { file: DT + 'recipes.md', crumb: 'Recipes', parent: DT + 'README.md', guide: 'user' },
  { file: DT + 'properties.md', crumb: 'Properties', parent: DT + 'README.md', guide: 'user' },
  { file: DT + 'events.md', crumb: 'Events', parent: DT + 'README.md', guide: 'user' },
  { file: CH + 'README.md', crumb: 'Click To Graph Chart', parent: UG + 'README.md', guide: 'user' },
  { file: CH + 'interaction.md', crumb: 'Interaction', parent: CH + 'README.md', guide: 'user' },
  { file: CH + 'pens-axes-plots.md', crumb: 'Pens, axes and plots', parent: CH + 'README.md', guide: 'user' },
  { file: CH + 'panels-and-tools.md', crumb: 'Panels and tools', parent: CH + 'README.md', guide: 'user' },
  { file: CH + 'recipes.md', crumb: 'Recipes', parent: CH + 'README.md', guide: 'user' },
  { file: CH + 'properties.md', crumb: 'Properties', parent: CH + 'README.md', guide: 'user' },
  { file: CH + 'events.md', crumb: 'Events', parent: CH + 'README.md', guide: 'user' },
  { file: UG + 'gateway-settings.md', crumb: 'Gateway settings', parent: UG + 'README.md', guide: 'user' },
  { file: UG + 'security-and-permissions.md', crumb: 'Security and permissions', parent: UG + 'README.md', guide: 'user' },
  { file: UG + 'designer.md', crumb: 'Working in the Designer', parent: UG + 'README.md', guide: 'user' },
  { file: UG + 'operator-guide.md', crumb: 'Operator guide', parent: UG + 'README.md', guide: 'user' },
  { file: UG + 'upgrading-from-v1.md', crumb: 'Upgrading from 1.x', parent: UG + 'README.md', guide: 'user' },
  { file: UG + 'troubleshooting.md', crumb: 'Troubleshooting', parent: UG + 'README.md', guide: 'user' },
  { file: UG + 'known-limitations.md', crumb: 'Known limitations', parent: UG + 'README.md', guide: 'user' },
  { file: UG + 'faq.md', crumb: 'FAQ', parent: UG + 'README.md', guide: 'user' },
  { file: UG + 'glossary.md', crumb: 'Glossary', parent: UG + 'README.md', guide: 'user' },
  { file: SA + 'README.md', crumb: 'Samples', parent: UG + 'README.md', guide: 'user' },
  { file: SA + 'AuditLogView.md', crumb: 'Audit log view', parent: SA + 'README.md', guide: 'user' },
  { file: SA + 'setpoint-log-script.md', crumb: 'Setpoint log scripts', parent: SA + 'README.md', guide: 'user' },

  { file: DG + 'README.md', crumb: 'Developer Guide', parent: 'README.md', guide: 'dev' },
  { file: DG + '01-architecture.md', crumb: 'Architecture', parent: DG + 'README.md', guide: 'dev' },
  { file: DG + '02-javascript-primer.md', crumb: 'JavaScript primer', parent: DG + 'README.md', guide: 'dev' },
  { file: DG + '03-backend-java.md', crumb: 'Backend (Java)', parent: DG + 'README.md', guide: 'dev' },
  { file: DG + '04-frontend-javascript.md', crumb: 'Frontend JavaScript', parent: DG + 'README.md', guide: 'dev' },
  { file: DG + '05-building.md', crumb: 'Building and testing', parent: DG + 'README.md', guide: 'dev' },
  { file: DG + '06-deployment.md', crumb: 'Deployment', parent: DG + 'README.md', guide: 'dev' },
  { file: DG + '07-signing.md', crumb: 'Signing', parent: DG + 'README.md', guide: 'dev' },
  { file: DG + '08-extending-and-contributing.md', crumb: 'Extending and contributing', parent: DG + 'README.md', guide: 'dev' },
];

export const TOP_BEGIN = '<!-- nav:top -->';
export const TOP_END = '<!-- /nav:top -->';
export const BOTTOM_BEGIN = '<!-- nav:bottom -->';
export const BOTTOM_END = '<!-- /nav:bottom -->';

const byFile = new Map(PAGES.map((p) => [p.file, p]));

/** Relative link from one docs page to another (both docs-relative, forward slashes). */
function link(from, to) {
  const r = path.posix.relative(path.posix.dirname(from), to);
  return r === '' ? path.posix.basename(to) : r;
}

/** The breadcrumb line of a page: linked ancestors, then the page's own name in plain text. */
export function breadcrumb(page) {
  const chain = [];
  for (let p = page; p; p = p.parent ? byFile.get(p.parent) : null) chain.unshift(p);
  return chain.map((p, i) => (i === chain.length - 1 ? '**' + p.crumb + '**' : '[' + p.crumb + '](' + link(page.file, p.file) + ')'))
    .join(' › ');
}

/** The footer line: Previous / Up / Back to index (the guide index) / Next (each only when it exists). */
export function footer(page) {
  const parts = [];
  if (page.guide === 'home') {
    const user = PAGES.find((p) => p.guide === 'user');
    const dev = PAGES.find((p) => p.guide === 'dev');
    parts.push('Next: [' + user.crumb + '](' + link(page.file, user.file) + ') →');
    parts.push('[' + dev.crumb + '](' + link(page.file, dev.file) + ') →');
    return parts.join(' · ');
  }
  const chain = PAGES.filter((p) => p.guide === page.guide);
  const i = chain.indexOf(page);
  const prev = i > 0 ? chain[i - 1] : null;
  const next = i < chain.length - 1 ? chain[i + 1] : null;
  if (prev) parts.push('← Previous: [' + prev.crumb + '](' + link(page.file, prev.file) + ')');
  // "Back to index" always means the guide's own index (the page that lists every page of the guide). A page one
  // level deeper (a component's guide page, a sample) also gets "Up" to its own parent, unless Previous already is it.
  const parent = byFile.get(page.parent);
  const guideIndex = chain[0];
  const index = page === guideIndex ? parent : guideIndex;
  if (parent !== index && parent !== prev) parts.push('↑ Up: [' + parent.crumb + '](' + link(page.file, parent.file) + ')');
  parts.push('[Back to index](' + link(page.file, index.file) + ')');
  if (next) parts.push('Next: [' + next.crumb + '](' + link(page.file, next.file) + ') →');
  return parts.join(' · ');
}

/** Strips existing navigation blocks (and the blank lines around them) from a page. */
function strip(text) {
  let t = text;
  const top = new RegExp('^' + esc(TOP_BEGIN) + '[\\s\\S]*?' + esc(TOP_END) + '\\n*');
  t = t.replace(top, '');
  const bottom = new RegExp('\\n*' + esc(BOTTOM_BEGIN) + '[\\s\\S]*?' + esc(BOTTOM_END) + '\\n*$');
  t = t.replace(bottom, '\n');
  return t.replace(/\n+$/, '\n');
}
function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** The full expected content of one page, given its current text. */
export function renderPage(page, text) {
  const body = strip(text.replace(/\r\n/g, '\n'));
  return TOP_BEGIN + '\n\n' + breadcrumb(page) + '\n\n' + TOP_END + '\n\n' + body + '\n' +
    BOTTOM_BEGIN + '\n\n---\n\n' + footer(page) + '\n\n' + BOTTOM_END + '\n';
}

/** Every markdown file under docs/, docs-relative with forward slashes. */
export function docsMarkdown(dir = DOCS_DIR, base = '') {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    // OneDrive folders can be cloud reparse points that Node reports as symbolic links: ask stat, not the dirent
    const isDir = e.isDirectory() || (e.isSymbolicLink() && statSync(path.join(dir, e.name)).isDirectory());
    if (isDir) out.push(...docsMarkdown(path.join(dir, e.name), base + e.name + '/'));
    else if (e.name.endsWith('.md')) out.push(base + e.name);
  }
  return out.sort();
}

/** Problems with the PAGES list itself: files not listed, listed files that do not exist, unknown parents. */
export function listProblems() {
  const files = new Set(docsMarkdown());
  const listed = new Set(PAGES.map((p) => p.file));
  const out = [];
  for (const f of files) if (!listed.has(f)) out.push(f + ' is not in PAGES (gen-docs-nav.mjs)');
  for (const p of PAGES) {
    if (!files.has(p.file)) out.push(p.file + ' is in PAGES but does not exist');
    if (p.parent && !byFile.has(p.parent)) out.push(p.file + ': unknown parent ' + p.parent);
  }
  return out;
}

function main(argv) {
  const check = argv.includes('--check');
  const problems = listProblems();
  if (problems.length) {
    for (const p of problems) console.log('ERROR       ' + p);
    return 1;
  }
  let stale = 0;
  for (const page of PAGES) {
    const file = path.join(DOCS_DIR, page.file);
    const current = readFileSync(file, 'utf8');
    const next = renderPage(page, current);
    if (next === current.replace(/\r\n/g, '\n')) continue;
    if (check) {
      stale++;
      console.log('OUT OF DATE docs/' + page.file + '  (run: node simple-tag-display/tools/gen-docs-nav.mjs)');
    } else {
      writeFileSync(file, next);
      console.log('written     docs/' + page.file);
    }
  }
  if (!stale) console.log((check ? 'up to date  ' : 'done        ') + PAGES.length + ' pages');
  return stale ? 1 : 0;
}

if (isMain(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
