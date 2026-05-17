/**
 * Unit tests for resolveInitialState — the routing decision launch.ts makes after the
 * side-effecting reads. Covers each branch.
 */

import { describe, expect, it } from 'vitest';
import { resolveInitialState } from '@src/application/ui/tui/launch-routing.ts';
import { ProjectId } from '@src/domain/value/id/project-id.ts';
import { makeProject } from '@tests/fixtures/domain.ts';

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

  it('routes to home with the first project pre-seeded when several exist and nothing was used last', () => {
    const a = makeProject({ id: ProjectId.generate(), slug: 'one', displayName: 'One' });
    const b = makeProject({ id: ProjectId.generate(), slug: 'two', displayName: 'Two' });
    const result = resolveInitialState({ settingsExist: true, projects: [a, b] });
    expect(result.initialView).toEqual({ id: 'home' });
    expect(result.initialSelection).toEqual({ projectId: a.id, projectLabel: 'One' });
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

  it('falls back to the first project when the persisted last-selection no longer exists', () => {
    const a = makeProject({ slug: 'one', displayName: 'One' });
    const result = resolveInitialState({
      settingsExist: true,
      projects: [a],
      // ProjectId values are opaque tags over strings; we cast for the missing-id case.
      lastProjectId: 'does-not-exist' as unknown as typeof a.id,
    });
    expect(result.initialSelection).toEqual({ projectId: a.id, projectLabel: 'One' });
  });
});
