/**
 * Unit tests for resolveInitialState — the routing decision launch.ts makes after the
 * side-effecting reads. Covers each branch.
 */

import { describe, expect, it } from 'vitest';
import { resolveInitialState } from '@src/application/ui/tui/launch-routing.ts';
import { createSprint, type Sprint } from '@src/domain/entity/sprint.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { makeProject } from '@tests/fixtures/domain.ts';

const sprintId = (s: string): SprintId => {
  const r = SprintId.parse(s);
  if (!r.ok) throw new Error(`bad sprint id fixture: ${r.error.message}`);
  return r.value;
};

/**
 * Deterministic sprint ids. UUIDv7 is lex-sortable and `_HI` is greater than `_LO`, so the
 * routing logic's descending-id sort makes `_HI` the "most recent" — explicit ids avoid the
 * sub-millisecond non-monotonicity of two back-to-back `SprintId.generate()` calls.
 */
const SID_LO = sprintId('01900000-0000-7000-8000-0000000000c1');
const SID_HI = sprintId('01900000-0000-7000-8000-0000000000c9');

/** Minimal draft sprint scoped to a project, with an explicit (lex-sortable) id. */
const makeSprint = (projectId: ProjectId, id: SprintId, name = 'a sprint'): Sprint => {
  const r = createSprint({ id, name, projectId });
  if (!r.ok) throw new Error(`fixture sprint failed: ${r.error.message}`);
  return r.value;
};

/** A sealed `done` sprint — routing must skip it when seeding the most-recent actionable sprint. */
const makeDoneSprint = (projectId: ProjectId, id: SprintId, name = 'a sprint'): Sprint => {
  const ts = IsoTimestamp.parse('2026-01-01T00:00:00.000Z');
  if (!ts.ok) throw new Error(`bad timestamp fixture: ${ts.error.message}`);
  return {
    ...makeSprint(projectId, id, name),
    status: 'done',
    plannedAt: ts.value,
    activatedAt: ts.value,
    reviewAt: ts.value,
    doneAt: ts.value,
  };
};

