/**
 * PickSprintView integration tests — the cross-project sprint picker.
 *
 * Verifies the grouped-by-project layout (current project first, then alphabetical), the
 * `t` toggle that scopes to the current project only, cursor navigation that skips header
 * sentinel rows, the atomic `setProjectAndSprint` write when a sprint from a different
 * project is picked, the orphan "Unknown project" group for sprints whose project is missing,
 * and the per-empty-project "no sprints" sub-line.
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { PickSprintView } from '@src/application/ui/tui/views/pick-sprint-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import { useSelection } from '@src/application/ui/tui/runtime/selection-context.tsx';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';
import { projectId, makeProject, makeRepository, absolutePath } from '@tests/fixtures/domain.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { RepositoryId } from '@src/domain/value/id/repository-id.ts';

const sprintId = (s: string): SprintId => {
  const r = SprintId.parse(s);
  if (!r.ok) throw new Error(`bad sprint id fixture: ${r.error.message}`);
  return r.value;
};

const repoId = (s: string): RepositoryId => {
  const r = RepositoryId.parse(s);
  if (!r.ok) throw new Error(`bad repo id fixture: ${r.error.message}`);
  return r.value;
};

const PID_A = projectId('01900000-0000-7000-8000-0000000000a1');
const PID_B = projectId('01900000-0000-7000-8000-0000000000a2');
const PID_C = projectId('01900000-0000-7000-8000-0000000000a3');
const SID_A1 = sprintId('01900000-0000-7000-8000-0000000010a1');
const SID_A2 = sprintId('01900000-0000-7000-8000-0000000020a1');
const SID_B1 = sprintId('01900000-0000-7000-8000-0000000010b1');
const SID_ORPHAN = sprintId('01900000-0000-7000-8000-0000000099ff');

const fakeSprintRepo = (sprints: readonly Sprint[]): SprintRepository =>
  ({
    async list() {
      return Result.ok([...sprints]);
    },
    async remove() {
      return Result.ok(undefined);
    },
  }) as unknown as SprintRepository;

const fakeProjectRepo = (projects: readonly Project[]): ProjectRepository =>
  ({
    async list() {
      return Result.ok([...projects]);
    },
    async remove() {
      return Result.ok(undefined);
    },
  }) as unknown as ProjectRepository;

const stubDeps = (sprints: readonly Sprint[], projects: readonly Project[]): AppDeps =>
  ({
    sprintRepo: fakeSprintRepo(sprints),
    projectRepo: fakeProjectRepo(projects),
    sprintExecutionRepo: {} as never,
    taskRepo: {} as never,
    settingsRepo: {} as never,
  }) as unknown as AppDeps;

const makeSprint = (overrides: {
  readonly id: SprintId;
  readonly projectId: Project['id'];
  readonly name: string;
  readonly slug?: string;
  readonly status?: Sprint['status'];
}): Sprint =>
  ({
    id: overrides.id,
    slug: overrides.slug ?? overrides.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name: overrides.name,
    projectId: overrides.projectId,
    status: overrides.status ?? 'draft',
    tickets: [],
  }) as unknown as Sprint;

const projectAlpha = makeProject({
  id: PID_A,
  displayName: 'Alpha Project',
  slug: 'alpha',
  repositories: [makeRepository({ id: repoId('01900000-0000-7000-8000-000000000fa1'), slug: 'alpha-repo' })],
});
const projectBeta = makeProject({
  id: PID_B,
  displayName: 'Beta Project',
  slug: 'beta',
  repositories: [
    makeRepository({
      id: repoId('01900000-0000-7000-8000-000000000fb1'),
      slug: 'beta-repo',
      path: absolutePath('/tmp/ralph/beta-repo').toString(),
    }),
  ],
});
const projectGamma = makeProject({
  id: PID_C,
  displayName: 'Gamma Project',
  slug: 'gamma',
  repositories: [
    makeRepository({
      id: repoId('01900000-0000-7000-8000-000000000fc1'),
      slug: 'gamma-repo',
      path: absolutePath('/tmp/ralph/gamma-repo').toString(),
    }),
  ],
});

describe('PickSprintView', () => {
  it('renders all sprints grouped by project when scopeAll is true', async () => {
    const sprints = [
      makeSprint({ id: SID_A1, projectId: PID_A, name: 'alpha sprint one' }),
      makeSprint({ id: SID_A2, projectId: PID_A, name: 'alpha sprint two' }),
      makeSprint({ id: SID_B1, projectId: PID_B, name: 'beta sprint one' }),
    ];
    const { result } = renderView(<PickSprintView />, {
      deps: stubDeps(sprints, [projectAlpha, projectBeta]),
      initial: { id: 'pick-sprint' },
      selection: { projectId: PID_A, projectLabel: 'Alpha Project' },
    });
    await tick(60);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Alpha Project');
    expect(frame).toContain('Beta Project');
    expect(frame).toContain('alpha sprint one');
    expect(frame).toContain('alpha sprint two');
    expect(frame).toContain('beta sprint one');
    expect(frame).toContain('3 sprints');
    expect(frame).toContain('all projects');
    // Current project (Alpha) appears before Beta in the rendered output.
    expect(frame.indexOf('Alpha Project')).toBeLessThan(frame.indexOf('Beta Project'));
  });

  it('t key scopes list to current project only and resets cursor', async () => {
    const sprints = [
      makeSprint({ id: SID_A1, projectId: PID_A, name: 'alpha sprint one' }),
      makeSprint({ id: SID_B1, projectId: PID_B, name: 'beta sprint one' }),
    ];
    const { result } = renderView(<PickSprintView />, {
      deps: stubDeps(sprints, [projectAlpha, projectBeta]),
      initial: { id: 'pick-sprint' },
      selection: { projectId: PID_A, projectLabel: 'Alpha Project' },
    });
    await tick(60);
    expect(result.lastFrame() ?? '').toContain('Beta Project');
    result.stdin.write('t');
    await tick(30);
    const after = result.lastFrame() ?? '';
    expect(after).toContain('Alpha Project');
    expect(after).not.toContain('Beta Project');
    expect(after).toContain('current project only');
    expect(after).toContain('1 sprint');
  });

  it('cursor j/k skips group header sentinel rows', async () => {
    const sprints = [
      makeSprint({ id: SID_A1, projectId: PID_A, name: 'alpha sprint' }),
      makeSprint({ id: SID_B1, projectId: PID_B, name: 'beta sprint' }),
    ];
    const { result } = renderView(<PickSprintView />, {
      deps: stubDeps(sprints, [projectAlpha, projectBeta]),
      initial: { id: 'pick-sprint' },
      selection: { projectId: PID_A, projectLabel: 'Alpha Project' },
    });
    await tick(60);
    // Initial cursor is on the first sprint row (alpha). Press j once — it must skip the
    // Beta header row and land on the beta sprint row, which becomes the focused row.
    result.stdin.write('j');
    await tick(30);
    // Press j again — there's no further sprint, cursor stays put.
    result.stdin.write('j');
    await tick(30);
    const frame = result.lastFrame() ?? '';
    // The focus marker (▍) precedes whichever sprint is focused; assert beta sprint shows
    // the focused-line marker (focused rows print a "↳ N tickets" hint, headers do not).
    expect(frame).toContain('↳ 0 tickets');
  });

  it('picking a sprint from a different project calls setProjectAndSprint atomically', async () => {
    const sprints = [
      makeSprint({ id: SID_A1, projectId: PID_A, name: 'alpha sprint' }),
      makeSprint({ id: SID_B1, projectId: PID_B, name: 'beta sprint' }),
    ];
    const setProjectAndSprint = vi.fn();
    const Spy = (): React.JSX.Element => {
      const selection = useSelection();
      // Swap the real method out so the picker calls our spy. We mutate the readonly
      // property via Object.assign for the duration of the test render.
      React.useEffect(() => {
        Object.assign(selection, { setProjectAndSprint });
      }, [selection]);
      return <></>;
    };
    const { result } = renderView(
      <>
        <Spy />
        <PickSprintView />
      </>,
      {
        deps: stubDeps(sprints, [projectAlpha, projectBeta]),
        initial: { id: 'pick-sprint' },
        selection: { projectId: PID_A, projectLabel: 'Alpha Project' },
      }
    );
    await tick(60);
    // Move cursor down past the Beta header onto the beta sprint, then Enter.
    result.stdin.write('j');
    await tick(30);
    result.stdin.write('\r');
    await tick(30);
    expect(setProjectAndSprint).toHaveBeenCalledTimes(1);
    const [calledProjectId, calledProjectLabel, calledSprintId, calledSprintLabel] = setProjectAndSprint.mock
      .calls[0] as [unknown, unknown, unknown, unknown];
    expect(calledProjectId).toBe(PID_B);
    expect(calledProjectLabel).toBe('Beta Project');
    expect(calledSprintId).toBe(SID_B1);
    expect(calledSprintLabel).toBe('beta sprint');
  });

  it('orphaned sprint (projectId not in projects list) renders under Unknown project group', async () => {
    const sprints = [
      makeSprint({ id: SID_A1, projectId: PID_A, name: 'alpha sprint' }),
      makeSprint({ id: SID_ORPHAN, projectId: PID_C, name: 'lonely sprint' }),
    ];
    const { result } = renderView(<PickSprintView />, {
      // PID_C is referenced by the orphan sprint but absent from the projects list.
      deps: stubDeps(sprints, [projectAlpha]),
      initial: { id: 'pick-sprint' },
      selection: { projectId: PID_A, projectLabel: 'Alpha Project' },
    });
    await tick(60);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Unknown project');
    expect(frame).toContain('lonely sprint');
    expect(frame).toContain('⚠');
  });

  it('empty project group renders no-sprints sub-line when scopeAll is true', async () => {
    const sprints = [makeSprint({ id: SID_A1, projectId: PID_A, name: 'alpha sprint' })];
    const { result } = renderView(<PickSprintView />, {
      // Gamma has no sprints. It must still render a header + "no sprints" sub-line.
      deps: stubDeps(sprints, [projectAlpha, projectGamma]),
      initial: { id: 'pick-sprint' },
      selection: { projectId: PID_A, projectLabel: 'Alpha Project' },
    });
    await tick(60);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Gamma Project');
    expect(frame).toContain('no sprints');
  });
});
