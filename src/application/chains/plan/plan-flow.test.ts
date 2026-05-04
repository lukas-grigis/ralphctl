// Legacy intent: src/business/pipelines/*.test.ts step-order + failure path coverage
import { describe, expect, it } from 'vitest';

import { Project } from '@src/domain/entities/project.ts';
import { Repository } from '@src/domain/entities/repository.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { abs, makeApprovedTicket, makeProject, makeSprint, makeTicket } from '@src/application/_test-fakes/fixtures.ts';
import { createTestDeps } from '@src/application/_test-fakes/create-test-deps.ts';
import { FakePromptPort } from '@src/application/_test-fakes/fake-prompt-port.ts';
import { FakeSessionFolderBuilderPort } from '@src/business/_test-fakes/fake-session-folder-builder-port.ts';
import { createPlanFlow } from './plan-flow.ts';

// projectPath must match the project's repository (`makeProject` defaults
// to `/tmp/demo-repo`) — `persist-repo-selection` writes that path onto
// `sprint.affectedRepositories`, which the use case's projectPath guard
// then validates against.
const TASK_OUTPUT = `\`\`\`json
[
  {
    "name": "Task one",
    "steps": ["do A"],
    "verificationCriteria": ["it works"],
    "order": 1,
    "projectPath": "/tmp/demo-repo"
  }
]
\`\`\``;

