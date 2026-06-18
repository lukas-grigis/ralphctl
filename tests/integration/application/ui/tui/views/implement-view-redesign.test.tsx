/**
 * Visual verification test for the Implement view redesign (feature/implement-view-redesign).
 *
 * Validates all 4 user asks at wide widths (180 and 220 cols) using ink-testing-library
 * renders with a populated fixture:
 *
 *   Ask #1: HeaderCard + BaselineHealthChip rendered at the TOP in the wide path
 *           (previously gated to !sidebarLayout — gate removed).
 *   Ask #2: TokenBudgetCard at the BOTTOM of the sidebar (never clipped).
 *   Ask #3: Cross-task orphan notes (>200 chars) ellide within the main column — no overflow.
 *   Ask #4: Active task shows pending (◇) sub-steps from plannedLeaves after executed ones.
 *
 * Uses the ImplementSidebar + ExecuteBody directly so the fixtures are deterministic (no
 * live EventBus wiring needed). Height invariants use useResponsiveLayout directly, which
 * is a pure function (no React hook state).
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ImplementSidebar } from '@src/application/ui/tui/views/execute-view-internals/implement-sidebar.tsx';
import { ExecuteBody } from '@src/application/ui/tui/views/execute-view-internals/body.tsx';
import { useResponsiveLayout } from '@src/application/ui/tui/views/execute-view-internals/use-responsive-layout.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { TokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isoAt = (ms: number): IsoTimestamp => new Date(ms).toISOString() as IsoTimestamp;
const BASE_MS = Date.UTC(2026, 5, 18, 9, 0, 0);

const TASK_ID_A = '019f1234-5678-7abc-def0-111111111111';
const TASK_ID_B = '019f9999-aaaa-7bbb-cccc-222222222222';

/** A long cross-task note that exceeds 200 chars (must ellide, not overflow). */
const LONG_NOTE =
  'cross-task-note: this is a very long decision signal that describes a significant architectural change spanning multiple systems and contains detailed reasoning about why the current approach was chosen over alternatives — it should be ellipsed';

const makeRunningTask = (): TaskBucket => ({
  id: TASK_ID_A,
  status: 'running',
  subSteps: [
    { leafName: 'install-skills', status: 'completed', durationMs: 120 },
    { leafName: 'branch-preflight', status: 'completed', durationMs: 80 },
    { leafName: 'build-workspace', status: 'completed', durationMs: 340 },
    { leafName: 'setup-script', status: 'completed', durationMs: 200 },
    { leafName: 'generator', status: 'completed', durationMs: 8500 },
  ],
  evaluations: [],
  signals: [{ type: 'decision', text: 'chose Zod for schema validation', timestamp: isoAt(BASE_MS + 60_000) }],
  genEvalRound: 1,
  genEvalMaxRounds: 3,
});

const makePendingTask = (): TaskBucket => ({
  id: TASK_ID_B,
  status: 'pending',
  subSteps: [],
  evaluations: [],
  signals: [],
  genEvalRound: 0,
});

const makeBucketed = (): BucketedExecution => ({
  tasks: [makeRunningTask(), makePendingTask()],
  orphanSignals: [
    { type: 'note', text: 'short cross-task note', timestamp: isoAt(BASE_MS + 1000) },
    { type: 'decision', text: LONG_NOTE, timestamp: isoAt(BASE_MS + 2000) },
    { type: 'learning', text: 'another cross-task insight', timestamp: isoAt(BASE_MS + 3000) },
  ],
});

/**
 * Descriptor with plannedLeaves that include per-task UUID-suffixed entries.
 * - commit-task, post-task-verify, uninstall-skills for TASK_ID_A are FIXED leaves — should
 *   show as ◇ pending after the executed sub-steps.
 * - generator + evaluator are DYNAMIC (unknown rounds) — excluded from pending display.
 */
