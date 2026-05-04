/**
 * Step-order integration test for the create-pr chain. Locks the trace
 * shape on happy + failure paths so the chain definition cannot drift
 * silently.
 */
import { describe, expect, it } from 'vitest';

import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/errors/storage-error.ts';
import { FakeExternalPort } from '@src/business/_test-fakes/fake-external-port.ts';
import { abs, makeApprovedTicket, makeSprint, T0 } from '@src/application/_test-fakes/fixtures.ts';
import { createTestDeps } from '@src/application/_test-fakes/create-test-deps.ts';
import { createCreatePrFlow } from './create-pr-flow.ts';

const CWD = abs('/tmp/create-pr-test');

const HAPPY_PATH_STEPS = [
  'load-sprint',
  'assert-active',
  'assert-has-branch',
  'derive-pr-content',
  'create-pull-request',
  'record-pr-url',
];

describe('createCreatePrFlow', () => {
  it('runs load-sprint → assert-active → assert-has-branch → derive-pr-content → create-pull-request → record-pr-url', async () => {
    const sprintBase = makeSprint({ name: 'Demo Sprint' });
    const ticket = makeApprovedTicket({ title: 'Add login' });
    const withTicket = sprintBase.addTicket(ticket);
    if (!withTicket.ok) throw withTicket.error;
    const activated = withTicket.value.activate(T0);
    if (!activated.ok) throw activated.error;
    const branched = activated.value.setBranch('ralphctl/test');
    if (!branched.ok) throw branched.error;

    const external = new FakeExternalPort({
      createPullRequestOutcomes: [Result.ok({ url: 'https://github.com/o/r/pull/9' })],
    });
    const deps = createTestDeps({ sprints: [branched.value], overrides: { external } });

    const flow = createCreatePrFlow(deps, {
      sprintId: branched.value.id,
      cwd: CWD,
      base: 'main',
      draft: false,
      tasks: [],
    });

    const result = await flow.execute({
      sprintId: branched.value.id,
      cwd: CWD,
      base: 'main',
      draft: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.trace.map((t) => t.stepName)).toStrictEqual(HAPPY_PATH_STEPS);
    for (const entry of result.value.trace) expect(entry.status).toBe('completed');

    expect(result.value.ctx.pullRequestUrl).toBe('https://github.com/o/r/pull/9');
    expect(external.createPullRequestCalls).toHaveLength(1);
    expect(external.createPullRequestCalls[0]?.branch).toBe('ralphctl/test');

    // Persisted on the sprint aggregate.
    const reread = await deps.sprintRepo.findById(branched.value.id);
    expect(reread.ok).toBe(true);
    if (reread.ok) expect(reread.value.pullRequestUrl).toBe('https://github.com/o/r/pull/9');
  });

  it('uses caller-provided title/body when set', async () => {
    const sprintBase = makeSprint();
    const activated = sprintBase.activate(T0);
    if (!activated.ok) throw activated.error;
    const branched = activated.value.setBranch('ralphctl/x');
    if (!branched.ok) throw branched.error;

    const external = new FakeExternalPort({
      createPullRequestOutcomes: [Result.ok({ url: 'https://github.com/o/r/pull/2' })],
    });
    const deps = createTestDeps({ sprints: [branched.value], overrides: { external } });

    const flow = createCreatePrFlow(deps, {
      sprintId: branched.value.id,
      cwd: CWD,
      base: 'develop',
      draft: true,
    });

    const result = await flow.execute({
      sprintId: branched.value.id,
      cwd: CWD,
      base: 'develop',
      draft: true,
      title: 'CUSTOM TITLE',
      body: 'CUSTOM BODY',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const call = external.createPullRequestCalls[0];
    expect(call?.title).toBe('CUSTOM TITLE');
    expect(call?.body).toBe('CUSTOM BODY');
    expect(call?.base).toBe('develop');
    expect(call?.draft).toBe(true);
  });

  it('short-circuits at assert-active when sprint is not active', async () => {
    const sprint = makeSprint(); // draft status, with a branch
    const branched = sprint.setBranch('ralphctl/z');
    if (!branched.ok) throw branched.error;
    const deps = createTestDeps({ sprints: [branched.value] });

    const flow = createCreatePrFlow(deps, {
      sprintId: branched.value.id,
      cwd: CWD,
      base: 'main',
      draft: false,
    });

    const result = await flow.execute({
      sprintId: branched.value.id,
      cwd: CWD,
      base: 'main',
      draft: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('invalid-state');

    expect(result.error.trace[1]?.stepName).toBe('assert-active');
    expect(result.error.trace[1]?.status).toBe('failed');
    expect(result.error.trace).toHaveLength(HAPPY_PATH_STEPS.length);
    expect(result.error.trace[0]?.status).toBe('completed');
    for (const entry of result.error.trace.slice(2)) expect(entry.status).toBe('skipped');
  });

  it('short-circuits at assert-has-branch when sprint has no branch', async () => {
    const sprintBase = makeSprint(); // no branch
    const activated = sprintBase.activate(T0);
    if (!activated.ok) throw activated.error;
    const sprint = activated.value;
    const deps = createTestDeps({ sprints: [sprint] });

    const flow = createCreatePrFlow(deps, {
      sprintId: sprint.id,
      cwd: CWD,
      base: 'main',
      draft: false,
    });

    const result = await flow.execute({
      sprintId: sprint.id,
      cwd: CWD,
      base: 'main',
      draft: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error.code).toBe('invalid-state');

    const stepNames = result.error.trace.map((t) => t.stepName);
    expect(stepNames).toStrictEqual(HAPPY_PATH_STEPS);
    expect(result.error.trace[0]?.status).toBe('completed');
    expect(result.error.trace[1]?.status).toBe('completed');
    expect(result.error.trace[2]?.status).toBe('failed');
    for (const entry of result.error.trace.slice(3)) expect(entry.status).toBe('skipped');
  });

  it('propagates ExternalPort failures and skips record-pr-url', async () => {
    const sprintBase = makeSprint();
    const activated = sprintBase.activate(T0);
    if (!activated.ok) throw activated.error;
    const branched = activated.value.setBranch('ralphctl/y');
    if (!branched.ok) throw branched.error;

    const external = new FakeExternalPort({
      createPullRequestOutcomes: [Result.error(new StorageError({ subCode: 'io', message: 'gh: not authenticated' }))],
    });
    const deps = createTestDeps({ sprints: [branched.value], overrides: { external } });

    const flow = createCreatePrFlow(deps, {
      sprintId: branched.value.id,
      cwd: CWD,
      base: 'main',
      draft: false,
    });

    const result = await flow.execute({
      sprintId: branched.value.id,
      cwd: CWD,
      base: 'main',
      draft: false,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;

    const failedIdx = result.error.trace.findIndex((t) => t.status === 'failed');
    expect(failedIdx).toBeGreaterThan(-1);
    expect(result.error.trace[failedIdx]?.stepName).toBe('create-pull-request');
    // record-pr-url skipped.
    const last = result.error.trace.at(-1);
    expect(last?.stepName).toBe('record-pr-url');
    expect(last?.status).toBe('skipped');
  });
});
