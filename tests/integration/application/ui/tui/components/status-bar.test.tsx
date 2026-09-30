/**
 * Regression fence: `StatusBar`'s footer stethoscope indicator must never treat an `unknown`
 * doctor probe as a warning. `system-status-context.tsx` is the sole importer of the doctor
 * flow, so mocking it gives full control over the report without depending on which CLIs
 * happen to be on the test runner's PATH.
 */

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Result } from '@src/domain/result.ts';
import { StatusBar } from '@src/application/ui/tui/components/status-bar.tsx';
import { useSystemStatus } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { DoctorReport } from '@src/application/flows/doctor/ctx.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView, stripAnsi } from '@tests/integration/application/ui/tui/_harness.tsx';
import { renderAtSize } from '@tests/helpers/render-at-size.tsx';
import { StorageProvider } from '@src/application/ui/tui/runtime/storage-context.tsx';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import { DepsProvider } from '@src/application/ui/tui/runtime/deps-context.tsx';
import { SessionsProvider } from '@src/application/ui/tui/runtime/sessions-context.tsx';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { UiStateProvider, useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import { HintsProvider } from '@src/application/ui/tui/runtime/use-view-hints.tsx';
import { SelectionProvider } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { SystemStatusProvider } from '@src/application/ui/tui/runtime/system-status-context.tsx';
import { RouterProvider, useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import { useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';

const reportRef = vi.hoisted(() => ({ current: undefined as DoctorReport | undefined }));

vi.mock('@src/application/flows/doctor/flow.ts', () => ({
  createDoctorFlow: () => ({
    execute: async () => Result.ok({ ctx: { output: reportRef.current } }),
  }),
}));

const deps = {} as unknown as AppDeps;

/** StatusBar reads the doctor report passively — nothing triggers the initial fetch in tests, so
 * pull `refreshDoctor()` explicitly and render StatusBar underneath. */
const TriggerAndRender = (): React.JSX.Element => {
  const system = useSystemStatus();
  const refresh = system.refreshDoctor;
  React.useEffect(() => {
    void refresh();
  }, [refresh]);
  return <StatusBar />;
};

describe('StatusBar — doctor indicator', () => {
  it('stays green when every non-pass probe is unknown (never inflates the warning count)', async () => {
    reportRef.current = {
      probes: [
        { id: 'ai-claude-code', label: 'Claude Code', status: 'pass', group: 'ai' },
        {
          id: 'ai-auth-github-copilot',
          label: 'GitHub Copilot authenticated',
          status: 'unknown',
          group: 'ai',
          detail: 'no non-interactive auth-status verb',
        },
      ],
      allPassed: true,
      hasFailures: false,
    };
    const { result } = renderView(<TriggerAndRender />, { deps, initial: { id: 'home' } });
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('doctor ok'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('doctor ok');
    expect(frame).not.toContain('doctor warning');
    expect(frame).not.toContain('doctor failure');
  });

  it('still surfaces a warning when a probe genuinely warns', async () => {
    reportRef.current = {
      probes: [{ id: 'settings-persisted', label: 'Settings file present', status: 'warn', group: 'settings' }],
      allPassed: false,
      hasFailures: false,
    };
    const { result } = renderView(<TriggerAndRender />, { deps, initial: { id: 'home' } });
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('doctor warning'));
    expect(result.lastFrame() ?? '').toContain('1 doctor warning');
  });
});

/**
 * The footer strip is built from two groups — the view's own hints, then the curated global
 * tail — laid out as separate Boxes so Yoga squeezes only the global half on a narrow terminal.
 * They used to be divided by a bare space, which read as one hint run into the next
 * (`u unblock (3) esc back`, where `(3)` looks like the key for `esc`). Both groups separate
 * their own entries with `·`; the seam between them must use the same one.
 */
describe('StatusBar — hint group separator', () => {
  const HintsAndBar = (): React.JSX.Element => {
    useViewHints([{ keys: 'u', label: 'unblock (3)' }]);
    return <StatusBar />;
  };

  it('divides the view hints from the global tail with the bullet, not a bare space', async () => {
    reportRef.current = { probes: [], summary: 'ok' } as unknown as DoctorReport;
    const { result } = renderView(<HintsAndBar />, { deps, initial: { id: 'home' } });
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('unblock (3)'), {
      label: 'the view hint rendered',
    });

    // Assert only the seam. The global tail is deliberately squeezed at the harness's 100-column
    // width (that is the whole point of the two-group split), so its words clip — matching the
    // full `esc back` text would be asserting on the squeeze, not on the separator.
    const flat = stripAnsi(result.lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(flat).toContain('u unblock (3) ·');
    expect(flat).not.toMatch(/unblock \(3\) es/);
    result.unmount();
  });
});

/**
 * The footer is exactly one row at any width: a width-budgeted single `<Text>`, never per-hint
 * boxes that Yoga can squeeze mid-word. Driven through `renderAtSize` because the harness's
 * 100-column pin cannot prove 80.
 */
describe('StatusBar — one-row hint strip', () => {
  const localSet = [
    { keys: '↑/↓', label: 'move' },
    { keys: '↵', label: 'open' },
    { keys: 'b', label: 'browse' },
    { keys: 'u', label: 'unblock (3)' },
  ];
  const Bar = ({ prompt = false }: { prompt?: boolean }): React.JSX.Element => {
    useViewHints(localSet);
    const ui = useUiState();
    const claim = ui.claimPrompt;
    React.useEffect(() => (prompt ? claim() : undefined), [prompt, claim]);
    return <StatusBar />;
  };
  const mount = (columns: number, prompt: boolean, stackDepth = 2) => {
    reportRef.current = { probes: [], summary: 'ok' } as unknown as DoctorReport;
    const initial = { id: 'home' } as const;
    return renderAtSize(
      <DepsProvider value={deps}>
        <StorageProvider value={{} as unknown as StoragePaths}>
          <SessionsProvider value={createSessionManager()}>
            <UiStateProvider>
              <HintsProvider>
                <SelectionProvider>
                  <SystemStatusProvider>
                    <RouterProvider initial={initial}>
                      {(): React.ReactNode => (
                        <>
                          <PushTo depth={stackDepth} />
                          <Bar prompt={prompt} />
                        </>
                      )}
                    </RouterProvider>
                  </SystemStatusProvider>
                </SelectionProvider>
              </HintsProvider>
            </UiStateProvider>
          </SessionsProvider>
        </StorageProvider>
      </DepsProvider>,
      { columns, rows: 24 }
    );
  };
  const PushTo = ({ depth }: { depth: number }): null => {
    const router = useRouter();
    const push = router.push;
    const len = router.stack.length;
    React.useEffect(() => {
      if (len < depth) push({ id: 'flows' });
    }, [len, depth, push]);
    return null;
  };
  const hintRows = (frame: string): string[] => frame.split('\n').filter((l) => l.includes('move'));

  it.each([80, 100, 120])('renders the hint strip as one clean row at %i columns', async (columns) => {
    const r = mount(columns, false);
    await waitForPredicate(() => hintRows(r.lastFrame() ?? '').length > 0, { label: 'hints rendered' });
    const frame = stripAnsi(r.lastFrame() ?? '');
    const rows = hintRows(frame);
    expect(rows).toHaveLength(1);
    const row = rows[0] ?? '';
    expect(row).toContain('↵ open');
    expect(frame).not.toContain('es bac');
    expect(frame).not.toContain('hom ·');
    expect(row.trim().length).toBeLessThanOrEqual(columns);
    // Nothing spills onto a second hint row: the line after the strip is not a hint remnant.
    const after = frame.split('\n')[frame.split('\n').indexOf(row) + 1] ?? '';
    expect(after.trim()).toBe('');
    r.unmount();
  });

  it('shows only local hints and ctrl+c quit while a prompt holds the keyboard', async () => {
    const r = mount(100, true);
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('ctrl+c quit'), { label: 'prompt footer' });
    const frame = stripAnsi(r.lastFrame() ?? '');
    expect(frame).toContain('↵ open');
    expect(frame).not.toContain('h home');
    expect(frame).not.toContain('(press !)');
    r.unmount();
  });

  it('omits esc back at stack depth 1 and shows it deeper', async () => {
    const root = mount(120, false, 1);
    await waitForPredicate(() => (root.lastFrame() ?? '').includes('↵ open'), { label: 'root footer' });
    expect(stripAnsi(root.lastFrame() ?? '')).not.toContain('esc back');
    root.unmount();
    const deep = mount(120, false, 2);
    await waitForPredicate(() => stripAnsi(deep.lastFrame() ?? '').includes('esc back'), { label: 'deep footer' });
    deep.unmount();
  });
});
