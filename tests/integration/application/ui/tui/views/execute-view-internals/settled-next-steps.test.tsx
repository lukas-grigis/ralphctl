/**
 * A settled run used to state what happened and nothing about what to do next: `ResultCard`
 * declared a `nextSteps` section that no caller ever filled, a failure showed a bare
 * `DomainError.message` with no pointer to the artifacts on disk, and the only key on offer was
 * `↵ home`. These are the fences for the fix.
 *
 * `g` is deliberately NOT handled by the Execute view — it is a global chord already functional
 * on a settled view with a pinned sprint (`use-global-keys.ts`). Only its hint is new, so the
 * assertions here are about the hint strip, not about a local handler.
 */

import { promises as fs } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ExecuteView } from '@src/application/ui/tui/views/execute-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import type { RunnerStatus } from '@src/application/chain/run/runner.ts';
import type { StoragePaths } from '@src/application/bootstrap/storage-paths.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { ProjectId } from '@src/domain/value/id/project-id.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import {
  makeApprovedTicket,
  makeDraftSprint,
  makePlannedSprint,
  makeReviewSprint,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import { tick } from '@tests/integration/application/ui/tui/_keys.ts';
import { waitForPredicate } from '@tests/integration/application/ui/tui/_wait.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const SPRINT_ID = '01933fbb-3333-7000-8000-0000000000bb' as unknown as SprintId;
const PROJECT_ID = 'project-settled-next' as unknown as ProjectId;

const noopEventBus: EventBus = {
  publish: vi.fn(),
  subscribe: () => () => undefined,
} as unknown as EventBus;

const fakeRunner = (id: string, status: RunnerStatus): Runner<unknown> =>
  ({
    id,
    status,
    ctx: {},
    trace: [],
    subscribe: () => () => undefined,
    start: vi.fn(),
    abort: vi.fn(),
  }) as unknown as Runner<unknown>;

const absPath = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`invalid path ${p}`);
  return r.value;
};

const storageAt = (root: string): StoragePaths =>
  ({
    appRoot: absPath(root),
    dataRoot: absPath(root),
    configRoot: absPath(root),
    stateRoot: absPath(root),
    locksRoot: absPath(root),
    runsRoot: absPath(join(root, 'runs')),
    memoryRoot: absPath(root),
    operatorSkillsRoot: absPath(root),
    operatorAgentDefinitionsRoot: absPath(root),
  }) as unknown as StoragePaths;

const depsWithSprint = (sprint: unknown): AppDeps =>
  ({
    eventBus: noopEventBus,
    sprintRepo: { findById: vi.fn().mockResolvedValue({ ok: true, value: sprint }) },
    sprintExecutionRepo: { findById: vi.fn().mockResolvedValue({ ok: false }) },
    taskRepo: {
      findById: vi.fn().mockResolvedValue({ ok: false }),
      findBySprintId: vi.fn().mockResolvedValue({ ok: true, value: [] }),
    },
  }) as unknown as AppDeps;

