/**
 * `EvaluateAndFixLoopUseCase` — orchestrate the multi-round
 * generator/evaluator fix loop on a single, settled task.
 *
 * Single round (`evaluationIterations: 1`) → run the evaluator once.
 * `0` → skip evaluation entirely (the loop exits immediately and
 * downstream code treats the task as not-evaluated).
 * `N > 1` → up to N evaluator rounds; on a `failed` round the use case
 * resumes the *generator* with the prior critique injected, re-runs the
 * post-task check, and then re-evaluates. Plateau detection short-circuits
 * the loop when two consecutive `failed` rounds flag the same set of
 * dimensions (Anthropic's harness-design guidance — see
 * `plateau-detection.ts`).
 *
 * **Iteration semantics** — `evaluationIterations: N` is interpreted as
 * "at most N evaluator rounds total". Round 1 is the initial evaluation;
 * rounds 2..N are fix-and-reeval. This matches the legacy default
 * (`1` = "one initial eval, no fix attempt") rather than `1` meaning
 * "1 fix on top of an initial".
 *
 * **Live config** — the iteration cap is re-read from {@link LiveConfigReader}
 * on every loop tick so a settings-panel edit mid-execution applies to the
 * next round (REQ-12).
 *
 * **Per-round on-disk layout** — `evaluateWorkspaceDir` is required;
 * the loop writes one folder per round under
 * `<workspace>/rounds/<N>/evaluator/`:
 *
 *   - `prompt.md` — the evaluator prompt rendered for THIS round.
 *   - `evaluation.md` — the full critique (`fullCritique` from the
 *     `EvaluateTaskUseCase` result), stamped after the round settles.
 *   - `session.md` — the audit pack written by the AI session adapter.
 *
 * Generator (re-)spawns land their `session.md` audit at
 * `rounds/<N>/generator/session.md`. Each round path is unique, so
 * "the most recent verdict" is unambiguously the highest-N
 * `evaluation.md`; the chain layer records that path on
 * `Task.evaluationFile` directly — no pointer file is needed.
 *
 * The generator's prompt at the chain-supplied
 * `executePromptFilePath` is rendered once by the
 * `render-prompt-to-file` leaf and reused across fix rounds. On round
 * `>= 2` the loop hands the generator a critique-aware wrapper that
 * inlines the prior round's verdict body directly in the resume turn
 * so the fix attempt reads the critique without a tool round-trip.
 *
 * **Never blocks** — the loop **always** returns `Result.ok(...)`. A
 * failed / malformed / plateau outcome is signalled via the structured
 * output and surfaced to the chain layer, which records it on the task
 * but never aborts the per-task chain. (Spawn errors from the evaluator
 * or generator do propagate as `Result.error`; that's a system fault,
 * not an evaluator verdict.)
 */
import { join } from 'node:path';

import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { Result } from '@src/domain/result.ts';
import type { EvaluationSignal } from '@src/domain/signals/harness-signal.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { AbsolutePath as AbsolutePathVO } from '@src/domain/values/absolute-path.ts';
import { evaluatorRoundDir } from '@src/kernel/algorithms/execution-round-paths.ts';
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder-port.ts';
import type { WriteContextFilePort } from '@src/business/ports/write-context-file-port.ts';
import type { ExecuteSingleTaskUseCase } from '@src/business/usecases/execute/execute-single-task.ts';
import type { PostTaskCheckUseCase } from '@src/business/usecases/execute/post-task-check.ts';
import type { EvaluateTaskUseCase } from './evaluate-task.ts';
import { type EvaluationOutcome } from './evaluate-task.ts';
import { dimensionsEqual } from './plateau-detection.ts';

/**
 * Narrow shape this use case needs from a live-config provider — only the
 * single field it actually reads. Defined locally so the business layer
 * doesn't import from `application/`. The application's
 * {@link LiveConfigReader} satisfies this structurally; chain factories
 * adapt between the two.
 */
export interface EvaluationConfigReader {
  current(): Promise<{ readonly evaluationIterations: number }>;
}

