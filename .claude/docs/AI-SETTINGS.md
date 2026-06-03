# AI Settings

> On-demand reference (split out of `CLAUDE.md`). Read when working on `settings.ai`, effort
> resolution, presets, or the per-flow provider/model wiring.

`settings.ai` is a flat record: one optional global `ai.effort` plus six per-flow rows
`ai.{refine,plan,implement,readiness,ideate,createPr}`, each `{ provider, model, effort? }`.
`detect-scripts` / `detect-skills` reuse the `readiness` row; `review` reuses the `implement` row — no
dedicated settings rows. The `createPr` row drives the optional AI step inside `create-pr --ai`; settings
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

**Four equal presets** stamp the entire `ai` section in one shot: `mixed` (best-fit provider per flow),
`claude-only`, `copilot-only`, `codex-only`. None is marked default. Apply via
`ralphctl settings apply-preset <name>` or from the TUI settings view (four buttons above the global
effort row). Re-applying overwrites every row in one transaction; subsequent per-key edits via
`ralphctl settings set ai.<flow>.<field> <value>` stick.

**Fail-fast PATH check.** Every AI-spawning flow probes for its row's CLI binary at launch (`claude` /
`copilot` / `codex` via `src/integration/system/detect-cli.ts`) and exits with `LaunchResult.fail` naming the
binary, the flow, and the offending `settings.ai.<flow>.provider` key when the binary is absent.
`apply-preset` emits non-fatal warnings for any preset row whose CLI is missing at apply time, and the
welcome view silently auto-seeds a preset on fresh install based on what it detects on PATH.
