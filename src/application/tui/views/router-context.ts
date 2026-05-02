/**
 * Router context — exposes navigation API to descendants.
 *
 * Views call `useRouter()` to push, pop, or replace stack entries instead of
 * managing their own modes. The router itself owns the actual stack state
 * (see `view-router.tsx`).
 */

import { createContext, useContext } from 'react';

/**
 * View identifiers — every screen the router can mount.
 *
 * Foundation views (Phase 1):
 *   home, settings, dashboard, execute, sessions
 *
 * Browse + CRUD form views are added in the follow-up task.
 */
export type ViewId =
  | 'home'
  | 'settings'
  | 'dashboard'
  | 'execute'
  | 'sessions'
  // Sprint workflow destinations.
  | 'sprint-create'
  | 'sprint-edit'
  | 'sprint-set-current'
  | 'sprint-activate'
  | 'sprint-close'
  | 'sprint-remove'
  | 'sprint-list'
  | 'sprint-show'
  // Ticket workflow destinations.
  | 'ticket-add'
  | 'ticket-edit'
  | 'ticket-approve'
  | 'ticket-remove'
  | 'ticket-list'
  // Task workflow destinations.
  | 'task-add'
  | 'task-edit'
  | 'task-edit-status'
  | 'task-remove'
  | 'task-list'
  // Project workflow destinations.
  | 'project-add'
  | 'project-edit'
  | 'project-remove'
  | 'project-repo-add'
  | 'project-repo-remove'
  | 'project-list'
  | 'project-show'
  // System views.
  | 'doctor'
  // Sprint progress + diagnostics.
  | 'progress'
  // Sprint exports (requirements + harness context).
  | 'sprint-export-requirements'
  | 'sprint-export-context';

/**
 * One frame on the navigation stack. Optional `props` are passed through to
 * the view component (typed loosely — view-specific props are narrowed by
 * the consuming component).
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

/**
 * Non-throwing variant for hooks that must degrade gracefully when rendered
 * outside a `<ViewRouter />` — e.g. view unit tests that exercise a single
 * view component in isolation.
 */
export function useRouterOptional(): RouterApi | null {
  return useContext(RouterContext);
}
