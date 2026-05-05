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
 * **Per-round on-disk layout** — when an `evaluateWorkspaceDir` is set,
 * the loop writes one folder per round under
 * `<workspace>/rounds/<N>/evaluator/`:
 *
 *   - `prompt.md` — the evaluator prompt rendered for THIS round.
 *   - `evaluation.md` — the full critique (`fullCritique` from the
 *     `EvaluateTaskUseCase` result), stamped after the round settles.
 *   - `session.md` — the audit pack written by the AI session adapter.
 *
 * Generator (re-)spawns land their `session.md` audit at
 * `rounds/<N>/generator/session.md`. After every successful round the
 * loop also copies the verdict to `<workspace>/latest-evaluation.md`
 * — a stable pointer for `Task.evaluationFile`, while the per-round
 * `evaluation.md` files remain the durable history.
 *
 * The generator's prompt at the chain-supplied
 * `executePromptFilePath` is rendered once by the
 * `render-prompt-to-file` leaf and reused across fix rounds (Claude
 * resumes via `--resume <session-id>` so the original file body
 * remains in scope).
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
import type { LoggerPort } from '@src/business/ports/logger-port.ts';
import type { PromptBuilderPort } from '@src/business/ports/prompt-builder-port.ts';
import type { WriteContextFilePort } from '@src/business/ports/write-context-file-port.ts';
import type { ExecuteSingleTaskUseCase } from '@src/business/usecases/execute/execute-single-task.ts';
import type { PostTaskCheckUseCase } from '@src/business/usecases/execute/post-task-check.ts';
import type { EvaluateTaskUseCase } from './evaluate-task.ts';
import { type EvaluationOutcome } from './evaluate-task.ts';
import { dimensionsEqual } from './plateau-detection.ts';

/**
 * Pure path helpers — the loop knows the per-round layout under an
 * execution unit folder. Mirror of the integration-layer helpers in
 * `src/integration/persistence/execution-unit-builder.ts`; kept inline
 * here so the business layer doesn't import from integration. Both
 * sites must agree on the layout.
 */
function evaluatorRoundDirInline(workspaceDir: string, round: number): string {
  return join(workspaceDir, 'rounds', String(round), 'evaluator');
}

function latestEvaluationPathInline(workspaceDir: string): string {
  return join(workspaceDir, 'latest-evaluation.md');
}

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
   * Absolute path to the sprint dir's contexts/ folder. The loop
   * writes per-round evaluator prompts under
   * `<contextsDir>/evaluate-<task-id>.md`, overwriting on each round.
   */
  readonly contextsDir: AbsolutePath;
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
   * Absolute path of the evaluate workspace root, embedded into the
   * evaluator prompt's `Contract files` section so the AI knows where
   * to read upstream contracts (refined requirements, full task plan,
   * dimension definitions, prior sibling evaluations). When undefined
   * the section renders empty (standalone `sprint evaluate`).
   */
  readonly evaluateWorkspaceDir?: string;
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
      //    When an evaluate workspace is mounted, route the prompt + verdict
      //    + session.md under `rounds/<round>/evaluator/` so each round's
      //    artefacts persist independently. Without a workspace (the
      //    standalone evaluate chain doesn't mount one), fall back to the
      //    sprint-level contexts/ folder so plain-text invocations still
      //    write somewhere meaningful.
      const evaluatorPromptPath = AbsolutePathVO.trustString(
        input.evaluateWorkspaceDir !== undefined
          ? join(evaluatorRoundDirInline(input.evaluateWorkspaceDir, round), 'prompt.md')
          : join(String(input.contextsDir), `evaluate-${String(input.task.id)}.md`)
      );

      // ── Render the evaluator prompt to file (per-round; the
      //    `previousCritique` slot changes between rounds). Overwriting
      //    is intentional — the AI reads the FRESH version each time.
      const evalPromptResult = await this.prompts.buildEvaluatePrompt({
        task: input.task,
        sprint: input.sprint,
        ...(previousCritique !== undefined ? { previousCritique } : {}),
        ...(input.evaluateWorkspaceDir !== undefined ? { evaluateWorkspaceDir: input.evaluateWorkspaceDir } : {}),
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

      // ── Persist the verdict to disk: per-round file + stable
      //    `latest-evaluation.md` pointer. Best-effort: a write failure
      //    surfaces as a warning so the round result is still usable
      //    by the chain (the verdict is in `fullCritique` on the result
      //    object regardless). Skipped when no workspace is mounted.
      if (input.evaluateWorkspaceDir !== undefined) {
        const verdictPath = AbsolutePathVO.trustString(
          join(evaluatorRoundDirInline(input.evaluateWorkspaceDir, round), 'evaluation.md')
        );
        const verdictWritten = await this.writeContextFile.write(verdictPath, fullCritique);
        if (!verdictWritten.ok) {
          log.warn('failed to persist per-round evaluator verdict', {
            round,
            error: verdictWritten.error.message,
          });
        }
        const latestPath = AbsolutePathVO.trustString(latestEvaluationPathInline(input.evaluateWorkspaceDir));
        const latestWritten = await this.writeContextFile.write(latestPath, fullCritique);
        if (!latestWritten.ok) {
          log.warn('failed to update latest-evaluation.md pointer', {
            round,
            error: latestWritten.error.message,
          });
        }
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
      // already in scope. No re-render needed. The next round's
      // index is `round + 1` — `nextSessionMdPath` is keyed on it
      // so the generator's audit lands in `rounds/<round + 1>/generator/`.
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
