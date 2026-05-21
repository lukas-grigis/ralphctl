---
name: home-view pipeline-map architecture
description: HomeView uses pipeline-map as spine + tiered browse submenu; design decisions locked Apr 2026
type: project
---

Home screen uses a pipeline-map based layout, not a flat menu.

**Why:** Flat menu was unordered and gave no lifecycle context. Pipeline map makes sprint phase visible.

**How to apply:** When extending home, use the pipeline-map action/drillIn callbacks, not a flat list. Check current imports in `src/application/ui/tui/views/home-view.tsx` for actual file names before assuming helper file locations — several planned helpers (menu-builder.ts, home-submenu-memory.ts, sprint-summary-line.tsx) were not extracted into separate files.

## Entry value conventions in submenus

- `action:<group>:<sub>` — dispatch directly (router push or chain launch)
- `group:<name>` — drill into named submenu
- `back` — return to parent level

## useRouterOptional() in browse views

List views and show views use `useRouterOptional()` (not `useRouter()`) so they degrade gracefully when rendered in tests without a RouterProvider. All router pushes use `router?.push(...)`.

## Keyboard shortcuts

All lookups use `getKeyFor(action)` from `keyboard-map.ts` — no hardcoded letters in view files.
