/**
 * Model-escalation ladder consulted by the gen-eval loop when an attempt plateaus and the
 * user has opted into `settings.harness.escalateOnPlateau`. This module ships the static
 * per-provider ladders, the merge helper, the cycle check, the self-loop warning, and the
 * same-model effort rung.
 *
 * The default ladders encode "weaker → stronger" rungs within each provider's catalog and are
 * scoped per provider: the rung above a model depends on WHICH backend runs it, because some
 * slugs are shared across catalogs (`claude-sonnet-5` is both a Claude-Code and a Copilot id,
 * yet Claude Code climbs it to Opus 5.5 while Copilot climbs it to Opus 4.8). Users can extend or
 * override via the flat `settings.harness.escalationMap`, which applies to whichever provider the
 * generator runs on; user keys win on conflict and a custom key with no default entry adds a new
 * rung.
 */

import type { AiProvider } from '@src/domain/entity/settings.ts';
import type { Logger } from '@src/business/observability/logger.ts';

/**
 * Built-in escalation ladders, one per provider. Keys are the model id the generator is
 * currently spawning with; values are the model id to switch to after a plateau exit. Ladders
 * are climbed cheapest-first, one rung per plateau.
 *
 *  - **claude-code** — Haiku → Sonnet 5 → Opus 5.5 (top). Legacy tiers converge on the flagship:
 *    Sonnet 4.6 → Opus 4.8 → Opus 5.5, and Opus 5 → Opus 5.5 (cheaper and stronger). Fable is
 *    never a default rung — it costs 2.5x Opus 5.5 and needs a non-ZDR org; opt in via
 *    `escalationMap` (`'claude-opus-5-5': 'claude-fable-5-1'`).
 *  - **github-copilot** — Haiku → Sonnet 5 → Opus 4.8 (top); Opus 4.7 → Opus 4.8. Opus 5 / 5.5 are
 *    plan-gated on Copilot (Pro+/Max/Business/Enterprise), so the default ladder never steers a
 *    mid-task spawn into a model many accounts cannot use — opt in via `escalationMap`. GPT: the
 *    minis step to `gpt-5.5`, which climbs to `gpt-5.6-sol`; within 5.6, luna → terra → sol. The
 *    GPT-6 ids are not rungs yet (gradual rollout; not reachable on the reference account).
 *  - **openai-codex** — `gpt-6-luna` → `gpt-6-sol` (top). `gpt-6-astra` is opt-in premium (5x the
 *    sol price), never a default rung. Pinned older tiers converge on `gpt-6-sol`: `gpt-5.5` →
 *    `gpt-5.6-sol`, luna → terra → sol within 5.6, then `gpt-5.6-sol` → `gpt-6-sol` (the codex
 *    cache's upgrade target, at half the price).
 *  - **xai-grok** — one generation per plateau up to `grok-4.7`. `grok-4.7-build-fast` is the same
 *    model at 2x price, so it is not a rung.
 *  - **opencode** — none. OpenCode aggregates upstream providers, so there is no vendor ladder.
 *
 * Kept in lockstep with the catalogs in `domain/value/settings-models/` by a verify-gate:
 * `tests/unit/business/task/escalation-map.test.ts` asserts every key/value is a member of THAT
 * provider's catalog and fingerprints the catalogs, so a rename/de-list that strands a rung fails
 * `pnpm verify` (and triggers the HARNESS-PRINCIPLES.md model-bump audit) rather than shipping a
 * rung the adapter rejects at spawn time.
 */
const CLAUDE_OPUS_5_5 = 'claude-opus-5-5';
const GPT_5_5 = 'gpt-5.5';
const GPT_5_6_SOL = 'gpt-5.6-sol';
const GPT_6_SOL = 'gpt-6-sol';

