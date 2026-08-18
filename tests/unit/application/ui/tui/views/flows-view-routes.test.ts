/**
 * Route shapes for the use-case-shaped flows the Flows menu opens as a view instead of
 * launching as a chain. The `id` + `props` pair must match what the destination view reads and
 * what the OTHER entry points push (Home's `a` row and sprint-detail's `a` chord both push
 * `{ id: 'add-ticket', props: { sprintId } }`) — a mismatch renders an empty wizard rather than
 * failing loudly.
 */

import { describe, expect, it } from 'vitest';
import { viewRouteFor } from '@src/application/ui/tui/views/flows-view.tsx';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';

const PROJECT_ID = 'project-fixture-id' as unknown as ProjectId;
const SPRINT_ID = 'sprint-fixture-id' as unknown as SprintId;

const project = {
  id: PROJECT_ID,
  slug: 'fixture-project',
  displayName: 'Fixture Project',
  repositories: [],
} as unknown as Project;

const sprint = {
  id: SPRINT_ID,
  projectId: PROJECT_ID,
  slug: 'fixture-sprint',
  name: 'Fixture Sprint',
  status: 'draft',
  tickets: [],
} as unknown as Sprint;

const snapshotWithSprint: AppStateSnapshot = {
  project,
  sprint,
  tasks: [],
  triggerInputs: {
    hasProject: true,
    currentSprintStatus: 'draft',
    pendingTicketCount: 0,
    approvedTicketCount: 0,
    resumableTaskCount: 0,
  },
  projectCount: 1,
  sprintCount: 1,
  recentSprints: [sprint],
};

const { sprint: _omitted, ...snapshotWithoutSprint } = snapshotWithSprint;
void _omitted;

describe('viewRouteFor', () => {
  it('routes add-ticket to the add-ticket wizard with the selected sprint id', () => {
    expect(viewRouteFor('add-ticket', snapshotWithSprint)).toEqual({
      id: 'add-ticket',
      props: { sprintId: SPRINT_ID },
    });
  });

  it('routes remove-ticket to sprint-detail (removal happens inline there)', () => {
    expect(viewRouteFor('remove-ticket', snapshotWithSprint)).toEqual({
      id: 'sprint-detail',
      props: { sprintId: SPRINT_ID },
    });
  });

  it('yields no route for the sprint-scoped ticket flows when no sprint is selected', () => {
    expect(viewRouteFor('add-ticket', snapshotWithoutSprint)).toBeUndefined();
    expect(viewRouteFor('remove-ticket', snapshotWithoutSprint)).toBeUndefined();
  });

  it.each([['doctor'], ['settings'], ['export-context'], ['export-requirements'], ['create-pr']])(
    'routes %s to its own view without needing a sprint',
    (flowId) => {
      expect(viewRouteFor(flowId, snapshotWithoutSprint)).toEqual({ id: flowId });
    }
  );

  it('yields no route for chain-launched flows', () => {
    for (const flowId of ['refine', 'plan', 'implement', 'create-sprint']) {
      expect(viewRouteFor(flowId, snapshotWithSprint)).toBeUndefined();
    }
  });
});
