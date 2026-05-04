/**
 * `createPerTaskFlow` — per-task chain composed inside the executeFlow's
 * Sequential of topologically-ordered tasks. One instance per task in the
 * sprint.
 *
 * Steps (happy path):
 *
 *   branch-preflight → mark-in-progress → render-prompt-to-file →
 *     execute-task → post-task-check → evaluate-task → mark-done
 *
 * The chain does NOT auto-commit a dirty tree after the generator. The
 * evaluator runs `git status` as part of its read-only checks and treats
 * leftover uncommitted changes as a Completeness failure — auto-committing
 * first defeats that signal and produces noise commits attributed to the
 * harness for changes the agent forgot to ship.
 *
 * The brief calls for `Retry(execute-task, ...)` on rate-limit and
 * `OnError(branch-preflight, fallback: mark-blocked)`. Today's
 * implementation:
 *
 *  - **Retry** — `execute-task` is wrapped in `Retry(maxAttempts: 2,
 *    retryOn: code === 'rate-limited')`. The use case classifies a
 *    rate-limited spawn as outcome `'rate-limited'` returned via
 *    `Result.ok(...)`, so Retry won't fire automatically. We surface
 *    rate-limit as a kernel error instead, letting Retry pick it up.
 *    The retry loop is independent of the rate-limit coordinator's
 *    pause/resume machinery — it handles in-flight 429 via session
 *    resume on the same task.
 *  - **Cancel** — the Retry-wrapped execute-task is further wrapped in
 *    `OnError(catchIf: code === 'aborted', fallback: markBlocked)` so a
 *    user-initiated cancel (TUI `c` key, CLI Ctrl+C) transitions the
 *    in-flight task to `'blocked'` with reason "cancelled by user" and
 *    short-circuits the rest of the chain via `taskBlocked`.
 *  - **Branch preflight** — wrapped in `OnError(catchIf: BranchPreflight
 *    mismatch, fallback: mark-blocked)` so a wrong-branch repo doesn't
 *    crash the entire sprint. The fallback transitions the Task aggregate
 *    to `'blocked'` (recording the preflight error message as the reason)
 *    and sets `ctx.taskBlocked = true`. Every downstream leaf checks the
 *    flag and short-circuits as a no-op so the rest of the chain still
 *    runs (each step still emits a trace entry, keeping the trace honest)
 *    but performs no work. The outer Sequential continues with the next
 *    task because the per-task chain returns `Result.ok` after the
 *    fallback recovers.
 *
 * `render-prompt-to-file` writes the FULL execute prompt (with task
 * data, harness context, signal vocabulary) to
 * `<sprintDir>/contexts/execute-<task-id>.md`. The downstream `execute-task`
 * leaf hands the AI a thin wrapper pointing at that file — the file body
 * is the prompt the AI actually reads.
 *
 * The `evaluate-task` step is a single Leaf wrapping
 * {@link EvaluateAndFixLoopUseCase} — the loop owns the multi-round
 * generator/evaluator orchestration (iterations cap, plateau detection,
 * generator resume, inter-round check) and exposes a single `Result`
 * back to the chain. Persisting the verdict on the Task aggregate is
 * the chain's job and happens after the loop returns.
 *
 * The evaluator is non-blocking by contract: a failed / malformed /
 * plateau outcome resolves successfully so the per-task chain
 * continues to `mark-done`. Spawn errors propagate but are caught by
 * the surrounding chain frame so `mark-done` still runs. (See the
 * `OnError(catchIf: () => true)` wrapper below.)
 */
import { dirname, join } from 'node:path';

import { Result } from '@src/domain/result.ts';
import { nextSessionPath } from '@src/integration/persistence/session-md-writer.ts';
import { readDoneCriteriaBullet } from '@src/integration/persistence/done-criteria-reader.ts';

import { BranchPreflightUseCase } from '@src/business/usecases/execute/branch-preflight.ts';
import {
  EvaluateAndFixLoopUseCase,
  type EvaluateAndFixLoopOutput,
} from '@src/business/usecases/evaluate/evaluate-and-fix-loop.ts';
import { EvaluateTaskUseCase } from '@src/business/usecases/evaluate/evaluate-task.ts';
import {
  ExecuteSingleTaskUseCase,
  type TaskExecutionOutcome,
} from '@src/business/usecases/execute/execute-single-task.ts';
import { PostTaskCheckUseCase, type PostTaskCheckOutput } from '@src/business/usecases/execute/post-task-check.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { DomainError } from '@src/domain/errors/domain-error.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';
import type { Element, KernelError } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import { OnError } from '@src/kernel/chain/on-error.ts';
import { Retry } from '@src/kernel/chain/retry.ts';
import { Sequential } from '@src/kernel/chain/sequential.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';
import { buildExecutionUnitLeaf } from '@src/application/chains/leaves/build-execution-unit.ts';
import { renderPromptToFileLeaf } from '@src/application/chains/leaves/render-prompt-to-file.ts';
import { resolveStoragePaths } from '@src/integration/persistence/storage-paths.ts';
import { unitSlug } from '@src/integration/persistence/unit-slug.ts';

