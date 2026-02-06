# RalphCTL - Sprint & Task Management for AI-Assisted Coding

CLI tool for managing sprints and tasks that integrates with Claude Code for AI-assisted implementation workflows.

Featuring Ralph Wiggum personality with fun quotes, themed colors, and an interactive menu mode!

@REQUIREMENTS.md - What the app does, why features exist, design rationale
@ARCHITECTURE.md - Technical implementation: data models, services, APIs

Check these files for high-level context on the tool's purpose and design.
If you notice inconsistencies or discrepancies, please raise an issue.

## Workflow

```
1. Add projects       → ralphctl project add (define multi-repo projects)
2. Create sprint      → ralphctl sprint create (draft, becomes current)
3. Add tickets        → ralphctl ticket add --project <name> (repeat for each)
4. Refine requirements → ralphctl sprint refine (Claude asks questions, user approves)
5. Plan tasks         → ralphctl sprint plan (Claude explores repos, generates tasks)
6. Start work         → ralphctl sprint start (auto-activates, executes tasks)
7. Close sprint       → ralphctl sprint close (active → closed)
```

Note: `sprint start` auto-activates if the sprint is in draft status.

Tickets can have an optional external ID/link (for issue tracker integration) or be freestyle descriptions. Each ticket references a project by name, enabling multi-project sprints.

### Two Workflow Paths

**Workflow 1: Direct Tasks (Core)**

```
ralphctl sprint create → ralphctl task add (repeat) → ralphctl sprint start
```

Use when you know exactly what needs to be done. Fast and direct.

**Workflow 2: AI-Assisted Planning**

```
ralphctl sprint create → ralphctl ticket add → ralphctl sprint refine → ralphctl sprint plan → ralphctl sprint start
```

Use when you have high-level tickets that need AI help breaking down into tasks.

## Key Concepts

### Projects

Projects are named entities with one or more repositories. Each repository has an auto-derived name (from path basename), absolute path, and optional setup/verify scripts.

Tickets reference projects by name. Tasks get their execution path from a specific repository within the project.

### Multi-Project Sprints

A sprint can contain tickets from multiple projects. Each ticket references a project:

```
Sprint (container)
├── Ticket A (projectName: frontend)
│   └── Tasks 1-3 (projectPath: ~/frontend)
├── Ticket B (projectName: backend)
│   └── Tasks 4-6 (projectPath: ~/backend)
```

### Current Sprint vs Sprint Status

These are two separate concepts:

| Concept            | Purpose                          | Stored In     |
| ------------------ | -------------------------------- | ------------- |
| **Current Sprint** | Which sprint CLI commands target | `config.json` |
| **Sprint Status**  | Lifecycle state of a sprint      | `sprint.json` |

- **Current sprint**: A pointer in config.json. Set by `sprint create` (auto) or `sprint current`
- **Sprint status**: Part of the sprint's lifecycle (draft → active → closed)

Multiple sprints can be active simultaneously (useful for parallel work in different terminals).

### Sprint State Machine

Sprint status: `draft` → `active` → `closed`

| Operation           | Draft | Active | Closed |
| ------------------- | :---: | :----: | :----: |
| Add/edit/rm ticket  |   ✓   |   ✗    |   ✗    |
| Refine requirements |   ✓   |   ✗    |   ✗    |
| Plan/add tasks      |   ✓   |   ✗    |   ✗    |
| Start (execute)     |  ✓\*  |   ✓    |   ✗    |
| Update task status  |   ✗   |   ✓    |   ✗    |
| Close               |   ✗   |   ✓    |   ✗    |

\*`sprint start` auto-activates draft sprints.

### Two-Phase Planning

**Phase 1: Requirements Refinement** (`ralphctl sprint refine`)

Per-ticket Human-In-The-Loop (HITL) clarification focused on WHAT needs to be done:

1. For each pending ticket:
   - Display ticket details (title, description, project)
   - Claude asks clarifying questions about requirements and acceptance criteria
   - User answers via selection UI
   - User reviews and approves refined requirements
2. Requirements stored in tickets, marked `requirementStatus: 'approved'`

This phase is **implementation-agnostic** — no code exploration, no repository selection.

**Phase 2: Task Generation** (`ralphctl sprint plan`)

Per-ticket HOW it will be implemented:

1. Requires all tickets to have `requirementStatus: 'approved'`
2. For each ticket:
   - **Claude proposes which repositories are affected** based on approved requirements
   - User reviews and confirms the proposed repositories (checkbox UI)
   - Selection saved to `ticket.affectedRepositories` (stores paths, not names)
   - Claude explores ONLY the confirmed repos
   - Claude generates tasks split by repository with proper dependencies
3. Each task gets a `projectPath` matching one of the affected repos

The repo selection is persisted, so you can resume planning even if interrupted.

## Development

```bash
pnpm dev <command>     # Run CLI
pnpm lint              # Lint
pnpm typecheck         # Type check
pnpm test              # Run tests
pnpm test:watch        # Tests in watch mode
pnpm test:coverage     # Tests with coverage report
```

Keep CLAUDE.md updated with CLI Commands and concepts as they evolve.
Update [json schemas](/schemas) for config files when edited.

## Architecture Rules

- **No `sprint activate` command** — `sprint start` auto-activates draft sprints
- **`affectedRepositories`** stores paths (not names) — set during `sprint plan`, persisted per-ticket
- **Refinement is per-ticket** — template uses `{{TICKET}}` (singular), one Claude session per ticket
- **Planning is per-sprint** — repo selection applies to all tickets, paths saved per-ticket based on project membership
- **JSON schemas** in `/schemas/` must be kept in sync with Zod schemas in `src/schemas/index.ts`

## UI Patterns

Use helpers from `@src/theme/ui.ts`: `showSuccess`, `showError`, `showEmpty`, `showNextStep`, `icons`, `field`.
Use `createSpinner()` from `@src/theme/ui.ts` for async operations (donut-themed spinner).
Use `log.*` for consistent output formatting. See `.claude/agents/designer.md` for complete UX guidelines.

## Compaction Rules

When compacting, always preserve:

- Sprint state machine rules and two-phase planning constraints
- The list of modified files and any verification commands
- Architecture rules listed above
- Current task context and progress
