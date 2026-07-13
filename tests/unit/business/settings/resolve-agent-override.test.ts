import { describe, expect, it } from 'vitest';
import type { AiFlowSettings } from '@src/domain/entity/settings.ts';
import { resolveAgentOverride } from '@src/business/settings/resolve-agent-override.ts';

const claudeRow = (effort?: string): AiFlowSettings =>
  ({
    provider: 'claude-code',
    model: 'claude-sonnet-5',
    ...(effort !== undefined ? { effort } : {}),
  }) as AiFlowSettings;

const codexRow = (effort?: string): AiFlowSettings =>
  ({ provider: 'openai-codex', model: 'gpt-5.5', ...(effort !== undefined ? { effort } : {}) }) as AiFlowSettings;

describe('resolveAgentOverride', () => {
  it('falls through to the per-flow row model/effort when no definition is bound', () => {
    const row = claudeRow('high');
    expect(resolveAgentOverride(row, 'medium', undefined)).toEqual({ model: 'claude-sonnet-5', effort: 'high' });
  });

  it('falls through to the global default effort when neither a definition nor the row specify one', () => {
    const row = claudeRow();
    expect(resolveAgentOverride(row, 'medium', undefined)).toEqual({ model: 'claude-sonnet-5', effort: 'medium' });
  });

  it('leaves model/effort undefined-floored when nothing is set anywhere', () => {
    const row = claudeRow();
    expect(resolveAgentOverride(row, undefined, undefined)).toEqual({ model: 'claude-sonnet-5', effort: undefined });
  });

  it('a definition specifying both model and effort overrides a differing per-flow row', () => {
    const row = claudeRow('low');
    const resolved = resolveAgentOverride(row, 'medium', { model: 'claude-opus-4-8', effort: 'max' });
    expect(resolved).toEqual({ model: 'claude-opus-4-8', effort: 'max' });
  });

  it('a definition specifying neither model nor effort falls through to the per-flow row', () => {
    const row = claudeRow('high');
    const resolved = resolveAgentOverride(row, 'medium', {});
    expect(resolved).toEqual({ model: 'claude-sonnet-5', effort: 'high' });
  });

  it('a definition specifying neither falls through to the global default when the row omits effort', () => {
    const row = claudeRow();
    const resolved = resolveAgentOverride(row, 'xhigh', {});
    expect(resolved).toEqual({ model: 'claude-sonnet-5', effort: 'xhigh' });
  });

  it('a definition specifying only model keeps the row/global-derived effort', () => {
    const row = claudeRow('high');
    const resolved = resolveAgentOverride(row, 'medium', { model: 'claude-opus-4-8' });
    expect(resolved).toEqual({ model: 'claude-opus-4-8', effort: 'high' });
  });

  it('a definition specifying only effort keeps the row model', () => {
    const row = claudeRow();
    const resolved = resolveAgentOverride(row, 'medium', { effort: 'max' });
    expect(resolved).toEqual({ model: 'claude-sonnet-5', effort: 'max' });
  });

  it('a bound definition effort still composes with the provider floor when it is the global that supplies it', () => {
    // The definition wins outright here — 'xhigh' passes through verbatim, unfloored, because
    // a definition-supplied effort bypasses resolveEffortForRow's provider-floor table
    // entirely (that table only applies to the global-default fallback path).
    const row = codexRow();
    const resolved = resolveAgentOverride(row, 'medium', { effort: 'xhigh' });
    expect(resolved).toEqual({ model: 'gpt-5.5', effort: 'xhigh' });
  });

  it('floors the global default to the codex provider ceiling when no definition/row effort is set', () => {
    const row = codexRow();
    const resolved = resolveAgentOverride(row, 'xhigh', undefined);
    expect(resolved).toEqual({ model: 'gpt-5.5', effort: 'high' });
  });
});
