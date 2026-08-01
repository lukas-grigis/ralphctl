import { describe, expect, it } from 'vitest';
import { formatDuration } from '@src/business/_shared/format-duration.ts';

// Canonical duration-formatting suite — the single implementation shared by
// business/sprint/render-journal-entry.ts and business/task/render-round-outcome.ts, which used
// to each define an identical formatDuration + MS_PER_* constants copy.

describe('formatDuration', () => {
  it('renders an em-dash for undefined', () => {
    expect(formatDuration(undefined)).toBe('—');
  });

  it('renders sub-second durations in milliseconds', () => {
    expect(formatDuration(0)).toBe('0ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('renders negative durations in milliseconds verbatim', () => {
    expect(formatDuration(-5)).toBe('-5ms');
  });

  it('renders sub-minute durations in whole seconds', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(1500)).toBe('1s');
    expect(formatDuration(59_000)).toBe('59s');
  });

  it('renders sub-hour durations as minutes, dropping the seconds when zero', () => {
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(5_000 + 60_000)).toBe('1m 5s');
    expect(formatDuration(3_599_000)).toBe('59m 59s');
  });

  it('renders hour-plus durations as hours, dropping the minutes when zero', () => {
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_600_000 + 5 * 60_000)).toBe('1h 5m');
  });
});
