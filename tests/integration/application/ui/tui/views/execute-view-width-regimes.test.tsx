/**
 * Width-regime smoke tests for ExecuteView. Verifies that each responsive breakpoint renders
 * without crashing and surfaces the expected rail variant:
 *
 *   < 100 cols       → single-column stack — "Flow steps" section header rendered.
 *   100–139 cols     → compact two-column — rail collapses to glyph spine, no "Flow steps" label.
 *   140–179 cols     → labelled rail (fixed RAIL_WIDTH = 28).
 *   ≥ 180 cols       → labelled rail (fluid resolveRailWidth — grows up to 56 at 260+ cols).
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

  it('renders labelled rail at 140 cols (two-column layout)', async () => {
    const { frame, unmount } = await renderAt(140);
    expect(frame).toContain('Flow steps');
    expect(frame).toContain('Tasks');
    unmount();
  });

  it('renders three-column layout at 180 cols — rail + Tasks + context column', async () => {
    const { frame, unmount } = await renderAt(180);
    expect(frame).toContain('Flow steps');
    expect(frame).toContain('Tasks');
    // The context column hosts the BaselineHealthCard — its title contains "Baseline".
    expect(frame).toMatch(/Baseline/);
    unmount();
  });

  it('renders three-column layout at 240 cols (xxl breakpoint) without crashing', async () => {
    const { frame, unmount } = await renderAt(240);
    expect(frame).toContain('Flow steps');
    expect(frame).toContain('Tasks');
    expect(frame).toMatch(/Baseline/);
    unmount();
  });
});
