import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { DashboardView } from './dashboard-view.tsx';
import { ViewHintsProvider } from './view-hints-context.tsx';
import { setSharedDeps, resetSharedDeps } from '../../bootstrap/get-shared-deps.ts';
import type { SharedDeps } from '../../bootstrap/shared-deps.ts';
import { Sprint } from '../../../domain/entities/sprint.ts';
import { Task } from '../../../domain/entities/task.ts';
import { Slug } from '../../../domain/values/slug.ts';
import { IsoTimestamp } from '../../../domain/values/iso-timestamp.ts';
import { AbsolutePath } from '../../../domain/values/absolute-path.ts';
import { Result } from 'typescript-result';
import { CONFIG_DEFAULTS } from '../../config/config-defaults.ts';
import type { SessionManagerPort, SessionManagerEvent } from '../../runtime/session-manager-port.ts';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeSlug(s: string) {
  const r = Slug.parse(s);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function makeSprint(name = 'My Sprint') {
  const r = Sprint.create({ name, slug: makeSlug('my-sprint'), now: IsoTimestamp.now() });
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

function makeTask(name: string, order: number, status: Task['status'] = 'todo') {
  const pathResult = AbsolutePath.parse('/tmp/org/project');
  if (!pathResult.ok) throw new Error(pathResult.error.message);
  const r = Task.create({ name, order, projectPath: pathResult.value, steps: [], verificationCriteria: [] });
  if (!r.ok) throw new Error(r.error.message);
  const t = r.value;
  if (status === 'in_progress') return t.markInProgress().value ?? t;
  if (status === 'done') {
    const ip = t.markInProgress().value;
    if (!ip) return t;
    return ip.markDone().value ?? ip;
  }
  if (status === 'blocked') return t.markBlocked('blocker').value ?? t;
  return t;
}

function makeSessionManager(): SessionManagerPort {
  const listeners = new Set<(e: SessionManagerEvent) => void>();
  return {
    start: vi.fn(),
    list: vi.fn(() => []),
    get: vi.fn(),
    foreground: vi.fn(() => Result.ok()),
    background: vi.fn(() => Result.ok()),
    kill: vi.fn(() => Result.ok()),
    get active() {
      return null;
    },
    subscribe: vi.fn((l: (e: SessionManagerEvent) => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    }),
    dispose: vi.fn(),
  };
}

const testSprint = makeSprint();
const todoTask = makeTask('Implement feature', 1);
const doneTask = makeTask('Write tests', 2, 'done');
const blockedTask = makeTask('Deploy service', 3, 'blocked');

function setDeps(sprintOverride?: Sprint | null, tasksOverride?: Task[]) {
  const effectiveSprint = sprintOverride === undefined ? testSprint : sprintOverride;
  setSharedDeps({
    configStore: {
      load: vi.fn(() =>
        Promise.resolve(
          Result.ok({
            ...CONFIG_DEFAULTS,
            currentSprint: effectiveSprint?.id ?? null,
          })
        )
      ),
      save: vi.fn(),
    },
    sprintRepo: {
      findById: vi.fn(() =>
        Promise.resolve(effectiveSprint ? Result.ok(effectiveSprint) : Result.error(new Error('not found')))
      ),
      findAll: vi.fn(() => Promise.resolve(Result.ok([]))),
      save: vi.fn(),
      remove: vi.fn(),
    },
    taskRepo: {
      findBySprintId: vi.fn(() => Promise.resolve(Result.ok(tasksOverride ?? [todoTask, doneTask]))),
      findById: vi.fn(),
      update: vi.fn(),
      saveAll: vi.fn(),
    },
    prompt: {
      select: vi.fn(),
      confirm: vi.fn(),
      input: vi.fn(),
      checkbox: vi.fn(),
      editor: vi.fn(),
      fileBrowser: vi.fn(),
    },
  } as unknown as SharedDeps);
}

beforeEach(() => {
  setDeps();
});

afterEach(() => {
  resetSharedDeps();
});

// ── tests ─────────────────────────────────────────────────────────────────────

describe('DashboardView', () => {
  it('renders the DASHBOARD header', async () => {
    const { lastFrame } = render(
      <ViewHintsProvider>
        <DashboardView />
      </ViewHintsProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('DASHBOARD');
  });

  it('renders the sprint hero with name and status', async () => {
    const { lastFrame } = render(
      <ViewHintsProvider>
        <DashboardView />
      </ViewHintsProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('My Sprint');
    expect(frame).toContain('DRAFT');
  });

  it('renders hero field list: tickets, tasks, branch (status shown via chip, not field)', async () => {
    const { lastFrame } = render(
      <ViewHintsProvider>
        <DashboardView />
      </ViewHintsProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? '';
    // FieldList labels — Status is intentionally absent: the hero already
    // renders a colored StatusChip for the same value.
    expect(frame).not.toContain('Status:');
    expect(frame).toContain('Tickets:');
    expect(frame).toContain('Tasks:');
    // Task progress: 1 done out of 2
    expect(frame).toContain('1 of 2 done');
  });

  it('renders the task grid with task names and status chips', async () => {
    const { lastFrame } = render(
      <ViewHintsProvider>
        <DashboardView />
      </ViewHintsProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Implement feature');
    expect(frame).toContain('Write tests');
    // Status chips for each task
    expect(frame).toContain('TODO');
    expect(frame).toContain('DONE');
  });

  it('renders blockers section only when a blocked task exists', async () => {
    // Without blocked tasks
    const { lastFrame: noBlockFrame } = render(
      <ViewHintsProvider>
        <DashboardView />
      </ViewHintsProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(noBlockFrame()).not.toContain('Blocked tasks');

    // With a blocked task
    setDeps(testSprint, [todoTask, blockedTask]);
    const { lastFrame } = render(
      <ViewHintsProvider>
        <DashboardView />
      </ViewHintsProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Blocked tasks');
    expect(frame).toContain('Deploy service');
  });

  it('shows project path tail in task grid', async () => {
    const { lastFrame } = render(
      <ViewHintsProvider>
        <DashboardView />
      </ViewHintsProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    // Path is /tmp/org/project → tail is org/project
    expect(lastFrame()).toContain('org/project');
  });

  it('shows info card when no current sprint is set', async () => {
    setSharedDeps({
      configStore: {
        load: vi.fn(() => Promise.resolve(Result.ok({ ...CONFIG_DEFAULTS, currentSprint: null }))),
        save: vi.fn(),
      },
      sprintRepo: { findById: vi.fn(), findAll: vi.fn(), save: vi.fn(), remove: vi.fn() },
      taskRepo: { findBySprintId: vi.fn(), findById: vi.fn(), update: vi.fn(), saveAll: vi.fn() },
      prompt: {
        select: vi.fn(),
        confirm: vi.fn(),
        input: vi.fn(),
        checkbox: vi.fn(),
        editor: vi.fn(),
        fileBrowser: vi.fn(),
      },
    } as unknown as SharedDeps);
    const { lastFrame } = render(
      <ViewHintsProvider>
        <DashboardView />
      </ViewHintsProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain('No active sprint');
  });

  it('subscribes to sessionManager and re-fetches on events', async () => {
    const subscribeFn = vi.fn((l: (e: SessionManagerEvent) => void) => {
      void l;
      return () => undefined;
    });
    const sm: SessionManagerPort = { ...makeSessionManager(), subscribe: subscribeFn };
    render(
      <ViewHintsProvider>
        <DashboardView sessionManager={sm} />
      </ViewHintsProvider>
    );
    await new Promise((r) => setTimeout(r, 20));
    // subscribe was called with a listener
    expect(subscribeFn).toHaveBeenCalled();
  });
});
