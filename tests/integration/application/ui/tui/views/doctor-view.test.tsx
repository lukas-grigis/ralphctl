/**
 * Smoke tests for DoctorView. The doctor flow itself (`createDoctorFlow`) is mocked so the
 * rendered report is deterministic — it no longer depends on which CLIs happen to be on the
 * test runner's PATH. `system-status-context.tsx` is the sole importer of the flow, so mocking
 * that one module fully controls what `useSystemStatus().doctor` resolves to.
 */

import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { DoctorView } from '@src/application/ui/tui/views/doctor-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { DoctorReport, ProbeResult } from '@src/application/flows/doctor/ctx.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

const reportRef = vi.hoisted(() => ({ current: undefined as DoctorReport | undefined }));

vi.mock('@src/application/flows/doctor/flow.ts', () => ({
  createDoctorFlow: () => ({
    execute: async () => Result.ok({ ctx: { output: reportRef.current } }),
  }),
}));

const probe = (p: Pick<ProbeResult, 'id' | 'label' | 'status'> & Partial<ProbeResult>): ProbeResult => ({
  group: 'ai',
  ...p,
});

const deps = {} as unknown as AppDeps;

describe('DoctorView', () => {
  it('renders the grouped probe report with a summary header', async () => {
    reportRef.current = {
      probes: [
        probe({ id: 'data-root', label: 'Data root readable', status: 'pass', group: 'storage' }),
        probe({ id: 'ai-claude-code', label: 'Claude Code', status: 'pass' }),
      ],
      allPassed: true,
      hasFailures: false,
    };
    const { result } = renderView(<DoctorView />, { deps, initial: { id: 'doctor' } });
    await waitForPredicate(() => /passed/.test(result.lastFrame() ?? ''));
    const frame = result.lastFrame() ?? '';
    expect(frame).toMatch(/passed/);
    expect(frame).toContain('Storage');
    expect(frame).toContain('AI providers');
    expect(frame).toContain('r reload');
  });

  it('publishes the r reload hint', async () => {
    reportRef.current = { probes: [], allPassed: true, hasFailures: false };
    const { result } = renderView(<DoctorView />, { deps, initial: { id: 'doctor' } });
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('reload'));
    expect(result.lastFrame() ?? '').toContain('reload');
  });

  it('renders unknown probes as a muted chip and tallies them separately from warnings', async () => {
    reportRef.current = {
      probes: [
        probe({ id: 'ai-claude-code', label: 'Claude Code', status: 'pass' }),
        probe({
          id: 'ai-auth-github-copilot',
          label: 'GitHub Copilot authenticated',
          status: 'unknown',
          detail: 'no non-interactive auth-status verb',
        }),
      ],
      allPassed: true,
      hasFailures: false,
    };
    const { result } = renderView(<DoctorView />, { deps, initial: { id: 'doctor' } });
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('GitHub Copilot authenticated'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('UNKNOWN');
    // The summary header tallies it as "1 unknown", not as a warning.
    expect(frame).toContain('0 warnings');
    expect(frame).toContain('1 unknown');
  });
});
