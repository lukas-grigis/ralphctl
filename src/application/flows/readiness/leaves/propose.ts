import { promises as fs } from 'node:fs';
import { type Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HarnessSignalSink } from '@src/integration/ai/signals/_engine/sink.ts';
import type { ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import { isPresent } from '@src/integration/ai/readiness/_engine/predicates.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { READ_ONLY } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { setupReadinessUseCase } from '@src/integration/ai/readiness/_engine/setup.ts';
import { buildReadinessPrompt } from '@src/integration/ai/prompts/readiness/definition.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import type { ReadinessCtx } from '@src/application/flows/readiness/ctx.ts';

/** Per-call AiSession profile for the readiness chain: read-only — write is a separate leaf. */
export const readinessSession = (
  cwd: AbsolutePath,
  prompt: Prompt,
  model: string,
  signalsFile: AbsolutePath,
  bodyFile?: AbsolutePath
): AiSession => ({
  prompt,
  cwd,
  model,
  permissions: READ_ONLY,
  signalsFile,
  ...(bodyFile !== undefined ? { bodyFile } : {}),
});

export interface ProposeReadinessLeafDeps {
  readonly provider: HeadlessAiProvider;
  readonly templateLoader: TemplateLoader;
  readonly signals: HarnessSignalSink;
  readonly logger: Logger;
  readonly cwd: AbsolutePath;
  readonly model: string;
  /** `<dataRoot>/runs`; forwarded into the engine for artifact persistence. */
  readonly runsRoot: AbsolutePath;
}

interface ProposeReadinessInput {
  readonly repository: Repository;
  readonly tool: AssistantTool;
  readonly probedState: ReadinessState;
}

interface ProposeReadinessOutput {
  readonly proposedContent: string;
  readonly targetPath: AbsolutePath;
  readonly proposedSetupScript?: string;
  readonly proposedVerifyScript?: string;
}

/**
 * Build the readiness prompt, call the AI, parse `<agents-md>` from the response. Reads the
 * existing context file body (if `probedState === 'present'` and the artifact catalog exposes
 * one) so the use case can pass it to the prompt builder — the template's "preserve verbatim"
 * rule keys off non-empty `EXISTING_CONTEXT_FILE`.
 *
 * File-read errors degrade gracefully: if the existing artifact is unreadable we fall back to
 * "no existing file" rather than failing the chain. Readiness setup is best-effort; a permission
 * error on a stale `CLAUDE.md` shouldn't block the user.
 */
const proposeReadinessUseCase = async (
  deps: ProposeReadinessLeafDeps,
  input: ProposeReadinessInput
): Promise<Result<ProposeReadinessOutput, DomainError>> => {
  const existingPath = pickExistingContextPath(input.tool, input.probedState);
  let existingBody: string | undefined;
  if (existingPath !== undefined) {
    try {
      existingBody = await fs.readFile(existingPath, 'utf8');
    } catch {
      existingBody = undefined;
    }
  }

  return setupReadinessUseCase(
    {
      provider: deps.provider,
      buildPrompt: (params) => buildReadinessPrompt(deps.templateLoader, params),
      buildSession: (prompt, signalsFile, bodyFile) =>
        readinessSession(deps.cwd, prompt, deps.model, signalsFile, bodyFile),
      signals: deps.signals,
      logger: deps.logger,
      runsRoot: deps.runsRoot,
    },
    {
      repository: input.repository,
      tool: input.tool,
      probedState: input.probedState,
      ...(existingBody !== undefined ? { existingContextFile: existingBody } : {}),
    }
  );
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

export const proposeReadinessLeaf = (deps: ProposeReadinessLeafDeps): Element<ReadinessCtx> =>
  leaf<ReadinessCtx, ProposeReadinessInput, ProposeReadinessOutput>('propose', {
    useCase: {
      execute: async (input) => proposeReadinessUseCase(deps, input),
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
      if (ctx.tool === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-propose',
          attemptedAction: 'propose',
          message: 'propose: ctx.tool is undefined — pick-tool must run first',
        });
      }
      if (ctx.probedState === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-propose',
          attemptedAction: 'propose',
          message: 'propose: ctx.probedState is undefined — probe must run first',
        });
      }
      return { repository: ctx.repository, tool: ctx.tool, probedState: ctx.probedState };
    },
    output: (ctx, out) => ({
      ...ctx,
      proposal: {
        proposedContent: out.proposedContent,
        targetPath: out.targetPath,
        ...(out.proposedSetupScript !== undefined ? { proposedSetupScript: out.proposedSetupScript } : {}),
        ...(out.proposedVerifyScript !== undefined ? { proposedVerifyScript: out.proposedVerifyScript } : {}),
      },
    }),
  });
