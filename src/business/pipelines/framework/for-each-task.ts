/**
 * `forEachTask` — dynamic per-item scheduling primitive.
 *
 * Items are pulled fresh on every scheduling tick, so items appearing
 * mid-run (e.g. tasks whose dependencies just cleared) are picked up
 * automatically — no fixed input list.
 *
 * This primitive encapsulates the worker-pool + rate-limit + mutex-key +
 * retry-policy logic that previously lived inside
 * `ExecuteTasksUseCase.executeParallel`. Lifting it into the framework
 * means the execute pipeline's declaration stays code-first and the
 * scheduler's invariants are enforced by a small, heavily tested core.
 *
 * Responsibilities:
 *   - Pull items each tick; filter by mutex-key availability.
 *   - Launch up to `concurrency` inner pipelines concurrently.
 *   - Apply a caller-supplied `retryPolicy` to failures:
 *       `retry-now` / `requeue` / `pause-all` / `skip-repo` / `fail`.
 *   - Pause the shared `RateLimitCoordinator` on `pause-all`.
 *   - Call `between` between settlements for step-mode gates.
 *   - Always run `disposeServices` in a `finally`.
 *
 * Non-responsibilities (intentionally left to callers):
 *   - Persistence — callers project settlements into durable state
 *     themselves (inside the inner pipeline or in `onSettle`).
 *   - Exit-code mapping — the primitive only returns `Result.ok` with
 *     `schedulerStats` or `Result.error` when `fail` fires.
 */

import type { StepContext } from '@src/domain/context.ts';
import { DomainError, StepError } from '@src/domain/errors.ts';
import type { RateLimitCoordinatorPort } from '@src/business/ports/rate-limit-coordinator.ts';
import type { HarnessEvent, SignalBusPort, Unsubscribe } from '@src/business/ports/signal-bus.ts';
import type { DomainResult } from '@src/domain/types.ts';
import { Result } from '@src/domain/types.ts';
import { executePipeline } from './pipeline.ts';
import type { ParallelSharedServices, PipelineDefinition, PipelineStep } from './types.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Running counters exposed to `stopWhen` / `between` hooks and returned via context. */
export interface SchedulerStats {
  completed: number;
  failed: number;
  requeued: number;
  inFlight: number;
  pausedRepos: Set<string>;
}

export type RetryAction =
  /** Relaunch same item immediately (no re-pull). */
  | { action: 'retry-now' }
  /** Put back on the queue — next `pullItems` tick will pick it up. */
  | { action: 'requeue'; delayMs?: number }
  /** Pause scheduler globally (coordinator). Optionally requeue the failing item. */
  | { action: 'pause-all'; delayMs: number; requeueItem: boolean }
  /** Block further items sharing this mutex key. */
  | { action: 'skip-repo'; key: string }
  /** Stop scheduling; optionally drain in-flight before returning. */
  | { action: 'fail'; drainInFlight: boolean };

/** Strategy for scheduling inner pipelines. */
interface ForEachTaskStrategy<TItem> {
  /** 1 = sequential; N = parallel pool; 'auto' = one per unique mutex key (capped). */
  concurrency: number | 'auto';
  /** Hard upper bound on concurrency (default: 10). */
  maxConcurrency?: number;
  /** Pull items fresh each tick — lets new items appear as dependencies clear. */
  pullItems: (ctx: StepContext) => Promise<TItem[]> | TItem[];
  /** Mutex key — items with the same key never run concurrently. */
  mutexKey?: (item: TItem) => string;
  /** Stop when true. If omitted, stops when no items left and none in-flight. */
  stopWhen?: (stats: SchedulerStats) => boolean;
}

/** Policy for handling item failures + lifecycle hooks. */
interface ForEachTaskPolicies<TItem> {
  /** What to do when an item's pipeline fails with a given error. */
  retryPolicy: (item: TItem, error: DomainError, attempt: number) => RetryAction;
  /** Called between item settlements — e.g. step-mode's "Continue?" prompt. */
  between?: (stats: SchedulerStats) => Promise<'continue' | 'stop'> | 'continue' | 'stop';
  /** Called when the scheduler pauses (e.g. rate limit). */
  onPause?: (delayMs: number) => void;
  /** Called when the scheduler resumes from a pause. */
  onResume?: () => void;
  /** Called before launching each item. */
  onLaunch?: (item: TItem) => void;
  /** Called after each item settles. */
  onSettle?: (item: TItem, result: 'success' | 'failed' | 'skipped') => void;
}

