---
name: verify
description: Run the project's full verification gate — typecheck, lint, tests — in one go. Use after any code change before committing, or when the user asks "is it green?" / "can I ship this?" / "verify" / "run checks".
when_to_use: After editing any TypeScript file, before committing, or when the user explicitly asks to verify. CLAUDE.md mandates this exact sequence must pass before every commit.
allowed-tools: Bash
---

# Verify

Run the project's verification gate as a single command:

```!
pnpm typecheck && pnpm lint && pnpm test
```

All three MUST pass. If any step fails, report which one, show the error, and stop — don't move on until the failure is
addressed.

## Why these three, in this order

1. **`pnpm typecheck`** — `tsc --noEmit`. Fastest feedback; catches most issues.
2. **`pnpm lint`** — ESLint. Includes the Clean Architecture layer fence (
   `domain → business → integration → application`), the no-class fence (outside `domain/value/error/`), the no-barrels
   fence, the sibling-isolation rules under `integration/ai/<concept>/`, and the CLI/TUI → flow-factory rule. A layer
   violation shows up here.
3. **`pnpm test`** — vitest. 1299 tests including flow step-order integration tests that lock the architectural shape.

Running them chained with `&&` short-circuits on the first failure, which is what we want.

## Not a replacement for

- `pnpm format:check` / `pnpm format` — Prettier. The pre-commit hook handles staged files; run `format:check` manually
  for a full sweep before opening a PR.
- `pnpm deadcode` — knip. One-off audit; symbols intentionally exported are whitelisted via `@public` JSDoc tag +
  `knip.json#tags: ["-public"]`.
- `pnpm build` — `tsup` + `tsx scripts/build-assets.ts`. Only needed before publishing to npm; CI verifies the bundle
  from arbitrary cwd.
