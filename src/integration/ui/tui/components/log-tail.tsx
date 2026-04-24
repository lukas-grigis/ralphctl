/**
 * LogTail — renders the last N log events emitted on `logEventBus`.
 *
 * The Ink sink translates LoggerPort calls into structured `LogEvent`s — this
 * component flattens each event into a single coloured line. Headers and
 * separators are kept compact so the tail stays readable in a small terminal.
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { LogEvent, LogEventLevel } from '@src/business/ports/log-event-bus.ts';
import { glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';

interface Props {
  events: readonly LogEvent[];
  limit?: number;
}

function levelColor(level: LogEventLevel): string | undefined {
  switch (level) {
    case 'error':
      return inkColors.error;
    case 'warn':
    case 'warning':
      return inkColors.warning;
    case 'success':
      return inkColors.success;
    case 'info':
    case 'tip':
      return inkColors.info;
    case 'dim':
    case 'debug':
      return inkColors.muted;
    default:
      return undefined;
  }
}

function renderLine(event: LogEvent, index: number, isActiveSpinner: boolean): React.JSX.Element | null {
  switch (event.kind) {
    case 'log':
      return (
        <Text key={index} color={levelColor(event.level)} dimColor={event.level === 'dim' || event.level === 'debug'}>
          {event.message}
        </Text>
      );
    case 'header':
      return (
        <Text key={index} bold>
          {event.icon ? `${event.icon} ` : ''}
          {event.title}
        </Text>
      );
    case 'separator':
      return (
        <Text key={index} dimColor>
          {'─'.repeat(Math.min(event.width, 40))}
        </Text>
      );
    case 'field':
      return (
        <Text key={index}>
          <Text dimColor>{event.label}: </Text>
          {event.value}
        </Text>
      );
    case 'card':
      return (
        <Text key={index} bold>
          {event.title}
        </Text>
      );
    case 'newline':
      return <Text key={index}> </Text>;
    case 'spinner-start':
      if (isActiveSpinner) {
        return (
          <Box key={index}>
            <Spinner label={event.message} color={inkColors.info} />
          </Box>
        );
      }
      return (
        <Text key={index} color={inkColors.info}>
          {glyphs.phaseDisabled} {event.message}
        </Text>
      );
    case 'spinner-succeed':
      return (
        <Text key={index} color={inkColors.success}>
          {glyphs.check} {event.message}
        </Text>
      );
    case 'spinner-fail':
      return (
        <Text key={index} color={inkColors.error}>
          {glyphs.cross} {event.message}
        </Text>
      );
    case 'spinner-stop':
      return null;
    default: {
      const _exhaustive: never = event;
      void _exhaustive;
      return null;
    }
  }
}

export function LogTail({ events, limit = 8 }: Props): React.JSX.Element {
  const tail = events.slice(-limit);

  // A spinner-start is "active" if no later event with the same id has
  // resolved it (succeed/fail/stop). Scan the full events array — not just
  // the tail — so a spinner whose terminator got trimmed still counts as
  // resolved. Memoized because this runs on every ~16ms signal-bus flush.
  const resolvedIds = useMemo(() => {
    const ids = new Set<number>();
    for (const ev of events) {
      if (ev.kind === 'spinner-succeed' || ev.kind === 'spinner-fail' || ev.kind === 'spinner-stop') {
        ids.add(ev.id);
      }
    }
    return ids;
  }, [events]);

  return (
    <Box flexDirection="column">
      <Text dimColor>── Log ─────────────────────────────</Text>
      {tail.length === 0 ? (
        <Text dimColor>(no activity yet)</Text>
      ) : (
        tail.map((event, i) => {
          const active = event.kind === 'spinner-start' && !resolvedIds.has(event.id);
          return renderLine(event, i, active);
        })
      )}
    </Box>
  );
}
