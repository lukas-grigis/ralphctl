/**
 * `ralphctl sprint reopen` used to print `done → review` unconditionally, even on the idempotent
 * pass-through where the sprint was already in `review` and `reopenDoneSprintUseCase` persisted
 * nothing. An operator couldn't tell a real state change from a no-op from the output alone. It
 * now names the transition only when one actually happened.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { makeDoneSprint, makeReviewSprint } from '@tests/fixtures/domain.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl sprint reopen — idempotent output', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('reports the real done → review transition and persists it', async () => {
    const sprintRepo = createFsSprintRepository({ root: cli.paths.dataRoot });
    const sprint = makeDoneSprint();
    await sprintRepo.save(sprint);

    const result = await runCliCaptured(cli, ['sprint', 'reopen', String(sprint.id)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('done → review');
    expect(result.stdout).toContain('ralphctl task unblock');

    const reloaded = await sprintRepo.findById(sprint.id);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value.status).toBe('review');
  });

  it('does NOT claim a done → review transition on an already-review sprint', async () => {
    const sprintRepo = createFsSprintRepository({ root: cli.paths.dataRoot });
    const sprint = makeReviewSprint();
    await sprintRepo.save(sprint);

    const result = await runCliCaptured(cli, ['sprint', 'reopen', String(sprint.id)]);
    expect(result.exitCode).toBe(0);
    // The sprint never left review — nothing was persisted — so the output must not read as a
    // state change an operator could mistake for a real transition.
    expect(result.stdout).not.toContain('done → review');
    expect(result.stdout).toContain('already in review');

    const reloaded = await sprintRepo.findById(sprint.id);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value.status).toBe('review');
  });
});