export const DEFAULT_ESCALATION_LADDERS: Readonly<Record<AiProvider, Readonly<Record<string, string>>>> = {
  'claude-code': {
    'claude-haiku-4-5': 'claude-sonnet-5',
    'claude-sonnet-5': CLAUDE_OPUS_5_5,
    'claude-sonnet-4-6': 'claude-opus-4-8',
    'claude-opus-4-8': CLAUDE_OPUS_5_5,
    'claude-opus-5': CLAUDE_OPUS_5_5,
  },
  'github-copilot': {
    'claude-haiku-4.5': 'claude-sonnet-5',
    'claude-sonnet-5': 'claude-opus-4.8',
    'claude-opus-4.7': 'claude-opus-4.8',
    'gpt-5-mini': GPT_5_5,
    'gpt-5.4-mini': GPT_5_5,
    'gpt-5.4': GPT_5_5,
    [GPT_5_5]: GPT_5_6_SOL,
    'gpt-5.6-luna': 'gpt-5.6-terra',
    'gpt-5.6-terra': GPT_5_6_SOL,
    'grok-4.5': 'grok-4.6',
  },
  'openai-codex': {
    'gpt-6-luna': GPT_6_SOL,
    [GPT_5_5]: GPT_5_6_SOL,
    'gpt-5.6-luna': 'gpt-5.6-terra',
    'gpt-5.6-terra': GPT_5_6_SOL,
    [GPT_5_6_SOL]: GPT_6_SOL,
  },
  'xai-grok': {
    'grok-4.5': 'grok-4.6',
    'grok-4.6': 'grok-4.7',
  },
  opencode: {},
};

/**
 * Merge the user's `settings.harness.escalationMap` over the built-in ladder for `provider`
 * (the generator row's provider). User keys win on conflict (allowing them to redirect a default
 * rung) and user-only keys extend the ladder. With no provider there is no built-in ladder to
 * pick, so only the user's rungs apply. Returns a fresh object so callers can keep treating it
 * as immutable.
 */
