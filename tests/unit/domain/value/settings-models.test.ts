import { describe, expect, it } from 'vitest';
import { RETIRED_MODEL_REMAPS, type AiProvider } from '@src/domain/entity/settings.ts';
import { CLAUDE_MODELS, isClaudeModel } from '@src/domain/value/settings-models/claude.ts';
import { CODEX_MODELS, isCodexModel } from '@src/domain/value/settings-models/codex.ts';
import { COPILOT_MODELS, isCopilotModel } from '@src/domain/value/settings-models/copilot.ts';
import { GROK_MODELS } from '@src/domain/value/settings-models/grok.ts';
import { OPENCODE_MODELS, isOpencodeModel } from '@src/domain/value/settings-models/opencode.ts';

describe('settings-models / claude catalog', () => {
  it('adds Opus 5.5 and Fable 5.1 (Claude Code 2.1.280, 2026-09-22) without dropping pinned ids', () => {
    for (const m of ['claude-opus-5-5', 'claude-fable-5-1', 'claude-opus-5', 'claude-fable-5', 'claude-opus-4-8']) {
      expect(isClaudeModel(m), m).toBe(true);
    }
  });

  it('does not catalog a [1m] variant for the natively-1M Opus 5.5 / Fable 5.1', () => {
    expect(CLAUDE_MODELS).not.toContain('claude-opus-5-5[1m]');
    expect(CLAUDE_MODELS).not.toContain('claude-fable-5-1[1m]');
  });
});

describe('settings-models / codex catalog', () => {
  // Verified against the live CLI model cache (codex CLI v0.155.1, 2026-09-22).
  const kept = ['gpt-5.5', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'codex-auto-review'] as const;
  const added = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna'] as const;
  // Gone from the codex CLI entirely — persisted rows are remapped at parse time.
  const removed = ['gpt-5.2', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.4', 'gpt-5.4-mini'] as const;

  it('keeps the still-served entries plus the synthetic review id', () => {
    for (const m of kept) {
      expect(CODEX_MODELS).toContain(m);
    }
  });

  it('adds the GPT-6 family from the 0.155.1 model cache', () => {
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
  // Reconciled to GitHub's supported-models doc + changelog (as of 2026-09-22).
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
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-luna',
    // Anthropic
    'claude-haiku-4.5',
    'claude-opus-4.7',
    'claude-opus-4.8',
    'claude-opus-4.8-fast',
    'claude-opus-5',
    'claude-opus-5.5',
    'claude-fable-5',
    'claude-fable-5.1',
    'claude-sonnet-5',
    // Google
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash',
    // Microsoft
    'mai-code-1.1-flash',
    // Moonshot
    'kimi-k2.7-code',
    'kimi-k3',
    // xAI
    'grok-4.5',
    'grok-4.6',
    'grok-4.7',
  ] as const;

  // New in the 2026-09 GitHub changelog.
  const added = [
    'claude-opus-5.5',
    'claude-fable-5.1',
    'gpt-6-astra',
    'gpt-6-sol',
    'gpt-6-luna',
    'gemini-3.8-flash',
    'grok-4.7',
  ] as const;

  // De-listed or deprecated by GitHub — must no longer appear in the static catalog. All the
  // recent ones are remapped for persisted settings (see `RETIRED_MODEL_REMAPS`).
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
    // 2026-09-01 deprecation, plus the superseded mai-code-1-flash.
    'claude-opus-4.5',
    'claude-opus-4.6',
    'claude-sonnet-4.5',
    'claude-sonnet-4.6',
    'gemini-3.1-pro',
    'raptor-mini',
    'mai-code-1-flash',
  ] as const;

  it('contains exactly the official supported-models list', () => {
    expect([...COPILOT_MODELS]).toEqual([...official]);
  });

  it('recognizes every official id', () => {
    for (const m of official) {
      expect(isCopilotModel(m)).toBe(true);
    }
  });

  it('adds the 2026-09 entries', () => {
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

describe('settings-models / opencode catalog', () => {
  // Verified against `opencode models` on opencode-ai v1.18.32 (2026-09-22).
  it('drops the free-tier ids that left the live listing and adds the new ones', () => {
    for (const gone of [
      'opencode/deepseek-v4-flash-free',
      'opencode/laguna-s-2.1-free',
      'opencode/ling-3.0-tiny-free',
      'opencode/longcat-2.0-free',
      'opencode/north-mini-code-free',
    ]) {
      expect(isOpencodeModel(gone), gone).toBe(false);
    }
    for (const added of [
      'opencode/hy3-free',
      'opencode/ling-3.0-flash-fin-free',
      'opencode/muse-spark-1.2-contributor-free',
      'opencode/nemotron-3.5-lightning-free',
    ]) {
      expect(isOpencodeModel(added), added).toBe(true);
    }
  });
});

describe('RETIRED_MODEL_REMAPS — every remap lands on a live model in one hop', () => {
  const catalogFor: Readonly<Record<AiProvider, readonly string[]>> = {
    'claude-code': CLAUDE_MODELS,
    'github-copilot': COPILOT_MODELS,
    'openai-codex': CODEX_MODELS,
    opencode: OPENCODE_MODELS,
    'xai-grok': GROK_MODELS,
  };

  it('every target is a member of its own provider catalog', () => {
    for (const { provider, from, to } of RETIRED_MODEL_REMAPS) {
      expect(catalogFor[provider], `${provider}: ${from} → ${to}`).toContain(to);
    }
  });

  it('no source is still a live catalog id (a live id must never be silently rewritten)', () => {
    for (const { provider, from } of RETIRED_MODEL_REMAPS) {
      expect(catalogFor[provider], `${provider}: ${from}`).not.toContain(from);
    }
  });

  it('no target is itself a remap source for the same provider (chain-collapsed)', () => {
    for (const { provider, to } of RETIRED_MODEL_REMAPS) {
      const chained = RETIRED_MODEL_REMAPS.some((r) => r.provider === provider && r.from === to);
      expect(chained, `${provider}: ${to} is remapped again`).toBe(false);
    }
  });
});
