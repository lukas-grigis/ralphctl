/**
 * Exit codes for CLI commands.
 * Using structured exit codes enables scripting and CI/CD integration.
 */

/** Success - all requested operations completed successfully */
export const EXIT_SUCCESS = 0;

/** Error - validation failed, missing params, execution error, etc. */
export const EXIT_ERROR = 1;

/** No tasks - no tasks available to execute */
export const EXIT_NO_TASKS = 2;

/** All blocked - remaining tasks are blocked by dependencies */
export const EXIT_ALL_BLOCKED = 3;

/**
 * Exit with the given code (wrapper for testability).
 * In non-interactive mode, commands should use this to signal outcome.
 */
export function exitWithCode(code: number): never {
  process.exit(code);
}
