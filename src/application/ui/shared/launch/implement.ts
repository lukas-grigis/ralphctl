import { join } from 'node:path';
import { sprintDir } from '@src/integration/persistence/storage.ts';
import type { Element } from '@src/application/chain/element.ts';
import { createRunner, type Runner } from '@src/application/chain/run/runner.ts';
import {
  createImplementFlow,
  IMPLEMENT_TASK_TERMINAL_LEAF,
  planImplementWaves,
  type CreateImplementFlowOpts,
} from '@src/application/flows/implement/flow.ts';
import type { ImplementDeps } from '@src/application/flows/implement/deps.ts';
import {
  buildWaveBranches,
  createFoldQueue,
  serializeAppendFile,
  type BuildWaveBranchesDeps,
} from '@src/application/flows/implement/wave-branch.ts';
import { createParallelImplementElement } from '@src/application/flows/implement/parallel-element.ts';
import { buildAttemptReadConfig } from '@src/application/flows/implement/leaves/attempt-body.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { Result } from '@src/domain/result.ts';
import type { Task } from '@src/domain/entity/task.ts';
import { renderTaskGraphIssue, type TaskGraphIssue, validateTaskGraph } from '@src/domain/entity/task-graph.ts';
import { renderSprintConsistencyIssue, validateSprintConsistency } from '@src/business/sprint/sprint-consistency.ts';
import type { TaskId } from '@src/domain/value/id/task-id.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { RecoveryContext } from '@src/domain/entity/attempt.ts';
import type { Sprint } from '@src/domain/entity/sprint.ts';
import type { SprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { Project } from '@src/domain/entity/project.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import { createPublishSignal, type PublishSignal } from '@src/application/flows/_shared/publish-signal.ts';
import { type AiFlowSettings, type AiImplementSettings, type Settings } from '@src/domain/entity/settings.ts';
import { resolveImplementAgentBindings } from '@src/application/ui/shared/launch/implement-agent-bindings.ts';
import {
  buildImplementDepsBag,
  buildImplementOptsBag,
  buildImplementProviders,
} from '@src/application/ui/shared/launch/implement-bags.ts';
import type { LaunchContext } from '@src/application/ui/shared/launch/context.ts';
import type { LaunchResult } from '@src/application/ui/shared/launcher.ts';
import { checkCli } from '@src/application/ui/shared/launch/check-cli.ts';
import { mergeFlowRow } from '@src/application/ui/shared/launch/ai-flow-id.ts';

/** Apply role-level `implementRoleOverrides` on top of the persisted `settings.ai.implement` pair. */
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
    next.generator = mergeFlowRow(base.generator, overrides.generator);
  }
  if (overrides.evaluator !== undefined) {
    next.evaluator = mergeFlowRow(base.evaluator, overrides.evaluator);
  }
  return next;
};

/**
 * The cross-aggregate bundle that lets {@link resolveImplementQueue} run the FULL referential- integrity check
 * instead of the dependency graph alone.
 * @public
 */
export interface ImplementQueueBundle {
  readonly project: Project;
  readonly sprint: Sprint;
  readonly execution: SprintExecution;
}

/**
 * Resolve the ordered launch queue from a sprint's FULL task set — the pre-launch human gate.
 * @public
 */
