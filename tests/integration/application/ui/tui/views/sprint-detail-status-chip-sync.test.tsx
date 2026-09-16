/**
 * Sprint detail refreshes the breadcrumb's sprint status chip from the bundle it loads.
 *
 * `selection.sprintStatus` is only written when the operator PICKS a sprint, so the chip caches
 * whatever the status was at pick time. Home and Flows have always re-synced it on load
 * (`home-view.tsx`, `flows-view.tsx`); sprint detail did not — and it is the one view that can
 * transition the sprint under the operator's feet, because `u` on a `review` sprint reopens it
 * to `active`. The result was a header card reading ACTIVE above a breadcrumb still claiming
 * REVIEW.
 */

import React from 'react';
import { Text } from 'ink';
import { describe, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintDetailView } from '@src/application/ui/tui/views/sprint-detail-view.tsx';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const SPRINT_ID = 'sprint-chip-fixture' as unknown as SprintId;
const PROJECT_ID = 'proj-chip-fixture' as unknown as ProjectId;

const ACTIVE_SPRINT = {
  id: SPRINT_ID,
  slug: 'chip-fixture',
  name: 'Chip Fixture',
  projectId: PROJECT_ID,
  status: 'active',
  tickets: [{ id: 't1' as never, title: 'the ticket', status: 'approved' } as never],
} as unknown as Sprint;

const deps = (): AppDeps =>
  ({
    sprintRepo: {
      async findById() {
        return Result.ok(ACTIVE_SPRINT);
      },
      async list() {
        return Result.ok([ACTIVE_SPRINT]);
      },
      async save() {
        return Result.ok(undefined);
      },
    } as unknown as SprintRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([]);
      },
    } as unknown as TaskRepository,
    projectRepo: {
      async findById() {
        return Result.ok({ id: PROJECT_ID, displayName: 'Proj', repositories: [] } as never);
      },
    } as never,
    sprintExecutionRepo: {} as never,
    settingsRepo: {} as never,
    clock: () => IsoTimestamp.now(),
    logger: noopLogger,
  }) as unknown as AppDeps;

const initial: ViewEntry = { id: 'sprint-detail', props: { sprintId: SPRINT_ID } };

/**
 * Reads the cached status straight off the selection context — the value the breadcrumb chip
 * renders. Asserting here rather than on the rendered breadcrumb keeps the test about the sync
 * itself: the breadcrumb drops its sprint segment entirely at the harness's 100-column width,
 * and the header card prints its own `[ACTIVE]` chip that would satisfy a looser frame match.
 */
const StatusProbe = (): React.JSX.Element => {
  const selection = useSelection();
  return <Text>{`chip=${selection.sprintStatus ?? 'none'}`}</Text>;
};

describe('SprintDetailView — breadcrumb status chip', () => {
  it('stamps the loaded sprint status onto the selection so the chip is not stale', async () => {
    const { result } = renderView(
      <>
        <SprintDetailView />
        <StatusProbe />
      </>,
      {
        deps: deps(),
        initial,
        // Seeded WITHOUT a status, the way a selection restored from disk arrives.
        selection: { projectId: PROJECT_ID, sprintId: SPRINT_ID, sprintLabel: 'Chip Fixture' },
      }
    );
    await waitForViewReady(result, (f) => f.includes('Chip Fixture'));

    // Without the sync the probe stays `chip=none` for the life of the view — the seed carries
    // no status and nothing else on this screen writes one.
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('chip=active'), {
      label: 'the cached status picked up the loaded sprint status',
    });
    result.unmount();
  });
});
