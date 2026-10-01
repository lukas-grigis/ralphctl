/**
 * The pipeline's highlighted stage and the first flow row `buildNextSteps` offers must name the
 * same phase — before they were separate tables and one screen said "Refine" while advising Plan.
 */

import { describe, expect, it } from 'vitest';
import { renderAtSize } from '@tests/helpers/render-at-size.tsx';
import { SprintPipeline } from '@src/application/ui/tui/components/sprint-pipeline.tsx';
import { buildNextSteps, nextStepsInputFromSnapshot } from '@src/application/ui/shared/next-steps.ts';
import { snapshotFromLoadedSprint } from '@src/application/ui/shared/state-snapshot.ts';
import type { Sprint, SprintStatus } from '@src/domain/entity/sprint.ts';
import type { Task } from '@src/domain/entity/task.ts';
import {
  makeActiveSprint,
  makeApprovedTicket,
  makeDoneSprint,
  makeDraftSprint,
  makePendingTicket,
  makePlannedSprint,
  makeProject,
  makeReviewSprint,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';

const sprintFor = (status: SprintStatus, pending: boolean): Sprint => {
  switch (status) {
    case 'draft':
      // A pending ticket is not an ApprovedTicket; the draft fixture types its tickets loosely.
      return pending
        ? { ...makeDraftSprint(), tickets: [makePendingTicket()] }
        : makeDraftSprint({ tickets: [makeApprovedTicket()] });
    case 'planned':
      return makePlannedSprint();
    case 'active':
      return makeActiveSprint();
    case 'review':
      return makeReviewSprint();
    case 'done':
      return makeDoneSprint();
  }
};

const STAGE_FLOW: Record<string, string> = {
  Refine: 'refine',
  Plan: 'plan',
  Implement: 'implement',
  Review: 'review',
  Done: 'create-pr',
};

const activeStageOf = (frame: string): string | undefined => /◆ (\w+)/.exec(frame)?.[1];

describe('SprintPipeline stage vs the first flow next step', () => {
  const cases: ReadonlyArray<readonly [SprintStatus, boolean]> = [
    ['draft', true],
    ['draft', false],
    ['planned', false],
    ['active', false],
    ['review', false],
    ['done', false],
  ];

  it.each(cases)('%s (pending tickets: %s) highlights the stage of the first flow row', (status, pending) => {
    const tasks: Task[] = status === 'planned' || status === 'active' ? [makeTodoTask()] : [];
    const snapshot = snapshotFromLoadedSprint({
      project: makeProject(),
      sprint: sprintFor(status, pending),
      tasks,
    });
    const flow = buildNextSteps(nextStepsInputFromSnapshot(snapshot)).steps.find((s) => s.flow !== undefined)?.flow;
    expect(flow).toBeDefined();

    const r = renderAtSize(<SprintPipeline snapshot={snapshot} />, { columns: 100, rows: 24 });
    const stage = activeStageOf(r.lastFrame() ?? '');
    r.unmount();
    expect(stage).toBeDefined();
    expect(STAGE_FLOW[stage ?? '']).toBe(flow);
  });

  it('a draft sprint with no tickets sits at Refine, not Plan', () => {
    const snapshot = snapshotFromLoadedSprint({ project: makeProject(), sprint: makeDraftSprint(), tasks: [] });
    const r = renderAtSize(<SprintPipeline snapshot={snapshot} />, { columns: 100, rows: 24 });
    expect(activeStageOf(r.lastFrame() ?? '')).toBe('Refine');
    r.unmount();
  });
});
