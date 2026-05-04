/**
 * `readDoneCriteriaBullet` — extract the single bullet for `taskId` from a
 * `done-criteria.md` file.
 *
 * The file has one bullet per task in this format (written by `save-tasks`):
 *
 * ```md
 * - **Task name** (`<task-id>`) — <criteria>
 * ```
 *
 * The reader matches by task-id substring so the lookup is robust to name
 * changes between plan and execution. Returns the full bullet line when
 * found, or `''` when the file is absent, unreadable, or the task id is
 * not present — in all three cases the evaluator gracefully omits the
 * `## Per-task done criteria` section rather than failing.
 */
import { readFile } from 'node:fs/promises';

/**
 * Read the per-task done-criteria bullet from `criteriaFilePath`.
 *
 * Safe to call unconditionally — never throws. Returns `''` when the
 * file is absent, the task id is not found, or any I/O error occurs.
 */
export async function readDoneCriteriaBullet(criteriaFilePath: string, taskId: string): Promise<string> {
  let body: string;
  try {
    body = await readFile(criteriaFilePath, 'utf-8');
  } catch {
    // File absent (legacy sprint) or I/O error — evaluator grades without it.
    return '';
  }

  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    // Each bullet contains the task id in backticks: (`<taskId>`)
    if (trimmed.startsWith('- ') && trimmed.includes(`\`${taskId}\``)) {
      return trimmed;
    }
  }

  return '';
}
