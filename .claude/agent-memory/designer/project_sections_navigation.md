---
name: project_sections_navigation
description: Sectioned router + chrome + switcher overlay — non-obvious invariants (title channel, overlay key ownership, test-frame noise, none-section)
metadata:
  type: project
---

**Title channel.** `ViewShell` publishes title/subtitle/right into `view-title-context.tsx`; the location line (mounted once in `Layout`) reads it. The setter and value live in SEPARATE contexts on purpose: ViewShell only publishes, so it never re-renders on a value change. Merge them and publishing a fresh `right` node each render loops.

**Why:** a view's `right` is a new ReactNode identity every render; identity-compare would re-publish forever.

**Switcher overlay owns its keys with a raw `useInput`, not `useViewKeys`.** `useViewKeys` mutes itself while any overlay is open and would also register its hints into the hidden view's registry. The global handler just swallows every key while `ui.switcherFocus` is set (after the `?`/ctrl+c branches), and the overlay pins its own `FooterBar`. The tab bar + location line stay on screen for the switcher but hide for help/progress/evaluation (those assume a full-frame body budget).

**Initial entries `welcome` and `create-project` start in section `none`** (tab bar + location line hidden, digits inert) even though `sectionOf('create-project')` is `projects` — the first-run wizard must not offer tabs. `reset({id:'create-project'})` also lands in `none` (welcome hands off via reset; filing it under Projects showed the tab bar mid-wizard). Work's `c` pushes it, so it stays a normal depth-2 view there.

**Test frames:** `renderAtSize.lastFrame()` now skips control-only writes. `ScrollRegion` writes mouse-reporting toggles when `modalOpen` flips (prompt claimed), which used to read as an empty screen. Whole-frame navigation tests use `_app-frame.tsx` (real Layout + stub views).

**Hint order follows the mockups:** local hints, `esc <parent>`, `1–5 sections` (lg+), `? help`, `q quit` (Work root only) — not the brief's prose order.
