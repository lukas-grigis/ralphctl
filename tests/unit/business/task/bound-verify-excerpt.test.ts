import { describe, expect, it } from 'vitest';
import { VERIFY_WARNING_EXCERPT_LIMIT, boundVerifyExcerpt } from '@src/business/task/bound-verify-excerpt.ts';

describe('boundVerifyExcerpt', () => {
  it('returns short output verbatim (no marker, byte-for-byte)', () => {
    const out = '[ERROR] BUILD FAILURE\nsee the test report';
    expect(boundVerifyExcerpt(out)).toBe(out);
  });

  it('returns output exactly at the limit verbatim', () => {
    const out = 'x'.repeat(VERIFY_WARNING_EXCERPT_LIMIT);
    expect(boundVerifyExcerpt(out)).toBe(out);
  });

  it('caps oversized output to well under the limit and keeps head + tail', () => {
    const head = 'HEAD-MARKER';
    const tail = 'TAIL-MARKER';
    // ~50 MB, like a verbose `mvn clean verify` echoed through the 50 MB runner cap.
    const huge = `${head}${'-'.repeat(50 * 1024 * 1024)}${tail}`;
    const bounded = boundVerifyExcerpt(huge);

    // The whole point: the persisted excerpt is tiny, not 50 MB.
    expect(bounded.length).toBeLessThan(VERIFY_WARNING_EXCERPT_LIMIT + 200);
    expect(bounded.startsWith(head)).toBe(true);
    expect(bounded.endsWith(tail)).toBe(true);
    expect(bounded).toContain('truncated');
    expect(bounded).toContain('full verify log on disk');
  });

  it('honours a custom limit', () => {
    const bounded = boundVerifyExcerpt('a'.repeat(1000), 100);
    expect(bounded.length).toBeLessThan(300);
    expect(bounded).toContain('truncated');
  });

  it('treats a non-positive limit as no-op (defensive)', () => {
    const out = 'x'.repeat(1000);
    expect(boundVerifyExcerpt(out, 0)).toBe(out);
  });
});
