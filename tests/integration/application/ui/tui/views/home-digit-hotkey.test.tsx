/**
 * Home digit quick-switch (1-5) — reproduction + regression fence.
 *
 * Reported symptom: pressing a digit on Home (e.g. "2") with >= 2 recent sprints does not
 * switch the current sprint. The mechanism: home-internals/menu-items.ts stamps
 * `hotkey: String(idx + 1)` on each recent-sprint row; action-menu.tsx's `matchHotkey` binds it
 * via a local `useInput` active whenever the menu itself is active.
 *
 * This test drives real stdin through the full Home -> ActionMenu stack (no direct
 * `onSelect()` call — see `menu-items.test.ts` for that unit-level coverage) and observes the
 * shared `SelectionProvider` via a probe component, mirroring the pattern in
 * `execute-view.test.tsx`'s `SelectionProbe`.
 */

import React from 'react';
import { describe, expect, it } from 'vitest';
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
import { makeDraftSprint, makeProject } from '@tests/fixtures/domain.ts';
import { waitFor } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

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

/** Mirrors `execute-view.test.tsx`'s `SelectionProbe` — records every `sprintId` seen. */
const makeSelectionProbe = (seen: Array<SprintId | undefined>): (() => React.JSX.Element | null) =>
  function SelectionProbe(): React.JSX.Element | null {
    const sel = useSelection();
    seen.push(sel.sprintId);
    return null;
  };

describe('HomeView — digit quick-switch hotkeys', () => {
  it('pressing a digit switches the current sprint to the corresponding recent-sprint row', async () => {
    const project = makeProject({ displayName: 'Digit Project' });
    // Created in this order so UUIDv7 lex order is Alpha < Beta; `loadAppStateSnapshot` reverses
    // the list, so recentSprints = [Beta, Alpha] -> hotkeys '1' = Beta, '2' = Alpha.
    const sprintA = { ...makeDraftSprint({ name: 'Alpha Sprint' }), projectId: project.id } as unknown as Sprint;
    const sprintB = { ...makeDraftSprint({ name: 'Beta Sprint' }), projectId: project.id } as unknown as Sprint;
    const deps = makeDepsWithProject([sprintA, sprintB], project);

    const seenSprintIds: Array<SprintId | undefined> = [];
    const SelectionProbe = makeSelectionProbe(seenSprintIds);

    const { result } = renderView(
      <>
        <HomeView />
        <SelectionProbe />
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

    await waitForViewReady(result, (f) => f.includes('Beta Sprint'));
    expect(seenSprintIds.at(-1)).toBe(sprintA.id);

    // '1' maps to the newest non-current recent sprint (Beta) — a real switch.
    result.stdin.write('1');
    await waitFor(() => seenSprintIds.at(-1) === sprintB.id);

    expect(seenSprintIds.at(-1)).toBe(sprintB.id);
    result.unmount();
  });

  it('pressing the digit for the already-selected sprint is a no-op (matches menu-items guard)', async () => {
    const project = makeProject({ displayName: 'Digit Project 2' });
    const sprintA = { ...makeDraftSprint({ name: 'Alpha Sprint' }), projectId: project.id } as unknown as Sprint;
    const sprintB = { ...makeDraftSprint({ name: 'Beta Sprint' }), projectId: project.id } as unknown as Sprint;
    const deps = makeDepsWithProject([sprintA, sprintB], project);

    const seenSprintIds: Array<SprintId | undefined> = [];
    const SelectionProbe = makeSelectionProbe(seenSprintIds);

    const { result } = renderView(
      <>
        <HomeView />
        <SelectionProbe />
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

    await waitForViewReady(result, (f) => f.includes('Beta Sprint'));
    // '2' maps to Alpha (already current) — onSelect's `selectionSprintId` guard makes this a
    // deliberate no-op, not a hotkey failure.
    result.stdin.write('2');
    await new Promise((res) => setTimeout(res, 100));
    expect(seenSprintIds.at(-1)).toBe(sprintA.id);
    result.unmount();
  });
});
