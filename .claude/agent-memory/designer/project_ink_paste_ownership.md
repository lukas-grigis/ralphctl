---
name: project_ink_paste_ownership
description: Ink 8 parses bracketed paste before useInput; prompts use usePromptPaste (Ink usePaste) and Ink owns DEC 2004 on/off
metadata:
  type: project
---

Ink 8's input parser strips `ESC[200~ … ESC[201~` and emits one paste event before `useInput` runs, so an app-side marker parser never sees a marker. Prompts take pastes through `usePromptPaste` (use-prompt-input.ts, same overlay/active gate as `usePromptInput`); Ink ref-counts mode 2004 and turns it off on unmount, signal-exit and the `runInTerminal` unmount.

**Why:** the old hand-written parser plus manual `\x1b[?2004h/l` writes in ink-host left the terminal in 2004 after SIGTERM, and a pasted lone `\r` fell through to `key.return` and submitted the prompt.

**How to apply:** never write 2004 escapes yourself; add paste support to a new input via `usePromptPaste`. The printable-chunk fallback in the prompts is only for terminals without mode 2004. Testing the mode needs a TTY-flagged fake stdout passed to Ink's own `render` (ink-testing-library's stdout has no `isTTY`, so Ink writes nothing).
