/**
 * Smoke tests for FlowsView. Verifies the eligibility card reflects the snapshot, every
 * registered flow appears in the menu, and project / sprint badges render with the right
 * placeholder when nothing is selected.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { FlowsView } from '@src/application/ui/tui/views/flows-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

const emptyDeps: AppDeps = {
  projectRepo: {
    async list() {
      return Result.ok([]);
    },
  } as unknown as ProjectRepository,
  sprintRepo: {
    async list() {
      return Result.ok([]);
    },
  } as unknown as SprintRepository,
  taskRepo: {
    async findBySprintId() {
      return Result.ok([]);
    },
  } as unknown as TaskRepository,
} as unknown as AppDeps;

describe('FlowsView', () => {
  it('renders the eligibility card with (none) badges on a fresh install', async () => {
    const { result } = renderView(<FlowsView />, { deps: emptyDeps, initial: { id: 'flows' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Eligibility');
    expect(frame).toContain('(none)');
    result.unmount();
  });

  it('hides every flow on a fresh install (no project, no sprint) — visibility helper short-circuits', async () => {
    // Sprint-state-machine visibility: with no project loaded, the project-scoped section is
    // hidden too; the user is meant to land here only after picking or creating a project.
    const { result } = renderView(<FlowsView />, { deps: emptyDeps, initial: { id: 'flows' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).not.toContain('Create sprint');
    expect(frame).not.toContain('Refine');
    expect(frame).not.toContain('Plan');
    expect(frame).not.toContain('Implement');
    result.unmount();
  });

  it('publishes the r reload-state hint', async () => {
    const { result } = renderView(<FlowsView />, { deps: emptyDeps, initial: { id: 'flows' } });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toMatch(/reload/);
    result.unmount();
  });
});
