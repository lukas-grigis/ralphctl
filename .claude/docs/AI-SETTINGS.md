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
otherwise the provider CLI's default. Codex caps at `high` — `xhigh` and `max` collapse to `high` when
floored from the global value; `minimal` is reachable only via an explicit per-flow override.

**Single-provider configurations are first-class.** Every row may point at the same provider, or every row
at a different one; the launcher rebuilds the provider / interactive-AI / skills-adapter trio per launch
keyed on the dispatched flow's row, so mixed and uniform configs traverse the same code path.

**Twenty presets across five families** stamp the entire `ai` section plus `harness.escalateOnPlateau`
in one shot — all equally first-class (none is marked default). Each family carries four variants:
`mixed` (best-fit provider per flow), `claude-only`, `copilot-only`, `codex-only`. The families:

- **standard** (`mixed`, `claude-only`, `copilot-only`, `codex-only`) — flagship model per flow at
  `xhigh` effort for `implement`/`plan`; `readiness` at `medium`; `refine`/`ideate` inherit global `high`.
- **economic** (`mixed-economic`, `claude-economic`, `copilot-economic`, `codex-economic`) — same routing
  as standard but `implement` starts one tier below the flagship at `high` effort; the escalation ladder
  climbs to the flagship only when a task plateaus — cheaper tokens on easy tasks, same quality gate on
  hard ones.
- **strong-gate** (`mixed-strong-gate`, `claude-strong-gate`, `copilot-strong-gate`, `codex-strong-gate`)
  — cheap generate tier paired with a permanently-flagship evaluator gate — the only family that
  intentionally splits `implement.generator` and `implement.evaluator` onto different models. The generator
  climbs to the flagship on plateau via the escalation ladder (`escalateOnPlateau` stamped `true`). The
  Codex variant (`gpt-5.4` gen → `gpt-5.5` gate) has the narrowest gap of the family.
- **fast** (`mixed-fast`, `claude-fast`, `copilot-fast`, `codex-fast`) — cheapest viable tier at `low`
  effort across the board. Implement uses sonnet/mini (not haiku — too weak to author code reliably); light
  flows drop further. This is the only family with `escalateOnPlateau` stamped **`false`** — a plateau
  settles (done-with-warning) rather than climbing the ladder, which is what keeps the family genuinely
  cheap and predictable. `codex-fast` uses `minimal` effort for the lightest Codex rows.
- **frontier** (`mixed-frontier`, `claude-frontier`, `copilot-frontier`, `codex-frontier`) — flagship
  everywhere at `max` effort. Codex is floored to `high` (its effort ceiling). Tops out at opus;
  `claude-fable-5` is intentionally not referenced — it is export-control-suspended and would be rejected
  at launch. Restoring fable is a one-line model swap when the suspension lifts.

**`applyPreset` stamps `harness.escalateOnPlateau`** alongside the AI section. Standard / economic /
strong-gate / frontier all stamp it `true`; fast stamps it `false`. The rest of `harness` (`maxTurns`,
`escalationMap`, `plateauThreshold`, …) plus all other top-level settings keys are preserved verbatim.

**Model-tier ordering.** The ladders each family relies on are grounded in SWE-bench rankings (June
2026 data): Claude haiku < sonnet < opus < fable; GPT mini < 5.4 < 5.5. These orderings explain why
the cheap-to-strong tier progressions are wired the way they are — not as guaranteed scores (OpenAI
stopped publishing SWE-bench Verified after contamination concerns, and results swing significantly with
scaffolding). Treat this as relative-ordering rationale, not a performance promise.

Apply via `ralphctl settings apply-preset <name>` or from the TUI settings view. Re-applying overwrites
every `ai` row plus `harness.escalateOnPlateau` in one transaction; subsequent per-key edits via
`ralphctl settings set ai.<flow>.<field> <value>` stick.

**Model catalog versions used by the presets** (verified against the tool versions noted per row):

