/**
 * Model-escalation ladder consulted by the gen-eval loop when an attempt plateaus and the
 * user has opted into `settings.harness.escalateOnPlateau`. The runtime wiring lands in a
 * later task — this module ships the static ladder, the merge helper, and the self-loop
 * warning so the wiring can land cleanly on top.
 *
 * The default map encodes "weaker → stronger" rungs within each provider's catalog. Users
 * can extend or override via `settings.harness.escalationMap`; user keys win on conflict
 * and a custom key that has no default entry adds a new rung.
 */

import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { Logger } from '@src/business/observability/logger.ts';

/**
 * Built-in escalation ladder. Keys are the model id the generator is currently spawning
 * with; values are the model id to switch to after a plateau exit. The Claude ladders are
 * climbed cheapest-first one rung per plateau — the current-generation dash tier jumps straight
 * to the same-price current flagship (Sonnet 5 → Opus 5), while legacy tiers climb gradually
 * through their own generation and converge at the flagship (Sonnet 4.6 → Opus 4.8 → Opus 5).
 * The GPT mini tiers step to the old-generation full tier, which chains into the new GPT-5.6
 * family (`gpt-5.4` → `gpt-5.5` → `gpt-5.6-sol`); within 5.6, `luna` → `terra` → `sol`.
 * Entries are seeded from the per-provider model catalogs at
 * `domain/value/settings-models/` — weakening or removing an entry here implies the
 * corresponding model is no longer in catalog, so this file and the catalog are kept in
 * lockstep by a verify-gate: `tests/unit/business/task/escalation-map.test.ts` asserts every
 * key/value is a catalog member and fingerprints the catalogs, so a rename/de-list that strands a
 * rung fails `pnpm verify` (and triggers the HARNESS-PRINCIPLES.md model-bump audit) rather than
 * shipping a rung the adapter rejects at spawn time.
 *
 * Dash-form ids (`claude-haiku-4-5`) are the Claude-Code / Codex catalog ids; dot-form ids
 * (`claude-haiku-4.5`) are the Copilot catalog ids — both forms are seeded and kept in
 * lockstep with `domain/value/settings-models/`.
 *
 * Sonnet 5 is the default Sonnet for the dash-form (Claude-Code) ladder: Haiku climbs to
 * `claude-sonnet-5`, which climbs directly to `claude-opus-5` — same price, vendor-stated
 * drop-in, strictly better, so no intermediate rung is worth spending. The legacy
 * `claude-sonnet-4-6` rung is RETAINED so configs explicitly pinned to Sonnet 4.6 still climb
 * (to `claude-opus-4-8`), and `claude-opus-4-8` itself now carries a rung to `claude-opus-5` so
 * pinned Opus-4.8 configs get a live escalation step at the same price. The Copilot dot-form
 * ladder deliberately stays on `claude-sonnet-4.6`: Sonnet 5's slug carries no dot/date, so its
 * Copilot id is the SAME string (`claude-sonnet-5`) as the Claude-Code id — a flat map has one
 * value per key, and the dash form (the primary provider) wins it pointing at `claude-opus-5`.
 * A Copilot row pinned to `claude-sonnet-5` therefore has no dot-form Opus rung; that edge is
 * accepted rather than mis-routing the Claude-Code climb to a dot-form Opus id Claude Code rejects.
 *
 * `claude-opus-5` (like `claude-sonnet-5`) is likewise an undotted shared-slug id — identical on
 * both catalogs. It appears only as a DESTINATION here, never a key: because both catalogs carry
 * the identical string, the destination is valid whichever provider's row climbed to it, so the
 * flat-map single-value constraint costs nothing. It deliberately has no key of its own — it is
 * the dash-form top of the ladder (Fable is opt-in only, at 2x the Opus price, never a default
 * rung — see the `escalationMap` promotion path noted below) — and giving it a key would also
 * collide with any future dot-form need. The dot-form ladder deliberately stops at
 * `claude-opus-4.8`: `claude-opus-5` is plan-gated on Copilot (Pro+/Max/Business/Enterprise), so
 * the default ladder must never steer a mid-task Copilot spawn into a model many accounts cannot
 * use — opt in explicitly via `escalationMap` (`'claude-opus-4.8': 'claude-opus-5'`) if desired.
 */
