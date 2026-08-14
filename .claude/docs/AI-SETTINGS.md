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
otherwise, for `plan` and `ideate` only, a shipped default of `high` (floored to the row's provider
ceiling) — deliberately the lowest-precedence layer, below the global default, so an operator who has
set `ai.effort` keeps that deliberate choice untouched; otherwise the provider CLI's default. Codex
accepts `low..ultra` — from the **global** value, `max` floors
to `xhigh` (only the GPT-5.6 family accepts `max`); `ultra` (sol/terra-only, plan-gated) is reachable only
via an explicit per-flow effort; `minimal` no longer exists — persisted rows migrate to `low` at parse
time. OpenCode accepts `minimal | low | medium | high | xhigh | max`
(`src/domain/value/settings-models/effort.ts`) and forwards the resolved value verbatim to `--variant` on
`opencode run`; it gets no entry in `clampEffortToProvider`, so the CLI is the final arbiter per upstream
model — OpenCode aggregates other vendors, and the accepted `--variant` levels belong to whichever vendor
sits behind the `provider/model` id. Two deliberate carve-outs follow from that: the shipped per-flow
default (`plan` / `ideate` → `high`) is NOT stamped on an opencode row (`resolve-effort.ts`), matching
`EFFORT_CAPABLE_PROVIDERS` in `escalation-map.ts`, because a level the upstream model never supported
would turn a working spawn into a hard failure; and `--variant` exists only on the `run` subcommand, so
the interactive TUI path (`opencode <cwd> --model …`) forwards no effort at all. This headless/interactive
asymmetry is declared per provider as `ProviderTraits.effortForwarding.{headless,interactive}`
(`providers/_engine/provider-traits.ts`) — OpenCode is the only row where the two differ — and the port
conformance suites assert each adapter's argv against that declaration in both directions, so an adapter
that starts or stops forwarding effort without updating its row fails at `pnpm test`. The implement generator's
resolved effort also feeds the escalation policy's same-model effort rung,
whose target is provider- and model-aware: a Claude generator at the top of the model ladder climbs its own
effort tiers (Claude Code's default is `xhigh` on xhigh-capable models, so the shipped default
`claude-opus-5` with effort unset escalates to `max`, not `high`), while Copilot escalates to a fixed
`high` and Codex to a fixed `xhigh` — see `PERFORMANCE.md § plateau escalation`).

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

**Twenty-one presets across five families** stamp the entire `ai` section plus `harness.escalateOnPlateau`
in one shot — all equally first-class (none is marked default). Four families carry four variants each:
`mixed` (best-fit provider per flow), `claude-only`, `copilot-only`, `codex-only`; the standard family
additionally carries `opencode-only`. The families:

- **standard** (`mixed`, `claude-only`, `copilot-only`, `codex-only`, `opencode-only`) — flagship model
  per flow at `xhigh` effort for `implement`/`plan`; `readiness` at `medium`; `refine`/`ideate` inherit
  global `high`. `opencode-only` is a single-member family by design: every OpenCode free-tier model sits
  at the same (zero) price point, so economic / fast / frontier variants would differ in name only.
  Operators who authenticate an upstream provider through `opencode providers` should pin rows directly
  rather than reach for a preset (see the `OPENCODE_ONLY` note in `src/business/settings/presets.ts`).
  Its rows leave `effort` unset for the reason given under **Effort resolution** above.
- **economic** (`mixed-economic`, `claude-economic`, `copilot-economic`, `codex-economic`) — same routing
  as standard but `implement` starts one tier below the flagship at `high` effort; the escalation ladder
  climbs to the flagship only when a task plateaus — cheaper tokens on easy tasks, same quality gate on
  hard ones.
- **strong-gate** (`mixed-strong-gate`, `claude-strong-gate`, `copilot-strong-gate`, `codex-strong-gate`)
  — cheap generate tier paired with a permanently-flagship evaluator gate — the only family that
  intentionally splits `implement.generator` and `implement.evaluator` onto different models. The generator
  climbs to the flagship on plateau via the escalation ladder (`escalateOnPlateau` stamped `true`). The
  Codex variant (`gpt-5.6-terra` gen → `gpt-5.6-sol` gate) has the narrowest gap of the family.
