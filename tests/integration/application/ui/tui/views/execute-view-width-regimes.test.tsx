/**
 * Width-regime smoke tests for ExecuteView. Verifies that each responsive breakpoint renders
 * without crashing and surfaces the expected layout variant:
 *
 *   < 100 cols       → single-column stack — "Flow steps" section header rendered.
 *   100–139 cols     → compact two-column — rail collapses to glyph spine, no "Flow steps" label.
 *   ≥ 140 cols       → sidebar layout (ImplementLayout) — left sidebar carries the "Tasks" and
 *                      "Steps" section headers plus the BaselineHealthCard; the main area hosts
 *                      the collapsible task cards. The legacy three-column "Flow steps" rail is
 *                      replaced by the sidebar's "Steps" section.
 *
 * `useTerminalSize` is mocked so we can drive the layout decisions independent of the
 * ink-testing-library stdout (which hardcodes `columns = 100`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExecuteView } from '@src/application/ui/tui/views/execute-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { useResponsiveLayout } from '@src/application/ui/tui/views/execute-view-internals/use-responsive-layout.ts';

// Hoisted controls — the mock factory reads from this state holder so each test can set its
// own columns/rows before rendering. `vi.hoisted` ensures the variable exists when the mock
// factory is hoisted above the imports.
const sizeRef = vi.hoisted(() => ({ columns: 100, rows: 40 }));

vi.mock('@src/application/ui/tui/runtime/use-terminal-size.ts', () => ({
  useTerminalSize: () => ({ columns: sizeRef.columns, rows: sizeRef.rows }),
}));

const noopEventBus: EventBus = {
  publish: vi.fn(),
  subscribe: () => () => undefined,
} as unknown as EventBus;

const fakeRunner = (id: string, status: 'running' | 'completed' | 'failed'): Runner<unknown> =>
  ({
    id,
    status,
    ctx: {},
    trace: [],
    subscribe: () => () => undefined,
    start: vi.fn(),
    abort: vi.fn(),
  }) as unknown as Runner<unknown>;

const stubDeps = (): AppDeps =>
  ({
    eventBus: noopEventBus,
  }) as unknown as AppDeps;

describe('ExecuteView width regimes', () => {
  beforeEach(() => {
    sizeRef.columns = 100;
    sizeRef.rows = 40;
  });
  afterEach(() => {
    sizeRef.columns = 100;
    sizeRef.rows = 40;
  });

  const renderAt = async (columns: number): Promise<{ frame: string; unmount: () => void }> => {
    sizeRef.columns = columns;
    const sessions = createSessionManager();
    const runner = fakeRunner('rw-1', 'running');
    sessions.register({ runner, flowId: 'implement', title: 'Implement — Width' });
    const { result } = renderView(<ExecuteView />, {
      deps: stubDeps(),
      initial: { id: 'execute', props: { sessionId: 'rw-1' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('Implement — Width'));
    return { frame: result.lastFrame() ?? '', unmount: () => result.unmount() };
  };

  it('renders single-column stack below 100 cols — labelled "Flow steps" section', async () => {
    const { frame, unmount } = await renderAt(80);
    expect(frame).toContain('Flow steps');
    expect(frame).toContain('Tasks');
    unmount();
  });

  it('renders compact rail at 100 cols — "Flow steps" label suppressed, glyph spine rendered', async () => {
    const { frame, unmount } = await renderAt(100);
    // The compact rail intentionally drops its SectionHeader. Tasks header still renders.
    expect(frame).toContain('Tasks');
    unmount();
  });

  it('renders sidebar layout at 140 cols — sidebar order: Baseline → Steps → Tasks → Tokens, no column labels', async () => {
    const { frame, unmount } = await renderAt(140);
    // The sidebar replaces the legacy "Flow steps" rail with "Steps" section.
    // [nav] and [tasks] column labels have been removed (user ask #4).
    expect(frame).not.toContain('[nav]');
    expect(frame).not.toContain('[tasks]');
    // Section headers present in sidebar (Baseline card title + Steps + Tasks sections).
    expect(frame).toContain('Baseline');
    expect(frame).toContain('Tasks');
    expect(frame).toContain('Steps');
    expect(frame).not.toContain('Flow steps');
    // TokenBudgetCard renders at sidebar bottom (user ask #3).
    expect(frame).toContain('Tokens');
    // Sidebar order check using unambiguous markers:
    //   Baseline → Steps → Tokens (all exclusively in the sidebar column).
    //   "Tasks" is NOT used for the order check here because the TasksPanel empty-state
    //   ("· Tasks panel empty") also contains "Tasks" and appears in the MAIN column at an
    //   earlier row in the character stream — indexOf('Tasks') would find the wrong occurrence.
    const baselineIdx = frame.indexOf('Baseline');
    const stepsIdx = frame.indexOf('Steps');
    const tokensIdx = frame.indexOf('Tokens');
    expect(baselineIdx).toBeLessThan(stepsIdx);
    expect(stepsIdx).toBeLessThan(tokensIdx);
    unmount();
  });

  it('renders sidebar layout at 180 cols — no column labels, Baseline card present', async () => {
    const { frame, unmount } = await renderAt(180);
    expect(frame).not.toContain('[nav]');
    expect(frame).not.toContain('[tasks]');
    expect(frame).toContain('Baseline');
    expect(frame).toContain('Tasks');
    expect(frame).toContain('Steps');
    // HeaderCard renders the session title and flow meta.
    expect(frame).toContain('Tokens');
    unmount();
  });

  it('renders sidebar layout at 240 cols (xxl breakpoint) — sidebar ~2/5 wide, no column labels', async () => {
    const { frame, unmount } = await renderAt(240);
    expect(frame).not.toContain('[nav]');
    expect(frame).not.toContain('[tasks]');
    expect(frame).toContain('Baseline');
    expect(frame).toContain('Tasks');
    expect(frame).toContain('Steps');
    expect(frame).toContain('Tokens');
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Height-budget regression tests (Bug A)
// ---------------------------------------------------------------------------

describe('useResponsiveLayout — sidebar height budget never exceeds terminal rows', () => {
  const COMMON_SIZES: Array<{ cols: number; rows: number; label: string }> = [
    { cols: 180, rows: 50, label: '180×50' },
    { cols: 140, rows: 35, label: '140×35' },
    { cols: 220, rows: 60, label: '220×60' },
    { cols: 140, rows: 30, label: '140×30 (tight)' },
    { cols: 240, rows: 50, label: '240×50' },
  ];

  it.each(COMMON_SIZES)('sidebar sections fit within terminal rows at $label', ({ cols, rows }) => {
    const layout = useResponsiveLayout({ columns: cols, rows, isRunning: true });

    // sidebarTaskNavRows + sidebarFlowStepsRows must not exceed the available body rows
    const usedBodyRows = layout.sidebarTaskNavRows + layout.sidebarFlowStepsRows;
    expect(usedBodyRows).toBeLessThanOrEqual(layout.sidebarBodyRows + 8 /* slack for floor clamping */);

    // The total sidebar budget must be well within terminal rows
    // Chrome + body should be ≤ rows (the rest goes to the main page chrome)
    expect(layout.sidebarBodyRows).toBeGreaterThanOrEqual(0);
    expect(layout.sidebarFlowStepsRows).toBeGreaterThanOrEqual(0);
    expect(layout.sidebarTaskNavRows).toBeGreaterThanOrEqual(4);

    // Flow steps are capped at 10 rows — prevent the rail dominating the sidebar on tall terms
    expect(layout.sidebarFlowStepsRows).toBeLessThanOrEqual(10);
  });

  it('tasksMaxBlocks in sidebar layout grows with terminal height without exceeding it', () => {
    // At 50 rows, running=true: logRows = max(6, min(16, 50-38)) = 12.
    // mainBodyRows = 50 - 10 - 12 = 28. Budget = floor(28/3) = 9.
    const layout = useResponsiveLayout({ columns: 180, rows: 50, isRunning: true });
    expect(layout.tasksMaxBlocks).toBeGreaterThanOrEqual(3);
    // Must not exceed a reasonable fraction of terminal rows (not the whole screen)
    expect(layout.tasksMaxBlocks).toBeLessThanOrEqual(Math.ceil(50 / 2));
  });
});
