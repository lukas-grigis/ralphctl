import { describe, expect, it } from 'vitest';
import { doctorSummary } from '@src/application/ui/tui/views/system-view-model.ts';
import type { DoctorReport } from '@src/application/flows/doctor/ctx.ts';

const report = (probes: DoctorReport['probes']): DoctorReport => ({
  probes,
  allPassed: false,
  hasFailures: probes.some((p) => p.status === 'fail'),
});

describe('doctorSummary', () => {
  it("names the first warning's actual problem, not the probe", () => {
    const { summary, tone } = doctorSummary(
      report([
        { id: 'gh-installed', label: 'GitHub CLI (`gh`) installed', status: 'warn', detail: 'gh not found on PATH' },
        { id: 'other', label: 'Other', status: 'warn', detail: 'second' },
      ]),
      false
    );
    expect(summary).toBe('⚠ 2 warnings — gh not found on PATH');
    expect(tone).toBe('warn');
  });

  it('falls back to the probe label when it carries no detail, and uses only the first detail line', () => {
    expect(doctorSummary(report([{ id: 'a', label: 'Probe A', status: 'fail' }]), false).summary).toBe(
      '✗ 1 failing — Probe A'
    );
    expect(
      doctorSummary(report([{ id: 'a', label: 'Probe A', status: 'warn', detail: 'first\nsecond' }]), false).summary
    ).toBe('⚠ 1 warning — first');
  });
});