export interface PerTaskCtx {
  readonly sprintId: SprintId;
  readonly sprint: Sprint;
  readonly task: Task;
  readonly cwd: AbsolutePath;
  readonly expectedBranch: string;
  /** Optional resolved check script for the post-task gate; skipped when missing. */
  readonly checkScript?: string;
  /**
   * Absolute path to the per-task prompt file written by the
   * `render-prompt-to-file` leaf. Consumed by `execute-task` (the AI
   * receives a thin wrapper pointing at this file). Undefined when
   * the upstream leaf hasn't run — every downstream leaf treats
   * absence as a programmer error.
   */
  readonly promptFilePath?: AbsolutePath;
  readonly outcome?: TaskExecutionOutcome;
  readonly newSessionId?: string;
  readonly checkResult?: PostTaskCheckOutput;
  /** Surfaced by the evaluate-and-fix loop; absent when the evaluator is disabled. */
  readonly evaluation?: EvaluateAndFixLoopOutput;
  /**
   * Set to `true` by the branch-preflight `OnError` fallback after it
   * transitions the Task aggregate to `'blocked'`. Every downstream leaf
   * checks this flag and no-ops, keeping the trace honest while skipping
   * the actual work.
   */
  readonly taskBlocked?: boolean;
  /**
   * Stamped from the launcher (CLI `--no-commit` / TUI flag). When `true`,
   * the per-task `commit-task` leaf no-ops — the harness leaves the dirty
   * tree for the user to commit manually.
   */
  readonly noCommit?: boolean;
  /**
   * Per-task execution unit folder root. Stamped by
   * `build-execution-unit`; consumed by `evaluate-task` (passes it down
   * to the loop, which in turn embeds it into the evaluator prompt's
   * contract-files section and refreshes its volatile contents per
   * round).
   */
  readonly executionUnitRoot?: AbsolutePath;
  /**
   * Read roots the evaluator session should expose to the AI. Claude:
   * `[executionUnitRoot]`. Copilot: `[]` (the unit folder mirrors the
   * repo internally — no `--add-dir` equivalent on Copilot's CLI).
   */
  readonly executionAddDirs?: readonly AbsolutePath[];
  /**
   * Working directory the evaluator session spawns under. Claude:
   * `task.projectPath` (read-only checks against the real repo).
   * Copilot: `executionUnitRoot` (the repo is mirrored inside).
   * The generator's cwd is unaffected — generator always runs in the
   * real `task.projectPath`.
   */
  readonly executionSessionCwd?: AbsolutePath;
  /** `<executionUnitRoot>/evaluation.md` — durable evaluator critique sink. */
  readonly executionEvaluationMdPath?: AbsolutePath;
  /**
   * Full sprint task list. Used by `build-execution-unit` to derive
   * `priorEvaluations` and to populate `tasks.md` / `tasks.json` inside
   * the unit folder. Stamped onto the ctx by the outer `executeFlow`'s
   * `load-tasks` leaf via the per-task chain construction; we expose
   * it on the per-task ctx so the build leaf can read it without
   * threading a separate input.
   */
  readonly tasks?: readonly Task[];
  /**
   * The single `done-criteria.md` bullet for this task, read from the
   * per-task execution unit folder after `build-execution-unit` runs.
   * Threaded through to every `buildEvaluatePrompt` call so the
   * evaluator has an explicit, stable definition of "done". Absent when
   * the file doesn't exist (legacy sprint) or when the task is not found
   * in the file — in both cases the evaluator gracefully omits the
   * section.
   */
  readonly doneCriteriaBullet?: string;
}

export interface CreatePerTaskFlowOpts {
  readonly task: Task;
  readonly sprint: Sprint;
}

/** Per-task commit message: trim to 64 chars, prefix with task id. */
const COMMIT_NAME_MAX = 64;
const COMMIT_MESSAGE_MAX = 200;
function buildCommitMessage(task: Task): string {
  const idPrefix = String(task.id).slice(0, 8);
  const trimmedName = task.name.trim();
  const slicedName = trimmedName.length > COMMIT_NAME_MAX ? trimmedName.slice(0, COMMIT_NAME_MAX) : trimmedName;
  const message = slicedName.length > 0 ? `task(${idPrefix}): ${slicedName}` : `task(${idPrefix})`;
  return message.length > COMMIT_MESSAGE_MAX ? message.slice(0, COMMIT_MESSAGE_MAX) : message;
}

