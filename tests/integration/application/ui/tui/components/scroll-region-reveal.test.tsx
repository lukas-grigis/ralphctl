/**
 * ScrollRegion reveal-on-focus.
 *
 * A view that owns its own list cursor passes `suppressArrows`, which leaves the PAGE with no
 * keyboard scroll at all. On a view tall enough to overflow (sprint detail with its banner,
 * header card, next-phase card and two list sections) that used to strand everything below the
 * fold: the cursor walked through rows nobody could see, `B next blocked` looked like a no-op,
 * and the action-result line landed off-screen.
 *
 * `useScrollAnchor` — wired once inside `ListCard`, so every card in the product participates —
 * registers the focused card with the enclosing region, which then keeps it inside the viewport.
 * These tests pin the three behaviours that matter: it scrolls DOWN to a focused row below the
 * fold, back UP to one above it, and does NOTHING while the focused row is already visible (so
 * reveal never fights a deliberate mouse-wheel scroll).
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
import { Box } from 'ink';
import { render } from 'ink-testing-library';
import { ScrollRegion } from '@src/application/ui/tui/components/scroll-region.tsx';
import { ListCard } from '@src/application/ui/tui/components/list-card.tsx';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';

const ROW_COUNT = 12;

/** Fixed-height frame so the region actually overflows — mirrors App's `height={rows}` Layout. */
const Harness = ({ focusIdx }: { readonly focusIdx: number }): React.JSX.Element => (
  <Box flexDirection="column" height={12}>
    <ScrollRegion suppressArrows>
      {Array.from({ length: ROW_COUNT }, (_, i) => (
        <ListCard key={i} focused={i === focusIdx} indexLabel={`#${String(i)}`} title={`row-${String(i)}`} />
      ))}
    </ScrollRegion>
  </Box>
);

describe('ScrollRegion — reveal on focus', () => {
  it('scrolls down to a focused card that starts below the fold', async () => {
    const { lastFrame, rerender } = render(<Harness focusIdx={0} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('row-0'), {
      label: 'the first card painted',
    });
    expect(lastFrame() ?? '').not.toContain(`row-${String(ROW_COUNT - 1)}`);

    rerender(<Harness focusIdx={ROW_COUNT - 1} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes(`row-${String(ROW_COUNT - 1)}`), {
      label: 'the last card scrolled into view',
    });
  });

  it('scrolls back up to a focused card above the fold', async () => {
    const { lastFrame, rerender } = render(<Harness focusIdx={ROW_COUNT - 1} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes(`row-${String(ROW_COUNT - 1)}`), {
      label: 'the last card revealed',
    });

    rerender(<Harness focusIdx={0} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('row-0'), {
      label: 'the first card scrolled back into view',
    });
  });

  it('leaves the offset alone while the focused card is already visible', async () => {
    const { lastFrame, rerender } = render(<Harness focusIdx={0} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('row-0'), { label: 'the first card painted' });
    const before = lastFrame() ?? '';

    // Row 1 shares the viewport with row 0, so revealing it must not move the page.
    rerender(<Harness focusIdx={1} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('row-1'), { label: 'focus moved to the second card' });
    expect(lastFrame() ?? '').toContain('row-0');
    expect((before.match(/row-/g) ?? []).length).toBe(((lastFrame() ?? '').match(/row-/g) ?? []).length);
  });
});