- **fast** (`mixed-fast`, `claude-fast`, `copilot-fast`, `codex-fast`) — cheapest viable tier at `low`
  effort across the board. Implement uses sonnet/mini (not haiku — too weak to author code reliably); light
  flows drop further. This is the only family with `escalateOnPlateau` stamped **`false`** — a plateau
  settles (done-with-warning) rather than climbing the ladder, which is what keeps the family genuinely
  cheap and predictable.
- **frontier** (`mixed-frontier`, `claude-frontier`, `copilot-frontier`, `codex-frontier`) — flagship
  everywhere at `max` effort. Codex now genuinely stamps `max` too (`gpt-5.6-sol` is the only tier that
  accepts it); `ultra` is deliberately not used (plan-gated to Plus+, would brick spawns on lower plans).
  Tops out at Opus 5 / GPT-5.6 Sol; `claude-fable-5` is intentionally not referenced — it is priced at 2×
  Opus and stays opt-in only (not a suspension — see below).

**`applyPreset` stamps `harness.escalateOnPlateau`** alongside the AI section. Standard / economic /
strong-gate / frontier all stamp it `true`; fast stamps it `false`. The rest of `harness` (`maxTurns`,
`escalationMap`, `plateauThreshold`, …) plus all other top-level settings keys are preserved verbatim.

**Model-tier ordering.** The ladders each family relies on are grounded in SWE-bench rankings (June
2026 data): Claude haiku < sonnet < opus < fable; GPT mini < 5.4 < 5.5 < 5.6 (luna < terra < sol). These
orderings explain why the cheap-to-strong tier progressions are wired the way they are — not as
guaranteed scores (OpenAI stopped publishing SWE-bench Verified after contamination concerns, and
results swing significantly with scaffolding). Treat this as relative-ordering rationale, not a
performance promise.

Apply via `ralphctl settings apply-preset <name>` or from the TUI settings view. Re-applying overwrites
every `ai` row plus `harness.escalateOnPlateau` in one transaction; subsequent per-key edits via
`ralphctl settings set ai.<flow>.<field> <value>` stick.

**Model catalog versions used by the presets** (verified against the tool versions noted per row):

- Claude Code — `claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-sonnet-5` / `claude-opus-4-8` /
  `claude-opus-5` (verified against Claude Code v2.1.197; `claude-sonnet-5` requires v2.1.197+;
  `claude-opus-5` ships at the same price as Opus 4.8 — vendor-stated drop-in). `claude-opus-5` is the
  Opus 4.8 successor and the **default Opus** across presets, the new-install defaults, and the
  escalation ladder; `claude-opus-4-8` is kept alongside it (both Active at Anthropic) so pinned 4.8
  configs keep working, and now carries a ladder rung up to Opus 5. Like Sonnet 5, Opus 5 has
  **no `[1m]` variant** — on the Anthropic API it always runs at its native 1M window in Claude Code, so
  the 1M figure is recorded against the bare id in the context-window tables (Sonnet 5 and Opus 5 are now
  both base ids, not `[1m]` variants, that carry native 1M); 128K output; a separate rate-limit bucket
  from the Opus 4.x family. The catalog additionally lists the frontier tier `claude-fable-5` plus the
  1M-context variants `claude-opus-4-8[1m]` and `claude-fable-5[1m]` (the `[1m]` suffix is Claude Code's
  long-context syntax for models whose Claude-Code default is 200K, passed through verbatim — on large
  repos the 1M window avoids mid-session compaction during deep implement runs) as **opt-in only** — no
  preset, default, or built-in escalation rung references them; pick per row or add a
  `'claude-opus-5': 'claude-fable-5'` rung via `settings.harness.escalationMap`. Fable is **GA as of July
  2026** — the 2026-06-12 export-control suspension has been lifted (`settings-models/suspended-models.ts`
  keeps the kill-switch mechanism, now empty) — it stays opt-in for a different reason: 2× the Opus price
  is an operator spend decision, not a capability gate.
