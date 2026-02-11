# RalphCTL - Sprint & Task Management for AI-Assisted Coding

CLI tool for managing sprints and tasks with Claude Code integration. Ralph Wiggum themed.

@REQUIREMENTS.md - What the app does, why features exist, design rationale
@ARCHITECTURE.md - Technical implementation: data models, services, APIs

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

### Two Workflow Paths

**Direct Tasks:** `sprint create` → `task add` (repeat) → `sprint start`
**AI-Assisted:** `sprint create` → `ticket add` → `sprint refine` → `sprint plan` → `sprint start`

## Sprint State Machine

Status: `draft` → `active` → `closed`

| Operation           | Draft | Active | Closed |
| ------------------- | :---: | :----: | :----: |
| Add/edit/rm ticket  |   ✓   |   ✗    |   ✗    |
| Refine requirements |   ✓   |   ✗    |   ✗    |
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
- Claude proposes affected repos → user confirms (checkbox UI) → saved to `ticket.affectedRepositories`
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

## UI Patterns

Use helpers from `@src/theme/ui.ts` — never add raw emoji or inconsistent formatting:

- `showSuccess()` / `showError()` / `showEmpty()` — standard output patterns
- `createSpinner()` — async operations (donut-themed)
- `icons.*` — ASCII icons for entities (`icons.sprint`, `icons.task`, `icons.ticket`, `icons.project`)
- `log.*` — consistent output formatting
- `renderTable(columns, rows)` — ANSI-safe table with box-drawing borders
- `renderCard(title, lines)` — bordered card for detail views
- `renderColumns(blocks)` — side-by-side column layout
- `progressBar(done, total)` — visual progress indicator
- `labelValue(label, value)` — consistent label:value formatting (shared, don't duplicate)
- See `.claude/agents/designer.md` for complete UX guidelines

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

When compacting, always preserve: sprint state machine, two-phase planning constraints, architecture constraints, list of modified files, verification commands, and current task context.
