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
import {
  useActiveHints,
  useSuppressedGlobalKeys,
  type ViewHint,
} from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { useSessions } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { useSystemStatus } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import { KeyboardHints } from '@src/application/ui/tui/components/keyboard-hints.tsx';
import { Divider } from '@src/application/ui/tui/components/divider.tsx';
import { Spinner } from '@src/application/ui/tui/components/spinner.tsx';
import type { DoctorReport } from '@src/application/flows/doctor/ctx.ts';

const GLOBAL_HINTS: readonly ViewHint[] = [
  { keys: 'h', label: 'home' },
  { keys: 'n', label: 'new flow' },
  { keys: 'P', label: 'switch project' },
  { keys: 'x', label: 'sessions' },
  { keys: 's', label: 'settings' },
  { keys: '↑/↓', label: 'scroll' },
  { keys: '?', label: 'help' },
  { keys: 'esc', label: 'back' },
  { keys: 'q', label: 'quit' },
];

/** A stethoscope sits in the footer; the tint flips with doctor state. */
const STETHOSCOPE = '🩺';

export const StatusBar = (): React.JSX.Element => {
  const sessions = useSessions();
  const localHints = useActiveHints();
  const suppressedKeys = useSuppressedGlobalKeys();
  const system = useSystemStatus();
  // Per-view suppressions hide specific global hints so the footer never advertises a key combo
  // whose default meaning is contradicted by the currently-mounted view (e.g. a Review-step
  // description that fits the viewport mutes the ↑/↓ scroll hint because arrows are inert).
  const visibleGlobalHints =
    suppressedKeys.size === 0 ? GLOBAL_HINTS : GLOBAL_HINTS.filter((h) => !suppressedKeys.has(h.keys));

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
        </Box>
      </Box>
      <Box paddingX={spacing.indent}>
        <KeyboardHints hints={[...localHints, ...visibleGlobalHints]} />
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
        <Text color={inkColors.error}>{STETHOSCOPE}</Text>
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
        <Text color={inkColors.warning}>{STETHOSCOPE}</Text>
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
      <Text color={inkColors.success}>{STETHOSCOPE}</Text>
      <Text dimColor> doctor ok</Text>
    </Text>
  );
};
