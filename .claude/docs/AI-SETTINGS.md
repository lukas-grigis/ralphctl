# AI Settings

> On-demand reference (split out of `CLAUDE.md`). Read when working on `settings.ai`, effort
> resolution, presets, or the per-flow provider/model wiring.

`settings.ai` carries one optional global `ai.effort` plus per-flow configuration. Five flows use a flat
`{ provider, model, effort? }` row: `ai.{refine,plan,readiness,ideate,createPr}`. The `implement` flow is a
nested pair: `ai.implement.{ generator, evaluator }`, each its own `{ provider, model, effort? }` row —
generator produces the change, evaluator scores it, and they may run on different providers / models /
effort levels. `detect-scripts` and `detect-skills` reuse the `readiness` row; `review` reuses
`ai.implement.generator` (same code-mutation profile, no dedicated row) — no dedicated settings rows for
either. The `createPr` row drives the optional AI step inside `create-pr --ai`; settings
files written by ralphctl ≤ 0.8.x are missing it and the load path silently seeds it from `ai.refine` (no
`schemaVersion` bump; canonical shape lands on the next save). Per-flow `model` accepts the matching
provider's catalog or any non-empty trimmed custom string; per-flow `effort` validates against the
provider's native vocabulary.

**Effort resolution** at every AI-spawning leaf (`src/business/settings/resolve-effort.ts`): per-flow
`ai.<flow>.effort` wins; otherwise the global `ai.effort` floored to the row's provider ceiling;
otherwise the flow's shipped default (`FLOW_DEFAULT_EFFORT`: plan / ideate / implement → `high`, refine /
readiness → `medium`, createPr → `low`; review inherits implement's), floored to the row's provider
ceiling — deliberately the lowest-precedence layer, below the global default, so an operator who has
set `ai.effort` keeps that deliberate choice untouched. Every flow has an entry on purpose: ralphctl never
leaves an effort-capable provider on its CLI's built-in default, which moves between model releases
(Claude Code runs Opus 5.5 and Sonnet 5.5 at `medium` with no `--effort`; earlier Opus and Sonnet
models ran at `high`). The only
path that still reaches the CLI default is an opencode row with no row or global effort. Readiness,
distill, the implement roles, create-pr and review all resolve through the same function.
**Per-model narrowing:** every layer is then clamped to the row's MODEL when the catalog knows its effort
list — `CLAUDE_MODEL_EFFORT_LEVELS` (`settings-models/claude.ts`: `claude-haiku-4-5` has no effort,
`claude-sonnet-4-6` no `xhigh`), `COPILOT_MODEL_EFFORT_LEVELS` (`settings-models/copilot.ts`, from the Copilot SDK's `listModels()`),
`CODEX_MODEL_EFFORT_LEVELS` (`settings-models/codex.ts`, from `~/.codex/models_cache.json`) and
`GROK_MODEL_EFFORT_LEVELS` (`settings-models/grok.ts`, from the model menus shipped in the Grok Build CLI
1.0.62 binary), read via `modelEffortLevels()` in `effort.ts`. The Copilot, Codex and Grok
CLIs exit 1 on a level the model lacks. `clampEffortToModel`
drops effort for a model with none (Copilot `claude-haiku-4.5` — the CLI rejects every level; Claude Code
`claude-haiku-4-5` — the CLI ignores it) and otherwise
takes the strongest supported level below the request; it applies to an explicit row effort too. An
unknown model (custom id, `grok-4.7-build-fast`, or an opencode row) falls back to the provider floor for the
global / default / agent-binding layers and passes an explicit row effort through verbatim. When a CLI
still rejects the effort or model, `classifySpawnExit` returns a non-retryable `InvalidStateError` stamped
with a `ProviderConfigRejection` state, and the implement turn blocks once, naming
`ai.implement.<role>.effort|model`. Codex accepts `low..ultra` — `max` on every catalog model (the
GPT-5.6 and GPT-6 families), `ultra` only on `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6-sol`, `gpt-5.6-sol`, and `gpt-5.6-terra`
(plan-gated); a custom codex model floors a global `max` to `xhigh`; `minimal` no longer exists — persisted
rows migrate to `low` at parse time. OpenCode accepts `minimal | low | medium | high | xhigh | max`
(`src/domain/value/settings-models/effort.ts`) and forwards the resolved value verbatim to `--variant` on
`opencode run`; it gets no entry in `clampEffortToProvider`, so the CLI is the final arbiter per upstream
model — OpenCode aggregates other vendors, and the accepted `--variant` levels belong to whichever vendor
sits behind the `provider/model` id. Two deliberate carve-outs follow from that: the shipped per-flow
default is NOT stamped on an opencode row (`resolve-effort.ts`), matching
its absence from `FIXED_EFFORT_RUNG` in `escalation-map.ts`, because a level the upstream model never supported
would turn a working spawn into a hard failure; and `--variant` exists only on the `run` subcommand, so
the interactive TUI path (`opencode <cwd> --model …`) forwards no effort at all. This headless/interactive
asymmetry is declared per provider as `ProviderTraits.effortForwarding.{headless,interactive}`
(`providers/_engine/provider-traits.ts`) — OpenCode is the only row where the two differ — and the port
conformance suites assert each adapter's argv against that declaration in both directions, so an adapter
that starts or stops forwarding effort without updating its row fails at `pnpm test`. Grok rows accept
`low | medium | high | xhigh | max` and forward `--effort` on **both** surfaces (identity in
`clampEffortToProvider`), but the models cap lower: `grok-4.5` takes `low..high`, `grok-4.6` / `grok-4.7`
`low..xhigh`, and none takes `max` — so a row or global `max` resolves to `xhigh` on `grok-4.7`. The CLI
refuses any level a model's menu doesn't list, which rules out `none` / `minimal` everywhere: persisted
grok rows carrying either migrate to `low` at parse time, like Codex `minimal`. That migration is for
loading old files only: `settings set` refuses any row effort outside the provider's list (and a retired
model id, naming its successor) rather than letting the save rewrite it. A Grok rejection
(`Couldn't apply reasoning effort` / `unknown effort level`) classifies as the same `ProviderConfigRejection`
as Copilot's and Codex's. `grok-4.7-build-fast` has no published effort
data and passes through. Grok has a `FIXED_EFFORT_RUNG` entry. The implement generator's
resolved effort also feeds the escalation policy's same-model effort rung,
whose target is provider- and model-aware: a Claude generator at the top of the model ladder climbs one
tier above its EFFECTIVE effort — the explicit level, or, only when genuinely unset, the model's own
Claude Code CLI default (`medium` on Opus 5.5 and Sonnet 5.5, `high` on every other effort-capable Claude model — the gap
between the two is exactly why ralphctl stamps an explicit effort on every flow now) — while Copilot
escalates to a fixed `high` and Codex and Grok to a fixed `xhigh` (on Grok capped to the model's ceiling,
so `grok-4.5` climbs to `high`) — see
`PERFORMANCE.md § plateau escalation` and `§ Default escalation posture` below for the shipped default's
own trace.

