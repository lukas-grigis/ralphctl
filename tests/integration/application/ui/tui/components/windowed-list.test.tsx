/**
 * Windowed-list primitive — pure `computeListWindow` math plus the id-cursor `useListWindow` hook.
 *
 * The pure cases assert the window slice / overflow flags / clamp behaviour for a flat list. The
 * hook cases mount a tiny harness component (ink-testing-library) and drive keystrokes to verify:
 *   - the focused row stays inside the window as the cursor crosses the bottom edge (window shifts);
 *   - Home/End jump to first / last;
 *   - the id-cursor survives a reorder (focus stays on the same item id, not the same index);
 *   - eviction of the focused item snaps to a nearby survivor.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Box, Text } from 'ink';
import { describe, expect, it } from 'vitest';
import {
  computeListWindow,
  useListWindow,
  type UseListWindowResult,
} from '@src/application/ui/tui/components/windowed-list.tsx';
import { DOWN, END, HOME, tick } from '@tests/integration/application/ui/tui/_keys.ts';

describe('computeListWindow', () => {
  it('returns the full list with no overflow when everything fits', () => {
    expect(computeListWindow(3, 0, 5)).toEqual({ start: 0, end: 3, hasAbove: false, hasBelow: false });
  });

  it('returns the full list when visibleRows equals total', () => {
    expect(computeListWindow(5, 4, 5)).toEqual({ start: 0, end: 5, hasAbove: false, hasBelow: false });
  });

  it('centres the focused index with one half-window of context on either side', () => {
    // 20 items, window of 5, focus at 10 → half = 2 → start 8, end 13.
    expect(computeListWindow(20, 10, 5)).toEqual({ start: 8, end: 13, hasAbove: true, hasBelow: true });
  });

  it('clamps at the top — focus 0 pins the window to the start, no overflow above', () => {
    const w = computeListWindow(20, 0, 5);
    expect(w).toEqual({ start: 0, end: 5, hasAbove: false, hasBelow: true });
  });

  it('clamps at the bottom — focus last pins the window to the end, no overflow below', () => {
    const w = computeListWindow(20, 19, 5);
    expect(w).toEqual({ start: 15, end: 20, hasAbove: true, hasBelow: false });
  });

  it('keeps the focused index inside [start, end) at every position', () => {
    for (let focus = 0; focus < 20; focus++) {
      const w = computeListWindow(20, focus, 5);
      expect(focus).toBeGreaterThanOrEqual(w.start);
      expect(focus).toBeLessThan(w.end);
    }
  });

  it('clamps an out-of-range focus into the list before windowing', () => {
    expect(computeListWindow(10, 999, 4)).toEqual({ start: 6, end: 10, hasAbove: true, hasBelow: false });
    expect(computeListWindow(10, -5, 4)).toEqual({ start: 0, end: 4, hasAbove: false, hasBelow: true });
  });

  it('handles an empty list', () => {
    expect(computeListWindow(0, 0, 5)).toEqual({ start: 0, end: 0, hasAbove: false, hasBelow: false });
  });

  it('handles a non-positive visibleRows defensively', () => {
    expect(computeListWindow(10, 3, 0)).toEqual({ start: 0, end: 0, hasAbove: false, hasBelow: false });
    expect(computeListWindow(10, 3, -2)).toEqual({ start: 0, end: 0, hasAbove: false, hasBelow: false });
  });
});

interface Row {
  readonly id: string;
}

const makeRows = (n: number): Row[] => Array.from({ length: n }, (_unused, i) => ({ id: `r${String(i)}` }));

const Harness = ({
  items,
  visibleRows,
  capture,
  onSubmit,
  initialCursorId,
}: {
  readonly items: readonly Row[];
  readonly visibleRows: number;
  readonly capture: (api: UseListWindowResult<Row>) => void;
  readonly onSubmit?: (item: Row) => void;
  readonly initialCursorId?: string;
}): React.JSX.Element => {
  const api = useListWindow<Row>({
    items,
    getId: (item) => item.id,
    visibleRows,
    active: true,
    onSubmit,
    initialCursorId,
  });
  capture(api);
  return (
    <Box flexDirection="column">
      {api.visibleItems.map((item) => (
        <Text key={item.id}>{item.id}</Text>
      ))}
    </Box>
  );
};

describe('useListWindow', () => {
  it('keeps the focused row inside the window when the cursor crosses the bottom edge', async () => {
    const items = makeRows(20);
    let latest: UseListWindowResult<Row> | undefined;
    const r = render(<Harness items={items} visibleRows={5} capture={(api) => (latest = api)} initialCursorId="r0" />);
    await tick(20);

    // Drive the cursor down past the bottom of the initial window (rows 0..4).
    for (let i = 0; i < 7; i++) {
      r.stdin.write(DOWN);
      await tick(15);
    }

    // Focus should now be on r7, and the window must still contain it.
    expect(latest?.cursorId).toBe('r7');
    expect(latest?.focusedIndex).toBe(7);
    expect(latest?.focusedIndex).toBeGreaterThanOrEqual(latest?.window.start ?? -1);
    expect(latest?.focusedIndex).toBeLessThan(latest?.window.end ?? -1);
    expect(latest?.window.hasAbove).toBe(true);
    r.unmount();
  });

  it('Home jumps to the first item and End to the last', async () => {
    const items = makeRows(20);
    let latest: UseListWindowResult<Row> | undefined;
    const r = render(<Harness items={items} visibleRows={5} capture={(api) => (latest = api)} initialCursorId="r10" />);
    await tick(20);

    r.stdin.write(END);
    await tick(20);
    expect(latest?.cursorId).toBe('r19');
    expect(latest?.focusedIndex).toBe(19);

    r.stdin.write(HOME);
    await tick(20);
    expect(latest?.cursorId).toBe('r0');
    expect(latest?.focusedIndex).toBe(0);
    r.unmount();
  });

  it('keeps focus on the same item id after the items reorder', async () => {
    const items = makeRows(6);
    let latest: UseListWindowResult<Row> | undefined;
    const r = render(<Harness items={items} visibleRows={4} capture={(api) => (latest = api)} initialCursorId="r0" />);
    await tick(20);

    // Move focus onto r3.
    r.stdin.write(DOWN);
    await tick(15);
    r.stdin.write(DOWN);
    await tick(15);
    r.stdin.write(DOWN);
    await tick(15);
    expect(latest?.cursorId).toBe('r3');
    const indexBefore = latest?.focusedIndex;
    expect(indexBefore).toBe(3);

    // Reorder: move r3 to the front. Its index changes but the id is still present.
    const reordered = [items[3] as Row, ...items.filter((_unused, i) => i !== 3)];
    r.rerender(<Harness items={reordered} visibleRows={4} capture={(api) => (latest = api)} initialCursorId="r0" />);
    await tick(20);

    // Focus must follow the id, not the old index.
    expect(latest?.cursorId).toBe('r3');
    expect(latest?.focusedIndex).toBe(0);
    expect(latest?.focusedItem?.id).toBe('r3');
    r.unmount();
  });

  it('snaps to a nearby survivor when the focused item is evicted', async () => {
    const items = makeRows(6);
    let latest: UseListWindowResult<Row> | undefined;
    const r = render(<Harness items={items} visibleRows={4} capture={(api) => (latest = api)} initialCursorId="r0" />);
    await tick(20);

    // Focus r3 (index 3).
    r.stdin.write(DOWN);
    await tick(15);
    r.stdin.write(DOWN);
    await tick(15);
    r.stdin.write(DOWN);
    await tick(15);
    expect(latest?.cursorId).toBe('r3');

    // Evict r3 — list becomes r0,r1,r2,r4,r5. The prior index (3) clamps onto the survivor now
    // sitting at index 3 → r4.
    const evicted = items.filter((item) => item.id !== 'r3');
    r.rerender(<Harness items={evicted} visibleRows={4} capture={(api) => (latest = api)} initialCursorId="r0" />);
    await tick(20);

    expect(latest?.focusedItem).toBeDefined();
    expect(latest?.cursorId).toBe('r4');
    expect(latest?.focusedIndex).toBe(3);
    r.unmount();
  });

  it('Enter submits the focused item', async () => {
    const items = makeRows(5);
    const submitted: Row[] = [];
    const r = render(
      <Harness
        items={items}
        visibleRows={5}
        capture={() => {
          /* no-op */
        }}
        onSubmit={(item) => submitted.push(item)}
        initialCursorId="r2"
      />
    );
    await tick(20);
    r.stdin.write('\r');
    await tick(20);
    expect(submitted.map((s) => s.id)).toEqual(['r2']);
    r.unmount();
  });
});
