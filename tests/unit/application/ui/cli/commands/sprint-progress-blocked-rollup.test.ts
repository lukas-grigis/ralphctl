/**
 * `ralphctl sprint progress`'s Blockers section used to list every blocked task as an
 * equal-weight row, so a 3-deep dependency cascade (one real failure plus two tasks the
 * dependency gate parked behind it) read as three unrelated problems. It now rolls the
 * upstream-blocked dependents up under the actual root cause, and prints the reason + recover
 * hint for that root.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { makeDraftSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { type CliHome, createCliHome, runCliCaptured } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl sprint progress — blocked-cascade rollup', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('groups an upstream-blocked cascade under its own-failure root instead of three flat rows', async () => {
    const sprint = makeDraftSprint();
    await createFsSprintRepository({ root: cli.paths.dataRoot }).save(sprint);
    const repo = createFsTaskRepository({ root: cli.paths.dataRoot });

    const rootTodo = makeTodoTask({ name: 'root-task' });
    const root = markTaskBlocked(rootTodo, 'verify script failed', 'own');
    if (!root.ok) throw new Error(`fixture: ${root.error.message}`);

    const depBTodo = makeTodoTask({ name: 'dep-b', dependsOn: [root.value.id] });
    const depB = markTaskBlocked(depBTodo, 'blocked upstream — prerequisite not done: root-task (blocked)', 'upstream');
    if (!depB.ok) throw new Error(`fixture: ${depB.error.message}`);

    const depCTodo = makeTodoTask({ name: 'dep-c', dependsOn: [depB.value.id] });
    const depC = markTaskBlocked(depCTodo, 'blocked upstream — prerequisite not done: dep-b (blocked)', 'upstream');
    if (!depC.ok) throw new Error(`fixture: ${depC.error.message}`);

    await repo.saveAll(sprint.id, [root.value, depB.value, depC.value]);

    const result = await runCliCaptured(cli, ['sprint', 'progress', String(sprint.id)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Blockers (3)');

    // Exactly ONE top-level bullet — the root cause — not three equal-weight rows.
    const bulletCount = (result.stdout.match(/✗ /g) ?? []).length;
    expect(bulletCount).toBe(1);
    expect(result.stdout).toContain('✗ root-task');
    expect(result.stdout).toContain('verify script failed');
    expect(result.stdout).toContain(`recover with: ralphctl task unblock ${String(root.value.id)}`);

    // Both dependents are named in a rollup line naming the root, not their own bullets.
    expect(result.stdout).toContain('waiting on this');
    expect(result.stdout).toContain('dep-b');
    expect(result.stdout).toContain('dep-c');
  });

  it('reports independent blocked tasks as independent roots (no false grouping)', async () => {
    const sprint = makeDraftSprint();
    await createFsSprintRepository({ root: cli.paths.dataRoot }).save(sprint);
    const repo = createFsTaskRepository({ root: cli.paths.dataRoot });

    const a = markTaskBlocked(makeTodoTask({ name: 'alpha' }), 'own failure a', 'own');
    const b = markTaskBlocked(makeTodoTask({ name: 'beta' }), 'own failure b', 'own');
    if (!a.ok || !b.ok) throw new Error('fixture setup failed');
    await repo.saveAll(sprint.id, [a.value, b.value]);

    const result = await runCliCaptured(cli, ['sprint', 'progress', String(sprint.id)]);
    expect(result.exitCode).toBe(0);
    const bulletCount = (result.stdout.match(/✗ /g) ?? []).length;
    expect(bulletCount).toBe(2);
    expect(result.stdout).not.toContain('waiting on this');
  });
});
