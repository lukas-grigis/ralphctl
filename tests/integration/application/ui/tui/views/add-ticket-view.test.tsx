/**
 * End-to-end tests for the add-ticket wizard. Two paths:
 *  - manual entry (no `IssueFetcher` wired): link → title → description → confirm.
 *  - URL-prefilled entry: link → fetch → title (prefilled) → description (prefilled) → confirm.
 *
 * The second path is the whole point of the wizard's ordering — the user pastes a GitHub
 * URL once instead of copy-pasting title and description by hand.
 *
 * Description is required: submitting an empty description on the description step does not
 * advance the wizard. The confirm step always shows the trimmed description text.
 */

import React, { useEffect, useState } from 'react';
import { Text } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { AddTicketView } from '@src/application/ui/tui/views/add-ticket-view.tsx';
import { useRouter } from '@src/application/ui/tui/runtime/router.tsx';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { IssuePusher } from '@src/business/scm/issue-pusher.ts';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { ExternalIssue, IssueFetcher } from '@src/business/scm/issue-fetcher.ts';
import { makeDraftSprint, makeProject } from '@tests/fixtures/domain.ts';
import { ENTER, ESC } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitFor, waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView } from '@tests/integration/application/ui/tui/_harness.tsx';

describe('AddTicketView — wizard e2e', () => {
  it('manual entry: skip link → enter title → enter description → confirm appends the ticket', async () => {
    const sprint = makeDraftSprint();
    const save = vi.fn(async (s: Sprint) => {
      void s;
      return Result.ok(undefined);
    });
    const sprintRepo: SprintRepository = {
      async findById() {
        return Result.ok(sprint);
      },
      save,
    } as unknown as SprintRepository;
    const deps: AppDeps = { sprintRepo } as unknown as AppDeps;

    const { result } = renderView(<AddTicketView />, {
      deps,
      initial: { id: 'add-ticket', props: { sprintId: sprint.id } },
    });

    // Step 1: link — skip with an empty URL.
    await waitFor(() => expect(result.lastFrame()).toContain('Issue link'));
    result.stdin.write(ENTER);

    // Step 2: title (required).
    await waitFor(() => expect(result.lastFrame()).toMatch(/^\s*▸\s*Title/m));
    result.stdin.write('Implement caching layer');
    await waitFor(() => expect(result.lastFrame()).toContain('Implement caching layer'));
    result.stdin.write(ENTER);

    // Step 3: description (now required — must enter something).
    await waitFor(() => expect(result.lastFrame()).toContain('Description'));
    result.stdin.write('Adds a per-request cache');
    await waitFor(() => expect(result.lastFrame()).toContain('Adds a per-request cache'));
    result.stdin.write(ENTER);

    // Step 4: confirm — description should be shown as text, not "(skipped)".
    await waitFor(() => expect(result.lastFrame()).toContain('Add this ticket?'));
    expect(result.lastFrame()).toContain('Adds a per-request cache');
    // Description field must not show "(skipped)" — it was required and entered.
    const frame = result.lastFrame() ?? '';
    const descLine = frame.split('\n').find((l) => l.includes('Description'));
    expect(descLine).not.toContain('skipped');
    result.stdin.write(ENTER);

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0]?.[0];
    expect(saved?.tickets).toHaveLength(1);
    expect(saved?.tickets[0]?.title).toBe('Implement caching layer');
    expect(saved?.tickets[0]?.status).toBe('pending');
  });

  it('empty description: wizard does not advance when description is empty', async () => {
    const sprint = makeDraftSprint();
    const save = vi.fn(async (s: Sprint) => {
      void s;
      return Result.ok(undefined);
    });
    const sprintRepo: SprintRepository = {
      async findById() {
        return Result.ok(sprint);
      },
      save,
    } as unknown as SprintRepository;
    const deps: AppDeps = { sprintRepo } as unknown as AppDeps;

    const { result } = renderView(<AddTicketView />, {
      deps,
      initial: { id: 'add-ticket', props: { sprintId: sprint.id } },
    });

    // Step 1: link — skip.
    await waitFor(() => expect(result.lastFrame()).toContain('Issue link'));
    result.stdin.write(ENTER);

    // Step 2: title.
    await waitFor(() => expect(result.lastFrame()).toMatch(/^\s*▸\s*Title/m));
    result.stdin.write('My ticket');
    await waitFor(() => expect(result.lastFrame()).toContain('My ticket'));
    result.stdin.write(ENTER);

    // Step 3: description — press Enter with empty buffer.
    await waitFor(() => expect(result.lastFrame()).toContain('Description'));
    result.stdin.write(ENTER);
    await waitFor(() => expect(result.lastFrame()).toContain('Description'));
    // Wizard should still show the description step — confirm never appears.
    expect(result.lastFrame()).not.toContain('Add this ticket?');
    expect(save).not.toHaveBeenCalled();
  });

  it('URL prefill: enter link → fetch populates title + description → user accepts both → save', async () => {
    const sprint = makeDraftSprint();
    const save = vi.fn(async (s: Sprint) => {
      void s;
      return Result.ok(undefined);
    });
    const sprintRepo: SprintRepository = {
      async findById() {
        return Result.ok(sprint);
      },
      save,
    } as unknown as SprintRepository;
    const fetched: ExternalIssue = {
      url: 'https://github.com/acme/repo/issues/42',
      title: 'Caching layer is missing',
      body: 'We need a per-request cache for the resolver pipeline.',
      state: 'open',
      comments: [],
    };
    const issueFetcher: IssueFetcher = async () => Result.ok(fetched);
    const deps: AppDeps = { sprintRepo, issueFetcher } as unknown as AppDeps;

    const { result } = renderView(<AddTicketView />, {
      deps,
      initial: { id: 'add-ticket', props: { sprintId: sprint.id } },
    });

    // Step 1: paste the URL.
    await waitFor(() => expect(result.lastFrame()).toContain('Issue link'));
    result.stdin.write('https://github.com/acme/repo/issues/42');
    await waitFor(() => expect(result.lastFrame()).toContain('issues/42'));
    result.stdin.write(ENTER);

    // Step 2: title is prefilled — accept as-is.
    await waitFor(() => expect(result.lastFrame()).toContain(fetched.title));
    result.stdin.write(ENTER);

    // Step 3: description is prefilled — accept as-is.
    await waitFor(() => expect(result.lastFrame()).toContain(fetched.body));
    result.stdin.write(ENTER);

    // Step 4: confirm — description field shows the text, not "(skipped)".
    await waitFor(() => expect(result.lastFrame()).toContain('Add this ticket?'));
    const frame = result.lastFrame() ?? '';
    const descLine = frame.split('\n').find((l) => l.includes('Description'));
    expect(descLine).not.toContain('skipped');
    result.stdin.write(ENTER);

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    const saved = save.mock.calls[0]?.[0];
    expect(saved?.tickets).toHaveLength(1);
    expect(saved?.tickets[0]?.title).toBe(fetched.title);
    expect(saved?.tickets[0]?.description).toBe(fetched.body);
    expect(saved?.tickets[0]?.link).toBe(fetched.url);
  });
});

