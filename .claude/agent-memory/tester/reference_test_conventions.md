---
name: reference-test-conventions
description: Standing vitest conventions for this repo — Result assertions, branded VOs, temp dirs, mocking seams, and the recurring gotchas
metadata:
  type: reference
---

Vitest, config at `vitest.config.ts`; tests live under `tests/{unit,integration,e2e}/`, flow e2e at
`tests/e2e/flows/<flow>.test.ts`. Targeted runs use `npx vitest run <path>`.

## Assertions and fixtures

```typescript
// Result-typed
const r = await repo.findById(sprintId, t.id);
expect(r.ok).toBe(true);
if (r.ok) expect(r.value.name).toBe('findable');
if (!r.ok) expect(r.error.code).toBe('not-found');

// Branded VOs — parse() is the ONLY constructor (there is no trustString; verified 2026-08-19).
// Prefer the shared helpers in @tests/fixtures/domain.ts (absolutePath(...)); wrap locally otherwise.
const absPath = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`invalid path ${p}`);
  return r.value;
};
const sprintId = '01933fbb-2222-7000-8000-0000000000aa' as unknown as SprintId; // ids are commonly cast
```

Temp dirs: `join(tmpdir(), 'ralphctl-<module>-<pid>-<now>-<rand>')`, removed in `afterEach` with
`rm(root, { recursive: true, force: true })`. Skip shell-dependent tests on Windows with
`if (process.platform === 'win32') return;`.

Entity construction goes through the static factory — `Task.create({...})` returns
`Result<Task, ValidationError>`.

## Mocking

- Integration tests use real implementations against temp dirs, **not** module-level `vi.mock` — the
  exception is mocking a node builtin to inject a specific error code the real filesystem cannot
  reproduce deterministically.
- `vi.mock('node:fs/promises', …)` is the only reliable seam for **named-import** interception: ESM
  named imports bind at link time, so `vi.spyOn` on the namespace only catches namespace-qualified
  calls (`fs.readFile()`), never an already-bound local `readFile`. Put it in a SEPARATE file so it
  does not affect co-located real-fs tests.

## Gotchas

- Import `afterEach` only if used — `@typescript-eslint/no-unused-vars` fails lint.
- `src/` uses `import type` for type-only imports (lint-enforced); no barrel files, so imports point
  at source modules directly.
- `// Ported from <sha>~1:src/...` marks tests backported from legacy.
- **`Leaf.input()` throws are caught by `runLeaf`** and wrapped in `Result.error` — the promise
  RESOLVES. Assert `result.ok === false`, never `rejects.toThrow`.
- `resolveStoragePaths()` reads `process.env.RALPHCTL_ROOT` at call time, not import time — set the
  env var in `beforeEach`/`afterEach`; no vitest setup file needed for leaves that call it inline.
- Sprint mutators are free functions, and their return shape is not uniform: `setSprintSlug`
  (`domain/entity/sprint.ts`) returns `Result<OpenSprint, InvalidStateError>`, while
  `setExecutionBranch` / `recordExecutionPullRequestUrl` / `setExecutionBaselineBrokenPolicy`
  (`domain/entity/sprint-execution.ts`) return a plain `SprintExecution`. Check the signature before
  assuming an envelope.
