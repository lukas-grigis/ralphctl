/**
 * StateCard next-action hint coverage. The hint must name the flow AND what it does (audit 2-E)
 * — a bare key like "press n" leaves a newcomer guessing which flow runs and why. We assert the
 * loaded-sprint regime renders a "◆ <Flow> — <what it does>" hint (no key: ↵ / the footer launch it)
 * per lifecycle status.
 *
 * The wording now comes from `buildNextSteps` (`ui/shared/next-steps.ts`), shared with the Flows
 * orientation card and the settled ResultCard, so the copy asserted here is the copy all three
 * surfaces show. The table itself is unit-tested; these cases fence the Home rendering of it.
 *
 * StateCard is a pure presentational sub-component (no React context), so it renders directly
 * under ink-testing-library without the full provider harness.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { StateCard } from '@src/application/ui/tui/views/home-internals/state-card.tsx';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import {
  makeActiveSprint,
  makeDoneSprint,
  makeDraftSprint,
  makePendingTicket,
  makeProject,
  makeReviewSprint,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';

const snapshot = (sprint: Sprint, triggers: Partial<AppStateSnapshot['triggerInputs']> = {}): AppStateSnapshot =>
  ({
    project: makeProject({ displayName: 'Demo' }),
    sprint,
    tasks: [],
    triggerInputs: {
      hasProject: true,
      currentSprintStatus: sprint.status,
      pendingTicketCount: 0,
      approvedTicketCount: 0,
      resumableTaskCount: 0,
      ...triggers,
    },
    projectCount: 1,
    sprintCount: 1,
    recentSprints: [],
  }) as AppStateSnapshot;

describe('StateCard — next-action hint names the flow', () => {
  it('draft + pending tickets → refine, naming what it does', () => {
    // The label branch keys off a non-empty tickets array; the count comes from triggerInputs.
    // A draft sprint with one pending ticket lands on the refine branch.
    const base = makeDraftSprint({ name: 'Drafty' });
    const draft = { ...base, tickets: [makePendingTicket({ title: 'unclear ask' })] } as unknown as Sprint;
    const { lastFrame, unmount } = render(
      <StateCard state={snapshot(draft, { pendingTicketCount: 2 })} loading={false} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('◆ Refine — clarify 2 pending tickets');
    expect(frame).toContain('clarify');
    unmount();
  });

  it('active + resumable tasks → implement (run the tasks), not a bare key', () => {
    const active = makeActiveSprint();
    const { lastFrame, unmount } = render(
      <StateCard state={snapshot(active, { resumableTaskCount: 3 })} loading={false} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('◆ Implement — 3 tasks pending');
    // The old bare-key phrasing must be gone — the hint names the flow now.
    expect(frame).not.toContain('— press n');
    expect(frame).not.toContain('n →');
    unmount();
  });

  it('review offers review, create-pr and close-sprint, in that order', () => {
    // `ALLOWED_BY_STATUS` (flows-visibility.ts) lists all three at `review`; Review leads so the
    // pipeline stage and the first row agree.
    const review = makeReviewSprint();
    const { lastFrame, unmount } = render(<StateCard state={snapshot(review)} loading={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('◆ Review');
    expect(frame).toContain('◆ Create PR');
    expect(frame).toContain('◆ Close sprint');
    expect(frame.indexOf('◆ Review')).toBeLessThan(frame.indexOf('◆ Create PR'));
    expect(frame.indexOf('◆ Create PR')).toBeLessThan(frame.indexOf('◆ Close sprint'));
    unmount();
  });

  it('done recommends create-pr — the card used to render nothing at all in this state', () => {
    const done = makeDoneSprint();
    const { lastFrame, unmount } = render(<StateCard state={snapshot(done)} loading={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('◆ Create PR — open a pull request');
    unmount();
  });

  it('done WITH blocked tasks leads with the unblock callout naming the reopen path, ahead of create-pr', () => {
    // The regression this fixes: closing a sprint with blocked work (confirm-and-proceed) used to
    // leave Home saying only "run create-pr" — silent about tasks that are now stuck in a closed
    // sprint, even though the counts line above already flags them and unblocking one reopens it.
    const done = makeDoneSprint();
    const blockedTask = (() => {
      const r = markTaskBlocked(makeTodoTask(), 'stuck', 'own');
      if (!r.ok) throw new Error(`fixture setup failed: ${r.error.message}`);
      return r.value;
    })();
    const state: AppStateSnapshot = { ...snapshot(done), tasks: [blockedTask] };
    const { lastFrame, unmount } = render(<StateCard state={state} loading={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('unblock 1 blocked task');
    expect(frame).toContain('reopens the sprint');
    expect(frame).toContain('◆ Create PR');
    unmount();
  });
});

describe('StateCard — sprint hero counts', () => {
  const todo = (): ReturnType<typeof makeTodoTask> => makeTodoTask();

  it('uses " · " separators and pluralises each noun by its own count', () => {
    const state: AppStateSnapshot = {
      ...snapshot(makeActiveSprint(), { pendingTicketCount: 0, approvedTicketCount: 1, resumableTaskCount: 1 }),
      tasks: [todo()],
    };
    const { lastFrame, unmount } = render(<StateCard state={state} loading={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1 ticket · 0 pending · 1 approved · 1 task pending');
    unmount();
  });

  it('says "2 tasks pending" for two tasks', () => {
    const state: AppStateSnapshot = {
      ...snapshot(makeActiveSprint(), { resumableTaskCount: 2 }),
      tasks: [todo(), todo()],
    };
    const { lastFrame, unmount } = render(<StateCard state={state} loading={false} />);
    expect(lastFrame() ?? '').toContain('2 tasks pending');
    unmount();
  });

  it('carries no cursor glyph in the hero title (one cursor per screen)', () => {
    const { lastFrame, unmount } = render(<StateCard state={snapshot(makeActiveSprint())} loading={false} />);
    expect(lastFrame() ?? '').not.toContain('▸');
    unmount();
  });
});
