# Providers

ralphctl drives four AI coding CLIs. All four run every flow and are supported first-class. Pick one per
flow — or mix them, say plan with one and implement with another — through a preset or per-row settings.

This page is the detailed reference. The [README](../README.md#providers) has the summary.

## At a glance

| Provider                                  | CLI        | Install                              | Auth                  | Context file                      | Skills directory |
| ----------------------------------------- | ---------- | ------------------------------------ | --------------------- | --------------------------------- | ---------------- |
| **Claude Code** (`claude-code`)           | `claude`   | `npm i -g @anthropic-ai/claude-code` | Anthropic account     | `CLAUDE.md`                       | `.claude/`       |
| **GitHub Copilot CLI** (`github-copilot`) | `copilot`  | `npm i -g @github/copilot`           | GitHub Copilot seat   | `.github/copilot-instructions.md` | `.github/`       |
| **OpenAI Codex CLI** (`openai-codex`)     | `codex`    | `npm i -g @openai/codex`             | ChatGPT / OpenAI      | `AGENTS.md`                       | `.agents/`       |
| **OpenCode** (`opencode`)                 | `opencode` | `npm i -g opencode-ai`               | your own key, or none | `AGENTS.md`                       | `.opencode/`     |

Bundled skill injection and `bodyFile` forensic capture work on all four. Parallel execution is
provider-agnostic — it works with whichever provider each implement role is configured to use.

## Permission model per backend

Each CLI exposes a different vocabulary for "let the agent work without asking". ralphctl maps its own
permission model onto whatever the backend offers:

| Provider           | Headless mapping                                                                                | Fine-grained gate?                |
| ------------------ | ----------------------------------------------------------------------------------------------- | --------------------------------- |
| **Claude Code**    | `--permission-mode bypassPermissions` + per-tool deny list                                      | Yes — per-tool deny list          |
| **GitHub Copilot** | `--autopilot --max-autopilot-continues=200` + `--allow-all` (per-tool deny list when read-only) | Yes — per-tool deny list          |
| **OpenAI Codex**   | `-s workspace-write` (topology-scoped)                                                          | No — two sandbox modes only       |
| **OpenCode**       | `--auto` (topology-scoped)                                                                      | No — permission is all-or-nothing |

For Codex and OpenCode, **path topology is the safety envelope** rather than a per-tool deny list. Codex's
sandbox has only two modes (read-only / workspace-write), so the cwd plus `--add-dir` set defines the scope.
OpenCode has no per-directory grant at all, and ralphctl writes its `signals.json` results file outside the
project folder, so it passes `--auto` on effectively every headless run — without it the agent would sit
blocked waiting for an approval that never arrives. In both cases the session directory is the real boundary.

## Claude Code

The most end-to-end mileage inside the harness — the most battle-tested backend, and the reference
implementation the others are checked against.

```bash
npm i -g @anthropic-ai/claude-code
ralphctl settings apply-preset claude-only
```

Full per-tool deny lists mean read-only flows are genuinely sandboxed by the CLI, not just by path scope.
Reads `CLAUDE.md` at the repo root as its native context file; ralphctl's readiness flow writes it.

## GitHub Copilot CLI

Runs every flow, backed by your GitHub Copilot seat.

```bash
npm i -g @github/copilot
ralphctl settings apply-preset copilot-only
```

Autopilot mode is capped at 200 continues per session. Like Claude Code it supports a per-tool deny list, so
read-only flows are CLI-enforced. Reads `.github/copilot-instructions.md`.

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

The other three each bind you to one vendor. [OpenCode](https://opencode.ai/) doesn't: it's a vendor-neutral
CLI that fronts **75+ model providers** (via [Models.dev](https://models.dev/)) plus local runtimes, on a
bring-your-own-key model.

```bash
npm i -g opencode-ai
opencode providers        # connect Anthropic / OpenAI / Ollama / … with your own keys
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

## Choosing between them

- **Want the most proven path?** Claude Code.
- **Already have a Copilot seat?** GitHub Copilot CLI — no extra billing relationship.
- **Live in the ChatGPT/OpenAI ecosystem?** OpenAI Codex CLI.
- **Want a specific model, a local model, or no account at all?** OpenCode.

Hit a rough edge with any provider? Please [open an issue](https://github.com/lukas-grigis/ralphctl/issues).

## Adding a new provider

See [adding-a-provider.md](./adding-a-provider.md).
