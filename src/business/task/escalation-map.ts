/**
 * Model-escalation ladders, the user-map merge, cycle / self-loop / retired-value checks, and the
 * same-model effort rung. Ladders are scoped per provider because some slugs are shared across
 * catalogs (`claude-sonnet-5` climbs to `claude-opus-5-5` on Claude Code, `claude-opus-5.5` on
 * Copilot). The flat `settings.harness.escalationMap` applies to whichever provider runs; user keys
 * win and user-only keys add rungs.
 */

import { type AiProvider, RETIRED_MODEL_REMAPS } from '@src/domain/entity/settings.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { modelEffortLevels } from '@src/domain/value/settings-models/effort.ts';

/**
 * Built-in ladders, cheapest first, one rung per escalation; legacy tiers converge on each top:
 *
 *  - claude-code — Haiku → Sonnet 5.5 → Opus 5.5. Fable is never a default rung (2.5x Opus 5.5,
 *    needs a non-ZDR org); opt in via `escalationMap`.
 *  - github-copilot — Haiku → Sonnet 5.5 → Opus 5.5 (Opus 4.8 / 5 / 5.5 are plan-gated alike, 5.5 is
 *    cheapest); GPT luna → sol within 5.6, skipping the retiring terra. GPT-6 ids are Pro+ only, so no rungs.
 *  - openai-codex — up to `gpt-6.1-sol`; the premium `gpt-6-astra` is never a default rung.
 *  - xai-grok — one generation per escalation up to `grok-4.7`; `-build-fast` is the same model at 2x.
 *  - opencode — none: an aggregator has no vendor ladder.
 *
 * `escalation-map.test.ts` asserts every key/value is in that provider's catalog and fingerprints the
 * catalogs, so a de-listed rung fails verify (and triggers the model-bump audit).
 */
const CLAUDE_OPUS_5_5 = 'claude-opus-5-5';
const CLAUDE_SONNET_5_5 = 'claude-sonnet-5-5';
const GPT_5_6_SOL = 'gpt-5.6-sol';
const GPT_6_1_SOL = 'gpt-6.1-sol';
const GPT_5_6_LUNA = 'gpt-5.6-luna';
const COPILOT_SONNET_5_5 = 'claude-sonnet-5.5';
const COPILOT_OPUS_5_5 = 'claude-opus-5.5';

export const DEFAULT_ESCALATION_LADDERS: Readonly<Record<AiProvider, Readonly<Record<string, string>>>> = {
  'claude-code': {
    'claude-haiku-5-5': CLAUDE_SONNET_5_5,
    'claude-haiku-4-5': CLAUDE_SONNET_5_5,
    [CLAUDE_SONNET_5_5]: CLAUDE_OPUS_5_5,
    'claude-sonnet-5': CLAUDE_OPUS_5_5,
    'claude-sonnet-4-6': 'claude-opus-4-8',
    'claude-opus-4-8': CLAUDE_OPUS_5_5,
    'claude-opus-5': CLAUDE_OPUS_5_5,
  },
  'github-copilot': {
    'claude-haiku-5.5': COPILOT_SONNET_5_5,
    'claude-haiku-4.5': COPILOT_SONNET_5_5,
    [COPILOT_SONNET_5_5]: COPILOT_OPUS_5_5,
    'claude-sonnet-5': COPILOT_OPUS_5_5,
    'claude-opus-4.8': COPILOT_OPUS_5_5,
    'claude-opus-5': COPILOT_OPUS_5_5,
    [GPT_5_6_LUNA]: GPT_5_6_SOL,
    'gpt-5.6-terra': GPT_5_6_SOL,
  },
  'openai-codex': {
    'gpt-6-luna': GPT_6_1_SOL,
    'gpt-6-sol': GPT_6_1_SOL,
    [GPT_5_6_LUNA]: 'gpt-5.6-terra',
    'gpt-5.6-terra': GPT_5_6_SOL,
    [GPT_5_6_SOL]: GPT_6_1_SOL,
  },
  'xai-grok': {
    'grok-4.5': 'grok-4.6',
    'grok-4.6': 'grok-4.7',
  },
  opencode: {},
};

/** User rungs over the generator provider's built-in ladder; with no provider, only the user's rungs. */
export const mergeEscalationMap = (
  user: Readonly<Record<string, string>>,
  provider: AiProvider | undefined
): Readonly<Record<string, string>> => ({
  ...(provider === undefined ? {} : DEFAULT_ESCALATION_LADDERS[provider]),
  ...user,
});

/** Self-loops (`{ a: 'a' }`) parse fine but do nothing, so they warn at load instead of failing the file. */
export const warnEscalationMapSelfLoops = (escalationMap: Readonly<Record<string, string>>, logger: Logger): void => {
  for (const [from, to] of Object.entries(escalationMap)) {
    if (from === to) {
      logger.warn(`escalationMap: '${from}' maps to itself — entry has no effect`, { from, to });
    }
  }
};

/**
 * Warn on escalation targets still retired after the parse. The schema already rewrote unambiguous
 * ones, so a survivor is ambiguous (`grok-4.5`, `gpt-5.4`) and stays as written.
 */