export function createPerTaskFlow(
  deps: Pick<
    ChainSharedDeps,
    | 'sprintRepo'
    | 'taskRepo'
    | 'aiSession'
    | 'prompts'
    | 'signalParser'
    | 'external'
    | 'logger'
    | 'liveConfig'
    | 'signalBus'
    | 'signalHandler'
    | 'rateLimitCoordinator'
    | 'writeContextFile'
    | 'sessionFolderBuilder'
  >,
  opts: CreatePerTaskFlowOpts
): Element<PerTaskCtx> {
  const branchPreflight = new BranchPreflightUseCase(deps.external, deps.logger);
  const executeOne = new ExecuteSingleTaskUseCase(
    deps.aiSession,
    deps.signalParser,
    deps.logger,
    deps.signalBus,
    deps.rateLimitCoordinator
  );
  const postCheck = new PostTaskCheckUseCase(deps.external, deps.logger);
  const evaluator = new EvaluateTaskUseCase(deps.aiSession, deps.signalParser, deps.logger, deps.signalHandler);
  const evaluateLoop = new EvaluateAndFixLoopUseCase(
    deps.liveConfig,
    evaluator,
    executeOne,
    postCheck,
    deps.prompts,
    deps.writeContextFile,
    deps.logger
  );

  const branchPreflightStep = new OnError<PerTaskCtx>(branchPreflightLeaf(branchPreflight), {
    catchIf: (err) => err.code === 'invalid-state',
    fallback: markBlockedFallbackLeaf(deps),
  });

  const executeTaskWithRetry = new Retry<PerTaskCtx>(executeTaskLeaf(executeOne), {
    maxAttempts: 2,
    backoff: 'fixed',
    initialDelayMs: 0,
    retryOn: (err) => err.code === 'rate-limited',
  });

  // User-initiated cancellation propagates as `code: 'aborted'` from the
  // kernel's AbortSignal plumbing. Catch only that variant and transition
  // the task to `'blocked'` with reason "cancelled by user" so the rest
  // of the per-task chain can short-circuit cleanly. Any other error
  // (rate-limit-exhausted, spawn failure, etc.) falls through unchanged.
  const executeTaskStep = new OnError<PerTaskCtx>(executeTaskWithRetry, {
    catchIf: (err) => err.code === 'aborted',
    fallback: markCancelledFallbackLeaf(deps),
  });

  // The evaluator pack: `build-evaluate-workspace` lays down the per-task
  // contract files, then `evaluate-task` runs the multi-round loop and
  // reads them via the workspace root. Wrap BOTH together so a workspace
  // builder failure (disk full, EPERM, ...) ALSO doesn't block task
  // completion — the task should still proceed to `mark-done`. The
  // existing "evaluator never gates mark-done" contract extends to the
  // workspace setup that feeds it. User-initiated cancellation
  // (`code: 'aborted'`) propagates so Ctrl+C mid-evaluator doesn't
  // silently fall through to mark-done.
  const buildEvalWorkspaceStep = buildExecutionUnitLeaf<PerTaskCtx>({
    sessionFolderBuilder: deps.sessionFolderBuilder,
    aiSession: deps.aiSession,
  });
  const evaluatorAsLeaf = new OnError<PerTaskCtx>(
    new Sequential<PerTaskCtx>('evaluate', [buildEvalWorkspaceStep, evaluateLoopLeaf(deps, evaluateLoop)]),
    {
      catchIf: (err) => err.code !== 'aborted',
      fallback: noopLeaf<PerTaskCtx>('evaluate-task-noop'),
    }
  );

  // Conditionally include post-task-check only when a check script is
  // configured. Tasks with no check script (e.g. polyglot subdirs) skip
  // the gate cleanly.
  const postTaskStep = postTaskCheckLeaf(postCheck);

  // The render-prompt-to-file leaf writes the FULL execute prompt (with
  // task body, harness context, signal vocabulary, project tooling) to
  // `<sprintDir>/execution/<unit-slug>/prompt.md` — co-located with the
  // other per-task artefacts so the sandbox is self-contained. The
  // downstream `execute-task` leaf hands the AI a thin wrapper pointing
  // at that file — the file body is the prompt the AI actually reads.
  const renderPromptStep = renderPromptToFileLeaf<PerTaskCtx>(
    { writeContextFile: deps.writeContextFile },
    {
      flowName: 'execute',
      identifier: (ctx) => String(ctx.task.id),
      path: (ctx) => {
        const slug = unitSlug(String(ctx.task.id), ctx.task.name);
        const root = resolveStoragePaths().executionUnitDir(ctx.sprintId, slug);
        return AbsolutePath.trustString(join(String(root), 'prompt.md'));
      },
      buildPrompt: (ctx) =>
        deps.prompts.buildExecutePrompt({
          task: ctx.task,
          sprint: ctx.sprint,
          ...(ctx.checkScript !== undefined ? { checkScript: ctx.checkScript } : {}),
        }),
    }
  );

  return new Sequential<PerTaskCtx>(`per-task-${opts.task.id}`, [
    branchPreflightStep,
    markInProgressLeaf(deps),
    renderPromptStep,
    executeTaskStep,
    postTaskStep,
    evaluatorAsLeaf,
    commitTaskLeaf(deps),
    markDoneLeaf(deps),
  ]);
}

function branchPreflightLeaf(useCase: BranchPreflightUseCase): Element<PerTaskCtx> {
  return new Leaf<PerTaskCtx, { readonly projectPath: AbsolutePath; readonly expectedBranch: string }, void>(
    'branch-preflight',
    {
      useCase: {
        async execute(input) {
          return useCase.execute({
            projectPath: input.projectPath,
            expectedBranch: input.expectedBranch,
          });
        },
      },
      input: (ctx) => ({ projectPath: ctx.cwd, expectedBranch: ctx.expectedBranch }),
      output: (ctx) => ctx,
    }
  );
}

