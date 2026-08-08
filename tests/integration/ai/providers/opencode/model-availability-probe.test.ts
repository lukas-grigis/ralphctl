/**
 * OpenCode model-availability probe — shells out to `opencode models` and returns the CLI's own
 * list rather than a filtered subset of the catalog (the aggregator widening of the
 * `ModelAvailabilityProbe` contract). Every error path fails open to `catalog`. Tests inject the
 * whole spawn via the `listModels` seam, so no binary is required.
 */

import { describe, expect, it } from 'vitest';
import { createOpencodeModelAvailabilityProbe } from '@src/integration/ai/providers/opencode/model-availability-probe.ts';
import { OPENCODE_MODELS } from '@src/domain/value/settings-models/opencode.ts';

const probeWith = (listModels: (command: string, signal?: AbortSignal) => Promise<readonly string[]>) =>
  createOpencodeModelAvailabilityProbe({ listModels });

describe('createOpencodeModelAvailabilityProbe', () => {
  it('keeps multi-segment aggregator ids and drops whitespace-bearing junk lines', async () => {
    // `openrouter/microsoft/phi-4` has three segments — the CLI prints `${providerID}/${modelID}`
    // verbatim and many aggregator keys carry their own slash. A banner line has whitespace, so
    // the anchored filter rejects the whole line.
    const probe = probeWith(() =>
      Promise.resolve(['openrouter/microsoft/phi-4', 'opencode/big-pickle', 'Available models:'])
    );
    const available = await probe.availableModels(OPENCODE_MODELS);
    expect(available).toEqual(['openrouter/microsoft/phi-4', 'opencode/big-pickle']);
  });

  it('drops bare unnamespaced ids the adapter would refuse to run', async () => {
    // The filter is the adapter's own `isOpencodeModelIdShape`, so anything admitted here is
    // runnable — a bare `gpt-5.5` would fail argv validation and become an un-runnable entry.
    const probe = probeWith(() => Promise.resolve(['gpt-5.5', 'opencode/big-pickle']));
    expect(await probe.availableModels(OPENCODE_MODELS)).toEqual(['opencode/big-pickle']);
  });

  it('passes ids absent from the shipped catalog through unfiltered', async () => {
    // Deliberate aggregator widening: the shipped catalog is only the zero-auth free tier, so
    // intersecting against it would hide every model an authenticated operator pays for.
    const probe = probeWith(() => Promise.resolve(['anthropic/claude-sonnet-4-5', 'openai/gpt-5.6-terra']));
    const available = await probe.availableModels(OPENCODE_MODELS);
    expect(available).toEqual(['anthropic/claude-sonnet-4-5', 'openai/gpt-5.6-terra']);
  });

  it('falls open to the catalog when the list is empty', async () => {
    const probe = probeWith(() => Promise.resolve([]));
    expect(await probe.availableModels(OPENCODE_MODELS)).toEqual(OPENCODE_MODELS);
  });

  it('falls open to the catalog when every line is filtered out', async () => {
    const probe = probeWith(() => Promise.resolve(['Available models:', 'run `opencode auth login` first']));
    expect(await probe.availableModels(OPENCODE_MODELS)).toEqual(OPENCODE_MODELS);
  });

  it('falls open to the catalog when the listing rejects (non-zero exit / spawn error / timeout)', async () => {
    const probe = probeWith(() => Promise.reject(new Error('opencode models exited 1')));
    await expect(probe.availableModels(OPENCODE_MODELS)).resolves.toEqual(OPENCODE_MODELS);
  });

  it('forwards the caller signal verbatim to the listing', async () => {
    const controller = new AbortController();
    const seen: Array<AbortSignal | undefined> = [];
    const probe = probeWith((_command, signal) => {
      seen.push(signal);
      return Promise.resolve(['opencode/big-pickle']);
    });
    await probe.availableModels(OPENCODE_MODELS, controller.signal);
    expect(seen).toEqual([controller.signal]);
  });
});
