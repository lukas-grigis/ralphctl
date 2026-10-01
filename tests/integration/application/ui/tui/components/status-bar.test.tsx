/**
 * StatusBar — the footer: a rule and one hint row. Doctor health and the running-session count
 * moved to the tab bar (see `tab-bar.test.tsx`); what remains is the hint strip, which carries the
 * view's own keys followed by the globals derived from where the operator is (`esc <parent>`,
 * `? help`, `q quit` on the Work root) — never the hidden single-letter accelerators.
 */

import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { Result } from '@src/domain/result.ts';
import { StatusBar } from '@src/application/ui/tui/components/status-bar.tsx';
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
import { usePromptHints, useViewHints } from '@src/application/ui/tui/runtime/use-view-hints.tsx';

const reportRef = vi.hoisted(() => ({ current: undefined as DoctorReport | undefined }));

vi.mock('@src/application/flows/doctor/flow.ts', () => ({
  createDoctorFlow: () => ({
    execute: async () => Result.ok({ ctx: { output: reportRef.current } }),
  }),
}));

const deps = {} as unknown as AppDeps;

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
    expect(flat).toContain('u unblock (3) · ? help');
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
  const mount = (columns: number, prompt: boolean, stackDepth = 2, extra: React.ReactNode = null) => {
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
                          {extra}
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
    expect(row).toContain('? help');
    // The hidden accelerators are never advertised.
    for (const stale of ['h home', 'n new flow', 'x sessions', 's settings', 'P pick project']) {
      expect(frame).not.toContain(stale);
    }
    expect(row.trim().length).toBeLessThanOrEqual(columns);
    // Nothing spills onto a second hint row: the line after the strip is not a hint remnant.
    const after = frame.split('\n')[frame.split('\n').indexOf(row) + 1] ?? '';
    expect(after.trim()).toBe('');
    r.unmount();
  });

  it('shows only ctrl+c quit while a prompt holds the keyboard — the view keys are muted', async () => {
    const r = mount(100, true);
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('ctrl+c quit'), { label: 'prompt footer' });
    const frame = stripAnsi(r.lastFrame() ?? '');
    expect(frame).not.toContain('↵ open');
    expect(frame).not.toContain('? help');
    expect(frame).not.toContain('(press !)');
    r.unmount();
  });

  it("shows the prompt's own keys, then ctrl+c quit, while a prompt holds the keyboard", async () => {
    const Prompt = (): null => {
      usePromptHints([
        { keys: '↵', label: 'submit' },
        { keys: 'y/n', label: 'quick' },
        { keys: 'esc', label: 'cancel' },
      ]);
      return null;
    };
    const r = mount(80, true, 2, <Prompt />);
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('y/n quick'), { label: 'prompt keys' });
    const frame = stripAnsi(r.lastFrame() ?? '');
    expect(frame).toContain('↵ submit · y/n quick · esc cancel · ctrl+c quit');
    expect(frame).not.toContain('↵ open');
    r.unmount();
  });

  it('drops `esc <parent>` while something local claims esc (an expanded card, an overlay)', async () => {
    const Claim = (): null => {
      const claim = useUiState().claimEscape;
      React.useEffect(() => claim(), [claim]);
      return null;
    };
    const r = mount(120, false, 2, <Claim />);
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('↵ open'), { label: 'footer' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(stripAnsi(r.lastFrame() ?? '')).not.toContain('esc Work');
    r.unmount();
  });

  it('omits esc at the Work root (and offers q quit there), and names the parent deeper', async () => {
    const root = mount(120, false, 1);
    await waitForPredicate(() => (root.lastFrame() ?? '').includes('↵ open'), { label: 'root footer' });
    const rootFrame = stripAnsi(root.lastFrame() ?? '');
    expect(rootFrame).not.toContain('esc ');
    expect(rootFrame).toContain('q/ctrl+c quit');
    root.unmount();
    const deep = mount(120, false, 2);
    await waitForPredicate(() => stripAnsi(deep.lastFrame() ?? '').includes('esc Work'), { label: 'deep footer' });
    expect(stripAnsi(deep.lastFrame() ?? '')).not.toContain('quit');
    deep.unmount();
  });

  it('adds `1–5 sections` only from 140 columns', async () => {
    const narrow = mount(120, false, 1);
    await waitForPredicate(() => (narrow.lastFrame() ?? '').includes('↵ open'), { label: 'narrow footer' });
    expect(stripAnsi(narrow.lastFrame() ?? '')).not.toContain('1–5 sections');
    narrow.unmount();
    const wide = mount(160, false, 1);
    await waitForPredicate(() => stripAnsi(wide.lastFrame() ?? '').includes('1–5 sections'), {
      label: 'wide footer',
    });
    wide.unmount();
  });

  it('is exactly a rule and one hint row', async () => {
    const r = mount(100, false, 1);
    await waitForPredicate(() => (r.lastFrame() ?? '').includes('↵ open'), { label: 'footer' });
    const lines = stripAnsi(r.lastFrame() ?? '')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^─+$/);
    r.unmount();
  });
});
