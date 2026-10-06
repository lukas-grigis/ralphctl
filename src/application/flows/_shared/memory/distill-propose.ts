import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
import type { RunInTerminal } from '@src/integration/io/run-in-terminal.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { renderProjectToolingSection } from '@src/integration/ai/prompts/_engine/renderers/task.ts';
import {
  buildDistillLearningsPrompt,
  DEFAULT_LEARNINGS_SECTION_HEADING,
} from '@src/integration/ai/prompts/distill-learnings/definition.ts';
import type { AssistantTool } from '@src/integration/ai/readiness/_engine/tool.ts';
import { targetPathFor } from '@src/integration/ai/readiness/_engine/setup.ts';
import { hasOwnedSection, spliceOwnedSection } from '@src/business/context-file/splice-section.ts';
import { isNodeErrnoCode, writeTextAtomic } from '@src/integration/io/fs.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import type { Repository } from '@src/domain/entity/repository.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { assertCtxField } from '@src/application/flows/_shared/_engine/assert-ctx-field.ts';
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
 * prompt is a one-shot documentation edit (no signals.json): the AI reads the existing native
 * context file plus the curated candidate learnings and writes ONLY the reconciled body of the
 * owned learnings section to `outputFile`. The leaf reads that delta back and splices it into the
 * existing file in code ({@link spliceOwnedSection}) — everything outside the owned section is
 * preserved byte-for-byte, and the spliced full file is the proposal the confirm gate shows.
 *
 * Mirrors the `InteractiveAiProvider` round-trip (prompt-file in, output-file out) used by plan /
 * refine, NOT the readiness propose leaf — this is intentional: the distill sub-chain
 * owns its own leaves; the readiness surface stays untouched.
 *
 * Failure modes (each leaves disk state untouched downstream — confirm/write follow):
 *  - prompt build error → propagated.
 *  - AI exited non-zero → propagated (typically `InvalidStateError`).
 *  - output file unreadable → `InvalidStateError`.
 *  - delta unusable (own H1/H2 heading, duplicate owned headings in the file, or empty while an
 *    owned section exists) → `ValidationError`; nothing is proposed, so nothing is written.
 *  - empty delta with no owned section yet → no-op: the existing file comes back unchanged.
 *
 * `AbortError` from the AI session forwards verbatim — the sequential sub-chain then skips confirm
 * / write / stamp, so the ledger stays un-stamped.
 */
const distillProposeUseCase = async (
  deps: DistillProposeLeafDeps,
  tool: AssistantTool,
  input: DistillProposeInput,
  signal?: AbortSignal
): Promise<Result<DistillProposeOutput, DomainError>> => {
  const log = deps.logger.named(`memory.distill-propose-${tool}`);
  const targetFilename = targetPathFor(tool);

  const targetPathResult = AbsolutePath.parse(join(String(input.repository.path), targetFilename));
  if (!targetPathResult.ok) return Result.error(targetPathResult.error);
  const targetPath = targetPathResult.value;

  // Read the existing context file (if any) so the AI folds the learnings into its current
  // `## Learnings (ralphctl)` section idempotently. Absent / unreadable → empty string.
  const existingRead = await readExisting(String(targetPath));
  if (!existingRead.ok) return Result.error(existingRead.error);
  const existingContextFile = existingRead.value;

  const toolDir = join(String(deps.distillRoot), tool);
  const outputFileResult = AbsolutePath.parse(join(toolDir, 'context-file.out'));
  if (!outputFileResult.ok) return Result.error(outputFileResult.error);

  const prompt = await buildDistillLearningsPrompt(deps.templateLoader, {
    existingContextFile,
    candidateLearnings: renderCandidateList(input.candidates),
    targetFilename,
    outputFile: String(outputFileResult.value),
    projectTooling: renderProjectTooling(input.repository),
    learningsSectionHeading: DEFAULT_LEARNINGS_SECTION_HEADING,
  });
  if (!prompt.ok) return Result.error(prompt.error);

  const prepared = await prepareSandbox(toolDir, String(outputFileResult.value), tool);
  if (!prepared.ok) return Result.error(prepared.error);
  const promptFileResult = AbsolutePath.parse(join(toolDir, 'prompt.md'));
  if (!promptFileResult.ok) return Result.error(promptFileResult.error);

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
      // Thread the leaf's abort signal so a TUI cancel tears the stdio-inherit child down
      // (attachAbortKill) rather than leaving it running — and the adapter classifies the
      // resulting non-zero exit as AbortError, not InvalidStateError.
      ...(signal !== undefined ? { abortSignal: signal } : {}),
    })
  );
  if (!session.ok) return Result.error(session.error);

  const sectionBody = await safeReadText(String(outputFileResult.value));
  if (sectionBody === undefined) {
    return Result.error(
      new InvalidStateError({
        entity: 'distill',
        currentState: 'post-spawn',
        attemptedAction: 'read-output',
        message: `distill-propose-${tool}: AI exited cleanly but wrote no output file at ${String(outputFileResult.value)}`,
      })
    );
  }

  // Nothing to fold in and no owned section to wipe: leave the file as it is rather than fail the run.
  if (sectionBody.trim() === '' && !hasOwnedSection(existingContextFile, DEFAULT_LEARNINGS_SECTION_HEADING)) {
    log.info(`distill-propose-${tool}: AI proposed no learnings to add; leaving ${String(targetPath)} unchanged`);
    return Result.ok({ proposedContent: existingContextFile, targetPath });
  }

  const spliced = spliceOwnedSection(existingContextFile, DEFAULT_LEARNINGS_SECTION_HEADING, sectionBody);
  if (!spliced.ok) return Result.error(spliced.error);
  const proposedContent = spliced.value;

  log.info(`distilled context proposal ready for ${tool}`, {
    targetPath: String(targetPath),
    bytes: proposedContent.length,
  });
  return Result.ok({ proposedContent, targetPath });
};

