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
 * with; values are the model id to switch to after a plateau exit. The ladder is climbed
 * cheapest-first one rung per plateau, so each tier points at the next stronger tier (not the
 * flagship directly) — letting an economic preset that starts a tier below flagship climb
 * through every intermediate rung. Entries are seeded from the per-provider model catalogs at
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