export const DEFAULT_ESCALATION_MAP: Readonly<Record<string, string>> = {
  // Claude (Claude-Code dash-form) — Haiku → Sonnet 5 → Opus 5; legacy tiers chain through their
  // own generation (Sonnet 4.6 → Opus 4.8 → Opus 5) and converge at the flagship.
  'claude-haiku-4-5': 'claude-sonnet-5',
  'claude-sonnet-5': 'claude-opus-5',
  'claude-sonnet-4-6': 'claude-opus-4-8',
  'claude-opus-4-8': 'claude-opus-5',
  // Claude (Copilot dot-form) — Haiku → Sonnet 4.6 → Opus 4.8. Opus 4.8 is deliberately the
  // dot-form top: claude-opus-5 is plan-gated on Copilot, so the default ladder never steers a
  // mid-task spawn into a model many accounts cannot use (add a rung via escalationMap to opt in).
  'claude-haiku-4.5': 'claude-sonnet-4.6',
  'claude-sonnet-4.6': 'claude-opus-4.8',
  // Copilot/Codex GPT — minis step to the 5.5 full tier; the 5.5/5.4 generation chains into the
  // 5.6 family; within 5.6, luna → terra → sol (sol is the flagship top rung).
  'gpt-5-mini': 'gpt-5.5',
  'gpt-5.4-mini': 'gpt-5.5',
  'gpt-5.4': 'gpt-5.5',
  'gpt-5.5': 'gpt-5.6-sol',
  'gpt-5.6-luna': 'gpt-5.6-terra',
  'gpt-5.6-terra': 'gpt-5.6-sol',
};

/**
 * Merge the user's `settings.harness.escalationMap` over the built-in default. User keys
 * win on conflict (allowing them to redirect a default rung) and user-only keys extend the
 * ladder. Returns a frozen-spreaded object so callers can keep treating it as immutable.
 */
export const mergeEscalationMap = (user: Readonly<Record<string, string>>): Readonly<Record<string, string>> => ({
  ...DEFAULT_ESCALATION_MAP,
  ...user,
});

/**
 * Emit one warn-level log record per self-loop entry (`{ 'foo': 'foo' }`). Self-loops parse
 * cleanly through the schema — the value matches the `z.string()` constraint — but they
 * have no effect on the runtime ladder, so the harness logs a warning at settings-load time
 * so the misconfiguration is visible without rejecting the file.
 */
export const warnEscalationMapSelfLoops = (escalationMap: Readonly<Record<string, string>>, logger: Logger): void => {
  for (const [from, to] of Object.entries(escalationMap)) {
    if (from === to) {
      logger.warn(`escalationMap: '${from}' maps to itself — entry has no effect`, { from, to });
    }
  }
};

/**
 * True when following the escalation chain from `start` revisits any model — i.e. the map
 * contains a cycle reachable from `start`. The built-in {@link DEFAULT_ESCALATION_MAP} is
 * acyclic, but a user-authored `escalationMap` can introduce a multi-node cycle (`{ a: b, b: a }`)
 * that {@link warnEscalationMapSelfLoops} (which only catches the 1-cycle `{ a: a }`) misses.
 *
 * `decideEscalation` consults this so a cyclic rung never drives an unbounded climb: a generator
 * model that sits on a cycle is treated as top-of-ladder (same-model nudge → topped-out) instead
 * of escalating forever. Conservative by design — a cycle anywhere downstream of `start` blocks
 * escalation from `start` too, because every step would eventually loop. Pure; no I/O.
 */
export const escalationLadderCyclicFrom = (map: Readonly<Record<string, string>>, start: string): boolean => {
  const seen = new Set<string>([start]);
  let cur: string | undefined = map[start];
  while (cur !== undefined) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = map[cur];
  }
  return false;
};

/**
 * The reasoning-effort level the Copilot effort rung climbs TO. Fixed at `high`: it is a member
 * of the Copilot effort vocabulary (`none..max`), and it is a meaningful step up from the ~medium
 * effort the CLI defaults a fresh row to. Non-OpenAI models' effort semantics are opaque, so
 * Copilot stays conservative here. Claude does NOT use this constant — its rung is model-aware
 * (see {@link nextEffortRung}) because Claude Code's own default is `xhigh` on xhigh-capable
 * models, so a fixed `high` target would be a no-op or an outright downgrade. Codex uses its own
 * fixed target, {@link CODEX_EFFORT_ESCALATION_TARGET}, not this one.
 *
 * @public
 */
export const EFFORT_ESCALATION_TARGET = 'high';

