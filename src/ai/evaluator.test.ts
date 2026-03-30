import { describe, expect, it } from 'vitest';
import { getEvaluatorModel, parseEvaluationResult } from './evaluator.ts';
import type { ProviderAdapter } from '@src/providers/types.ts';

// ============================================================================
// Minimal provider stubs
// ============================================================================

const claudeProvider: ProviderAdapter = {
  name: 'claude',
  displayName: 'Claude',
  binary: 'claude',
  baseArgs: [],
  experimental: false,
  buildInteractiveArgs: () => [],
  buildHeadlessArgs: () => [],
  parseJsonOutput: () => ({ result: '', sessionId: null, model: null }),
  buildResumeArgs: () => [],
  detectRateLimit: () => ({ rateLimited: false, retryAfterMs: null }),
  getSpawnEnv: () => ({}),
};

const copilotProvider: ProviderAdapter = {
  ...claudeProvider,
  name: 'copilot',
  displayName: 'Copilot',
  binary: 'copilot',
  experimental: true,
};

// ============================================================================
// parseEvaluationResult
// ============================================================================

describe('parseEvaluationResult', () => {
  it('returns passed=true for <evaluation-passed> signal', () => {
    const output = '<evaluation-passed>';
    const result = parseEvaluationResult(output);
    expect(result.passed).toBe(true);
    expect(result.output).toContain('<evaluation-passed>');
  });

  it('returns passed=false for <evaluation-failed> signal with critique', () => {
    const critique = 'Missing error handling in main function';
    const output = `<evaluation-failed>${critique}</evaluation-failed>`;
    const result = parseEvaluationResult(output);
    expect(result.passed).toBe(false);
    expect(result.output).toBe(critique);
  });

  it('extracts critique text from failed signal embedded in surrounding context', () => {
    const critique = 'Line 42: Off-by-one error in loop';
    const output = `Some context\n<evaluation-failed>${critique}</evaluation-failed>\nMore context`;
    const result = parseEvaluationResult(output);
    expect(result.output).toBe(critique);
  });

  it('handles multiline critique in failed signal', () => {
    const critique = `Issue 1: Missing validation\nIssue 2: Unhandled edge case`;
    const output = `<evaluation-failed>${critique}</evaluation-failed>`;
    const result = parseEvaluationResult(output);
    expect(result.output).toContain('Issue 1');
    expect(result.output).toContain('Issue 2');
  });

  it('returns passed=false with original output when no signal found', () => {
    const output = 'Random AI output with no signals';
    const result = parseEvaluationResult(output);
    expect(result.passed).toBe(false);
    expect(result.output).toBe(output);
  });

  it('evaluation-passed takes precedence when both signals are present', () => {
    const output = '<evaluation-passed>\n<evaluation-failed>this should not matter</evaluation-failed>';
    const result = parseEvaluationResult(output);
    expect(result.passed).toBe(true);
  });

  it('handles empty critique text in failed signal', () => {
    const output = '<evaluation-failed></evaluation-failed>';
    const result = parseEvaluationResult(output);
    expect(result.passed).toBe(false);
    expect(result.output).toBe('');
  });

  it('trims whitespace from critique extracted from failed signal', () => {
    const output = '<evaluation-failed>  leading and trailing spaces  </evaluation-failed>';
    const result = parseEvaluationResult(output);
    expect(result.output).toBe('leading and trailing spaces');
  });

  it('handles evaluation-passed with surrounding prose', () => {
    const output = 'I reviewed the code.\n<evaluation-passed>\nLooks good overall.';
    const result = parseEvaluationResult(output);
    expect(result.passed).toBe(true);
  });
});

// ============================================================================
// getEvaluatorModel
// ============================================================================

describe('getEvaluatorModel', () => {
  describe('Claude provider', () => {
    it('returns Sonnet for Opus generator model', () => {
      const model = getEvaluatorModel('claude-opus-4-1', claudeProvider);
      expect(model).toBe('claude-sonnet-4-6');
    });

    it('returns Sonnet for model name with OPUS in any case', () => {
      const model = getEvaluatorModel('CLAUDE-OPUS-SOMETHING', claudeProvider);
      expect(model).toBe('claude-sonnet-4-6');
    });

    it('returns Haiku for Sonnet generator model', () => {
      const model = getEvaluatorModel('claude-sonnet-4-6', claudeProvider);
      expect(model).toBe('claude-haiku-4-5');
    });

    it('returns Haiku for Haiku generator model', () => {
      const model = getEvaluatorModel('claude-haiku-4-5', claudeProvider);
      expect(model).toBe('claude-haiku-4-5');
    });

    it('returns Haiku for unknown model names', () => {
      const model = getEvaluatorModel('some-unknown-model', claudeProvider);
      expect(model).toBe('claude-haiku-4-5');
    });

    it('returns null when generator model is null', () => {
      const model = getEvaluatorModel(null, claudeProvider);
      expect(model).toBeNull();
    });
  });

  describe('Copilot provider', () => {
    it('returns null regardless of model name', () => {
      const model = getEvaluatorModel('gpt-4', copilotProvider);
      expect(model).toBeNull();
    });

    it('returns null even when model name contains opus', () => {
      const model = getEvaluatorModel('claude-opus-4-1', copilotProvider);
      expect(model).toBeNull();
    });

    it('returns null when generator model is null', () => {
      const model = getEvaluatorModel(null, copilotProvider);
      expect(model).toBeNull();
    });
  });
});
