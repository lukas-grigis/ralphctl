import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { IssuePusher, IssueTrackerOrigin } from '@src/business/scm/issue-pusher.ts';
import { refinementCommentBody } from '@src/business/scm/refinement-comment.ts';
import { publishTicketToTracker } from '@src/business/ticket/publish-to-tracker.ts';
import { addTicket } from '@src/domain/entity/sprint.ts';
import { setTicketLink } from '@src/domain/entity/ticket.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { TicketId } from '@src/domain/value/id/ticket-id.ts';
import { absolutePath, makeApprovedTicket, makeDraftSprint, makePendingTicket } from '@tests/fixtures/domain.ts';

const CWD = absolutePath('/repo');
const ISSUE_URL = 'https://github.com/x/y/issues/42';
const ORIGIN: IssueTrackerOrigin = {
  provider: 'github',
  hostname: 'github.com',
  owner: 'x',
  repo: 'y',
};

interface PusherCalls {
  resolveOrigin: number;
  create: Array<{ title: string; body: string }>;
  listComments: string[];
  comment: Array<{ url: string; body: string }>;
}

const recordingPusher = (opts?: {
  origin?: Result<IssueTrackerOrigin | null, StorageError>;
  create?: Result<{ url: string }, StorageError>;
  comments?: Result<readonly string[], StorageError>;
  comment?: Result<void, StorageError>;
}): { pusher: IssuePusher; calls: PusherCalls } => {
  const calls: PusherCalls = { resolveOrigin: 0, create: [], listComments: [], comment: [] };
  const pusher: IssuePusher = {
    async resolveOrigin() {
      calls.resolveOrigin += 1;
      return opts?.origin ?? Result.ok(ORIGIN);
    },
    async create(args) {
      calls.create.push({ title: args.title, body: args.body });
      return opts?.create ?? Result.ok({ url: ISSUE_URL });
    },
    async listComments(url) {
      calls.listComments.push(url);
      return opts?.comments ?? Result.ok([]);
    },
    async comment(url, args) {
      calls.comment.push({ url, body: args.body });
      return opts?.comment ?? Result.ok(undefined);
    },
  };
  return { pusher, calls };
};

