# Providers

ralphctl drives five AI coding CLIs. All five run every flow and are supported first-class. Pick one per
flow — or mix them, say plan with one and implement with another — through a preset or per-row settings.

This page is the detailed reference. The [README](../README.md#providers) has the summary.

## At a glance

| Provider                                  | CLI        | Install                              | Auth                       | Context file                      | Skills directory |
| ----------------------------------------- | ---------- | ------------------------------------ | -------------------------- | --------------------------------- | ---------------- |
| **Claude Code** (`claude-code`)           | `claude`   | `npm i -g @anthropic-ai/claude-code` | Anthropic account          | `CLAUDE.md`                       | `.claude/`       |
| **GitHub Copilot CLI** (`github-copilot`) | `copilot`  | `npm i -g @github/copilot`           | GitHub Copilot seat        | `.github/copilot-instructions.md` | `.github/`       |
| **OpenAI Codex CLI** (`openai-codex`)     | `codex`    | `npm i -g @openai/codex`             | ChatGPT / OpenAI           | `AGENTS.md`                       | `.agents/`       |
| **OpenCode** (`opencode`)                 | `opencode` | `npm i -g opencode-ai`               | your own key, or none      | `AGENTS.md`                       | `.opencode/`     |
| **Grok Build CLI** (`xai-grok`)           | `grok`     | `npm i -g @xai-official/grok`        | xAI account (`grok login`) | `AGENTS.md`                       | `.grok/`         |

Bundled skill injection and `bodyFile` forensic capture work on all five. Parallel execution is
provider-agnostic — it works with whichever provider each implement role is configured to use.

## Permission model per backend

Each CLI exposes a different vocabulary for "let the agent work without asking". ralphctl maps its own
permission model onto whatever the backend offers:

| Provider           | Headless mapping (full-auto)           | Read-only mapping                                                                                         | Fine-grained gate?                                 |
| ------------------ | -------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **Claude Code**    | `--permission-mode bypassPermissions`  | `--disallowedTools` on edit / shell / network                                                             | Yes — per-tool deny list                           |
| **GitHub Copilot** | `--autopilot` + `--allow-all`          | `--allow-all-tools --deny-tool=shell`                                                                     | Partial — shell deny only                          |
| **OpenAI Codex**   | `-s workspace-write` (topology-scoped) | same — two sandbox modes only                                                                             | No — two sandbox modes only                        |
| **OpenCode**       | `--auto` (topology-scoped)             | same — no read-only mode                                                                                  | No — permission is all-or-nothing                  |
| **Grok Build CLI** | `--always-approve`                     | `--always-approve --disallowed-tools search_replace,run_terminal_command,run_terminal_cmd --no-subagents` | Partial — edit + shell deny; `write` stays allowed |

**The `Write` tool is never denied, on any backend.** The harness's contract envelope (`signals.json`) lands
through it, so path scope — cwd plus the mounted roots (`--add-dir` and equivalents) — is always part of the
safety envelope, not an alternative to the deny list. Claude Code denies the tools that modify _existing_
files (`Edit` / `MultiEdit` / `NotebookEdit`) plus shell and network; Copilot denies only `shell`; Grok
denies `search_replace` (edit) and both shell ids (`run_terminal_command` / `run_terminal_cmd`) plus `--no-subagents` while `write` stays allowed; Codex and
OpenCode have no per-tool gate at all.

For Codex and OpenCode, **path topology is the whole safety envelope**. Codex's sandbox has only two modes
(read-only / workspace-write), so the cwd plus `--add-dir` set defines the scope. OpenCode has no
`--add-dir` flag; its per-directory grants live in config instead (`permission.external_directory`), and
ralphctl writes `signals.json` outside the project folder. Interactive sessions get exactly one such grant,
scoped to the directory holding the prompt file and layered onto your own config. Headless runs still pass
`--auto` — without it the agent would sit blocked waiting for an approval that never arrives. In both cases
the session directory is the real boundary.

Grok has no `--add-dir`. The adapter forces `--sandbox off` so an operator's `~/.grok/config.toml`
cannot re-enable workspace/strict and block `grok-prompt.md` / `signals.json` outside cwd. Extra
roots are a **named over-grant** (same posture as OpenCode `--auto`) rather than an error: writes
outside cwd already work, so the adapter does not pretend it can mount a subset. Path topology is
therefore not a Grok CLI envelope either; the deny list is the only gate.

## Claude Code

The most end-to-end mileage inside the harness — the most battle-tested backend, and the reference
implementation the others are checked against.

```bash
npm i -g @anthropic-ai/claude-code
ralphctl settings apply-preset claude-only
```

The finest-grained gate of the five: read-only flows deny the edit, shell and network tools at the CLI level.
`Write` stays open by design so `signals.json` can land, bounded by cwd + `--add-dir`. Reads `CLAUDE.md` at
the repo root as its native context file; ralphctl's readiness flow writes it.

## GitHub Copilot CLI

Runs every flow, backed by your GitHub Copilot seat.

```bash
npm i -g @github/copilot
ralphctl settings apply-preset copilot-only
```

ralphctl passes `--max-autopilot-continues=200` per spawn, raising Copilot's default budget of 5. Its deny
list is coarser than Claude Code's: a read-only flow denies `shell` only, so file writes remain available and
path scope (cwd + `--add-dir`) is what bounds them. Reads `.github/copilot-instructions.md`.

A model showing as "not available" is usually plan gating on your Copilot subscription, not an invalid model
id — check what your seat includes before assuming a bug.

## OpenAI Codex CLI

Runs every flow, backed by ChatGPT or an OpenAI account.

```bash
npm i -g @openai/codex
ralphctl settings apply-preset codex-only
```

The sandbox has exactly two modes, so every ralphctl profile maps to `workspace-write` — `codex exec`
read-only blocks every write including `signals.json`, which the harness needs. Path scope is therefore the
fine-grained safety envelope. Reads `AGENTS.md`.

## OpenCode

The other four each bind you to one vendor. [OpenCode](https://opencode.ai/) doesn't: it's a vendor-neutral
CLI that fronts **75+ model providers** (via [Models.dev](https://models.dev/)) plus local runtimes, on a
bring-your-own-key model.

```bash
npm i -g opencode-ai
opencode providers login  # connect Anthropic / OpenAI / Ollama / … with your own keys
opencode providers list   # see what is currently connected
opencode models           # list every id now reachable

ralphctl settings set ai.implement.generator.provider opencode
ralphctl settings set ai.implement.generator.model    <provider>/<model>
```

| Want to run…               | With OpenCode                                                   |
| -------------------------- | --------------------------------------------------------------- |
| A frontier hosted model    | Anthropic, OpenAI, Google Vertex, Bedrock, Azure — your own key |
| An aggregator              | OpenRouter, Together, Groq, Hugging Face                        |
| A specialist or open model | DeepSeek, Mistral, xAI, and the rest of the Models.dev catalog  |
| Something entirely local   | Ollama, LM Studio, llama.cpp — no data leaves your machine      |
| Nothing at all set up yet  | OpenCode's own free tier — no account, no key                   |

### Model ids

Ids are namespaced `<provider>/<model>` and can carry more than two segments — OpenRouter ids are three
(`openrouter/moonshotai/kimi-k2`) because the vendor id itself contains a slash, and a custom provider you
declare yourself can nest just as deep (`myprovider/vendor/slashed-model`).

ralphctl doesn't validate against a fixed list; it asks the CLI (`opencode models`) for whatever is reachable,
so authenticating — or declaring — a new provider in OpenCode makes its models selectable in ralphctl
immediately, with no ralphctl upgrade and no catalog PR. **New models become usable the day they land
upstream.**

The division of responsibility is deliberate: OpenCode owns authentication, base URLs, and the provider
adapter package; ralphctl only stores a model id string. There is no ralphctl-side provider or credential
configuration — including a project-level `opencode.json` in your repository's working directory, which
`opencode models` honours, so per-repo model configuration works with no ralphctl-side setup.

### Worked example — OpenRouter

```bash
opencode auth login                       # add your OpenRouter key (or edit opencode.json directly)
opencode models | grep openrouter         # confirm the ids you now have reachable
ralphctl settings set ai.implement.generator.provider opencode
ralphctl settings set ai.implement.generator.model    openrouter/moonshotai/kimi-k2
```

### Mixing backends

Nothing forces a whole sprint onto one backend. A local model can draft while a frontier model reviews:

```bash
ralphctl settings set ai.implement.generator.provider opencode
ralphctl settings set ai.implement.generator.model    ollama/<your-local-model>
ralphctl settings set ai.implement.evaluator.provider claude-code
ralphctl settings set ai.implement.evaluator.model    claude-opus-5
```

### Zero-auth path

`ralphctl settings apply-preset opencode-only` uses OpenCode's free tier, which needs no credentials at all —
handy for a first look or a CI job without secrets. The free-tier models are community models, so point
OpenCode at a real provider before judging output quality.

The free tier rotates as OpenCode swaps models in and out, and individual models occasionally stop serving
(an upstream `401` on one id while others answer fine). If a free-tier model fails, list what's currently
reachable and pick another:

```bash
opencode models | grep free
```

### OpenCode limitations

- `opencode run` has no read-only mode, so a read-only flow is not sandboxed by the CLI — the session
  directory is the boundary, as it already is for OpenAI Codex.
- No flag to grant write access to just one extra directory; permission is all-or-nothing.
- Reasoning effort is forwarded only on the headless `run` path (`--variant`); the interactive TUI path
  never receives it.
- Plateau escalation skips the effort rung, because the accepted `--variant` levels belong to whichever
  upstream vendor is behind your model id. Set `effort` explicitly on the row if your model supports it.

## Grok Build CLI

Runs every flow, backed by an xAI account. Catalog models are `grok-4.6` (flagship / default) and
`grok-4.5`, each with a 500k context window. Verified against Grok Build CLI v1.0.5.

```bash
# macOS / Linux
curl -fsSL https://x.ai/cli/install.sh | bash
# Windows
irm https://x.ai/cli/install.ps1 | iex
# any platform
npm i -g @xai-official/grok

grok login
ralphctl settings apply-preset grok-only
```

Headless delivers the prompt via `--prompt-file grok-prompt.md` (never stdin, never an inline `-p`
fallback — a failed write fails the spawn). Interactive never passes `--prompt-file` (that forces
headless); it uses `--permission-mode acceptEdits` plus a positional prompt pointer. Headless
resume is `-r` (interactive session id is `-s`); a stale session ("session not found" / 404 restore)
falls back to a cold spawn.

Read-only flows deny `search_replace` (edit) and both shell ids (`run_terminal_command` live,
`run_terminal_cmd` docs), plus `--no-subagents`. A no-network session also denies `web_search` /
`web_fetch`. The `write` tool stays allowed so `signals.json` can land. `--sandbox off` is forced
and there is no `--add-dir` — extra roots are a named over-grant. Never `--permission-mode plan`
(blocks `signals.json`).

Effort is forwarded as `--effort` on both surfaces, so plateau escalation can raise effort on the
same model, then climb `grok-4.5` → `grok-4.6`. Doctor cannot check whether you are signed in —
sign in with `grok login`. The availability probe is passthrough (not `grok models`).

Reads `AGENTS.md` (shared with Codex and OpenCode). Codex, OpenCode, and Grok share one repo-root
`AGENTS.md`. Readiness for more than one of them writes that file in sequence; each later pass
keeps the previous body at `AGENTS.md.bak.<timestamp>`. Skills and agent definitions live under
`.grok/`; operator skills under `~/.ralphctl/skills/grok/`. Docs: https://docs.x.ai/build/overview.

## Choosing between them

- **Want the most proven path?** Claude Code.
- **Already have a Copilot seat?** GitHub Copilot CLI — no extra billing relationship.
- **Live in the ChatGPT/OpenAI ecosystem?** OpenAI Codex CLI.
- **Want a specific model, a local model, or no account at all?** OpenCode.
- **Live in the xAI / Grok ecosystem?** Grok Build CLI.

Hit a rough edge with any provider? Please [open an issue](https://github.com/lukas-grigis/ralphctl/issues).

## Adding a new provider

See [adding-a-provider.md](./adding-a-provider.md).
