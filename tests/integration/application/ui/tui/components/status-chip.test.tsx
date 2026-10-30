/**
 * StatusChip — bracketed, uppercased lifecycle tag. The chip normalises underscores to spaces
 * so the only multi-word status (`in_progress`) reads `[IN PROGRESS]` instead of `[IN_PROGRESS]`
 * — correct-by-construction for every caller (DESIGN-SYSTEM §8.3 status-word spelling).
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { StatusChip, taskStatusKind } from '@src/application/ui/tui/components/status-chip.tsx';

describe('StatusChip', () => {
  it('renders `[IN PROGRESS]` for the in_progress status (underscore normalised to space)', () => {
    const { lastFrame } = render(<StatusChip label="in_progress" kind={taskStatusKind('in_progress')} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[IN PROGRESS]');
    expect(frame).not.toContain('IN_PROGRESS');
  });

  it('uppercases a single-word status without altering it', () => {
    const { lastFrame } = render(<StatusChip label="done" />);
    expect(lastFrame() ?? '').toContain('[DONE]');
  });
});
