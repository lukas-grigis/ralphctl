/**
 * `createFilesystemSkillsAdapter` — shared {@link SkillsAdapter} implementation backing
 * every provider whose skills convention is "write `<sessionDir>/<parentDir>/skills/<name>/
 * SKILL.md` and let the running CLI auto-discover it." That covers Claude (`.claude`), Codex
 * (`.agents`), and Copilot (`.github`) — all use the Agent Skills open-standard frontmatter.
 *
 * Behaviour (identical across providers, only `parentDir` and the {@link describeSkillsConvention}
 * text differ):
 *  - **Project skills win.** If `<sessionDir>/<parentDir>/skills/<name>/` already exists, the
 *    user authored their own copy — leave it untouched and exclude `<name>` from the manifest.
 *  - **Manifest-tracked uninstall.** `install` records names it actually wrote into a
 *    per-`sessionDir` Set. `uninstall` removes only those, then attempts to clean up the
 *    `<parentDir>/skills` and `<parentDir>` directories when they end up empty.
 *  - **Idempotent.** A second `install` adds only the still-missing skills; double-`uninstall`
 *    is a no-op.
 *
 * Why one helper instead of three near-identical adapters: the only inter-provider differences
 * are the `parentDir` constant (`.claude` vs `.agents` vs `.github`) and the convention prose.
 * Keeping the logic in one place means a bugfix here lands for every provider at once.
 */

import { existsSync } from 'node:fs';
import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { ensureGitExcludeWildcard } from '@src/integration/io/git-exclude.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';

export interface FilesystemSkillsAdapterDeps {
  /** Provider id — used only for error messages. */
  readonly providerId: string;
  /**
   * Top-level directory the running CLI scans for skills (e.g. `.claude`, `.agents`,
   * `.github`). The adapter creates `<sessionDir>/<parentDir>/skills/<name>/SKILL.md`.
   */
  readonly parentDir: string;
  /** Markdown sentence returned from {@link SkillsAdapter.describeSkillsConvention}. */
  readonly convention: string;
  /**
   * Optional logger — used to warn when the best-effort `.git/info/exclude` write fails.
   * Skills install still succeeds in that case; the user just sees harness-authored
   * `ralphctl-*` folders in `git status` until the exclude lands manually.
   */
  readonly logger?: Logger;
}

/**
 * Render the canonical Skill back into Markdown with frontmatter — Agent Skills spec
 * (`name`, `description`, plus optional `license` / `compatibility` / `allowed-tools`).
 */
const renderSkill = (skill: Skill): string => {
  const lines = ['---', `name: ${skill.name}`, `description: ${skill.description}`];
  if (skill.license !== undefined) lines.push(`license: ${skill.license}`);
  if (skill.compatibility !== undefined) lines.push(`compatibility: ${skill.compatibility}`);
  if (skill.allowedTools !== undefined) lines.push(`allowed-tools: ${skill.allowedTools}`);
  lines.push('---');
  return `${lines.join('\n')}\n\n${skill.content.replace(/\s+$/u, '')}\n`;
};

const tryRmdirIfEmpty = async (path: string): Promise<void> => {
  try {
    await rmdir(path);
  } catch {
    // Non-empty or missing — both are fine, the cleanup is best-effort.
  }
};

