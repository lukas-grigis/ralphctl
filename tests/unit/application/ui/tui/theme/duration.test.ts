/**
 * Unit tests for the duration formatters in `theme/duration.ts`.
 *
 * Local-time formatters (`fmtIsoTime`, `fmtIsoHHMM`, `fmtIsoAbsolute`) depend on the
 * host timezone, which makes naive assertions flaky across dev / CI environments. We pin
 * TZ=UTC in `beforeEach` so `new Date(iso)` resolves deterministically, then assert the
 * expected local string for that pinned zone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fmtDuration,
  fmtElapsed,
  fmtIsoAbsolute,
  fmtIsoHHMM,
  fmtIsoTime,
} from '@src/application/ui/tui/theme/duration.ts';

// ---------------------------------------------------------------------------
// fmtDuration
// ---------------------------------------------------------------------------

describe('fmtDuration', () => {
  it('renders sub-second values as whole milliseconds', () => {
    expect(fmtDuration(0)).toBe('0ms');
    expect(fmtDuration(9.7)).toBe('10ms');
    expect(fmtDuration(999)).toBe('999ms');
  });

  it('renders 1–60 seconds with one decimal', () => {
    expect(fmtDuration(1000)).toBe('1.0s');
    expect(fmtDuration(1500)).toBe('1.5s');
    expect(fmtDuration(59_999)).toBe('60.0s');
  });

  it('renders ≥ 60 s as MmSs', () => {
    expect(fmtDuration(60_000)).toBe('1m0s');
    expect(fmtDuration(90_000)).toBe('1m30s');
    expect(fmtDuration(3_661_000)).toBe('61m1s');
  });
});

// ---------------------------------------------------------------------------
// fmtElapsed
// ---------------------------------------------------------------------------

describe('fmtElapsed', () => {
  it('renders sub-second elapsed as raw ms', () => {
    expect(fmtElapsed(1000, 1500)).toBe('500ms');
  });

  it('renders seconds without decimal', () => {
    expect(fmtElapsed(0, 45_000)).toBe('45s');
  });

  it('pads the seconds component to two digits', () => {
    expect(fmtElapsed(0, 65_000)).toBe('1m05s');
    expect(fmtElapsed(0, 600_000)).toBe('10m00s');
  });
});

// ---------------------------------------------------------------------------
// Local-time formatters — pinned to UTC for deterministic assertions
// ---------------------------------------------------------------------------

describe('fmtIsoTime (local timezone)', () => {
  beforeEach(() => {
    vi.stubEnv('TZ', 'UTC');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns HH:MM:SS in local time (UTC pinned)', () => {
    // In UTC the ISO offset is +00:00 so local == UTC.
    expect(fmtIsoTime('2025-05-16T17:07:42.123Z')).toBe('17:07:42');
  });

  it('zero-pads hours, minutes, seconds', () => {
    expect(fmtIsoTime('2025-01-01T00:00:05.000Z')).toBe('00:00:05');
    expect(fmtIsoTime('2025-01-01T01:02:03.000Z')).toBe('01:02:03');
  });

  it('falls back to raw slice on a malformed timestamp', () => {
    // Must not throw. 'not-a-date'.slice(11, 19) === '' (string shorter than 19 chars).
    expect(fmtIsoTime('not-a-date')).toBe('');
  });
});

describe('fmtIsoHHMM (local timezone)', () => {
  beforeEach(() => {
    vi.stubEnv('TZ', 'UTC');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns HH:MM in local time (UTC pinned)', () => {
    expect(fmtIsoHHMM('2025-05-16T17:07:42.123Z')).toBe('17:07');
  });

  it('zero-pads hours and minutes', () => {
    expect(fmtIsoHHMM('2025-01-01T00:00:05.000Z')).toBe('00:00');
    expect(fmtIsoHHMM('2025-01-01T01:02:03.000Z')).toBe('01:02');
  });

  it('falls back to raw slice on a malformed timestamp', () => {
    expect(fmtIsoHHMM('not-a-date')).toBe('');
  });
});

describe('fmtIsoAbsolute (local timezone)', () => {
  beforeEach(() => {
    vi.stubEnv('TZ', 'UTC');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns YYYY-MM-DD HH:MM in local time (UTC pinned)', () => {
    expect(fmtIsoAbsolute('2025-05-16T17:07:42.123Z')).toBe('2025-05-16 17:07');
  });

  it('zero-pads month, day, hours, and minutes', () => {
    expect(fmtIsoAbsolute('2025-01-05T01:02:00.000Z')).toBe('2025-01-05 01:02');
  });

  it('falls back to raw slice on a malformed timestamp', () => {
    // 'not-a-date'.slice(0, 16).replace('T', ' ') === 'not-a-date'
    expect(fmtIsoAbsolute('not-a-date')).toBe('not-a-date');
  });
});
