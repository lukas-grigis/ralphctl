---
name: project_scroll_region_anchor_rerender
description: ScrollRegion reveal-on-focus only ran when the region re-rendered; cursors living inside a child (ActionMenu) never triggered it; cue rows cost viewport rows
metadata:
  type: project
---

`useScrollAnchor` registration must bump a state counter in `ScrollRegion` when a NEW anchor registers. A cursor whose state lives in a descendant (ActionMenu) re-renders only that subtree, so the region's layout-effect reveal pass never ran and the focused row walked off-screen (caught only by a test that pinned the root Box to the terminal height).

**Why:** `renderAtSize` does not bound the root height; without `<Box height={rows}>` ScrollRegion never clips and scroll bugs are invisible.

**How to apply:** viewport/scroll tests wrap the view in a height-pinned Box (the real App does). The overflow cues are separate rows outside the clip box, so max offset is `content - viewport + 1` while overflowing; don't revert to `content - viewport` in tests.
