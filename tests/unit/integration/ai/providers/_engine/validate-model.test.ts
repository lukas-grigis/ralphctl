import { describe, expect, it, vi } from 'vitest';

// `SUSPENDED_MODELS` is empty in the shipped catalog (see suspended-models.ts) — the mechanism
// is deliberately kept wired for the next incident, so the only way to exercise the suspended
// branch is to mock the module. `isKnownModel` stays real per-call; only suspension is faked.
vi.mock('@src/domain/value/settings-models/suspended-models.ts', () => ({
  isSuspendedModel: (s: string) => s === 'suspended-model',
  suspendedModelMessage: (m: string) =>
    `'${m}' is temporarily suspended by its provider — pick another model until access is restored`,
}));

const { validateModel } = await import('@src/integration/ai/providers/_engine/validate-model.ts');

describe('validateModel', () => {
  const isKnown = (s: string): boolean => s === 'known-model' || s === 'suspended-model';

  it('returns ok for a catalog-known, non-suspended model', () => {
    const result = validateModel('known-model', isKnown, {
      entity: 'test-provider',
      attemptedAction: 'build argv',
      notKnownMessage: 'not known',
    });
    expect(result.ok).toBe(true);
  });

  it('returns InvalidStateError (currentState model-validation) for an unknown model, using the caller-supplied message', () => {
    const result = validateModel('typo-model', isKnown, {
      entity: 'test-provider',
      attemptedAction: 'build argv',
      notKnownMessage: "test-provider: 'typo-model' is not a known model",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-state');
    expect(result.error.currentState).toBe('model-validation');
    expect(result.error.entity).toBe('test-provider');
    expect(result.error.message).toBe("test-provider: 'typo-model' is not a known model");
  });

  it('returns InvalidStateError (currentState model-suspended) for a catalog-known but suspended model', () => {
    const result = validateModel('suspended-model', isKnown, {
      entity: 'test-provider',
      attemptedAction: 'run',
      notKnownMessage: 'not known',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-state');
    expect(result.error.currentState).toBe('model-suspended');
    expect(result.error.message).toContain('temporarily suspended');
  });

  it('checks catalog membership BEFORE suspension — an unknown model never reaches the suspension check', () => {
    // 'unknown-and-not-in-catalog' is neither known nor in the mocked suspended set, so this
    // only proves ordering when combined with the next assertion's shared predicate; the real
    // guard here is that a model failing isKnownModel always surfaces model-validation, never
    // model-suspended, even if it happened to also be suspended.
    const result = validateModel('suspended-model', () => false, {
      entity: 'test-provider',
      attemptedAction: 'run',
      notKnownMessage: 'not known',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.currentState).toBe('model-validation');
  });
});
