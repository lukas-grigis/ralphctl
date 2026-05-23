import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { AppendFile } from '@src/business/io/append-file.ts';
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { Sink } from '@src/business/observability/sink.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { FULL_AUTO } from '@src/integration/ai/providers/_engine/session-permissions.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import {
  renderReviewCommitMessage,
  type RunReviewRoundOutput,
  runReviewRoundUseCase,
} from '@src/business/feedback/run-review-round.ts';
import { MARKER_COMMENT, renderEmptyRound, ROUND_SEPARATOR } from '@src/business/feedback/md-parser.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { buildApplyFeedbackPrompt } from '@src/integration/ai/prompts/apply-feedback/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import { reviewRoundOutputContract } from '@src/application/flows/review/leaves/review-round.contract.ts';
import { buildRunDirName } from '@src/integration/ai/runs/_engine/run-artifacts.ts';
import { writeTextAtomic } from '@src/integration/io/fs.ts';
import type { TemplateLoader } from '@src/integration/ai/prompts/_engine/template-loader.ts';
import { gitCommitWithMessage } from '@src/integration/io/git-operations.ts';
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ShellScriptRunner } from '@src/integration/io/shell-script-runner.ts';
import type { ReviewCtx } from '@src/application/flows/review/ctx.ts';

/**
 * Chain leaf — one iteration of the review loop. Wires the interactive prompt, fs, AI, git, and
 * shell ports into the function-shape deps {@link runReviewRoundUseCase} consumes; the use case
 * owns the per-round decision tree (termination, blocked, commit, verify).
 *
 * Composition: the surrounding `loop` primitive runs this leaf until `ctx.lastReviewExit` is
 * set (use case wrote a terminal outcome) or `maxRounds` is reached.
 *
 * Feedback collection: the v1 design opened the user's `$EDITOR` on `feedback.md` and parsed
 * what they saved. v2 collects the round body via the in-app textarea prompt instead. The leaf
 * writes the typed body underneath the current round's marker comment so the rest of the
 * pipeline (`parseFeedbackMd`, `apply-feedback`, …) keeps reading from the same on-disk format.
 *
 * AI session contract (audit-[09]): the leaf materialises one per-round forensic directory
 * `<runsRoot>/apply-feedback/<run-id>/`, writes the rendered prompt there, then drives the
 * spawn. The AI writes `signals.json` directly into the same dir; the harness post-validates
 * via {@link validateSignalsFile} against {@link reviewRoundOutputContract}. The terminal
 * signal (`task-complete` xor `task-blocked`) is what the use case branches on.
 */
export interface ReviewRoundLeafDeps {
  readonly interactive: InteractivePrompt;
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
  readonly gitRunner: GitRunner;
  readonly shellScriptRunner: ShellScriptRunner;
  readonly appendFile: AppendFile;
  /** `<dataRoot>/runs`. Per-round forensic dirs land under `<runsRoot>/apply-feedback/<run-id>/`. */
  readonly runsRoot: AbsolutePath;
  readonly model: string;
}

export interface ReviewRoundLeafOpts {
  readonly cwd: AbsolutePath;
  readonly verifyScript?: string;
}

interface ReviewRoundInput {
  readonly sprint: Sprint;
  readonly feedbackFile: AbsolutePath;
  readonly progressFile?: AbsolutePath;
  readonly previousRound?: ReviewCtx['previousRound'];
}

const readProgressSnippet = async (path: AbsolutePath | undefined): Promise<string> => {
  if (path === undefined) return '_(no progress file)_';
  try {
    const content = await fs.readFile(String(path), 'utf8');
    return content.length > 4000 ? `${content.slice(0, 4000)}\n[truncated]` : content;
  } catch {
    return '_(progress file missing)_';
  }
};

const appendNewRound = async (
  appendFile: AppendFile,
  path: AbsolutePath,
  nextIndex: number
): Promise<Result<void, StorageError>> => {
  const block = `\n\n${renderEmptyRound(nextIndex)}${ROUND_SEPARATOR}\n`;
  return appendFile(path, block);
};

/**
 * Insert the user-typed body underneath the LAST marker comment in the file. The marker is
 * idempotent — calling this twice on the same round body just re-inserts under the same marker.
 * Idempotency matters because the gen-eval loop may re-enter a round after a transient failure.
 */
