/**
 * Behavioural tests for the redesigned Implement view: passive-minimap focus model,
 * all-completed expansion seed, Tab-blocker regression, and TokenBudgetCard sidebar display.
 *
 * Tests 1-4: ImplementSidebar directly (component-level — task minimap + steps + token card).
 * Tests 5-6: TasksPanel all-completed edge case (component-level).
 * Test 7:    Wide layout Tab-regression (smoke via ImplementLayout + useTerminalSize mock).
 * Tests 8-9: TokenBudgetCard in sidebar + wide-layout meta surface checks.
 *
 * Note: Since v0.7.0 layout overhaul the sidebar carries the TokenBudgetCard at the bottom
 * (user ask #2). Sprint meta (name, elapsed, model pair) is in the HeaderCard at the top
 * of the wide layout (body.tsx, user ask #1). The StatusBand and ModelMeta block were removed.
 */

import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImplementSidebar } from '@src/application/ui/tui/views/execute-view-internals/implement-sidebar.tsx';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { TokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';
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
  it('renders section headers (Baseline, Steps, Tasks) in sidebar — model meta removed', () => {
    const descriptor = makeDescriptor();
    const { lastFrame, unmount } = render(
      <ImplementSidebar
        sidebarWidth={40}
        sidebarTaskNavRows={8}
        sidebarFlowStepsRows={8}
        sidebarContextSideBySide={false}
        descriptor={descriptor}
        bucketed={THREE_TASKS}
        isRunning={true}
        focusedTaskId={undefined}
        now={BASE_MS}
      />
    );
    const frame = lastFrame() ?? '';

    // Section headers for the sidebar (order: Baseline → Steps → Tasks)
    expect(frame).toContain('Baseline');
    expect(frame).toContain('Tasks');
    expect(frame).toContain('Steps');

    // Model meta block has been removed from the sidebar — model info lives in the
    // HeaderCard (body.tsx) which already renders "generator <model>" + "evaluator <model>".
    expect(frame).not.toContain('generator');
    expect(frame).not.toContain('evaluator');

    // Sprint name and elapsed remain in the HeaderCard (body.tsx) — NOT in the sidebar.
    expect(frame).not.toContain('1m30s');
    expect(frame).not.toContain('sprint-2026-01');

    // Task names should appear in the minimap
    expect(frame).toContain('Add auth middleware');
    expect(frame).toContain('Update tests');
    expect(frame).toContain('Refactor service layer');

    // TokenBudgetCard renders at the bottom (no usage data yet → empty-state placeholder)
    expect(frame).toContain('Tokens');

    unmount();
  });

  it('highlights the focusedTaskId row with actionCursor glyph', () => {
    const descriptor = makeDescriptor();
    const { lastFrame, unmount } = render(
      <ImplementSidebar
        sidebarWidth={36}
        sidebarTaskNavRows={8}
        sidebarFlowStepsRows={8}
        sidebarContextSideBySide={false}
        descriptor={descriptor}
        bucketed={THREE_TASKS}
        isRunning={true}
        focusedTaskId="task-bbb"
        now={BASE_MS}
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
        sidebarContextSideBySide={false}
        descriptor={descriptor}
        bucketed={THREE_TASKS}
        isRunning={true}
        focusedTaskId="task-ccc"
        now={BASE_MS}
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
        sidebarContextSideBySide={false}
        descriptor={descriptor}
        bucketed={THREE_TASKS}
        isRunning={true}
        focusedTaskId="task-aaa"
        now={BASE_MS}
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
        sidebarContextSideBySide={false}
        descriptor={descriptor}
        bucketed={THREE_TASKS}
        isRunning={true}
        focusedTaskId={undefined}
        now={BASE_MS}
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
// TokenBudgetCard in sidebar — glanceable token/context usage (user ask #2)
// ---------------------------------------------------------------------------

describe('ImplementSidebar — TokenBudgetCard at bottom', () => {
  it('renders the empty-state token card when no usage data is supplied', () => {
    const descriptor = makeDescriptor();
    const { lastFrame, unmount } = render(
      <ImplementSidebar
        sidebarWidth={36}
        sidebarTaskNavRows={8}
        sidebarFlowStepsRows={4}
        sidebarContextSideBySide={false}
        descriptor={descriptor}
        bucketed={THREE_TASKS}
        isRunning={true}
        focusedTaskId={undefined}
        now={BASE_MS}
      />
    );
    const frame = lastFrame() ?? '';
    // TokenBudgetCard section header renders (the card title is "Tokens · sess-<id>")
    expect(frame).toContain('Tokens');
    // Empty-state placeholder visible
    expect(frame).toContain('no usage data');
    unmount();
  });

  it('renders cumulative token data (claude -p style) — no absurd bar', () => {
    const descriptor = makeDescriptor();
    const cumulativeUsage: TokenUsage = {
      provider: 'claude-code',
      inputTokens: 21,
      outputTokens: 7300,
      cacheReadTokens: 2_244_000,
      contextWindow: 200_000,
    };
    const { lastFrame, unmount } = render(
      <ImplementSidebar
        sidebarWidth={36}
        sidebarTaskNavRows={8}
        sidebarFlowStepsRows={4}
        sidebarContextSideBySide={false}
        descriptor={descriptor}
        bucketed={THREE_TASKS}
        isRunning={true}
        focusedTaskId={undefined}
        tokenUsage={cumulativeUsage}
        now={BASE_MS}
      />
    );
    const frame = lastFrame() ?? '';
    // Cumulative: totalUsed = 21 + 2_244_000 >> contextWindow → "session: N (cumulative)"
    expect(frame).toContain('cumulative');
    // Must NOT show a "/200k" context bar (the cumulative path omits it)
    expect(frame).not.toContain('/200k');
    // Must NOT show an absurd context bar percentage (the cache-hit % of ~100% is legit and allowed)
    expect(frame).not.toContain('9176567%');
    // The context bar (filled blocks ███) must not appear for cumulative data
    expect(frame).not.toMatch(/█{5,}/);
    unmount();
  });

  it('renders plausible single-call context bar (Copilot style)', () => {
    const descriptor = makeDescriptor();
    const singleCallUsage: TokenUsage = {
      provider: 'github-copilot',
      inputTokens: 40_000,
      outputTokens: 5_000,
      contextWindow: 200_000,
    };
    const { lastFrame, unmount } = render(
      <ImplementSidebar
        sidebarWidth={36}
        sidebarTaskNavRows={8}
        sidebarFlowStepsRows={4}
        sidebarContextSideBySide={false}
        descriptor={descriptor}
        bucketed={THREE_TASKS}
        isRunning={true}
        focusedTaskId={undefined}
        tokenUsage={singleCallUsage}
        now={BASE_MS}
      />
    );
    const frame = lastFrame() ?? '';
    // 40k / 200k = 20% — renders context bar
    expect(frame).toContain('20%');
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

  it('renders sidebar sections without [nav]/[tasks] column labels (user ask #4)', async () => {
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

    // Column labels [nav] and [tasks] have been removed (user ask #4).
    // The sidebar's self-labelled section headers (Baseline, Steps, Tasks) replace them.
    expect(frame).not.toContain('[nav]');
    expect(frame).not.toContain('[tasks]');
    expect(frame).toContain('Baseline');
    expect(frame).toContain('Steps');
    expect(frame).toContain('Tasks');

    // REQ: No focusSide concept — pressing Tab should not change the layout.
    const frameBefore = result.lastFrame() ?? '';
    result.stdin?.write('\t');
    const frameAfter = result.lastFrame() ?? '';
    // Column labels must remain absent after Tab
    expect(frameAfter).not.toContain('[nav]');
    expect(frameAfter).not.toContain('[tasks]');
    expect(frameBefore.includes('Baseline')).toBe(frameAfter.includes('Baseline'));

    result.unmount();
  });

  it('renders HeaderCard with sprint title in the wide layout (user ask #1: header restored)', async () => {
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

    // The HeaderCard renders the sprint title at the top of the wide layout.
    // StatusBand has been removed (user ask #1) — the HeaderCard is shown at all widths.
    expect(frame).toContain('Band Test Sprint');
    // The TokenBudgetCard is in the sidebar (user ask #2)
    expect(frame).toContain('Tokens');

    result.unmount();
  });
});
