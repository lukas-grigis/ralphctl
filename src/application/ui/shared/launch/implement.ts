import { join } from 'node:path';
import { type Element, flattenLeaves } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import {
  createImplementFlow,
  IMPLEMENT_TASK_TERMINAL_LEAF,
  planImplementWaves,
  type CreateImplementFlowOpts,
  type RepoExecConfig,
} from '@src/application/flows/implement/flow.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import {
  buildWaveBranches,
  createFoldQueue,
  serializeAppendFile,
  type BuildWaveBranchesDeps,
} from '@src/application/flows/implement/wave-branch.ts';
import { createParallelImplementElement } from '@src/application/flows/implement/parallel-element.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { renderTaskGraphIssue, validateTaskGraph } from '@src/domain/entity/task-graph.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
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
 * persisted `settings.ai.implement` pair. Each role accepts `{ provider?, model?, effort? }`
 * with every field independently optional — supplying only `provider` keeps the persisted
 * model / effort for that role. The TUI customize picker assembles coherent overrides (a
 * provider switch always rides with a fresh model from the new provider's catalog); the CLI
 * parser still rejects half-supplied provider/model pairs upstream. The discriminated-union
 * cast remains sound under both call sites.
 */
const mergeImplementRole = (
  base: AiFlowSettings,
  override: NonNullable<NonNullable<LaunchContext['extras']['implementRoleOverrides']>['generator']>
): AiFlowSettings => {
  const provider = override.provider ?? base.provider;
  const model = override.model ?? base.model;
  const effort = override.effort ?? base.effort;
  return { provider, model, ...(effort !== undefined ? { effort } : {}) } as AiFlowSettings;
};

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
    next.generator = mergeImplementRole(base.generator, overrides.generator);
  }
  if (overrides.evaluator !== undefined) {
    next.evaluator = mergeImplementRole(base.evaluator, overrides.evaluator);
  }
  return next;
};

/**
 * Resolve the ordered launch queue from a sprint's FULL task set (audit §5 human-gate).
 *
 * `validateTaskGraph` runs first, so a cyclic / self-edge / dangling-dependency sprint fails fast
 * here with the rendered issue — a deadlock can't hide behind an innocuous "No tasks to implement"
 * message that only appears after unschedulable tasks are filtered out.
 *
 * On a sound DAG the queue is built by a dependency-respecting PRIORITY topological sort over the
 * RESUMABLE subset (`todo` + `in_progress`): a task is emitted only after every resumable
 * prerequisite it depends on has been emitted, and among the tasks that are legally runnable at
 * each step the resumed (`in_progress`) ones lead, then `Task.order` ASC breaks the tie. A done /
 * blocked prerequisite is NOT in the resumable subgraph, so it never blocks ordering — a resumed
 * task whose prerequisites are all `done` still leads the queue.
 *
 * Why a priority topo-sort and not the old flat in-progress-first sort: the flat sort could hoist a
 * resumed `in_progress` task AHEAD of a still-`todo` prerequisite it depends on (e.g. after a crash
 * + manual unblock leaves `{prereq: todo, dependent: in_progress}`). In the serial path the per-task
 * subchains run in queue order, so the dependent's `dependency-gate` would then fire BEFORE its
 * prerequisite ran, blocking the dependent `blocked upstream` and dead-ending it for the launch.
 * Making dependency order a hard constraint (a prerequisite always precedes its dependent) means the
 * gate never sees a not-yet-run prerequisite — the prereq runs first, settles, and the dependent
 * resumes behind it.
 *
 * Returns the rendered `TaskGraphIssue` string on an invalid graph, otherwise the ordered queue
 * (possibly empty when nothing is resumable — the caller reports that separately).
 *
 * @public
 */
export const resolveImplementQueue = (tasks: readonly Task[]): Result<readonly Task[], string> => {
  // Validate the full graph first (cycle / self-edge / dangling) so a deadlock surfaces as the
  // rendered issue rather than a silently-truncated queue.
  const validation = validateTaskGraph(tasks);
  if (!validation.ok) return Result.error(renderTaskGraphIssue(validation.error));

  const resumable = tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress');
  const resumableIds = new Set(resumable.map((t) => t.id));

  // In-degree + successors over the RESUMABLE subgraph only — a dependency that resolves to a
  // done / blocked (non-resumable) task is already satisfied (or terminal) and must not gate the
  // dependent here; the dependency-gate leaf handles the blocked-prerequisite case at run time.
  const byId = new Map<TaskId, Task>(resumable.map((t) => [t.id, t]));
  const inDegree = new Map<TaskId, number>(resumable.map((t) => [t.id, 0]));
  const successors = new Map<TaskId, TaskId[]>(resumable.map((t) => [t.id, []]));
  for (const t of resumable) {
    for (const dep of t.dependsOn) {
      if (!resumableIds.has(dep)) continue;
      inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
      successors.get(dep)?.push(t.id);
    }
  }

  // Resumed tasks lead, then lowest `Task.order` — applied only among the currently-runnable
  // frontier, so it can never violate dependency order.
  const priority = (a: Task, b: Task): number => {
    if (a.status !== b.status) return a.status === 'in_progress' ? -1 : 1;
    return a.order - b.order;
  };

  const queue: Task[] = [];
  // `Task[]`, not the inferred `(TodoTask | InProgressTask)[]` from `resumable` — successors pushed
  // below come from `byId` (typed `Task`), and the priority comparator only reads `status`/`order`.
  const frontier: Task[] = resumable.filter((t) => (inDegree.get(t.id) ?? 0) === 0);
  while (frontier.length > 0) {
    frontier.sort(priority);
    const next = frontier.shift() as Task;
    queue.push(next);
    for (const succId of successors.get(next.id) ?? []) {
      const remaining = (inDegree.get(succId) ?? 0) - 1;
      inDegree.set(succId, remaining);
      const succ = byId.get(succId);
      if (remaining === 0 && succ !== undefined) frontier.push(succ);
    }
  }
  return Result.ok(queue);
};