/**
 * Branch-preflight `OnError` fallback. Reached only when the wrapped
 * preflight leaf returns an `invalid-state` failure (the only error code
 * `BranchPreflightUseCase` produces for a wrong-branch repo).
 *
 * The OnError contract hands us the same input context the preflight saw,
 * not the caught error. The error has already been surfaced through the
 * logger by the preflight use case; we record a generic-but-faithful
 * reason on the Task aggregate so callers grepping `tasks.json` can see
 * which step failed without needing the trace.
 */
function markBlockedFallbackLeaf(deps: Pick<ChainSharedDeps, 'taskRepo' | 'signalBus'>): Element<PerTaskCtx> {
  return new Leaf<
    PerTaskCtx,
    { readonly sprintId: SprintId; readonly task: Task; readonly expectedBranch: string },
    Task
  >('mark-blocked', {
    useCase: {
      async execute(input) {
        const reason =
          input.expectedBranch.length > 0
            ? `Branch preflight failed: repo not on '${input.expectedBranch}'`
            : 'Branch preflight failed';
        const transitioned = input.task.markBlocked(reason);
        if (!transitioned.ok) return Result.error(transitioned.error);
        const saved = await deps.taskRepo.update(input.sprintId, transitioned.value);
        if (!saved.ok) return Result.error(saved.error);
        deps.signalBus.emit({ type: 'task-finished', taskId: transitioned.value.id, status: 'blocked' });
        return Result.ok(transitioned.value);
      },
    },
    input: (ctx) => ({ sprintId: ctx.sprintId, task: ctx.task, expectedBranch: ctx.expectedBranch }),
    // Set `taskBlocked: true` on the context so the rest of the per-task
    // chain knows to short-circuit. Every downstream leaf checks the flag
    // and no-ops without doing any work — the chain trace still records
    // each step (kept honest) but no further side effects fire.
    output: (ctx, task) => ({ ...ctx, task, taskBlocked: true }),
  });
}

/**
 * `executeTask` `OnError` fallback for user cancellation. Reached only when
 * the kernel surfaces `code: 'aborted'` (SessionManager.kill / Ctrl+C).
 *
 * The task may already be `in_progress` (mark-in-progress ran first) — both
 * states are valid sources for `markBlocked()`. Records "cancelled by user"
 * as the blocked reason so it appears in `tasks.json` / sprint health.
 */
function markCancelledFallbackLeaf(deps: Pick<ChainSharedDeps, 'taskRepo' | 'signalBus'>): Element<PerTaskCtx> {
  return new Leaf<PerTaskCtx, { readonly sprintId: SprintId; readonly task: Task }, Task>('mark-cancelled', {
    useCase: {
      async execute(input) {
        const reason = 'cancelled by user';
        const transitioned = input.task.markBlocked(reason);
        if (!transitioned.ok) return Result.error(transitioned.error);
        const saved = await deps.taskRepo.update(input.sprintId, transitioned.value);
        if (!saved.ok) return Result.error(saved.error);
        deps.signalBus.emit({ type: 'task-finished', taskId: transitioned.value.id, status: 'blocked' });
        return Result.ok(transitioned.value);
      },
    },
    input: (ctx) => ({ sprintId: ctx.sprintId, task: ctx.task }),
    output: (ctx, task) => ({ ...ctx, task, taskBlocked: true }),
  });
}

function markInProgressLeaf(deps: Pick<ChainSharedDeps, 'taskRepo' | 'signalBus'>): Element<PerTaskCtx> {
  return new Leaf<
    PerTaskCtx,
    { readonly sprintId: SprintId; readonly task: Task; readonly taskBlocked: boolean },
    Task
  >('mark-in-progress', {
    useCase: {
      async execute(input) {
        if (input.taskBlocked) return Result.ok(input.task);
        const transitioned = input.task.markInProgress();
        if (!transitioned.ok) return Result.error(transitioned.error);
        const saved = await deps.taskRepo.update(input.sprintId, transitioned.value);
        if (!saved.ok) return Result.error(saved.error);
        deps.signalBus.emit({ type: 'task-started', taskId: transitioned.value.id });
        return Result.ok(transitioned.value);
      },
    },
    input: (ctx) => ({ sprintId: ctx.sprintId, task: ctx.task, taskBlocked: ctx.taskBlocked === true }),
    output: (ctx, task) => ({ ...ctx, task }),
  });
}

