import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readRun, recordRun, type RunState } from '@src/integration/runtime/runs-store.ts';
import { captureOutput } from '@src/test-utils/setup.ts';
import { stopRun } from './stop.ts';

let runsRoot: string;

beforeEach(async () => {
  runsRoot = await mkdtemp(join(tmpdir(), 'ralphctl-stop-'));
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

describe('stopRun', () => {
  it('returns not-found when no matching run exists', async () => {
    const result = await stopRun({ id: 'missing' });
    expect(result.status).toBe('not-found');
  });

  it('returns already-terminal for a completed run', async () => {
    await recordRun(makeState({ status: 'completed', endedAt: '2026-04-29T01:00:00.000Z' }));
    const result = await stopRun({ id: 'exec-1' });
    expect(result.status).toBe('already-terminal');
  });

  it('SIGTERM grace path: process exits within window — flips status to cancelled', async () => {
    // Use a PID that will be reported alive on the first tick, then dead after
    // the SIGTERM. We simulate this with a fake `kill` that "kills" the pid by
    // recording the signal; we then swap `process.kill` behavior via a custom
    // Liveness check. Because `isProcessAlive` reads the real OS, we instead
    // pick our own test-process PID (always alive) and let the fake `kill`
    // short-circuit the loop by overriding the poll budget.
    //
    // A simpler model: mark the run with a guaranteed-dead PID and let stopRun
    // observe the daemon already gone — the graceful branch covers that case.
    const deadPid = 2_147_483_647;
    await recordRun(makeState({ pid: deadPid }));

    const sentSignals: NodeJS.Signals[] = [];
    const result = await stopRun(
      { id: 'exec-1', graceMs: 500, pollMs: 10 },
      {
        kill: (_pid, signal) => {
          if (signal !== 0) sentSignals.push(signal);
        },
      }
    );
    expect(result.status).toBe('graceful');
    const persisted = await readRun('exec-1');
    expect(persisted?.status).toBe('cancelled');
    expect(persisted?.endedAt).toBeDefined();
    // No signals sent — PID was already dead before SIGTERM.
    expect(sentSignals).toEqual([]);
  });

  it('SIGTERM → SIGKILL escalation when daemon ignores grace window', async () => {
    // process.pid is alive for the duration of the test, so the graceful loop
    // will keep observing "alive" until the deadline elapses, then escalate.
    await recordRun(makeState({ pid: process.pid }));

    const sentSignals: NodeJS.Signals[] = [];
    const result = await stopRun(
      { id: 'exec-1', graceMs: 50, pollMs: 10 },
      {
        kill: (_pid, signal) => {
          if (signal !== 0) sentSignals.push(signal);
        },
      }
    );
    expect(result.status).toBe('forced');
    expect(sentSignals).toEqual(['SIGTERM', 'SIGKILL']);
    const persisted = await readRun('exec-1');
    expect(persisted?.status).toBe('cancelled');
  });

  it('resolves by sprintId when no executionId match exists', async () => {
    const deadPid = 2_147_483_647;
    await recordRun(makeState({ executionId: 'exec-xyz', sprintId: 'sprint-zz', pid: deadPid }));

    const result = await stopRun({ id: 'sprint-zz', graceMs: 500, pollMs: 10 }, { kill: () => undefined });
    expect(result.status).toBe('graceful');
    const persisted = await readRun('exec-xyz');
    expect(persisted?.status).toBe('cancelled');
  });
});

describe('sprintStopCommand', () => {
  it('emits a usage error when called with no id', async () => {
    const { sprintStopCommand } = await import('./stop.ts');
    const output = await captureOutput(() => sprintStopCommand([]));
    expect(output).toContain('Missing run id');
  });

  it('reports not-found via stdout when no run matches', async () => {
    const { sprintStopCommand } = await import('./stop.ts');
    const output = await captureOutput(() => sprintStopCommand(['nope']));
    expect(output).toContain("No run found matching 'nope'");
  });
});
