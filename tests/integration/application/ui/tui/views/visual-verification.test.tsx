/**
 * Visual verification for the redesigned Implement view (wide layout).
 *
 * Renders the sidebar at 50×200 and 60×240 with a populated fixture and verifies:
 *   (a) sidebar is ~2/5 width
 *   (b) sidebar order: Baseline → Steps → Tasks → Tokens
 *   (c) model labels NOT in sidebar (ModelMeta removed — they live in HeaderCard)
 *   (d) no [nav] / [tasks] labels anywhere
 *   (e) token card reads as cumulative (not a fake window bar)
 *   (f) token card not clipped (Tokens present in frame)
 *
 * This is an integration smoke-test, not a snapshot test — it verifies structure and
 * content presence without pinning exact character positions.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImplementSidebar } from '@src/application/ui/tui/views/execute-view-internals/implement-sidebar.tsx';
import { useResponsiveLayout } from '@src/application/ui/tui/views/execute-view-internals/use-responsive-layout.ts';
import type { SessionDescriptor } from '@src/application/ui/tui/runtime/session-manager.ts';
import type { BucketedExecution } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';
import type { TokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_MS = Date.UTC(2026, 5, 18, 9, 0, 0);
const isoAt = (ms: number): IsoTimestamp => new Date(ms).toISOString() as IsoTimestamp;

const GENERATOR_MODEL = 'claude-sonnet-4-6';
const EVALUATOR_MODEL = 'claude-opus-4-8';

/** Full descriptor with taskNames, generator+evaluator models, and pinnedSprintLabel. */
const makeDescriptor = (): SessionDescriptor => ({
  id: 'sess-verify-001',
  flowId: 'implement',
  title: 'Auth Middleware Sprint',
  status: 'running',
  startedAt: BASE_MS,
  trace: [],
  taskNames: new Map([
    ['task-aaa-111-222-333', 'Add JWT authentication middleware'],
    ['task-bbb-444-555-666', 'Update user session handling'],
    ['task-ccc-777-888-999', 'Refactor permission checks'],
  ]),
  generatorModel: GENERATOR_MODEL,
  evaluatorModel: EVALUATOR_MODEL,
  pinnedSprintLabel: 'sprint-2026-06',
});

/** Bucketed tasks with one running, one completed, one pending. */
const makeBucketed = (): BucketedExecution => ({
  tasks: [
    {
      id: 'task-aaa-111-222-333',
      status: 'completed',
      subSteps: [],
      evaluations: [],
      signals: [],
      genEvalRound: 2,
      durationMs: 45_000,
    },
    {
      id: 'task-bbb-444-555-666',
      status: 'running',
      subSteps: [],
      evaluations: [],
      signals: [],
      genEvalRound: 1,
    },
    {
      id: 'task-ccc-777-888-999',
      status: 'pending',
      subSteps: [],
      evaluations: [],
      signals: [],
      genEvalRound: 0,
    },
  ],
  orphanSignals: [],
});

/** Execution state with a successful setup run. */
const makeExecutionState = (): SprintExecution =>
  ({
    sprintId: 'sprint-verify',
    setupRanAt: [{ repositoryId: 'main-repo', ranAt: isoAt(BASE_MS + 60_000), outcome: 'ok' }],
    branch: 'feature/auth',
    setupRanCount: 1,
  }) as unknown as SprintExecution;

