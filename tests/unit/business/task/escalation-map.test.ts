/**
 * Contract for `business/task/escalation-map.ts`:
 *
 *  - `DEFAULT_ESCALATION_LADDERS` holds one ladder per provider, each rung inside THAT provider's
 *    catalog.
 *  - `mergeEscalationMap` overlays the flat user map over the generator provider's ladder, with
 *    user keys winning on conflict and user-only keys extending it.
 *  - `warnEscalationMapSelfLoops` logs one `warn`-level record per `{ x: x }` entry and
 *    leaves the input untouched.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { CURRENT_SCHEMA_VERSION, SettingsSchema } from '@src/domain/entity/settings.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';
import { COPILOT_MODELS } from '@src/domain/value/settings-models/copilot.ts';
import { GROK_MODELS } from '@src/domain/value/settings-models/grok.ts';
import { OPENCODE_MODELS } from '@src/domain/value/settings-models/opencode.ts';
import { AI_PROVIDERS, type AiProvider } from '@src/domain/entity/settings.ts';
import {
  CODEX_EFFORT_ESCALATION_TARGET,
  DEFAULT_ESCALATION_LADDERS,
  EFFORT_ESCALATION_TARGET,
  escalationLadderCyclicFrom,
  mergeEscalationMap,
  nextEffortRung,
  warnEscalationMapRetiredValues,
  warnEscalationMapSelfLoops,
} from '@src/business/task/escalation-map.ts';

const fakeLogger = () => {
  const warn = vi.fn();
  const noop = vi.fn();
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn,
    error: noop,
    named: () => logger,
  };
  return { logger, warn };
};

const CLAUDE_LADDER = DEFAULT_ESCALATION_LADDERS['claude-code'];
const COPILOT_LADDER = DEFAULT_ESCALATION_LADDERS['github-copilot'];
const CODEX_LADDER = DEFAULT_ESCALATION_LADDERS['openai-codex'];
const GROK_LADDER = DEFAULT_ESCALATION_LADDERS['xai-grok'];

describe('DEFAULT_ESCALATION_LADDERS', () => {
  it('climbs the Claude-Code ladder haiku → sonnet-5 → opus-5-5', () => {
    expect(CLAUDE_LADDER['claude-haiku-4-5']).toBe('claude-sonnet-5');
    expect(CLAUDE_LADDER['claude-sonnet-5']).toBe('claude-opus-5-5');
    expect(CLAUDE_LADDER['claude-opus-5-5']).toBeUndefined();
  });

  it('converges pinned legacy Claude-Code tiers on Opus 5.5', () => {
    expect(CLAUDE_LADDER['claude-sonnet-4-6']).toBe('claude-opus-4-8');
    expect(CLAUDE_LADDER['claude-opus-4-8']).toBe('claude-opus-5-5');
    expect(CLAUDE_LADDER['claude-opus-5']).toBe('claude-opus-5-5');
  });

  it('never makes Fable a default rung on any provider', () => {
    for (const provider of AI_PROVIDERS) {
      for (const [from, to] of Object.entries(DEFAULT_ESCALATION_LADDERS[provider])) {
        expect(from.startsWith('claude-fable'), `${provider}: ${from}`).toBe(false);
        expect(to.startsWith('claude-fable'), `${provider}: ${from} → ${to}`).toBe(false);
      }
    }
  });

  it('climbs the shared claude-sonnet-5 slug to a different Opus per provider', () => {
    // The reason the ladder is provider-scoped: one flat map could hold only one of these.
    expect(CLAUDE_LADDER['claude-sonnet-5']).toBe('claude-opus-5-5');
    expect(COPILOT_LADDER['claude-sonnet-5']).toBe('claude-opus-4.8');
  });

  it('tops the Copilot Claude ladder at Opus 4.8 — Opus 5 / 5.5 are plan-gated there', () => {
    expect(COPILOT_LADDER['claude-haiku-4.5']).toBe('claude-sonnet-5');
    expect(COPILOT_LADDER['claude-opus-4.7']).toBe('claude-opus-4.8');
    expect(COPILOT_LADDER['claude-opus-4.8']).toBeUndefined();
    expect(Object.values(COPILOT_LADDER)).not.toContain('claude-opus-5');
    expect(Object.values(COPILOT_LADDER)).not.toContain('claude-opus-5.5');
  });

  it('climbs the Copilot GPT ladder through gpt-5.5 into the 5.6 family', () => {
    expect(COPILOT_LADDER['gpt-5-mini']).toBe('gpt-5.5');
    expect(COPILOT_LADDER['gpt-5.4-mini']).toBe('gpt-5.5');
    expect(COPILOT_LADDER['gpt-5.5']).toBe('gpt-5.6-sol');
    expect(COPILOT_LADDER['gpt-5.6-luna']).toBe('gpt-5.6-terra');
    expect(COPILOT_LADDER['gpt-5.6-terra']).toBe('gpt-5.6-sol');
    expect(COPILOT_LADDER['gpt-5.6-sol']).toBeUndefined();
  });

  it('tops the Codex ladder at gpt-6-sol — astra stays opt-in', () => {
    expect(CODEX_LADDER['gpt-6-luna']).toBe('gpt-6-sol');
    expect(CODEX_LADDER['gpt-6-sol']).toBeUndefined();
    expect(Object.values(CODEX_LADDER)).not.toContain('gpt-6-astra');
  });

  it('converges pinned older Codex tiers on gpt-6-sol', () => {
    expect(CODEX_LADDER['gpt-5.5']).toBe('gpt-5.6-sol');
    expect(CODEX_LADDER['gpt-5.6-luna']).toBe('gpt-5.6-terra');
    expect(CODEX_LADDER['gpt-5.6-terra']).toBe('gpt-5.6-sol');
    expect(CODEX_LADDER['gpt-5.6-sol']).toBe('gpt-6-sol');
  });

  it('climbs grok one generation at a time up to the grok-4.7 flagship', () => {
    expect(GROK_LADDER['grok-4.5']).toBe('grok-4.6');
    expect(GROK_LADDER['grok-4.6']).toBe('grok-4.7');
    expect(GROK_LADDER['grok-4.7']).toBeUndefined();
    // Same model at 2× price — a rung would spend more for speed, not capability.
    expect(GROK_LADDER['grok-4.7-build-fast']).toBeUndefined();
    expect(Object.values(GROK_LADDER)).not.toContain('grok-4.7-build-fast');
  });

  it('has no OpenCode ladder — an aggregator has no vendor tiers to climb', () => {
    expect(DEFAULT_ESCALATION_LADDERS.opencode).toEqual({});
  });
});

describe('mergeEscalationMap', () => {
  it("returns the provider's default ladder unchanged when the user map is empty", () => {
    for (const provider of AI_PROVIDERS) {
      expect(mergeEscalationMap({}, provider)).toEqual(DEFAULT_ESCALATION_LADDERS[provider]);
    }
  });

  it('applies only the user rungs when no provider is known', () => {
    expect(mergeEscalationMap({}, undefined)).toEqual({});
    expect(mergeEscalationMap({ a: 'b' }, undefined)).toEqual({ a: 'b' });
  });

  it('lets user keys win on conflict with the default ladder', () => {
    const merged = mergeEscalationMap({ 'claude-sonnet-4-6': 'custom-overlord' }, 'claude-code');
    expect(merged['claude-sonnet-4-6']).toBe('custom-overlord');
    // Other default rungs are still present — user override does not wipe the ladder.
    expect(merged['claude-haiku-4-5']).toBe('claude-sonnet-5');
  });

  it("applies the flat user map on top of every provider's ladder", () => {
    const user = { 'claude-sonnet-5': 'claude-fable-5' };
    expect(mergeEscalationMap(user, 'claude-code')['claude-sonnet-5']).toBe('claude-fable-5');
    expect(mergeEscalationMap(user, 'github-copilot')['claude-sonnet-5']).toBe('claude-fable-5');
  });

  it('extends the ladder when the user adds a new rung', () => {
    const merged = mergeEscalationMap({ 'some-new-model': 'some-stronger-model' }, 'claude-code');
    expect(merged['some-new-model']).toBe('some-stronger-model');
    // Defaults still present.
    expect(merged['claude-sonnet-4-6']).toBe('claude-opus-4-8');
  });

  it('does not mutate the default ladders when the user override carries new entries', () => {
    const before = structuredClone(DEFAULT_ESCALATION_LADDERS);
    void mergeEscalationMap({ 'temp-key': 'temp-value' }, 'claude-code');
    expect(DEFAULT_ESCALATION_LADDERS).toEqual(before);
  });
});

describe('warnEscalationMapSelfLoops', () => {
  it('logs a warn-level record for each self-loop entry', () => {
    const { logger, warn } = fakeLogger();
    warnEscalationMapSelfLoops(
      { 'claude-opus-4-8': 'claude-opus-4-8', 'gpt-5.5': 'gpt-5.5', 'gpt-5-mini': 'gpt-5.5' },
      logger
    );
    expect(warn).toHaveBeenCalledTimes(2);
    const messages = warn.mock.calls.map((call) => String(call[0]));
    expect(messages.some((m) => m.includes('claude-opus-4-8'))).toBe(true);
    expect(messages.some((m) => m.includes('gpt-5.5'))).toBe(true);
    // Non-self-loop entry was not flagged.
    expect(messages.every((m) => !m.includes("'gpt-5-mini'"))).toBe(true);
  });

  it('emits nothing when no self-loop is present', () => {
    const { logger, warn } = fakeLogger();
    warnEscalationMapSelfLoops({ 'claude-sonnet-4-6': 'claude-opus-4-8', 'gpt-5-mini': 'gpt-5.5' }, logger);
    expect(warn).not.toHaveBeenCalled();
  });

  it('emits nothing when the map is empty', () => {
    const { logger, warn } = fakeLogger();
    warnEscalationMapSelfLoops({}, logger);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a self-loop entry parses cleanly through SettingsSchema and triggers one warn record', () => {
    const record = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      ai: {
        refine: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
        plan: { provider: 'claude-code', model: 'claude-opus-4-8' },
        implement: {
          generator: { provider: 'claude-code', model: 'claude-opus-4-8' },
          evaluator: { provider: 'claude-code', model: 'claude-opus-4-8' },
        },
        readiness: { provider: 'claude-code', model: 'claude-sonnet-4-6' },
        ideate: { provider: 'claude-code', model: 'claude-opus-4-8' },
      },
      harness: {
        maxTurns: 5,
        maxAttempts: 3,
        rateLimitRetries: 3,
        plateauThreshold: 2,
        escalationMap: { 'claude-opus-4-8': 'claude-opus-4-8' },
      },
      logging: { level: 'info' },
      concurrency: { maxParallelTasks: 1 },
      ui: { notifications: { enabled: true } },
    };
    const parsed = SettingsSchema.safeParse(record);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const { logger, warn } = fakeLogger();
    warnEscalationMapSelfLoops(parsed.data.harness.escalationMap, logger);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('claude-opus-4-8');
  });
});

describe('escalationMap retired targets', () => {
  const parseWithMap = (escalationMap: Record<string, string>) => {
    const parsed = SettingsSchema.safeParse({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      ai: {
        refine: { provider: 'github-copilot', model: 'claude-sonnet-5' },
        plan: { provider: 'github-copilot', model: 'claude-sonnet-5' },
        implement: {
          generator: { provider: 'github-copilot', model: 'claude-haiku-4.5' },
          evaluator: { provider: 'github-copilot', model: 'claude-sonnet-5' },
        },
        readiness: { provider: 'github-copilot', model: 'claude-sonnet-5' },
        ideate: { provider: 'github-copilot', model: 'claude-sonnet-5' },
      },
      harness: { maxTurns: 5, maxAttempts: 3, rateLimitRetries: 3, plateauThreshold: 2, escalationMap },
      logging: { level: 'info' },
      concurrency: { maxParallelTasks: 1 },
      ui: { notifications: { enabled: true } },
    });
    if (!parsed.success) throw parsed.error;
    return parsed.data.harness.escalationMap;
  };

  it('rewrites an unambiguously retired target at parse time and then warns about nothing', () => {
    const map = parseWithMap({ 'claude-haiku-4.5': 'claude-sonnet-4.5', 'claude-sonnet-5': 'claude-opus-4.8' });
    expect(map).toEqual({ 'claude-haiku-4.5': 'claude-sonnet-5', 'claude-sonnet-5': 'claude-opus-4.8' });
    const { logger, warn } = fakeLogger();
    warnEscalationMapRetiredValues(map, logger);
    expect(warn).not.toHaveBeenCalled();
  });

  it('leaves an ambiguous target (retired on codex, live on Copilot) in place and warns once', () => {
    const map = parseWithMap({ 'gpt-5-mini': 'gpt-5.4' });
    expect(map).toEqual({ 'gpt-5-mini': 'gpt-5.4' });
    const { logger, warn } = fakeLogger();
    warnEscalationMapRetiredValues(map, logger);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toContain('openai-codex');
    expect(message).toContain('gpt-6-sol');
  });
});

describe('DEFAULT_ESCALATION_LADDERS — catalog lockstep (mechanizes the section 14/18 model-bump audit)', () => {
  // A rung that names an id outside the generator provider's OWN catalog would be stamped onto a
  // task as `escalatedToModel`, then rejected by that provider's adapter at spawn time with
  // InvalidStateError — so every key AND value must be a member of THAT provider's catalog, not
  // merely of some catalog.
  const catalogFor: Readonly<Record<AiProvider, readonly string[]>> = {
    'claude-code': CLAUDE_MODELS,
    'github-copilot': COPILOT_MODELS,
    'openai-codex': CODEX_MODELS,
    opencode: OPENCODE_MODELS,
    'xai-grok': GROK_MODELS,
  };

  it("every ladder key and destination is a member of that provider's catalog", () => {
    for (const provider of AI_PROVIDERS) {
      const catalog = catalogFor[provider];
      for (const [from, to] of Object.entries(DEFAULT_ESCALATION_LADDERS[provider])) {
        expect(catalog, `${provider}: ladder key '${from}' is not in its catalog`).toContain(from);
        expect(catalog, `${provider}: ladder destination '${to}' is not in its catalog`).toContain(to);
      }
    }
  });

  // Fingerprint each catalog (stable hash of the sorted ids). When this test fails because a catalog
  // changed, a model bump just landed: run the HARNESS-PRINCIPLES.md model-bump audit (walk the
  // partial/gap rows, re-check the applied rows' load-bearing status, and confirm no
  // DEFAULT_ESCALATION_LADDERS rung was orphaned by a catalog rename/de-list), THEN update the
  // recorded hash.
  // This converts the section 18 ritual from a ticket convention into a verify-gate failure that
  // fires precisely when a model bump lands.
  const fingerprint = (ids: readonly string[]): string =>
    createHash('sha256')
      .update([...ids].sort().join('\n'))
      .digest('hex')
      .slice(0, 16);

  it('catalog fingerprints are unchanged — a failure means a model bump landed; run the model-bump audit', () => {
    expect(fingerprint(CLAUDE_MODELS)).toBe('456dd7013f3e81ec');
    expect(fingerprint(CODEX_MODELS)).toBe('e0c266c09d88d135');
    expect(fingerprint(COPILOT_MODELS)).toBe('6f10fab67bee9487');
    expect(fingerprint(GROK_MODELS)).toBe('2c56e449169a2ec3');
  });
});

describe('nextEffortRung', () => {
  // ── Claude is model-aware: the rung climbs one tier above the effective effort — the explicit
  //    level, or the model's CLI default (`medium` on Opus 5.5, `high` elsewhere) — so it never
  //    re-stamps the implicit default. ──

  const OPUS55 = 'claude-opus-5-5'; // CLI default `medium`
  const OPUS = 'claude-opus-4-8'; // xhigh-capable, CLI default `high`
  const SONNET5 = 'claude-sonnet-5'; // xhigh-capable, CLI default `high`
  const SONNET46 = 'claude-sonnet-4-6'; // effort-capable but NOT xhigh-capable (CLI default `high`)
  const HAIKU = 'claude-haiku-4-5'; // no effort dimension

  it('claude unset → one tier above the model CLI default (Opus 5.5 medium → high; others high → xhigh)', () => {
    expect(nextEffortRung('claude-code', OPUS55, undefined)).toBe('high');
    expect(nextEffortRung('claude-code', 'claude-opus-5', undefined)).toBe('xhigh');
    expect(nextEffortRung('claude-code', OPUS, undefined)).toBe('xhigh');
    expect(nextEffortRung('claude-code', SONNET5, undefined)).toBe('xhigh');
    expect(nextEffortRung('claude-code', 'claude-fable-5-1', undefined)).toBe('xhigh');
  });

  it('claude xhigh-capable + explicit level → exactly one tier up', () => {
    expect(nextEffortRung('claude-code', OPUS55, 'low')).toBe('medium');
    expect(nextEffortRung('claude-code', OPUS55, 'medium')).toBe('high');
    expect(nextEffortRung('claude-code', OPUS55, 'high')).toBe('xhigh');
    expect(nextEffortRung('claude-code', OPUS, 'high')).toBe('xhigh');
    expect(nextEffortRung('claude-code', SONNET5, 'medium')).toBe('high');
  });

  it('claude xhigh-capable + xhigh → max; + max → spent (undefined)', () => {
    expect(nextEffortRung('claude-code', OPUS55, 'xhigh')).toBe('max');
    expect(nextEffortRung('claude-code', OPUS, 'xhigh')).toBe('max');
    expect(nextEffortRung('claude-code', OPUS55, 'max')).toBeUndefined();
  });

  it('claude non-xhigh-capable (Sonnet 4.6) skips the unsupported xhigh tier', () => {
    // CLI default here is `high` and the model has no xhigh tier, so unset / high climb to `max`.
    expect(nextEffortRung('claude-code', SONNET46, undefined)).toBe('max');
    expect(nextEffortRung('claude-code', SONNET46, 'high')).toBe('max');
    expect(nextEffortRung('claude-code', SONNET46, 'low')).toBe('medium');
    expect(nextEffortRung('claude-code', SONNET46, 'max')).toBeUndefined();
  });

  it('claude model with no effort dimension (Haiku) → skipped (undefined) regardless of effort', () => {
    expect(nextEffortRung('claude-code', HAIKU, undefined)).toBeUndefined();
    expect(nextEffortRung('claude-code', HAIKU, 'low')).toBeUndefined();
  });

  // ── Copilot keeps the original fixed-`high` semantics; model plays no role. ──

  it('copilot escalates a fresh or below-target row to the fixed target `high`', () => {
    expect(nextEffortRung('github-copilot', 'gpt-5.5', undefined)).toBe(EFFORT_ESCALATION_TARGET);
    expect(nextEffortRung('github-copilot', 'gpt-5.5', 'low')).toBe(EFFORT_ESCALATION_TARGET);
  });

  it('copilot returns undefined when already at/above the fixed target (no headroom)', () => {
    expect(nextEffortRung('github-copilot', 'gpt-5.5', 'high')).toBeUndefined();
    expect(nextEffortRung('github-copilot', 'gpt-5.5', 'xhigh')).toBeUndefined();
  });

  // ── Codex targets the fixed `xhigh` rung — universal across the codex catalog since the
  //    vocabulary change, so every codex preset (which stamps `high`) has a live rung. ──

  it('codex escalates a fresh, below-target, or legacy `minimal` row to the fixed target `xhigh`', () => {
    expect(nextEffortRung('openai-codex', 'gpt-5.6-sol', undefined)).toBe(CODEX_EFFORT_ESCALATION_TARGET);
    expect(nextEffortRung('openai-codex', 'gpt-5.5', 'high')).toBe(CODEX_EFFORT_ESCALATION_TARGET);
    expect(nextEffortRung('openai-codex', 'gpt-5.5', 'minimal')).toBe(CODEX_EFFORT_ESCALATION_TARGET);
  });

  it('codex returns undefined when already at/above the fixed target (no headroom)', () => {
    expect(nextEffortRung('openai-codex', 'gpt-5.5', 'xhigh')).toBeUndefined();
    expect(nextEffortRung('openai-codex', 'gpt-5.5', 'max')).toBeUndefined();
    expect(nextEffortRung('openai-codex', 'gpt-5.5', 'ultra')).toBeUndefined();
  });

  // ── Grok shares Codex's fixed `xhigh` target — universal across the grok catalog. ──

  it('grok escalates a fresh, below-target, or `minimal` row to the fixed target `xhigh`', () => {
    expect(nextEffortRung('xai-grok', 'grok-4.6', undefined)).toBe(CODEX_EFFORT_ESCALATION_TARGET);
    expect(nextEffortRung('xai-grok', 'grok-4.6', 'high')).toBe(CODEX_EFFORT_ESCALATION_TARGET);
    expect(nextEffortRung('xai-grok', 'grok-4.5', 'minimal')).toBe(CODEX_EFFORT_ESCALATION_TARGET);
  });

  it('grok returns undefined when already at/above the fixed target (no headroom)', () => {
    expect(nextEffortRung('xai-grok', 'grok-4.6', 'xhigh')).toBeUndefined();
    expect(nextEffortRung('xai-grok', 'grok-4.6', 'max')).toBeUndefined();
  });

  it('returns undefined when no provider is resolvable (skips the rung gracefully)', () => {
    expect(nextEffortRung(undefined, OPUS, undefined)).toBeUndefined();
    expect(nextEffortRung(undefined, OPUS, 'low')).toBeUndefined();
  });

  it('returns undefined for a provider outside the effort-capable set (forward-compat)', () => {
    // A future provider with no effort dimension must skip the rung rather than stamp a level the
    // adapter would reject.
    expect(nextEffortRung('some-future-provider' as AiProvider, OPUS, undefined)).toBeUndefined();
  });
});

describe('escalationLadderCyclicFrom', () => {
  it('returns false for an acyclic chain that reaches a terminus', () => {
    expect(escalationLadderCyclicFrom({ a: 'b', b: 'c' }, 'a')).toBe(false);
  });

  it('returns false when the start model has no rung', () => {
    expect(escalationLadderCyclicFrom({ a: 'b' }, 'z')).toBe(false);
  });

  it('detects a self-loop (1-cycle)', () => {
    expect(escalationLadderCyclicFrom({ a: 'a' }, 'a')).toBe(true);
  });

  it('detects a multi-node cycle from either node', () => {
    const map = { a: 'b', b: 'a' };
    expect(escalationLadderCyclicFrom(map, 'a')).toBe(true);
    expect(escalationLadderCyclicFrom(map, 'b')).toBe(true);
  });

  it('detects a cycle reachable downstream of the start (lead-in chain)', () => {
    expect(escalationLadderCyclicFrom({ a: 'b', b: 'c', c: 'b' }, 'a')).toBe(true);
  });

  it('does not flag any acyclic DEFAULT_ESCALATION_LADDERS entry from any of its keys', () => {
    for (const provider of AI_PROVIDERS) {
      const ladder = DEFAULT_ESCALATION_LADDERS[provider];
      for (const key of Object.keys(ladder)) {
        expect(escalationLadderCyclicFrom(ladder, key), `${provider}: cycle from ${key}`).toBe(false);
      }
    }
  });
});
