/**
 * Smoke tests for SprintsView. Empty state, populated row, `c` advice when no project picked.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintsView } from '@src/application/ui/tui/views/sprints-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

const fakeSprintRepo = (sprints: readonly Sprint[]): SprintRepository =>
  ({
    async list() {
      return Result.ok([...sprints]);
    },
    async remove() {
      return Result.ok(undefined);
    },
  }) as unknown as SprintRepository;

const stubDeps = (sprints: readonly Sprint[]): AppDeps =>
  ({
    sprintRepo: fakeSprintRepo(sprints),
    projectRepo: {} as never,
    sprintExecutionRepo: {} as never,
    taskRepo: {} as never,
    settingsRepo: {} as never,
  }) as unknown as AppDeps;

const makeSprint = (overrides: Record<string, unknown> = {}): Sprint =>
  ({
    id: 'sprint-id',
    slug: 'demo-sprint',
    name: 'Demo Sprint',
    projectId: 'proj',
    status: 'draft',
    tickets: [],
    ...overrides,
  }) as unknown as Sprint;

describe('SprintsView', () => {
  it('shows the empty state when no sprints exist (no project picked)', async () => {
    const { result } = renderView(<SprintsView />, { deps: stubDeps([]), initial: { id: 'sprints' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('No sprints yet');
    expect(frame).toContain('Pick a project first');
    result.unmount();
  });

  it('renders one row per sprint with name, status, ticket count', async () => {
    const sprint = makeSprint({ name: 'Spring Sprint', slug: 'spring' });
    const { result } = renderView(<SprintsView />, { deps: stubDeps([sprint]), initial: { id: 'sprints' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Spring Sprint');
    expect(frame).toContain('spring');
    expect(frame).toMatch(/DRAFT/i);
    expect(frame).toContain('1 sprint(s)');
    result.unmount();
  });

  it('publishes c / d / r hints to the status bar', async () => {
    const sprint = makeSprint({});
    const { result } = renderView(<SprintsView />, { deps: stubDeps([sprint]), initial: { id: 'sprints' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('c create');
    expect(frame).toContain('d delete');
    result.unmount();
  });
});
