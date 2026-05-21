import { join } from 'node:path';
import { type Element, flattenLeaves } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import {
  createImplementFlow,
  IMPLEMENT_TASK_TERMINAL_LEAF,
  type RepoExecConfig,
} from '@src/application/flows/implement/flow.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { RecoveryContext } from '@src/domain/entity/attempt.ts';
import type { RepositoryId } from '@src/domain/value/id/repository-id.ts';
import type { HarnessSignalSink } from '@src/integration/ai/signals/_engine/sink.ts';
import { broadcastSink } from '@src/integration/observability/sinks/broadcast-sink.ts';
import { createDecisionsLogSink } from '@src/integration/observability/sinks/decisions-log-sink.ts';
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
  const decisionsLogPath = AbsolutePath.parse(join(String(sprintDirPath.value), 'decisions.log'));
  if (!decisionsLogPath.ok) return { ok: false, reason: decisionsLogPath.error.message };

  // Tee every AppEvent on the bus to <sprintDir>/chain.log for postmortem debugging.
  // Stopped when the runner exits (success or fail) — wired below via subscribe().
  const chainLog = startFileLogSink({ file: chainLogPath.value, bus: deps.app.eventBus });

  // Per-sprint decisions.log: tracks `<decision>` signals from the harness signal stream.
  // The taskId column tracks the most recent `task-attempt-started` event so decisions
  // emitted mid-attempt carry the right id. Commit sha is best-effort `?` — decisions are
  // emitted during the generator turn, before the per-task commit; a future enhancement can
  // backfill once the commit-task leaf settles.
  let currentTaskId: string | undefined;
  const unsubTaskTracker = deps.app.eventBus.subscribe((event) => {
    if (event.type === 'task-attempt-started') currentTaskId = event.taskId;
  });
  const decisionsSink = createDecisionsLogSink({
    file: decisionsLogPath.value,
    resolveContext: () => (currentTaskId !== undefined ? { taskId: currentTaskId } : {}),
  });
  // Fan out every harness signal to both the existing app sink (TUI bus + any other
  // subscribers) AND the decisions log sink. The decisions sink filters internally — only
  // `decision` signals produce a write.
  const signals: HarnessSignalSink = broadcastSink<HarnessSignal>([deps.app.signals, decisionsSink]);

  const repositories = new Map<RepositoryId, RepoExecConfig>();
  for (const r of snapshot.project.repositories) {
    repositories.set(r.id, {
      path: r.path,
      ...(r.verifyScript !== undefined ? { verifyScript: r.verifyScript } : {}),
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
      signals,
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
      loadChainLog: deps.app.loadChainLog,
      loadDecisionsLog: deps.app.loadDecisionsLog,
      writeFile: deps.app.writeFile,
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
  // Stop the file-log + decisions-log subscriptions when the runner reaches a terminal state.
  // Pending writes still drain in the background — both files remain consistent post-exit.
  runner.subscribe((evt) => {
    if (evt.type === 'completed' || evt.type === 'failed' || evt.type === 'aborted') {
      chainLog.stop();
      void chainLog.flush();
      unsubTaskTracker();
      void decisionsSink.flush();
    }
  });
  const taskNames = new Map<string, string>(todoTasks.map((t) => [String(t.id), t.name]));
  // Detect resumes at launch time: any in-progress task whose last attempt is still `running`
  // (the v8 OOM / Ctrl-C / SIGTERM signature in a prior process) gets a `RecoveryContext`
  // pinned to its id. We pre-derive here — rather than waiting for the chain's start-attempt
  // leaf to settle — so the TUI's resume-from-aborted banner shows up *before* the chain
  // starts executing, not after the first leaf finishes. `process-crash` is the conservative
  // cause for the cross-process inference; P1j's signal-aware path will refine it.
  const taskRecovering = new Map<string, RecoveryContext>();
  const nowAtLaunch = deps.app.clock();
  for (const t of todoTasks) {
    if (t.status !== 'in_progress') continue;
    const last = t.attempts.at(-1);
    if (last === undefined || last.status !== 'running') continue;
    taskRecovering.set(String(t.id), {
      fromAttemptN: t.attempts.length,
      cause: 'process-crash',
      abortedAt: nowAtLaunch,
    });
  }
  const flattened = flattenLeaves(element);
  const plannedLeaves = flattened.map((e) => e.name);
  // Plan-time label lookup — keyed by element name so the rail can render friendly labels for
  // rows that haven't traced yet (pending / running). Once a leaf executes, the trace entry's
  // own `label` carries the same value and supersedes this lookup. Only leaves that supplied
  // a non-empty label are entered; lookups fall through to the raw name for everything else.
  const planLabelByName = new Map<string, string>();
  for (const leaf of flattened) {
    if (leaf.label !== undefined && leaf.label.length > 0) planLabelByName.set(leaf.name, leaf.label);
  }
  return {
    ok: true,
    runner: bridge(runner) as Runner<unknown>,
    title: `Implement — ${snapshot.sprint.name}`,
    taskNames,
    maxTurns: settings.harness.maxTurns,
    plannedLeaves,
    ...(planLabelByName.size > 0 ? { planLabelByName } : {}),
    terminalSubstepName: IMPLEMENT_TASK_TERMINAL_LEAF,
    ...(taskRecovering.size > 0 ? { taskRecovering } : {}),
  };
};
