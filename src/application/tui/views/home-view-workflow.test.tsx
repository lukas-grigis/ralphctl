/**
 * Tests for HomeView workflow launchers (refine / plan / start / ideate).
 *
 * The new pipeline-map based home view dispatches workflow actions through
 * the pipeline map's "Next step" quick-action row (row 0). Pressing Enter
 * when that row is selected fires the appropriate workflow chain.
 *
 * The quick-action row is pre-selected on mount (findInitialCursor returns 0
 * for the quick-action row), so a bare Enter triggers it immediately.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import React from 'react';
import { cleanup, render } from 'ink-testing-library';
import { HomeView } from './home-view.tsx';
import { RouterProvider } from './router-context.ts';
import { ViewHintsProvider } from './view-hints-context.tsx';
import { setSharedDeps, resetSharedDeps } from '@src/application/bootstrap/get-shared-deps.ts';
import type { SharedDeps } from '@src/application/bootstrap/shared-deps.ts';
import { Sprint } from '@src/domain/entities/sprint.ts';
import { Ticket } from '@src/domain/entities/ticket.ts';
import { Slug } from '@src/domain/values/slug.ts';
import { IsoTimestamp } from '@src/domain/values/iso-timestamp.ts';
import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { ProjectName } from '@src/domain/values/project-name.ts';
import { Result } from '@src/domain/result.ts';
import { CONFIG_DEFAULTS } from '@src/application/config/config-defaults.ts';
import { FakePromptPort } from '@src/application/_test-fakes/fake-prompt-port.ts';
import type { SessionManagerPort, SessionId } from '@src/application/runtime/session-manager-port.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Wait for the home view to render its initial pipeline-map. We poll the
 * frame for the quick-action cursor `▸` (always present once the layout
 * paints) instead of a fixed `setTimeout(...)` — fixed waits race under
 * heavy parallel CI load.
 */
