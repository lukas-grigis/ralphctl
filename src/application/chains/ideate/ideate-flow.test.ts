// Legacy intent: src/business/pipelines/*.test.ts step-order + failure path coverage
import { describe, expect, it } from 'vitest';

import { abs, makeProject, makeSprint, projectName } from '../../_test-fakes/fixtures.ts';
import { createTestDeps } from '../../_test-fakes/create-test-deps.ts';
import { createIdeateFlow } from './ideate-flow.ts';

const CWD = abs('/tmp/ideate-test');

const IDEATE_OUTPUT = `<ticket>
<title>Implement caching</title>
<description>Speed up reads</description>
<requirements>Cache responses for 5 minutes</requirements>
</ticket>
<tasks>
[
  {
    "name": "Add cache layer",
    "steps": ["wire it up"],
    "verificationCriteria": ["it caches"],
    "order": 1,
    "projectPath": "/tmp/demo-repo"
  }
]
</tasks>`;

describe('createIdeateFlow', () => {
  it('runs load-sprint → assert-draft → load-project → ideate-and-plan → save-results (save-sprint + save-tasks)', async () => {
    const sprint = makeSprint();
    const project = makeProject();

    const deps = createTestDeps({
      sprints: [sprint],
      projects: [project],
      aiSession: { outcomes: [{ kind: 'ok', result: { output: IDEATE_OUTPUT } }] },
    });

    const flow = createIdeateFlow(deps, {
      sprintId: sprint.id,
      cwd: CWD,
      projectName: project.name,
      ideaText: 'Speed up reads with caching',
    });

    const result = await flow.execute({
      sprintId: sprint.id,
      cwd: CWD,
      projectName: project.name,
      ideaText: 'Speed up reads with caching',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.trace.map((t) => t.stepName)).toEqual([
      'load-sprint',
      'assert-draft',
      'load-project',
      'ideate-and-plan',
      'save-sprint',
      'save-tasks',
    ]);

    // Verify both writes hit the repos.
    const reread = await deps.sprintRepo.findById(sprint.id);
    if (!reread.ok) throw new Error('expected sprint after run');
    expect(reread.value.tickets).toHaveLength(1);
    expect(reread.value.tickets[0]?.title).toBe('Implement caching');

    const tasks = await deps.taskRepo.findBySprintId(sprint.id);
    if (!tasks.ok) throw new Error('expected tasks after run');
    expect(tasks.value).toHaveLength(1);
  });

  it('step short-circuit: assert-draft failure marks remaining steps as "skipped"', async () => {
    // Activate the sprint so assert-draft fails → load-project, ideate-and-plan, save-* all skipped.
    const sprint0 = makeSprint();
    const activated = sprint0.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition');
    const project = makeProject();

    const deps = createTestDeps({ sprints: [activated.value], projects: [project] });
    const flow = createIdeateFlow(deps, {
      sprintId: activated.value.id,
      cwd: CWD,
      projectName: project.name,
      ideaText: 'idea',
    });

    const result = await flow.execute({
      sprintId: activated.value.id,
      cwd: CWD,
      projectName: project.name,
      ideaText: 'idea',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const failedIdx = result.error.trace.findIndex((t) => t.status === 'failed');
    expect(failedIdx).toBeGreaterThan(-1);
    for (const entry of result.error.trace.slice(failedIdx + 1)) {
      expect(entry.status).toBe('skipped');
    }
  });

  it('abort propagation: pre-aborted signal marks in-flight step "aborted" and chain fails', async () => {
    const sprint = makeSprint();
    const project = makeProject();
    const deps = createTestDeps({ sprints: [sprint], projects: [project] });

    const flow = createIdeateFlow(deps, {
      sprintId: sprint.id,
      cwd: CWD,
      projectName: project.name,
      ideaText: 'idea',
    });

    const ac = new AbortController();
    ac.abort();

    const result = await flow.execute(
      { sprintId: sprint.id, cwd: CWD, projectName: project.name, ideaText: 'idea' },
      ac.signal
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('aborted');
    expect(result.error.trace.some((t) => t.status === 'aborted')).toBe(true);
  });

  it('fails at load-project when the project does not exist', async () => {
    const sprint = makeSprint();
    const deps = createTestDeps({ sprints: [sprint] });

    const ghost = projectName('ghost');
    const flow = createIdeateFlow(deps, {
      sprintId: sprint.id,
      cwd: CWD,
      projectName: ghost,
      ideaText: 'idea',
    });

    const result = await flow.execute({
      sprintId: sprint.id,
      cwd: CWD,
      projectName: ghost,
      ideaText: 'idea',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('not-found');
    const failed = result.error.trace.find((t) => t.status === 'failed');
    expect(failed?.stepName).toBe('load-project');
  });
});
