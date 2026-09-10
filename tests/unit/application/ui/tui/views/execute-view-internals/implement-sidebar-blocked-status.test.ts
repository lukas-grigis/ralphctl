/**
 * The sidebar task-nav minimap's status maps must treat `blocked` exactly like the main-area
 * card's `STATUS_PRESENTATION` — error-level color, distinct glyph — so a stuck task reads the
 * same way on both surfaces at once.
 */

import { describe, expect, it } from 'vitest';
import {
  TASK_STATUS_COLOR,
  TASK_STATUS_GLYPH,
} from '@src/application/ui/tui/views/execute-view-internals/implement-sidebar.tsx';
import { STATUS_PRESENTATION } from '@src/application/ui/tui/components/tasks-panel-internals/task-card-parts.tsx';
import { inkColors } from '@src/application/ui/tui/theme/tokens.ts';

describe('implement-sidebar task-nav status maps — blocked', () => {
  it('colors a blocked row error-level, never the muted grey of skipped/pending', () => {
    expect(TASK_STATUS_COLOR.blocked).toBe(inkColors.error);
    expect(TASK_STATUS_COLOR.blocked).not.toBe(TASK_STATUS_COLOR.skipped);
    expect(TASK_STATUS_COLOR.blocked).not.toBe(TASK_STATUS_COLOR.pending);
  });

  it('gives blocked a glyph distinct from every other status in the minimap', () => {
    const others = [
      TASK_STATUS_GLYPH.pending,
      TASK_STATUS_GLYPH.running,
      TASK_STATUS_GLYPH.completed,
      TASK_STATUS_GLYPH.failed,
      TASK_STATUS_GLYPH.aborted,
      TASK_STATUS_GLYPH.skipped,
    ];
    expect(others).not.toContain(TASK_STATUS_GLYPH.blocked);
  });

  it('agrees with the main-area card presentation for blocked', () => {
    expect(TASK_STATUS_COLOR.blocked).toBe(STATUS_PRESENTATION.blocked.color);
    expect(TASK_STATUS_GLYPH.blocked).toBe(STATUS_PRESENTATION.blocked.glyph);
  });
});
