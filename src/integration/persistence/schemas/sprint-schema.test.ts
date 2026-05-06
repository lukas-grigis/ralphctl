import { describe, expect, it } from 'vitest';

import { Sprint } from '@src/domain/entities/sprint.ts';
import { Ticket } from '@src/domain/entities/ticket.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { fromSprint, sprintJsonSchema, toSprint } from './sprint-schema.ts';

function makeDraftSprint(): Sprint {
  const slug = Slug.parse('demo');
  if (!slug.ok) throw slug.error;
  const pn = ProjectName.parse('demo-project');
  if (!pn.ok) throw pn.error;
  const r = Sprint.create({
    name: 'Demo sprint',
    slug: slug.value,
    now: IsoTimestamp.trustString('2026-04-29T00:00:00.000Z'),
    projectName: pn.value,
  });
  if (!r.ok) throw r.error;
  return r.value;
}

function makeTicket(): Ticket {
  const r = Ticket.create({ title: 'Add login' });
  if (!r.ok) throw r.error;
  return r.value;
}

describe('sprint-schema', () => {
  it('round-trips a draft sprint with no tickets', () => {
    const original = makeDraftSprint();
    const json = fromSprint(original);
    const parsed = sprintJsonSchema.safeParse(json);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const back = toSprint(parsed.data);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.id).toBe(original.id);
    expect(back.value.name).toBe(original.name);
    expect(back.value.status).toBe('draft');
    expect(back.value.tickets).toHaveLength(0);
    expect(back.value.branch).toBeNull();
    expect(back.value.setupRanAt.size).toBe(0);
    expect(String(back.value.projectName)).toBe('demo-project');
    expect(back.value.affectedRepositories).toStrictEqual([]);
  });

  it('round-trips a sprint with one ticket', () => {
    const draft = makeDraftSprint();
    const added = draft.addTicket(makeTicket());
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    const json = fromSprint(added.value);
    const back = toSprint(sprintJsonSchema.parse(json));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.tickets).toHaveLength(1);
    expect(back.value.tickets[0]?.title).toBe('Add login');
  });

  it('round-trips an active sprint', () => {
    const draft = makeDraftSprint();
    const active = draft.activate(IsoTimestamp.trustString('2026-04-29T01:00:00.000Z'));
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    const json = fromSprint(active.value);
    const back = toSprint(sprintJsonSchema.parse(json));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.status).toBe('active');
    expect(back.value.activatedAt).toBe('2026-04-29T01:00:00.000Z');
  });

  it('round-trips a closed sprint', () => {
    const draft = makeDraftSprint();
    const active = draft.activate(IsoTimestamp.trustString('2026-04-29T01:00:00.000Z'));
    if (!active.ok) throw active.error;
    const closed = active.value.close(IsoTimestamp.trustString('2026-04-29T02:00:00.000Z'));
    if (!closed.ok) throw closed.error;
    const json = fromSprint(closed.value);
    const back = toSprint(sprintJsonSchema.parse(json));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.status).toBe('closed');
    expect(back.value.closedAt).toBe('2026-04-29T02:00:00.000Z');
  });

  it('preserves setupRanAt entries', () => {
    const draft = makeDraftSprint();
    const stamped = draft.recordSetupRun(
      AbsolutePath.trustString('/repo/a'),
      IsoTimestamp.trustString('2026-04-29T03:00:00.000Z')
    );
    const json = fromSprint(stamped);
    const back = toSprint(sprintJsonSchema.parse(json));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.setupRanAt.size).toBe(1);
    expect(back.value.setupRanAt.get(AbsolutePath.trustString('/repo/a'))).toBe('2026-04-29T03:00:00.000Z');
  });

  it('preserves branch when set', () => {
    const draft = makeDraftSprint();
    const branched = draft.setBranch('feature/login');
    if (!branched.ok) throw branched.error;
    const json = fromSprint(branched.value);
    const back = toSprint(sprintJsonSchema.parse(json));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.branch).toBe('feature/login');
  });

  it('preserves affectedRepositories when set', () => {
    const draft = makeDraftSprint();
    const withRepos = draft.setAffectedRepositories([
      AbsolutePath.trustString('/abs/repo-a'),
      AbsolutePath.trustString('/abs/repo-b'),
    ]);
    if (!withRepos.ok) throw withRepos.error;
    const json = fromSprint(withRepos.value);
    expect(json.affectedRepositories).toStrictEqual(['/abs/repo-a', '/abs/repo-b']);
    const back = toSprint(sprintJsonSchema.parse(json));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.affectedRepositories).toStrictEqual(['/abs/repo-a', '/abs/repo-b']);
  });

  it('rejects malformed JSON missing required fields', () => {
    const r = sprintJsonSchema.safeParse({ id: 'x' });
    expect(r.success).toBe(false);
  });

  it('rejects old-shape JSON missing the top-level projectName', () => {
    // Simulate a 0.5.x-shape sprint.json — projectName lives on each ticket
    // (not at the top level), and the top-level affectedRepositories key is
    // absent. Both the missing top-level fields are required by 0.6.0; Zod
    // must reject the document outright.
    const oldShape = {
      id: '20260429-141522-demo',
      name: 'Demo sprint',
      status: 'draft',
      createdAt: '2026-04-29T00:00:00.000Z',
      activatedAt: null,
      closedAt: null,
      branch: null,
      pullRequestUrl: null,
      setupRanAt: {},
      tickets: [
        {
          id: 'aaaaaaaa',
          title: 'Add login',
          // legacy: projectName / affectedRepositories at the ticket level
          projectName: 'demo-project',
          affectedRepositories: [],
          requirementStatus: 'pending',
        },
      ],
    };
    const r = sprintJsonSchema.safeParse(oldShape);
    expect(r.success).toBe(false);
    if (r.success) return;
    // The error must call out the missing top-level keys.
    const paths = r.error.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('projectName');
    expect(paths).toContain('affectedRepositories');
  });

  it('round-trips a sprint with a recorded pullRequestUrl', () => {
    const draft = makeDraftSprint();
    const recorded = draft.recordPullRequestUrl('https://github.com/foo/bar/pull/42');
    if (!recorded.ok) throw recorded.error;
    const json = fromSprint(recorded.value);
    expect(json.pullRequestUrl).toBe('https://github.com/foo/bar/pull/42');
    const back = toSprint(sprintJsonSchema.parse(json));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.pullRequestUrl).toBe('https://github.com/foo/bar/pull/42');
  });

  it('loads legacy sprint.json without pullRequestUrl (defaults to null)', () => {
    const original = makeDraftSprint();
    // Simulate a legacy on-disk shape — no pullRequestUrl key at all.
    const legacy = { ...fromSprint(original) } as Record<string, unknown>;
    delete legacy['pullRequestUrl'];
    const parsed = sprintJsonSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const back = toSprint(parsed.data);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.pullRequestUrl).toBeNull();
  });
});
