/**
 * `STATUS_PRESENTATION.blocked` — a dependency-blocked task must render with the SAME
 * error-level treatment as every other status the operator needs to act on (`failed`), and must
 * be visually distinct from `skipped` / `pending`, which share the muted grey. Color-only checks
 * live here as pure object assertions (mirrors `flow-visual.test.ts`'s pattern) rather than
 * scraping ANSI codes out of a rendered frame.
 */

import { describe, expect, it } from 'vitest';
import { STATUS_PRESENTATION } from '@src/application/ui/tui/components/tasks-panel-internals/task-card-parts.tsx';
import { inkColors } from '@src/application/ui/tui/theme/tokens.ts';

describe('STATUS_PRESENTATION.blocked', () => {
  it('is error-level, matching `failed` — never the muted grey of `skipped` / `pending`', () => {
    expect(STATUS_PRESENTATION.blocked.color).toBe(inkColors.error);
    expect(STATUS_PRESENTATION.blocked.color).toBe(STATUS_PRESENTATION.failed.color);
    expect(STATUS_PRESENTATION.blocked.color).not.toBe(STATUS_PRESENTATION.skipped.color);
    expect(STATUS_PRESENTATION.blocked.color).not.toBe(STATUS_PRESENTATION.pending.color);
  });

  it('carries a glyph distinct from every other status glyph', () => {
    const others = [
      STATUS_PRESENTATION.pending.glyph,
      STATUS_PRESENTATION.running.glyph,
      STATUS_PRESENTATION.completed.glyph,
      STATUS_PRESENTATION.failed.glyph,
      STATUS_PRESENTATION.aborted.glyph,
      STATUS_PRESENTATION.skipped.glyph,
    ];
    expect(others).not.toContain(STATUS_PRESENTATION.blocked.glyph);
  });
});
