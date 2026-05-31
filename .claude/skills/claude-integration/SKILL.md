---
name: claude-integration
description: "Low-level AI CLI spawn mechanics used by ralphctl's provider adapters — headless / interactive spawn, the file-based contract (`signals.json` + `sessionId` files), idle-stdout watchdog, exponential rate-limit backoff, and `--resume` for in-flight recovery. Use when modifying `src/integration/ai/providers/{claude,copilot,codex}/` or `src/integration/ai/providers/_engine/`, debugging stdin hangs / slow Claude startups, or wiring a new code path that spawns an AI CLI directly."
when_to_use: 'When touching a provider adapter, the shared `_engine/`, or a readiness probe; when diagnosing a rate-limit / resume / watchdog issue; when a new consumer needs to spawn an AI CLI outside the existing ports. Not needed for higher-level work — the flows already wrap all of this through the `HeadlessAiProvider` / `InteractiveAiProvider` ports.'
---

# AI provider integration (Claude / Copilot / Codex)

Covers what is **not** in `CLAUDE.md` or `.claude/docs/ARCHITECTURE.md`. For harness signals, exit codes,
sequential task execution, and check-script gating — see `CLAUDE.md`.

**Source of truth (v0.7.0):**

- Provider adapters: `src/integration/ai/providers/{claude,copilot,codex}/` — one folder per tool, sibling-
  isolated. Each owns `headless.ts` and `interactive.ts` entries (Claude also has `parse-stream.ts` for
  stream-format handling).
- Shared engine: `src/integration/ai/providers/_engine/` — `spawn.ts` (the `ProviderSpawn` port + default
  `node:child_process.spawn` impl), `run-headless-spawn.ts` (the headless wrapper that wires watchdog +
  signals file + sessionId file + rate-limit backoff), `rate-limit-backoff.ts` (exponential retry policy),
  `idle-watchdog.ts` (kills wedged children), `headless-ai-provider.ts` (the cross-tool port).
- Signal contract:
  `src/integration/ai/contract/_engine/{validate-signals-file,render-sidecars,render-contract-section}.ts`
  with per-kind Zod schemas under `src/integration/ai/contract/_engine/signals/<kind>/schema.ts`.
  Each AI-spawning leaf composes `<leaf>.contract.ts` from these primitives; the AI writes
  `signals.json` via its Write tool, the harness Zod-validates post-spawn.
- Composition: `src/application/bootstrap/provider-factory.ts` (`createAiProvider`) picks the concrete
  adapter from `settings.ai.provider`.

## Spawn modes

There are two ports under `_engine/`:

```ts
import type { HeadlessAiProvider } from '@src/integration/ai/providers/_engine/headless-ai-provider.ts';
import type { InteractiveAiProvider } from '@src/integration/ai/providers/_engine/interactive-ai-provider.ts';
```

- **Headless** — `-p` (print) mode with prompt + signals output file. The shared
  `runHeadlessSpawn(...)` helper handles arg construction, the file-based contract, the idle watchdog,
  rate-limit backoff retry, and post-spawn parsing. Each per-tool adapter under `providers/<tool>/headless.ts`
  customises the arg builder and JSON-shape parser.
- **Interactive** — TTY handoff, `stdio: 'inherit'`. The AI CLI takes over the terminal (alt-screen swap to
  its own UI); the TUI's alt-screen state is suspended and restored on the way back. Used by `refine` /
  `plan` / `ideate` / `readiness` flows that need a human at the keyboard.

## File-based provider contract

v0.7.0 does NOT parse stdout for signals or session IDs. Instead, every spawn passes paths to two files:

