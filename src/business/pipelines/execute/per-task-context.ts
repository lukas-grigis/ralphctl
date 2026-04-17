import type { StepContext } from '@src/domain/context.ts';
import type { Task, Sprint } from '@src/domain/models.ts';
import type { TaskExecutionResult } from '@src/business/usecases/execute.ts';

/**
 * Per-task pipeline context.
 *
 * The outer `StepContext` provides `sprintId`; the per-task pipeline adds
 * the current task (injected by `forEachTask` at `itemKey`) plus running
 * state populated by the per-task steps.
 *
 * Field lifecycle:
 *   - `task` — seeded by the caller (or by `forEachTask` in commit 3)
 *   - `sprint` — carried through from the outer pipeline
 *   - `executionResult` — written by `execute-task`
 *   - `generatorModel` — written by `execute-task` (derived from
 *     `executionResult.model`); read by `evaluate-task` to feed the model
 *     ladder
 */
export interface PerTaskContext extends StepContext {
  task: Task;
  sprint: Sprint;
  executionResult?: TaskExecutionResult;
  generatorModel?: string | null;
  /**
   * Step names from the nested evaluator pipeline (success or failure).
   * Populated by `evaluate-task` when the nested pipeline runs so the
   * integration test can assert the evaluator composed correctly.
   * Undefined when evaluation is disabled or skipped.
   */
  evaluationStepNames?: string[];
}
