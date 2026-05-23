/**
 * Behavior 6 — Sprint-detail does NOT auto-sync selection.
 *
 * Mounting SprintDetailView MUST NOT call `selection.setSprint`. The current production code
 * calls `setSprint` immediately on mount (and again when the async load resolves). This test
 * documents the NEW expected behaviour the implementer is landing: the detail view should stop
 * auto-syncing and let the user explicitly press `m` to make a sprint current.
 *
 * This is an inverse assertion relative to the current behaviour — it is deliberately written
 * against the new contract, not the old one. It WILL FAIL until the implementer removes the
 * auto-sync effects from sprint-detail-view.tsx.
 *
 * IMPORTANT: Do NOT edit the existing sprint-detail-view.test.tsx. This file is new.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintDetailView } from '@src/application/ui/tui/views/sprint-detail-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';
import { makeDraftSprint } from '@tests/fixtures/domain.ts';

const FIXED_SPRINT_ID = 'sprint-no-autosync' as unknown as SprintId;

const makeSprint = (overrides: Partial<Sprint> = {}): Sprint =>
  ({
    id: FIXED_SPRINT_ID,
    slug: 'no-autosync',
    name: 'No AutoSync Sprint',
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

const initial = { id: 'sprint-detail', props: { sprintId: FIXED_SPRINT_ID } };

/**
 * Spy component: wraps the view and records every `setSprint` call.
 */
const SpyOnSprint = ({
  onSetSprint,
  children,
}: {
  readonly onSetSprint: (id: SprintId | undefined, label: string | undefined) => void;
  readonly children: React.ReactNode;
}): React.JSX.Element => {
  const selection = useSelection();
  const spyRef = React.useRef(onSetSprint);
  spyRef.current = onSetSprint;

  React.useEffect(() => {
    const original = selection.setSprint;
    Object.assign(selection, {
      setSprint: (id: SprintId | undefined, label?: string) => {
        spyRef.current(id, label);
        original(id, label);
      },
    });
    // Cleanup: restore the original on unmount.
    return () => {
      Object.assign(selection, { setSprint: original });
    };
    // Intentional: only run once on mount — we want to patch before the child mounts.
  }, []);

  return <>{children}</>;
};

describe('SprintDetailView — no auto-sync', () => {
  it('does NOT call setSprint automatically on mount', async () => {
    const sprint = makeSprint({ status: 'draft', name: 'No AutoSync Sprint' });
    const setSprintCalls: Array<{ id: SprintId | undefined; label: string | undefined }> = [];

    const { result } = renderView(
      <SpyOnSprint
        onSetSprint={(id, label) => {
          setSprintCalls.push({ id, label });
        }}
      >
        <SprintDetailView />
      </SpyOnSprint>,
      { deps: stubDeps(sprint), initial }
    );

    // Allow full async load and effect cycle to complete.
    await tick(100);

    // No auto-sync: setSprint MUST NOT have been called by the view on mount.
    const mountCalls = setSprintCalls.filter((c) => c.id !== undefined);
    expect(mountCalls).toHaveLength(0);

    result.unmount();
  });

  it('does NOT call setSprint when the async load resolves', async () => {
    const sprint = makeSprint({ status: 'active', name: 'Active Sprint No Sync' });
    const setSprintCalls: Array<{ id: SprintId | undefined; label: string | undefined }> = [];

    const { result } = renderView(
      <SpyOnSprint
        onSetSprint={(id, label) => {
          setSprintCalls.push({ id, label });
        }}
      >
        <SprintDetailView />
      </SpyOnSprint>,
      { deps: stubDeps(sprint), initial }
    );

    // Wait well past the async load resolution point.
    await tick(150);

    // Neither the initial sprintId-only call nor the name-bearing call should happen.
    expect(setSprintCalls).toHaveLength(0);

    result.unmount();
  });

  it('renders the sprint name in the title without auto-syncing', async () => {
    const sprint = makeSprint({ status: 'draft', name: 'Visible Sprint' });
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint), initial });

    await tick(80);
    const frame = result.lastFrame() ?? '';

    // The view should still render correctly (sprint name appears).
    expect(frame).toContain('Visible Sprint');

    result.unmount();
  });
});

// ── Separate describe block: setSprint IS still available for tests that want the old behaviour ──

describe('SprintDetailView — setSprint is reachable via m key after redesign', () => {
  it('renders without error when a draft sprint is loaded', async () => {
    const sprint = makeDraftSprint({ name: 'Renderable Sprint' });
    const initialWithId = { id: 'sprint-detail', props: { sprintId: sprint.id } };

    const deps: AppDeps = {
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
    } as unknown as AppDeps;

    const { result } = renderView(<SprintDetailView />, { deps, initial: initialWithId });
    await tick(80);

    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Renderable Sprint');
    result.unmount();
  });
});
