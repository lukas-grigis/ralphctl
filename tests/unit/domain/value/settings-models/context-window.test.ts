/**
 * Unit tests for the domain context-window helper. Pins the mapping and formatting so any
 * model-catalog change that forgets to update this table fails here rather than silently
 * displaying a wrong label in the TUI.
 */

import { describe, expect, it } from 'vitest';
import { contextWindowFor, contextWindowLabel } from '@src/domain/value/settings-models/context-window.ts';

describe('contextWindowFor', () => {
  it('returns 200_000 for the standard 200K Claude models', () => {
    expect(contextWindowFor('claude-haiku-4-5')).toBe(200_000);
    expect(contextWindowFor('claude-sonnet-4-6')).toBe(200_000);
    expect(contextWindowFor('claude-opus-4-8')).toBe(200_000);
  });

  it('returns 1_000_000 for [1m] long-context variants', () => {
    expect(contextWindowFor('claude-opus-4-8[1m]')).toBe(1_000_000);
    expect(contextWindowFor('claude-fable-5[1m]')).toBe(1_000_000);
  });

  it('returns 1_000_000 for the bare claude-sonnet-5 id (native 1M, no [1m] selector)', () => {
    // Sonnet 5 always runs at its native 1M window on the Anthropic API — the only base id (not a
    // `[1m]` variant) that carries a 1M window.
    expect(contextWindowFor('claude-sonnet-5')).toBe(1_000_000);
  });

  it('returns undefined for models whose window size is not published', () => {
    // Copilot / Codex ids — omitted by scope discipline.
    expect(contextWindowFor('gpt-5.5')).toBeUndefined();
    expect(contextWindowFor('claude-haiku-4.5')).toBeUndefined(); // Copilot-routed variant (different id)
  });

  it('returns undefined for a custom or unknown id', () => {
    expect(contextWindowFor('my-custom-model')).toBeUndefined();
    expect(contextWindowFor('')).toBeUndefined();
  });

  it('returns undefined when model is undefined', () => {
    expect(contextWindowFor(undefined)).toBeUndefined();
  });
});

describe('contextWindowLabel', () => {
  it('formats 200K models as "200K"', () => {
    expect(contextWindowLabel('claude-sonnet-4-6')).toBe('200K');
    expect(contextWindowLabel('claude-haiku-4-5')).toBe('200K');
    expect(contextWindowLabel('claude-opus-4-8')).toBe('200K');
  });

  it('formats 1M models as "1M" (not "1000k")', () => {
    expect(contextWindowLabel('claude-opus-4-8[1m]')).toBe('1M');
    expect(contextWindowLabel('claude-fable-5[1m]')).toBe('1M');
    expect(contextWindowLabel('claude-sonnet-5')).toBe('1M');
  });

  it('returns undefined for models with no published window size', () => {
    expect(contextWindowLabel('gpt-5.5')).toBeUndefined();
  });

  it('returns undefined when model is undefined', () => {
    expect(contextWindowLabel(undefined)).toBeUndefined();
  });
});
