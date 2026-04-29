import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordRun, type RunState } from '@src/integration/runtime/runs-store.ts';
import { captureOutput } from '@src/test-utils/setup.ts';

let runsRoot: string;

beforeEach(async () => {
  runsRoot = await mkdtemp(join(tmpdir(), 'ralphctl-list-runs-'));
  process.env['RALPHCTL_ROOT'] = runsRoot;
});

afterEach(async () => {
  delete process.env['RALPHCTL_ROOT'];
  await rm(runsRoot, { recursive: true, force: true });
});

function makeState(overrides: Partial<RunState> = {}): RunState {
  return {
    executionId: 'exec-1',
    pid: process.pid,
    sprintId: 'sprint-a',
    projectName: 'alpha',
    status: 'running',
    startedAt: '2026-04-29T00:00:00.000Z',
    ...overrides,
  };
}

describe('sprint list-runs', () => {
  it('shows an empty-state hint when no runs exist', async () => {
    const { sprintListRunsCommand } = await import('./list-runs.ts');
    const output = await captureOutput(() => sprintListRunsCommand());
    expect(output).toContain('No runs yet');
    expect(output).toContain('ralphctl sprint start');
  });

  it('renders rows for each persisted run with status, project, sprint, and pid', async () => {
    await recordRun(makeState({ executionId: 'exec-a', sprintId: 'sprint-1', projectName: 'alpha' }));
    await recordRun(
      makeState({
        executionId: 'exec-b',
        sprintId: 'sprint-2',
        projectName: 'beta',
        startedAt: '2026-04-29T01:00:00.000Z',
      })
    );

    const { sprintListRunsCommand } = await import('./list-runs.ts');
    const output = await captureOutput(() => sprintListRunsCommand());

    expect(output).toContain('alpha');
    expect(output).toContain('beta');
    expect(output).toContain('sprint-1');
    expect(output).toContain('sprint-2');
    expect(output).toContain(String(process.pid));
    expect(output).toContain('Showing 2 run(s)');
  });

  it('prunes stale entries before rendering — dead PID becomes cancelled', async () => {
    const deadPid = 2_147_483_647;
    await recordRun(makeState({ executionId: 'exec-zombie', sprintId: 'sprint-a', pid: deadPid }));

    const { sprintListRunsCommand } = await import('./list-runs.ts');
    const output = await captureOutput(() => sprintListRunsCommand());

    expect(output).toContain('cancelled');
    // The footer shows "0 running" because the zombie was reaped.
    expect(output).toContain('0 running');
  });

  it('shows two parallel runs simultaneously', async () => {
    await recordRun(makeState({ executionId: 'exec-a', sprintId: 'sprint-1', projectName: 'alpha' }));
    await recordRun(makeState({ executionId: 'exec-b', sprintId: 'sprint-2', projectName: 'beta' }));

    const { sprintListRunsCommand } = await import('./list-runs.ts');
    const output = await captureOutput(() => sprintListRunsCommand());

    // Both projects appear, both rows present, "running" appears at least twice.
    expect(output).toContain('alpha');
    expect(output).toContain('beta');
    const runningMatches = output.match(/running/g) ?? [];
    expect(runningMatches.length).toBeGreaterThanOrEqual(2);
  });
});
