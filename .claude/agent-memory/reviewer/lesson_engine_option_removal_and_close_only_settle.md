---
name: engine-option-removal-and-close-only-settle
description: Removing an option from a provider-engine interface leaves stale snippets in public docs/ ; settling only on 'close' needs a non-POSIX / escaped-group story
metadata:
  type: feedback
---

When an option is deleted from `RunHeadlessSpawnOptions` / `ProviderAttemptInput`, grep the public `docs/` tree
(`docs/adding-a-provider.md` carries a copy-paste adapter snippet), not only `.claude/docs/` and `src/`. tsc/lint/knip
never read markdown, so the stale `resolveOn: 'close'` survived a green gate.

**Why:** the snippet is what a contributor copies; it would now fail typecheck on an excess property.

**How to apply:** after any engine-interface removal, `grep -rn <option> docs .claude/docs README.md scripts`.

A spawn that settles only on `'close'` hangs when a descendant holds the stdout pipe. The group reap on `'exit'`
covers POSIX leaders only (`processGroupOf` is undefined on Windows, and a `setsid` escapee is outside the group), and
the idle watchdog cannot rescue it because its kill targets an already-dead leader. When a change moves providers from
`'exit'` to `'close'`, ask what bounds `'close'` on Windows. See [[lesson-partial-wiring-of-general-seam]] for the
same "fix covers one launcher/platform" shape.
