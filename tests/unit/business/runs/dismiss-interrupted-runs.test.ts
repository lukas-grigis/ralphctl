import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { DetectInterruptedRuns, InterruptedRun } from '@src/business/runs/detect-interrupted-runs.ts';
import { createDismissInterruptedRuns } from '@src/business/runs/dismiss-interrupted-runs.ts';
import type { LiveRunRecord } from '@src/business/runs/live-run.ts';

const interrupted = (runId: string): InterruptedRun => ({
  record: {
    version: 1,
    runId,
    flowId: 'implement',
    owner: { pid: 1, host: 'h', startedAt: 'x' },
    startedAt: 'x',
    updatedAt: 'x',
    spawns: [],
  } satisfies LiveRunRecord,
  liveSpawns: [],
});

const setup = (detected: readonly string[]) => {
  const removed: string[] = [];
  const detect: DetectInterruptedRuns = {
    execute: () =>
      Promise.resolve(Result.ok(detected.map(interrupted)) as Result<readonly InterruptedRun[], StorageError>),
  };
  const dismiss = createDismissInterruptedRuns({
    detect,
    store: {
      remove: (id) => {
        removed.push(id);
        return Promise.resolve(Result.ok(undefined) as Result<void, StorageError>);
      },
    },
  });
  return { dismiss, removed };
};

describe('dismissInterruptedRuns', () => {
  it('removes the named records that are still interrupted', async () => {
    const { dismiss, removed } = setup(['a', 'b']);
    const result = await dismiss.execute(['a']);
    expect(result.ok && result.value).toBe(1);
    expect(removed).toEqual(['a']);
  });

  it('never touches a record that is not interrupted (its run may be live)', async () => {
    const { dismiss, removed } = setup(['a']);
    const result = await dismiss.execute(['live-run']);
    expect(result.ok && result.value).toBe(0);
    expect(removed).toEqual([]);
  });
});
