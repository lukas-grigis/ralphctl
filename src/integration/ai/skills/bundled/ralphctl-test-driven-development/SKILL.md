---
name: ralphctl-test-driven-development
description: Execute-phase skill — write the failing test before the code that makes it pass; reproduce bugs with a test before fixing them. Use for any logic change, bug fix, or behavioural modification.
license: MIT
---

# Test-Driven Development

> Concept from [Addy Osmani — "Test-Driven Development"](https://github.com/addyosmani/agent-skills)
> (agent-skills, MIT). Adapted for ralphctl's execute phase.

Write a failing test before writing the code that makes it pass. For bug fixes, reproduce the bug with a
test before attempting a fix. Tests are proof — "seems right" is not done. A codebase with good tests is an
AI agent's superpower; a codebase without tests is a liability.

## When this applies

- **Execute** — any new logic, bug fix, or behavioural change. Follow the RED→GREEN→REFACTOR cycle for each
  unit of work. Run the project's narrow check after each step; emit `<task-complete>` once the task's
  acceptance criteria are met. The harness runs the post-task verify gate — you do not own that verdict.

**When NOT to use:** Pure configuration changes, documentation updates, or static content changes with no
behavioural impact.

## The TDD Cycle

```
    RED                GREEN              REFACTOR
 Write a test    Write minimal code    Clean up the
 that fails  ──→  to make it pass  ──→  implementation  ──→  (repeat)
      │                  │                    │
      ▼                  ▼                    ▼
   Test FAILS        Test PASSES         Tests still PASS
```

### Step 1: RED — Write a Failing Test

Write the test first. It must fail. A test that passes immediately proves nothing.

```typescript
// RED: This test fails because createTask doesn't exist yet
describe('TaskService', () => {
  it('creates a task with title and default status', async () => {
    const task = await taskService.createTask({ title: 'Buy groceries' });

    expect(task.id).toBeDefined();
    expect(task.title).toBe('Buy groceries');
    expect(task.status).toBe('pending');
    expect(task.createdAt).toBeInstanceOf(Date);
  });
});
```

### Step 2: GREEN — Make It Pass

Write the minimum code to make the test pass. Do not over-engineer:

```typescript
// GREEN: Minimal implementation
export async function createTask(input: { title: string }): Promise<Task> {
  const task = {
    id: generateId(),
    title: input.title,
    status: 'pending' as const,
    createdAt: new Date(),
  };
  await db.tasks.insert(task);
  return task;
}
```

### Step 3: REFACTOR — Clean Up

With tests green, improve the code without changing behaviour:

- Extract shared logic
- Improve naming
- Remove duplication
- Optimise if necessary

Run the project's narrow check after every refactor step to confirm nothing broke.

## The Prove-It Pattern (Bug Fixes)

When a bug is reported, **do not start by trying to fix it.** Start by writing a test that reproduces it.

```
Bug report arrives
       │
       ▼
  Write a test that demonstrates the bug
       │
       ▼
  Test FAILS (confirming the bug exists)
       │
       ▼
  Implement the fix
       │
       ▼
  Test PASSES (proving the fix works)
       │
       ▼
  Run the project's narrow check (no regressions in the affected scope)
```

**Example:**

```typescript
// Bug: "Completing a task doesn't update the completedAt timestamp"

// Step 1: Write the reproduction test (it should FAIL)
it('sets completedAt when task is completed', async () => {
  const task = await taskService.createTask({ title: 'Test' });
  const completed = await taskService.completeTask(task.id);

  expect(completed.status).toBe('completed');
  expect(completed.completedAt).toBeInstanceOf(Date); // This fails → bug confirmed
});

// Step 2: Fix the bug
export async function completeTask(id: string): Promise<Task> {
  return db.tasks.update(id, {
    status: 'completed',
    completedAt: new Date(), // This was missing
  });
}

// Step 3: Test passes → bug fixed, regression guarded
```

## The Test Pyramid

Invest testing effort according to the pyramid — most tests should be small and fast, with progressively
fewer tests at higher levels:

```
          ╱╲
         ╱  ╲         E2E Tests (~5%)
        ╱    ╲        Full user flows, real system
       ╱──────╲
      ╱        ╲      Integration Tests (~15%)
     ╱          ╲     Component interactions, API boundaries
    ╱────────────╲
   ╱              ╲   Unit Tests (~80%)
  ╱                ╲  Pure logic, isolated, milliseconds each
 ╱──────────────────╲
```

**The Beyoncé Rule:** If you liked it, you should have put a test on it. Infrastructure changes,
refactoring, and migrations are not responsible for catching your bugs — your tests are. If a change
breaks your code and you did not have a test for it, that is on you.

### Test Sizes (Resource Model)

Beyond the pyramid levels, classify tests by what resources they consume:

| Size       | Constraints                                            | Speed        | Example                                 |
| ---------- | ------------------------------------------------------ | ------------ | --------------------------------------- |
| **Small**  | Single process, no I/O, no network, no database        | Milliseconds | Pure function tests, data transforms    |
| **Medium** | Multi-process OK, localhost only, no external services | Seconds      | API tests with test DB, component tests |
| **Large**  | Multi-machine OK, external services allowed            | Minutes      | E2E tests, performance benchmarks       |

Small tests should make up the vast majority of your suite. They are fast, reliable, and easy to debug
when they fail.

### Decision Guide

```
Is it pure logic with no side effects?
  → Unit test (small)

Does it cross a boundary (API, database, file system)?
  → Integration test (medium)

Is it a critical user flow that must work end-to-end?
  → E2E test (large) — limit these to critical paths
```

## Writing Good Tests

### Test State, Not Interactions

Assert on the _outcome_ of an operation, not on which methods were called internally. Tests that verify
method call sequences break when you refactor, even if the behaviour is unchanged.

```typescript
// Good: Tests what the function does (state-based)
it('returns tasks sorted by creation date, newest first', async () => {
  const tasks = await listTasks({ sortBy: 'createdAt', sortOrder: 'desc' });
  expect(tasks[0].createdAt.getTime()).toBeGreaterThan(tasks[1].createdAt.getTime());
});

// Bad: Tests how the function works internally (interaction-based)
it('calls db.query with ORDER BY created_at DESC', async () => {
  await listTasks({ sortBy: 'createdAt', sortOrder: 'desc' });
  expect(db.query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY created_at DESC'));
});
```

### DAMP Over DRY in Tests

In production code, DRY (Don't Repeat Yourself) is usually right. In tests, **DAMP (Descriptive And
Meaningful Phrases)** is better. A test should read like a specification — each test should tell a
complete story without requiring the reader to trace through shared helpers.

```typescript
// DAMP: Each test is self-contained and readable
it('rejects tasks with empty titles', () => {
  const input = { title: '', assignee: 'user-1' };
  expect(() => createTask(input)).toThrow('Title is required');
});

it('trims whitespace from titles', () => {
  const input = { title: '  Buy groceries  ', assignee: 'user-1' };
  const task = createTask(input);
  expect(task.title).toBe('Buy groceries');
});

// Over-DRY: Shared setup obscures what each test actually verifies
// (Do not do this just to avoid repeating the input shape)
```

Duplication in tests is acceptable when it makes each test independently understandable.

### Prefer Real Implementations Over Mocks

Use the simplest test double that gets the job done. The more your tests use real code, the more
confidence they provide.

```
Preference order (most to least preferred):
1. Real implementation  → Highest confidence, catches real bugs
2. Fake                 → In-memory version of a dependency (e.g., fake DB)
3. Stub                 → Returns canned data, no behaviour
4. Mock (interaction)   → Verifies method calls — use sparingly
```

Use mocks only when the real implementation is too slow, non-deterministic, or has side effects you
cannot control (external APIs, email sending). Over-mocking creates tests that pass while production
breaks.

### Use the Arrange-Act-Assert Pattern

```typescript
it('marks overdue tasks when deadline has passed', () => {
  // Arrange: Set up the test scenario
  const task = createTask({
    title: 'Test',
    deadline: new Date('2025-01-01'),
  });

  // Act: Perform the action being tested
  const result = checkOverdue(task, new Date('2025-01-02'));

  // Assert: Verify the outcome
  expect(result.isOverdue).toBe(true);
});
```

### One Assertion Per Concept

```typescript
// Good: Each test verifies one behaviour
it('rejects empty titles', () => { ... });
it('trims whitespace from titles', () => { ... });
it('enforces maximum title length', () => { ... });

// Bad: Everything in one test
it('validates titles correctly', () => {
  expect(() => createTask({ title: '' })).toThrow();
  expect(createTask({ title: '  hello  ' }).title).toBe('hello');
  expect(() => createTask({ title: 'a'.repeat(256) })).toThrow();
});
```

### Name Tests Descriptively

```typescript
// Good: Reads like a specification
describe('TaskService.completeTask', () => {
  it('sets status to completed and records timestamp', ...);
  it('throws NotFoundError for non-existent task', ...);
  it('is idempotent — completing an already-completed task is a no-op', ...);
  it('sends notification to task assignee', ...);
});

// Bad: Vague names
describe('TaskService', () => {
  it('works', ...);
  it('handles errors', ...);
  it('test 3', ...);
});
```

## Anti-Patterns to Avoid

| Anti-Pattern                          | Problem                                                     | Fix                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Testing implementation details        | Tests break when refactoring even if behaviour is unchanged | Test inputs and outputs, not internal structure                                                                             |
| Flaky tests (timing, order-dependent) | Erode trust in the test suite                               | Use deterministic assertions, isolate test state                                                                            |
| Testing framework code                | Wastes time testing third-party behaviour                   | Only test YOUR code                                                                                                         |
| Snapshot abuse                        | Large snapshots nobody reviews, break on any change         | Use snapshots sparingly and review every change                                                                             |
| No test isolation                     | Tests pass individually but fail together                   | Each test sets up and tears down its own state                                                                              |
| Mocking everything                    | Tests pass but production breaks                            | Prefer real implementations > fakes > stubs > mocks — mock only at boundaries where real deps are slow or non-deterministic |

## Common Rationalizations

| Rationalization                                    | Reality                                                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| "I'll write tests after the code works"            | You won't. And tests written after the fact test implementation, not behaviour.                                                     |
| "This is too simple to test"                       | Simple code gets complicated. The test documents the expected behaviour.                                                            |
| "Tests slow me down"                               | Tests slow you down now. They speed you up every time you change the code later.                                                    |
| "I tested it manually"                             | Manual testing does not persist. Tomorrow's change might break it with no way to know.                                              |
| "The code is self-explanatory"                     | Tests ARE the specification. They document what the code should do, not what it does.                                               |
| "It's just a prototype"                            | Prototypes become production code. Tests from day one prevent the "test debt" crisis.                                               |
| "Let me run the tests again just to be extra sure" | After a clean run, repeating the same command on unchanged code adds nothing. Run again after subsequent edits, not as reassurance. |

## Red Flags

- Writing code without any corresponding tests
- Tests that pass on the first run (they may not be testing what you think)
- "All tests pass" but no tests were actually run
- Bug fixes without a reproduction test
- Tests that verify framework behaviour instead of application behaviour
- Test names that do not describe the expected behaviour
- Skipping tests to make the suite pass
- Running the same test command twice in a row without any intervening code change

## Verification Checklist

Before emitting `<task-complete>`, confirm:

- Every new behaviour introduced by this task has a corresponding test
- Run the project's narrow check (consult the project's AI context file — `CLAUDE.md`, `AGENTS.md`,
  or `.github/copilot-instructions.md` when present — for the exact test command) after each meaningful
  change; confirm it is green
- Bug fixes include a reproduction test that failed before the fix
- Test names describe the behaviour being verified
- No tests were skipped or disabled to achieve a passing run
- Coverage for the changed scope has not decreased (if tracked by the project)

The harness runs the post-task verify gate after you signal completion — incremental narrow checks
during the work are your responsibility; the final gate verdict is the harness's.
