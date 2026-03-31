# Tester Memory

## Test Setup

- **Framework:** vitest
- **Config:** `vitest.config.ts` in project root
- **Location:** Colocated `*.test.ts` files next to source

## Test Files Found

```
src/ai/evaluator.test.ts    # parseEvaluationResult: passed/failed signals, empty critique, no signal, precedence
                            #   getEvaluatorModel: Opus→Sonnet, Sonnet→Haiku, Haiku→Haiku, null model, Copilot→null
src/ai/permissions.test.ts  # isToolAllowed (pure): exact name, Bash(*), prefix:*, exact specifier, deny
                            #   getProviderPermissions: copilot returns empty, project-level settings.local.json,
                            #   malformed JSON, missing permissions section — homedir() mocked via vi.mock('node:os')
                            #   checkTaskPermissions: copilot no warnings, needsCommit flag, Bash(*) coverage,
                            #   commit and script warnings simultaneously
src/ai/prompts/index.test.ts # buildInteractivePrompt, buildAutoPrompt, buildTaskExecutionPrompt (noCommit),
                             #   buildTicketRefinePrompt (with/without issueContext), buildIdeatePrompt,
                             #   buildIdeateAutoPrompt — all check no unreplaced tokens (except known
                             #   {{PROGRESS_FILE}} second-occurrence bug in task-execution.md)
src/ai/executor.test.ts     # pickTasksToLaunch: empty tasks, in-flight filtering, path dedup
                            #   (first-encountered wins, not lowest order), concurrency limit,
                            #   slot math (limit - inFlight), all-same-path, zero limit
src/ai/parser.test.ts       # parseExecutionResult: complete+verified, complete-without-verified,
                            #   blocked with reason/empty, no signals, verified-only, verified+blocked,
                            #   large output, multiline verified content
src/ai/runner.test.ts       # Runner/executor tests: parseExecutionResult, getEffectiveVerifyScript,
                            #   getRecentGitHistory, buildFullTaskContext (setup + pre-flight rendering),
                            #   runSetupScripts, runPreFlightVerify, runPreFlightForTask
src/commands/ticket/refine.test.ts # ticketRefineCommand: sprint resolution, ticket selection,
                                   #   AI session flow, issue link fetching, approval/rejection
src/integration/cli-smoke.test.ts # CLI smoke tests (comprehensive E2E scenarios)
src/integration/cli.test.ts     # CLI integration tests
src/schemas/index.test.ts       # Schema validation tests (incl. SprintSchema backward compat for setupRanAt)
                                #   TaskSchema: evaluated/evaluationOutput fields + backward compat
                                #   ConfigSchema: evaluationIterations (int >=0, optional, rejects negative/float)
src/store/config.test.ts        # Config store: getConfig default, saveConfig roundtrip,
                                #   setCurrentSprint/setAiProvider/setEditor/setEvaluationIterations persist and read back
                                #   getEvaluationIterations: defaults to 1 when field missing
src/store/progress.test.ts      # Progress store tests
src/store/project.test.ts       # Project store: listProjects, createProject, getProject,
                                #   ProjectExistsError/ProjectNotFoundError, removeProject,
                                #   addProjectRepo, removeProjectRepo (incl. last-repo guard)
src/store/sprint.test.ts        # Sprint store: assertSprintStatus (pure), createSprint,
                                #   activateSprint, closeSprint, getCurrentSprintOrThrow,
                                #   full create→activate→close lifecycle integration
src/store/task.test.ts          # Task store tests (topological sort, validation)
src/store/ticket.test.ts        # Ticket store tests
src/theme/index.test.ts         # Theme tests
src/utils/ids.test.ts             # ID generation tests
src/utils/issue-fetch.test.ts     # Issue fetch: parseIssueUrl, fetchIssue (gh/glab), fetchIssueFromUrl,
                                  #   formatIssueContext, IssueFetchError — spawnSync mocked via vi.mock
```

## Interactive Mode Coverage

The interactive menu (`src/interactive/menu.ts`) defines menu structure but is **not directly tested**. However:

- **CLI commands** are comprehensively tested via `cli-smoke.test.ts`
- Interactive mode dispatches to the same command handlers
- Test coverage is indirect but effective

**Ticket Edit Status:**

- Menu entry exists at line 72 of `src/interactive/menu.ts`:
  `{ name: 'Edit', value: 'edit', description: 'Edit a ticket' }`
