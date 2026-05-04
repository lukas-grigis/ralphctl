/**
 * `dist-asset-manifest` — boot-time integrity check for the bundled
 * non-code assets (prompt templates, default skills) the build script
 * stages into `dist/`.
 *
 * Why this exists: tsup compiles the TypeScript graph but does not copy
 * `.md` templates or skill folders. Those are staged by a sibling build
 * step (`scripts/build-assets.mjs`). When that step is skipped or
 * partially fails, the CLI keeps running but every prompt-build call
 * silently substitutes empty placeholders — the user just sees the AI
 * receive a degraded prompt and notices the bad output much later. The
 * CLAUDE.md "Build & Distribution" gotcha calls this out explicitly.
 *
 * The manifest is generated at build time and shipped in
 * `dist/manifest.json`. At first call, this module reads the manifest
 * and stats every listed file; on a missing or corrupt asset it returns
 * a `Result.error(StorageError)` with a clear repair hint. The result
 * is cached so re-entry is free.
 *
 * Dev mode (running via `tsx`) is a no-op — `HERE` is `src/integration/ai/`,
 * there is no `manifest.json` next to it, and the dev path has no need
 * for verification. The function returns `Result.ok()` immediately.
 */
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';

/** Absolute filesystem location of this module — `dist/` when bundled, `src/integration/ai/` in dev. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Manifest schema. Keep this surface narrow and versioned so we can
 * evolve the producer without breaking older bundles in the field.
 */
export interface DistAssetManifestV1 {
  readonly version: 1;
  /** ISO timestamp the manifest was produced. Diagnostic only. */
  readonly generatedAt: string;
  /** Asset paths relative to the `dist/` directory. */
  readonly assets: readonly string[];
}

/**
 * Cached outcome of the verification. The check is idempotent and cheap,
 * but a cold call still does N stat syscalls — there's no reason to
 * repeat it inside one CLI process.
 */
type CachedVerification =
  | { readonly state: 'pass' }
  | { readonly state: 'fail'; readonly error: StorageError }
  | { readonly state: 'unverified' };

let cached: CachedVerification = { state: 'unverified' };

/**
 * Reset the cached verification result. Tests use this to re-run
 * verification against a fresh fixture without spawning a child
 * process.
 */
export function resetDistAssetManifestCacheForTesting(): void {
  cached = { state: 'unverified' };
}

/**
 * Verify the bundled asset tree is intact. No-op outside the bundled
 * layout (dev mode). The check is keyed off `manifest.json` next to
 * this module — its presence is the bundled-mode signal, its absence
 * means we're running from `src/`.
 *
 * Dist root override is for tests only; production callers should use
 * the default which probes next to the bundled module.
 */
export async function verifyDistAssets(distRootOverride?: string): Promise<Result<void, StorageError>> {
  if (cached.state === 'pass') return Result.ok();
  if (cached.state === 'fail') return Result.error(cached.error);

  const distRoot = distRootOverride ?? HERE;
  const manifestPath = join(distRoot, 'manifest.json');

  // Dev mode — the manifest doesn't ship next to `src/integration/ai/`
  // and there's nothing to verify. Cache the pass so subsequent calls
  // skip the existsSync check.
  if (!existsSync(manifestPath)) {
    cached = { state: 'pass' };
    return Result.ok();
  }

  const parsed = await loadManifest(manifestPath);
  if (!parsed.ok) {
    cached = { state: 'fail', error: parsed.error };
    return Result.error(parsed.error);
  }

  const missing: string[] = [];
  for (const rel of parsed.value.assets) {
    const abs = join(distRoot, rel);
    try {
      const s = await stat(abs);
      if (!s.isFile()) missing.push(rel);
    } catch {
      missing.push(rel);
    }
  }

  if (missing.length > 0) {
    const head = missing.slice(0, 5).join(', ');
    const tail = missing.length > 5 ? `, …(+${String(missing.length - 5)} more)` : '';
    const error = new StorageError({
      subCode: 'io',
      message: `dist asset bundle is incomplete — ${String(missing.length)} file(s) missing: ${head}${tail}. Run \`pnpm build\` to regenerate.`,
      path: distRoot,
      hint: 'Run `pnpm build` to regenerate the dist tree.',
    });
    cached = { state: 'fail', error };
    return Result.error(error);
  }

  cached = { state: 'pass' };
  return Result.ok();
}

/**
 * Read + parse `manifest.json`. Surfaces a clear `StorageError` for
 * each failure mode the bundled CLI may hit in the field — corrupted
 * JSON, unknown schema version, missing fields. Tests cover all three.
 */
async function loadManifest(manifestPath: string): Promise<Result<DistAssetManifestV1, StorageError>> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, 'utf-8');
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to read dist asset manifest at ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
        path: manifestPath,
        cause: err,
      })
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'parse',
        message: `dist asset manifest at ${manifestPath} is not valid JSON — bundle is corrupt`,
        path: manifestPath,
        cause: err,
      })
    );
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    !Array.isArray((parsed as { assets?: unknown }).assets)
  ) {
    return Result.error(
      new StorageError({
        subCode: 'schema-mismatch',
        message: `dist asset manifest at ${manifestPath} has an unexpected schema (expected { version: 1, assets: string[] })`,
        path: manifestPath,
      })
    );
  }

  const obj = parsed as { version: 1; generatedAt?: unknown; assets: readonly unknown[] };
  for (const a of obj.assets) {
    if (typeof a !== 'string') {
      return Result.error(
        new StorageError({
          subCode: 'schema-mismatch',
          message: `dist asset manifest at ${manifestPath} contains a non-string asset entry`,
          path: manifestPath,
        })
      );
    }
  }
  return Result.ok({
    version: 1,
    generatedAt: typeof obj.generatedAt === 'string' ? obj.generatedAt : '',
    assets: obj.assets as readonly string[],
  });
}