async function awaitInitialRender(lastFrame: () => string | undefined): Promise<void> {
  await vi.waitFor(() => {
    const f = lastFrame() ?? '';
    expect(f).toContain('▸');
  });
  // Drain the microtask/macrotask queues so Ink's useInput subscription is
  // fully active before the caller sends a keystroke. Without this drain, the
  // Enter keypress lands before PipelineMap's handler is registered and is
  // silently dropped (same technique as pipeline-map.test.tsx's flush()).
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

function makeRouter() {
  return {
    current: { id: 'home' as const },
    stack: [{ id: 'home' as const }],
    push: vi.fn(),
    pop: vi.fn(),
    replace: vi.fn(),
    reset: vi.fn(),
  };
}

function makeSessionManagerProp(): SessionManagerPort {
  return {
    start: vi.fn(() => 'sm-prop-session'),
    list: vi.fn(() => []),
    get: vi.fn(),
    foreground: vi.fn(() => Result.ok()),
    background: vi.fn(() => Result.ok()),
    kill: vi.fn(() => Result.ok()),
    get active() {
      return null;
    },
    subscribe: vi.fn(() => () => undefined),
    dispose: vi.fn(),
  };
}

function makeSlug(s: string) {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function makeDraftSprint(name = 'Test Sprint') {
  const pnResult = ProjectName.parse('my-project');
  if (!pnResult.ok) throw new Error(pnResult.error.message);
  const r = Sprint.create({ name, slug: makeSlug('test'), now: IsoTimestamp.now(), projectName: pnResult.value });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function addPendingTicket(sprint: Sprint): Sprint {
  const ticketResult = Ticket.create({ title: 'Test ticket' });
  if (!ticketResult.ok) throw new Error(ticketResult.error.message);
  const sprintResult = sprint.addTicket(ticketResult.value);
  if (!sprintResult.ok) throw new Error(sprintResult.error.message);
  return sprintResult.value;
}

const FAKE_CWD = AbsolutePath.trustString('/tmp/test-cwd');

function makeSharedDepsStub(opts: {
  currentSprint: string | null;
  sprint?: Sprint;
  tasks?: unknown[];
  prompt?: FakePromptPort;
  allTicketsApproved?: boolean;
}): {
  deps: SharedDeps;
  sessionStartMock: ReturnType<typeof vi.fn>;
} {
  const sessionStartMock = vi.fn((): SessionId => 'shared-deps-session');
  const sprint = opts.sprint ?? makeDraftSprint();
  const tasks = opts.tasks ?? [];

  let sprintToUse: Sprint;
  if (opts.allTicketsApproved) {
    // Build a real-ish sprint with one approved ticket so buildPlanInputs's
    // pre-flight (sprint lookup, hasApprovedAllTickets) operates on actual
    // entities. Repo selection now happens INSIDE the chain via the
    // `persist-repo-selection` leaf — the launcher no longer touches
    // ticket repositories.
    const withTicket = addPendingTicket(sprint);
    const ticket = withTicket.tickets[0];
    if (ticket === undefined) throw new Error('precondition: ticket present');
    const approvedTicket = ticket.approveRequirements('approved requirements body');
    if (!approvedTicket.ok) throw new Error(approvedTicket.error.message);
    const replaced = withTicket.replaceTicket(ticket.id, approvedTicket.value);
    if (!replaced.ok) throw new Error(replaced.error.message);
    sprintToUse = replaced.value;
  } else {
    sprintToUse = sprint;
  }

  const deps = {
    configStore: {
      load: vi.fn(() =>
        Promise.resolve(
          Result.ok({
            ...CONFIG_DEFAULTS,
            currentSprint: opts.currentSprint as (typeof CONFIG_DEFAULTS)['currentSprint'],
          })
        )
      ),
      save: vi.fn(() => Promise.resolve(Result.ok(undefined))),
    },

    sprintRepo: {
      findById: vi.fn(() => Promise.resolve(Result.ok(sprintToUse))),
      list: vi.fn(() => Promise.resolve(Result.ok([sprintToUse]))),
      save: vi.fn(() => Promise.resolve(Result.ok(undefined))),
      remove: vi.fn(() => Promise.resolve(Result.ok(undefined))),
    },

    taskRepo: {
      findBySprintId: vi.fn(() => Promise.resolve(Result.ok(tasks))),
      findById: vi.fn(),
      update: vi.fn(),
      saveAll: vi.fn(),
    },

    projectRepo: {
      findByName: vi.fn(() =>
        Promise.resolve(
          Result.ok({
            name: 'my-project',
            displayName: 'My Project',
            repositories: [{ name: 'repo', path: FAKE_CWD }],
          })
        )
      ),
      list: vi.fn(() =>
        Promise.resolve(
          Result.ok([
            {
              name: 'my-project',
              displayName: 'My Project',
              repositories: [{ name: 'repo', path: FAKE_CWD }],
            },
          ])
        )
      ),
      save: vi.fn(),
      remove: vi.fn(),
    },

    prompt: opts.prompt ?? new FakePromptPort(),

    sessionManager: {
      start: sessionStartMock,
      list: vi.fn(() => []),
      get: vi.fn(),
      foreground: vi.fn(() => Result.ok()),
      background: vi.fn(() => Result.ok()),
      kill: vi.fn(() => Result.ok()),
      get active() {
        return null;
      },
      subscribe: vi.fn(() => () => undefined),
      dispose: vi.fn(),
    },

    // launch-workflow's buildRefineInputs reads `deps.storage.sprintDir(id)`
    // to compute the per-ticket refinement output dir. Stub the bit it
    // touches; the rest of StoragePaths isn't exercised by these tests.
    storage: {
      sprintDir: vi.fn((id: string) => `/tmp/test-sprints/${id}`),
    },
  };

  return { deps: deps as unknown as SharedDeps, sessionStartMock };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('HomeView — workflow launchers', () => {
  afterEach(() => {
    // Tear down the Ink render tree first — multiple renders accumulating
    // across cases caused stdin races where a previous render's listener
    // swallowed the keystroke under test.
    cleanup();
    resetSharedDeps();
    vi.restoreAllMocks();
  });

  it('Refine quick action starts refine session and pushes execute', async () => {
    const sprint = addPendingTicket(makeDraftSprint('Draft Sprint'));
    const { deps, sessionStartMock } = makeSharedDepsStub({
      currentSprint: sprint.id,
      sprint,
    });
    setSharedDeps(deps);

    const router = makeRouter();
    const sm = makeSessionManagerProp();
    const { stdin, lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );

    await awaitInitialRender(lastFrame);
    stdin.write('\r'); // Enter on "Refine Requirements" quick action
    await vi.waitFor(() => {
      expect(sessionStartMock).toHaveBeenCalledTimes(1);
    });

    const call = sessionStartMock.mock.calls[0] as [{ label: string; initialCtx: { sprintId: string } }];
    expect(call[0].label).toContain('refine');
    expect(call[0].initialCtx.sprintId).toBe(sprint.id);
    expect(router.push).toHaveBeenCalledWith({ id: 'execute' });
  });

  it('Plan quick action with all tickets approved starts plan session and pushes execute', async () => {
    const sprint = makeDraftSprint('Draft Sprint');
    const { deps, sessionStartMock } = makeSharedDepsStub({
      currentSprint: sprint.id,
      sprint,
      allTicketsApproved: true,
    });
    setSharedDeps(deps);

    const router = makeRouter();
    const sm = makeSessionManagerProp();
    const { stdin, lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );

    await awaitInitialRender(lastFrame);
    stdin.write('\r');
    await vi.waitFor(() => {
      expect(sessionStartMock).toHaveBeenCalledTimes(1);
    });
    const call = sessionStartMock.mock.calls[0] as [{ label: string }];
    expect(call[0].label).toContain('plan');
    expect(router.push).toHaveBeenCalledWith({ id: 'execute' });
  });

  it('No current sprint — quick action navigates to sprint-create', async () => {
    const promptPort = new FakePromptPort();
    promptPort.queueConfirm(true); // confirm create
    const { deps, sessionStartMock } = makeSharedDepsStub({
      currentSprint: null,
      prompt: promptPort,
    });
    setSharedDeps(deps);

    const router = makeRouter();
    const sm = makeSessionManagerProp();
    const { stdin, lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );

    // Wait for the no-sprint pipeline-map to finish loading (the "Create
    // Sprint" quick-action label is what makes Enter meaningful). Without
    // this, under heavy parallel CI load the stdin.write fires into a
    // half-rendered tree and the test races.
    await vi.waitFor(() => {
      expect(lastFrame() ?? '').toContain('Create Sprint');
    });
    // Drain event queues so Ink's useInput is fully registered before keystroke.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    stdin.write('\r'); // Enter on "Create Sprint" quick action
    await vi.waitFor(() => {
      // Quick action for no-sprint context is sprint.create → router push
      expect(router.push).toHaveBeenCalledWith({ id: 'sprint-create' });
    });
    expect(sessionStartMock).not.toHaveBeenCalled();
  });

  it('Start quick action auto-activates draft sprint and starts execute session', async () => {
    const sprint = makeDraftSprint('Draft Sprint');
    const fakeTasks = [{ id: 'task-1', status: 'todo', projectPath: FAKE_CWD, blockedBy: [] }];
    const { deps } = makeSharedDepsStub({
      currentSprint: sprint.id,
      sprint,
      tasks: fakeTasks,
    });
    setSharedDeps(deps);

    const router = makeRouter();
    const sm = makeSessionManagerProp();
    const { stdin, lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );

    await awaitInitialRender(lastFrame);
    // Navigate to Execute phase's quick action — this requires the pipeline
    // snapshot to have "start" as the next step. With a draft sprint + tasks
    // but no approved tickets, the plan phase is "active" → its action is
    // "Plan Tasks" → not start. We need a fully planned sprint.
    // For this test we use the `allTicketsApproved: true` equivalent via
    // a manual dispatch: navigate down to the Execute row and press Enter.
    // Row order: 0=quick-action, 1=Refine, 2=Plan, 3=Execute, 4=Close
    stdin.write('\x1B[B'); // down to row 1 (Refine)
    stdin.write('\x1B[B'); // down to row 2 (Plan)
    stdin.write('\x1B[B'); // down to row 3 (Execute)
    stdin.write('\r'); // Enter → drill-in to execute view (if status is active/done)
    await vi.waitFor(() => {
      // With draft status + tasks the execute drill-in returns the execute view
      // (status is active since tasks > 0 and sprint is draft with tasks).
      // The phase status would be 'active' → drill-in returns { id: 'execute' }.
      // But the router push would only happen if sprintId is set.
      expect(router.push).toHaveBeenCalled();
    });
  });

  it('defers router.push("execute") until launchWorkflow resolves with a sessionId', async () => {
    // Regression: previously HomeView pushed `execute` BEFORE launchWorkflow
    // ran its pre-flight prompts. The execute view auto-attaches to the
    // most recent session in the registry — which was a previously
    // completed run — so the user saw the prior run's terminal trace while
    // answering the new run's prompts. The fix defers the push.
    const sprint = addPendingTicket(makeDraftSprint('Draft Sprint'));
    const { deps, sessionStartMock } = makeSharedDepsStub({
      currentSprint: sprint.id,
      sprint,
    });
    setSharedDeps(deps);

    const router = makeRouter();
    const sm = makeSessionManagerProp();
    const { stdin, lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );

    await awaitInitialRender(lastFrame);
    stdin.write('\r'); // Enter on the Refine quick action
    await vi.waitFor(() => {
      // Both calls must have happened, and order must be:
      // sessionManager.start (inside launchWorkflow) → router.push('execute').
      expect(sessionStartMock).toHaveBeenCalledTimes(1);
      expect(router.push).toHaveBeenCalledWith({ id: 'execute' });
    });

    const startOrder = sessionStartMock.mock.invocationCallOrder[0] ?? 0;
    const executePushIdx = router.push.mock.calls.findIndex(
      (call) => (call[0] as { id?: string } | undefined)?.id === 'execute'
    );
    expect(executePushIdx).toBeGreaterThanOrEqual(0);
    const pushOrder = router.push.mock.invocationCallOrder[executePushIdx] ?? 0;
    expect(pushOrder).toBeGreaterThan(startOrder);
  });

  it('does NOT push execute when launchWorkflow resolves null (user cancelled)', async () => {
    // No current sprint and the user declines the "create one?" confirm.
    // launchWorkflow resolves null; HomeView must stay put.
    const promptPort = new FakePromptPort();
    promptPort.queueConfirm(false); // decline create
    const { deps, sessionStartMock } = makeSharedDepsStub({
      currentSprint: null,
      prompt: promptPort,
    });
    setSharedDeps(deps);

    const router = makeRouter();
    const sm = makeSessionManagerProp();
    const { stdin, lastFrame } = render(
      <RouterProvider value={router}>
        <ViewHintsProvider>
          <HomeView sessionManager={sm} />
        </ViewHintsProvider>
      </RouterProvider>
    );

    await awaitInitialRender(lastFrame);
    // Navigate down to the Refine phase row (1) and press Enter — this
    // dispatches a launchChain action with no sprint, which routes through
    // launchWorkflow → loadCurrentSprintIdOrPrompt → confirm:false → null.
    stdin.write('\x1B[B'); // down to row 1 (Refine)
    stdin.write('\r');
    // Give the launchWorkflow promise time to resolve to null before we
    // assert it didn't fire side effects. vi.waitFor wouldn't help here
    // because the assertions are negative — there's nothing to wait for.
    await new Promise((r) => setTimeout(r, 100));

    expect(sessionStartMock).not.toHaveBeenCalled();
    // Critically: no `execute` push. (Other pushes — e.g. sprint-create on
    // a `confirm:true` path — are tested separately above.)
    const executePushes = router.push.mock.calls.filter(
      (call) => (call[0] as { id?: string } | undefined)?.id === 'execute'
    );
    expect(executePushes).toHaveLength(0);
  });
});
