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
 * lockstep by code review.
 *
 * Dash-form ids (`claude-haiku-4-5`) are the Claude-Code / Codex catalog ids; dot-form ids
 * (`claude-haiku-4.5`) are the Copilot catalog ids — both forms are seeded and kept in
 * lockstep with `domain/value/settings-models/`.
 */
export const DEFAULT_ESCALATION_MAP: Readonly<Record<string, string>> = {
  // Claude (Claude-Code / Codex dash-form) — Haiku → Sonnet → Opus.
  'claude-haiku-4-5': 'claude-sonnet-4-6',
  'claude-sonnet-4-6': 'claude-opus-4-8',
  // Claude (Copilot dot-form) — Haiku → Sonnet → Opus.
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
