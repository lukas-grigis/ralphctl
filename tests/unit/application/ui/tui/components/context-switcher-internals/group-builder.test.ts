import { describe, expect, it } from 'vitest';
import {
  buildGroups,
  cursorableRowId,
  cursorableRows,
  flatten,
  preferredCursorId,
} from '@src/application/ui/tui/components/context-switcher-internals/group-builder.ts';
import type { PickerData } from '@src/application/ui/tui/components/context-switcher-internals/types.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { makeProject, makeRepository, projectId } from '@tests/fixtures/domain.ts';

const sid = (s: string): SprintId => {
  const r = SprintId.parse(s);
  if (!r.ok) throw new Error('bad sprint id');
  return r.value;
};

const PA = projectId('01900000-0000-7000-8000-0000000000a1');
const PB = projectId('01900000-0000-7000-8000-0000000000a2');
const PX = projectId('01900000-0000-7000-8000-0000000000a9');
const S1 = sid('01900000-0000-7000-8000-0000000010a1');
const S2 = sid('01900000-0000-7000-8000-0000000020a1');
const SB = sid('01900000-0000-7000-8000-0000000010b1');
const SO = sid('01900000-0000-7000-8000-0000000099ff');

const sprint = (id: SprintId, pid: Project['id'], name: string): Sprint =>
  ({ id, slug: name, name, projectId: pid, status: 'draft', tickets: [] }) as unknown as Sprint;

const alpha = makeProject({ id: PA, displayName: 'Alpha', slug: 'alpha', repositories: [makeRepository()] });
const beta = makeProject({ id: PB, displayName: 'Beta', slug: 'beta' });

const data = (sprints: readonly Sprint[], projects: readonly Project[]): PickerData => ({
  sprints,
  projectsById: new Map(projects.map((p) => [p.id, p])),
  taskHealthBySprintId: new Map(),
});

describe('context-switcher group builder', () => {
  const d = data(
    [sprint(S1, PA, 'a1'), sprint(S2, PA, 'a2'), sprint(SB, PB, 'b1'), sprint(SO, PX, 'orphan')],
    [alpha, beta]
  );

  it('orders current project first, newest sprint first, orphans last', () => {
    const groups = buildGroups(d, PB, true);
    expect(groups.map((g) => g.label)).toEqual(['Beta', 'Alpha', 'Unknown project']);
    expect(groups[1]?.sprints.map((s) => s.name)).toEqual(['a2', 'a1']);
  });

  it('carries the project id and repo count on each header', () => {
    const rows = flatten(buildGroups(d, PA, true), false);
    const header = rows.find((r) => r.kind === 'header' && r.label === 'Alpha');
    expect(header).toMatchObject({ projectId: PA, repoCount: 1, orphan: false });
  });

  it('makes project headers cursorable but not the orphan header', () => {
    const rows = flatten(buildGroups(d, PA, true), true);
    const kinds = cursorableRows(rows).map((r) => r.kind);
    expect(kinds.filter((k) => k === 'header')).toHaveLength(2);
    expect(kinds).toContain('create');
    expect(rows.filter((r) => r.kind === 'header' && r.orphan)).toHaveLength(1);
  });

  it('gives every cursorable row a distinct id', () => {
    const rows = cursorableRows(flatten(buildGroups(d, PA, true), true));
    const ids = rows.map(cursorableRowId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('scope current keeps only the current project group', () => {
    expect(buildGroups(d, PA, false).map((g) => g.label)).toEqual(['Alpha']);
  });
});

describe('preferredCursorId', () => {
  const rows = flatten(buildGroups(data([sprint(S1, PA, 'a1'), sprint(SB, PB, 'b1')], [alpha, beta]), PA, true), true);

  it('S (sprint focus) lands on the current sprint', () => {
    expect(preferredCursorId(rows, { focus: 'sprint', sprintId: SB, projectId: PA })).toBe(SB);
  });

  it("P (project focus) lands on the current project's header", () => {
    expect(preferredCursorId(rows, { focus: 'project', sprintId: S1, projectId: PB })).toBe(`project:${PB}`);
  });

  it('falls back to the first sprint, then the first header, then the create row', () => {
    expect(preferredCursorId(rows, { focus: 'sprint', sprintId: undefined, projectId: undefined })).toBe(S1);
    const headersOnly = flatten(buildGroups(data([], [alpha]), PA, true), true);
    expect(preferredCursorId(headersOnly, { focus: 'sprint', sprintId: undefined, projectId: undefined })).toBe(
      `project:${PA}`
    );
    expect(preferredCursorId(flatten([], true), { focus: 'sprint', sprintId: undefined, projectId: undefined })).toBe(
      '__create__'
    );
  });
});
