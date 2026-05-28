/**
 * SelectionProvider unit tests. The `setProjectAndSprint` atomic setter MUST fire `onChange`
 * exactly once per call and surface both ids together — chaining `setProject` then `setSprint`
 * would fire it twice and briefly nullify `sprintId` in between (setProject clears the sprint
 * cursor as a side effect). The cross-project sprint picker depends on the atomic setter to
 * avoid a flicker + double persistence write.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import {
  SelectionProvider,
  useSelection,
  type SelectionSeed,
} from '@src/application/ui/tui/runtime/selection-context.tsx';
import { projectId } from '@tests/fixtures/domain.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';

const sprintId = (s: string): SprintId => {
  const r = SprintId.parse(s);
  if (!r.ok) throw new Error(`bad sprint id fixture: ${r.error.message}`);
  return r.value;
};

const PID_A = projectId('01900000-0000-7000-8000-0000000000a1');
const PID_B = projectId('01900000-0000-7000-8000-0000000000a2');
const SID_X = sprintId('01900000-0000-7000-8000-0000000000b1');
const SID_Y = sprintId('01900000-0000-7000-8000-0000000000b2');

/**
 * Mounts inside the provider and fires the atomic setter once after a microtask. The action
 * is deferred via setTimeout so the provider's initial-mount onChange completes (and is
 * captured by the `onMounted` baseline hook) before the setter fires — child useEffect runs
 * before parent useEffect, so calling the setter inside useEffect would otherwise race with
 * the provider's persistence effect.
 */
const makeTrigger = (
  triggered: { current: boolean },
  onMounted: () => void,
  action: (api: ReturnType<typeof useSelection>) => void
): (() => React.JSX.Element) => {
  return function Trigger(): React.JSX.Element {
    const api = useSelection();
    const apiRef = React.useRef(api);
    apiRef.current = api;
    React.useEffect(() => {
      if (triggered.current) return;
      triggered.current = true;
      // Defer one microtask so the provider's mount effect (which fires onChange once) has
      // run before we sample the baseline.
      setTimeout(() => {
        onMounted();
        action(apiRef.current);
      }, 0);
    }, []);
    return (
      <Text>
        p={String(api.projectId)} s={String(api.sprintId)}
      </Text>
    );
  };
};

describe('SelectionProvider first-run persistence guard', () => {
  it('does NOT persist the seeded selection on mount, but DOES persist a post-mount change', async () => {
    // The launch router may seed an auto-default project/sprint (first project + most-recent
    // sprint) when nothing was persisted. Persisting that on mount would freeze the auto-default
    // as if the user had chosen it. The first-run guard suppresses the initial write; only a
    // post-mount selection change reaches the store.
    const onChange = vi.fn<(s: SelectionSeed) => void>();
    const triggered = { current: false };
    let mountCalls = -1;
    const Trigger = makeTrigger(
      triggered,
      () => {
        // Sampled one microtask after mount — the suppressed initial write means zero calls.
        mountCalls = onChange.mock.calls.length;
      },
      (api) => api.setSprint(SID_Y, 'Sprint Y')
    );

    const r = render(
      <SelectionProvider seed={{ projectId: PID_A, projectLabel: 'Project A', sprintId: SID_X }} onChange={onChange}>
        <Trigger />
      </SelectionProvider>
    );

    await vi.waitFor(
      () => {
        // Mount must not have persisted the auto-default seed.
        expect(mountCalls).toBe(0);
        // The post-mount setSprint is the only write, and it carries the new selection.
        expect(onChange.mock.calls.length).toBe(1);
        expect(onChange.mock.calls[0]?.[0]).toEqual({
          projectId: PID_A,
          projectLabel: 'Project A',
          sprintId: SID_Y,
          sprintLabel: 'Sprint Y',
        });
      },
      { timeout: 500, interval: 5 }
    );
    r.unmount();
  });
});