function executeTaskLeaf(useCase: ExecuteSingleTaskUseCase): Element<PerTaskCtx> {
  return new Leaf<
    PerTaskCtx,
    {
      readonly sprint: Sprint;
      readonly task: Task;
      readonly cwd: AbsolutePath;
      readonly promptFilePath?: AbsolutePath;
      readonly taskBlocked: boolean;
      readonly executionUnitRoot?: AbsolutePath;
    },
    { readonly outcome: TaskExecutionOutcome; readonly newSessionId?: string }
  >('execute-task', {
    useCase: {
      async execute(input) {
        // Skip the AI spawn entirely when the task is already blocked by
        // an earlier preflight failure — there's nothing to execute.
        if (input.taskBlocked) {
          return Result.ok({ outcome: 'blocked' });
        }
        // Programmer-error guard: the upstream `render-prompt-to-file`
        // leaf must have run by now and stamped the resolved path on
        // the context. If it's missing, fail loudly via a kernel error
        // rather than silently sending the AI an empty wrapper.
        if (input.promptFilePath === undefined) {
          return Result.error({
            code: 'invalid-state',
            message: 'execute-task: promptFilePath is missing — render-prompt-to-file must run first',
          });
        }
        // Per-spawn `session.md` audit path. Each retry attempt OR
        // resume on rate-limit recovery counts as its own round and
        // gets its own `session-N.md` under the execution unit folder
        // so the audit history shows each attempt distinctly. Best-
        // effort: if the unit folder wasn't materialised (build leaf
        // failed and the OnError above this leaf is about to swallow
        // the result anyway), audit is silently skipped.
        const sessionMdPath =
          input.executionUnitRoot !== undefined
            ? AbsolutePath.trustString(await nextSessionPath(String(input.executionUnitRoot)))
            : undefined;
        const result = await useCase.execute({
          sprint: input.sprint,
          task: input.task,
          cwd: input.cwd,
          promptFilePath: String(input.promptFilePath),
          ...(sessionMdPath !== undefined ? { sessionMdPath } : {}),
        });
        if (!result.ok) return Result.error(result.error);
        // Convert the rate-limited outcome into a kernel error so the
        // surrounding `Retry` can match it. Other outcomes (completed,
        // blocked, failed) propagate as success — the per-task chain
        // decides what to do with them via the marker leaves below.
        if (result.value.outcome === 'rate-limited') {
          return Result.error({
            code: 'rate-limited',
            message: result.value.reason ?? 'rate-limit hit during execute-task',
          });
        }
        return Result.ok({
          outcome: result.value.outcome,
          ...(result.value.newSessionId !== undefined ? { newSessionId: result.value.newSessionId } : {}),
        });
      },
    },
    input: (ctx) => ({
      sprint: ctx.sprint,
      task: ctx.task,
      cwd: ctx.cwd,
      ...(ctx.promptFilePath !== undefined ? { promptFilePath: ctx.promptFilePath } : {}),
      taskBlocked: ctx.taskBlocked === true,
      ...(ctx.executionUnitRoot !== undefined ? { executionUnitRoot: ctx.executionUnitRoot } : {}),
    }),
    output: (ctx, out) => ({
      ...ctx,
      outcome: out.outcome,
      ...(out.newSessionId !== undefined ? { newSessionId: out.newSessionId } : {}),
    }),
  });
}

function postTaskCheckLeaf(useCase: PostTaskCheckUseCase): Element<PerTaskCtx> {
  return new Leaf<
    PerTaskCtx,
    { readonly projectPath: AbsolutePath; readonly checkScript?: string; readonly taskBlocked: boolean },
    PostTaskCheckOutput
  >('post-task-check', {
    useCase: {
      async execute(input) {
        if (input.taskBlocked) {
          return Promise.resolve(Result.ok({ passed: true, output: '', skipped: true }));
        }
        if (input.checkScript === undefined || input.checkScript.length === 0) {
          return Promise.resolve(Result.ok({ passed: true, output: '', skipped: true }));
        }
        return useCase.execute({
          projectPath: input.projectPath,
          checkScript: input.checkScript,
        });
      },
    },
    input: (ctx) => ({
      projectPath: ctx.cwd,
      ...(ctx.checkScript !== undefined ? { checkScript: ctx.checkScript } : {}),
      taskBlocked: ctx.taskBlocked === true,
    }),
    output: (ctx, checkResult) => ({ ...ctx, checkResult }),
  });
}

