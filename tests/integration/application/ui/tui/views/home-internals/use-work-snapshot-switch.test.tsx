/** After a sprint switch, Work must not present the sprint it just left while the new one loads. */

import React from 'react';
import { Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { useWorkSnapshot } from '@src/application/ui/tui/views/home-internals/use-work-state.ts';
import { createCapturingBus } from '@tests/fixtures/capturing-event-bus.ts';
import { makeDraftSprint, makeProject } from '@tests/fixtures/domain.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

const loads = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@src/application/ui/shared/state-snapshot.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAppStateSnapshot: loads.fn,
}));

describe('useWorkSnapshot across a sprint switch', () => {
  it('reports no snapshot (not the old sprint) until the new sprint loads', async () => {
    const project = makeProject();
    const sprintA = { ...makeDraftSprint({ name: 'sprint-a' }) };
    const sprintB = {
      ...makeDraftSprint({ name: 'sprint-b' }),
      id: `${sprintA.id.slice(0, -1)}f` as typeof sprintA.id,
    };
    const snapshotFor = (sprint: typeof sprintA): AppStateSnapshot =>
      ({ project, sprint, tasks: [], recentSprints: [] }) as unknown as AppStateSnapshot;
    let resolveB: (s: AppStateSnapshot) => void = () => undefined;
    loads.fn.mockImplementation(async (_deps: unknown, sel: { sprintId?: string }) =>
      sel.sprintId === sprintB.id
        ? new Promise<AppStateSnapshot>((resolve) => {
            resolveB = resolve;
          })
        : snapshotFor(sprintA)
    );

    const seen: Array<string | undefined> = [];
    let select: ReturnType<typeof useSelection> | undefined;
    const Probe = (): React.JSX.Element => {
      select = useSelection();
      const { snapshot } = useWorkSnapshot();
      seen.push(snapshot?.sprint?.name);
      return <Text>{snapshot?.sprint?.name ?? 'none'}</Text>;
    };
    const { result } = renderView(<Probe />, {
      deps: { eventBus: createCapturingBus().bus } as unknown as AppDeps,
      initial: { id: 'home' },
      selection: { projectId: project.id, sprintId: sprintA.id },
    });
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('sprint-a'));

    const switchedAt = seen.length;
    select?.setSprint(sprintB.id, 'sprint-b', 'draft');
    await waitForPredicate(() => loads.fn.mock.calls.some(([, sel]) => sel.sprintId === sprintB.id));
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('none'));
    expect(seen.slice(switchedAt)).not.toContain('sprint-a');

    resolveB(snapshotFor(sprintB));
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('sprint-b'));
  });
});
