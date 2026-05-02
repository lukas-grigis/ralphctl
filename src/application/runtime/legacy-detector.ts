/**
 * `detectLegacyLayout` — guards the boot path against a 0.5.x on-disk layout.
 *
 * The 0.6.0 rewrite moved `config.json` and `projects.json` from the root of
 * `~/.ralphctl/` into a `config/` subdirectory. A legacy install has
 * `~/.ralphctl/config.json` at root; the new install never does.
 *
 * This is a single `fs.access` call so boot is not perceptibly slowed. When
 * a legacy layout is detected, the caller prints a multi-line warning to
 * stderr, refuses to read or migrate the data, and exits non-zero — the
 * user must back up the directory and start fresh (see README upgrade
 * section). We don't migrate automatically: the schema is incompatible and
 * silently rewriting the user's data would be worse than refusing to boot.
 */
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';

interface LegacyDetection {
  readonly isLegacy: boolean;
  readonly legacyConfigPath: AbsolutePath | null;
  readonly hint: string;
}

interface LegacyDetectorDeps {
  /**
   * Override the root directory checked for the legacy `config.json` marker.
   * Defaults to `RALPHCTL_ROOT` env var or `~/.ralphctl`. Tests pass an
   * absolute temp directory.
   */
  readonly root?: AbsolutePath;
}

const NOT_LEGACY: LegacyDetection = { isLegacy: false, legacyConfigPath: null, hint: '' };

function defaultRoot(): AbsolutePath {
  const fromEnv = process.env['RALPHCTL_ROOT'];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return AbsolutePath.trustString(fromEnv);
  }
  return AbsolutePath.trustString(join(homedir(), '.ralphctl'));
}

/**
 * Returns `{ isLegacy: true }` when the root directory contains a top-level
 * `config.json` (the 0.5.x layout). New 0.6.x installs hold this file at
 * `<root>/config/config.json`, so the marker is unambiguous.
 *
 * Always resolves — never throws. Any I/O error is interpreted as "no
 * legacy file present" so a missing root or unreadable permissions can't
 * accidentally block a fresh install.
 */
export async function detectLegacyLayout(deps: LegacyDetectorDeps = {}): Promise<LegacyDetection> {
  const root = deps.root ?? defaultRoot();
  const legacyConfigPath = AbsolutePath.trustString(join(root, 'config.json'));
  try {
    await access(legacyConfigPath);
  } catch {
    return NOT_LEGACY;
  }
  return {
    isLegacy: true,
    legacyConfigPath,
    hint: `Legacy 0.5.x layout detected at ${root}.\nThe 0.6.0 rewrite is not backwards compatible — your existing data must be backed up before upgrading.\n\n  mv ${root} ${root}.0.5-backup\n\nThen re-run ralphctl to start fresh, and use 'ralphctl project add' to register your projects in the new layout.`,
  };
}
