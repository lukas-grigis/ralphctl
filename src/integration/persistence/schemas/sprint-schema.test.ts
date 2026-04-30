import { describe, expect, it } from 'vitest';

import { Sprint } from '../../../domain/entities/sprint.ts';
import { Ticket } from '../../../domain/entities/ticket.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { ProjectName } from '../../../domain/values/project-name.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { fromSprint, sprintJsonSchema, toSprint } from './sprint-schema.ts';

function makeDraftSprint(): Sprint {
  const slug = Slug.parse('demo');
  if (!slug.ok) throw slug.error;
  const r = Sprint.create({
    name: 'Demo sprint',
    slug: slug.value,
    now: IsoTimestamp.trustString('2026-04-29T00:00:00.000Z'),
  });
  if (!r.ok) throw r.error;
  return r.value;
}

function makeTicket(): Ticket {
  const pn = ProjectName.parse('demo-project');
  if (!pn.ok) throw pn.error;
  const r = Ticket.create({ title: 'Add login', projectName: pn.value });
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
    expect(back.value.checkRanAt.size).toBe(0);
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

  it('preserves checkRanAt entries', () => {
    const draft = makeDraftSprint();
    const stamped = draft.recordCheckRun(
      AbsolutePath.trustString('/repo/a'),
      IsoTimestamp.trustString('2026-04-29T03:00:00.000Z')
    );
    const json = fromSprint(stamped);
    const back = toSprint(sprintJsonSchema.parse(json));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.value.checkRanAt.size).toBe(1);
    expect(back.value.checkRanAt.get(AbsolutePath.trustString('/repo/a'))).toBe('2026-04-29T03:00:00.000Z');
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

  it('rejects malformed JSON missing required fields', () => {
    const r = sprintJsonSchema.safeParse({ id: 'x' });
    expect(r.success).toBe(false);
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
