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
import {
  MARKER_COMMENT,
  parseFeedbackMd,
  renderEmptyRound,
  ROUND_SEPARATOR,
} from '@src/business/feedback/md-parser.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Element } from '@src/application/chain/element.ts';
import { leaf } from '@src/application/chain/build/leaf.ts';
import { currentSessionId } from '@src/application/session/session.ts';
import { buildApplyFeedbackPrompt } from '@src/integration/ai/prompts/apply-feedback/definition.ts';
import { renderContractSectionFor } from '@src/integration/ai/contract/_engine/render-contract-section.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import { reviewRoundOutputContract } from '@src/application/flows/review/leaves/review-round.contract.ts';
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
 * `<sprintDir>/review/round-<N>/`, writes the rendered prompt there, then drives the spawn.
 * The AI session is rooted at the per-round dir (no repo enjoys cwd privilege) and every
 * sprint-affected repo is mounted as an `additionalRoot` — mirrors plan's symmetric
 * multi-repo pattern. The AI writes `signals.json` directly into the round dir; the harness
 * post-validates via {@link validateSignalsFile} against {@link reviewRoundOutputContract}.
 * The terminal signal (`task-complete` xor `task-blocked`) is what the use case branches on.
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
  readonly model: string;
}

export interface ReviewRoundLeafOpts {
  /**
   * Parent directory for per-round forensic dirs — `<sprintDir>/review/`. Each round
   * materialises a `round-<N>/` subfolder here that becomes the AI session's cwd.
   */
  readonly reviewRoot: AbsolutePath;
  /**
   * Single repo working tree the harness commits and runs verify in. Review touches a
   * sprint-affected diff which historically lives on one branch in one repo; the launcher
   * picks the first sprint-affected repo. Distinct from the AI session's cwd, which is the
   * per-round dir under {@link reviewRoot} so no repo's `CLAUDE.md` / agents auto-load
   * (matches plan).
   */
  readonly commitCwd: AbsolutePath;
  /**
   * Every sprint-affected repository, mounted into the AI session as `--add-dir` roots.
   * Derived by the launcher from the sprint's tasks (`Task.repositoryId`) joined against
   * `Project.repositories`. Empty arrays are rejected upstream — review needs at least one
   * repo to act against.
   */
  readonly additionalRoots: readonly AbsolutePath[];
  /**
   * Pre-rendered `{{REPOSITORIES}}` block — Markdown list of every sprint-affected repo
   * (absolute path + display name). Built by the launcher so this leaf stays agnostic of
   * `Project` shape.
   */
  readonly repositoriesBlock: string;
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
 * Read the feedback file and return the index of the active round — the LAST `## Round N` heading
 * on disk. Defaults to 1 when the file is absent or holds no parseable round (a fresh sprint whose
 * `ensure-feedback-file` leaf has not yet run, or an empty file). Read failures other than absence
 * also fall back to 1 rather than aborting the round — the index only drives the prompt label and
 * the forensic dir name, so a best-effort read keeps the round running.
 */
const deriveActiveRoundIndex = async (feedbackFile: AbsolutePath): Promise<number> => {
  try {
    const raw = await fs.readFile(String(feedbackFile), 'utf8');
    const rounds = parseFeedbackMd(raw);
    return rounds.at(-1)?.index ?? 1;
  } catch {
    return 1;
  }
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
    // Atomic write — this is durable human-feedback history (the only copy of the review record).
    // A plain `fs.writeFile` could leave it truncated on a crash mid-write; `writeTextAtomic`
    // writes-temp-then-renames so a reader sees either the old or the full new content.
    return writeTextAtomic(String(path), next);
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
 * Compute the per-round forensic paths under `<reviewRoot>/round-<N>/`. The dir is allocated
 * once per round and shared between prompt-build (which embeds `outputDir` in the contract
 * section) and the spawn call (which lands `signals.json` there). The AI session is rooted
 * at this dir, mirroring plan's per-run unit dir — keeps per-repo `CLAUDE.md` / agents from
 * auto-loading on multi-repo sprints.
 */
const allocateRoundPaths = (reviewRoot: AbsolutePath, roundIndex: number): Result<RoundPaths, DomainError> => {
  const dir = AbsolutePath.parse(join(String(reviewRoot), `round-${String(roundIndex)}`));
  if (!dir.ok) return Result.error(dir.error);
  const promptFile = AbsolutePath.parse(join(String(dir.value), 'prompt.md'));
  if (!promptFile.ok) return Result.error(promptFile.error);
  const signalsFile = AbsolutePath.parse(join(String(dir.value), 'signals.json'));
  if (!signalsFile.ok) return Result.error(signalsFile.error);
  return Result.ok({ outputDir: dir.value, signalsFile: signalsFile.value, promptFile: promptFile.value });
};

/**
 * `mkdir -p` the per-round dir so the AI session can write `signals.json` into it. Idempotent.
 */
const ensureRoundDir = async (dir: AbsolutePath): Promise<Result<void, StorageError>> => {
  try {
    await fs.mkdir(String(dir), { recursive: true });
    return Result.ok(undefined);
  } catch (cause) {
    return Result.error(
      new StorageError({
        subCode: 'io',
        message: `failed to create review round dir: ${String(dir)}`,
        path: String(dir),
        cause,
      })
    );
  }
};

export const reviewRoundLeaf = (deps: ReviewRoundLeafDeps, opts: ReviewRoundLeafOpts): Element<ReviewCtx> =>
  leaf<ReviewCtx, ReviewRoundInput, RunReviewRoundOutput>('review-round', {
    useCase: {
      execute: async (input, signal) => {
        // Derive the active round index from the ON-DISK feedback.md, not from in-memory ctx.
        // `previousRound` lives only in chain ctx, so on a relaunch of a sprint whose feedback.md
        // already holds N rounds (user quit mid-review; sprint stayed in `review`), the ctx-derived
        // index would compute 1 — mislabelling the prompt ("Feedback for round 1"), writing the
        // body into round N+1 (writeRoundBody targets the LAST marker), and overwriting round-1's
        // forensic dir. The harness writes the active round's `## Round N` heading as the LAST round
        // in the file (`ensure-feedback-file` seeds Round 1; `appendNextRound` appends the next), so
        // its index is the round we're about to act on. Default to 1 for a not-yet-seeded file.
        const roundIndex = await deriveActiveRoundIndex(input.feedbackFile);
        const paths = allocateRoundPaths(opts.reviewRoot, roundIndex);
        if (!paths.ok) return Result.error(paths.error);
        const ensured = await ensureRoundDir(paths.value.outputDir);
        if (!ensured.ok) return Result.error(ensured.error);
        let prompt: Prompt | undefined;

        return runReviewRoundUseCase({
          sprint: input.sprint,
          ...(input.previousRound !== undefined ? { previousRound: input.previousRound } : {}),

          openEditor: async () => {
            // Ask the user for the round's body in-app. Esc → DomainError, which the use case
            // maps to an `aborted` outcome (same behaviour the old vim `:cq` produced).
            const answer = await deps.interactive.askTextArea(
              `Feedback for round ${String(roundIndex)}` +
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
              repositories: opts.repositoriesBlock,
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
            // Plan-style multi-repo cwd: the AI session is rooted at the per-round dir
            // (harness-owned, sprint-scoped) and every sprint-affected repo is mounted via
            // `--add-dir` as an equal source. No repo enjoys cwd privilege — picking one
            // would auto-load its `CLAUDE.md` / agents / `.mcp.json` and bias the AI toward
            // it, and on a multi-repo sprint where the feedback targets a non-first repo it
            // also blinded the AI to the relevant tree entirely (root cause of the bug this
            // change fixes).
            // `currentSessionId()` is read in the leaf's `execute(...)` scope (wrapped by the
            // runner's `runWithSession`) and threaded onto the session as DATA so the headless
            // adapter can key the token-usage event by the runner id without importing the
            // application session helper across the layer boundary.
            const chainSessionId = currentSessionId();
            const spawn = await deps.provider.generate({
              prompt,
              cwd: paths.value.outputDir,
              additionalRoots: opts.additionalRoots,
              model: deps.model,
              permissions: FULL_AUTO,
              signalsFile: paths.value.signalsFile,
              outputDir: paths.value.outputDir,
              ...(chainSessionId !== undefined ? { chainSessionId } : {}),
              // Thread the chain's abort signal so a TUI cancel mid-spawn kills the child via
              // the provider's SIGTERM ladder instead of letting it run to completion.
              ...(signal !== undefined ? { abortSignal: signal } : {}),
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
            // Commit and verify still target a single repo working tree — review operates
            // against the sprint branch in `commitCwd`. Multi-repo commit/verify is out of
            // scope for this fix.
            const message = renderReviewCommitMessage(round);
            const commit = await gitCommitWithMessage(deps.gitRunner, opts.commitCwd, message);
            if (!commit.ok) return Result.error(commit.error) as Result<{ readonly committed: boolean }, DomainError>;
            return Result.ok({ committed: commit.value.committed });
          },
          ...(opts.verifyScript !== undefined && opts.verifyScript.trim().length > 0
            ? {
                verifyRound: async () => {
                  const verify = await deps.shellScriptRunner.run(opts.commitCwd, opts.verifyScript!, {
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
