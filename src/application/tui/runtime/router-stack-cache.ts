/**
 * Module-level cache of the router's navigation stack.
 *
 * Why this exists: when an interactive AI session runs (refine / plan
 * / ideate), `runInteractive` flips a global flag that makes the
 * top-level App component return `null` so Ink stops painting while
 * Claude owns the terminal. Returning `null` unmounts the entire view
 * tree — including ViewRouter — and the back-stack `useState` inside
 * ViewRouter dies with it. When the AI session exits and App re-renders,
 * a fresh ViewRouter mounts with its `initialStack` prop (set at
 * mount time), and the user lands wherever they were when ralphctl
 * STARTED, not where they were when Claude took over.
 *
 * Persisting the stack outside React's lifecycle survives the
 * unmount/remount cycle. Module-level state is fine here: there's
 * exactly one Ink app per process, and on real exit the process dies
 * and the module is gone.
 *
 * Contract:
 *  - `getCachedStack()` — null when nothing's been cached (first
 *    launch, or after an explicit clear). The router uses this to
 *    decide whether to fall back to `initialStack`.
 *  - `setCachedStack(s)` — called by ViewRouter on every state change
 *    to mirror its `stack` here.
 *  - `clearCachedStack()` — used by tests to isolate cases. Production
 *    code never needs this; the process exit drops the cache.
 */
import type { ViewEntry } from '@src/application/tui/views/router-context.ts';

let cached: readonly ViewEntry[] | null = null;

export function getCachedStack(): readonly ViewEntry[] | null {
  return cached;
}

export function setCachedStack(stack: readonly ViewEntry[]): void {
  cached = stack;
}

export function clearCachedStack(): void {
  cached = null;
}
