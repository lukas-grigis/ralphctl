import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import type { Task } from '@src/domain/models.ts';
import { RouterProvider, type RouterApi } from '../router-context.ts';

const resolveSprintIdMock = vi.fn<(id?: string) => Promise<string>>();
const listTasksMock = vi.fn<(id?: string) => Promise<Task[]>>();

vi.mock('@src/integration/persistence/sprint.ts', () => ({
  resolveSprintId: (id?: string) => resolveSprintIdMock(id),
}));
vi.mock('@src/integration/persistence/task.ts', () => ({
  listTasks: (id?: string) => listTasksMock(id),
}));

import { EvaluationsView } from './evaluations-view.tsx';

const router: RouterApi = {
  current: { id: 'evaluations' },
  stack: [{ id: 'home' }, { id: 'evaluations' }],
  push: vi.fn(),
  pop: vi.fn(),
  replace: vi.fn(),
  reset: vi.fn(),
};

function withRouter(node: React.ReactElement): React.ReactElement {
  return <RouterProvider value={router}>{node}</RouterProvider>;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
}

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    name: 'Implement feature',
    steps: [],
    verificationCriteria: [],
    status: 'done',
    order: 1,
    blockedBy: [],
    repoId: 'r1',
    verified: false,
    evaluated: true,
    evaluationStatus: 'passed',
    evaluationOutput: 'Looks good — all dimensions green.',
    ...overrides,
  };
}

describe('EvaluationsView', () => {
  afterEach(() => vi.clearAllMocks());

  it('shows empty state when no task has evaluation output', async () => {
    resolveSprintIdMock.mockResolvedValue('s1');
    listTasksMock.mockResolvedValue([
      task({ evaluationStatus: undefined, evaluationOutput: undefined, evaluated: false }),
    ]);

    const { lastFrame } = render(withRouter(<EvaluationsView sprintId="s1" />));
    await flush();

    expect(lastFrame() ?? '').toContain('No evaluations yet');
  });

  it('renders a row for each evaluated task', async () => {
    resolveSprintIdMock.mockResolvedValue('s1');
    listTasksMock.mockResolvedValue([task(), task({ id: 't2', name: 'Other task', evaluationStatus: 'failed' })]);

    const { lastFrame } = render(withRouter(<EvaluationsView sprintId="s1" />));
    await flush();

    const frame = lastFrame() ?? '';
    expect(frame).toContain('EVALUATIONS');
    expect(frame).toContain('Implement feature');
    expect(frame).toContain('Other task');
  });
});
