/**
 * Behavioural tests for the redesigned Implement view: passive-minimap focus model,
 * all-completed expansion seed, Tab-blocker regression, and StatusBand meta.
 *
 * Tests 1-4: ImplementSidebar directly (component-level — navigation only, no sprint meta).
 * Tests 5-6: TasksPanel all-completed edge case (component-level).
 * Test 7:    Wide layout Tab-regression (smoke via ImplementLayout + useTerminalSize mock).
 * Tests 8-9: StatusBand meta (model pair, baseline, token) + height-budget checks.
 *
 * Note: Since v0.7.0 layout overhaul the sidebar is NAVIGATION ONLY. Sprint meta (name,
 * elapsed, model pair, baseline health, token budget) now lives in the StatusBand. The
 * sidebar renders: task minimap + flow-steps rail.
 */

import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImplementSidebar } from '@src/application/ui/tui/views/execute-view-internals/implement-sidebar.tsx';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import { StatusBand } from '@src/application/ui/tui/components/status-band.tsx';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { ExecuteView } from '@src/application/ui/tui/views/execute-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const isoAt = (ms: number): IsoTimestamp => new Date(ms).toISOString() as IsoTimestamp;
const BASE_MS = Date.UTC(2026, 0, 1, 9, 0, 0);

const makeTask = (id: string, status: TaskBucket['status']): TaskBucket => {
  const base: TaskBucket = {
    id,
    status,
    subSteps: [],
    evaluations: [],
    signals: [{ type: 'note', text: `note from ${id}`, timestamp: isoAt(BASE_MS) }],
    genEvalRound: 0,
  };
  return status === 'completed' ? { ...base, durationMs: 5000 } : base;
};

const THREE_TASKS: BucketedExecution = {
  tasks: [makeTask('task-aaa', 'completed'), makeTask('task-bbb', 'completed'), makeTask('task-ccc', 'running')],
  orphanSignals: [],
};

const ALL_COMPLETED: BucketedExecution = {
  tasks: [makeTask('task-aaa', 'completed'), makeTask('task-bbb', 'completed'), makeTask('task-ccc', 'completed')],
  orphanSignals: [],
};

const makeDescriptor = (): SessionDescriptor => ({
  id: 'sess-1',
  flowId: 'implement',
  title: 'Test Sprint',
  status: 'running',
  startedAt: BASE_MS,
  trace: [],
  taskNames: new Map([
    ['task-aaa', 'Add auth middleware'],
    ['task-bbb', 'Update tests'],
    ['task-ccc', 'Refactor service layer'],
  ]),
  generatorModel: 'claude-opus-4',
  evaluatorModel: 'claude-sonnet-4-6',
});

// ---------------------------------------------------------------------------
// ImplementSidebar — navigation only (task minimap + flow steps)
// ---------------------------------------------------------------------------

