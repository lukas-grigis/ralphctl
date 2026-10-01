/** Header + scrollable body for prompt messages. */

import React, { useState } from 'react';
import { Box, Text, useInput, type Key } from 'ink';
import { inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';

/** Smallest body window worth showing, however short the terminal. */
const MIN_BODY_ROWS = 5;
/**
 * Rows the surrounding chrome consumes besides the header and the body itself: view header + key hints (~6), body
 * border (2), scroll hint + margins (3).
 */
const DEFAULT_RESERVED_ROWS = 15;
/** Columns lost to prompt indent + body border + body padding. */
const HORIZONTAL_CHROME = 8;

/** Hard-wrap one line to `width`, continuing wrapped rows at the line's own indent. */
const wrapLine = (line: string, width: number): readonly string[] => {
  if (width < 20 || line.length <= width) return [line];
  const indent = /^\s*/.exec(line)?.[0] ?? '';
  const pad = indent.length < width / 2 ? indent : '';
  const out: string[] = [];
  let rest = line;
  let first = true;
  while (rest.length > width) {
    const room = first ? width : width - pad.length;
    let cut = rest.lastIndexOf(' ', room);
    if (cut <= (first ? indent.length : 0)) cut = room;
    out.push(first ? rest.slice(0, cut) : `${pad}${rest.slice(0, cut)}`);
    rest = rest.slice(cut).trimStart();
    first = false;
  }
  out.push(first ? rest : `${pad}${rest}`);
  return out;
};

/**
 * Resolve the scroll-offset delta for a keypress, or `undefined` for a key this component doesn't handle.
 */
const resolveScrollDelta = (input: string, key: Key, ownsArrows: boolean, page: number): number | undefined => {
  const half = Math.max(1, Math.floor(page / 2));
  if (ownsArrows && key.upArrow) return -1;
  if (ownsArrows && key.downArrow) return 1;
  if (key.pageUp || (key.ctrl && input === 'b')) return -page;
  if (key.pageDown || (key.ctrl && input === 'f')) return page;
  if (key.ctrl && input === 'u') return -half;
  if (key.ctrl && input === 'd') return half;
  return undefined;
};

const splitHeaderBody = (msg: string): { readonly header: string; readonly body: readonly string[] } => {
  const sep = msg.indexOf('\n\n');
  if (sep === -1) return { header: msg, body: [] };
  return { header: msg.slice(0, sep), body: msg.slice(sep + 2).split('\n') };
};

export interface ScrollableMessageProps {
  readonly message: string;
  /**
   * When `false`, the body skips ↑/↓ handling so the host (e.g. a select prompt whose option cursor uses arrows)
   * keeps sole ownership of arrow keys.
   */
  readonly ownsArrows?: boolean;
  /**
   * Extra rows the host renders below the message (option list, legend, …), on top of the default chrome allowance.
   */
  readonly reservedRows?: number;
}

export const ScrollableMessage = ({
  message,
  ownsArrows = true,
  reservedRows = 0,
}: ScrollableMessageProps): React.JSX.Element => {
  const { columns, rows } = useTerminalSize();
  const width = columns - HORIZONTAL_CHROME;
  const { header, body: rawBody } = splitHeaderBody(message);
  const body = rawBody.flatMap((l) => wrapLine(l, width));
  const headerRows = header.split('\n').reduce((n, l) => n + wrapLine(l, width - 2).length, 0);
  const windowRows = Math.max(MIN_BODY_ROWS, rows - DEFAULT_RESERVED_ROWS - reservedRows - headerRows);
  const [offset, setOffset] = useState(0);
  const maxOffset = Math.max(0, body.length - windowRows);
  const clamp = (n: number): number => Math.max(0, Math.min(n, maxOffset));
  // A grown terminal shrinks maxOffset; derive the effective offset so a stale one never shows a short tail.
  const effOffset = Math.min(offset, maxOffset);
  const overflows = body.length > windowRows;

  useInput((input, key) => {
    if (!overflows) return;
    const delta = resolveScrollDelta(input, key, ownsArrows, windowRows);
    if (delta !== undefined) setOffset((o) => clamp(Math.min(o, maxOffset) + delta));
  });

  const visible = body.slice(effOffset, effOffset + windowRows);
  const lastVisible = Math.min(effOffset + windowRows, body.length);
  const scrollHint = ownsArrows ? '↑/↓ scroll · PgUp/PgDn page' : 'PgUp/PgDn page · Ctrl+u/d half-page';

  return (
    <>
      <Text color={inkColors.primary} bold>
        {header}
      </Text>
      {body.length > 0 && (
        <Box flexDirection="column" marginTop={spacing.section}>
          <Box flexDirection="column" borderStyle="single" borderColor={inkColors.rule} paddingX={spacing.cardPadX}>
            {visible.map((line, i) => (
              <Text key={`body-${String(effOffset + i)}`}>{line.length === 0 ? ' ' : line}</Text>
            ))}
          </Box>
          {overflows && (
            <Text color={inkColors.highlight} bold>
              lines {String(effOffset + 1)}–{String(lastVisible)} of {String(body.length)} · {scrollHint}
            </Text>
          )}
        </Box>
      )}
    </>
  );
};
