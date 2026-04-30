/**
 * Singleton accessor for the application's `SharedDeps` graph.
 *
 *  - `getSharedDeps()` lazily builds the graph the first time it's called.
 *  - `setSharedDeps(deps)` swaps the cached value — used by the Ink mount
 *    path so the second pass reuses the Ink-aware sinks/buses.
 *  - `resetSharedDeps()` clears the cache. Test-only — guarantees each
 *    `it` block starts from scratch.
 *
 * The cache is process-scoped. There is no per-request scoping; the
 * graph is essentially long-lived runtime state.
 */
import { createSharedDeps, type SharedDeps, type SharedDepsOverrides } from './shared-deps.ts';

let cached: SharedDeps | null = null;
let pending: Promise<SharedDeps> | null = null;

/** Resolve the shared graph, building it on first access. */
export async function getSharedDeps(overrides?: SharedDepsOverrides): Promise<SharedDeps> {
  if (cached) return cached;
  if (pending) return pending;
  pending = createSharedDeps(overrides).then((deps) => {
    cached = deps;
    pending = null;
    return deps;
  });
  return pending;
}

/** Replace the cached graph. The caller owns the lifecycle of `deps`. */
export function setSharedDeps(deps: SharedDeps): void {
  cached = deps;
  pending = null;
}

/** Drop the cached graph. Test-only — call inside `afterEach`. */
export function resetSharedDeps(): void {
  cached = null;
  pending = null;
}

/**
 * Convenience accessor for the interactive prompt port.
 * Equivalent to `(await getSharedDeps()).prompt`.
 */
export async function getPrompt(): Promise<import('../../business/ports/prompt-port.ts').PromptPort> {
  return (await getSharedDeps()).prompt;
}
