import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import { buildRunDirName } from '@src/integration/ai/runs/_engine/run-artifacts.ts';
import type { ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';

/**
 * Per-tool target path for the readiness artefact, relative to the repo root. Centralised so
 * the chain leaf, the CLI's "where will it write?" preview, and any doctor command agree on the
 * convention.
 *
 *  - `claude-code`  → `CLAUDE.md` (Claude's project memory).
 *  - `copilot`      → `.github/copilot-instructions.md` (Copilot's canonical instructions file).
 *  - `codex`        → `AGENTS.md` (cross-tool spec; Codex reads it when present).
 */
export const targetPathFor = (tool: AssistantTool): string => {
  switch (tool) {
    case 'claude-code':
      return 'CLAUDE.md';
    case 'copilot':
      return '.github/copilot-instructions.md';
    case 'codex':
      return 'AGENTS.md';
  }
};

/**
 * Function-injection contract for the prompt builder. The chain leaf supplies a closure that
 * pre-binds the integration-layer template loader; the use case itself never imports from
 * `integration/` — the layer dependency rule (business may not depend on integration) keeps
 * the seam clean.
 */
export type BuildReadinessPromptFn = (input: {
  readonly repositoryPath: string;
  readonly currentTool: AssistantTool;
  readonly probedState: ReadinessState;
  readonly existingContextFile?: string;
}) => Promise<Result<Prompt, DomainError>>;

/**
 * Function-injection contract for the AiSession builder. The chain leaf owns the per-call
 * profile and supplies a closure that wraps the rendered prompt + per-run paths
 * (`signalsFile`, optional `bodyFile` for forensic capture, `outputDir` for audit-[09]
 * contract validation) into the chain's per-call profile; the use case stays
 * profile-agnostic.
 */
export type BuildReadinessSessionFn = (
  prompt: Prompt,
  signalsFile: AbsolutePath,
  bodyFile: AbsolutePath | undefined,
  outputDir: AbsolutePath
) => AiSession;

export interface SetupReadinessDeps {
  readonly provider: HeadlessAiProvider;
  /** Pre-bound prompt builder. The chain leaf wires this from the integration-layer builder. */
  readonly buildPrompt: BuildReadinessPromptFn;
  /** Pre-bound session builder — wraps the prompt + signalsFile into the chain's per-call profile. */
  readonly buildSession: BuildReadinessSessionFn;
  readonly logger: Logger;
  /**
   * `<dataRoot>/runs`. The use case materialises `<runsRoot>/readiness/<run-id>/prompt.md` and
   * (for Claude) `body.txt`. Under audit-[09] the AI writes `signals.json` here directly; the
   * calling leaf validates it post-spawn.
   */
  readonly runsRoot: AbsolutePath;
}

export interface SetupReadinessInput {
  readonly repository: Repository;
  readonly tool: AssistantTool;
  readonly probedState: ReadinessState;
  /**
   * Existing context file body, when one was found. Threaded by the chain leaf via the
   * filesystem after the probe runs; we accept it here as a string so the use case stays free
   * of file I/O.
   */
  readonly existingContextFile?: string;
}

export interface SetupReadinessOutput {
  /**
   * Per-run forensic directory (`<runsRoot>/readiness/<run-id>/`) — the audit-[09]
   * `outputDir` the AI was told to write `signals.json` into. The calling leaf validates
   * `<runDir>/signals.json` against the readiness contract and renders harness-owned
   * sidecars in the same directory.
   */
  readonly runDir: AbsolutePath;
  /**
   * Absolute path the harness will land the validated `agents-md-proposal` body at — derived
   * from the active tool (`CLAUDE.md` / `.github/copilot-instructions.md` / `AGENTS.md`).
   * The leaf reads the body from the validated signal in ctx, not from this path.
   */
  readonly targetPath: AbsolutePath;
}

/**
 * Set up AI readiness for one repository on one tool — audit-[09] thin wrapper around the
 * provider call: build the readiness prompt, materialise the per-run forensic directory,
 * spawn the AI with `outputDir = <runDir>` so it writes `signals.json` there directly. The
 * calling leaf validates the file against the readiness contract and projects the validated
 * signals onto ctx.
 *
 * The use case never writes to disk other than the prompt artefact (the chain owns
 * persistence) and never edits the project aggregate (also chain-owned).
 *
 * Failure modes:
 *  - Prompt build error → propagated as `BuildPromptError` (Storage / Parse / Validation).
 *  - Provider error → propagated unchanged.
 *  - Repo path → AbsolutePath conversion failure → `ValidationError` from `AbsolutePath.parse`.
 */
export const setupReadinessUseCase = async (
  deps: SetupReadinessDeps,
  input: SetupReadinessInput
): Promise<Result<SetupReadinessOutput, DomainError>> => {
  const log = deps.logger.named('readiness.setup');
  log.info(`starting repo ${input.repository.name} for ${input.tool}`, {
    repositoryId: String(input.repository.id),
    tool: input.tool,
    state: input.probedState.kind,
  });

  const prompt = await deps.buildPrompt({
    repositoryPath: String(input.repository.path),
    currentTool: input.tool,
    probedState: input.probedState,
    ...(input.existingContextFile !== undefined ? { existingContextFile: input.existingContextFile } : {}),
  });
  if (!prompt.ok) return Result.error(prompt.error);

  const runDir = AbsolutePath.parse(join(String(deps.runsRoot), 'readiness', buildRunDirName()));
  if (!runDir.ok) return Result.error(runDir.error);
  const promptFile = AbsolutePath.parse(join(String(runDir.value), 'prompt.md'));
  if (!promptFile.ok) return Result.error(promptFile.error);
  const bodyFile = AbsolutePath.parse(join(String(runDir.value), 'body.txt'));
  if (!bodyFile.ok) return Result.error(bodyFile.error);
  // Under audit-[09] the AI writes `signals.json` into `outputDir`. `signalsFile` is still on
  // the session shape; we wire it to the same path so the file lands at `<runDir>/signals.json`.
  const signalsFile = AbsolutePath.parse(join(String(runDir.value), 'signals.json'));
  if (!signalsFile.ok) return Result.error(signalsFile.error);

  const promptWrote = await writeTextAtomic(String(promptFile.value), String(prompt.value));
  if (!promptWrote.ok) return Result.error(promptWrote.error);

  const session = deps.buildSession(prompt.value, signalsFile.value, bodyFile.value, runDir.value);
  const spawned = await deps.provider.generate(session);
  if (!spawned.ok) {
    log.error(`provider failed for repo ${input.repository.name}`, {
      repositoryId: String(input.repository.id),
      error: spawned.error.message,
      runDir: String(runDir.value),
    });
    return Result.error(spawned.error);
  }

  const targetPath = AbsolutePath.parse(join(String(input.repository.path), targetPathFor(input.tool)));
  if (!targetPath.ok) return Result.error(targetPath.error);

  log.info(`provider spawn complete for repo ${input.repository.name}`, {
    repositoryId: String(input.repository.id),
    targetPath: String(targetPath.value),
    runDir: String(runDir.value),
  });

  return Result.ok({ runDir: runDir.value, targetPath: targetPath.value });
};
