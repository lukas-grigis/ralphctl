/**
 * Token-budget card — snapshot-style assertions over the states the card surfaces:
 *
 *   1. empty — no usage data
 *   2. full   — input + cache + cache hit + context bar
 *   3. partial — only input/output (no cache, no context window)
 *   4. REQ-1 canonical — context = input + cache_read (output excluded), ~30%
 *   5. cumulative — totalUsed > contextWindow (claude -p spawn-total) ⇒ "tok N cumul." no bar
 *   6. no-cache fallback — context = input_tokens only
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

  it('renders the full state with input + cache, cache hit, and context bar', () => {
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
    // Top-row label reverted from `in+cache:` to `input/output:` so it matches the input/output
    // values it renders. The narrow context column wraps the trailing `: ` to the next cell, so
    // pin the label stem (`input/output`) rather than the full colon-suffixed form.
    expect(frame).toContain('input/output');
    expect(frame).not.toContain('in+cache');
    expect(frame).toContain('41.2k');
    expect(frame).toContain('18.5k');
    expect(frame).toContain('cache hit');
    expect(frame).toContain('12.4k');
    expect(frame).toContain('context');
    // Context used = input + cache_read = 41.2k + 12.4k = 53.6k (output excluded).
    expect(frame).toContain('53.6k');
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

  it('computes the context figure from input + cache_read only (REQ-1 canonical example)', () => {
    const { lastFrame } = render(
      <TokenBudgetCard
        sessionId={SESSION}
        usage={{
          provider: 'claude-code',
          inputTokens: 9100,
          outputTokens: 28700,
          cacheReadTokens: 50000,
          contextWindow: 200000,
        }}
      />
    );
    const frame = lastFrame() ?? '';
    // Context used = input + cache_read = 9100 + 50000 = 59100 ⇒ 59.1k.
    expect(frame).toContain('59.1k');
    // 59100 / 200000 = 29.55% ⇒ rounds to 30%.
    expect(frame).toContain('30%');
    // Output (28.7k) does NOT contribute to the context figure — it is not 87.8k (input+cache+output).
    expect(frame).not.toContain('87.8k');
  });

  it('shows "tok N cumul." for over-context records — no absurd bar against a bigger-than-window value', () => {
    // input + cache_read = 240000 > 200000 (contextWindow) ⇒ this is cumulative spawn-total data
    // (typical of the claude -p provider). The old behavior was a clamped "100%" bar which was
    // actively misleading. The new behavior shows "tok: 240k cumul." without a "/200k 100%" bar.
    const { lastFrame } = render(
      <TokenBudgetCard
        sessionId={SESSION}
        usage={{
          provider: 'openai-codex',
          inputTokens: 180000,
          outputTokens: 5000,
          cacheReadTokens: 60000,
          contextWindow: 200000,
        }}
      />
    );
    const frame = lastFrame() ?? '';
    // Cumulative marker present; no absurd percentage.
    expect(frame).toContain('cumul.');
    expect(frame).toContain('240k');
    // No context-bar artefacts — the bar must not appear for cumulative data.
    expect(frame).not.toContain('100%');
    expect(frame).not.toContain('120%');
    expect(frame).not.toMatch(/█{10}/);
    // The input/output row still shows the raw values.
    expect(frame).toContain('180k');
    expect(frame).toContain('5k');
  });

  it('uses input_tokens alone for context when no cache reads are reported (REQ-1 no-cache fallback)', () => {
    const { lastFrame } = render(
      <TokenBudgetCard
        sessionId={SESSION}
        usage={{
          provider: 'github-copilot',
          inputTokens: 40000,
          outputTokens: 12000,
          contextWindow: 200000,
        }}
      />
    );
    const frame = lastFrame() ?? '';
    // No cache_read ⇒ context used = input only = 40000 ⇒ 40k.
    expect(frame).toContain('40k');
    // 40000 / 200000 = 20% (input only, output excluded).
    expect(frame).toContain('20%');
    // No cache counters ⇒ the cache hit row is omitted.
    expect(frame).not.toContain('cache hit');
  });
});
