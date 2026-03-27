## Project Resources (instruction files and `.claude/` directory)

Each repository may have project-specific instruction files and a `.claude/` directory. Check them during exploration
and
leverage them throughout planning:

- **`CLAUDE.md`** — Project-level rules, conventions, and persistent memory
- **`.github/copilot-instructions.md`** — GitHub Copilot-specific repository instructions, if present
- **`agents/`** — Specialized agent definitions for Task tool delegation (architecture, testing, domain tasks)
- **`commands/`** — Custom slash commands (skills) — invoke with the Skill tool for project-specific workflows
- **`rules/`** — Project-specific rules and constraints that apply to all work
- **`memory/`** — Persistent learnings from previous sessions — consult for patterns and decisions
- **`settings.json` / `settings.local.json`** — Tool permissions, model preferences, hooks

If repository instruction files exist (`CLAUDE.md`, `.github/copilot-instructions.md`), treat their instructions as
authoritative for that codebase.

## What Makes a Great Task

A great task can be picked up cold, implemented independently, and verified as done. Before finalizing any task, ask:
**"How will I know this task is done?"** — if the answer is vague, the task needs work.

Every task must have:

- **Clear scope** — Which files/modules change, and what the outcome looks like
- **Verifiable result** — Can be checked with tests, type checks, or other project commands
- **Independence** — Can be implemented without waiting on other tasks (unless explicitly declared via `blockedBy`)

### Task Sizing

Completable in a single AI session: 1-3 primary files (up to 5-7 total with tests), ~50-200 lines of meaningful
changes, one logical change per task. Split if too large, merge if too small.

**TOO GRANULAR (avoid):**

- "Create date formatting utility"
- "Refactor experience module to use date utility"
- "Refactor certifications module to use date utility"

**CORRECT SIZE (prefer):**

- "Centralize date formatting across all sections" — creates utility AND updates all usages
- "Improve style robustness in interactive components" — handles multiple related files

### Rules

1. **Outcome-oriented** — Each task delivers a testable result
2. **Merge create+use** — Never separate "create X" from "use X" — that is one task
3. **Target 5-15 tasks** per scope, not 20-30 micro-tasks
4. **No artificial splits** — If tasks only make sense in sequence, merge them

### Anti-patterns

- Separate tasks for "create utility" and "integrate utility"
- One task per file modification
- Tasks that are "blocked by" the previous task for trivial reasons
- Micro-refactoring tasks (add directive, remove import, etc.)

## Non-Overlapping File Ownership

**Each task must own its files exclusively.** Before finalizing:

1. **List files per task** — Write down which files each task creates or modifies
2. **Check for overlap** — If two tasks touch the same file, either merge them or clearly delineate which
   sections/functions each owns (document in steps)
3. **Check for concept overlap** — If two tasks involve the same abstraction (e.g., both deal with "error handling"),
   merge or split cleanly by concern

**Overlap test**: Could task B's implementation conflict with or undo task A's work? If yes, restructure.

## Dependency Graph

Tasks execute in dependency order — foundations before dependents.

### Rules

1. **Foundation first** — Shared utilities, types, schemas before anything that uses them
2. **Declare all dependencies** — Use `blockedBy` to enforce order. Do not rely on array position alone.
3. **Maximize parallelism** — Only add `blockedBy` when there is a real code dependency
4. **Validate the DAG** — No cycles; earlier tasks cannot depend on later ones

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

**Dependency test**: For each `blockedBy` entry, ask: "Does this task literally use code produced by the blocker?" If
not, remove the dependency.

## Task Repository Assignment

Each task must specify which repository it executes in via `projectPath`:

1. **One repo per task** — Each task runs in exactly one repository directory
2. **Split by repo** — If a ticket affects multiple repos, create separate tasks per repo with dependencies
3. **Use exact paths** — `projectPath` must be one of the absolute paths from the project's Repositories section

Never create a task that modifies files in multiple repos — split it.

## Precise Step Declarations

Every task must include explicit, actionable steps — the implementation checklist.

### Step Requirements

1. **Specific file references** — Name exact files/directories to create or modify
2. **Concrete actions** — "Add function X to file Y", not "implement the feature"
3. **Verification included** — Last step(s) should include project-specific verification commands from the repository
   instruction files
4. **No ambiguity** — Another developer should be able to follow steps without guessing

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

Use actual file paths discovered during exploration. Reference the repository instruction files for verification
commands.

## Task Naming

Start with an action verb (Add, Create, Update, Fix, Refactor, Remove, Migrate). Include the feature/concept, not files.
Keep under 60 characters. Avoid vague verbs (Improve, Enhance, Handle).
