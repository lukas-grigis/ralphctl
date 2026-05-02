import { describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import type { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { TicketId } from '@src/domain/values/ticket-id.ts';
import { Sprint } from './sprint.ts';
import { Ticket } from './ticket.ts';

function slug(s: string): Slug {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function projectName(): ProjectName {
  const r = ProjectName.parse('demo-project');
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function ticket(id?: string): Ticket {
  const idVo = id !== undefined ? TicketId.parse(id) : undefined;
  if (idVo !== undefined && !idVo.ok) throw new Error('precondition failed');
  const r = Ticket.create({
    id: idVo?.ok ? idVo.value : undefined,
    title: 't',
  });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

function path(p: string): AbsolutePath {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

const T0 = '2026-04-29T14:15:22.000Z' as IsoTimestamp;
const T1 = '2026-04-29T15:00:00.000Z' as IsoTimestamp;
const T2 = '2026-04-29T16:00:00.000Z' as IsoTimestamp;

function draft(): Sprint {
  const r = Sprint.create({
    name: 'My Sprint',
    slug: slug('my-sprint'),
    now: T0,
    projectName: projectName(),
  });
  if (!r.ok) throw new Error('precondition failed');
  return r.value;
}

describe('Sprint.create', () => {
  it('builds a draft sprint with empty tickets and no branch', () => {
    const s = draft();
    expect(s.status).toBe('draft');
    expect(s.tickets).toStrictEqual([]);
    expect(s.activatedAt).toBeNull();
    expect(s.closedAt).toBeNull();
    expect(s.checkRanAt.size).toBe(0);
    expect(s.branch).toBeNull();
    expect(s.createdAt).toBe(T0);
    expect(s.id).toMatch(/^\d{8}-\d{6}-my-sprint$/);
  });

  it('captures the projectName and defaults affectedRepositories to []', () => {
    const s = draft();
    expect(String(s.projectName)).toBe('demo-project');
    expect(s.affectedRepositories).toStrictEqual([]);
  });

  it('honors an explicit affectedRepositories at create time', () => {
    const r = Sprint.create({
      name: 'With repos',
      slug: slug('wr'),
      now: T0,
      projectName: projectName(),
      affectedRepositories: [path('/abs/a'), path('/abs/b')],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.affectedRepositories).toStrictEqual(['/abs/a', '/abs/b']);
  });

  it('rejects empty / whitespace name', () => {
    const r = Sprint.create({
      name: '   ',
      slug: slug('x'),
      now: T0,
      projectName: projectName(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('sprint.name');
  });

  it('trims the name', () => {
    const r = Sprint.create({
      name: '  Cool Sprint  ',
      slug: slug('x'),
      now: T0,
      projectName: projectName(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('Cool Sprint');
  });
});

describe('Sprint.activate', () => {
  it('moves draft → active and stamps activatedAt', () => {
    const r = draft().activate(T1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('active');
    expect(r.value.activatedAt).toBe(T1);
  });

  it('refuses to activate an already-active sprint', () => {
    const a = draft().activate(T1);
    if (!a.ok) throw new Error('precondition failed');
    const a2 = a.value.activate(T2);
    expect(a2.ok).toBe(false);
    if (!a2.ok) {
      expect(a2.error.code).toBe('invalid-state');
      expect(a2.error.currentState).toBe('active');
    }
  });

  it('does not mutate the original', () => {
    const s = draft();
    s.activate(T1);
    expect(s.status).toBe('draft');
    expect(s.activatedAt).toBeNull();
  });
});

describe('Sprint.close', () => {
  it('moves active → closed, stamps closedAt, and clears checkRanAt', () => {
    const a = draft().activate(T1);
    if (!a.ok) throw new Error('precondition failed');
    const stamped = a.value.recordCheckRun(path('/abs/repo'), T1);
    expect(stamped.checkRanAt.size).toBe(1);

    const c = stamped.close(T2);
    expect(c.ok).toBe(true);
    if (!c.ok) return;
    expect(c.value.status).toBe('closed');
    expect(c.value.closedAt).toBe(T2);
    expect(c.value.checkRanAt.size).toBe(0);
  });

  it('refuses to close a draft', () => {
    const c = draft().close(T2);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.error.attemptedAction).toBe('close');
  });

  it('refuses to close an already-closed sprint', () => {
    const a = draft().activate(T1);
    if (!a.ok) throw new Error('precondition failed');
    const c = a.value.close(T2);
    if (!c.ok) throw new Error('precondition failed');
    const c2 = c.value.close(T2);
    expect(c2.ok).toBe(false);
  });
});

describe('Sprint ticket management', () => {
  it('addTicket appends in draft', () => {
    const s = draft();
    const r = s.addTicket(ticket('aaaaaaaa'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tickets).toHaveLength(1);
    expect(r.value.tickets[0]?.id).toBe('aaaaaaaa');
  });

  it('addTicket rejects duplicate ids with a ConflictError', () => {
    const s = draft();
    const first = s.addTicket(ticket('deadbeef'));
    if (!first.ok) throw new Error('precondition failed');
    const dup = first.value.addTicket(ticket('deadbeef'));
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.error.code).toBe('conflict');
      if (dup.error.code === 'conflict') {
        expect(dup.error.conflictingId).toBe('deadbeef');
      }
    }
  });

  it('addTicket fails outside draft', () => {
    const a = draft().activate(T1);
    if (!a.ok) throw new Error('precondition failed');
    const r = a.value.addTicket(ticket('aaaaaaaa'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid-state');
  });

  it('removeTicket drops the matching id', () => {
    const s = draft();
    const a = s.addTicket(ticket('aaaaaaaa'));
    if (!a.ok) throw new Error('precondition failed');
    const b = a.value.addTicket(ticket('bbbbbbbb'));
    if (!b.ok) throw new Error('precondition failed');
    const tid = TicketId.parse('aaaaaaaa');
    if (!tid.ok) throw new Error('precondition failed');
    const r = b.value.removeTicket(tid.value);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tickets.map((t) => t.id)).toStrictEqual(['bbbbbbbb']);
  });

  it('removeTicket fails outside draft', () => {
    const a = draft().activate(T1);
    if (!a.ok) throw new Error('precondition failed');
    const tid = TicketId.parse('aaaaaaaa');
    if (!tid.ok) throw new Error('precondition failed');
    const r = a.value.removeTicket(tid.value);
    expect(r.ok).toBe(false);
  });

  it('replaceTicket swaps the ticket with the same id', () => {
    const s = draft();
    const t1 = ticket('aaaaaaaa');
    const a = s.addTicket(t1);
    if (!a.ok) throw new Error('precondition failed');

    const approved = t1.approveRequirements('REQ');
    if (!approved.ok) throw new Error('precondition failed');
    const tid = TicketId.parse('aaaaaaaa');
    if (!tid.ok) throw new Error('precondition failed');

    const r = a.value.replaceTicket(tid.value, approved.value);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.tickets[0]?.requirementStatus).toBe('approved');
  });

  it('replaceTicket fails outside draft', () => {
    const a = draft().activate(T1);
    if (!a.ok) throw new Error('precondition failed');
    const tid = TicketId.parse('aaaaaaaa');
    if (!tid.ok) throw new Error('precondition failed');
    const r = a.value.replaceTicket(tid.value, ticket('aaaaaaaa'));
    expect(r.ok).toBe(false);
  });

  it('addTicket does not mutate the original tickets array', () => {
    const s = draft();
    const before = s.tickets;
    s.addTicket(ticket('aaaaaaaa'));
    expect(s.tickets).toBe(before);
    expect(s.tickets).toHaveLength(0);
  });
});

describe('Sprint.setBranch', () => {
  it('sets a branch in draft', () => {
    const r = draft().setBranch('feature/x');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.branch).toBe('feature/x');
  });

  it('sets a branch in active', () => {
    const a = draft().activate(T1);
    if (!a.ok) throw new Error('precondition failed');
    const r = a.value.setBranch('feature/y');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.branch).toBe('feature/y');
  });

  it('refuses to set a branch on a closed sprint', () => {
    const a = draft().activate(T1);
    if (!a.ok) throw new Error('precondition failed');
    const c = a.value.close(T2);
    if (!c.ok) throw new Error('precondition failed');
    const r = c.value.setBranch('feature/z');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.attemptedAction).toBe('set-branch');
  });
});

describe('Sprint.rename', () => {
  it('updates the name on a draft sprint', () => {
    const r = draft().rename('Renamed');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('Renamed');
  });

  it('updates the name on an active sprint', () => {
    const a = draft().activate(T1);
    if (!a.ok) throw new Error('precondition failed');
    const r = a.value.rename('Active Rename');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('Active Rename');
  });

  it('trims the new name', () => {
    const r = draft().rename('  Trim Me  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.name).toBe('Trim Me');
  });

  it('rejects an empty / whitespace name', () => {
    const r = draft().rename('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid-value');
  });

  it('refuses to rename a closed sprint', () => {
    const a = draft().activate(T1);
    if (!a.ok) throw new Error('precondition failed');
    const c = a.value.close(T2);
    if (!c.ok) throw new Error('precondition failed');
    const r = c.value.rename('Too Late');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('invalid-state');
  });
});

describe('Sprint.clearBranch', () => {
  it('clears a previously-set branch on a draft sprint', () => {
    const set = draft().setBranch('feature/x');
    if (!set.ok) throw new Error('precondition failed');
    const cleared = set.value.clearBranch();
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.branch).toBeNull();
  });

  it('refuses to clear a branch on a closed sprint', () => {
    const a = draft().activate(T1);
    if (!a.ok) throw new Error('precondition failed');
    const c = a.value.close(T2);
    if (!c.ok) throw new Error('precondition failed');
    const cleared = c.value.clearBranch();
    expect(cleared.ok).toBe(false);
    if (!cleared.ok) expect(cleared.error.attemptedAction).toBe('clear-branch');
  });
});

describe('Sprint.recordCheckRun', () => {
  it('stamps a repo with the timestamp', () => {
    const s = draft().recordCheckRun(path('/abs/r'), T1);
    expect(s.checkRanAt.get(path('/abs/r'))).toBe(T1);
  });

  it('overwrites a prior entry for the same repo', () => {
    const s1 = draft().recordCheckRun(path('/abs/r'), T1);
    const s2 = s1.recordCheckRun(path('/abs/r'), T2);
    expect(s2.checkRanAt.size).toBe(1);
    expect(s2.checkRanAt.get(path('/abs/r'))).toBe(T2);
  });

  it('does not mutate the original map', () => {
    const s1 = draft().recordCheckRun(path('/abs/r'), T1);
    s1.recordCheckRun(path('/abs/r'), T2);
    expect(s1.checkRanAt.get(path('/abs/r'))).toBe(T1);
  });
});

describe('Sprint.recordPullRequestUrl', () => {
  it('records a valid https URL on a draft sprint', () => {
    const r = draft().recordPullRequestUrl('https://github.com/foo/bar/pull/1');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.pullRequestUrl).toBe('https://github.com/foo/bar/pull/1');
  });

  it('records a URL even on a closed sprint (legacy behavior)', () => {
    const a = draft().activate(T1);
    if (!a.ok) throw new Error('precondition failed');
    const c = a.value.close(T2);
    if (!c.ok) throw new Error('precondition failed');
    const r = c.value.recordPullRequestUrl('https://gitlab.com/g/p/-/merge_requests/9');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.pullRequestUrl).toBe('https://gitlab.com/g/p/-/merge_requests/9');
  });

  it('trims whitespace before validating', () => {
    const r = draft().recordPullRequestUrl('  https://github.com/x/y/pull/2  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.pullRequestUrl).toBe('https://github.com/x/y/pull/2');
  });

  it('rejects empty / whitespace-only urls', () => {
    expect(draft().recordPullRequestUrl('').ok).toBe(false);
    expect(draft().recordPullRequestUrl('   ').ok).toBe(false);
  });

  it('rejects non-URL strings', () => {
    const r = draft().recordPullRequestUrl('not a url');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('sprint.pullRequestUrl');
  });

  it('rejects URLs with non-http(s) protocols', () => {
    const r = draft().recordPullRequestUrl('ftp://example.com/x');
    expect(r.ok).toBe(false);
  });

  it('does not mutate the original', () => {
    const s = draft();
    s.recordPullRequestUrl('https://github.com/x/y/pull/3');
    expect(s.pullRequestUrl).toBeNull();
  });

  it('defaults pullRequestUrl to null on create', () => {
    expect(draft().pullRequestUrl).toBeNull();
  });
});

describe('Sprint.setAffectedRepositories', () => {
  it('records the repo list on a draft sprint', () => {
    const r = draft().setAffectedRepositories([path('/abs/a'), path('/abs/b')]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.affectedRepositories).toStrictEqual(['/abs/a', '/abs/b']);
  });

  it('records the repo list on an active sprint', () => {
    const a = draft().activate(T1);
    if (!a.ok) throw new Error('precondition failed');
    const r = a.value.setAffectedRepositories([path('/abs/c')]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.affectedRepositories).toStrictEqual(['/abs/c']);
  });

  it('overwrites a prior selection (idempotent)', () => {
    const first = draft().setAffectedRepositories([path('/abs/a')]);
    if (!first.ok) throw new Error('precondition failed');
    const second = first.value.setAffectedRepositories([path('/abs/b'), path('/abs/c')]);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.affectedRepositories).toStrictEqual(['/abs/b', '/abs/c']);
  });

  it('accepts an empty list (clears prior selection)', () => {
    const first = draft().setAffectedRepositories([path('/abs/a')]);
    if (!first.ok) throw new Error('precondition failed');
    const cleared = first.value.setAffectedRepositories([]);
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.affectedRepositories).toStrictEqual([]);
  });

  it('refuses to set repos on a closed sprint', () => {
    const a = draft().activate(T1);
    if (!a.ok) throw new Error('precondition failed');
    const c = a.value.close(T2);
    if (!c.ok) throw new Error('precondition failed');
    const r = c.value.setAffectedRepositories([path('/abs/x')]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('invalid-state');
      expect(r.error.attemptedAction).toBe('set-affected-repositories');
    }
  });

  it('does not mutate the original instance', () => {
    const s = draft();
    s.setAffectedRepositories([path('/abs/a')]);
    expect(s.affectedRepositories).toStrictEqual([]);
  });

  it('copies the input array (defensive against later mutation)', () => {
    const input: AbsolutePath[] = [path('/abs/a')];
    const r = draft().setAffectedRepositories(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Mutating the caller's array must not affect the entity's snapshot.
    input.push(path('/abs/b'));
    expect(r.value.affectedRepositories).toStrictEqual(['/abs/a']);
  });
});

describe('Sprint derivations', () => {
  it('hasApprovedAllTickets is trivially true for no tickets', () => {
    expect(draft().hasApprovedAllTickets()).toBe(true);
  });

  it('hasApprovedAllTickets is false while any ticket is pending', () => {
    const s = draft();
    const a = s.addTicket(ticket('aaaaaaaa'));
    if (!a.ok) throw new Error('precondition failed');
    expect(a.value.hasApprovedAllTickets()).toBe(false);
  });

  it('hasApprovedAllTickets is true once all tickets are approved', () => {
    const t1 = ticket('aaaaaaaa');
    const t1Approved = t1.approveRequirements('a');
    if (!t1Approved.ok) throw new Error('precondition failed');
    const t2 = ticket('bbbbbbbb');
    const t2Approved = t2.approveRequirements('b');
    if (!t2Approved.ok) throw new Error('precondition failed');

    let s = draft();
    const r1 = s.addTicket(t1Approved.value);
    if (!r1.ok) throw new Error('precondition failed');
    s = r1.value;
    const r2 = s.addTicket(t2Approved.value);
    if (!r2.ok) throw new Error('precondition failed');

    expect(r2.value.hasApprovedAllTickets()).toBe(true);
  });

  it('ticketById returns the matching ticket or undefined', () => {
    const s = draft();
    const r = s.addTicket(ticket('aaaaaaaa'));
    if (!r.ok) throw new Error('precondition failed');
    const tid = TicketId.parse('aaaaaaaa');
    const missing = TicketId.parse('cccccccc');
    if (!tid.ok || !missing.ok) throw new Error('precondition failed');
    expect(r.value.ticketById(tid.value)?.id).toBe('aaaaaaaa');
    expect(r.value.ticketById(missing.value)).toBeUndefined();
  });
});
