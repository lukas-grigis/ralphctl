import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { Sink } from '@src/business/observability/sink.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { HarnessSignal, SetupScriptSignal, VerifyScriptSignal } from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { buildDetectScriptsPrompt } from '@src/integration/ai/prompts/detect-scripts/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import { detectScriptsOutputContract } from '@src/application/flows/detect-scripts/leaves/propose.contract.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { buildRunDirName } from '@src/integration/ai/runs/_engine/run-artifacts.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { DetectScriptsCtx } from '@src/application/flows/detect-scripts/ctx.ts';

/**
 * Per-call AiSession profile for the detect-scripts chain — read-only by construction.
 * `outputDir` carries the per-run forensic dir; the AI writes `signals.json` directly there.
 */
export const detectScriptsSession = (
  repository: Repository,
  prompt: Prompt,
  model: string,
  signalsFile: AbsolutePath,
  outputDir: AbsolutePath,
  bodyFile?: AbsolutePath,
  effort?: string,
  abortSignal?: AbortSignal
): AiSession => ({
  prompt,
  cwd: repository.path,
  model,
  permissions: READ_ONLY,
  signalsFile,
  outputDir,
  ...(bodyFile !== undefined ? { bodyFile } : {}),
  ...(effort !== undefined ? { effort } : {}),
  // Thread the chain's abort signal so a TUI cancel mid-spawn kills the child.
  ...(abortSignal !== undefined ? { abortSignal } : {}),
});

export interface ProposeDetectScriptsLeafDeps {
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  /**
   * Legacy harness signal sink — fanned out so the TUI's per-flow signal panels keep
   * rendering live updates while the eventBus subscriber path matures. The `eventBus`
   * mirror below is the canonical path for new consumers.
   */
  readonly signals: Sink<HarnessSignal>;
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly model: string;
  /** Optional reasoning / effort level forwarded into the AiSession. */
  readonly effort?: string;
  /**
   * `<dataRoot>/runs`. The leaf creates `<runsRoot>/detect-scripts/<run-id>/` and writes
   * `prompt.md` (the rendered template the AI saw), `signals.json` (the AI's contract
   * envelope), and `body.txt` (the raw AI response). The directory is the operator's primary
   * diagnostic surface when a proposal comes back empty.
   *
   * Lifecycle is user-managed: artifacts persist after the run; `rm -rf <runsRoot>` at any
   * point is safe. We intentionally do NOT auto-GC — the failure mode of losing a forensic
   * record is worse than the cost of an occasional `rm`.
   */
  readonly runsRoot: AbsolutePath;
}

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

interface RunPaths {
  readonly runDir: AbsolutePath;
  readonly promptFile: AbsolutePath;
  readonly bodyFile: AbsolutePath;
  readonly signalsFile: AbsolutePath;
}

const allocateRunPaths = (runsRoot: AbsolutePath): Result<RunPaths, DomainError> => {
  const runDir = AbsolutePath.parse(join(String(runsRoot), 'detect-scripts', buildRunDirName()));
  if (!runDir.ok) return Result.error(runDir.error);
  const promptFile = AbsolutePath.parse(join(String(runDir.value), 'prompt.md'));
  if (!promptFile.ok) return Result.error(promptFile.error);
  const bodyFile = AbsolutePath.parse(join(String(runDir.value), 'body.txt'));
  if (!bodyFile.ok) return Result.error(bodyFile.error);
  const signalsFile = AbsolutePath.parse(join(String(runDir.value), 'signals.json'));
  if (!signalsFile.ok) return Result.error(signalsFile.error);
  return Result.ok({
    runDir: runDir.value,
    promptFile: promptFile.value,
    bodyFile: bodyFile.value,
    signalsFile: signalsFile.value,
  });
};

/**
 * Build the detect-scripts prompt, run the AI, validate the audit-[09] `signals.json` it
 * wrote, fan validated signals out to the bus + sink, project the proposed script lines onto
 * the leaf output.
 *
 * Unlike `readiness/propose`, this leaf does not require either signal to be present: a clean
 * repo where the AI honestly says "nothing to do" produces `{}` and the confirm leaf then
 * shows the user a "no suggestions" state. Failing the chain would be the wrong outcome for
 * a useful "no answer".
 *
 * Forensic artifacts: every call materialises `<runsRoot>/detect-scripts/<run-id>/prompt.md`
 * (always), `signals.json` (the contract envelope), and `body.txt` (when the configured
 * provider implements `bodyFile` — Claude does today; Copilot / Codex no-op). Operators
 * inspect these when a proposal comes back empty to decide whether the prompt or the AI is
 * at fault. Artifacts persist after the chain exits — user manages the lifecycle.
 */
