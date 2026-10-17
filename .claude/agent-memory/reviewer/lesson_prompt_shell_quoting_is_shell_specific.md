---
name: lesson-prompt-shell-quoting-is-shell-specific
description: Shell-quoting a path inside a prompt template is only correct for the shell the model's bash tool uses; POSIX single-quote escaping can regress Windows providers while its /bin/sh round-trip test stays green
metadata:
  type: feedback
---

A prompt that tells the model to run `git -C <path>` is executed by whatever shell the provider's tool uses, not by
`/bin/sh`. A POSIX single-quote word (`'` becomes `'\''`) round-trips in sh/bash/Git Bash but not in cmd.exe
(single quotes are literal) and PowerShell (embedded `'` is doubled, not `'\''`). The matching test is
`skipIf(win32)` and uses `/bin/sh`, so it cannot see this.

**Why:** the quoting was chosen to stop `$`/backtick expansion inside double quotes; the fix is right for POSIX and
silently unverified elsewhere.

**How to apply:** when a diff changes quoting in a template, ask which providers run on Windows and what shell
their tool gives the model; report it as a note unless the repo documents Windows as unsupported for that path.
Also check the sibling placeholders on the same command lines (`{{BASE_BRANCH}}`) for the same class.
