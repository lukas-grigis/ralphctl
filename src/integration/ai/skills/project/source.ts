/**
 * `createProjectSkillSource` — a {@link SkillSource} that materialises per-repository skills
 * stored on the {@link Project} aggregate. Pairs with the bundled source via
 * {@link composeSkillSources} so the same `installSkillsLeaf` installs both flows of skills
 * without each leaf having to know about the project.
 *
 * Each repository on the project may contribute up to two skills:
 *  - `setup` → from `Repository.setupSkill` (if set)
 *  - `verify` → from `Repository.verifySkill` (if set)
 *
 * Skill names are namespaced per repository so two repos with their own setup skills don't
 * collide in `<sessionDir>/.claude/skills/<name>/`: `ralphctl-<repo-slug>-setup`,
 * `ralphctl-<repo-slug>-verify`. The `ralphctl-` prefix lets the wildcard exclude in
 * `.git/info/exclude` (`<parentDir>/skills/ralphctl-*`) hide these from `git status`
 * alongside the bundled skills.
 *
 * The source is project-aware but flow-agnostic — every flow that links skills installs the
 * same set. Reason: setup + verify guidance is load-bearing across refine (understand the
 * repo), plan (understand the build), implement (the verify step). A more granular per-flow
 * filter is a follow-up.
 */

import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { FlowId } from '@src/integration/ai/skills/_engine/registry.ts';

export interface ProjectSkillSourceDeps {
  /**
   * Project-getter — read every time `getForFlow` is called so the source picks up the latest
   * `setupSkill` / `verifySkill` writes made by detect-skills during the same session.
   * Returning `undefined` (e.g. flow ran without a project) yields an empty skill list.
   */
  readonly getProject: () => Project | undefined;
}

const projectSkillsFor = (project: Project): readonly Skill[] => {
  const skills: Skill[] = [];
  for (const repo of project.repositories) {
    if (repo.setupSkill !== undefined && repo.setupSkill.trim().length > 0) {
      skills.push({
        name: `ralphctl-${String(repo.slug)}-setup`,
        description: `Setup guidance for ${repo.name}: how to prepare the working tree at sprint start.`,
        content: `# Setup — ${repo.name}\n\n${repo.setupSkill}`,
      });
    }
    if (repo.verifySkill !== undefined && repo.verifySkill.trim().length > 0) {
      skills.push({
        name: `ralphctl-${String(repo.slug)}-verify`,
        description: `Verify guidance for ${repo.name}: how to interpret the post-task verification gate.`,
        content: `# Verify — ${repo.name}\n\n${repo.verifySkill}`,
      });
    }
  }
  return skills;
};

export const createProjectSkillSource = (deps: ProjectSkillSourceDeps): SkillSource => ({
  async getForFlow(_flowId: FlowId): Promise<Result<readonly Skill[], StorageError>> {
    void _flowId;
    const project = deps.getProject();
    if (project === undefined) return Result.ok([]);
    return Result.ok(projectSkillsFor(project));
  },
});

/**
 * Compose two or more {@link SkillSource}s into a union — every source's skills are emitted in
 * the order the sources were composed. Used by the launcher to combine the static
 * `BundledSkillSource` (cross-phase skills) with the dynamic `ProjectSkillSource` (per-repo
 * setup / verify skills authored via the detect-skills flow).
 *
 * Errors from any source short-circuit: a hard failure on the bundled side will not be masked
 * by an empty project source.
 */
export const composeSkillSources = (...sources: readonly SkillSource[]): SkillSource => ({
  async getForFlow(flowId: FlowId): Promise<Result<readonly Skill[], StorageError>> {
    const all: Skill[] = [];
    for (const source of sources) {
      const r = await source.getForFlow(flowId);
      if (!r.ok) return Result.error(r.error);
      all.push(...r.value);
    }
    return Result.ok(all);
  },
});
