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
import { useTokenUsage, type TokenUsage } from '@src/application/ui/tui/runtime/use-token-usage.ts';
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
});
