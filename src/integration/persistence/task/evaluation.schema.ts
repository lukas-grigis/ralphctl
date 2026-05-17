import { z } from 'zod';

/**
 * Loader for `attempt.evaluation`. The body string was dropped by the file-based provider
 * refactor; legacy `tasks.json` files carried it under `output` and that field is silently
 * discarded on load. The rendered verdict still lives on disk as
 * `<sprintDir>/implement/<task-id>/rounds/<N>/evaluator/evaluation.md`.
 */
export const EvaluationSchema = z
  .looseObject({
    status: z.enum(['passed', 'failed', 'malformed']),
    file: z.string(),
  })
  .transform(({ status, file }) => ({ status, file }));
