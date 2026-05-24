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
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { Sink } from '@src/business/observability/sink.ts';
import type { HarnessSignalSink } from '@src/business/observability/harness-signal-sink.ts';
import { broadcastSink } from '@src/integration/observability/sinks/broadcast-sink.ts';
import type { AiFlowSettings, AiImplementSettings, Settings } from '@src/domain/entity/settings.ts';
import { createAiProvider } from '@src/application/bootstrap/provider-factory.ts';
import { resolveEffortForRow } from '@src/business/settings/resolve-effort.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';

/**
 * Apply role-level overrides from {@link LaunchExtras.implementRoleOverrides} on top of the
 * persisted `settings.ai.implement` pair. Each role accepts `{ provider, model }` together —
 * the CLI parser rejects half-supplied pairs before we reach this point, so the merge is
 * straightforward: when a role override is present, swap its row entirely; otherwise leave
 * the persisted row alone.
 */
const applyImplementRoleOverrides = (
  base: AiImplementSettings,
  overrides: NonNullable<LaunchContext['extras']['implementRoleOverrides']> | undefined
): AiImplementSettings => {
  if (overrides === undefined) return base;
  const next: { generator: AiFlowSettings; evaluator: AiFlowSettings } = {
    generator: base.generator,
    evaluator: base.evaluator,
  };
  if (overrides.generator !== undefined) {
    next.generator = { provider: overrides.generator.provider, model: overrides.generator.model } as AiFlowSettings;
  }
  if (overrides.evaluator !== undefined) {
    next.evaluator = { provider: overrides.evaluator.provider, model: overrides.evaluator.model } as AiFlowSettings;
  }
  return next;
};

