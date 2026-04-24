/**
 * LogTail — renders a scrollable window of log events emitted on `logEventBus`.
 *
 * The Ink sink translates LoggerPort calls into structured `LogEvent`s — this
 * component flattens each event into a single coloured line. Headers and
 * separators are kept compact so the tail stays readable in a small terminal.
 *
 * Scrolling:
 *   - `scrollOffset = 0` means "stick to bottom" (default, live-update mode).
 *   - `scrollOffset > 0` means the user has paged up; auto-scroll is frozen.
 *   - The parent controls `scrollOffset` and passes it as a prop so key
 *     handling lives in the view (which already owns `useInput`).
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { LogEvent, LogEventLevel } from '@src/business/ports/log-event-bus.ts';
import { glyphs, inkColors } from '@src/integration/ui/theme/tokens.ts';
import { Spinner } from '@src/integration/ui/tui/components/spinner.tsx';

interface Props {
  events: readonly LogEvent[];
  /** How many lines to display at once. Defaults to 8. */
  visibleLines?: number;
  /**
   * How many lines above the natural tail the user has scrolled.
   * 0 = stick-to-bottom. Positive values show older events.
   * Clamped internally so callers don't have to guard boundaries.
   */
  scrollOffset?: number;
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

export function LogTail({ events, visibleLines = 8, scrollOffset = 0 }: Props): React.JSX.Element {
  // Clamp offset so callers don't have to guard upper/lower bounds.
  const maxOffset = Math.max(0, events.length - visibleLines);
  const clampedOffset = Math.min(Math.max(0, scrollOffset), maxOffset);

  // Slice the visible window. When offset=0 this is the tail; when offset>0
  // we show older events above that tail.
  const end = events.length - clampedOffset;
  const start = Math.max(0, end - visibleLines);
  const window = events.slice(start, end);

  // A spinner-start is "active" if no later event with the same id has
  // resolved it (succeed/fail/stop). Scan the full events array — not just
  // the window — so a spinner whose terminator got trimmed still counts as
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

  const scrolledUp = clampedOffset > 0;
  const hiddenAbove = start;
  const hiddenBelow = events.length - end;

  return (
    <Box flexDirection="column">
      <Box>
        <Text dimColor>── Log ─────────────────────────────</Text>
        {scrolledUp ? (
          <Text dimColor>
            {'  '}
            {glyphs.arrowRight} {hiddenAbove} line{hiddenAbove !== 1 ? 's' : ''} above
            {hiddenBelow > 0 ? ` · ${String(hiddenBelow)} below` : ''}
          </Text>
        ) : events.length > visibleLines ? (
          <Text dimColor>
            {'  '}({events.length - visibleLines} hidden)
          </Text>
        ) : null}
      </Box>
      {window.length === 0 ? (
        <Text dimColor>(no activity yet)</Text>
      ) : (
        window.map((event, i) => {
          const active = event.kind === 'spinner-start' && !resolvedIds.has(event.id);
          return renderLine(event, i, active);
        })
      )}
    </Box>
  );
}