**Single-provider configurations are first-class.** Every row may point at the same provider, or every row
at a different one; the launcher rebuilds the provider / interactive-AI / skills-adapter trio per launch
keyed on the dispatched flow's row, so mixed and uniform configs traverse the same code path.

**Per-flow skill opt-out — `settings.ai.skills`.** An optional, durable preference of shape
`Partial<Record<FlowId, { disabled: string[] }>>`. Every flow key is optional; an absent key — or an absent
`ai.skills` altogether — means the flow's registry defaults apply. Each flow's `disabled` array lists skill
names (`ralphctl-*`) to SUBTRACT from that flow's bundled defaults at launch. Names are not validated against
the bundled catalog at parse time, so an unknown name is a harmless no-op. This is opt-OUT only — adding a
skill beyond the defaults is filesystem-based (`<appRoot>/skills/<flow>/` folders), never settings.

```json
"skills": {
  "implement": { "disabled": ["ralphctl-ponytail"] },
  "refine": { "disabled": [] }
}
```

Precedence at launch: per-run override > this saved preference > registry default. The per-run override is
the customize picker's checklist; the saved preference is this key; the registry default is the flow's
bundled skill set.

**Agent-definition role binding — `settings.ai.implement.agents`.** An optional per-role binding of shape
`{ generator?: string, evaluator?: string }` under `ai.implement.agents`; either, both, or neither role may
be bound, and an absent block (or absent role key) means that role runs unaided — exactly as before this
field existed. The bound value is an `AgentDefinition` name resolved against the composed bundled +
operator catalog (`integration/ai/agents/`; see `ARCHITECTURE.md § Agent definitions subsystem`) — a name
that doesn't resolve is a logged warning, not a launch failure, and the role falls back to running unaided.

```json
"implement": {
  "generator": { "provider": "claude-code", "model": "claude-opus-4-8" },
  "evaluator": { "provider": "claude-code", "model": "claude-opus-4-8" },
  "agents": { "generator": "ralphctl-generator" }
}
```

Set or clear via `ralphctl settings set ai.implement.agents.<role> <name>` (empty value clears); list
what's available (bundled + operator, and which role each is currently bound to) via `ralphctl agents list`.

**Precedence when a role is bound — definition > per-flow row > global default.** `resolveAgentOverride`
(`business/settings/resolve-agent-override.ts`) resolves the effective `model` as the definition's `model`
when set, else the role's own per-flow row `model` (always present); `effort` follows the same order but
falls through to the existing per-flow-row → global-default resolution (**Effort resolution** above) when
neither the definition nor the row set one explicitly.

**Twenty-six presets across five families** stamp the entire `ai` section plus `harness.escalateOnPlateau`
in one shot — all equally first-class (none is marked default). Economic, strong-gate, fast, and frontier
each carry five variants: `mixed` (best-fit provider per flow), `claude-only`, `copilot-only`, `codex-only`,
and `grok-*`. The standard family also carries `opencode-only`. Every row of every preset now pins an
explicit effort — none inherits the global preset effort or a provider CLI default (see **Effort
resolution** above). The families:

