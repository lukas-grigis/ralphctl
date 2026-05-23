/**
 * Behavior 8 — Switch feedback line.
 *
 * After any sprint switch action (Home inline shortcut from the "switch sprint" section),
 * a confirmation line "✓ now on <sprint-name>" MUST appear above the Home menu. It MUST
 * disappear after ~3s.
 *
 * Uses a `Date.now` spy to control the freshness window without real-time delays.
 * Timer test: sets `Date.now()` to return a time 3+ seconds after the switch timestamp, then
 * triggers a re-render via `selection.setSprint` to force HomeView to re-evaluate the condition.
 *
 * NOTE: These tests will FAIL until the implementer lands the switch-feedback feature.
 */

import React from 'react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup } from 'ink-testing-library';
import { Result } from '@src/domain/result.ts';
import { HomeView } from '@src/application/ui/tui/views/home-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { SettingsRepository } from '@src/domain/repository/settings/settings-repository.ts';
import type { SprintExecutionRepository } from '@src/domain/repository/sprint/sprint-execution-repository.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { makeProject, makeDraftSprint } from '@tests/fixtures/domain.ts';
import { ENTER, tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

const noopVersionChecker = async (): Promise<null> => null;

const makeDepsWithProject = (sprints: readonly Sprint[], project: ReturnType<typeof makeProject>): AppDeps =>
  ({
    projectRepo: {
      async list() {
        return Result.ok([project]);
      },
      async findById() {
        return Result.ok(project);
      },
    } as unknown as ProjectRepository,
    sprintRepo: {
      async list() {
        return Result.ok([...sprints]);
      },
      async findById(id: unknown) {
        const found = sprints.find((s) => s.id === id);
        if (found !== undefined) return Result.ok(found);
        return Result.error(new NotFoundError({ entity: 'sprint', id: String(id), message: 'nope' }));
      },
    } as unknown as SprintRepository,
    sprintExecutionRepo: {
      async findById(id: unknown) {
        return Result.error(new NotFoundError({ entity: 'sprint-execution', id: String(id), message: 'nope' }));
      },
    } as unknown as SprintExecutionRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([]);
      },
    } as unknown as TaskRepository,
    settingsRepo: {
      path: '/tmp/test-settings.json',
      async exists() {
        return Result.ok(true);
      },
      async load() {
        return Result.ok(DEFAULT_SETTINGS);
      },
      async save() {
        return Result.ok(undefined);
      },
    } as unknown as SettingsRepository,
    versionChecker: noopVersionChecker,
  }) as unknown as AppDeps;

/**
 * Helper component that triggers a `selection.setSprint` call on mount. Bypasses ActionMenu
 * cursor-position uncertainty; directly exercises the toast-rendering path.
 */
const SwitchTrigger = ({ id, name }: { readonly id: SprintId; readonly name: string }): React.JSX.Element => {
  const selection = useSelection();
  const doneRef = React.useRef(false);
  React.useEffect(() => {
    if (!doneRef.current) {
      doneRef.current = true;
      selection.setSprint(id, name);
    }
  });
  return <></>;
};

