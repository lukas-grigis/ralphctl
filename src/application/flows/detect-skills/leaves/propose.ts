import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { Sink } from '@src/business/observability/sink.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { HarnessSignal, SetupSkillProposalSignal, VerifySkillProposalSignal } from '@src/domain/signal.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { buildDetectSkillsPrompt } from '@src/integration/ai/prompts/detect-skills/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { renderSidecars } from '@src/integration/ai/contract/_engine/render-sidecars.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import { detectSkillsOutputContract } from '@src/application/flows/detect-skills/leaves/propose.contract.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { SkillsAdapter } from '@src/integration/ai/skills/_engine/skills-port.ts';
import type { DetectSkillsCtx } from '@src/application/flows/detect-skills/ctx.ts';
import {
  readOnlySignalsSession,
  type ReadOnlySignalsSessionOpts,
} from '@src/application/flows/_shared/signals-session.ts';
import { runPathsFor, type RunPaths } from '@src/application/flows/_shared/allocate-run-dir.ts';

export interface ProposeDetectSkillsLeafDeps {
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  /**
   * Legacy harness signal sink — fanned out so the TUI's per-flow signal panels keep
   * rendering live updates while the eventBus subscriber path matures. The `eventBus`
   * mirror below is the canonical path for new consumers.
   */
  readonly signals: Sink<HarnessSignal>;
  readonly eventBus: EventBus;
  readonly writeFile: WriteFile;
  readonly logger: Logger;
  readonly skillsAdapter: SkillsAdapter;
  readonly model: string;
  /** Optional reasoning / effort level forwarded into the AiSession. */
  readonly effort?: string;
}

interface ProposeInput {
  readonly repository: Repository;
  /**
   * Pre-allocated per-run forensic directory — `<runsRoot>/detect-skills/<run-id>/`. Resolved
   * upstream by the chain's `allocate-run-dir-detect-skills` leaf so `prompt.md` (rendered
   * template), `signals.json` (contract envelope), `body.txt` (raw AI response — Claude only)
   * and the two sidecar `*.md` skill bodies all land in the same directory. The confirm leaf
   * reads `body.txt` when both proposals are empty to surface the AI's actual response to the
   * user.
   */
  readonly runDir: AbsolutePath;
}

interface ProposeOutput {
  readonly proposedSetupSkill?: string;
  readonly proposedVerifySkill?: string;
  /**
   * Per-run forensic dir mirrored back for downstream leaves. Mirrors {@link ProposeInput.runDir}
   * — the leaf receives it and returns it unchanged so `ctx.proposal.runDir` stays populated.
   */
  readonly runDir: AbsolutePath;
}

/**
 * Assemble the `readOnlySignalsSession` options — pulled out of `proposeUseCase` purely to
 * keep the use case's branch count low; the two optional fields are the only conditionals
 * here.
 */
