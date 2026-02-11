# RalphCTL - Sprint & Task Management for AI-Assisted Coding

CLI tool for managing sprints and tasks with Claude Code integration. Ralph Wiggum themed.

@REQUIREMENTS.md - What the app does, why features exist, design rationale
@ARCHITECTURE.md - Technical implementation: data models, services, APIs

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
- **Claude CLI** installed and configured (`claude --version`)

## Interactive Mode

**Run `ralphctl` with no arguments to enter interactive menu mode** — context-aware menus with persistent status header,
workflow guidance, and Quick Start wizard. This is the recommended way to use ralphctl for most workflows.

## Architecture Constraints

- **No `sprint activate` command** — `sprint start` auto-activates draft sprints
- **`affectedRepositories` stores absolute paths** (not names) — set during `sprint plan`, persisted per-ticket
- **Refinement is per-ticket** — template uses `{{TICKET}}` (singular), one Claude session per ticket
- **Planning is per-sprint** — repo selection applies to all tickets, paths saved per-ticket
- **JSON schemas** in `/schemas/` must stay in sync with Zod schemas in `src/schemas/index.ts`
- **`currentSprint`** (config.json pointer) is NOT the same as sprint status (lifecycle state)

## Common Mistakes to Avoid

- Don't reference or create a `sprint activate` command — use `sprint start`
- Don't confuse `currentSprint` (which sprint CLI targets) with `sprintStatus` (draft/active/closed)
- Don't store repository names in `affectedRepositories` — store absolute paths
- Don't explore repos during `sprint refine` — refinement is implementation-agnostic (WHAT, not HOW)
- Don't break task `blockedBy` dependencies during planning — preserve dependency chains
- Don't let prompt templates drift from command implementation — verify prompts describe actual workflow (e.g., repo
  selection timing)

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

### Workflow Paths

**Direct Tasks:** `sprint create` → `task add` (repeat) → `sprint start`
**AI-Assisted:** `sprint create` → `ticket add` → `sprint refine` → `sprint plan` → `sprint start`
**Quick Ideation:** `sprint create` → `sprint ideate` → `sprint start` (combines refine + plan for quick ideas)

## Sprint State Machine

Status: `draft` → `active` → `closed`

| Operation           | Draft | Active | Closed |
| ------------------- | :---: | :----: | :----: |
| Add/edit/rm ticket  |   ✓   |   ✗    |   ✗    |
| Refine requirements |   ✓   |   ✗    |   ✗    |
| Ideate (quick)      |   ✓   |   ✗    |   ✗    |
| Plan/add tasks      |   ✓   |   ✗    |   ✗    |
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
**Template builders** - `src/claude/prompts/index.ts` compiles `.md` templates with placeholder replacement

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
See `.claude/agents/designer.md` for complete UX guidelines.

**Messages:**

- `showSuccess(message, details?)` — success confirmation with optional field details
- `showError(message)` — error output (fatal issues)
- `showWarning(message)` — warning output (non-fatal issues, e.g., blocked tasks)
- `showInfo(message)` — informational output
- `showTip(message)` — tip/hint with consistent formatting
- `showEmpty(what, hint?)` — empty state with helpful next action

**Spinners:**

- `createSpinner(text)` — async operations (donut-themed)

**Icons & Theme:**

- `icons.*` — ASCII icons for entities (`icons.sprint`, `icons.task`, `icons.ticket`, `icons.project`)
- `emoji.*` — emoji constants (`emoji.donut`)
- `showRandomQuote()` — display random Ralph quote (personality after key actions)
- `showBanner()` — themed banner with gradient styling

**Fields & Cards:**

- `field(label, value)` — consistent label:value formatting (shared, don't duplicate)
- `labelValue(label, value)` — detail field for card content (trimmed for card alignment)
- `fieldMultiline(label, value)` — multiline field with proper indentation
- `renderCard(title, lines)` — bordered card for detail views
- `DETAIL_LABEL_WIDTH` — standard label width for detail views (14 chars)

**Tables & Layout:**

- `renderTable(columns, rows)` — ANSI-safe table with box-drawing borders

**Status & Progress:**

- `formatTaskStatus(status)` — colored task status with emoji
- `formatSprintStatus(status)` — colored sprint status with emoji
- `badge(text, type?)` — inline status indicator (`[text]`)
- `progressBar(done, total)` — visual progress indicator
- `printCountSummary(label, done, total)` — count summary with percentage

**Formatting:**

- `log.*` — structured output (`log.info`, `log.success`, `log.warn`, `log.error`, `log.dim`, `log.item`, `log.raw`,
  `log.newline`)
- `formatMuted(text)` — muted/secondary text
- `clearScreen()` — clear terminal (TTY-safe)
- `printSeparator(width?)` — horizontal separator line
- `printHeader(title, icon?)` — header with icon and separator

**Utilities:**

- `terminalBell()` — audio feedback on completions (TTY-safe)
- `boxChars` — box-drawing character sets (light, rounded, heavy)

### Available UI Helpers (Not Yet Used)

Additional helpers available in `@src/theme/ui.ts` — use these instead of creating duplicates:

- `renderColumns(blocks)` — side-by-side column layout
- `renderProgressSummary(done, total, labels?)` — progress summary with labels
- `createThemedSpinner(text, variant?)` — themed spinner with variants (donut/sprinkle/minimal)
- `renderBox(lines, title?, style?)` — low-level box renderer
- `section(title, icon?)` — section header formatting
- `subsection(title)` — subsection header formatting
- `printSummary(items)` — print summary key-value pairs
- `typewriter(text)` — typewriter animation (experimental)
- `progressiveReveal(lines)` — progressive line reveal (experimental)
- `horizontalLine(width, style?)` — horizontal line with box-drawing chars
- `verticalLine(style?)` — vertical line with box-drawing chars
- `isTTY()` — check TTY support
- `sanitizeForDisplay(s)` — sanitize string for ANSI terminal display

### Recent UI Improvements

- **Warning vs Error distinction** — warnings now used for non-fatal issues (blocked tasks)
- **Standardized tips** — all hints use `showTip()` for consistency
- **Audio feedback** — terminal bell on sprint completion and task import
- **Enhanced personality** — Ralph quotes appear after sprint create/close/complete
- **Shared detail formatting** — `labelValue()` eliminates duplication across show commands
- **Removed dead code** — 7 unused helpers removed to reduce maintenance burden

### List Commands

All list commands support filters and show summary lines:

- Task list: `--status`, `--project`, `--ticket`, `--blocked`
- Ticket list: `--project`, `--status`
- Sprint list: `--status`
- Output: "Showing X of Y (filtered: ...)" when filters active

### Interactive Mode Features

- **Dynamic menus** — context-aware with badges, disabled states, workflow ordering
- **Persistent status header** — sprint name/status/progress shown before every menu
- **Action-on-empty** — selectors offer to create missing entities inline
- **Quick Start wizard** — guided sprint setup (create → tickets → refine → plan → start)
- **Batch ticket entry** — loop with "Add another?" and pre-filled project

## Parallel Execution

`sprint start` runs tasks in parallel by default (one per unique `projectPath`):

- Session/step mode forces sequential (`--concurrency 1` equivalent)
- `RateLimitCoordinator` pauses new launches on rate limits; running tasks continue
- Rate-limited tasks auto-resume via `--resume <session_id>`

## Compaction Rules

When compacting, always preserve: sprint state machine, two-phase planning constraints, architecture constraints, list
of modified files, verification commands, and current task context.
