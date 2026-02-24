# RalphCTL - Sprint & Task Management for AI-Assisted Coding

CLI tool for managing sprints and tasks with AI-assisted coding (Claude Code + GitHub Copilot). Ralph Wiggum themed.

@.claude/docs/REQUIREMENTS.md - Acceptance criteria checklists
@.claude/docs/ARCHITECTURE.md - Data models, file storage, error/exit tables

## Quick Start

```bash
# Install dependencies
pnpm install

# Run CLI in dev mode
pnpm dev --help
pnpm dev sprint create

# Or run installed CLI
./bin/ralphctl

# Run without args for interactive menu mode (recommended)
pnpm dev
```

**Verify everything works:**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

## Requirements

- **Node.js 24+** (managed via `mise.toml`)
- **pnpm 10+**
- **Claude CLI** or **GitHub Copilot CLI** installed and configured (see Provider Configuration below)

## Architecture Constraints

- **No `sprint activate` command** — `sprint start` auto-activates draft sprints
- **`affectedRepositories` stores absolute paths** (not names) — set during `sprint plan`, persisted per-ticket
- **Refinement is per-ticket** — template uses `{{TICKET}}` (singular), one AI session per ticket
- **Planning is per-sprint** — repo selection applies to all tickets, paths saved per-ticket
- **JSON schemas** in `/schemas/` must stay in sync with Zod schemas in `src/schemas/index.ts`
- **`currentSprint`** (config.json pointer) is NOT the same as sprint status (lifecycle state)
- **`aiProvider`** is a global config setting, not per-sprint — stored in config.json
- **Setup/verify scripts come ONLY from explicit repo config** — set during `project add` or `project repo add`; heuristic detection (`src/utils/detect-scripts.ts`) is used only as editable suggestions during project setup, never as a runtime fallback
- **`RALPHCTL_SETUP_TIMEOUT_MS`** — env var to override the 5-minute default timeout for setup/verify scripts
- **Setup tracking** — `sprint.setupRanAt` records per-repo timestamps; re-runs skip already-completed setups; `--refresh-setup` forces re-execution; cleared on sprint close
- **Per-task pre-flight** — harness runs `verifyScript` before each AI task; self-heals via `setupScript` on failure for `todo` tasks; passes failure context to agent for `in_progress` tasks

## Common Mistakes to Avoid

- Don't reference or create a `sprint activate` command — use `sprint start`
- Don't confuse `currentSprint` (which sprint CLI targets) with `sprintStatus` (draft/active/closed)
- Don't store repository names in `affectedRepositories` — store absolute paths
- Don't explore repos during `sprint refine` — refinement is implementation-agnostic (WHAT, not HOW)
- Don't break task `blockedBy` dependencies during planning — preserve dependency chains
- Don't let prompt templates drift from command implementation — verify prompts describe actual workflow (e.g., repo
  selection timing)
- Don't hardcode provider-specific logic outside `src/providers/` — use the provider abstraction layer
- Don't assume both providers share the same permission model — Claude uses settings files, Copilot uses `--allow-all-tools` (see Provider Differences below)
- Don't add runtime auto-detection of setup/verify scripts — detection logic in `src/utils/detect-scripts.ts` is for suggestions during `project add` only

## Workflow

```
1. Add projects       → ralphctl project add
2. Create sprint      → ralphctl sprint create (draft, becomes current)
3. Add tickets        → ralphctl ticket add --project <name>
4. Refine requirements → ralphctl sprint refine (WHAT — clarify requirements)
5. Export requirements → ralphctl sprint requirements (optional, markdown export)
6. Plan tasks         → ralphctl sprint plan (HOW — explore repos, generate tasks)
7. Check health       → ralphctl sprint health (diagnose blockers, stale tasks)
8. Start work         → ralphctl sprint start (auto-activates draft sprints)
9. Close sprint       → ralphctl sprint close
```

**Optional:** Configure your preferred AI provider with `ralphctl config set provider <claude|copilot>` (prompted on first use if not set).

### Provider Configuration

```bash
ralphctl config set provider claude      # Use Claude Code CLI
ralphctl config set provider copilot     # Use GitHub Copilot CLI
```

Auto-prompts on first AI command if not set. Both CLIs must be in PATH and authenticated.

### Provider Differences

| Aspect              | Claude Code                                              | GitHub Copilot      |
| ------------------- | -------------------------------------------------------- | ------------------- |
| CLI flag            | `--permission-mode acceptEdits`                          | `--allow-all-tools` |
| Settings files      | `.claude/settings.local.json`, `~/.claude/settings.json` | None                |
| Allow/deny patterns | `Bash(git commit:*)`, `Bash(*)`, etc.                    | Not applicable      |

