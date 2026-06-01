import { Result } from '@src/domain/result.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';
import type { Element, ElementResult } from '@src/application/chain/element.ts';
import type { TraceEntry } from '@src/application/chain/trace.ts';
import { combineAbortSignals } from '@src/application/chain/run/combine-signals.ts';
import type { FileLocker } from '@src/integration/io/file-locker.ts';
import { repoLockFile } from '@src/integration/io/lock-paths.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

/**
 * Higher-order element that wraps an inner chain in a repository-level advisory lock. Used
 * by the implement and review chains to serialise whole-flow runs against the same working tree:
 *
 *   ralphctl run repo=A          ralphctl run repo=A          ralphctl run repo=B
 *      ↓                            ↓                            ↓
 *   acquire repo-A.lock          waits for repo-A.lock        acquires repo-B.lock
 *      ↓                            ↓                            ↓
 *   per-task chain runs          per-task chain runs (after)  runs in parallel
 *
 * Lock filename is keyed by a hash of the worktree path (see `repoLockFile`), so two
 * different `Repository` aggregates pointing at the same physical clone still serialise.
 *
 * Failure modes:
 *   - Lock acquisition fails (max retries, contention) → leaf returns
 *     `StorageError({ subCode: 'lock' })` and the chain halts with a clear message.
 *   - Lock-path construction fails (path validation) → same `StorageError`.
 *   - Inner element returns `Result.error` → the lock is still released (the locker's
 *     `withLock` runs its `finally` even when the wrapped function throws).
 */

export interface WithRepoLockOpts {
  readonly fileLocker: FileLocker;
  readonly locksRoot: AbsolutePath;
  readonly worktreePath: AbsolutePath;
  readonly eventBus: EventBus;
}

export const withRepoLock = (opts: WithRepoLockOpts, inner: Element<ImplementCtx>): Element<ImplementCtx> => ({
  name: `with-repo-lock(${inner.name})`,
  // Expose the wrapped chain through the composite-pattern `children` slot so `flattenLeaves`
  // walks into it when the TUI builds its planned-leaf list. Without this the wrapper looked
  // like an opaque single leaf and the Flow-steps panel rendered only "with-repo-lock(…)" —
  // never the real setup / per-task / teardown sequence inside the lock.
  children: [inner],
  async execute(ctx, signal, onTrace): Promise<ElementResult<ImplementCtx>> {
    const lockPath = repoLockFile(opts.locksRoot, opts.worktreePath);
    if (!lockPath.ok) {
      const entry: TraceEntry = {
        elementName: this.name,
        status: 'failed',
        durationMs: 0,
        error: lockPath.error,
      };
      onTrace?.(entry);
      return Result.error({ error: lockPath.error, trace: [entry] });
    }
    const start = performance.now();
    const bannerId = `lock-${String(lockPath.value)}`;
    // Thread the lock-compromised signal into the inner chain (merged with the host abort signal)
    // so a lock lost mid-run tears the chain down as an AbortError instead of mutating the repo
    // a competitor may now own.
    const acquired = await opts.fileLocker.withLock(lockPath.value, async (lockSignal) =>
      inner.execute(ctx, combineAbortSignals(signal, lockSignal), onTrace)
    );
    const durationMs = performance.now() - start;

    if (!acquired.ok) {
      // Surface the lock-contention failure as a warn banner. The chain has already failed
      // (StorageError) and the inner trace records it; the banner is for the operator that
      // missed the error scrollback. `id` is keyed by lock path so concurrent flows on the
      // same repo dedupe rather than stack.
      opts.eventBus.publish({
        type: 'banner-show',
        id: bannerId,
        tier: 'warn',
        message: `Repository lock held by another process — could not acquire after retries`,
        cause: String(lockPath.value),
        at: IsoTimestamp.now(),
      });
      const entry: TraceEntry = {
        elementName: this.name,
        status: 'failed',
        durationMs,
        error: acquired.error,
      };
      onTrace?.(entry);
      return Result.error({ error: acquired.error, trace: [entry] });
    }
    // The locker returns the inner's Result-shaped result directly; bubble it up unchanged so
    // the inner trace surfaces in the parent.
    if (!acquired.value.ok) {
      const wrappedFailure = new StorageError({
        subCode: 'lock',
        message: `with-repo-lock: inner chain failed under ${String(lockPath.value)}`,
      });
      void wrappedFailure;
      return acquired.value;
    }
    return Result.ok(acquired.value.value);
  },
});
