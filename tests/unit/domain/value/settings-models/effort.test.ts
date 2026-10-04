import { describe, expect, it } from 'vitest';
import { modelEffortLevels, PROVIDER_EFFORT_LEVELS } from '@src/domain/value/settings-models/effort.ts';
import { COPILOT_MODEL_EFFORT_LEVELS } from '@src/domain/value/settings-models/copilot.ts';
import { CODEX_MODEL_EFFORT_LEVELS } from '@src/domain/value/settings-models/codex.ts';

describe('settings-models / per-model effort levels', () => {
  it.each([
    ['github-copilot', COPILOT_MODEL_EFFORT_LEVELS],
    ['openai-codex', CODEX_MODEL_EFFORT_LEVELS],
  ] as const)('%s: every listed level is in the provider vocabulary the settings schema accepts', (provider, table) => {
    const vocabulary: readonly string[] = PROVIDER_EFFORT_LEVELS[provider];
    for (const [model, levels] of Object.entries(table)) {
      for (const level of levels ?? []) expect(vocabulary, `${model}: ${level}`).toContain(level);
    }
  });

  it('records claude-haiku-4.5 on Copilot as having no effort dimension', () => {
    expect(modelEffortLevels('github-copilot', 'claude-haiku-4.5')).toEqual([]);
  });

  it('returns undefined (unknown → the CLI arbitrates) for custom ids and providers without a table', () => {
    expect(modelEffortLevels('github-copilot', 'some-custom-model')).toBeUndefined();
    expect(modelEffortLevels('claude-code', 'claude-haiku-4-5')).toBeUndefined();
    expect(modelEffortLevels('opencode', 'openrouter/anthropic/claude-haiku-4.5')).toBeUndefined();
    expect(modelEffortLevels('xai-grok', 'grok-4.7')).toBeUndefined();
  });
});
