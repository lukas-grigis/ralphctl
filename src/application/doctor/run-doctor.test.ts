import { describe, expect, it } from 'vitest';

import { aggregateStatus, type DoctorCheckResult } from './run-doctor.ts';

describe('aggregateStatus', () => {
  it('returns ok when every check passes or skips', () => {
    const checks: DoctorCheckResult[] = [
      { name: 'a', status: 'pass' },
      { name: 'b', status: 'skip' },
      { name: 'c', status: 'pass' },
    ];
    expect(aggregateStatus(checks)).toBe('ok');
  });

  it('returns warn when at least one check warns and none fail', () => {
    const checks: DoctorCheckResult[] = [
      { name: 'a', status: 'pass' },
      { name: 'b', status: 'warn' },
      { name: 'c', status: 'skip' },
    ];
    expect(aggregateStatus(checks)).toBe('warn');
  });

  it('returns fail when at least one check fails (overrides warn)', () => {
    const checks: DoctorCheckResult[] = [
      { name: 'a', status: 'pass' },
      { name: 'b', status: 'warn' },
      { name: 'c', status: 'fail' },
    ];
    expect(aggregateStatus(checks)).toBe('fail');
  });

  it('returns ok on an empty input', () => {
    expect(aggregateStatus([])).toBe('ok');
  });
});
