/**
 * Home submenu memory — per-session in-memory cache of the last selected
 * submenu group so re-opening a submenu from Home lands the cursor on the
 * previous selection.
 *
 * No persistence — clears on process restart. Module-level variable so it
 * survives across renders but not across app restarts.
 */

import type { MenuGroup } from './menu-action.ts';

/** The group currently stored in memory, or null when at the main pipeline view. */
let _group: MenuGroup | null = null;

/**
 * Record that the user navigated to `group` (or cleared back to the main
 * map when `group` is null).
 */
export function setHomeSubmenuMemory(group: MenuGroup | null): void {
  _group = group;
}

/**
 * Retrieve the last stored group, or null if the user was on the main
 * pipeline view.
 */
export function getHomeSubmenuMemory(): MenuGroup | null {
  return _group;
}