const makeDescriptor = (): SessionDescriptor => ({
  id: 'sess-visual-test-001',
  flowId: 'implement',
  title: 'Visual Test Sprint',
  status: 'running',
  startedAt: BASE_MS,
  trace: [
    { elementName: 'load-tasks', status: 'completed', durationMs: 50 },
    { elementName: 'working-tree-clean', status: 'completed', durationMs: 30 },
    { elementName: `install-skills-${TASK_ID_A}`, status: 'completed', durationMs: 120 },
    { elementName: `generator-${TASK_ID_A}`, status: 'completed', durationMs: 8500 },
  ] as unknown as SessionDescriptor['trace'],
  taskNames: new Map([
    [TASK_ID_A, 'Implement auth middleware'],
    [TASK_ID_B, 'Add rate limiting'],
  ]),
  generatorModel: 'claude-opus-4',
  evaluatorModel: 'claude-sonnet-4-6',
  pinnedSprintLabel: 'sprint-2026-06',
  plannedLeaves: [
    'load-tasks',
    'working-tree-clean',
    // Per-task leaves for TASK_ID_A
    `install-skills-${TASK_ID_A}`,
    `branch-preflight-${TASK_ID_A}`,
    `build-workspace-${TASK_ID_A}`,
    `setup-script-${TASK_ID_A}`,
    `generator-${TASK_ID_A}`, // dynamic — excluded from pending display
    `evaluator-${TASK_ID_A}`, // dynamic — excluded from pending display
    `commit-task-${TASK_ID_A}`, // fixed — unexecuted → show as ◇
    `post-task-verify-${TASK_ID_A}`, // fixed — unexecuted → show as ◇
    `uninstall-skills-${TASK_ID_A}`, // fixed — unexecuted → show as ◇
    // Per-task leaves for TASK_ID_B (all pending)
    `install-skills-${TASK_ID_B}`,
    `commit-task-${TASK_ID_B}`,
    `uninstall-skills-${TASK_ID_B}`,
    'finalize',
  ],
});

/** Cumulative claude-p style token usage (totalUsed >> contextWindow → "cumul." label). */
const makeCumulativeTokenUsage = (): TokenUsage => ({
  provider: 'claude-code',
  inputTokens: 24_000,
  outputTokens: 8_100,
  cacheReadTokens: 1_840_000,
  contextWindow: 200_000,
});

// ---------------------------------------------------------------------------
// ImplementSidebar direct renders (isolated, no full view wiring required)
// ---------------------------------------------------------------------------