/**
 * Create the per-tool sandbox dir and clear any previous output file. The dir outlives a run (it
 * sits under the sprint dir), so without the clear a second distill whose AI exits cleanly without
 * writing would read the earlier session's delta back and splice it in as this session's answer —
 * it must surface as "wrote no output file" instead.
 */
const prepareSandbox = async (
  toolDir: string,
  outputFile: string,
  tool: AssistantTool
): Promise<Result<void, StorageError>> => {
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
  try {
    await fs.rm(outputFile, { force: true });
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `distill-propose-${tool}: cannot clear stale output ${outputFile}`,
        path: outputFile,
        cause,
      })
    );
  }
  return Result.ok(undefined);
};

/**
 * Render the curated learnings as a markdown bullet list — one `<learning>` body per bullet, with
 * `Context` / `Applies to` sub-bullets when the record carries them. The
 * distill prompt's `CANDIDATE_LEARNINGS` placeholder requires a non-empty value; the load gate
 * upstream guarantees at least one candidate before this leaf runs.
 */
const renderCandidateList = (candidates: readonly LearningRecord[]): string =>
  candidates
    .map((c) =>
      [
        `- ${c.text}`,
        ...(c.context !== undefined && c.context !== '' ? [`  - Context: ${c.context}`] : []),
        ...(c.appliesTo !== undefined && c.appliesTo !== '' ? [`  - Applies to: ${c.appliesTo}`] : []),
      ].join('\n')
    )
    .join('\n');

/**
 * Project the repository's known tooling into the prompt's `PROJECT_TOOLING` section — the only
 * place a package-manager command may appear. Delegates the empty-fallback rendering to
 * {@link renderProjectToolingSection} (shared with the implement / evaluate prompts) so the
 * fallback markup can't drift between the two renderers.
 */
const renderProjectTooling = (repository: Repository): string => {
  const lines: string[] = [];
  if (repository.setupScript !== undefined) lines.push(`- Setup: ${repository.setupScript}`);
  if (repository.verifyScript !== undefined) lines.push(`- Verify: ${repository.verifyScript}`);
  return renderProjectToolingSection(lines.length > 0 ? lines.join('\n') : undefined);
};

/** Absent file → `''` (fresh file); any other read failure is an error, never a silent empty base. */
const readExisting = async (path: string): Promise<Result<string, DomainError>> => {
  try {
    return Result.ok(await fs.readFile(path, 'utf8'));
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT')) return Result.ok('');
    return Result.error(
      new StorageError({ subCode: 'io', message: `distill-propose: cannot read existing ${path}`, path, cause })
    );
  }
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
      execute: async (input, signal) => distillProposeUseCase(deps, tool, input, signal),
    },
    input: (ctx) => ({
      repository: ctx.repository,
      candidates: assertCtxField(ctx, 'candidates', `distill-propose-${tool}`, 'pre-distill-propose'),
    }),
    output: (ctx, out) => ({
      ...ctx,
      entries: {
        ...ctx.entries,
        [tool]: { ...ctx.entries[tool], proposedContent: out.proposedContent, targetPath: out.targetPath },
      },
    }),
    label: 'Propose learnings',
  });
