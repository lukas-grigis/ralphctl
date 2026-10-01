---
name: project_banner_tiers
description: Work banner is three tiers (full / compact / none) and the maintainer rejected redesigned mini wordmarks; stopped-task minimap state
metadata:
  type: project
---

The maintainer rejected a NEW mini wordmark: identity = the original art + gradient, only the chrome compacts. Below the compact tier the tab bar's gradient `ralphctl` carries the brand.

**Why:** "i miss the banner a bit" — a redesign was refused twice.

**How to apply:** a banner change budgets rows via `bannerRows(mode, columns)`, never a local constant. `Extended_Pictographic` matches `↔` and similar arrows, so the banner source emoji-fence test also rejects them in comments. Probe seeding: an `in_progress` task needs `finishedAt` on a settled attempt or the schema drops the whole task silently (minimap shows `TASKS 0`).
