/**
 * Vertical scroll viewport — the middle slot of {@link ViewShell}. Tall views (long settings
 * pages, projects with ten repos) clip inside this region so the banner and the status bar
 * stay pinned at top and bottom.
 *
 * Measures the viewport and the inner content via `measureElement` so the offset always clamps
 * against `contentHeight - viewportHeight` — keyboard or mouse-wheel scroll never lets the
 * user fall off the end of the content into blank space. A zero-height viewport measurement is
 * ignored rather than clamped against: that only happens while the whole view sits inside a
 * `display: "none"` box (a document overlay is open), and treating it as real would reset the
 * offset to the top behind the overlay. Mouse wheel is wired through xterm
 * SGR mouse-tracking (`?1000h` + `?1006h`) and only enabled when stdout is a real TTY, so the
 * test harness (a piped stream) never sees the enable sequence.
 *
 * Keyboard model (only when not disabled — prompts / wizards mute the region):
 *   ↑ / ↓                     → scroll one row (primary on laptops without a PgUp/PgDn key)
 *   PageUp / PageDown / Ctrl+b / Ctrl+f → scroll a full page
 *   Ctrl+u / Ctrl+d           → half-page jumps
 *   g                         → top
 *   G                         → bottom (the clamped max)
 *
 * Arrow keys are dual-purpose: windowed-list views that own their own cursor via `useListWindow`
 * also handle arrow keys for row navigation. The early return on `max === 0` (content fits the
 * viewport) keeps the dominant case — a list shorter than the screen — conflict-free; only when
 * the page itself overflows do both handlers fire on the same key. Pass `suppressArrows` (via
 * `ViewShell suppressScrollArrows`) to prevent that double-act: the scroll region yields all
 * arrow / paging keys so only the view's own cursor handler fires.
 *
 * Reveal-on-focus is the other half of that bargain. Yielding the arrows leaves the PAGE with no
 * keyboard scroll, so a view whose chrome already fills the viewport used to strand everything
 * below the fold. Cards published through {@link useScrollAnchor} are kept inside the viewport
 * automatically, so the cursor can never walk off-screen — see that hook for the mechanics.
 *
 * Mouse tracking is also gated on `disabled`: while a prompt is open the SGR enable sequence
 * is withdrawn so wheel events stop emitting `\x1b[<64;…M` / `\x1b[<65;…M` bytes onto stdin,
 * which would otherwise leak through Ink's input parser into TextPrompt / TextAreaPrompt as
 * stray printable characters (`M`, `;`, digits).
 */

import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, type DOMElement, type Key, measureElement, useInput, useStdin, useStdout } from 'ink';

export interface ScrollRegionProps {
  readonly children: React.ReactNode;
  /** When true (prompt active, overlay open, etc.), swallow no keys and no mouse events. */
  readonly disabled?: boolean;
  /**
   * When true, the keyboard scroll handler ignores the arrow / paging / vim keys (↑ ↓ PageUp
   * PageDown Ctrl+b/f/u/d g G k j) so they fall through to a view that owns its own list cursor
   * — preventing a single keypress from both moving the cursor AND page-scrolling. Mouse-wheel
   * scroll is UNAFFECTED: the wheel still drives the viewport regardless of this flag. The
   * `disabled` gate still mutes everything (keys and wheel) when set.
   */
  readonly suppressArrows?: boolean;
}

/**
 * Registry the {@link ScrollRegion} exposes to its subtree so a view that owns its own list
 * cursor can say "this card is the focused one" and have the page scroll follow it.
 *
 * Why this exists: `suppressArrows` hands ↑/↓ to the view's cursor, which means the PAGE has no
 * keyboard scroll left. On a view whose chrome (banner + header cards) already fills the
 * viewport, everything below the fold — further list sections, the action-result line — was
 * then unreachable, and the cursor moved invisibly through rows nobody could see. Reveal-on-
 * focus closes that: the region keeps the registered element inside the viewport, so moving the
 * cursor (or jumping to it, e.g. sprint-detail's `B`) scrolls the page exactly as much as it
 * takes and no more.
 *
 * Deliberately a registry of ONE: a viewport can only follow a single anchor, and every consumer
 * registers on focus / deregisters on blur, so the last focused element wins.
 */
interface ScrollAnchorRegistry {
  readonly register: (node: DOMElement | null) => void;
}

const ScrollAnchorContext = createContext<ScrollAnchorRegistry | undefined>(undefined);