interface ForEachTaskOptions<TItem, TInnerCtx extends StepContext = StepContext> {
  /**
   * Sub-pipeline run per-item. Receives the outer ctx plus `[itemKey]: TItem`.
   *
   * `TInnerCtx` lets callers declare the per-item context shape — e.g. the
   * execute pipeline passes `PipelineDefinition<PerTaskContext>` so the
   * per-task steps see `task` / `sprint` directly without casting. The
   * runtime contract is that the outer ctx must already carry every field
   * `TInnerCtx` requires beyond `[itemKey]: TItem`.
   */
  steps: PipelineDefinition<TInnerCtx>;
  strategy: ForEachTaskStrategy<TItem>;
  policies: ForEachTaskPolicies<TItem>;
  /** Context key for the injected item. Default: `'task'`. */
  itemKey?: string;
  /** Shared services for the lifetime of this step. */
  createServices?: () => ParallelSharedServices;
  disposeServices?: (services: ParallelSharedServices) => void;
}

/**
 * Context shape augmentation produced by `forEachTask`. The returned step
 * writes `schedulerStats` to the outer context.
 */
export interface ForEachTaskContext extends StepContext {
  schedulerStats?: SchedulerStats;
}

// ---------------------------------------------------------------------------
// Primitive
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCURRENCY = 10;
const DEFAULT_ITEM_KEY = 'task';

/** The primitive. Returns a `PipelineStep` that runs `opts.steps` for each pulled item. */
export function forEachTask<TItem, TInnerCtx extends StepContext = StepContext>(
  opts: ForEachTaskOptions<TItem, TInnerCtx>
): PipelineStep {
  const name = opts.steps.name;

  return {
    name: `for-each-task:${name}`,
    execute: (ctx: ForEachTaskContext) => runScheduler<TItem, TInnerCtx>(opts, ctx),
  };
}

// ---------------------------------------------------------------------------
// Scheduler implementation
// ---------------------------------------------------------------------------

interface SchedulerState<TItem> {
  stats: SchedulerStats;
  retryNowQueue: TItem[];
  requeueQueue: TItem[];
  attempts: Map<TItem, number>;
  inFlightKeys: Set<string>;
  inFlight: Map<TItem, Promise<SettlementEnvelope<TItem>>>;
  terminalError: DomainError | null;
  shouldDrainOnFail: boolean;
  stopRequested: boolean;
}

interface SettlementEnvelope<TItem> {
  item: TItem;
  error: DomainError | null;
}