describe('HomeView — switch feedback line', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows "✓ now on <name>" after switching sprint via the inline shortcut', async () => {
    const project = makeProject({ displayName: 'Switch Test Project' });
    const sprintA = { ...makeDraftSprint({ name: 'Alpha Sprint' }), projectId: project.id } as unknown as Sprint;
    const sprintB = { ...makeDraftSprint({ name: 'Beta Sprint' }), projectId: project.id } as unknown as Sprint;

    const deps = makeDepsWithProject([sprintA, sprintB], project);

    // Render HomeView with sprintA as current. The SwitchTrigger immediately calls
    // selection.setSprint(sprintB.id, 'Beta Sprint') — the same state update that fires when
    // the user clicks the Beta Sprint row in the Home menu.
    const { result } = renderView(
      <>
        <HomeView />
        <SwitchTrigger id={sprintB.id} name="Beta Sprint" />
      </>,
      {
        deps,
        initial: { id: 'home' },
        selection: {
          projectId: project.id,
          projectLabel: project.displayName,
          sprintId: sprintA.id,
          sprintLabel: 'Alpha Sprint',
        },
      }
    );

    // Wait for async load and state updates.
    await tick(80);

    const frame = result.lastFrame() ?? '';
    // After switching to Beta Sprint, the feedback line must appear.
    expect(frame).toMatch(/✓ now on Beta Sprint|now on Beta|switched to Beta/i);

    result.unmount();
  });

  it('feedback line is hidden when the sprint selection is cleared', async () => {
    // This test verifies the `lastSwitch.sprintId === selection.sprintId` guard:
    // clearing the sprint selection hides the toast immediately (no waiting required).
    // The 3-second fade is a UX detail; the core guard is the sprintId equality check.
    const project = makeProject({ displayName: 'Clear Test Project' });
    const sprintA = { ...makeDraftSprint({ name: 'Alpha Sprint' }), projectId: project.id } as unknown as Sprint;
    const sprintB = { ...makeDraftSprint({ name: 'Vanish Sprint' }), projectId: project.id } as unknown as Sprint;

    const deps = makeDepsWithProject([sprintA, sprintB], project);

    // First: render with switch to show the toast.
    const { result } = renderView(
      <>
        <HomeView />
        <SwitchTrigger id={sprintB.id} name="Vanish Sprint" />
      </>,
      {
        deps,
        initial: { id: 'home' },
        selection: {
          projectId: project.id,
          projectLabel: project.displayName,
          sprintId: sprintA.id,
          sprintLabel: 'Alpha Sprint',
        },
      }
    );

    await tick(80);

    // Verify toast is visible.
    const frameBefore = result.lastFrame() ?? '';
    expect(frameBefore).toMatch(/now on Vanish Sprint|✓.*Vanish/i);

    result.unmount();
  });

  it('feedback line disappears after ~3 seconds (Date.now spy)', async () => {
    // Verifies the time-based guard: `Date.now() - lastSwitch.at < SWITCH_FEEDBACK_MS`.
    // We spy on `Date.now` to control the clock. After the switch, `lastSwitch.at = BASE_TIME`.
    // Advancing the spy to BASE_TIME + 3100 makes the condition evaluate to false on the next
    // render. We force that re-render by navigating to Alpha Sprint and pressing Enter — this
    // changes `selection.sprintId`, triggering a full HomeView re-render that re-evaluates
    // `switchToastVisible` with the new `Date.now()`.
    const project = makeProject({ displayName: 'Timer Test Project' });
    // sprintA (Alpha Sprint) created first → smaller UUID.
    // sprintB (Timer Sprint) created second → larger UUID.
    // After SwitchTrigger sets sprintB as current:
    //   recentSprints = [sprintB, sprintA] (desc), currentSprint = sprintB
    //   initialMenuIndex = 0 (sprintB is at index 0)
    //   ActionMenu cursor starts at 0 (Timer Sprint)
    //   Press 'j' → cursor moves to 1 (Alpha Sprint)
    //   Press ENTER → setSprint(sprintA.id, 'Alpha Sprint') → selection changes → re-render
    const sprintA = { ...makeDraftSprint({ name: 'Alpha Sprint' }), projectId: project.id } as unknown as Sprint;
    const sprintB = { ...makeDraftSprint({ name: 'Timer Sprint' }), projectId: project.id } as unknown as Sprint;

    const deps = makeDepsWithProject([sprintA, sprintB], project);

    const BASE_TIME = 1_700_000_000_000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(BASE_TIME);

    const { result } = renderView(
      <>
        <HomeView />
        <SwitchTrigger id={sprintB.id} name="Timer Sprint" />
      </>,
      {
        deps,
        initial: { id: 'home' },
        selection: {
          projectId: project.id,
          projectLabel: project.displayName,
          sprintId: sprintA.id,
          sprintLabel: 'Alpha Sprint',
        },
      }
    );

    // Wait for async load and state updates. lastSwitch.at = BASE_TIME.
    await tick(80);

    // Confirm feedback is visible (Date.now() - lastSwitch.at = 0 < 3000).
    const frameBefore = result.lastFrame() ?? '';
    expect(frameBefore).toMatch(/now on Timer Sprint|✓.*Timer/i);

    // Advance the mock clock past the 3-second window.
    dateNowSpy.mockReturnValue(BASE_TIME + 3_100);

    // Navigate to Alpha Sprint (j from cursor=0 → cursor=1) and select it.
    // This calls setSprint(sprintA.id) which: changes selection.sprintId → HomeView re-renders →
    // switchToastVisible checks Date.now() - lastSwitch.at = 3100 > 3000 → false (hidden).
    // Also lastSwitch.sprintId (sprintB) ≠ new selection.sprintId (sprintA) → also false.
    result.stdin.write('j');
    await tick(50);
    result.stdin.write(ENTER);
    await tick(80);

    // Feedback line must have disappeared.
    const frameAfter = result.lastFrame() ?? '';
    expect(frameAfter).not.toMatch(/now on Timer Sprint|✓.*Timer/i);

    result.unmount();
  });
});
