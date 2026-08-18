import { describe, expect, it } from 'vitest';
import { CODEX_MODELS, isCodexModel } from '@src/domain/value/settings-models/codex.ts';
import { COPILOT_MODELS, isCopilotModel } from '@src/domain/value/settings-models/copilot.ts';

describe('settings-models / codex catalog', () => {
  // Verified against the live CLI model cache (codex CLI v0.145.0, 2026-07-26).
  const kept = ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'codex-auto-review'] as const;
  const added = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'] as const;
  // Gone from the codex CLI entirely — persisted rows are remapped to `gpt-5.5` at parse time.
  const removed = ['gpt-5.2', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'] as const;

  it('keeps the previously-shipped entries plus the synthetic review id', () => {
    for (const m of kept) {
      expect(CODEX_MODELS).toContain(m);
    }
  });

  it('adds the GPT-5.6 family from the 0.145.0 model cache', () => {
    for (const m of added) {
      expect(CODEX_MODELS).toContain(m);
      expect(isCodexModel(m)).toBe(true);
    }
  });

  it('drops every model removed from the live CLI cache', () => {
    for (const m of removed) {
      expect(CODEX_MODELS).not.toContain(m);
      expect(isCodexModel(m)).toBe(false);
    }
  });

  it('rejects unknown ids', () => {
    expect(isCodexModel('gpt-9000')).toBe(false);
  });

  it('rejects the bare gpt-5.6 alias — API-only, deliberately absent', () => {
    expect(isCodexModel('gpt-5.6')).toBe(false);
  });
});

describe('settings-models / copilot catalog', () => {
  // Reconciled to GitHub's official supported-models doc (as of 2026-08-18).
  const official = [
    // OpenAI
    'gpt-5-mini',
    'gpt-5.3-codex',
    'gpt-5.4',
    'gpt-5.4-mini',
    'gpt-5.4-nano',
    'gpt-5.5',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-5.6-luna',
    // Anthropic
    'claude-haiku-4.5',
    'claude-opus-4.5',
    'claude-opus-4.6',
    'claude-opus-4.7',
    'claude-opus-4.8',
    'claude-opus-4.8-fast',
    'claude-opus-5',
    'claude-fable-5',
    'claude-sonnet-4.5',
    'claude-sonnet-4.6',
    'claude-sonnet-5',
    // Google
    'gemini-3.1-pro',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    // Microsoft
    'mai-code-1-flash',
    'mai-code-1.1-flash',
    // Moonshot
    'kimi-k2.7-code',
    'kimi-k3',
    // xAI
    'grok-4.5',
    'grok-4.6',
    // Fine-tuned
    'raptor-mini',
  ] as const;

  // Landed in the 2026-08-18 reconciliation — all convention-derived from the doc's display names.
  const added = [
    'gemini-3.7-flash',
    'mai-code-1.1-flash',
    'kimi-k3',
    'grok-4.5',
    'grok-4.6',
    'gemini-3.1-pro',
    'raptor-mini',
  ] as const;

  // De-listed by GitHub — must no longer appear in the static catalog. The last four went in the
  // 2026-08-18 pass: two preview graduations that renamed the derived slug, two outright
  // delistings. All are remapped for persisted settings (see `RETIRED_MODEL_REMAPS`).
  const removed = [
    'gpt-5.1',
    'gpt-5.2',
    'gpt-5.2-codex',
    'gpt-5.1-codex-max',
    'gpt-5.1-codex',
    'gpt-5.1-codex-mini',
    'gpt-4.1',
    'claude-sonnet-4',
    'gemini-3-pro-preview',
    'gemini-3-flash-preview',
    'claude-opus-4.6-fast',
    'gemini-3.1-pro-preview',
    'raptor-mini-preview',
    'gemini-2.5-pro',
    'gemini-3-flash',
  ] as const;

  it('contains exactly the official supported-models list', () => {
    expect([...COPILOT_MODELS]).toEqual([...official]);
  });

  it('recognizes every official id', () => {
    for (const m of official) {
      expect(isCopilotModel(m)).toBe(true);
    }
  });

  it('adds the 2026-08-18 entries, including the first xAI models', () => {
    for (const m of added) {
      expect(COPILOT_MODELS).toContain(m);
      expect(isCopilotModel(m)).toBe(true);
    }
  });

  it('drops every de-listed id', () => {
    for (const m of removed) {
      expect(COPILOT_MODELS).not.toContain(m);
      expect(isCopilotModel(m)).toBe(false);
    }
  });

  it('rejects unknown ids', () => {
    expect(isCopilotModel('claude-opus-9')).toBe(false);
  });
});
