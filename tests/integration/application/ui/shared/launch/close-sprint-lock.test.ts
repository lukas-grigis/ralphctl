/**
 * The TUI close-sprint launcher must take the same sprint-dir lock implement and review hold, so a
 * close waits for a live run and judges the sprint as the run left it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { revertSprintToActive } from '@src/domain/entity/sprint.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { InteractivePrompt } from '@src/business/interactive/prompt.ts';
import { launchFlow, type LauncherDeps } from '@src/application/ui/shared/launcher.ts';
import { loadAppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import { passthroughRunInTerminal } from '@src/integration/io/run-in-terminal.ts';
import { makeProject, makeReviewSprint } from '@tests/fixtures/domain.ts';
import { createRealFsApp, type RealFsApp } from '@tests/helpers/real-fs-app.ts';
import { holdSprintLock } from '@tests/helpers/hold-flow-lock.ts';

describe('launchCloseSprint — while a run holds the sprint', () => {
  let app: RealFsApp;

  beforeEach(async () => {
    app = await createRealFsApp();
  });

  afterEach(async () => {
    await app.cleanup();
  });

  it('waits for the run and refuses a sprint the run reopened meanwhile', async () => {
    const project = makeProject();
    const sprint = makeReviewSprint();
    expect((await app.deps.projectRepo.save(project)).ok).toBe(true);
    expect((await app.deps.sprintRepo.save(sprint)).ok).toBe(true);
    const snapshot = await loadAppStateSnapshot(
      { projectRepo: app.deps.projectRepo, sprintRepo: app.deps.sprintRepo, taskRepo: app.deps.taskRepo },
      { projectId: project.id, sprintId: sprint.id }
    );
    // Close yes, distill no.
    const answers = [true, false];
    const deps: LauncherDeps = {
      app: app.deps,
      storage: app.paths,
      interactive: { askConfirm: async () => Result.ok(answers.shift() ?? false) } as unknown as InteractivePrompt,
      runInTerminal: passthroughRunInTerminal,
    };

    const run = await holdSprintLock(app.paths, sprint, 'implement');
    const launched = await launchFlow(deps, 'close-sprint', snapshot);
    if (!launched.ok) throw new Error(launched.reason);
    const contended = run.contender();
    const close = launched.runner.start();
    const first = await Promise.race([contended.then(() => 'waiting'), close.then(() => 'finished')]);
    expect(first).toBe('waiting');
    const reopened = revertSprintToActive(sprint, IsoTimestamp.now());
    if (!reopened.ok) throw new Error(reopened.error.message);
    expect((await app.deps.sprintRepo.save(reopened.value)).ok).toBe(true);
    await run.release();
    await close;

    expect(launched.runner.status).toBe('failed');
    const after = await app.deps.sprintRepo.findById(sprint.id);
    expect(after.ok && after.value.status).toBe('active');
  });
});
