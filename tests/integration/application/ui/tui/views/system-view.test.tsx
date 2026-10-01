/**
 * System hub — Settings / Skills / Doctor with live summaries; Doctor jumps to the top while its
 * report holds a warning or failure. Mounted through the real chrome so `↵` / `esc` exercise the
 * System stack, with the real hub and stubbed children.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { DoctorReport } from '@src/application/flows/doctor/ctx.ts';
import { useSystemStatus } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { ENTER, ESC, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitFor } from '@tests/integration/application/ui/tui/_wait.ts';
import { mountFrame, type AppFrame } from '@tests/integration/application/ui/tui/_app-frame.tsx';
import { stripAnsi } from '@tests/integration/application/ui/tui/_harness.tsx';

const reportRef = vi.hoisted(() => ({ current: undefined as DoctorReport | undefined, calls: 0 }));

vi.mock('@src/application/flows/doctor/flow.ts', () => ({
  createDoctorFlow: () => ({
    execute: async () => {
      reportRef.calls += 1;
      return Result.ok({ ctx: { output: reportRef.current } });
    },
  }),
}));

const report = (statuses: ReadonlyArray<'pass' | 'warn' | 'fail'>): DoctorReport => ({
  probes: statuses.map((status, i) => ({ id: `p${String(i)}`, label: `check ${String(i + 1)}`, status })),
  allPassed: statuses.every((s) => s === 'pass'),
  hasFailures: statuses.includes('fail'),
});

const Refresh = (): null => {
  const { refreshDoctor } = useSystemStatus();
  React.useEffect(() => {
    void refreshDoctor();
  }, [refreshDoctor]);
  return null;
};

const entry = (id: string, installs: ReadonlyArray<{ status: string }> = []): unknown => ({ name: id, installs });

const stubDeps = (skills: readonly unknown[] = []): AppDeps =>
  ({
    eventBus: createInMemoryEventBus(),
    settingsRepo: { load: async () => Result.ok(DEFAULT_SETTINGS) },
    skillCatalog: { list: async () => Result.ok(skills) },
    projectRepo: { list: async () => Result.ok([]) },
    sprintRepo: { list: async () => Result.ok([]) },
    taskRepo: { findBySprintId: async () => Result.ok([]) },
  }) as unknown as AppDeps;

const mountHub = async (r: DoctorReport, skills: readonly unknown[] = []): Promise<AppFrame> => {
  reportRef.current = r;
  reportRef.calls = 0;
  const f = mountFrame({
    columns: 100,
    rows: 24,
    deps: stubDeps(skills),
    initial: { id: 'system' },
    probe: <Refresh />,
  });
  await waitFor(() => expect(stripAnsi(f.result.lastFrame() ?? '')).toContain('Settings'));
  await tick(80);
  return f;
};

/** Hub rows in order — the lines naming one of the children. */
const hubRows = (f: AppFrame): string[] =>
  f
    .lines()
    .map(stripAnsi)
    .filter((l) => /^\s*[▸ ]\s*(Settings|Skills|Doctor)\b/.test(l));

describe('SystemView', () => {
  it('puts Doctor first with its warning count and first warning when the report has warnings', async () => {
    const f = await mountHub(report(['pass', 'warn', 'warn']));
    await waitFor(() => expect(hubRows(f)[0] ?? '').toContain('Doctor'));
    const first = hubRows(f)[0] ?? '';
    expect(first).toContain('⚠ 2 warnings');
    expect(first).toContain('check 2');
    expect(hubRows(f).map((r) => /(Settings|Skills|Doctor)/.exec(r)?.[1])).toEqual(['Doctor', 'Settings', 'Skills']);
    f.result.unmount();
  });

  it('reports failures over warnings', async () => {
    const f = await mountHub(report(['fail', 'warn']));
    await waitFor(() => expect(hubRows(f)[0] ?? '').toContain('✗ 1 failing'));
    f.result.unmount();
  });

  it('keeps Settings first and says all checks passed when the report is clean', async () => {
    const f = await mountHub(report(['pass', 'pass', 'pass']));
    await waitFor(() => expect(hubRows(f).join('\n')).toContain('✓ all 3 checks passed'));
    expect(hubRows(f).map((r) => /(Settings|Skills|Doctor)/.exec(r)?.[1])).toEqual(['Settings', 'Skills', 'Doctor']);
    f.result.unmount();
  });

  it('summarises settings and skills from their sources', async () => {
    const f = await mountHub(report(['pass']), [
      entry('a', [{ status: 'up-to-date' }]),
      entry('b', [{ status: 'update-available' }, { status: 'update-available' }]),
      entry('c'),
    ]);
    await waitFor(() => expect(hubRows(f).join('\n')).toContain('3 bundled'));
    const rows = hubRows(f).join('\n');
    expect(rows).toContain('3 bundled · 2 enabled · 2 updates available');
    expect(rows).toContain('implement');
    expect(rows).toContain('effort');
    f.result.unmount();
  });

  it('↵ opens the focused child on the System stack and esc returns to the hub', async () => {
    const f = await mountHub(report(['pass']));
    expect(stripAnsi(f.lines()[1] ?? '')).toMatch(/^ {2}▣ System/);
    f.result.stdin.write(ENTER);
    await waitFor(() => expect(f.router().stack.map((e) => e.id)).toEqual(['system', 'settings']));
    expect(stripAnsi(f.lines()[1] ?? '')).toContain('▣ System › Settings');

    f.result.stdin.write(ESC);
    await waitFor(() => expect(f.router().stack.map((e) => e.id)).toEqual(['system']));
    expect(hubRows(f).length).toBe(3);
    f.result.unmount();
  });

  it('r re-runs the doctor probes', async () => {
    const f = await mountHub(report(['pass']));
    const before = reportRef.calls;
    f.result.stdin.write('r');
    await waitFor(() => expect(reportRef.calls).toBeGreaterThan(before));
    f.result.unmount();
  });

  it('shows `running checks…` before the first report', async () => {
    reportRef.current = undefined;
    const f = mountFrame({ columns: 100, rows: 24, deps: stubDeps(), initial: { id: 'system' } });
    await tick(100);
    expect(stripAnsi(f.result.lastFrame() ?? '')).toContain('running checks…');
    f.result.unmount();
  });
});
