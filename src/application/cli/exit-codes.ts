/**
 * Exit codes ralphctl emits from its CLI surface. Documented at the entry
 * point so scripted callers (CI pipelines, shell wrappers) can branch on
 * them without parsing stdout.
 *
 * Distinct from kernel chain status — the CLI translates pipeline
 * outcomes into one of these numbers when the process exits.
 */
export const EXIT_SUCCESS = 0;
/** Validation, lifecycle, or use-case error. The default failure code. */
export const EXIT_ERROR = 1;
/** Sprint has no tasks to execute (planning hasn't run). */
export const EXIT_NO_TASKS = 2;
/** Every remaining task is blocked — execution can't make progress. */
export const EXIT_ALL_BLOCKED = 3;
/** SIGINT (Ctrl+C) received. Matches POSIX 128 + signal number convention. */
export const EXIT_INTERRUPTED = 130;

export type ExitCode =
  | typeof EXIT_SUCCESS
  | typeof EXIT_ERROR
  | typeof EXIT_NO_TASKS
  | typeof EXIT_ALL_BLOCKED
  | typeof EXIT_INTERRUPTED;