async function runScheduler<TItem, TInnerCtx extends StepContext>(
  opts: ForEachTaskOptions<TItem, TInnerCtx>,
  ctx: StepContext
): Promise<DomainResult<Partial<ForEachTaskContext>>> {
  const itemKey = opts.itemKey ?? DEFAULT_ITEM_KEY;
  const maxConcurrency = opts.strategy.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const mutexKeyFn = opts.strategy.mutexKey ?? identityMutexKey;
  const services = opts.createServices?.() ?? defaultServices();

  const state: SchedulerState<TItem> = {
    stats: {
      completed: 0,
      failed: 0,
      requeued: 0,
      inFlight: 0,
      pausedRepos: new Set<string>(),
    },
    retryNowQueue: [],
    requeueQueue: [],
    attempts: new Map<TItem, number>(),
    inFlightKeys: new Set<string>(),
    inFlight: new Map<TItem, Promise<SettlementEnvelope<TItem>>>(),
    terminalError: null,
    shouldDrainOnFail: false,
    stopRequested: false,
  };

  let concurrencyLimit = -1; // resolved on first tick

  try {
    // Scheduling loop. At each iteration we either launch more items or
    // block on Promise.race for an in-flight item to settle. We exit when
    // nothing is pullable and nothing is running, when `stopWhen` fires,
    // when `between` returns 'stop', or when `fail` sets `terminalError`.
    for (;;) {
      if (state.stopRequested) break;
      if (state.terminalError) break;
      if (opts.strategy.stopWhen?.(state.stats)) break;

      // Respect coordinator pauses — fire onResume once the wait returns.
      if (services.coordinator.isPaused) {
        await services.coordinator.waitIfPaused();
        opts.policies.onResume?.();
      }

      // Pull items fresh; retry-now and requeue have priority ordering.
      const pulled = await opts.strategy.pullItems(ctx);
      const available: TItem[] = [...state.retryNowQueue, ...state.requeueQueue, ...pulled];
      state.retryNowQueue.length = 0;
      state.requeueQueue.length = 0;

      if (concurrencyLimit < 0) {
        concurrencyLimit = resolveConcurrency(opts.strategy.concurrency, available, mutexKeyFn, maxConcurrency);
      }

      const launchable = selectLaunchable(available, mutexKeyFn, state.inFlightKeys, state.stats.pausedRepos);

      while (state.inFlight.size < concurrencyLimit && launchable.length > 0) {
        const item = launchable.shift() as TItem;
        launchItem<TItem, TInnerCtx>(item, opts, ctx, mutexKeyFn, itemKey, state);
      }

      if (state.inFlight.size === 0) break;

      const envelope = await Promise.race(state.inFlight.values());
      const { item, error } = envelope;
      state.inFlight.delete(item);
      state.inFlightKeys.delete(mutexKeyFn(item));
      state.stats.inFlight = state.inFlight.size;

      if (error === null) {
        state.stats.completed++;
        opts.policies.onSettle?.(item, 'success');

        // `between` fires after every non-last successful settlement.
        // Because the item queue is dynamic we probe for more work by
        // checking in-flight + queued + pulling once more.
        if (opts.policies.between && !opts.strategy.stopWhen?.(state.stats)) {
          const hasMore = await hasMoreWork(ctx, opts, state);
          if (hasMore) {
            const verdict = await opts.policies.between(state.stats);
            if (verdict === 'stop') {
              state.stopRequested = true;
            }
          }
        }
        continue;
      }

      // Error path — delegate to retryPolicy.
      const attempt = (state.attempts.get(item) ?? 0) + 1;
      state.attempts.set(item, attempt);
      const action = opts.policies.retryPolicy(item, error, attempt);
      applyRetryAction(action, item, error, services, opts.policies, state);
    }

    // Drain in-flight if `fail` with `drainInFlight: true` fired.
    if (state.terminalError && state.shouldDrainOnFail && state.inFlight.size > 0) {
      await Promise.allSettled(state.inFlight.values());
    }
  } finally {
    if (opts.disposeServices) {
      opts.disposeServices(services);
    } else {
      services.coordinator.dispose();
      services.signalBus.dispose();
    }
  }

  if (state.terminalError) {
    return Result.error(state.terminalError);
  }

  const output: Partial<ForEachTaskContext> = { schedulerStats: state.stats };
  return Result.ok(output);
}

// ---------------------------------------------------------------------------
// Launch + settlement
// ---------------------------------------------------------------------------

function launchItem<TItem, TInnerCtx extends StepContext>(
  item: TItem,
  opts: ForEachTaskOptions<TItem, TInnerCtx>,
  outerCtx: StepContext,
  mutexKeyFn: (item: TItem) => string,
  itemKey: string,
  state: SchedulerState<TItem>
): void {
  state.inFlightKeys.add(mutexKeyFn(item));
  state.stats.inFlight = state.inFlight.size + 1;
  opts.policies.onLaunch?.(item);

  // Callers read the injected item via `ctx[itemKey]`. Shared services
  // (rate-limit coordinator, signal bus) are owned by the scheduler and
  // injected into per-item steps through their own `deps` closure — they
  // are not exposed on the context. The runtime contract is that
  // `outerCtx` already carries every field `TInnerCtx` requires beyond
  // `[itemKey]: TItem` — the cast bridges the structural gap.
  const innerCtx = {
    ...outerCtx,
    [itemKey]: item,
  } as unknown as TInnerCtx;

  const promise = runItem(opts.steps, innerCtx).then(
    (settlement): SettlementEnvelope<TItem> => ({ item, error: settlement.error })
  );
  state.inFlight.set(item, promise);
}

interface ItemSettlement {
  error: DomainError | null;
}

