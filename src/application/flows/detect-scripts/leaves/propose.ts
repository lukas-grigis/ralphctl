import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HarnessSignalSink } from '@src/integration/ai/signals/_engine/sink.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
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
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { DetectScriptsCtx } from '@src/application/flows/detect-scripts/ctx.ts';

/** Per-call AiSession profile for the detect-scripts chain — read-only by construction. */
export const detectScriptsSession = (
  repository: Repository,
  prompt: Prompt,
  model: string,
  signalsFile: AbsolutePath,
  bodyFile?: AbsolutePath
): AiSession => ({
  prompt,
  cwd: repository.path,
  model,
  permissions: READ_ONLY,
  signalsFile,
  ...(bodyFile !== undefined ? { bodyFile } : {}),
});

export interface ProposeDetectScriptsLeafDeps {
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly signals: HarnessSignalSink;
  readonly logger: Logger;
  readonly model: string;
  /**
   * `<dataRoot>/runs`. The leaf creates `<runsRoot>/detect-scripts/<run-id>/` and writes
   * `prompt.md` (the rendered template the AI saw) and `body.txt` (the raw AI response). The
   * directory is the operator's primary diagnostic surface when a proposal comes back empty —
   * tail the body, eyeball the prompt, decide whether to tighten the wording or the parser.
   *
   * Lifecycle is user-managed: artifacts persist after the run; `rm -rf <runsRoot>` at any
   * point is safe. We intentionally do NOT auto-GC — the failure mode of losing a forensic
   * record is worse than the cost of an occasional `rm`.
   */
  readonly runsRoot: AbsolutePath;
}

/**
 * Build a unique run directory name. Lexicographic sort = chronological sort, which is what
 * an operator wants when they `ls` the runs dir. Random suffix keeps two near-simultaneous
 * runs from colliding in the same millisecond.
 */
const buildRunDirName = (): string => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
};

interface ProposeInput {
  readonly repository: Repository;
}

interface ProposeOutput {
  readonly proposedSetupScript?: string;
  readonly proposedVerifyScript?: string;
  /**
   * Per-run forensic dir surfaced for the confirm leaf to read `body.txt` when both scripts
   * are absent. Always set on success — the leaf creates the dir before calling the AI.
   */
  readonly runDir: AbsolutePath;
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
 *
 * Forensic artifacts: every call materialises `<runsRoot>/detect-scripts/<run-id>/prompt.md`
 * (always) and `<run-id>/body.txt` (when the configured provider implements `bodyFile` — Claude
 * does today; Copilot / Codex no-op). Operators inspect these when a proposal comes back empty
 * to decide whether the prompt, the parser, or the AI is at fault. Artifacts persist after the
 * chain exits — user manages the lifecycle (`rm -rf <runsRoot>` at will).
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

  const runDir = AbsolutePath.parse(join(String(deps.runsRoot), 'detect-scripts', buildRunDirName()));
  if (!runDir.ok) return Result.error(runDir.error);
  const promptFile = AbsolutePath.parse(join(String(runDir.value), 'prompt.md'));
  if (!promptFile.ok) return Result.error(promptFile.error);
  const bodyFile = AbsolutePath.parse(join(String(runDir.value), 'body.txt'));
  if (!bodyFile.ok) return Result.error(bodyFile.error);

  // Write the rendered prompt first so the artifact survives even when the provider call fails
  // before reaching `bodyFile`. `writeTextAtomic` mkdir-p's the run dir for us.
  const promptWrote = await writeTextAtomic(String(promptFile.value), String(prompt.value));
  if (!promptWrote.ok) return Result.error(promptWrote.error);

  return await withSignalsTempPath('detect-scripts', async (signalsFile) => {
    const signals = await consumeSignals(
      deps.provider,
      detectScriptsSession(input.repository, prompt.value, deps.model, signalsFile, bodyFile.value),
      deps.signals
    );
    if (!signals.ok) {
      log.error(`provider failed for repo ${input.repository.name}`, {
        repositoryId: String(input.repository.id),
        error: signals.error.message,
        runDir: String(runDir.value),
      });
      return Result.error(signals.error);
    }

    const setupScript = signals.value.find(
      (s: HarnessSignal): s is SetupScriptSignal => s.type === 'setup-script'
    )?.command;
    const verifyScript = signals.value.find(
      (s: HarnessSignal): s is VerifyScriptSignal => s.type === 'verify-script'
    )?.command;

    if (setupScript === undefined && verifyScript === undefined) {
      // Surface the run dir at warn level — an empty proposal is the case the operator most
      // needs to diagnose, and the body.txt is right there to inspect.
      log.warn(`AI returned no proposals for repo ${input.repository.name} — inspect run dir for prompt + raw body`, {
        repositoryId: String(input.repository.id),
        runDir: String(runDir.value),
      });
    }

    log.info(`proposal ready for repo ${input.repository.name}`, {
      repositoryId: String(input.repository.id),
      hasSetupScript: setupScript !== undefined,
      hasVerifyScript: verifyScript !== undefined,
      runDir: String(runDir.value),
    });

    return Result.ok({
      ...(setupScript !== undefined ? { proposedSetupScript: setupScript } : {}),
      ...(verifyScript !== undefined ? { proposedVerifyScript: verifyScript } : {}),
      runDir: runDir.value,
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
        runDir: out.runDir,
      },
    }),
  });