`checkTaskPermissions()` in `src/ai/task-context.ts` always performs Claude-style file checks (benign for Copilot — settings files won't exist). Thread `provider` through if extending permission logic.

### Workflow Paths

**Direct Tasks:** `sprint create` → `task add` (repeat) → `sprint start`
**AI-Assisted:** `sprint create` → `ticket add` → `sprint refine` → `sprint plan` → `sprint start`
**Quick Ideation:** `sprint create` → `sprint ideate` → `sprint start` (combines refine + plan for quick ideas)
**Re-Plan:** (draft sprint) `ticket add` → `sprint refine` → `sprint plan` (replaces existing tasks)

## Sprint State Machine

Status: `draft` → `active` → `closed`

| Operation           | Draft | Active | Closed |
| ------------------- | :---: | :----: | :----: |
| Add ticket          |   ✓   |   ✗    |   ✗    |
| Edit/remove ticket  |   ✓   |   ✗    |   ✗    |
| Refine requirements |   ✓   |   ✗    |   ✗    |
| Ideate (quick)      |   ✓   |   ✗    |   ✗    |
| Plan tasks          |   ✓   |   ✗    |   ✗    |
| Start (execute)     |  ✓\*  |   ✓    |   ✗    |
| Update task status  |   ✗   |   ✓    |   ✗    |
| Close               |   ✗   |   ✓    |   ✗    |

\*`sprint start` auto-activates draft sprints.

## Two-Phase Planning

**Phase 1: Requirements Refinement** (`sprint refine`) — WHAT needs doing

- Per-ticket HITL clarification: Claude asks questions, user approves requirements
- **Implementation-agnostic** — no code exploration, no repo selection
- Stores results as `requirementStatus: 'approved'` on each ticket

**Phase 2: Task Generation** (`sprint plan`) — HOW to implement

- Requires all tickets to have `requirementStatus: 'approved'`
- User selects repos via checkbox UI (before Claude starts) → saved to `ticket.affectedRepositories`
- Claude explores confirmed repos only → generates tasks split by repo with dependencies
- Repo selection persists for resumability

### Draft Re-Plan

Running `sprint plan` on a draft sprint that already has tasks triggers re-plan mode:

1. Add new tickets to the draft sprint (`ticket add`)
2. Refine their requirements (`sprint refine`)
3. Run `sprint plan` — auto-detects existing tasks

**Behavior:**

- Processes ALL tickets (not just unplanned ones)
- Existing tasks are included as AI context so Claude can reuse, modify, or drop them
- AI generates a complete replacement task set covering all tickets
- New tasks atomically replace all existing tasks via `saveTasks()` (interruption-safe)
- `reorderByDependencies` runs after every import
- Interactive mode shows confirmation prompt before replacing

## Development

```bash
pnpm dev <command>     # Run CLI
pnpm typecheck         # Type check
pnpm lint              # Lint
pnpm test              # Run tests
```

### Verification

After implementation, always run: `pnpm typecheck && pnpm lint && pnpm test`
All checks must pass before committing. Keep CLAUDE.md updated as CLI commands evolve.

### Git Hooks

Pre-commit hook runs `lint-staged` (ESLint + Prettier on staged files). If commits are rejected, run:

```bash
pnpm lint:fix    # Auto-fix linting issues
pnpm format      # Format all files
```

## Prompt Template Engineering

**Conditional sections** - `{{VARIABLE}}` placeholders in prompts can be empty strings; avoid numbered lists that create
gaps (use blockquotes or bullets)
**Em-dash usage** - Use `—` (em-dash) not `-` (hyphen) for explanatory clauses in `.md` prompts (consistency across all
prompt files)
**Workflow sync** - Prompt templates must match actual command flow (e.g., repo selection happens in command before
Claude session starts)
**Template builders** - `src/ai/prompts/index.ts` compiles `.md` templates with placeholder replacement

## Custom Agents

`.claude/agents/` contains specialized agent definitions for the Task tool:

- `designer.md` — UI/UX design and theming (use for frontend/UI work)
- `tester.md` — Test engineering (use for writing/fixing tests)
- `implementer.md` — TypeScript implementation (use for feature implementation)
- `planner.md` — Implementation planning (use before coding begins)
- `reviewer.md` — Code review (use after implementation)
- `auditor.md` — Security audit (use for security-sensitive code)

Use Task tool with these `subagent_type` values for specialized work.

## UI Patterns

Use helpers from `@src/theme/ui.ts` — never add raw emoji or inconsistent formatting.
See `.claude/agents/designer.md` for complete UX guidelines and helper reference.

## Task Execution Signals

The harness parses these XML signals from AI agent output:

- `<task-verified>output</task-verified>` — verification passed (required before completion in headless mode)
- `<task-complete>` — task finished successfully
- `<task-blocked>reason</task-blocked>` — task cannot proceed

## Parallel Execution

`sprint start` runs tasks in parallel by default (one per unique `projectPath`):

- Session/step mode forces sequential (`--concurrency 1` equivalent)
- `RateLimitCoordinator` pauses new launches on rate limits; running tasks continue
- Rate-limited tasks auto-resume via `--resume <session_id>`

## Compaction Rules

When compacting, always preserve: sprint state machine, two-phase planning constraints, architecture constraints, list
of modified files, verification commands, and current task context.

## References

- [Anthropic — Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) — consult when extending the runner/executor layer.
