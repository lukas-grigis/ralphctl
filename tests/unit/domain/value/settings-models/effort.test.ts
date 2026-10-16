import { describe, expect, it } from 'vitest';
import { modelEffortLevels, PROVIDER_EFFORT_LEVELS } from '@src/domain/value/settings-models/effort.ts';
import { CLAUDE_MODEL_EFFORT_LEVELS, CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { COPILOT_MODEL_EFFORT_LEVELS } from '@src/domain/value/settings-models/copilot.ts';
import { CODEX_MODEL_EFFORT_LEVELS } from '@src/domain/value/settings-models/codex.ts';
import { GROK_MODEL_EFFORT_LEVELS } from '@src/domain/value/settings-models/grok.ts';

describe('settings-models / per-model effort levels', () => {
  it.each([
    ['claude-code', CLAUDE_MODEL_EFFORT_LEVELS],
    ['github-copilot', COPILOT_MODEL_EFFORT_LEVELS],
    ['openai-codex', CODEX_MODEL_EFFORT_LEVELS],
    ['xai-grok', GROK_MODEL_EFFORT_LEVELS],
  ] as const)('%s: every listed level is in the provider vocabulary the settings schema accepts', (provider, table) => {
    const vocabulary: readonly string[] = PROVIDER_EFFORT_LEVELS[provider];
    for (const [model, levels] of Object.entries(table)) {
      for (const level of levels ?? []) expect(vocabulary, `${model}: ${level}`).toContain(level);
    }
  });

  it('records claude-haiku-4.5 on Copilot as having no effort dimension', () => {
    expect(modelEffortLevels('github-copilot', 'claude-haiku-4.5')).toEqual([]);
  });

  it('records the Claude Code per-model facts — haiku-4-5 has no effort, sonnet-4-6 lacks xhigh, the rest take all five', () => {
    expect(modelEffortLevels('claude-code', 'claude-haiku-4-5')).toEqual([]);
    expect(modelEffortLevels('claude-code', 'claude-sonnet-4-6')).toEqual(['low', 'medium', 'high', 'max']);
    for (const model of CLAUDE_MODELS.filter((m) => m !== 'claude-haiku-4-5' && m !== 'claude-sonnet-4-6')) {
      expect(modelEffortLevels('claude-code', model), model).toEqual(PROVIDER_EFFORT_LEVELS['claude-code']);
    }
  });

  it('returns undefined (unknown → the CLI arbitrates) for custom ids and providers without a table', () => {
    expect(modelEffortLevels('github-copilot', 'some-custom-model')).toBeUndefined();
    expect(modelEffortLevels('claude-code', 'claude-custom-preview')).toBeUndefined();
    expect(modelEffortLevels('opencode', 'openrouter/anthropic/claude-haiku-4.5')).toBeUndefined();
    // Same model on faster serving, but no published effort data — left to the CLI.
    expect(modelEffortLevels('xai-grok', 'grok-4.7-build-fast')).toBeUndefined();
    expect(modelEffortLevels('xai-grok', 'grok-5-custom')).toBeUndefined();
  });

  it('caps grok-4.5 at high and grok-4.6 / grok-4.7 at xhigh — no catalog Grok model accepts max', () => {
    expect(modelEffortLevels('xai-grok', 'grok-4.5')?.at(-1)).toBe('high');
    expect(modelEffortLevels('xai-grok', 'grok-4.6')?.at(-1)).toBe('xhigh');
    expect(modelEffortLevels('xai-grok', 'grok-4.7')?.at(-1)).toBe('xhigh');
    for (const levels of Object.values(GROK_MODEL_EFFORT_LEVELS)) expect(levels).not.toContain('max');
  });

  it('keeps the Grok-native levels below low (none / minimal) on every listed Grok model', () => {
    for (const levels of Object.values(GROK_MODEL_EFFORT_LEVELS)) {
      expect(levels?.slice(0, 3)).toEqual(['none', 'minimal', 'low']);
    }
  });
});