export const warnEscalationMapRetiredValues = (
  escalationMap: Readonly<Record<string, string>>,
  logger: Logger
): void => {
  for (const [from, to] of Object.entries(escalationMap)) {
    const retirements = RETIRED_MODEL_REMAPS.filter((r) => r.from === to);
    if (retirements.length === 0) continue;
    const where = retirements.map((r) => `${r.provider} (successor '${r.to}')`).join(', ');
    logger.warn(
      `escalationMap: '${from}' escalates to '${to}', which is retired on ${where} — left unchanged because the slug is ambiguous; pin the successor if the generator runs there`,
      { from, to }
    );
  }
};

/**
 * True when the chain from `start` reaches a cycle — a user map can author `{ a: b, b: a }`. A model
 * on or upstream of a cycle is treated as top-of-ladder rather than climbing forever.
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
 * Fixed effort-rung targets and the levels already at or above them (spent). Copilot stays at a
 * conservative `high` because non-OpenAI models' effort semantics are opaque. Codex and Grok use
 * `xhigh`, which every codex catalog model accepts; `max` / `ultra` are plan- or model-gated, so
 * the rung never targets them. OpenCode is absent on purpose: its levels belong to the upstream
 * vendor, so no stamp is known to be valid and a rejected `--variant` would turn a plateau into a
 * spawn failure.
 */
const FIXED_EFFORT_RUNG: Readonly<Partial<Record<AiProvider, { target: string; spent: ReadonlySet<string> }>>> = {
  'github-copilot': { target: 'high', spent: new Set(['high', 'xhigh', 'max']) },
  'openai-codex': { target: 'xhigh', spent: new Set(['xhigh', 'max', 'ultra']) },
  'xai-grok': { target: 'xhigh', spent: new Set(['xhigh', 'max', 'ultra']) },
};

const CLAUDE_EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
type ClaudeEffort = (typeof CLAUDE_EFFORT_LADDER)[number];

/**
 * Claude Code's effort when no `--effort` is passed, where it is not `high`
 * (code.claude.com/docs/en/model-config). This is the CLI default, not the API's — the API documents
 * `high` for Sonnet 5.5, but the rung must track what the spawned CLI runs. Re-check on a model bump.
 */
const CLAUDE_CLI_DEFAULT_EFFORT: Readonly<Record<string, ClaudeEffort>> = {
  'claude-opus-5-5': 'medium',
  'claude-opus-5.5': 'medium',
  [CLAUDE_SONNET_5_5]: 'medium',
  'claude-haiku-5-5': 'medium',
};
const CLAUDE_FALLBACK_CLI_DEFAULT_EFFORT: ClaudeEffort = 'high';

const isClaudeEffort = (s: string): s is ClaudeEffort => (CLAUDE_EFFORT_LADDER as readonly string[]).includes(s);

/**
 * The next tier strictly above the effective effort (explicit, else the model's CLI default) on the
 * model's own ladder, so the rung never re-stamps the implicit default as a no-op attempt. A model
 * with no effort dimension skips; a custom id gets the full ladder; `max` is spent.
 */
const claudeEffortRung = (
  model: string,
  modelLevels: readonly string[] | undefined,
  currentEffort: string | undefined
): string | undefined => {
  const levels = modelLevels ?? CLAUDE_EFFORT_LADDER;
  if (levels.length === 0) return undefined;
  const effective = currentEffort ?? CLAUDE_CLI_DEFAULT_EFFORT[model] ?? CLAUDE_FALLBACK_CLI_DEFAULT_EFFORT;
  if (!isClaudeEffort(effective)) return undefined;
  const effectiveIndex = CLAUDE_EFFORT_LADDER.indexOf(effective);
  return CLAUDE_EFFORT_LADDER.find(
    (level) => levels.includes(level) && CLAUDE_EFFORT_LADDER.indexOf(level) > effectiveIndex
  );
};

/**
 * The effort level the same-model effort rung climbs to, or `undefined` when the rung is unavailable:
 * no provider, no effort dimension, a catalog model whose levels lack the target (that would hard-fail
 * the CLI), or no headroom left. `currentEffort` is the resolved effort; `undefined` = CLI default.
 */
export const nextEffortRung = (
  provider: AiProvider | undefined,
  model: string,
  currentEffort: string | undefined
): string | undefined => {
  if (provider === undefined) return undefined;
  const levels = modelEffortLevels(provider, model);
  if (provider === 'claude-code') return claudeEffortRung(model, levels, currentEffort);
  const rung = FIXED_EFFORT_RUNG[provider];
  if (rung === undefined) return undefined;
  if (currentEffort !== undefined && rung.spent.has(currentEffort)) return undefined;
  if (provider === 'xai-grok' && levels !== undefined) return grokEffortRung(levels, currentEffort, rung);
  return levels === undefined || levels.includes(rung.target) ? rung.target : undefined;
};

/**
 * The target, or the model's ceiling below it (`high` on `grok-4.5`). Hand-rolled rather than the
 * settings clamp: `business/task` may not import `business/settings`.
 */
const grokEffortRung = (
  levels: readonly string[],
  currentEffort: string | undefined,
  rung: { target: string; spent: ReadonlySet<string> }
): string | undefined => {
  const target = levels.includes(rung.target) ? rung.target : levels.filter((level) => !rung.spent.has(level)).at(-1);
  if (target === undefined) return undefined;
  if (currentEffort !== undefined && levels.indexOf(currentEffort) >= levels.indexOf(target)) return undefined;
  return target;
};
