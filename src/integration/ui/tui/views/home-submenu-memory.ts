/**
 * Home submenu memory — a tiny module-level cell that remembers which Home
 * submenu the user was in (browse / sprint / ticket / …) the last time the
 * view was on screen.
 *
 * The router remounts views on every navigation, so without this cell the
 * user would lose context after drilling in and popping back. Typical flow:
 *
 *   home/browse submenu → Enter on "Tickets" → ticket-list view → Esc
 *     → router pops back to home → HomeView remounts → reads this memory
 *     → restores the browse submenu the user came from.
 *
 * Pressing `h` (the "go home" global hotkey) must clear the cell — otherwise
 * the remount would land the user back in the submenu instead of the main
 * pipeline map, which is not what "home" means to the user.
 */

let memory: string | null = null;

export function getHomeSubmenuMemory(): string | null {
  return memory;
}

export function setHomeSubmenuMemory(group: string | null): void {
  memory = group;
}

export function clearHomeSubmenuMemory(): void {
  memory = null;
}
