/**
 * Shared fixtures for the `sprint-detail-*` view tests: the repo stubs the view needs to load a
 * sprint plus its tasks, the router entry that opens it, and the whitespace flattener for
 * soft-wrapped toasts.
 */

import { Result } from '@src/domain/result.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

/** Deps that can load `sprint` and `tasks` and nothing else — every write seam is absent. */
export const readOnlyDeps = (sprint: Sprint, tasks: readonly Task[] = []): AppDeps =>
  ({
    sprintRepo: { findById: async () => Result.ok(sprint) },
    taskRepo: { findBySprintId: async () => Result.ok([...tasks]) },
    projectRepo: {},
    sprintExecutionRepo: {},
    settingsRepo: {},
    logger: noopLogger,
  }) as unknown as AppDeps;

export const sprintDetailEntry = (sprintId: SprintId): ViewEntry => ({ id: 'sprint-detail', props: { sprintId } });

/** Ink soft-wraps toasts, so assert against a whitespace-flattened frame. */
export const flat = (frame: string): string => frame.replace(/\s+/g, ' ');