describe('resolveInitialState', () => {
  it('routes to welcome when no settings file exists', () => {
    const result = resolveInitialState({ settingsExist: false, projects: [] });
    expect(result.initialView).toEqual({ id: 'welcome' });
    expect(result.initialSelection).toBeUndefined();
  });

  it('routes to welcome even when settings missing and projects exist (first run wins)', () => {
    const result = resolveInitialState({ settingsExist: false, projects: [makeProject({})] });
    expect(result.initialView).toEqual({ id: 'welcome' });
  });

  it('routes to create-project when settings exist but no projects', () => {
    const result = resolveInitialState({ settingsExist: true, projects: [] });
    expect(result.initialView).toEqual({ id: 'create-project' });
    expect(result.initialSelection).toBeUndefined();
  });

  it('routes to home with the only project pre-seeded when one exists', () => {
    const project = makeProject({ displayName: 'Mainline', slug: 'mainline' });
    const result = resolveInitialState({ settingsExist: true, projects: [project] });
    expect(result.initialView).toEqual({ id: 'home' });
    expect(result.initialSelection).toEqual({
      projectId: project.id,
      projectLabel: 'Mainline',
    });
  });

  it('routes to home with NO selection when several projects exist and nothing was used last', () => {
    // We must never auto-pick the alphabetically-first of several projects — that dumps the user
    // onto an unrelated project's empty card. Home's StateCard shows the "pick a project" prompt.
    const a = makeProject({ id: ProjectId.generate(), slug: 'one', displayName: 'One' });
    const b = makeProject({ id: ProjectId.generate(), slug: 'two', displayName: 'Two' });
    const result = resolveInitialState({ settingsExist: true, projects: [a, b] });
    expect(result.initialView).toEqual({ id: 'home' });
    expect(result.initialSelection).toBeUndefined();
  });

  it('honours the persisted last-selection when present', () => {
    const a = makeProject({ id: ProjectId.generate(), slug: 'one', displayName: 'One' });
    const b = makeProject({ id: ProjectId.generate(), slug: 'two', displayName: 'Two' });
    const result = resolveInitialState({
      settingsExist: true,
      projects: [a, b],
      lastProjectId: b.id,
    });
    expect(result.initialView).toEqual({ id: 'home' });
    expect(result.initialSelection).toEqual({ projectId: b.id, projectLabel: 'Two' });
  });

  it('falls back to the only project when the persisted last-selection no longer exists', () => {
    // Single-project case: pre-seeding is unambiguous — there's no choice to make.
    const a = makeProject({ slug: 'one', displayName: 'One' });
    const result = resolveInitialState({
      settingsExist: true,
      projects: [a],
      // ProjectId values are opaque tags over strings; we cast for the missing-id case.
      lastProjectId: 'does-not-exist' as unknown as typeof a.id,
    });
    expect(result.initialSelection).toEqual({ projectId: a.id, projectLabel: 'One' });
  });

  it('routes to home with NO selection when the persisted last-selection no longer exists and several projects are present', () => {
    // Deleted remembered project + multiple candidates: never auto-pick the first. Home prompts
    // the user to choose rather than silently landing them on an unrelated project.
    const a = makeProject({ id: ProjectId.generate(), slug: 'one', displayName: 'One' });
    const b = makeProject({ id: ProjectId.generate(), slug: 'two', displayName: 'Two' });
    const result = resolveInitialState({
      settingsExist: true,
      projects: [a, b],
      lastProjectId: ProjectId.generate(),
    });
    expect(result.initialView).toEqual({ id: 'home' });
    expect(result.initialSelection).toBeUndefined();
  });

  it('honours the persisted sprint when the project and sprint both still resolve', () => {
    const a = makeProject({ id: ProjectId.generate(), slug: 'one', displayName: 'One' });
    const older = makeSprint(a.id, SID_LO);
    const remembered = makeSprint(a.id, SID_HI);
    const result = resolveInitialState({
      settingsExist: true,
      projects: [a],
      lastProjectId: a.id,
      lastSprintId: remembered.id,
      sprints: [older, remembered],
    });
    expect(result.initialSelection).toEqual({
      projectId: a.id,
      projectLabel: 'One',
      sprintId: remembered.id,
      sprintLabel: 'a sprint',
    });
  });

  it('falls back to the project most-recent sprint when the remembered sprint was deleted', () => {
    // Remembered project still resolves, but the pinned sprint is gone. Seed the project's
    // most-recent sprint (highest UUIDv7 id) instead of threading a dangling id through.
    const a = makeProject({ id: ProjectId.generate(), slug: 'one', displayName: 'One' });
    const older = makeSprint(a.id, SID_LO);
    const newest = makeSprint(a.id, SID_HI);
    const result = resolveInitialState({
      settingsExist: true,
      projects: [a],
      lastProjectId: a.id,
      lastSprintId: SprintId.generate(),
      sprints: [older, newest],
    });
    expect(result.initialSelection).toEqual({
      projectId: a.id,
      projectLabel: 'One',
      sprintId: newest.id,
      sprintLabel: 'a sprint',
    });
  });

  it('seeds the most-recent sprint of the single auto-seeded project', () => {
    // Single project, no persisted selection → seed it + that project's most-recent sprint.
    const a = makeProject({ id: ProjectId.generate(), slug: 'one', displayName: 'One' });
    const olderA = makeSprint(a.id, SID_LO);
    const newestA = makeSprint(a.id, SID_HI);
    const result = resolveInitialState({
      settingsExist: true,
      projects: [a],
      sprints: [olderA, newestA],
    });
    expect(result.initialSelection).toEqual({
      projectId: a.id,
      projectLabel: 'One',
      sprintId: newestA.id,
      sprintLabel: 'a sprint',
    });
  });

  it('seeds the most-recent NON-done sprint, skipping a more-recent done one', () => {
    // Persisted project resolves, no persisted sprint. The newest sprint is `done`; seed the
    // older open one so the user lands on actionable work, not a sealed sprint.
    const a = makeProject({ id: ProjectId.generate(), slug: 'one', displayName: 'One' });
    const openOlder = makeSprint(a.id, SID_LO, 'open one');
    const doneNewer = makeDoneSprint(a.id, SID_HI, 'sealed one');
    const result = resolveInitialState({
      settingsExist: true,
      projects: [a],
      lastProjectId: a.id,
      sprints: [openOlder, doneNewer],
    });
    expect(result.initialSelection).toEqual({
      projectId: a.id,
      projectLabel: 'One',
      sprintId: openOlder.id,
      sprintLabel: 'open one',
    });
  });

  it('seeds no sprint when the project has only done sprints', () => {
    // No persisted sprint and every sprint is sealed → seed no sprint (empty-sprint card).
    const a = makeProject({ id: ProjectId.generate(), slug: 'one', displayName: 'One' });
    const result = resolveInitialState({
      settingsExist: true,
      projects: [a],
      lastProjectId: a.id,
      sprints: [makeDoneSprint(a.id, SID_HI)],
    });
    expect(result.initialSelection).toEqual({ projectId: a.id, projectLabel: 'One' });
    expect(result.initialSelection?.sprintId).toBeUndefined();
  });

  it('honours a persisted sprint even when it is now done (done-on-boot probe clears it later)', () => {
    // The persisted pick wins regardless of status — SelectionProvider's done-on-boot probe is
    // what clears a sealed sprint to the empty card, not this routing function.
    const a = makeProject({ id: ProjectId.generate(), slug: 'one', displayName: 'One' });
    const sealed = makeDoneSprint(a.id, SID_HI, 'sealed pick');
    const result = resolveInitialState({
      settingsExist: true,
      projects: [a],
      lastProjectId: a.id,
      lastSprintId: sealed.id,
      sprints: [sealed],
    });
    expect(result.initialSelection).toEqual({
      projectId: a.id,
      projectLabel: 'One',
      sprintId: sealed.id,
      sprintLabel: 'sealed pick',
    });
  });

  it('seeds no sprint when the resolved project has none', () => {
    const a = makeProject({ id: ProjectId.generate(), slug: 'one', displayName: 'One' });
    const b = makeProject({ id: ProjectId.generate(), slug: 'two', displayName: 'Two' });
    const result = resolveInitialState({
      settingsExist: true,
      projects: [a],
      sprints: [makeSprint(b.id, SID_HI)],
    });
    expect(result.initialSelection).toEqual({ projectId: a.id, projectLabel: 'One' });
    expect(result.initialSelection?.sprintId).toBeUndefined();
  });

  it('routes to create-project (no selection) when settings exist but there are no projects', () => {
    // No-projects path is unaffected by the auto-default work — still the create-project wizard.
    const result = resolveInitialState({ settingsExist: true, projects: [], sprints: [] });
    expect(result.initialView).toEqual({ id: 'create-project' });
    expect(result.initialSelection).toBeUndefined();
  });

  it('seeds sprintLabel equal to the resolved sprint name', () => {
    const a = makeProject({ id: ProjectId.generate(), slug: 'alpha', displayName: 'Alpha' });
    const s = makeSprint(a.id, SID_HI, 'Sprint Alpha');
    const result = resolveInitialState({
      settingsExist: true,
      projects: [a],
      lastProjectId: a.id,
      lastSprintId: s.id,
      sprints: [s],
    });
    expect(result.initialSelection?.sprintId).toEqual(s.id);
    expect(result.initialSelection?.sprintLabel).toBe('Sprint Alpha');
  });

  it('seeds no sprintLabel when the project has no sprints', () => {
    const a = makeProject({ id: ProjectId.generate(), slug: 'alpha', displayName: 'Alpha' });
    const result = resolveInitialState({
      settingsExist: true,
      projects: [a],
      lastProjectId: a.id,
      sprints: [],
    });
    expect(result.initialSelection?.sprintId).toBeUndefined();
    expect(result.initialSelection?.sprintLabel).toBeUndefined();
  });
});
