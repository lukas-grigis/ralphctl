import { describe, expect, it } from 'vitest';
import { parseImplementRoleOverrides } from '@src/application/ui/cli/parse-implement-role-overrides.ts';

/**
 * Covers AC2 of the per-role implement wiring: the bare `ralphctl` CLI must reject a
 * half-supplied `{provider, model}` pair for either role with a message naming the matching
 * flag, rather than silently falling back to the persisted settings row.
 */
describe('parseImplementRoleOverrides', () => {
  it('returns undefined overrides when no flags are supplied', () => {
    const result = parseImplementRoleOverrides({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overrides).toBeUndefined();
  });

  it('accepts a fully-formed generator pair', () => {
    const result = parseImplementRoleOverrides({
      generatorProvider: 'claude-code',
      generatorModel: 'claude-opus-4-7',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overrides).toEqual({
      generator: { provider: 'claude-code', model: 'claude-opus-4-7' },
    });
  });

  it('accepts a fully-formed evaluator pair only (generator stays on persisted row)', () => {
    const result = parseImplementRoleOverrides({
      evaluatorProvider: 'openai-codex',
      evaluatorModel: 'gpt-5.5',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overrides).toEqual({
      evaluator: { provider: 'openai-codex', model: 'gpt-5.5' },
    });
  });

  it('rejects generator-provider without generator-model and names the missing flag', () => {
    const result = parseImplementRoleOverrides({ generatorProvider: 'claude-code' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('--implement-generator-provider');
    expect(result.error).toContain('--implement-generator-model');
  });

  it('rejects generator-model without generator-provider and names the missing flag', () => {
    const result = parseImplementRoleOverrides({ generatorModel: 'claude-opus-4-7' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('--implement-generator-model');
    expect(result.error).toContain('--implement-generator-provider');
  });

  it('rejects evaluator-provider without evaluator-model and names the missing flag', () => {
    const result = parseImplementRoleOverrides({ evaluatorProvider: 'openai-codex' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('--implement-evaluator-provider');
    expect(result.error).toContain('--implement-evaluator-model');
  });

  it('rejects evaluator-model without evaluator-provider and names the missing flag', () => {
    const result = parseImplementRoleOverrides({ evaluatorModel: 'gpt-5.5' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('--implement-evaluator-model');
    expect(result.error).toContain('--implement-evaluator-provider');
  });

  it('rejects an unsupported provider value with a focused message naming the allowed set', () => {
    const result = parseImplementRoleOverrides({
      generatorProvider: 'not-a-provider',
      generatorModel: 'whatever',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('not-a-provider');
    expect(result.error).toContain('claude-code');
    expect(result.error).toContain('github-copilot');
    expect(result.error).toContain('openai-codex');
  });

  it('rejects an empty model string', () => {
    const result = parseImplementRoleOverrides({
      generatorProvider: 'claude-code',
      generatorModel: '   ',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('--implement-generator-model');
  });

  it('accepts independent generator + evaluator pairs targeting different providers', () => {
    const result = parseImplementRoleOverrides({
      generatorProvider: 'claude-code',
      generatorModel: 'claude-opus-4-7',
      evaluatorProvider: 'openai-codex',
      evaluatorModel: 'gpt-5.5',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overrides).toEqual({
      generator: { provider: 'claude-code', model: 'claude-opus-4-7' },
      evaluator: { provider: 'openai-codex', model: 'gpt-5.5' },
    });
  });
});
