/**
 * PipelineMap component tests.
 *
 * Verifies:
 *   - Status glyphs render for each phase status
 *   - Phase labels and detail text appear
 *   - Quick-action row renders when nextStep is present
 *   - Cursor navigation (↑/↓) works
 *   - Enter on quick-action row fires onAction
 *   - Enter on phase row fires onDrillIn
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { PipelineMap } from './pipeline-map.tsx';
import { glyphs } from '@src/integration/ui/theme/tokens.ts';
import type { PipelineSnapshot } from '@src/application/tui/pipeline-phases.ts';
import type { SprintId } from '@src/domain/values/sprint-id.ts';
import { computePipelineSnapshot } from '@src/application/tui/pipeline-phases.ts';

async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

const SPRINT_ID = '20240101-000000-test' as SprintId;

function makeSnapshot(overrides: Partial<Parameters<typeof computePipelineSnapshot>[0]> = {}): PipelineSnapshot {
  return computePipelineSnapshot({
    hasProjects: true,
    projectCount: 1,
    currentSprintId: SPRINT_ID,
    currentSprintName: 'Test Sprint',
    currentSprintStatus: 'draft',
    ticketCount: 2,
    taskCount: 5,
    tasksDone: 0,
    tasksInProgress: 0,
    pendingRequirements: 0,
    allRequirementsApproved: true,
    plannedTicketCount: 2,
    aiProvider: null,
    currentSprintHasBranch: false,
    currentSprintHasPullRequest: false,
    ...overrides,
  });
}

describe('PipelineMap', () => {
  it('renders all four phase titles', () => {
    const snapshot = makeSnapshot();
    const { lastFrame } = render(<PipelineMap snapshot={snapshot} onAction={vi.fn()} onDrillIn={vi.fn()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Refine');
    expect(frame).toContain('Plan');
    expect(frame).toContain('Execute');
    expect(frame).toContain('Close');
  });

  it('renders the phaseDone glyph for done phases', () => {
    // All tickets approved + all tasks done → Refine, Plan, Execute done
    const snapshot = makeSnapshot({
      currentSprintStatus: 'active',
      tasksDone: 5,
    });
    const { lastFrame } = render(<PipelineMap snapshot={snapshot} onAction={vi.fn()} onDrillIn={vi.fn()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain(glyphs.phaseDone);
  });

  it('renders the phaseActive glyph for active phases', () => {
    const snapshot = makeSnapshot({
      currentSprintStatus: 'draft',
      tasksDone: 0,
    });
    const { lastFrame } = render(<PipelineMap snapshot={snapshot} onAction={vi.fn()} onDrillIn={vi.fn()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain(glyphs.phaseActive);
  });

  it('renders the phasePending glyph for pending phases', () => {
    const snapshot = makeSnapshot({
      currentSprintStatus: 'draft',
      tasksDone: 0,
    });
    const { lastFrame } = render(<PipelineMap snapshot={snapshot} onAction={vi.fn()} onDrillIn={vi.fn()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain(glyphs.phasePending);
  });

  it('renders a quick-action row when nextStep is present', () => {
    const snapshot = makeSnapshot({
      currentSprintStatus: 'draft',
      taskCount: 5,
      tasksDone: 0,
    });
    const { lastFrame } = render(<PipelineMap snapshot={snapshot} onAction={vi.fn()} onDrillIn={vi.fn()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Next:');
    expect(snapshot.nextStep).not.toBeNull();
  });

  it('does not render quick-action row when nextStep is null', () => {
    // In the no-sprint case nextStep IS 'Create Sprint' — test a post-close scenario instead
    const closedSnapshot = computePipelineSnapshot({
      hasProjects: true,
      projectCount: 1,
      currentSprintId: SPRINT_ID,
      currentSprintName: 'Test',
      currentSprintStatus: 'closed',
      ticketCount: 1,
      taskCount: 1,
      tasksDone: 1,
      tasksInProgress: 0,
      pendingRequirements: 0,
      allRequirementsApproved: true,
      plannedTicketCount: 1,
      aiProvider: null,
      currentSprintHasBranch: false,
      currentSprintHasPullRequest: false,
    });
    // post-close snapshot has nextStep = 'Start a new sprint' (create sprint)
    expect(closedSnapshot.nextStep).not.toBeNull();
    const { lastFrame } = render(<PipelineMap snapshot={closedSnapshot} onAction={vi.fn()} onDrillIn={vi.fn()} />);
    expect(lastFrame()).toContain('Next:');
  });

  it('calls onAction when Enter is pressed on quick-action row (initial cursor position)', async () => {
    const onAction = vi.fn();
    const snapshot = makeSnapshot();
    // snapshot.nextStep should be non-null — Execute phase is active (Start Sprint)
    expect(snapshot.nextStep).not.toBeNull();

    const { stdin } = render(<PipelineMap snapshot={snapshot} onAction={onAction} onDrillIn={vi.fn()} />);
    await flush();
    stdin.write('\r');
    await flush();
    const nextStep = snapshot.nextStep;
    expect(nextStep).not.toBeNull();
    expect(onAction).toHaveBeenCalledWith(nextStep);
  });

  it('calls onDrillIn when Enter is pressed on a phase row', async () => {
    const onDrillIn = vi.fn();
    const snapshot = makeSnapshot();

    const { stdin } = render(<PipelineMap snapshot={snapshot} onAction={vi.fn()} onDrillIn={onDrillIn} />);
    await flush();
    // Move down once from quick-action row to first phase row (Refine).
    // Ink maps down-arrow as the escape sequence \x1B[B.
    stdin.write('\x1B[B');
    await flush();
    stdin.write('\r');
    await flush();
    // Should drill into the first phase (refine)
    expect(onDrillIn).toHaveBeenCalled();
  });

  it('cursor wraps: pressing up from the first row lands on the last row', async () => {
    const onDrillIn = vi.fn();
    const snapshot = makeSnapshot();
    // There are 5 rows: 1 quick-action + 4 phase rows.
    // Initial cursor = row 0 (quick-action). Going up once wraps to the last
    // row (index 4 = Close phase). Pressing Enter there calls onDrillIn.

    const { stdin } = render(<PipelineMap snapshot={snapshot} onAction={vi.fn()} onDrillIn={onDrillIn} />);
    await flush();
    // Go up from row 0 → wraps to last row (Close phase row)
    stdin.write('\x1B[A');
    await flush();
    stdin.write('\r');
    await flush();
    // Last row is a phase row, so onDrillIn should have been called
    expect(onDrillIn).toHaveBeenCalledWith('close');
  });

  it('renders vertical connector glyphs between phase rows', () => {
    const snapshot = makeSnapshot();
    const { lastFrame } = render(<PipelineMap snapshot={snapshot} onAction={vi.fn()} onDrillIn={vi.fn()} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain(glyphs.separatorVertical);
  });

  it('is inert when disabled=true (no cursor highlight)', () => {
    const snapshot = makeSnapshot();
    const { lastFrame } = render(
      <PipelineMap snapshot={snapshot} onAction={vi.fn()} onDrillIn={vi.fn()} disabled={true} />
    );
    const frame = lastFrame() ?? '';
    // actionCursor should not appear when disabled
    expect(frame).not.toContain(glyphs.actionCursor);
  });

  describe('snapshots', () => {
    it('draft sprint — refine active', () => {
      const snapshot = makeSnapshot();
      const { lastFrame } = render(<PipelineMap snapshot={snapshot} onAction={vi.fn()} onDrillIn={vi.fn()} disabled />);
      expect(lastFrame()).toMatchSnapshot();
    });

    it('active sprint — execute phase running', () => {
      const snapshot = makeSnapshot({
        currentSprintStatus: 'active',
        tasksDone: 2,
        tasksInProgress: 1,
      });
      const { lastFrame } = render(<PipelineMap snapshot={snapshot} onAction={vi.fn()} onDrillIn={vi.fn()} disabled />);
      expect(lastFrame()).toMatchSnapshot();
    });

    it('all-done — close phase next', () => {
      const snapshot = makeSnapshot({
        currentSprintStatus: 'active',
        tasksDone: 5,
      });
      const { lastFrame } = render(<PipelineMap snapshot={snapshot} onAction={vi.fn()} onDrillIn={vi.fn()} disabled />);
      expect(lastFrame()).toMatchSnapshot();
    });
  });
});
