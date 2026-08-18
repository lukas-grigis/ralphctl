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
 * Mouse tracking is also gated on `disabled`: while a prompt is open the SGR enable sequence
 * is withdrawn so wheel events stop emitting `\x1b[<64;…M` / `\x1b[<65;…M` bytes onto stdin,
 * which would otherwise leak through Ink's input parser into TextPrompt / TextAreaPrompt as
 * stray printable characters (`M`, `;`, digits).
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

export const ScrollRegion = ({
  children,
  disabled = false,
  suppressArrows = false,
}: ScrollRegionProps): React.JSX.Element => {
  const [offset, setOffset] = useState(0);
  const sizeRef = useRef<{ viewport: number; content: number }>({ viewport: 0, content: 0 });
  const viewportRef = useRef<DOMElement | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  const { stdin, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();

  const maxOffset = (): number => Math.max(0, sizeRef.current.content - sizeRef.current.viewport);
  const clamp = (next: number): number => Math.max(0, Math.min(next, maxOffset()));

  // No dep array: runs after every render so sizeRef stays current as content grows or
  // shrinks (e.g. live trace entries arriving during an Implement run). The concern about
  // "every render → setOffset → render" looping does NOT apply here: setOffset only fires
  // when offset > max, i.e. when we need to clamp down. Once clamped, offset ≤ max on the
  // next render so setOffset is not called again. Measurement reads Yoga computed heights
  // which change only when layout changes; reading them is side-effect-free and cheap.
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
    if (offset > max) setOffset(max);
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
  }, [stdin, stdout, isRawModeSupported, disabled]);

  return (
    // Viewport: takes all remaining vertical space (flexGrow=1) AND clips overflow so an
    // oversized inner box can't push the status bar off-screen.
    <Box ref={viewportRef} flexDirection="column" flexGrow={1} overflowY="hidden">
      {/* Inner: renders content at its natural height (flexShrink=0); marginTop=-offset
          shifts it up, the viewport's overflow=hidden does the clipping. */}
      <Box ref={contentRef} flexDirection="column" marginTop={-offset} flexShrink={0}>
        {children}
      </Box>
    </Box>
  );
};
