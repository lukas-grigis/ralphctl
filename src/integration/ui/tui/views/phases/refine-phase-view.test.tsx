/**
 * RefinePhaseView tests — mocks the shared deps + factory graph so the view
 * renders deterministically. Verifies ticket table, action availability, and
 * the step-trace update after a mocked pipeline run.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Result } from 'typescript-result';
import type { Sprint } from '@src/domain/models.ts';
import type { StepExecutionRecord } from '@src/business/pipelines/framework/types.ts';

import type { DomainResult } from '@src/domain/types.ts';
import type { PipelineResult } from '@src/business/pipelines/framework/types.ts';

const getSprintMock = vi.fn<(id: string) => Promise<Sprint>>();
const executePipelineMock = vi.fn<() => Promise<DomainResult<PipelineResult>>>();
const createRefinePipelineMock = vi.fn(() => ({ name: 'refine', steps: [] }));

vi.mock('@src/application/bootstrap.ts', () => ({
  getSharedDeps: () => ({
    persistence: {
      getSprint: (id: string) => getSprintMock(id),
    },
  }),
}));

vi.mock('@src/application/factories.ts', () => ({
  createRefinePipeline: () => createRefinePipelineMock(),
}));

vi.mock('@src/business/pipelines/framework/pipeline.ts', () => ({
  executePipeline: () => executePipelineMock(),
}));

import { RefinePhaseView } from './refine-phase-view.tsx';

function sprint(overrides: Partial<Sprint> = {}): Sprint {
  return {
    id: 'sprint-1',
    name: 'Demo Sprint',
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

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('RefinePhaseView', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders tickets with approval badges', async () => {
    getSprintMock.mockResolvedValue(
      sprint({
        name: 'Alpha',
        tickets: [
          { id: 'a', title: 'Pending ticket', projectName: 'p', requirementStatus: 'pending' },
          { id: 'b', title: 'Approved ticket', projectName: 'p', requirementStatus: 'approved' },
        ],
      })
    );

    const { lastFrame } = render(<RefinePhaseView sprintId="sprint-1" />);
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Refine — Alpha');
    expect(frame).toContain('Pending ticket');
    expect(frame).toContain('Approved ticket');
    expect(frame).toContain('1/2 tickets approved');
    expect(frame).toContain('1 pending');
  });

  it('offers the refine action when the draft sprint has pending tickets', async () => {
    getSprintMock.mockResolvedValue(
      sprint({
        tickets: [{ id: 'a', title: 'T', projectName: 'p', requirementStatus: 'pending' }],
      })
    );

    const { lastFrame } = render(<RefinePhaseView sprintId="sprint-1" />);
    await flush();

    expect(lastFrame() ?? '').toContain('Press Enter to refine pending requirements');
  });

  it('explains why the action is unavailable when every ticket is approved', async () => {
    getSprintMock.mockResolvedValue(
      sprint({
        tickets: [{ id: 'a', title: 'T', projectName: 'p', requirementStatus: 'approved' }],
      })
    );

    const { lastFrame } = render(<RefinePhaseView sprintId="sprint-1" />);
    await flush();

    expect(lastFrame() ?? '').toContain('All requirements already approved');
  });

  it('explains why the action is unavailable on an active sprint', async () => {
    getSprintMock.mockResolvedValue(
      sprint({
        status: 'active',
        activatedAt: '2026-04-16T01:00:00Z',
        tickets: [{ id: 'a', title: 'T', projectName: 'p', requirementStatus: 'approved' }],
      })
    );

    const { lastFrame } = render(<RefinePhaseView sprintId="sprint-1" />);
    await flush();

    expect(lastFrame() ?? '').toContain('Refine requires a draft sprint');
  });

  it('renders the step trace after a pipeline run completes', async () => {
    getSprintMock.mockResolvedValue(
      sprint({
        tickets: [{ id: 'a', title: 'T', projectName: 'p', requirementStatus: 'pending' }],
      })
    );
    const records: StepExecutionRecord[] = [
      { stepName: 'load-sprint', status: 'success', durationMs: 10 },
      { stepName: 'refine-tickets', status: 'success', durationMs: 1200 },
    ];
    executePipelineMock.mockResolvedValue(Result.ok({ context: { sprintId: 'sprint-1' }, stepResults: records }));

    const { lastFrame, stdin } = render(<RefinePhaseView sprintId="sprint-1" />);
    await flush();

    stdin.write('\r'); // Enter
    await flush();
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('refine-tickets');
    expect(frame).toContain('1.2s');
  });
});
