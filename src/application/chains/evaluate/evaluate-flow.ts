/**
 * `createEvaluateFlow` — chain definition for a standalone evaluator
 * round on a single, already-settled task.
 *
 * Steps (happy path):
 *
 *   load-sprint → load-task → check-already-evaluated →
 *     evaluate-task → persist-evaluation
 *
 * Used standalone by the `sprint evaluate` command and embedded inside
 * the per-task flow (see `execute/per-task-flow.ts`) for the
 * post-settlement evaluator gate.
 *
 * SIMPLIFICATION: the multi-iteration fix-and-re-evaluate loop is **not**
 * built into this chain yet. The brief calls for `evaluationIterations`
 * rounds with plateau detection — the legacy implementation lives in
 * `business/usecases/evaluate/` and is invoked once per call here. The
 * loop will be re-introduced once `forEachItem` (or an explicit Loop
 * primitive) exists in the kernel; until then the chain runs one round.
 *
 * The use case **never blocks**: a malformed / failed evaluation still
 * resolves successfully so the surrounding chain can continue. The
 * `persist-evaluation` step records the verdict on the task entity.
 */
import { Result } from '@src/domain/result.ts';

import { EvaluateTaskUseCase, type EvaluationOutcome } from '@src/business/usecases/evaluate/evaluate-task.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import { NotFoundError } from '@src/domain/errors/not-found-error.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import { Sequential } from '@src/kernel/chain/sequential.ts';
import type { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';
import { loadSprintLeaf } from '@src/application/chains/leaves/load-sprint.ts';

export interface EvaluateCtx {
  readonly sprintId: SprintId;
  readonly taskId: TaskId;
  readonly cwd: AbsolutePath;
  readonly previousCritique?: string;
  readonly sprint?: Sprint;
  readonly task?: Task;
  readonly evaluationOutcome?: EvaluationOutcome;
  readonly evaluationCritique?: string;
}

export interface CreateEvaluateFlowOpts {
  readonly sprintId: SprintId;
  readonly taskId: TaskId;
  readonly cwd: AbsolutePath;
  readonly previousCritique?: string;
}

export function createEvaluateFlow(
  deps: Pick<ChainSharedDeps, 'sprintRepo' | 'taskRepo' | 'aiSession' | 'prompts' | 'signalParser' | 'logger'>,
  _opts: CreateEvaluateFlowOpts
): Element<EvaluateCtx> {
  void _opts;
  const useCase = new EvaluateTaskUseCase(deps.aiSession, deps.prompts, deps.signalParser, deps.logger);

  return new Sequential<EvaluateCtx>('evaluate', [
    loadSprintLeaf<EvaluateCtx>({ sprintRepo: deps.sprintRepo }),
    loadTaskLeaf(deps),
    checkAlreadyEvaluatedLeaf(),
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
 * Skip-out leaf — surfaces an early `not-found` so re-running an
 * already-evaluated task doesn't burn another AI spawn. The chain
 * trace still records the step so callers see the reason for the
 * short-circuit.
 *
 * This is the only step that intentionally fails the chain on a
 * **business** condition rather than a true error. Wrap the chain in
 * `OnError` if the caller wants to treat already-evaluated as a no-op
 * success.
 */
function checkAlreadyEvaluatedLeaf(): Element<EvaluateCtx> {
  return new Leaf<EvaluateCtx, { readonly task: Task }, void>('check-already-evaluated', {
    useCase: {
      async execute(input) {
        if (input.task.evaluated) {
          return Promise.resolve(
            Result.error(
              new NotFoundError({
                entity: 'unevaluated-task',
                id: input.task.id,
                message: `task ${input.task.id} has already been evaluated`,
              })
            )
          );
        }
        return Promise.resolve(Result.ok(undefined));
      },
    },
    input: (ctx) => {
      if (!ctx.task) throw new Error('check-already-evaluated: ctx.task must be loaded');
      return { task: ctx.task };
    },
    output: (ctx) => ctx,
  });
}

function evaluateTaskLeaf(useCase: EvaluateTaskUseCase): Element<EvaluateCtx> {
  return new Leaf<
    EvaluateCtx,
    {
      readonly sprint: Sprint;
      readonly task: Task;
      readonly cwd: AbsolutePath;
      readonly previousCritique?: string;
    },
    { readonly outcome: EvaluationOutcome; readonly fullCritique: string }
  >('evaluate-task', {
    useCase: {
      async execute(input) {
        const result = await useCase.execute({
          sprint: input.sprint,
          task: input.task,
          cwd: input.cwd,
          ...(input.previousCritique !== undefined ? { previousCritique: input.previousCritique } : {}),
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
        ...(ctx.previousCritique !== undefined ? { previousCritique: ctx.previousCritique } : {}),
      };
    },
    output: (ctx, out) => ({
      ...ctx,
      evaluationOutcome: out.outcome,
      evaluationCritique: out.fullCritique,
    }),
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
      readonly outcome: EvaluationOutcome;
      readonly critique: string;
    },
    void
  >('persist-evaluation', {
    useCase: {
      async execute(input) {
        const recorded = input.task.recordEvaluation({
          status: input.outcome,
          output: input.critique.slice(0, MAX_PREVIEW_CHARS),
          file: `evaluations/${input.task.id}.md`,
        });
        return deps.taskRepo.update(input.sprintId, recorded);
      },
    },
    input: (ctx) => {
      if (!ctx.task) throw new Error('persist-evaluation: ctx.task must be loaded');
      if (ctx.evaluationOutcome === undefined) {
        throw new Error('persist-evaluation: ctx.evaluationOutcome must be set');
      }
      return {
        sprintId: ctx.sprintId,
        task: ctx.task,
        outcome: ctx.evaluationOutcome,
        critique: ctx.evaluationCritique ?? '',
      };
    },
    output: (ctx) => ctx,
  });
}