- **standard** (`mixed`, `claude-only`, `copilot-only`, `codex-only`, `opencode-only`, `grok-only`) —
  flagship model at `xhigh` effort on `plan`/`implement`; `refine` and `readiness` at `medium` (Codex's
  cheap-tier `refine` is the exception: `codex-only` and `mixed` both run it on `gpt-6-luna` and compensate
  with `high`); `ideate` at `high`; `createPr` at `low`. `opencode-only` is a single-member extra by
  design: every OpenCode free-tier model sits at the same (zero) price point, so economic / fast / frontier
  variants would differ in name only. Operators who authenticate an upstream provider should pin rows
  directly via `opencode providers` rather than reach for a preset (see the `OPENCODE_ONLY` note in
  `src/business/settings/opencode-preset-matrices.ts`). Its rows leave `effort` unset for the reason given
  under **Effort resolution** above. `grok-only` stamps that same matrix onto `grok-4.7` (implement / plan
  / ideate, at `xhigh`/`xhigh`/`high`), `grok-4.6` (refine, at `medium` like Claude/Copilot), and `grok-4.5`
  (readiness / createPr). Mixed presets were not rerouted onto Grok — `mixed` and `mixed-frontier` keep the
  Claude author / Codex critic split.
- **economic** (`mixed-economic`, `claude-economic`, `copilot-economic`, `codex-economic`, `grok-economic`) —
  same routing as standard but `implement` starts one tier below the flagship at `high` effort (Sonnet /
  Copilot Sonnet / `grok-4.6`); the escalation ladder climbs to the flagship only when a task plateaus —
  cheaper tokens on easy tasks, same quality gate on hard ones. `claude-economic` also moves its light
  flows (`refine` / `readiness` / `createPr`) to `claude-haiku-5-5` at `low`; `plan` / `implement` /
  `ideate` stay on Sonnet 5.5. `codex-economic` is the exception: it stays
  on `gpt-6-luna` — one tier below `gpt-6.1-sol` — and buys back quality with `xhigh` effort instead of a
  model bump; `gpt-6-luna` at `xhigh` is reported to match `gpt-5.6-sol` at roughly 1/20 of the sol price.
  `mixed-economic` pairs a Sonnet generator with that same Codex-luna-at-`xhigh` critic — a cross-provider
  second opinion at near-zero cost. `grok-economic` starts implement on `grok-4.6`, which publishes the
  same token price as `grok-4.7`, so the saving there is the lower effort plus staying off the flagship
  until a plateau.
- **strong-gate** (`mixed-strong-gate`, `claude-strong-gate`, `copilot-strong-gate`, `codex-strong-gate`,
  `grok-strong-gate`) — cheap generator tier paired with a permanently-flagship evaluator gate — the only
  family that intentionally splits `implement.generator` and `implement.evaluator` onto different models. The
  generator climbs to the flagship on plateau via the escalation ladder (`escalateOnPlateau` stamped `true`).
  `mixed-strong-gate` keeps both roles on Claude rather than mixing providers — the family already splits by
  tier. The Codex variant (`gpt-6-luna` gen → `gpt-6.1-sol` gate) and the Grok variant (`grok-4.6` →
  `grok-4.7`) are both a single ladder rung; Codex's generator additionally runs at `xhigh` rather than
  `high` — the same effort-compensates-for-tier pattern as `codex-economic`.
