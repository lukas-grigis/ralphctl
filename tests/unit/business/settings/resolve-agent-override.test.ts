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
    expect(resolveAgentOverride(row, 'medium', undefined, 'implement')).toEqual({
      model: 'claude-sonnet-5',
      effort: 'high',
    });
  });

  it('falls through to the global default effort when neither a definition nor the row specify one', () => {
    const row = claudeRow();
    expect(resolveAgentOverride(row, 'medium', undefined, 'implement')).toEqual({
      model: 'claude-sonnet-5',
      effort: 'medium',
    });
  });

  it('falls through to the flow default when nothing is set anywhere — never the CLI default', () => {
    const row = claudeRow();
    expect(resolveAgentOverride(row, undefined, undefined, 'implement')).toEqual({
      model: 'claude-sonnet-5',
      effort: 'high',
    });
  });

  it('a definition specifying both model and effort overrides a differing per-flow row', () => {
    const row = claudeRow('low');
    const resolved = resolveAgentOverride(row, 'medium', { model: 'claude-opus-4-8', effort: 'max' }, 'implement');
    expect(resolved).toEqual({ model: 'claude-opus-4-8', effort: 'max' });
  });

  it('a definition specifying neither model nor effort falls through to the per-flow row', () => {
    const row = claudeRow('high');
    const resolved = resolveAgentOverride(row, 'medium', {}, 'implement');
    expect(resolved).toEqual({ model: 'claude-sonnet-5', effort: 'high' });
  });

  it('a definition specifying neither falls through to the global default when the row omits effort', () => {
    const row = claudeRow();
    const resolved = resolveAgentOverride(row, 'xhigh', {}, 'implement');
    expect(resolved).toEqual({ model: 'claude-sonnet-5', effort: 'xhigh' });
  });

  it('a definition specifying only model keeps the row/global-derived effort', () => {
    const row = claudeRow('high');
    const resolved = resolveAgentOverride(row, 'medium', { model: 'claude-opus-4-8' }, 'implement');
    expect(resolved).toEqual({ model: 'claude-opus-4-8', effort: 'high' });
  });

  it('a definition specifying only effort keeps the row model', () => {
    const row = claudeRow();
    const resolved = resolveAgentOverride(row, 'medium', { effort: 'max' }, 'implement');
    expect(resolved).toEqual({ model: 'claude-sonnet-5', effort: 'max' });
  });

  it('passes a binding-supplied xhigh through unclamped for codex (xhigh is now universal across the catalog)', () => {
    // A definition-bound effort still goes through the same provider floor as the
    // global-default path — codex now accepts low|medium|high|xhigh|max|ultra, so xhigh
    // passes through identity.
    const row = codexRow();
    const resolved = resolveAgentOverride(row, 'medium', { effort: 'xhigh' }, 'implement');
    expect(resolved).toEqual({ model: 'gpt-5.5', effort: 'xhigh' });
  });

  it('floors a binding-supplied max to the codex provider ceiling (xhigh)', () => {
    const row = codexRow();
    const resolved = resolveAgentOverride(row, 'medium', { effort: 'max' }, 'implement');
    expect(resolved).toEqual({ model: 'gpt-5.5', effort: 'xhigh' });
  });

  it('leaves a binding-supplied xhigh untouched on a claude-code row (identity)', () => {
    const row = claudeRow();
    const resolved = resolveAgentOverride(row, 'medium', { effort: 'xhigh' }, 'implement');
    expect(resolved).toEqual({ model: 'claude-sonnet-5', effort: 'xhigh' });
  });

  it('passes an unknown/out-of-vocabulary binding effort through unchanged', () => {
    const row = codexRow();
    const resolved = resolveAgentOverride(row, 'medium', { effort: 'ultra-mega' }, 'implement');
    expect(resolved).toEqual({ model: 'gpt-5.5', effort: 'ultra-mega' });
  });

  it('passes a global xhigh default through unclamped for codex when no definition/row effort is set', () => {
    const row = codexRow();
    const resolved = resolveAgentOverride(row, 'xhigh', undefined, 'implement');
    expect(resolved).toEqual({ model: 'gpt-5.5', effort: 'xhigh' });
  });

  it('floors a global max default to xhigh for codex when no definition/row effort is set', () => {
    const row = codexRow();
    const resolved = resolveAgentOverride(row, 'max', undefined, 'implement');
    expect(resolved).toEqual({ model: 'gpt-5.5', effort: 'xhigh' });
  });
});
