---
name: project-work-agenda
description: Work (home route) agenda traps — ActionMenu cursor is private, stale-while-reload snapshot, `n` re-entry remount, row-height budgeting
metadata:
  type: project
---

Work's agenda is `home-internals/agenda.ts` (pure) rendered through ONE `ActionMenu`.

- `useAsyncLoad.reload()` resets state to `loading`: a view that reloads live (Work passes `liveTasks`) must keep the last
  snapshot of the same selection, or the agenda blanks and the cursor remounts on every task event.
- `ActionMenu` owns the cursor id privately. A caller that needs it (footer verb, `u` gating) uses `onFocusChange`; a caller
  that must re-seed it (`n` re-entering Work) remounts the menu with a `key` bump — there is no setter by design.
- `n` is `router.reset({ id: 'home', props: { focus: 'flows' } })`, never `land()`: `land` no-ops at the Work root, but the
  cursor still has to move onto FLOWS.
- Events carry task ids, not sprint ids — "this sprint's events" means the id is in the loaded task list.
- Menu row budget must count section headers, the focused row's detail line and the `v` hint line, or the agenda clips at
  80x24 (windowing counts enabled items only).

**Why:** each of these cost a failing real-pty frame or a flickering list during the Work rewrite.
**How to apply:** any future live-reloading list view or any view whose cursor must be set from outside.
