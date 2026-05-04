// Legacy intent: src/business/pipelines/*.test.ts step-order + failure path coverage
import { describe, expect, it } from 'vitest';

import { FakeExternalPort } from '@src/business/_test-fakes/fake-external-port.ts';
import { FakePromptPort } from '@src/application/_test-fakes/fake-prompt-port.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';
import { abs, makeApprovedTicket, makeSprint, makeTask, taskId } from '@src/application/_test-fakes/fixtures.ts';
import { createTestDeps } from '@src/application/_test-fakes/create-test-deps.ts';
import { createExecuteFlow } from './execute-flow.ts';

const CWD = abs('/tmp/exec-test');

const taskCompleteSignal: HarnessSignal = {
  type: 'task-complete',
  timestamp: '2026-04-29T12:00:00Z' as never,
};

describe('createExecuteFlow', () => {
  it('runs load-sprint → assert-active → load-tasks → reset-stale-in-progress → assert-tasks-not-empty → assert-tasks-blocked-by-resolvable → assert-tasks-acyclic → [initialize: resolve-branch → dirty-tree-preflight → check-scripts-sprint-start] → link-skills → execute-tasks → unlink-skills → summarise-execution', async () => {
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition');
    // Pre-set the sprint branch so resolve-branch skips the prompt
    // (resume case). Prompt-driven resolution is exercised separately.
    const branched = activated.value.setBranch('ralphctl/test');
    if (!branched.ok) throw new Error('precondition');

    const task = makeTask({ name: 'do work', projectPath: '/tmp/demo-repo' });
    const deps = createTestDeps({
      sprints: [branched.value],
      tasks: [[branched.value.id, [task]]],
      aiSession: {
        // Two outputs: execute-task, then evaluate-task (nested chain).
        outcomes: [
          { kind: 'ok', result: { output: 'done' } },
          { kind: 'ok', result: { output: 'evaluator output' } },
        ],
      },
      signalParser: {
        results: [
          [taskCompleteSignal],
          [
            {
              type: 'evaluation',
              status: 'passed',
              dimensions: [],
              critique: 'lgtm',
              timestamp: '2026-04-29T12:00:00Z' as never,
            },
          ],
        ],
      },
    });

    const flow = createExecuteFlow(deps, {
      sprintId: branched.value.id,
      cwd: CWD,
      expectedBranch: 'ralphctl/test',
      tasks: [task],
      sprint: branched.value,
    });

    const result = await flow.execute({
      sprintId: branched.value.id,
      cwd: CWD,
      expectedBranch: 'ralphctl/test',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The kernel's Sequential flattens child traces: a nested Sequential's
    // own name never appears as a trace entry — only Leaf entries do.
    // So `'initialize'` (which wraps resolve-branch → dirty-tree-preflight →
    // check-scripts-sprint-start) and `'execute-tasks'` (which wraps the
    // per-task bridges) do NOT appear in headlineSteps; their children surface
    // flatly in the same order as before.
    const headlineSteps = [
      'load-sprint',
      'assert-active',
      'load-tasks',
      'reset-stale-in-progress',
      'assert-tasks-not-empty',
      'assert-tasks-blocked-by-resolvable',
      'assert-tasks-acyclic',
      'resolve-branch',
      'dirty-tree-preflight',
      'check-scripts-sprint-start',
      'link-skills',
      'unlink-skills',
      'summarise-execution',
    ];
    const trace = result.value.trace.map((t) => t.stepName);
    const headline = trace.filter((n) => headlineSteps.includes(n));
    expect(headline).toStrictEqual(headlineSteps);

    // The inner Sequential surfaces its child trace as `task-<id>`
    // between link-skills and unlink-skills.
    const linkIdx = trace.indexOf('link-skills');
    const unlinkIdx = trace.indexOf('unlink-skills');
    expect(linkIdx).toBeGreaterThan(-1);
    expect(unlinkIdx).toBeGreaterThan(linkIdx);
    expect(trace.slice(linkIdx + 1, unlinkIdx)).toContain(`task-${task.id}`);
  });

  it('fails at assert-active when the sprint is still draft', async () => {
    const sprint = makeSprint();
    const task = makeTask({ name: 'do work' });

    const deps = createTestDeps({
      sprints: [sprint],
      tasks: [[sprint.id, [task]]],
    });

    const flow = createExecuteFlow(deps, {
      sprintId: sprint.id,
      cwd: CWD,
      expectedBranch: '',
      tasks: [task],
      sprint,
    });

    const result = await flow.execute({
      sprintId: sprint.id,
      cwd: CWD,
      expectedBranch: '',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.trace[1]?.stepName).toBe('assert-active');
    expect(result.error.trace[1]?.status).toBe('failed');
  });

  it('fails at assert-tasks-not-empty when no tasks exist', async () => {
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition');

    const deps = createTestDeps({ sprints: [activated.value] });

    const flow = createExecuteFlow(deps, {
      sprintId: activated.value.id,
      cwd: CWD,
      expectedBranch: '',
      tasks: [],
      sprint: activated.value,
    });

    const result = await flow.execute({
      sprintId: activated.value.id,
      cwd: CWD,
      expectedBranch: '',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const failed = result.error.trace.find((t) => t.status === 'failed');
    expect(failed?.stepName).toBe('assert-tasks-not-empty');
  });

  it('abort propagation: pre-aborted signal marks in-flight step "aborted" and chain fails', async () => {
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition');
    const task = makeTask({ name: 'do work' });

    const deps = createTestDeps({
      sprints: [activated.value],
      tasks: [[activated.value.id, [task]]],
    });

    const flow = createExecuteFlow(deps, {
      sprintId: activated.value.id,
      cwd: CWD,
      expectedBranch: '',
      tasks: [task],
      sprint: activated.value,
    });

    const ac = new AbortController();
    ac.abort();

    const result = await flow.execute({ sprintId: activated.value.id, cwd: CWD, expectedBranch: '' }, ac.signal);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('aborted');
    expect(result.error.trace.some((t) => t.status === 'aborted')).toBe(true);
  });

  it('dirty-tree-preflight short-circuits the chain when the user cancels', async () => {
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition');
    // Pre-set sprint branch so resolve-branch skips the prompt and
    // dirty-tree-preflight is the first prompt-driven step we hit.
    const branched = activated.value.setBranch('ralphctl/dirty');
    if (!branched.ok) throw new Error('precondition');
    const task = makeTask({ name: 'do work', projectPath: '/tmp/dirty-repo' });

    const dirtyExternal = new FakeExternalPort({ uncommitted: true });
    const prompt = new FakePromptPort();
    prompt.queueSelect('cancel');

    const deps = createTestDeps({
      sprints: [branched.value],
      tasks: [[branched.value.id, [task]]],
      overrides: { external: dirtyExternal, prompt },
    });

    const flow = createExecuteFlow(deps, {
      sprintId: branched.value.id,
      cwd: CWD,
      expectedBranch: 'ralphctl/dirty',
      tasks: [task],
      sprint: branched.value,
    });

    const result = await flow.execute({
      sprintId: branched.value.id,
      cwd: CWD,
      expectedBranch: 'ralphctl/dirty',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The new step landed in the trace between resolve-branch and
    // check-scripts-sprint-start. Failure is the dirty-tree-preflight step
    // itself; subsequent steps are kernel-skipped (status 'skipped').
    const failed = result.error.trace.find((t) => t.status === 'failed');
    expect(failed?.stepName).toBe('dirty-tree-preflight');
    const checkSprintStart = result.error.trace.find((t) => t.stepName === 'check-scripts-sprint-start');
    expect(checkSprintStart?.status).toBe('skipped');
    const executeTasks = result.error.trace.find((t) => t.stepName === 'execute-tasks');
    expect(executeTasks?.status).toBe('skipped');
    // No stash / reset calls when the user cancelled.
    expect(dirtyExternal.stashCalls).toHaveLength(0);
    expect(dirtyExternal.hardResetCalls).toHaveLength(0);
  });

  it('runs per-task chains sequentially in dependency order', async () => {
    // Two independent tasks — order is preserved by the topological sort
    // (both have no deps; stable input order is the tiebreaker). Each
    // task spawns one execute + one evaluate AI session.
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition');
    const branched = activated.value.setBranch('ralphctl/seq');
    if (!branched.ok) throw new Error('precondition');

    const tasks = [makeTask({ name: 'a', order: 1 }), makeTask({ name: 'b', order: 2 })];

    const okOutput = { output: 'done' };
    const deps = createTestDeps({
      sprints: [branched.value],
      tasks: [[branched.value.id, tasks]],
      aiSession: {
        outcomes: [
          { kind: 'ok', result: okOutput },
          { kind: 'ok', result: okOutput },
          { kind: 'ok', result: okOutput },
          { kind: 'ok', result: okOutput },
        ],
      },
      signalParser: {
        results: [
          [taskCompleteSignal],
          [
            {
              type: 'evaluation',
              status: 'passed',
              dimensions: [],
              critique: '',
              timestamp: '2026-04-29T12:00:00Z' as never,
            },
          ],
          [taskCompleteSignal],
          [
            {
              type: 'evaluation',
              status: 'passed',
              dimensions: [],
              critique: '',
              timestamp: '2026-04-29T12:00:00Z' as never,
            },
          ],
        ],
      },
    });

    const flow = createExecuteFlow(deps, {
      sprintId: branched.value.id,
      cwd: CWD,
      expectedBranch: 'ralphctl/seq',
      tasks,
      sprint: branched.value,
    });

    const result = await flow.execute({
      sprintId: branched.value.id,
      cwd: CWD,
      expectedBranch: 'ralphctl/seq',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const [firstTask, secondTask] = tasks;
    if (!firstTask || !secondTask) throw new Error('precondition');

    // Both task bridges show up in the trace, and they appear in the
    // input order (no deps → stable Kahn order).
    const bridgeSteps = result.value.trace.map((t) => t.stepName).filter((n) => n.startsWith('task-'));
    expect(bridgeSteps).toStrictEqual([`task-${firstTask.id}`, `task-${secondTask.id}`]);

    // Sequential semantics: A's full lifecycle (started → finished) lands
    // before B's started fires.
    const bus = deps.signalBus as unknown as { events: { type: string; taskId?: unknown }[] };
    const lifecycleByTask: { task: 'A' | 'B'; type: string }[] = [];
    for (const e of bus.events) {
      if (e.type !== 'task-started' && e.type !== 'task-finished') continue;
      const id = String(e.taskId);
      if (id === String(firstTask.id)) lifecycleByTask.push({ task: 'A', type: e.type });
      else if (id === String(secondTask.id)) lifecycleByTask.push({ task: 'B', type: e.type });
    }
    const aStarted = lifecycleByTask.findIndex((e) => e.task === 'A' && e.type === 'task-started');
    const aFinished = lifecycleByTask.findIndex((e) => e.task === 'A' && e.type === 'task-finished');
    const bStarted = lifecycleByTask.findIndex((e) => e.task === 'B' && e.type === 'task-started');
    expect(aStarted).toBeGreaterThan(-1);
    expect(aFinished).toBeGreaterThan(aStarted);
    expect(bStarted).toBeGreaterThan(aFinished);
  });

  it('topologically reorders tasks so a dependent runs after its dependency, even when the input list is reversed', async () => {
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition');
    const branched = activated.value.setBranch('ralphctl/topo');
    if (!branched.ok) throw new Error('precondition');

    // taskA has no deps; taskC blockedBy taskA. Pass them in C-then-A
    // order so on-disk ordering can't accidentally satisfy the test —
    // the linearisation must reorder them.
    const taskA = makeTask({ name: 'a', order: 1, projectPath: '/tmp/repo-a' });
    const taskC = makeTask({ name: 'c', order: 2, projectPath: '/tmp/repo-c', blockedBy: [taskA.id] });

    const okOutput = { output: 'done' };
    const passSignal = {
      type: 'evaluation' as const,
      status: 'passed' as const,
      dimensions: [],
      critique: '',
      timestamp: '2026-04-29T12:00:00Z' as never,
    };

    const deps = createTestDeps({
      sprints: [branched.value],
      tasks: [[branched.value.id, [taskC, taskA]]],
      aiSession: {
        outcomes: [
          { kind: 'ok', result: okOutput },
          { kind: 'ok', result: okOutput },
          { kind: 'ok', result: okOutput },
          { kind: 'ok', result: okOutput },
        ],
      },
      signalParser: {
        results: [[taskCompleteSignal], [passSignal], [taskCompleteSignal], [passSignal]],
      },
    });

    const flow = createExecuteFlow(deps, {
      sprintId: branched.value.id,
      cwd: CWD,
      expectedBranch: 'ralphctl/topo',
      // Reversed: C before A. The chain must still run A first.
      tasks: [taskC, taskA],
      sprint: branched.value,
    });

    const result = await flow.execute({
      sprintId: branched.value.id,
      cwd: CWD,
      expectedBranch: 'ralphctl/topo',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const bridgeSteps = result.value.trace.map((t) => t.stepName).filter((n) => n.startsWith('task-'));
    // A appears before C in the trace despite the input list being reversed.
    expect(bridgeSteps).toStrictEqual([`task-${taskA.id}`, `task-${taskC.id}`]);
  });

  it('fails at assert-tasks-acyclic when the task graph contains a cycle', async () => {
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition');
    const branched = activated.value.setBranch('ralphctl/cycle');
    if (!branched.ok) throw new Error('precondition');

    // taskA depends on taskB; taskB depends on taskA — a true cycle.
    // We must use stable, pre-declared ids so each task can reference the
    // other's real id (makeTask mints a fresh id per call, so we pass
    // explicit ids here to form the mutual dependency correctly).
    const idA = taskId('cycle-task-a');
    const idB = taskId('cycle-task-b');
    const taskACycled = makeTask({ id: idA, name: 'a', order: 1, blockedBy: [idB] });
    const taskBCycled = makeTask({ id: idB, name: 'b', order: 2, blockedBy: [idA] });

    const deps = createTestDeps({
      sprints: [branched.value],
      tasks: [[branched.value.id, [taskACycled, taskBCycled]]],
    });

    const flow = createExecuteFlow(deps, {
      sprintId: branched.value.id,
      cwd: CWD,
      expectedBranch: 'ralphctl/cycle',
      tasks: [taskACycled, taskBCycled],
      sprint: branched.value,
    });

    const result = await flow.execute({
      sprintId: branched.value.id,
      cwd: CWD,
      expectedBranch: 'ralphctl/cycle',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const failed = result.error.trace.find((t) => t.status === 'failed');
    expect(failed?.stepName).toBe('assert-tasks-acyclic');
    expect(result.error.error.code).toBe('invalid-state');
  });

  // ── assert-tasks-blocked-by-resolvable ────────────────────────────

  it('fails at assert-tasks-blocked-by-resolvable when a blockedBy id does not exist in the sprint', async () => {
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition');
    const branched = activated.value.setBranch('ralphctl/bad-dep');
    if (!branched.ok) throw new Error('precondition');

    const taskA = makeTask({ name: 'a', order: 1 });
    // taskB references a nonexistent task id in its blockedBy list.
    const phantomId = taskId('phantom-000');
    const taskB = makeTask({ name: 'b', order: 2, blockedBy: [phantomId] });

    const deps = createTestDeps({
      sprints: [branched.value],
      tasks: [[branched.value.id, [taskA, taskB]]],
    });

    const flow = createExecuteFlow(deps, {
      sprintId: branched.value.id,
      cwd: CWD,
      expectedBranch: 'ralphctl/bad-dep',
      tasks: [taskA, taskB],
      sprint: branched.value,
    });

    const result = await flow.execute({
      sprintId: branched.value.id,
      cwd: CWD,
      expectedBranch: 'ralphctl/bad-dep',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const failed = result.error.trace.find((t) => t.status === 'failed');
    expect(failed?.stepName).toBe('assert-tasks-blocked-by-resolvable');
    expect(result.error.error.code).toBe('invalid-state');
    expect(result.error.error.message).toContain('phantom-000');
  });

  it('fails at assert-tasks-blocked-by-resolvable when a task lists itself in blockedBy', async () => {
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition');
    const branched = activated.value.setBranch('ralphctl/self-ref');
    if (!branched.ok) throw new Error('precondition');

    // Build a task whose id is known, then re-create it with blockedBy: [self].
    const seed = makeTask({ name: 'self-loop', order: 1 });
    const selfRef = makeTask({ name: 'self-loop', order: 1, id: seed.id, blockedBy: [seed.id] });

    const deps = createTestDeps({
      sprints: [branched.value],
      tasks: [[branched.value.id, [selfRef]]],
    });

    const flow = createExecuteFlow(deps, {
      sprintId: branched.value.id,
      cwd: CWD,
      expectedBranch: 'ralphctl/self-ref',
      tasks: [selfRef],
      sprint: branched.value,
    });

    const result = await flow.execute({
      sprintId: branched.value.id,
      cwd: CWD,
      expectedBranch: 'ralphctl/self-ref',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const failed = result.error.trace.find((t) => t.status === 'failed');
    expect(failed?.stepName).toBe('assert-tasks-blocked-by-resolvable');
    expect(result.error.error.code).toBe('invalid-state');
    expect(result.error.error.message).toContain('self');
  });

  // ── resolve-branch ────────────────────────────────────────────────

  describe('resolve-branch', () => {
    function setupActiveSprintWithTask(opts: { branch?: string } = {}) {
      const sprint0 = makeSprint();
      const ticket = makeApprovedTicket();
      const withTicket = sprint0.addTicket(ticket);
      if (!withTicket.ok) throw new Error('precondition');
      const activated = withTicket.value.activate(sprint0.createdAt);
      if (!activated.ok) throw new Error('precondition');
      let sprint = activated.value;
      if (opts.branch !== undefined) {
        const branched = sprint.setBranch(opts.branch);
        if (!branched.ok) throw new Error('precondition');
        sprint = branched.value;
      }
      const task = makeTask({ name: 'do work', projectPath: '/tmp/demo-repo' });
      return { sprint, task };
    }

    function aiOutcomes() {
      return {
        aiSession: {
          outcomes: [
            { kind: 'ok' as const, result: { output: 'done' } },
            { kind: 'ok' as const, result: { output: 'evaluator output' } },
          ],
        },
        signalParser: {
          results: [
            [taskCompleteSignal],
            [
              {
                type: 'evaluation' as const,
                status: 'passed' as const,
                dimensions: [],
                critique: '',
                timestamp: '2026-04-29T12:00:00Z' as never,
              },
            ],
          ],
        },
      };
    }

    it('skips the prompt and reuses sprint.branch when already set', async () => {
      const { sprint, task } = setupActiveSprintWithTask({ branch: 'ralphctl/preset' });
      const external = new FakeExternalPort();
      const prompt = new FakePromptPort();
      const deps = createTestDeps({
        sprints: [sprint],
        tasks: [[sprint.id, [task]]],
        overrides: { external, prompt },
        ...aiOutcomes(),
      });

      const flow = createExecuteFlow(deps, {
        sprintId: sprint.id,
        cwd: CWD,
        expectedBranch: 'ralphctl/preset',
        tasks: [task],
        sprint,
      });

      const result = await flow.execute({
        sprintId: sprint.id,
        cwd: CWD,
        expectedBranch: 'ralphctl/preset',
      });

      expect(result.ok).toBe(true);
      // No prompt fired.
      expect(prompt.selectMock).not.toHaveBeenCalled();
      expect(prompt.inputMock).not.toHaveBeenCalled();
      // Branch creation runs once per unique repo, idempotently — the
      // underlying op no-ops when already on the branch but ensures
      // a CLI pre-seed actually checks out the requested branch.
      expect(external.createAndCheckoutBranchCalls).toHaveLength(1);
      expect(external.createAndCheckoutBranchCalls[0]?.branchName).toBe('ralphctl/preset');
      // Per-task branch-preflight saw the resolved branch.
      expect(external.verifyBranchCalls.some((c) => c.expected === 'ralphctl/preset')).toBe(true);
    });

    it("'keep current' resolves to empty string with no save and no branch creation", async () => {
      const { sprint, task } = setupActiveSprintWithTask();
      const external = new FakeExternalPort();
      const prompt = new FakePromptPort();
      prompt.queueSelect('keep');
      const deps = createTestDeps({
        sprints: [sprint],
        tasks: [[sprint.id, [task]]],
        overrides: { external, prompt },
        ...aiOutcomes(),
      });

      const flow = createExecuteFlow(deps, {
        sprintId: sprint.id,
        cwd: CWD,
        expectedBranch: '',
        tasks: [task],
        sprint,
      });

      const result = await flow.execute({
        sprintId: sprint.id,
        cwd: CWD,
        expectedBranch: '',
      });

      expect(result.ok).toBe(true);
      // No branch creation, no save (sprint.branch stays null).
      expect(external.createAndCheckoutBranchCalls).toHaveLength(0);
      const reread = await deps.sprintRepo.findById(sprint.id);
      expect(reread.ok).toBe(true);
      if (reread.ok) expect(reread.value.branch).toBe(null);
      // Per-task branch-preflight ran with empty branch (no enforcement).
      expect(external.verifyBranchCalls).toHaveLength(0);
    });

    it("'auto' generates ralphctl/<sprint-id>, persists it, and creates the branch in each unique repo", async () => {
      const { sprint, task } = setupActiveSprintWithTask();
      const external = new FakeExternalPort();
      const prompt = new FakePromptPort();
      prompt.queueSelect('auto');
      const deps = createTestDeps({
        sprints: [sprint],
        tasks: [[sprint.id, [task]]],
        overrides: { external, prompt },
        ...aiOutcomes(),
      });

      const flow = createExecuteFlow(deps, {
        sprintId: sprint.id,
        cwd: CWD,
        expectedBranch: '',
        tasks: [task],
        sprint,
      });

      const result = await flow.execute({
        sprintId: sprint.id,
        cwd: CWD,
        expectedBranch: '',
      });

      expect(result.ok).toBe(true);
      const expectedBranch = `ralphctl/${String(sprint.id)}`;
      const reread = await deps.sprintRepo.findById(sprint.id);
      expect(reread.ok).toBe(true);
      if (reread.ok) expect(reread.value.branch).toBe(expectedBranch);
      // Branch created once per unique repo (one task → one repo).
      expect(external.createAndCheckoutBranchCalls).toHaveLength(1);
      expect(external.createAndCheckoutBranchCalls[0]?.branchName).toBe(expectedBranch);
      expect(external.createAndCheckoutBranchCalls[0]?.projectPath).toBe(task.projectPath);
    });

    it("'custom' with a valid name persists and creates the branch", async () => {
      const { sprint, task } = setupActiveSprintWithTask();
      const external = new FakeExternalPort();
      const prompt = new FakePromptPort();
      prompt.queueSelect('custom');
      prompt.queueInput('feature/login');
      const deps = createTestDeps({
        sprints: [sprint],
        tasks: [[sprint.id, [task]]],
        overrides: { external, prompt },
        ...aiOutcomes(),
      });

      const flow = createExecuteFlow(deps, {
        sprintId: sprint.id,
        cwd: CWD,
        expectedBranch: '',
        tasks: [task],
        sprint,
      });

      const result = await flow.execute({
        sprintId: sprint.id,
        cwd: CWD,
        expectedBranch: '',
      });

      expect(result.ok).toBe(true);
      const reread = await deps.sprintRepo.findById(sprint.id);
      expect(reread.ok).toBe(true);
      if (reread.ok) expect(reread.value.branch).toBe('feature/login');
      expect(external.createAndCheckoutBranchCalls).toHaveLength(1);
      expect(external.createAndCheckoutBranchCalls[0]?.branchName).toBe('feature/login');
    });

    it("'custom' with an invalid name re-prompts until valid", async () => {
      const { sprint, task } = setupActiveSprintWithTask();
      // Fake validation: empty string is invalid. Default `isValidBranchName`
      // in the fake returns true iff `name.length > 0`.
      const external = new FakeExternalPort();
      const prompt = new FakePromptPort();
      prompt.queueSelect('custom');
      prompt.queueInput(''); // first try: invalid
      prompt.queueInput('feature/x'); // second try: valid
      const deps = createTestDeps({
        sprints: [sprint],
        tasks: [[sprint.id, [task]]],
        overrides: { external, prompt },
        ...aiOutcomes(),
      });

      const flow = createExecuteFlow(deps, {
        sprintId: sprint.id,
        cwd: CWD,
        expectedBranch: '',
        tasks: [task],
        sprint,
      });

      const result = await flow.execute({
        sprintId: sprint.id,
        cwd: CWD,
        expectedBranch: '',
      });

      expect(result.ok).toBe(true);
      // Two input prompts fired (the first was rejected).
      expect(prompt.inputMock).toHaveBeenCalledTimes(2);
      const reread = await deps.sprintRepo.findById(sprint.id);
      expect(reread.ok).toBe(true);
      if (reread.ok) expect(reread.value.branch).toBe('feature/x');
    });
  });

  // ── resume / dependency handling ───────────────────────────────────
  describe('resume + dependencies', () => {
    it('skips tasks already in `done` / `blocked` so the chain trace stays focused on runnable work', async () => {
      // Resume scenario: taskA is already done from a prior run; taskC is
      // blocked. taskB is the only runnable task. The chain must skip the
      // settled tasks at construction time so their bridges don't show up.
      const sprint0 = makeSprint();
      const ticket = makeApprovedTicket();
      const withTicket = sprint0.addTicket(ticket);
      if (!withTicket.ok) throw new Error('precondition');
      const activated = withTicket.value.activate(sprint0.createdAt);
      if (!activated.ok) throw new Error('precondition');
      const branched = activated.value.setBranch('ralphctl/resume');
      if (!branched.ok) throw new Error('precondition');

      const taskA0 = makeTask({ name: 'a', order: 1, projectPath: '/tmp/repo-a' });
      const inProgress = taskA0.markInProgress();
      if (!inProgress.ok) throw new Error('precondition');
      const doneRes = inProgress.value.markDone();
      if (!doneRes.ok) throw new Error('precondition');
      const taskA = doneRes.value;

      const taskC0 = makeTask({ name: 'c', order: 2, projectPath: '/tmp/repo-c' });
      const blockedRes = taskC0.markBlocked('preflight failed');
      if (!blockedRes.ok) throw new Error('precondition');
      const taskC = blockedRes.value;

      const taskB = makeTask({ name: 'b', order: 3, projectPath: '/tmp/repo-b' });

      const deps = createTestDeps({
        sprints: [branched.value],
        tasks: [[branched.value.id, [taskA, taskC, taskB]]],
        aiSession: {
          outcomes: [
            { kind: 'ok', result: { output: 'done' } },
            { kind: 'ok', result: { output: 'evaluated' } },
          ],
        },
        signalParser: {
          results: [
            [taskCompleteSignal],
            [
              {
                type: 'evaluation',
                status: 'passed',
                dimensions: [],
                critique: '',
                timestamp: '2026-04-29T12:00:00Z' as never,
              },
            ],
          ],
        },
      });

      const flow = createExecuteFlow(deps, {
        sprintId: branched.value.id,
        cwd: CWD,
        expectedBranch: 'ralphctl/resume',
        tasks: [taskA, taskC, taskB],
        sprint: branched.value,
      });

      const result = await flow.execute({
        sprintId: branched.value.id,
        cwd: CWD,
        expectedBranch: 'ralphctl/resume',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const bridgeSteps = result.value.trace.map((t) => t.stepName).filter((n) => n.startsWith('task-'));
      // Only taskB's bridge appears — taskA (done) and taskC (blocked)
      // were filtered out at construction time.
      expect(bridgeSteps).toStrictEqual([`task-${taskB.id}`]);
    });

    it('a dep that ends in blocked: downstream tasks still run because Sequential continues past the recovered failure', async () => {
      // Scenario: taskA hits branch-preflight failure → markBlocked
      // (recovers via OnError → Sequential continues). taskB depends on
      // taskA. Both must end up persisted as blocked / blocked because
      // the preflight fails for both (same fake-external is configured
      // with branchOk: false), but the chain must NOT hang.
      const sprint0 = makeSprint();
      const ticket = makeApprovedTicket();
      const withTicket = sprint0.addTicket(ticket);
      if (!withTicket.ok) throw new Error('precondition');
      const activated = withTicket.value.activate(sprint0.createdAt);
      if (!activated.ok) throw new Error('precondition');
      const branched = activated.value.setBranch('main');
      if (!branched.ok) throw new Error('precondition');

      const taskA = makeTask({ name: 'a', order: 1, projectPath: '/tmp/repo-a' });
      const taskB = makeTask({ name: 'b', order: 2, projectPath: '/tmp/repo-b', blockedBy: [taskA.id] });

      const deps = createTestDeps({
        sprints: [branched.value],
        tasks: [[branched.value.id, [taskA, taskB]]],
        external: { branchOk: false, currentBranch: 'wrong-branch' },
        aiSession: {
          // Both tasks fail their preflight, so neither spawns AI.
          outcomes: [],
        },
      });

      const flow = createExecuteFlow(deps, {
        sprintId: branched.value.id,
        cwd: CWD,
        expectedBranch: 'main',
        tasks: [taskA, taskB],
        sprint: branched.value,
      });

      const result = await flow.execute({
        sprintId: branched.value.id,
        cwd: CWD,
        expectedBranch: 'main',
      });

      expect(result.ok).toBe(true);
      // The chain settled (no hang); both tasks transitioned to blocked.
      const after = await deps.taskRepo.findBySprintId(branched.value.id);
      expect(after.ok).toBe(true);
      if (!after.ok) return;
      const a = after.value.find((t) => t.id === taskA.id);
      const b = after.value.find((t) => t.id === taskB.id);
      expect(a?.status).toBe('blocked');
      expect(b?.status).toBe('blocked');
    });
  });
});
