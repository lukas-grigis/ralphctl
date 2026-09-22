/**
 * Disk-round-trip tests for the add-ticket wizard. Uses a real `wire()` pointed at a tmp
 * `RALPHCTL_HOME` so a successful submission is verified by reading the actual `sprint.json`
 * the repository writes — not by checking that a mock `save()` was called.
 *
 * Why a parallel test file instead of replacing the existing mock-based ones: the existing
 * tests cover UI-state assertions (frame contents, wizard step progression) and are cheap.
 * These tests cover the persistence contract — schema version, field shape, tickets array
 * structure. Different concern, different file, different failure mode.
 *
 * What a regression here catches:
 *  - Sprint schema change without migration → `sprint.json` parse fails on read
 *  - Ticket schema change → ticket field missing or in wrong shape
 *  - SprintRepository#save side-effect on the wrong file → sprint.json absent / wrong dir
 *  - schemaVersion field accidentally stripped → next load fails
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { IssueFetcher } from '@src/business/scm/issue-fetcher.ts';
import type { IssuePusher, IssueTrackerOrigin } from '@src/business/scm/issue-pusher.ts';
import { AddTicketView } from '@src/application/ui/tui/views/add-ticket-view.tsx';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { makeDraftSprint, makeProject } from '@tests/fixtures/domain.ts';
import { ENTER } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitFor } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';
import { createRealFsApp, type RealFsApp } from '@tests/helpers/real-fs-app.ts';
import { readSprintDir } from '@tests/helpers/sprint-dir-snapshot.ts';

interface PersistedSprint {
  readonly schemaVersion: number;
  readonly id: string;
  readonly status: string;
  readonly tickets: ReadonlyArray<{
    readonly title: string;
    readonly status: string;
    readonly description?: string;
    readonly link?: string;
  }>;
}

describe('AddTicketView — disk round-trip', () => {
  let app: RealFsApp;

  beforeEach(async () => {
    app = await createRealFsApp();
  });

  afterEach(async () => {
    await app.cleanup();
  });

  it('appends a manually-entered ticket to sprint.json on disk', async () => {
    const sprint = makeDraftSprint();
    const initialSave = await app.deps.sprintRepo.save(sprint);
    expect(initialSave.ok).toBe(true);

    // Confirm the precondition: sprint.json exists with zero tickets.
    const before = await readSprintDir(await app.resolveSprintDir(sprint.id));
    expect(before.tree).toContain('sprint.json');
    const beforeSprint = before.json<PersistedSprint>('sprint.json');
    expect(beforeSprint.schemaVersion).toBe(1);
    expect(beforeSprint.tickets).toHaveLength(0);

    const { result } = renderView(<AddTicketView />, {
      deps: app.deps,
      initial: { id: 'add-ticket', props: { sprintId: sprint.id } },
    });

    // Step 1: skip link.
    await waitFor(() => expect(result.lastFrame()).toContain('Issue link'));
    result.stdin.write(ENTER);

    // Step 2: title.
    await waitFor(() => expect(result.lastFrame()).toMatch(/^\s*▸\s*Title/m));
    result.stdin.write('Wire-up caching layer');
    await waitFor(() => expect(result.lastFrame()).toContain('Wire-up caching layer'));
    result.stdin.write(ENTER);

    // Step 3: description (required).
    await waitFor(() => expect(result.lastFrame()).toContain('Description'));
    result.stdin.write('Adds a per-request cache to the resolver pipeline');
    await waitFor(() => expect(result.lastFrame()).toContain('per-request cache'));
    result.stdin.write(ENTER);

    // Step 4: confirm.
    await waitFor(() => expect(result.lastFrame()).toContain('Add this ticket?'));
    result.stdin.write(ENTER);

    // Wait until disk reflects the appended ticket — the save is async + we don't get a
    // synchronous "save complete" event from the view.
    await waitFor(async () => {
      const snap = await readSprintDir(await app.resolveSprintDir(sprint.id));
      const persisted = snap.json<PersistedSprint>('sprint.json');
      expect(persisted.tickets).toHaveLength(1);
    });

    // Full assertions on what landed on disk.
    const after = await readSprintDir(await app.resolveSprintDir(sprint.id));
    const persisted = after.json<PersistedSprint>('sprint.json');
    expect(persisted.schemaVersion).toBe(1);
    expect(persisted.id).toBe(String(sprint.id));
    expect(persisted.status).toBe('draft');
    expect(persisted.tickets).toHaveLength(1);
    const ticket = persisted.tickets[0]!;
    expect(ticket.title).toBe('Wire-up caching layer');
    expect(ticket.description).toBe('Adds a per-request cache to the resolver pipeline');
    expect(ticket.status).toBe('pending');
  });

  it('a second invocation appends — does not overwrite the existing tickets array', async () => {
    const sprint = makeDraftSprint();
    await app.deps.sprintRepo.save(sprint);

    // First add.
    {
      const { result } = renderView(<AddTicketView />, {
        deps: app.deps,
        initial: { id: 'add-ticket', props: { sprintId: sprint.id } },
      });
      await waitFor(() => expect(result.lastFrame()).toContain('Issue link'));
      result.stdin.write(ENTER);
      await waitFor(() => expect(result.lastFrame()).toMatch(/^\s*▸\s*Title/m));
      result.stdin.write('Ticket one');
      result.stdin.write(ENTER);
      await waitFor(() => expect(result.lastFrame()).toContain('Description'));
      result.stdin.write('first description');
      result.stdin.write(ENTER);
      await waitFor(() => expect(result.lastFrame()).toContain('Add this ticket?'));
      result.stdin.write(ENTER);
      await waitFor(async () => {
        const snap = await readSprintDir(await app.resolveSprintDir(sprint.id));
        expect(snap.json<PersistedSprint>('sprint.json').tickets).toHaveLength(1);
      });
    }

    // Second add.
    {
      const { result } = renderView(<AddTicketView />, {
        deps: app.deps,
        initial: { id: 'add-ticket', props: { sprintId: sprint.id } },
      });
      await waitFor(() => expect(result.lastFrame()).toContain('Issue link'));
      result.stdin.write(ENTER);
      await waitFor(() => expect(result.lastFrame()).toMatch(/^\s*▸\s*Title/m));
      result.stdin.write('Ticket two');
      result.stdin.write(ENTER);
      await waitFor(() => expect(result.lastFrame()).toContain('Description'));
      result.stdin.write('second description');
      result.stdin.write(ENTER);
      await waitFor(() => expect(result.lastFrame()).toContain('Add this ticket?'));
      result.stdin.write(ENTER);
      await waitFor(async () => {
        const snap = await readSprintDir(await app.resolveSprintDir(sprint.id));
        expect(snap.json<PersistedSprint>('sprint.json').tickets).toHaveLength(2);
      });
    }

    const final = await readSprintDir(await app.resolveSprintDir(sprint.id));
    const persisted = final.json<PersistedSprint>('sprint.json');
    expect(persisted.tickets.map((t) => t.title)).toEqual(['Ticket one', 'Ticket two']);
    expect(persisted.tickets.map((t) => t.description)).toEqual(['first description', 'second description']);
  });

  it('empty description never writes to disk', async () => {
    const sprint = makeDraftSprint();
    await app.deps.sprintRepo.save(sprint);

    const before = await readSprintDir(await app.resolveSprintDir(sprint.id));
    const beforeMtime = before.files['sprint.json'];

    const { result } = renderView(<AddTicketView />, {
      deps: app.deps,
      initial: { id: 'add-ticket', props: { sprintId: sprint.id } },
    });

    await waitFor(() => expect(result.lastFrame()).toContain('Issue link'));
    result.stdin.write(ENTER);
    await waitFor(() => expect(result.lastFrame()).toMatch(/^\s*▸\s*Title/m));
    result.stdin.write('Some title');
    result.stdin.write(ENTER);
    // Description step: press Enter with empty buffer; wizard should NOT advance to confirm.
    await waitFor(() => expect(result.lastFrame()).toContain('Description'));
    result.stdin.write(ENTER);
    // Give the (non-)save a tick to happen if it would.
    await new Promise((r) => setTimeout(r, 30));

    const after = await readSprintDir(await app.resolveSprintDir(sprint.id));
    // Same content — no save happened. Catches a regression where the wizard silently
    // commits with an empty description because the required-check was dropped.
    expect(after.files['sprint.json']).toBe(beforeMtime);
    expect(after.json<PersistedSprint>('sprint.json').tickets).toHaveLength(0);
  });

  it('create prompt default No saves locally and does not call IssuePusher.create', async () => {
    const { sprint, deps, createCalls } = await seedWithOrigin();
    const { result } = renderView(<AddTicketView />, {
      deps,
      initial: { id: 'add-ticket', props: { sprintId: sprint.id } },
    });

    await fillManualTicket(result, 'Local only', 'stays on disk');
    result.stdin.write(ENTER);
    await waitFor(() => expect(result.lastFrame()).toContain('Create a tracker issue?'));
    result.stdin.write(ENTER);

    await waitFor(async () => {
      const snap = await readSprintDir(await app.resolveSprintDir(sprint.id));
      expect(snap.json<PersistedSprint>('sprint.json').tickets).toHaveLength(1);
    });

    const persisted = (await readSprintDir(await app.resolveSprintDir(sprint.id))).json<PersistedSprint>('sprint.json');
    expect(persisted.tickets[0]?.title).toBe('Local only');
    expect(persisted.tickets[0]?.link).toBeUndefined();
    expect(createCalls).toEqual([]);
    expect(result.lastFrame()).toContain('Add another ticket?');
  });

  it('create prompt Yes stores the IssuePusher.create URL as the ticket link', async () => {
    const { sprint, deps, createCalls } = await seedWithOrigin();
    const { result } = renderView(<AddTicketView />, {
      deps,
      initial: { id: 'add-ticket', props: { sprintId: sprint.id } },
    });

    await fillManualTicket(result, 'Ship it', 'open a tracker issue');
    result.stdin.write(ENTER);
    await waitFor(() => expect(result.lastFrame()).toContain('Create a tracker issue?'));
    result.stdin.write('y');

    await waitFor(async () => {
      const snap = await readSprintDir(await app.resolveSprintDir(sprint.id));
      expect(snap.json<PersistedSprint>('sprint.json').tickets[0]?.link).toBe('https://github.com/x/y/issues/7');
    });

    expect(createCalls).toEqual([{ title: 'Ship it', body: 'open a tracker issue' }]);
  });

  it('skips the create prompt when origin does not resolve', async () => {
    const { sprint, deps, createCalls } = await seedWithOrigin({
      origin: Result.ok(null),
    });
    const { result } = renderView(<AddTicketView />, {
      deps,
      initial: { id: 'add-ticket', props: { sprintId: sprint.id } },
    });

    await fillManualTicket(result, 'No origin', 'skip the prompt');
    result.stdin.write(ENTER);

    await waitFor(async () => {
      const snap = await readSprintDir(await app.resolveSprintDir(sprint.id));
      expect(snap.json<PersistedSprint>('sprint.json').tickets).toHaveLength(1);
    });

    expect(result.lastFrame()).not.toContain('Create a tracker issue?');
    expect(createCalls).toEqual([]);
    expect(
      (await readSprintDir(await app.resolveSprintDir(sprint.id))).json<PersistedSprint>('sprint.json').tickets[0]?.link
    ).toBeUndefined();
  });

  it('skips the create prompt when the ticket already has a link', async () => {
    const issueUrl = 'https://github.com/acme/repo/issues/42';
    const { sprint, deps, createCalls } = await seedWithOrigin({
      issueFetcher: async () =>
        Result.ok({
          url: issueUrl,
          title: 'Already linked',
          body: 'came from the tracker',
          state: 'open',
          comments: [],
        }),
    });
    const { result } = renderView(<AddTicketView />, {
      deps,
      initial: { id: 'add-ticket', props: { sprintId: sprint.id } },
    });

    await waitFor(() => expect(result.lastFrame()).toContain('Issue link'));
    result.stdin.write(issueUrl);
    result.stdin.write(ENTER);
    await waitFor(() => expect(result.lastFrame()).toContain('Already linked'));
    result.stdin.write(ENTER);
    await waitFor(() => expect(result.lastFrame()).toContain('came from the tracker'));
    result.stdin.write(ENTER);
    await waitFor(() => expect(result.lastFrame()).toContain('Add this ticket?'));
    result.stdin.write(ENTER);

    await waitFor(async () => {
      const snap = await readSprintDir(await app.resolveSprintDir(sprint.id));
      expect(snap.json<PersistedSprint>('sprint.json').tickets).toHaveLength(1);
    });

    expect(result.lastFrame()).not.toContain('Create a tracker issue?');
    expect(createCalls).toEqual([]);
    expect(
      (await readSprintDir(await app.resolveSprintDir(sprint.id))).json<PersistedSprint>('sprint.json').tickets[0]?.link
    ).toBe(issueUrl);
  });

  it('create failure leaves the local ticket in place and says it was saved', async () => {
    const { sprint, deps, createCalls } = await seedWithOrigin({
      create: Result.error(new StorageError({ subCode: 'io', message: 'gh is down' })),
    });
    const { result } = renderView(<AddTicketView />, {
      deps,
      initial: { id: 'add-ticket', props: { sprintId: sprint.id } },
    });

    await fillManualTicket(result, 'Keep locally', 'tracker is down');
    result.stdin.write(ENTER);
    await waitFor(() => expect(result.lastFrame()).toContain('Create a tracker issue?'));
    result.stdin.write('y');

    await waitFor(() => expect(result.lastFrame()).toMatch(/saved locally/i));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('gh is down');
    expect(frame).toMatch(/ticket publish/i);

    const persisted = (await readSprintDir(await app.resolveSprintDir(sprint.id))).json<PersistedSprint>('sprint.json');
    expect(persisted.tickets).toHaveLength(1);
    expect(persisted.tickets[0]?.title).toBe('Keep locally');
    expect(persisted.tickets[0]?.link).toBeUndefined();
    expect(createCalls).toEqual([{ title: 'Keep locally', body: 'tracker is down' }]);
  });

  const ORIGIN: IssueTrackerOrigin = {
    provider: 'github',
    hostname: 'github.com',
    owner: 'x',
    repo: 'y',
  };

  const fillManualTicket = async (
    result: { stdin: { write: (s: string) => void }; lastFrame: () => string | undefined },
    title: string,
    description: string
  ): Promise<void> => {
    await waitFor(() => expect(result.lastFrame()).toContain('Issue link'));
    result.stdin.write(ENTER);
    await waitFor(() => expect(result.lastFrame()).toMatch(/^\s*▸\s*Title/m));
    result.stdin.write(title);
    result.stdin.write(ENTER);
    await waitFor(() => expect(result.lastFrame()).toContain('Description'));
    result.stdin.write(description);
    result.stdin.write(ENTER);
    await waitFor(() => expect(result.lastFrame()).toContain('Add this ticket?'));
  };

  const seedWithOrigin = async (opts?: {
    readonly origin?: Result<IssueTrackerOrigin | null, StorageError>;
    readonly create?: Result<{ url: string }, StorageError>;
    readonly issueFetcher?: IssueFetcher;
  }): Promise<{
    readonly sprint: ReturnType<typeof makeDraftSprint>;
    readonly deps: AppDeps;
    readonly createCalls: Array<{ title: string; body: string }>;
  }> => {
    const sprint = makeDraftSprint();
    const project = makeProject({ id: sprint.projectId });
    expect((await app.deps.projectRepo.save(project)).ok).toBe(true);
    expect((await app.deps.sprintRepo.save(sprint)).ok).toBe(true);

    const createCalls: Array<{ title: string; body: string }> = [];
    const pusher: IssuePusher = {
      async resolveOrigin() {
        return opts?.origin ?? Result.ok(ORIGIN);
      },
      async create(args) {
        createCalls.push({ title: args.title, body: args.body });
        return opts?.create ?? Result.ok({ url: 'https://github.com/x/y/issues/7' });
      },
      async listComments() {
        return Result.ok([]);
      },
      async comment() {
        return Result.ok(undefined);
      },
    };

    return {
      sprint,
      createCalls,
      deps: {
        ...app.deps,
        issuePusher: pusher,
        ...(opts?.issueFetcher !== undefined ? { issueFetcher: opts.issueFetcher } : {}),
      },
    };
  };
});
