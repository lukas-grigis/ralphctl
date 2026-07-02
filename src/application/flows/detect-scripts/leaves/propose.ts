import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { PublishSignal } from '@src/application/flows/_shared/publish-signal.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type {
  HarnessSignal,
  SetupScriptSignal,
  VerifyGateProposal,
  VerifyGatesSignal,
  VerifyScriptSignal,
} from '@src/domain/signal.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { buildDetectScriptsPrompt } from '@src/integration/ai/prompts/detect-scripts/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import { detectScriptsOutputContract } from '@src/application/flows/detect-scripts/leaves/propose.contract.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { DetectScriptsCtx } from '@src/application/flows/detect-scripts/ctx.ts';
import {
  readOnlySignalsSession,
  type ReadOnlySignalsSessionOpts,
} from '@src/application/flows/_shared/signals-session.ts';
import { runPathsFor, type RunPaths } from '@src/application/flows/_shared/allocate-run-dir.ts';

export interface ProposeDetectScriptsLeafDeps {
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  /**
   * Fan-out seam for every validated signal this run emits — the ONE harness-signal channel
   * (see `publish-signal.ts`). Pre-bound by the flow factory with `source: 'detect-scripts'`.
   */
  readonly publishSignal: PublishSignal;
  readonly logger: Logger;
  readonly model: string;
  /** Optional reasoning / effort level forwarded into the AiSession. */
  readonly effort?: string;
}

interface ProposeInput {
  readonly repository: Repository;
  /**
   * Pre-allocated per-run forensic directory — `<runsRoot>/detect-scripts/<run-id>/`. Resolved
   * upstream by the chain's `allocate-run-dir-detect-scripts` leaf so `prompt.md` (the rendered
   * template the AI saw), `signals.json` (the AI's contract envelope), and `body.txt` (the raw
   * AI response) all land in the same directory — the operator's primary diagnostic surface
   * when a proposal comes back empty.
   *
   * Lifecycle is user-managed: artifacts persist after the run; `rm -rf <runsRoot>` at any
   * point is safe. We intentionally do NOT auto-GC — the failure mode of losing a forensic
   * record is worse than the cost of an occasional `rm`.
   */
  readonly runDir: AbsolutePath;
}

interface ProposeOutput {
  readonly proposedSetupScript?: string;
  readonly proposedVerifyScript?: string;
  /**
   * Structured per-module verify gates the AI proposed for a monorepo-style repo. ADDITIVE to
   * `proposedVerifyScript` — present only alongside it, never instead. Absent for single-module
   * repos. Persisted onto `Repository.verifyGates` on accept; the script remains the legacy
   * fallback the operator sees and edits.
   */
  readonly proposedVerifyGates?: readonly VerifyGateProposal[];
  /**
   * Per-run forensic dir surfaced for the confirm leaf to read `body.txt` when both scripts
   * are absent. Mirrors {@link ProposeInput.runDir} — the leaf receives it and returns it
   * unchanged so downstream leaves can keep reading it off `ctx.proposal.runDir`.
   */
  readonly runDir: AbsolutePath;
}

/**
 * Assemble the `readOnlySignalsSession` options — pulled out of `proposeUseCase` purely to
 * keep the use case's branch count low; the two optional fields are the only conditionals
 * here.
 */
const buildSessionOpts = (
  deps: ProposeDetectScriptsLeafDeps,
  input: ProposeInput,
  paths: RunPaths,
  prompt: Prompt,
  abortSignal: AbortSignal | undefined
): ReadOnlySignalsSessionOpts => ({
  cwd: input.repository.path,
  prompt,
  model: deps.model,
  signalsFile: paths.signalsFile,
  outputDir: input.runDir,
  bodyFile: paths.bodyFile,
  ...(deps.effort !== undefined ? { effort: deps.effort } : {}),
  ...(abortSignal !== undefined ? { abortSignal } : {}),
});

