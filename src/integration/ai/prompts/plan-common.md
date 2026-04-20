## Project Resources

During exploration, check for project instruction files if present. Treat whichever files exist as authoritative for
that codebase; skip silently when absent.

**Instruction files (any ecosystem):**

- **`CLAUDE.md` / `AGENTS.md`** — when present: project-level rules, conventions, and persistent memory
- **`.github/copilot-instructions.md`** — when present: GitHub Copilot-specific repository instructions
- **`README.md`** and manifest files (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml`, …) — setup,
  scripts, and dependencies

**Claude-specific configuration (only when the repo has a `.claude/` directory):**

- **`.mcp.json`** — MCP servers the project ships with (Playwright, database inspection, etc.)
- **`.claude/agents/`** — subagent definitions for Task-tool delegation
- **`.claude/skills/`** — custom skills invokable with the Skill tool for project-specific workflows
- **`.claude/settings.json`** / **`.claude/settings.local.json`** — tool permissions, model preferences, hooks

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

The unit is **one coherent feature or vertical slice** — a change that can be picked up cold, implemented in a single
session, and verified end-to-end against its criteria. Size is driven by coherence, not line count. Modern agents are
capable; artificial fragmentation creates serial chains, duplicate context reloads, and merge conflicts that cost far
more than they save.

**Do not split when:**

- A utility and its first caller would be separated — create-and-use is always one task
- A feature and its tests would be separated
- The same pattern applies across N call sites — it is one refactor, not N tasks

**Do split when:**

- Two chunks can run in parallel (different `projectPath`, or independent files with no shared contract)
- A clean, verifiable boundary exists partway through (e.g. schema + migration land first, then consumer wiring — the
  schema is independently testable and unblocks parallel consumers)
- The change spans multiple repositories — one task per repo, connected via `blockedBy`

**Soft ceiling, not a target:** if a task looks like it will touch more than ~10 files or ~500 lines of meaningful
change AND a natural split point exists, split it. No natural split point? Keep it whole.

Too granular (one task, not three):

- "Create date formatting utility"
- "Refactor experience module to use date utility"
- "Refactor certifications module to use date utility"

Right size (one task covering the full change):

- "Centralize date formatting across all sections" — creates utility AND updates all usages
- "Improve style robustness in interactive components" — handles multiple related files

### Verification Criteria (The Evaluator Contract)

_See the `<examples>` block at the end of this page for good/bad pairs._

Every task must include a `verificationCriteria` array — these are the **done contract** between the generator (task
executor) and the evaluator (independent reviewer). The evaluator grades each criterion as pass/fail across four
floor dimensions: correctness, completeness, safety, and consistency. If ANY dimension fails, the task fails
evaluation and the generator receives specific feedback to fix.

#### Optional: Extra Evaluator Dimensions (`extraDimensions`)

The four floor dimensions apply to every task. When a task has a non-default success criterion that the floor
dimensions do not capture cleanly — e.g. perf-sensitive work, UI/accessibility, schema migration safety,
security-critical changes — emit `extraDimensions: ["Name"]` on that task. The evaluator will grade those names
on top of the floor.

Use sparingly — most tasks need no extras. Pick PascalCase names the evaluator can interpret directly (e.g.
`"Performance"`, `"Accessibility"`, `"MigrationSafety"`, `"BackwardCompatibility"`). Omit the field when
floor-only is enough.

Write criteria that are:

- **Computationally verifiable** where possible — prefer "TypeScript compiles with no errors" over "code is well-typed"
- **Observable** — the evaluator must be able to check it by running commands or reading code
- **Unambiguous** — two reviewers would agree on pass/fail
- **Outcome-oriented** — describe WHAT is true when done, not HOW to get there

Aim for 2-4 criteria per task. Include at least one criterion that is computationally checkable (test pass, type check,
lint clean). For **UI/frontend tasks**, if the project has Playwright configured, add a browser-verifiable criterion —
the evaluator will attempt visual verification using Playwright or browser tools when the project supports it.

### Guidelines

1. **Outcome-oriented** — Each task delivers a testable result
2. **Merge create+use** — Keep "create X" and "use X" in one task — except when a stable contract makes them
   independently testable (e.g. schema + migration lands first, consumer wiring lands after)
3. **Let scope drive task count** — do not aim for a specific number. Fewer, larger coherent tasks beat many
   micro-tasks; split only when parallelism or a clean boundary justifies it
4. **Merge serial chains** — If tasks only make sense when run in sequence, fold them into one task

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

_See the `<examples>` block at the end of this page for good/bad pairs._

Tasks execute in dependency order — foundations before dependents.

### Guidelines

1. **Foundation first** — Shared utilities, types, schemas before anything that uses them
2. **Declare all dependencies** — Use `blockedBy` to enforce order. Do not rely on array position alone.
3. **Maximize parallelism** — Only add `blockedBy` when there is a real code dependency
4. **Validate the DAG** — No cycles; earlier tasks cannot depend on later ones

**Dependency test**: For each `blockedBy` entry, ask: "Does this task literally use code produced by the blocker?" If
not, remove the dependency.

## Task Repository Assignment

Each task must specify which repository it executes in via `projectPath`:

1. **One repo per task** — Each task runs in exactly one repository directory
2. **Split by repo** — If a ticket affects multiple repos, create separate tasks per repo with dependencies
3. **Use exact paths** — `projectPath` must be one of the absolute paths from the project's Repositories section

Split cross-repo work into one task per repo with `blockedBy` — except when atomicity is genuinely required (a
single commit must land in both repos to avoid broken state), in which case flag the task and surface the need for
human coordination.

## Precise Step Declarations

_See the `<examples>` block at the end of this page for good/bad pairs._

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

Use actual file paths discovered during exploration. Reference the repository instruction files for verification
commands.

## Task Naming

Start with an action verb (Add, Create, Update, Fix, Refactor, Remove, Migrate). Include the feature/concept, not files.
Keep under 60 characters. Avoid vague verbs (Improve, Enhance, Handle).

See `<examples>` below for concrete good/bad pairs.

{{PLAN_COMMON_EXAMPLES}}

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
