/**
 * Contract for the optional `settings.ai.implement.agents` role-binding block.
 *
 * Shape: `{ generator?: string; evaluator?: string }` — both keys optional. Absent (or an
 * absent `agents` block altogether) means "no binding for this role". Names are free trimmed
 * non-empty strings; the domain never validates them against the integration-side
 * agent-definition catalog.
 */

import { describe, expect, it } from 'vitest';
import { primaryAgentBinding, SettingsSchema } from '@src/domain/entity/settings.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';

const withAgents = (agents: unknown): unknown => ({
  ...DEFAULT_SETTINGS,
  ai: {
    ...DEFAULT_SETTINGS.ai,
    implement: { ...DEFAULT_SETTINGS.ai.implement, agents },
  },
});

describe('settings.ai.implement.agents — role-binding preference', () => {
  it('accepts an absent block (DEFAULT_SETTINGS carries no agents block)', () => {
    const parsed = SettingsSchema.safeParse(DEFAULT_SETTINGS);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.implement.agents).toBeUndefined();
  });

  it('accepts an empty agents object (no role bound)', () => {
    const parsed = SettingsSchema.safeParse(withAgents({}));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.implement.agents).toEqual({});
  });

  it('round-trips an independent generator binding', () => {
    const parsed = SettingsSchema.safeParse(withAgents({ generator: 'ralphctl-implementer' }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.implement.agents).toEqual({ generator: 'ralphctl-implementer' });
  });

  it('round-trips an independent evaluator binding', () => {
    const parsed = SettingsSchema.safeParse(withAgents({ evaluator: 'ralphctl-evaluator' }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.implement.agents).toEqual({ evaluator: 'ralphctl-evaluator' });
  });

  it('round-trips both roles bound to distinct definitions', () => {
    const agents = { generator: 'ralphctl-implementer', evaluator: 'ralphctl-evaluator' };
    const parsed = SettingsSchema.safeParse(withAgents(agents));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.implement.agents).toEqual(agents);
  });

  it('trims agent-name entries', () => {
    const parsed = SettingsSchema.safeParse(withAgents({ generator: '  ralphctl-implementer  ' }));
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.implement.agents).toEqual({ generator: 'ralphctl-implementer' });
  });

  it('rejects a blank (whitespace-only) agent name', () => {
    const parsed = SettingsSchema.safeParse(withAgents({ generator: '   ' }));
    expect(parsed.success).toBe(false);
  });

  it('strips a target key outside generator/evaluator rather than failing the whole parse', () => {
    const parsed = SettingsSchema.safeParse(
      withAgents({ reviewer: 'ralphctl-reviewer', generator: 'ralphctl-implementer' })
    );
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.ai.implement.agents).toEqual({ generator: 'ralphctl-implementer' });
  });

  it('is stable under a second parse (schema-level save/load round-trip)', () => {
    const agents = { evaluator: 'ralphctl-evaluator' };
    const once = SettingsSchema.safeParse(withAgents(agents));
    expect(once.success).toBe(true);
    if (!once.success) return;
    const twice = SettingsSchema.safeParse(once.data);
    expect(twice.success).toBe(true);
    if (!twice.success) return;
    expect(twice.data.ai.implement.agents).toEqual(agents);
  });
});

describe('primaryAgentBinding', () => {
  it('returns undefined when the agents block is absent', () => {
    expect(primaryAgentBinding(undefined, 'generator')).toBeUndefined();
    expect(primaryAgentBinding(undefined, 'evaluator')).toBeUndefined();
  });

  it('returns undefined for a role with no binding', () => {
    expect(primaryAgentBinding({ generator: 'ralphctl-implementer' }, 'evaluator')).toBeUndefined();
  });

  it('returns the bound name for the requested role', () => {
    const agents = { generator: 'ralphctl-implementer', evaluator: 'ralphctl-evaluator' };
    expect(primaryAgentBinding(agents, 'generator')).toBe('ralphctl-implementer');
    expect(primaryAgentBinding(agents, 'evaluator')).toBe('ralphctl-evaluator');
  });
});
