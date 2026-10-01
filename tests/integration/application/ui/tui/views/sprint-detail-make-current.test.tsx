/**
 * Behavior 7 — Sprint-detail `m` makes current.
 *
 * Pressing `m` on the sprint detail view MUST call `selection.setSprint(sprint.id, sprint.name)`.
 * When `selection.sprintId === sprint.id` (i.e. the viewed sprint is already the current selection),
 * a `· current` badge MUST appear in the detail header.
 *
 * NOTE: These tests will FAIL until the implementer lands the `m` hotkey on SprintDetailView.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintDetailView } from '@src/application/ui/tui/views/sprint-detail-view.tsx';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const SPRINT_ID = 'sprint-make-current-id' as unknown as SprintId;

const makeSprint = (overrides: Partial<Sprint> = {}): Sprint =>
  ({
    id: SPRINT_ID,
    slug: 'make-current',
    name: 'Make Current Sprint',
    projectId: 'proj-fixture' as never,
    status: 'draft',
    tickets: [],
    ...overrides,
  }) as unknown as Sprint;

const stubDeps = (sprint: Sprint): AppDeps =>
  ({
    sprintRepo: {
      async findById() {
        return Result.ok(sprint);
      },
    } as unknown as SprintRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([]);
      },
    } as unknown as TaskRepository,
    projectRepo: {} as never,
    sprintExecutionRepo: {} as never,
    settingsRepo: {} as never,
  }) as unknown as AppDeps;

const initial: ViewEntry = { id: 'sprint-detail', props: { sprintId: SPRINT_ID } };

/**
 * Intercept spy: patches `setSprint` on the selection context via Object.assign after mount.
 */
const MakeSpy = ({
  spy,
  children,
}: {
  readonly spy: ReturnType<typeof vi.fn>;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const selection = useSelection();
  React.useEffect(() => {
    const original = selection.setSprint;
    Object.assign(selection, { setSprint: spy });
    return () => {
      Object.assign(selection, { setSprint: original });
    };
  }, []);
  return <>{children}</>;
};

describe('SprintDetailView — m key makes current', () => {
  it('calls selection.setSprint with sprint id and name when m is pressed', async () => {
    const sprint = makeSprint({ name: 'Make Current Sprint' });
    const setSprint = vi.fn<(id: SprintId | undefined, label?: string) => void>();

    const { result } = renderView(
      <MakeSpy spy={setSprint}>
        <SprintDetailView />
      </MakeSpy>,
      { deps: stubDeps(sprint), initial }
    );

    await waitForViewReady(result, (f) => f.includes('Tickets'));

    result.stdin.write('m');
    await waitForPredicate(() => setSprint.mock.calls.length === 1);

    expect(setSprint).toHaveBeenCalledTimes(1);
    const [calledId, calledLabel] = setSprint.mock.calls[0] as [SprintId | undefined, string | undefined];
    expect(calledId).toBe(SPRINT_ID);
    expect(calledLabel).toBe('Make Current Sprint');

    result.unmount();
  });

  it('does NOT call setSprint when a key other than m/n is pressed', async () => {
    const sprint = makeSprint({ name: 'Other Key Sprint' });
    const setSprint = vi.fn<(id: SprintId | undefined, label?: string) => void>();

    const { result } = renderView(
      <MakeSpy spy={setSprint}>
        <SprintDetailView />
      </MakeSpy>,
      { deps: stubDeps(sprint), initial }
    );

    await waitForViewReady(result, (f) => f.includes('Tickets'));

    result.stdin.write('z'); // inert key — neither make-current (m) nor open-flows (n)
    await tick(40);

    expect(setSprint).not.toHaveBeenCalled();

    result.unmount();
  });

  it('n reseats the selection onto the viewed sprint before opening Flows', async () => {
    // The view advertises `n — flows` as "scoped to this sprint": pressing it while a
    // DIFFERENT sprint is current must make the viewed sprint current so the Flows launch
    // targets what the user is looking at. The route push itself is owned by the global `n`
    // handler (not mounted in this harness), so only the reseat is asserted here.
    const sprint = makeSprint({ name: 'Scoped Sprint' });
    const setSprint = vi.fn<(id: SprintId | undefined, label?: string) => void>();

    const { result } = renderView(
      <MakeSpy spy={setSprint}>
        <SprintDetailView />
      </MakeSpy>,
      { deps: stubDeps(sprint), initial }
    );

    await waitForViewReady(result, (f) => f.includes('Tickets'));

    result.stdin.write('n');
    await waitForPredicate(() => setSprint.mock.calls.length === 1);

    expect(setSprint).toHaveBeenCalledTimes(1);
    const [calledId, calledLabel] = setSprint.mock.calls[0] as [SprintId | undefined, string | undefined];
    expect(calledId).toBe(SPRINT_ID);
    expect(calledLabel).toBe('Scoped Sprint');

    result.unmount();
  });

  it('n does NOT reseat when the viewed sprint is already current', async () => {
    // Seeding the selection re-memoizes the api object, which would silently drop a MakeSpy
    // patch — so assert via the view's own "✓ now on …" feedback line instead: it renders on
    // every reseat and must stay absent when `n` is pressed on the already-current sprint.
    const sprint = makeSprint({ name: 'Already Current Sprint' });

    const { result } = renderView(<SprintDetailView />, {
      deps: stubDeps(sprint),
      initial,
      selection: { sprintId: SPRINT_ID, sprintLabel: 'Already Current Sprint' },
    });

    await waitForViewReady(result, (f) => f.includes('Tickets'));

    result.stdin.write('n');
    await tick(40);

    expect(result.lastFrame() ?? '').not.toContain('✓ now on');

    result.unmount();
  });

  it('renders no name row or current badge in the body — the LocationBar owns the sprint identity', async () => {
    const sprint = makeSprint({ name: 'Selected Sprint' });

    const { result } = renderView(<SprintDetailView />, {
      deps: stubDeps(sprint),
      initial,
      selection: { sprintId: SPRINT_ID, sprintLabel: 'Selected Sprint' },
    });

    await waitForViewReady(result, (f) => f.includes('Tickets'));
    const frame = result.lastFrame() ?? '';

    expect(frame).not.toContain('Selected Sprint');
    expect(frame).not.toMatch(/·\s*current/i);

    result.unmount();
  });

  it('m key is a view-local key (does not globally navigate)', async () => {
    const sprint = makeSprint({ name: 'Local Key Sprint' });
    const routedIds: string[] = [];

    const { result } = renderView(<SprintDetailView />, {
      deps: stubDeps(sprint),
      initial,
      onRoute: (entry) => {
        routedIds.push(entry.id);
      },
    });

    await waitForViewReady(result, (f) => f.includes('Tickets'));
    result.stdin.write('m');
    await tick(40);

    // 'm' must not navigate to a different view.
    const routedAwayFromDetail = routedIds.some((id) => id !== 'sprint-detail');
    expect(routedAwayFromDetail).toBe(false);

    result.unmount();
  });
});
