/**
 * StateCard: the hero cards Work shows when there is no sprint to put a header strip over. With a
 * sprint loaded it renders nothing — the strip and the agenda own that state (see
 * `home-view.test.tsx`; next-step wording is covered by the `buildNextSteps` unit tests).
 *
 * StateCard is a pure presentational sub-component (no React context), so it renders directly
 * under ink-testing-library without the provider harness.
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { StateCard } from '@src/application/ui/tui/views/home-internals/state-card.tsx';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { makeActiveSprint, makeProject } from '@tests/fixtures/domain.ts';

const triggerInputs = {
  hasProject: true,
  currentSprintStatus: 'active',
  pendingTicketCount: 0,
  approvedTicketCount: 0,
  resumableTaskCount: 0,
} as AppStateSnapshot['triggerInputs'];

const snapshot = (over: Partial<AppStateSnapshot>): AppStateSnapshot => ({
  tasks: [],
  triggerInputs,
  projectCount: 1,
  sprintCount: 0,
  recentSprints: [],
  ...over,
});

const frameOf = (state: AppStateSnapshot | undefined, loading = false): string => {
  const { lastFrame, unmount } = render(<StateCard state={state} loading={loading} />);
  const frame = lastFrame() ?? '';
  unmount();
  return frame;
};

describe('StateCard', () => {
  it('invites creating the first project when storage holds none', () => {
    const frame = frameOf(snapshot({ projectCount: 0 }));
    expect(frame).toContain('Start by creating a project');
    expect(frame).toContain('create your first project');
  });

  it('asks for a project pick when projects exist but none is selected', () => {
    expect(frameOf(snapshot({ projectCount: 3 }))).toContain('Pick a project to work on');
  });

  it('offers the first sprint for a project without sprints', () => {
    const frame = frameOf(snapshot({ project: makeProject({ displayName: 'Demo' }) }));
    expect(frame).toContain('Demo');
    expect(frame).toContain('ready for the first sprint');
  });

  it('renders nothing once a sprint is loaded — the header strip and agenda take over', () => {
    const frame = frameOf(snapshot({ project: makeProject(), sprint: makeActiveSprint(), sprintCount: 1 }));
    expect(frame.trim()).toBe('');
  });

  it('shows a spinner while loading', () => {
    expect(frameOf(undefined, true)).toContain('loading state');
  });
});
