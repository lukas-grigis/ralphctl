/**
 * Header + scrollable body for prompt messages. When a prompt is asked to display a long body
 * (e.g. the refine flow's approval prompt shows the full refined-requirements markdown), the
 * single-`<Text>` rendering used to overflow the terminal with no way to scroll. This component
 * splits the message at the first blank line — everything before is the bold header, everything
 * after becomes a fixed-height windowed viewport.
 *
 * Default scroll bindings (used by hosts whose own option nav doesn't take ↑/↓ — e.g. the
 * yes/no `ConfirmPrompt`, which navigates with ←/→):
 *
 *   ↑ / ↓             → one row
 *   PgUp / PgDn       → full page (fn+↑/↓ on Mac laptops)
 *   Ctrl+u / Ctrl+d   → half page
 *   Ctrl+b / Ctrl+f   → full page (vim alias)
 *
 * Hosts that already own ↑/↓ for option navigation (e.g. `SelectPrompt`) pass `ownsArrows={false}`
 * so the body yields arrows back to them. The body still scrolls via PgUp/PgDn, Ctrl+u/d, and
 * Ctrl+b/f — keys that don't conflict with the host. The hint row reflects the active scheme so
 * the user doesn't have to guess.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';

const VISIBLE_BODY_ROWS = 12;
const HALF_PAGE = Math.max(1, Math.floor(VISIBLE_BODY_ROWS / 2));

const splitHeaderBody = (msg: string): { readonly header: string; readonly body: readonly string[] } => {
  const sep = msg.indexOf('\n\n');
  if (sep === -1) return { header: msg, body: [] };
  return { header: msg.slice(0, sep), body: msg.slice(sep + 2).split('\n') };
};

export interface ScrollableMessageProps {
  readonly message: string;
  /**
   * When `false`, the body skips ↑/↓ handling so the host (e.g. a select prompt whose option
   * cursor uses arrows) keeps sole ownership of arrow keys. The body still scrolls via
   * PgUp/PgDn, Ctrl+u/d, and Ctrl+b/f. Defaults to `true` for hosts whose option nav uses ←/→
   * or no arrows at all.
   */
  readonly ownsArrows?: boolean;
}

export const ScrollableMessage = ({ message, ownsArrows = true }: ScrollableMessageProps): React.JSX.Element => {
  const { header, body } = splitHeaderBody(message);
  const [offset, setOffset] = useState(0);
  const maxOffset = Math.max(0, body.length - VISIBLE_BODY_ROWS);
  const clamp = (n: number): number => Math.max(0, Math.min(n, maxOffset));
  const overflows = body.length > VISIBLE_BODY_ROWS;

  useInput((input, key) => {
    if (!overflows) return;
    if (ownsArrows && key.upArrow) setOffset((o) => clamp(o - 1));
    else if (ownsArrows && key.downArrow) setOffset((o) => clamp(o + 1));
    else if (key.pageUp || (key.ctrl && input === 'b')) setOffset((o) => clamp(o - VISIBLE_BODY_ROWS));
    else if (key.pageDown || (key.ctrl && input === 'f')) setOffset((o) => clamp(o + VISIBLE_BODY_ROWS));
    else if (key.ctrl && input === 'u') setOffset((o) => clamp(o - HALF_PAGE));
    else if (key.ctrl && input === 'd') setOffset((o) => clamp(o + HALF_PAGE));
  });

  const visible = body.slice(offset, offset + VISIBLE_BODY_ROWS);
  const lastVisible = Math.min(offset + VISIBLE_BODY_ROWS, body.length);
  const scrollHint = ownsArrows ? '↑/↓ scroll · PgUp/PgDn page' : 'PgUp/PgDn page · Ctrl+u/d half-page';

  return (
    <>
      <Text color={inkColors.primary} bold>
        {glyphs.actionCursor} {header}
      </Text>
      {body.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="column" borderStyle="single" borderColor={inkColors.rule} paddingX={spacing.cardPadX}>
            {visible.map((line, i) => (
              <Text key={`body-${String(offset + i)}`}>{line.length === 0 ? ' ' : line}</Text>
            ))}
          </Box>
          {overflows && (
            <Text dimColor>
              lines {String(offset + 1)}–{String(lastVisible)} of {String(body.length)} · {scrollHint}
            </Text>
          )}
        </Box>
      )}
    </>
  );
};