- **fast** (`mixed-fast`, `claude-fast`, `copilot-fast`, `codex-fast`, `grok-fast`) — cheapest viable tier at
  `low` effort across the board; implement always stays on a code-capable tier, never a sub-coding model —
  too weak to author code reliably. `claude-fast` runs Haiku 5.5 (`claude-haiku-5-5`) on the light flows
  (`refine` / `readiness` / `createPr`) and Sonnet 5.5 on `plan` / `implement` / `ideate`, all at `low` —
  implement stays on the code-capable Sonnet. `codex-fast` and `grok-fast` are uniformly one model
  (`gpt-6-luna` / `grok-4.5`) at `low` across every row — `gpt-6-luna` is itself code-capable, so Codex
  needs no separate implement tier. `copilot-fast` and `mixed-fast` still mix
  models even at this tier: Copilot's light flows (refine/readiness/ideate/createPr) drop to
  `gpt-6-luna` while `plan`/`implement` stay on Claude Sonnet 5.5 (Copilot's cheapest code-capable model);
  `mixed-fast` likewise keeps Claude Sonnet on `plan`/`implement` and Codex/Copilot Luna on the light flows.
  This is the only family with `escalateOnPlateau` stamped **`false`** — a plateau settles
  (done-with-warning) rather than climbing the ladder, which is what keeps the family genuinely cheap and
  predictable.
- **frontier** (`mixed-frontier`, `claude-frontier`, `copilot-frontier`, `codex-frontier`, `grok-frontier`) —
  the vendor's top model on the deep flows (`plan`/`implement`) at `max` effort; `refine`/`readiness` at
  `high`, `ideate` at `high`, `createPr` at `medium` — no row runs a light flow at `max`. Frontier now means
  Claude's flagship is Fable 5.1, not Opus: `claude-frontier` and `mixed-frontier` run `plan`/`implement`/
  `ideate` on `claude-fable-5-1` (2.5× the Opus 5.5 price, needs a non-ZDR org). `claude-frontier` keeps
  `refine`/`readiness`/`createPr` on Opus 5.5; `mixed-frontier` keeps only `readiness` there, runs
  `refine`/`createPr` on `gpt-6.1-sol`, and gates implement with a `gpt-6-astra` critic. `codex-frontier` steps up to `gpt-6-astra` (5× the `gpt-6.1-sol` price) on the deep flows,
  with `gpt-6.1-sol` on the light ones; `ultra` is deliberately not used (plan-gated to Plus+, would brick
  spawns on lower plans). `copilot-frontier` and `grok-frontier` have no equivalent premium tier available
  by default, so they stay on their existing flagship (`claude-opus-5.5` — GitHub gates Opus 4.8 / 5 / 5.5
  identically, so the newest and cheapest Opus reaches the same accounts — and `grok-4.7`).
  `copilot-frontier` differentiates purely by effort. `grok-frontier` cannot: `grok-4.7` caps at `xhigh`,
  the level `grok-only` already runs on the deep flows, so it stamps `xhigh` there (global too) and
  differentiates by running every light flow on the flagship (`refine` / `readiness` at `high`, `createPr`
  at `medium`) and lifting `ideate` to `xhigh`. `grok-4.7-build-fast` is the same exclusion
  as Fable / Astra: same model, twice the token price, never a preset pick.

**`applyPreset` stamps `harness.escalateOnPlateau`** alongside the AI section. Standard / economic /
strong-gate / frontier all stamp it `true`; fast stamps it `false`. The rest of `harness` (`maxTurns`,
`escalationMap`, `plateauThreshold`, …) plus all other top-level settings keys are preserved verbatim.

**Model-tier ordering.** The ladders each family relies on are grounded in SWE-bench rankings (June
2026 data): Claude haiku 5.5 < sonnet < opus 5.5 < fable (Haiku 5.5 runs only the light flows of the
fast / economic presets; Haiku 4.5 is pin-only ahead of its Anthropic retirement horizon); GPT 5.6 (luna < terra < sol) < GPT-6 (luna < sol < astra) — the older
GPT-5 ids (`gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5-mini`) are retired on both Codex and Copilot and
remapped at parse time; Grok `grok-4.5` < `grok-4.6` < `grok-4.7` (`grok-4.6` and `grok-4.7` publish the
same token price). These
orderings explain why the cheap-to-strong tier progressions are wired the way they are — not as
guaranteed scores (OpenAI stopped publishing SWE-bench Verified after contamination concerns, and
results swing significantly with scaffolding). Treat this as relative-ordering rationale, not a
performance promise.

Apply via `ralphctl settings apply-preset <name>` or from the TUI settings view. Re-applying overwrites
every `ai` row plus `harness.escalateOnPlateau` in one transaction; the skills opt-out (`ai.skills`) and
the implement agent bindings (`ai.implement.agents`) carry over. Subsequent per-key edits via
`ralphctl settings set ai.<flow>.<field> <value>` stick.

**Presets adapt to the account.** Before saving, the apply-preset flow asks each stamped provider's
model-availability probe (`AppDeps.availableModelsFor`) which models the signed-in account can run, and
`adaptAiToAvailableModels` (`business/settings/adapt-to-available-models.ts`) moves any row it can't run
to the nearest available stand-in from `PRESET_MODEL_FALLBACKS` (same provider, same or cheaper tier —
e.g. Copilot `gpt-6-luna` → `gpt-5.6-luna`, `claude-opus-5.5` → `claude-sonnet-5.5` (Opus 4.8 retires 2026-11-16);
a cheapest tier with no cheaper sibling steps up instead). Each swap is
reported (CLI `note:` lines, TUI preset card, first-run Welcome log); a row with no available stand-in
keeps its model and is reported too. A probe that can't answer fails open to the full catalog, so it
never rewrites a row. Live sources: Copilot's headless server, Codex's `~/.codex/models_cache.json`,
`opencode models`; Claude Code and Grok have no listing and are taken as-is, so their
`PRESET_MODEL_FALLBACKS` entries are inert until a real probe exists. A lockstep test requires a
`PRESET_MODEL_FALLBACKS` entry for every model a preset or provider default stamps.

**Model catalog versions used by the presets** (verified against the tool versions noted per row):

- Claude Code — lists 12 models: `claude-haiku-4-5` / `claude-haiku-5-5` / `claude-sonnet-4-6` / `claude-sonnet-5` /
  `claude-sonnet-5-5` / `claude-opus-4-8` / `claude-opus-4-8[1m]` / `claude-opus-5` / `claude-opus-5-5` /
  `claude-fable-5` / `claude-fable-5[1m]` / `claude-fable-5-1` (verified against Claude Code v2.1.197;
  `claude-opus-5-5` and `claude-fable-5-1` were live-probed on Claude Code 2.1.280, 2026-09-22 — Opus 5.5
  requires that version or later). **Added 2026-10-11:** `claude-haiku-5-5` (Claude Code >= 2.1.293,
  released 2026-10-07), the default Haiku on the Anthropic API — $0.10/$0.50 per MTok ($0.50/$2.50 for
  prompts over 100K), natively 1M with no `[1m]` variant, 128K output, all five effort levels, and a CLI
  default effort of `medium`. It runs the light flows of `claude-fast` / `claude-economic` and is the
  bottom rung of the claude-code ladder (Haiku 5.5 → Sonnet 5.5 → Opus 5.5). `claude-haiku-4-5` (no
  effort dimension; still Active, retirement not before 2026-10-15) stays for pinned configs only and
  keeps its rung to Sonnet 5.5.
  **Added since the 2026-09-22 reconciliation:** `claude-sonnet-5-5`, live-probed on Claude Code 2.1.285
  (2026-09-30; the CLI requires v2.1.284 or later). It is the **default Sonnet** across the Claude-family
  presets, the new-install claude-code defaults, and the claude-code escalation ladder (Haiku 5.5 → Sonnet
  5.5 → Opus 5.5): $2/$10 per MTok, natively 1M with no `[1m]` variant, 128K output, all five effort levels,
  and — like Opus 5.5 — a Claude Code CLI default effort of `medium` (the Claude API documents `high`;
  the effort rung follows the CLI). Its effort levels are recalibrated against Sonnet 5, so the same
  preset level does not buy the same amount of thinking. Copilot serves it as the dotted
  `claude-sonnet-5.5` (the dash form `claude-sonnet-5-5` is rejected there), and the Copilot rows and
  ladder use it (see the Copilot entry below). `claude-sonnet-5` is **not retired** — it stays live on Claude Code
  (and is Claude Code's cybersecurity fallback for Sonnet 5.5), keeps its own ladder rung to Opus 5.5, and
  a row pinned to it loads unchanged (no `RETIRED_MODEL_REMAPS` entry). Nothing was removed.
  `claude-opus-5-5` is the Opus 5 successor and the **default Opus** across presets, the new-install
  defaults, and the escalation ladder — and it's cheaper, not pricier: $4/$20 per MTok against Opus 5's
  $5/$25. Its Claude Code CLI default effort is `medium`, unlike every earlier Opus's `high` — the reason
  ralphctl stamps an explicit effort on every flow rather than relying on the CLI default (see **Effort
  resolution** above). `claude-opus-5` and `claude-opus-4-8` are kept alongside it (all Active at
  Anthropic) so pinned configs keep working; both now carry a ladder rung up to Opus 5.5. Like Sonnet 5
  and 5.5, Opus 5.5 has **no `[1m]` variant** — on the Anthropic API it always runs at its native 1M window in
  Claude Code (default AND max), so the 1M figure is recorded against the bare id in the context-window
  tables; 128K output. The catalog additionally lists the frontier tier `claude-fable-5-1` (successor to
  `claude-fable-5`, same $10/$50 price — 2.5× Opus 5.5 now, and requires 30-day data retention: a
  zero-data-retention org gets a 400) plus the 1M-context variants `claude-opus-4-8[1m]` and
  `claude-fable-5[1m]` (the `[1m]` suffix is Claude Code's long-context syntax, passed through verbatim).
  Those two are now **redundant** — Claude Code runs Opus 4.7+ and Fable at 1M by default with no suffix,
  so the bare `claude-opus-4-8` / `claude-fable-5` ids already carry 1M in the context-window tables —
  and stay only so pinned configs keep loading. Fable is **opt-in only** outside the frontier presets — no default or
  built-in escalation rung references Fable; pick per row or add a `'claude-opus-5-5': 'claude-fable-5-1'`
  rung via `settings.harness.escalationMap`. Fable is **GA** (the 2026-06-12 export-control suspension has
  been lifted — `settings-models/suspended-models.ts` keeps the kill-switch mechanism, now empty) — it
  stays opt-in outside the frontier presets for a different reason: 2.5× the Opus 5.5 price is an operator
  spend decision, not a capability gate.
- GitHub Copilot — lists 24 models reconciled to GitHub's supported-models doc + changelog and
  checked against the Copilot SDK's `listModels()` (Copilot CLI 1.0.91) on a reference account (as of 2026-10-03): OpenAI
  `gpt-5.3-codex`, `gpt-5.4-nano`, `gpt-5.6-sol`,
  `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6.1-sol`, `gpt-6-luna`; Anthropic `claude-haiku-4.5`,
  `claude-haiku-5.5`, `claude-opus-4.8`, `claude-opus-4.8-fast`, `claude-opus-5`, `claude-opus-5.5`,
  `claude-fable-5`, `claude-fable-5.1`, `claude-sonnet-5`, `claude-sonnet-5.5`; Google
  `gemini-3.8-flash`; Microsoft `mai-code-1.1-flash`; Moonshot `kimi-k3`; xAI `grok-4.6`, `grok-4.7`. The 2026-09-01 GitHub deprecation (changelog
  2026-08-31) removed `claude-opus-4.5`, `claude-opus-4.6`, `claude-sonnet-4.5` (the former default),
  `claude-sonnet-4.6` (kept upstream only for individual annual-plan subscribers), `gemini-3.1-pro`, and
  `raptor-mini`; `mai-code-1-flash` was dropped as superseded by `mai-code-1.1-flash`. The 2026-10-02
  deprecation removed `gemini-3.5-flash`, `gemini-3.6-flash`, `kimi-k2.7-code` and `claude-opus-4.7`
  (remapped at parse time; `gemini-3-flash` now collapses to `gemini-3.8-flash`). The 2026-10-19
  deprecation removed `gpt-5.5` / `gpt-5.4` (→ `gpt-5.6-sol`), `gpt-5.4-mini` / `gpt-5-mini`
  (→ `gpt-5.6-luna`), `gemini-3.7-flash` (→ `gemini-3.8-flash`) and `grok-4.5` (→ `grok-4.6`) — GitHub's
  named successors, remapped at parse time; `grok-4.5` is retired on Copilot only and stays on the
  `xai-grok` backend, so its remap is copilot-provider-guarded. **Added 2026-10-17:** `claude-haiku-5.5`
  (changelog 2026-10-07; needs Copilot CLI 1.0.94 or later), with a ladder rung to `claude-sonnet-5.5`.
  Its effort list mirrors Claude Code's Haiku 5.5 (all five levels) and is not yet confirmed by
  `listModels()`. **Retiring 2026-11-16** (changelog 2026-10-15): `claude-opus-4.8` and `claude-opus-5`
  (→ `claude-opus-5.5`; 4.8 stays for annual plans) and `gpt-5.6-terra` (→ `gpt-6.1-sol` or
  `gpt-6-luna`). They stay listed until that date, but nothing ralphctl stamps leans on them: the ladder
  climbs `gpt-5.6-luna` straight to `gpt-5.6-sol`, the `claude-opus-5.5` preset fallback goes to Sonnet
  5.5, and the older retired Opus ids (`claude-opus-4.5` / `-4.6` / `-4.7`) remap to `claude-opus-5.5`.
  New in the 2026-09
  changelog: `claude-opus-5.5` (09-22, Pro+/Max/Business/Enterprise), `claude-fable-5.1` (09-01, Pro+ and
  up, off by default for Business/Enterprise), `gpt-6-astra` (09-04, Pro+ and up), `gpt-6-sol` /
  `gpt-6-luna` (09-22; luna includes Pro), `gemini-3.8-flash` (09-03), and `grok-4.7` (09-21, gradual
  rollout). Of these, only `gemini-3.8-flash` answered on the reference account; the other six
  (`claude-opus-5.5`, `claude-fable-5.1`, `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `grok-4.7`) did not
  yet, so they are catalog + pin-only.
  Verified available on the reference account: `claude-sonnet-5`, `claude-sonnet-5.5`, `claude-opus-4.8`,
  `claude-opus-5`, `claude-haiku-4.5`, `gpt-5.3-codex`, `gpt-5.6-sol` / `-terra` / `-luna`, `gemini-3.8-flash`, `mai-code-1.1-flash`, and `grok-4.6`; the
  remaining entries are convention-derived slugs from the doc's display names — the Copilot CLI still
  cannot enumerate its catalog non-interactively (github/copilot-cli issue #700) — and are not validated
  against the live CLI. Every rename/delisting is covered by `RETIRED_MODEL_REMAPS`, so a pinned settings
  row loads on its successor rather than on a slug the adapter rejects at spawn. Note: `claude-sonnet-5`,
  `claude-opus-5`, and `claude-fable-5` carry no dot/date, so their Copilot slugs are the SAME string as
  the Claude-Code ids — the escalation ladder is scoped per provider now (`escalation-map.ts`), so the
  collision no longer constrains either climb. GitHub's plan tables gate `claude-opus-4.8`,
  `claude-opus-5` and `claude-opus-5.5` identically (Pro+/Max/Business/Enterprise, none on Pro), so
  Copilot's curated presets, provider defaults and default escalation ladder top out on the newest and
  cheapest, `claude-opus-5.5` ($4/$20 vs 4.8's $5/$25); rows pinned to 4.8 or 5 climb to it. On a Pro
  account the apply-preset adaptation steps Opus rows down to `claude-sonnet-5.5`. The Copilot availability probe (`providers/copilot/model-availability-probe.ts`)
  asks the CLI's own headless JSON-RPC server (`copilot --headless --stdio`: `connect`, `models.list`)
  for the account's models — the CLI handles auth, so no keychain token is read — and keeps those with an
  `enabled` policy or no policy. It fails open to the full catalog (the `connect` handshake is marked
  experimental in the Copilot SDK).
- OpenAI Codex — verified against the live CLI model cache (codex CLI v0.160.0,
  `~/.codex/models_cache.json`, 2026-10-03). `gpt-6.1-sol` is the flagship and the top rung of the Codex
  escalation ladder — $2/$10 per MTok, half the `gpt-5.6-sol` price, and the model `codex-only` runs
  implement on (`codex-frontier` runs it on `gpt-6-astra`); `gpt-6-sol` is the previous generation, kept for
  pinned configs and climbing to `gpt-6.1-sol`; `gpt-6-luna` is the cheap tier ($0.10/$0.50); `gpt-6-astra` is the
  premium tier ($10/$50, frontier presets only, never a default or ladder rung). All run
  `low..max`; `ultra` exists on `gpt-6.1-sol`, `gpt-6-sol` and astra but NOT luna — effort resolution
  narrows per model from `CODEX_MODEL_EFFORT_LEVELS` (see **Effort resolution**). `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` remain in the catalog for
  pinned configs and chain up their own tier into the GPT-6 family (`gpt-5.6-sol` → `gpt-6.1-sol`, `gpt-5.6-terra` → `gpt-5.6-sol`,
  `gpt-5.6-luna` → `gpt-5.6-terra`). `gpt-5.5` retired from Codex on 2026-10-14 and was REMOVED;
  persisted rows remap to `gpt-5.6-sol`. `gpt-5.4` / `gpt-5.4-mini`
  retired from Codex on 2026-08-31 and were REMOVED from this catalog; persisted rows remap to
  `gpt-6-sol` / `gpt-6-luna` at parse time (Copilot retired the same slugs onto `gpt-5.6-sol` /
  `gpt-5.6-luna`, so each remap is provider-guarded). Bare `gpt-5.6` is an API-only alias rejected under ChatGPT auth and is
  deliberately NOT listed. `gpt-5.2` / `gpt-5.3-codex` / `gpt-5.3-codex-spark` are gone from the CLI
  entirely and stay REMOVED, remapping to `gpt-5.6-sol` at parse time (chain-collapsed when `gpt-5.5`
  retired; `gpt-5.3-codex` stays in the **Copilot** catalog, so that remap is codex-provider-guarded too). Effort vocabulary is `low..ultra`;
  `minimal` was retired and persisted rows migrate to `low`; `max` now covers the 5.6 AND GPT-6 families,
  `ultra` every non-luna tier of those two families.
- OpenCode — structurally unlike the other four: `OPENCODE_MODELS`
  (`src/domain/value/settings-models/opencode.ts`, verified against `opencode models opencode`,
  opencode-ai v1.18.35, 2026-10-17 — 11 ids; `hy3-free`, `mimo-v2.5-free` and
  `muse-spark-1.2-contributor-free` left the tier, the last two remapping to `mimo-v2.6-flash-free` /
  `muse-spark-1.3-contributor-free`) is the **zero-auth free-tier floor**, not a vendor catalog. Only
  **OpenCode 1** is supported: OpenCode 2 ships as the same `opencode` binary but its `run` has no
  `--dir` / `--variant` and its root command no `--model`, so the launch check below refuses a 2.x
  binary. Ids are namespaced
  `<provider>/<model>` (an aggregator upstream may add further segments), and the adapter validates only
  that SHAPE — it does **not** reject off-catalog ids, because doing so would make every authenticated
  model un-runnable. The runtime `opencode models` probe
  (`providers/opencode/model-availability-probe.ts`) reports whatever the operator's authenticated
  providers actually serve, so the picker grows without a ralphctl release. The free tier rotates
  upstream; a stale entry degrades to a picker row the CLI rejects, never a crash. When that probe
  cannot answer (binary absent, not authenticated, 15 s cap, abort) the picker falls back to the
  free-tier floor — a lossy fallback, unlike the other four backends — so every fail-open is logged
  at warn (`model-probe: opencode fell back to the shipped free-tier catalog`) with a reason.
- Grok — flag surface and permission semantics verified against Grok Build CLI 1.0.30's shipped CLI
  reference on 2026-09-15; minimum supported version 1.0.13 (`-s`). Model ids re-probed with
  `grok models` on CLI 1.0.40 (2026-09-22): `grok-4.7` (flagship / CLI default), `grok-4.7-build-fast`
  (same model, faster serving, 2× token price, not on the free tier — catalogued, never a preset
  default), `grok-4.6`, and `grok-4.5`. Each publishes a 500k context window. The availability
  probe is passthrough — the CLI exposes `grok models` but no cheap non-interactive per-account
  filter, so the static catalog is the picker source. An off-catalog id persists fine via
  `CustomModelStringSchema`, but the adapter rejects it at argv-build time rather than forwarding it,
  so a model xAI ships between ralphctl releases needs a catalog update (forwarding an unknown id to
  the CLI is OpenCode's contract, not Grok's).

**Default escalation posture (effort rung twice, no model ladder).**
`DEFAULT_SETTINGS.ai.implement.generator` is `claude-opus-5-5`, which has no key in
`DEFAULT_ESCALATION_LADDERS['claude-code']` — so the shipped default never model-escalates. (A pinned
`claude-opus-4-8` or `claude-opus-5` generator DOES model-escalate — both carry a live rung up to
`claude-opus-5-5` — before the effort rung below applies.) The default's effort rung is NOT inert, though,
and now fires twice: the generator's effort is left unset in `DEFAULT_SETTINGS`, so it resolves through
the `implement` flow's shipped default (`high` — see **Effort resolution** above), not through Opus 5.5's
own `medium` CLI default. On the first plateau at the top of the model ladder the graduated policy raises
reasoning effort (the `escalate-effort` rung) from `high` to `xhigh`; a second plateau raises it again,
`xhigh` to `max` — two live remedies where the old fixed `high` target would have been a no-op on every
earlier Opus (their CLI default was already `high`). Then — on a further plateau, opus now at `max` — it fires the same-model nudge (a
change-of-approach directive), then — since `harness.bestOfNCandidates` now defaults to `2` — one best-of-N
attempt that samples two candidates and selects by verification then judging, and only then settles
`done-with-warning`. To also activate a live MODEL ladder, use one of the `*-economic` presets (where
`implement.generator` starts on Sonnet and escalates to Opus 5.5) or add a custom rung via
`settings.harness.escalationMap`:

```json
"escalationMap": { "claude-opus-5-5": "claude-fable-5-1" }
```

`claude-fable-5-1` and the legacy `claude-fable-5` / `claude-fable-5[1m]` are in the Claude catalog as
**opt-in only** outside the frontier presets — no default or built-in escalation rung references them.
Select per row via the TUI picker or `settings set`, or add an escalationMap rung as shown above.
Escalation-map rungs can also be added and removed from the TUI's **Harness** settings section: the
`map-add` row walks a two-step from/to model picker; each existing override appears as a `map-entry` row
that can be retargeted or removed without leaving the TUI.

**`settings.harness` keys** (full list — see `PERFORMANCE.md § Iteration budget` for the gen-eval tuning knobs):

- `maxTurns`, `maxAttempts`, `rateLimitRetries`, `idleWatchdogMs`, `plateauThreshold`, `escalateOnPlateau`,
  `escalationMap` — see `PERFORMANCE.md`.
- `bestOfNCandidates` (default `2`) — the top-of-ladder remedy: once the model ladder AND the same-model nudge
  are both spent, a stuck task gets ONE more attempt that samples N candidates on the unchanged model and
  selects among them by verification then judging. `2`-`4` enables it, `0` disables it. The cost is bounded —
  at most once per task, and only for a task that already exhausted the whole ladder — but that one attempt
  spends N generator sessions instead of one, so the five `*-economic` presets pin it to `0` (applying one of
  them overwrites whatever you had set; every other preset leaves the knob alone). See
  `PERFORMANCE.md § Escalation on plateau`.
- `skipPreVerifyOnFreshSetup` (default `false`) — opt-in: skip the FIRST pre-task verify of a launch when this
  launch's own setup script already built and tested the same tree. Safe only when the setup script actually runs
  the verify gate (not merely installs dependencies) — an install-only setup script would hide a pre-broken
  baseline. Default `false` keeps the strict pre/post symmetry for everyone who has not made that assertion. See
  `PERFORMANCE.md § Verify-gate cost and scoping`.

**Fail-fast PATH check.** Every AI-spawning flow probes for its row's CLI binary at launch (`claude` /
`copilot` / `codex` / `opencode` / `grok` — `PROVIDER_BINARY` in `src/integration/system/detect-cli.ts`
covers all five) and exits with `LaunchResult.fail` naming the
binary, the flow, and the offending `settings.ai.<flow>.provider` key when the binary is absent.
Once every binary is present, a provider whose traits declare a `versionGate`
(`providers/_engine/provider-traits.ts` — today only OpenCode, pinned to major 1) has its
`<binary> --version` read once per launch (`probeUnsupportedVersion`); any other major fails the launch
with a one-line reason naming the version, the settings key, and the installers that still ship 1.x
(`brew install sst/tap/opencode` — Homebrew core's `opencode` formula tracks 2.x — the install script,
or `npm install -g opencode-ai@1`). An unreadable version fails open. `ralphctl doctor` runs the same check
for each configured, installed provider: an unsupported major is a `fail` row (`ai-<provider>-version`) with the
install hint, in place of that provider's auth row. `apply-preset` emits non-fatal warnings for any preset row whose CLI is missing at apply time, and the
welcome view silently auto-seeds a preset on fresh install based on what it detects on PATH.
