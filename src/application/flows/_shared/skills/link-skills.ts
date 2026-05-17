/**
 * `linkSkillsLeaf` — install bundled skills into the AI session's sandbox before the session
 * runs.
 *
 * Pairs with {@link unlinkSkillsLeaf}. The flow brackets every AI step with
 * `link → … → unlink`; both leaves dispatch through the wired {@link SkillsAdapter}, which
 * is provider-aware (Claude writes to `.claude/skills/`, Copilot / Codex log + no-op).
 *
 * The leaf does not throw if the skill source has no skills configured for the flow — an
 * empty `Skill[]` is a valid state and `install` is a no-op for empty input.
 *
 * `cwdPicker` is how each flow tells the leaf where its AI session runs from. v2 flows name
 * their cwd field differently (`cwd`, `currentUnitRoot`, etc.) to match their domain — the
 * picker keeps the leaf reusable without forcing every flow to share a single ctx field.
 */

import { Result } from '@src/domain/result.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { FlowId } from '@src/integration/ai/skills/_engine/registry.ts';

export interface LinkSkillsDeps {
  readonly skillsAdapter: SkillsAdapter;
  readonly skillSource: SkillSource;
}

export interface LinkSkillsOptions<TCtx> {
  readonly name?: string;
  readonly flowId: FlowId;
  /** Project the chain context to the AI session's cwd. Throws if the upstream leaves haven't
   * populated it yet — surfaces a misconfigured chain at the failing leaf rather than later. */
  readonly cwdPicker: (ctx: TCtx) => AbsolutePath;
}

export const linkSkillsLeaf = <TCtx>(deps: LinkSkillsDeps, opts: LinkSkillsOptions<TCtx>): Element<TCtx> => {
  const name = opts.name ?? 'link-skills';
  return leaf<TCtx, { readonly cwd: AbsolutePath }, void>(name, {
    useCase: {
      async execute(input): Promise<Result<void, DomainError>> {
        const skills = await deps.skillSource.getForFlow(opts.flowId);
        if (!skills.ok) return Result.error(skills.error);
        return deps.skillsAdapter.install(input.cwd, skills.value);
      },
    },
    input: (ctx) => ({ cwd: opts.cwdPicker(ctx) }),
    output: (ctx) => ctx,
  });
};
