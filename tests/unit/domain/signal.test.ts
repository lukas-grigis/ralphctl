/**
 * Domain-side smoke for the `HarnessSignal` union — pins the `context-compacted` variant's
 * shape and its membership in the union so a future drift (rename / accidental removal) fails
 * loudly at typecheck or in this assertion rather than silently breaking TUI rendering.
 *
 * No parser is wired yet (no provider exposes a stable compaction marker in v0.7.0), so the
 * value of these tests is the type-level contract plus a literal construction example.
 */

import { describe, expect, it } from 'vitest';
import type { ContextCompactedSignal, HarnessSignal } from '@src/domain/signal.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

const ts = (n: number): IsoTimestamp => new Date(Date.UTC(2026, 5, 1, 0, 0, n)).toISOString() as IsoTimestamp;

describe('ContextCompactedSignal', () => {
  it('constructs with only the required fields (timestamp)', () => {
    const sig: ContextCompactedSignal = { type: 'context-compacted', timestamp: ts(0) };
    expect(sig.type).toBe('context-compacted');
    expect(sig.beforeTokens).toBeUndefined();
    expect(sig.afterTokens).toBeUndefined();
    expect(sig.preservedTopics).toBeUndefined();
  });

  it('constructs with the full optional payload (token counts + topics)', () => {
    const sig: ContextCompactedSignal = {
      type: 'context-compacted',
      timestamp: ts(0),
      beforeTokens: 200_000,
      afterTokens: 12_000,
      preservedTopics: ['repo layout', 'open task', 'test harness', 'auth flow'],
    };
    expect(sig.beforeTokens).toBe(200_000);
    expect(sig.afterTokens).toBe(12_000);
    expect(sig.preservedTopics).toHaveLength(4);
  });

  it('is a member of the HarnessSignal union (narrowable by discriminator)', () => {
    const sig: HarnessSignal = { type: 'context-compacted', timestamp: ts(0), beforeTokens: 100 };
    if (sig.type === 'context-compacted') {
      // Type narrowed — touching the variant-specific field must compile.
      expect(sig.beforeTokens).toBe(100);
    } else {
      throw new Error('discriminator narrowing failed');
    }
  });
});
