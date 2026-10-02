/** Work's "interrupted … ago" chip keeps counting while nothing runs (the agenda memo must not freeze `now`). */

import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { SessionsProvider } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { useWorkAgenda } from '@src/application/ui/tui/views/home-internals/use-work-state.ts';
import { makeActiveSprint, makeInProgressTaskWithRunningAttempt, makeProject } from '@tests/fixtures/domain.ts';

const task = makeInProgressTaskWithRunningAttempt();
const snapshot = {
  project: makeProject(),
  sprint: makeActiveSprint(),
  tasks: [task],
  projectCount: 1,
  sprintCount: 1,
  recentSprints: [],
  triggerInputs: {
    hasProject: true,
    currentSprintStatus: 'active',
    pendingTicketCount: 0,
    approvedTicketCount: 0,
    resumableTaskCount: 1,
  },
} as unknown as AppStateSnapshot;
const launchability = (): { readonly ok: true } => ({ ok: true });

const settle = (): Promise<void> => new Promise((r) => setImmediate(r));

afterEach(() => vi.useRealTimers());

describe('useWorkAgenda clock', () => {
  it('advances the interrupted-ago chip as time passes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const facts = new Map([[task.id, { since: Date.now() }]]);
    let chip = 'none';
    const Probe = (): React.JSX.Element => {
      const { agenda } = useWorkAgenda(snapshot, launchability, facts);
      chip = agenda.find((r) => r.id.startsWith('interrupted:'))?.fact ?? 'none';
      return <Text>{chip}</Text>;
    };
    const { unmount } = render(
      <SessionsProvider value={createSessionManager()}>
        <Probe />
      </SessionsProvider>
    );
    await settle();
    const first = chip;
    expect(first).toContain('ago');
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await settle();
    const later = chip;
    expect(later).not.toBe(first);
    expect(later).toContain('10m');
    unmount();
  });
});
