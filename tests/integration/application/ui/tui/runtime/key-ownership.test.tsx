/**
 * One owner per keystroke — behavioural fences for the claimed-keys registry.
 *
 *   - project-detail's `S` (detect skills) must not also fire the global sprint picker;
 *   - a view's `d` (delete) must not also dismiss the StatusBanner;
 *   - the cancel-scope overlay's `1` / `2` are the overlay's alone;
 *   - `y` (copy task) is Execute-local.
 *
 * The global handler is mounted exactly like `App`'s Layout does (`useGlobalKeys` behind the
 * prompt gate) next to the view under test.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text, useInput } from 'ink';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { ProjectDetailView } from '@src/application/ui/tui/views/project-detail-view.tsx';
import { SprintsView } from '@src/application/ui/tui/views/sprints-view.tsx';
import { CancelScopeOverlay } from '@src/application/ui/tui/components/cancel-scope-overlay.tsx';
import { ClaimedKeysProvider, useClaimedKeys } from '@src/application/ui/tui/runtime/claimed-keys-context.tsx';
import { useGlobalKeys } from '@src/application/ui/tui/runtime/use-global-keys.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { makeDraftSprint, makeProject, makeRepository } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { DOWN, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

import type * as LauncherModule from '@src/application/ui/shared/launcher.ts';
import type * as StateSnapshotModule from '@src/application/ui/shared/state-snapshot.ts';

const launchFlow = vi.fn();
vi.mock('@src/application/ui/shared/launcher.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof LauncherModule>()),
  launchFlow: (...args: unknown[]): unknown => launchFlow(...args),
}));
vi.mock('@src/application/ui/shared/state-snapshot.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof StateSnapshotModule>()),
  loadAppStateSnapshot: async (): Promise<unknown> => ({}),
}));

/** Mounts the production global handler behind the same prompt gate `App`'s Layout uses. */
const GlobalKeys = (): null => {
  const ui = useUiState();
  useGlobalKeys({ disabled: ui.promptActive });
  return null;
};

beforeEach(() => {
  launchFlow.mockReset();
  launchFlow.mockResolvedValue({ ok: false, reason: 'test stub' });
});

describe('key ownership', () => {
  it('project-detail `S` fires detect-skills and does not open the sprint picker', async () => {
    const project = makeProject({ repositories: [makeRepository()] });
    const deps = {
      projectRepo: { findById: async () => Result.ok(project), save: async () => Result.ok(undefined) },
    } as unknown as AppDeps;
    const { result, routeIds } = renderView(
      <>
        <GlobalKeys />
        <ProjectDetailView />
      </>,
      { deps, initial: { id: 'project-detail', props: { projectId: project.id } } }
    );
    await waitForViewReady(result);
    result.stdin.write(DOWN); // onto the repository row
    await tick();
    result.stdin.write('S');
    await tick(60);

    expect(launchFlow).toHaveBeenCalledTimes(1);
    expect(launchFlow.mock.calls[0]?.[1]).toBe('detect-skills');
    expect(routeIds()).not.toContain('pick-sprint');
    result.unmount();
  });

  it('project-detail no longer binds `r` to Sprints navigation', async () => {
    const project = makeProject({ repositories: [makeRepository()] });
    const deps = {
      projectRepo: { findById: async () => Result.ok(project), save: async () => Result.ok(undefined) },
    } as unknown as AppDeps;
    const { result, routeIds } = renderView(<ProjectDetailView />, {
      deps,
      initial: { id: 'project-detail', props: { projectId: project.id } },
    });
    await waitForViewReady(result);
    result.stdin.write('r');
    await tick();
    expect(routeIds()).not.toContain('sprints');
    result.unmount();
  });

  it('Sprints `d` opens the delete confirm and leaves a visible StatusBanner alone', async () => {
    const sprint = makeDraftSprint({ name: 'Doomed Sprint' });
    const bus = createInMemoryEventBus();
    const deps = {
      sprintRepo: { list: async () => Result.ok([sprint]), findById: async () => Result.ok(sprint) },
      taskRepo: { findBySprintId: async () => Result.ok([]) },
      projectRepo: {},
      sprintExecutionRepo: {},
      settingsRepo: {},
      eventBus: bus,
      logger: noopLogger,
    } as unknown as AppDeps;
    const { result } = renderView(<SprintsView />, { deps, initial: { id: 'sprints' } });
    await waitForViewReady(result, (f) => f.includes('Doomed Sprint'));
    bus.publish({
      type: 'banner-show',
      id: 'rate-limit',
      tier: 'warn',
      message: 'Rate limited by provider',
      at: IsoTimestamp.now(),
    });
    await waitForViewReady(result, (f) => f.includes('Rate limited by provider'));

    result.stdin.write('d');
    await tick(60);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Remove sprint "Doomed Sprint"?');
    expect(frame).toContain('Rate limited by provider');
    result.unmount();
  });

  it('with the cancel-scope overlay open, `1` is claimed and handled only by the overlay', async () => {
    const onCancelAttempt = vi.fn();
    let ambient = 0;
    const Ambient = (): React.JSX.Element => {
      const { isClaimed } = useClaimedKeys();
      // What an ambient digit handler (section jumps) does: ask before acting.
      useInput((input) => {
        if (input === '1' && !isClaimed(input)) ambient += 1;
      });
      return <Text>ambient</Text>;
    };
    const r = render(
      <ClaimedKeysProvider>
        <Ambient />
        <CancelScopeOverlay
          attemptElapsedMs={1000}
          remainingTaskCount={2}
          onCancelAttempt={onCancelAttempt}
          onCancelFlow={vi.fn()}
          onDismiss={vi.fn()}
        />
      </ClaimedKeysProvider>
    );
    await tick();
    r.stdin.write('1');
    await tick();
    expect(onCancelAttempt).toHaveBeenCalledTimes(1);
    expect(ambient).toBe(0);
    r.unmount();
  });

  it('releases the claim when the overlay unmounts', async () => {
    let claimedNow: boolean | undefined;
    const Probe = (): React.JSX.Element => {
      const { isClaimed } = useClaimedKeys();
      useInput(() => {
        claimedNow = isClaimed('1');
      });
      return <Text>probe</Text>;
    };
    const Tree = ({ open }: { open: boolean }): React.JSX.Element => (
      <ClaimedKeysProvider>
        <Probe />
        {open && (
          <CancelScopeOverlay
            attemptElapsedMs={undefined}
            remainingTaskCount={1}
            onCancelAttempt={vi.fn()}
            onCancelFlow={vi.fn()}
            onDismiss={vi.fn()}
          />
        )}
      </ClaimedKeysProvider>
    );
    const r = render(<Tree open />);
    await tick();
    r.rerender(<Tree open={false} />);
    await tick();
    r.stdin.write('x');
    await tick();
    expect(claimedNow).toBe(false);
    r.unmount();
  });
});