export const resolveImplementQueue = (
  tasks: readonly Task[],
  bundle?: ImplementQueueBundle
): Result<readonly Task[], string> => {
  // Validate first so a cycle or dangling reference surfaces as the rendered issue, not a silently-truncated queue.
  const validation = bundle === undefined ? validateTaskGraph(tasks) : validateSprintConsistency({ ...bundle, tasks });
  if (!validation.ok) return Result.error(renderSprintConsistencyIssue(validation.error));

  const resumable = tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress');
  const resumableIds = new Set(resumable.map((t) => t.id));

  // In-degree + successors over the RESUMABLE subgraph only — a dependency that resolves to a done / blocked
  // (non-resumable) task is already satisfied (or terminal) and must not gate the dependent here.
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
 * Clamp `settings.concurrency.maxParallelTasks` to `[1,5]` — the parallel cap. `=== 1` selects the serial implement
 * path; `> 1` selects the parallel worktree-fan-out path.
 * @public
 */
export const clampParallel = (n: number): number => {
  if (!Number.isFinite(n)) return 1;
  return Math.min(5, Math.max(1, Math.trunc(n)));
};

/** Build the `>1` parallel implement element. */
const buildParallelElement = (
  implementDeps: ImplementDeps,
  implementOpts: CreateImplementFlowOpts,
  maxParallel: number,
  sessionId: () => string
): Result<Element<ImplementCtx>, TaskGraphIssue> => {
  // Built via the shared `buildAttemptReadConfig` (see `attempt-body.ts`) — the same builder `flow.ts`'s serial
  // launcher uses.
  const readConfig = buildAttemptReadConfig(implementDeps.config.harness);

  // Serialise every append for the WHOLE parallel run — prologue, all branches, and the epilogue share ONE mutex.
  const parallelDeps: ImplementDeps = { ...implementDeps, appendFile: serializeAppendFile(implementDeps.appendFile) };

  const branchDeps: BuildWaveBranchesDeps = {
    implement: parallelDeps,
    eventBus: parallelDeps.eventBus,
    foldQueue: createFoldQueue(),
  };
  const planned = planImplementWaves(parallelDeps, implementOpts);
  if (!planned.ok) return Result.error(planned.error);
  const plan = planned.value;

  return Result.ok(
    createParallelImplementElement(plan, {
      fileLocker: implementDeps.fileLocker,
      locksRoot: implementDeps.locksRoot,
      eventBus: implementDeps.eventBus,
      maxConcurrency: maxParallel,
      flowId: 'implement',
      sessionId,
      buildWaves: () => buildWaveBranches(branchDeps, implementOpts, plan.waves, readConfig),
    })
  );
};

/**
 * Direct-build the canonical `<id>--<slug>/` sprint dir plus its `progress.md` / `events.ndjson` siblings, collapsing
 * the three `AbsolutePath.parse` checks into one `Result` chain.
 */
const resolveImplementSprintPaths = (
  dataRoot: AbsolutePath,
  sprint: Pick<Sprint, 'id' | 'slug'>
): Result<
  {
    readonly sprintDirPath: AbsolutePath;
    readonly progressPath: AbsolutePath;
    readonly eventsNdjsonPath: AbsolutePath;
  },
  string
> => {
  const sprintDirPath = AbsolutePath.parse(sprintDir(dataRoot, sprint.id, sprint.slug));
  if (!sprintDirPath.ok) return Result.error(sprintDirPath.error.message);
  const progressPath = AbsolutePath.parse(join(String(sprintDirPath.value), 'progress.md'));
  if (!progressPath.ok) return Result.error(progressPath.error.message);
  const eventsNdjsonPath = AbsolutePath.parse(join(String(sprintDirPath.value), 'events.ndjson'));
  if (!eventsNdjsonPath.ok) return Result.error(eventsNdjsonPath.error.message);
  return Result.ok({
    sprintDirPath: sprintDirPath.value,
    progressPath: progressPath.value,
    eventsNdjsonPath: eventsNdjsonPath.value,
  });
};

/**
 * Stop the file-log + bus subscriptions when the runner reaches a terminal state. Pending writes still drain in the
 * background — events.ndjson remains consistent post-exit.
 */
type ChainLogHandle = { readonly stop: () => void; readonly flush: () => Promise<void> };

const stopChainLog = (chainLog: ChainLogHandle): void => {
  chainLog.stop();
  void chainLog.flush();
};

const wireChainLogStop = (runner: Runner<ImplementCtx>, chainLog: ChainLogHandle): void => {
  const unsubRunner: () => void = runner.subscribe((evt) => {
    if (evt.type === 'completed' || evt.type === 'failed' || evt.type === 'aborted') {
      stopChainLog(chainLog);
      unsubRunner();
    }
  });
};

/**
 * Detect resumes at launch time: any task whose last attempt is still `running` (the v8 OOM / Ctrl-C / SIGTERM
 * signature in a prior process) gets a `RecoveryContext` pinned to its id.
 */
const computeTaskRecovering = (todoTasks: readonly Task[], now: IsoTimestamp): Map<string, RecoveryContext> => {
  const taskRecovering = new Map<string, RecoveryContext>();
  for (const t of todoTasks) {
    const last = t.attempts.at(-1);
    if (last === undefined || last.status !== 'running') continue;
    taskRecovering.set(String(t.id), {
      fromAttemptN: t.attempts.length,
      cause: 'harness-interrupted',
      abortedAt: now,
    });
  }
  return taskRecovering;
};

/**
 * Build the implement chain element for this launch — the deps/opts bags plus the serial-vs-parallel topology
 * decision.
 */
const buildImplementElement = (
  ctx: LaunchContext,
  args: {
    readonly effectiveSettings: Settings;
    readonly implementPair: AiImplementSettings;
    readonly publishSignal: PublishSignal;
    readonly providers: ReturnType<typeof buildImplementProviders>;
    readonly agentBindings: Awaited<ReturnType<typeof resolveImplementAgentBindings>>;
    readonly sprint: Sprint;
    readonly project: Project;
    readonly todoTasks: readonly Task[];
    /** EVERY task on the sprint, not just the resumable queue. */
    readonly allTasks: readonly Task[];
    readonly progressPath: AbsolutePath;
    readonly sprintDirPath: AbsolutePath;
  }
): Result<Element<ImplementCtx>, TaskGraphIssue> => {
  const { deps, skillsAdapter, skillSource, sessionId } = ctx;
  const implementDeps = buildImplementDepsBag(
    deps,
    args.effectiveSettings,
    args.publishSignal,
    args.providers,
    skillsAdapter,
    skillSource,
    { generator: args.agentBindings.generatorAdapter, evaluator: args.agentBindings.evaluatorAdapter }
  );
  // Tasks outside the resumable queue are already settled (`done` or `blocked`), so a dependency on one is satisfied,
  // not a dangling edge; an id that exists on no task still fails.
  const queuedIds = new Set<TaskId>(args.todoTasks.map((t) => t.id));
  const satisfiedDependencyIds = new Set<TaskId>(args.allTasks.filter((t) => !queuedIds.has(t.id)).map((t) => t.id));
  const implementOpts: CreateImplementFlowOpts = {
    ...buildImplementOptsBag(
      args.sprint,
      args.project,
      args.todoTasks,
      { progressPath: args.progressPath, sprintDirPath: args.sprintDirPath },
      args.implementPair,
      args.providers,
      deps.storage.memoryRoot,
      { generator: args.agentBindings.generator, evaluator: args.agentBindings.evaluator }
    ),
    ...(satisfiedDependencyIds.size > 0 ? { satisfiedDependencyIds } : {}),
  };
  const maxParallel = clampParallel(args.effectiveSettings.concurrency.maxParallelTasks);
  return maxParallel === 1
    ? Result.ok(createImplementFlow(implementDeps, implementOpts))
    : buildParallelElement(implementDeps, implementOpts, maxParallel, sessionId);
};

/**
 * A sprint whose execution record can't be read (none written yet — no implement run has happened) still gets the
 * dependency-graph check.
 */
const resolveQueueForLaunch = async (
  deps: LaunchContext['deps'],
  project: Project,
  sprint: Sprint,
  tasks: readonly Task[]
): Promise<Result<readonly Task[], string>> => {
  const execution = await deps.app.sprintExecutionRepo.findById(sprint.id);
  if (!execution.ok) return resolveImplementQueue(tasks);
  return resolveImplementQueue(tasks, { project, sprint, execution: execution.value });
};

/**
 * PATH pre-flight for both roles — skipped when a provider spawn override is wired, because "is the CLI installed?"
 * is not a question that applies when nothing will be spawned.
 */
const preflightCli = async (ctx: LaunchContext, effectiveSettings: Settings): Promise<LaunchResult | undefined> =>
  ctx.deps.app.providerSpawn !== undefined
    ? undefined
    : checkCli('implement', effectiveSettings, { implementRoleOverrides: ctx.extras.implementRoleOverrides });

/**
 * Build the implement element for this launch and unwrap `buildImplementElement`'s `Result` into a launch failure.
 */
const buildImplementElementOrFailure = (
  ctx: LaunchContext,
  args: Parameters<typeof buildImplementElement>[1]
): Result<Element<ImplementCtx>, LaunchResult> => {
  const built = buildImplementElement(ctx, args);
  return built.ok ? Result.ok(built.value) : Result.error({ ok: false, reason: renderTaskGraphIssue(built.error) });
};

/**
 * Resolve each role's opt-in agent-definition binding, then build the two per-role providers on top of it.
 */
const resolveImplementAgentBindingsAndProviders = async (
  deps: LaunchContext['deps'],
  implementPair: AiImplementSettings,
  effectiveSettings: Settings
): Promise<{
  readonly agentBindings: Awaited<ReturnType<typeof resolveImplementAgentBindings>>;
  readonly providers: ReturnType<typeof buildImplementProviders>;
}> => {
  const agentBindings = await resolveImplementAgentBindings(deps, implementPair);
  const providers = buildImplementProviders(implementPair, effectiveSettings, deps, {
    ...(agentBindings.generator.definition !== undefined ? { generator: agentBindings.generator.definition } : {}),
    ...(agentBindings.evaluator.definition !== undefined ? { evaluator: agentBindings.evaluator.definition } : {}),
  });
  return { agentBindings, providers };
};

/** The sink is bus-subscribed from construction, so every exit before the runner owns it must stop it. */
const buildProvidersAndElementOrStopLog = async (
  ctx: LaunchContext,
  chainLog: ChainLogHandle,
  args: Omit<Parameters<typeof buildImplementElement>[1], 'providers' | 'agentBindings'>
): Promise<
  Result<
    { readonly providers: ReturnType<typeof buildImplementProviders>; readonly element: Element<ImplementCtx> },
    LaunchResult
  >
> => {
  try {
    const { agentBindings, providers } = await resolveImplementAgentBindingsAndProviders(
      ctx.deps,
      args.implementPair,
      args.effectiveSettings
    );
    const elementResult = buildImplementElementOrFailure(ctx, { ...args, providers, agentBindings });
    if (!elementResult.ok) {
      stopChainLog(chainLog);
      return Result.error(elementResult.error);
    }
    return Result.ok({ providers, element: elementResult.value });
  } catch (cause) {
    stopChainLog(chainLog);
    throw cause;
  }
};

export const launchImplement = async (ctx: LaunchContext): Promise<LaunchResult> => {
  const { deps, snapshot, extras, settings, bridge, sessionId } = ctx;
  // Apply per-role overrides (from CLI flags via `LaunchExtras.implementRoleOverrides`) onto a settings copy before
  // either readiness probing or provider construction.
  const implementPair = applyImplementRoleOverrides(settings.ai.implement, extras.implementRoleOverrides);
  const effectiveSettings: Settings = {
    ...settings,
    ai: { ...settings.ai, implement: implementPair },
  };
  const missing = await preflightCli(ctx, effectiveSettings);
  if (missing !== undefined) return missing;
  if (!snapshot.sprint) return { ok: false, reason: 'No sprint selected.' };
  if (!snapshot.project) return { ok: false, reason: 'No project loaded for the selected sprint.' };
  if (snapshot.project.repositories.length === 0) {
    return { ok: false, reason: 'Project has no repositories — add one first.' };
  }
  const queue = await resolveQueueForLaunch(deps, snapshot.project, snapshot.sprint, snapshot.tasks);
  if (!queue.ok) return { ok: false, reason: queue.error };
  const todoTasks = queue.value;
  if (todoTasks.length === 0) return { ok: false, reason: 'No tasks to implement or resume.' };
  const sprintPaths = resolveImplementSprintPaths(deps.storage.dataRoot, snapshot.sprint);
  if (!sprintPaths.ok) return { ok: false, reason: sprintPaths.error };
  const { sprintDirPath, progressPath, eventsNdjsonPath } = sprintPaths.value;

  // Tee every AppEvent on the bus to <sprintDir>/events.ndjson for postmortem debugging. Stopped when the runner
  // exits (success or fail) — wired below via `wireChainLogStop`.
  const chainLog = deps.app.chainLogSink({ file: eventsNdjsonPath, bus: deps.app.eventBus });

  // Flow-wide publisher for the serial path — every gen-eval turn's signal publishes onto the application bus as a
  // typed `ai-signal` event with `source: 'implement'`.
  const publishSignal = createPublishSignal(deps.app.eventBus, 'implement');
  const built = await buildProvidersAndElementOrStopLog(ctx, chainLog, {
    effectiveSettings,
    implementPair,
    publishSignal,
    sprint: snapshot.sprint,
    project: snapshot.project,
    todoTasks,
    allTasks: snapshot.tasks,
    progressPath,
    sprintDirPath,
  });
  if (!built.ok) return built.error;
  const { providers, element } = built.value;
  const { generatorModel, evaluatorModel, generatorEffort, evaluatorEffort } = providers;

  const runner = createRunner<ImplementCtx>({
    id: sessionId(),
    element,
    initialCtx: { sprintId: snapshot.sprint.id },
  });
  wireChainLogStop(runner, chainLog);

  const taskNames = new Map<string, string>(todoTasks.map((t) => [String(t.id), t.name]));
  const taskRecovering = computeTaskRecovering(todoTasks, deps.app.clock());
  // Providers are drawn from the post-merge implementPair, and the models from `providers` (which already carry a
  // bound definition's override — see `buildImplementProviders`).
  const generatorProviderId = implementPair.generator.provider;
  const evaluatorProviderId = implementPair.evaluator.provider;
  return {
    ok: true,
    runner: bridge(runner) as Runner<unknown>,
    title: `Implement — ${snapshot.sprint.name}`,
    taskNames,
    maxTurns: settings.harness.maxTurns,
    maxAttempts: settings.harness.maxAttempts,
    terminalSubstepName: IMPLEMENT_TASK_TERMINAL_LEAF,
    ...(taskRecovering.size > 0 ? { taskRecovering } : {}),
    generatorModel,
    evaluatorModel,
    generatorProvider: generatorProviderId,
    evaluatorProvider: evaluatorProviderId,
    ...(generatorEffort !== undefined ? { generatorEffort } : {}),
    ...(evaluatorEffort !== undefined ? { evaluatorEffort } : {}),
  };
};
