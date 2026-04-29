import { lstatSync, readlinkSync, unlinkSync } from 'node:fs';
import { lstat, mkdir, readlink, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { LinkedSkillSet, ResolvedSkill } from '@src/business/ports/skills.ts';

/**
 * Subdirectory under each working directory where Claude Code looks for
 * project-scoped skills.
 */
const SKILLS_SUBDIR = join('.claude', 'skills');

/**
 * Module-level set of linked skill sets that have not yet been cleaned up.
 * On `process.exit` (any cause — normal completion, uncaught error, default
 * SIGINT termination) we walk this set and remove any leftover symlinks
 * synchronously so a crashed phase never leaves a `.claude/skills/<name>`
 * symlink pointing into the harness install behind in a working tree.
 */
const activeLinkedSets = new Set<LinkedSkillSet>();
let exitHandlerInstalled = false;

function ensureExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on('exit', () => {
    for (const set of activeLinkedSets) {
      cleanupSkillsSync(set);
    }
    activeLinkedSets.clear();
  });
}

/**
 * Create `<workingDir>/.claude/skills/<name>` symlinks for each skill,
 * pointing to its `sourcePath`. Returns the set of names successfully
 * linked — any link that failed (e.g. permission, or a pre-existing entry
 * that isn't ours) is logged as a warning and excluded from the returned
 * set, matching the loader's "skip invalid + continue" contract.
 *
 * The working directory and `.claude/skills` parent are created on demand.
 * The set is registered in a module-level registry so a crashed phase still
 * gets the symlinks reaped via the `process.on('exit')` handler.
 */
export async function linkSkillsForPhase(
  workingDir: string,
  skills: readonly ResolvedSkill[],
  logger?: LoggerPort
): Promise<LinkedSkillSet> {
  const skillsDir = join(workingDir, SKILLS_SUBDIR);
  await mkdir(skillsDir, { recursive: true });

  const linkedNames: string[] = [];
  for (const skill of skills) {
    const linkPath = join(skillsDir, skill.name);
    try {
      // Rebind any pre-existing symlink we previously left behind so a
      // re-run of the phase always points to the current source. A regular
      // file or directory at the same path is treated as user-owned and
      // left alone with a warning — overwriting it would risk data loss.
      try {
        const existing = await lstat(linkPath);
        if (existing.isSymbolicLink()) {
          await unlink(linkPath);
        } else {
          logger?.warning(
            `Skipping skill '${skill.name}': ${linkPath} already exists and is not a symlink — leaving user file untouched.`
          );
          continue;
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | undefined)?.code;
        if (code !== 'ENOENT') throw err;
      }
      await symlink(skill.sourcePath, linkPath, 'dir');
      linkedNames.push(skill.name);
    } catch (err) {
      logger?.warning(
        `Failed to link skill '${skill.name}' into ${linkPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const set: LinkedSkillSet = { workingDir, linkedNames };
  if (linkedNames.length > 0) {
    activeLinkedSets.add(set);
    ensureExitHandler();
  }
  return set;
}

/**
 * Remove every symlink the matched `link` call created. Idempotent — a
 * second call is a no-op. Files that aren't symlinks (someone else replaced
 * the entry between link and cleanup) are left untouched with a warning so
 * cleanup never destroys user data.
 */
export async function cleanupSkills(set: LinkedSkillSet, logger?: LoggerPort): Promise<void> {
  activeLinkedSets.delete(set);
  if (set.linkedNames.length === 0) return;
  const skillsDir = join(set.workingDir, SKILLS_SUBDIR);
  for (const name of set.linkedNames) {
    const linkPath = join(skillsDir, name);
    try {
      const stats = await lstat(linkPath);
      if (!stats.isSymbolicLink()) {
        logger?.warning(
          `Skipping cleanup of '${name}' at ${linkPath}: entry is no longer a symlink — leaving in place.`
        );
        continue;
      }
      // Defence in depth: re-read the symlink target so a renamed-then-recreated
      // entry that happens to share the link name doesn't get unlinked.
      try {
        await readlink(linkPath);
      } catch {
        // Already gone — fall through and let unlink no-op via ENOENT.
      }
      await unlink(linkPath);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') continue;
      logger?.warning(
        `Failed to clean up skill '${name}' at ${linkPath}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

/**
 * Synchronous cleanup for `process.on('exit')`. Identical semantics to the
 * async variant but uses the sync fs API since exit handlers cannot await.
 * Errors are swallowed — the process is already terminating and there is
 * nowhere meaningful to surface them.
 */
function cleanupSkillsSync(set: LinkedSkillSet): void {
  if (set.linkedNames.length === 0) return;
  const skillsDir = join(set.workingDir, SKILLS_SUBDIR);
  for (const name of set.linkedNames) {
    const linkPath = join(skillsDir, name);
    try {
      const stats = lstatSync(linkPath);
      if (!stats.isSymbolicLink()) continue;
      try {
        readlinkSync(linkPath);
      } catch {
        continue;
      }
      unlinkSync(linkPath);
    } catch {
      // Swallow — exit-time best-effort.
    }
  }
}

/**
 * Test helper — drains the module-level registry. Production code should
 * never need this; tests use it to keep state isolated across cases.
 *
 * Also performs a best-effort sync cleanup so a test that forgets to call
 * `cleanupSkills` does not leak symlinks into the next case.
 */
export function _resetSkillRegistryForTests(): void {
  for (const set of activeLinkedSets) {
    cleanupSkillsSync(set);
  }
  activeLinkedSets.clear();
}

/**
 * Test helper — read the live registry size without exposing the set itself.
 * Used in lifecycle tests to assert the exit-handler set is drained on
 * cleanup.
 */
export function _activeLinkedSetCountForTests(): number {
  return activeLinkedSets.size;
}

/**
 * Compute every directory the loader will need to mkdir before linking. Pure
 * helper exposed so the pipeline-level link step can validate the working
 * dirs ahead of any filesystem mutation.
 */
export function skillsDirFor(workingDir: string): string {
  return join(workingDir, SKILLS_SUBDIR);
}
