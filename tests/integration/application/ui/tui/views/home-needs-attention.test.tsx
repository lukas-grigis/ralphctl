/**
 * Home's NEEDS ATTENTION group: an interrupted task leads the menu with its attempt and age, a run
 * parked on a prompt reads [WAITING], and a sprint another live process owns shows neither.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { HomeView } from '@src/application/ui/tui/views/home-view.tsx';
import type { AppDeps } from '@src/application/bootstrap/wire.ts';
import type { Runner } from '@src/application/chain/run/runner.ts';
import type { LiveSprintOwner } from '@src/business/runs/find-live-sprint-owner.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { createSessionManager } from '@src/application/ui/tui/runtime/session-manager.ts';
import { createPromptQueue } from '@src/application/ui/tui/prompts/prompt-queue.ts';
import {
  absolutePath,
  makeActiveSprint,
  makeInProgressTaskWithRunningAttempt,
  makeProject,
} from '@tests/fixtures/domain.ts';
import { renderView, waitForViewReady } from '@tests/integration/application/ui/tui/_harness.tsx';

const project = makeProject({ displayName: 'Mainline' });
const sprint = makeActiveSprint();
const task = makeInProgressTaskWithRunningAttempt();

const depsWith = (owner: LiveSprintOwner | undefined): AppDeps =>
  ({
    projectRepo: {
      async list() {
        return Result.ok([project]);
      },
      async findById() {
        return Result.ok(project);
      },
    },
    sprintRepo: {
      async list() {
        return Result.ok([sprint]);
      },
      async findById() {
        return Result.ok(sprint);
      },
    },
    taskRepo: {
      async findBySprintId() {
        return Result.ok([task]);
      },
    },
    settingsRepo: {
      path: '/tmp/test-settings.json',
      async exists() {
        return Result.ok(true);
      },
      async load() {
        return Result.ok(DEFAULT_SETTINGS);
      },
    },
    versionChecker: async () => null,
    findLiveSprintOwner: { execute: () => Promise.resolve(Result.ok(owner)) },
    detectInterruptedRuns: { execute: () => Promise.resolve(Result.ok([])) },
    dismissInterruptedRuns: { execute: () => Promise.resolve(Result.ok(undefined)) },
    gitRunner: { run: () => Promise.reject(new Error('no git in this test')) },
    storage: { dataRoot: absolutePath('/nonexistent-data-root') },
    eventBus: { publish: vi.fn(), subscribe: () => () => undefined },
  }) as unknown as AppDeps;

const mount = (owner: LiveSprintOwner | undefined, extra: Partial<Parameters<typeof renderView>[1]> = {}) =>
  renderView(<HomeView />, {
    deps: depsWith(owner),
    initial: { id: 'home' },
    selection: {
      projectId: project.id,
      projectLabel: project.displayName,
      sprintId: sprint.id,
      sprintLabel: sprint.name,
    },
    ...extra,
  }).result;

afterEach(() => vi.useRealTimers());

describe('Home — needs attention', () => {
  it('leads the menu with the interrupted task, its attempt and age', async () => {
    const result = mount(undefined);
    await waitForViewReady(result, (f) => f.includes('[INTERRUPTED]'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('NEEDS ATTENTION');
    expect(frame).toMatch(/\[INTERRUPTED\] do-the-work · attempt 1 · /);
    expect(frame).toContain('[i]');
    expect(frame.indexOf('NEEDS ATTENTION')).toBeLessThan(frame.indexOf('WORK'));
    // The cursor lands on it, so its resume hint is on screen.
    expect(frame).toContain('↵ resumes Implement');
    result.unmount();
  });

  it('shows nothing interrupted while another live process owns the sprint', async () => {
    const result = mount({ pid: 4321, via: 'run-record' });
    await waitForViewReady(result, (f) => f.includes('WORK'));
    await new Promise((r) => setTimeout(r, 80));
    expect(result.lastFrame() ?? '').not.toContain('[INTERRUPTED]');
    result.unmount();
  });

  it('lists a run parked on a prompt as [WAITING] and opens it', async () => {
    const sessions = createSessionManager();
    sessions.register({
      runner: {
        id: 'r-w',
        status: 'running',
        ctx: {},
        trace: [],
        subscribe: () => () => undefined,
        start: vi.fn(),
        abort: vi.fn(),
      } as unknown as Runner<unknown>,
      flowId: 'refine',
      title: 'Refine — Mainline',
    });
    const queue = createPromptQueue();
    queue.enqueue({ kind: 'confirm', message: 'Proceed?', sessionId: 'r-w', resolve: vi.fn(), reject: vi.fn() });
    const result = mount({ pid: 1, via: 'run-record' }, { sessions, queue });
    await waitForViewReady(result, (f) => f.includes('[WAITING]'));
    const frame = result.lastFrame() ?? '';
    expect(frame).toContain('[WAITING] Refine — Mainline');
    expect(frame).toContain('NEEDS ATTENTION');
    result.unmount();
  });

  it("keeps counting a [WAITING] run's age while Home stays open", async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const sessions = createSessionManager();
    sessions.register({
      runner: {
        id: 'r-age',
        status: 'running',
        ctx: {},
        trace: [],
        subscribe: () => () => undefined,
        start: vi.fn(),
        abort: vi.fn(),
      } as unknown as Runner<unknown>,
      flowId: 'refine',
      title: 'Refine — Mainline',
    });
    const queue = createPromptQueue();
    queue.enqueue({ kind: 'confirm', message: 'Proceed?', sessionId: 'r-age', resolve: vi.fn(), reject: vi.fn() });
    const result = mount({ pid: 1, via: 'run-record' }, { sessions, queue });
    // Fake timers stall the harness's polling helpers; spin on setImmediate instead, and fail loudly if it never loads.
    const until = async (needle: string): Promise<void> => {
      for (let i = 0; i < 5000 && !(result.lastFrame() ?? '').includes(needle); i++) {
        await new Promise((r) => setImmediate(r));
      }
      expect(result.lastFrame() ?? '').toContain(needle);
    };
    await until('[WAITING]');
    // Let the remaining async loads land so nothing but the clock tick can re-render the rows.
    for (let i = 0; i < 200; i++) await new Promise((r) => setImmediate(r));
    expect(result.lastFrame() ?? '').toContain('Refine — Mainline · <1m');
    // The clock moves 30s but no tick has fired: the label must still be stale, so the next change proves the tick.
    // (advancing 30s of fake timers then moves the clock a further 30s — 60s in total, one minute.)
    vi.setSystemTime(Date.now() + 30_000);
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    expect(result.lastFrame() ?? '').toContain('Refine — Mainline · <1m');
    await vi.advanceTimersByTimeAsync(30_000);
    await until('Refine — Mainline · 1m');
    result.unmount();
  }, 60_000); // 30s of fake timers replays every spinner frame as a render — slow on a loaded runner
});
