// =============================================================================
// encoding.test.mjs — every mounted text resource is valid UTF-8
// =============================================================================
// The gateway serves /res/simpletagdisplay/* as application/javascript and
// text/css WITHOUT a charset, so the browser decodes the bytes as UTF-8. A file
// written by a non-UTF-8 tool (e.g. Windows PowerShell 5.1 Set-Content, which
// writes cp1252) garbles every non-ASCII character in it — harmless in a
// comment, visible as soon as UI strings live in the file.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { JS_DIR } from './_stubs.mjs';

const MOUNTED = path.dirname(JS_DIR);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(m?js|css|json|html|svg)$/i.test(name)) out.push(p);
  }
  return out;
}

test('every mounted text file decodes as UTF-8 (no BOM)', () => {
  const files = walk(MOUNTED);
  assert.ok(files.length >= 5, 'found the mounted files');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  for (const f of files) {
    const bytes = readFileSync(f);
    const rel = path.relative(MOUNTED, f);
    assert.doesNotThrow(() => decoder.decode(bytes), `${rel} is not valid UTF-8`);
    assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), `${rel} starts with a UTF-8 BOM`);
  }
});

test('our own JS files contain no raw control characters', () => {
  // Raw NUL..US (other than tab/LF/CR) in source usually means an escape sequence was expanded by a tool.
  for (const f of walk(MOUNTED).filter(p => /ctg-|display-template/.test(path.basename(p)))) {
    const text = readFileSync(f, 'utf8');
    const m = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.exec(text);
    assert.equal(m, null, `${path.basename(f)} contains U+${m && m[0].charCodeAt(0).toString(16).padStart(4, '0')}`);
  }
});
