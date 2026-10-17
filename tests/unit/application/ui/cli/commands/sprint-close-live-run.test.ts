/**
 * `ralphctl sprint close` against a sprint a live review run holds: close must wait for the run's
 * sprint lock and judge the sprint as the run left it, never flip a stale `review` copy to `done`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { revertSprintToActive } from '@src/domain/entity/sprint.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { makeReviewSprint } from '@tests/fixtures/domain.ts';
import { holdSprintLock } from '@tests/helpers/hold-flow-lock.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl sprint close — while a run holds the sprint', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('waits for the run and refuses a sprint the run reopened meanwhile', async () => {
    const sprintRepo = createFsSprintRepository({ root: cli.paths.dataRoot });
    const sprint = makeReviewSprint();
    await sprintRepo.save(sprint);

    const run = await holdSprintLock(cli.paths, sprint, 'review');
    const contended = run.contender();
    const close = runCliCaptured(cli, ['sprint', 'close', String(sprint.id), '--yes']);
    const first = await Promise.race([contended.then(() => 'waiting'), close.then(() => 'finished')]);
    expect(first).toBe('waiting');
    // The review round found more work and reopened the sprint.
    const reopened = revertSprintToActive(sprint, IsoTimestamp.now());
    if (!reopened.ok) throw new Error(reopened.error.message);
    await sprintRepo.save(reopened.value);
    await run.release();

    const result = await close;
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain('closed sprint');
    const after = await sprintRepo.findById(sprint.id);
    expect(after.ok && after.value.status).toBe('active');
  });
});