const writeRoundBody = async (path: AbsolutePath, body: string): Promise<Result<void, StorageError>> => {
  try {
    const content = await fs.readFile(String(path), 'utf8');
    const lastMarker = content.lastIndexOf(MARKER_COMMENT);
    if (lastMarker === -1) {
      return Result.error(
        new StorageError({
          subCode: 'io',
          message: `feedback file missing the round marker — ${String(path)}`,
          path: String(path),
        })
      );
    }
    const after = lastMarker + MARKER_COMMENT.length;
    // Take everything up to and including the marker line break, then the typed body, then the
    // existing tail (which includes the round separator). Trim only stray trailing whitespace
    // from the body so empty submissions still parse as "empty round" (= termination).
    const head = content.slice(0, after);
    const tail = content.slice(after).replace(/^\n*/, ''); // strip blanks immediately after marker
    const next = `${head}\n${body.replace(/\s+$/u, '')}\n${tail}`;
    await fs.writeFile(String(path), next, 'utf8');
    return Result.ok(undefined);
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to write feedback body to ${String(path)}`,
        path: String(path),
        cause,
      })
    );
  }
};

interface RoundPaths {
  readonly outputDir: AbsolutePath;
  readonly signalsFile: AbsolutePath;
  readonly promptFile: AbsolutePath;
}

/**
 * Compute the per-round forensic paths under `<runsRoot>/apply-feedback/<run-id>/`. The dir
 * is allocated once per round and shared between prompt-build (which embeds `outputDir` in
 * the contract section) and the spawn call (which lands `signals.json` there).
 */
const allocateRoundPaths = (runsRoot: AbsolutePath): Result<RoundPaths, DomainError> => {
  const dir = AbsolutePath.parse(join(String(runsRoot), 'apply-feedback', buildRunDirName()));
  if (!dir.ok) return Result.error(dir.error);
  const promptFile = AbsolutePath.parse(join(String(dir.value), 'prompt.md'));
  if (!promptFile.ok) return Result.error(promptFile.error);
  const signalsFile = AbsolutePath.parse(join(String(dir.value), 'signals.json'));
  if (!signalsFile.ok) return Result.error(signalsFile.error);
  return Result.ok({ outputDir: dir.value, signalsFile: signalsFile.value, promptFile: promptFile.value });
};

export const reviewRoundLeaf = (deps: ReviewRoundLeafDeps, opts: ReviewRoundLeafOpts): Element<ReviewCtx> =>
  leaf<ReviewCtx, ReviewRoundInput, RunReviewRoundOutput>('review-round', {
    useCase: {
      execute: async (input) => {
        // One per-round forensic dir, allocated up-front so the prompt's contract section
        // and the eventual spawn point at the same `<outputDir>/signals.json`.
        const paths = allocateRoundPaths(deps.runsRoot);
        if (!paths.ok) return Result.error(paths.error);
        let prompt: Prompt | undefined;

        return runReviewRoundUseCase({
          sprint: input.sprint,
          ...(input.previousRound !== undefined ? { previousRound: input.previousRound } : {}),

          openEditor: async () => {
            // Ask the user for the round's body in-app. Esc → DomainError, which the use case
            // maps to an `aborted` outcome (same behaviour the old vim `:cq` produced).
            const answer = await deps.interactive.askTextArea(
              `Feedback for round ${String((input.previousRound?.index ?? 0) + 1)}` +
                ' — Ctrl+D to submit, Esc to cancel, empty submission ends the review.'
            );
            if (!answer.ok) return Result.error(answer.error) as Result<void, DomainError>;
            const wrote = await writeRoundBody(input.feedbackFile, answer.value);
            if (!wrote.ok) return Result.error(wrote.error) as Result<void, DomainError>;
            return Result.ok(undefined);
          },
          readFeedbackFile: () => fs.readFile(String(input.feedbackFile), 'utf8'),
          readProgressSnippet: () => readProgressSnippet(input.progressFile),
          buildPrompt: async (params) => {
            const outputContractSection = renderContractSectionFor(reviewRoundOutputContract, paths.value.outputDir);
            const built = await buildApplyFeedbackPrompt(deps.templateLoader, {
              projectPath: String(opts.cwd),
              sprintContext: params.sprintContext,
              feedbackLog: params.feedbackLog,
              latestRound: params.latestRound,
              progress: params.progress,
              outputContractSection,
            });
            if (!built.ok) return Result.error(built.error) as Result<unknown, DomainError>;
            prompt = built.value;
            return Result.ok(built.value) as Result<unknown, DomainError>;
          },
          callApplyFeedback: async () => {
            if (prompt === undefined) {
              throw new InvalidStateError({
                entity: 'chain',
                currentState: 'pre-apply-feedback',
                attemptedAction: 'review-round.apply-feedback',
                message: 'review-round: callApplyFeedback invoked before buildPrompt',
              });
            }
            // Persist the rendered prompt to the round dir for post-hoc replay BEFORE the
            // spawn so a crash mid-spawn still leaves the prompt that triggered it on disk.
            const promptWrote = await writeTextAtomic(String(paths.value.promptFile), String(prompt));
            if (!promptWrote.ok) return Result.error(promptWrote.error);
            const spawn = await deps.provider.generate({
              prompt,
              cwd: opts.cwd,
              model: deps.model,
              permissions: FULL_AUTO,
              signalsFile: paths.value.signalsFile,
              outputDir: paths.value.outputDir,
            });
            if (!spawn.ok) return Result.error(spawn.error);
            const validated = await validateSignalsFile(paths.value.outputDir, reviewRoundOutputContract);
            if (!validated.ok) return Result.error(validated.error);
            // Fan-out to BOTH the legacy sink (TUI panels) AND the typed event bus — matching
            // the generator/evaluator dual-emit pattern. Wave 6 of the audit collapses the
            // two paths once every TUI consumer migrates to `ai-signal` events.
            for (const sig of validated.value) {
              deps.signals.emit(sig);
              deps.eventBus.publish({ type: 'ai-signal', signal: sig, source: 'review-round' });
            }
            return Result.ok(validated.value as readonly HarnessSignal[]);
          },
          commitRound: async (round) => {
            const message = renderReviewCommitMessage(round);
            const commit = await gitCommitWithMessage(deps.gitRunner, opts.cwd, message);
            if (!commit.ok) return Result.error(commit.error) as Result<{ readonly committed: boolean }, DomainError>;
            return Result.ok({ committed: commit.value.committed });
          },
          ...(opts.verifyScript !== undefined && opts.verifyScript.trim().length > 0
            ? {
                verifyRound: async () => {
                  const verify = await deps.shellScriptRunner.run(opts.cwd, opts.verifyScript!, {
                    env: { RALPHCTL_LIFECYCLE_EVENT: 'feedback' },
                  });
                  if (!verify.ok) return Result.error(verify.error);
                  return Result.ok({ passed: verify.value.passed, exitCode: verify.value.exitCode });
                },
              }
            : {}),
          appendNextRound: (nextIndex) => appendNewRound(deps.appendFile, input.feedbackFile, nextIndex),
          logger: deps.logger,
        });
      },
    },
    input: (ctx) => {
      if (ctx.sprint === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-review-round',
          attemptedAction: 'review-round',
          message: 'review-round: ctx.sprint missing',
        });
      }
      if (ctx.feedbackFile === undefined) {
        throw new InvalidStateError({
          entity: 'chain',
          currentState: 'pre-review-round',
          attemptedAction: 'review-round',
          message: 'review-round: ctx.feedbackFile missing — ensure-feedback-file must run first',
        });
      }
      return {
        sprint: ctx.sprint,
        feedbackFile: ctx.feedbackFile,
        ...(ctx.progressFile !== undefined ? { progressFile: ctx.progressFile } : {}),
        ...(ctx.previousRound !== undefined ? { previousRound: ctx.previousRound } : {}),
      };
    },
    output: (ctx, out) => {
      const next: ReviewCtx = {
        ...ctx,
        ...(out.currentRound !== undefined ? { previousRound: out.currentRound } : {}),
        ...(out.applied ? { roundsApplied: (ctx.roundsApplied ?? 0) + 1 } : {}),
      };
      if (out.exit === 'continued') return next;
      return {
        ...next,
        lastReviewExit: out.exit,
        ...(out.exit === 'aborted' ? { aborted: true } : {}),
      };
    },
  });