export const mergeEscalationMap = (
  user: Readonly<Record<string, string>>,
  provider: AiProvider | undefined
): Readonly<Record<string, string>> => ({
  ...(provider === undefined ? {} : DEFAULT_ESCALATION_LADDERS[provider]),
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
 * contains a cycle reachable from `start`. The built-in {@link DEFAULT_ESCALATION_LADDERS} are
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
 * (see {@link nextEffortRung}): it climbs one tier above the effective level, and the effective
 * level for an unset row depends on the model's own CLI default, so no fixed target fits. Codex
 * uses its own fixed target, {@link CODEX_EFFORT_ESCALATION_TARGET}, not this one.
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
 * Providers whose reasoning-effort dimension this ladder can raise with a KNOWN-GOOD level.
 * Modelled as a set — rather than assumed for every provider — so a provider whose effort
 * vocabulary cannot be resolved statically skips the effort rung gracefully instead of stamping a
 * level the adapter would reject mid-task.
 *
 * `opencode` is deliberately EXCLUDED even though it has an effort knob (`--variant`). OpenCode
 * aggregates upstream providers, so the accepted levels for a given `provider/model` id belong to
 * that upstream vendor, not to OpenCode — there is no level this ladder could stamp that is known
 * to be valid for the row's model, and the free-tier community models generally expose none at all.
 * Escalating into a rejected `--variant` would turn a plateau into a hard spawn failure, which is
 * strictly worse than not escalating. Operators who know their upstream model's vocabulary can set
 * the effort explicitly on the row.
 */
const EFFORT_CAPABLE_PROVIDERS: ReadonlySet<AiProvider> = new Set<AiProvider>([
  'claude-code',
  'github-copilot',
  'openai-codex',
  'xai-grok',
]);

/**
 * Claude's reasoning-effort ladder, weakest → strongest. The adapter validates against the same
 * `low | medium | high | xhigh | max` provider vocabulary (`settings.ts`), so every entry here is a
 * level the Claude Code CLI accepts. Used to compute the model-aware effort rung below.
 */
const CLAUDE_EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type ClaudeEffort = (typeof CLAUDE_EFFORT_LADDER)[number];

/**
 * Claude models with NO reasoning-effort dimension — the CLI ignores an effort flag for them, so
 * the rung is skipped (returns `undefined`) rather than stamping a level the model does not honour.
 * Currently just Haiku 4.5. Both the dash-form (Claude-Code catalog) and dot-form ids are listed so
 * the classification is robust even if a dot-form id ever reaches the Claude path.
 */
const CLAUDE_EFFORTLESS_MODELS: ReadonlySet<string> = new Set(['claude-haiku-4-5', 'claude-haiku-4.5']);

/**
 * Effort-capable Claude models WITHOUT the `xhigh` tier. Sonnet 4.6 is the only such model in the
 * Claude-Code catalog; its ladder skips straight from `high` to `max`. Every other effort-capable
 * Claude model (Sonnet 5, Opus 4.7/4.8/5/5.5, Fable 5/5.1, and — by default — any future frontier id
 * not listed here) is treated as xhigh-capable.
 */
const CLAUDE_NO_XHIGH_MODELS: ReadonlySet<string> = new Set(['claude-sonnet-4-6', 'claude-sonnet-4.6']);

/**
 * Claude Code's built-in effort when no `--effort` is passed, for models whose default is NOT
 * `high` (code.claude.com/docs/en/model-config, checked 2026-09-22): Opus 5.5 defaults to
 * `medium`. Every other effort-capable Claude model (Opus 5 / 4.8, Sonnet 5 / 4.6, Fable 5 / 5.1)
 * defaults to `high`. Kept in lockstep with the per-provider catalogs in
 * `domain/value/settings-models/`: the catalog fingerprint test flags a model bump so this table is
 * re-checked alongside the ladder.
 */
const CLAUDE_CLI_DEFAULT_EFFORT: Readonly<Record<string, ClaudeEffort>> = {
  'claude-opus-5-5': 'medium',
  'claude-opus-5.5': 'medium',
};
const CLAUDE_FALLBACK_CLI_DEFAULT_EFFORT: ClaudeEffort = 'high';

const isClaudeEffort = (s: string): s is ClaudeEffort => (CLAUDE_EFFORT_LADDER as readonly string[]).includes(s);

/**
 * Model-aware Claude effort rung — one tier above the effective effort:
 *
 *   - Haiku (no effort dimension) → `undefined`; the rung is skipped gracefully.
 *   - The `effective` current effort is the explicit level, or — when unset — the model's CLI
 *     default ({@link CLAUDE_CLI_DEFAULT_EFFORT}: `medium` on Opus 5.5, `high` elsewhere).
 *   - The target is the next tier strictly above `effective` on the model's own ladder
 *     (`low → medium → high → xhigh → max`; models without `xhigh` go `high → max`); `max` is the
 *     ceiling → `undefined` (spent).
 *
 * Never returns a level at or below `effective` — so it never re-stamps the CLI default, which
 * would be a no-op attempt. ralphctl stamps an explicit effort on effort-capable rows, so the
 * unset path is a fallback, but it stays correct.
 */
const claudeEffortRung = (model: string, currentEffort: string | undefined): string | undefined => {
  if (CLAUDE_EFFORTLESS_MODELS.has(model)) return undefined;
  const effective = currentEffort ?? CLAUDE_CLI_DEFAULT_EFFORT[model] ?? CLAUDE_FALLBACK_CLI_DEFAULT_EFFORT;
  // An effort string outside the Claude ladder (never expected from a validated row) — skip rather
  // than stamp a level we can't reason about.
  if (!isClaudeEffort(effective)) return undefined;
  const effectiveIndex = CLAUDE_EFFORT_LADDER.indexOf(effective);
  const modelLadder = CLAUDE_NO_XHIGH_MODELS.has(model)
    ? CLAUDE_EFFORT_LADDER.filter((level) => level !== 'xhigh')
    : CLAUDE_EFFORT_LADDER;
  return modelLadder.find((level) => CLAUDE_EFFORT_LADDER.indexOf(level) > effectiveIndex);
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
 *   - **claude-code** — model-aware ({@link claudeEffortRung}): one tier above the effective effort
 *     (the explicit level, or the model's CLI default — `medium` on Opus 5.5, `high` elsewhere), so
 *     the rung never re-stamps the implicit default. `claude-opus-5-5` unset → `high`; `xhigh` →
 *     `max`; `max` is spent.
 *   - **github-copilot** — fixed target {@link EFFORT_ESCALATION_TARGET} (`high`); `unset` counts as
 *     escalatable (its CLI default sits ~medium), and `high | xhigh | max` are spent. Non-OpenAI
 *     models' effort semantics are opaque, so Copilot stays conservative rather than climbing further.
 *   - **openai-codex** and **xai-grok** — fixed target {@link CODEX_EFFORT_ESCALATION_TARGET}
 *     (`xhigh`, universal across the codex catalog since the vocabulary change, and the rung below
 *     the `max` that Grok's `--effort` tops out at); `unset` and a legacy `minimal` (retired, pre-migration)
 *     count as escalatable, and `xhigh | max | ultra` are spent. `model` plays no role on the
 *     Copilot, Codex, or Grok path — they are the fallthrough once Claude, the one model-aware
 *     provider, has been handled.
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
  // openai-codex and xai-grok: xhigh is universal; max/ultra are already above it.
  if (currentEffort !== undefined && CODEX_EFFORT_AT_OR_ABOVE_TARGET.has(currentEffort)) return undefined;
  return CODEX_EFFORT_ESCALATION_TARGET;
};