/**
 * Clamp `settings.concurrency.maxParallelTasks` to `[1,5]` — the parallel cap. `=== 1`
 * selects the serial implement path; `> 1` selects the parallel worktree-fan-out path. The settings
 * schema already validates `[1,5]`, but the launcher re-clamps defensively (a hand-edited settings
 * file or a future schema change can never push the harness past the budget it was sized against).
 *
 * @public
 */
export const clampParallel = (n: number): number => {
  if (!Number.isFinite(n)) return 1;
  return Math.min(5, Math.max(1, Math.trunc(n)));
};

/**
 * Build the `>1` parallel implement element. Computes the wave plan from the same deps/opts the
 * serial path uses, then wraps the prologue → `runWaves` → epilogue orchestration in the
 * {@link createParallelImplementElement} adapter — run on ONE outer runner under ONE held lock.
 *
 * `appSignals` is the launcher's app-wide harness-signal sink (NOT the serial-path-wrapped one);
 * `buildWaveBranches` fans a per-branch sink off it keyed on each branch's `taskId`.
 */
const buildParallelElement = (
  implementDeps: ImplementDeps,
  implementOpts: CreateImplementFlowOpts,
  appSignals: HarnessSignalSink,
  maxParallel: number,
  sessionId: () => string
): Element<ImplementCtx> => {
  const readConfig = (): Promise<{
    readonly maxTurns: number;
    readonly escalateOnPlateau: boolean;
    readonly escalationMap: Readonly<Record<string, string>>;
  }> =>
    Promise.resolve({
      maxTurns: implementDeps.config.harness.maxTurns,
      escalateOnPlateau: implementDeps.config.harness.escalateOnPlateau,
      escalationMap: implementDeps.config.harness.escalationMap,
    });

  // Serialise every append for the WHOLE parallel run — prologue, all branches, and the epilogue
  // share ONE mutex. Concurrent branches append to the same `progress.md` journal and project
  // learnings ledger; funnelling them through one queue keeps each line atomic (no torn NDJSON /
  // journal lines under fan-out). The serial path keeps the raw port — it has no concurrency.
  const parallelDeps: ImplementDeps = { ...implementDeps, appendFile: serializeAppendFile(implementDeps.appendFile) };

  const branchDeps: BuildWaveBranchesDeps = {
    implement: parallelDeps,
    appSignals,
    eventBus: parallelDeps.eventBus,
    foldQueue: createFoldQueue(),
  };
  const plan = planImplementWaves(parallelDeps, implementOpts);

  return createParallelImplementElement(plan, {
    fileLocker: implementDeps.fileLocker,
    locksRoot: implementDeps.locksRoot,
    eventBus: implementDeps.eventBus,
    maxConcurrency: maxParallel,
    flowId: 'implement',
    sessionId,
    buildWaves: () => buildWaveBranches(branchDeps, implementOpts, plan.waves, readConfig),
  });
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
  const missing = await checkCli('implement', effectiveSettings, {
    implementRoleOverrides: extras.implementRoleOverrides,
  });
  if (missing !== undefined) return missing;
  if (!snapshot.sprint) return { ok: false, reason: 'No sprint selected.' };
  if (!snapshot.project) return { ok: false, reason: 'No project loaded for the selected sprint.' };
  if (snapshot.project.repositories.length === 0) {
    return { ok: false, reason: 'Project has no repositories — add one first.' };
  }
  // Human-gate (audit §5): validate + dependency-schedule the FULL task set before launch, then
  // derive the resumable queue with the in-progress-first override applied. A cyclic / dangling
  // graph fails fast here with the rendered issue rather than silently surfacing as an empty
  // queue once the unschedulable tasks are filtered out.
  const queue = resolveImplementQueue(snapshot.tasks);
  if (!queue.ok) return { ok: false, reason: queue.error };
  const todoTasks = queue.value;
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

  // Signal mirror: `<change>` / `<learning>` / `<note>` signals are republished as structured
  // `harness-signal` events on the EventBus so the TUI panels (and the opt-in events.ndjson tee)
  // see them with a queryable shape.
  //
  // The OLD single-slot `currentTaskId` tracker (keyed off the bus's `task-attempt-started` event)
  // is DELETED: that event has zero production publishers, so the slot was always `undefined` —
  // every serial-path `harness-signal` was already unattributed. The parallel `>1` path attaches a
  // PER-BRANCH sink keyed on the branch's `taskId` (see `wave-branch.ts`), the only correct model
  // under concurrency. The serial path keeps emitting unattributed events, byte-for-byte with
  // today's behaviour — renderers that group by task simply skip unattributed entries.
  const serialSignalBusMirror: Sink<HarnessSignal> = {
    emit(signal) {
      if (signal.type !== 'change' && signal.type !== 'learning' && signal.type !== 'note') return;
      deps.app.eventBus.publish({
        type: 'harness-signal',
        signalKind: signal.type,
        text: signal.text,
        at: IsoTimestamp.now(),
      });
    },
  };
  // Fan out every harness signal to the existing app sink (TUI bus + subscribers) and the serial
  // event-bus mirror. Decisions are accumulated on ctx by the gen-eval leaves and rendered into
  // `progress.md` by the journal leaf (audit-[07]). The parallel path builds its own per-branch
  // sinks in `wave-branch.ts` from `deps.app.signals`, so this `signals` is the serial-path sink.
  const signals: HarnessSignalSink = broadcastSink<HarnessSignal>([deps.app.signals, serialSignalBusMirror]);

  const repositories = new Map<RepositoryId, RepoExecConfig>();
  for (const r of snapshot.project.repositories) {
    repositories.set(r.id, {
      path: r.path,
      name: r.name,
      ...(r.verifyScript !== undefined ? { verifyScript: r.verifyScript } : {}),
      ...(r.verifyTimeout !== undefined ? { verifyTimeout: r.verifyTimeout } : {}),
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

  const implementDeps: ImplementDeps = {
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
  };
  const implementOpts = {
    sprintId: snapshot.sprint.id,
    todoTasks,
    repositories,
    progressFile: progressPath.value,
    sprintDir: sprintDirPath.value,
    generatorProviderId: implementPair.generator.provider,
    generatorModel: implementPair.generator.model,
    ...(generatorEffort !== undefined ? { generatorEffort } : {}),
    evaluatorProviderId: implementPair.evaluator.provider,
    evaluatorModel: implementPair.evaluator.model,
    ...(evaluatorEffort !== undefined ? { evaluatorEffort } : {}),
    memoryRoot: deps.storage.memoryRoot,
    projectId: String(snapshot.project.id),
  };

  // Parallel cap: clamp `settings.concurrency.maxParallelTasks` to `[1,5]`. `=== 1` →
  // today's serial path (the chain owns its own internal `withRepoLock`); the meta-run caller
  // (`createRunFlow`) also stays on this path — it constructs `createImplementFlow` directly and
  // never reaches this launcher. `> 1` → the parallel path: one held lock hoisted to the launcher
  // across prologue + waves + epilogue, one worktree per task, folds serialised onto the
  // single shared sprint branch → one PR.
  const maxParallel = clampParallel(effectiveSettings.concurrency.maxParallelTasks);

  // Parallel path fans per-branch signal sinks off the RAW app sink (`deps.app.signals`), NOT the
  // serial-wrapped `signals` (which carries the unattributed serial bus mirror) — so concurrent
  // branches emit `harness-signal` events with their own `taskId` and don't also double-publish
  // unattributed ones.
  const element: Element<ImplementCtx> =
    maxParallel === 1
      ? createImplementFlow(implementDeps, implementOpts)
      : buildParallelElement(implementDeps, implementOpts, deps.app.signals, maxParallel, sessionId);

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
      unsubRunner();
    }
  });
  const taskNames = new Map<string, string>(todoTasks.map((t) => [String(t.id), t.name]));
  // Detect resumes at launch time: any task whose last attempt is still `running` (the v8 OOM /
  // Ctrl-C / SIGTERM signature in a prior process) gets a `RecoveryContext` pinned to its id. We
  // pre-derive here — rather than waiting for the chain's start-attempt leaf to settle — so the
  // TUI's resume-from-aborted banner shows up *before* the chain starts executing, not after the
  // first leaf finishes. Keyed on the leftover running attempt, NOT on `status === 'in_progress'`:
  // a crash can persist a status-corrupt `todo` task whose last attempt is still `running` (which
  // `startAttemptUseCase` heals), and the banner must fire for it too. `process-crash` is the
  // conservative cause for the cross-process inference; P1j's signal-aware path will refine it.
  const taskRecovering = new Map<string, RecoveryContext>();
  const nowAtLaunch = deps.app.clock();
  for (const t of todoTasks) {
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
  // Both role models are drawn from the post-merge implementPair so per-launch role overrides
  // (TUI customize picker or CLI flags) flow through to the rail/banner without a second
  // settings read.
  const generatorModel = implementPair.generator.model;
  const evaluatorModel = implementPair.evaluator.model;
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
    generatorModel,
    evaluatorModel,
  };
};
