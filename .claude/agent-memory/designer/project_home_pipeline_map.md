---
name: home-view pipeline-map architecture
description: HomeView rewritten to use pipeline-map as spine + tiered browse submenu, shipped Apr 2026
type: project
---

Home screen rewritten from flat menu to pipeline-map based layout.

**Why:** Flat menu was unordered and gave no lifecycle context. Pipeline map makes sprint phase visible.

**How to apply:** When extending home, use the pipeline-map action/drillIn callbacks, not a flat list.

## Key files

- `src/application/tui/views/home-view.tsx` — pipeline map + browse submenu + workflow launchers
- `src/application/tui/views/menu-builder.ts` — submenu builders (browse/sprint/ticket/task/project), re-exports `MenuContext` from `pipeline-phases.ts`
- `src/application/tui/views/home-submenu-memory.ts` — per-session submenu cursor memory
- `src/application/tui/components/action-menu.tsx` — keyboard-navigated submenu renderer
- `src/application/tui/components/sprint-summary-line.tsx` — one-line sprint summary above the map

## Entry value conventions in submenus

- `action:<group>:<sub>` — dispatch directly (router push or chain launch)
- `group:<name>` — drill into named submenu
- `back` — return to parent level

## useRouterOptional() in browse views

List views and show views use `useRouterOptional()` (not `useRouter()`) so they degrade gracefully when
rendered in tests without a RouterProvider. All router pushes use `router?.push(...)`.

## Keyboard shortcuts wired via getKeyFor()

- All list views: `a` add, `e` edit, `r` remove, `f` filter, `c` set-current, `t` status, `o` onboard
- Detail views: `e` edit, `a` add-repo, `r` remove-repo, `o` onboard
- Execute view: `c` cancel, `D` detach/background, Enter back
- Home: `b` browse submenu

All lookups use `getKeyFor(action)` from `keyboard-map.ts` — no hardcoded letters in view files.
