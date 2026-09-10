/**
 * Pure-function cover for `focus-list.ts`'s jump-to-blocked helpers: `clampFocusIndex` (the
 * override-index clamp `useFocusModel` uses once a `B` jump engages) and `nextBlockedIndex` (the
 * wrapping search the `B` chord itself calls). Both are plain functions with no React / Ink
 * involved, so this is a straight unit test — no rendering harness needed.
 */

import { describe, expect, it } from 'vitest';
import {
  clampFocusIndex,
  nextBlockedIndex,
  type FocusItem,
} from '@src/application/ui/tui/views/sprint-detail-internals/focus-list.ts';
import type { Task } from '@src/domain/entity/task.ts';

const taskItem = (status: Task['status'], name: string): FocusItem => ({
  kind: 'task',
  task: { id: name, status, name } as unknown as Task,
});

const ticketItem = (id: string): FocusItem => ({
  kind: 'ticket',
  ticket: { id, title: id } as never,
});

describe('clampFocusIndex', () => {
  it('clamps above the top of the list to the last index', () => {
    expect(clampFocusIndex(5, 3)).toBe(2);
  });

  it('clamps below zero to zero', () => {
    expect(clampFocusIndex(-4, 3)).toBe(0);
  });

  it('passes an in-range index through unchanged', () => {
    expect(clampFocusIndex(1, 3)).toBe(1);
  });

  it('returns 0 for an empty list regardless of input', () => {
    expect(clampFocusIndex(5, 0)).toBe(0);
    expect(clampFocusIndex(-5, 0)).toBe(0);
  });
});

describe('nextBlockedIndex', () => {
  it('finds the next blocked task after the cursor, skipping tickets and non-blocked tasks', () => {
    const list = [
      ticketItem('t1'),
      taskItem('todo', 'a'),
      taskItem('blocked', 'b'),
      taskItem('done', 'c'),
      taskItem('blocked', 'd'),
    ];
    expect(nextBlockedIndex(list, 0)).toBe(2);
    // From on top of the first blocked entry, the NEXT press must move past it, not stay put.
    expect(nextBlockedIndex(list, 2)).toBe(4);
  });

  it('wraps from the end of the list back to an earlier blocked task', () => {
    const list = [taskItem('blocked', 'a'), taskItem('todo', 'b'), taskItem('done', 'c')];
    expect(nextBlockedIndex(list, 2)).toBe(0);
  });

  it('lands back on itself when it is the sole blocked task, instead of returning undefined', () => {
    const list = [taskItem('todo', 'a'), taskItem('blocked', 'b'), taskItem('done', 'c')];
    expect(nextBlockedIndex(list, 1)).toBe(1);
  });

  it('returns undefined when nothing in the list is blocked', () => {
    const list = [taskItem('todo', 'a'), taskItem('done', 'b'), ticketItem('t1')];
    expect(nextBlockedIndex(list, 0)).toBeUndefined();
  });

  it('returns undefined for an empty list', () => {
    expect(nextBlockedIndex([], 0)).toBeUndefined();
  });
});
