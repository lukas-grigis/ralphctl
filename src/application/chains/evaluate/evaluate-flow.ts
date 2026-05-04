/**
 * `createEvaluateFlow` — chain definition for a standalone evaluator
 * round on a single, already-settled task.
 *
 * Steps (happy path):
 *
 *   load-sprint → assert-active → load-task → check-already-evaluated →
 *     render-prompt-to-file → evaluate-task → persist-evaluation
 *
 * Used standalone by the `sprint evaluate` command. The per-task
 * chain inside `executeFlow` runs the multi-round
 * `EvaluateAndFixLoopUseCase` directly (which manages its own per-round
 * prompt rendering); this chain is the single-round equivalent for
 * one-shot evaluator runs.
 *
 * `render-prompt-to-file` writes the FULL evaluator prompt (task body,
 * verification criteria, harness context, signal vocabulary) to
 * `<sprintDir>/contexts/evaluate-<task-id>.md`. The downstream
 * `evaluate-task` leaf hands the AI a thin wrapper pointing at that
 * file.
 *
 * The use case **never blocks**: a malformed / failed evaluation still
 * resolves successfully so the surrounding chain can continue. The
 * `persist-evaluation` step records the verdict on the task entity.
 */
import { Result } from '@src/domain/result.ts';

import { EvaluateTaskUseCase, type EvaluationOutcome } from '@src/business/usecases/evaluate/evaluate-task.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import { Sequential } from '@src/kernel/chain/sequential.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';
import { assertActiveLeaf } from '@src/application/chains/leaves/assert-active.ts';
import { loadSprintLeaf } from '@src/application/chains/leaves/load-sprint.ts';
import { renderPromptToFileLeaf } from '@src/application/chains/leaves/render-prompt-to-file.ts';
import { readDoneCriteriaBullet } from '@src/integration/persistence/done-criteria-reader.ts';
import { resolveStoragePaths } from '@src/integration/persistence/storage-paths.ts';

export interface EvaluateCtx {
  readonly sprintId: SprintId;
  readonly taskId: TaskId;
  readonly cwd: AbsolutePath;
  readonly previousCritique?: string;
  readonly sprint?: Sprint;
  readonly task?: Task;
  readonly evaluationOutcome?: EvaluationOutcome;
  readonly evaluationCritique?: string;
  /**
   * Resolved evaluator prompt file path. Set by `render-prompt-to-file`;
   * consumed by `evaluate-task`.
   */
  readonly promptFilePath?: AbsolutePath;
  /**
   * Set to `true` by `check-already-evaluated` when the task already
   * carries a recorded verdict. Every downstream leaf (render-prompt,
   * evaluate-task, persist-evaluation) checks the flag and short-circuits
   * as a no-op so the chain trace stays honest while skipping the work.
   *
   * The evaluator never blocks (REQUIREMENTS.md): re-running
   * `sprint evaluate <task>` on an already-evaluated task must complete
   * successfully, not return a `NotFoundError`.
   */
  readonly skipEvaluation?: boolean;
}

