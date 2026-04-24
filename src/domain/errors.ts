/**
 * Common base class for all domain errors in ralphctl.
 * Every domain error carries a machine-readable code, a human-readable
 * message, and an optional cause for error chaining.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;
  override readonly cause?: Error;

  constructor(message: string, cause?: Error) {
    super(message, cause ? { cause } : undefined);
    this.name = this.constructor.name;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// I/O and file-system errors
// ---------------------------------------------------------------------------

export class IOError extends DomainError {
  readonly code = 'IO_ERROR';
}

export class StorageError extends DomainError {
  readonly code = 'STORAGE_ERROR';
}

export class LockError extends DomainError {
  readonly code = 'LOCK_ERROR';
  readonly lockPath: string;

  constructor(message: string, lockPath: string, cause?: Error) {
    super(message, cause);
    this.lockPath = lockPath;
  }
}

// ---------------------------------------------------------------------------
// Parse and validation errors
// ---------------------------------------------------------------------------

export class ParseError extends DomainError {
  readonly code = 'PARSE_ERROR';
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR';
  readonly path: string;

  constructor(message: string, path: string, cause?: Error) {
    super(message, cause);
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// Process / spawn errors
// ---------------------------------------------------------------------------

function detectSpawnRateLimit(stderr: string): { rateLimited: boolean; retryAfterMs: number | null } {
  const patterns = [/rate.?limit/i, /\b429\b/, /too many requests/i, /overloaded/i, /\b529\b/];
  const isRateLimited = patterns.some((p) => p.test(stderr));
  if (!isRateLimited) return { rateLimited: false, retryAfterMs: null };
  const retryMatch = /retry.?after:?\s*(\d+)/i.exec(stderr);
  const retryAfterMs = retryMatch?.[1] ? parseInt(retryMatch[1], 10) * 1000 : null;
  return { rateLimited: true, retryAfterMs };
}

export class SpawnError extends DomainError {
  readonly code = 'SPAWN_ERROR';
  readonly stderr: string;
  readonly exitCode: number;
  readonly rateLimited: boolean;
  readonly retryAfterMs: number | null;
  readonly sessionId: string | null;

  constructor(message: string, stderr: string, exitCode: number, sessionId?: string | null, cause?: Error) {
    super(message, cause);
    this.stderr = stderr;
    this.exitCode = exitCode;
    this.sessionId = sessionId ?? null;
    const rl = detectSpawnRateLimit(stderr);
    this.rateLimited = rl.rateLimited;
    this.retryAfterMs = rl.retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// Not-found errors
// ---------------------------------------------------------------------------

export class SprintNotFoundError extends DomainError {
  readonly code = 'SPRINT_NOT_FOUND';
  readonly sprintId: string;

  constructor(sprintId: string) {
    super(`Sprint not found: ${sprintId}`);
    this.sprintId = sprintId;
  }
}

export class TaskNotFoundError extends DomainError {
  readonly code = 'TASK_NOT_FOUND';
  readonly taskId: string;

  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.taskId = taskId;
  }
}

export class TicketNotFoundError extends DomainError {
  readonly code = 'TICKET_NOT_FOUND';
  readonly ticketId: string;

  constructor(ticketId: string) {
    super(`Ticket not found: ${ticketId}`);
    this.ticketId = ticketId;
  }
}

export class ProjectNotFoundError extends DomainError {
  readonly code = 'PROJECT_NOT_FOUND';
  readonly projectName: string;

  constructor(projectName: string) {
    super(`Project not found: ${projectName}`);
    this.projectName = projectName;
  }
}

export class ProjectExistsError extends DomainError {
  readonly code = 'PROJECT_EXISTS';
  readonly projectName: string;

  constructor(projectName: string) {
    super(`Project already exists: ${projectName}`);
    this.projectName = projectName;
  }
}

// ---------------------------------------------------------------------------
// Status / lifecycle errors
// ---------------------------------------------------------------------------

class StatusError extends DomainError {
  readonly code: string = 'STATUS_ERROR';
}

export class SprintStatusError extends StatusError {
  readonly currentStatus: string;
  readonly operation: string;

  constructor(message: string, currentStatus: string, operation: string) {
    super(message);
    this.currentStatus = currentStatus;
    this.operation = operation;
  }
}

export class NoCurrentSprintError extends StatusError {
  constructor() {
    super('No sprint specified and no current sprint set.');
  }
}

// ---------------------------------------------------------------------------
// Dependency errors
// ---------------------------------------------------------------------------

export class DependencyCycleError extends DomainError {
  readonly code = 'DEPENDENCY_CYCLE';
  readonly cycle: string[];

  constructor(cycle: string[]) {
    super(`Dependency cycle detected: ${cycle.join(' → ')}`);
    this.cycle = cycle;
  }
}

// ---------------------------------------------------------------------------
// External issue fetch errors
// ---------------------------------------------------------------------------

export class IssueFetchError extends DomainError {
  readonly code = 'ISSUE_FETCH_ERROR';
}

// ---------------------------------------------------------------------------
// Pipeline step errors
// ---------------------------------------------------------------------------

export class StepError extends DomainError {
  readonly code = 'STEP_ERROR';
  readonly stepName: string;

  constructor(message: string, stepName: string, cause?: Error) {
    super(message, cause);
    this.stepName = stepName;
  }
}

/**
 * Raised by the per-task `branch-preflight` step when a repo is not on the
 * expected sprint branch. Distinct from `StorageError` so the executor's
 * retry policy can pattern-match by type rather than by message substring
 * and requeue the task up to `MAX_BRANCH_RETRIES` times before failing.
 */
export class BranchPreflightError extends DomainError {
  readonly code = 'BRANCH_PREFLIGHT_ERROR';
  readonly projectPath: string;
  readonly expectedBranch: string;

  constructor(projectPath: string, expectedBranch: string, cause?: Error) {
    super(`Branch verification failed: expected '${expectedBranch}' in ${projectPath}`, cause);
    this.projectPath = projectPath;
    this.expectedBranch = expectedBranch;
  }
}

// ---------------------------------------------------------------------------
// Execution registry errors
// ---------------------------------------------------------------------------

/**
 * Raised by `ExecutionRegistryPort.start` when the target project already has
 * a running execution. Carries `existingExecutionId` so the UI can deep-link
 * the user to the live execution screen instead of offering a new start.
 */
export class ExecutionAlreadyRunningError extends DomainError {
  readonly code = 'EXECUTION_ALREADY_RUNNING';
  readonly projectName: string;
  readonly existingExecutionId: string;

  constructor(projectName: string, existingExecutionId: string) {
    super(`An execution is already running for project '${projectName}' (id: ${existingExecutionId}).`);
    this.projectName = projectName;
    this.existingExecutionId = existingExecutionId;
  }
}
