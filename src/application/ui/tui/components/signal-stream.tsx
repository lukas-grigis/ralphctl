/**
 * Live signal stream panel — renders the harness signal feed in human form. Each variant has a
 * dedicated row layout so progress vs evaluation vs task-verified read distinct at a glance.
 *
 * The component takes the raw signal array (the {@link useSinkStream} hook produces this) and
 * renders the most recent N. Older signals scroll off the top; the user can navigate to the
 * sessions / progress detail view for the full archive.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { HarnessSignal, EvaluationSignal } from '@src/domain/signal.ts';
import { glyphs, inkColors, spacing } from '@src/application/ui/tui/theme/tokens.ts';
import { fmtIsoTime } from '@src/application/ui/tui/theme/duration.ts';

export interface SignalStreamProps {
  readonly signals: readonly HarnessSignal[];
  readonly maxRows?: number;
  /**
   * When false, the empty-state copy switches from "(awaiting signals…)" to "(none)" — the
   * flow has terminated, so "awaiting" is misleading. Defaults to `true` (still running).
   */
  readonly running?: boolean;
}

export const SignalStream = ({ signals, maxRows = 8, running = true }: SignalStreamProps): React.JSX.Element => {
  const rows = signals.slice(-maxRows);
  if (rows.length === 0) {
    return (
      <Box paddingX={spacing.indent}>
        <Text dimColor>{running ? '(awaiting signals…)' : '(none)'}</Text>
      </Box>
    );
  }
  return (
    <Box flexDirection="column">
      {rows.map((signal, i) => (
        <SignalRow key={`sig-${String(i)}`} signal={signal} />
      ))}
    </Box>
  );
};