- `signals.json` — structured JSON the adapter (or the AI's wrapper) writes during the run. The harness
  reads it back post-spawn via `readSignalsFile(...)` and dispatches to the parser registry.
- `sessionId` — a single-line text file containing the provider's session id. The harness reads it
  post-spawn and persists on `Task.attempts[]` for resume.

This replaces v0.6.x's brittle stdout-parsing path. Provider JSON-shape drift no longer breaks the harness;
the contract is the file content.

The per-spawn audit / sandbox layout is:

```
<sprintDir>/<flow>/<unit>/rounds/<N>/{generator,evaluator}/
├── prompt.md           ← rendered prompt (input)
├── session.md          ← per-session audit (provider / cwd / flags / exit code)
├── signals.json        ← parsed structured signals (output)
└── sessionId           ← provider's session id (output)
```

## Permission modes (per-tool, NOT portable)

| Provider         | Headless permission flag              | Why                                                   |
| ---------------- | ------------------------------------- | ----------------------------------------------------- |
| `claude-code`    | `--permission-mode bypassPermissions` | Piped stdin can't answer prompts; `acceptEdits` hangs |
| `github-copilot` | `--allow-all-tools`                   | Copilot's permission model is all-or-nothing          |
| `openai-codex`   | per-session approval flow             | Codex prompts for approval inline; sandbox handles it |

Interactive flows use lower-privilege modes where available (e.g. Claude's `acceptEdits`) because a human is
there to answer prompts.

The harness enforces actual safety through branch isolation, the per-task `checkScript` gate, and the
dirty-tree preflight — not the CLI permission gate.

## Idle-stdout watchdog

`src/integration/ai/providers/_engine/idle-watchdog.ts` kills a headless child whose stdout has been silent
past a configurable idle threshold. Prevents a stuck Claude / Copilot / Codex process from stranding the
harness. The watchdog timer resets on every stdout chunk; killing the child surfaces as a `RateLimitError`-
adjacent failure that the chain's retry policy handles.

## Rate-limit retry (exponential backoff)

`src/integration/ai/providers/_engine/rate-limit-backoff.ts` retries on `RateLimitError` with exponential
delay. Per-spawn cap is `settings.harness.rateLimitRetries` (range 0–10). The retry loop captures the
provider's `sessionId` from the previous attempt and passes `--resume <id>` on the next, so the AI continues
from where it stopped instead of restarting.

## Session resume contract

```bash
# Initial spawn (claude — adjust per provider)
claude -p --output-format stream-json --permission-mode bypassPermissions < prompt.md
# Provider writes session id to the sessionId file

# Resume later
claude -p --resume "<session-id>" --permission-mode bypassPermissions < followup-prompt.md
```

Implementation contract in `runHeadlessSpawn`:

- Post-spawn, `readSignalsFile(...)` + the sessionId file's contents are returned as part of the spawn
  result.
- `RateLimitError` carries the captured `sessionId` so the retry pass passes `--resume <id>` on the next
  attempt.
- The per-task chain (in `src/application/flows/implement/`) persists `sessionId` on `Task.attempts[]` so
  the apply-feedback flow can resume the right session.

## Known startup issues

| Symptom                                  | Cause                     | Fix                                                                |
| ---------------------------------------- | ------------------------- | ------------------------------------------------------------------ |
| Process stuck at 0 CPU after spawn       | Stdin not closed          | Confirm `child.stdin.end()` is called after writing the prompt     |
| First spawn takes 1–2 min instead of ~5s | Bloated `~/.claude` cache | `rm -rf ~/.claude/plugins ~/.claude/debug`                         |
| Watchdog kills a healthy spawn           | Idle threshold too tight  | Tune via the env var the watchdog reads (check `idle-watchdog.ts`) |

Quick health checks:

```bash
du -sh ~/.claude              # expect < 10 MB
time claude -p "yolo"         # expect ~5s
```

## Relationship to ports

Business code never imports an adapter directly — it goes through `HeadlessAiProvider` / `InteractiveAiProvider`
ports from `_engine/`. When adding a new spawn code path, prefer extending the port + the per-tool adapter;
only drop into `runHeadlessSpawn` / `spawn` if a genuinely new spawn shape is needed.

Sibling-isolation rules apply: `providers/claude/`, `providers/copilot/`, and `providers/codex/` cannot
import each other. Shared helpers (spawn, watchdog, backoff, the file-based contract reader/writer) live in
`providers/_engine/` and are the only legitimate cross-tool seam.
