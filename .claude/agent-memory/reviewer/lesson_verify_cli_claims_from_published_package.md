---
name: verify-cli-claims-from-published-package
description: Env-var / flag / dist-tag claims about external CLIs can be checked offline-style from the npm tarball; the sandbox has registry access
metadata:
  type: feedback
---

The review sandbox can reach the npm registry. `npm view <pkg> dist-tags.latest` settles "does `npm i -g X` give the
wrong major"; `npm pack @anthropic-ai/claude-code-darwin-arm64@<ver>` into a scratchpad dir, extract, and
`strings -a package/claude | grep -o ".\{120\}ENV_NAME.\{120\}"` shows whether an env var exists and how it parses
(`CLAUDE_CODE_FORK_SUBAGENT === false` disables, so `'0'` is right). Never execute the extracted binary.

**Why:** a misspelled env var or a flag that does not exist turns a hardening fix into a silent no-op that no
fake-spawn test can catch; I nearly reported the OpenCode README install line as stale before `npm view` showed
`latest` is still 1.x.

**How to apply:** before reporting or accepting a claim about an external CLI's behaviour, query the registry
first; keep the downloaded tree in its own scratchpad subdir.
