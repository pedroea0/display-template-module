// =============================================================================
// common-menu-contrast.test.mjs — ctg-common.js: menu hint contrast
// =============================================================================
// axe color-contrast: the shared menu hint (12 px,
// --ctg-text-muted) was 4.0:1 on a hovered / focused item's --ctg-surface-2 in
// the light theme. WCAG AA needs 4.5:1 for small text. The effective colour of a
// hint on a focused item is computed from the common stylesheet (the last
// matching rule wins at equal :where() specificity) with the token fallbacks.
// =============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnv } from './_stubs.mjs';

function load() {
  const env = createEnv();
  env.load('ctg-common.js', '2.0.0-c0c0c001');
  return env.window.__CTG;
}
/** Token name -> its fallback colour in TOKENS_CSS ('--ctg-text:var(--label,#323232);' -> #323232). */
function tokenDefaults(css) {
  const out = {};
  const re = /(--ctg-[a-z0-9-]+):([^;]+);/g;
  let m;
  while ((m = re.exec(css))) {
    const hex = /#[0-9A-Fa-f]{6}/.exec(m[2]);
    if (hex) out[m[1]] = hex[0];
  }
  return out;
}
/** The colour the LAST rule whose selector list matches `pred` gives (rules are ':where(sel,...){decls}'). */
function lastColor(css, pred) {
  const re = /:where\(([^{}]*)\)\{([^{}]*)\}/g;
  let m, color = null;
  while ((m = re.exec(css))) {
    const sels = m[1].split(',').map((x) => x.trim());
    if (!sels.some(pred)) continue;
    const decl = /(?:^|;)color:var\((--ctg-[a-z0-9-]+)\)/.exec(m[2]);
    if (decl) color = decl[1];
  }
  return color;
}

test('the menu hint keeps >= 4.5:1 on a focused / hovered item (light theme defaults)', () => {
  const NS = load();
  const tokens = tokenDefaults(NS.theme.TOKENS_CSS);
  const css = NS.theme.OVERLAY_CSS;
  const hintAlways = lastColor(css, (s) => s === '.ctg-menu__hint');
  const hintFocused = lastColor(css, (s) => s === '.ctg-menu__item:focus .ctg-menu__hint') || hintAlways;
  const hintHover = lastColor(css, (s) => s === '.ctg-menu__item:hover .ctg-menu__hint') || hintAlways;
  const itemBg = /(?:^|;)background:var\((--ctg-[a-z0-9-]+)\)/.exec(/:where\(\.ctg-menu__item:hover,\.ctg-menu__item:focus\)\{([^}]*)\}/.exec(css)[1])[1];
  const bg = NS.theme.parseColor(tokens[itemBg]);
  const ratio = (tok) => NS.theme.contrast(NS.theme.parseColor(tokens[tok]), bg);
  assert.ok(ratio(hintFocused) >= 4.5, 'focused: ' + hintFocused + ' on ' + itemBg + ' = ' + ratio(hintFocused).toFixed(2) + ':1 (old: 4.0:1)');
  assert.ok(ratio(hintHover) >= 4.5, 'hover: ' + ratio(hintHover).toFixed(2) + ':1');
  // the hint stays muted (secondary) on an unfocused item, where the muted colour already passes on the menu surface
  assert.equal(hintAlways, '--ctg-text-muted');
  const surface = NS.theme.parseColor(tokens['--ctg-surface']);
  assert.ok(NS.theme.contrast(NS.theme.parseColor(tokens['--ctg-text-muted']), surface) >= 4.5);
});
