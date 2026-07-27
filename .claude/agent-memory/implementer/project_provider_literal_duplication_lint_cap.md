---
name: project-provider-literal-duplication-lint-cap
description: Adding a provider-keyed lookup table (e.g. RETIRED_MODEL_REMAPS) with repeated
  raw 'github-copilot' / 'openai-codex' string literals can push src/domain/entity/settings.ts
  over the ratcheted lint warning cap via sonarjs/no-duplicate-string
metadata:
  type: project
---

`src/domain/entity/settings.ts` already had `PROVIDER_CLAUDE_CODE` as a hoisted constant for the
`'claude-code'` literal, but `'github-copilot'` and `'openai-codex'` were still spelled out raw at
each z.literal() call site. Adding a per-provider table (e.g. the 2026-07-26 provider
model-catalog refresh's `RETIRED_MODEL_REMAPS`) that references these strings multiple times each
pushed the file over sonarjs's 3-occurrence `no-duplicate-string` threshold, which tipped the
project's ratcheted `eslint --max-warnings` cap from 115 to 116 and failed `pnpm lint`.

**Why:** the lint cap (see [[project_lint_warning_reduction_2026-06-30]]) is a hard ratchet —
any net-new warning anywhere in the diff fails the gate, even in a file whose complexity/size
warnings are unrelated to your change.

**How to apply:** when editing `settings.ts` (or any file with an existing `no-duplicate-string`
warning) to add a new table/array keyed by provider id, hoist `PROVIDER_GITHUB_COPILOT` /
`PROVIDER_OPENAI_CODEX` constants alongside `PROVIDER_CLAUDE_CODE` and reuse them at every
z.literal()/comparison site (schema definitions, migration tables, row-shape guards) rather than
adding more raw literal occurrences. This is a general pattern: before landing a lint-passing
change, re-run `pnpm lint` and treat ANY new warning in a touched file as your responsibility to
fix by constant-hoisting, not as pre-existing drift — check `git diff <file>` for the literal
before assuming it predates your change.
