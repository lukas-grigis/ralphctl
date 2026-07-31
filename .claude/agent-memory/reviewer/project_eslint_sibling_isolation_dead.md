---
name: eslint-sibling-isolation-dead-under-integration
description: Sibling-isolation ESLint fences under src/integration/ai/** are silently dead — the later general src/integration/** block replaces their no-restricted-imports value
metadata:
  type: project
---

The `siblingIsolationRule(...)` blocks in `eslint.config.ts` for
`src/integration/ai/{prompts,providers,readiness,skills,agents}/<sibling>/` are **not enforced**. The
general `{ files: ['src/integration/**/*.{ts,tsx}'] }` block is declared later in the flat-config array
and sets its own `'no-restricted-imports'`; ESLint flat config **replaces** (never merges) a same-key
rule entry, so the sibling patterns are wiped for every file under `src/integration/`.

Verified empirically 2026-08-01 with `new Linter().verify(code, config, filename)`:
a `providers/claude → providers/codex` import produces **no** diagnostic with the config as shipped,
and produces the expected "Sibling-provider import violation" once **both** `src/integration/**` blocks
are filtered out of the array. The equivalent fences for `src/business/<x>/` and
`src/domain/repository/<x>/` are NOT affected (no later same-glob block overrides them);
`src/application/flows/<x>/` is also fine (its sibling block is declared after the flows block).

**Why:** discovered while reviewing the security-hygiene `node:child_process` fence, which added a
second `src/integration/**` block. The new block did not cause this — it predates the change — but
any future work that "adds a rule to the integration block" needs to know which of the two same-glob
blocks actually wins.

**How to apply:** treat CLAUDE.md's claim that sibling isolation under `integration/ai/` is
ESLint-fenced as aspirational for that subtree — verify cross-sibling imports by hand in review until
the config is fixed. Fixing it means folding the sibling patterns into the integration block (or
declaring the sibling blocks after it). Related: [[project_duplicate_codex_effort_clamp]] for the
same "a fence exists but doesn't fire" failure mode.
