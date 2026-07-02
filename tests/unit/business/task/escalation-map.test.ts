/**
 * Contract for `business/task/escalation-map.ts`:
 *
 *  - `DEFAULT_ESCALATION_MAP` contains the seed ladders the ticket requires.
 *  - `mergeEscalationMap` overlays user-over-default with user keys winning on conflict
 *    and user-only keys extending the default ladder.
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
import type { AiProvider } from '@src/domain/entity/settings.ts';
import {
  DEFAULT_ESCALATION_MAP,
  EFFORT_ESCALATION_TARGET,
  escalationLadderCyclicFrom,
  mergeEscalationMap,
  nextEffortRung,
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

describe('DEFAULT_ESCALATION_MAP', () => {
  it('seeds the ticket-mandated ladders (claude-sonnet-4-6 → claude-opus-4-8, gpt-5-mini → gpt-5.5)', () => {
    expect(DEFAULT_ESCALATION_MAP['claude-sonnet-4-6']).toBe('claude-opus-4-8');
    expect(DEFAULT_ESCALATION_MAP['gpt-5-mini']).toBe('gpt-5.5');
  });

  it('lets the economic codex/copilot full tier climb to flagship (gpt-5.4 → gpt-5.5)', () => {
    expect(DEFAULT_ESCALATION_MAP['gpt-5.4']).toBe('gpt-5.5');
  });

  it('seeds the dot-form Copilot Claude rungs (haiku → sonnet → opus)', () => {
    expect(DEFAULT_ESCALATION_MAP['claude-haiku-4.5']).toBe('claude-sonnet-4.6');
    expect(DEFAULT_ESCALATION_MAP['claude-sonnet-4.6']).toBe('claude-opus-4.8');
  });

  it('climbs the dash-form Claude-Code/Codex ladder via Sonnet 5 (haiku → sonnet-5 → opus)', () => {
    expect(DEFAULT_ESCALATION_MAP['claude-haiku-4-5']).toBe('claude-sonnet-5');
    expect(DEFAULT_ESCALATION_MAP['claude-sonnet-5']).toBe('claude-opus-4-8');
  });

  it('retains the legacy claude-sonnet-4-6 → claude-opus-4-8 rung so pinned 4.6 configs still climb', () => {
    expect(DEFAULT_ESCALATION_MAP['claude-sonnet-4-6']).toBe('claude-opus-4-8');
  });
});

describe('mergeEscalationMap', () => {
  it('returns the default ladder unchanged when the user map is empty', () => {
    expect(mergeEscalationMap({})).toEqual(DEFAULT_ESCALATION_MAP);
  });

  it('lets user keys win on conflict with the default ladder', () => {
    const merged = mergeEscalationMap({ 'claude-sonnet-4-6': 'custom-overlord' });
    expect(merged['claude-sonnet-4-6']).toBe('custom-overlord');
    // Other default rungs are still present — user override does not wipe the ladder.
    expect(merged['gpt-5-mini']).toBe('gpt-5.5');
  });

  it('extends the ladder when the user adds a new rung', () => {
    const merged = mergeEscalationMap({ 'some-new-model': 'some-stronger-model' });
    expect(merged['some-new-model']).toBe('some-stronger-model');
    // Defaults still present.
    expect(merged['claude-sonnet-4-6']).toBe('claude-opus-4-8');
  });

  it('does not mutate the default map when the user override carries new entries', () => {
    const before = { ...DEFAULT_ESCALATION_MAP };
    void mergeEscalationMap({ 'temp-key': 'temp-value' });
    expect(DEFAULT_ESCALATION_MAP).toEqual(before);
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
      developer: { showEvaluatorFailureUI: false },
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

describe('DEFAULT_ESCALATION_MAP — catalog lockstep (mechanizes the section 14/18 model-bump audit)', () => {
  // The union of every per-provider catalog id. A ladder rung that names an id outside this set
  // would be stamped onto a task as `escalatedToModel`, then rejected by the adapter at spawn time
  // with InvalidStateError — so every key AND value must be a member.
  const catalogIds = new Set<string>([...CLAUDE_MODELS, ...CODEX_MODELS, ...COPILOT_MODELS]);

  it('every ladder key is a member of some provider catalog', () => {
    for (const from of Object.keys(DEFAULT_ESCALATION_MAP)) {
      expect(catalogIds.has(from), `ladder key '${from}' is not in any model catalog`).toBe(true);
    }
  });

  it('every ladder destination is a member of some provider catalog', () => {
    for (const to of Object.values(DEFAULT_ESCALATION_MAP)) {
      expect(catalogIds.has(to), `ladder destination '${to}' is not in any model catalog`).toBe(true);
    }
  });

  // Fingerprint each catalog (stable hash of the sorted ids). When this test fails because a catalog
  // changed, a model bump just landed: run the HARNESS-PRINCIPLES.md model-bump audit (walk the
  // partial/gap rows, re-check the applied rows' load-bearing status, and confirm no DEFAULT_
  // ESCALATION_MAP rung was orphaned by a catalog rename/de-list), THEN update the recorded hash.
  // This converts the section 18 ritual from a ticket convention into a verify-gate failure that
  // fires precisely when a model bump lands.
  const fingerprint = (ids: readonly string[]): string =>
    createHash('sha256')
      .update([...ids].sort().join('\n'))
      .digest('hex')
      .slice(0, 16);

  it('catalog fingerprints are unchanged — a failure means a model bump landed; run the model-bump audit', () => {
    expect(fingerprint(CLAUDE_MODELS)).toBe('f49667dc324c37cc');
    expect(fingerprint(CODEX_MODELS)).toBe('d0af18882f9e15ac');
    expect(fingerprint(COPILOT_MODELS)).toBe('1f51a63b2cbf93f0');
  });
});

describe('nextEffortRung', () => {
  // ── Claude is model-aware: its CLI default is `xhigh` on xhigh-capable models, so the rung
  //    climbs Claude's own tiers (…→ xhigh → max), never re-stamping the implicit default. ──

  const OPUS = 'claude-opus-4-8'; // xhigh-capable frontier
  const SONNET5 = 'claude-sonnet-5'; // xhigh-capable
  const SONNET46 = 'claude-sonnet-4-6'; // effort-capable but NOT xhigh-capable (CLI default `high`)
  const HAIKU = 'claude-haiku-4-5'; // no effort dimension

  it('claude xhigh-capable + unset (CLI default xhigh) → max in a single step', () => {
    // The shipped default posture (`claude-opus-4-8`, effort unset). A fixed `high` here would be a
    // no-op / downgrade of the implicit xhigh — the rung must climb to `max` instead.
    expect(nextEffortRung('claude-code', OPUS, undefined)).toBe('max');
    expect(nextEffortRung('claude-code', SONNET5, undefined)).toBe('max');
  });

  it('claude xhigh-capable + explicit low/medium/high → xhigh (the first power tier)', () => {
    expect(nextEffortRung('claude-code', OPUS, 'low')).toBe('xhigh');
    expect(nextEffortRung('claude-code', OPUS, 'medium')).toBe('xhigh');
    expect(nextEffortRung('claude-code', OPUS, 'high')).toBe('xhigh');
    expect(nextEffortRung('claude-code', SONNET5, 'medium')).toBe('xhigh');
  });

  it('claude xhigh-capable + xhigh → max; + max → spent (undefined)', () => {
    expect(nextEffortRung('claude-code', OPUS, 'xhigh')).toBe('max');
    expect(nextEffortRung('claude-code', OPUS, 'max')).toBeUndefined();
  });

  it('claude non-xhigh-capable (Sonnet 4.6) → max, skipping the unsupported xhigh tier', () => {
    // CLI default here is `high` (no xhigh tier), so unset AND every explicit tier below max climb
    // straight to `max`. Never a no-op / downgrade.
    expect(nextEffortRung('claude-code', SONNET46, undefined)).toBe('max');
    expect(nextEffortRung('claude-code', SONNET46, 'low')).toBe('max');
    expect(nextEffortRung('claude-code', SONNET46, 'high')).toBe('max');
    expect(nextEffortRung('claude-code', SONNET46, 'max')).toBeUndefined();
  });

  it('claude model with no effort dimension (Haiku) → skipped (undefined) regardless of effort', () => {
    expect(nextEffortRung('claude-code', HAIKU, undefined)).toBeUndefined();
    expect(nextEffortRung('claude-code', HAIKU, 'low')).toBeUndefined();
  });

  // ── Copilot / Codex keep the original fixed-`high` semantics; model plays no role. ──

  it('copilot/codex escalate a fresh or below-target row to the fixed target `high`', () => {
    expect(nextEffortRung('github-copilot', 'gpt-5.5', undefined)).toBe(EFFORT_ESCALATION_TARGET);
    expect(nextEffortRung('openai-codex', 'gpt-5.5', undefined)).toBe(EFFORT_ESCALATION_TARGET);
    expect(nextEffortRung('github-copilot', 'gpt-5.5', 'low')).toBe(EFFORT_ESCALATION_TARGET);
    expect(nextEffortRung('openai-codex', 'gpt-5.5', 'minimal')).toBe(EFFORT_ESCALATION_TARGET);
  });

  it('copilot/codex return undefined when already at/above the fixed target (no headroom)', () => {
    expect(nextEffortRung('github-copilot', 'gpt-5.5', 'high')).toBeUndefined();
    expect(nextEffortRung('github-copilot', 'gpt-5.5', 'xhigh')).toBeUndefined();
    expect(nextEffortRung('openai-codex', 'gpt-5.5', 'high')).toBeUndefined();
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

  it('does not flag the acyclic DEFAULT_ESCALATION_MAP from any of its keys', () => {
    for (const key of Object.keys(DEFAULT_ESCALATION_MAP)) {
      expect(escalationLadderCyclicFrom(DEFAULT_ESCALATION_MAP, key), `cycle from ${key}`).toBe(false);
    }
  });
});
