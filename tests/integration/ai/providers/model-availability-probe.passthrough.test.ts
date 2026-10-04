/**
 * Claude + Grok model-availability probes are passthrough — they return the supplied catalog
 * reference unchanged. Asserting reference equality proves the probe neither filters nor copies it.
 */

import { describe, expect, it } from 'vitest';
import { claudeModelAvailabilityProbe } from '@src/integration/ai/providers/claude/model-availability-probe.ts';
import { grokModelAvailabilityProbe } from '@src/integration/ai/providers/grok/model-availability-probe.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { GROK_MODELS } from '@src/domain/value/settings-models/grok.ts';

describe('claudeModelAvailabilityProbe (passthrough)', () => {
  it('returns the same catalog reference', async () => {
    const available = await claudeModelAvailabilityProbe.availableModels(CLAUDE_MODELS);
    expect(available).toBe(CLAUDE_MODELS);
  });
});

describe('grokModelAvailabilityProbe (passthrough)', () => {
  it('returns the same catalog reference', async () => {
    const available = await grokModelAvailabilityProbe.availableModels(GROK_MODELS);
    expect(available).toBe(GROK_MODELS);
  });
});
