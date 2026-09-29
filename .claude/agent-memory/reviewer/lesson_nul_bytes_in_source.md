---
name: nul-bytes-in-source
description: A literal NUL byte in a .ts file passes lint and prettier but breaks git diff
metadata:
  type: feedback
---

A typed literal NUL where `'\x00'` was meant behaves identically at runtime, but the file becomes opaque to `git diff`
(`Bin 0 -> N bytes` in `--stat`, `file` says "data") and PR views. `pnpm lint` and `format:check` do not catch it.

**How to apply:** `git diff --stat` showing `Bin` on a `.ts` file is the tell; confirm with
`LC_ALL=C grep -naP '\x00' <file>`.
