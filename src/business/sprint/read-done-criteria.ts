import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

/**
 * Output port for reading a task's `done-criteria.md` from the implement audit workspace.
 *
 * The file is materialised by `build-task-workspace-leaf` at
 * `<sprintDir>/implement/<task-id>/done-criteria.md` as soon as the implement chain enters the
 * per-task subchain. The TUI's Tasks panel surfaces the criteria so the operator can read what
 * the AI is being held to without leaving the live dashboard.
 *
 * Tolerant by contract:
 *  - file missing (pre-implement view, or task hasn't entered its subchain yet) → `undefined`
 *  - directory missing (sprint hasn't run) → `undefined`
 *  - any other IO failure → `undefined` (the TUI degrades to "criteria not available" rather
 *    than crashing the live view; the canonical criteria still live on the task entity)
 *
 * Returns the raw file contents (markdown). The caller is responsible for any presentation
 * (collapsing to a summary line, fuzzy-mapping to evaluator dimensions, etc).
 *
 * @public
 */
export type ReadDoneCriteria = (sprintDir: AbsolutePath, taskId: string) => Promise<string | undefined>;
