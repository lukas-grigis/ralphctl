import { z } from 'zod';
import type { TaskPlanSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';

/**
 * Zod schema for the `task-plan` AI signal — produced by the plan flow's AI session. Carries
 * the raw planner JSON envelope; `parseTaskList` resolves cross-references (projectPath →
 * Repository, blockedBy → TaskId) downstream. No sidecar — the harness projects the parsed
 * tasks onto the sprint via `planSprintUseCase`.
 *
 * Wave 6 will replace `tasksJson` with a structured `TaskImportSpec[]` once the prompt asks
 * the AI to write the wrapper directly.
 */
/** @public */
export const taskPlanSignalSchema = z.object({
  type: z.literal('task-plan'),
  tasksJson: z.string(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof taskPlanSignalSchema>, TaskPlanSignal> = true;
void _typeCheck;
