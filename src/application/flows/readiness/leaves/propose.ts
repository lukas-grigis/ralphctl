import { promises as fs } from 'node:fs';
import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import { isPresent } from '@src/integration/ai/readiness/_engine/predicates.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { setupReadinessUseCase } from '@src/integration/ai/readiness/_engine/setup.ts';
import { buildReadinessPrompt } from '@src/integration/ai/prompts/readiness/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { renderSidecars } from '@src/integration/ai/contract/_engine/render-sidecars.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';
import { readinessOutputContract } from '@src/application/flows/readiness/leaves/readiness.contract.ts';

/**
 * Per-call AiSession profile for the readiness chain — audit-[09] aware: the AI's permission
 * profile remains READ_ONLY for repository navigation, augmented with the Write tool so the
 * AI can write `signals.json` into `outputDir`. `outputDir` is the per-run forensic dir; the
 * harness validates `<outputDir>/signals.json` post-spawn.
 */
export const readinessSession = (
  cwd: AbsolutePath,
  prompt: Prompt,
  model: string,
  signalsFile: AbsolutePath,
  bodyFile: AbsolutePath | undefined,
  outputDir: AbsolutePath,
  effort?: string
): AiSession => ({
  prompt,
  cwd,
  model,
  permissions: READ_ONLY,
  signalsFile,
  outputDir,
  ...(bodyFile !== undefined ? { bodyFile } : {}),
  ...(effort !== undefined ? { effort } : {}),
});

export interface ProposeReadinessLeafDeps {
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  /**
   * Output port used to write any harness-owned sidecars (`agents-md-proposal.md`,
   * `setup-skill.md`, `verify-skill.md`) post-spawn under audit-[09]. The AI itself writes
   * `signals.json` directly into `outputDir`; the leaf only validates that file and
   * renders sidecars from the validated signals.
   */
  readonly writeFile: WriteFile;
  /**
   * Application bus — every validated `agents-md-proposal` / `setup-skill-proposal` /
   * `verify-skill-proposal` / `learning` / `note` / `skill-suggestions` signal fans out as a
   * typed `ai-signal` event the TUI subscribes to.
   */
  readonly eventBus: EventBus;
  readonly logger: Logger;
  readonly cwd: AbsolutePath;
  readonly model: string;
  /** Optional reasoning / effort level forwarded into the AiSession. */
  readonly effort?: string;
}

interface ProposeReadinessInput {
  readonly repository: Repository;
  readonly probedState: ReadinessState;
  /**
   * Pre-allocated per-run forensic directory — `<runsRoot>/readiness/<run-id>/`. Resolved
   * upstream by the chain's `allocate-run-dir-<tool>` leaf so the per-spawn `meta.json`
   * sidecar (written by the chain's `stamp-session-meta` leaf BEFORE this propose leaf
   * spawns the AI) lands beside the AI-written `signals.json`.
   */
  readonly runDir: AbsolutePath;
}

interface ProposeReadinessOutput {
  readonly proposedContent: string;
  readonly targetPath: AbsolutePath;
  /**
   * Verbatim body the AI proposed as the project's setup skill. Populated when the AI emits a
   * `setup-skill-proposal` signal (multi-paragraph markdown). The post-readiness install leaf
   * copies this body into `<repo>/<parentDir>/skills/setup/SKILL.md` after operator approval.
   */
  readonly proposedSetupSkillBody?: string;
  /**
   * Same shape as {@link proposedSetupSkillBody} but for verify. The install leaf lands it at
   * `<repo>/<parentDir>/skills/verify/SKILL.md`.
   */
  readonly proposedVerifySkillBody?: string;
}

/**
 * Build the readiness prompt, call the AI, validate the audit-[09] `signals.json` it wrote
 * into the per-run dir, fan validated signals out to the bus, render harness-owned
 * sidecars, then project the proposal bodies onto ctx for downstream leaves.
 *
 * Reads the existing context file body (if `probedState === 'present'` and the artifact
 * catalog exposes one) so the use case can pass it to the prompt builder — the template's
 * "preserve verbatim" rule keys off non-empty `EXISTING_CONTEXT_FILE`.
 *
 * File-read errors degrade gracefully: if the existing artifact is unreadable we fall back to
 * "no existing file" rather than failing the chain. Readiness setup is best-effort; a permission
 * error on a stale `CLAUDE.md` shouldn't block the user.
 */