/**
 * Mount the wizard ON TOP of a `sprints` entry so `router.pop()` is observable — a single-entry
 * stack makes pop a no-op, which would hide exactly the dead end these tests fence.
 */
const PushedAddTicket = ({ sprintId }: { readonly sprintId: SprintId }): React.JSX.Element => {
  const router = useRouter();
  const [pushed, setPushed] = useState(false);
  useEffect(() => {
    router.push({ id: 'add-ticket', props: { sprintId } });
    setPushed(true);
    // Push exactly once on mount.
  }, []);
  return pushed ? <AddTicketView /> : <Text>mounting</Text>;
};

const fillTicket = async (
  result: { stdin: { write: (s: string) => void }; lastFrame: () => string | undefined },
  title: string
): Promise<void> => {
  await waitFor(() => expect(result.lastFrame()).toContain('Issue link'));
  result.stdin.write(ENTER);
  await waitFor(() => expect(result.lastFrame()).toMatch(/^\s*▸\s*Title/m));
  result.stdin.write(title);
  result.stdin.write(ENTER);
  await waitFor(() => expect(result.lastFrame()).toContain('Description'));
  result.stdin.write('some detail');
  result.stdin.write(ENTER);
  await waitFor(() => expect(result.lastFrame()).toContain('Add this ticket?'));
  result.stdin.write(ENTER);
};

