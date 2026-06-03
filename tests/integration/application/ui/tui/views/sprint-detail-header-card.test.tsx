/**
 * Sprint-detail header card — crash-resume next-action alignment (audit L8).
 *
 * The header card's `phaseAction` projection and its `NextPhaseCard` companion must give the
 * same advice as Home for a crash-resumed sprint. Home counts `todo + in_progress` as resumable;
 * the header card previously counted only `todo`, so a sprint left mid-run by a prior crash
 * (only `in_progress` tasks remaining) was told "No todo tasks — review" while Home correctly
 * said "implement N pending task(s)". These tests fence the two surfaces back into agreement.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { NextPhaseCard, phaseAction } from '@src/application/ui/tui/views/sprint-detail-internals/header-card.tsx';
import {
  makeActiveSprint,
  makeDoneTask,
  makeInProgressTaskWithRunningAttempt,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';

describe('phaseAction — active sprint resumable count', () => {
  it('counts in_progress alongside todo as resumable', () => {
    const sprint = makeActiveSprint();
    const tasks = [makeTodoTask(), makeInProgressTaskWithRunningAttempt(), makeDoneTask()];
    const action = phaseAction(sprint, tasks);
    expect(action?.label).toBe('Implement 2 resumable task(s)');
  });

  it('advises resuming — not "review" — when only in_progress tasks remain (crash-resumed sprint)', () => {
    const sprint = makeActiveSprint();
    const tasks = [makeInProgressTaskWithRunningAttempt(), makeDoneTask()];
    const action = phaseAction(sprint, tasks);
    expect(action?.label).toBe('Implement 1 resumable task(s)');
    expect(action?.label).not.toMatch(/review/i);
    expect(action?.hint).not.toMatch(/no todo tasks/i);
  });

  it('falls back to review only when no todo and no in_progress tasks remain', () => {
    const sprint = makeActiveSprint();
    const tasks = [makeDoneTask()];
    const action = phaseAction(sprint, tasks);
    expect(action?.label).toBe('Review pending tasks');
  });
});

describe('NextPhaseCard — resume secondary line', () => {
  it('renders the resume line when in_progress > 0 and todo === 0', () => {
    const sprint = makeActiveSprint();
    const tasks = [makeInProgressTaskWithRunningAttempt(), makeDoneTask()];
    const { lastFrame } = render(<NextPhaseCard sprint={sprint} tasks={tasks} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Implement 1 resumable task(s)');
    expect(frame).toContain('Resume in-progress task');
    expect(frame).toContain('partially');
  });

  it('omits the resume line when a fresh todo task is queued', () => {
    const sprint = makeActiveSprint();
    const tasks = [makeTodoTask(), makeInProgressTaskWithRunningAttempt()];
    const { lastFrame } = render(<NextPhaseCard sprint={sprint} tasks={tasks} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Implement 2 resumable task(s)');
    expect(frame).not.toContain('Resume in-progress task');
  });
});
