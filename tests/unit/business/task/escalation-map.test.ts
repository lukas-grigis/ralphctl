/**
 * Contract for `business/task/escalation-map.ts`:
 *
 *  - `DEFAULT_ESCALATION_MAP` contains the seed ladders the ticket requires.
 *  - `mergeEscalationMap` overlays user-over-default with user keys winning on conflict
 *    and user-only keys extending the default ladder.
 *  - `warnEscalationMapSelfLoops` logs one `warn`-level record per `{ x: x }` entry and
 *    leaves the input untouched.
 */

import { describe, expect, it, vi } from 'vitest';
import { CURRENT_SCHEMA_VERSION, SettingsSchema } from '@src/domain/entity/settings.ts';
import type { Logger } from '@src/business/observability/logger.ts';
import {
  DEFAULT_ESCALATION_MAP,
  escalationLadderCyclicFrom,
  mergeEscalationMap,
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

  it('keeps the dash-form Claude-Code/Codex Claude rungs (haiku → sonnet → opus)', () => {
    expect(DEFAULT_ESCALATION_MAP['claude-haiku-4-5']).toBe('claude-sonnet-4-6');
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