describe('publishTicketToTracker', () => {
  it('creates on a missing link, stores the returned URL, and does not comment', async () => {
    const ticket = makeApprovedTicket({ title: 'Add the thing', requirements: 'do it' });
    const sprint = makeDraftSprint({ tickets: [ticket] });
    const { pusher, calls } = recordingPusher();

    const r = await publishTicketToTracker({ sprint, ticketId: ticket.id, cwd: CWD, issuePusher: pusher });

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('created');
    expect(r.value.sprint.tickets[0]?.link).toBe(ISSUE_URL);
    expect(r.value.sprint.tickets[0]?.externalRef).toBe('#42');
    expect(calls.resolveOrigin).toBe(1);
    expect(calls.create).toEqual([{ title: 'Add the thing', body: '' }]);
    expect(calls.comment).toEqual([]);
    expect(calls.listComments).toEqual([]);
  });

  it('passes the ticket description as the create body when present', async () => {
    const pending = makePendingTicket({ title: 'with desc' });
    const ticket = { ...pending, description: 'longer writeup' };
    const seeded = addTicket(makeDraftSprint({ tickets: [] }), ticket);
    if (!seeded.ok) throw new Error(seeded.error.message);
    const { pusher, calls } = recordingPusher();

    const r = await publishTicketToTracker({
      sprint: seeded.value,
      ticketId: ticket.id,
      cwd: CWD,
      issuePusher: pusher,
    });

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.outcome).toBe('created');
    expect(calls.create).toEqual([{ title: 'with desc', body: 'longer writeup' }]);
  });

  it('rejects an unknown ticket without calling the tracker', async () => {
    const sprint = makeDraftSprint({ tickets: [makeApprovedTicket()] });
    const { pusher, calls } = recordingPusher();
    const r = await publishTicketToTracker({
      sprint,
      ticketId: TicketId.generate(),
      cwd: CWD,
      issuePusher: pusher,
    });
    expect(r.ok).toBe(false);
    expect(calls.resolveOrigin).toBe(0);
    expect(calls.create).toEqual([]);
    expect(calls.comment).toEqual([]);
  });

  it('rejects an empty title on the create path without calling the tracker', async () => {
    const ticket = { ...makeApprovedTicket(), title: '' };
    const sprint = makeDraftSprint({ tickets: [ticket] });
    const { pusher, calls } = recordingPusher();
    const r = await publishTicketToTracker({ sprint, ticketId: ticket.id, cwd: CWD, issuePusher: pusher });
    expect(r.ok).toBe(false);
    expect(sprint.tickets[0]?.link).toBeUndefined();
    expect(calls.resolveOrigin).toBe(0);
    expect(calls.create).toEqual([]);
    expect(calls.comment).toEqual([]);
  });

  it('rejects a whitespace title on the create path without calling the tracker', async () => {
    const ticket = { ...makeApprovedTicket(), title: '   ' };
    const sprint = makeDraftSprint({ tickets: [ticket] });
    const { pusher, calls } = recordingPusher();
    const r = await publishTicketToTracker({ sprint, ticketId: ticket.id, cwd: CWD, issuePusher: pusher });
    expect(r.ok).toBe(false);
    expect(calls.create).toEqual([]);
    expect(calls.comment).toEqual([]);
  });

  it('returns the resolve error and does not create when origin resolution fails', async () => {
    const ticket = makeApprovedTicket();
    const sprint = makeDraftSprint({ tickets: [ticket] });
    const originError = new StorageError({ subCode: 'io', message: 'git not installed' });
    const { pusher, calls } = recordingPusher({ origin: Result.error(originError) });
    const r = await publishTicketToTracker({ sprint, ticketId: ticket.id, cwd: CWD, issuePusher: pusher });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(originError);
    expect(calls.create).toEqual([]);
    expect(r.ok ? r.value.sprint : sprint).toBe(sprint);
  });

  it('returns a failure and does not create when origin is null', async () => {
    const ticket = makeApprovedTicket();
    const sprint = makeDraftSprint({ tickets: [ticket] });
    const { pusher, calls } = recordingPusher({ origin: Result.ok(null) });
    const r = await publishTicketToTracker({ sprint, ticketId: ticket.id, cwd: CWD, issuePusher: pusher });
    expect(r.ok).toBe(false);
    expect(calls.create).toEqual([]);
    expect(calls.comment).toEqual([]);
  });

  it('leaves the sprint unchanged when create fails', async () => {
    const ticket = makeApprovedTicket();
    const sprint = makeDraftSprint({ tickets: [ticket] });
    const createError = new StorageError({ subCode: 'io', message: 'gh: not authenticated' });
    const { pusher } = recordingPusher({ create: Result.error(createError) });
    const r = await publishTicketToTracker({ sprint, ticketId: ticket.id, cwd: CWD, issuePusher: pusher });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(createError);
    expect(sprint.tickets[0]?.link).toBeUndefined();
  });

  it('never calls create when the ticket already has a link', async () => {
    const linked = setTicketLink(makeApprovedTicket({ requirements: 'the reqs' }), ISSUE_URL);
    if (!linked.ok) throw new Error(linked.error.message);
    const sprint = makeDraftSprint({ tickets: [linked.value] });
    const { pusher, calls } = recordingPusher();
    const r = await publishTicketToTracker({ sprint, ticketId: linked.value.id, cwd: CWD, issuePusher: pusher });
    expect(r.ok).toBe(true);
    expect(calls.create).toEqual([]);
    expect(calls.resolveOrigin).toBe(0);
    if (r.ok) expect(r.value.outcome).toBe('commented');
  });

  it('skips comment when the refinement body is already present', async () => {
    const requirements = '## Acceptance\n- already posted';
    const linked = setTicketLink(makeApprovedTicket({ requirements }), ISSUE_URL);
    if (!linked.ok) throw new Error(linked.error.message);
    const sprint = makeDraftSprint({ tickets: [linked.value] });
    const body = refinementCommentBody(requirements);
    const { pusher, calls } = recordingPusher({ comments: Result.ok(['noise', body]) });
    const r = await publishTicketToTracker({ sprint, ticketId: linked.value.id, cwd: CWD, issuePusher: pusher });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.outcome).toBe('already-up-to-date');
    expect(calls.create).toEqual([]);
    expect(calls.comment).toEqual([]);
    expect(calls.listComments).toEqual([ISSUE_URL]);
  });

  it('comments with the refinement body when it is not yet on the issue', async () => {
    const requirements = '## Acceptance\n- new criterion';
    const linked = setTicketLink(makeApprovedTicket({ requirements }), ISSUE_URL);
    if (!linked.ok) throw new Error(linked.error.message);
    const sprint = makeDraftSprint({ tickets: [linked.value] });
    const { pusher, calls } = recordingPusher({ comments: Result.ok(['unrelated']) });
    const r = await publishTicketToTracker({ sprint, ticketId: linked.value.id, cwd: CWD, issuePusher: pusher });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.outcome).toBe('commented');
    expect(calls.comment).toEqual([{ url: ISSUE_URL, body: refinementCommentBody(requirements) }]);
  });

  it('does not skip a closed-issue refusal — the tracker failure is returned', async () => {
    const linked = setTicketLink(makeApprovedTicket({ requirements: 'reqs' }), ISSUE_URL);
    if (!linked.ok) throw new Error(linked.error.message);
    const sprint = makeDraftSprint({ tickets: [linked.value] });
    const refusal = new StorageError({ subCode: 'io', message: 'Issue is locked' });
    const { pusher, calls } = recordingPusher({ comment: Result.error(refusal) });
    const r = await publishTicketToTracker({ sprint, ticketId: linked.value.id, cwd: CWD, issuePusher: pusher });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe(refusal);
    expect(calls.comment).toHaveLength(1);
  });

  it('existing link with no approved requirements is nothing-to-post and does not call the tracker', async () => {
    const pending = makePendingTicket();
    const linked = setTicketLink(pending, ISSUE_URL);
    if (!linked.ok) throw new Error(linked.error.message);
    const seeded = addTicket(makeDraftSprint({ tickets: [] }), linked.value);
    if (!seeded.ok) throw new Error(seeded.error.message);
    const { pusher, calls } = recordingPusher();
    const r = await publishTicketToTracker({
      sprint: seeded.value,
      ticketId: linked.value.id,
      cwd: CWD,
      issuePusher: pusher,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.outcome).toBe('nothing-to-post');
      expect(r.value.sprint).toBe(seeded.value);
    }
    expect(calls.resolveOrigin).toBe(0);
    expect(calls.create).toEqual([]);
    expect(calls.listComments).toEqual([]);
    expect(calls.comment).toEqual([]);
  });
});
