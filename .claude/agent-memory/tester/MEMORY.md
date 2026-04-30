# Tester Memory

## Test Setup

- **Framework:** vitest
- **Config:** `vitest.config.ts` in project root
- **Location:** Colocated `*.test.ts` files — main tree under `src/`, new tree under `src/`
- **Commands:** `pnpm test`, `pnpm test:watch`, `pnpm test:coverage`

## Architecture Migration

The active codebase is migrating from `src/` (legacy) to `src/` (Clean Architecture). Both trees have tests.
The deletion commit is `afe771f9`. Legacy tests: `git show afe771f9~1:src/...`.

## src/ Test Coverage Summary

### Integration — AI Providers

- `src/integration/ai/providers/claude-adapter.test.ts` — metadata, buildInteractiveArgs, buildHeadlessArgs (exact order), parseJsonOutput, detectRateLimit (all patterns incl. empty stderr, 5xx, retry-after:N), buildResumeArgs (valid, invalid: hyphen/space/metachar/empty/too-long), getSpawnEnv
- `src/integration/ai/providers/copilot-adapter.test.ts` — same shape, plus extractSessionId (share-file TOCTOU), detectRateLimit (overloaded/529/empty/retry-after:N)

### Integration — AI Session

- `src/integration/ai/session/process-runner.test.ts` — stdout/stderr capture, non-zero exit, ENOENT→StorageError, stdin, env merge, abort pre-spawn, SIGTERM→SIGKILL escalation, cwd verification via `pwd`, ESRCH tolerance

### Integration — External

- `src/integration/external/check-script-runner.test.ts` — exit 0/non-zero, combined output, RALPHCTL_LIFECYCLE_EVENT, per-call timeout, missing binary, >2 MB output (maxBuffer regression), timeout kills child

### Integration — Persistence

- `src/integration/persistence/file-locker.test.ts` — acquire/release, stale timestamp takeover, dead-PID takeover, corrupted lock, throw-release, PID+timestamp content, concurrent DIFFERENT targets (parallel, no deadlock), sequential re-acquire idempotency
- `src/integration/persistence/file-task-repository.test.ts` — findBySprintId empty, saveAll round-trip, replace, findById, NotFoundError (missing id in real sprint), update in-place, update NotFoundError (no file/unknown id), order preserved, concurrent updates serialised, round-trip all optional fields (description/verificationCriteria/extraDimensions/verificationOutput/evaluationOutput/evaluationStatus/evaluationFile), update leaves siblings unchanged

### Integration — Signals

- `src/integration/signals/file-system-handler.test.ts` — progress+files→progress.md, note→progress.md, blocked→progress.md, append-only, evaluation sidecar+progress, sidecar overwrite, evaluation without taskId→error, task-verified/task-complete→no-op, check-script/agents-md→no-op, concurrent serialisation

### Integration — Logging

- `src/integration/logging/jsonl-file-writer.test.ts` — write→jsonl, multi-line, concurrent (no interleave), context payload, lazy mkdir, reuse existing dir, write-after-dispose→error, dispose idempotent, dispose-without-write creates no file

### Chain flow tests — abort + short-circuit pattern (2026-04-29)

Added to all 6 chain flow test files (`evaluate/execute/feedback/ideate/plan/refine`):

- **Step short-circuit**: mid-chain leaf returning error → remaining steps have `status: 'skipped'`, verified via `trace.slice(failedIdx + 1)`.
- **Abort propagation**: pre-aborted `AbortController.signal` passed to `flow.execute(ctx, ac.signal)` → `result.error.code === 'aborted'` and at least one trace entry with `status: 'aborted'`.

### Business use case coverage (2026-04-29)

- `execute-single-task.test.ts`: empty stdout→failed, multiple blocked signals→all captured, task-verified+task-complete, task-complete alone (no task-verified required)
- `evaluate-task.test.ts`: evaluation-failed with empty critique still emits failed signal (when dimensions present)
- `refine-single-ticket.test.ts`: empty AI output → approved with empty requirements (documents: no length guard in use case)
- `plan-sprint-tasks.test.ts`: ticketId cross-reference intentionally not validated (documented test)

### SessionManager coverage (2026-04-29)

- `kill()` on completed runner: removes from registry, fires `removed` event, returns ok
- Two concurrent `start()` calls: distinct ids, two `added` events in order
- Late subscribe on terminated session: descriptor stays in registry until `kill()`, subscriber sees future events (no historical replay)
- `dispose()` while mid-step: explicitly tests await-and-abort pattern

### CLI coverage (2026-04-29)

- `task add --criterion` repeated: all criteria captured
- `sprint create` 200+ char name: accepted (no max-length guard in entity)
- doctor with corrupt `projects.json`: `writeFile` seeds corrupt file, deps rebuilt from same root → `EXIT_ERROR`
- `config set evaluationIterations` non-integer: `EXIT_ERROR`; value `0` accepted

### Storage paths coverage (2026-04-29)

- `RALPHCTL_ROOT` trailing slash: preserved verbatim via `trustString` (not stripped)
- `RALPHCTL_ROOT` with `~/...`: tilde NOT expanded (document: caller responsibility)

## Known Regression (not fixed here)

`RALPHCTL_SETUP_TIMEOUT_MS` env var: Legacy `runLifecycleHook` read the env var to set default timeout.
`src/CheckScriptRunner` accepts a constructor arg but the composition root (`shared-deps.ts`) calls
`new CheckScriptRunner()` without reading the env var. The env-var override path is missing.
**Fix required in `shared-deps.ts`** — read and pass `RALPHCTL_SETUP_TIMEOUT_MS` when constructing `CheckScriptRunner`.

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
const path = AbsolutePath.trustString('/code');
const sprintId = SprintId.trustString('20260429-120000-demo');
const taskId = TaskId.trustString('abcdef01');
const slug = Slug.parse('demo');
if (!slug.ok) throw slug.error;
```

### Temp dirs

```typescript
function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
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

- **No module-level `vi.mock`** for integration tests — they use real implementations with temp dirs
- `AbsolutePath.trustString()` bypasses the VO validator for test paths (use only when you own the value)
- Domain entity creation via static factory: `Task.create({...})` returns `Result<Task, ValidationError>`

## Gotchas

- **`afterEach` import**: Only import if used — `@typescript-eslint/no-unused-vars` will fail lint
- **`src/` uses `import type` for type-only imports** — enforced by lint
- **No barrel files** — imports always point to source modules directly
- **`// Ported from afe771f9~1:src/...`** comment convention marks tests backported from legacy
