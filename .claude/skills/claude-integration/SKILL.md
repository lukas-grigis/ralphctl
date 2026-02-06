# Claude CLI Integration & Agent Harness

Auto-invoked when working on `src/claude/` module, session spawning, or task execution harness.

## Claude CLI Invocation from Node.js

Claude process spawning is centralized in `src/claude/session.ts`:

```typescript
import { spawnClaudeInteractive, spawnClaudeHeadless } from '@src/claude/session.ts';

// Interactive session with initial prompt (single spawn, stdio: inherit)
spawnClaudeInteractive('Read .ralphctl-sprint-<id>-task-<id>-context.md and follow the instructions', {
  cwd: projectPath,
  args: ['--add-dir', '/other/path'],
});

// Headless mode - prompt via stdin, captures output
const output = await spawnClaudeHeadless({
  cwd: projectPath,
  prompt: 'Your prompt content here',
});
```

**Key patterns:**

- Interactive: pass prompt as CLI argument, `stdio: 'inherit'` for full interactivity
- Headless: `-p` (print mode) with prompt via stdin for large content
- `--permission-mode acceptEdits` enables auto-execution without confirmation

**Task execution flow:**

1. Write `.ralphctl-sprint-<sprintId>-task-<taskId>-context.md` with task info + instructions
2. **Interactive mode:** Tell Claude to read the file, then continue interactively
3. **Headless mode:** Read file content, pass via stdin to Claude

### Known Issues & Fixes

| Issue        | Symptom                                  | Fix                                        |
| ------------ | ---------------------------------------- | ------------------------------------------ |
| Stdin hang   | Process stuck at 0 CPU, never progresses | Add `child.stdin.end()` after spawn        |
| Cache bloat  | Startup takes 1-2min instead of ~5s      | `rm -rf ~/.claude` (or selectively below)  |
| Plugin bloat | Slow startup, high memory                | `rm -rf ~/.claude/plugins ~/.claude/debug` |

**Cache health check:**

```bash
du -sh ~/.claude  # Should be < 10MB for normal operation
```

**Quick startup test:**

```bash
time claude -p "yolo"  # Should complete in ~5s
```

## Agent Harness Design

ralphctl orchestrates Claude agents to execute tasks. The harness design is based on patterns from [Anthropic's Effective Harnesses for Long-Running Agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

> **Note:** This section documents how ralphctl implements the harness (for ralphctl contributors).
> The actual agent instructions are in `src/claude/prompts/task-execution.md`.

### Key Implementation Details

**Task context** (`buildFullTaskContext` in `claude/executor.ts`):

- Task specification (name, steps, description)
- Git history (last 20 commits via `getRecentGitHistory`)
- Verification command (explicit or "read CLAUDE.md")
- Progress history (filtered by project)

**Completion signals** (parsed by `parseExecutionResult` in `claude/parser.ts`):

- `<task-verified>` - verification output (required before completion)
- `<task-complete>` - task done
- `<task-blocked>reason</task-blocked>` - task cannot proceed

**Baseline tracking** (on `sprint start` activation):

- Logs git commit hash for each project path to progress.md
- Enables diffing what changed during the sprint

### Repository Verification Scripts

Each repository within a project can have its own setup and verify scripts:

```
my-app/
├── frontend/  → setupScript: "npm install", verifyScript: "npm test"
├── backend/   → setupScript: "pip install -e .", verifyScript: "pytest"
└── shared/    → setupScript: "pnpm install", verifyScript: "pnpm typecheck"
```

Scripts are configured per-repository during `project add` (interactive mode auto-detects based on project type).

**Resolution order for verification:**

1. Explicit `verifyScript` on the repository (recommended)
2. Auto-detection from package.json/pyproject.toml/etc. (convenience fallback)
3. Agent reads target repository's CLAUDE.md (ultimate fallback)

### Exit Codes

| Code | Meaning                                              |
| ---- | ---------------------------------------------------- |
| 0    | Success (all requested operations completed)         |
| 1    | Error (validation, missing params, execution failed) |
| 2    | No tasks available                                   |
| 3    | All remaining tasks blocked by dependencies          |

### Task Dependency System

Tasks support `blockedBy` dependencies. When executing:

1. Tasks marked `in_progress` are resumed first
2. Only tasks whose dependencies are all `done` can be selected
3. If all remaining tasks are blocked, execution stops with exit code 3

### Atomic Task Updates

Task file operations use file locking to prevent data corruption from concurrent access. This enables:

- Multiple terminals running different sprints
- Safe interruption and resumption with Ctrl+C

Lock defaults: 30s stale timeout, 50ms retry delay, 100 max retries (~5s total wait). If you hit `LockAcquisitionError` on slow filesystems (e.g., NFS), increase the stale timeout with `RALPHCTL_LOCK_TIMEOUT_MS=60000`.
