/**
 * `BundledSkillsCopier` — install / uninstall the bundled skill set
 * under `<sessionDir>/.claude/skills/` for the duration of an AI session
 * phase.
 *
 * The bundled skill set is the union of two folders:
 *  - `default/` — general-purpose skills present for every phase
 *  - `<phase>/`  — phase-specific skills (`refine`, `plan`, `exec`)
 *
 * Either folder may be empty or missing — that's fine, the copier just
 * skips it. The phase folder is always overlaid on top of `default/`;
 * a name collision between the two is a packaging bug, not a runtime
 * concern (we don't ship colliding skills).
 *
 * Project skills win: when `<sessionDir>/.claude/skills/<name>/` already
 * exists at install time, the bundled version is skipped and the project
 * copy is left untouched. The skill name is also excluded from the
 * uninstall manifest so we never `rm -rf` a directory we didn't put
 * there.
 *
 * The install/uninstall pair tracks installed skill names per `cwd` in
 * an in-memory manifest. `uninstall(cwd)` removes only what `install`
 * recorded — pre-existing project skills under `<cwd>/.claude/skills/`
 * are preserved verbatim.
 */
import { existsSync } from 'node:fs';
import { readdir, rm, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';

import { copyTree } from './copy-tree.ts';
import { addRalphctlSkillsExclude, removeRalphctlSkillsExclude } from './skill-git-exclude.ts';

/** `.claude/skills/` under the AI session's working directory. */
export const SKILLS_SUBDIR = join('.claude', 'skills');

/** Phase identifier — one folder per phase under the bundled root. */
export type SkillsPhase = 'refine' | 'plan' | 'exec';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve the bundled-skills root — the directory containing the
 * `default/` and `<phase>/` subfolders. Two layouts:
 *  - **Bundled (`dist/cli.mjs`)** — `HERE` is `dist/`; the build step
 *    copies the four phase folders to `dist/skills/`.
 *  - **Dev (tsx)** — `HERE` is `src/integration/ai/skills/` itself;
 *    the four phase folders sit as siblings.
 */
export function bundledSkillsRootDir(): AbsolutePath {
  const distRoot = join(HERE, 'skills');
  if (existsSync(distRoot)) return AbsolutePath.trustString(distRoot);
  return AbsolutePath.trustString(HERE);
}

export interface BundledSkillsCopier {
  /**
   * Copy the bundled skill set for `phase` into
   * `<sessionDir>/.claude/skills/`. Skills already present at the
   * destination are left untouched — project copies always win.
   * Records the names of skills the install actually created so a
   * later `uninstall` removes only those.
   */
  install(sessionDir: AbsolutePath, phase: SkillsPhase): Promise<Result<void, StorageError>>;
  /**
   * Remove the skills `install` placed under
   * `<sessionDir>/.claude/skills/`. Pre-existing project skills are
   * preserved. Idempotent: calling without a prior install (or after a
   * previous uninstall) is a no-op.
   */
  uninstall(sessionDir: AbsolutePath): Promise<Result<void, StorageError>>;
}

export interface FileBundledSkillsCopierOptions {
  /** Override the bundled-skills root — used by tests. */
  readonly bundledRootDir?: AbsolutePath;
}

export class FileBundledSkillsCopier implements BundledSkillsCopier {
  private readonly bundledRootDir: AbsolutePath;
  /**
   * Per-cwd manifest of skill names this copier created at install
   * time. Keyed by absolute cwd string so callers that re-use the same
   * copier across multiple sessions stay isolated.
   */
  private readonly installed = new Map<string, Set<string>>();

  constructor(opts: FileBundledSkillsCopierOptions = {}) {
    this.bundledRootDir = opts.bundledRootDir ?? bundledSkillsRootDir();
  }

  async install(sessionDir: AbsolutePath, phase: SkillsPhase): Promise<Result<void, StorageError>> {
    const skillsDir = join(sessionDir, SKILLS_SUBDIR);
    const sources = await this.collectSourceSkills(phase);
    if (!sources.ok) return Result.error(sources.error);

    const tracked = this.installed.get(String(sessionDir)) ?? new Set<string>();

    for (const [name, srcDir] of sources.value) {
      const dst = join(skillsDir, name);
      if (existsSync(dst)) {
        // Project copy wins — leave it alone, don't track for uninstall.
        continue;
      }
      const r = await copyTree(srcDir, dst);
      if (!r.ok) {
        // Persist anything we did install before failing so a follow-up
        // uninstall still cleans them up. Also write the local-git
        // exclude block so the partial install doesn't get committed.
        if (tracked.size > 0) {
          this.installed.set(String(sessionDir), tracked);
          await addRalphctlSkillsExclude(sessionDir);
        }
        return Result.error(r.error);
      }
      tracked.add(name);
    }

    if (tracked.size > 0) {
      this.installed.set(String(sessionDir), tracked);
      // Best-effort: prevent `git add -A` from staging the bundled-skill
      // files we just copied. No-op outside git repos. A failure here
      // would only resurface the original dirty-tree behaviour, so we
      // intentionally swallow it rather than fail the install.
      await addRalphctlSkillsExclude(sessionDir);
    }
    return Result.ok();
  }

  async uninstall(sessionDir: AbsolutePath): Promise<Result<void, StorageError>> {
    const key = String(sessionDir);
    const tracked = this.installed.get(key);
    if (!tracked || tracked.size === 0) {
      // Nothing in our manifest, but a prior crashed run may have left
      // a stale exclude block in `.git/info/exclude`. Clean it up so a
      // re-launch never accumulates duplicates.
      await removeRalphctlSkillsExclude(sessionDir);
      return Result.ok();
    }

    const skillsDir = join(sessionDir, SKILLS_SUBDIR);
    try {
      for (const name of tracked) {
        await rm(join(skillsDir, name), { recursive: true, force: true });
      }
      this.installed.delete(key);
    } catch (err) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `failed to uninstall bundled skills under ${skillsDir}: ${err instanceof Error ? err.message : String(err)}`,
          path: skillsDir,
          cause: err,
        })
      );
    }

    // Tidy empty parent dirs we may have created. Any failure here is
    // benign — the skills tree itself is already gone.
    await tryRmdirIfEmpty(skillsDir);
    await tryRmdirIfEmpty(join(sessionDir, '.claude'));
    // Remove the local-git exclude block we wrote at install time. The
    // helper no-ops outside a git repo, so this is safe regardless of
    // where the session lives.
    await removeRalphctlSkillsExclude(sessionDir);

    return Result.ok();
  }

  /**
   * Resolve the source skill set for a phase: the union of skills
   * under `<root>/default/` and `<root>/<phase>/`. Either folder may
   * be missing or empty — both are tolerated. Returns an ordered map
   * (insertion = `default/` first, then phase) so the install order
   * is deterministic.
   */
  private async collectSourceSkills(phase: SkillsPhase): Promise<Result<Map<string, string>, StorageError>> {
    const sources = new Map<string, string>();
    for (const sub of ['default', phase] as const) {
      const dir = join(this.bundledRootDir, sub);
      const r = await listSkillDirs(dir);
      if (!r.ok) return Result.error(r.error);
      for (const [name, abs] of r.value) {
        sources.set(name, abs);
      }
    }
    return Result.ok(sources);
  }
}

/**
 * Enumerate skill directories directly under `dir`. Each immediate
 * subdirectory is treated as a skill named after the directory. Returns
 * an empty list when `dir` doesn't exist or contains no subdirectories
 * — both are valid states (e.g. an empty phase folder ships with
 * `.gitkeep` only).
 */
async function listSkillDirs(dir: string): Promise<Result<readonly (readonly [string, string])[], StorageError>> {
  if (!existsSync(dir)) return Result.ok([]);
  try {
    const dirents = await readdir(dir, { withFileTypes: true });
    const out: (readonly [string, string])[] = [];
    for (const d of dirents) {
      if (d.isDirectory()) out.push([d.name, join(dir, d.name)] as const);
    }
    return Result.ok(out);
  } catch (err) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to read bundled-skills source ${dir}: ${err instanceof Error ? err.message : String(err)}`,
        path: dir,
        cause: err,
      })
    );
  }
}

async function tryRmdirIfEmpty(dir: string): Promise<void> {
  if (!existsSync(dir)) return;
  try {
    const entries = await readdir(dir);
    if (entries.length === 0) await rmdir(dir);
  } catch {
    // Non-fatal — caller has already removed the bundled skills.
  }
}
