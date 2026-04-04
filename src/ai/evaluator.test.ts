import { describe, expect, it } from 'vitest';
import { buildEvaluatorContext, getEvaluatorModel, parseDimensionScores, parseEvaluationResult } from './evaluator.ts';
import type { ProviderAdapter } from '@src/providers/types.ts';
import type { Task } from '@src/schemas/index.ts';

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

describe('parseDimensionScores', () => {
  it('parses all four dimensions from well-formed output', () => {
    const output = [
      '## Assessment',
      '',
      '**Correctness**: PASS — All criteria verified',
      '**Completeness**: PASS — All steps implemented',
      '**Safety**: PASS — No vulnerabilities found',
      '**Consistency**: FAIL — Uses snake_case instead of camelCase',
    ].join('\n');

    const scores = parseDimensionScores(output);
    expect(scores).toHaveLength(4);
    expect(scores[0]).toMatchObject({ dimension: 'correctness', passed: true, finding: 'All criteria verified' });
    expect(scores[3]).toMatchObject({
      dimension: 'consistency',
      passed: false,
      finding: 'Uses snake_case instead of camelCase',
    });
  });

  it('returns empty array when no dimension lines are present', () => {
    const scores = parseDimensionScores('Some random output with no dimensions');
    expect(scores).toEqual([]);
  });

  it('handles partial dimension output (only some dimensions present)', () => {
    const output = '**Correctness**: PASS — Looks good\n**Safety**: FAIL — SQL injection at line 42';
    const scores = parseDimensionScores(output);
    expect(scores).toHaveLength(2);
    expect(scores[0]).toMatchObject({ dimension: 'correctness' });
    expect(scores[1]).toMatchObject({ dimension: 'safety' });
  });

  it('is case-insensitive for PASS/FAIL', () => {
    const output = '**Correctness**: pass — ok\n**Safety**: Fail — issue';
    const scores = parseDimensionScores(output);
    expect(scores[0]).toMatchObject({ passed: true });
    expect(scores[1]).toMatchObject({ passed: false });
  });

  it('handles hyphen instead of em-dash as separator', () => {
    const output = '**Correctness**: PASS - All good';
    const scores = parseDimensionScores(output);
    expect(scores).toHaveLength(1);
    expect(scores[0]).toMatchObject({ finding: 'All good' });
  });
});

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

  it('includes dimension scores when present in output', () => {
    const output = [
      '## Assessment',
      '**Correctness**: PASS — All good',
      '**Completeness**: PASS — Done',
      '**Safety**: PASS — Secure',
      '**Consistency**: PASS — Follows patterns',
      '<evaluation-passed>',
    ].join('\n');

    const result = parseEvaluationResult(output);
    expect(result.passed).toBe(true);
    expect(result.dimensions).toHaveLength(4);
    expect(result.dimensions.every((d) => d.passed)).toBe(true);
  });

  it('includes dimension scores in failed evaluation', () => {
    const output = [
      '**Correctness**: FAIL — Off-by-one in loop',
      '**Completeness**: PASS — All steps done',
      '**Safety**: PASS — No issues',
      '**Consistency**: PASS — Follows patterns',
      '<evaluation-failed>Off-by-one error at line 42</evaluation-failed>',
    ].join('\n');

    const result = parseEvaluationResult(output);
    expect(result.passed).toBe(false);
    expect(result.dimensions).toHaveLength(4);
    expect(result.dimensions[0]).toMatchObject({ passed: false });
  });

  it('returns empty dimensions array when no dimension lines present', () => {
    const output = '<evaluation-passed>';
    const result = parseEvaluationResult(output);
    expect(result.dimensions).toEqual([]);
  });
});

// ============================================================================
// buildEvaluatorContext
// ============================================================================

describe('buildEvaluatorContext', () => {
  const baseTask: Task = {
    id: 'task-1',
    name: 'Add user auth',
    description: 'Implement authentication',
    steps: ['Create auth service', 'Add tests'],
    verificationCriteria: [],
    status: 'done',
    order: 1,
    blockedBy: [],
    projectPath: '/home/user/project',
    verified: false,
    evaluated: false,
  };

  it('includes verificationCriteria when non-empty', () => {
    const task: Task = {
      ...baseTask,
      verificationCriteria: ['TypeScript compiles', 'Tests pass'],
    };
    const ctx = buildEvaluatorContext(task, null);
    expect(ctx.verificationCriteria).toEqual(['TypeScript compiles', 'Tests pass']);
  });

  it('returns empty verificationCriteria when task has none', () => {
    const ctx = buildEvaluatorContext(baseTask, null);
    expect(ctx.verificationCriteria).toEqual([]);
  });

  it('includes check script section with computational gate framing when provided', () => {
    const ctx = buildEvaluatorContext(baseTask, 'pnpm test');
    expect(ctx.checkScriptSection).toContain('pnpm test');
    expect(ctx.checkScriptSection).toContain('Computational Gate');
  });

  it('sets checkScriptSection to null when no script', () => {
    const ctx = buildEvaluatorContext(baseTask, null);
    expect(ctx.checkScriptSection).toBeNull();
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
