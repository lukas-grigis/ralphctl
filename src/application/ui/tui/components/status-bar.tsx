/**
 * Bottom status bar — always visible: a health row plus a one-row hint strip. The top row right-aligns the health indicators
 * (a stethoscope glyph tinted by the worst probe status, plus the npm update hint, plus the
 * current project/sprint and session counts). The hint strip shows the merged keyboard hints
 * (local set first, then globals), fitted to the terminal width.
 *
 * Hints are read from the {@link useActiveHints} registry; views declare their own via
 * `useViewHints([{ keys: 'n', label: 'new' }])`. Global hints are appended last.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useActiveHints, useSuppressedGlobalKeys } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useSessions } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { useSystemStatus } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import { footerGlobalHints, globalKeys } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import { fitHints, type FitHint } from '@src/application/ui/tui/components/hint-budget.ts';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { Divider } from '@src/application/ui/tui/components/divider.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import type { DoctorReport } from '@src/application/flows/doctor/ctx.ts';

const QUIT_HINT: FitHint = { keys: 'ctrl+c', label: 'quit' };

/**
 * Priority order for the footer: view-local hints, `esc back` (omitted at the stack root — it is a
 * no-op there), `? help`, then the remaining globals. While a prompt holds the keyboard every
 * single-letter global is muted, so only the local hints and `ctrl+c quit` are honest.
 */
const orderFooterHints = (args: {
  readonly local: readonly FitHint[];
  readonly globals: readonly FitHint[];
  readonly promptActive: boolean;
  readonly atStackRoot: boolean;
}): readonly FitHint[] => {
  if (args.promptActive) return [...args.local, QUIT_HINT];
  const back = args.globals.filter((h) => h.keys === globalKeys.back.keys[0]);
  const help = args.globals.filter((h) => h.keys === globalKeys.help.keys[0]);
  const rest = args.globals.filter((h) => !back.includes(h) && !help.includes(h));
  return [...args.local, ...(args.atStackRoot ? [] : back), ...help, ...rest];
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
  const sessions = useSessions();
  const localHints = useActiveHints();
  const suppressedKeys = useSuppressedGlobalKeys();
  const system = useSystemStatus();
  // Per-view suppressions hide specific footer hints (matched by their `keys` string) so the
  // footer never advertises a key combo whose default meaning is contradicted by the
  // currently-mounted view. A suppressed key absent from footerGlobalHints is simply a no-op.
  const visibleGlobalHints =
    suppressedKeys.size === 0 ? footerGlobalHints : footerGlobalHints.filter((h) => !suppressedKeys.has(h.keys));
  const { columns } = useTerminalSize();
  const router = useRouter();
  const ui = useUiState();
  const hints = orderFooterHints({
    local: localHints,
    globals: visibleGlobalHints,
    promptActive: ui.promptActive,
    atStackRoot: router.stack.length <= 1,
  });
  const budget = columns - 2 * spacing.indent;

  const running = sessions.filter((s) => s.descriptor.status === 'running').length;
  const sessionSummary =
    sessions.length > 0
      ? `${String(running)} running ${glyphs.bullet} ${String(sessions.length)} total`
      : 'no active runs';

  return (
    <Box flexDirection="column" marginTop={spacing.section}>
      <Divider />
      <Box justifyContent="flex-end" paddingX={spacing.indent}>
        <Box>
          <DoctorIndicator actionable={!ui.promptActive} loading={system.doctorLoading} report={system.doctor} />
          {system.version?.updateAvailable === true && (
            <Text dimColor>
              {'  '}
              {glyphs.bullet} update {system.version.current} {glyphs.arrowRight} {system.version.latest}
            </Text>
          )}
          <Text dimColor>
            {'  '}
            {glyphs.bullet} {sessionSummary}
          </Text>
        </Box>
      </Box>
      <Box paddingX={spacing.indent}>
        <HintStrip hints={hints} budget={budget} />
      </Box>
    </Box>
  );
};

const DoctorIndicator = ({
  loading,
  report,
  actionable,
}: {
  /** `false` while a prompt mutes the global letters — the `!` call to action would be dead. */
  readonly actionable: boolean;
  readonly loading: boolean;
  readonly report: DoctorReport | undefined;
}): React.JSX.Element => {
  if (loading || !report) {
    return (
      <Box>
        <Spinner color={inkColors.muted} />
        <Text dimColor> doctor</Text>
      </Box>
    );
  }
  const failed = report.probes.filter((p) => p.status === 'fail').length;
  const warned = report.probes.filter((p) => p.status === 'warn').length;
  if (failed > 0) {
    return (
      <Text>
        <Text color={inkColors.error}>{glyphs.stethoscope}</Text>
        <Text color={inkColors.error}>
          {' '}
          {String(failed)} doctor failure{failed === 1 ? '' : 's'}
        </Text>
        {actionable && <Text dimColor> (press !)</Text>}
      </Text>
    );
  }
  if (warned > 0) {
    return (
      <Text>
        <Text color={inkColors.warning}>{glyphs.stethoscope}</Text>
        <Text color={inkColors.warning}>
          {' '}
          {String(warned)} doctor warning{warned === 1 ? '' : 's'}
        </Text>
        {actionable && <Text dimColor> (press !)</Text>}
      </Text>
    );
  }
  return (
    <Text>
      <Text color={inkColors.success}>{glyphs.stethoscope}</Text>
      <Text dimColor> doctor ok</Text>
    </Text>
  );
};
