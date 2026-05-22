/**
 * `SkillsAdapter` — provider-specific install / uninstall of skills into an AI session's
 * sandbox.
 *
 * Each AI provider has (or doesn't have) its own skills-discovery convention:
 *  - Claude reads `<sessionDir>/.claude/skills/<id>/SKILL.md` and auto-mounts each.
 *  - Copilot / Codex have no equivalent today; their adapters are no-ops with a hook.
 *
 * The adapter takes a list of canonical {@link Skill}s and writes them in the format the
 * selected provider discovers. The same port is reused for both bundled skills (this PR) and
 * user-defined skills (next PR) — the adapter never knows where the {@link Skill} list came
 * from.
 *
 * `install` is idempotent and *project-skills-win*: a destination that already exists with
 * matching content is left untouched, and that name is excluded from the manifest the
 * matching `uninstall` will use to clean up. Pre-existing folders the user authored
 * themselves under `<sessionDir>/.claude/skills/<id>/` are preserved verbatim.
 */

import type { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';

export interface SkillsAdapter {
  /**
   * Install the given skills into the AI session's sandbox at `sessionDir`. Returns ok on
   * every path including "this provider has no skills concept" (the adapter logs and
   * no-ops). Project skills already at the destination are preserved.
   *
   * This is the **bundled-skills** path — adapter prepends `ralphctl-*` tracking (so
   * `uninstall` removes only those entries) and appends the `ralphctl-*` wildcard to
   * `.git/info/exclude` (so bundled folders don't show in `git status`). Use
   * {@link installBareSkill} for project-tracked, AI-authored skills (readiness).
   */
  install(sessionDir: AbsolutePath, skills: readonly Skill[]): Promise<Result<void, StorageError>>;
  /**
   * Install one bare-name skill — written to `<sessionDir>/<parentDir>/skills/<skill.name>/
   * SKILL.md` with NO `ralphctl-` prefix and NO `.git/info/exclude` entry, so the folder is
   * **deliberately tracked by git** as a project asset. Used by the readiness flow to land
   * the AI-authored setup / verify skill bodies after operator approval.
   *
   * Bare-name installs are NOT recorded in the adapter's manifest; {@link uninstall} leaves
   * them in place. The operator owns their lifecycle (commit, edit, delete).
   *
   * Idempotent: when the destination already contains a `SKILL.md`, the existing file is
   * left untouched (same project-wins rule as {@link install}). Returns ok on a provider
   * whose adapter has no skills concept — the call is a logged no-op.
   */
  installBareSkill(sessionDir: AbsolutePath, skill: Skill): Promise<Result<void, StorageError>>;
  /**
   * Remove only the skills `install` placed at `sessionDir` (manifest-tracked). Pre-existing
   * project copies and {@link installBareSkill}-placed skills are never touched. Idempotent —
   * calling without a prior install (or after a previous uninstall) is a no-op.
   */
  uninstall(sessionDir: AbsolutePath): Promise<Result<void, StorageError>>;
  /**
   * Short markdown snippet that describes where this provider stores skills and how the
   * running AI session can read them. Spliced into authoring prompts so the prompt template
   * itself stays provider-agnostic. Implementations that have no convention (Copilot, Codex
   * today) return a single sentence saying so — the prompt then knows to skip the existing-
   * skill check rather than guess at a path.
   */
  describeSkillsConvention(): string;
}
