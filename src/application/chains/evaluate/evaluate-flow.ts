/**
 * `createEvaluateFlow` — chain definition for a standalone evaluator
 * round on a single, already-settled task.
 *
 * Steps (happy path):
 *
 *   load-sprint → assert-active → load-task → render-prompt-to-file →
 *     evaluate-task → persist-evaluation
 *
 * Used standalone by the `sprint evaluate` command. The per-task
 * chain inside `executeFlow` runs the multi-round
 * `EvaluateAndFixLoopUseCase` directly (which manages its own per-round
 * prompt rendering); this chain is the single-round equivalent for
 * one-shot evaluator runs.
 *
 * Re-runs are allowed: every invocation creates a fresh
 * `<sprintDir>/execution/<unit-slug>/rounds/standalone-<ISO>/evaluator/`
 * folder so prior verdicts are preserved as durable history. Each
 * standalone-round path is unique by ISO, so `Task.evaluationFile` is
 * stamped to the verdict file inside the current run's folder — no
 * pointer-file indirection needed.
 *
 * `render-prompt-to-file` writes the evaluator prompt to the standalone
 * round's `prompt.md`. The downstream `evaluate-task` leaf hands the AI
 * a thin wrapper pointing at that file.
 *
 * The use case **never blocks**: a malformed / failed evaluation still
 * resolves successfully so the surrounding chain can continue. The
 * `persist-evaluation` step records the verdict on the task entity.
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { Result } from '@src/domain/result.ts';

import { EvaluateTaskUseCase, type EvaluationOutcome } from '@src/business/usecases/evaluate/evaluate-task.ts';
import type { Sprint } from '@src/domain/entities/sprint.ts';
import type { Task } from '@src/domain/entities/task.ts';
import type { Element } from '@src/kernel/chain/element.ts';
import { Leaf } from '@src/kernel/chain/leaf.ts';
import { Sequential } from '@src/kernel/chain/sequential.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import type { TaskId } from '@src/domain/values/task-id.ts';
import type { ChainSharedDeps } from '@src/application/chains/chain-deps.ts';
import { assertActiveLeaf } from '@src/application/chains/leaves/assert-active.ts';
import { loadSprintLeaf } from '@src/application/chains/leaves/load-sprint.ts';
import { renderPromptToFileLeaf } from '@src/application/chains/leaves/render-prompt-to-file.ts';
import { readDoneCriteriaBullet } from '@src/integration/persistence/done-criteria-reader.ts';
import { resolveStoragePaths } from '@src/integration/persistence/storage-paths.ts';
import {
  standaloneEvaluatorVerdictSprintRelative,
  standaloneRoundDir,
} from '@src/kernel/algorithms/execution-round-paths.ts';
import { unitSlug } from '@src/integration/persistence/unit-slug.ts';

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
   * Relative path (under the sprint dir) of the verdict file this run
   * wrote on disk — `execution/<unit-slug>/rounds/standalone-<ISO>/
   * evaluator/evaluation.md`. Stamped by `evaluate-task` and read by
   * `persist-evaluation` so the recorded `Task.evaluationFile`
   * reliably points at a file that exists.
   */
  readonly evaluationFile?: string;
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

  // One folder-token per chain factory call → one folder per
  // `sprint evaluate <task>` invocation. The token is `<ISO>-<rand4>`
  // — millisecond ISO plus a 4-hex-char random suffix so two
  // same-process invocations within the same millisecond can't collide
  // on the same `rounds/standalone-<token>/` folder. Computed eagerly
  // so `render-prompt-to-file` and `evaluate-task` resolve to the same
  // path within this run. Suffix entropy is 16⁴ ≈ 65k — collision odds
  // are well below the noise floor for human-driven evaluator runs and
  // `randomBytes` keeps us off `Math.random` for consistency with the
  // rest of the codebase.
  const iso = `${String(IsoTimestamp.now()).replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`;

  /**
   * Resolve the standalone-round evaluator folder for this invocation.
   * Each `sprint evaluate <task>` call gets a fresh
   * `<unit>/rounds/standalone-<ISO>/evaluator/` subtree so prior
   * verdicts persist as durable history. `iso` is captured per chain
   * factory call so `render-prompt-to-file` and `evaluate-task` resolve
   * identical paths within a single run, and a fresh factory call gives
   * a fresh `iso`.
   *
   * Pure path computation — `WriteContextFilePort` and the AI session
   * adapter both mkdir their parent dirs, so the caller does not need
   * to ensure the directory before writing.
   */
  const standaloneEvaluatorDir = (sprintId: SprintId, task: Task): string => {
    const storage = resolveStoragePaths();
    const slug = unitSlug(String(task.id), task.name);
    const unitRoot = String(storage.executionUnitDir(sprintId, slug));
    return join(standaloneRoundDir(unitRoot, iso), 'evaluator');
  };

  const renderPromptStep = renderPromptToFileLeaf<EvaluateCtx>(
    { writeContextFile: deps.writeContextFile },
    {
      flowName: 'evaluate',
      identifier: (ctx) => String(ctx.taskId),
      // Standalone evaluate routes the prompt under the standalone-round
      // folder so each invocation lays down a fresh, distinct artefact
      // pack alongside its prior siblings. `WriteContextFilePort.write`
      // mkdir's its parent directory, so we only need to compute the
      // path here.
      path: (ctx) => {
        if (!ctx.sprint) throw new Error('render-prompt-to-file: ctx.sprint must be loaded first');
        if (!ctx.task) throw new Error('render-prompt-to-file: ctx.task must be loaded first');
        const dir = standaloneEvaluatorDir(ctx.sprint.id, ctx.task);
        return AbsolutePath.trustString(join(dir, 'prompt.md'));
      },
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
    renderPromptStep,
    evaluateTaskLeaf(deps, useCase, iso),
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

function evaluateTaskLeaf(
  deps: Pick<ChainSharedDeps, 'writeContextFile' | 'logger'>,
  useCase: EvaluateTaskUseCase,
  iso: string
): Element<EvaluateCtx> {
  return new Leaf<
    EvaluateCtx,
    {
      readonly sprint: Sprint;
      readonly task: Task;
      readonly cwd: AbsolutePath;
      readonly promptFilePath?: AbsolutePath;
    },
    {
      readonly outcome?: EvaluationOutcome;
      readonly fullCritique?: string;
      readonly evaluationFile?: string;
    }
  >('evaluate-task', {
    useCase: {
      async execute(input) {
        if (!input.promptFilePath) {
          throw new Error('evaluate-task: ctx.promptFilePath must be set by render-prompt-to-file');
        }
        // Route every per-spawn artefact (session.md, evaluation.md)
        // under the standalone-round folder this chain run owns. The AI
        // session adapter mkdir's the parent of `sessionMdPath`, and
        // `WriteContextFilePort.write` mkdir's its parent — no explicit
        // mkdir needed here.
        const slug = unitSlug(String(input.task.id), input.task.name);
        const unitRoot = String(resolveStoragePaths().executionUnitDir(input.sprint.id, slug));
        const evaluatorDir = join(standaloneRoundDir(unitRoot, iso), 'evaluator');
        const sessionMdPath = AbsolutePath.trustString(join(evaluatorDir, 'session.md'));
        const result = await useCase.execute({
          sprint: input.sprint,
          task: input.task,
          cwd: input.cwd,
          promptFilePath: String(input.promptFilePath),
          sessionMdPath,
        });
        if (!result.ok) return Result.error(result.error);

        // Per-round verdict — best-effort. "Evaluator never blocks":
        // the Task entity carries the critique in memory already
        // (returned in `result.value.fullCritique`), so a write failure
        // here is observable warn-level noise but doesn't fail the
        // chain. The relative path is plumbed through ctx so
        // `persist-evaluation` records the same path that was written.
        const verdictPath = AbsolutePath.trustString(join(evaluatorDir, 'evaluation.md'));
        const verdictWritten = await deps.writeContextFile.write(verdictPath, result.value.fullCritique);
        if (!verdictWritten.ok) {
          deps.logger.warn('failed to persist standalone evaluator verdict', {
            sprintId: String(input.sprint.id),
            taskId: String(input.task.id),
            path: String(verdictPath),
            error: verdictWritten.error.message,
          });
        }

        const evaluationFile = standaloneEvaluatorVerdictSprintRelative(slug, iso);
        return Result.ok({
          outcome: result.value.outcome,
          fullCritique: result.value.fullCritique,
          evaluationFile,
        });
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
      };
    },
    output: (ctx, out) =>
      out.outcome === undefined
        ? ctx
        : {
            ...ctx,
            evaluationOutcome: out.outcome,
            evaluationCritique: out.fullCritique ?? '',
            ...(out.evaluationFile !== undefined ? { evaluationFile: out.evaluationFile } : {}),
          },
  });
}

const MAX_PREVIEW_CHARS = 2000;

/**
 * Persist the evaluator outcome on the Task aggregate. Records the
 * preview (≤2000 chars) plus the resolved verdict. The full critique is
 * persisted under `execution/<unit-slug>/rounds/standalone-<ISO>/evaluator/
 * evaluation.md` by the upstream evaluate-task leaf, which also stamps
 * the relative path of that file onto `ctx.evaluationFile` so this leaf
 * records the exact path that was written — no path duplication, no
 * drift between writer and recorder.
 */
function persistEvaluationLeaf(deps: Pick<ChainSharedDeps, 'taskRepo'>): Element<EvaluateCtx> {
  return new Leaf<
    EvaluateCtx,
    {
      readonly sprintId: SprintId;
      readonly task: Task;
      readonly outcome?: EvaluationOutcome;
      readonly critique: string;
      readonly evaluationFile?: string;
    },
    void
  >('persist-evaluation', {
    useCase: {
      async execute(input) {
        if (input.outcome === undefined) {
          throw new Error('persist-evaluation: ctx.evaluationOutcome must be set');
        }
        if (input.evaluationFile === undefined) {
          throw new Error('persist-evaluation: ctx.evaluationFile must be set by evaluate-task');
        }
        const recorded = input.task.recordEvaluation({
          status: input.outcome,
          output: input.critique.slice(0, MAX_PREVIEW_CHARS),
          file: input.evaluationFile,
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
        ...(ctx.evaluationFile !== undefined ? { evaluationFile: ctx.evaluationFile } : {}),
      };
    },
    output: (ctx) => ctx,
  });
}