/**
 * The reasoning-effort level the Codex effort rung climbs TO. Fixed at `xhigh`: it is accepted by
 * every codex catalog model since the CLI's `low | medium | high | xhigh | max | ultra` vocabulary
 * change, so the rung is live for every preset — the old shared `high` target left it permanently
 * spent for every codex preset, which stamps `high` on implement by default. `max` / `ultra` are
 * deliberately NOT the target: they are narrower than the full catalog (5.6-family-only /
 * sol-terra-only, plan-gated) and this rung has no per-model context to know whether they apply.
 *
 * @public
 */
export const CODEX_EFFORT_ESCALATION_TARGET = 'xhigh';

/**
 * Effort levels at or above {@link EFFORT_ESCALATION_TARGET}. A Copilot generator already running
 * at one of these has no headroom for the effort rung — it is spent and the policy falls through
 * to the same-model nudge. Copilot-only: Codex uses {@link CODEX_EFFORT_AT_OR_ABOVE_TARGET}.
 */
const EFFORT_AT_OR_ABOVE_TARGET: ReadonlySet<string> = new Set(['high', 'xhigh', 'max']);

/**
 * Effort levels at or above {@link CODEX_EFFORT_ESCALATION_TARGET}. A Codex generator already
 * running at one of these has no headroom for the effort rung. `max` / `ultra` are narrower than
 * the universal `xhigh` target but both still count as "at or above" it — a generator already
 * running one of the narrower tiers is never downgraded to `xhigh` by this rung.
 */
const CODEX_EFFORT_AT_OR_ABOVE_TARGET: ReadonlySet<string> = new Set(['xhigh', 'max', 'ultra']);

/**
 * Providers that expose a reasoning-effort dimension the adapter can raise. All three current
 * providers do (see `settings.ts` per-provider effort enums). Modelled as a set — rather than
 * assumed for every provider — so a future provider without an effort knob (or a caller that cannot
 * resolve one, passing `undefined`) skips the effort rung gracefully instead of stamping a level the
 * adapter would reject.
 */
const EFFORT_CAPABLE_PROVIDERS: ReadonlySet<AiProvider> = new Set<AiProvider>([
  'claude-code',
  'github-copilot',
  'openai-codex',
]);

/**
 * Claude's reasoning-effort ladder, weakest → strongest. The adapter validates against the same
 * `low | medium | high | xhigh | max` provider vocabulary (`settings.ts`), so every entry here is a
 * level the Claude Code CLI accepts. Used to compute the model-aware effort rung below.
 */
const CLAUDE_EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const CLAUDE_XHIGH_INDEX = CLAUDE_EFFORT_LADDER.indexOf('xhigh');
const CLAUDE_MAX_INDEX = CLAUDE_EFFORT_LADDER.indexOf('max');

/**
 * Claude models with NO reasoning-effort dimension — the CLI ignores an effort flag for them, so
 * the rung is skipped (returns `undefined`) rather than stamping a level the model does not honour.
 * Currently just Haiku 4.5. Both the dash-form (Claude-Code catalog) and dot-form ids are listed so
 * the classification is robust even if a dot-form id ever reaches the Claude path.
 */
const CLAUDE_EFFORTLESS_MODELS: ReadonlySet<string> = new Set(['claude-haiku-4-5', 'claude-haiku-4.5']);

/**
 * Effort-capable Claude models whose Claude-Code CLI default is `high`, NOT `xhigh` — i.e. models
 * that do not expose the `xhigh` tier. Sonnet 4.6 is the only such model in the Claude-Code catalog.
 * Every OTHER effort-capable Claude model (Sonnet 5, Opus 4.7/4.8/5, Fable 5, and — by default —
 * any future frontier id not listed here) is treated as xhigh-capable, whose CLI default is `xhigh`.
 * Kept in lockstep with the per-provider catalogs in `domain/value/settings-models/`: the catalog
 * fingerprint test flags a model bump so this classification is re-checked alongside the ladder.
 */
const CLAUDE_HIGH_DEFAULT_MODELS: ReadonlySet<string> = new Set(['claude-sonnet-4-6', 'claude-sonnet-4.6']);

/**
 * Model-aware Claude effort rung. Grounded in the Claude effort vocabulary + the per-model
 * capability the shipped default depends on:
 *
 *   - Haiku (no effort dimension) → `undefined`; the rung is skipped gracefully.
 *   - The `effective` current effort is the explicit level, or — when unset — the CLI default:
 *     `xhigh` on xhigh-capable models (Opus 4.7/4.8/5, Sonnet 5, Fable 5, …), else `high`.
 *   - The target is the next power tier strictly above `effective`, capped at `max`: an explicit
 *     `low | medium | high` on an xhigh-capable model climbs to `xhigh`; `unset | xhigh` (and every
 *     tier on a non-xhigh-capable model) climbs to `max`; `max` is the ceiling → `undefined` (spent).
 *
 * Never returns a level at or below `effective` — so it never re-stamps the CLI default (`high`
 * would be a no-op or a downgrade for the shipped default, which is the bug this replaces).
 */
