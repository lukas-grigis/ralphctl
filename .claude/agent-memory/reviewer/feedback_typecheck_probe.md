---
name: feedback-typecheck-probe
description: How to verify a "compile-time forcing function" claim when the review workflow forbids running pnpm typecheck
metadata:
  type: feedback
---

When a fix claims a type-level guarantee (`satisfies`, mapped type, `Required<Pick<…>>`, branded type) and the review
harness forbids `pnpm typecheck`, do NOT take the claim on faith and do NOT settle for the runtime tests — replicate the
pattern in a scratchpad-only `.ts` file with a synthetic stand-in for the repo type and run `tsc` on it, including a
NEGATIVE variant that should error.

**Why:** these guards are load-bearing only if the inferred types come out as literals. A `satisfies` map whose property
types widen to `string` silently degrades a derived key union to `never`, so the "forcing function" compiles no matter
what while every runtime test still passes. Nothing in vitest can distinguish the two.

**How to apply:** copy the repo's compilerOptions that change inference (`strict`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `target`, `verbatimModuleSyntax`); add `{"type":"module"}` package.json in the probe dir or
`verbatimModuleSyntax` + NodeNext will report bogus TS1287 on every export; pass `--ignoreConfig` when naming files on
the CLI next to a tsconfig.json. Assert BOTH directions — a positive (`const k: DerivedKey = 'realKey'` compiles, proving
the union isn't `never`) and a negative (omit the field → expect the exact TSxxxx the docstring promises).

Applies to any review under a "never run pnpm typecheck/lint/test" workflow — see [[feedback_review_scope]] for the
normal, unrestricted pass.