export interface EvaluateAndFixLoopInput {
  readonly task: Task;
  readonly sprint: Sprint;
  readonly cwd: AbsolutePath;
  /**
   * Absolute path to the per-task generator prompt file produced by
   * the upstream `render-prompt-to-file` leaf. Reused across fix
   * rounds — the generator resumes the same session so the original
   * file body stays in scope.
   */
  readonly executePromptFilePath: string;
  /**
   * Resolved check script for the post-task gate after a generator fix
   * round. When omitted, the post-task gate is skipped between rounds.
   */
  readonly checkScript?: string;
  /**
   * Provider session id to resume the generator from on a fix round.
   * Set by the per-task chain after the initial `execute-task` so the
   * fix attempt continues the same conversation.
   */
  readonly resumeSessionId?: string;
  /**
   * Extra read roots the evaluator session should be able to see. Set by
   * the per-task chain to the evaluate workspace root so the evaluator
   * can read upstream contract files. Empty / undefined for Copilot and
   * for the standalone `sprint evaluate` chain.
   */
  readonly addDirs?: readonly AbsolutePath[];
  /**
   * Working directory the evaluator session spawns under. When set,
   * overrides `task.projectPath` for the evaluator's `cwd`. Used by
   * the per-task chain on the Copilot path: Copilot has no `--add-dir`
   * equivalent, so the workspace builder mirrors the repo into the
   * sandbox and the evaluator's cwd becomes the workspace root. The
   * generator continues to spawn from `task.projectPath`.
   */
  readonly evaluateSessionCwd?: AbsolutePath;
  /**
   * Absolute path of the evaluate workspace root. Two roles:
   *  - Embedded into the evaluator prompt's `Contract files` section so
   *    the AI knows where to read upstream contracts (refined
   *    requirements, full task plan, dimension definitions, prior
   *    sibling evaluations).
   *  - Anchors the per-round on-disk artefact pack at
   *    `<workspace>/rounds/<N>/evaluator/{prompt.md, evaluation.md,
   *    session.md}` plus the stable `<workspace>/latest-evaluation.md`.
   *
   * Required: production callers (the per-task chain) always provide
   * one. Callers that lack a workspace (build-execution-unit failed)
   * must SKIP the loop entirely rather than invoke it with no
   * archival target — the chain layer owns that decision.
   */
  readonly evaluateWorkspaceDir: string;
  /**
   * The single `done-criteria.md` bullet for this task — e.g.
   * `- **Task name** (\`<id>\`) — <criteria>`. Threaded through to
   * each `buildEvaluatePrompt` call so the evaluator receives a stable,
   * explicit definition of "done" for the current task. Collapses to
   * an empty string in the prompt when absent.
   */
  readonly doneCriteriaBullet?: string;
  /**
   * Optional callback that refreshes the volatile evaluate-workspace
   * files for this task. Invoked AT THE TOP of every round — including
   * round 1 — so the evaluator always reads the latest sibling state.
   * Best-effort: a refresh failure logs a warning but does NOT abort
   * the loop, because the workspace from `buildEvaluateWorkspace` is
   * still readable; stale snapshots are better than no evaluation.
   */
  readonly refreshWorkspace?: () => Promise<Result<void, DomainError>>;
  /**
   * Optional per-spawn `session.md` path provider. The loop calls this
   * before each generator (`{ kind: 'generator' }`) and evaluator
   * (`{ kind: 'evaluator' }`) spawn to obtain an audit path keyed on
   * `round`; it threads the result into the spawn's `SessionOptions`
   * so the AI session adapter brackets the spawn with
   * `writeSessionStart` / `writeSessionFinish`. Returning `undefined`
   * skips the audit for that round. The chain layer's implementation
   * routes `'evaluator'` to `rounds/<round>/evaluator/session.md` and
   * `'generator'` to `rounds/<round>/generator/session.md`.
   *
   * Lives in `business/` so the use case stays IO-free; the chain
   * leaf injects an integration-side closure.
   */
  readonly nextSessionMdPath?: (kind: 'generator' | 'evaluator', round: number) => Promise<AbsolutePath | undefined>;
  readonly abortSignal?: AbortSignal;
}

export interface EvaluateAndFixLoopOutput {
  /** Number of evaluator rounds actually run (0 when disabled). */
  readonly rounds: number;
  /** Final evaluator signal. `null` when `evaluationIterations: 0`. */
  readonly finalSignal: EvaluationSignal | null;
  /** Final evaluator critique (full text). Empty string when disabled. */
  readonly finalCritique: string;
  /** True when the loop exited because two consecutive rounds flagged the same dimensions. */
  readonly plateauDetected: boolean;
  /** Per-round critiques, in order. Used by the chain layer to render history. */
  readonly history: readonly EvaluationRound[];
}

