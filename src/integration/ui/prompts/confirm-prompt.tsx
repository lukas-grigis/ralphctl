import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import { ConfirmInput } from '@inkjs/ui';
import type { ConfirmOptions } from '@src/business/ports/prompt.ts';
import { emoji, glyphs, inkColors, spacing } from '@src/integration/ui/theme/tokens.ts';

interface ConfirmPromptProps {
  options: ConfirmOptions;
  onSubmit: (value: boolean) => void;
  onCancel: () => void;
}

// Rows reserved for the rest of the prompt (confirm line, hints, breadcrumb,
// borders). Viewport = terminalRows - RESERVED_ROWS, clamped to a sane range.
const RESERVED_ROWS = 10;
const MIN_VIEWPORT = 6;
const MAX_VIEWPORT = 40;

function useTerminalRows(): number {
  const { stdout } = useStdout();
  const [rows, setRows] = useState(stdout.rows);
  useEffect(() => {
    const onResize = (): void => {
      setRows(stdout.rows);
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);
  return rows;
}

export function ConfirmPrompt({ options, onSubmit }: ConfirmPromptProps): React.JSX.Element {
  const hint = options.default === false ? '(y/N)' : '(Y/n)';
  const details = options.details?.trim();
  const lines = useMemo(() => (details ? details.split('\n') : []), [details]);
  const terminalRows = useTerminalRows();
  const viewport = Math.max(MIN_VIEWPORT, Math.min(MAX_VIEWPORT, terminalRows - RESERVED_ROWS));
  const total = lines.length;
  const maxOffset = Math.max(0, total - viewport);
  const scrollable = total > viewport;
  const [offset, setOffset] = useState(0);

  useInput((_input, key) => {
    if (!scrollable) return;
    if (key.upArrow) setOffset((o) => Math.max(0, o - 1));
    else if (key.downArrow) setOffset((o) => Math.min(maxOffset, o + 1));
    else if (key.pageUp) setOffset((o) => Math.max(0, o - viewport));
    else if (key.pageDown) setOffset((o) => Math.min(maxOffset, o + viewport));
  });

  const visibleLines = scrollable ? lines.slice(offset, offset + viewport) : lines;

  return (
    <Box flexDirection="column">
      {details ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={inkColors.muted}
          paddingX={spacing.gutter}
          marginBottom={spacing.section}
        >
          {visibleLines.map((line, idx) => (
            <Text key={idx}>
              {line.length > 0 ? (
                <>
                  <Text color={inkColors.muted}>{glyphs.quoteRail} </Text>
                  {line}
                </>
              ) : (
                ' '
              )}
            </Text>
          ))}
          {scrollable ? (
            <Text color={inkColors.muted}>
              {glyphs.inlineDot} lines {String(offset + 1)}–{String(Math.min(offset + viewport, total))} of{' '}
              {String(total)} {glyphs.inlineDot} ↑/↓ scroll {glyphs.inlineDot} PgUp/PgDn page
            </Text>
          ) : null}
        </Box>
      ) : null}
      <Box>
        <Text>
          {emoji.donut} {options.message}{' '}
        </Text>
        <Text dimColor>{hint} </Text>
        <ConfirmInput
          defaultChoice={options.default === false ? 'cancel' : 'confirm'}
          onConfirm={() => {
            onSubmit(true);
          }}
          onCancel={() => {
            onSubmit(false);
          }}
        />
      </Box>
    </Box>
  );
}