export const launchImplement = async (ctx: LaunchContext): Promise<LaunchResult> => {
  const { deps, snapshot, extras, settings, skillsAdapter, skillSource, bridge, sessionId } = ctx;
  // Apply per-role overrides (from CLI flags via `LaunchExtras.implementRoleOverrides`) onto
  // a settings copy before either readiness probing or provider construction — both must see
  // the overridden providers / models to avoid spawning the persisted pair while reporting on
  // the overridden one.
  const implementPair = applyImplementRoleOverrides(settings.ai.implement, extras.implementRoleOverrides);
  const effectiveSettings: Settings = {
    ...settings,
    ai: { ...settings.ai, implement: implementPair },
  };
  const missing = await checkCli('implement', effectiveSettings);
  if (missing !== undefined) return missing;
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
  const eventsNdjsonPath = AbsolutePath.parse(join(String(sprintDirPath.value), 'events.ndjson'));
  if (!eventsNdjsonPath.ok) return { ok: false, reason: eventsNdjsonPath.error.message };

  // Tee every AppEvent on the bus to <sprintDir>/events.ndjson for postmortem debugging.
  // Stopped when the runner exits (success or fail) — wired below via subscribe().
  // The factory is env-gated at `wire()` time: when `RALPHCTL_DEBUG_TRACE` is unset the
  // returned handle is a no-op, so production runs do not write the file unless the operator
  // explicitly opts in.
  const chainLog = deps.app.chainLogSink({ file: eventsNdjsonPath.value, bus: deps.app.eventBus });

  // Per-task signal mirror: `<change>` / `<learning>` / `<note>` signals are republished as
  // structured `harness-signal` events on the EventBus so the TUI panels (and the opt-in
  // events.ndjson tee) see them with a queryable shape. Track the current task id via the
  // bus's `task-attempt-started` events.
  let currentTaskId: string | undefined;
  const unsubTaskTracker = deps.app.eventBus.subscribe((event) => {
    if (event.type === 'task-attempt-started') currentTaskId = event.taskId;
  });
  const perTaskSignalBusMirror: Sink<HarnessSignal> = {
    emit(signal) {
      if (signal.type !== 'change' && signal.type !== 'learning' && signal.type !== 'note') return;
      deps.app.eventBus.publish({
        type: 'harness-signal',
        signalKind: signal.type,
        ...(currentTaskId !== undefined ? { taskId: currentTaskId } : {}),
        text: signal.text,
        at: IsoTimestamp.now(),
      });
    },
  };
  // Fan out every harness signal to the existing app sink (TUI bus + subscribers) and the
  // per-task event-bus mirror. Decisions are now accumulated on ctx by the gen-eval leaves
  // and rendered into `progress.md` by the journal leaf (audit-[07]) — no more on-disk
  // decisions.log.
  const signals: HarnessSignalSink = broadcastSink<HarnessSignal>([deps.app.signals, perTaskSignalBusMirror]);

  const repositories = new Map<RepositoryId, RepoExecConfig>();
  for (const r of snapshot.project.repositories) {
    repositories.set(r.id, {
      path: r.path,
      ...(r.verifyScript !== undefined ? { verifyScript: r.verifyScript } : {}),
      ...(r.setupScript !== undefined ? { setupScript: r.setupScript } : {}),
    });
  }

  // Build one HeadlessAiProvider per role from the effective implement pair. The two roles
  // may target distinct providers — the launcher constructs them independently rather than
  // routing through `primaryFlowRow` so a cross-provider configuration spawns the right CLI
  // per role. `ctx.provider` (the launcher-rebuilt primary adapter) is left unused here;
  // implement deliberately bypasses the single-row seam.
  const generatorProvider = createAiProvider({
    row: implementPair.generator,
    harnessConfig: effectiveSettings.harness,
    eventBus: deps.app.eventBus,
  });
  const evaluatorProvider = createAiProvider({
    row: implementPair.evaluator,
    harnessConfig: effectiveSettings.harness,
    eventBus: deps.app.eventBus,
  });
  const generatorEffort = resolveEffortForRow(implementPair.generator, effectiveSettings.ai.effort);
  const evaluatorEffort = resolveEffortForRow(implementPair.evaluator, effectiveSettings.ai.effort);

  const element: Element<ImplementCtx> = createImplementFlow(
    {
      sprintRepo: deps.app.sprintRepo,
      sprintExecutionRepo: deps.app.sprintExecutionRepo,
      taskRepo: deps.app.taskRepo,
      generatorProvider,
      evaluatorProvider,
      templateLoader: deps.app.templateLoader,
      signals,
      eventBus: deps.app.eventBus,
      logger: deps.app.logger,
      clock: deps.app.clock,
      config: effectiveSettings,
      gitRunner: deps.app.gitRunner,
      shellScriptRunner: deps.app.shellScriptRunner,
      fileLocker: deps.app.fileLocker,
      locksRoot: deps.storage.locksRoot,
      skillsAdapter,
      skillSource,
      interactive: deps.interactive,
      writeFile: deps.app.writeFile,
      appendFile: deps.app.appendFile,
    },
    {
      sprintId: snapshot.sprint.id,
      todoTasks,
      repositories,
      progressFile: progressPath.value,
      sprintDir: sprintDirPath.value,
      // `extras.modelOverride` is a legacy single-model knob from the flows-view picker;
      // applied to the generator role since that's the one that drove the prior single-model
      // implement path. Evaluator model stays bound to its settings row.
      generatorModel: extras.modelOverride ?? implementPair.generator.model,
      ...(generatorEffort !== undefined ? { generatorEffort } : {}),
      evaluatorModel: implementPair.evaluator.model,
      ...(evaluatorEffort !== undefined ? { evaluatorEffort } : {}),
    }
  );
  const runner = createRunner<ImplementCtx>({
    id: sessionId(),
    element,
    initialCtx: { sprintId: snapshot.sprint.id },
  });
  // Stop the file-log + bus subscriptions when the runner reaches a terminal state.
  // Pending writes still drain in the background — events.ndjson remains consistent
  // post-exit. The subscription self-unsubscribes on the terminal event so we don't pin
  // a dead listener (and its closure scope) to the runner's internal listener Set across
  // a long multi-run TUI session — historically a load-bearing OOM contributor.
  const unsubRunner: () => void = runner.subscribe((evt) => {
    if (evt.type === 'completed' || evt.type === 'failed' || evt.type === 'aborted') {
      chainLog.stop();
      void chainLog.flush();
      unsubTaskTracker();
      unsubRunner();
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
