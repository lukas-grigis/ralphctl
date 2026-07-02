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
 * The reasoning-effort level the graduated same-model effort rung climbs TO — the counterpart of a
 * model-ladder rung for a generator that is already at (or has no) stronger model. Fixed at `high`:
 * it is a member of every provider's effort vocabulary (Claude `low..max`, Copilot `none..max`,
 * Codex `minimal..high`), so the rung never targets a level the adapter would floor away, and it is
 * a meaningful step up from the CLI-default effort a fresh row runs at.
 */
export const EFFORT_ESCALATION_TARGET = 'high';

/**
 * Effort levels at or above {@link EFFORT_ESCALATION_TARGET}. A generator already running at one of
 * these has no headroom for the effort rung — the rung is spent and the policy falls through to the
 * same-model nudge. Uses the Claude/Copilot superset (`high | xhigh | max`); the Codex vocabulary
 * tops out at `high`, which is covered.
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
 * Same-model effort rung — the cheapest remedy on the graduated escalation ladder. Given the
 * generator's provider and its currently-resolved effort, returns the effort level to escalate TO
 * (always {@link EFFORT_ESCALATION_TARGET}), or `undefined` when the rung is unavailable:
 *
 *   - the provider has no effort dimension the caller could resolve (`undefined` provider, or a
 *     future provider outside {@link EFFORT_CAPABLE_PROVIDERS}) — skip gracefully, never error; or
 *   - the generator is already at or above the target (`high | xhigh | max`) — no headroom left.
 *
 * `currentEffort` is the resolved per-flow effort (`resolveEffort`/`resolveEffortForRow`): an
 * explicit `undefined` means "CLI default" and IS below the target, so a fresh row (the shipped
 * default posture, which sets no effort) escalates to `high`. Pure; no I/O.
 *
 * @public
 */
export const nextEffortRung = (
  provider: AiProvider | undefined,
  currentEffort: string | undefined
): string | undefined => {
  if (provider === undefined || !EFFORT_CAPABLE_PROVIDERS.has(provider)) return undefined;
  if (currentEffort !== undefined && EFFORT_AT_OR_ABOVE_TARGET.has(currentEffort)) return undefined;
  return EFFORT_ESCALATION_TARGET;
};