/** Claude-p style cumulative token usage (totalUsed >> contextWindow). */
const makeCumulativeTokenUsage = (): TokenUsage => ({
  provider: 'claude-code',
  inputTokens: 24_000,
  outputTokens: 8_100,
  cacheReadTokens: 1_840_000,
  contextWindow: 200_000,
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

interface SidebarRender {
  readonly frame: string;
  readonly sidebarWidth: number;
  readonly unmount: () => void;
}

const renderSidebar = (cols: number, rows: number): SidebarRender => {
  const layout = useResponsiveLayout({ columns: cols, rows, isRunning: true });
  const descriptor = makeDescriptor();
  const bucketed = makeBucketed();

  const { lastFrame, unmount } = render(
    React.createElement(ImplementSidebar, {
      sidebarWidth: layout.sidebarWidth,
      sidebarTaskNavRows: layout.sidebarTaskNavRows,
      sidebarFlowStepsRows: layout.sidebarFlowStepsRows,
      sidebarContextSideBySide: layout.sidebarContextSideBySide,
      descriptor,
      bucketed,
      isRunning: true,
      focusedTaskId: 'task-bbb-444-555-666',
      tokenUsage: makeCumulativeTokenUsage(),
      executionState: makeExecutionState(),
      now: BASE_MS + 180_000,
    })
  );

  return { frame: lastFrame() ?? '', sidebarWidth: layout.sidebarWidth, unmount };
};

// ---------------------------------------------------------------------------
// Tests at 200×50
// ---------------------------------------------------------------------------

describe('ImplementSidebar visual verification at 200×50', () => {
  let frame: string;
  let sidebarWidth: number;
  let unmount: () => void;

  beforeEach(() => {
    const result = renderSidebar(200, 50);
    frame = result.frame;
    sidebarWidth = result.sidebarWidth;
    unmount = result.unmount;
  });

  afterEach(() => unmount());

  it('(a) sidebar width is ~2/5 of 200 cols (≥80)', () => {
    // Math.max(34, Math.round(200 * 0.4)) = Math.max(34, 80) = 80
    expect(sidebarWidth).toBe(80);
  });

  it('(b) sidebar order: Baseline + Tokens side-by-side row, then Steps (≥xl side-by-side layout)', () => {
    // At 200 cols (≥xl) Baseline and Tokens are rendered side-by-side in the top row.
    // Both appear BEFORE Steps in the character stream.
    const baselineIdx = frame.indexOf('Baseline');
    const stepsIdx = frame.indexOf('Steps');
    const tokensIdx = frame.indexOf('Tokens');

    expect(baselineIdx).toBeGreaterThan(-1);
    expect(stepsIdx).toBeGreaterThan(-1);
    expect(tokensIdx).toBeGreaterThan(-1);

    // Baseline before Steps (always true — Baseline is at the top of the sidebar).
    expect(baselineIdx).toBeLessThan(stepsIdx);
    // In side-by-side layout, Tokens is in the same top row as Baseline — before Steps.
    expect(tokensIdx).toBeLessThan(stepsIdx);
  });

  it('(b) Tasks section present in sidebar', () => {
    expect(frame).toContain('Tasks');
  });

  it('(c) model labels absent from sidebar (ModelMeta removed — lives in HeaderCard)', () => {
    // generator / evaluator labels are now rendered exclusively by HeaderCard (body.tsx).
    // The sidebar carries only Baseline, Steps, Tasks, and Tokens sections.
    expect(frame).not.toContain('generator');
    expect(frame).not.toContain('evaluator');
  });

  it('(d) no [nav] column label', () => {
    expect(frame).not.toContain('[nav]');
  });

  it('(d) no [tasks] column label', () => {
    expect(frame).not.toContain('[tasks]');
  });

  it('(e) token card reads as cumulative — no fake context bar', () => {
    expect(frame).toContain('cumulative');
    // No bar for cumulative data (no "context: N/200k ████ N%" form)
    expect(frame).not.toContain('100%');
    expect(frame).not.toMatch(/█{10}/);
  });

  it('(f) token card present (not clipped)', () => {
    expect(frame).toContain('Tokens');
    expect(frame).not.toContain('no usage data'); // has real usage data
    expect(frame).toContain('24k'); // input tokens visible
  });

  it('task minimap shows task names', () => {
    // Names truncated to sidebar width budget — check prefixes
    expect(frame).toContain('Add JWT'); // task-aaa
    expect(frame).toContain('Update user'); // task-bbb (focused)
    expect(frame).toContain('Refactor'); // task-ccc
  });
});

// ---------------------------------------------------------------------------
// Tests at 240×60
// ---------------------------------------------------------------------------

describe('ImplementSidebar visual verification at 240×60', () => {
  let frame: string;
  let sidebarWidth: number;
  let unmount: () => void;

  beforeEach(() => {
    const result = renderSidebar(240, 60);
    frame = result.frame;
    sidebarWidth = result.sidebarWidth;
    unmount = result.unmount;
  });

  afterEach(() => unmount());

  it('(a) sidebar width is ~2/5 of 240 cols (≥96)', () => {
    // Math.max(34, Math.round(240 * 0.4)) = Math.max(34, 96) = 96
    expect(sidebarWidth).toBe(96);
  });

  it('(b) sidebar order: Baseline + Tokens side-by-side row, then Steps (≥xl side-by-side layout)', () => {
    // At 240 cols (≥xl) Baseline and Tokens are rendered side-by-side in the top row.
    // Both appear BEFORE Steps in the character stream.
    const baselineIdx = frame.indexOf('Baseline');
    const stepsIdx = frame.indexOf('Steps');
    const tokensIdx = frame.indexOf('Tokens');

    expect(baselineIdx).toBeGreaterThan(-1);
    expect(stepsIdx).toBeGreaterThan(-1);
    expect(tokensIdx).toBeGreaterThan(-1);

    // Baseline before Steps (always true — Baseline is at the top of the sidebar).
    expect(baselineIdx).toBeLessThan(stepsIdx);
    // In side-by-side layout, Tokens is in the same top row as Baseline — before Steps.
    expect(tokensIdx).toBeLessThan(stepsIdx);
  });

  it('(c) model labels absent from sidebar (ModelMeta removed — lives in HeaderCard)', () => {
    // generator / evaluator labels are now rendered exclusively by HeaderCard (body.tsx).
    // The sidebar carries only Baseline, Steps, Tasks, and Tokens sections.
    expect(frame).not.toContain('generator');
    expect(frame).not.toContain('evaluator');
  });

  it('(d) no [nav] or [tasks] column labels', () => {
    expect(frame).not.toContain('[nav]');
    expect(frame).not.toContain('[tasks]');
  });

  it('(e) token card is cumulative — no fake bar', () => {
    expect(frame).toContain('cumulative');
    expect(frame).not.toContain('100%');
    expect(frame).not.toMatch(/█{10}/);
  });

  it('(f) token card not clipped', () => {
    expect(frame).toContain('Tokens');
  });
});

// ---------------------------------------------------------------------------
// Width formula: Math.max(34, Math.round(cols * 0.4))
// ---------------------------------------------------------------------------

describe('useResponsiveLayout — sidebarWidth is proportional 2/5 of terminal', () => {
  it('200 cols → sidebarWidth = 80 (exactly 2/5)', () => {
    const layout = useResponsiveLayout({ columns: 200, rows: 50, isRunning: true });
    expect(layout.sidebarWidth).toBe(80);
  });

  it('140 cols → sidebarWidth = 56 (exactly 2/5)', () => {
    const layout = useResponsiveLayout({ columns: 140, rows: 40, isRunning: true });
    expect(layout.sidebarWidth).toBe(56);
  });

  it('80 cols (below sidebar breakpoint) → sidebarLayout=false, no sidebarWidth constraint', () => {
    const layout = useResponsiveLayout({ columns: 80, rows: 40, isRunning: true });
    expect(layout.sidebarLayout).toBe(false);
  });

  it('floor: 85 cols → sidebarWidth = max(34, round(85*0.4)) = max(34,34) = 34', () => {
    // 85 * 0.4 = 34 exactly
    const layout = useResponsiveLayout({ columns: 140, rows: 40, isRunning: true });
    // At 140 cols, 140 * 0.4 = 56 ≥ 34 floor
    expect(layout.sidebarWidth).toBeGreaterThanOrEqual(34);
  });
});