export const createFilesystemSkillsAdapter = (deps: FilesystemSkillsAdapterDeps): SkillsAdapter => {
  // Per-sessionDir manifest of skill names this adapter created at install time. Cleared on
  // a successful uninstall. Not promised across crashed runs — the cleanup is best-effort.
  const installed = new Map<string, Set<string>>();
  // Per-sessionDir flag tracking whether we've already attempted to append the wildcard
  // exclude. Idempotent against the file regardless, but the in-memory check avoids re-
  // reading the file on every install call across a long-running session.
  const excludeAttempted = new Set<string>();
  const skillsSubdir = join(deps.parentDir, 'skills');
  const excludePattern = `${skillsSubdir}/ralphctl-*`;

  // Self-healing prune: drop manifest entries whose sessionDir no longer exists on disk. The
  // typical leak path is the per-task subchain failing BETWEEN `linkSkills` and `unlinkSkills`
  // — `sequential` then marks unlink as skipped, no cleanup runs, and the map entry sticks
  // for the harness lifetime. We can't reliably force unlink to run (the chain framework has
  // no try/finally semantics), so prune lazily on every install: stale sessionDirs are
  // workspaces ralphctl deleted or moved, so their entries can't ever be unwound anyway.
  const pruneStale = (): void => {
    for (const key of [...installed.keys()]) {
      if (!existsSync(key)) installed.delete(key);
    }
  };

  return {
    async install(sessionDir: AbsolutePath, skills: readonly Skill[]): Promise<Result<void, StorageError>> {
      pruneStale();
      const skillsDir = join(String(sessionDir), skillsSubdir);
      const tracked = installed.get(String(sessionDir)) ?? new Set<string>();

      for (const skill of skills) {
        const dst = join(skillsDir, skill.name);
        if (existsSync(dst)) continue; // project copy wins

        try {
          await mkdir(dst, { recursive: true });
          await writeFile(join(dst, 'SKILL.md'), renderSkill(skill), 'utf-8');
          tracked.add(skill.name);
        } catch (cause) {
          // Persist anything we did install before failing so a follow-up uninstall still
          // cleans them up.
          if (tracked.size > 0) installed.set(String(sessionDir), tracked);
          return Result.error(
            new StorageError({
              subCode: 'io',
              message: `${deps.providerId}: failed to install skill ${skill.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
              path: dst,
              cause,
            })
          );
        }
      }

      if (tracked.size > 0) installed.set(String(sessionDir), tracked);

      // Best-effort: append a single wildcard line to <sessionDir>/.git/info/exclude so
      // every `ralphctl-*` skill we manage stays out of `git status`. A non-git tree, a
      // worktree, or a write-protected `.git/info/exclude` all collapse to "warn and
      // proceed" — the skill install itself already succeeded.
      if (!excludeAttempted.has(String(sessionDir))) {
        excludeAttempted.add(String(sessionDir));
        const excluded = await ensureGitExcludeWildcard(sessionDir, excludePattern);
        if (!excluded.ok) {
          deps.logger
            ?.named('skills.exclude')
            .warn(`${deps.providerId}: failed to update .git/info/exclude: ${excluded.error.message}`);
        }
      }

      return Result.ok(undefined);
    },

    async installBareSkill(sessionDir: AbsolutePath, skill: Skill): Promise<Result<void, StorageError>> {
      // Bare-name install path — drops the `ralphctl-` prefix, doesn't touch
      // `.git/info/exclude`, doesn't add to the manifest. The folder is deliberately
      // project-tracked so the operator commits it as a regular project asset.
      const skillsDir = join(String(sessionDir), skillsSubdir);
      const dst = join(skillsDir, skill.name);
      // Project-wins: a pre-existing `SKILL.md` at the destination is the operator's own.
      // Leave it alone (the readiness flow may run on a repo where these skills already
      // exist from a previous run; we don't want to overwrite operator edits).
      if (existsSync(join(dst, 'SKILL.md'))) return Result.ok(undefined);
      try {
        await mkdir(dst, { recursive: true });
        await writeFile(join(dst, 'SKILL.md'), renderSkill(skill), 'utf-8');
      } catch (cause) {
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: `${deps.providerId}: failed to install bare skill ${skill.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
            path: dst,
            cause,
          })
        );
      }
      return Result.ok(undefined);
    },

    describeSkillsConvention(): string {
      return deps.convention;
    },

    async uninstall(sessionDir: AbsolutePath): Promise<Result<void, StorageError>> {
      const key = String(sessionDir);
      const tracked = installed.get(key);
      if (tracked === undefined || tracked.size === 0) return Result.ok(undefined);

      const skillsDir = join(key, skillsSubdir);
      try {
        for (const id of tracked) {
          await rm(join(skillsDir, id), { recursive: true, force: true });
        }
        installed.delete(key);
      } catch (cause) {
        return Result.error(
          new StorageError({
            subCode: 'io',
            message: `${deps.providerId}: failed to uninstall skills under ${skillsDir}: ${cause instanceof Error ? cause.message : String(cause)}`,
            path: skillsDir,
            cause,
          })
        );
      }

      // Tidy empty parent dirs we may have created. Failure is benign — the skills
      // themselves are already gone, and a non-empty parent (e.g. a project `.github/`
      // with workflows in it) is preserved by `tryRmdirIfEmpty`.
      await tryRmdirIfEmpty(skillsDir);
      await tryRmdirIfEmpty(join(key, deps.parentDir));
      return Result.ok(undefined);
    },
  };
};
