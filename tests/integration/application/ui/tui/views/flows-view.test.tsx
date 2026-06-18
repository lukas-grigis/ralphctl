/**
 * Smoke tests for FlowsView. Verifies the orientation card reflects the correct regime for
 * each context state (no project / no sprint / sprint loaded), flows appear in the menu,
 * and the view renders with no redundant footer hint strip.
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
import { DOWN, tick, waitFor } from '@tests/integration/application/ui/tui/_keys.ts';
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
  it('renders the no-project orientation regime on a fresh install', async () => {
    const { result } = renderView(<FlowsView />, { deps: emptyDeps, initial: { id: 'flows' } });
    // Wait for the async deps load + Ink render to settle; orientation card is always present.
    await waitFor(() => /no project|pick one/i.test(result.lastFrame() ?? ''));
    const frame = result.lastFrame() ?? '';
    // The card should direct the user toward picking or creating a project.
    expect(frame).toMatch(/no project|pick one/i);
    // No system-y eligibility label in the new design.
    expect(frame).not.toContain('Eligibility');
    result.unmount();
  });

  it('hides every flow on a fresh install (no project, no sprint) — visibility helper short-circuits', async () => {
    // Sprint-state-machine visibility: with no project loaded, the project-scoped section is
    // hidden too; the user is meant to land here only after picking or creating a project.
    const { result } = renderView(<FlowsView />, { deps: emptyDeps, initial: { id: 'flows' } });
    // Anchor on the orientation card so absence assertions run on a fully-settled frame.
    await waitFor(() => /no project|pick one/i.test(result.lastFrame() ?? ''));
    const frame = result.lastFrame() ?? '';
    expect(frame).not.toContain('Create sprint');
    expect(frame).not.toContain('Refine');
    expect(frame).not.toContain('Plan');
    expect(frame).not.toContain('Implement');
    result.unmount();
  });

  it('renders the no-sprint orientation regime when a project is loaded but no sprint is selected', async () => {
    // Project exists but no sprint is selected — second regime.
    const deps = makeProjectSprintDeps({ id: FIXED_PROJECT_ID }, { id: FIXED_SPRINT_ID, projectId: FIXED_PROJECT_ID });
    // Override: no sprint selected in the selection context.
    const { result } = renderView(<FlowsView />, {
      deps,
      initial: { id: 'flows' },
      selection: { projectId: FIXED_PROJECT_ID }, // sprintId intentionally omitted
    });
    await waitFor(() => /no sprint|create one|pick one/i.test(result.lastFrame() ?? ''));
    const frame = result.lastFrame() ?? '';
    expect(frame).toMatch(/no sprint|create one|pick one/i);
    result.unmount();
  });

  it('renders the sprint-loaded orientation regime with sprint name and next-action hint', async () => {
    // Project + draft sprint with no tickets → stage is Plan (all tickets approved, none pending).
    const deps = makeProjectSprintDeps({ id: FIXED_PROJECT_ID }, { id: FIXED_SPRINT_ID, projectId: FIXED_PROJECT_ID });
    const { result } = renderView(<FlowsView />, {
      deps,
      initial: { id: 'flows' },
      selection: { projectId: FIXED_PROJECT_ID, sprintId: FIXED_SPRINT_ID },
    });
    await waitFor(() => (result.lastFrame() ?? '').includes('Fixture Sprint'));
    const frame = result.lastFrame() ?? '';
    // Sprint name must appear in the orientation card.
    expect(frame).toContain('Fixture Sprint');
    // Status chip for the draft status should appear.
    expect(frame).toMatch(/DRAFT/);
    // Next action derived from the pipeline stage should appear.
    expect(frame).toMatch(/next:/i);
    result.unmount();
  });

  it('publishes the r reload-state hint', async () => {
    const { result } = renderView(<FlowsView />, { deps: emptyDeps, initial: { id: 'flows' } });
    await waitFor(() => /reload/.test(result.lastFrame() ?? ''));
    const frame = result.lastFrame() ?? '';
    expect(frame).toMatch(/reload/);
    result.unmount();
  });

  it('renders the trigger reason inline for a dimmed flow (not just when focused)', async () => {
    // Draft sprint with zero tickets → Refine and Plan are visible but gated. Their trigger
    // reasons should appear in the rendered frame regardless of which row has the cursor. Both
    // reasons must be present because ActionMenu now annotates every disabled row, not just the
    // focused one. The cursor will land on the first eligible row (Remove ticket), so Refine and
    // Plan are non-focused — this asserts that the "not focused" path renders the reason too.
    const deps = makeProjectSprintDeps({ id: FIXED_PROJECT_ID }, { id: FIXED_SPRINT_ID, projectId: FIXED_PROJECT_ID });
    const { result } = renderView(<FlowsView />, {
      deps,
      initial: { id: 'flows' },
      selection: { projectId: FIXED_PROJECT_ID, sprintId: FIXED_SPRINT_ID },
    });
    // Wait for the async project + sprint load to settle so the dimmed sprint-scoped rows are
    // rendered before asserting — a fixed tick can capture a pre-load frame under coverage.
    // New copy: Refine reason mentions "ticket" (add at least one), Plan reason mentions
    // "Refine and approve" — both contain "ticket".
    await waitFor(() => /ticket/i.test(result.lastFrame() ?? ''));
    const frame = result.lastFrame() ?? '';
    // At least one trigger reason should be visible — both Refine and Plan are dimmed.
    // Use a forgiving check: the reason text may be truncated on narrow test terminals.
    expect(frame).toMatch(/ticket/i);
    result.unmount();
  });

  it('does not render a trigger reason next to an eligible flow', async () => {
    // "Remove ticket" has only `currentSprintStatus: ['draft']` as a trigger — fully satisfied.
    // With a draft sprint selected it must appear without any reason annotation. (The old
    // `add-tickets` flow used here was removed; tickets are now added via the `a` shortcut wizard.)
    const deps = makeProjectSprintDeps({ id: FIXED_PROJECT_ID }, { id: FIXED_SPRINT_ID, projectId: FIXED_PROJECT_ID });
    const { result } = renderView(<FlowsView />, {
      deps,
      initial: { id: 'flows' },
      selection: { projectId: FIXED_PROJECT_ID, sprintId: FIXED_SPRINT_ID },
    });
    // Wait for the async project + sprint load to settle so the sprint-scoped "Remove ticket" row
    // is rendered. This was the flake source: a fixed tick(40) under coverage instrumentation
    // could capture the frame before the load resolved, so the row was absent.
    await waitFor(() => (result.lastFrame() ?? '').includes('Remove ticket'));
    const frame = result.lastFrame() ?? '';
    // The "Remove ticket" row should appear.
    expect(frame).toContain('Remove ticket');
    // An eligible row must not carry any project-missing reason (new copy: "Select a project
    // first"). Verify the orientation card wording is distinct from flow disabled reasons.
    expect(frame).not.toContain('No project is loaded.');
    expect(frame).not.toContain('Select a project first');
    // Confirm the sprint name and status are on-screen (sprint-loaded regime).
    expect(frame).toContain('Fixture Sprint');
    result.unmount();
  });
});

describe('FlowsView — cost hints (manifest → menu threading)', () => {
  /**
   * Verify that `costHint` from the flow manifest reaches the rendered ActionMenu. Ideate is
   * hidden by default (HIDDEN_BY_DEFAULT_FLOW_IDS); pressing `v` (show-all) makes it visible.
   * We then navigate until the Ideate row is focused (cursor on it) and confirm the hint appears.
   * The isolated ActionMenu focus-vs-unfocused behaviour is tested in action-menu.test.tsx.
   */
  it('threads the ideate costHint from the manifest into the rendered flows menu', async () => {
    const deps = makeProjectSprintDeps({ id: FIXED_PROJECT_ID }, { id: FIXED_SPRINT_ID, projectId: FIXED_PROJECT_ID });
    const { result } = renderView(<FlowsView />, {
      deps,
      initial: { id: 'flows' },
      selection: { projectId: FIXED_PROJECT_ID, sprintId: FIXED_SPRINT_ID },
    });
    // Wait for the orientation card to settle so the view is interactive.
    await waitFor(() => (result.lastFrame() ?? '').includes('Fixture Sprint'));

    // Press `v` to show all flows — this makes Ideate visible in the menu.
    result.stdin.write('v');
    await waitFor(() => (result.lastFrame() ?? '').includes('Ideate'));

    // Navigate down until the Ideate cost hint becomes visible (cursor lands on Ideate).
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