- **MISSING:** CLI handler not in interactive dispatch map (line 78-82 of `src/interactive/index.ts`)
- Command implementation: `src/commands/ticket/edit.ts` (fully implemented)
- CLI tests: Comprehensive coverage in `cli-smoke.test.ts` lines 310-326, 716-752

**Fix Required:**

- Import: `import { ticketEditCommand } from '@src/commands/ticket/edit.ts';`
- Dispatch: Add `edit: () => ticketEditCommand(undefined, { interactive: true })` to ticket command map

## Test Patterns

### Factory Functions

Create test data with sensible defaults:

```typescript
function createTask(id: string, blockedBy: string[] = []): Task {
  return {
    id,
    name: `Task ${id}`,
    description: undefined,
    steps: [],
    status: 'todo',
    order: 1,
    ticketId: undefined,
    blockedBy,
    projectPath: '/tmp/test',
    verified: false,
  };
}
```

### Describe/It Structure

Group related tests, descriptive names:

```typescript
describe('topologicalSort', () => {
  it('sorts independent tasks by original order', () => { ... });
  it('puts dependencies before dependents', () => { ... });
  it('detects simple cycle', () => { ... });
});
```

### Testing Errors

```typescript
it('detects simple cycle', () => {
  const tasks = [createTask('a', ['b']), createTask('b', ['a'])];
  expect(() => topologicalSort(tasks)).toThrow(DependencyCycleError);
});
```

### Testing Validation

```typescript
it('rejects reference to non-existent task', () => {
  const importTasks = [{ name: 'Task', blockedBy: ['nonexistent'] }];
  const errors = validateImportTasks(importTasks, []);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('does not exist');
});
```

## Commands

```bash
pnpm test              # Run all tests
pnpm test:watch        # Watch mode
pnpm test:coverage     # Coverage report
pnpm test <pattern>    # Run specific tests
```

## Test Categories

### Unit Tests (src/store/, src/utils/)

- Pure function testing
- No I/O mocking needed for algorithms
- Fast, focused tests

### Integration Tests (src/integration/)

- CLI command execution via in-process `runCli` helper or `execSync`
- Tests actual command output
- Slower, higher confidence
- `cli-smoke.test.ts` contains comprehensive E2E scenarios including full sprint lifecycle

## Mocking Strategies

### No Mocks Needed

- Pure functions like `topologicalSort()`, `validateImportTasks()`
- Schema validation tests
- ID generation tests

### File System (when needed)

- Use temp directories for isolation
- Clean up in `afterEach`

### Module mocking with partial override (task-context pattern)

When a module exports both pure functions (keep real) and side-effecting functions (mock):

```typescript
vi.mock('@src/ai/task-context.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/ai/task-context.ts')>();
  return {
    ...actual, // keep pure functions (buildFullTaskContext, etc.)
    getProjectForTask: vi.fn(), // override only side-effecting functions
    getEffectiveSetupScript: vi.fn(),
  };
});
```

vi.mock calls must be at module top level (not inside describe/it). Use dynamic imports
inside beforeEach/test bodies to get the mocked versions after `vi.clearAllMocks()`.

### vi.resetAllMocks() vs vi.clearAllMocks()

- `vi.clearAllMocks()` — clears call history only; mock implementations/return values persist.
  Safe to use when `vi.mock()` factories set stable defaults.
- `vi.resetAllMocks()` — clears call history AND mock return values/implementations.
  Required when tests need clean isolation, BUT you must re-establish all default mocks in `beforeEach`.

**Pattern for command tests with many mocked modules:**

```typescript
beforeEach(() => {
  vi.resetAllMocks();
  // Re-establish every default needed across all tests:
  vi.mocked(resolveSprintId).mockResolvedValue('sprint-id');
  vi.mocked(assertSprintStatus).mockReturnValue(undefined);
  vi.mocked(getRefinementDir).mockReturnValue('/tmp/dir'); // don't forget path utils!
  vi.mocked(getSchemaPath).mockReturnValue('/tmp/schema.json');
  vi.mocked(resolveProvider).mockResolvedValue('claude');
  vi.mocked(providerDisplayName).mockReturnValue('Claude');
  vi.mocked(createSpinner).mockReturnValue({ start, stop, succeed, fail });
  // ... all others
});
```

**Common gotcha:** `vi.mock()` factory functions with `.mockReturnValue(...)` are wiped by
`resetAllMocks()`. Always re-set in `beforeEach` after calling `resetAllMocks()`.

### Testing multi-step guard logic

When a command has sequential guards (e.g., "no approved tickets" check before "ticket not approved" check),
test data must satisfy all earlier guards to reach the guard being tested:

