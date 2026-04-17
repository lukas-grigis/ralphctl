import type { Sprint, Task, Ticket, Project, AiProvider, Config } from './models.ts';

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

/** Unified result envelope for pipeline steps */
export interface StepOutput<T = unknown> {
  status: 'success' | 'blocked' | 'skipped';
  data: T;
  diagnostics?: StepDiagnostics;
}

/** Timing and session metadata from a step execution */
export interface StepDiagnostics {
  durationMs: number;
  sessionId?: string;
  model?: string;
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
}

/** Options specific to evaluation */
export interface EvaluationOptions extends StepOptions {
  iterations?: number;
}
