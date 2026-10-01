/**
 * TabBar — row 0. Badges read the session list and the shared system status; the active tab stays
 * distinguishable with colour off because it is wrapped in `[ ]`.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { TabBar } from '@src/application/ui/tui/components/tab-bar.tsx';
import { renderAtSize } from '@tests/helpers/render-at-size.tsx';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { StorageProvider } from '@src/application/ui/tui/runtime/storage-context.tsx';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { DoctorReport } from '@src/application/flows/doctor/ctx.ts';
import { SessionsProvider } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { RouterProvider } from '@src/application/ui/tui/runtime/router.tsx';
import { SystemStatusProvider, useSystemStatus } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';

const reportRef = vi.hoisted(() => ({ current: undefined as DoctorReport | undefined }));

vi.mock('@src/application/flows/doctor/flow.ts', () => ({
  createDoctorFlow: () => ({
    execute: async () => Result.ok({ ctx: { output: reportRef.current } }),
  }),
}));

const deps = {} as unknown as AppDeps;

const Refresh = (): null => {
  const { refreshDoctor } = useSystemStatus();
  React.useEffect(() => {
    void refreshDoctor();
  }, [refreshDoctor]);
  return null;
};

const mount = (columns: number, initial: 'home' | 'welcome' | 'system' = 'home'): ReturnType<typeof renderAtSize> =>
  renderAtSize(
    <DepsProvider value={deps}>
      <StorageProvider value={{} as unknown as StoragePaths}>
        <SessionsProvider value={createSessionManager()}>
          <SystemStatusProvider>
            <RouterProvider initial={{ id: initial }}>
              {() => (
                <>
                  <Refresh />
                  <TabBar />
                </>
              )}
            </RouterProvider>
          </SystemStatusProvider>
        </SessionsProvider>
      </StorageProvider>
    </DepsProvider>,
    { columns, rows: 24 }
  );

const probes = (statuses: ReadonlyArray<'pass' | 'warn' | 'fail' | 'unknown'>): DoctorReport => ({
  probes: statuses.map((status, i) => ({ id: `p${String(i)}`, label: `probe ${String(i)}`, status })),
  allPassed: statuses.every((s) => s === 'pass' || s === 'unknown'),
  hasFailures: statuses.includes('fail'),
});

afterEach(() => {
  delete process.env['NO_COLOR'];
});

describe('TabBar', () => {
  it('renders all five tabs on row 0 with the active one in [ ]', async () => {
    reportRef.current = probes(['pass']);
    const r = mount(80);
    await tick(60);
    const frame = r.lastFrame() ?? '';
    expect(frame.split('\n')).toHaveLength(1);
    for (const label of ['1 Work', '2 Sprints', '3 Projects', '4 Runs', '5 System']) expect(frame).toContain(label);
    expect(frame).toContain('[1 Work]');
    expect(frame).toContain('? help');
    r.unmount();
  });

  it('keeps the active tab distinguishable with NO_COLOR set', async () => {
    process.env['NO_COLOR'] = '1';
    reportRef.current = probes(['pass']);
    const r = mount(100, 'system');
    await tick(60);
    const frame = r.lastFrame() ?? '';
    // eslint-disable-next-line no-control-regex
    expect(frame).not.toMatch(/\x1b\[[0-9;]*m/);
    expect(frame).toContain('[5 System]');
    expect(frame).not.toContain('[1 Work]');
    r.unmount();
  });

  it('shows a compact system badge below 140 columns and a verbose one from 140', async () => {
    reportRef.current = probes(['pass', 'warn', 'warn']);
    const narrow = mount(100);
    await tick(80);
    expect(narrow.lastFrame() ?? '').toContain('5 System ✚2');
    narrow.unmount();

    const wide = mount(160);
    await tick(80);
    expect(wide.lastFrame() ?? '').toContain('✚ 2 warnings');
    expect(wide.lastFrame() ?? '').toMatch(/\? help · v\d/);
    wide.unmount();
  });

  it('reports failures over warnings, and shows no badge when everything passes (unknown is neutral)', async () => {
    reportRef.current = probes(['fail', 'warn']);
    const failing = mount(160);
    await tick(80);
    expect(failing.lastFrame() ?? '').toContain('✚ 1 failing');
    failing.unmount();

    reportRef.current = probes(['pass', 'unknown']);
    const clean = mount(160);
    await tick(80);
    expect(clean.lastFrame() ?? '').not.toContain('✚');
    clean.unmount();
  });

  it('is hidden while no section is active', async () => {
    reportRef.current = probes(['pass']);
    const r = mount(100, 'welcome');
    await tick(60);
    expect((r.lastFrame() ?? '').trim()).toBe('');
    r.unmount();
  });
});