const proposeReadinessUseCase = async (
  deps: ProposeReadinessLeafDeps,
  tool: AssistantTool,
  input: ProposeReadinessInput
): Promise<Result<ProposeReadinessOutput, DomainError>> => {
  const existingPath = pickExistingContextPath(tool, input.probedState);
  let existingBody: string | undefined;
  if (existingPath !== undefined) {
    try {
      existingBody = await fs.readFile(existingPath, 'utf8');
    } catch {
      existingBody = undefined;
    }
  }

  const engineResult = await setupReadinessUseCase(
    {
      provider: deps.provider,
      buildPrompt: (params) =>
        buildReadinessPrompt(deps.templateLoader, {
          ...params,
          outputContractSection: renderContractSectionFor(readinessOutputContract, params.outputDir),
        }),
      buildSession: (prompt, signalsFile, bodyFile, outputDir) =>
        readinessSession(deps.cwd, prompt, deps.model, signalsFile, bodyFile, outputDir, deps.effort),
      logger: deps.logger,
    },
    {
      repository: input.repository,
      tool,
      probedState: input.probedState,
      runDir: input.runDir,
      ...(existingBody !== undefined ? { existingContextFile: existingBody } : {}),
    }
  );
  if (!engineResult.ok) return Result.error(engineResult.error);
  const engineOut = engineResult.value;

  // audit-[09]: the AI wrote `signals.json` into the per-run dir directly. Validate against
  // the readiness contract (signals-missing / invalid-json / schema-mismatch surface as
  // domain errors with precise hints).
  const validated = await validateSignalsFile(engineOut.runDir, readinessOutputContract);
  if (!validated.ok) return Result.error(validated.error);
  const signals = validated.value;

  // Find the proposal body the harness will write to the tool's native context file.
  const proposal = signals.find((s) => s.type === 'agents-md-proposal');
  if (proposal === undefined) {
    return Result.error(
      new InvalidStateError({
        entity: 'readiness',
        currentState: 'post-validation',
        attemptedAction: 'project-signal',
        message: 'readiness: validated signals contained no agents-md-proposal signal',
      })
    );
  }

  // Fan out every validated signal to the application bus so the TUI's `ai-signal`
  // subscribers render live updates. Source tag identifies the leaf for multi-leaf traces.
  for (const sig of signals) {
    deps.eventBus.publish({ type: 'ai-signal', signal: sig, source: 'readiness' });
  }

  // Render harness-owned sidecars (`agents-md-proposal.md` / `setup-skill.md` /
  // `verify-skill.md`) for the kinds the AI actually emitted. Write failures log warn inside
  // `renderSidecars`; the helper always returns `Result.ok` (sidecars are operator UX only —
  // downstream consumers read signals from ctx, never from the rendered files).
  await renderSidecars(deps.writeFile, engineOut.runDir, signals, readinessOutputContract.sidecars, deps.logger);

  // Project the validated skill-proposal bodies onto ctx so the post-readiness install leaf
  // can copy them into the active provider's `<parentDir>/skills/` layout via the bare-name
  // path on the skills adapter.
  const setupSkill = signals.find((s) => s.type === 'setup-skill-proposal');
  const verifySkill = signals.find((s) => s.type === 'verify-skill-proposal');

  return Result.ok({
    proposedContent: proposal.content,
    targetPath: engineOut.targetPath,
    ...(setupSkill !== undefined ? { proposedSetupSkillBody: setupSkill.content } : {}),
    ...(verifySkill !== undefined ? { proposedVerifySkillBody: verifySkill.content } : {}),
  });
};

/**
 * Return the absolute path of the tool-native context file when the probe surfaced one.
 *  - claude-code → `claudeMd` (preferred) or `agentsMd`.
 *  - copilot     → `copilotInstructions`.
 *  - codex       → `agentsMd`.
 */
const pickExistingContextPath = (tool: AssistantTool, state: ReadinessState): string | undefined => {
  if (!isPresent(state)) return undefined;
  const a = state.artifacts;
  if (tool === 'claude-code' && a.tool === 'claude-code') {
    if (a.claudeMd !== undefined) return String(a.claudeMd.path);
    if (a.agentsMd !== undefined) return String(a.agentsMd.path);
    return undefined;
  }
  if (tool === 'copilot' && a.tool === 'copilot') {
    return a.copilotInstructions !== undefined ? String(a.copilotInstructions.path) : undefined;
  }
  if (tool === 'codex' && a.tool === 'codex') {
    return a.agentsMd !== undefined ? String(a.agentsMd.path) : undefined;
  }
  return undefined;
};

export const proposeReadinessLeaf = (deps: ProposeReadinessLeafDeps, tool: AssistantTool): Element<ReadinessCtx> =>
  leaf<ReadinessCtx, ProposeReadinessInput, ProposeReadinessOutput>(`propose-${tool}`, {
    useCase: {
      execute: async (input) => proposeReadinessUseCase(deps, tool, input),
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
      const entry = ctx.entries[tool];
      if (entry?.probedState === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-propose',
          attemptedAction: 'propose',
          message: `propose: ctx.entries[${tool}].probedState is undefined — probe must run first`,
        });
      }
      if (entry.runDir === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-propose',
          attemptedAction: 'propose',
          message: `propose: ctx.entries[${tool}].runDir is undefined — allocate-run-dir must run first`,
        });
      }
      return { repository: ctx.repository, probedState: entry.probedState, runDir: entry.runDir };
    },
    output: (ctx, out) => ({
      ...ctx,
      entries: {
        ...ctx.entries,
        [tool]: {
          ...ctx.entries[tool],
          proposal: {
            proposedContent: out.proposedContent,
            targetPath: out.targetPath,
            ...(out.proposedSetupSkillBody !== undefined ? { proposedSetupSkillBody: out.proposedSetupSkillBody } : {}),
            ...(out.proposedVerifySkillBody !== undefined
              ? { proposedVerifySkillBody: out.proposedVerifySkillBody }
              : {}),
          },
        },
      },
    }),
  });
