// =============================================================================
// resource-urls.test.mjs — every module resource URL carries ?v=<version>
// =============================================================================
// The gateway caches the seven allow-listed module files as `immutable` for a
// year (SimpleTagDisplayGatewayHook.IMMUTABLE_RESOURCES). That is
// only safe while EVERY reference to /res/simpletagdisplay/... carries the
// content-hash cache buster ?v=<RESOURCE_VERSION>: a reference without it would
// pin a browser to an old copy for a year (the old stale-JS problem, worse).
//
// Checked here, without a build:
//   1. mounted JS/CSS (ours; the vendored uPlot files are skipped): every
//      '/res/simpletagdisplay/...' string literal, template literal or CSS
//      url(...) is followed by ?v= in the same literal, or concatenated with a
//      '?v=' literal right after it (e.g. '/res/simpletagdisplay/js/uplot.min.js?v=' + NS.build);
//   2. Java: BROWSER_RESOURCES entries all go through resourceUrl(), whose format
//      contains ?v=%s, and no other Java string literal names /res/simpletagdisplay/;
//   3. the hook's immutable allow-list names exactly existing files.
// The checker itself is tested against bad samples, so a regex slip cannot
// silently turn the test into a no-op.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { JS_DIR } from './_stubs.mjs';

const MOUNTED = path.dirname(JS_DIR);
const MODULE_ROOT = path.resolve(MOUNTED, '..', '..', '..', '..', '..');
const ALIAS = '/res/simpletagdisplay/';
const VENDORED = new Set(['js/uplot.min.js', 'css/uplot.min.css']);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Removes /* *\/ and // comments (rough, but string-aware enough for our files). */
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += n || ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; continue; }
    if (c === '/' && n === '/' && src[i - 1] !== ':' && src[i - 1] !== '\\') {
      const e = src.indexOf('\n', i); i = e < 0 ? src.length : e; continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Returns the offending snippets: references to ALIAS whose literal does not contain ?v= and is not followed
 * (after the closing quote) by + '?v=' / + "?v=" / + `?v=`.
 */
export function unversionedReferences(code) {
  const bad = [];
  let from = 0;
  for (;;) {
    const i = code.indexOf(ALIAS, from);
    if (i < 0) break;
    from = i + ALIAS.length;
    // the rest of this literal / url(...) token
    const rest = code.slice(i, i + 400);
    const end = rest.search(/['"`)\s]/);
    const literal = end < 0 ? rest : rest.slice(0, end);
    if (literal.includes('?v=') || literal.includes('?v=${')) continue;
    const after = rest.slice(end < 0 ? rest.length : end + 1);
    if (/^\s*\+\s*(['"`])\?v=/.test(after)) continue;
    bad.push(literal);
  }
  return bad;
}

test('the checker flags unversioned references and accepts versioned ones', () => {
  assert.deepEqual(unversionedReferences("load('/res/simpletagdisplay/js/uplot.min.js')"), ['/res/simpletagdisplay/js/uplot.min.js']);
  assert.deepEqual(unversionedReferences('url(/res/simpletagdisplay/css/x.css)'), ['/res/simpletagdisplay/css/x.css']);
  assert.deepEqual(unversionedReferences("load('/res/simpletagdisplay/js/uplot.min.js?v=' + NS.build)"), []);
  assert.deepEqual(unversionedReferences("load('/res/simpletagdisplay/js/uplot.min.js' + '?v=' + v)"), []);
  assert.deepEqual(unversionedReferences('load(`/res/simpletagdisplay/js/a.js?v=${NS.build}`)'), []);
  assert.deepEqual(unversionedReferences("x = '/res/simpletagdisplay/js/a.js' + suffix"), ['/res/simpletagdisplay/js/a.js']);
  assert.equal(stripComments("a // '/res/simpletagdisplay/x'\nb /* /res/simpletagdisplay/y */ c").includes(ALIAS), false);
  assert.equal(stripComments("s = 'http://h/res/simpletagdisplay/z?v=1'").includes(ALIAS), true);
});

test('mounted JS/CSS reference module resources only with ?v=', () => {
  const files = walk(MOUNTED).filter(f => /\.(m?js|css)$/i.test(f));
  assert.ok(files.length >= 5, 'found the mounted files');
  const problems = [];
  for (const f of files) {
    const rel = path.relative(MOUNTED, f).split(path.sep).join('/');
    if (VENDORED.has(rel)) continue;
    for (const literal of unversionedReferences(stripComments(readFileSync(f, 'utf8')))) {
      problems.push(`${rel}: ${literal}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('BROWSER_RESOURCES are built by resourceUrl(), which appends ?v=', () => {
  const javaFile = path.join(MODULE_ROOT, 'common', 'src', 'main', 'java', 'com', 'example', 'simpletagdisplay', 'common',
    'SimpleTagDisplayModule.java');
  const src = stripComments(readFileSync(javaFile, 'utf8'));
  const fmt = /String\.format\("\/res\/%s\/%s\?v=%s", URL_ALIAS, relativePath, RESOURCE_VERSION\)/;
  assert.match(src, fmt, 'resourceUrl() format carries ?v=');
  const block = src.slice(src.indexOf('BROWSER_RESOURCES'), src.indexOf(')));', src.indexOf('BROWSER_RESOURCES')));
  const entries = block.match(/js\("[^"]+", "[^"]+"\)/g) || [];
  assert.equal(entries.length, 5, 'five browser resources');
  assert.match(src, /private static BrowserResource js\(String name, String relativePath\) \{\s*return new BrowserResource\(name, resourceUrl\(relativePath\)/);
  for (const e of entries) {
    const rel = /js\("[^"]+", "([^"]+)"\)/.exec(e)[1];
    assert.ok(existsSync(path.join(MOUNTED, rel)), `${rel} exists under mounted/`);
  }
});

test('no other Java string literal names /res/simpletagdisplay/ directly', () => {
  const javaRoots = ['common', 'gateway', 'designer'].map(p => path.join(MODULE_ROOT, p, 'src', 'main', 'java'));
  const problems = [];
  for (const root of javaRoots) {
    if (!existsSync(root)) continue;
    for (const f of walk(root).filter(x => x.endsWith('.java'))) {
      const src = stripComments(readFileSync(f, 'utf8'));
      if (src.includes('"/res/simpletagdisplay/') || src.includes('"res/simpletagdisplay/')) {
        problems.push(path.relative(MODULE_ROOT, f));
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('the immutable allow-list names exactly the five module scripts and uPlot', () => {
  const hook = readFileSync(path.join(MODULE_ROOT, 'gateway', 'src', 'main', 'java', 'com', 'example', 'simpletagdisplay',
    'gateway', 'SimpleTagDisplayGatewayHook.java'), 'utf8');
  const block = hook.slice(hook.indexOf('IMMUTABLE_RESOURCES = Set.of('), hook.indexOf(');', hook.indexOf('IMMUTABLE_RESOURCES = Set.of(')));
  const listed = (block.match(/"([^"]+)"/g) || []).map(s => s.slice(1, -1)).sort();
  assert.deepEqual(listed, ['css/uplot.min.css', 'js/ctg-chart-panels.js', 'js/ctg-chart-tools.js', 'js/ctg-chart.js',
    'js/ctg-common.js', 'js/display-template.js', 'js/uplot.min.js']);
  for (const rel of listed) assert.ok(existsSync(path.join(MOUNTED, rel)), rel);
});
