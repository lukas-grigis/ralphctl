/**
 * Compose the "## Project Tooling" prompt body — a compact, one-line-per-tool catalog threaded
 * into `{{PROJECT_TOOLING}}` by both the generator and evaluator prompt builders (see
 * `renderProjectToolingSection`). Shared between `generator.ts` and `evaluator.ts` so both sides
 * of the gen-eval loop name the same tooling the same way.
 *
 * Every fact here comes from an EXISTING resolution seam — the portable-agents feature's
 * per-role binding (`PerTaskSubchainOpts.generatorAgentDefinition` / `.evaluatorAgentDefinition`,
 * threaded down as a bare name) and the per-flow skill catalog (`ImplementDeps.skillSource`, the
 * same source `installSkillsLeaf` already reads before the AI session starts). No new detection
 * is introduced here — this only NAMES what the harness already resolved and installed, per the
 * empirical finding that explicit tool naming carries a large agent-compliance multiplier.
 *
 * Pure. Empty facts → `''` so `renderProjectToolingSection` falls back to its own
 * "(none detected)" default — this module never emits that fallback text itself.
 */

import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';

export interface ProjectToolingFacts {
  /**
   * This role's bound agent-definition NAME (the portable-agents feature) — the same identifier
   * the prompt's `## Agent Definition` section already announces. Repeated here so the one
   * tool-catalog section is complete for a reader who only skims `{{PROJECT_TOOLING}}`. Absent
   * when the role has no binding.
   */
  readonly agentDefinitionName?: string;
  /** Skills installed for this flow's AI session — name + one-line "when to use" description. */
  readonly skills?: ReadonlyArray<Pick<Skill, 'name' | 'description'>>;
}

export const composeProjectTooling = (facts: ProjectToolingFacts): string => {
  const lines: string[] = [];
  const agentName = facts.agentDefinitionName?.trim();
  if (agentName !== undefined && agentName.length > 0) {
    lines.push(
      `- Subagent: \`${agentName}\` — the bound persona for this session (see the bound sub-agent persona note above); check this session's native subagent listing to delegate to it directly.`
    );
  }
  for (const skill of facts.skills ?? []) {
    const name = skill.name.trim();
    if (name.length === 0) continue;
    lines.push(`- Skill: \`${name}\` — ${skill.description.trim()}`);
  }
  return lines.join('\n');
};
