/**
 * Verify `ralphctl sprint attach <id>`:
 *   - Resolves a direct executionId to its run state
 *   - Resolves a sprintId to the most-recent running daemon for that sprint
 *   - Mounts the Ink TUI in attach mode for live runs
 *   - Falls back to a one-line status report on non-TTY (mountInk reports fallback)
 *   - Errors on missing id and on unknown id
 *   - Warns when the resolved run is already terminal
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { recordRun, type RunState } from '@src/integration/runtime/runs-store.ts';
import { captureOutput } from '@src/test-utils/setup.ts';

let runsRoot: string;

beforeEach(async () => {
  runsRoot = await mkdtemp(join(tmpdir(), 'ralphctl-attach-'));
  process.env['RALPHCTL_ROOT'] = runsRoot;
});

afterEach(async () => {
  delete process.env['RALPHCTL_ROOT'];
  await rm(runsRoot, { recursive: true, force: true });
});

function makeRun(overrides: Partial<RunState> = {}): RunState {
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

describe('sprint attach', () => {
  it('errors when no id is provided', async () => {
    const { sprintAttachCommand } = await import('./attach.ts');
    const output = await captureOutput(() => sprintAttachCommand([]));
    expect(output).toContain('Missing run id');
  });

  it('errors when id matches no run', async () => {
    const { sprintAttachCommand } = await import('./attach.ts');
    const output = await captureOutput(() => sprintAttachCommand(['unknown-id']));
    expect(output.toLowerCase()).toContain('no run found');
  });

  it('warns and exits when the resolved run is already terminal', async () => {
    await recordRun(
      makeRun({
        executionId: 'exec-done',
        sprintId: 'sprint-x',
        status: 'completed',
        endedAt: '2026-04-29T00:30:00.000Z',
      })
    );
    const { sprintAttachCommand } = await import('./attach.ts');
    const output = await captureOutput(() => sprintAttachCommand(['exec-done']));
    expect(output).toContain('completed');
    expect(output.toLowerCase()).toContain('nothing live');
  });

  it('mounts attach TUI for a live run resolved by executionId', async () => {
    await recordRun(makeRun({ executionId: 'exec-live', sprintId: 'sprint-a' }));
    const mountInk = vi.fn((executionId: string) => {
      void executionId;
      return Promise.resolve({ fallback: false });
    });
    const { sprintAttachCommand } = await import('./attach.ts');
    await captureOutput(() => sprintAttachCommand(['exec-live'], { mountInk }));
    expect(mountInk).toHaveBeenCalledTimes(1);
    expect(mountInk.mock.calls[0]?.[0]).toBe('exec-live');
  });

  it('resolves a sprintId fallback by picking the most-recent running daemon', async () => {
    await recordRun(
      makeRun({
        executionId: 'exec-old',
        sprintId: 'sprint-b',
        startedAt: '2026-04-29T00:00:00.000Z',
      })
    );
    await recordRun(
      makeRun({
        executionId: 'exec-new',
        sprintId: 'sprint-b',
        startedAt: '2026-04-29T01:00:00.000Z',
      })
    );
    const mountInk = vi.fn((executionId: string) => {
      void executionId;
      return Promise.resolve({ fallback: false });
    });
    const { sprintAttachCommand } = await import('./attach.ts');
    await captureOutput(() => sprintAttachCommand(['sprint-b'], { mountInk }));
    expect(mountInk.mock.calls[0]?.[0]).toBe('exec-new');
  });

  it('falls back to a one-line status report when Ink mount declines', async () => {
    await recordRun(
      makeRun({
        executionId: 'exec-non-tty',
        sprintId: 'sprint-y',
        logPath: '/tmp/daemon.log',
      })
    );
    const mountInk = vi.fn(() => Promise.resolve({ fallback: true }));
    const { sprintAttachCommand } = await import('./attach.ts');
    const output = await captureOutput(() => sprintAttachCommand(['exec-non-tty'], { mountInk }));
    expect(output).toContain('exec-non-tty');
    expect(output).toContain(`pid ${String(process.pid)}`);
    expect(output).toContain('/tmp/daemon.log');
  });
});