describe('Execute view — settled-run next steps', () => {
  it('offers BOTH flows visible at review, not the create-pr the old Home card advised', async () => {
    const sessions = createSessionManager();
    sessions.register({
      runner: fakeRunner('r-settled-review', 'completed'),
      flowId: 'implement',
      title: 'Implement — Review Ready',
      pinnedProjectId: PROJECT_ID,
      pinnedSprintId: SPRINT_ID,
      pinnedSprintLabel: 'Demo Sprint',
    });

    const { result } = renderView(<ExecuteView />, {
      deps: depsWithSprint(makeReviewSprint()),
      initial: { id: 'execute', props: { sessionId: 'r-settled-review' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('Next steps'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Next steps');
    expect(frame).toContain('run review');
    expect(frame).toContain('run close-sprint');
    expect(frame).not.toContain('run create-pr');
    result.unmount();
  });

  it('advertises re-run and progress alongside home once the run settles', async () => {
    const sessions = createSessionManager();
    sessions.register({
      runner: fakeRunner('r-settled-hints', 'completed'),
      flowId: 'implement',
      title: 'Implement — Hints',
      pinnedProjectId: PROJECT_ID,
      pinnedSprintId: SPRINT_ID,
      pinnedSprintLabel: 'Demo Sprint',
    });

    const { result } = renderView(<ExecuteView />, {
      deps: depsWithSprint(makeReviewSprint()),
      initial: { id: 'execute', props: { sessionId: 'r-settled-hints' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('re-run'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('home');
    expect(frame).toContain('re-run');
    expect(frame).toContain('progress');
    result.unmount();
  });

  it('hides the progress hint when the run has no pinned sprint to open', async () => {
    const sessions = createSessionManager();
    sessions.register({
      runner: fakeRunner('r-settled-nopin', 'completed'),
      flowId: 'create-sprint',
      title: 'Create Sprint — No Pin',
    });

    const { result } = renderView(<ExecuteView />, {
      deps: depsWithSprint(undefined),
      initial: { id: 'execute', props: { sessionId: 'r-settled-nopin' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('re-run'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('re-run');
    expect(frame).not.toContain('progress');
    result.unmount();
  });

  it('r RESETS to Flows so the dead run leaves the stack and triggers are re-evaluated', async () => {
    const sessions = createSessionManager();
    sessions.register({
      runner: fakeRunner('r-settled-rerun', 'failed'),
      flowId: 'implement',
      title: 'Implement — Rerun',
      pinnedProjectId: PROJECT_ID,
      pinnedSprintId: SPRINT_ID,
      pinnedSprintLabel: 'Demo Sprint',
    });

    const { result, routeIds } = renderView(<ExecuteView />, {
      deps: depsWithSprint(makeReviewSprint()),
      initial: { id: 'execute', props: { sessionId: 'r-settled-rerun' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('Implement — Rerun'));
    result.stdin.write('r');
    await waitForPredicate(() => routeIds().at(-1) === 'flows');
    expect(routeIds().at(-1)).toBe('flows');
    // A reset (not a push): Home is never routed through, and the run is off the stack.
    expect(routeIds()).not.toContain('home');
    result.unmount();
  });

  it('leaves r unbound while the run is live — no accidental navigation off a running flow', async () => {
    const sessions = createSessionManager();
    sessions.register({
      runner: fakeRunner('r-live-rerun', 'running'),
      flowId: 'implement',
      title: 'Implement — Live',
      pinnedProjectId: PROJECT_ID,
      pinnedSprintId: SPRINT_ID,
    });

    const { result, routeIds } = renderView(<ExecuteView />, {
      deps: depsWithSprint(makeDraftSprint()),
      initial: { id: 'execute', props: { sessionId: 'r-live-rerun' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('Implement — Live'));
    result.stdin.write('r');
    await tick();
    expect(routeIds()).not.toContain('flows');
    result.unmount();
  });

  it('renders the post-mortem block with the paths a failed run actually left behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ralphctl-settled-'));
    const sprintDir = join(root, 'sprints', `${String(SPRINT_ID)}--demo-sprint`);
    await fs.mkdir(sprintDir, { recursive: true });
    await fs.writeFile(join(sprintDir, 'progress.md'), '# progress\n', 'utf8');

    const sessions = createSessionManager();
    sessions.register({
      runner: fakeRunner('r-settled-forensics', 'failed'),
      flowId: 'implement',
      title: 'Implement — Forensics',
      pinnedProjectId: PROJECT_ID,
      pinnedSprintId: SPRINT_ID,
      pinnedSprintLabel: 'Demo Sprint',
    });

    const { result } = renderView(<ExecuteView />, {
      deps: depsWithSprint(makeReviewSprint()),
      initial: { id: 'execute', props: { sessionId: 'r-settled-forensics' } },
      sessions,
      storage: storageAt(root),
    });
    await waitForViewReady(result, (f) => f.includes('Post-mortem'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('Post-mortem');
    expect(frame).toContain('progress.md');
    // There is no `chain.log` anywhere in the tree — advertising one would print a dead path.
    expect(frame).not.toContain('chain.log');
    result.unmount();
  });

  it('advises on the sprint the flow LEFT BEHIND, not the one it started on', async () => {
    // The availability probe reads the sprint once, at mount. A `plan` run moves the sprint
    // draft → planned while that mount-time snapshot sits in state, so without a re-read on the
    // settle edge the finished card recommends re-running the flow that just succeeded.
    let emit: ((event: { readonly type: string }) => void) | undefined;
    const runner = {
      id: 'r-settle-refresh',
      status: 'running',
      ctx: {},
      trace: [],
      subscribe: (listener: (event: { readonly type: string }) => void) => {
        emit = listener;
        return () => undefined;
      },
      start: vi.fn(),
      abort: vi.fn(),
    } as unknown as Runner<unknown>;

    const sessions = createSessionManager();
    sessions.register({
      runner,
      flowId: 'plan',
      title: 'Plan — Refresh',
      pinnedProjectId: PROJECT_ID,
      pinnedSprintId: SPRINT_ID,
      pinnedSprintLabel: 'Demo Sprint',
    });

    const findById = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, value: makeDraftSprint({ tickets: [makeApprovedTicket()] }) })
      .mockResolvedValue({ ok: true, value: makePlannedSprint() });
    const deps = {
      eventBus: noopEventBus,
      sprintRepo: { findById },
      sprintExecutionRepo: { findById: vi.fn().mockResolvedValue({ ok: false }) },
      taskRepo: {
        findById: vi.fn().mockResolvedValue({ ok: false }),
        findBySprintId: vi.fn().mockResolvedValue({ ok: true, value: [makeTodoTask()] }),
      },
    } as unknown as AppDeps;

    const { result } = renderView(<ExecuteView />, {
      deps,
      initial: { id: 'execute', props: { sessionId: 'r-settle-refresh' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('Plan — Refresh'));
    emit?.({ type: 'completed' });

    await waitForViewReady(result, (f) => f.includes('Next steps'));
    await waitForPredicate(() => (result.lastFrame() ?? '').includes('run implement'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('run implement');
    expect(frame).not.toContain('run plan');
    result.unmount();
  });

  it('omits the post-mortem block entirely when the run has no sprint to resolve paths from', async () => {
    // create-sprint has no pin at launch, and a run that failed BEFORE creating the sprint never
    // gets one back-filled. Rendering a guessed path here is exactly the failure mode to avoid.
    const sessions = createSessionManager();
    sessions.register({
      runner: fakeRunner('r-settled-nopath', 'failed'),
      flowId: 'create-sprint',
      title: 'Create Sprint — Failed',
    });

    const { result } = renderView(<ExecuteView />, {
      deps: depsWithSprint(undefined),
      initial: { id: 'execute', props: { sessionId: 'r-settled-nopath' } },
      sessions,
    });
    await waitForViewReady(result, (f) => f.includes('Create Sprint — Failed'));
    const frame = result.lastFrame() ?? '';
    expect(frame).not.toContain('Post-mortem');
    result.unmount();
  });
});
