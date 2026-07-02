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
 * climbed cheapest-first one rung per plateau — each tier points at the next stronger tier, so
 * an economic preset that starts a tier below flagship climbs through every intermediate rung
 * (haiku → sonnet → opus). The GPT mini tiers instead step straight to the frontier default
 * (`gpt-5.5`); the economic full tier (`gpt-5.4`) climbs the single remaining rung to it.
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
 * `claude-sonnet-5`, which climbs to `claude-opus-4-8`. The legacy `claude-sonnet-4-6` rung is
 * RETAINED so configs explicitly pinned to Sonnet 4.6 still climb to Opus. The Copilot dot-form
 * ladder deliberately stays on `claude-sonnet-4.6`: Sonnet 5's slug carries no dot/date, so its
 * Copilot id is the SAME string (`claude-sonnet-5`) as the Claude-Code id — a flat map has one
 * value per key, and the dash form (the primary provider) wins it pointing at `claude-opus-4-8`.
 * A Copilot row pinned to `claude-sonnet-5` therefore has no dot-form Opus rung; that edge is
 * accepted rather than mis-routing the Claude-Code climb to a dot-form Opus id Claude Code rejects.
 */
export const DEFAULT_ESCALATION_MAP: Readonly<Record<string, string>> = {
  // Claude (Claude-Code / Codex dash-form) — Haiku → Sonnet 5 → Opus; Sonnet 4.6 still climbs.
  'claude-haiku-4-5': 'claude-sonnet-5',
  'claude-sonnet-5': 'claude-opus-4-8',
  'claude-sonnet-4-6': 'claude-opus-4-8',
  // Claude (Copilot dot-form) — Haiku → Sonnet 4.6 → Opus (Sonnet 5 shares the dash-form key above).
  'claude-haiku-4.5': 'claude-sonnet-4.6',
  'claude-sonnet-4.6': 'claude-opus-4.8',
  // Copilot/Codex GPT — mini variants step up to their full-tier frontier, and the
  // economic full tier (`gpt-5.4`) climbs to the flagship.
  'gpt-5-mini': 'gpt-5.5',
  'gpt-5.4-mini': 'gpt-5.5',
  'gpt-5.4': 'gpt-5.5',
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
 * The reasoning-effort level the Copilot / Codex effort rung climbs TO. Fixed at `high`: it is a
 * member of both those providers' effort vocabularies (Copilot `none..max`, Codex `minimal..high`),
 * it is the level the Codex vocabulary tops out at, and it is a meaningful step up from the ~medium
 * effort those CLIs default a fresh row to. Claude does NOT use this constant — its rung is
 * model-aware (see {@link nextEffortRung}) because Claude Code's own default is `xhigh` on
 * xhigh-capable models, so a fixed `high` target would be a no-op or an outright downgrade.
 *
 * @public
 */
export const EFFORT_ESCALATION_TARGET = 'high';

/**
 * Effort levels at or above {@link EFFORT_ESCALATION_TARGET}. A Copilot / Codex generator already
 * running at one of these has no headroom for the effort rung — it is spent and the policy falls
 * through to the same-model nudge. Uses the Copilot superset (`high | xhigh | max`); the Codex
 * vocabulary tops out at `high`, which is covered. Not consulted on the Claude path.
 */
const EFFORT_AT_OR_ABOVE_TARGET: ReadonlySet<string> = new Set(['high', 'xhigh', 'max']);

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
 * Every OTHER effort-capable Claude model (Sonnet 5, Opus 4.7/4.8, Fable 5, and — by default — any
 * future frontier id not listed here) is treated as xhigh-capable, whose CLI default is `xhigh`.
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
 *     `xhigh` on xhigh-capable models (Opus 4.7/4.8, Sonnet 5, Fable 5, …), else `high`.
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
 *     never re-stamping the implicit default. The shipped default posture (`claude-opus-4-8`, effort
 *     unset) therefore escalates to `max` in a single step.
 *   - **github-copilot / openai-codex** — unchanged fixed target {@link EFFORT_ESCALATION_TARGET}
 *     (`high`); `unset` counts as escalatable (their CLI default sits ~medium), and `high | xhigh |
 *     max` are spent. `model` plays no role on this path.
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
  // Copilot / Codex keep the original fixed-`high` semantics — see EFFORT_ESCALATION_TARGET.
  if (currentEffort !== undefined && EFFORT_AT_OR_ABOVE_TARGET.has(currentEffort)) return undefined;
  return EFFORT_ESCALATION_TARGET;
};
