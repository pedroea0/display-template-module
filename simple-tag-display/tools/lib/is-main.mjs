// =============================================================================
// is-main.mjs — "is this module the script node was started with?"
// =============================================================================
// Comparing process.argv[1] (only path.resolve()d) with import.meta.url (which
// Node gives as the REAL path) is not enough: started through a symlink, a
// Windows junction, an 8.3 short name or a macOS /tmp checkout the two differ,
// main() never runs and the script exits 0 having done nothing (a "successful"
// migration that wrote nothing, a docs check that checked nothing). Both sides
// are therefore compared as real paths (case-insensitive on Windows).
// =============================================================================
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function real(p) {
  try { return realpathSync.native(p); } catch { /* fall through */ }
  try { return realpathSync(p); } catch { return path.resolve(p); }
}

/** True when the module at `metaUrl` (import.meta.url) is the entry script `argv1` (default process.argv[1]). */
export function isMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  const a = real(path.resolve(argv1));
  const b = real(fileURLToPath(metaUrl));
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
