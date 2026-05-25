/**
 * Shared wrapper for sprint-bound flow launches. Every flow whose final ctx carries a
 * `sprint` (or `sprintId`) field is launched through this helper so the post-completion
 * selection reseat happens in one place — not duplicated per call site.
 *
 * Behaviour:
 *  - Delegates to {@link launchFlow} for the actual chain construction.
 *  - On `runner.subscribe('completed')`, reads `ctx.sprint` (preferred — carries the canonical
 *    name) or falls back to `ctx.sprintId` (uses `fallbackLabel` when supplied; otherwise
 *    leaves the label unchanged).
 *  - Notifies the caller via `onReseat({ id, name })` so views can render transient
 *    "✓ now on <sprint-name>" feedback above their menus.
 *  - Does NOT reseat on `aborted` or `failed` events. The user's prior selection stays put;
 *    cancelling a create-sprint flow must not yank them onto an unrelated sprint.
 *
 * Subscription is registered before the caller invokes `runner.start()` — the runner's
 * late-subscriber replay (see runner.ts) makes this race-free even if the chain completes
 * synchronously.
 */

import type { Runner } from '@src/application/chain/run/runner.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import {
  launchFlow,
  type LauncherDeps,
  type LaunchExtras,
  type LaunchResult,
} from '@src/application/ui/shared/launcher.ts';

/**
 * Minimal shape every sprint-bound chain's terminal ctx exposes. `sprint` is preferred —
 * it carries the canonical name. `sprintId` is the fallback for flows that surface only the
 * id post-completion (currently none, but kept resilient).
 */
interface SprintBoundCtx {
  readonly sprint?: { readonly id: SprintId; readonly name: string };
  readonly sprintId?: SprintId;
}

export interface SprintBoundLaunchExtras extends LaunchExtras {
  /**
   * Called when the chain completes with a `sprint` (or `sprintId`) on ctx. The caller wires
   * this to `selection.setSprint(id, name)` AND any transient-feedback state — both happen in
   * one place so the UI never shows the reseat without the toast.
   */
  readonly onReseat?: (info: { readonly id: SprintId; readonly name: string }) => void;
  /**
   * Display name to use when ctx surfaces only `sprintId` (no `sprint` object). Defaults to
   * `String(id)`; callers that have a friendlier label (e.g. the snapshot's sprint name)
   * should pass it.
   */
  readonly fallbackLabel?: string;
}

export const launchSprintBoundFlow = async (
  deps: LauncherDeps,
  flowId: string,
  snapshot: AppStateSnapshot,
  extras: SprintBoundLaunchExtras = {}
): Promise<LaunchResult> => {
  const { onReseat, fallbackLabel, ...launchExtras } = extras;
  const result = await launchFlow(deps, flowId, snapshot, launchExtras);
  if (!result.ok) return result;
  // Late-subscribe replay makes this race-free with `result.runner.start()` — the caller is
  // free to call `start()` immediately after we return.
  if (onReseat !== undefined) {
    attachReseatSubscriber(result.runner, fallbackLabel, onReseat);
  }
  return result;
};

const attachReseatSubscriber = (
  runner: Runner<unknown>,
  fallbackLabel: string | undefined,
  onReseat: (info: { readonly id: SprintId; readonly name: string }) => void
): void => {
  // Self-unsubscribe on terminal events so the listener (and the captured `onReseat`
  // closure) doesn't pin the runner across a long TUI session — historically a load-bearing
  // OOM contributor for sprint-bound flows that get re-launched repeatedly.
  const unsub: () => void = runner.subscribe((event) => {
    if (event.type === 'failed' || event.type === 'aborted') {
      unsub();
      return;
    }
    if (event.type !== 'completed') return;
    const ctx = event.ctx as SprintBoundCtx;
    if (ctx.sprint !== undefined) {
      onReseat({ id: ctx.sprint.id, name: ctx.sprint.name });
    } else if (ctx.sprintId !== undefined) {
      onReseat({ id: ctx.sprintId, name: fallbackLabel ?? String(ctx.sprintId) });
    }
    unsub();
  });
};