/**
 * Build the detect-scripts prompt, run the AI, validate the audit-[09] `signals.json` it
 * wrote, fan validated signals out to the bus + sink, project the proposed script lines onto
 * the leaf output.
 *
 * Unlike `readiness/propose`, this leaf does not require either signal to be present: a clean
 * repo where the AI honestly says "nothing to do" produces `{}` and the confirm leaf then
 * shows the user a "no suggestions" state. Failing the chain would be the wrong outcome for
 * a useful "no answer".
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

  const paths = runPathsFor(input.runDir);
  if (!paths.ok) return Result.error(paths.error);

  const outputContractSection = renderContractSectionFor(detectScriptsOutputContract, input.runDir);
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
    readOnlySignalsSession(buildSessionOpts(deps, input, paths.value, prompt.value, abortSignal))
  );
  if (!spawn.ok) {
    log.error(`provider failed for repo ${input.repository.name}`, {
      repositoryId: String(input.repository.id),
      error: spawn.error.message,
      runDir: String(input.runDir),
    });
    return Result.error(spawn.error);
  }

  const validated = await validateSignalsFile(input.runDir, detectScriptsOutputContract);
  if (!validated.ok) {
    log.error(`signals validation failed for repo ${input.repository.name}`, {
      repositoryId: String(input.repository.id),
      error: validated.error.message,
      runDir: String(input.runDir),
    });
    return Result.error(validated.error);
  }
  const signals = validated.value;

  // Publish every validated signal onto the one harness-signal channel.
  for (const sig of signals) deps.publishSignal(sig);

  const { setupScript, verifyScript, verifyGates } = extractProposal(signals);

  if (setupScript === undefined && verifyScript === undefined) {
    // Surface the run dir at warn level — an empty proposal is the case the operator most
    // needs to diagnose, and the body.txt is right there to inspect.
    log.warn(`AI returned no proposals for repo ${input.repository.name} — inspect run dir for prompt + raw body`, {
      repositoryId: String(input.repository.id),
      runDir: String(input.runDir),
    });
  }

  log.info(`proposal ready for repo ${input.repository.name}`, {
    repositoryId: String(input.repository.id),
    hasSetupScript: setupScript !== undefined,
    hasVerifyScript: verifyScript !== undefined,
    verifyGateCount: verifyGates?.length ?? 0,
    runDir: String(input.runDir),
  });

  return Result.ok({
    ...(setupScript !== undefined ? { proposedSetupScript: setupScript } : {}),
    ...(verifyScript !== undefined ? { proposedVerifyScript: verifyScript } : {}),
    ...(verifyGates !== undefined ? { proposedVerifyGates: verifyGates } : {}),
    runDir: input.runDir,
  });
};

/**
 * Project the validated detect-scripts signal array onto the three optional proposal fields. The
 * contract caps each kind at one, so `find` is the right primitive. Extracted from
 * `proposeUseCase` so the use-case body stays a flat read of its validation chain.
 */
const extractProposal = (
  signals: readonly HarnessSignal[]
): {
  readonly setupScript?: string;
  readonly verifyScript?: string;
  readonly verifyGates?: readonly VerifyGateProposal[];
} => {
  const setupScript = signals.find((s): s is SetupScriptSignal => s.type === 'setup-script')?.command;
  const verifyScript = signals.find((s): s is VerifyScriptSignal => s.type === 'verify-script')?.command;
  const verifyGates = signals.find((s): s is VerifyGatesSignal => s.type === 'verify-gates')?.gates;
  return {
    ...(setupScript !== undefined ? { setupScript } : {}),
    ...(verifyScript !== undefined ? { verifyScript } : {}),
    ...(verifyGates !== undefined ? { verifyGates } : {}),
  };
};

export const proposeDetectScriptsLeaf = (deps: ProposeDetectScriptsLeafDeps): Element<DetectScriptsCtx> =>
  leaf<DetectScriptsCtx, ProposeInput, ProposeOutput>('propose', {
    useCase: {
      execute: async (input, signal) => proposeUseCase(deps, input, signal),
    },
    input: (ctx) => {
      const PRE_PROPOSE_STATE = 'pre-propose';
      if (ctx.repository === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: PRE_PROPOSE_STATE,
          attemptedAction: 'propose',
          message: 'propose: ctx.repository is undefined — pick-repository must run first',
        });
      }
      const runDir = ctx.proposal?.runDir;
      if (runDir === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: PRE_PROPOSE_STATE,
          attemptedAction: 'propose',
          message: 'propose: ctx.proposal.runDir is undefined — allocate-run-dir must run first',
        });
      }
      return { repository: ctx.repository, runDir };
    },
    output: (ctx, out) => ({
      ...ctx,
      proposal: {
        ...(out.proposedSetupScript !== undefined ? { proposedSetupScript: out.proposedSetupScript } : {}),
        ...(out.proposedVerifyScript !== undefined ? { proposedVerifyScript: out.proposedVerifyScript } : {}),
        ...(out.proposedVerifyGates !== undefined ? { proposedVerifyGates: out.proposedVerifyGates } : {}),
        runDir: out.runDir,
      },
    }),
  });
