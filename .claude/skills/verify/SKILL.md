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

All three MUST pass. If any step fails, report which one, show the error, and stop — don't move on until the failure is addressed.

## Why these three, in this order

1. **`pnpm typecheck`** — `tsc --noEmit`. Fastest feedback; catches most issues.
2. **`pnpm lint`** — ESLint. Includes the Clean Architecture layer fence (domain < business < integration < application) and the CLI/TUI → pipeline-factory rule. A layer violation shows up here.
3. **`pnpm test`** — vitest. 1300+ tests including pipeline step-order integration tests that lock the architectural shape.

Running them chained with `&&` short-circuits on the first failure, which is what we want.

## Not a replacement for

- `pnpm build` — only needed before publishing to npm
- `knip` / dead-code scans — one-off audit, not a per-change gate
- `pnpm format` — formatting is handled by the pre-commit hook
