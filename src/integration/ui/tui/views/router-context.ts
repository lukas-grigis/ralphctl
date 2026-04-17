/**
 * Router context — exposes navigation API to descendants.
 *
 * Views call `useRouter()` to push, pop, or replace stack entries instead of
 * managing their own modes. The router itself owns the actual stack state
 * (see `view-router.tsx`); this module is just the React glue so that any
 * deeply-nested component can navigate without prop-drilling.
 *
 * Kept in its own file (no React tree) so that the router component module
 * doesn't end up with a circular import when child views import the hook.
 */

import { createContext, useContext } from 'react';

/**
 * View identifiers — every screen the router can mount.
 *
 * Add a new ID when you introduce a new top-level view. The router maps each
 * ID to a concrete component in `views.ts`.
 *
 * Phase IDs (`refine-phase`, `plan-phase`, `close-phase`) are the drill-in
 * destinations from Home's pipeline map. The execute phase deliberately
 * reuses the existing `execute` destination — `ExecuteView` already has the
 * task grid, log tail, rate-limit banner and live SignalBus subscription
 * that a dedicated execute-phase view would otherwise duplicate.
 */
export type ViewId =
  | 'home'
  | 'onboarding'
  | 'settings'
  | 'execute'
  | 'dashboard'
  | 'refine-phase'
  | 'plan-phase'
  | 'close-phase'
  // Sprint workflow destinations (M2).
  | 'sprint-create'
  | 'sprint-delete'
  | 'sprint-reactivate'
  | 'sprint-set-current'
  | 'sprint-requirements-export'
  | 'sprint-context-export'
  // Ticket workflow destinations (M3).
  | 'ticket-add'
  | 'ticket-edit'
  | 'ticket-remove'
  | 'ticket-refine'
  // Task workflow destinations (M4).
  | 'task-add'
  | 'task-import'
  | 'task-status'
  | 'task-reorder'
  | 'task-remove'
  | 'task-next'
  // Project workflow destinations (M5).
  | 'project-add'
  | 'project-remove'
  | 'project-repo-add'
  | 'project-repo-remove'
  | 'project-edit'
  // Browse list + detail destinations (M6).
  | 'sprint-list'
  | 'sprint-show'
  | 'ticket-list'
  | 'ticket-show'
  | 'task-list'
  | 'task-show'
  | 'project-list'
  | 'project-show'
  // Doctor / progress (M7).
  | 'doctor'
  | 'progress-log'
  | 'progress-show'
  // Ideate pipeline wrapper (M8).
  | 'ideate'
  // Per-sprint evaluator / feedback surfaces.
  | 'evaluations'
  | 'evaluation-show'
  | 'feedback';

/**
 * One frame on the navigation stack. Optional `props` are passed through to
 * the view component (typed loosely on purpose — view-specific props are
 * narrowed by the consuming component).
 */
export interface ViewEntry {
  readonly id: ViewId;
  readonly props?: Readonly<Record<string, unknown>>;
}

/**
 * Navigation API exposed via React context. Stable identity per router mount.
 */
export interface RouterApi {
  readonly current: ViewEntry;
  readonly stack: readonly ViewEntry[];
  push(entry: ViewEntry): void;
  pop(): void;
  replace(entry: ViewEntry): void;
  /** Reset the stack to a single entry — used by the `h` hotkey to "go home". */
  reset(entry: ViewEntry): void;
}

const RouterContext = createContext<RouterApi | null>(null);

export const RouterProvider = RouterContext.Provider;

export function useRouter(): RouterApi {
  const api = useContext(RouterContext);
  if (api === null) {
    throw new Error('useRouter() called outside of <ViewRouter />');
  }
  return api;
}
