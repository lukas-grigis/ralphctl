import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HarnessSignalSink } from '@src/integration/ai/signals/_engine/sink.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { HarnessSignal, SetupSkillProposalSignal, VerifySkillProposalSignal } from '@src/domain/signal.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { buildDetectSkillsPrompt } from '@src/integration/ai/prompts/detect-skills/definition.ts';
import { consumeSignals } from '@src/integration/ai/signals/_engine/consume-signals.ts';
import { withSignalsTempPath } from '@src/integration/ai/signals/_engine/temp-signals-file.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { DetectSkillsCtx } from '@src/application/flows/detect-skills/ctx.ts';

/** Per-call AiSession profile for the detect-skills chain — read-only by construction. */
export const detectSkillsSession = (
  repository: Repository,
  prompt: Prompt,
  model: string,
  signalsFile: AbsolutePath
): AiSession => ({
  prompt,
  cwd: repository.path,
  model,
  permissions: READ_ONLY,
  signalsFile,
});

export interface ProposeDetectSkillsLeafDeps {
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly signals: HarnessSignalSink;
  readonly logger: Logger;
  readonly skillsAdapter: SkillsAdapter;
  readonly model: string;
}

interface ProposeInput {
  readonly repository: Repository;
}

interface ProposeOutput {
  readonly proposedSetupSkill?: string;
  readonly proposedVerifySkill?: string;
}

/**
 * Headless AI round-trip. Builds the detect-skills prompt, runs the session against the
 * repository path, then picks the `setup-skill-proposal` / `verify-skill-proposal` signals out
 * of the provider's signals file. Either signal may be absent — that's a valid "no skill
 * needed" answer.
 */
const proposeUseCase = async (
  deps: ProposeDetectSkillsLeafDeps,
  input: ProposeInput
): Promise<Result<ProposeOutput, DomainError>> => {
  const log = deps.logger.named('detect-skills.propose');
  log.info(`starting repo ${input.repository.name}`, {
    repositoryId: String(input.repository.id),
    repositoryPath: String(input.repository.path),
  });

  const prompt = await buildDetectSkillsPrompt(deps.templateLoader, {
    repositoryPath: String(input.repository.path),
    skillsConvention: deps.skillsAdapter.describeSkillsConvention(),
  });
  if (!prompt.ok) return Result.error(prompt.error);

  return withSignalsTempPath('detect-skills', async (signalsFile) => {
    const signals = await consumeSignals(
      deps.provider,
      detectSkillsSession(input.repository, prompt.value, deps.model, signalsFile),
      deps.signals
    );
    if (!signals.ok) {
      log.error(`provider failed for repo ${input.repository.name}`, {
        repositoryId: String(input.repository.id),
        error: signals.error.message,
      });
      return Result.error(signals.error);
    }

    const setupSkill = signals.value.find(
      (s: HarnessSignal): s is SetupSkillProposalSignal => s.type === 'setup-skill-proposal'
    )?.content;
    const verifySkill = signals.value.find(
      (s: HarnessSignal): s is VerifySkillProposalSignal => s.type === 'verify-skill-proposal'
    )?.content;

    log.info(`proposal ready for repo ${input.repository.name}`, {
      repositoryId: String(input.repository.id),
      hasSetupSkill: setupSkill !== undefined,
      hasVerifySkill: verifySkill !== undefined,
      setupLength: setupSkill?.length ?? 0,
      verifyLength: verifySkill?.length ?? 0,
    });

    return Result.ok({
      ...(setupSkill !== undefined ? { proposedSetupSkill: setupSkill } : {}),
      ...(verifySkill !== undefined ? { proposedVerifySkill: verifySkill } : {}),
    });
  });
};

export const proposeDetectSkillsLeaf = (deps: ProposeDetectSkillsLeafDeps): Element<DetectSkillsCtx> =>
  leaf<DetectSkillsCtx, ProposeInput, ProposeOutput>('propose', {
    useCase: {
      execute: async (input) => proposeUseCase(deps, input),
    },
    input: (ctx) => {
      if (ctx.repository === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-propose',
          attemptedAction: 'propose',
          message: 'propose: ctx.repository is undefined — pick-repository must run first',
        });
      }
      return { repository: ctx.repository };
    },
    output: (ctx, out) => ({
      ...ctx,
      proposal: {
        ...(out.proposedSetupSkill !== undefined ? { proposedSetupSkill: out.proposedSetupSkill } : {}),
        ...(out.proposedVerifySkill !== undefined ? { proposedVerifySkill: out.proposedVerifySkill } : {}),
      },
    }),
  });
