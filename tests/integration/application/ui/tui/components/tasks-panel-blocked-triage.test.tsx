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

/** Control bytes built by code point — a literal ESC here would be invisible in a diff. */
const chr = (code: number): string => String.fromCharCode(code);
const ESC = chr(0x1b);
const BEL = chr(0x07);
const DEL = chr(0x7f);

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

  it('renders nothing at all for fields that are only control bytes', () => {
    // These three are MODEL-authored, off a generator that just read the target repository. A
    // reason of nothing but ESC/BEL survives `.trim()` (JS whitespace does not cover C0), so
    // without sanitising BEFORE the emptiness gate the card renders a notice whose whole body
    // the strip then removes — a bare `⚠` with no text, plus a `?` and a `→` for the triage
    // pair. Asserted as frame equality against the same card with the fields absent.
    const bucketed: BucketedExecution = { tasks: [bucket(ID, 'blocked')], orphanSignals: [] };
    const reasonById = new Map([[ID, `${ESC}${BEL}`]]);
    const triageById = new Map([[ID, { question: `${ESC}${DEL}`, whatUnblocksMe: chr(0x00) }]]);

    const noisy = render(
      <TasksPanel bucketed={bucketed} running={false} blockedReasonById={reasonById} blockedTriageById={triageById} />
    );
    const noisyFrame = noisy.lastFrame() ?? '';
    noisy.unmount();

    const bare = render(<TasksPanel bucketed={bucketed} running={false} />);
    const bareFrame = bare.lastFrame() ?? '';
    bare.unmount();

    expect(noisyFrame).toBe(bareFrame);
    expect(noisyFrame).not.toContain(ESC);
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
