## Task Sizing Philosophy

Think of tasks as **features or outcomes**, not implementation steps.

### Sizing Heuristics

A well-sized task should be completable in a single Claude session:

- **Files**: Typically touches 3-7 files (fewer = might be too small, more = might need splitting)
- **Scope**: One logical change (a feature, a refactor, a fix) - not multiple unrelated changes
- **Verification**: Can be verified with the project's standard commands (from CLAUDE.md)

If a task seems too large, split by concern. If too small, merge with related work.

### Examples

**TOO GRANULAR (avoid):**

- "Create date formatting utility"
- "Refactor experience module to use date utility"
- "Refactor certifications module to use date utility"
- "Add style fallbacks in one component"

**CORRECT SIZE (prefer):**

- "Centralize date formatting across all sections" - creates utility AND updates all usages
- "Improve style robustness in interactive components" - handles multiple related files

### Rules

1. **Outcome-oriented**: Each task delivers a testable, demonstrable result
2. **Merge create+use**: Never separate "create X" from "use X" - that's one task
3. **Target count**: Aim for 5-15 tasks per scope, not 20-30 micro-tasks
4. **Logical grouping**: A task can touch 5-10 files if they share a theme
5. **No artificial splits**: If tasks only make sense in sequence, merge them

### Anti-patterns

- Separate tasks for "create utility" and "integrate utility"
- One task per file modification
- Tasks that are "blocked by" the previous task for trivial reasons
- Micro-refactoring tasks (add directive, remove import, etc.)

### Good patterns

- "Implement feature X with tests" (not: create, then test separately)
- "Refactor animation system" (touches multiple files, one theme)
- "Add i18n support to date displays" (create helper + update all usages)

## Critical: Non-Overlapping Tasks

**Each task MUST be completely independent in scope.** Before finalizing:

1. **Check for file overlap** - If two tasks touch the same file, merge them or clearly delineate which parts each task handles
2. **Check for concept overlap** - If two tasks involve the same abstraction (e.g., both deal with "error handling"), merge or split cleanly by concern
3. **No duplicate work** - Never have two tasks that could reasonably step on each other's changes

**Overlap test**: Could task B's implementation conflict with or undo task A's work? If yes, restructure.

## Critical: Execution Order via Dependencies

Tasks execute in dependency order. Plan the sequence explicitly:

1. **Foundation first** - Tasks that create shared utilities, types, or infrastructure must come before tasks that use them
2. **Declare all dependencies** - Use `blockedBy` to enforce correct order
3. **Validate the DAG** - The dependency graph must be acyclic; earlier tasks cannot depend on later ones

**Ordering principle**: When reviewing your task list, read it top to bottom. Ask: "Can I implement task N without any output from tasks N+1, N+2, ...?" If no, reorder.

### Dependency Examples

Give each task an `id` field, then reference those IDs in `blockedBy`:

```json
[
  { "id": "1", "name": "Add shared validation utilities", "projectPath": "/Users/dev/my-app" },
  { "id": "2", "name": "Implement user registration form", "projectPath": "/Users/dev/my-app", "blockedBy": ["1"] },
  { "id": "3", "name": "Implement user profile editor", "projectPath": "/Users/dev/my-app", "blockedBy": ["1"] },
  { "id": "4", "name": "Add form submission analytics", "projectPath": "/Users/dev/my-app", "blockedBy": ["2", "3"] }
]
```

Tasks 2 and 3 can run in parallel (both depend on 1). Task 4 waits for both 2 and 3.

## Critical: Task Repository Assignment

Each task MUST specify which repository it executes in via `projectPath`.

### Rules

1. **One repo per task** - Each task runs in exactly one repository directory
2. **Split by repo** - If a ticket affects multiple repos, create separate tasks per repo with proper dependencies
3. **Use exact paths** - The `projectPath` must be one of the absolute paths listed in the project's Repositories section

### Multi-Repo Example

Ticket: "Add user notifications"
**Affected Repositories:** commons, web-ui-v2

Project repositories:

- **commons**: `/Users/dev/blinced/commons`
- **web-ui-v2**: `/Users/dev/blinced/web-ui-v2`

Tasks should be split by repo:

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

**Never** create a task that needs to modify files in multiple repos - split it.

## Critical: Precise Step Declarations

Every task MUST include explicit, actionable steps. Steps are the implementation checklist.

### Step Requirements

1. **Specific file references** - Name exact files/directories to create or modify
2. **Concrete actions** - "Add function X to file Y", not "implement the feature"
3. **Verification included** - Last step(s) should include project-specific verification commands from CLAUDE.md
4. **No ambiguity** - Another developer should be able to follow steps without guessing

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
    "Create auth service in src/services/ with login(), logout(), getCurrentUser()",
    "Add auth context/provider wrapping the app",
    "Create useAuth hook exposing auth state and actions",
    "Add protected route wrapper component",
    "Write unit tests for auth service",
    "Run verification commands from CLAUDE.md - all pass"
  ]
}
```

**Important**:

- Use actual file paths discovered during exploration
- Only include verification steps for commands that exist in the project (e.g., a Java project won't have lint/typecheck but will have build/test; a Python project might use ruff/pytest)
- Reference CLAUDE.md for the exact verification commands to use

## Task Naming

- Start with an action verb: Add, Create, Update, Fix, Refactor, Remove, Migrate
- Include the feature/concept, not just files: "Add user authentication" not "Update auth files"
- Keep under 60 characters
- Avoid vague verbs: "Improve", "Enhance", "Handle"