export interface EvaluationRound {
  readonly round: number;
  readonly outcome: EvaluationOutcome;
  readonly signal: EvaluationSignal;
  readonly critique: string;
}

export class EvaluateAndFixLoopUseCase {
  constructor(
    private readonly liveConfig: EvaluationConfigReader,
    private readonly evaluator: EvaluateTaskUseCase,
    private readonly generator: ExecuteSingleTaskUseCase,
    private readonly checkRunner: PostTaskCheckUseCase,
    private readonly prompts: PromptBuilderPort,
    private readonly writeContextFile: WriteContextFilePort,
    private readonly logger: LoggerPort
  ) {}

  async execute(input: EvaluateAndFixLoopInput): Promise<Result<EvaluateAndFixLoopOutput, DomainError>> {
    const log = this.logger.child({
      sprintId: input.sprint.id,
      taskId: input.task.id,
    });

    const initialConfig = await this.liveConfig.current();
    if (initialConfig.evaluationIterations <= 0) {
      log.info('evaluator disabled (evaluationIterations: 0)');
      return Result.ok({
        rounds: 0,
        finalSignal: null,
        finalCritique: '',
        plateauDetected: false,
        history: [],
      });
    }

    const history: EvaluationRound[] = [];
    let previousSignal: EvaluationSignal | undefined;
    let previousCritique: string | undefined;
    let resumeSessionId = input.resumeSessionId;
    let plateauDetected = false;

    // Cap is re-read each iteration tick so settings-panel edits apply
    // to the *next* loop check without restart (REQ-12). The exit
    // conditions are all `break` statements inside the body — every
    // round makes progress (round counter increments before any
    // potentially-await side effect), so there is no risk of an
    // unbounded loop.
    let round = 0;
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    while (true) {
      const cfg = await this.liveConfig.current();
      const cap = cfg.evaluationIterations;
      if (cap <= round) {
        log.info('evaluation cap reached', { rounds: round, cap });
        break;
      }

      round += 1;

      // ── Refresh the evaluate workspace's volatile files BEFORE the
      //    round (including round 1) so the evaluator reads the
      //    freshest sibling state. Best-effort: a refresh failure
      //    means the AI sees a slightly-stale snapshot, which is
      //    strictly better than aborting the round outright. The
      //    workspace adapter never throws on missing files — refresh
      //    only fails on disk-full / EPERM, both of which the user
      //    can act on without losing the evaluation itself.
      if (input.refreshWorkspace) {
        const refreshed = await input.refreshWorkspace();
        if (!refreshed.ok) {
          log.warn('failed to refresh evaluate workspace — continuing with stale snapshot', {
            round,
            error: refreshed.error.message,
          });
        }
      }

      // ── Per-round evaluator paths.
      //    Each round's prompt + verdict + session.md live under
      //    `<workspace>/rounds/<round>/evaluator/` so artefacts persist
      //    independently. The workspace is contractually required —
      //    callers that don't have one must skip the loop.
      const evaluatorPromptPath = AbsolutePathVO.trustString(
        join(evaluatorRoundDir(input.evaluateWorkspaceDir, round), 'prompt.md')
      );

      // ── Render the evaluator prompt to file (per-round; the
      //    `previousCritique` slot changes between rounds). Overwriting
      //    is intentional — the AI reads the FRESH version each time.
      const evalPromptResult = await this.prompts.buildEvaluatePrompt({
        task: input.task,
        sprint: input.sprint,
        evaluateWorkspaceDir: input.evaluateWorkspaceDir,
        ...(previousCritique !== undefined ? { previousCritique } : {}),
        ...(input.doneCriteriaBullet !== undefined ? { doneCriteriaBullet: input.doneCriteriaBullet } : {}),
      });
      if (!evalPromptResult.ok) return Result.error(evalPromptResult.error);
      const written = await this.writeContextFile.write(evaluatorPromptPath, evalPromptResult.value);
      if (!written.ok) return Result.error(written.error);

      // ── Evaluator round ─────────────────────────────────────────
      const evaluatorCwd = input.evaluateSessionCwd ?? input.cwd;
      const evaluatorSessionMdPath = input.nextSessionMdPath
        ? await input.nextSessionMdPath('evaluator', round)
        : undefined;
      const evalResult = await this.evaluator.execute({
        task: input.task,
        sprint: input.sprint,
        cwd: evaluatorCwd,
        promptFilePath: String(evaluatorPromptPath),
        ...(input.addDirs !== undefined ? { addDirs: input.addDirs } : {}),
        ...(evaluatorSessionMdPath !== undefined ? { sessionMdPath: evaluatorSessionMdPath } : {}),
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      });
      if (!evalResult.ok) return Result.error(evalResult.error);

      const { outcome, signal, fullCritique } = evalResult.value;
      history.push({ round, outcome, signal, critique: fullCritique });

      // ── Persist the verdict to disk under the per-round folder.
      //    Each round gets its own unique path (`rounds/<N>/evaluator/
      //    evaluation.md`), so "the most recent" is unambiguously the
      //    highest N — no pointer file needed. Best-effort: a write
      //    failure surfaces as a warning, the verdict is still in
      //    `fullCritique` on the result object regardless.
      const verdictPath = AbsolutePathVO.trustString(
        join(evaluatorRoundDir(input.evaluateWorkspaceDir, round), 'evaluation.md')
      );
      const verdictWritten = await this.writeContextFile.write(verdictPath, fullCritique);
      if (!verdictWritten.ok) {
        log.warn('failed to persist per-round evaluator verdict', {
          round,
          error: verdictWritten.error.message,
        });
      }

      log.info(`evaluator round complete for task ${String(input.task.id)}`, { round, outcome });

      // Exit conditions checked in priority order.
      if (outcome === 'passed') break;
      if (outcome === 'malformed') {
        log.warn('evaluator output malformed — exiting loop', { round });
        break;
      }

      // outcome === 'failed' — check plateau before another fix attempt.
      if (previousSignal !== undefined && dimensionsEqual(previousSignal, signal)) {
        log.warn('evaluator plateau detected — exiting loop', {
          round,
          dimensions: signal.dimensions.filter((d) => !d.passed).map((d) => d.dimension),
        });
        plateauDetected = true;
        break;
      }

      previousSignal = signal;
      previousCritique = fullCritique;

      // No point spawning a fix attempt when the cap is already
      // exhausted — the next round wouldn't run anyway. Re-read the
      // cap so a panel edit "raise iterations" mid-run can still
      // unlock a fix attempt before we exit.
      const nextCfg = await this.liveConfig.current();
      if (nextCfg.evaluationIterations <= round) {
        log.info('evaluation cap reached after failed round — skipping fix attempt', {
          rounds: round,
          cap: nextCfg.evaluationIterations,
        });
        break;
      }

      // ── Generator fix round ─────────────────────────────────────
      // The generator resumes the same session, so the original
      // execute prompt file at `input.executePromptFilePath` is
      // already in scope. The fix wrapper inlines the verdict body
      // (`fullCritique`) directly in the resume turn so the generator
      // reads it without a tool round-trip — the critique is bounded
      // and already in memory; an on-disk handoff would only add
      // failure modes. The next round's index is `round + 1`.
      log.info('resuming generator with critique', { round });
      const fixRound = round + 1;
      const generatorSessionMdPath = input.nextSessionMdPath
        ? await input.nextSessionMdPath('generator', fixRound)
        : undefined;
      const fixResult = await this.generator.execute({
        task: input.task,
        sprint: input.sprint,
        cwd: input.cwd,
        promptFilePath: input.executePromptFilePath,
        ...(resumeSessionId !== undefined ? { resumeSessionId } : {}),
        ...(generatorSessionMdPath !== undefined ? { sessionMdPath: generatorSessionMdPath } : {}),
        fixContext: { critique: fullCritique },
        ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
      });
      if (!fixResult.ok) return Result.error(fixResult.error);
      if (fixResult.value.newSessionId !== undefined) {
        resumeSessionId = fixResult.value.newSessionId;
      }

      // ── Post-task check between rounds ──────────────────────────
      if (input.checkScript !== undefined && input.checkScript.length > 0) {
        const checkResult = await this.checkRunner.execute({
          projectPath: input.cwd,
          checkScript: input.checkScript,
        });
        if (!checkResult.ok) return Result.error(checkResult.error);
        if (!checkResult.value.passed) {
          log.warn('post-task check failed after fix attempt — re-evaluating anyway', { round });
        }
      }
    }

    const last = history.length > 0 ? history[history.length - 1] : undefined;
    return Result.ok({
      rounds: history.length,
      finalSignal: last?.signal ?? null,
      finalCritique: last?.critique ?? '',
      plateauDetected,
      history,
    });
  }
}
