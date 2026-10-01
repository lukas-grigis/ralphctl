/** Footer — always visible: a rule and ONE hint row. */

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
 * While a prompt holds the keyboard the view's keys and every global letter are muted, so only the prompt's own keys
 * (published through `usePromptHints`) and `ctrl+c quit` are honest; otherwise local hints lead.
 */
const orderFooterHints = (args: {
  readonly local: ReadonlyArray<FitHint & { readonly prompt?: boolean }>;
  readonly globals: readonly FitHint[];
  readonly promptActive: boolean;
}): readonly FitHint[] => {
  if (!args.promptActive) return [...args.local.filter((h) => h.prompt !== true), ...args.globals];
  // The prompt's own keys lead; with none published (a bare confirm overlay) only quit is honest.
  return [...args.local.filter((h) => h.prompt === true), QUIT_HINT];
};

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
  // Per-view suppressions hide specific footer hints (matched by their `keys` string) so the footer never advertises
  // a key combo whose default meaning is contradicted by the currently-mounted view.
  // A claimed `esc` closes something local (a card, an overlay) — advertising "esc <parent>" would lie.
  const visibleGlobals = globals.filter((h) => !suppressedKeys.has(h.keys) && !(ui.escapeClaimed && h.keys === 'esc'));
  const hints = orderFooterHints({ local: localHints, globals: visibleGlobals, promptActive: ui.promptActive });

  return <FooterBar hints={hints} columns={columns} />;
};

/**
 * The footer itself — a rule and one hint row. Exported so an overlay that hides the view (and so its StatusBar) can
 * pin its own hints in the same place.
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
