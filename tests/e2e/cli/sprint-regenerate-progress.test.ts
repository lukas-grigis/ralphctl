/**
 * `ralphctl sprint regenerate-progress <id>` — operator-facing escape hatch for
 * re-rendering `<sprintDir>/progress.md` from current persisted state. Smoke contract:
 *  - Resolves the sprint, execution, tasks and writes a non-empty progress.md.
 *  - Surfaces the path on stdout for scripting.
 *  - Exits non-zero on malformed sprint ids.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFsSprintRepository } from '@src/integration/persistence/sprint/repository.ts';
import { createFsSprintExecutionRepository } from '@src/integration/persistence/sprint-execution/repository.ts';
import { createFsTaskRepository } from '@src/integration/persistence/task/repository.ts';
import { createSprintExecution } from '@src/domain/entity/sprint-execution.ts';
import { makeActiveSprint, makeTodoTask } from '@tests/fixtures/domain.ts';
import { createCliHome, runCliCaptured, type CliHome } from '@tests/e2e/cli/_harness.ts';

describe('ralphctl sprint regenerate-progress', () => {
  let cli: CliHome;

  beforeEach(async () => {
    cli = await createCliHome();
  });

  afterEach(async () => cli.cleanup());

  it('renders progress.md from persisted state and prints the path', async () => {
    const sprint = makeActiveSprint();
    const execution = createSprintExecution({ sprintId: sprint.id });
    const task = makeTodoTask({ name: 'wire form', order: 1 });

    const sprintRepo = createFsSprintRepository({ root: cli.paths.dataRoot });
    const executionRepo = createFsSprintExecutionRepository({ root: cli.paths.dataRoot });
    const taskRepo = createFsTaskRepository({ root: cli.paths.dataRoot });
    await sprintRepo.save(sprint);
    await executionRepo.save(execution);
    await taskRepo.saveAll(sprint.id, [task]);

    const result = await runCliCaptured(cli, ['sprint', 'regenerate-progress', String(sprint.id)]);

    expect(result.exitCode).toBe(0);
    const progressPath = join(String(cli.paths.dataRoot), 'sprints', String(sprint.id), 'progress.md');
    expect(result.stdout).toContain(`progress.md regenerated at ${progressPath}`);

    const written = await fs.readFile(progressPath, 'utf8');
    // Header section + per-task heading + machine block are the three load-bearing
    // shapes the operator depends on; assert each rather than the full document so the
    // test stays robust to additive copy changes.
    expect(written).toContain('# Sprint progress —');
    expect(written).toContain('### Task 1 — wire form');
    expect(written).toContain('<!-- machine:begin -->');
    expect(written).toContain('<!-- machine:end -->');
  });

  it('exits 1 on a malformed sprint id', async () => {
    const result = await runCliCaptured(cli, ['sprint', 'regenerate-progress', 'not-a-uuid']);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('invalid sprint id');
  });
});
