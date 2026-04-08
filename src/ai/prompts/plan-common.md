## Project Resources (instruction files and `.claude/` directory)

Each repository may have project-specific instruction files and a `.claude/` directory. Check them during exploration and
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

A great task can be picked up cold by an AI agent, implemented independently, and verified as done — by a _different_ AI
agent (the evaluator). The litmus test: "Could an independent reviewer verify this task is done using only the
verification criteria and the codebase?" If not, the task needs work.

<task-qualities>

- **Clear scope** — which files/modules change, and what the outcome looks like
- **Verifiable result** — can be checked with tests, type checks, or other project commands
- **Independence** — can be implemented without waiting on other tasks (unless explicitly declared via `blockedBy`)
- **Pattern reference** — steps reference existing similar code the agent should follow (feedforward guidance)

</task-qualities>

### Task Sizing

Completable in a single AI session: 1-3 primary files (up to 5-7 total with tests), ~50-200 lines of meaningful
changes, one logical change per task. Split if too large, merge if too small.

Too granular (three tasks that should be one):

- "Create date formatting utility"
- "Refactor experience module to use date utility"
- "Refactor certifications module to use date utility"

Right size (one task covering the full change):

- "Centralize date formatting across all sections" — creates utility AND updates all usages
- "Improve style robustness in interactive components" — handles multiple related files

### Verification Criteria (The Evaluator Contract)

Every task must include a `verificationCriteria` array — these are the **done contract** between the generator (task
executor) and the evaluator (independent reviewer). The evaluator grades each criterion as pass/fail across four
dimensions: correctness, completeness, safety, and consistency. If ANY criterion fails, the task fails evaluation and
the generator receives specific feedback to fix.

Write criteria that are:

- **Computationally verifiable** where possible — prefer "TypeScript compiles with no errors" over "code is well-typed"
- **Observable** — the evaluator must be able to check it by running commands or reading code
- **Unambiguous** — two reviewers would agree on pass/fail
- **Outcome-oriented** — describe WHAT is true when done, not HOW to get there

> **Good criteria (verifiable, unambiguous):**
>
> - "TypeScript compiles with no errors"
> - "All existing tests pass plus new tests for the added feature"
> - "GET /api/users returns 200 with paginated user list"
> - "GET /api/users?page=-1 returns 400 with validation error"
> - "Component renders without console errors in browser"
> - "Playwright e2e: login flow completes without errors" _(UI tasks with Playwright configured)_

> **Bad criteria (vague, not independently verifiable):**
>
> - "Code is clean and well-structured"
> - "Error handling is appropriate"
> - "Performance is acceptable"

Aim for 2-4 criteria per task. Include at least one criterion that is computationally checkable (test pass, type check,
lint clean). For **UI/frontend tasks**, if the project has Playwright configured, add a browser-verifiable criterion —
the evaluator will attempt visual verification using Playwright or browser tools when the project supports it.

### Guidelines

1. **Outcome-oriented** — Each task delivers a testable result
2. **Merge create+use** — Never separate "create X" from "use X" — that is one task
3. **Target 5-15 tasks** per scope, not 20-30 micro-tasks
4. **No artificial splits** — If tasks only make sense in sequence, merge them

### Anti-Patterns

- Separate tasks for "create utility" and "integrate utility" — always merge create+use
- One task per file modification — group by logical change, not by file
- Tasks that are "blocked by" the previous task for trivial reasons — false chains kill parallelism
- Micro-refactoring tasks (add directive, remove import, etc.) — fold into the task that needs them

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

### Guidelines

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
3. **Pattern references** — When possible, point to existing code the agent should follow: "Follow the pattern in
   `src/controllers/users.ts` for error handling and response format." This is feedforward guidance — it steers the
   agent toward correct behavior before it starts.
4. **Verification included** — Last step(s) should include project-specific verification commands from the repository
   instruction files
5. **No ambiguity** — Another developer should be able to follow steps without guessing

Bad — vague steps that force the agent to guess:

```json
{
  "name": "Add user authentication",
  "steps": ["Implement auth", "Add tests", "Update docs"]
}
```

Good — precise steps with file paths and pattern references:

```json
{
  "name": "Add user authentication",
  "projectPath": "/Users/dev/my-app",
  "steps": [
    "Create auth service in src/services/auth.ts with login(), logout(), getCurrentUser() — follow the pattern in src/services/user.ts for error handling and return types",
    "Add AuthContext provider in src/contexts/AuthContext.tsx wrapping the app — follow existing ThemeContext pattern",
    "Create useAuth hook in src/hooks/useAuth.ts exposing auth state and actions",
    "Add ProtectedRoute wrapper component in src/components/ProtectedRoute.tsx",
    "Write unit tests in src/services/__tests__/auth.test.ts — follow test patterns in src/services/__tests__/user.test.ts",
    "Run pnpm typecheck && pnpm lint && pnpm test — all pass"
  ],
  "verificationCriteria": [
    "TypeScript compiles with no errors",
    "All existing tests pass plus new auth tests",
    "ProtectedRoute redirects unauthenticated users to /login",
    "useAuth hook exposes isAuthenticated, user, login, and logout"
  ]
}
```

Use actual file paths discovered during exploration. Reference the repository instruction files for verification
commands.

## Task Naming

Start with an action verb (Add, Create, Update, Fix, Refactor, Remove, Migrate). Include the feature/concept, not files.
Keep under 60 characters. Avoid vague verbs (Improve, Enhance, Handle).

## Delegation to Available Tooling

The "Project Tooling" section below (when present) lists subagents, skills, and MCP servers detected in the target
repositories. Use these in your task planning:

- **Surface tool delegation in task steps.** When a step's nature matches an available tool's specialization, write
  the step so the executor knows to delegate. For example, if the tooling section lists a subagent specialized in
  security review, security-sensitive task steps should explicitly recommend invoking it via the Task tool. Generic
  pseudo-step: _"Delegate the final review of authentication changes to the `<name>` subagent via the Task tool."_
- **Pull verification criteria from available tools.** UI tasks should add browser-verifiable criteria when a
  Playwright or similar MCP is listed. Database tasks should reference DB-inspection MCPs when present.
- **Do not invent tools.** Only reference tools that actually appear in the Project Tooling section. If the section is
  empty or absent, omit delegation recommendations entirely — do not fabricate subagent names.

{{PROJECT_TOOLING}}
