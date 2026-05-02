import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { cleanup, render } from 'ink-testing-library';

import { RateLimitBanner } from './rate-limit-banner.tsx';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';

afterEach(() => {
  cleanup();
});

describe('RateLimitBanner', () => {
  it('renders nothing when not visible', () => {
    const { lastFrame } = render(<RateLimitBanner visible={false} />);
    expect(lastFrame()).toBe('');
  });

  it('renders an indeterminate banner when visible without resumeAt', () => {
    const { lastFrame } = render(<RateLimitBanner visible={true} />);
    expect(lastFrame()).toContain('Rate limit reached');
    expect(lastFrame()).toContain('Waiting to resume');
  });

  it('shows a countdown reflecting seconds remaining when resumeAt is set', () => {
    // Pin "now" to a fixed value 30s before resumeAt so the rendered
    // countdown is deterministic.
    const now = new Date('2026-04-29T12:00:00.000Z').getTime();
    const resumeAt = new Date(now + 30_000).toISOString() as IsoTimestamp;
    const { lastFrame } = render(<RateLimitBanner visible={true} resumeAt={resumeAt} now={() => now} />);
    expect(lastFrame()).toContain('Rate limit reached');
    expect(lastFrame()).toContain('resuming in 30s');
  });

  it('shows "Resuming…" once countdown reaches zero (no resume event yet)', () => {
    // resumeAt already in the past — secondsRemaining clamps to 0.
    const now = new Date('2026-04-29T12:00:30.000Z').getTime();
    const resumeAt = new Date(now - 5_000).toISOString() as IsoTimestamp;
    const { lastFrame } = render(<RateLimitBanner visible={true} resumeAt={resumeAt} now={() => now} />);
    expect(lastFrame()).toContain('Resuming…');
  });

  it('disappears when toggled invisible', () => {
    const { lastFrame, rerender } = render(<RateLimitBanner visible={true} />);
    expect(lastFrame()).toContain('Rate limit');
    rerender(<RateLimitBanner visible={false} />);
    expect(lastFrame()).toBe('');
  });
});
