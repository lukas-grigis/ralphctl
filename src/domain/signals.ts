/**
 * Structured signal types — discriminated union of all signal types emitted by AI agents
 * and parsed by the harness during task execution and evaluation.
 *
 * Each signal type carries a fixed set of fields required by signal handlers.
 * All signals are timestamped by the harness (not by AI agent).
 */

/**
 * Dimension scores from evaluator output.
 *
 * Parsed from lines like `**Name**: PASS|FAIL — one-line finding`. The dimension
 * name is any identifier matched by the parser regex — both the four floor
 * dimensions (`correctness`, `completeness`, `safety`, `consistency`) AND
 * planner-emitted extras (e.g. `performance`, `accessibility`, `migrationsafety`).
 * Names are lowercased at the parser boundary so downstream comparisons (e.g.
 * `failedDimensions()` for plateau detection) stay case-insensitive.
 */
export type EvaluationDimension = string;

export interface DimensionScore {
  dimension: EvaluationDimension;
  passed: boolean;
  finding: string;
}

/**
 * Progress signal — AI agent reports progress on current task.
 * Harness appends to progress.md with timestamp and project marker.
 */
export interface ProgressSignal {
  type: 'progress';
  summary: string; // One-line summary of work completed
  files?: string[]; // Optional list of files modified
  timestamp: Date;
}

/**
 * Evaluation signal — Result of evaluator assessment after task completion.
 * Status discriminator: 'passed' | 'failed' | 'malformed'
 * - passed: <evaluation-passed> signal found
 * - failed: <evaluation-failed> signal or failed dimensions
 * - malformed: no signals AND no parseable dimension lines
 */
export interface EvaluationSignal {
  type: 'evaluation';
  status: 'passed' | 'failed' | 'malformed';
  dimensions: DimensionScore[]; // Structured scores (may be empty)
  critique?: string; // Full critique from <evaluation-failed> tag (if failed)
  timestamp: Date;
}

/**
 * Task complete signal — AI agent marks task as complete.
 * Only valid AFTER task-verified signal has been processed (enforced by parser).
 */
export interface TaskCompleteSignal {
  type: 'task-complete';
  timestamp: Date;
}

/**
 * Task verified signal — AI agent verifies task output meets criteria.
 * Must be emitted BEFORE task-complete signal.
 */
export interface TaskVerifiedSignal {
  type: 'task-verified';
  output: string; // Verification output describing what was checked
  timestamp: Date;
}

/**
 * Task blocked signal — AI agent cannot proceed; task is blocked.
 * Harness pauses execution for this task and logs blocker reason.
 */
export interface TaskBlockedSignal {
  type: 'task-blocked';
  reason: string; // Human-readable reason for blockage
  timestamp: Date;
}

/**
 * Note signal — Informational message from AI agent.
 * Harness appends to progress.md as a note (not timestamped separately).
 */
export interface NoteSignal {
  type: 'note';
  text: string; // Note content
  timestamp: Date;
}

/**
 * Discriminated union of all signal types.
 * Narrows signal type based on the `type` discriminator field.
 *
 * Example: TypeScript's type guard:
 *   if (signal.type === 'progress') { signal.summary; } // ✓ type-safe
 *   if (signal.type === 'evaluation') { signal.status; } // ✓ type-safe
 */
export type HarnessSignal =
  | ProgressSignal
  | EvaluationSignal
  | TaskCompleteSignal
  | TaskVerifiedSignal
  | TaskBlockedSignal
  | NoteSignal;
