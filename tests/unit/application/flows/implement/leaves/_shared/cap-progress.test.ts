import { describe, expect, it } from 'vitest';
import {
  capProgressBody,
  RECENT_ATTEMPT_SECTIONS,
} from '@src/application/flows/implement/leaves/_shared/cap-progress.ts';

/**
 * `capProgressBody` bounds the inlined `progress.md` excerpt to the sprint header plus the last
 * N attempt sections so a late-sprint journal doesn't grow the prompt superlinearly. The full
 * file always stays on disk; this only caps what is inlined.
 */

const HEADER = '# Sprint: demo\n\n- id: s-1\n- created: 2026-06-09T00:00:00.000Z\n';

/** Build a `## Task:` attempt section the way `renderJournalEntry` would. */
const section = (name: string, attemptN: number, body = 'work') =>
  `\n## Task: ${name} — Attempt ${String(attemptN)}\n\n_2026-06-09T00:00:00.000Z_\n\n${body}\n`;

describe('capProgressBody', () => {
  it('returns the empty string for empty / whitespace-only input', () => {
    expect(capProgressBody('')).toBe('');
    expect(capProgressBody('   \n\t')).toBe('');
  });

  it('passes through a header-only body untouched (first task of the sprint — no attempt sections)', () => {
    expect(capProgressBody(HEADER)).toBe(HEADER);
  });

  it('passes through a body with fewer than N sections untouched', () => {
    const body = HEADER + section('a', 1) + section('b', 2);
    expect(capProgressBody(body)).toBe(body);
  });

  it('passes through a body with exactly N sections untouched', () => {
    const body = HEADER + section('a', 1) + section('b', 2) + section('c', 3);
    // Default N is 3 — exactly three sections is still within the cap.
    expect(RECENT_ATTEMPT_SECTIONS).toBe(3);
    expect(capProgressBody(body)).toBe(body);
  });

  it('keeps the header and drops all but the last N sections when over the cap', () => {
    const body =
      HEADER +
      section('old1', 1) +
      section('old2', 2) +
      section('keep1', 3) +
      section('keep2', 4) +
      section('keep3', 5);
    const out = capProgressBody(body);

    // Header is preserved verbatim.
    expect(out).toContain('# Sprint: demo');
    expect(out).toContain('- id: s-1');
    // The last three sections survive.
    expect(out).toContain('## Task: keep1 — Attempt 3');
    expect(out).toContain('## Task: keep2 — Attempt 4');
    expect(out).toContain('## Task: keep3 — Attempt 5');
    // The two oldest are gone.
    expect(out).not.toContain('## Task: old1 — Attempt 1');
    expect(out).not.toContain('## Task: old2 — Attempt 2');
  });

  it('annotates the elision with the dropped count and points to the on-disk full file', () => {
    const body =
      HEADER +
      section('old1', 1) +
      section('old2', 2) +
      section('keep1', 3) +
      section('keep2', 4) +
      section('keep3', 5);
    const out = capProgressBody(body);
    expect(out).toContain('2 earlier attempt sections omitted');
    expect(out).toContain('progress.md');
  });

  it('uses the singular form when exactly one section is dropped', () => {
    const body = HEADER + section('old1', 1) + section('keep1', 2) + section('keep2', 3) + section('keep3', 4);
    const out = capProgressBody(body);
    expect(out).toContain('1 earlier attempt section omitted');
    expect(out).not.toContain('sections omitted');
  });

  it('honors a custom recent-section count', () => {
    const body = HEADER + section('a', 1) + section('b', 2) + section('c', 3) + section('d', 4);
    const out = capProgressBody(body, 1);
    expect(out).toContain('## Task: d — Attempt 4');
    expect(out).not.toContain('## Task: c — Attempt 3');
    expect(out).toContain('3 earlier attempt sections omitted');
  });

  describe('current-task depth guarantee', () => {
    it('keeps EVERY section of the current task even when it falls outside the recency window', () => {
      // The current task's attempt 1 sits five sibling sections back — a pure recency window
      // would drop it, losing the warnings/escalations the next attempt must honour.
      const body =
        HEADER +
        section('current', 1) +
        section('sib1', 1) +
        section('sib2', 1) +
        section('current', 2) +
        section('sib3', 1) +
        section('sib4', 1) +
        section('sib5', 1);
      const out = capProgressBody(body, 3, 'current');

      // Depth: both current-task sections survive, wherever they sat.
      expect(out).toContain('## Task: current — Attempt 1');
      expect(out).toContain('## Task: current — Attempt 2');
      // Breadth: only the last three sibling sections survive.
      expect(out).toContain('## Task: sib3 — Attempt 1');
      expect(out).toContain('## Task: sib4 — Attempt 1');
      expect(out).toContain('## Task: sib5 — Attempt 1');
      expect(out).not.toContain('## Task: sib1 — Attempt 1');
      expect(out).not.toContain('## Task: sib2 — Attempt 1');
      // The elision is marked in place with the dropped count.
      expect(out).toContain('2 earlier attempt sections omitted');
    });

    it('keeps original ordering — current-task sections stay interleaved where they were', () => {
      const body =
        HEADER +
        section('current', 1) +
        section('sib1', 1) +
        section('sib2', 1) +
        section('sib3', 1) +
        section('sib4', 1);
      const out = capProgressBody(body, 2, 'current');
      const idxCurrent = out.indexOf('## Task: current — Attempt 1');
      const idxSib3 = out.indexOf('## Task: sib3 — Attempt 1');
      const idxSib4 = out.indexOf('## Task: sib4 — Attempt 1');
      expect(idxCurrent).toBeGreaterThan(-1);
      // current (oldest) rides before the kept recency window, in original order.
      expect(idxCurrent).toBeLessThan(idxSib3);
      expect(idxSib3).toBeLessThan(idxSib4);
    });

    it('a name that prefixes another task name does not over-match (boundary on " — Attempt")', () => {
      const body =
        HEADER + section('auth', 1) + section('auth-tokens', 1) + section('a', 1) + section('b', 1) + section('c', 1);
      const out = capProgressBody(body, 3, 'auth');
      // 'auth' attempt 1 is kept by the depth guarantee; 'auth-tokens' is a SIBLING (dropped —
      // it is the oldest of four non-current sections with a window of three).
      expect(out).toContain('## Task: auth — Attempt 1');
      expect(out).not.toContain('## Task: auth-tokens — Attempt 1');
    });

    it('without a current-task name the cap is the plain recency window (legacy behaviour)', () => {
      const body = HEADER + section('a', 1) + section('b', 2) + section('c', 3) + section('d', 4);
      const out = capProgressBody(body);
      expect(out).not.toContain('## Task: a — Attempt 1');
      expect(out).toContain('## Task: b — Attempt 2');
    });
  });

  it('preserves prose that precedes the first attempt section as part of the header', () => {
    // Status-transition separators (renderJournalSeparator) can precede the first `## Task:`.
    const headerWithSeparator = HEADER + '\n---\n\n_Sprint activated at 2026-06-09T00:00:00.000Z_\n\n';
    const body =
      headerWithSeparator + section('a', 1) + section('b', 2) + section('c', 3) + section('d', 4) + section('e', 5);
    const out = capProgressBody(body);
    expect(out).toContain('Sprint activated at');
    expect(out).toContain('# Sprint: demo');
  });
});
