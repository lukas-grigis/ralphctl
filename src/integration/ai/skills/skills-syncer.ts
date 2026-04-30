import { existsSync } from 'node:fs';
import { mkdir, readdir, copyFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StorageError } from '../../../domain/errors/storage-error.ts';
import { Result } from '../../../domain/result.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';

/**
 * `SkillsSyncer` — copies the bundled default skills into a writable
 * cache directory under `<root>/cache/skills/`.
 *
 * The cache is the canonical link target for {@link SessionSkillsLinker}.
 * Bundling the templates inside the npm tarball + lazily syncing into a
 * user-writable cache lets callers live-edit a skill if they need to
 * tweak it without modifying the install.
 *
 * Idempotent — a re-run is a no-op when the skill already exists in the
 * cache. We do not overwrite a synced skill so user edits stick. Callers
 * who want to refresh should delete the cached copy and re-sync.
 */
export interface SkillsSyncer {
  /** Sync every bundled default skill into `cache/skills/`. */
  syncDefaults(): Promise<Result<void, StorageError>>;
  /** Resolved cache path — exposed so the linker can target it. */
  readonly cacheSkillsDir: AbsolutePath;
}

export interface SkillsSyncerOptions {
  /** `<root>/cache` from `StoragePaths`. The syncer appends `skills/`. */
  readonly cacheDir: AbsolutePath;
  /**
   * Override the bundled default-skills source — used by tests. When
   * omitted, dual-mode resolution kicks in:
   *  - dev: `src/integration/ai/skills/default/`
   *  - prod: `dist/skills/default/`
   */
  readonly bundledDefaultsDir?: AbsolutePath;
}

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the bundled `default/` source. Public so tests + tooling can
 * cross-check the same logic the syncer applies internally.
 *
 * Two layouts supported:
 *  - **Bundled (`dist/cli.mjs`)** — `HERE` is `dist/`; the build step copies
 *    `src/integration/ai/skills/default/` to `dist/skills/default/`.
 *  - **Dev (tsx)** — `HERE` is `src/integration/ai/skills/`; the
 *    bundled defaults sit in the sibling `default/` directory.
 *
 * We probe the bundled location first via `existsSync` so the published
 * binary doesn't have to ship `src/`.
 */
export function defaultBundledSkillsDir(): AbsolutePath {
  const distSibling = join(HERE, 'skills', 'default');
  if (existsSync(distSibling)) return AbsolutePath.trustString(distSibling);
  return AbsolutePath.trustString(join(HERE, 'default'));
}

export class FileSkillsSyncer implements SkillsSyncer {
  readonly cacheSkillsDir: AbsolutePath;
  private readonly bundledDefaultsDir: AbsolutePath;

  constructor(opts: SkillsSyncerOptions) {
    this.cacheSkillsDir = AbsolutePath.trustString(join(opts.cacheDir, 'skills'));
    this.bundledDefaultsDir = opts.bundledDefaultsDir ?? defaultBundledSkillsDir();
  }

  async syncDefaults(): Promise<Result<void, StorageError>> {
    let entries: { name: string; isDir: boolean }[];
    try {
      const dirents = await readdir(this.bundledDefaultsDir, { withFileTypes: true });
      entries = dirents.map((d) => ({ name: d.name, isDir: d.isDirectory() }));
    } catch (err) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `failed to enumerate bundled skills at ${this.bundledDefaultsDir}: ${stringifyError(err)}`,
          path: this.bundledDefaultsDir,
          cause: err,
        })
      );
    }

    try {
      await mkdir(this.cacheSkillsDir, { recursive: true });
    } catch (err) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `failed to create cache skills dir ${this.cacheSkillsDir}: ${stringifyError(err)}`,
          path: this.cacheSkillsDir,
          cause: err,
        })
      );
    }

    for (const entry of entries) {
      if (!entry.isDir) continue;
      const src = join(this.bundledDefaultsDir, entry.name);
      const dst = join(this.cacheSkillsDir, entry.name);
      // Idempotent: if the destination skill directory already exists,
      // we skip it. Users who want to refresh can `rm -rf` the cache.
      if (existsSync(dst)) continue;
      const copyResult = await copyDirectory(src, dst);
      if (!copyResult.ok) return copyResult;
    }
    return Result.ok();
  }
}

async function copyDirectory(src: string, dst: string): Promise<Result<void, StorageError>> {
  try {
    await mkdir(dst, { recursive: true });
    const dirents = await readdir(src, { withFileTypes: true });
    for (const d of dirents) {
      const s = join(src, d.name);
      const t = join(dst, d.name);
      if (d.isDirectory()) {
        const r = await copyDirectory(s, t);
        if (!r.ok) return r;
      } else if (d.isFile()) {
        await copyFile(s, t);
      } else if (d.isSymbolicLink()) {
        // Resolve and copy the underlying file — we don't preserve
        // symlinks in the cache because the cache should be a
        // freestanding, edit-safe tree.
        const stats = await stat(s);
        if (stats.isFile()) await copyFile(s, t);
      }
    }
    return Result.ok();
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to copy ${src} → ${dst}: ${stringifyError(err)}`,
        path: dst,
        cause: err,
      })
    );
  }
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
