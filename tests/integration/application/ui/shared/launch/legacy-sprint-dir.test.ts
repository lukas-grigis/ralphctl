/**
 * A sprint still in the legacy bare `<id>/` dir (the operator declined or was blocked from the data
 * migration) must be moved onto `<id>--<slug>/` at launch, before the run writes progress.md, logs or
 * worktrees under the canonical path — otherwise the readers resolve the side-file-only canonical dir
 * and the sprint's state goes missing mid-run.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { launchFlow, type LauncherDeps } from '@src/application/ui/shared/launcher.ts';
import { loadAppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { passthroughRunInTerminal } from '@src/integration/io/run-in-terminal.ts';
import { toJsonSprint } from '@src/integration/persistence/sprint/sprint.schema.ts';
import { resolveSprintDir, sprintDir } from '@src/integration/persistence/storage.ts';
import { createRealFsApp, type RealFsApp } from '@tests/helpers/real-fs-app.ts';
import { makeActiveSprint, makeProject, makeTodoTask } from '@tests/fixtures/domain.ts';

describe('launch — legacy bare sprint dir', () => {
  let app: RealFsApp;

  beforeEach(async () => {
    app = await createRealFsApp();
  });

  afterEach(async () => {
    await app.cleanup();
  });

  it('implement moves the legacy dir onto <id>--<slug>/ before the run starts', async () => {
    const project = makeProject();
    const sprint = makeActiveSprint();
    const task = makeTodoTask();
    expect((await app.deps.projectRepo.save(project)).ok).toBe(true);
    const legacyDir = app.sprintDir(sprint.id);
    await fs.mkdir(legacyDir, { recursive: true });
    await fs.writeFile(join(legacyDir, 'sprint.json'), JSON.stringify(toJsonSprint(sprint)), 'utf8');
    await fs.writeFile(join(legacyDir, 'progress.md'), 'OLD HISTORY\n', 'utf8');
    expect((await app.deps.taskRepo.saveAll(sprint.id, [task])).ok).toBe(true);

    const snapshot = await loadAppStateSnapshot(
      { projectRepo: app.deps.projectRepo, sprintRepo: app.deps.sprintRepo, taskRepo: app.deps.taskRepo },
      { projectId: project.id, sprintId: sprint.id }
    );
    const deps: LauncherDeps = {
      app: app.deps,
      storage: app.paths,
      interactive: {} as InteractivePrompt,
      runInTerminal: passthroughRunInTerminal,
    };

    const launched = await launchFlow(deps, 'implement', snapshot);
    expect(launched.ok).toBe(true);

    const canonical = sprintDir(app.paths.dataRoot, sprint.id, sprint.slug);
    expect(await resolveSprintDir(app.paths.dataRoot, sprint.id)).toBe(canonical);
    await expect(fs.stat(legacyDir)).rejects.toThrow();
    expect(await fs.readFile(join(canonical, 'progress.md'), 'utf8')).toBe('OLD HISTORY\n');
    const tasks = await app.deps.taskRepo.findBySprintId(sprint.id);
    expect(tasks.ok && tasks.value.map((t) => t.id)).toEqual([task.id]);
  });
});
