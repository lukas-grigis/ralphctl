/**
 * Detects v0.6.x leftover data at the resolved appRoot. v0.7.0's on-disk schema is
 * incompatible with v0.6.x — letting the harness boot and `ParseError` on first read is
 * loud but unhelpful. This module gives the user a clear path forward before any I/O
 * happens.
 *
 * **Detection signals.** Any single signal triggers a positive:
 *
 *   - `<appRoot>/cache/`       — v0.6.x cache dir; v0.7.0 has no `cache/`
 *   - `<appRoot>/logs/`        — v0.6.x logs dir; v0.7.0 routes via `<sprintDir>/chain.log`
 *   - `<appRoot>/backups/`     — v0.6.x backups dir; v0.7.0 doesn't auto-backup
 *   - `<appRoot>/config.json`  — v0.6.x top-level config; v0.7.0 puts settings.json under config/
 *
 * Fresh installs (appRoot missing entirely) and v0.7.0 layouts (no v0.6.x signals)
 * surface as `{ kind: 'fresh' }` and `{ kind: 'compatible' }` respectively. Both let
 * the boot continue.
 *
 * **Escape hatch.** `RALPHCTL_SKIP_LEGACY_CHECK` (any truthy value) bypasses the check.
 * Used by tests that exercise the boot path against tmp dirs they fully control, and by
 * power users who knowingly want to run 0.7.0 alongside legacy data (e.g. on a
 * `RALPHCTL_HOME=/tmp/...` override).
 *
 * @public
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

export const LEGACY_SKIP_ENV = 'RALPHCTL_SKIP_LEGACY_CHECK';

/** Names of v0.6.x-only entries under `<appRoot>` that signal a legacy layout. */
const LEGACY_DIRS: readonly string[] = ['cache', 'logs', 'backups'];
const LEGACY_FILES: readonly string[] = ['config.json'];

export type LegacyLayoutDetection =
  | { readonly kind: 'fresh' }
  | { readonly kind: 'compatible' }
  | { readonly kind: 'legacy-v0.6'; readonly signals: readonly string[]; readonly appRoot: AbsolutePath };

export interface DetectLegacyLayoutDeps {
  /**
   * Test seam. Defaults to `process.env`. Set `RALPHCTL_SKIP_LEGACY_CHECK` to any truthy
   * value to short-circuit detection (returns `'compatible'`).
   */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Walk the candidate signals; return the kind that classifies the appRoot.
 *
 * Pure async — only filesystem read via `fs.stat`. No writes, no env reads beyond the
 * single `LEGACY_SKIP_ENV` lookup. Errors are treated as "not present" (so a permission
 * error on a specific candidate doesn't trigger a false positive).
 */
export const detectLegacyLayout = async (
  appRoot: AbsolutePath,
  deps: DetectLegacyLayoutDeps = {}
): Promise<LegacyLayoutDetection> => {
  const env = deps.env ?? process.env;
  const skip = env[LEGACY_SKIP_ENV];
  if (typeof skip === 'string' && skip.length > 0) return { kind: 'compatible' };

  const root = String(appRoot);

  // If the appRoot doesn't exist at all, this is a fresh install.
  const rootStat = await statOrUndefined(root);
  if (rootStat === undefined || !rootStat.isDirectory()) return { kind: 'fresh' };

  const signals: string[] = [];

  for (const name of LEGACY_DIRS) {
    const entry = await statOrUndefined(join(root, name));
    if (entry?.isDirectory() === true) signals.push(`${name}/`);
  }

  for (const name of LEGACY_FILES) {
    const entry = await statOrUndefined(join(root, name));
    if (entry?.isFile() === true) signals.push(name);
  }

  if (signals.length > 0) return { kind: 'legacy-v0.6', signals, appRoot };
  return { kind: 'compatible' };
};

const statOrUndefined = async (path: string): Promise<Awaited<ReturnType<typeof fs.stat>> | undefined> => {
  try {
    return await fs.stat(path);
  } catch {
    return undefined;
  }
};

/**
 * Render the operator-facing message for a `legacy-v0.6` detection. Returns a multi-line
 * string callers print to stderr before exiting non-zero. Single source of truth for the
 * message so the CLI and TUI surfaces stay aligned.
 */
export const renderLegacyLayoutMessage = (detection: {
  readonly signals: readonly string[];
  readonly appRoot: AbsolutePath;
}): string => {
  const rootStr = String(detection.appRoot);
  const backupPath = `${rootStr}.0.6-backup`;
  const signalLines = detection.signals.map((s) => `    • ${s}`).join('\n');
  return [
    '',
    'ralphctl 0.7.0 refuses to start on v0.6.x data.',
    '',
    `Detected legacy layout at ${rootStr}/:`,
    signalLines,
    '',
    'The 0.7.0 on-disk schema is incompatible. Back up your old data, then re-launch:',
    '',
    `    mv ${rootStr} ${backupPath}`,
    '    ralphctl',
    '',
    'The backup keeps your old sprint plans, tickets, and progress notes readable. If you',
    "don't need them later, you can `rm -rf` the backup directory.",
    '',
    'Alternatives:',
    '',
    `  • Run 0.7.0 against a different directory: RALPHCTL_HOME=/path/to/dir ralphctl`,
    `  • Bypass this check (e.g. for testing): ${LEGACY_SKIP_ENV}=1 ralphctl`,
    '',
  ].join('\n');
};
