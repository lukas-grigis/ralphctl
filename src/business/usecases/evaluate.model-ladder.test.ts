/**
 * Unit tests for the evaluator's model-ladder mapping.
 *
 * The ladder is intentionally a version-agnostic prefix match — any Opus
 * (4.5, 4.6, 4.7, or a future 4.x) cascades to Sonnet, any Sonnet cascades
 * to Haiku, and Haiku stays on Haiku. These tests pin that behaviour so a
 * future model-ID change (adding 4.8, renaming the Haiku target, etc.)
 * can't silently break the cascade.
 */

import { describe, expect, it } from 'vitest';
import { getEvaluatorModel } from './evaluate.ts';

describe('getEvaluatorModel', () => {
  describe('claude provider', () => {
    it('Opus 4.5 → claude-sonnet-4-6', () => {
      expect(getEvaluatorModel('claude-opus-4-5', 'claude')).toBe('claude-sonnet-4-6');
    });

    it('Opus 4.6 → claude-sonnet-4-6', () => {
      expect(getEvaluatorModel('claude-opus-4-6', 'claude')).toBe('claude-sonnet-4-6');
    });

    it('Opus 4.7 → claude-sonnet-4-6', () => {
      expect(getEvaluatorModel('claude-opus-4-7', 'claude')).toBe('claude-sonnet-4-6');
    });

    it('Sonnet 4.6 → claude-haiku-4-5', () => {
      expect(getEvaluatorModel('claude-sonnet-4-6', 'claude')).toBe('claude-haiku-4-5');
    });

    it('Haiku 4.5 → claude-haiku-4-5 (stays at bottom of ladder)', () => {
      expect(getEvaluatorModel('claude-haiku-4-5', 'claude')).toBe('claude-haiku-4-5');
    });

    it('is case-insensitive on the generator model string', () => {
      expect(getEvaluatorModel('CLAUDE-OPUS-4-7', 'claude')).toBe('claude-sonnet-4-6');
    });

    it('unknown model string falls back to Haiku (safe default)', () => {
      expect(getEvaluatorModel('gpt-9', 'claude')).toBe('claude-haiku-4-5');
    });

    it('null generator model → null (nothing to cascade from)', () => {
      expect(getEvaluatorModel(null, 'claude')).toBeNull();
    });
  });

  describe('non-claude providers', () => {
    it('copilot returns null regardless of input (no model control)', () => {
      expect(getEvaluatorModel('claude-opus-4-7', 'copilot')).toBeNull();
      expect(getEvaluatorModel(null, 'copilot')).toBeNull();
    });
  });
});