export function createEvaluateFlow(
  deps: Pick<
    ChainSharedDeps,
    | 'sprintRepo'
    | 'taskRepo'
    | 'aiSession'
    | 'prompts'
    | 'signalParser'
    | 'logger'
    | 'writeContextFile'
    | 'signalHandler'
  >
): Element<EvaluateCtx> {
  const useCase = new EvaluateTaskUseCase(deps.aiSession, deps.signalParser, deps.logger, deps.signalHandler);

  const renderPromptStep = renderPromptToFileLeaf<EvaluateCtx>(
    { writeContextFile: deps.writeContextFile },
    {
      flowName: 'evaluate',
      identifier: (ctx) => String(ctx.taskId),
      // `check-already-evaluated` may flip `skipEvaluation: true` upstream
      // when the task carries a recorded verdict. The render-prompt-to-file
      // leaf honours the flag — no point writing an evaluator prompt we
      // never plan to spawn.
      skip: (ctx) => ctx.skipEvaluation === true,
      buildPrompt: async (ctx) => {
        if (!ctx.sprint) throw new Error('render-prompt-to-file: ctx.sprint must be loaded first');
        if (!ctx.task) throw new Error('render-prompt-to-file: ctx.task must be loaded first');
        // Read the per-task bullet from the sprint-level done-criteria.md.
        // Best-effort — returns '' when absent (legacy sprint / no plan run).
        const storage = resolveStoragePaths();
        const criteriaPath = String(storage.doneCriteriaFile(ctx.sprint.id));
        const doneCriteriaBullet = await readDoneCriteriaBullet(criteriaPath, String(ctx.task.id));
        return deps.prompts.buildEvaluatePrompt({
          task: ctx.task,
          sprint: ctx.sprint,
          ...(ctx.previousCritique !== undefined ? { previousCritique: ctx.previousCritique } : {}),
          ...(doneCriteriaBullet.length > 0 ? { doneCriteriaBullet } : {}),
        });
      },
    }
  );

  return new Sequential<EvaluateCtx>('evaluate', [
    loadSprintLeaf<EvaluateCtx>({ sprintRepo: deps.sprintRepo }),
    assertActiveLeaf<EvaluateCtx>('evaluate'),
    loadTaskLeaf(deps),
    checkAlreadyEvaluatedLeaf(),
    renderPromptStep,
    evaluateTaskLeaf(useCase),
    persistEvaluationLeaf(deps),
  ]);
}

/** Build a load-task leaf for the evaluate flow's per-task pipeline. */
function loadTaskLeaf(deps: Pick<ChainSharedDeps, 'taskRepo'>): Element<EvaluateCtx> {
  return new Leaf<EvaluateCtx, { readonly sprintId: SprintId; readonly taskId: TaskId }, Task>('load-task', {
    useCase: {
      async execute(input) {
        return deps.taskRepo.findById(input.sprintId, input.taskId);
      },
    },
    input: (ctx) => ({ sprintId: ctx.sprintId, taskId: ctx.taskId }),
    output: (ctx, task) => ({ ...ctx, task }),
  });
}

/**
 * Skip-out leaf — flips `ctx.skipEvaluation = true` when the task already
 * carries a recorded verdict so downstream leaves no-op as a courtesy.
 * Re-running `sprint evaluate <task>` on an already-evaluated task must
 * complete successfully (REQUIREMENTS.md: the evaluator never blocks),
 * not abort with a `NotFoundError`.
 *
 * The trace still records the step so callers can see why the rest of
 * the chain skipped its work — every downstream leaf still emits its
 * own trace entry as a no-op.
 */
function checkAlreadyEvaluatedLeaf(): Element<EvaluateCtx> {
  return new Leaf<EvaluateCtx, { readonly task: Task }, { readonly skipEvaluation: boolean }>(
    'check-already-evaluated',
    {
      useCase: {
        async execute(input) {
          return Promise.resolve(Result.ok({ skipEvaluation: input.task.evaluated }));
        },
      },
      input: (ctx) => {
        if (!ctx.task) throw new Error('check-already-evaluated: ctx.task must be loaded');
        return { task: ctx.task };
      },
      output: (ctx, out) => ({ ...ctx, skipEvaluation: out.skipEvaluation }),
    }
  );
}

