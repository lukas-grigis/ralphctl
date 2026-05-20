/**
 * Token-budget card — snapshot-style assertions over the three states the card surfaces:
 *
 *   1. empty — no usage data
 *   2. full   — input/output + cache hit + context bar
 *   3. partial — only input/output (no cache, no context window)
 *
 * Pins enough rendered text that a future refactor that drops a row or swaps a formatter fails
 * loudly.
 */

import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TokenBudgetCard } from '@src/application/ui/tui/components/token-budget-card.tsx';

const SESSION = '019e46d1-5f16-7db9-af55-67c3c703d438';

describe('TokenBudgetCard', () => {
  it('renders the empty state when no usage data is supplied', () => {
    const { lastFrame } = render(<TokenBudgetCard sessionId={SESSION} />);
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Tokens');
    expect(frame).toContain('sess-019e46d1');
    expect(frame).toContain('no usage data');
  });

  it('renders the full state with input/output, cache hit, and context bar', () => {
    const { lastFrame } = render(
      <TokenBudgetCard
        sessionId={SESSION}
        usage={{
          provider: 'claude-code',
          inputTokens: 41200,
          outputTokens: 18500,
          cacheReadTokens: 12400,
          contextWindow: 200000,
        }}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('input/output');
    expect(frame).toContain('41.2k');
    expect(frame).toContain('18.5k');
    expect(frame).toContain('cache hit');
    expect(frame).toContain('12.4k');
    expect(frame).toContain('context');
    expect(frame).toContain('200k');
    expect(frame).toMatch(/[█░]/);
    expect(frame).toContain('%');
  });

  it('renders the partial state when only input/output are known', () => {
    const { lastFrame } = render(
      <TokenBudgetCard
        sessionId={SESSION}
        usage={{
          provider: 'github-copilot',
          inputTokens: 1500,
          outputTokens: 500,
        }}
      />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1.5k');
    expect(frame).toContain('500');
    expect(frame).not.toContain('cache hit');
    // No context window known ⇒ row prints `2k / ?` with no bar.
    expect(frame).toContain('?');
  });
});
