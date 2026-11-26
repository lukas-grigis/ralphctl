---
name: ralphctl-test-driven-development
description: Execute-phase skill — drive changes with the red-green-refactor loop; write the failing test before the code that makes it pass; for bug fixes, this is the reproduction test itself. Use for any logic change, bug fix, or behavioural modification; for the full root-cause triage pipeline around an unexpected failure, see ralphctl-debugging-and-error-recovery. Never ship the behavioural change alone.
license: MIT
---

# Test-Driven Development

> Concept from [Addy Osmani — "Test-Driven Development"](https://github.com/addyosmani/agent-skills)
> (agent-skills, MIT), with the tautological-assertion anti-pattern drawn from
> [mattpocock/skills](https://github.com/mattpocock/skills) (MIT). Adapted for ralphctl's execute phase.

Write a failing test before writing the code that makes it pass. For bug fixes, reproduce the bug with a
test before attempting a fix. Tests are proof — "seems right" is not done. A codebase with good tests is an
AI agent's superpower; a codebase without tests is a liability.

## When this applies

- **Execute** — any new logic, bug fix, or behavioural change. Follow the RED→GREEN→REFACTOR cycle for each
  unit of work. Run the project's narrow check after each step; signal the work complete once the task's
  acceptance criteria are met (generator role: a `task-complete` signal — the evaluator's contract has no
  `task-complete` schema). The harness runs the post-task verify gate — you do not own that verdict.

RED→GREEN covers the behaviour the task's steps and criteria ask to test, or that the project already tests for this kind of change. Otherwise drive the change with a scratch check you delete before finishing. As a reviewer, a missing test beyond the steps is an observation, not a FAIL.

**When NOT to use:** Pure configuration changes, documentation updates, or static content changes with no
behavioural impact.

## Discover the Stack First

The TDD cycle is universal; the commands are not. Before writing the first test, find out how _this_
repository tests, and use its commands for every RED, GREEN, and narrow-check step:

- **Commands the harness hands you** — the prompt's project-tooling or check-gate section, when present, is
  the authoritative source; prefer it over anything you infer.
- **Language and build system** — the dependency manifest or build file (`package.json`, `pom.xml` /
  `build.gradle`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, a `Makefile`).
- **Checked-in wrappers** — prefer a repo wrapper or script (`./gradlew`, `./mvnw`, a `Makefile` target) over
  a globally installed tool.
- **Test framework and configuration** — and how it runs a single focused test versus the full suite.
- **Existing conventions** — where tests live, how files are named, what patterns neighbouring tests follow.
- **Documented commands** — the project's AI context file, README, CONTRIBUTING, and CI workflows show the
  commands that actually gate merges.

Run the repository's focused-test command during the loop. Never assume a default test command from another
ecosystem — a Gradle, Cargo, or pytest project has its own equivalent.

The examples below use TypeScript for illustration; the workflow is identical in any language once you have
discovered the project's own tooling.

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

With tests green, improve the code without changing behaviour. Refactor only code this task wrote or changed, within the project's existing patterns:

- Extract shared logic
- Improve naming
- Remove duplication
- Optimise if necessary

Run the project's narrow check after every refactor step to confirm nothing broke.

## The Prove-It Pattern (Bug Fixes)

When the prompt carries a reproduction test, it is your RED — do not write a second one. In a reproduction-only session, stop at RED: no fix.

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

## Test Sizing and Writing Good Tests

Read `references/test-sizing.md` when deciding what level a test belongs at: the test pyramid, the small/medium/large resource model, and the unit/integration/E2E decision guide.

Read `references/writing-good-tests.md` when writing or reviewing a test's structure: state over interactions, DAMP over DRY, real implementations over mocks, Arrange-Act-Assert, one concept per test, and naming.

## Anti-Patterns to Avoid

| Anti-Pattern                          | Problem                                                     | Fix                                                                                                                         |
| ------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Testing implementation details        | Tests break when refactoring even if behaviour is unchanged | Test inputs and outputs, not internal structure                                                                             |
| Tautological assertions               | Recomputes the expected value the way the code does         | Expected values come from an independent source — a literal, a worked example, the spec — never the code's own formula      |
| Flaky tests (timing, order-dependent) | Erode trust in the test suite                               | Use deterministic assertions, isolate test state                                                                            |
| Testing framework code                | Wastes time testing third-party behaviour                   | Only test YOUR code                                                                                                         |
| Snapshot abuse                        | Large snapshots nobody reviews, break on any change         | Use snapshots sparingly and review every change                                                                             |
| No test isolation                     | Tests pass individually but fail together                   | Each test sets up and tears down its own state                                                                              |
| Horizontal slicing                    | Writing all the tests first, then all the code              | Work one vertical behaviour at a time: one RED, its GREEN, then the next                                                    |
| Mocking everything                    | Tests pass but production breaks                            | Prefer real implementations > fakes > stubs > mocks — mock only at boundaries where real deps are slow or non-deterministic |

## Common Rationalizations

| Rationalization                                    | Reality                                                                                                                             |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| "I'll write tests after the code works"            | You won't. And tests written after the fact test implementation, not behaviour.                                                     |
| "This is too simple to test"                       | Simple code gets complicated. The test documents the expected behaviour — when the task or project practice calls for a test.       |
| "Tests slow me down"                               | Tests slow you down now. They speed you up every time you change the code later.                                                    |
| "I tested it manually"                             | Manual testing does not persist. Tomorrow's change might break it with no way to know.                                              |
| "The code is self-explanatory"                     | Tests ARE the specification. They document what the code should do, not what it does.                                               |
| "It's just a prototype"                            | Prototypes become production code. Tests from day one prevent the "test debt" crisis.                                               |
| "Let me run the tests again just to be extra sure" | After a clean run, repeating the same command on unchanged code adds nothing. Run again after subsequent edits, not as reassurance. |

## Red Flags

- Writing behaviour the task asks to test without a test
- Reaching for a default test command without checking what this repository actually uses
- Tests that pass on the first run (they may not be testing what you think)
- An expected value computed with the code's own formula (`add(a, b)` checked against `a + b`) — it passes by
  construction
- "All tests pass" but no tests were actually run
- Bug fixes without a reproduction test
- Tests that verify framework behaviour instead of application behaviour
- Test names that do not describe the expected behaviour
- Skipping tests to make the suite pass
- Running the same test command twice in a row without any intervening code change

## Verification Checklist

Before you signal the work complete, confirm:

- [ ] Every behaviour the task's steps or criteria ask to test, or that the project tests for this kind of change, has a test.
- Run the project's narrow check (consult the project's AI context file — `CLAUDE.md`, `AGENTS.md`,
  or `.github/copilot-instructions.md` when present — for the exact test command) after each meaningful
  change; confirm it is green
- Bug fixes include a reproduction test that failed before the fix
- Test names describe the behaviour being verified
- No tests were skipped or disabled to achieve a passing run
- Coverage for the changed scope has not decreased (if tracked by the project)

The harness runs the post-task verify gate after you signal completion — incremental narrow checks
during the work are your responsibility; the final gate verdict is the harness's.
