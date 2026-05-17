/**
 * Vertical scroll viewport — the middle slot of {@link ViewShell}. Tall views (long settings
 * pages, projects with ten repos) clip inside this region so the banner and the status bar
 * stay pinned at top and bottom.
 *
 * Measures the viewport and the inner content via `measureElement` so the offset always clamps
 * against `contentHeight - viewportHeight` — keyboard or mouse-wheel scroll never lets the
 * user fall off the end of the content into blank space. Mouse wheel is wired through xterm
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
 * Arrow keys are dual-purpose: list views (ListView, CardList) also use them to move the row
 * cursor. The early return on `max === 0` (content fits the viewport) keeps the dominant case
 * — a list shorter than the screen — conflict-free; only when the page itself overflows do
 * both handlers fire on the same key, which is the intended UX (cursor moves AND page scrolls).
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Box, measureElement, useInput, useStdin, useStdout, type DOMElement } from 'ink';

export interface ScrollRegionProps {
  readonly children: React.ReactNode;
  /** When true (prompt active, overlay open, etc.), swallow no keys and no mouse events. */
  readonly disabled?: boolean;
}

/** Three terminal rows per wheel notch — feels right for most trackpads / mice. */
const WHEEL_STEP = 3;

export const ScrollRegion = ({ children, disabled = false }: ScrollRegionProps): React.JSX.Element => {
  const [offset, setOffset] = useState(0);
  const sizeRef = useRef<{ viewport: number; content: number }>({ viewport: 0, content: 0 });
  const viewportRef = useRef<DOMElement | null>(null);
  const contentRef = useRef<DOMElement | null>(null);
  const { stdin, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();

  const maxOffset = (): number => Math.max(0, sizeRef.current.content - sizeRef.current.viewport);
  const clamp = (next: number): number => Math.max(0, Math.min(next, maxOffset()));

  useLayoutEffect(() => {
    if (viewportRef.current) {
      sizeRef.current.viewport = measureElement(viewportRef.current).height;
    }
    if (contentRef.current) {
      sizeRef.current.content = measureElement(contentRef.current).height;
    }
    const max = maxOffset();
    if (offset > max) setOffset(max);
  });

  useInput(
    (input, key) => {
      if (disabled) return;
      const max = maxOffset();
      if (max === 0) return;
      const viewportH = sizeRef.current.viewport;
      const page = Math.max(4, viewportH - 2);
      const half = Math.max(2, Math.floor(viewportH / 2));
      if (key.downArrow) {
        setOffset((o) => clamp(o + 1));
        return;
      }
      if (key.upArrow) {
        setOffset((o) => clamp(o - 1));
        return;
      }
      if (key.pageDown || (key.ctrl && input === 'f')) {
        setOffset((o) => clamp(o + page));
        return;
      }
      if (key.pageUp || (key.ctrl && input === 'b')) {
        setOffset((o) => clamp(o - page));
        return;
      }
      if (key.ctrl && input === 'd') {
        setOffset((o) => clamp(o + half));
        return;
      }
      if (key.ctrl && input === 'u') {
        setOffset((o) => clamp(o - half));
        return;
      }
      if (input === 'g') {
        setOffset(0);
        return;
      }
      if (input === 'G') {
        setOffset(max);
      }
    },
    { isActive: !disabled }
  );

  useEffect(() => {
    if (!isRawModeSupported || !stdin || !stdout || !stdout.isTTY) return undefined;
    const enable = '\x1b[?1000h\x1b[?1006h';
    const disableSeq = '\x1b[?1006l\x1b[?1000l';
    stdout.write(enable);
    const onData = (chunk: Buffer): void => {
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
  }, [stdin, stdout, isRawModeSupported]);

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