function markDoneLeaf(deps: Pick<ChainSharedDeps, 'taskRepo' | 'logger' | 'signalBus'>): Element<PerTaskCtx> {
  return new Leaf<
    PerTaskCtx,
    {
      readonly sprintId: SprintId;
      readonly task: Task;
      readonly outcome?: TaskExecutionOutcome;
      readonly taskBlocked: boolean;
    },
    Task
  >('mark-done', {
    useCase: {
      async execute(input) {
        // Already blocked upstream — the markBlocked fallback already
        // transitioned the task and emitted `task-finished`. No-op here.
        if (input.taskBlocked) return Result.ok(input.task);
        // Mark-done semantics: by the time we reach this leaf the
        // per-task chain has already run preflight, the AI session,
        // post-task check, and the (non-blocking) evaluator. The work
        // has either been done or the chain would have aborted. We
        // mark done unless something explicitly negative happened:
        //
        //   - outcome === 'blocked'        — AI emitted <task-blocked>
        //   - evaluationStatus === 'failed'    — evaluator caught a real
        //                                        regression
        //   - evaluationStatus === 'malformed' — evaluator output was
        //                                        unparseable; conservative
        //                                        no-op for human review
        //
        // Note: outcome === 'failed' historically meant "AI did not
        // emit <task-complete>". In practice agents complete the work
        // but occasionally drop the closing tag — leaving such tasks
        // in_progress strands the sprint. Marking done here is safe
        // because the evaluator runs immediately before this leaf and
        // would have flagged a regression as `failed` / `malformed`.
        // (See `evaluateLoopLeaf` above, which always runs and writes
        // `evaluationStatus` onto `ctx.task`.) `outcome === 'completed'`
        // is the explicit happy path.
        //
        // 'rate-limited' never reaches here — Retry surfaces it as a
        // kernel error so this leaf doesn't run on a rate-limited run.
        if (input.outcome === 'blocked') {
          // AI emitted <task-blocked> — mirror that on the bus so the
          // live execute view flips the task pill from RUNNING to BLOCKED.
          deps.signalBus.emit({ type: 'task-finished', taskId: input.task.id, status: 'blocked' });
          return Result.ok(input.task);
        }
        const transitioned = input.task.markDone();
        if (!transitioned.ok) return Result.error(transitioned.error);
        const saved = await deps.taskRepo.update(input.sprintId, transitioned.value);
        if (!saved.ok) return Result.error(saved.error);
        // Milestone — surface task completion as a success-level log so
        // the live execute view's "Recent events" panel renders it
        // visibly distinct from routine `[INFO]` progress lines.
        deps.logger.success(
          `task ${String(transitioned.value.id)} completed${formatNameSuffix(transitioned.value.name)}`,
          {
            sprintId: input.sprintId,
            taskId: transitioned.value.id,
          }
        );
        deps.signalBus.emit({ type: 'task-finished', taskId: transitioned.value.id, status: 'completed' });
        return Result.ok(transitioned.value);
      },
    },
    input: (ctx) => ({
      sprintId: ctx.sprintId,
      task: ctx.task,
      ...(ctx.outcome !== undefined ? { outcome: ctx.outcome } : {}),
      taskBlocked: ctx.taskBlocked === true,
    }),
    output: (ctx, task) => ({ ...ctx, task }),
  });
}

/**
 * Render a task name slice for success log messages — appending the name
 * makes the recent-events panel scannable. Mirrors the same helper in
 * `execute-single-task.ts` and `refine-single-ticket.ts`.
 */
function formatNameSuffix(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '';
  const max = 50;
  const slice = trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
  return ` — "${slice}"`;
}

/**
 * Run the multi-round evaluate-and-fix loop, then persist the verdict on
 * the Task aggregate. Persistence happens here rather than inside the
 * loop so the loop stays a pure orchestrator (chain-layer concern: side
 * effects on entities the chain owns).
 */
const MAX_PREVIEW_CHARS = 2000;

