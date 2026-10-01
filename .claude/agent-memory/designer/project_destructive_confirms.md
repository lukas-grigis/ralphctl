---
name: project-destructive-confirms
description: ConfirmCard verb/target contract, destructive ConfirmPrompt, multi-step confirm traps (stale Yes/No focus, preview race)
metadata:
  type: project
---

Destructive confirms go through `ConfirmCard verb target body`; `ConfirmPrompt destructive` ignores `h`/`l` because `h` is global Home.

**Why:** the old title/prompt pairs disagreed (`Remove sprint` / `Delete?`) and a stray `h` answered Yes.

**How to apply:**

- A second confirm rendered at the same tree position reuses the first card's `ConfirmPrompt` state, so it inherits the Yes/No focus. Give each step a `key`.
- If a confirm depends on an async preview (project removal), hold the card until the preview lands; otherwise a fast `y` skips the follow-up question.
- A removal that empties a list lands on the empty state, which drops the feedback line, so test it on disk or on the empty state, not on the toast.
- Real-fs view tests (`createRealFsApp`) prove "dir is gone, siblings untouched"; stub repos cannot.