const claudeEffortRung = (model: string, currentEffort: string | undefined): string | undefined => {
  if (CLAUDE_EFFORTLESS_MODELS.has(model)) return undefined;
  const xhighCapable = !CLAUDE_HIGH_DEFAULT_MODELS.has(model);
  const effective = currentEffort ?? (xhighCapable ? 'xhigh' : 'high');
  const effectiveIndex = CLAUDE_EFFORT_LADDER.indexOf(effective as (typeof CLAUDE_EFFORT_LADDER)[number]);
  // An effort string outside the Claude ladder (never expected from a validated row) — skip rather
  // than stamp a level we can't reason about.
  if (effectiveIndex < 0) return undefined;
  // Already at the ceiling → rung spent.
  if (effectiveIndex >= CLAUDE_MAX_INDEX) return undefined;
  // Below `xhigh` on an xhigh-capable model → step into `xhigh` (the first power tier).
  if (xhighCapable && effectiveIndex < CLAUDE_XHIGH_INDEX) return 'xhigh';
  // At/above `xhigh`, or a non-xhigh-capable model (no `xhigh` tier) → climb to the `max` ceiling.
  return CLAUDE_EFFORT_LADDER[CLAUDE_MAX_INDEX];
};

/**
 * Same-model effort rung — the cheapest remedy on the graduated escalation ladder. Given the
 * generator's provider, the model the just-finished attempt ran on, and its currently-resolved
 * effort, returns the effort level to escalate TO, or `undefined` when the rung is unavailable
 * (skip gracefully, never error):
 *
 *   - the provider has no effort dimension the caller could resolve (`undefined` provider, or a
 *     future provider outside {@link EFFORT_CAPABLE_PROVIDERS}); or
 *   - the model has no effort dimension (Claude Haiku); or
 *   - the generator has no headroom left (already at the ceiling for its provider/model).
 *
 * Provider-aware target:
 *   - **claude-code** — model-aware ({@link claudeEffortRung}). Claude Code's own default effort is
 *     `xhigh` on xhigh-capable models, so the rung climbs to the next tier up (…→ `xhigh` → `max`),
 *     never re-stamping the implicit default. The shipped default posture (`claude-opus-5`, effort
 *     unset) therefore escalates to `max` in a single step.
 *   - **github-copilot** — fixed target {@link EFFORT_ESCALATION_TARGET} (`high`); `unset` counts as
 *     escalatable (its CLI default sits ~medium), and `high | xhigh | max` are spent. Non-OpenAI
 *     models' effort semantics are opaque, so Copilot stays conservative rather than climbing further.
 *   - **openai-codex** — fixed target {@link CODEX_EFFORT_ESCALATION_TARGET} (`xhigh`, universal
 *     across the codex catalog since the vocabulary change); `unset` and a legacy `minimal` (retired,
 *     pre-migration) count as escalatable, and `xhigh | max | ultra` are spent. `model` plays no role
 *     on either the Copilot or Codex path.
 *
 * `currentEffort` is the resolved per-flow effort (`resolveEffort`/`resolveEffortForRow`), or
 * `undefined` for the CLI default. Pure; no I/O.
 *
 * @public
 */
export const nextEffortRung = (
  provider: AiProvider | undefined,
  model: string,
  currentEffort: string | undefined
): string | undefined => {
  if (provider === undefined || !EFFORT_CAPABLE_PROVIDERS.has(provider)) return undefined;
  if (provider === 'claude-code') return claudeEffortRung(model, currentEffort);
  if (provider === 'github-copilot') {
    if (currentEffort !== undefined && EFFORT_AT_OR_ABOVE_TARGET.has(currentEffort)) return undefined;
    return EFFORT_ESCALATION_TARGET;
  }
  // openai-codex: xhigh is universal across the codex catalog; max/ultra are already above it.
  if (currentEffort !== undefined && CODEX_EFFORT_AT_OR_ABOVE_TARGET.has(currentEffort)) return undefined;
  return CODEX_EFFORT_ESCALATION_TARGET;
};
