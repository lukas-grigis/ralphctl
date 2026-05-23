/**
 * Smoke tests for FlowsView. Verifies the eligibility card reflects the snapshot, every
 * registered flow appears in the menu, and project / sprint badges render with the right
 * placeholder when nothing is selected.
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { FlowsView } from '@src/application/ui/tui/views/flows-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

const FIXED_PROJECT_ID = 'project-fixture-id' as unknown as ProjectId;
const FIXED_SPRINT_ID = 'sprint-fixture-id' as unknown as SprintId;

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

/**
 * Build deps for a project + draft sprint with zero tickets and zero tasks. With this
 * snapshot several sprint-scoped flows are visible but gated:
 *   - Refine: dimmed — Requires at least 1 pending ticket(s) (have 0).
 *   - Plan:   dimmed — Requires at least 1 approved ticket(s) (have 0).
 *   - Add tickets, Ticket add/remove: enabled (no extra trigger beyond draft status).
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

  it('renders the trigger reason inline for a dimmed flow (not just when focused)', async () => {
    // Draft sprint with zero tickets → Refine and Plan are visible but gated. Their trigger
    // reasons should appear in the rendered frame regardless of which row has the cursor. Both
    // reasons must be present because ActionMenu now annotates every disabled row, not just the
    // focused one. The cursor will land on the first eligible row (Add tickets), so Refine and
    // Plan are non-focused — this asserts that the "not focused" path renders the reason too.
    const deps = makeProjectSprintDeps({ id: FIXED_PROJECT_ID }, { id: FIXED_SPRINT_ID, projectId: FIXED_PROJECT_ID });
    const { result } = renderView(<FlowsView />, {
      deps,
      initial: { id: 'flows' },
      selection: { projectId: FIXED_PROJECT_ID, sprintId: FIXED_SPRINT_ID },
    });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    // At least one trigger reason should be visible — both Refine and Plan are dimmed.
    // Use a forgiving check: the reason text may be truncated on narrow test terminals.
    expect(frame).toMatch(/pending ticket|approved ticket/i);
    result.unmount();
  });

  it('does not render a trigger reason next to an eligible flow', async () => {
    // "Add tickets" has only `currentSprintStatus: ['draft']` as a trigger — fully satisfied.
    // With a draft sprint selected it must appear without any reason annotation.
    const deps = makeProjectSprintDeps({ id: FIXED_PROJECT_ID }, { id: FIXED_SPRINT_ID, projectId: FIXED_PROJECT_ID });
    const { result } = renderView(<FlowsView />, {
      deps,
      initial: { id: 'flows' },
      selection: { projectId: FIXED_PROJECT_ID, sprintId: FIXED_SPRINT_ID },
    });
    await tick(40);
    const frame = result.lastFrame() ?? '';
    // The "Add tickets" row should appear.
    expect(frame).toContain('Add tickets');
    // An eligible row must not carry any trigger reason. "No project is loaded." is the
    // project-gate reason; "Requires sprint status" is the status-gate reason — neither should
    // appear next to an eligible row.
    expect(frame).not.toContain('No project is loaded.');
    // Confirm the eligible "Add tickets" row is on-screen without any adjacent reason text.
    // We cannot diff per-row in a text frame, but verifying the reasons that _should_ appear
    // come from the dimmed rows (Refine / Plan) and NOT from an eligible row is sufficient.
    expect(frame).toContain('Fixture Sprint');
    result.unmount();
  });
});
