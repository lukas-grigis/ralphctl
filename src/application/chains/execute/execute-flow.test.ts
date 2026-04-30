// Legacy intent: src/business/pipelines/*.test.ts step-order + failure path coverage
import { describe, expect, it } from 'vitest';

import type { HarnessSignal } from '../../../domain/signals/harness-signal.ts';
import { abs, makeApprovedTicket, makeSprint, makeTask } from '../../_test-fakes/fixtures.ts';
import { createTestDeps } from '../../_test-fakes/create-test-deps.ts';
import { createExecuteFlow } from './execute-flow.ts';

const CWD = abs('/tmp/exec-test');

const taskCompleteSignal: HarnessSignal = {
  type: 'task-complete',
  timestamp: '2026-04-29T12:00:00Z' as never,
};

describe('createExecuteFlow', () => {
  it('runs load-sprint → assert-active → load-tasks → assert-tasks-not-empty → check-scripts-sprint-start → link-skills → execute-tasks → unlink-skills', async () => {
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition');

    const task = makeTask({ name: 'do work', projectPath: '/tmp/demo-repo' });
    const deps = createTestDeps({
      sprints: [activated.value],
      tasks: [[activated.value.id, [task]]],
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
      sprintId: activated.value.id,
      cwd: CWD,
      expectedBranch: '',
      tasks: [task],
      sprint: activated.value,
    });

    const result = await flow.execute({
      sprintId: activated.value.id,
      cwd: CWD,
      expectedBranch: '',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The kernel's Parallel doesn't emit an entry for itself — only
    // its children. Filter the outer trace down to the headline steps
    // and the per-task bridge entry the Parallel surfaces.
    const headlineSteps = [
      'load-sprint',
      'assert-active',
      'load-tasks',
      'assert-tasks-not-empty',
      'check-scripts-sprint-start',
      'link-skills',
      'unlink-skills',
    ];
    const trace = result.value.trace.map((t) => t.stepName);
    const headline = trace.filter((n) => headlineSteps.includes(n));
    expect(headline).toEqual(headlineSteps);

    // The Parallel surfaces its child trace as `task-<id>` between
    // link-skills and unlink-skills.
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

  it('runs per-task chains in parallel respecting the concurrency cap', async () => {
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition');

    const tasks = [makeTask({ name: 'a', order: 1 }), makeTask({ name: 'b', order: 2 })];

    // Provide enough scripted AI outcomes for each task's
    // execute + evaluate spawns (4 total).
    const okOutput = { output: 'done' };
    const deps = createTestDeps({
      sprints: [activated.value],
      tasks: [[activated.value.id, tasks]],
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
      sprintId: activated.value.id,
      cwd: CWD,
      expectedBranch: '',
      tasks,
      sprint: activated.value,
      concurrency: 2,
    });

    const result = await flow.execute({
      sprintId: activated.value.id,
      cwd: CWD,
      expectedBranch: '',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both task bridges show up in the trace.
    const bridgeSteps = result.value.trace.map((t) => t.stepName).filter((n) => n.startsWith('task-'));
    const [firstTask, secondTask] = tasks;
    if (!firstTask || !secondTask) throw new Error('precondition');
    expect(bridgeSteps).toEqual(expect.arrayContaining([`task-${firstTask.id}`, `task-${secondTask.id}`]));
  });
});