const proposeUseCase = async (
  deps: ProposeDetectScriptsLeafDeps,
  input: ProposeInput,
  abortSignal?: AbortSignal
): Promise<Result<ProposeOutput, DomainError>> => {
  const log = deps.logger.named('detect-scripts.propose');
  log.info(`starting repo ${input.repository.name}`, {
    repositoryId: String(input.repository.id),
    repositoryPath: String(input.repository.path),
  });

  const paths = allocateRunPaths(deps.runsRoot);
  if (!paths.ok) return Result.error(paths.error);

  const outputContractSection = renderContractSectionFor(detectScriptsOutputContract, paths.value.runDir);
  const prompt = await buildDetectScriptsPrompt(deps.templateLoader, {
    repositoryPath: String(input.repository.path),
    outputContractSection,
  });
  if (!prompt.ok) return Result.error(prompt.error);

  // Write the rendered prompt first so the artifact survives even when the provider call fails.
  // `writeTextAtomic` mkdir-p's the run dir for us.
  const promptWrote = await writeTextAtomic(String(paths.value.promptFile), String(prompt.value));
  if (!promptWrote.ok) return Result.error(promptWrote.error);

  const spawn = await deps.provider.generate(
    detectScriptsSession(
      input.repository,
      prompt.value,
      deps.model,
      paths.value.signalsFile,
      paths.value.runDir,
      paths.value.bodyFile,
      deps.effort,
      abortSignal
    )
  );
  if (!spawn.ok) {
    log.error(`provider failed for repo ${input.repository.name}`, {
      repositoryId: String(input.repository.id),
      error: spawn.error.message,
      runDir: String(paths.value.runDir),
    });
    return Result.error(spawn.error);
  }

  const validated = await validateSignalsFile(paths.value.runDir, detectScriptsOutputContract);
  if (!validated.ok) {
    log.error(`signals validation failed for repo ${input.repository.name}`, {
      repositoryId: String(input.repository.id),
      error: validated.error.message,
      runDir: String(paths.value.runDir),
    });
    return Result.error(validated.error);
  }
  const signals = validated.value;

  // Fan-out to BOTH the legacy sink (TUI panels) AND the typed event bus — matching the
  // generator/evaluator dual-emit pattern. Wave 6 of the audit collapses the two paths
  // once every TUI consumer migrates to `ai-signal` events.
  for (const sig of signals) {
    deps.signals.emit(sig);
    deps.eventBus.publish({ type: 'ai-signal', signal: sig, source: 'detect-scripts' });
  }

  const setupScript = signals.find((s): s is SetupScriptSignal => s.type === 'setup-script')?.command;
  const verifyScript = signals.find((s): s is VerifyScriptSignal => s.type === 'verify-script')?.command;

  if (setupScript === undefined && verifyScript === undefined) {
    // Surface the run dir at warn level — an empty proposal is the case the operator most
    // needs to diagnose, and the body.txt is right there to inspect.
    log.warn(`AI returned no proposals for repo ${input.repository.name} — inspect run dir for prompt + raw body`, {
      repositoryId: String(input.repository.id),
      runDir: String(paths.value.runDir),
    });
  }

  log.info(`proposal ready for repo ${input.repository.name}`, {
    repositoryId: String(input.repository.id),
    hasSetupScript: setupScript !== undefined,
    hasVerifyScript: verifyScript !== undefined,
    runDir: String(paths.value.runDir),
  });

  return Result.ok({
    ...(setupScript !== undefined ? { proposedSetupScript: setupScript } : {}),
    ...(verifyScript !== undefined ? { proposedVerifyScript: verifyScript } : {}),
    runDir: paths.value.runDir,
  });
};

export const proposeDetectScriptsLeaf = (deps: ProposeDetectScriptsLeafDeps): Element<DetectScriptsCtx> =>
  leaf<DetectScriptsCtx, ProposeInput, ProposeOutput>('propose', {
    useCase: {
      execute: async (input, signal) => proposeUseCase(deps, input, signal),
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
