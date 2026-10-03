/** Shared wrapper for sprint-bound flow launches. */

import type { Runner } from '@src/application/chain/run/runner.ts';
import type { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { SprintStatus } from '@src/domain/entity/sprint.ts';
import type { AppStateSnapshot } from '@src/application/ui/shared/state-snapshot.ts';
import {
  type LauncherDeps,
  type LaunchExtras,
  launchFlow,
  type LaunchResult,
} from '@src/application/ui/shared/launcher.ts';

/**
 * Minimal shape every sprint-bound chain's terminal ctx exposes. `sprint` is preferred — it carries the canonical
 * name and status.
 */
interface SprintBoundCtx {
  readonly sprint?: { readonly id: SprintId; readonly name: string; readonly status?: SprintStatus };
  readonly sprintId?: SprintId;
}

export interface SprintBoundLaunchExtras extends LaunchExtras {
  /** Called when the chain completes with a `sprint` (or `sprintId`) on ctx. */
  readonly onReseat?: (info: { readonly id: SprintId; readonly name: string; readonly status?: SprintStatus }) => void;
  /** Display name to use when ctx surfaces only `sprintId` (no `sprint` object). */
  readonly fallbackLabel?: string;
  /** Called when the sprint's id/name become known — like `onReseat`, but with the runner id so the caller can pin it. */
  readonly onSprintResolved?: (
    runnerId: string,
    info: { readonly id: SprintId; readonly name: string; readonly status?: SprintStatus }
  ) => void;
}

export const launchSprintBoundFlow = async (
  deps: LauncherDeps,
  flowId: string,
  snapshot: AppStateSnapshot,
  extras: SprintBoundLaunchExtras = {}
): Promise<LaunchResult> => {
  const { onReseat, fallbackLabel, onSprintResolved, ...launchExtras } = extras;
  const result = await launchFlow(deps, flowId, snapshot, launchExtras);
  if (!result.ok) return result;
  // Late-subscribe replay makes this race-free with `result.runner.start()` — the caller is
  // free to call `start()` immediately after we return.
  if (onReseat !== undefined || onSprintResolved !== undefined) {
    attachReseatSubscriber(result.runner, fallbackLabel, onReseat, onSprintResolved);
  }
  return result;
};

const attachReseatSubscriber = (
  runner: Runner<unknown>,
  fallbackLabel: string | undefined,
  onReseat:
    ((info: { readonly id: SprintId; readonly name: string; readonly status?: SprintStatus }) => void) | undefined,
  onSprintResolved:
    | ((
        runnerId: string,
        info: { readonly id: SprintId; readonly name: string; readonly status?: SprintStatus }
      ) => void)
    | undefined
): void => {
  // Self-unsubscribe on terminal events so the listener (and the captured closures) don't pin the runner across a
  // long TUI session.
  const unsub: () => void = runner.subscribe((event) => {
    if (event.type === 'failed' || event.type === 'aborted') {
      unsub();
      return;
    }
    if (event.type !== 'completed') return;
    const ctx = event.ctx as SprintBoundCtx;
    const info =
      ctx.sprint !== undefined
        ? {
            id: ctx.sprint.id,
            name: ctx.sprint.name,
            ...(ctx.sprint.status !== undefined ? { status: ctx.sprint.status } : {}),
          }
        : ctx.sprintId !== undefined
          ? { id: ctx.sprintId, name: fallbackLabel ?? String(ctx.sprintId) }
          : undefined;
    if (info !== undefined) {
      onReseat?.(info);
      onSprintResolved?.(runner.id, info);
    }
    unsub();
  });
};