const buildSessionOpts = (
  deps: ProposeDetectSkillsLeafDeps,
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
 * Project the validated detect-skills signal array onto the two optional proposal fields. The
 * contract caps each kind at one, so `find` is the right primitive. Extracted from
 * `proposeUseCase` so the use-case body stays a flat read of its validation chain (mirrors
 * detect-scripts' `extractProposal`).
 */
const extractProposal = (
  signals: readonly HarnessSignal[]
): { readonly setupSkill?: string; readonly verifySkill?: string } => {
  const setupSkill = signals.find((s): s is SetupSkillProposalSignal => s.type === 'setup-skill-proposal')?.content;
  const verifySkill = signals.find((s): s is VerifySkillProposalSignal => s.type === 'verify-skill-proposal')?.content;
  return {
    ...(setupSkill !== undefined ? { setupSkill } : {}),
    ...(verifySkill !== undefined ? { verifySkill } : {}),
  };
};

/**
 * Headless AI round-trip. Builds the detect-skills prompt, runs the session against the
 * repository path, validates the audit-[09] `signals.json` the AI wrote, picks the
 * `setup-skill-proposal` / `verify-skill-proposal` signals out for downstream leaves.
 *
 * Either signal may be absent — that's a valid "no skill needed" answer (e.g. an existing
 * project skill already covers the responsibility). The confirm leaf renders a "no
 * suggestions" UI in that case rather than failing the chain.
 */
const proposeUseCase = async (
  deps: ProposeDetectSkillsLeafDeps,
  input: ProposeInput,
  abortSignal?: AbortSignal
): Promise<Result<ProposeOutput, DomainError>> => {
  const log = deps.logger.named('detect-skills.propose');
  log.info(`starting repo ${input.repository.name}`, {
    repositoryId: String(input.repository.id),
    repositoryPath: String(input.repository.path),
  });

  const paths = runPathsFor(input.runDir);
  if (!paths.ok) return Result.error(paths.error);

  const outputContractSection = renderContractSectionFor(detectSkillsOutputContract, input.runDir);
  const prompt = await buildDetectSkillsPrompt(deps.templateLoader, {
    repositoryPath: String(input.repository.path),
    skillsConvention: deps.skillsAdapter.describeSkillsConvention(),
    outputContractSection,
  });
  if (!prompt.ok) return Result.error(prompt.error);

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

  const validated = await validateSignalsFile(input.runDir, detectSkillsOutputContract);
  if (!validated.ok) {
    log.error(`signals validation failed for repo ${input.repository.name}`, {
      repositoryId: String(input.repository.id),
      error: validated.error.message,
      runDir: String(input.runDir),
    });
    return Result.error(validated.error);
  }
  const signals = validated.value;

  // Fan-out to BOTH the legacy sink and the typed event bus — matches the generator/evaluator
  // dual-emit pattern. Wave 6 of the audit collapses the two paths once every TUI consumer
  // migrates to `ai-signal` events.
  for (const sig of signals) {
    deps.signals.emit(sig);
    deps.eventBus.publish({ type: 'ai-signal', signal: sig, source: 'detect-skills' });
  }

  // Render the operator-facing sidecars (`setup-skill.md`, `verify-skill.md`) from validated
  // signals. The confirm leaf reads from in-memory signals (ctx), not these files — the
  // sidecars exist for operator review only.
  await renderSidecars(deps.writeFile, input.runDir, signals, detectSkillsOutputContract.sidecars, deps.logger);

  const { setupSkill, verifySkill } = extractProposal(signals);

  if (setupSkill === undefined && verifySkill === undefined) {
    log.warn(`AI returned no proposals for repo ${input.repository.name} — inspect run dir for prompt + raw body`, {
      repositoryId: String(input.repository.id),
      runDir: String(input.runDir),
    });
  }

  log.info(`proposal ready for repo ${input.repository.name}`, {
    repositoryId: String(input.repository.id),
    hasSetupSkill: setupSkill !== undefined,
    hasVerifySkill: verifySkill !== undefined,
    setupLength: setupSkill?.length ?? 0,
    verifyLength: verifySkill?.length ?? 0,
    runDir: String(input.runDir),
  });

  return Result.ok({
    ...(setupSkill !== undefined ? { proposedSetupSkill: setupSkill } : {}),
    ...(verifySkill !== undefined ? { proposedVerifySkill: verifySkill } : {}),
    runDir: input.runDir,
  });
};

export const proposeDetectSkillsLeaf = (deps: ProposeDetectSkillsLeafDeps): Element<DetectSkillsCtx> =>
  leaf<DetectSkillsCtx, ProposeInput, ProposeOutput>('propose', {
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
      const runDir = ctx.proposal?.runDir;
      if (runDir === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-propose',
          attemptedAction: 'propose',
          message: 'propose: ctx.proposal.runDir is undefined — allocate-run-dir must run first',
        });
      }
      return { repository: ctx.repository, runDir };
    },
    output: (ctx, out) => ({
      ...ctx,
      proposal: {
        ...(out.proposedSetupSkill !== undefined ? { proposedSetupSkill: out.proposedSetupSkill } : {}),
        ...(out.proposedVerifySkill !== undefined ? { proposedVerifySkill: out.proposedVerifySkill } : {}),
        runDir: out.runDir,
      },
    }),
  });
