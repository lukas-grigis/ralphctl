/**
 * Smoke tests for SprintDetailView's phase-aware workspace layout. Verifies the "Next phase"
 * card per status and that the ticket panel leads when draft, tasks otherwise.
 */

import { describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { SprintDetailView } from '@src/application/ui/tui/views/sprint-detail-view.tsx';
import type { ViewEntry } from '@src/application/ui/tui/runtime/router.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintRepository } from '@src/domain/repository/sprint/sprint-repository.ts';
import type { TaskRepository } from '@src/domain/repository/task/task-repository.ts';
import type { ProjectRepository } from '@src/domain/repository/project/project-repository.ts';
import type { Task } from '@src/domain/entity/task.ts';
import type { IssuePusher } from '@src/business/scm/issue-pusher.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { setTicketLink } from '@src/domain/entity/ticket.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import {
  makeApprovedTicket,
  makeDoneSprint,
  makeDraftSprint,
  makePendingTicket,
  makeProject,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import { startNextAttempt } from '@src/domain/entity/task-attempts.ts';
import { failCurrentAttempt } from '@src/domain/entity/task-settle.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const FIXED_SPRINT_ID = 'sprint-fixture-id' as unknown as SprintId;

const makeSprint = (overrides: Partial<Sprint>): Sprint =>
  ({
    id: FIXED_SPRINT_ID,
    slug: 'demo-sprint',
    name: 'Demo Sprint',
    projectId: 'proj-fixture' as never,
    status: 'draft',
    tickets: [],
    ...overrides,
  }) as unknown as Sprint;

const stubDeps = (sprint: Sprint, tasks: readonly Task[]): AppDeps =>
  ({
    sprintRepo: {
      async findById() {
        return Result.ok(sprint);
      },
    } as unknown as SprintRepository,
    taskRepo: {
      async findBySprintId() {
        return Result.ok([...tasks]);
      },
    } as unknown as TaskRepository,
    projectRepo: {} as never,
    sprintExecutionRepo: {} as never,
    settingsRepo: {} as never,
  }) as unknown as AppDeps;

const initial: ViewEntry = { id: 'sprint-detail', props: { sprintId: FIXED_SPRINT_ID } };

describe('SprintDetailView — phase workspace', () => {
  it('draft sprint with no tickets suggests "Add tickets"', async () => {
    const sprint = makeSprint({ status: 'draft', tickets: [] });
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, []), initial });
    await waitForViewReady(result, (f) => f.includes('Add tickets'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Next phase');
    expect(frame).toContain('Add tickets');
    result.unmount();
  });

  it('draft sprint with pending tickets suggests "Refine"', async () => {
    const sprint = makeSprint({
      status: 'draft',
      tickets: [
        { id: 't1' as never, title: 'first', status: 'pending' } as never,
        { id: 't2' as never, title: 'second', status: 'pending' } as never,
      ],
    });
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, []), initial });
    await waitForViewReady(result, (f) => f.includes('Refine 2 pending ticket(s)'));
    expect(result.lastFrame() ?? '').toContain('Refine 2 pending ticket(s)');
    result.unmount();
  });

  it('planned sprint with todo tasks suggests "Implement"; tickets always lead, tasks follow', async () => {
    const sprint = makeSprint({
      status: 'planned',
      tickets: [{ id: 't1' as never, title: 'first', status: 'approved' } as never],
    });
    const tasks: readonly Task[] = [
      {
        id: 'task-1' as never,
        name: 'do thing',
        status: 'todo',
        dependsOn: [],
        attempts: [],
        ticketId: 't1' as never,
        repositoryId: 'r1' as never,
      } as never,
      {
        id: 'task-2' as never,
        name: 'do other thing',
        status: 'todo',
        dependsOn: [],
        attempts: [],
        ticketId: 't1' as never,
        repositoryId: 'r1' as never,
      } as never,
    ];
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, tasks), initial });
    await waitForViewReady(result, (f) => f.includes('Implement 2 resumable task(s)'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Implement 2 resumable task(s)');
    const tasksHeader = frame.indexOf('▣ Tasks');
    const ticketsHeader = frame.indexOf('▣ Tickets');
    expect(tasksHeader).toBeGreaterThan(-1);
    expect(ticketsHeader).toBeGreaterThan(-1);
    // Tickets always come first now — the old planned-sprint flip was confusing for users.
    expect(ticketsHeader).toBeLessThan(tasksHeader);
    result.unmount();
  });

  it('review sprint suggests opening a pull request', async () => {
    const sprint = makeSprint({
      status: 'review',
      tickets: [{ id: 't1' as never, title: 'first', status: 'approved' } as never],
    });
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, []), initial });
    await waitForViewReady(result, (f) => f.includes('Open a pull request'));
    expect(result.lastFrame() ?? '').toContain('Open a pull request');
    result.unmount();
  });

  it('pressing u on a blocked task flips it to todo and surfaces "✓ unblocked"', async () => {
    const sprint = makeSprint({
      status: 'active',
      tickets: [{ id: 't1' as never, title: 'first', status: 'approved' } as never],
    });
    const blockedTask: Task = {
      id: 'task-blocked' as never,
      name: 'wedged',
      status: 'blocked',
      blockedReason: 'mvn agent attach failed',
      dependsOn: [],
      attempts: [],
      ticketId: 't1' as never,
      repositoryId: 'r1' as never,
      order: 1,
      steps: [],
      verificationCriteria: [],
    } as never;

    const updateCalls: Task[] = [];
    let storedStatus: 'blocked' | 'todo' = 'blocked';
    const deps = {
      sprintRepo: {
        async findById() {
          return Result.ok(sprint);
        },
      } as unknown as SprintRepository,
      taskRepo: {
        async findBySprintId() {
          return Result.ok(
            storedStatus === 'todo'
              ? [{ ...(blockedTask as object), status: 'todo' } as unknown as Task]
              : [blockedTask]
          );
        },
        async update(_sprintId: SprintId, task: Task) {
          updateCalls.push(task);
          storedStatus = task.status === 'todo' ? 'todo' : storedStatus;
          return Result.ok(undefined);
        },
      } as unknown as TaskRepository,
      projectRepo: {} as never,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
    } as unknown as AppDeps;

    const { result } = renderView(<SprintDetailView />, { deps, initial });
    await waitForViewReady(result, (f) => f.includes('wedged'));
    // Cursor starts at idx 0 (the ticket). Press 'j' once to land on the (one) task below.
    result.stdin.write('j');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('unbl'));
    result.stdin.write('u');
    // Give the async use case + reload a chance to settle.
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('✓ unblocked'));
    const frame = result.lastFrame() ?? '';
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.status).toBe('todo');
    expect(frame).toContain('✓ unblocked');
    expect(frame).toContain('wedged');
    result.unmount();
  });

  it("pressing 'e' on a focused ticket (draft sprint) opens an edit-field picker, then renames the ticket", async () => {
    const ticket = makePendingTicket({ title: 'Typo iin Title' });
    const sprint = makeDraftSprint({ tickets: [] as never });
    // Splice the ticket directly so the test fixture stays simple — makeDraftSprint defaults
    // to no tickets, and addTicket would require the sprint variant.
    const sprintWithTicket = { ...sprint, tickets: [ticket] } as unknown as Sprint;
    const save = vi.fn(async (s: Sprint) => Result.ok<Sprint>(s));
    const repo = {
      async findById() {
        return Result.ok(sprintWithTicket);
      },
      save,
    } as unknown as SprintRepository;
    const deps = {
      sprintRepo: repo,
      taskRepo: {
        async findBySprintId() {
          return Result.ok([] as readonly Task[]);
        },
      } as unknown as TaskRepository,
      projectRepo: {} as never,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
    } as unknown as AppDeps;
    const queue = createPromptQueue();
    const initialWithId: ViewEntry = { id: 'sprint-detail', props: { sprintId: sprintWithTicket.id } };
    const { result } = renderView(<SprintDetailView />, { deps, initial: initialWithId, queue });
    await waitForViewReady(result, (f) => f.includes('Typo iin Title'));
    // Cursor starts on the ticket. Press 'e' → opens the field-picker choice.
    result.stdin.write('e');
    await waitForPredicate(() => queue.head !== undefined);
    expect(queue.head?.kind).toBe('choice');
    // Pick "title" (the first option for a pending ticket).
    queue.resolveHead('title');
    await waitForPredicate(() => queue.head?.kind === 'text');
    expect(queue.head?.kind).toBe('text');
    if (queue.head?.kind === 'text') {
      expect(queue.head.initial).toBe('Typo iin Title');
    }
    queue.resolveHead('Typo in Title');
    await waitForPredicate(() => save.mock.calls.length === 1);
    expect(save).toHaveBeenCalledTimes(1);
    const saved = save.mock.calls[0]?.[0];
    expect(saved?.tickets?.[0]?.title).toBe('Typo in Title');
    result.unmount();
  });

  it("shows 'u unblock' hint in status bar when a blocked task is focused", async () => {
    const sprint = makeSprint({
      status: 'active',
      tickets: [{ id: 't1' as never, title: 'first', status: 'approved' } as never],
    });
    const blockedTask: Task = {
      id: 'task-blocked-hint' as never,
      name: 'stuck-task',
      status: 'blocked',
      blockedReason: 'verify script timed out',
      dependsOn: [],
      attempts: [],
      ticketId: 't1' as never,
      repositoryId: 'r1' as never,
      order: 1,
      steps: [],
      verificationCriteria: [],
    } as never;

    const deps = {
      sprintRepo: {
        async findById() {
          return Result.ok(sprint);
        },
      } as unknown as SprintRepository,
      taskRepo: {
        async findBySprintId() {
          return Result.ok([blockedTask]);
        },
      } as unknown as TaskRepository,
      projectRepo: {} as never,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
    } as unknown as AppDeps;

    const { result } = renderView(<SprintDetailView />, { deps, initial });
    await waitForViewReady(result, (f) => f.includes('stuck-task'));
    // Cursor starts on the ticket; press 'j' to land on the blocked task.
    result.stdin.write('j');
    await waitForPredicate(() => /unbl/.test(result.lastFrame() ?? ''));
    const frame = result.lastFrame() ?? '';
    // The 'u unblock' hint must appear in the status bar footer area. The terminal width used
    // by ink-testing-library may wrap the label across lines — match a prefix that survives
    // truncation/wrapping ("unbl" is the first four characters of the label "unblock").
    expect(frame).toMatch(/unbl/);
    result.unmount();
  });

  it("hides the 'u unblock' hint when a non-blocked task is focused", async () => {
    const sprint = makeSprint({
      status: 'active',
      tickets: [{ id: 't1' as never, title: 'first', status: 'approved' } as never],
    });
    const todoTask: Task = {
      id: 'task-todo-hint' as never,
      name: 'not-stuck',
      status: 'todo',
      dependsOn: [],
      attempts: [],
      ticketId: 't1' as never,
      repositoryId: 'r1' as never,
      order: 1,
      steps: [],
      verificationCriteria: [],
    } as never;

    const deps = {
      sprintRepo: {
        async findById() {
          return Result.ok(sprint);
        },
      } as unknown as SprintRepository,
      taskRepo: {
        async findBySprintId() {
          return Result.ok([todoTask]);
        },
      } as unknown as TaskRepository,
      projectRepo: {} as never,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
    } as unknown as AppDeps;

    const { result } = renderView(<SprintDetailView />, { deps, initial });
    await waitForViewReady(result, (f) => f.includes('not-stuck'));
    // Cursor starts on the ticket; press 'j' to land on the todo task.
    result.stdin.write('j');
    await tick(40);
    const frame = result.lastFrame() ?? '';
    // The task is visible but the unblock hint must NOT appear. The `unbl` prefix is enough —
    // if the label does not exist, not even the start of the word appears anywhere in the frame.
    expect(frame).toContain('not-stuck');
    expect(frame).not.toMatch(/unbl/);
    result.unmount();
  });

  it("shows 'u unblock' hint when focused on an in_progress task (crashed/aborted)", async () => {
    const sprint = makeSprint({
      status: 'active',
      tickets: [{ id: 't1' as never, title: 'first', status: 'approved' } as never],
    });
    // Build an in_progress task with a settled (aborted) last attempt — the "stuck after kill" shape.
    const todo = makeTodoTask({ name: 'in-progress-stuck' });
    const inProgress = (() => {
      const r = startNextAttempt(todo, IsoTimestamp.now(), 'session-x');
      if (!r.ok) throw new Error(`fixture: ${r.error.message}`);
      return r.value;
    })();
    // Settle the attempt as aborted so the last attempt is no longer running.
    const settled = (() => {
      const r = failCurrentAttempt(inProgress, IsoTimestamp.now(), 'aborted');
      if (!r.ok) throw new Error(`fixture: ${r.error.message}`);
      if (r.value.status !== 'in_progress') throw new Error('fixture: expected in_progress after single-attempt abort');
      return r.value;
    })();

    const deps = {
      sprintRepo: {
        async findById() {
          return Result.ok(sprint);
        },
      } as unknown as SprintRepository,
      taskRepo: {
        async findBySprintId() {
          return Result.ok([settled] as unknown as readonly Task[]);
        },
      } as unknown as TaskRepository,
      projectRepo: {} as never,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
    } as unknown as AppDeps;

    const { result } = renderView(<SprintDetailView />, { deps, initial });
    await waitForViewReady(result, (f) => f.includes('in-progress-stuck'));
    // Cursor starts on the ticket; press 'j' to land on the in_progress task.
    result.stdin.write('j');
    await waitForPredicate(() => /unbl/.test(result.lastFrame() ?? ''));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('in-progress-stuck');
    // The 'u unblock' hint must appear for in_progress tasks, same as for blocked.
    expect(frame).toMatch(/unbl/);
    result.unmount();
  });

  it('pressing u on an in_progress task with settled attempt resets it to todo', async () => {
    const sprint = makeSprint({
      status: 'active',
      tickets: [{ id: 't1' as never, title: 'first', status: 'approved' } as never],
    });
    const todo = makeTodoTask({ name: 'crashed-task' });
    const inProgress = (() => {
      const r = startNextAttempt(todo, IsoTimestamp.now(), 'session-y');
      if (!r.ok) throw new Error(`fixture: ${r.error.message}`);
      return r.value;
    })();
    const settled = (() => {
      const r = failCurrentAttempt(inProgress, IsoTimestamp.now(), 'aborted');
      if (!r.ok) throw new Error(`fixture: ${r.error.message}`);
      if (r.value.status !== 'in_progress') throw new Error('fixture: expected in_progress after single-attempt abort');
      return r.value;
    })();

    const updateCalls: Task[] = [];
    let storedStatus: 'in_progress' | 'todo' = 'in_progress';
    const deps = {
      sprintRepo: {
        async findById() {
          return Result.ok(sprint);
        },
      } as unknown as SprintRepository,
      taskRepo: {
        async findBySprintId() {
          return Result.ok(
            storedStatus === 'todo'
              ? [{ ...(settled as object), status: 'todo' } as unknown as Task]
              : [settled as unknown as Task]
          );
        },
        async update(_sprintId: SprintId, task: Task) {
          updateCalls.push(task);
          storedStatus = task.status === 'todo' ? 'todo' : storedStatus;
          return Result.ok(undefined);
        },
      } as unknown as TaskRepository,
      projectRepo: {} as never,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
    } as unknown as AppDeps;

    const { result } = renderView(<SprintDetailView />, { deps, initial });
    await waitForViewReady(result, (f) => f.includes('crashed-task'));
    // Cursor starts on the ticket; press 'j' to land on the in_progress task.
    result.stdin.write('j');
    await waitForPredicate(() => /unbl/.test(result.lastFrame() ?? ''));
    result.stdin.write('u');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('✓ unblocked'));
    const frame = result.lastFrame() ?? '';
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.status).toBe('todo');
    expect(frame).toContain('✓ unblocked');
    expect(frame).toContain('crashed-task');
    result.unmount();
  });

  it('shows the a/d ticket-CRUD hints on a draft sprint (handlers are draft-gated)', async () => {
    const sprint = makeSprint({
      status: 'draft',
      tickets: [{ id: 't1' as never, title: 'first', status: 'pending' } as never],
    });
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, []), initial });
    await waitForViewReady(result, (f) => f.includes('a add'));
    const frame = result.lastFrame() ?? '';
    // The hint strip advertises the ticket add/remove chords only while they are wired up.
    expect(frame).toContain('a add');
    expect(frame).toContain('d remove');
    // DESIGN-SYSTEM §6.4 — arrows only in the per-view hint strip; j/k stays bound but unadvertised.
    expect(frame).not.toContain('j/k');
    result.unmount();
  });

  it('hides the a/d ticket-CRUD hints on a non-draft sprint (handlers are no-ops there)', async () => {
    const sprint = makeSprint({
      status: 'active',
      tickets: [{ id: 't1' as never, title: 'first', status: 'approved' } as never],
    });
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, []), initial });
    await waitForViewReady(result, (f) => f.includes('first'));
    const frame = result.lastFrame() ?? '';
    // Ticket CRUD is draft-only; on an active sprint the chords do nothing, so the footer must
    // not advertise them — the hint shares one source of truth with the gated handler.
    expect(frame).not.toContain('a add');
    expect(frame).not.toContain('d remove');
    result.unmount();
  });

  it('u is a no-op when the focused card is a todo task (no use-case invocation)', async () => {
    const sprint = makeSprint({
      status: 'active',
      tickets: [{ id: 't1' as never, title: 'first', status: 'approved' } as never],
    });
    const todoTask: Task = {
      id: 'task-todo' as never,
      name: 'fine',
      status: 'todo',
      dependsOn: [],
      attempts: [],
      ticketId: 't1' as never,
      repositoryId: 'r1' as never,
      order: 1,
      steps: [],
      verificationCriteria: [],
    } as never;

    const updateCalls: Task[] = [];
    const deps = {
      sprintRepo: {
        async findById() {
          return Result.ok(sprint);
        },
      } as unknown as SprintRepository,
      taskRepo: {
        async findBySprintId() {
          return Result.ok([todoTask]);
        },
        async update(_sprintId: SprintId, task: Task) {
          updateCalls.push(task);
          return Result.ok(undefined);
        },
      } as unknown as TaskRepository,
      projectRepo: {} as never,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
    } as unknown as AppDeps;

    const { result } = renderView(<SprintDetailView />, { deps, initial });
    await waitForViewReady(result, (f) => f.includes('fine'));
    result.stdin.write('j');
    await tick(20);
    result.stdin.write('u');
    await tick(40);
    expect(updateCalls).toHaveLength(0);
    result.unmount();
  });

  it("shows 'p publish' hint when a ticket is focused", async () => {
    const ticket = makePendingTicket({ title: 'publish-me' });
    const sprint = { ...makeDraftSprint(), tickets: [ticket] } as unknown as Sprint;
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, []), initial });
    await waitForViewReady(result, (f) => f.includes('publish-me'));
    expect(result.lastFrame() ?? '').toContain('p publish');
    result.unmount();
  });

  it("hides the 'p publish' hint when a task is focused", async () => {
    const sprint = makeSprint({
      status: 'active',
      tickets: [{ id: 't1' as never, title: 'first', status: 'approved' } as never],
    });
    const todoTask: Task = {
      id: 'task-no-publish' as never,
      name: 'not-a-ticket',
      status: 'todo',
      dependsOn: [],
      attempts: [],
      ticketId: 't1' as never,
      repositoryId: 'r1' as never,
      order: 1,
      steps: [],
      verificationCriteria: [],
    } as never;
    const { result } = renderView(<SprintDetailView />, { deps: stubDeps(sprint, [todoTask]), initial });
    await waitForViewReady(result, (f) => f.includes('not-a-ticket'));
    result.stdin.write('j');
    await tick(40);
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('not-a-ticket');
    expect(frame).not.toContain('p publish');
    result.unmount();
  });

  it('pressing p on a focused ticket with no link creates the issue and stores the link', async () => {
    const ticket = makePendingTicket({ title: 'ship it' });
    let stored = { ...makeDraftSprint(), tickets: [ticket] } as unknown as Sprint;
    const createCalls: Array<{ title: string; body: string }> = [];
    const commentCalls: string[] = [];
    const pusher: IssuePusher = {
      async resolveOrigin() {
        return Result.ok({ provider: 'github', hostname: 'github.com', owner: 'x', repo: 'y' });
      },
      async create(args) {
        createCalls.push({ title: args.title, body: args.body });
        return Result.ok({ url: 'https://github.com/x/y/issues/7' });
      },
      async listComments() {
        return Result.ok([]);
      },
      async comment(url) {
        commentCalls.push(url);
        return Result.ok(undefined);
      },
    };
    const deps = {
      sprintRepo: {
        async findById() {
          return Result.ok(stored);
        },
        async save(next: Sprint) {
          stored = next;
          return Result.ok(undefined);
        },
      } as unknown as SprintRepository,
      taskRepo: {
        async findBySprintId() {
          return Result.ok([] as readonly Task[]);
        },
      } as unknown as TaskRepository,
      projectRepo: {
        async findById() {
          return Result.ok(makeProject());
        },
      } as unknown as ProjectRepository,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
      issuePusher: pusher,
    } as unknown as AppDeps;
    const initialWithId: ViewEntry = { id: 'sprint-detail', props: { sprintId: stored.id } };
    const { result } = renderView(<SprintDetailView />, { deps, initial: initialWithId });
    await waitForViewReady(result, (f) => f.includes('ship it'));
    result.stdin.write('p');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('created'));
    expect(createCalls).toEqual([{ title: 'ship it', body: '' }]);
    expect(commentCalls).toEqual([]);
    expect(stored.tickets[0]?.link).toBe('https://github.com/x/y/issues/7');
    expect(result.lastFrame() ?? '').toContain('ship it');
    result.unmount();
  });

  it('pressing p on a linked approved ticket comments and does not create', async () => {
    const approved = makeApprovedTicket({ title: 'linked ticket', requirements: 'do the thing well' });
    const linked = setTicketLink(approved, 'https://github.com/x/y/issues/42');
    if (!linked.ok) throw new Error('fixture: setTicketLink failed');
    let stored = { ...makeDraftSprint(), tickets: [linked.value] } as unknown as Sprint;
    const createCalls: string[] = [];
    const commentCalls: Array<{ url: string; body: string }> = [];
    const pusher: IssuePusher = {
      async resolveOrigin() {
        return Result.ok({ provider: 'github', hostname: 'github.com', owner: 'x', repo: 'y' });
      },
      async create() {
        createCalls.push('create');
        return Result.ok({ url: 'https://github.com/x/y/issues/99' });
      },
      async listComments() {
        return Result.ok([]);
      },
      async comment(url, args) {
        commentCalls.push({ url, body: args.body });
        return Result.ok(undefined);
      },
    };
    const deps = {
      sprintRepo: {
        async findById() {
          return Result.ok(stored);
        },
        async save(next: Sprint) {
          stored = next;
          return Result.ok(undefined);
        },
      } as unknown as SprintRepository,
      taskRepo: {
        async findBySprintId() {
          return Result.ok([] as readonly Task[]);
        },
      } as unknown as TaskRepository,
      projectRepo: {
        async findById() {
          return Result.ok(makeProject());
        },
      } as unknown as ProjectRepository,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
      issuePusher: pusher,
    } as unknown as AppDeps;
    const initialWithId: ViewEntry = { id: 'sprint-detail', props: { sprintId: stored.id } };
    const { result } = renderView(<SprintDetailView />, { deps, initial: initialWithId });
    await waitForViewReady(result, (f) => f.includes('linked ticket'));
    result.stdin.write('p');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('commented'));
    expect(createCalls).toEqual([]);
    expect(commentCalls).toHaveLength(1);
    expect(commentCalls[0]?.url).toBe('https://github.com/x/y/issues/42');
    result.unmount();
  });

  it('pressing p on tracker failure shows the error and keeps the ticket', async () => {
    const ticket = makePendingTicket({ title: 'stays put' });
    const sprint = { ...makeDraftSprint(), tickets: [ticket] } as unknown as Sprint;
    const saveCalls: Sprint[] = [];
    const pusher: IssuePusher = {
      async resolveOrigin() {
        return Result.error(new StorageError({ subCode: 'io', message: 'gh is down' }));
      },
      async create() {
        return Result.error(new StorageError({ subCode: 'io', message: 'gh is down' }));
      },
      async listComments() {
        return Result.ok([]);
      },
      async comment() {
        return Result.ok(undefined);
      },
    };
    const deps = {
      sprintRepo: {
        async findById() {
          return Result.ok(sprint);
        },
        async save(next: Sprint) {
          saveCalls.push(next);
          return Result.ok(undefined);
        },
      } as unknown as SprintRepository,
      taskRepo: {
        async findBySprintId() {
          return Result.ok([] as readonly Task[]);
        },
      } as unknown as TaskRepository,
      projectRepo: {
        async findById() {
          return Result.ok(makeProject());
        },
      } as unknown as ProjectRepository,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
      issuePusher: pusher,
    } as unknown as AppDeps;
    const initialWithId: ViewEntry = { id: 'sprint-detail', props: { sprintId: sprint.id } };
    const { result } = renderView(<SprintDetailView />, { deps, initial: initialWithId });
    await waitForViewReady(result, (f) => f.includes('stays put'));
    result.stdin.write('p');
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('gh is down'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('stays put');
    expect(saveCalls).toHaveLength(0);
    result.unmount();
  });

  it('pressing p twice while the first publish is in flight creates the issue once', async () => {
    const ticket = makePendingTicket({ title: 'double tap' });
    let stored = { ...makeDraftSprint(), tickets: [ticket] } as unknown as Sprint;
    let createCalls = 0;
    let releaseCreate: (() => void) | undefined;
    const pusher: IssuePusher = {
      async resolveOrigin() {
        return Result.ok({ provider: 'github', hostname: 'github.com', owner: 'x', repo: 'y' });
      },
      async create() {
        createCalls += 1;
        await new Promise<void>((resolve) => {
          releaseCreate = resolve;
        });
        return Result.ok({ url: 'https://github.com/x/y/issues/8' });
      },
      async listComments() {
        return Result.ok([]);
      },
      async comment() {
        return Result.ok(undefined);
      },
    };
    const deps = {
      sprintRepo: {
        async findById() {
          return Result.ok(stored);
        },
        async save(next: Sprint) {
          stored = next;
          return Result.ok(undefined);
        },
      } as unknown as SprintRepository,
      taskRepo: {
        async findBySprintId() {
          return Result.ok([] as readonly Task[]);
        },
      } as unknown as TaskRepository,
      projectRepo: {
        async findById() {
          return Result.ok(makeProject());
        },
      } as unknown as ProjectRepository,
      sprintExecutionRepo: {} as never,
      settingsRepo: {} as never,
      logger: noopLogger,
      issuePusher: pusher,
    } as unknown as AppDeps;
    const initialWithId: ViewEntry = { id: 'sprint-detail', props: { sprintId: stored.id } };
    const { result } = renderView(<SprintDetailView />, { deps, initial: initialWithId });
    await waitForViewReady(result, (f) => f.includes('double tap'));
    result.stdin.write('p');
    await waitForPredicate(() => releaseCreate !== undefined);
    result.stdin.write('p');
    await tick(40);
    expect(createCalls).toBe(1);
    releaseCreate?.();
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('created'));
    expect(createCalls).toBe(1);
    result.unmount();
  });

  it('hides p publish on a done sprint and pressing p never reaches the tracker', async () => {
    const ticket = makeApprovedTicket({ title: 'closed ticket' });
    const sprint = { ...makeDoneSprint(), tickets: [ticket] } as unknown as Sprint;
    let trackerCalls = 0;
    const pusher: IssuePusher = {
      async resolveOrigin() {
        trackerCalls += 1;
        return Result.ok({ provider: 'github', hostname: 'github.com', owner: 'x', repo: 'y' });
      },
      async create() {
        trackerCalls += 1;
        return Result.ok({ url: 'https://github.com/x/y/issues/9' });
      },
      async listComments() {
        trackerCalls += 1;
        return Result.ok([]);
      },
      async comment() {
        trackerCalls += 1;
        return Result.ok(undefined);
      },
    };
    const deps = {
      ...stubDeps(sprint, []),
      projectRepo: {
        async findById() {
          return Result.ok(makeProject());
        },
      } as unknown as ProjectRepository,
      logger: noopLogger,
      issuePusher: pusher,
    } as unknown as AppDeps;
    const initialWithId: ViewEntry = { id: 'sprint-detail', props: { sprintId: sprint.id } };
    const { result } = renderView(<SprintDetailView />, { deps, initial: initialWithId });
    await waitForViewReady(result, (f) => f.includes('closed ticket'));
    expect(result.lastFrame() ?? '').not.toContain('p publish');
    result.stdin.write('p');
    await tick(40);
    expect(trackerCalls).toBe(0);
    result.unmount();
  });
});
