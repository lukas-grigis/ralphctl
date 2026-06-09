import { describe, expect, it } from 'vitest';
import { CODEX_MODELS, isCodexModel } from '@src/domain/value/settings-models/codex.ts';
import { COPILOT_MODELS, isCopilotModel } from '@src/domain/value/settings-models/copilot.ts';

describe('settings-models / codex catalog', () => {
  const added = ['gpt-5.3-codex-spark'] as const;
  // Deprecated for ChatGPT sign-in but kept available via API-key auth — must not be dropped.
  const keptDeprecated = ['gpt-5.2', 'gpt-5.3-codex'] as const;

  it('keeps all six previously-shipped entries plus the synthetic review id', () => {
    for (const m of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2', 'codex-auto-review']) {
      expect(CODEX_MODELS).toContain(m);
    }
  });

  it('adds the new codex 0.138 research-preview model', () => {
    for (const m of added) {
      expect(CODEX_MODELS).toContain(m);
      expect(isCodexModel(m)).toBe(true);
    }
  });

  it('keeps the deprecated-but-API-valid models in the allowlist', () => {
    for (const m of keptDeprecated) {
      expect(isCodexModel(m)).toBe(true);
    }
  });

  it('rejects unknown ids', () => {
    expect(isCodexModel('gpt-9000')).toBe(false);
  });
});

describe('settings-models / copilot catalog', () => {
  const added = [
    'gpt-5.5',
    'claude-opus-4.7',
    'claude-opus-4.8',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
    'gemini-3.5-flash',
    'gemini-2.5-pro',
    'mai-code-1-flash',
    'raptor-mini-preview',
  ] as const;

  it('keeps the previously-shipped entries', () => {
    for (const m of [
      'gpt-5-mini',
      'gpt-5.4-mini',
      'gpt-5.1',
      'gpt-5.4',
      'gpt-5.3-codex',
      'gpt-5.2-codex',
      'gpt-5.2',
      'gpt-5.1-codex-max',
      'gpt-5.1-codex',
      'gpt-5.1-codex-mini',
      'gpt-4.1',
      'claude-haiku-4.5',
      'claude-sonnet-4.6',
      'claude-sonnet-4.5',
      'claude-sonnet-4',
      'claude-opus-4.6',
      'claude-opus-4.6-fast',
      'claude-opus-4.5',
      'gemini-3-pro-preview',
    ]) {
      expect(COPILOT_MODELS).toContain(m);
    }
  });

  it('adds the copilot 1.0.60 model ids', () => {
    for (const m of added) {
      expect(COPILOT_MODELS).toContain(m);
      expect(isCopilotModel(m)).toBe(true);
    }
  });

  it('rejects unknown ids', () => {
    expect(isCopilotModel('claude-opus-9')).toBe(false);
  });
});
