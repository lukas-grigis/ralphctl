/**
 * `ralphctl sprint close` used to transition straight to `done` without ever looking at tasks —
 * a review sprint with blocked work closed silently. Per the product decision (confirm-and-
 * proceed, never a refusal), it now gates on a TTY confirmation naming the blocked tasks (or
 * `--yes` for scripts) and always records what stayed blocked in its own output — not just the
 * TUI's close-sprint flow, which has no CLI-reachable `InteractivePrompt`. A task-list read that
 * FAILS (corrupt/unreadable `tasks.json`) is a distinct case from "no tasks are blocked" — the
 * close refuses rather than treating the read error as evidence the sprint is clean.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { sprintDir } from '@src/integration/persistence/storage.ts';
import { makeReviewSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl sprint close — blocked-task confirm', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('refuses on a non-TTY stdin without --yes, naming the blocked task, and leaves the sprint open', async () => {
    const sprintRepo = createFsSprintRepository({ root: cli.paths.dataRoot });
    const taskRepo = createFsTaskRepository({ root: cli.paths.dataRoot });
    const sprint = makeReviewSprint();
    await sprintRepo.save(sprint);
    const blocked = markTaskBlocked(makeTodoTask({ name: 'stuck-task' }), 'own failure', 'own');
    if (!blocked.ok) throw new Error(`fixture: ${blocked.error.message}`);
    await taskRepo.saveAll(sprint.id, [blocked.value]);

    const result = await runCliCaptured(cli, ['sprint', 'close', String(sprint.id)]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--yes');
    expect(result.stderr).toContain('stuck-task');

    const reloaded = await sprintRepo.findById(sprint.id);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value.status).toBe('review');
  });

  it('--yes proceeds with blocked tasks and records the outcome instead of closing silently', async () => {
    const sprintRepo = createFsSprintRepository({ root: cli.paths.dataRoot });
    const taskRepo = createFsTaskRepository({ root: cli.paths.dataRoot });
    const sprint = makeReviewSprint();
    await sprintRepo.save(sprint);
    const blocked = markTaskBlocked(makeTodoTask({ name: 'stuck-task' }), 'own failure', 'own');
    if (!blocked.ok) throw new Error(`fixture: ${blocked.error.message}`);
    await taskRepo.saveAll(sprint.id, [blocked.value]);

    const result = await runCliCaptured(cli, ['sprint', 'close', String(sprint.id), '--yes']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`closed sprint '${String(sprint.slug)}'`);
    // The outcome names what stayed blocked and how to recover — the whole point of the gate.
    expect(result.stdout).toContain('stuck-task');
    expect(result.stdout).toContain('stayed blocked');
    expect(result.stdout).toContain('ralphctl task unblock');

    const reloaded = await sprintRepo.findById(sprint.id);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value.status).toBe('done');
  });

  it('closes without any confirmation or note when nothing is blocked', async () => {
    const sprintRepo = createFsSprintRepository({ root: cli.paths.dataRoot });
    const sprint = makeReviewSprint();
    await sprintRepo.save(sprint);

    const result = await runCliCaptured(cli, ['sprint', 'close', String(sprint.id)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain('stayed blocked');
  });

  it('refuses instead of closing silently when the task list cannot be read', async () => {
    const sprintRepo = createFsSprintRepository({ root: cli.paths.dataRoot });
    const sprint = makeReviewSprint();
    await sprintRepo.save(sprint);
    // Corrupt tasks.json directly — truncated write, permissions, or a downgrade-induced
    // MigrationGapError would all surface the same StorageError{subCode:'parse'|'io'} from
    // findBySprintId. A failed read is not evidence nothing is blocked; the close must refuse
    // rather than proceeding as if the sprint were clean.
    const dir = sprintDir(cli.paths.dataRoot, sprint.id, sprint.slug);
    await fs.writeFile(join(dir, 'tasks.json'), '{not valid json', 'utf8');

    const result = await runCliCaptured(cli, ['sprint', 'close', String(sprint.id), '--yes']);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).not.toContain('closed sprint');

    const reloaded = await sprintRepo.findById(sprint.id);
    expect(reloaded.ok).toBe(true);
    if (reloaded.ok) expect(reloaded.value.status).toBe('review');
  });
});