function evaluateLoopLeaf(
  deps: Pick<ChainSharedDeps, 'taskRepo' | 'sessionFolderBuilder' | 'aiSession'>,
  loop: EvaluateAndFixLoopUseCase
): Element<PerTaskCtx> {
  return new Leaf<
    PerTaskCtx,
    {
      readonly sprintId: SprintId;
      readonly sprint: Sprint;
      readonly task: Task;
      readonly tasks: readonly Task[];
      readonly cwd: AbsolutePath;
      readonly promptFilePath?: AbsolutePath;
      readonly checkScript?: string;
      readonly resumeSessionId?: string;
      readonly taskBlocked: boolean;
      readonly executionUnitRoot?: AbsolutePath;
      readonly executionAddDirs?: readonly AbsolutePath[];
      readonly executionSessionCwd?: AbsolutePath;
      readonly executionEvaluationMdPath?: AbsolutePath;
    },
    { readonly evaluation?: EvaluateAndFixLoopOutput; readonly task: Task }
  >('evaluate-task', {
    useCase: {
      async execute(input) {
        if (input.taskBlocked) {
          return Result.ok({ task: input.task });
        }
        // Read the per-task bullet from the execution unit's done-criteria.md.
        // Best-effort — returns '' when absent or unreadable.
        const doneCriteriaBullet =
          input.executionUnitRoot !== undefined
            ? await readDoneCriteriaBullet(
                join(String(input.executionUnitRoot), 'done-criteria.md'),
                String(input.task.id)
              )
            : '';
        // Programmer-error guard — the upstream `render-prompt-to-file`
        // leaf must have set this. The fix-and-reeval loop re-spawns
        // the generator, which needs the same execute-prompt file path.
        if (input.promptFilePath === undefined) {
          return Result.error({
            code: 'invalid-state',
            message: 'evaluate-task: promptFilePath is missing — render-prompt-to-file must run first',
          });
        }
        // The render-prompt-to-file leaf already wrote the execute prompt
        // under `<sprintDir>/contexts/`; derive the directory from the
        // stamped path so the chain doesn't re-resolve storage paths.
        const contextsDir = AbsolutePath.trustString(dirname(String(input.promptFilePath)));

        // Build a `refreshWorkspace` closure when an evaluate workspace
        // was mounted upstream. The closure recomputes `priorEvaluations`
        // from the live task list each call so a sibling that finishes
        // mid-sprint surfaces in the next round's contract pack. When
        // the workspace wasn't mounted (e.g. `build-evaluate-workspace`
        // failed and the OnError wrapper is about to swallow this leaf
        // anyway, or the standalone evaluate chain), refresh is a no-op
        // and the loop skips it. The workspace root is captured by
        // value — refresh works against the root that was already laid
        // down, which is the contract for `refreshEvaluateWorkspace`.
        const unitMounted = input.executionUnitRoot !== undefined;
        const refreshWorkspace = unitMounted
          ? async (): Promise<Result<void, DomainError>> => {
              await deps.aiSession.ensureReady();
              const aiProvider = deps.aiSession.getProviderName();
              const priorEvaluations = collectPriorEvaluations(input.tasks);
              return deps.sessionFolderBuilder.refreshExecutionUnit({
                sprint: input.sprint,
                tasks: input.tasks,
                task: input.task,
                aiProvider,
                priorEvaluations,
              });
            }
          : undefined;

        // Per-spawn `session.md` audit path provider for the multi-round
        // loop. Both evaluator and generator (fix-attempt) rounds get
        // their own `session-N.md` under the per-task execution unit
        // folder so the user can audit every round individually. The
        // file basename is monotonic across kinds — interleaving the
        // counter is an explicit decision so chronological order is
        // preserved on disk; the frontmatter records `provider`/`flags`
        // and the body shows the prompt, which together disambiguate
        // generator vs evaluator without filename suffixes. When no
        // unit folder was materialised (build failed) the closure
        // returns undefined and audit is skipped.
        const unitRoot = input.executionUnitRoot;
        const nextSessionMdPath = unitRoot
          ? async (): Promise<AbsolutePath | undefined> =>
              AbsolutePath.trustString(await nextSessionPath(String(unitRoot)))
          : undefined;

        const result = await loop.execute({
          task: input.task,
          sprint: input.sprint,
          cwd: input.cwd,
          executePromptFilePath: String(input.promptFilePath),
          contextsDir,
          ...(input.checkScript !== undefined ? { checkScript: input.checkScript } : {}),
          ...(input.resumeSessionId !== undefined ? { resumeSessionId: input.resumeSessionId } : {}),
          ...(input.executionAddDirs !== undefined ? { addDirs: input.executionAddDirs } : {}),
          ...(input.executionSessionCwd !== undefined ? { evaluateSessionCwd: input.executionSessionCwd } : {}),
          ...(input.executionUnitRoot !== undefined ? { evaluateWorkspaceDir: String(input.executionUnitRoot) } : {}),
          ...(refreshWorkspace !== undefined ? { refreshWorkspace } : {}),
          ...(nextSessionMdPath !== undefined ? { nextSessionMdPath } : {}),
          ...(doneCriteriaBullet.length > 0 ? { doneCriteriaBullet } : {}),
        });
        if (!result.ok) return Result.error(result.error);

        // Persist the verdict on the Task aggregate. Skipped when the
        // evaluator was disabled (rounds === 0) — the task entity's
        // `evaluated` flag stays false so consumers can tell.
        if (result.value.rounds > 0 && result.value.finalSignal !== null) {
          // Evaluation file lives at `execution/<unit-slug>/evaluation.md`.
          // Persist the absolute path stamped by the build leaf when present;
          // fall back to a best-effort relative path keyed on the task id
          // when no unit was mounted (e.g. standalone evaluate chain).
          const recorded = input.task.recordEvaluation({
            status: result.value.finalSignal.status,
            output: result.value.finalCritique.slice(0, MAX_PREVIEW_CHARS),
            file:
              input.executionEvaluationMdPath !== undefined
                ? String(input.executionEvaluationMdPath)
                : `execution/${String(input.task.id)}/evaluation.md`,
          });
          const saved = await deps.taskRepo.update(input.sprintId, recorded);
          if (!saved.ok) return Result.error(saved.error);
          return Result.ok({ evaluation: result.value, task: recorded });
        }
        return Result.ok({ evaluation: result.value, task: input.task });
      },
    },
    input: (ctx) => ({
      sprintId: ctx.sprintId,
      sprint: ctx.sprint,
      task: ctx.task,
      tasks: ctx.tasks ?? [],
      cwd: ctx.cwd,
      ...(ctx.promptFilePath !== undefined ? { promptFilePath: ctx.promptFilePath } : {}),
      ...(ctx.checkScript !== undefined ? { checkScript: ctx.checkScript } : {}),
      ...(ctx.newSessionId !== undefined ? { resumeSessionId: ctx.newSessionId } : {}),
      taskBlocked: ctx.taskBlocked === true,
      ...(ctx.executionUnitRoot !== undefined ? { executionUnitRoot: ctx.executionUnitRoot } : {}),
      ...(ctx.executionAddDirs !== undefined ? { executionAddDirs: ctx.executionAddDirs } : {}),
      ...(ctx.executionSessionCwd !== undefined ? { executionSessionCwd: ctx.executionSessionCwd } : {}),
      ...(ctx.executionEvaluationMdPath !== undefined
        ? { executionEvaluationMdPath: ctx.executionEvaluationMdPath }
        : {}),
    }),
    // Push the recorded task back onto the context so the downstream
    // `mark-done` leaf carries the evaluation forward when it flips
    // to `done`.
    output: (ctx, out) =>
      out.evaluation === undefined
        ? { ...ctx, task: out.task }
        : { ...ctx, task: out.task, evaluation: out.evaluation },
  });
}