describe('createPlanFlow', () => {
  it('runs load-sprint → assert-draft → assert-all-tickets-approved → persist-repo-selection → load-existing-tasks → snapshot-existing-tasks → build-planning-folder → link-skills → confirm-replan → render-prompt-to-file → plan-tasks → reorder-tasks → confirm-task-list → save-tasks → unlink-skills', async () => {
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const sprint1 = sprint0.addTicket(ticket);
    if (!sprint1.ok) throw new Error('precondition');
    const project = makeProject();

    const deps = createTestDeps({
      sprints: [sprint1.value],
      projects: [project],
      aiSession: { outcomes: [{ kind: 'ok', result: { output: TASK_OUTPUT } }] },
    });

    const flow = createPlanFlow(deps, { sprintId: sprint1.value.id });

    const result = await flow.execute({ sprintId: sprint1.value.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.trace.map((t) => t.stepName)).toStrictEqual([
      'load-sprint',
      'assert-draft',
      'assert-all-tickets-approved',
      'persist-repo-selection',
      'load-existing-tasks',
      'snapshot-existing-tasks',
      'build-planning-folder',
      'link-skills',
      'confirm-replan',
      'render-prompt-to-file',
      'plan-tasks',
      'reorder-tasks',
      'confirm-task-list',
      'save-tasks',
      'unlink-skills',
    ]);

    // Tasks were persisted.
    const persisted = await deps.taskRepo.findBySprintId(sprint1.value.id);
    if (!persisted.ok) throw new Error('expected tasks');
    expect(persisted.value).toHaveLength(1);
    expect(persisted.value[0]?.name).toBe('Task one');

    // affectedRepositories now lives on the sprint (single-repo project,
    // prompt was skipped — the leaf still saved the selection).
    const reread = await deps.sprintRepo.findById(sprint1.value.id);
    if (!reread.ok) throw new Error('expected sprint');
    expect(reread.value.affectedRepositories).toHaveLength(1);
    expect(String(reread.value.affectedRepositories[0])).toBe('/tmp/demo-repo');
  });

  it('fails at assert-all-tickets-approved when a ticket is still pending', async () => {
    const sprint0 = makeSprint();
    const pending = makeTicket({ title: 'still pending' });
    const sprint1 = sprint0.addTicket(pending);
    if (!sprint1.ok) throw new Error('precondition');
    const project = makeProject();

    const deps = createTestDeps({ sprints: [sprint1.value], projects: [project] });
    const flow = createPlanFlow(deps, { sprintId: sprint1.value.id });

    const result = await flow.execute({ sprintId: sprint1.value.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const stepNames = result.error.trace.map((t) => t.stepName);
    expect(stepNames.slice(0, 3)).toStrictEqual(['load-sprint', 'assert-draft', 'assert-all-tickets-approved']);
    expect(result.error.trace[2]?.status).toBe('failed');
    // Steps after the failure are skipped.
    expect(stepNames.slice(3)).toStrictEqual([
      'persist-repo-selection',
      'load-existing-tasks',
      'snapshot-existing-tasks',
      'build-planning-folder',
      'link-skills',
      'confirm-replan',
      'render-prompt-to-file',
      'plan-tasks',
      'reorder-tasks',
      'confirm-task-list',
      'save-tasks',
      'unlink-skills',
    ]);
    for (const e of result.error.trace.slice(3)) {
      expect(e.status).toBe('skipped');
    }
  });

  it('step short-circuit: failed step leaves subsequent steps as "skipped"', async () => {
    // assert-all-tickets-approved fails → everything after it is skipped.
    const sprint0 = makeSprint();
    const pending = makeTicket({ title: 'not approved' });
    const sprint1 = sprint0.addTicket(pending);
    if (!sprint1.ok) throw new Error('precondition');
    const project = makeProject();

    const deps = createTestDeps({ sprints: [sprint1.value], projects: [project] });
    const flow = createPlanFlow(deps, { sprintId: sprint1.value.id });

    const result = await flow.execute({ sprintId: sprint1.value.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const skipped = result.error.trace.filter((t) => t.status === 'skipped');
    expect(skipped.length).toBeGreaterThan(0);
    // Everything after the failed step should be in skipped status.
    const failedIdx = result.error.trace.findIndex((t) => t.status === 'failed');
    expect(failedIdx).toBeGreaterThan(-1);
    for (const entry of result.error.trace.slice(failedIdx + 1)) {
      expect(entry.status).toBe('skipped');
    }
  });

  it('abort propagation: pre-aborted signal marks in-flight step "aborted" and chain fails', async () => {
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const sprint1 = sprint0.addTicket(ticket);
    if (!sprint1.ok) throw new Error('precondition');
    const project = makeProject();

    const deps = createTestDeps({ sprints: [sprint1.value], projects: [project] });
    const flow = createPlanFlow(deps, { sprintId: sprint1.value.id });

    const ac = new AbortController();
    ac.abort();

    const result = await flow.execute({ sprintId: sprint1.value.id }, ac.signal);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('aborted');
    expect(result.error.trace.some((t) => t.status === 'aborted')).toBe(true);
  });

  it('fails at assert-draft when the sprint is active', async () => {
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const withTicket = sprint0.addTicket(ticket);
    if (!withTicket.ok) throw new Error('precondition');
    const activated = withTicket.value.activate(sprint0.createdAt);
    if (!activated.ok) throw new Error('precondition');
    const project = makeProject();

    const deps = createTestDeps({ sprints: [activated.value], projects: [project] });
    const flow = createPlanFlow(deps, { sprintId: activated.value.id });

    const result = await flow.execute({ sprintId: activated.value.id });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.trace[1]?.stepName).toBe('assert-draft');
    expect(result.error.trace[1]?.status).toBe('failed');
  });

  it('persist-repo-selection prompts when the project has multiple repos', async () => {
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const sprint1 = sprint0.addTicket(ticket);
    if (!sprint1.ok) throw new Error('precondition');

    // Build a project with two repos so the checkbox prompt is required.
    const projectBase = makeProject();
    const secondRepoResult = Repository.create({ path: abs('/tmp/demo-repo-2'), name: 'demo-repo-2' });
    if (!secondRepoResult.ok) throw new Error('precondition');
    const projectResult = Project.create({
      name: projectBase.name,
      displayName: projectBase.displayName,
      repositories: [...projectBase.repositories, secondRepoResult.value],
    });
    if (!projectResult.ok) throw new Error('precondition');

    const prompt = new FakePromptPort();
    // User selects only the first repo.
    prompt.queueCheckbox(['/tmp/demo-repo']);

    const deps = createTestDeps({
      sprints: [sprint1.value],
      projects: [projectResult.value],
      prompt,
      aiSession: { outcomes: [{ kind: 'ok', result: { output: TASK_OUTPUT } }] },
    });

    const flow = createPlanFlow(deps, { sprintId: sprint1.value.id });
    const result = await flow.execute({ sprintId: sprint1.value.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(prompt.checkboxMock).toHaveBeenCalledTimes(1);

    const reread = await deps.sprintRepo.findById(sprint1.value.id);
    if (!reread.ok) throw new Error('expected sprint');
    expect(reread.value.affectedRepositories.map(String)).toStrictEqual(['/tmp/demo-repo']);
  });

  it('persist-repo-selection fails when the user picks no repositories', async () => {
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const sprint1 = sprint0.addTicket(ticket);
    if (!sprint1.ok) throw new Error('precondition');

    const projectBase = makeProject();
    const secondRepoResult = Repository.create({ path: abs('/tmp/demo-repo-2'), name: 'demo-repo-2' });
    if (!secondRepoResult.ok) throw new Error('precondition');
    const projectResult = Project.create({
      name: projectBase.name,
      displayName: projectBase.displayName,
      repositories: [...projectBase.repositories, secondRepoResult.value],
    });
    if (!projectResult.ok) throw new Error('precondition');

    const prompt = new FakePromptPort();
    prompt.queueCheckbox([]);

    const deps = createTestDeps({
      sprints: [sprint1.value],
      projects: [projectResult.value],
      prompt,
    });

    const flow = createPlanFlow(deps, { sprintId: sprint1.value.id });
    const result = await flow.execute({ sprintId: sprint1.value.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const failed = result.error.trace.find((t) => t.status === 'failed');
    expect(failed?.stepName).toBe('persist-repo-selection');
  });

  it('build-planning-folder failure aborts before link-skills runs', async () => {
    const sprint0 = makeSprint();
    const ticket = makeApprovedTicket();
    const sprint1 = sprint0.addTicket(ticket);
    if (!sprint1.ok) throw new Error('precondition');
    const project = makeProject();

    const failingBuilder = new FakeSessionFolderBuilderPort({
      failWith: new StorageError({ subCode: 'io', message: 'cannot create planning folder' }),
    });
    const deps = createTestDeps({
      sprints: [sprint1.value],
      projects: [project],
      overrides: { sessionFolderBuilder: failingBuilder },
    });

    const flow = createPlanFlow(deps, { sprintId: sprint1.value.id });
    const result = await flow.execute({ sprintId: sprint1.value.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;

    const stepNames = result.error.trace.map((t) => t.stepName);
    // Steps up to and including build-planning-folder ran; everything after is skipped.
    expect(stepNames).toStrictEqual([
      'load-sprint',
      'assert-draft',
      'assert-all-tickets-approved',
      'persist-repo-selection',
      'load-existing-tasks',
      'snapshot-existing-tasks',
      'build-planning-folder',
      'link-skills',
      'confirm-replan',
      'render-prompt-to-file',
      'plan-tasks',
      'reorder-tasks',
      'confirm-task-list',
      'save-tasks',
      'unlink-skills',
    ]);

    const failedIdx = result.error.trace.findIndex((t) => t.status === 'failed');
    expect(result.error.trace[failedIdx]?.stepName).toBe('build-planning-folder');
    // link-skills (immediately after build-planning-folder) and every later
    // step must be skipped — that's the whole point: the user's repo
    // never sees `.claude/skills/` when the workspace can't be built.
    for (const entry of result.error.trace.slice(failedIdx + 1)) {
      expect(entry.status).toBe('skipped');
    }
  });
});