async function runItem<TInnerCtx extends StepContext>(
  steps: PipelineDefinition<TInnerCtx>,
  ctx: TInnerCtx
): Promise<ItemSettlement> {
  try {
    const result = await executePipeline(steps, ctx);
    if (result.ok) return { error: null };
    return { error: result.error };
  } catch (err) {
    const wrapped =
      err instanceof DomainError
        ? err
        : new StepError(
            `Unexpected error in forEachTask item: ${err instanceof Error ? err.message : String(err)}`,
            steps.name,
            err instanceof Error ? err : undefined
          );
    return { error: wrapped };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function resolveConcurrency<TItem>(
  concurrency: number | 'auto',
  firstTickItems: TItem[],
  mutexKeyFn: (item: TItem) => string,
  maxConcurrency: number
): number {
  if (concurrency === 'auto') {
    const uniqueKeys = new Set(firstTickItems.map(mutexKeyFn));
    // Floor of 1 so the scheduler still makes progress on an empty first
    // tick (items might appear later from pullItems).
    return Math.max(1, Math.min(uniqueKeys.size || 1, maxConcurrency));
  }
  return Math.max(1, Math.min(concurrency, maxConcurrency));
}

function selectLaunchable<TItem>(
  available: TItem[],
  mutexKeyFn: (item: TItem) => string,
  inFlightKeys: Set<string>,
  pausedKeys: Set<string>
): TItem[] {
  const picked: TItem[] = [];
  const takenKeys = new Set<string>();
  for (const item of available) {
    const key = mutexKeyFn(item);
    if (inFlightKeys.has(key)) continue;
    if (pausedKeys.has(key)) continue;
    if (takenKeys.has(key)) continue; // dedupe within a tick
    takenKeys.add(key);
    picked.push(item);
  }
  return picked;
}

async function hasMoreWork<TItem, TInnerCtx extends StepContext>(
  ctx: StepContext,
  opts: ForEachTaskOptions<TItem, TInnerCtx>,
  state: SchedulerState<TItem>
): Promise<boolean> {
  if (state.inFlight.size > 0) return true;
  if (state.retryNowQueue.length > 0) return true;
  if (state.requeueQueue.length > 0) return true;
  // Probe pullItems without buffering — this is an extra call per
  // between-check, but it keeps pull semantics pure (no surprise
  // stashing). Callers whose `pullItems` is expensive should cache
  // externally.
  const pulled = await opts.strategy.pullItems(ctx);
  return pulled.length > 0;
}

function applyRetryAction<TItem>(
  action: RetryAction,
  item: TItem,
  error: DomainError,
  services: ParallelSharedServices,
  policies: ForEachTaskPolicies<TItem>,
  state: SchedulerState<TItem>
): void {
  switch (action.action) {
    case 'retry-now': {
      state.retryNowQueue.push(item);
      policies.onSettle?.(item, 'failed');
      return;
    }
    case 'requeue': {
      state.requeueQueue.push(item);
      state.stats.requeued++;
      policies.onSettle?.(item, 'failed');
      // `delayMs` is advisory — we don't block the loop. Callers that
      // actually need a cooldown should use `pause-all`.
      void action.delayMs;
      return;
    }
    case 'pause-all': {
      services.coordinator.pause(action.delayMs);
      policies.onPause?.(action.delayMs);
      if (action.requeueItem) {
        state.requeueQueue.push(item);
        state.stats.requeued++;
      }
      policies.onSettle?.(item, 'failed');
      return;
    }
    case 'skip-repo': {
      state.stats.pausedRepos.add(action.key);
      state.stats.failed++;
      policies.onSettle?.(item, 'failed');
      return;
    }
    case 'fail': {
      state.stats.failed++;
      state.terminalError = error;
      state.shouldDrainOnFail = action.drainInFlight;
      policies.onSettle?.(item, 'failed');
      return;
    }
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Default mutex key (identity-based)
// ---------------------------------------------------------------------------

const identityKeys = new WeakMap<object, string>();
let identityCounter = 0;

function identityMutexKey(item: unknown): string {
  if (item !== null && typeof item === 'object') {
    const existing = identityKeys.get(item);
    if (existing !== undefined) return existing;
    const key = `item:${String(identityCounter++)}`;
    identityKeys.set(item, key);
    return key;
  }
  // Primitives — use their string form. Callers with non-unique primitives
  // MUST provide an explicit mutexKey.
  return `prim:${String(item)}`;
}

// ---------------------------------------------------------------------------
// Default services (noop) — mirrors `helpers.ts`'s fallback so tests and
// callers without an explicit coordinator/bus still work.
// ---------------------------------------------------------------------------

function defaultServices(): ParallelSharedServices {
  return {
    coordinator: new NoopRateLimitCoordinator(),
    signalBus: new NoopSignalBus(),
  };
}

class NoopRateLimitCoordinator implements RateLimitCoordinatorPort {
  readonly isPaused = false;
  readonly remainingMs = 0;
  pause(_delayMs: number): void {
    void _delayMs;
  }
  waitIfPaused(): Promise<void> {
    return Promise.resolve();
  }
  dispose(): void {
    /* noop */
  }
}

class NoopSignalBus implements SignalBusPort {
  emit(_event: HarnessEvent): void {
    void _event;
  }
  subscribe(_listener: (events: readonly HarnessEvent[]) => void): Unsubscribe {
    void _listener;
    return () => {
      /* noop */
    };
  }
  dispose(): void {
    /* noop */
  }
}
