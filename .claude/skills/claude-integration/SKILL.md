---
name: claude-integration
description: "Low-level Claude CLI spawn mechanics used by ralphctl's AI session layer — `spawnInteractive` / `spawnHeadless` / `spawnWithRetry`, `--output-format json` session ID capture, and `--resume` for rate-limit recovery. Use when modifying `src/integration/ai/session/` or `src/integration/ai/providers/claude.ts`, debugging stdin hangs / slow Claude startups, or wiring a new code path that spawns Claude directly."
when_to_use: 'When touching the Claude provider adapter or session layer; when diagnosing a rate-limit / resume issue; when a new consumer needs to spawn Claude outside the existing ports. Not needed for higher-level work — the pipelines already wrap all of this.'
---

# Claude CLI Integration

Covers only what is **not** in `CLAUDE.md` or `.claude/docs/ARCHITECTURE.md`. For harness signals, exit codes, parallel
execution, check scripts, and task dependency ordering — see the root `CLAUDE.md`.

Source of truth:

- Session layer: `src/integration/ai/session/session.ts`, `session-adapter.ts`, `rate-limiter.ts`, `process-manager.ts`
- Provider adapter: `src/integration/ai/providers/claude.ts` (Copilot lives beside it for contrast)
- Task context builder: `src/business/usecases/execute.ts#buildFullTaskContext`
- Output parser: `src/integration/ai/output/parser.ts`

## Spawn modes

```typescript
import { spawnInteractive, spawnHeadless, spawnWithRetry } from '@src/integration/ai/session/session.ts';

// 1. Interactive — TTY-takeover, single spawn, stdio: inherit
spawnInteractive('Read .ralphctl-sprint-<sprintId>-task-<taskId>-context.md and follow instructions', {
  cwd: projectPath,
  args: ['--add-dir', '/other/repo'],
});

// 2. Headless — `-p` with prompt via stdin, captures output
const out = await spawnHeadless({ cwd: projectPath, prompt: '...' });

// 3. Headless + retry + session resume (rate-limit recovery)
const result = await spawnWithRetry(
  { cwd: projectPath, prompt: '...', resumeSessionId: prev?.sessionId },
  { maxRetries: 5, onRetry: (attempt, delayMs, err) => logger.info(...) }
);
// result.stdout, result.sessionId
```

Design rules:

- **Interactive:** prompt as CLI arg, `stdio: 'inherit'` — Claude takes over the terminal.
- **Headless:** prompt via stdin, `-p` (print) mode, always `--output-format json` so we can capture `session_id`.
- `--permission-mode acceptEdits` enables auto-execution without confirmation. The Copilot adapter uses
  `--allow-all-tools` instead — never paper over that difference; route through the provider adapter.

## Session resumption (verified)

`--resume <session_id>` restores full conversation context. ralphctl uses this for rate-limit recovery — a task
hitting 429 is requeued with its captured session ID, then resumed from exactly where Claude stopped.

```bash
# Initial spawn
claude -p --output-format json --permission-mode acceptEdits < prompt.txt
# {"result": "...", "session_id": "49e58e81-...", ...}

# Resume later (same session_id is returned)
echo "Continue where you left off." | claude -p --resume "49e58e81-..." --output-format json --permission-mode acceptEdits
```

Implementation contract:

- `spawnHeadless` parses `session_id` from the JSON envelope.
- `spawnWithRetry` retains the last known session ID and passes `--resume` on retry.
- `SpawnError` carries `sessionId` even on failure so callers can persist it before retry.
- The parallel executor keeps a `Map<taskId, sessionId>` in `taskSessionIds` (see
  `src/business/pipelines/execute.ts` and `per-task-pipeline.ts`).
- The `RateLimitCoordinator` pauses **new** task launches globally; in-flight tasks continue until they settle.

## Task context file

`buildFullTaskContext` writes `.ralphctl-sprint-<sprintId>-task-<taskId>-context.md` to the target repo's working
directory (path built by `NodeFilesystemAdapter.contextFilePath`). Interactive mode points Claude at the file;
headless mode reads it and pipes content via stdin.

Contents:

- Task specification (name, steps, description, `verificationCriteria`)
- Recent git history (`ExternalPort.getRecentGitHistory` — last 20 commits)
- Explicit verification command, or a fallback pointing Claude at `CLAUDE.md`
- Progress history filtered to this project path
- Branch section (when `sprint.branch` is set) telling the agent which branch to work on

## Known startup issues

| Symptom                                  | Cause                     | Fix                                                      |
| ---------------------------------------- | ------------------------- | -------------------------------------------------------- |
| Process stuck at 0 CPU after spawn       | Stdin not closed          | `child.stdin.end()` immediately after writing the prompt |
| First spawn takes 1–2 min instead of ~5s | Bloated `~/.claude` cache | `rm -rf ~/.claude/plugins ~/.claude/debug`               |

Quick health checks:

```bash
du -sh ~/.claude          # expect < 10 MB
time claude -p "yolo"     # expect ~5s
```

## Relationship to ports

Business code never imports `session.ts` directly — it goes through `AiSessionPort` (implemented by
`ProviderAiSessionAdapter` in `src/integration/ai/session/session-adapter.ts`). When adding a new spawn code path,
prefer extending the port + adapter; only drop into `spawnHeadless` / `spawnWithRetry` if a genuinely new spawn
shape is needed.
