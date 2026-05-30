import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { RunInTerminal } from '@src/integration/io/run-in-terminal.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { buildDistillLearningsPrompt } from '@src/integration/ai/prompts/distill-learnings/definition.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import { targetPathFor } from '@src/integration/ai/readiness/_engine/setup.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import type { DistillLearningsCtx } from '@src/application/flows/_shared/memory/distill-ctx.ts';

export interface DistillProposeLeafDeps {
  readonly interactiveAi: InteractiveAiProvider;
  readonly runInTerminal: RunInTerminal;
  readonly templateLoader: TemplateLoader;
  readonly logger: Logger;
  readonly model: string;
  /** Optional reasoning / effort level forwarded into the AI session. */
  readonly effort?: string;
  /**
   * Per-provider sandbox root under which the rendered prompt + the AI's output file round-trip
   * (`<distillRoot>/<tool>/prompt.md`, `<distillRoot>/<tool>/context-file.out`). Mounted as an
   * `--add-dir` root so the AI can write its output even though `cwd` is the repo.
   */
  readonly distillRoot: AbsolutePath;
}

interface DistillProposeInput {
  readonly repository: Repository;
  readonly candidates: readonly LearningRecord[];
}

interface DistillProposeOutput {
  readonly proposedContent: string;
  readonly targetPath: AbsolutePath;
}

/**
 * Distill-OWNED propose leaf — scoped to one {@link AssistantTool} per instance. The distill
 * prompt is a one-shot full-file documentation edit (no signals.json): the AI reads the existing
 * native context file plus the curated candidate learnings and writes the COMPLETE updated file
 * to `outputFile`. The leaf reads that file back verbatim — the whole body IS the proposal.
 *
 * Mirrors the `InteractiveAiProvider` round-trip (prompt-file in, output-file out) used by plan /
 * refine, NOT the readiness propose leaf — this is intentional: the distill sub-chain
 * owns its own leaves; the readiness surface stays untouched.
 *
 * Failure modes (each leaves disk state untouched downstream — confirm/write follow):
 *  - prompt build error → propagated.
 *  - AI exited non-zero → propagated (typically `InvalidStateError`).
 *  - output file unreadable → `InvalidStateError`.
 *
 * `AbortError` from the AI session forwards verbatim — the sequential sub-chain then skips confirm
 * / write / stamp, so the ledger stays un-stamped.
 */
const distillProposeUseCase = async (
  deps: DistillProposeLeafDeps,
  tool: AssistantTool,
  input: DistillProposeInput
): Promise<Result<DistillProposeOutput, DomainError>> => {
  const log = deps.logger.named(`memory.distill-propose-${tool}`);
  const targetFilename = targetPathFor(tool);

  const targetPathResult = AbsolutePath.parse(join(String(input.repository.path), targetFilename));
  if (!targetPathResult.ok) return Result.error(targetPathResult.error);
  const targetPath = targetPathResult.value;

  // Read the existing context file (if any) so the AI folds the learnings into its current
  // `## Learnings (ralphctl)` section idempotently. Absent / unreadable → "no existing file".
  const existingContextFile = (await safeReadText(String(targetPath))) ?? 'No existing file — create one.';

  const prompt = await buildDistillLearningsPrompt(deps.templateLoader, {
    existingContextFile,
    candidateLearnings: renderCandidateList(input.candidates),
    targetFilename,
    projectTooling: renderProjectTooling(input.repository),
  });
  if (!prompt.ok) return Result.error(prompt.error);

  const toolDir = join(String(deps.distillRoot), tool);
  try {
    await fs.mkdir(toolDir, { recursive: true });
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `distill-propose-${tool}: cannot create sandbox dir ${toolDir}`,
        path: toolDir,
        cause,
      })
    );
  }
  const promptFileResult = AbsolutePath.parse(join(toolDir, 'prompt.md'));
  if (!promptFileResult.ok) return Result.error(promptFileResult.error);
  const outputFileResult = AbsolutePath.parse(join(toolDir, 'context-file.out'));
  if (!outputFileResult.ok) return Result.error(outputFileResult.error);

  const promptWrote = await writeTextAtomic(String(promptFileResult.value), String(prompt.value));
  if (!promptWrote.ok) return Result.error(promptWrote.error);

  // cwd = the repo so the AI auto-discovers the project's own context-file conventions; the
  // sandbox dir is mounted via `additionalRoots` so the prompt / output round-trip lands in a
  // harness-controlled location.
  const session = await deps.runInTerminal(async () =>
    deps.interactiveAi.run({
      cwd: input.repository.path,
      additionalRoots: [deps.distillRoot],
      promptFile: promptFileResult.value,
      outputFile: outputFileResult.value,
      model: deps.model,
      ...(deps.effort !== undefined ? { effort: deps.effort } : {}),
    })
  );
  if (!session.ok) return Result.error(session.error);

  const proposedContent = await safeReadText(String(outputFileResult.value));
  if (proposedContent === undefined) {
    return Result.error(
      new InvalidStateError({
        entity: 'distill',
        currentState: 'post-spawn',
        attemptedAction: 'read-output',
        message: `distill-propose-${tool}: AI exited cleanly but wrote no output file at ${String(outputFileResult.value)}`,
      })
    );
  }

  log.info(`distilled context proposal ready for ${tool}`, {
    targetPath: String(targetPath),
    bytes: proposedContent.length,
  });
  return Result.ok({ proposedContent, targetPath });
};

/**
 * Render the curated learnings as a markdown bullet list — one `<learning>` body per line. The
 * distill prompt's `CANDIDATE_LEARNINGS` placeholder requires a non-empty value; the load gate
 * upstream guarantees at least one candidate before this leaf runs.
 */
const renderCandidateList = (candidates: readonly LearningRecord[]): string =>
  candidates.map((c) => `- ${c.text}`).join('\n');

/**
 * Project the repository's known tooling into the prompt's `PROJECT_TOOLING` section — the only
 * place a package-manager command may appear. Falls back to an explicit "(none detected)" line so
 * the prompt copy never hardcodes an ecosystem's commands.
 */
const renderProjectTooling = (repository: Repository): string => {
  const lines: string[] = [];
  if (repository.setupScript !== undefined) lines.push(`- Setup: ${repository.setupScript}`);
  if (repository.verifyScript !== undefined) lines.push(`- Verify: ${repository.verifyScript}`);
  return lines.length > 0 ? lines.join('\n') : '(none detected)';
};

const safeReadText = async (path: string): Promise<string | undefined> => {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * Build the distill-owned propose leaf for one tool. Reads the loaded candidates + repository from
 * the distill-local ctx, spawns the AI, projects the full-file proposal onto the per-tool entry.
 *
 * @public
 */
export const distillProposeLeaf = (deps: DistillProposeLeafDeps, tool: AssistantTool): Element<DistillLearningsCtx> =>
  leaf<DistillLearningsCtx, DistillProposeInput, DistillProposeOutput>(`distill-propose-${tool}`, {
    useCase: {
      execute: async (input) => distillProposeUseCase(deps, tool, input),
    },
    input: (ctx) => {
      if (ctx.candidates === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-distill-propose',
          attemptedAction: 'distill-propose',
          message: `distill-propose-${tool}: ctx.candidates is undefined — load-learnings must run first`,
        });
      }
      return { repository: ctx.repository, candidates: ctx.candidates };
    },
    output: (ctx, out) => ({
      ...ctx,
      entries: {
        ...ctx.entries,
        [tool]: { ...ctx.entries[tool], proposedContent: out.proposedContent, targetPath: out.targetPath },
      },
    }),
  });