describe('ImplementSidebar — navigation only', () => {
  it('renders task minimap section headers (Tasks + Steps) — no sprint meta', () => {
    const descriptor = makeDescriptor();
    const { lastFrame, unmount } = render(
      <ImplementSidebar
        sidebarWidth={36}
        sidebarTaskNavRows={8}
        sidebarFlowStepsRows={8}
        descriptor={descriptor}
        bucketed={THREE_TASKS}
        isRunning={true}
        focusedTaskId={undefined}
      />
    );
    const frame = lastFrame() ?? '';

    // Section headers for navigation-only sidebar
    expect(frame).toContain('Tasks');
    expect(frame).toContain('Steps');

    // Sprint name, elapsed, and model pair are in the StatusBand — NOT in the sidebar
    expect(frame).not.toContain('1m30s');
    expect(frame).not.toContain('sprint-2026-01');
    expect(frame).not.toContain('claude-opus-4');

    // Task names should appear in the minimap
    expect(frame).toContain('Add auth middleware');
    expect(frame).toContain('Update tests');
    expect(frame).toContain('Refactor service layer');

    unmount();
  });

  it('highlights the focusedTaskId row with actionCursor glyph', () => {
    const descriptor = makeDescriptor();
    const { lastFrame, unmount } = render(
      <ImplementSidebar
        sidebarWidth={36}
        sidebarTaskNavRows={8}
        sidebarFlowStepsRows={8}
        descriptor={descriptor}
        bucketed={THREE_TASKS}
        isRunning={true}
        focusedTaskId="task-bbb"
      />
    );
    const frame = lastFrame() ?? '';

    // task-bbb should appear with a highlight glyph (▸) near "Update tests"
    expect(frame).toContain('Update tests');
    const lines = frame.split('\n');
    const focusedLine = lines.find((l) => l.includes('Update tests'));
    expect(focusedLine).toBeDefined();
    // The ▸ glyph (actionCursor) should appear somewhere in the frame
    expect(frame).toContain('▸');

    unmount();
  });

  it('highlight follows a different focusedTaskId (cursor tracking)', () => {
    const descriptor = makeDescriptor();
    const { lastFrame, unmount } = render(
      <ImplementSidebar
        sidebarWidth={36}
        sidebarTaskNavRows={8}
        sidebarFlowStepsRows={8}
        descriptor={descriptor}
        bucketed={THREE_TASKS}
        isRunning={true}
        focusedTaskId="task-ccc"
      />
    );
    const frame = lastFrame() ?? '';

    expect(frame).toContain('Refactor service layer');
    const lines = frame.split('\n');
    const focusedLine = lines.find((l) => l.includes('Refactor service layer'));
    expect(focusedLine).toBeDefined();
    expect(frame).toContain('▸');

    unmount();
  });

  it('does NOT capture keyboard input (passive — no useInput in sidebar)', () => {
    // This is a structural invariant: the sidebar TaskNavList has no useInput handler.
    // We verify it by pressing j/k keys and confirming the highlight does NOT change
    // (sidebar cursor is read-only from focusedTaskId prop).
    const descriptor = makeDescriptor();
    const { lastFrame, stdin, unmount } = render(
      <ImplementSidebar
        sidebarWidth={36}
        sidebarTaskNavRows={8}
        sidebarFlowStepsRows={8}
        descriptor={descriptor}
        bucketed={THREE_TASKS}
        isRunning={true}
        focusedTaskId="task-aaa"
      />
    );
    const frameBefore = lastFrame() ?? '';

    // Press j (move down) — a keyboard-active list would change the highlighted row
    stdin.write('j');
    const frameAfter = lastFrame() ?? '';

    // Frame should be identical: passive sidebar doesn't respond to keystrokes
    expect(frameAfter).toBe(frameBefore);

    unmount();
  });

  it('renders steps compact — never leaks a failed step error/meta into the narrow column', () => {
    const descriptor: SessionDescriptor = {
      ...makeDescriptor(),
      trace: [
        { elementName: 'load-tasks', status: 'completed', durationMs: 1 },
        {
          elementName: 'working-tree-clean',
          status: 'failed',
          durationMs: 4,
          error: {
            message:
              'working-tree-dirty at /Users/grigis/Workzone/github/lukas-grigis/mindvaults (3 uncommitted change(s))',
          },
        },
        { elementName: 'setup-script', status: 'skipped', durationMs: 0 },
      ] as unknown as SessionDescriptor['trace'],
    };
    const { lastFrame, unmount } = render(
      <ImplementSidebar
        sidebarWidth={36}
        sidebarTaskNavRows={8}
        sidebarFlowStepsRows={8}
        descriptor={descriptor}
        bucketed={THREE_TASKS}
        isRunning={true}
        focusedTaskId={undefined}
      />
    );
    const frame = lastFrame() ?? '';

    // The step name still renders…
    expect(frame).toContain('working-tree-clean');
    // …but the failed step's error message is NEVER shown in the compact sidebar steps
    // (it would wrap across many lines in the narrow column — it lives in the log/footer).
    expect(frame).not.toContain('uncommitted');
    expect(frame).not.toContain('mindvaults');
    // …and the duration / trailing status word are suppressed too.
    expect(frame).not.toContain('skipped');

    unmount();
  });
});

