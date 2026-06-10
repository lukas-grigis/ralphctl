/**
 * Claude + Copilot model-availability probes are passthrough for v1 — they return the supplied
 * catalog reference unchanged. (Copilot upgrades to the real models API in v2; see the adapter's
 * TODO.) Asserting reference equality proves the probe neither filters nor copies the catalog.
 */

import { describe, expect, it } from 'vitest';
import { claudeModelAvailabilityProbe } from '@src/integration/ai/providers/claude/model-availability-probe.ts';
import { copilotModelAvailabilityProbe } from '@src/integration/ai/providers/copilot/model-availability-probe.ts';
import { CLAUDE_MODELS } from '@src/domain/value/settings-models/claude.ts';
import { COPILOT_MODELS } from '@src/domain/value/settings-models/copilot.ts';

describe('claudeModelAvailabilityProbe (passthrough)', () => {
  it('returns the same catalog reference', async () => {
    const available = await claudeModelAvailabilityProbe.availableModels(CLAUDE_MODELS);
    expect(available).toBe(CLAUDE_MODELS);
  });
});

describe('copilotModelAvailabilityProbe (passthrough)', () => {
  it('returns the same catalog reference', async () => {
    const available = await copilotModelAvailabilityProbe.availableModels(COPILOT_MODELS);
    expect(available).toBe(COPILOT_MODELS);
  });
});
