/**
 * Work's interrupted rows must not fire for a sprint another live ralphctl process is running: its `running` attempt is
 * in flight there, not crashed.
 */

import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import type { LiveSprintOwner } from '@src/business/runs/find-live-sprint-owner.ts';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { SessionsProvider } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { useInterrupted, type InterruptedState } from '@src/application/ui/tui/views/home-internals/use-interrupted.ts';
import {
  absolutePath,
  makeActiveSprint,
  makeInProgressTaskWithRunningAttempt,
  makeProject,
} from '@tests/fixtures/domain.ts';

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

const task = makeInProgressTaskWithRunningAttempt();
const snapshot = {
  project: makeProject(),
  sprint: makeActiveSprint(),
  tasks: [task],
} as unknown as AppStateSnapshot;

const mount = (
  owner: LiveSprintOwner | undefined
): { readonly state: () => InterruptedState | undefined; readonly unmount: () => void } => {
  let latest: InterruptedState | undefined;
  const Probe = (): React.JSX.Element => {
    latest = useInterrupted(snapshot);
    return <Text>{latest.tasks.length}</Text>;
  };
  const deps = {
    findLiveSprintOwner: { execute: vi.fn(() => Promise.resolve(Result.ok(owner))) },
    detectInterruptedRuns: { execute: () => Promise.resolve(Result.ok([])) },
    dismissInterruptedRuns: { execute: () => Promise.resolve(Result.ok(undefined)) },
    gitRunner: { run: () => Promise.reject(new Error('no git in this test')) },
    storage: { dataRoot: absolutePath('/nonexistent-data-root') },
  } as unknown as AppDeps;
  const r = render(
    <DepsProvider value={deps}>
      <SessionsProvider value={createSessionManager()}>
        <Probe />
      </SessionsProvider>
    </DepsProvider>
  );
  return { state: () => latest, unmount: r.unmount };
};

describe('useInterrupted — cross-process ownership', () => {
  it('flags the running attempt once no other live process owns the sprint', async () => {
    const { state, unmount } = mount(undefined);
    await tick();
    expect(state()?.tasks.map((t) => t.taskId)).toEqual([task.id]);
    expect(state()?.ownedElsewhere).toBe(false);
    unmount();
  });

  it('flags nothing while another live ralphctl process works the sprint', async () => {
    const { state, unmount } = mount({ pid: 4321, via: 'run-record' });
    await tick();
    expect(state()?.tasks).toEqual([]);
    expect(state()?.ids.size).toBe(0);
    expect(state()?.ownedElsewhere).toBe(true);
    unmount();
  });
});
