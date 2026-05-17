/**
 * Single source of truth for the CLI's identity. Both `commander.version()` and the
 * version-check adapter read from here so the npm registry poll and the `--version` flag
 * always agree. When we publish, bump `currentVersion` here and the rest of the code follows.
 */

export const CLI_METADATA = {
  /** npm package name. The version-check adapter polls `https://registry.npmjs.org/<name>/latest`. */
  packageName: 'ralphctl',
  /** Current installed version. Update on every release. */
  currentVersion: '0.1.0',
} as const;

export type CliMetadata = typeof CLI_METADATA;
