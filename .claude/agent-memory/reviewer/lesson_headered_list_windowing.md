---
name: headered-list-windowing
description: useListWindow over a grouped list: re-attached headers escape the window
metadata:
  type: feedback
---

Windowing over the cursorable subset and re-attaching headers for rendering drops the "rendered height <= visibleRows"
guarantee, because each header adds lines, and an "always render this header" exemption makes the overshoot unbounded in
group count. It bites hardest in views passing `suppressScrollArrows`, where overflowed content is unreachable.

**How to apply:** keep `useListWindow` for cursor and keys over the cursorable subset, but derive the render slice from
`computeListWindow(rows.length, indexOfFocusedInRows, visibleRows)` over the full flat row list.

**Gate trap:** `pnpm cmd | tail; echo done` reports `echo`'s exit code. Run each gate as its own command.