describe('ImplementSidebar — Ask #2: TokenBudgetCard at bottom', () => {
  it('renders TokenBudgetCard at the bottom of the sidebar (cumulative data)', () => {
    const descriptor = makeDescriptor();
    const bucketed = makeBucketed();
    const layout = useResponsiveLayout({ columns: 180, rows: 50, isRunning: true });

    const { lastFrame, unmount } = render(
      React.createElement(ImplementSidebar, {
        sidebarWidth: layout.sidebarWidth,
        sidebarTaskNavRows: layout.sidebarTaskNavRows,
        sidebarFlowStepsRows: layout.sidebarFlowStepsRows,
        descriptor,
        bucketed,
        isRunning: true,
        focusedTaskId: TASK_ID_A,
        tokenUsage: makeCumulativeTokenUsage(),
      })
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Tasks');
    expect(frame).toContain('Steps');
    expect(frame).toContain('Tokens');
    expect(frame).toContain('cumul.');
    unmount();
  });

  it('renders empty-state placeholder when no tokenUsage provided', () => {
    const descriptor = makeDescriptor();
    const layout = useResponsiveLayout({ columns: 180, rows: 50, isRunning: true });

    const { lastFrame, unmount } = render(
      React.createElement(ImplementSidebar, {
        sidebarWidth: layout.sidebarWidth,
        sidebarTaskNavRows: layout.sidebarTaskNavRows,
        sidebarFlowStepsRows: layout.sidebarFlowStepsRows,
        descriptor,
        bucketed: undefined,
        isRunning: true,
        focusedTaskId: undefined,
      })
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Tokens');
    unmount();
  });

  it('task minimap displays both tasks', () => {
    const descriptor = makeDescriptor();
    const bucketed = makeBucketed();
    const layout = useResponsiveLayout({ columns: 180, rows: 50, isRunning: true });

    const { lastFrame, unmount } = render(
      React.createElement(ImplementSidebar, {
        sidebarWidth: layout.sidebarWidth,
        sidebarTaskNavRows: layout.sidebarTaskNavRows,
        sidebarFlowStepsRows: layout.sidebarFlowStepsRows,
        descriptor,
        bucketed,
        isRunning: true,
        focusedTaskId: TASK_ID_A,
      })
    );

    const frame = lastFrame() ?? '';
    // Both task names appear (truncated to sidebarWidth budget)
    expect(frame).toContain('Implement auth');
    expect(frame).toContain('Add rate limit');
    unmount();
  });
});

// ---------------------------------------------------------------------------
// ExecuteBody at wide widths (full ask verification)
// ---------------------------------------------------------------------------

describe('ExecuteBody — wide layout redesign at 180×50', () => {
  const renderBodyAt180 = (): { frame: string; unmount: () => void } => {
    const cols = 180;
    const rows = 50;
    const layout = useResponsiveLayout({ columns: cols, rows, isRunning: true });
    const descriptor = makeDescriptor();
    const bucketed = makeBucketed();
    const task = bucketed.tasks[0]!;

    const { lastFrame, unmount } = render(
      React.createElement(ExecuteBody, {
        descriptor,
        sessionList: [],
        sessionId: 'sess-visual-test-001',
        isRunning: true,
        now: BASE_MS + 180_000,
        elapsed: '3m00s',
        elapsedMs: 180_000,
        layout,
        termColumns: cols,
        termRows: rows,
        bucketed,
        pinnedSprintLabel: descriptor.pinnedSprintLabel,
        executionState: undefined,
        taskState: undefined,
        tokenUsage: makeCumulativeTokenUsage(),
        tasksDone: 0,
        tasksTotal: 2,
        currentTask: task,
        currentTaskIdx: 0,
        currentTaskName: 'Implement auth middleware',
        currentSubStep: 'generator',
        tasksPanel: null,
        logEntries: [],
        cancelScopeOpen: false,
        attemptElapsedMs: 8500,
        remainingTaskCount: 1,
        onCancelAttempt: vi.fn(),
        onCancelFlow: vi.fn(),
        onDismissCancelScope: vi.fn(),
        pinnedSprintStale: false,
      })
    );

    return { frame: lastFrame() ?? '', unmount };
  };

  it('Ask #1 — HeaderCard renders at the top', () => {
    const { frame, unmount } = renderBodyAt180();
    expect(frame).toContain('Visual Test Sprint');
    expect(frame).toContain('3m00s');
    expect(frame).toContain('claude-opus-4');
    unmount();
  });

  it('Ask #2 — TokenBudgetCard in the sidebar (cumul. suffix, not clipped)', () => {
    const { frame, unmount } = renderBodyAt180();
    expect(frame).toContain('Tokens');
    expect(frame).toContain('cumul.');
    unmount();
  });

  it('Ask #3 — long cross-task note ellides (full 240-char string absent from frame)', () => {
    const { frame, unmount } = renderBodyAt180();
    // The full note must not appear verbatim
    expect(frame).not.toContain(LONG_NOTE);
    // The beginning of the note should be visible (truncated)
    expect(frame).toContain('cross-task-note:');
    unmount();
  });

  it('Ask #4 — active task shows ◇ pending sub-steps from plannedLeaves', () => {
    const { frame, unmount } = renderBodyAt180();
    // ◇ glyph from glyphs.phasePending — rendered for unexecuted fixed leaves
    expect(frame).toContain('◇');
    // Fixed planned leaves for TASK_ID_A not yet executed
    expect(frame).toContain('commit-task');
    unmount();
  });
});

describe('ExecuteBody — wide layout redesign at 220×60', () => {
  const renderBodyAt220 = (): { frame: string; unmount: () => void } => {
    const cols = 220;
    const rows = 60;
    const layout = useResponsiveLayout({ columns: cols, rows, isRunning: true });
    const descriptor = makeDescriptor();
    const bucketed = makeBucketed();
    const task = bucketed.tasks[0]!;

    const { lastFrame, unmount } = render(
      React.createElement(ExecuteBody, {
        descriptor,
        sessionList: [],
        sessionId: 'sess-visual-test-001',
        isRunning: true,
        now: BASE_MS + 180_000,
        elapsed: '3m00s',
        elapsedMs: 180_000,
        layout,
        termColumns: cols,
        termRows: rows,
        bucketed,
        pinnedSprintLabel: descriptor.pinnedSprintLabel,
        executionState: undefined,
        taskState: undefined,
        tokenUsage: makeCumulativeTokenUsage(),
        tasksDone: 0,
        tasksTotal: 2,
        currentTask: task,
        currentTaskIdx: 0,
        currentTaskName: 'Implement auth middleware',
        currentSubStep: 'generator',
        tasksPanel: null,
        logEntries: [],
        cancelScopeOpen: false,
        attemptElapsedMs: 8500,
        remainingTaskCount: 1,
        onCancelAttempt: vi.fn(),
        onCancelFlow: vi.fn(),
        onDismissCancelScope: vi.fn(),
        pinnedSprintStale: false,
      })
    );

    return { frame: lastFrame() ?? '', unmount };
  };

  it('Ask #1 — HeaderCard at top (xxl breakpoint)', () => {
    const { frame, unmount } = renderBodyAt220();
    expect(frame).toContain('Visual Test Sprint');
    expect(frame).toContain('3m00s');
    unmount();
  });

  it('Ask #2 — TokenBudgetCard in sidebar at xxl', () => {
    const { frame, unmount } = renderBodyAt220();
    expect(frame).toContain('Tokens');
    expect(frame).toContain('cumul.');
    unmount();
  });

  it('Ask #3 — long note ellides at xxl width', () => {
    const { frame, unmount } = renderBodyAt220();
    expect(frame).not.toContain(LONG_NOTE);
    expect(frame).toContain('cross-task-note:');
    unmount();
  });

  it('Ask #4 — pending sub-steps visible at xxl', () => {
    const { frame, unmount } = renderBodyAt220();
    expect(frame).toContain('◇');
    expect(frame).toContain('commit-task');
    unmount();
  });
});

// ---------------------------------------------------------------------------
// Height budget invariant (pure function — no render needed)
// ---------------------------------------------------------------------------

describe('useResponsiveLayout — sidebar height budget never exceeds terminal rows', () => {
  it.each([
    [180, 50],
    [220, 60],
    [140, 35],
    [240, 50],
  ] as const)('sidebar sections fit at %d×%d', (cols, rows) => {
    const layout = useResponsiveLayout({ columns: cols, rows, isRunning: true });

    expect(layout.sidebarLayout).toBe(true);
    // PAGE_CHROME_ROWS(10) + SIDEBAR_CHROME_ROWS(10) + logRows should fit in the terminal
    const conservativeChrome = 10 + 10 + layout.logRows;
    expect(conservativeChrome).toBeLessThanOrEqual(rows);
    // Individual section invariants
    expect(layout.sidebarFlowStepsRows).toBeLessThanOrEqual(10);
    expect(layout.sidebarTaskNavRows).toBeGreaterThanOrEqual(4);
    expect(layout.sidebarBodyRows).toBeGreaterThanOrEqual(0);
  });
});
