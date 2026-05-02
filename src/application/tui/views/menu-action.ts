/**
 * Typed discriminated union for Home menu / pipeline-map dispatch.
 *
 * Replaces the legacy stringly-typed `action:<group>:<sub>` / `group:<name>` /
 * `back` value strings. The router has typed `ViewId`s and the chain layer
 * has named factories — this is the equivalent on the menu side.
 *
 * Each builder emits a typed `MenuAction`; the dispatcher in `home-view.tsx`
 * switches on `kind` with an exhaustive `_exhaustive: never` check so adding
 * a variant is a compile error if a switch arm is missing.
 */
import type { ViewId } from './router-context.ts';

/** Workflow chains the home view can launch. */
export type ChainFlow = 'refine' | 'plan' | 'ideate' | 'execute' | 'feedback' | 'create-pr' | 'onboard';

/** Submenu groups Home can drill into. */
export type MenuGroup = 'browse' | 'sprint' | 'ticket' | 'task' | 'project';

/**
 * A user-triggered menu action.
 *
 *   - `route`        push a router view directly
 *   - `launchChain`  start a chain session and push the execute view
 *   - `subMenu`      drill into a Home submenu
 *   - `back`         return to the previous menu level
 */
export type MenuAction =
  | { readonly kind: 'route'; readonly viewId: ViewId }
  | { readonly kind: 'launchChain'; readonly flow: ChainFlow }
  | { readonly kind: 'subMenu'; readonly group: MenuGroup }
  | { readonly kind: 'back' };

/**
 * Stable string fingerprint of a `MenuAction` — used for keyed lookup in
 * Map-based caches (e.g. submenu memory) where structural equality is needed
 * but a Map can only key off strings or referentially-stable objects.
 */
export function actionKey(action: MenuAction): string {
  switch (action.kind) {
    case 'route':
      return `route:${action.viewId}`;
    case 'launchChain':
      return `launchChain:${action.flow}`;
    case 'subMenu':
      return `subMenu:${action.group}`;
    case 'back':
      return 'back';
  }
  const _exhaustive: never = action;
  void _exhaustive;
  return '';
}
