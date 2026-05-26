/**
 * Supplemental unit tests for apply-key.ts — covers branches not reached by
 * the main apply-key.test.ts file.
 *
 * Specific gaps:
 *   - Lines 142-144: `ai.effort` cleared with empty string (clears the global effort key)
 *   - Lines 201-205: `concurrency.maxParallelTasks` rejects non-numeric values
 *   - Additional flows: harness.maxAttempts, harness.rateLimitRetries, harness.plateauThreshold
 *     numeric validation (same switch arm as maxTurns, but each branch needs at least one hit)
 *   - `ai.implement.generator.provider` unknown provider rejected
 *   - `ai.implement.evaluator.effort` cleared with empty string
 */

import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { DEFAULT_SETTINGS } from '@src/business/settings/defaults.ts';
import { applySettingsKey } from '@src/business/settings/apply-key.ts';

describe('applySettingsKey — ai.effort global key', () => {
  it('clears the global ai.effort when given an empty string (lines 142-144)', () => {
    // Arrange: seed a global effort first
    const seeded = applySettingsKey(DEFAULT_SETTINGS, 'ai.effort', 'high');
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;

    // Act: clear it
    const cleared = applySettingsKey(seeded.value, 'ai.effort', '');
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.value.ai.effort).toBeUndefined();
    }
  });

  it('sets the global ai.effort to a trimmed value', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.effort', '  high  ');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ai.effort).toBe('high');
  });
});

describe('applySettingsKey — concurrency.maxParallelTasks (lines 201-205)', () => {
  it('rejects a non-numeric value with a "not a number" error', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'concurrency.maxParallelTasks', 'unlimited');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.message).toContain('not a number');
    }
  });

  it('rejects NaN string', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'concurrency.maxParallelTasks', 'NaN');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('not a number');
  });

  it('accepts a numeric string and stores it as a number', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'concurrency.maxParallelTasks', '4');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.concurrency.maxParallelTasks).toBe(4);
  });
});

describe('applySettingsKey — harness numeric keys (shared switch arm)', () => {
  it('updates harness.maxAttempts numerically', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'harness.maxAttempts', '5');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.harness.maxAttempts).toBe(5);
  });

  it('updates harness.rateLimitRetries numerically', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'harness.rateLimitRetries', '3');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.harness.rateLimitRetries).toBe(3);
  });

  it('updates harness.plateauThreshold numerically', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'harness.plateauThreshold', '4');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.harness.plateauThreshold).toBe(4);
  });

  it('rejects a non-numeric value for harness.maxAttempts', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'harness.maxAttempts', 'many');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('not a number');
  });

  it('rejects a non-numeric value for harness.rateLimitRetries', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'harness.rateLimitRetries', 'lots');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('not a number');
  });

  it('rejects a non-numeric value for harness.plateauThreshold', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'harness.plateauThreshold', 'auto');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('not a number');
  });
});

describe('applySettingsKey — ai.implement role fields', () => {
  it('rejects an unknown provider for ai.implement.generator.provider', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.implement.generator.provider', 'unknown-llm');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ValidationError);
      expect(result.error.message).toContain('not a recognised provider');
    }
  });

  it('rejects an unknown provider for ai.implement.evaluator.provider', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.implement.evaluator.provider', 'another-llm');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('not a recognised provider');
  });

  it('clears ai.implement.generator.effort when given empty string', () => {
    const seeded = applySettingsKey(DEFAULT_SETTINGS, 'ai.implement.generator.effort', 'high');
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;

    const cleared = applySettingsKey(seeded.value, 'ai.implement.generator.effort', '');
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.value.ai.implement.generator.effort).toBeUndefined();
    }
  });

  it('rejects a 4-part ai.implement key with an unknown role', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.implement.executor.model', 'some-model');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('unknown settings key');
  });

  it('rejects a 4-part ai.implement key with an unknown field', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.implement.generator.temperature', '0.7');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('unknown settings key');
  });
});

describe('applySettingsKey — non-implement flow edge cases', () => {
  it('rejects ai.ideate.provider with an unknown value', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.ideate.provider', 'not-valid');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('not a recognised provider');
  });

  it('clears ai.readiness.effort with empty string', () => {
    const seeded = applySettingsKey(DEFAULT_SETTINGS, 'ai.readiness.effort', 'low');
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) return;

    const cleared = applySettingsKey(seeded.value, 'ai.readiness.effort', '');
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.value.ai.readiness.effort).toBeUndefined();
  });

  it('rejects ai.refine.unknown_field (3-part key with non-provider/model/effort field)', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.refine.temperature', '0.8');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('unknown settings key');
  });

  it('rejects an ai key with only two parts (ai.<flow> without field)', () => {
    const result = applySettingsKey(DEFAULT_SETTINGS, 'ai.refine', 'claude-code');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('unknown settings key');
  });
});
