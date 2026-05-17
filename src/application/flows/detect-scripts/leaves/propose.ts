import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HarnessSignalSink } from '@src/integration/ai/signals/_engine/sink.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { HarnessSignal, SetupScriptSignal, VerifyScriptSignal } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { buildDetectScriptsPrompt } from '@src/integration/ai/prompts/detect-scripts/definition.ts';
import { consumeSignals } from '@src/integration/ai/signals/_engine/consume-signals.ts';
import { withSignalsTempPath } from '@src/integration/ai/signals/_engine/temp-signals-file.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { DetectScriptsCtx } from '@src/application/flows/detect-scripts/ctx.ts';

/** Per-call AiSession profile for the detect-scripts chain — read-only by construction. */
export const detectScriptsSession = (
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

export interface ProposeDetectScriptsLeafDeps {
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly signals: HarnessSignalSink;
  readonly logger: Logger;
  readonly model: string;
}

interface ProposeInput {
  readonly repository: Repository;
}

interface ProposeOutput {
  readonly proposedSetupScript?: string;
  readonly proposedVerifyScript?: string;
}

/**
 * Build the detect-scripts prompt, call the AI, pick the `setup-script` / `verify-script`
 * signals out of the provider's signals file. Both signals are optional — the AI is told to
 * omit a tag rather than guess.
 *
 * Unlike `readiness/propose`, this leaf does not require either signal to be present: a clean
 * repo where the AI honestly says "nothing to do" produces `{}` and the confirm leaf then
 * shows the user a "no suggestions" state. Failing the chain would be the wrong outcome for
 * a useful "no answer".
 */
const proposeUseCase = async (
  deps: ProposeDetectScriptsLeafDeps,
  input: ProposeInput
): Promise<Result<ProposeOutput, DomainError>> => {
  const log = deps.logger.named('detect-scripts.propose');
  log.info(`starting repo ${input.repository.name}`, {
    repositoryId: String(input.repository.id),
    repositoryPath: String(input.repository.path),
  });

  const prompt = await buildDetectScriptsPrompt(deps.templateLoader, {
    repositoryPath: String(input.repository.path),
  });
  if (!prompt.ok) return Result.error(prompt.error);

  return withSignalsTempPath('detect-scripts', async (signalsFile) => {
    const signals = await consumeSignals(
      deps.provider,
      detectScriptsSession(input.repository, prompt.value, deps.model, signalsFile),
      deps.signals
    );
    if (!signals.ok) {
      log.error(`provider failed for repo ${input.repository.name}`, {
        repositoryId: String(input.repository.id),
        error: signals.error.message,
      });
      return Result.error(signals.error);
    }

    const setupScript = signals.value.find(
      (s: HarnessSignal): s is SetupScriptSignal => s.type === 'setup-script'
    )?.command;
    const verifyScript = signals.value.find(
      (s: HarnessSignal): s is VerifyScriptSignal => s.type === 'verify-script'
    )?.command;

    log.info(`proposal ready for repo ${input.repository.name}`, {
      repositoryId: String(input.repository.id),
      hasSetupScript: setupScript !== undefined,
      hasVerifyScript: verifyScript !== undefined,
    });

    return Result.ok({
      ...(setupScript !== undefined ? { proposedSetupScript: setupScript } : {}),
      ...(verifyScript !== undefined ? { proposedVerifyScript: verifyScript } : {}),
    });
  });
};

export const proposeDetectScriptsLeaf = (deps: ProposeDetectScriptsLeafDeps): Element<DetectScriptsCtx> =>
  leaf<DetectScriptsCtx, ProposeInput, ProposeOutput>('propose', {
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
        ...(out.proposedSetupScript !== undefined ? { proposedSetupScript: out.proposedSetupScript } : {}),
        ...(out.proposedVerifyScript !== undefined ? { proposedVerifyScript: out.proposedVerifyScript } : {}),
      },
    }),
  });
