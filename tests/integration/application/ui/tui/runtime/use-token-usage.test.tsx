/**
 * Verify the per-session token-usage tracker hook. The hook must:
 *  - record the latest usage per sessionId,
 *  - replace prior usage for the same sessionId (latest event wins per session),
 *  - ignore other AppEvent types.
 */

import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { describe, expect, it } from 'vitest';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { type TokenUsage, useTokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';

const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');

const Probe = ({
  bus,
  onState,
}: {
  readonly bus: ReturnType<typeof createInMemoryEventBus>;
  readonly onState: (usage: ReadonlyMap<string, TokenUsage>) => void;
}): React.JSX.Element => {
  const usage = useTokenUsage(bus);
  onState(usage);
  return <Text>sessions={usage.size}</Text>;
};

describe('useTokenUsage', () => {
  it('records the latest usage per session across publishes', async () => {
    const bus = createInMemoryEventBus();
    let last: ReadonlyMap<string, TokenUsage> = new Map();
    const r = render(<Probe bus={bus} onState={(u) => (last = u)} />);

    bus.publish({
      type: 'token-usage',
      sessionId: 'sess-1',
      provider: 'claude-code',
      model: 'claude-sonnet',
      inputTokens: 40000,
      outputTokens: 10000,
      contextWindow: 200000,
      at: NOW,
    });
    bus.publish({
      type: 'token-usage',
      sessionId: 'sess-2',
      provider: 'github-copilot',
      inputTokens: 5000,
      outputTokens: 1000,
      at: NOW,
    });
    await new Promise((res) => setTimeout(res, 5));

    expect(last.get('sess-1')).toEqual({
      provider: 'claude-code',
      model: 'claude-sonnet',
      inputTokens: 40000,
      outputTokens: 10000,
      contextWindow: 200000,
    });
    expect(last.get('sess-2')).toEqual({
      provider: 'github-copilot',
      inputTokens: 5000,
      outputTokens: 1000,
    });
    r.unmount();
  });

  it('maps the live per-turn fields through alongside the cumulative ones', async () => {
    const bus = createInMemoryEventBus();
    let last: ReadonlyMap<string, TokenUsage> = new Map();
    const r = render(<Probe bus={bus} onState={(u) => (last = u)} />);

    bus.publish({
      type: 'token-usage',
      sessionId: 'sess-live',
      provider: 'claude-code',
      inputTokens: 2000,
      outputTokens: 900,
      cacheReadTokens: 187000,
      liveInputTokens: 1200,
      liveCacheReadTokens: 52000,
      liveCacheCreationTokens: 400,
      contextWindow: 200000,
      at: NOW,
    });
    await new Promise((res) => setTimeout(res, 5));

    expect(last.get('sess-live')).toEqual({
      provider: 'claude-code',
      inputTokens: 2000,
      outputTokens: 900,
      cacheReadTokens: 187000,
      liveInputTokens: 1200,
      liveCacheReadTokens: 52000,
      liveCacheCreationTokens: 400,
      contextWindow: 200000,
    });
    r.unmount();
  });

  it('replaces prior usage for the same session (latest event wins)', async () => {
    const bus = createInMemoryEventBus();
    let last: ReadonlyMap<string, TokenUsage> = new Map();
    const r = render(<Probe bus={bus} onState={(u) => (last = u)} />);

    bus.publish({
      type: 'token-usage',
      sessionId: 'sess-1',
      provider: 'claude-code',
      inputTokens: 1000,
      outputTokens: 200,
      at: NOW,
    });
    bus.publish({
      type: 'token-usage',
      sessionId: 'sess-1',
      provider: 'claude-code',
      inputTokens: 80000,
      outputTokens: 20000,
      contextWindow: 200000,
      at: NOW,
    });
    await new Promise((res) => setTimeout(res, 5));

    expect(last.get('sess-1')?.inputTokens).toBe(80000);
    expect(last.get('sess-1')?.contextWindow).toBe(200000);
    r.unmount();
  });

  it('ignores other AppEvent types', async () => {
    const bus = createInMemoryEventBus();
    let last: ReadonlyMap<string, TokenUsage> = new Map();
    const r = render(<Probe bus={bus} onState={(u) => (last = u)} />);

    bus.publish({ type: 'chain-started', chainId: 'c1', flowId: 'implement', at: NOW });
    bus.publish({ type: 'log', level: 'info', message: 'noise', at: NOW });
    await new Promise((res) => setTimeout(res, 5));

    expect(last.size).toBe(0);
    r.unmount();
  });

  it('keys by chainSessionId when present so the runner-id lookup hits', async () => {
    const bus = createInMemoryEventBus();
    let last: ReadonlyMap<string, TokenUsage> = new Map();
    const r = render(<Probe bus={bus} onState={(u) => (last = u)} />);

    // Provider stamps the AI CLI's own uuid in `sessionId` and the chain runner id in
    // `chainSessionId`; the view looks up by the runner id, so the entry must be keyed by it.
    bus.publish({
      type: 'token-usage',
      sessionId: 'cli-uuid-abc',
      chainSessionId: 'runner-1',
      provider: 'claude-code',
      inputTokens: 40000,
      outputTokens: 10000,
      contextWindow: 200000,
      at: NOW,
    });
    await new Promise((res) => setTimeout(res, 5));

    expect(last.has('runner-1')).toBe(true);
    expect(last.has('cli-uuid-abc')).toBe(false);
    expect(last.get('runner-1')).toEqual({
      provider: 'claude-code',
      inputTokens: 40000,
      outputTokens: 10000,
      contextWindow: 200000,
    });
    r.unmount();
  });

  it('falls back to sessionId for legacy events without chainSessionId', async () => {
    const bus = createInMemoryEventBus();
    let last: ReadonlyMap<string, TokenUsage> = new Map();
    const r = render(<Probe bus={bus} onState={(u) => (last = u)} />);

    bus.publish({
      type: 'token-usage',
      sessionId: 'sess-legacy',
      provider: 'openai-codex',
      inputTokens: 1000,
      at: NOW,
    });
    await new Promise((res) => setTimeout(res, 5));

    expect(last.has('sess-legacy')).toBe(true);
    expect(last.get('sess-legacy')?.inputTokens).toBe(1000);
    r.unmount();
  });

  it('caps retained sessions at the LRU limit and evicts the oldest on overflow', async () => {
    const bus = createInMemoryEventBus();
    let last: ReadonlyMap<string, TokenUsage> = new Map();
    const r = render(<Probe bus={bus} onState={(u) => (last = u)} />);

    // Publish 105 distinct sessions; the cap is 100. Expect the 5 oldest to be evicted.
    for (let i = 0; i < 105; i += 1) {
      bus.publish({
        type: 'token-usage',
        sessionId: `sess-${String(i)}`,
        provider: 'claude-code',
        inputTokens: i,
        at: NOW,
      });
    }
    await new Promise((res) => setTimeout(res, 5));

    expect(last.size).toBe(100);
    // The 5 oldest (sess-0..sess-4) were evicted; the 5 most-recent (sess-100..sess-104) remain.
    expect(last.has('sess-0')).toBe(false);
    expect(last.has('sess-4')).toBe(false);
    expect(last.has('sess-5')).toBe(true);
    expect(last.has('sess-104')).toBe(true);
    r.unmount();
  });
});
