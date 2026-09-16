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
 * These tests pin the behaviours that matter: it scrolls DOWN to a focused row below the fold,
 * back UP to one above it, does NOTHING while the focused row is already visible, top-aligns a
 * card taller than the viewport (and settles there), and leaves a mouse-wheel scroll alone until
 * the focus actually moves.
 */

import React from 'react';
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Box, Text, render as inkRender } from 'ink';
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

const TALL_BODY_LINES = 15;
const SHORT_CARDS_ABOVE = 3;
const TALL_IDX = SHORT_CARDS_ABOVE;
const BODY = (i: number): string => `body-${String(i).padStart(2, '0')}`;

/**
 * Three short cards (four rows each, gutter included) above one card whose body alone is taller
 * than the 8-row viewport — the shape of an expanded task card on a short terminal. `tallFirst`
 * moves the tall card to the top of the page instead.
 */
const TallHarness = ({
  focusIdx,
  tallFirst = false,
}: {
  readonly focusIdx: number;
  readonly tallFirst?: boolean;
}): React.JSX.Element => {
  const shortCards = Array.from({ length: SHORT_CARDS_ABOVE }, (_, i) => (
    <ListCard
      key={`short-${String(i)}`}
      focused={i === focusIdx}
      indexLabel={`#${String(i)}`}
      title={`row-${String(i)}`}
    />
  ));
  const tallCard = (
    <ListCard key="tall" focused={focusIdx === TALL_IDX} indexLabel={`#${String(TALL_IDX)}`} title="tall-card">
      {Array.from({ length: TALL_BODY_LINES }, (_, i) => (
        <Text key={i}>{BODY(i)}</Text>
      ))}
    </ListCard>
  );
  return (
    <Box flexDirection="column" height={8}>
      <ScrollRegion suppressArrows>{tallFirst ? [tallCard, ...shortCards] : [...shortCards, tallCard]}</ScrollRegion>
    </Box>
  );
};

/**
 * A stdout that claims to be a TTY, so the region switches on SGR mouse tracking and the wheel
 * path is live. `debug: true` makes ink write each full frame; the latest multi-line write is the
 * current frame (the mouse-tracking toggles are single-line escape sequences).
 */
const fakeTty = (): {
  readonly stdout: NodeJS.WriteStream;
  readonly stdin: NodeJS.ReadStream;
  readonly frame: () => string;
} => {
  const writes: string[] = [];
  const stdout = Object.assign(new EventEmitter(), {
    columns: 80,
    rows: 24,
    isTTY: true,
    write: (chunk: string): boolean => {
      writes.push(chunk);
      return true;
    },
  });
  const noop = (): void => undefined;
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setEncoding: noop,
    setRawMode: noop,
    resume: noop,
    pause: noop,
    ref: noop,
    unref: noop,
    read: (): null => null,
  });
  return {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    frame: (): string => writes.findLast((w) => w.includes('\n')) ?? '',
  };
};

/** One wheel-down notch (button 65) in xterm SGR mouse encoding — scrolls three rows. */
const WHEEL_DOWN = `${String.fromCharCode(27)}[<65;10;10M`;

const renderWithWheel = (
  element: React.JSX.Element
): {
  readonly frame: () => string;
  readonly wheelDown: () => void;
  readonly rerender: (next: React.JSX.Element) => void;
  readonly unmount: () => void;
} => {
  const tty = fakeTty();
  const instance = inkRender(element, {
    stdout: tty.stdout,
    stderr: fakeTty().stdout,
    stdin: tty.stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  return {
    frame: tty.frame,
    wheelDown: (): void => {
      tty.stdin.emit('data', Buffer.from(WHEEL_DOWN));
    },
    rerender: instance.rerender,
    unmount: instance.unmount,
  };
};

/** Let any follow-up render (a reveal that would snap the page back) land before asserting. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

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

  it('top-aligns a focused card taller than the viewport and stays there', async () => {
    const { lastFrame, rerender } = render(<TallHarness focusIdx={0} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('row-0'), { label: 'the first card painted' });

    rerender(<TallHarness focusIdx={TALL_IDX} />);
    await waitForPredicate(() => (lastFrame() ?? '').includes('tall-card'), {
      label: 'the tall card scrolled into view',
    });
    await settle();
    const frame = lastFrame() ?? '';
    // Its title row and the start of its body are what the operator reads first; the tail of the
    // body is what gives way.
    expect(frame).toContain('tall-card');
    expect(frame).toContain(BODY(0));
    expect(frame).not.toContain(BODY(TALL_BODY_LINES - 1));
    expect(frame).not.toContain('row-2');
  });
});

describe('ScrollRegion — reveal vs. the mouse wheel', () => {
  it('keeps a wheel scroll that moves the focused card out of view', async () => {
    const r = renderWithWheel(<Harness focusIdx={0} />);
    await waitForPredicate(() => r.frame().includes('row-0'), { label: 'the first card painted' });

    // One notch = three rows: the focused card (border, title, border) is now above the fold.
    r.wheelDown();
    await waitForPredicate(() => !r.frame().includes('row-0'), { label: 'the wheel scrolled past row-0' });
    await settle();
    expect(r.frame()).not.toContain('row-0');
    expect(r.frame()).toContain('row-1');
    r.unmount();
  });

  it('lets the wheel scroll through the body of a focused card taller than the viewport', async () => {
    const r = renderWithWheel(<TallHarness focusIdx={TALL_IDX} tallFirst />);
    await waitForPredicate(() => r.frame().includes('tall-card'), { label: 'the tall card painted' });

    r.wheelDown();
    r.wheelDown();
    await waitForPredicate(() => !r.frame().includes('tall-card'), { label: 'the wheel scrolled into the body' });
    await settle();
    expect(r.frame()).not.toContain('tall-card');
    expect(r.frame()).toContain(BODY(6));
    r.unmount();
  });

  it('still reveals when the focus moves to another card after a wheel scroll', async () => {
    const r = renderWithWheel(<Harness focusIdx={0} />);
    await waitForPredicate(() => r.frame().includes('row-0'), { label: 'the first card painted' });

    // Six rows down: row-1's title (row 5) is above the fold too.
    r.wheelDown();
    r.wheelDown();
    await waitForPredicate(() => !r.frame().includes('row-1'), { label: 'the wheel scrolled past row-1' });

    r.rerender(<Harness focusIdx={1} />);
    await waitForPredicate(() => r.frame().includes('row-1'), { label: 'the newly focused card revealed' });
    r.unmount();
  });

  it('reveals a card again when it regains focus after the wheel moved it away', async () => {
    const r = renderWithWheel(<Harness focusIdx={0} />);
    await waitForPredicate(() => r.frame().includes('row-0'), { label: 'the first card painted' });

    r.wheelDown();
    await waitForPredicate(() => !r.frame().includes('row-0'), { label: 'the wheel scrolled past row-0' });

    // Focus leaves every card (no anchor), then comes back to the same one.
    r.rerender(<Harness focusIdx={-1} />);
    await settle();
    expect(r.frame()).not.toContain('row-0');
    r.rerender(<Harness focusIdx={0} />);
    await waitForPredicate(() => r.frame().includes('row-0'), { label: 'the refocused card revealed' });
    r.unmount();
  });
});
