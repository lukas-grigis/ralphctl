/**
 * `syncSprintStatus` — toast-free status refresh for the currently-selected sprint.
 *
 * Contract:
 *  - Updates `sprintStatus` when the given id matches the live selection (views fire this on
 *    every snapshot load, so flow-driven transitions reach the breadcrumb chip).
 *  - No-op when the id does NOT match — a snapshot loaded for sprint A must never restamp
 *    the chip after the user picked sprint B.
 *  - Never writes `lastSwitch` — refreshing a chip must not replay the "✓ now on …" toast.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text, useInput } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { SelectionProvider, useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';

const sid = (s: string): SprintId => {
  const r = SprintId.parse(s);
  if (!r.ok) throw new Error(`bad sprint id: ${r.error.message}`);
  return r.value;
};

const SPRINT_A = sid('01900000-0000-7000-8000-0000000000a1');
const SPRINT_B = sid('01900000-0000-7000-8000-0000000000b1');

/**
 * Probe drives the api through Ink input so updates flow through React's normal scheduling:
 *   a — syncSprintStatus(SPRINT_A, 'active')
 *   b — syncSprintStatus(SPRINT_B, 'done')   (a non-selected sprint)
 */
const Probe = (): React.JSX.Element => {
  const api = useSelection();
  useInput((input) => {
    if (input === 'a') api.syncSprintStatus(SPRINT_A, 'active');
    if (input === 'b') api.syncSprintStatus(SPRINT_B, 'done');
  });
  return (
    <Text>
      status={String(api.sprintStatus)} switch={String(api.lastSwitch?.sprintId)}
    </Text>
  );
};

const mount = (): ReturnType<typeof render> =>
  render(
    <SelectionProvider seed={{ sprintId: SPRINT_A, sprintLabel: 'Alpha Sprint' }} onChange={vi.fn()}>
      <Probe />
    </SelectionProvider>
  );

describe('SelectionProvider — syncSprintStatus', () => {
  it('updates sprintStatus when the id matches the selected sprint', async () => {
    const r = mount();
    await new Promise((res) => setTimeout(res, 20));

    expect(r.lastFrame()).toContain('status=undefined');
    r.stdin.write('a');
    await new Promise((res) => setTimeout(res, 20));

    expect(r.lastFrame()).toContain('status=active');
    r.unmount();
  });

  it('is a no-op when the id does not match the selected sprint', async () => {
    const r = mount();
    await new Promise((res) => setTimeout(res, 20));

    r.stdin.write('b');
    await new Promise((res) => setTimeout(res, 20));

    expect(r.lastFrame()).toContain('status=undefined');
    r.unmount();
  });

  it('never records a lastSwitch (no toast replay on chip refresh)', async () => {
    const r = mount();
    await new Promise((res) => setTimeout(res, 20));

    r.stdin.write('a');
    await new Promise((res) => setTimeout(res, 20));

    expect(r.lastFrame()).toContain('status=active');
    expect(r.lastFrame()).toContain('switch=undefined');
    r.unmount();
  });
});
