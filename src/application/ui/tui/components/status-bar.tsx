/**
 * Bottom status bar — always visible, two rows. The top row right-aligns the health indicators
 * (a stethoscope glyph tinted by the worst probe status, plus the npm update hint, plus the
 * current project/sprint and session counts). The bottom row shows merged keyboard hints
 * (global + the current view's local set).
 *
 * Hints are read from the {@link useActiveHints} registry; views declare their own via
 * `useViewHints([{ keys: 'n', label: 'new' }])`. Global hints are appended last.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { useActiveHints, useSuppressedGlobalKeys } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useSessions } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { useAwaitingSessions } from '@src/application/ui/tui/runtime/use-awaiting-sessions.ts';
import { useTerminalSize } from '@src/application/ui/tui/runtime/use-terminal-size.ts';
import { useSystemStatus } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import { footerGlobalHints, globalKeys } from '@src/application/ui/tui/runtime/keyboard-map.ts';
import { fitHints, KeyboardHints } from '@src/application/ui/tui/components/keyboard-hints.tsx';
import { Divider } from '@src/application/ui/tui/components/divider.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import type { DoctorReport } from '@src/application/flows/doctor/ctx.ts';

/** Never dropped to make room: the two keys that answer "how do I get help / leave". */
const PINNED_HINT_KEYS: ReadonlySet<string> = new Set([globalKeys.help.keys.join('/'), globalKeys.quit.keys.join('/')]);

export const StatusBar = (): React.JSX.Element => {
  const sessions = useSessions();
  const localHints = useActiveHints();
  const suppressedKeys = useSuppressedGlobalKeys();
  const system = useSystemStatus();
  const awaiting = useAwaitingSessions();
  const { columns } = useTerminalSize();
  // Per-view suppressions hide specific footer hints (matched by their `keys` string) so the
  // footer never advertises a key combo whose default meaning is contradicted by the
  // currently-mounted view. A suppressed key absent from footerGlobalHints is simply a no-op.
  const visibleGlobalHints =
    suppressedKeys.size === 0 ? footerGlobalHints : footerGlobalHints.filter((h) => !suppressedKeys.has(h.keys));

  const running = sessions.filter((s) => s.descriptor.status === 'running').length;
  const waiting = sessions.filter((s) => s.descriptor.status === 'running' && awaiting.has(s.descriptor.id)).length;
  const sessionSummary =
    sessions.length > 0
      ? `${String(running)} running ${glyphs.bullet} ${String(sessions.length)} total`
      : 'no active runs';

  return (
    <Box flexDirection="column" marginTop={spacing.section}>
      <Divider />
      <Box justifyContent="flex-end" paddingX={spacing.indent}>
        <Box>
          <DoctorIndicator loading={system.doctorLoading} report={system.doctor} />
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
          {waiting > 0 && (
            <Text color={inkColors.warning} bold>
              {'  '}
              {glyphs.warningGlyph} [WAITING]
              {waiting > 1 ? ` ${String(waiting)}` : ''}
            </Text>
          )}
        </Box>
      </Box>
      {/* One line, local hints first: when it overflows the global tail is what gets clipped. */}
      <Box paddingX={spacing.indent}>
        <KeyboardHints
          hints={fitHints(
            [...localHints, ...visibleGlobalHints],
            columns - 2 * spacing.indent,
            localHints.length,
            PINNED_HINT_KEYS
          )}
        />
      </Box>
    </Box>
  );
};

const DoctorIndicator = ({
  loading,
  report,
}: {
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
        <Text dimColor> (press !)</Text>
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
        <Text dimColor> (press !)</Text>
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
