## What Makes a Great Task

A great task is one that a developer (or Claude) can pick up cold, implement independently, and verify is done. Each
task should read like a mini-spec with a clear finish line.

### The Done Test

Before finalizing a task, ask: **"How will I know this task is done?"** If the answer is vague ("it works") or depends
on another task ("once task 3 finishes"), the task needs work.

Every task must have:

- **Clear scope** — Which files/modules change, and what the outcome looks like
- **Verifiable result** — Can be checked with tests, type checks, or other project commands
- **Independence** — Can be implemented without waiting on other tasks (unless explicitly declared via `blockedBy`)

### Task Sizing

Each task should be completable in a single Claude session:

- **Files**: 1-3 primary files changed, up to 5-7 total (including tests)
- **Lines**: Roughly 50-200 lines of meaningful changes
- **Scope**: One logical change — a feature, a refactor, a fix — not multiple unrelated changes
- **Verification**: Can be verified with the project's standard commands

If a task exceeds these bounds, split by concern. If it falls well below, merge with related work.

### Examples

**TOO GRANULAR (avoid):**

- "Create date formatting utility"
- "Refactor experience module to use date utility"
- "Refactor certifications module to use date utility"

**CORRECT SIZE (prefer):**

- "Centralize date formatting across all sections" — creates utility AND updates all usages
- "Improve style robustness in interactive components" — handles multiple related files

### Rules

1. **Outcome-oriented**: Each task delivers a testable, demonstrable result
2. **Merge create+use**: Never separate "create X" from "use X" — that is one task
3. **Target count**: Aim for 5-15 tasks per scope, not 20-30 micro-tasks
4. **Logical grouping**: A task can touch 5-7 files if they share a theme
5. **No artificial splits**: If tasks only make sense in sequence, merge them

### Anti-patterns

- Separate tasks for "create utility" and "integrate utility"
- One task per file modification
- Tasks that are "blocked by" the previous task for trivial reasons
- Micro-refactoring tasks (add directive, remove import, etc.)

## Non-Overlapping File Ownership

**Each task MUST own its files exclusively.** Before finalizing:

1. **List files per task** — Write down which files each task creates or modifies
2. **Check for overlap** — If two tasks touch the same file, either:
   - Merge the tasks, or
   - Clearly delineate which sections/functions each task owns (document in steps)
3. **Check for concept overlap** — If two tasks involve the same abstraction (e.g., both deal with "error handling"),
   merge or split cleanly by concern

**Overlap test**: Could task B's implementation conflict with or undo task A's work? If yes, restructure.

## Dependency Graph

Tasks execute in dependency order. The ordering must reflect the **logical build order** — what needs to exist before
the next thing can be built on top of it.

### Rules

1. **Foundation first** — Shared utilities, types, schemas, or infrastructure before anything that uses them
2. **Declare all dependencies** — Use `blockedBy` to enforce correct order. Do not rely on array position alone.
3. **Maximize parallelism** — Independent tasks should NOT block each other. Only add `blockedBy` when there is a real
   data or code dependency.
4. **Validate the DAG** — The dependency graph must be acyclic; earlier tasks cannot depend on later ones

### Good Dependency Graph

```
Task 1: Add shared validation utilities       (no deps)
Task 2: Implement user registration form       (blockedBy: [1])
Task 3: Implement user profile editor          (blockedBy: [1])
Task 4: Add form submission analytics          (blockedBy: [2, 3])
```

Tasks 2 and 3 run in parallel (both depend only on 1). Task 4 waits for both.

### Bad Dependency Graph

```
Task 1: Add validation utilities               (no deps)
Task 2: Implement registration form            (blockedBy: [1])
Task 3: Implement profile editor               (blockedBy: [2])  <-- WRONG
Task 4: Add submission analytics               (blockedBy: [3])  <-- WRONG
```

Task 3 does not actually need Task 2 — it only needs Task 1. This creates a false serial chain that prevents parallel
execution.

**Dependency test**: For each `blockedBy` entry, ask: "Does this task literally use code or state produced by the
blocker?" If not, remove the dependency.

## Task Repository Assignment

Each task MUST specify which repository it executes in via `projectPath`.

### Rules

1. **One repo per task** — Each task runs in exactly one repository directory
2. **Split by repo** — If a ticket affects multiple repos, create separate tasks per repo with proper dependencies
3. **Use exact paths** — The `projectPath` must be one of the absolute paths listed in the project's Repositories
   section

### Multi-Repo Example

Ticket: "Add user notifications"
Project repositories: commons (`/Users/dev/blinced/commons`), web-ui-v2 (`/Users/dev/blinced/web-ui-v2`)

```json
[
  {
    "id": "1",
    "name": "Add notification types to commons",
    "projectPath": "/Users/dev/blinced/commons",
    "steps": ["Create NotificationType enum in commons/messaging/..."]
  },
  {
    "id": "2",
    "name": "Implement notification UI in web-ui",
    "projectPath": "/Users/dev/blinced/web-ui-v2",
    "blockedBy": ["1"],
    "steps": ["Import types from commons", "Add notification component"]
  }
]
```

**Never** create a task that needs to modify files in multiple repos — split it.

## Precise Step Declarations

Every task MUST include explicit, actionable steps. Steps are the implementation checklist.

### Step Requirements

1. **Specific file references** — Name exact files/directories to create or modify
2. **Concrete actions** — "Add function X to file Y", not "implement the feature"
3. **Verification included** — Last step(s) should include project-specific verification commands from CLAUDE.md
4. **No ambiguity** — Another developer should be able to follow steps without guessing

### Step Examples

**BAD (vague):**

```json
{
  "name": "Add user authentication",
  "steps": ["Implement auth", "Add tests", "Update docs"]
}
```

**GOOD (precise):**

```json
{
  "name": "Add user authentication",
  "projectPath": "/Users/dev/my-app",
  "steps": [
    "Create auth service in src/services/auth.ts with login(), logout(), getCurrentUser()",
    "Add AuthContext provider in src/contexts/AuthContext.tsx wrapping the app",
    "Create useAuth hook in src/hooks/useAuth.ts exposing auth state and actions",
    "Add ProtectedRoute wrapper component in src/components/ProtectedRoute.tsx",
    "Write unit tests in src/services/__tests__/auth.test.ts",
    "Run pnpm typecheck && pnpm lint && pnpm test — all pass"
  ]
}
```

**Important**:

- Use actual file paths discovered during exploration
- Only include verification steps for commands that exist in the project
- Reference CLAUDE.md for the exact verification commands to use

## Task Naming

- Start with an action verb: Add, Create, Update, Fix, Refactor, Remove, Migrate
- Include the feature/concept, not just files: "Add user authentication" not "Update auth files"
- Keep under 60 characters
- Avoid vague verbs: "Improve", "Enhance", "Handle"