const SignalRow = ({ signal }: { readonly signal: HarnessSignal }): React.JSX.Element => {
  const ts = fmtIsoTime(String(signal.timestamp));
  switch (signal.type) {
    case 'progress':
      return (
        <Box paddingX={spacing.indent}>
          <Text dimColor>{ts}</Text>
          <Text color={inkColors.info} bold>
            {'  '}prog{'  '}
          </Text>
          <Text>{signal.summary}</Text>
          {signal.files !== undefined && signal.files.length > 0 && (
            <Text dimColor>
              {' '}
              {glyphs.bullet} {String(signal.files.length)} files
            </Text>
          )}
        </Box>
      );
    case 'evaluation':
      return <EvaluationRow signal={signal} ts={ts} />;
    case 'task-complete':
      return (
        <Box paddingX={spacing.indent}>
          <Text dimColor>{ts}</Text>
          <Text color={inkColors.success} bold>
            {'  '}done{'  '}
          </Text>
          <Text>task complete</Text>
        </Box>
      );
    case 'task-verified':
      return (
        <Box paddingX={spacing.indent}>
          <Text dimColor>{ts}</Text>
          <Text color={inkColors.success} bold>
            {'  '}vrfy{'  '}
          </Text>
          <Text>{signal.output.length > 80 ? `${signal.output.slice(0, 79)}…` : signal.output}</Text>
        </Box>
      );
    case 'task-blocked':
      return (
        <Box paddingX={spacing.indent}>
          <Text dimColor>{ts}</Text>
          <Text color={inkColors.error} bold>
            {'  '}blok{'  '}
          </Text>
          <Text>{signal.reason}</Text>
        </Box>
      );
    case 'note':
      return (
        <Box paddingX={spacing.indent}>
          <Text dimColor>{ts}</Text>
          <Text dimColor>
            {'  '}note{'  '}
          </Text>
          <Text dimColor italic>
            {signal.text}
          </Text>
        </Box>
      );
    case 'check-script-discovery':
    case 'setup-script':
    case 'verify-script':
      return (
        <Box paddingX={spacing.indent}>
          <Text dimColor>{ts}</Text>
          <Text color={inkColors.warning} bold>
            {'  '}scrp{'  '}
          </Text>
          <Text>
            {signal.type}: <Text dimColor>{signal.command}</Text>
          </Text>
        </Box>
      );
    case 'agents-md-proposal':
      return (
        <Box paddingX={spacing.indent}>
          <Text dimColor>{ts}</Text>
          <Text color={inkColors.highlight} bold>
            {'  '}prop{'  '}
          </Text>
          <Text>
            &lt;{signal.tag}&gt; proposal ({String(signal.content.length)} chars)
          </Text>
        </Box>
      );
    case 'setup-skill-proposal':
    case 'verify-skill-proposal':
      return (
        <Box paddingX={spacing.indent}>
          <Text dimColor>{ts}</Text>
          <Text color={inkColors.highlight} bold>
            {'  '}skil{'  '}
          </Text>
          <Text>
            {signal.type}: <Text dimColor>{String(signal.content.length)} chars</Text>
          </Text>
        </Box>
      );
    case 'skill-suggestions':
      return (
        <Box paddingX={spacing.indent}>
          <Text dimColor>{ts}</Text>
          <Text color={inkColors.info} bold>
            {'  '}skil{'  '}
          </Text>
          <Text>{signal.names.length > 0 ? signal.names.join(', ') : '(none)'}</Text>
        </Box>
      );
    case 'change':
      return (
        <Box paddingX={spacing.indent}>
          <Text dimColor>{ts}</Text>
          <Text color={inkColors.info} bold>
            {'  '}chng{'  '}
          </Text>
          <Text>{truncate(signal.text, 80)}</Text>
        </Box>
      );
    case 'learning':
      return (
        <Box paddingX={spacing.indent}>
          <Text dimColor>{ts}</Text>
          <Text color={inkColors.highlight} bold>
            {'  '}lern{'  '}
          </Text>
          <Text>{truncate(signal.text, 80)}</Text>
        </Box>
      );
    case 'decision':
      return (
        <Box paddingX={spacing.indent}>
          <Text dimColor>{ts}</Text>
          <Text color={inkColors.highlight} bold>
            {'  '}dcsn{'  '}
          </Text>
          <Text bold>{truncate(signal.text, 80)}</Text>
        </Box>
      );
    case 'progress-entry':
      return (
        <Box paddingX={spacing.indent}>
          <Text dimColor>{ts}</Text>
          <Text color={inkColors.info} bold>
            {'  '}entr{'  '}
          </Text>
          <Text>{signal.task}</Text>
          {signal.filesChanged.length > 0 && (
            <Text dimColor>
              {' '}
              {glyphs.bullet} {String(signal.filesChanged.length)} files
            </Text>
          )}
        </Box>
      );
    case 'commit-message':
      return (
        <Box paddingX={spacing.indent}>
          <Text dimColor>{ts}</Text>
          <Text color={inkColors.info} bold>
            {'  '}cmsg{'  '}
          </Text>
          <Text>{truncate(signal.subject, 80)}</Text>
        </Box>
      );
    default: {
      const _exhaustive: never = signal;
      void _exhaustive;
      return <Text>(unknown signal)</Text>;
    }
  }
};

const truncate = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

const EvaluationRow = ({
  signal,
  ts,
}: {
  readonly signal: EvaluationSignal;
  readonly ts: string;
}): React.JSX.Element => {
  const color =
    signal.status === 'passed' ? inkColors.success : signal.status === 'failed' ? inkColors.error : inkColors.warning;
  return (
    <Box flexDirection="column" paddingX={spacing.indent}>
      <Box>
        <Text dimColor>{ts}</Text>
        <Text color={color} bold>
          {'  '}eval{'  '}
        </Text>
        <Text bold>{signal.status}</Text>
        {signal.overallScore !== undefined && (
          <Text dimColor>
            {' '}
            {glyphs.bullet} {signal.overallScore.toFixed(1)}/5.0
          </Text>
        )}
      </Box>
      {signal.dimensions.length > 0 && (
        <Box paddingLeft={6}>
          <Text dimColor>
            {signal.dimensions
              .map((d) => `${d.dimension}: ${String(d.score)}/5 ${d.passed ? glyphs.check : glyphs.cross}`)
              .join(`  ${glyphs.bullet}  `)}
          </Text>
        </Box>
      )}
      {signal.critique !== undefined && signal.critique.length > 0 && (
        <Box paddingLeft={6}>
          <Text dimColor italic>
            {signal.critique.length > 100 ? `${signal.critique.slice(0, 99)}…` : signal.critique}
          </Text>
        </Box>
      )}
    </Box>
  );
};
