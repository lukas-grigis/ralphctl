import { Result } from '@src/domain/result.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';

/**
 * Post-write leaf that copies AI-authored skill bodies into the active provider's
 * `<parentDir>/skills/<bare-name>/SKILL.md` after the operator approves the readiness proposal.
 *
 * Per audit-[09], readiness emits two project-tracked skill kinds: `setup-skill-proposal` and
 * `verify-skill-proposal`. The {@link proposeReadinessLeaf} contract-validation step lands the
 * bodies on `ctx.entries[tool].proposal`; this leaf calls the per-tool skills adapter's
 * bare-name install path to write them.
 *
 * Behaviour:
 *  - Matching entry's `accepted !== true` → no-op (the operator declined this tool's proposal).
 *  - Either body undefined → only the present one is installed (each is independent).
 *  - Both bodies undefined → no-op (the AI didn't propose any; today's prompt never does —
 *    Wave 6 lands the prompt-side ask).
 *  - The destination dir for each install is `ctx.repository.path` — the readiness repo. The
 *    skills adapter resolves the per-provider `<parentDir>/skills/<name>/SKILL.md` below that.
 *
 * Unlike the bundled-skills install (the `install-skills` leaf), this leaf does NOT touch
 * `.git/info/exclude`. The folders are deliberately project-tracked so the operator commits
 * them as regular project assets.
 */
export interface InstallReadinessSkillsLeafDeps {
  readonly skillsAdapter: SkillsAdapter;
  readonly logger: Logger;
}

interface InstallReadinessSkillsInput {
  readonly accepted: boolean;
  readonly repoPath?: AbsolutePath;
  readonly setupBody?: string;
  readonly verifyBody?: string;
}

const buildSkill = (name: 'setup' | 'verify', body: string): Skill => ({
  name,
  description: name === 'setup' ? 'Project setup convention' : 'Project verification convention',
  content: body,
});

const installReadinessSkillsUseCase = async (
  deps: InstallReadinessSkillsLeafDeps,
  tool: AssistantTool,
  input: InstallReadinessSkillsInput
): Promise<Result<void, DomainError>> => {
  const log = deps.logger.named(`readiness.install-skills-${tool}`);
  if (!input.accepted) {
    log.info('skipping skill install — proposal not accepted');
    return Result.ok(undefined);
  }
  if (input.repoPath === undefined) {
    log.info('skipping skill install — no repository path on ctx');
    return Result.ok(undefined);
  }
  if (input.setupBody === undefined && input.verifyBody === undefined) {
    log.info('skipping skill install — AI did not propose any skill bodies');
    return Result.ok(undefined);
  }

  if (input.setupBody !== undefined) {
    const installed = await deps.skillsAdapter.installBareSkill(input.repoPath, buildSkill('setup', input.setupBody));
    if (!installed.ok) return Result.error(installed.error);
    log.info(`installed setup skill at ${String(input.repoPath)}/<parentDir>/skills/setup/SKILL.md`);
  }
  if (input.verifyBody !== undefined) {
    const installed = await deps.skillsAdapter.installBareSkill(input.repoPath, buildSkill('verify', input.verifyBody));
    if (!installed.ok) return Result.error(installed.error);
    log.info(`installed verify skill at ${String(input.repoPath)}/<parentDir>/skills/verify/SKILL.md`);
  }
  return Result.ok(undefined);
};

export const installReadinessSkillsLeaf = (
  deps: InstallReadinessSkillsLeafDeps,
  tool: AssistantTool
): Element<ReadinessCtx> =>
  leaf<ReadinessCtx, InstallReadinessSkillsInput, void>(`install-readiness-skills-${tool}`, {
    useCase: {
      execute: async (input) => installReadinessSkillsUseCase(deps, tool, input),
    },
    input: (ctx) => {
      const entry = ctx.entries[tool];
      const proposal = entry?.proposal;
      return {
        accepted: entry?.accepted ?? false,
        ...(ctx.repository?.path !== undefined ? { repoPath: ctx.repository.path } : {}),
        ...(proposal?.proposedSetupSkillBody !== undefined ? { setupBody: proposal.proposedSetupSkillBody } : {}),
        ...(proposal?.proposedVerifySkillBody !== undefined ? { verifyBody: proposal.proposedVerifySkillBody } : {}),
      };
    },
    output: (ctx) => ctx,
  });
