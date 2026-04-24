import type { AiProvider, Config, Project, Sprint, Task, Ticket } from './models.ts';

/** Unified context flowing through pipeline steps */
export interface StepContext {
  sprintId: string;
  sprint?: Sprint;
  ticketIds?: string[];
  tickets?: Ticket[];
  taskIds?: string[];
  tasks?: Task[];
  projectPaths?: string[];
  projects?: Project[];
  selectedRepositoryPaths?: string[];
  checkResults?: Record<string, CheckResult>;
  progressSummary?: string;
  aiProvider?: AiProvider;
  branch?: string | null;
  config?: Config;
  /**
   * Cooperative cancellation signal for the pipeline. When `aborted`, the
   * pipeline executor stops launching subsequent steps and `forEachTask` stops
   * pulling new items. In-flight steps observe the signal via shared context
   * and are expected to wind down gracefully (see AiSessionPort + ProcessLifecyclePort).
   */
  abortSignal?: AbortSignal;
}

/** Result of a check script run for a single repo */
export interface CheckResult {
  projectPath: string;
  success: boolean;
  output?: string;
  ranAt?: string; // ISO8601
}

/** Options shared across all pipeline steps */
export interface StepOptions {
  maxTurns?: number;
  maxBudgetUsd?: number;
  fallbackModel?: string;
}

/** Options specific to refinement */
export interface RefineOptions extends StepOptions {
  auto?: boolean;
  project?: string;
}

/** Options specific to planning */
export interface PlanOptions extends StepOptions {
  auto?: boolean;
  allPaths?: boolean;
}

/** Options specific to ideation */
export interface IdeateOptions extends StepOptions {
  auto?: boolean;
  allPaths?: boolean;
  project?: string;
}

/** Options specific to task execution */
export interface ExecutionOptions extends StepOptions {
  step?: boolean;
  count?: number | null;
  session?: boolean;
  noCommit?: boolean;
  concurrency?: number;
  maxRetries?: number;
  failFast?: boolean;
  force?: boolean;
  refreshCheck?: boolean;
  branch?: boolean;
  branchName?: string;
  /**
   * Skip prompts and resume with uncommitted changes intact. Mutually
   * exclusive with `resetOnResume`. Required in non-interactive contexts
   * (no TTY / CI / piped stdin) when the working tree is dirty.
   */
  resumeDirty?: boolean;
  /**
   * Skip prompts and hard-reset the working tree to HEAD before resuming.
   * Destructive — tracked modifications and untracked files are discarded.
   * Mutually exclusive with `resumeDirty`.
   */
  resetOnResume?: boolean;
  noEvaluate?: boolean;
  noFeedback?: boolean;
  /**
   * Per-invocation resume hint: when set, `executeOneTask` passes this as the
   * provider's `--resume` session ID so a rate-limited task relaunches with
   * full conversation continuity. Transient — the scheduler injects it per
   * call via the per-task pipeline step, not stored at sprint or task level.
   */
  resumeSessionId?: string;
  /**
   * Absolute path to the task's sprint contract (written by `contract-negotiate`).
   * When set, `executeOneTask` appends a "## Sprint Contract" section to the
   * task context string pointing the generator at the file.
   */
  contractPath?: string;
  /**
   * Cooperative cancellation for a single task execution. Threaded from
   * `StepContext.abortSignal` through the per-task pipeline and into
   * `spawnWithRetry` so a cancelled backgrounded execution kills the child
   * subprocess (SIGTERM) rather than letting it run to completion.
   */
  abortSignal?: AbortSignal;
}

/** Options specific to evaluation */
export interface EvaluationOptions extends StepOptions {
  iterations?: number;
  /** Cooperative cancellation so a cancelled execution tears down any in-flight evaluator. */
  abortSignal?: AbortSignal;
  /**
   * Generator's initial session ID — threaded into the fix spawn as
   * `--resume <id>` so the fix is a continuation of the original task
   * session, not a fresh one.
   */
  generatorSessionId?: string;
  /** Whether the fix should commit its work. Mirrors `!ExecutionOptions.noCommit`. Default true. */
  needsCommit?: boolean;
}