describe('AddTicketView — failure steps always have an exit', () => {
  const failingTrackerDeps = (sprint: Sprint): AppDeps => {
    let stored = sprint;
    const issuePusher: IssuePusher = {
      resolveOrigin: async () => Result.ok({ provider: 'github', hostname: 'github.com', owner: 'x', repo: 'y' }),
      create: async () => Result.error(new StorageError({ subCode: 'io', message: 'gh is down' })),
      listComments: async () => Result.ok([]),
      comment: async () => Result.ok(undefined),
    };
    return {
      sprintRepo: {
        findById: async () => Result.ok(stored),
        save: async (next: Sprint) => {
          stored = next;
          return Result.ok(undefined);
        },
      } as unknown as SprintRepository,
      projectRepo: { findById: async () => Result.ok(makeProject()) } as unknown as ProjectRepository,
      issuePusher,
    } as unknown as AppDeps;
  };

  const reachCreateFailed = async (sprint: Sprint): Promise<ReturnType<typeof renderView>> => {
    const view = renderView(<PushedAddTicket sprintId={sprint.id} />, {
      deps: failingTrackerDeps(sprint),
      initial: { id: 'sprints', props: { sprintId: sprint.id } },
    });
    await fillTicket(view.result, 'Tracker down');
    await waitFor(() => expect(view.result.lastFrame()).toContain('Create a tracker issue?'));
    view.result.stdin.write('y');
    await waitFor(() => expect(view.result.lastFrame()).toContain('gh is down'));
    return view;
  };

  it('create-failed names the retry command and esc leaves the wizard', async () => {
    const sprint = makeDraftSprint();
    const { result, routeIds } = await reachCreateFailed(sprint);
    // The command is longer than the 100-column stub — compare with wrapping collapsed.
    const frame = (result.lastFrame() ?? '').replace(/\s+/g, ' ');
    expect(frame).toMatch(/saved locally/i);
    expect(frame).toContain(`ralphctl ticket publish --sprint ${String(sprint.id)}`);
    expect(frame).toContain('Add another ticket?');
    result.stdin.write(ESC);
    await waitForPredicate(() => routeIds().at(-1) === 'sprints');
  });

  it('create-failed: yes starts a fresh ticket and counts the saved one', async () => {
    const { result } = await reachCreateFailed(makeDraftSprint());
    result.stdin.write('y');
    await waitFor(() => expect(result.lastFrame()).toContain('Issue link'));
    expect(result.lastFrame()).toContain('1 ticket added this session');
  });

  it('error step (save failed) offers a way out instead of a dead end', async () => {
    const sprint = makeDraftSprint();
    const deps = {
      sprintRepo: {
        findById: async () => Result.ok(sprint),
        save: async () => Result.error(new StorageError({ subCode: 'io', message: 'disk full' })),
      } as unknown as SprintRepository,
    } as unknown as AppDeps;
    const { result, routeIds } = renderView(<PushedAddTicket sprintId={sprint.id} />, {
      deps,
      initial: { id: 'sprints', props: { sprintId: sprint.id } },
    });
    await fillTicket(result, 'Will not save');
    await waitFor(() => expect(result.lastFrame()).toContain('disk full'));
    expect(result.lastFrame()).toContain('Start over with a new ticket?');
    result.stdin.write('n');
    await waitForPredicate(() => routeIds().at(-1) === 'sprints');
  });
});