/**
 * Collect prior task evaluations from the sprint's task list — same
 * predicate as `build-evaluate-workspace.collectPriorEvaluations`, kept
 * in sync so the per-round refresh doesn't surface a different set of
 * priors than the initial build laid down.
 */
function collectPriorEvaluations(tasks: readonly Task[]): ReadonlyMap<TaskId, string> {
  const map = new Map<TaskId, string>();
  for (const t of tasks) {
    if (t.evaluated && t.evaluationOutput !== undefined && t.evaluationOutput.length > 0) {
      map.set(t.id, t.evaluationOutput);
    }
  }
  return map;
}

/**
 * `commit-task` — captures the work the AI just did into a single commit
 * AFTER the evaluator round settles. Commits sit between the evaluator
 * and `mark-done` so:
 *
 *  - the evaluator sees the dirty tree (its `git status` Completeness
 *    signal works as designed — see `dimensions.md`), and
 *  - the user's history shows one clean commit per task with a meaningful
 *    message instead of having to manually stage at the end of a sprint.
 *
 * Skip conditions (no commit, no log, leaf returns the ctx unchanged):
 *  - `ctx.taskBlocked === true` — branch preflight or user cancellation
 *    already short-circuited the work.
 *  - `ctx.noCommit === true` — explicit launcher opt-out.
 *  - working tree is clean (the AI emitted no file changes, or already
 *    committed itself).
 *
 * Commit failures do NOT abort the chain — the leaf logs a warning and
 * resolves OK. A failed commit shouldn't strand a task whose work is
 * otherwise complete; the user can recover by committing manually.
 */
function commitTaskLeaf(deps: Pick<ChainSharedDeps, 'taskRepo' | 'external' | 'logger'>): Element<PerTaskCtx> {
  return new Leaf<
    PerTaskCtx,
    {
      readonly sprintId: SprintId;
      readonly task: Task;
      readonly cwd: AbsolutePath;
      readonly taskBlocked: boolean;
      readonly noCommit: boolean;
    },
    Task
  >('commit-task', {
    useCase: {
      async execute(input) {
        if (input.taskBlocked) return Result.ok(input.task);
        if (input.noCommit) return Result.ok(input.task);
        if (!deps.external.hasUncommittedChanges(input.cwd)) {
          return Result.ok(input.task);
        }

        const message = buildCommitMessage(input.task);
        const committed = await deps.external.commitChanges(input.cwd, message);
        if (!committed.ok) {
          // Commit failure is non-fatal — log and continue so mark-done
          // still runs. Distinguish a clean tree (already handled above
          // but races / .gitignore edge cases can still surface it) from
          // a real I/O error so the warning is meaningful.
          const subCode = 'subCode' in committed.error ? committed.error.subCode : 'unknown';
          deps.logger.warn(`commit-task: failed to commit task ${String(input.task.id)} (${subCode})`, {
            taskId: String(input.task.id),
            error: committed.error.message,
          });
          return Result.ok(input.task);
        }

        const sha = committed.value;
        const recorded = input.task.recordCommit(sha);
        const saved = await deps.taskRepo.update(input.sprintId, recorded);
        if (!saved.ok) {
          // Persistence failure on the SHA is non-fatal too — the commit
          // itself is already on disk, only the metadata pointer failed.
          deps.logger.warn(`commit-task: committed task ${String(input.task.id)} but failed to persist SHA`, {
            taskId: String(input.task.id),
            sha,
            error: saved.error.message,
          });
          return Result.ok(recorded);
        }
        deps.logger.success(`committed task ${String(input.task.id)} as ${sha.slice(0, 7)}`, {
          sprintId: String(input.sprintId),
          taskId: String(input.task.id),
          sha,
        });
        return Result.ok(recorded);
      },
    },
    input: (ctx) => ({
      sprintId: ctx.sprintId,
      task: ctx.task,
      cwd: ctx.cwd,
      taskBlocked: ctx.taskBlocked === true,
      noCommit: ctx.noCommit === true,
    }),
    output: (ctx, task) => ({ ...ctx, task }),
  });
}

/**
 * Identity leaf — used as an `OnError` fallback so an evaluator failure
 * resolves the chain step with the original context. The evaluator
 * never blocks task completion (REQUIREMENTS.md).
 */
function noopLeaf<TCtx>(name: string): Element<TCtx> {
  return new Leaf<TCtx, TCtx, TCtx>(name, {
    useCase: {
      execute(input) {
        return Promise.resolve(Result.ok(input)) as Promise<Result<TCtx, KernelError>>;
      },
    },
    input: (ctx) => ctx,
    output: (_, ctx) => ctx,
  });
}
