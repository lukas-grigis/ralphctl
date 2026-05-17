import { join } from 'node:path';
import { type Element, flattenLeaves } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import {
  createImplementFlow,
  IMPLEMENT_TASK_TERMINAL_LEAF,
  type RepoExecConfig,
} from '@src/application/flows/implement/flow.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import { startFileLogSink } from '@src/integration/observability/sinks/file-log-sink.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';

export const launchImplement = (ctx: LaunchContext): LaunchResult => {
  const { deps, snapshot, extras, settings, provider, skillsAdapter, skillSource, bridge, sessionId } = ctx;
  if (!snapshot.sprint) return { ok: false, reason: 'No sprint selected.' };
  if (!snapshot.project) return { ok: false, reason: 'No project loaded for the selected sprint.' };
  if (snapshot.project.repositories.length === 0) {
    return { ok: false, reason: 'Project has no repositories — add one first.' };
  }
  // Resume support: `in_progress` tasks from a prior aborted chain are included so the user can
  // simply relaunch Implement and pick up where the previous run died. The start-attempt use
  // case settles any leftover `running` attempt as `aborted` before opening a new one, so the
  // domain stays consistent. Sort in-progress first so resume happens before any new task work.
  const resumable = snapshot.tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress');
  const todoTasks = [...resumable].sort((a, b) => {
    if (a.status === b.status) return 0;
    return a.status === 'in_progress' ? -1 : 1;
  });
  if (todoTasks.length === 0) return { ok: false, reason: 'No tasks to implement or resume.' };
  const sprintDirPath = AbsolutePath.parse(join(String(deps.storage.dataRoot), 'sprints', String(snapshot.sprint.id)));
  if (!sprintDirPath.ok) return { ok: false, reason: sprintDirPath.error.message };
  const progressPath = AbsolutePath.parse(join(String(sprintDirPath.value), 'progress.md'));
  if (!progressPath.ok) return { ok: false, reason: progressPath.error.message };
  const chainLogPath = AbsolutePath.parse(join(String(sprintDirPath.value), 'chain.log'));
  if (!chainLogPath.ok) return { ok: false, reason: chainLogPath.error.message };

  // Tee every AppEvent on the bus to <sprintDir>/chain.log for postmortem debugging.
  // Stopped when the runner exits (success or fail) — wired below via subscribe().
  const chainLog = startFileLogSink({ file: chainLogPath.value, bus: deps.app.eventBus });

  const repositories = new Map<RepositoryId, RepoExecConfig>();
  for (const r of snapshot.project.repositories) {
    repositories.set(r.id, {
      path: r.path,
      ...(r.checkScript !== undefined ? { checkScript: r.checkScript } : {}),
      ...(r.setupScript !== undefined ? { setupScript: r.setupScript } : {}),
    });
  }

  const element: Element<ImplementCtx> = createImplementFlow(
    {
      sprintRepo: deps.app.sprintRepo,
      sprintExecutionRepo: deps.app.sprintExecutionRepo,
      taskRepo: deps.app.taskRepo,
      provider,
      templateLoader: deps.app.templateLoader,
      signals: deps.app.signals,
      eventBus: deps.app.eventBus,
      logger: deps.app.logger,
      clock: deps.app.clock,
      config: settings,
      gitRunner: deps.app.gitRunner,
      shellScriptRunner: deps.app.shellScriptRunner,
      fileLocker: deps.app.fileLocker,
      locksRoot: deps.storage.locksRoot,
      skillsAdapter,
      skillSource,
      interactive: deps.interactive,
    },
    {
      sprintId: snapshot.sprint.id,
      todoTasks,
      repositories,
      progressFile: progressPath.value,
      sprintDir: sprintDirPath.value,
      model: extras.modelOverride ?? settings.ai.models.implement,
    }
  );
  const runner = createRunner<ImplementCtx>({
    id: sessionId(),
    element,
    initialCtx: { sprintId: snapshot.sprint.id },
  });
  // Stop the file-log subscription when the runner reaches a terminal state. Pending writes
  // still drain in the background — the file remains consistent post-exit.
  runner.subscribe((evt) => {
    if (evt.type === 'completed' || evt.type === 'failed' || evt.type === 'aborted') {
      chainLog.stop();
      void chainLog.flush();
    }
  });
  const taskNames = new Map<string, string>(todoTasks.map((t) => [String(t.id), t.name]));
  const plannedLeaves = flattenLeaves(element).map((e) => e.name);
  return {
    ok: true,
    runner: bridge(runner) as Runner<unknown>,
    title: `Implement — ${snapshot.sprint.name}`,
    taskNames,
    maxTurns: settings.harness.maxTurns,
    plannedLeaves,
    terminalSubstepName: IMPLEMENT_TASK_TERMINAL_LEAF,
  };
};
