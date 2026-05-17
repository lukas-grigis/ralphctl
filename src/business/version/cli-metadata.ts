/**
 * Single source of truth for the CLI's identity. Both `commander.version()` and the
 * version-check adapter read from here so the npm registry poll and the `--version` flag
 * always agree.
 *
 * `currentVersion` and `packageName` are sourced from the repo's `package.json` at build /
 * dev time via a JSON import attribute (Node + tsx + esbuild all support this) — there's no
 * runtime `fs.readFile` and no risk of the constant drifting from `package.json`.
 */

import pkg from '../../../package.json' with { type: 'json' };

export const CLI_METADATA = {
  packageName: pkg.name,
  currentVersion: pkg.version,
} as const;
