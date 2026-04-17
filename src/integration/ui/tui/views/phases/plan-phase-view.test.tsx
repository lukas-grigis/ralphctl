import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Sprint, Task, Tasks } from '@src/domain/models.ts';

import type { DomainResult } from '@src/domain/types.ts';
import type { PipelineResult } from '@src/business/pipelines/framework/types.ts';

const getSprintMock = vi.fn<(id: string) => Promise<Sprint>>();
const getTasksMock = vi.fn<(id: string) => Promise<Tasks>>();
const executePipelineMock = vi.fn<() => Promise<DomainResult<PipelineResult>>>();
const createPlanPipelineMock = vi.fn(() => ({ name: 'plan', steps: [] }));

vi.mock('@src/integration/bootstrap.ts', () => ({
  getSharedDeps: () => ({
    persistence: {
      getSprint: (id: string) => getSprintMock(id),
      getTasks: (id: string) => getTasksMock(id),
    },
  }),
}));

vi.mock('@src/application/factories.ts', () => ({
  createPlanPipeline: () => createPlanPipelineMock(),
}));

vi.mock('@src/business/pipelines/framework/pipeline.ts', () => ({
  executePipeline: () => executePipelineMock(),
}));

import { PlanPhaseView } from './plan-phase-view.tsx';

function sprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 'sprint-1',
    name: 'Demo Sprint',
    projectId: 'prj00001',
    status: 'draft',
    createdAt: '2026-04-16T00:00:00Z',
    activatedAt: null,
    closedAt: null,
    tickets: [],
    checkRanAt: {},
    branch: null,
    ...overrides,
  };
}

function task(overrides: Partial<Task>): Task {
  return {
    id: 't',
    name: 'Task',
    steps: [],
    verificationCriteria: [],
    status: 'todo',
    order: 1,
    blockedBy: [],
    repoId: 'repo0001',
    verified: false,
    evaluated: false,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('PlanPhaseView', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('shows the empty-tasks state and "Plan Tasks" action when requirements are approved', async () => {
    getSprintMock.mockResolvedValue(
      sprint({
        tickets: [{ id: 'a', title: 'T', requirementStatus: 'approved' }],
      })
    );
    getTasksMock.mockResolvedValue([]);

    const { lastFrame } = render(<PlanPhaseView sprintId="sprint-1" />);
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Plan — Demo Sprint');
    expect(frame).toContain('0/1 tickets planned');
    expect(frame).toContain('no tasks yet');
    expect(frame).toContain('Press Enter to plan tasks');
  });

  it('groups tasks by project path and surfaces the Re-Plan label when tasks exist', async () => {
    getSprintMock.mockResolvedValue(
      sprint({
        tickets: [
          { id: 'a', title: 'T1', requirementStatus: 'approved' },
          { id: 'b', title: 'T2', requirementStatus: 'approved' },
        ],
      })
    );
    getTasksMock.mockResolvedValue([
      task({ id: 't1', name: 'Task one', repoId: 'repo-a', ticketId: 'a' }),
      task({ id: 't2', name: 'Task two', repoId: 'repo-a', ticketId: 'a' }),
      task({ id: 't3', name: 'Task three', repoId: 'repo-b', ticketId: 'b' }),
    ]);

    const { lastFrame } = render(<PlanPhaseView sprintId="sprint-1" />);
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('2/2 tickets planned');
    expect(frame).toContain('repo-a');
    expect(frame).toContain('repo-b');
    expect(frame).toContain('Task one');
    expect(frame).toContain('Task three');
    expect(frame).toContain('Press Enter to re-plan tasks');
  });

  it('explains why the plan action is unavailable until refinement completes', async () => {
    getSprintMock.mockResolvedValue(
      sprint({
        tickets: [
          { id: 'a', title: 'T1', requirementStatus: 'pending' },
          { id: 'b', title: 'T2', requirementStatus: 'approved' },
        ],
      })
    );
    getTasksMock.mockResolvedValue([]);

    const { lastFrame } = render(<PlanPhaseView sprintId="sprint-1" />);
    await flush();

    expect(lastFrame() ?? '').toContain('All tickets must be refined before planning');
  });
});
