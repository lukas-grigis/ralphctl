/**
 * RateLimitBanner — shown when the rate-limit coordinator has paused new
 * task launches globally. Disappears when the coordinator resumes.
 *
 * When `resumeAt` is provided the banner ticks down once per second toward
 * the resume time. Once the countdown reaches zero (and we have not yet
 * received a resume event) the banner switches to an indeterminate state —
 * the coordinator may still be paused waiting on the next attempt.
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { inkColors, spacing } from '../../../integration/ui/theme/tokens.ts';
import type { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';

interface Props {
  readonly visible: boolean;
  readonly message?: string;
  /** Optional ISO timestamp when the coordinator is expected to resume. */
  readonly resumeAt?: IsoTimestamp | null;
  /**
   * Tick interval. Defaults to 1000ms; tests override to 0 to make the
   * countdown render synchronously.
   */
  readonly tickIntervalMs?: number;
  /**
   * Clock seam — defaults to `Date.now`. Tests inject a stable clock to
   * make the banner's countdown deterministic without faking timers.
   */
  readonly now?: () => number;
}

/** Inclusive seconds remaining (rounded up) until `resumeAt`, never negative. */
function secondsRemaining(resumeAt: IsoTimestamp, now: number): number {
  const target = Date.parse(resumeAt);
  if (Number.isNaN(target)) return 0;
  return Math.max(0, Math.ceil((target - now) / 1000));
}

export function RateLimitBanner({
  visible,
  message,
  resumeAt,
  tickIntervalMs = 1000,
  now = Date.now,
}: Props): React.JSX.Element | null {
  const [remaining, setRemaining] = useState<number | null>(() =>
    resumeAt ? secondsRemaining(resumeAt, now()) : null
  );

  useEffect(() => {
    if (!visible || !resumeAt) {
      setRemaining(null);
      return;
    }
    setRemaining(secondsRemaining(resumeAt, now()));
    const id = setInterval(() => {
      // Bail out when the recomputed value matches the prior one — Ink
      // re-renders on every state set, even when the value is identical.
      // Once the countdown plateaus at 0 (or "Resuming…") this prevents a
      // 1Hz storm of wasted reconciliations.
      setRemaining((prev) => {
        const next = secondsRemaining(resumeAt, now());
        return next === prev ? prev : next;
      });
    }, tickIntervalMs);
    return () => {
      clearInterval(id);
    };
  }, [visible, resumeAt, tickIntervalMs, now]);

  if (!visible) return null;

  const tail = formatTail({ remaining, message });

  return (
    <Box borderStyle="round" borderColor={inkColors.warning} paddingX={spacing.cardPadX} marginTop={spacing.section}>
      <Text color={inkColors.warning} bold>
        {`⚠ Rate limit reached${tail}`}
      </Text>
    </Box>
  );
}

function formatTail({ remaining, message }: { readonly remaining: number | null; readonly message?: string }): string {
  const reasonSuffix = message ? ` — ${message}` : '';
  if (remaining === null) {
    return `${reasonSuffix}. Waiting to resume…`;
  }
  if (remaining <= 0) {
    // Countdown finished but we have not yet seen a resume event; the
    // coordinator may still be paused waiting on the next attempt.
    return `${reasonSuffix}. Resuming…`;
  }
  return `${reasonSuffix} — resuming in ${String(remaining)}s`;
}
