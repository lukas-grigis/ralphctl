/**
 * Token-budget card — snapshot-style assertions over the states the card surfaces:
 *
 *   1. empty — no usage data
 *   2. Usage + Context groups — input/output + cache hit (Usage) and live-derived window bar (Context)
 *   3. partial — only input/output (no cache, no context window)
 *   4. live-driven context — bar comes from live per-turn counters, not cumulative
 *   5. cumulative fallback — no live counters, totalUsed > contextWindow ⇒ "session N cumulative" no bar
 *   6. no-cache fallback — context = input_tokens only (no live counters)
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

  it('renders both labelled groups — Usage (cumulative) and Context (window occupancy)', () => {
    const { lastFrame } = render(
      <TokenBudgetCard
        sessionId={SESSION}
        usage={{
          provider: 'claude-code',
          inputTokens: 41200,
          outputTokens: 18500,
          cacheReadTokens: 12400,
          // Live per-turn snapshot drives the Context bar.
          liveInputTokens: 9100,
          liveCacheReadTokens: 50000,
          contextWindow: 200000,
        }}
      />
    );
    const frame = lastFrame() ?? '';
    // Group headers.
    expect(frame).toContain('Usage');
    expect(frame).toContain('Context');
    // Usage group: throughput figures + cache hit. No "/window" denominator next to in/out.
    expect(frame).toContain('in/out');
    expect(frame).toContain('41.2k');
    expect(frame).toContain('18.5k');
    expect(frame).toContain('cache hit');
    expect(frame).toContain('12.4k');
    // Context group: live-derived occupancy = 9.1k + 50k = 59.1k against the 200k window.
    expect(frame).toContain('59.1k');
    expect(frame).toContain('200k');
    expect(frame).toMatch(/[█░]/);
    // 59100 / 200000 = 29.55% ⇒ 30%.
    expect(frame).toContain('30%');
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
    // No context window known ⇒ Context figure prints `2k / ?` with no bar.
    expect(frame).toContain('?');
  });

  it('drives the Context bar from live per-turn counters, not the cumulative figures', () => {
    const { lastFrame } = render(
      <TokenBudgetCard
        sessionId={SESSION}
        usage={{
          provider: 'claude-code',
          // Cumulative figures are huge (sum across many turns) — must NOT drive the bar.
          inputTokens: 9100,
          outputTokens: 28700,
          cacheReadTokens: 500000,
          // Live per-turn snapshot is the real current window occupancy.
          liveInputTokens: 9100,
          liveCacheReadTokens: 50000,
          contextWindow: 200000,
        }}
      />
    );
    const frame = lastFrame() ?? '';
    // Context used (live) = 9100 + 50000 = 59.1k ⇒ 30%. The cumulative cacheRead (500k) is ignored.
    expect(frame).toContain('59.1k');
    expect(frame).toContain('30%');
    // No "cumulative" note — live data is present so the bar renders.
    expect(frame).not.toContain('cumulative');
  });

  it('falls back to "session N cumulative" with no bar when no live data and over-window', () => {
    // input + cache_read = 240000 > 200000 (contextWindow) and no live counters ⇒ cumulative
    // spawn-total data. No clamped "100%" bar — show "session: 240k (cumulative)" plainly.
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
    expect(frame).toContain('cumulative');
    expect(frame).toContain('240k');
    expect(frame).not.toContain('100%');
    expect(frame).not.toMatch(/█{10}/);
    // The Usage row still shows the raw throughput values.
    expect(frame).toContain('180k');
    expect(frame).toContain('5k');
  });

  it('falls back to cumulative-derived figure WITH a bar when it plausibly fits the window', () => {
    // No live counters, but input + cache_read = 40000 <= 200000 ⇒ plausibly single-call ⇒ bar OK.
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
    // Context used = input only = 40000 ⇒ 40k, 20% (output excluded), bar renders.
    expect(frame).toContain('40k');
    expect(frame).toContain('20%');
    expect(frame).toMatch(/[█░]/);
    expect(frame).not.toContain('cumulative');
    expect(frame).not.toContain('cache hit');
  });
});
