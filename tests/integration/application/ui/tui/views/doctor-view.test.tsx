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
  it('collapses passing probes behind a count and expands them on ↵', async () => {
    reportRef.current = {
      probes: [
        probe({ id: 'data-root', label: 'Data root readable', status: 'pass', group: 'storage' }),
        probe({ id: 'ai-claude-code', label: 'Claude Code', status: 'pass' }),
      ],
      allPassed: true,
      hasFailures: false,
    };
    const { result } = renderView(<DoctorView />, { deps, initial: { id: 'doctor' } });
    await waitForPredicate(() => /2 passed/.test(result.lastFrame() ?? ''));
    expect(result.lastFrame()).not.toContain('Storage');
    expect(result.lastFrame()).toContain('show passed');
    result.stdin.write('\r');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('Storage'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('AI providers');
    expect(frame).toContain('hide passed');
    expect(frame).toContain('r reload');
  });

  it('leads with the group that fails and keeps its hint on one line', async () => {
    const hint =
      'run `git -C /Users/me/Workzone/github/someone/some-long-repository-name-here remote set-head origin --auto` to discover it';
    reportRef.current = {
      probes: [
        probe({ id: 'data-root', label: 'Data root readable', status: 'pass', group: 'storage' }),
        probe({ id: 'ai-claude-code', label: 'Claude Code', status: 'fail', hint }),
      ],
      allPassed: false,
      hasFailures: true,
    };
    const { result } = renderView(<DoctorView />, { deps, initial: { id: 'doctor' } });
    await waitForPredicate(() => /Claude Code/.test(result.lastFrame() ?? ''));
    const frame = result.lastFrame() ?? '';
    expect(frame.indexOf('AI providers')).toBeLessThan(frame.indexOf('1 passed'));
    const hintLine = frame.split('\n').find((l) => l.includes('hint:')) ?? '';
    expect(hintLine).toContain('remote set-head origin --auto` to discover it');
    expect(hintLine).toContain('…');
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
