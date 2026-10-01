/**
 * The `flows` route alias renders Work with the flow list focused. Covers the flow rows' visibility,
 * their trigger reasons, the cost hint, and the first-FLOWS-row cursor seed.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { FlowsAliasView } from '@src/application/ui/tui/views/flows-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { DOWN, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

const FIXED_PROJECT_ID = 'project-fixture-id' as unknown as ProjectId;
const FIXED_SPRINT_ID = 'sprint-fixture-id' as unknown as SprintId;

const emptyDeps: AppDeps = {
  eventBus: createInMemoryEventBus(),
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

/**
 * Build deps for a project + draft sprint with zero tickets and zero tasks. With this
 * snapshot several sprint-scoped flows are visible but gated:
 *   - Refine: dimmed — Requires at least 1 pending ticket(s) (have 0).
 *   - Plan:   dimmed — Requires at least 1 approved ticket(s) (have 0).
 *   - Remove ticket: enabled (no extra trigger beyond draft status).
 */
const makeProjectSprintDeps = (
  project: Partial<Project> & { readonly id: ProjectId },
  sprint: Partial<Sprint> & { readonly id: SprintId; readonly projectId: ProjectId }
): AppDeps => {
  const fullProject = {
    slug: 'fixture-project',
    displayName: 'Fixture Project',
    repositories: [],
    ...project,
  } as unknown as Project;
  const fullSprint = {
    slug: 'fixture-sprint',
    name: 'Fixture Sprint',
    status: 'draft',
    tickets: [],
    ...sprint,
  } as unknown as Sprint;
  return {
    eventBus: createInMemoryEventBus(),
    projectRepo: {
      async list() {
        return Result.ok([fullProject]);
      },
      async findById() {
        return Result.ok(fullProject);
      },
    } as unknown as ProjectRepository,
    sprintRepo: {
      async list() {
        return Result.ok([fullSprint]);
      },
      async findById() {
        return Result.ok(fullSprint);
      },
    } as unknown as SprintRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([]);
      },
    } as unknown as TaskRepository,
  } as unknown as AppDeps;
};

const selected = { projectId: FIXED_PROJECT_ID, sprintId: FIXED_SPRINT_ID };
const draftDeps = (): AppDeps =>
  makeProjectSprintDeps({ id: FIXED_PROJECT_ID }, { id: FIXED_SPRINT_ID, projectId: FIXED_PROJECT_ID });

describe('flows alias (Work, flow list focused)', () => {
  it('shows the create-project hero and no flows on a fresh install', async () => {
    const { result } = renderView(<FlowsAliasView />, { deps: emptyDeps, initial: { id: 'flows' } });
    await waitForPredicate(() => /Start by creating a project/.test(result.lastFrame() ?? ''));
    const frame = result.lastFrame() ?? '';
    expect(frame).not.toContain('Create sprint');
    expect(frame.split('\n').some((l) => l.includes('Refine') && !l.includes('→'))).toBe(false);
    expect(frame).not.toContain('Implement');
    result.unmount();
  });

  it('shows the no-sprint hero plus the project-scoped flows when no sprint is selected', async () => {
    const { result } = renderView(<FlowsAliasView />, {
      deps: draftDeps(),
      initial: { id: 'flows' },
      selection: { projectId: FIXED_PROJECT_ID },
    });
    await waitForPredicate(() => /ready for the first sprint|pick or create a sprint/.test(result.lastFrame() ?? ''));
    expect(result.lastFrame() ?? '').toContain('Create sprint');
    result.unmount();
  });

  it('publishes the r reload hint', async () => {
    const { result } = renderView(<FlowsAliasView />, {
      deps: draftDeps(),
      initial: { id: 'flows' },
      selection: selected,
    });
    await waitForPredicate(() => /reload/.test(result.lastFrame() ?? ''));
    result.unmount();
  });

  it('lists only the flows that can run, and puts the cursor on the first FLOWS row', async () => {
    // Draft sprint, zero tickets: Refine and Plan are gated, Remove ticket is eligible.
    const { result } = renderView(<FlowsAliasView />, {
      deps: draftDeps(),
      initial: { id: 'flows' },
      selection: selected,
    });
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Remove ticket'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Add ticket');
    expect(frame.split('\n').some((l) => l.includes('Refine') && !l.includes('→'))).toBe(false);
    expect(frame).not.toContain('No project is loaded.');
    const flowsHeader = frame.split('\n').findIndex((l) => l.includes('FLOWS'));
    expect(frame.split('\n')[flowsHeader + 1]).toContain('▸');
    result.unmount();
  });

  it('v adds the gated flows dim, each with its trigger reason inline', async () => {
    const { result } = renderView(<FlowsAliasView />, {
      deps: draftDeps(),
      initial: { id: 'flows' },
      selection: selected,
    });
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Remove ticket'));
    result.stdin.write('v');
    await waitForPredicate(() =>
      (result.lastFrame() ?? '').split('\n').some((l) => l.includes('Refine') && !l.includes('→'))
    );
    const refine = (result.lastFrame() ?? '').split('\n').find((l) => l.includes('Refine') && !l.includes('→')) ?? '';
    expect(refine).toMatch(/ticket/i);
    expect(refine).not.toContain('▸');
    result.unmount();
  });

  it('never lands the cursor on a gated row while moving', async () => {
    const { result } = renderView(<FlowsAliasView />, {
      deps: draftDeps(),
      initial: { id: 'flows' },
      selection: selected,
    });
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Remove ticket'));
    result.stdin.write('v');
    await waitForPredicate(() =>
      (result.lastFrame() ?? '').split('\n').some((l) => l.includes('Refine') && !l.includes('→'))
    );
    for (let i = 0; i < 12; i++) {
      result.stdin.write(DOWN);
      await tick(20);
      const focused = (result.lastFrame() ?? '').split('\n').find((l) => l.includes('▸')) ?? '';
      expect(focused).not.toMatch(/Refine|Plan|Implement|Review|Close sprint/);
    }
    result.unmount();
  });
});

describe('flows alias — cost hints (manifest → menu threading)', () => {
  /** Ideate is hidden by default; `v` reveals it, and focusing the row shows the manifest's costHint. */
  it('threads the ideate costHint from the manifest into the rendered menu', async () => {
    const { result } = renderView(<FlowsAliasView />, {
      deps: draftDeps(),
      initial: { id: 'flows' },
      selection: selected,
    });
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Remove ticket'));
    result.stdin.write('v');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Ideate'));

    const IDEATE_HINT = 'single AI session';
    let found = false;
    for (let i = 0; i < 25; i++) {
      if ((result.lastFrame() ?? '').includes(IDEATE_HINT)) {
        found = true;
        break;
      }
      result.stdin.write(DOWN);
      await tick(20);
    }
    expect(found, 'ideate cost hint should appear when the Ideate row is focused').toBe(true);
    result.unmount();
  });
});