- GitHub Copilot — lists 28 models reconciled to GitHub's supported-models doc (as of 2026-07-26):
  OpenAI `gpt-5-mini`, `gpt-5.3-codex`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`, `gpt-5.5`,
  `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`; Anthropic `claude-haiku-4.5`, `claude-opus-4.5`,
  `claude-opus-4.6`, `claude-opus-4.7`, `claude-opus-4.8`, `claude-opus-4.8-fast`, `claude-opus-5`,
  `claude-fable-5`, `claude-sonnet-4.5` (default), `claude-sonnet-4.6`, `claude-sonnet-5`; Google
  `gemini-2.5-pro`, `gemini-3-flash`, `gemini-3.1-pro-preview`, `gemini-3.5-flash`, `gemini-3.6-flash`;
  Microsoft `mai-code-1-flash`; Moonshot `kimi-k2.7-code`; fine-tuned `raptor-mini-preview`. Added since
  the last reconciliation: `claude-opus-4.8-fast`, `claude-opus-5`, `gpt-5.6-sol`, `gpt-5.6-terra`,
  `gpt-5.6-luna`, `gemini-3.6-flash`, `kimi-k2.7-code` — `gpt-5.6-sol` is CLI-verified (Copilot CLI
  1.0.75); `claude-opus-4.8-fast`, `gemini-3.6-flash`, and `kimi-k2.7-code` are convention-derived (could
  not be validated on the reference account). Removed: `claude-opus-4.6-fast` (delisted; remaps to
  `claude-opus-4.8-fast`). Note: `claude-opus-5`'s Copilot slug carries no dot/date, so — like Sonnet 5
  and Fable 5 — it is the SAME string (`claude-opus-5`) as the Claude-Code id; it is also plan-gated
  (Pro+/Max/Business/Enterprise) on Copilot, and per the existing passthrough-probe policy fails at spawn
  with a clear error on gated accounts, so Copilot's curated presets and the dot-form escalation ladder
  deliberately stay on `claude-opus-4.8` (see `escalation-map.ts`).
- OpenAI Codex — verified against the live CLI model cache (codex CLI v0.145.0,
  `~/.codex/models_cache.json`, 2026-07-26). `gpt-5.6-sol` is the flagship and the top rung of the Codex
  escalation ladder — the model `codex-only` / `codex-frontier` run implement on; `gpt-5.6-terra` is the
  balanced everyday tier (`codex-economic` / `codex-strong-gate`'s author role); `gpt-5.6-luna` is the
  most cost-efficient 5.6 tier (ladder: luna → terra → sol). `gpt-5.5` / `gpt-5.4` / `gpt-5.4-mini` remain
  in the catalog for pinned configs and chain into the 5.6 family (`gpt-5.5 → gpt-5.6-sol`). The 5.6
  family requires codex CLI ≥ ~0.145 — older CLIs reject with "requires a newer version of Codex". Bare
  `gpt-5.6` is an API-only alias rejected under ChatGPT auth and is deliberately NOT listed. `gpt-5.2` /
  `gpt-5.3-codex` / `gpt-5.3-codex-spark` are gone from the CLI entirely and were REMOVED from the
  catalog; persisted rows silently remap to `gpt-5.5` at parse time (`gpt-5.3-codex` stays in the
  **Copilot** catalog — GitHub still lists it — so the remap is codex-provider-guarded). Effort
  vocabulary is now `low..ultra`; `minimal` was retired and persisted rows migrate to `low`.
- OpenCode — structurally unlike the other three: `OPENCODE_MODELS`
  (`src/domain/value/settings-models/opencode.ts`, verified against `opencode models`, opencode-ai
  v1.18.15) is the **zero-auth free-tier floor**, not a vendor catalog. Ids are namespaced
  `<provider>/<model>` (an aggregator upstream may add further segments), and the adapter validates only
  that SHAPE — it does **not** reject off-catalog ids, because doing so would make every authenticated
  model un-runnable. The runtime `opencode models` probe
  (`providers/opencode/model-availability-probe.ts`) reports whatever the operator's authenticated
  providers actually serve, so the picker grows without a ralphctl release. The free tier rotates
  upstream; a stale entry degrades to a picker row the CLI rejects, never a crash.

**Default escalation posture (effort rung, no model ladder).** `DEFAULT_SETTINGS.ai.implement.generator` is
`claude-opus-5`, which has no key in `DEFAULT_ESCALATION_MAP` — so the shipped default never
model-escalates. (A pinned `claude-opus-4-8` generator DOES model-escalate now — it carries a live rung up
to `claude-opus-5` — before the effort rung below applies.) The default's effort rung is NOT inert, though:
at the top of the model ladder the graduated policy first raises reasoning effort on the same model (the
`escalate-effort` rung). opus is xhigh-capable and its effort is unset, so Claude Code's implicit default is
already `xhigh` — the rung therefore climbs to `max` in a single step (a fixed `high` would be a no-op or a
downgrade). Then — on a further plateau, opus now at `max` — it fires the same-model nudge (a
change-of-approach directive), then — since `harness.bestOfNCandidates` now defaults to `2` — one best-of-N
attempt that samples two candidates and selects by verification then judging, and only then settles
`done-with-warning`. For the shipped default the effort rung
fires exactly once (unset `→ max`; the next plateau sees `max` and falls through to the nudge). To also
activate a live MODEL ladder, use one of the `*-economic` presets (where `implement.generator` starts on
Sonnet and escalates to Opus) or add a custom rung via `settings.harness.escalationMap`:

```json
"escalationMap": { "claude-opus-5": "claude-fable-5" }
```

`claude-fable-5` and its 1M-context variant `claude-fable-5[1m]` are in the Claude catalog as
**opt-in only** — no preset, default, or built-in escalation rung references them. Select per row via
the TUI picker or `settings set`, or add an escalationMap rung as shown above. Escalation-map rungs
can also be added and removed from the TUI's **Harness** settings section: the `map-add` row walks a
two-step from/to model picker; each existing override appears as a `map-entry` row that can be
retargeted or removed without leaving the TUI.

**`settings.harness` keys** (full list — see `PERFORMANCE.md § Iteration budget` for the gen-eval tuning knobs):

- `maxTurns`, `maxAttempts`, `rateLimitRetries`, `idleWatchdogMs`, `plateauThreshold`, `escalateOnPlateau`,
  `escalationMap` — see `PERFORMANCE.md`.
- `bestOfNCandidates` (default `2`) — the top-of-ladder remedy: once the model ladder AND the same-model nudge
  are both spent, a stuck task gets ONE more attempt that samples N candidates on the unchanged model and
  selects among them by verification then judging. `2`-`4` enables it, `0` disables it. The cost is bounded —
  at most once per task, and only for a task that already exhausted the whole ladder — but that one attempt
  spends N generator sessions instead of one, so the four `*-economic` presets pin it to `0` (applying one of
  them overwrites whatever you had set; every other preset leaves the knob alone). See
  `PERFORMANCE.md § Escalation on plateau`.
- `skipPreVerifyOnFreshSetup` (default `false`) — opt-in: skip the FIRST pre-task verify of a launch when this
  launch's own setup script already built and tested the same tree. Safe only when the setup script actually runs
  the verify gate (not merely installs dependencies) — an install-only setup script would hide a pre-broken
  baseline. Default `false` keeps the strict pre/post symmetry for everyone who has not made that assertion. See
  `PERFORMANCE.md § Verify-gate cost and scoping`.

**Fail-fast PATH check.** Every AI-spawning flow probes for its row's CLI binary at launch (`claude` /
`copilot` / `codex` / `opencode` — `PROVIDER_BINARY` in `src/integration/system/detect-cli.ts` covers all
four) and exits with `LaunchResult.fail` naming the
binary, the flow, and the offending `settings.ai.<flow>.provider` key when the binary is absent.
`apply-preset` emits non-fatal warnings for any preset row whose CLI is missing at apply time, and the
welcome view silently auto-seeds a preset on fresh install based on what it detects on PATH.
