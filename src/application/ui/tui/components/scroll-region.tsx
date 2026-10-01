/** Vertical scroll viewport — the middle slot of {@link ViewShell}. */

import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { glyphs, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { Box, Text, type DOMElement, type Key, measureElement, useInput, useStdin, useStdout } from 'ink';

export interface ScrollRegionProps {
  readonly children: React.ReactNode;
  /** When true (prompt active, overlay open, etc.), swallow no keys and no mouse events. */
  readonly disabled?: boolean;
  /**
   * When true, the keyboard scroll handler ignores the arrow / paging / vim keys (↑ ↓ PageUp PageDown Ctrl+b/f/u/d g
   * G k j) so they fall through to a view that owns its own list cursor.
   */
  readonly suppressArrows?: boolean;
}

/**
 * Registry the {@link ScrollRegion} exposes to its subtree so a view that owns its own list cursor can say "this card
 * is the focused one" and have the page scroll follow it.
 */
interface ScrollAnchorRegistry {
  readonly register: (node: DOMElement | null) => void;
}

const ScrollAnchorContext = createContext<ScrollAnchorRegistry | undefined>(undefined);

/**
 * Mark a card as the scroll anchor while `active` is true and hand back the ref to spread onto its outer `<Box>`.
 * @public
 */
export const useScrollAnchor = (active: boolean): React.RefObject<DOMElement | null> => {
  const ref = useRef<DOMElement | null>(null);
  const registry = useContext(ScrollAnchorContext);
  const register = registry?.register;
  useLayoutEffect(() => {
    if (!active || register === undefined) return undefined;
    register(ref.current);
    return () => {
      register(null);
    };
  }, [active, register]);
  return ref;
};

/** Row offset of `node` inside `container`, by summing each yoga box's computed top on the way up. */
const offsetWithin = (node: DOMElement, container: DOMElement): number | undefined => {
  let top = 0;
  let current: DOMElement | undefined = node;
  while (current !== undefined && current !== container) {
    if (current.yogaNode === undefined) return undefined;
    top += current.yogaNode.getComputedTop();
    current = current.parentNode;
  }
  return current === container ? top : undefined;
};

/**
 * Smallest offset change that brings `[top, top + height)` fully inside the viewport — scroll up when the anchor sits
 * above the fold, down when it sits below.
 */
const revealOffset = (args: {
  readonly top: number;
  readonly height: number;
  readonly offset: number;
  readonly viewport: number;
}): number => {
  const { top, height, offset, viewport } = args;
  if (top < offset) return top;
  const bottom = top + height;
  if (bottom > offset + viewport) return Math.min(top, bottom - viewport);
  return offset;
};

/** Where the anchor sits inside the scrolled content — the inputs a reveal decision depends on. */
interface AnchorPlacement {
  readonly node: DOMElement;
  readonly top: number;
  readonly height: number;
}

/**
 * The registered anchor's placement, or `undefined` when there is none to act on — no anchor, or no laid-out position
 * yet.
 */
const placementOf = (anchor: DOMElement | null, content: DOMElement | null): AnchorPlacement | undefined => {
  if (anchor === null || content === null) return undefined;
  const top = offsetWithin(anchor, content);
  if (top === undefined) return undefined;
  return { node: anchor, top, height: measureElement(anchor).height };
};

const samePlacement = (a: AnchorPlacement | undefined, b: AnchorPlacement | undefined): boolean =>
  a !== undefined && b !== undefined && a.node === b.node && a.top === b.top && a.height === b.height;

/** Three terminal rows per wheel notch — feels right for most trackpads / mice. */
const WHEEL_STEP = 3;

/** Layout figures the keyboard/mouse handlers need, computed once per event from the refs. */
interface ScrollLayout {
  readonly offset: number;
  readonly max: number;
  readonly page: number;
  readonly half: number;
}

/** Largest scroll offset. */
const maxOffsetFor = (viewport: number, content: number): number => (content > viewport ? content - viewport + 1 : 0);

const computeLayout = (offset: number, viewport: number, content: number): ScrollLayout => {
  const max = maxOffsetFor(viewport, content);
  return { offset, max, page: Math.max(4, viewport - 2), half: Math.max(2, Math.floor(viewport / 2)) };
};

/** Rows a cue-bearing viewport is guaranteed to show whichever cues are active. */
const CUE_SAFE_ROWS = 2;

/** Dim `▴ N more` / `▾ N more` row marking clipped content at one edge of the viewport. */
const ScrollCue = ({
  direction,
  count,
}: {
  readonly direction: 'above' | 'below';
  readonly count: number;
}): React.JSX.Element => (
  <Box flexShrink={0} paddingX={spacing.indent}>
    <Text dimColor>
      {direction === 'above' ? glyphs.moreAbove : glyphs.moreBelow} {count} more
    </Text>
  </Box>
);

/**
 * One row per recognised scroll key: `matches` tests the raw `useInput` payload, `nextOffset` derives the target
 * offset from the current layout.
 */
const SCROLL_KEY_ACTIONS: ReadonlyArray<{
  readonly matches: (input: string, key: Key) => boolean;
  readonly nextOffset: (layout: ScrollLayout) => number;
}> = [
  { matches: (_input, key) => key.downArrow, nextOffset: (l) => l.offset + 1 },
  { matches: (_input, key) => key.upArrow, nextOffset: (l) => l.offset - 1 },
  { matches: (input, key) => key.pageDown || (key.ctrl && input === 'f'), nextOffset: (l) => l.offset + l.page },
  { matches: (input, key) => key.pageUp || (key.ctrl && input === 'b'), nextOffset: (l) => l.offset - l.page },
  { matches: (input, key) => key.ctrl && input === 'd', nextOffset: (l) => l.offset + l.half },
  { matches: (input, key) => key.ctrl && input === 'u', nextOffset: (l) => l.offset - l.half },
  { matches: (_input, key) => key.home, nextOffset: () => 0 },
  { matches: (_input, key) => key.end, nextOffset: (l) => l.max },
];

/** Mouse-wheel scrolling over xterm SGR mouse-tracking (`?1000h` + `?1006h`). */
const useWheelScroll = (args: {
  readonly disabled: boolean;
  readonly setOffset: React.Dispatch<React.SetStateAction<number>>;
  readonly maxOffset: () => number;
}): void => {
  const { disabled, setOffset, maxOffset } = args;
  const { stdin, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  useEffect(() => {
    if (!isRawModeSupported || !stdin || !stdout || !stdout.isTTY) return undefined;
    if (disabled) return undefined;
    const enable = '\x1b[?1000h\x1b[?1006h';
    const disableSeq = '\x1b[?1006l\x1b[?1000l';
    stdout.write(enable);
    const onData = (chunk: Buffer): void => {
      // Belt-and-suspenders: a wheel chunk can still arrive after `disabled` flipped on but
      // before the OS has stopped delivering bytes from the previous enable sequence.
      if (disabled) return;
      const str = chunk.toString('utf8');
      // xterm SGR mouse sequences start with ESC[< — `\x1b` is the literal escape byte the
      // terminal emits, not a stylistic choice, so the no-control-regex lint disable stays.
      // eslint-disable-next-line no-control-regex
      const re = /\x1b\[<(\d+);\d+;\d+([Mm])/g;
      let match;
      while ((match = re.exec(str)) !== null) {
        if (match[2] !== 'M') continue;
        const button = Number(match[1]);
        if (button === 64) {
          setOffset((o) => Math.max(0, o - WHEEL_STEP));
        } else if (button === 65) {
          setOffset((o) => Math.min(maxOffset(), o + WHEEL_STEP));
        }
      }
    };
    stdin.on('data', onData);
    return (): void => {
      stdin.off('data', onData);
      stdout.write(disableSeq);
    };
  }, [stdin, stdout, isRawModeSupported, disabled, setOffset, maxOffset]);
};

export const ScrollRegion = ({
  children,
  disabled = false,
  suppressArrows = false,
}: ScrollRegionProps): React.JSX.Element => {
  const [offset, setOffset] = useState(0);
  const sizeRef = useRef<{ viewport: number; content: number }>({ viewport: 0, content: 0 });
  // Mirror of `sizeRef` as state: the overflow cues are painted from it, and a ref write alone
  // would not re-render them into view.
  const [size, setSize] = useState<{ viewport: number; content: number }>({ viewport: 0, content: 0 });
  const viewportRef = useRef<DOMElement | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  // The element the viewport should keep visible, published by `useScrollAnchor` from whichever card currently holds
  // the view's list cursor.
  const anchorRef = useRef<DOMElement | null>(null);
  // A new anchor must re-run the measure-and-reveal pass below even when the cursor lives in a descendant
  // (ActionMenu) whose state change never re-renders this region.
  const [, setAnchorTick] = useState(0);
  const register = useCallback((node: DOMElement | null) => {
    const changed = node !== null && node !== anchorRef.current;
    anchorRef.current = node;
    if (changed) setAnchorTick((t) => t + 1);
  }, []);
  const anchorRegistry = React.useMemo<ScrollAnchorRegistry>(() => ({ register }), [register]);
  // The anchor placement the last reveal pass looked at.
  const revealedRef = useRef<AnchorPlacement | undefined>(undefined);

  // Memoised because `useWheelScroll` lists it as a dependency: `maxOffset` only reads a ref, so it has no inputs of
  // its own.
  const maxOffset = useCallback((): number => maxOffsetFor(sizeRef.current.viewport, sizeRef.current.content), []);
  const clamp = (next: number): number => Math.max(0, Math.min(next, maxOffset()));

  // No dep array: runs after every render so sizeRef stays current as content grows or
  // shrinks (e.g. live trace entries arriving during an Implement run). The concern about
  // "every render → setOffset → render" looping does NOT apply here: setOffset fires only to
  // clamp down (offset > max; once clamped, offset ≤ max on the next render) or to reveal a
  // changed anchor placement (recorded before the scroll, so the render it causes sees the same
  // placement and does nothing). Measurement reads Yoga computed heights which change only
  // when layout changes; reading them is side-effect-free and cheap.
  //
  // Hidden-subtree guard: a document overlay (progress `g` / evaluation `v`) hides the active
  // view with `display: "none"` while keeping it MOUNTED, and a hidden subtree measures 0 rows.
  // Adopting that measurement would make `max` 0 and clamp the offset to the top, so closing the
  // overlay silently scrolled the page back to row 0 — the very state App.tsx's Layout comment
  // promises is preserved. The viewport is `flexGrow={1}`, so a visible region always measures
  // ≥ 1 row: a 0 reading means "not laid out", never "genuinely empty". Skip the whole update in
  // that case and keep the last real measurement. A genuine viewport shrink (terminal resize,
  // banner appearing) still measures > 0 and still clamps.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const viewport = viewportRef.current ? measureElement(viewportRef.current).height : 0;
    if (viewport === 0) return;
    const content = contentRef.current ? measureElement(contentRef.current).height : 0;
    sizeRef.current = { viewport, content };
    setSize((prev) => (prev.viewport === viewport && prev.content === content ? prev : { viewport, content }));
    const max = maxOffset();
    if (offset > max) {
      setOffset(max);
      return;
    }
    // Reveal-on-focus. Runs after the commit that moved the cursor, so the anchor's yoga box is laid out at its new
    // position.
    const placement = placementOf(anchorRef.current, contentRef.current);
    if (samePlacement(placement, revealedRef.current)) return;
    revealedRef.current = placement;
    if (placement === undefined) return;
    // While overflowing, reveal against the cue-safe viewport so the anchor stays visible
    // whichever cue rows end up drawn.
    const visible = sizeRef.current.content > viewport ? viewport - CUE_SAFE_ROWS : viewport;
    const next = revealOffset({ top: placement.top, height: placement.height, offset, viewport: visible });
    if (next !== offset) setOffset(Math.min(next, max));
  });

  useInput(
    (input, key) => {
      if (disabled) return;
      // The view owns its own list cursor — leave every scroll key (↑ ↓ PageUp PageDown Ctrl+b/f/u/d g G.
      if (suppressArrows) return;
      const layout = computeLayout(0, sizeRef.current.viewport, sizeRef.current.content);
      if (layout.max === 0) return;
      const action = SCROLL_KEY_ACTIONS.find((candidate) => candidate.matches(input, key));
      if (action === undefined) return;
      setOffset((o) => clamp(action.nextOffset({ ...layout, offset: o })));
    },
    { isActive: !disabled }
  );

  useWheelScroll({ disabled, setOffset, maxOffset });

  // Cue bookkeeping — derived from the last measurement, so it is one frame stale at worst.
  const max = maxOffsetFor(size.viewport, size.content);
  const showAbove = max > 0 && offset > 0;
  const showBelow = max > 0 && offset < max;
  const shownRows = size.viewport - (showAbove ? 1 : 0) - (showBelow ? 1 : 0);
  const hiddenBelow = Math.max(0, size.content - offset - shownRows);

  return (
    // Viewport: takes all remaining vertical space (flexGrow=1). The cue rows sit OUTSIDE the
    // clip box so they never cover content; the clip box takes whatever rows remain.
    <Box ref={viewportRef} flexDirection="column" flexGrow={1}>
      {showAbove && <ScrollCue direction="above" count={offset} />}
      {/* Clip: overflow=hidden so an oversized inner box can't push the status bar off-screen. */}
      <Box flexDirection="column" flexGrow={1} flexShrink={1} overflowY="hidden">
        {/* Inner: renders content at its natural height (flexShrink=0); marginTop=-offset
            shifts it up, the clip's overflow=hidden does the clipping. */}
        <Box ref={contentRef} flexDirection="column" marginTop={-offset} flexShrink={0}>
          <ScrollAnchorContext.Provider value={anchorRegistry}>{children}</ScrollAnchorContext.Provider>
        </Box>
      </Box>
      {showBelow && <ScrollCue direction="below" count={hiddenBelow} />}
    </Box>
  );
};
