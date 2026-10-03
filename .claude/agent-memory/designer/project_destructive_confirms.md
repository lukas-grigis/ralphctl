---
name: project-destructive-confirms
description: ConfirmCard title/body/message contract, two-step project-removal confirm, multi-step confirm traps (stale Yes/No focus, preview race)
metadata:
  type: project
---

Destructive confirms go through `ConfirmCard title body message` (default No). Project removal asks twice: the project, then — only if it owns sprints or memory — the cascade, as a separate card.

**Why:** removal goes through `deps.projectRemoval` / `deps.sprintRemoval`, which refuse while a flow runs; the cascade must never ride on the first Yes.

**How to apply:**

- A second confirm rendered at the same tree position reuses the first card's `ConfirmPrompt` state, so it inherits the Yes/No focus. Give each step a `key`.
- If a confirm depends on an async preview (project removal), hold the card until the preview lands; otherwise a fast `y` skips the follow-up question.
- A removal that empties a list lands on the empty state; the views render the feedback line there too (a toast that vanishes with the list reads as silence).
- Real-fs view tests (`createRealFsApp`) prove "dir is gone, siblings untouched"; stub repos cannot.
