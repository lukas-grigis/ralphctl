import type { Task } from '@src/domain/entity/task.ts';
import { DISPLAY_TEXT_MAX_CHARS, sanitizeDisplayText } from '@src/domain/value/display-text.ts';

/** Longest task-name list spelled out before the tail collapses to "and N more". */
const MAX_NAMED_BLOCKED_TASKS = 5;

/** Comma-joined, sanitized names of blocked tasks — shared by the CLI and in-chain close confirms. */
export const nameBlockedTasks = (blocked: ReadonlyArray<Pick<Task, 'name'>>): string => {
  // Task names are planner-authored prose on their way to the terminal, so neuter escapes first.
  const named = blocked
    .slice(0, MAX_NAMED_BLOCKED_TASKS)
    .map((t) => sanitizeDisplayText(t.name, DISPLAY_TEXT_MAX_CHARS));
  const remainder = blocked.length - named.length;
  return remainder > 0 ? `${named.join(', ')}, and ${String(remainder)} more` : named.join(', ');
};