- Claude Code — `claude-haiku-4-5` / `claude-sonnet-4-6` / `claude-sonnet-5` / `claude-opus-4-8`
  (verified against Claude Code v2.1.197; `claude-sonnet-5` requires v2.1.197+). `claude-sonnet-5` is
  the Sonnet-5 successor to Sonnet 4.6 and the **default Sonnet** across presets, the new-install
  defaults, and the escalation ladder; `claude-sonnet-4-6` is kept alongside it (both Active at
  Anthropic) so pinned 4.6 configs keep working. Sonnet 5 has **no `[1m]` variant** — on the Anthropic
  API it always runs at its native 1M window in Claude Code, so the 1M figure is recorded against the
  bare id in the context-window tables (the only base id, not a `[1m]` variant, to carry 1M). The
  catalog additionally lists the frontier tier `claude-fable-5` plus the 1M-context variants
  `claude-opus-4-8[1m]` and `claude-fable-5[1m]` (the `[1m]` suffix is Claude Code's long-context
  syntax for models whose Claude-Code default is 200K, passed through verbatim — on large repos the 1M
  window avoids mid-session compaction during deep implement runs) as **opt-in only** — no preset,
  default, or built-in escalation rung references them; pick per row or add an
  `'claude-opus-4-8': 'claude-fable-5'` rung via `settings.harness.escalationMap`. **Temporarily
  suspended (2026-06-12 Anthropic export-control directive):** the `claude-fable-5` family stays in the
  catalog but is currently rejected at launch with a clear message and flagged `(suspended)` in the
  pickers; it will be restored when access returns (single-list revert in
  `settings-models/suspended-models.ts`).
- GitHub Copilot — adds `gpt-5.5`, `claude-opus-4.7`, `claude-opus-4.8`, `claude-sonnet-5`, the Gemini
  family (`gemini-2.5-pro`, `gemini-3-flash`, `gemini-3.1-pro-preview`, `gemini-3.5-flash`),
  plus `mai-code-1-flash`, `raptor-mini-preview` (Copilot reconciled to GitHub's supported-models doc
  as of 2026-06-30; Sonnet 5 went GA for Copilot that day). Note: Sonnet 5's Copilot slug carries no
  dot/date, so it is the SAME string (`claude-sonnet-5`) as the Claude-Code id — the escalation map
  has one value per key, so the dash-form (Claude-Code) rung `claude-sonnet-5 → claude-opus-4-8` wins
  it and Copilot's curated presets stay on `claude-sonnet-4.6` (see `escalation-map.ts`).
- OpenAI Codex — adds `gpt-5.3-codex-spark` (text-only research preview, ChatGPT Pro only);
  `gpt-5.2` and `gpt-5.3-codex` are deprecated for ChatGPT sign-in but kept in the allowlist because
  they remain available via API-key auth. `gpt-5.5` is the frontier default — the model `codex-only`
  runs implement on and the top rung of the Codex escalation ladder; `gpt-5.4` is the strong frontier
  coder one tier below it, where `codex-economic` starts implement (verified against Codex CLI
  v0.138.0). The `codex-only` preset moves implement off the deprecated `gpt-5.3-codex` to `gpt-5.5`.

**Default escalation posture (inert ladder).** `DEFAULT_SETTINGS.ai.implement.generator` is
`claude-opus-4-8`, which has no key in `DEFAULT_ESCALATION_MAP` — so the shipped default can never
model-escalate. On a plateau it fires one same-model nudge (a change-of-approach directive), then settles
`done-with-warning`. This is deliberate: the default posture is conservative. To activate a live ladder,
use one of the `*-economic` presets (where `implement.generator` starts on Sonnet and escalates to Opus)
or add a custom rung via `settings.harness.escalationMap`:

```json
"escalationMap": { "claude-opus-4-8": "claude-fable-5" }
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
- `skipPreVerifyOnFreshSetup` (default `false`) — opt-in: skip the FIRST pre-task verify of a launch when this
  launch's own setup script already built and tested the same tree. Safe only when the setup script actually runs
  the verify gate (not merely installs dependencies) — an install-only setup script would hide a pre-broken
  baseline. Default `false` keeps the strict pre/post symmetry for everyone who has not made that assertion. See
  `PERFORMANCE.md § Verify-gate cost and scoping`.

**Fail-fast PATH check.** Every AI-spawning flow probes for its row's CLI binary at launch (`claude` /
`copilot` / `codex` via `src/integration/system/detect-cli.ts`) and exits with `LaunchResult.fail` naming the
binary, the flow, and the offending `settings.ai.<flow>.provider` key when the binary is absent.
`apply-preset` emits non-fatal warnings for any preset row whose CLI is missing at apply time, and the
welcome view silently auto-seeds a preset on fresh install based on what it detects on PATH.
