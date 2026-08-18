/**
 * StateCard next-action hint coverage. The hint must name the flow AND what it does (audit 2-E)
 * — a bare key like "press n" leaves a newcomer guessing which flow runs and why. We assert the
 * loaded-sprint regime renders a "<key> → <flow> (<what it does>)" hint per lifecycle status.
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
} from '@tests/fixtures/domain.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';

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
    expect(frame).toContain('n → run refine');
    expect(frame).toContain('clarify');
    unmount();
  });

  it('active + resumable tasks → implement (run the tasks), not a bare key', () => {
    const active = makeActiveSprint();
    const { lastFrame, unmount } = render(
      <StateCard state={snapshot(active, { resumableTaskCount: 3 })} loading={false} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('n → run implement');
    expect(frame).toContain('3 tasks pending');
    // The old bare-key phrasing must be gone — the hint names the flow now.
    expect(frame).not.toContain('— press n');
    unmount();
  });

  it('review offers review + close-sprint, NOT the create-pr this card used to advise', () => {
    // Behaviour fix, not a rename: `ALLOWED_BY_STATUS` (flows-visibility.ts) hides `create-pr`
    // at `review`, so the old hint pointed at a flow the Flows menu would not even list. Both
    // flows that ARE visible at `review` are offered, which the previous single-string hint
    // could not express.
    const review = makeReviewSprint();
    const { lastFrame, unmount } = render(<StateCard state={snapshot(review)} loading={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('n → run review');
    expect(frame).toContain('n → run close-sprint');
    expect(frame).not.toContain('create-pr');
    unmount();
  });

  it('done recommends create-pr — the card used to render nothing at all in this state', () => {
    const done = makeDoneSprint();
    const { lastFrame, unmount } = render(<StateCard state={snapshot(done)} loading={false} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('n → run create-pr');
    expect(frame).toContain('pull request');
    unmount();
  });
});