/**
 * Mark a card as the scroll anchor while `active` is true and hand back the ref to spread onto
 * its outer `<Box>`. Registering the card's OWN box (rather than rendering a marker element)
 * keeps the layout byte-identical — nothing is added to the tree, so a view that adopts this
 * cannot shift by a row.
 *
 * Inert outside a {@link ScrollRegion} (the context is absent in component-level tests), and
 * inert while `active` is false, so a list can call it unconditionally for every row.
 *
 * A LAYOUT effect, not a plain one, and that is load-bearing: React flushes child layout effects
 * before the parent's, so registering here lands before the region's measure-and-reveal pass in
 * the SAME commit as the cursor move. Registering in a plain `useEffect` runs after that pass,
 * which left the region revealing the previous anchor — one keypress behind, forever.
 *
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

/**
 * Row offset of `node` inside `container`, by summing each yoga box's computed top on the way
 * up. Ink exposes `yogaNode` / `parentNode` on its `DOMElement`, and yoga's computed top is
 * relative to the parent box — so the walk is the only way to turn a child ref into a position
 * (`measureElement` reports size, never position).
 *
 * `undefined` when the walk cannot complete: either node has no laid-out yoga box yet (first
 * paint), or `node` is not a descendant of `container` (a stale ref from a card that has since
 * unmounted). Both mean "don't scroll", never "scroll to zero".
 */
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
 * Smallest offset change that brings `[top, top + height)` fully inside the viewport — scroll up
 * when the anchor sits above the fold, down when it sits below, and leave the offset alone when
 * it is already visible.
 *
 * An anchor TALLER than the viewport (an expanded card on a short terminal) can't fit; aligning
 * its top is the useful answer there — the operator reads a card from the top down. Below the
 * fold that is `Math.min`: a short anchor's bottom-aligned offset (`bottom - viewport`) never
 * exceeds its top, a tall one's always does. Picking the larger one instead bottom-aligned a tall
 * anchor, which put its top above the fold and sent the next pass back up — forever.
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
 * The registered anchor's placement, or `undefined` when there is none to act on — no anchor, or
 * no laid-out position yet. `top` is measured against the content box, whose own `marginTop` is
 * the scroll offset, so a scroll alone never changes a placement.
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

const computeLayout = (offset: number, viewport: number, content: number): ScrollLayout => {
  const max = Math.max(0, content - viewport);
  return { offset, max, page: Math.max(4, viewport - 2), half: Math.max(2, Math.floor(viewport / 2)) };
};

/**
 * One row per recognised scroll key: `matches` tests the raw `useInput` payload, `nextOffset`
 * derives the target offset from the current layout. Replaces the if/else cascade that used to
 * live directly in the `useInput` callback.
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
  { matches: (input) => input === 'g', nextOffset: () => 0 },
  { matches: (input) => input === 'G', nextOffset: (l) => l.max },
];

/**
 * Mouse-wheel scrolling over xterm SGR mouse-tracking (`?1000h` + `?1006h`).
 *
 * Extracted from the component body so {@link ScrollRegion} itself reads as measure → keys →
 * render. Behaviour is unchanged: enabled only on a real TTY (the test harness's piped stream
 * never sees the enable sequence) and withdrawn whenever `disabled` is set, so wheel bytes stop
 * reaching ink's input parser while a prompt owns the keyboard.
 */
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
  const viewportRef = useRef<DOMElement | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  // The element the viewport should keep visible, published by `useScrollAnchor` from whichever
  // card currently holds the view's list cursor. A ref (not state) so registering does not
  // re-render the whole subtree on every cursor move — the layout effect below reads it after
  // the commit that moved the focus, which is exactly when the new position is measurable.
  const anchorRef = useRef<DOMElement | null>(null);
  const register = useCallback((node: DOMElement | null) => {
    anchorRef.current = node;
  }, []);
  const anchorRegistry = React.useMemo<ScrollAnchorRegistry>(() => ({ register }), [register]);
  // The anchor placement the last reveal pass looked at. Reveal only runs when the placement
  // differs — a different card, or the same card moved or resized — so a render caused purely by
  // an offset change (a mouse-wheel scroll, or reveal's own scroll) leaves the offset alone.
  const revealedRef = useRef<AnchorPlacement | undefined>(undefined);

  // Memoised because `useWheelScroll` lists it as a dependency: `maxOffset` only reads a ref, so
  // it has no inputs of its own, and a fresh identity each render would re-arm the mouse-tracking
  // effect (rewriting the SGR enable sequence) on every paint.
  const maxOffset = useCallback((): number => Math.max(0, sizeRef.current.content - sizeRef.current.viewport), []);
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
    sizeRef.current = {
      viewport,
      content: contentRef.current ? measureElement(contentRef.current).height : 0,
    };
    const max = maxOffset();
    if (offset > max) {
      setOffset(max);
      return;
    }
    // Reveal-on-focus. Runs after the commit that moved the cursor, so the anchor's yoga box is
    // laid out at its new position. An unchanged placement means nothing about the focus moved,
    // so whatever brought the offset here — typically the wheel — wins. Losing the anchor clears
    // the record, so a card that regains focus is revealed again even though it never moved.
    const placement = placementOf(anchorRef.current, contentRef.current);
    if (samePlacement(placement, revealedRef.current)) return;
    revealedRef.current = placement;
    if (placement === undefined) return;
    const next = revealOffset({ top: placement.top, height: placement.height, offset, viewport });
    if (next !== offset) setOffset(Math.min(next, max));
  });

  useInput(
    (input, key) => {
      if (disabled) return;
      // The view owns its own list cursor — leave every scroll key (↑ ↓ PageUp PageDown
      // Ctrl+b/f/u/d g G, plus k/j if the view binds them) for its handler so a single press
      // doesn't double-act (cursor move AND page scroll). Mouse-wheel scroll below is untouched.
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

  return (
    // Viewport: takes all remaining vertical space (flexGrow=1) AND clips overflow so an
    // oversized inner box can't push the status bar off-screen.
    <Box ref={viewportRef} flexDirection="column" flexGrow={1} overflowY="hidden">
      {/* Inner: renders content at its natural height (flexShrink=0); marginTop=-offset
          shifts it up, the viewport's overflow=hidden does the clipping. */}
      <Box ref={contentRef} flexDirection="column" marginTop={-offset} flexShrink={0}>
        <ScrollAnchorContext.Provider value={anchorRegistry}>{children}</ScrollAnchorContext.Provider>
      </Box>
    </Box>
  );
};