describe('SelectionProvider.setProject', () => {
  it('keeps the sprint cursor when called with the same project id', async () => {
    // Regression: project-detail-view calls setProject on mount to stamp the display name.
    // If the user picked sprint X under project A, then navigates Home → Projects → opens A
    // to look at it, the sprint pick must survive. Clearing only matters when actually
    // switching projects (sprint ids are scoped to a project).
    //
    // Re-selecting the SAME project is a genuine no-op (no state change, no persistence write),
    // so we assert on the rendered selection state — the sprint cursor must still be SID_X —
    // rather than on `onChange`, which the first-run guard plus the no-op bail-out won't fire.
    const onChange = vi.fn<(s: SelectionSeed) => void>();
    const triggered = { current: false };
    const Trigger = makeTrigger(
      triggered,
      () => {
        /* no baseline needed — assertion reads the rendered frame */
      },
      (api) => api.setProject(PID_A, 'Project A')
    );

    const r = render(
      <SelectionProvider
        seed={{ projectId: PID_A, projectLabel: 'Project A', sprintId: SID_X, sprintLabel: 'Sprint X' }}
        onChange={onChange}
      >
        <Trigger />
      </SelectionProvider>
    );

    await vi.waitFor(
      () => {
        // The rendered frame reflects the live selection state: project A + sprint X survive.
        expect(r.lastFrame()).toContain(`p=${String(PID_A)} s=${String(SID_X)}`);
      },
      { timeout: 500, interval: 5 }
    );
    r.unmount();
  });

  it('clears the sprint cursor when called with a different project id', async () => {
    const seeds: SelectionSeed[] = [];
    const onChange = vi.fn<(s: SelectionSeed) => void>((s) => {
      seeds.push(s);
    });
    const triggered = { current: false };
    const Trigger = makeTrigger(
      triggered,
      () => {
        /* baseline */
      },
      (api) => api.setProject(PID_B, 'Project B')
    );

    const r = render(
      <SelectionProvider
        seed={{ projectId: PID_A, projectLabel: 'Project A', sprintId: SID_X, sprintLabel: 'Sprint X' }}
        onChange={onChange}
      >
        <Trigger />
      </SelectionProvider>
    );

    await vi.waitFor(
      () => {
        expect(seeds[seeds.length - 1]).toEqual({
          projectId: PID_B,
          projectLabel: 'Project B',
        });
      },
      { timeout: 500, interval: 5 }
    );
    r.unmount();
  });
});

describe('SelectionProvider.setProjectAndSprint', () => {
  it('fires onChange exactly once for the atomic write and sets both ids in one shot', async () => {
    const onChange = vi.fn<(s: SelectionSeed) => void>();
    const triggered = { current: false };
    let baselineCalls = -1;
    const Trigger = makeTrigger(
      triggered,
      () => {
        baselineCalls = onChange.mock.calls.length;
      },
      (api) => api.setProjectAndSprint(PID_B, 'Project B', SID_Y, 'Sprint Y')
    );

    const r = render(
      <SelectionProvider onChange={onChange}>
        <Trigger />
      </SelectionProvider>
    );

    await vi.waitFor(
      () => {
        expect(baselineCalls).toBeGreaterThanOrEqual(0);
        // Exactly one additional onChange after baseline — the four state setters batched into one
        // commit, one effect run, one persistence write.
        expect(onChange.mock.calls.length - baselineCalls).toBe(1);
        const lastSeed = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
        expect(lastSeed).toEqual({
          projectId: PID_B,
          projectLabel: 'Project B',
          sprintId: SID_Y,
          sprintLabel: 'Sprint Y',
        });
      },
      { timeout: 500, interval: 5 }
    );
    r.unmount();
  });

  it('still fires onChange exactly once when atomically switching from a populated seed', async () => {
    // Populated seed exercises the populated→populated transition: setProject's side effect
    // (clear sprintId/sprintLabel when project changes) WOULD fire if the implementation
    // regressed to chaining setProject() + setSprint(). The empty-seed variant above can't catch
    // that case because there's no prior sprint to clear. A chained regression here would
    // produce two onChange calls (one per setter) instead of the one expected from atomic
    // batching — the call-count assertion catches it without walking seeds for intermediate
    // states.
    const onChange = vi.fn<(s: SelectionSeed) => void>();
    const triggered = { current: false };
    let baselineCalls = -1;
    const Trigger = makeTrigger(
      triggered,
      () => {
        baselineCalls = onChange.mock.calls.length;
      },
      (api) => api.setProjectAndSprint(PID_B, 'Project B', SID_Y, 'Sprint Y')
    );

    const r = render(
      <SelectionProvider
        seed={{ projectId: PID_A, projectLabel: 'Project A', sprintId: SID_X, sprintLabel: 'Sprint X' }}
        onChange={onChange}
      >
        <Trigger />
      </SelectionProvider>
    );

    await vi.waitFor(
      () => {
        expect(baselineCalls).toBeGreaterThanOrEqual(0);
        expect(onChange.mock.calls.length - baselineCalls).toBe(1);
        const lastSeed = onChange.mock.calls[onChange.mock.calls.length - 1]?.[0];
        expect(lastSeed).toEqual({
          projectId: PID_B,
          projectLabel: 'Project B',
          sprintId: SID_Y,
          sprintLabel: 'Sprint Y',
        });
      },
      { timeout: 500, interval: 5 }
    );
    r.unmount();
  });
});
