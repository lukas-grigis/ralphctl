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
}

/** Options specific to evaluation */
export interface EvaluationOptions extends StepOptions {
  iterations?: number;
}
