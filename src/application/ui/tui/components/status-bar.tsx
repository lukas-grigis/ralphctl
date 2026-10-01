/**
 * Footer — always visible: a rule and ONE hint row. Doctor health, the running-session count and
 * the update nudge that used to sit above the hints are tab-bar badges now (`tab-bar.tsx`).
 *
 * The strip shows the merged keyboard hints (view-local first, then the globals
 * {@link buildFooterGlobalHints} derives from where you are), fitted to the terminal width. The
 * single-letter accelerators (`h n x s ! S P`) are never listed here — they live in `? help`.
 *
 * Hints are read from the {@link useActiveHints} registry; views declare their own via
 * `useViewKeys` / `useViewHints`.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing, breakpoints } from '@src/application/ui/tui/theme/tokens.ts';
import { useActiveHints, useSuppressedGlobalKeys } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { buildFooterGlobalHints } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import { fitHints, type FitHint } from '@src/application/ui/tui/components/hint-budget.ts';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { ROUTE_LABELS } from '@src/application/ui/tui/runtime/nav-tree.ts';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { Divider } from '@src/application/ui/tui/components/divider.tsx';

const QUIT_HINT: FitHint = { keys: 'ctrl+c', label: 'quit' };

/**
 * While a prompt holds the keyboard every single-letter global is muted, so only the local hints
 * and `ctrl+c quit` are honest; otherwise the local hints lead and the globals follow.
 */
const orderFooterHints = (args: {
  readonly local: readonly FitHint[];
  readonly globals: readonly FitHint[];
  readonly promptActive: boolean;
}): readonly FitHint[] => (args.promptActive ? [...args.local, QUIT_HINT] : [...args.local, ...args.globals]);

/** One row, never wrapping: fitted cells inside a single truncating `<Text>`. */
const HintStrip = ({ hints, budget }: { readonly hints: readonly FitHint[]; readonly budget: number }) => {
  const { visible } = fitHints(hints, budget);
  return (
    <Text wrap="truncate-end">
      {visible.map((h, i) => (
        <Text key={`${h.keys}-${String(i)}`}>
          {i > 0 && <Text dimColor> {glyphs.bullet} </Text>}
          <Text color={inkColors.primary} bold>
            {h.keys}
          </Text>
          <Text dimColor> {h.label}</Text>
        </Text>
      ))}
    </Text>
  );
};

export const StatusBar = (): React.JSX.Element => {
  const localHints = useActiveHints();
  const suppressedKeys = useSuppressedGlobalKeys();
  const { columns } = useTerminalSize();
  const router = useRouter();
  const ui = useUiState();
  const parent = router.stack[router.stack.length - 2];
  const globals = buildFooterGlobalHints({
    stackDepth: router.stack.length,
    parentLabel: parent !== undefined ? ROUTE_LABELS[parent.id] : undefined,
    onWorkRoot: router.activeSection === 'work' && router.stack.length <= 1 && router.current.id === 'home',
    atOtherSectionRoot: router.stack.length <= 1 && router.activeSection !== 'work' && router.activeSection !== 'none',
    wide: columns >= breakpoints.lg,
  });
  // Per-view suppressions hide specific footer hints (matched by their `keys` string) so the
  // footer never advertises a key combo whose default meaning is contradicted by the
  // currently-mounted view. A suppressed key absent from the globals is simply a no-op.
  const visibleGlobals = suppressedKeys.size === 0 ? globals : globals.filter((h) => !suppressedKeys.has(h.keys));
  const hints = orderFooterHints({ local: localHints, globals: visibleGlobals, promptActive: ui.promptActive });

  return <FooterBar hints={hints} columns={columns} />;
};

/**
 * The footer itself — a rule and one hint row. Exported so an overlay that hides the view (and so
 * its StatusBar) can pin its own hints in the same place.
 */
export const FooterBar = ({
  hints,
  columns,
}: {
  readonly hints: readonly FitHint[];
  readonly columns: number;
}): React.JSX.Element => (
  <Box flexDirection="column">
    <Divider />
    <Box paddingX={spacing.indent}>
      <HintStrip hints={hints} budget={columns - 2 * spacing.indent} />
    </Box>
  </Box>
);
