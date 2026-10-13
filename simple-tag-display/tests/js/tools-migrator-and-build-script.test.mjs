// =============================================================================
// tools-migrator-and-build-script.test.mjs — the v1 view migrator and build-and-sign.ps1
// =============================================================================
// (1) the v1 migrator did not know the v1.0.0 display props bounds.min/max (and the
//     pre-1.0 font / justify roots): 'mixed' + invalid v2 props;
// (2) build-and-sign.ps1 -VerifyModl with a relative path opened the file relative
//     to the PROCESS directory (crash, or another checkout's file verified);
// (3) build-and-sign.ps1 retried EVERY Gradle failure, so a flaky failing test that
//     passed on the second run was signed and deployed.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as M from '../../tools/migrate-v1-views.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleDir = path.resolve(here, '..', '..');
const SCRIPT = path.join(moduleDir, 'build-and-sign.ps1');
const schemas = M.loadSchemas();
const isWin = process.platform === 'win32';

/** Every key of `props` (root and bounds) exists in the v2 display schema (both have additionalProperties:false). */
function v2Problems(props) {
  const s = schemas.display;
  const out = [];
  for (const k of Object.keys(props)) if (!(k in s.properties)) out.push(k);
  if (props.bounds && typeof props.bounds === 'object') {
    for (const k of Object.keys(props.bounds)) if (!(k in s.properties.bounds.properties)) out.push('bounds.' + k);
  }
  return out;
}
const view = (props) => ({ root: { type: 'ia.container.flex', meta: { name: 'root' },
  children: [{ type: M.TYPE_DISPLAY, meta: { name: 'D' }, props }] } });

test('migrator: a display created under v1.0.0 (bounds.min / bounds.max stored) migrates as v1, valid v2 props', () => {
  const v = view({ tagPath: '[default]CTG/Temp', bounds: { enabled: true, min: 10, max: 90, minColor: '#FF0000', maxColor: '#00FF00',
    minInclusive: false, maxInclusive: false } });
  assert.equal(M.classify('display', v.root.children[0].props, null, schemas), 'v1', 'was mixed');
  const r = M.migrateView(v, {}, schemas);
  const out = v.root.children[0].props;
  assert.deepEqual(v2Problems(out), [], 'was bounds.min / bounds.max kept (the v2 schema rejects them)');
  assert.equal(out.bounds.enabled, true);
  assert.equal(out.bounds.lowColor, '#FF0000');
  const c = r.components[0];
  assert.ok(!c.warnings.some((w) => /both v1 and v2 keys/.test(w)), 'no false "mixed" warning');
  assert.ok(!c.warnings.some((w) => /unknown prop/.test(w)), 'no "unknown prop" warning');
  assert.ok(c.warnings.some((w) => /bounds\.min \/ bounds\.max \(10 \/ 90\)/.test(w)), 'the dropped manual limits are named');
  // a second run is a no-op
  const again = M.migrateView(v, {}, schemas);
  assert.equal(again.changed, false);
});

test('migrator: v1.0.0 defaults with bounds disabled are dropped; pre-1.0 font / justify roots are dropped with a warning', () => {
  const v = view({ tagPath: 'a', bounds: { enabled: false, min: 0, max: 100, minColor: '#FF0000', maxColor: '#00FF00' },
    tagNameFont: 'Arial', tagValueJustify: 'center', showUnits: true });
  const r = M.migrateView(v, {}, schemas);
  const out = v.root.children[0].props;
  assert.deepEqual(v2Problems(out), [], 'was: bounds {min:0,max:100} and the pre-1.0 roots kept');
  assert.equal(out.tagNameFont, undefined);
  const w = r.components[0].warnings.join('\n');
  assert.match(w, /tagNameFont \(a pre-1\.0 prop\)/);
  assert.match(w, /tagValueJustify \(a pre-1\.0 prop\)/);
});

// ---- build-and-sign.ps1 ----------------------------------------------------------------------------------------------

const ps = (command, cwd) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
  { encoding: 'utf8', timeout: 120000, cwd });

test('build-and-sign.ps1 -VerifyModl resolves a relative path against the PowerShell location', { skip: !isWin }, () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ctg-verify-'));
  try {
    mkdirSync(path.join(tmp, 'sub'));
    // an empty but valid zip: verification must REPORT its problems (exit 3), not crash
    writeFileSync(path.join(tmp, 'sub', 'x.modl'), Buffer.concat([Buffer.from('PK\x05\x06', 'latin1'), Buffer.alloc(18)]));
    const r = ps(`Set-Location -LiteralPath '${tmp.replace(/'/g, "''")}'; & '${SCRIPT.replace(/'/g, "''")}' -VerifyModl 'sub\\x.modl'; exit $LASTEXITCODE`, moduleDir);
    const outText = r.stdout + r.stderr;
    assert.equal(r.status, 3, 'was an unhandled DirectoryNotFoundException (the process directory was used): ' + outText.slice(0, 400));
    assert.match(outText, /expected exactly one common-/);
    assert.doesNotMatch(outText, /DirectoryNotFoundException|MethodInvocationException/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

test('build-and-sign.ps1 retries only the stale-output / file-lock Gradle failure, never failing tests', { skip: !isWin }, () => {
  const src = readFileSync(SCRIPT, 'utf8');
  const m = src.match(/function Test-GradleRetryable[\s\S]*?\n\}\r?\n/);
  assert.ok(m, 'was: no decision at all (every failure retried)');
  const cases = {
    stale: '> Task :gateway:compileJava FAILED\nFAILURE: Build failed with an exception.\n> Failed to clean up stale outputs',
    lock: 'java.nio.file.FileSystemException: x.jar: The process cannot access the file because it is being used by another process',
    tests: '> Task :gateway:test FAILED\nSessionSweepEvictionTest > race() FAILED\nThere were failing tests. See the report',
    testsAndStale: 'There were failing tests.\nFailed to clean up stale outputs',
    compile: 'error: cannot find symbol\n> Task :gateway:compileJava FAILED\nCompilation failed; see the compiler error output for details.',
    empty: '',
  };
  const lines = Object.entries(cases).map(([k, v]) => `'${k}=' + (Test-GradleRetryable @'\n${v}\n'@)`).join('; ');
  const r = ps(`${m[0]}\n${lines}`, moduleDir);
  const got = Object.fromEntries((r.stdout || '').trim().split(/\r?\n/).map((l) => l.split('=')));
  assert.deepEqual(got, { stale: 'True', lock: 'True', tests: 'False', testsAndStale: 'False', compile: 'False', empty: 'False' }, r.stderr);
});

test('docs and the script header name exit 3 of the deploy step correctly', () => {
  const header = readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(header, /version-check\s+errors/, 'was "1/2/3 = its general / configuration / version-check errors"');
  const doc = readFileSync(path.resolve(moduleDir, '..', 'docs', 'developer-guide', '05-building.md'), 'utf8');
  assert.doesNotMatch(doc, /installed-version check/);
  assert.match(doc, /verification failed: nothing was sent/);
  const up = readFileSync(path.resolve(moduleDir, '..', 'docs', 'user-guide', 'upgrading-from-v1.md'), 'utf8');
  assert.doesNotMatch(up, /periodic project scan/, 'the gateway does not scan by itself');
  assert.match(up, /bounds\.min` \/ `bounds\.max`/);
});
