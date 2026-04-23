/**
 * Execution registry port — runtime container for active sprint executions.
 *
 * Owns the lifecycle of in-flight executions: `start` spawns a pipeline in
 * the background, `get` / `list` expose current state, `cancel` signals a
 * running execution to wind down, and `subscribe` notifies listeners on
 * every status transition so the UI can render a live running-executions list.
 *
 * Invariants:
 *   - At most one `running` execution per project at a time. Starting a
 *     second execution on the same project raises `ExecutionAlreadyRunningError`
 *     synchronously from `start` — registry state is untouched on rejection.
 *   - Completed / failed / cancelled entries remain queryable until the caller
 *     chooses to prune (the registry itself keeps them indefinitely).
 *
 * The listener/subscribe style mirrors `SignalBusPort` — batching is a
 * concrete-adapter concern, not part of the port contract.
 */

import type { Sprint } from '@src/domain/models.ts';
import type { ExecutionOptions } from '@src/domain/context.ts';
import type { ExecutionSummary } from '@src/business/usecases/execute.ts';

export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * Public view of an in-flight or terminal execution. The registry stores a
 * private `Entry` per execution (see the in-memory adapter) and exposes only
 * this projection to callers so the UI never reaches into lifecycle internals.
 */
export interface RunningExecution {
  id: string;
  projectName: string;
  sprintId: string;
  sprint: Sprint;
  status: ExecutionStatus;
  startedAt: Date;
  endedAt?: Date;
  summary?: ExecutionSummary;
}

/**
 * Parameters for starting a new execution. The registry resolves the sprint
 * and project up-front so the returned `RunningExecution` captures the
 * launched-against sprint snapshot regardless of subsequent UI edits.
 */
export interface StartExecutionParams {
  sprintId: string;
  options?: ExecutionOptions;
}

export type ExecutionListener = (execution: RunningExecution) => void;
export type Unsubscribe = () => void;

export interface ExecutionRegistryPort {
  /**
   * Begin a new execution in the background. Returns the initial
   * `RunningExecution` snapshot (status `'running'`) once the pipeline has
   * been scheduled. Throws `ExecutionAlreadyRunningError` synchronously if
   * the target project already has a `running` entry — registry state is
   * unchanged when this happens.
   */
  start(params: StartExecutionParams): Promise<RunningExecution>;

  /** Look up a single execution by id. Returns `null` when unknown. */
  get(id: string): RunningExecution | null;

  /** Snapshot of every execution the registry currently knows about. */
  list(): RunningExecution[];

  /**
   * Request cancellation of a running execution. Triggers the execution's
   * AbortController; the pipeline winds down cooperatively and eventually
   * transitions to `'cancelled'`. No-op for unknown ids or terminal entries.
   */
  cancel(id: string): void;

  /**
   * Subscribe to every lifecycle transition (start, complete, fail, cancel).
   * Listeners are called once per transition with the fresh `RunningExecution`
   * snapshot. Returns an unsubscribe function.
   */
  subscribe(listener: ExecutionListener): Unsubscribe;
}