```typescript
// Wrong: only a pending ticket — exits at "no approved tickets" guard
makeSprint([makeTicket({ requirementStatus: 'pending' })]);

// Correct: one approved ticket (passes first guard) + the pending one to test:
makeSprint([
  makeTicket({ id: 'approved-one', requirementStatus: 'approved' }),
  makeTicket({ id: 'target', requirementStatus: 'pending' }),
]);
await command('target'); // reaches the "not approved" error
```

## Coverage Status

### Well Covered

- [x] Store logic (tickets, tasks, sprints, progress, config, projects)
- [x] CLI commands (comprehensive smoke tests in `cli-smoke.test.ts`)
- [x] Schema validation (incl. backward compat for new optional fields via `.default({})`)
- [x] Ticket edit command (CLI E2E tests)
- [x] Error handling and edge cases
- [x] `runSetupScripts` — timestamp recording, skip on cached, refresh flag, partial-failure safety
- [x] `runPreFlightVerify` — pass/fail detection
- [x] `runPreFlightForTask` — no-script skip, pass, fail-resuming, self-heal pass/fail, block on no setup
- [x] `issue-fetch` utils — parseIssueUrl (GitHub + GitLab + edge cases), fetchIssue (gh/glab CLI), formatIssueContext
- [x] `ticketRefineCommand` — 18 tests covering all guards, AI session flow, issue fetch, approval/rejection
- [x] `parseExecutionResult` — 11 tests covering all signal combinations (src/ai/parser.test.ts)
- [x] `pickTasksToLaunch` — 10 tests covering concurrency, dedup, in-flight filtering (src/ai/executor.test.ts)
- [x] `isToolAllowed` + `getProviderPermissions` + `checkTaskPermissions` — permissions module (
      src/ai/permissions.test.ts)
- [x] All prompt builders — token replacement, noCommit variations, distinct outputs (src/ai/prompts/index.test.ts)
- [x] `parseEvaluationResult` + `getEvaluatorModel` — evaluator module (src/ai/evaluator.test.ts)
- [x] `evaluationIterations` config field — schema, store getter/setter, doctor check

### Coverage Gaps

- [ ] Interactive mode menu dispatch (indirect coverage via CLI tests is sufficient)
- [ ] Interactive flows (src/interactive/) - need mock prompts for direct testing
- [ ] Command handlers (src/commands/\*) - partial, mostly via integration tests

## Gotchas

- **Mocking node:os homedir for file I/O isolation**: Functions that read from `homedir()` (e.g.,
  `getProviderPermissions`
  reads `~/.claude/settings.json`) will pick up real user settings unless mocked. Use:

  ```typescript
  vi.mock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>();
    return { ...actual, homedir: () => join(actual.tmpdir(), 'fake-home-nonexistent') };
  });
  ```

  Then import the module under test AFTER the `vi.mock()` call (dynamic import after mock registration).

- **Template builder .replace() vs .replaceAll()**: `buildTaskExecutionPrompt` uses `.replace()` for
  `{{PROGRESS_FILE}}` so the second occurrence in the template remains unreplaced. Tests should not assert
  `findUnreplacedTokens(result) === []` for that builder — instead test that the first occurrence is replaced
  and document the known behavior. `{{CONTEXT_FILE}}` correctly uses `.replaceAll()`.

- **Optional boolean fields**: `ExecutionResult.verified` is `boolean | undefined` — when not set it is
  `undefined`, not `false`. Use `.toBeFalsy()` or `.not.toBe(true)` rather than `.toBe(false)`.
- **`pickTasksToLaunch` picks first-encountered per path**, not lowest `order` value. If callers need
  lowest-order semantics they must pre-sort `readyTasks` before calling. Tests must reflect this.
- **vitest globals are not ambient** — always import `{ describe, expect, it, vi, beforeEach, afterEach }`
  from `'vitest'` explicitly, even though `vitest.config.ts` has `globals: true` (tsc requires the imports).
- **`export` needed to test internal functions** — added `export` to `pickTasksToLaunch` in executor.ts to
  enable direct unit testing; the linter simultaneously added an optional `failedPaths` param.

## Test Conventions

1. **Descriptive names**: "puts dependencies before dependents" not "test case 2"
2. **Factory functions**: Create test data helpers
3. **Arrange-Act-Assert**: Clear structure in each test
4. **Error messages**: Test that errors contain helpful info
5. **Edge cases**: Empty arrays, cycles, missing data
