import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { AiSession } from '@src/integration/ai/providers/_engine/ai-session.ts';
import type { HarnessSignalSink } from '@src/integration/ai/signals/_engine/sink.ts';
import { consumeSignals } from '@src/integration/ai/signals/_engine/consume-signals.ts';
import { withSignalsTempPath } from '@src/integration/ai/signals/_engine/temp-signals-file.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type { ReadinessState } from '@src/integration/ai/readiness/_engine/state.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { wireTagFor } from '@src/integration/ai/prompts/readiness/definition.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type {
  AgentsMdProposalSignal,
  HarnessSignal,
  SetupScriptSignal,
  VerifyScriptSignal,
} from '@src/domain/signal.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';

/** Max chars of body.txt shown inline in the missing-tag error hint before truncation. */
const BODY_PREVIEW_LIMIT = 800;

/** Lexicographic-sortable run dir name; mirrors detect-scripts / detect-skills. */
const buildRunDirName = (): string => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${stamp}-${suffix}`;
};

const readBodyPreview = async (bodyFile: AbsolutePath): Promise<string | undefined> => {
  try {
    const raw = await fs.readFile(String(bodyFile), 'utf8');
    const trimmed = raw.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed.length <= BODY_PREVIEW_LIMIT) return trimmed;
    return `${trimmed.slice(0, BODY_PREVIEW_LIMIT).trimEnd()} […truncated]`;
  } catch {
    return undefined;
  }
};

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
 * profile and supplies a closure that wraps the rendered prompt + signalsFile (+ optional
 * bodyFile for forensic capture) into the chain's per-call profile; the use case stays
 * profile-agnostic.
 */
export type BuildReadinessSessionFn = (prompt: Prompt, signalsFile: AbsolutePath, bodyFile?: AbsolutePath) => AiSession;

export interface SetupReadinessDeps {
  readonly provider: HeadlessAiProvider;
  /** Pre-bound prompt builder. The chain leaf wires this from the integration-layer builder. */
  readonly buildPrompt: BuildReadinessPromptFn;
  /** Pre-bound session builder — wraps the prompt + signalsFile into the chain's per-call profile. */
  readonly buildSession: BuildReadinessSessionFn;
  readonly signals: HarnessSignalSink;
  readonly logger: Logger;
  /**
   * `<dataRoot>/runs`. The use case materialises `<runsRoot>/readiness/<run-id>/prompt.md` and
   * (for Claude) `body.txt`. On a missing-wire-tag failure the body content is spliced into the
   * ParseError hint so the operator sees the AI's actual response without leaving the chain
   * trace. Sibling pattern to detect-scripts / detect-skills.
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
  readonly proposedContent: string;
  readonly targetPath: AbsolutePath;
  /**
   * One shell line the harness runs at sprint start to prepare the working tree (typically
   * dependency install). Undefined when the AI judges no setup is needed (the prompt allows the
   * AI to omit the `<setup-script>` tag entirely).
   */
  readonly proposedSetupScript?: string;
  /**
   * One shell line the harness runs as the post-task gate (typecheck / lint / test). Undefined
   * when the project exposes none of those — the AI omits the `<verify-script>` tag.
   */
  readonly proposedVerifyScript?: string;
}

/**
 * Set up AI readiness for one repository on one tool: build the readiness prompt, call the AI,
 * pick the tool-specific `agents-md-proposal` signal out of the file-based signals stream, plus
 * any optional `setup-script` / `verify-script` proposals, and return the proposed body + the
 * absolute target path the chain's write leaf will land on.
 *
 * Each tool sees its own wire tag in the prompt (claude-code → `<claude-md>`, copilot →
 * `<copilot-instructions>`, codex → `<agents-md>`); the shared signal parser captures whichever
 * tag the AI used and the use case asserts it matches `wireTagFor(input.tool)`.
 *
 * The use case never writes to disk (the chain owns persistence) and never edits the project
 * aggregate (also chain-owned). It is a pure "ask the AI, pick one signal" round-trip.
 *
 * Failure modes:
 *  - Prompt build error → propagated as `BuildPromptError` (Storage / Parse / Validation).
 *  - Provider error → propagated unchanged.
 *  - Response missing the tool's wire-tag signal → `ParseError(schema-mismatch)`. The AI was
 *    asked for one element only; an empty result means the prompt or the model misbehaved.
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

  const promptWrote = await writeTextAtomic(String(promptFile.value), String(prompt.value));
  if (!promptWrote.ok) return Result.error(promptWrote.error);

  return withSignalsTempPath('readiness', async (signalsFile) => {
    const signals = await consumeSignals(
      deps.provider,
      deps.buildSession(prompt.value, signalsFile, bodyFile.value),
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

    const expectedTag = wireTagFor(input.tool);
    const proposal = signals.value.find(
      (s: HarnessSignal): s is AgentsMdProposalSignal => s.type === 'agents-md-proposal' && s.tag === expectedTag
    );
    if (proposal === undefined) {
      // Surface the AI's actual response inline — when the wire tag is missing the operator
      // most needs to see what the model said (often a permission ask, sometimes a markdown-
      // fence slip). Run dir is also referenced so they can `cat body.txt` for the full body.
      const bodyPreview = await readBodyPreview(bodyFile.value);
      log.warn(`readiness: AI response missing <${expectedTag}> tag — inspect run dir for raw body`, {
        repositoryId: String(input.repository.id),
        runDir: String(runDir.value),
      });
      const hintLines: string[] = [
        `the prompt asks for exactly one <${expectedTag}> tag with no surrounding markdown fence; ` +
          `signals.json carried ${String(signals.value.length)} entries, none matching that tag`,
        `run artifacts: ${String(runDir.value)}`,
      ];
      if (bodyPreview !== undefined) {
        hintLines.push('', 'AI response:', bodyPreview);
      }
      return Result.error(
        new ParseError({
          subCode: 'schema-mismatch',
          message: `readiness: AI response missing <${expectedTag}>…</${expectedTag}> block`,
          hint: hintLines.join('\n'),
        })
      );
    }

    const setupScript = signals.value.find(
      (s: HarnessSignal): s is SetupScriptSignal => s.type === 'setup-script'
    )?.command;
    const verifyScript = signals.value.find(
      (s: HarnessSignal): s is VerifyScriptSignal => s.type === 'verify-script'
    )?.command;

    const targetPath = AbsolutePath.parse(join(String(input.repository.path), targetPathFor(input.tool)));
    if (!targetPath.ok) return Result.error(targetPath.error);

    log.info(`proposal ready for repo ${input.repository.name}`, {
      repositoryId: String(input.repository.id),
      bodyLength: proposal.content.length,
      targetPath: String(targetPath.value),
      hasSetupScript: setupScript !== undefined,
      hasVerifyScript: verifyScript !== undefined,
      runDir: String(runDir.value),
    });

    return Result.ok({
      proposedContent: proposal.content,
      targetPath: targetPath.value,
      ...(setupScript !== undefined ? { proposedSetupScript: setupScript } : {}),
      ...(verifyScript !== undefined ? { proposedVerifyScript: verifyScript } : {}),
    });
  });
};
