// =============================================================================
// tools-symlinked-entry.test.mjs — the CLIs started through a symlink /
// junction run their main() (they used to run nothing and exit 0)
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const moduleDir = path.resolve(here, '..', '..');

function linked(fn) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'ctg-link-'));
  const link = path.join(tmp, 'jn');
  try {
    symlinkSync(moduleDir, link, process.platform === 'win32' ? 'junction' : 'dir');
    return fn(link);
  } finally {
    try { rmSync(link, { recursive: false, force: true }); } catch { /* junction removal */ }
    rmSync(tmp, { recursive: true, force: true });
  }
}
const node = (args) => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 60000 });

test('migrate-v1-views.mjs through a junction/symlink runs main() (a missing input is an error, exit 1)', () => {
  linked((link) => {
    const r = node([path.join(link, 'tools', 'migrate-v1-views.mjs'), path.join(link, 'definitely-missing-input')]);
    assert.equal(r.status, 1, 'was 0 with no output: ' + JSON.stringify(r.stdout + r.stderr));
    assert.match(r.stderr, /input not found/);
  });
});

test('gen-prop-docs.mjs --check through a junction/symlink really checks', () => {
  linked((link) => {
    const r = node([path.join(link, 'tools', 'gen-prop-docs.mjs'), '--check']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /up to date/, 'was: no output at all');
  });
});

test('isMain compares real paths', async () => {
  const { isMain } = await import(pathToFileURL(path.join(moduleDir, 'tools', 'lib', 'is-main.mjs')).href);
  const file = path.join(moduleDir, 'tools', 'gen-prop-docs.mjs');
  assert.equal(isMain(pathToFileURL(file).href, file), true);
  assert.equal(isMain(pathToFileURL(file).href, path.join(moduleDir, 'tools', 'migrate-v1-views.mjs')), false);
  assert.equal(isMain(pathToFileURL(file).href, undefined), false);
  linked((link) => assert.equal(isMain(pathToFileURL(file).href, path.join(link, 'tools', 'gen-prop-docs.mjs')), true));
});