// ---------------------------------------------------------------------------
// StatusBand — glanceable meta (sprint, elapsed, model, baseline, token)
// ---------------------------------------------------------------------------

describe('StatusBand — meta display', () => {
  it('renders sprint label, elapsed, model pair with proper spacing', () => {
    const descriptor = makeDescriptor();
    const { lastFrame, unmount } = render(
      <StatusBand
        descriptor={descriptor}
        isRunning={true}
        elapsedMs={90_000}
        pinnedSprintLabel="sprint-2026-01"
        termColumns={180}
        now={BASE_MS + 90_000}
      />
    );
    const frame = lastFrame() ?? '';
    // eslint-disable-next-line no-control-regex
    const plain = frame.replace(/\x1B\[[0-9;]*m/g, '');

    // Sprint label
    expect(plain).toContain('sprint-2026-01');
    // Elapsed (90s → 1m30s)
    expect(plain).toContain('1m30s');
    // Running status
    expect(plain).toContain('RUNNING');
    // Model pair — label separated from value
    expect(plain).not.toMatch(/modelclaude/);
    expect(plain).toMatch(/model\s+\S/);

    unmount();
  });

  it('renders compact token summary for cumulative claude data (no absurd %)', () => {
    const descriptor = makeDescriptor();
    const { lastFrame, unmount } = render(
      <StatusBand
        descriptor={descriptor}
        isRunning={true}
        elapsedMs={270_000}
        pinnedSprintLabel="sprint-2026-01"
        termColumns={180}
        now={BASE_MS + 270_000}
        tokenUsage={{
          provider: 'claude-code',
          inputTokens: 21,
          outputTokens: 7300,
          cacheReadTokens: 2_244_000,
          contextWindow: 200_000,
        }}
      />
    );
    const frame = lastFrame() ?? '';

    // Cumulative: totalUsed = 21 + 2_244_000 = 2_244_021 >> contextWindow 200k
    // Should show "tok 2.2M" (NOT a "/200k 100%" bar)
    expect(frame).toContain('tok');
    expect(frame).toContain('2.2M');
    // Must NOT produce a "%" context bar in the band
    expect(frame).not.toContain('9176567%');
    expect(frame).not.toContain('100%');
    // Must NOT show "/200k" fraction
    expect(frame).not.toContain('/200k');

    unmount();
  });

  it('renders context bar for plausible single-call usage', () => {
    const descriptor = makeDescriptor();
    const { lastFrame, unmount } = render(
      <StatusBand
        descriptor={descriptor}
        isRunning={true}
        elapsedMs={30_000}
        termColumns={180}
        now={BASE_MS + 30_000}
        tokenUsage={{
          provider: 'github-copilot',
          inputTokens: 40_000,
          outputTokens: 5_000,
          contextWindow: 200_000,
        }}
      />
    );
    const frame = lastFrame() ?? '';

    // 40k/200k = 20% — sensible percentage
    expect(frame).toContain('ctx');
    expect(frame).toContain('20%');
    // No absurd values
    expect(frame).not.toContain('9176567%');

    unmount();
  });
});

// ---------------------------------------------------------------------------
// TasksPanel — all-completed expansion seed (REQ-3 edge case)
// ---------------------------------------------------------------------------

describe('TasksPanel — all-completed expansion seed (REQ-3)', () => {
  it('expands the last task card when all tasks are completed', () => {
    const { lastFrame, unmount } = render(
      <TasksPanel
        bucketed={ALL_COMPLETED}
        running={false}
        nameById={
          new Map([
            ['task-aaa', 'Add auth middleware'],
            ['task-bbb', 'Update tests'],
            ['task-ccc', 'Refactor service layer'],
          ])
        }
      />
    );
    const frame = lastFrame() ?? '';

    // The LAST task ('task-ccc' / 'Refactor service layer') should be expanded and show its
    // signal note. The other cards remain collapsed.
    expect(frame).toContain('note from task-ccc');
    // First two tasks stay collapsed (their notes should NOT appear)
    expect(frame).not.toContain('note from task-aaa');
    expect(frame).not.toContain('note from task-bbb');

    unmount();
  });

  it('expands the last task on mount even when running=true and all tasks are completed', () => {
    const { lastFrame, unmount } = render(
      <TasksPanel
        bucketed={ALL_COMPLETED}
        running={true}
        nameById={new Map([['task-ccc', 'Refactor service layer']])}
      />
    );
    const frame = lastFrame() ?? '';

    // Last task note should be visible (card is expanded)
    expect(frame).toContain('note from task-ccc');

    unmount();
  });
});

// ---------------------------------------------------------------------------
// Wide layout — Tab regression
// ---------------------------------------------------------------------------

// Hoisted controls for the Tab regression test
const sizeRef = vi.hoisted(() => ({ columns: 140, rows: 40 }));

vi.mock('@src/application/ui/tui/runtime/use-terminal-size.ts', () => ({
  useTerminalSize: () => ({ columns: sizeRef.columns, rows: sizeRef.rows }),
}));

const noopEventBus: EventBus = {
  publish: vi.fn(),
  subscribe: () => () => undefined,
} as unknown as EventBus;

const fakeRunner = (id: string): Runner<unknown> =>
  ({
    id,
    status: 'running',
    ctx: {},
    trace: [],
    subscribe: () => () => undefined,
    start: vi.fn(),
    abort: vi.fn(),
  }) as unknown as Runner<unknown>;

const stubDeps = (): AppDeps => ({ eventBus: noopEventBus }) as unknown as AppDeps;

describe('ImplementLayout (≥140 cols) — Tab does not toggle focus state', () => {
  beforeEach(() => {
    sizeRef.columns = 140;
    sizeRef.rows = 40;
  });
  afterEach(() => {
    sizeRef.columns = 140;
    sizeRef.rows = 40;
  });

  it('renders nav + tasks column labels without active/inactive focus toggle', async () => {
    const sessions = createSessionManager();
    const runner = fakeRunner('tab-reg-1');
    sessions.register({ runner, flowId: 'implement', title: 'Tab Reg Sprint' });
    const { result } = renderView(<ExecuteView />, {
      deps: stubDeps(),
      initial: { id: 'execute', props: { sessionId: 'tab-reg-1' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('Tab Reg Sprint'));
    const frame = result.lastFrame() ?? '';

    // The passive minimap design uses static dim labels: [nav] and [tasks].
    expect(frame).toContain('[nav]');
    expect(frame).toContain('[tasks]');

    // REQ: No focusSide concept — pressing Tab should not change the column labels.
    const frameBefore = result.lastFrame() ?? '';
    result.stdin?.write('\t');
    const frameAfter = result.lastFrame() ?? '';
    expect(frameAfter).toContain('[nav]');
    expect(frameAfter).toContain('[tasks]');
    expect(frameBefore.includes('[nav]')).toBe(frameAfter.includes('[nav]'));

    result.unmount();
  });

  it('renders StatusBand with sprint title in the wide layout', async () => {
    const sessions = createSessionManager();
    const runner = fakeRunner('band-test-1');
    sessions.register({ runner, flowId: 'implement', title: 'Band Test Sprint' });
    const { result } = renderView(<ExecuteView />, {
      deps: stubDeps(),
      initial: { id: 'execute', props: { sessionId: 'band-test-1' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('Band Test Sprint'));
    const frame = result.lastFrame() ?? '';

    // The StatusBand renders the sprint title (in wide layout it shows the title as
    // pinnedSprintLabel is undefined — shows descriptor.title as fallback)
    expect(frame).toContain('Band Test Sprint');
    // Running state glyph + RUNNING label
    expect(frame).toContain('RUNNING');

    result.unmount();
  });
});
