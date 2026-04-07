import { appendToFile } from '@src/utils/storage.ts';
import { getEvaluationFilePath } from '@src/utils/paths.ts';
import { unwrapOrThrow } from '@src/utils/result-helpers.ts';
import type { EvaluationStatus } from '@src/schemas/index.ts';

/**
 * Append an evaluation entry to the sidecar file for a task.
 *
 * The file lives at `<sprintDir>/evaluations/<taskId>.md` and contains the
 * FULL untruncated critique. `tasks.json` keeps a 2000-char preview in
 * `evaluationOutput` for quick scanning, plus an `evaluationFile` pointer to
 * this file.
 *
 * Iterations append (one entry per iteration) so the user can see how the
 * evaluator's verdict evolved across fix attempts.
 */
export async function writeEvaluation(
  sprintId: string,
  taskId: string,
  iteration: number,
  status: EvaluationStatus,
  body: string
): Promise<string> {
  const filePath = getEvaluationFilePath(sprintId, taskId);
  const timestamp = new Date().toISOString();
  const header = `## ${timestamp} — Iteration ${String(iteration)} — ${status.toUpperCase()}\n\n`;
  const entry = `${header}${body.trimEnd()}\n\n---\n\n`;
  unwrapOrThrow(await appendToFile(filePath, entry));
  return filePath;
}
