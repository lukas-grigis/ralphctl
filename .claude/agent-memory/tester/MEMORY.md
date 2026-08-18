# Tester Memory

## Test Setup

- **Framework:** vitest
- **Config:** `vitest.config.ts` in project root
- **Location:** tests live under `tests/{unit,integration,e2e}/`; flow e2e tests at `tests/e2e/flows/<flow>.test.ts`
- **Commands:** `pnpm test`, `pnpm test:watch`, `pnpm coverage`

## Test Patterns (src style)

### Result-typed assertions

```typescript
const r = await repo.findById(sprintId, t.id);
expect(r.ok).toBe(true);
if (r.ok) expect(r.value.name).toBe('findable');

expect(r.ok).toBe(false);
if (!r.ok) expect(r.error.code).toBe('not-found');
```

### Branded value objects

```typescript
// `parse()` is the ONLY constructor — there is no `trustString` (verified 2026-08-18).
const absPath = (p: string): AbsolutePath => {
  const r = AbsolutePath.parse(p);
  if (!r.ok) throw new Error(`invalid path ${p}`);
  return r.value;
};
const sprintId = '01933fbb-2222-7000-8000-0000000000aa' as unknown as SprintId;
const slug = Slug.parse('demo');
if (!slug.ok) throw slug.error;
```

### Temp dirs

```typescript
function uniqueRoot(): AbsolutePath {
  return absPath(
    join(
      tmpdir(),
      `ralphctl-<module>-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
    )
  );
}
// Clean up in afterEach: await rm(root, { recursive: true, force: true })
```

### Windows skip for shell-dependent tests

```typescript
if (process.platform === 'win32') return;
```

## Mocking Strategies (src)

- **No module-level `vi.mock`** for integration tests — they use real implementations with temp dirs (exception: mocking node builtins like `node:fs/promises` to inject specific error codes deterministically, where real filesystem cannot reproduce the exact error code reliably)
- **`vi.mock('node:fs/promises', ...)` for named-import injection**: ESM named imports bind at link time, so `vi.spyOn` on the namespace object only intercepts namespace-qualified calls (e.g. `fs.readFile()`), not already-bound local `readFile` identifiers. `vi.mock` hoisting replaces the entire module factory before any import is evaluated — the only reliable seam for named-import interception. Put this in a SEPARATE test file so it doesn't affect co-located real-fs tests.
- **`trustString` does not exist anywhere in `src/`** (verified 2026-08-18 — the note that claimed otherwise was stale). Branded VOs expose `parse()` (and `generate()` on the id VOs). In tests either use the shared `@tests/fixtures/domain.ts` helpers (`absolutePath(...)`) or wrap locally: `const absPath = (p: string): AbsolutePath => { const r = AbsolutePath.parse(p); if (!r.ok) throw new Error(`invalid path ${p}`); return r.value; }`. Ids are commonly cast: `'…' as unknown as SprintId`.
- Domain entity creation via static factory: `Task.create({...})` returns `Result<Task, ValidationError>`

## Gotchas

- **`afterEach` import**: Only import if used — `@typescript-eslint/no-unused-vars` will fail lint
- **`src/` uses `import type` for type-only imports** — enforced by lint
- **No barrel files** — imports always point to source modules directly
- **`// Ported from afe771f9~1:src/...`** comment convention marks tests backported from legacy
- **`Leaf.input()` throws are caught by `runLeaf`**: the framework catches the throw from `input()` and wraps it in `Result.error` — the promise resolves, it does NOT reject. Use `result.ok === false` assertions, NOT `rejects.toThrow`.
- **`resolveStoragePaths()` inside a leaf execute body**: it reads `process.env.RALPHCTL_ROOT` at call time (not import time). Set the env var in `beforeEach`/`afterEach` — no vitest setup file needed for leaves that call it inline.
- **`Sprint.recordCheckRun(repo, at)`** returns a plain `Sprint` (no `Result` wrapper); `setBranch` and `setAffectedRepositories` return `Result<Sprint, InvalidStateError>`.

## Topic index (session-specific patterns — one line each, detail in the linked file)

- [model-catalog-refresh-2026-07-26.md](model-catalog-refresh-2026-07-26.md) — model-catalog/ladder bumps break "top of ladder" test fixtures far outside the catalog/preset files; run the FULL suite, don't trust a spec's file list
- [fingerprint-audit-gate-pattern.md](fingerprint-audit-gate-pattern.md) — recompute escalation-map.test.ts's SHA-256 catalog fingerprints by running the test and pasting the actual hash, never by hand
- [gen-eval-exit-mapping.md](gen-eval-exit-mapping.md) — finalize-gen-eval mapExit verdict/warning/blockedReason truth table
- [launcher-hitl-distill-confirm.md](launcher-hitl-distill-confirm.md) — launchCloseSprint/launchReview HITL distill confirm gate test patterns
- [parallel-implement-wave-ordering-lock.md](parallel-implement-wave-ordering-lock.md) — scheduleIntoWaves dependency-fence + concurrent FsTaskRepository integrity tests
- [parallel-implement-realgit-e2e.md](parallel-implement-realgit-e2e.md) — real-git parallel worktree e2e test + the worktree branch-leak bug it caught
- [sprint-selection-redesign-tests.md](sprint-selection-redesign-tests.md) — reseat wiring, done-sprint filtering, MakeSpy intercept, fake-timer toast tests, ActionMenu cursor/UUIDv7 ordering
- [gen-eval-turn-step-order-fence.md](gen-eval-turn-step-order-fence.md) — gen-eval-loop.test.ts shape fence + crash-attribution (InvalidStateError is recoverable)
- [meta-run-flow-failure-arcs.md](meta-run-flow-failure-arcs.md) — implement-failure/review-failure arcs; RateLimitError yields 'failed' not 'aborted'
- [progress-overlay-flake-elimination.md](progress-overlay-flake-elimination.md) — SEEDED sentinel + waitFor pattern to eliminate flaky ink-testing-library overlay/scroll tests
- [full-stack-e2e-wiring.md](full-stack-e2e-wiring.md) — full-stack e2e wiring: implement launcher bypasses app.deps.provider, TUI mount plumbing, sprint pre-setup
- [waitfor-loud-timeout-contract.md](waitfor-loud-timeout-contract.md) — ONE predicate waiter (`waitForPredicate`, throws on timeout) + the control-probe settle pattern for "empty is also the first frame" hooks
- [plateau-detector-subordination.md](plateau-detector-subordination.md) — entropy/diversity leaves can never fire in the composed gen-eval loop; where the mutual-exclusion fences live
