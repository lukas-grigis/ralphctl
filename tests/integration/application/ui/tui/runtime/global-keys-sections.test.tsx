/**
 * Section navigation through the real chrome: the five digits, per-section stacks, `esc` climbing
 * one level (then to Work), the hidden accelerators, and every case where a digit must stay inert.
 * Views are stubbed (see `_app-frame.tsx`); the tab bar, location line, footer, key handler and
 * System hub are the production ones.
 */

import React from 'react';
import { Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import { CancelScopeOverlay } from '@src/application/ui/tui/components/cancel-scope-overlay.tsx';
import { ViewShell } from '@src/application/ui/tui/components/view-shell.tsx';
import { useUiState } from '@src/application/ui/tui/runtime/ui-state-context.tsx';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import { ENTER, ESC, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { mountFrame, StubView, type AppFrame } from '@tests/integration/application/ui/tui/_app-frame.tsx';
import { stripAnsi } from '@tests/integration/application/ui/tui/_harness.tsx';

const stubDeps = (): AppDeps =>
  ({
    eventBus: createInMemoryEventBus(),
    settingsRepo: { load: async () => Result.ok(DEFAULT_SETTINGS) },
    skillCatalog: { list: async () => Result.ok([]) },
    sprintRepo: { list: async () => Result.ok([]) },
    projectRepo: { list: async () => Result.ok([]) },
    taskRepo: { findBySprintId: async () => Result.ok([]) },
  }) as unknown as AppDeps;

const press = async (frame: AppFrame, keys: string): Promise<void> => {
  frame.result.stdin.write(keys);
  await tick(60);
};

/** Row 1 of the frame — the location line. */
const location = (frame: AppFrame): string => stripAnsi(frame.lines()[1] ?? '');

const mount = (over: { columns?: number; rows?: number; initial?: ViewEntry } = {}): AppFrame =>
  mountFrame({ columns: 100, rows: 30, deps: stubDeps(), ...over });

describe('section keys — navigation flow', () => {
  it('walks Work → System › Settings → Sprints → back, restoring stacks and climbing with esc', async () => {
    const f = mount();
    await tick(60);
    expect(location(f)).toMatch(/^ {2}▣ Work/);

    await press(f, '5');
    expect(location(f)).toMatch(/^ {2}▣ System/);
    expect(f.lines().join('\n')).toContain('Settings');

    // The hub's first row is Settings (no doctor warning in the stubbed environment).
    await press(f, ENTER);
    expect(location(f)).toContain('▣ System › Settings');

    await press(f, '2');
    expect(location(f)).toMatch(/^ {2}▣ Sprints/);

    await press(f, '5');
    expect(location(f)).toContain('▣ System › Settings');

    await press(f, ESC);
    expect(location(f)).toMatch(/^ {2}▣ System(?! ›)/);

    await press(f, ESC);
    expect(location(f)).toMatch(/^ {2}▣ Work/);
    f.result.unmount();
  });

  it("pressing the active section's digit resets it to its root", async () => {
    const f = mount();
    await press(f, '5');
    await press(f, ENTER);
    expect(f.router().stack.map((e) => e.id)).toEqual(['system', 'settings']);
    await press(f, '5');
    expect(f.router().stack.map((e) => e.id)).toEqual(['system']);
    f.result.unmount();
  });

  it('esc at the Work root does nothing', async () => {
    const f = mount();
    await press(f, ESC);
    expect(location(f)).toMatch(/^ {2}▣ Work/);
    expect(f.router().stack.map((e) => e.id)).toEqual(['home']);
    f.result.unmount();
  });
});

describe('hidden accelerators', () => {
  it('s → System › Settings, ! → System › Doctor, p → Projects, x → Runs, h → Work root, n → Work', async () => {
    const f = mount();
    await press(f, '2');
    expect(location(f)).toMatch(/^ {2}▣ Sprints/);

    await press(f, 's');
    expect(location(f)).toContain('▣ System › Settings');
    expect(f.router().stack.map((e) => e.id)).toEqual(['system', 'settings']);

    await press(f, '!');
    expect(location(f)).toContain('▣ System › Doctor');
    expect(f.router().stack.map((e) => e.id)).toEqual(['system', 'doctor']);

    await press(f, 'p');
    expect(location(f)).toMatch(/^ {2}▣ Projects/);
    expect(f.router().stack.map((e) => e.id)).toEqual(['projects']);

    await press(f, 'x');
    expect(location(f)).toMatch(/^ {2}▣ Runs/);

    await press(f, 'n');
    expect(location(f)).toMatch(/^ {2}▣ Work(?! ›)/);
    expect(f.router().stack.map((e) => e.id)).toEqual(['home']);
    expect(f.router().current.props).toEqual({ focus: 'flows' });

    await press(f, 'h');
    expect(location(f)).toMatch(/^ {2}▣ Work(?! ›)/);
    expect(f.router().stack.map((e) => e.id)).toEqual(['home']);
    f.result.unmount();
  });

  it('pressing an accelerator for the view you are already on does not grow the stack', async () => {
    const f = mount();
    await press(f, 's');
    await press(f, 's');
    expect(f.router().stack.map((e) => e.id)).toEqual(['system', 'settings']);
    f.result.unmount();
  });

  it('q quits only from the Work root', async () => {
    const f = mount();
    await press(f, '5');
    await press(f, 'q');
    // Still mounted and still in System — `q` did nothing off the Work root.
    expect(location(f)).toMatch(/^ {2}▣ System/);
    f.result.unmount();
  });
});

describe('digits stay inert', () => {
  it('while a prompt holds the keyboard', async () => {
    const Claimer = (): React.JSX.Element => {
      const ui = useUiState();
      const claim = ui.claimPrompt;
      React.useEffect(() => claim(), [claim]);
      return <StubView id="home" />;
    };
    const f = mountFrame({
      columns: 100,
      rows: 30,
      deps: stubDeps(),
      renderRoute: () => <Claimer />,
    });
    await tick(60);
    await press(f, '2');
    expect(location(f)).toMatch(/^ {2}▣ Work/);
    f.result.unmount();
  });

  it('while the help overlay is open', async () => {
    const f = mount();
    await press(f, '?');
    expect(stripAnsi(f.result.lastFrame() ?? '')).toContain('Keyboard reference');
    await press(f, '2');
    await press(f, '?');
    expect(location(f)).toMatch(/^ {2}▣ Work/);
    expect(f.router().activeSection).toBe('work');
    f.result.unmount();
  });

  it('while the switcher is open', async () => {
    const f = mount();
    await press(f, 'S');
    expect(stripAnsi(f.result.lastFrame() ?? '')).toContain('switch sprint or project');
    await press(f, '2');
    expect(f.router().activeSection).toBe('work');
    await press(f, ESC);
    expect(f.router().activeSection).toBe('work');
    f.result.unmount();
  });

  it('while the cancel-scope overlay claims 1 / 2', async () => {
    const onCancelFlow = vi.fn();
    const View = (): React.JSX.Element => (
      <ViewShell title="Implement">
        <CancelScopeOverlay
          attemptElapsedMs={1000}
          remainingTaskCount={2}
          onCancelAttempt={vi.fn()}
          onCancelFlow={onCancelFlow}
          onDismiss={vi.fn()}
        />
        <Text>overlay-open</Text>
      </ViewShell>
    );
    const f = mountFrame({ columns: 100, rows: 30, deps: stubDeps(), renderRoute: () => <View /> });
    await tick(60);
    await press(f, '2');
    // The overlay took the key; no section jump.
    expect(onCancelFlow).toHaveBeenCalledTimes(1);
    expect(f.router().activeSection).toBe('work');
    f.result.unmount();
  });
});

describe('Tab / Shift+Tab / Ctrl+1..9 land in Runs', () => {
  it('Tab from Work resets onto [sessions, execute] and esc climbs back to Work', async () => {
    const sessions = createSessionManager();
    const runner = {
      id: 'r-1',
      status: 'running',
      ctx: {},
      trace: [],
      subscribe: () => () => undefined,
      start: vi.fn(),
      abort: vi.fn(),
    } as unknown as Runner<unknown>;
    sessions.register({ runner, flowId: 'implement', title: 'Implement — demo' });
    const f = mountFrame({ columns: 100, rows: 30, deps: stubDeps(), sessions });
    await tick(60);
    await press(f, '\t');
    expect(f.router().activeSection).toBe('runs');
    expect(f.router().stack.map((e) => e.id)).toEqual(['sessions', 'execute']);
    expect(f.router().current.props).toEqual({ sessionId: 'r-1' });
    await press(f, ESC);
    expect(f.router().stack.map((e) => e.id)).toEqual(['sessions']);
    await press(f, ESC);
    expect(f.router().activeSection).toBe('work');
    f.result.unmount();
  });
});

describe('frame layout', () => {
  it('Work at 80x24: tab bar row 0, location row 1, rule row 2; bottom two rows are the rule and one hint row', async () => {
    const f = mount({ columns: 80, rows: 24 });
    await tick(80);
    const lines = f.lines().map(stripAnsi);
    expect(lines).toHaveLength(24);
    expect(lines[0]).toContain('[1 Work]');
    expect(lines[0]).toContain('5 System');
    expect(lines[1]).toMatch(/^ {2}▣ Work/);
    expect(lines[2]).toMatch(/^─+$/);
    expect(lines[22]).toMatch(/^─+$/);
    expect(lines[23]).toContain('? help');
    f.result.unmount();
  });

  it('first-run (section none) hides the tab bar and the location line', async () => {
    const f = mountFrame({
      columns: 80,
      rows: 24,
      deps: stubDeps(),
      initial: { id: 'welcome' },
    });
    await tick(80);
    const frame = stripAnsi(f.result.lastFrame() ?? '');
    expect(frame).not.toContain('1 Work');
    expect(frame).not.toContain('▣');
    expect(frame).toContain('view:welcome');
    f.result.unmount();
  });
});

describe('footer', () => {
  const footer = (f: AppFrame): string => stripAnsi(f.lines().at(-1) ?? '');

  it('never advertises the hidden accelerators on any section', async () => {
    const f = mount({ columns: 160, rows: 30 });
    for (const key of ['1', '2', '3', '4', '5']) {
      await press(f, key);
      for (const stale of ['h home', 'n new flow', 'x sessions', 's settings', 'P pick project']) {
        expect(footer(f), `${key}: ${stale}`).not.toContain(stale);
      }
      expect(footer(f)).toContain('? help');
    }
    f.result.unmount();
  });

  it('offers q quit only on the Work root, and 1–5 sections only from 140 columns', async () => {
    const wide = mount({ columns: 160, rows: 30 });
    await tick(60);
    expect(footer(wide)).toContain('q/ctrl+c quit');
    expect(footer(wide)).toContain('1–5 sections');
    await press(wide, '5');
    expect(footer(wide)).not.toContain('quit');
    expect(footer(wide)).toContain('esc work');
    wide.result.unmount();

    const narrow = mount({ columns: 100, rows: 30 });
    await tick(60);
    expect(footer(narrow)).toContain('q/ctrl+c quit');
    expect(footer(narrow)).not.toContain('1–5 sections');
    narrow.result.unmount();
  });
});
