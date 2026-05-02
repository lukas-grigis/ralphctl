/**
 * Keyed FIFO mutex.
 *
 * Each unique key has its own independent FIFO queue: holders of different
 * keys never block each other. Within a single key, `acquire()` returns a
 * release function; the next waiter is admitted only after `release()` runs.
 *
 * Used by the executor to serialize tasks that touch the same `projectPath`
 * (a per-repo working tree must not have two parallel agents stomping on it),
 * while letting tasks targeting different repos run concurrently.
 *
 * Abort behaviour: passing an aborted signal to `acquire()` rejects
 * immediately. Aborting a signal while the caller is queued cleanly removes
 * that waiter from the queue without disturbing FIFO order for the others.
 *
 * Re-entrancy: `release()` is idempotent — calling it more than once is a
 * no-op. This makes it safe to wire into try/finally without tracking
 * "already released" state at the call site.
 */
export class MutexQueue<TKey> {
  private readonly heads = new Map<TKey, boolean>();
  private readonly waiters = new Map<TKey, QueueEntry[]>();

  /**
   * Acquire the mutex for `key`. Resolves with a release function once this
   * caller is the head of its queue. The release function is idempotent.
   */
  public acquire(key: TKey, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) {
      // `AbortSignal.reason` is `unknown` by the platform spec — callers may
      // pass plain strings to `controller.abort('reason')`. Forward the
      // user's value verbatim rather than rewrapping; tests rely on
      // `.rejects.toBe('cancel-me')`. abortReason() guarantees the value is
      // never `undefined`.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(this.abortReason(signal));
    }

    if (!this.heads.get(key)) {
      this.heads.set(key, true);
      return Promise.resolve(this.makeRelease(key));
    }

    return new Promise<() => void>((resolve, reject) => {
      let queue = this.waiters.get(key);
      if (!queue) {
        queue = [];
        this.waiters.set(key, queue);
      }

      const entry: QueueEntry = {
        resolve: () => {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve(this.makeRelease(key));
        },
        cancel: () => {
          if (signal) signal.removeEventListener('abort', onAbort);
        },
      };

      const onAbort = (): void => {
        // Remove ourselves from the queue without disturbing the others.
        const list = this.waiters.get(key);
        if (list) {
          const idx = list.indexOf(entry);
          if (idx >= 0) list.splice(idx, 1);
          if (list.length === 0) this.waiters.delete(key);
        }
        entry.cancel();
        // See acquire() — forwarding the platform-supplied abort reason.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(this.abortReason(signal));
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      queue.push(entry);
    });
  }

  /**
   * Pending count for `key` — includes the current holder (if any) plus
   * everyone in the queue. Used by tests and by callers wanting backpressure
   * visibility.
   */
  public size(key: TKey): number {
    const holder = this.heads.get(key) ? 1 : 0;
    const queued = this.waiters.get(key)?.length ?? 0;
    return holder + queued;
  }

  private makeRelease(key: TKey): () => void {
    let released = false;
    return () => {
      // Idempotent: callers can wire this into try/finally without worrying
      // about double-release.
      if (released) return;
      released = true;

      const queue = this.waiters.get(key);
      if (queue && queue.length > 0) {
        const next = queue.shift();
        if (queue.length === 0) this.waiters.delete(key);
        if (next) {
          // Hand the lock straight to the next waiter — heads stays true.
          next.resolve();
          return;
        }
      }
      this.heads.delete(key);
    };
  }

  private abortReason(signal?: AbortSignal): unknown {
    // `signal.reason` is `unknown` by the platform spec — surface it
    // verbatim. Fall back to a synthetic AbortError-shaped DOMException
    // when no reason was set so the rejection always carries something
    // informative.
    if (signal?.reason !== undefined) return signal.reason;
    return new DOMException('Aborted', 'AbortError');
  }
}

interface QueueEntry {
  readonly resolve: () => void;
  readonly cancel: () => void;
}
