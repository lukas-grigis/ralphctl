/**
 * Startup integrity probe for a published bundle. `scripts/build-assets.ts` writes
 * `dist/manifest.json` (`{ schemaVersion, packageVersion, generatedAt, assets[] }`) as a
 * build-completeness record — until this module, nothing read it back, so an interrupted
 * publish or truncated npm tarball surfaced only as a generic `StorageError` deep inside
 * `FsTemplateLoader` / `bundledSkillSource`, the same confusing failure class the 0.15.1
 * bundle-detection regression needed a patch release to diagnose.
 *
 * Bundle-mode detection mirrors `resolveTemplatesDir` / `resolveBundledRoot`: probe the
 * filesystem for `manifest.json` sitting beside the running module, never the artifact
 * filename. In dev (`tsx`) this module lives at `src/integration/system/bundle-integrity.ts`
 * with nothing beside it, so the probe is a silent no-op; in a published bundle it's compiled
 * into `dist/cli.mjs` (or one of tsup's hashed code-split chunks), which sits directly beside
 * `dist/manifest.json` and every asset dir the manifest names.
 *
 * Two failure classes, both actionable, both surfaced as a `StorageError` naming a "reinstall
 * ralphctl" hint:
 *   - **missing asset(s)** — the exact 0.15.1-shaped failure mode: a partial copy or truncated
 *     tarball left `dist/manifest.json` naming files that never landed.
 *   - **package-version mismatch** — a half-upgraded global install: `dist/cli.mjs` was replaced
 *     but the co-located assets (or vice versa) are stale from a different release.
 *
 * A malformed / unparseable manifest degrades to a `'malformed'` status (not a `Result.error`) —
 * the probe must never brick a working install over its own bookkeeping file; callers log it at
 * warning level and continue.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { pathExists, readJson } from '@src/integration/io/fs.ts';
import { CLI_METADATA } from '@src/business/version/cli-metadata.ts';

const REINSTALL_HINT = 'reinstall ralphctl (npm i -g ralphctl / pnpm add -g ralphctl)';

const ManifestSchema = z.object({
  schemaVersion: z.number(),
  packageVersion: z.string(),
  generatedAt: z.string(),
  assets: z.array(z.string()),
});

/** Outcome that does not warrant a hard startup failure — the caller decides how to render it. */
export type BundleIntegrityStatus =
  | { readonly kind: 'skipped' } // dev mode: no manifest.json beside the running module
  | { readonly kind: 'ok' } // bundle mode: manifest parsed, version matches, every asset present
  | { readonly kind: 'malformed'; readonly reason: string }; // bundle mode: manifest unreadable / bad shape

export interface CheckBundleIntegrityDeps {
  /** Test seam — defaults to this module's own `import.meta.url`. */
  readonly moduleUrl?: string;
  /** Test seam for the beside-the-module existence probe — defaults to `existsSync`. */
  readonly exists?: (path: string) => boolean;
  /** Test seam — defaults to `CLI_METADATA.currentVersion`. */
  readonly currentVersion?: string;
}

/**
 * Resolve `manifest.json` beside this module, or `undefined` in dev mode where nothing sits
 * there. Deliberately NOT a filename check for the same reason the sibling resolvers aren't:
 * tsup code-splitting rewrites `import.meta.url` to a hashed `cli-<hash>.mjs` chunk, and a check
 * against a fixed filename would silently miss it.
 *
 * @public
 */
export const resolveManifestPath = (
  moduleUrl: string,
  exists: (path: string) => boolean = existsSync
): string | undefined => {
  const here = dirname(fileURLToPath(moduleUrl));
  const manifestPath = join(here, 'manifest.json');
  return exists(manifestPath) ? manifestPath : undefined;
};

/** Existence-check every asset path (relative to the manifest's directory) in parallel — presence only, no hashing. */
const findMissingAssets = async (assetRoot: string, assets: readonly string[]): Promise<readonly string[]> => {
  const checks = await Promise.all(
    assets.map(async (rel) => {
      const found = await pathExists(join(assetRoot, rel));
      const present = found.ok && found.value;
      return present ? undefined : rel;
    })
  );
  return checks.filter((rel): rel is string => rel !== undefined);
};

/**
 * Run the startup integrity probe. `Result.error` carries the two hard-failure diagnostics
 * (missing assets / version mismatch) as a `StorageError` the composition root already knows
 * how to render (`throw new Error(`bundle-integrity: ${result.error.message}`)`, same idiom as
 * the storage-paths / settings-load pre-flights it sits beside). `Result.ok` carries every other
 * outcome, including the malformed-manifest warning — that path must never abort startup.
 */
export const checkBundleIntegrity = async (
  deps: CheckBundleIntegrityDeps = {}
): Promise<Result<BundleIntegrityStatus, StorageError>> => {
  const moduleUrl = deps.moduleUrl ?? import.meta.url;
  const currentVersion = deps.currentVersion ?? CLI_METADATA.currentVersion;
  const manifestPath = resolveManifestPath(moduleUrl, deps.exists);
  if (manifestPath === undefined) return Result.ok({ kind: 'skipped' });

  const raw = await readJson(manifestPath);
  if (!raw.ok) {
    return Result.ok({ kind: 'malformed', reason: `${manifestPath}: ${raw.error.message}` });
  }
  const parsed = ManifestSchema.safeParse(raw.value);
  if (!parsed.success) {
    return Result.ok({ kind: 'malformed', reason: `${manifestPath}: does not match the expected manifest shape` });
  }

  if (parsed.data.packageVersion !== currentVersion) {
    return Result.error(
      new StorageError({
        subCode: 'schema-mismatch',
        message:
          `ralphctl install looks half-upgraded — ${manifestPath} was built for ` +
          `${parsed.data.packageVersion} but the running package is ${currentVersion}. ${REINSTALL_HINT}.`,
        path: manifestPath,
        hint: REINSTALL_HINT,
      })
    );
  }

  const missing = await findMissingAssets(dirname(manifestPath), parsed.data.assets);
  if (missing.length > 0) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message:
          `ralphctl install is missing ${String(missing.length)} bundled asset(s) declared in ` +
          `${manifestPath}. ${REINSTALL_HINT}.`,
        path: manifestPath,
        hint: REINSTALL_HINT,
      })
    );
  }

  return Result.ok({ kind: 'ok' });
};