function evaluateTaskLeaf(useCase: EvaluateTaskUseCase): Element<EvaluateCtx> {
  return new Leaf<
    EvaluateCtx,
    {
      readonly sprint: Sprint;
      readonly task: Task;
      readonly cwd: AbsolutePath;
      readonly promptFilePath?: AbsolutePath;
      readonly skipEvaluation: boolean;
    },
    { readonly outcome?: EvaluationOutcome; readonly fullCritique?: string }
  >('evaluate-task', {
    useCase: {
      async execute(input) {
        // No-op when an upstream `check-already-evaluated` flagged the
        // task as already evaluated. Re-running `sprint evaluate` on a
        // settled task must complete successfully without burning a
        // fresh AI spawn (REQUIREMENTS.md: evaluator never blocks).
        if (input.skipEvaluation) {
          return Result.ok({});
        }
        if (!input.promptFilePath) {
          throw new Error('evaluate-task: ctx.promptFilePath must be set by render-prompt-to-file');
        }
        // Standalone evaluate has no per-task execution unit folder
        // (the per-task chain inside executeFlow owns that folder), so
        // we derive a stable session.md path under the sprint dir
        // keyed on the task id. Each invocation of
        // `sprint evaluate <task>` overwrites the prior file; the
        // standalone command is a one-shot, not a loop.
        const { resolveStoragePaths } = await import('@src/integration/persistence/storage-paths.ts');
        const { join } = await import('node:path');
        const sprintDir = resolveStoragePaths().sprintDir(input.sprint.id);
        const { AbsolutePath: APV } = await import('@src/domain/values/absolute-path.ts');
        const sessionMdPath = APV.trustString(join(sprintDir, 'evaluations', `session-${String(input.task.id)}.md`));
        const result = await useCase.execute({
          sprint: input.sprint,
          task: input.task,
          cwd: input.cwd,
          promptFilePath: String(input.promptFilePath),
          sessionMdPath,
        });
        if (!result.ok) return Result.error(result.error);
        return Result.ok({ outcome: result.value.outcome, fullCritique: result.value.fullCritique });
      },
    },
    input: (ctx) => {
      if (!ctx.sprint) throw new Error('evaluate-task: ctx.sprint must be loaded');
      if (!ctx.task) throw new Error('evaluate-task: ctx.task must be loaded');
      return {
        sprint: ctx.sprint,
        task: ctx.task,
        cwd: ctx.cwd,
        ...(ctx.promptFilePath !== undefined ? { promptFilePath: ctx.promptFilePath } : {}),
        skipEvaluation: ctx.skipEvaluation === true,
      };
    },
    output: (ctx, out) =>
      out.outcome === undefined
        ? ctx
        : {
            ...ctx,
            evaluationOutcome: out.outcome,
            evaluationCritique: out.fullCritique ?? '',
          },
  });
}

const MAX_PREVIEW_CHARS = 2000;

/**
 * Persist the evaluator outcome on the Task aggregate. Records the
 * preview (≤2000 chars) plus the resolved verdict; full critique would
 * be persisted to a sidecar file by an integration adapter outside this
 * chain (the legacy `evaluations/<taskId>.md` writer).
 */
function persistEvaluationLeaf(deps: Pick<ChainSharedDeps, 'taskRepo'>): Element<EvaluateCtx> {
  return new Leaf<
    EvaluateCtx,
    {
      readonly sprintId: SprintId;
      readonly task: Task;
      readonly outcome?: EvaluationOutcome;
      readonly critique: string;
      readonly skipEvaluation: boolean;
    },
    void
  >('persist-evaluation', {
    useCase: {
      async execute(input) {
        // No-op when the task was already evaluated upstream — there's
        // no fresh verdict to persist.
        if (input.skipEvaluation) return Result.ok(undefined);
        if (input.outcome === undefined) {
          throw new Error('persist-evaluation: ctx.evaluationOutcome must be set');
        }
        const recorded = input.task.recordEvaluation({
          status: input.outcome,
          output: input.critique.slice(0, MAX_PREVIEW_CHARS),
          file: `execution/${String(input.task.id)}/evaluation.md`,
        });
        return deps.taskRepo.update(input.sprintId, recorded);
      },
    },
    input: (ctx) => {
      if (!ctx.task) throw new Error('persist-evaluation: ctx.task must be loaded');
      return {
        sprintId: ctx.sprintId,
        task: ctx.task,
        ...(ctx.evaluationOutcome !== undefined ? { outcome: ctx.evaluationOutcome } : {}),
        critique: ctx.evaluationCritique ?? '',
        skipEvaluation: ctx.skipEvaluation === true,
      };
    },
    output: (ctx) => ctx,
  });
}
