/**
 * Structured block triage. When a self-block signal supplied the generator's own question and
 * what-would-unblock-it (see `BlockedTask.question` / `.whatUnblocksMe` on the domain entity),
 * the card should surface them rather than leaving the operator with a bare reason string —
 * mirrors `tasks-panel-blocked-reason.test.tsx` for the plain-reason case.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TasksPanel } from '@src/application/ui/tui/components/tasks-panel.tsx';
import type { BucketedExecution, TaskBucket } from '@src/application/ui/tui/runtime/bucket-task-signals.ts';

const bucket = (id: string, status: TaskBucket['status']): TaskBucket => ({
  id,
  status,
  subSteps: [],
  evaluations: [],
  signals: [],
  genEvalRound: 0,
});

const ID = '01933fbb-0000-7000-8000-000000000001';

describe('TasksPanel blocked triage', () => {
  it('renders the question and what-unblocks-it lines on the (auto-expanded) card', () => {
    const bucketed: BucketedExecution = { tasks: [bucket(ID, 'blocked')], orphanSignals: [] };
    const reasonById = new Map([[ID, 'generator reported missing information']]);
    const triageById = new Map([
      [ID, { question: 'Which auth provider should tickets use?', whatUnblocksMe: 'a decision on the provider' }],
    ]);
    const r = render(
      <TasksPanel bucketed={bucketed} running={false} blockedReasonById={reasonById} blockedTriageById={triageById} />
    );
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('generator reported missing information');
    expect(frame).toContain('Which auth provider should tickets use?');
    expect(frame).toContain('a decision on the provider');
    r.unmount();
  });

  it('renders only the reason line when no triage is supplied (unchanged pre-existing behaviour)', () => {
    const bucketed: BucketedExecution = { tasks: [bucket(ID, 'blocked')], orphanSignals: [] };
    const reasonById = new Map([[ID, 'blocked upstream — prerequisite not done: Foundation (blocked)']]);
    const r = render(<TasksPanel bucketed={bucketed} running={false} blockedReasonById={reasonById} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).toContain('blocked upstream');
    expect(frame).not.toContain('unblocks');
    r.unmount();
  });

  it('does not render the triage lines while the card is collapsed', () => {
    // Two tasks: the FIRST is blocked (with triage) but the LAST is the active-in-flight task, so
    // the blocked card's collapsed-by-default state is exercised (the auto-expand seed picks the
    // active/settled-fallback card, not this one).
    const bucketed: BucketedExecution = {
      tasks: [bucket(ID, 'blocked'), bucket('running-task', 'running')],
      orphanSignals: [],
    };
    const triageById = new Map([[ID, { question: 'Should this be collapsed-only hidden?' }]]);
    const r = render(<TasksPanel bucketed={bucketed} running={true} blockedTriageById={triageById} />);
    const frame = r.lastFrame() ?? '';

    expect(frame).not.toContain('Should this be collapsed-only hidden?');
    r.unmount();
  });
});
