import { describe, expect, it } from 'vitest';
import {
  capProgressBody,
  DEFAULT_RECENT_BUDGET_TOKENS,
  progressCapBudgetForModel,
} from '@src/application/flows/_shared/progress/cap-progress.ts';

/**
 * `capProgressBody` bounds the inlined `progress.md` excerpt to the always-kept header band, EVERY
 * section of the current task (matched by stable id), and the most-recent OTHER-task sections that
 * fit a token budget scaled to the resolved context window. The full file always stays on disk; this
 * only caps what is inlined.
 */

const HEADER = '# Sprint: demo\n\n- id: s-1\n- created: 2026-06-09T00:00:00.000Z\n';

/** Count non-overlapping occurrences of `needle` in `haystack`. */
const countOccurrences = (haystack: string, needle: string): number => {
  let count = 0;
  let pos = 0;
  while (pos < haystack.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    count += 1;
    pos = idx + needle.length;
  }
  return count;
};

/** Build a `## Task:` attempt section the way `renderJournalEntry` would — name plus stable id token. */
const section = (name: string, attemptN: number, id: string, body = 'work') =>
  `\n## Task: ${name} — Attempt ${String(attemptN)} · id:${id}\n\n_2026-06-09T00:00:00.000Z_\n\n${body}\n`;

/** Per-section token cost (chars/4, ceil) for budget arithmetic — every fixture section is uniform. */
const sectionTokens = (s: string): number => Math.ceil(s.length / 4);
/** A budget that keeps exactly `k` uniform sections of size `oneSection`. */
const budgetFor = (k: number, oneSection: string): number => sectionTokens(oneSection) * k + 1;

describe('capProgressBody', () => {
  it('returns the empty string for empty / whitespace-only input', () => {
    expect(capProgressBody('')).toBe('');
    expect(capProgressBody('   \n\t')).toBe('');
  });

  it('passes through a header-only body untouched (first task of the sprint — no attempt sections)', () => {
    expect(capProgressBody(HEADER)).toBe(HEADER);
  });

  it('passes through a body whose sibling sections all fit the default budget untouched', () => {
    const body = HEADER + section('a', 1, 'id-a') + section('b', 2, 'id-b') + section('c', 3, 'id-c');
    // Default budget is the 200K tier (thousands of tokens) — three tiny sections never overflow it.
    expect(capProgressBody(body)).toBe(body);
  });

  it('keeps the header and drops the oldest sibling sections when over the budget', () => {
    const s = section('keep1', 3, 'id-keep1');
    const body =
      HEADER +
      section('old1', 1, 'id-old1') +
      section('old2', 2, 'id-old2') +
      section('keep1', 3, 'id-keep1') +
      section('keep2', 4, 'id-keep2') +
      section('keep3', 5, 'id-keep3');
    const out = capProgressBody(body, { recentBudgetTokens: budgetFor(3, s) });

    expect(out).toContain('# Sprint: demo');
    expect(out).toContain('- id: s-1');
    // The three most-recent siblings survive.
    expect(out).toContain('## Task: keep1 — Attempt 3 · id:id-keep1');
    expect(out).toContain('## Task: keep2 — Attempt 4 · id:id-keep2');
    expect(out).toContain('## Task: keep3 — Attempt 5 · id:id-keep3');
    // The two oldest are gone.
    expect(out).not.toContain('## Task: old1 — Attempt 1');
    expect(out).not.toContain('## Task: old2 — Attempt 2');
  });

  it('annotates the elision with the dropped count + on-disk pointer — EXACTLY one note per contiguous run', () => {
    const s = section('keep1', 3, 'id-keep1');
    const body =
      HEADER +
      section('old1', 1, 'id-old1') +
      section('old2', 2, 'id-old2') +
      section('keep1', 3, 'id-keep1') +
      section('keep2', 4, 'id-keep2') +
      section('keep3', 5, 'id-keep3');
    const out = capProgressBody(body, { recentBudgetTokens: budgetFor(3, s) });
    expect(out).toContain('2 earlier attempt sections omitted');
    expect(out).toContain('progress.md');
    expect(countOccurrences(out, 'earlier attempt section')).toBe(1);
    const noteIdx = out.indexOf('2 earlier attempt sections omitted');
    const firstKeptIdx = out.indexOf('## Task: keep1 — Attempt 3');
    expect(noteIdx).toBeGreaterThan(-1);
    expect(noteIdx).toBeLessThan(firstKeptIdx);
  });

  it('uses the singular form when exactly one section is dropped — exact wording, no plural', () => {
    const s = section('keep1', 2, 'id-keep1');
    const body =
      HEADER +
      section('old1', 1, 'id-old1') +
      section('keep1', 2, 'id-keep1') +
      section('keep2', 3, 'id-keep2') +
      section('keep3', 4, 'id-keep3');
    const out = capProgressBody(body, { recentBudgetTokens: budgetFor(3, s) });
    expect(out).toContain('1 earlier attempt section omitted');
    expect(out).not.toContain('1 earlier attempt sections omitted');
    expect(countOccurrences(out, 'earlier attempt section')).toBe(1);
  });

  it('always keeps at least the single most-recent sibling even when it alone exceeds the budget', () => {
    const body = HEADER + section('a', 1, 'id-a') + section('b', 2, 'id-b') + section('c', 3, 'id-c');
    const out = capProgressBody(body, { recentBudgetTokens: 1 });
    expect(out).toContain('## Task: c — Attempt 3 · id:id-c');
    expect(out).not.toContain('## Task: a — Attempt 1');
    expect(out).not.toContain('## Task: b — Attempt 2');
  });

  describe('current-task depth guarantee (matched by stable id, not name)', () => {
    it('keeps EVERY section of the current task even when it falls outside the recency window', () => {
      const s = section('sib3', 1, 'id-sib3');
      const body =
        HEADER +
        section('current', 1, 'id-cur') +
        section('sib1', 1, 'id-sib1') +
        section('sib2', 1, 'id-sib2') +
        section('current', 2, 'id-cur') +
        section('sib3', 1, 'id-sib3') +
        section('sib4', 1, 'id-sib4') +
        section('sib5', 1, 'id-sib5');
      const out = capProgressBody(body, { currentTaskId: 'id-cur', recentBudgetTokens: budgetFor(3, s) });

      // Depth: both current-task sections survive, wherever they sat.
      expect(out).toContain('## Task: current — Attempt 1 · id:id-cur');
      expect(out).toContain('## Task: current — Attempt 2 · id:id-cur');
      // Breadth: only the last three sibling sections survive.
      expect(out).toContain('## Task: sib3 — Attempt 1 · id:id-sib3');
      expect(out).toContain('## Task: sib4 — Attempt 1 · id:id-sib4');
      expect(out).toContain('## Task: sib5 — Attempt 1 · id:id-sib5');
      expect(out).not.toContain('## Task: sib1 — Attempt 1');
      expect(out).not.toContain('## Task: sib2 — Attempt 1');
      // One elision note, between current-attempt-1 and current-attempt-2.
      expect(out).toContain('2 earlier attempt sections omitted');
      expect(countOccurrences(out, 'earlier attempt section')).toBe(1);
      const noteIdx = out.indexOf('2 earlier attempt sections omitted');
      const current1Idx = out.indexOf('## Task: current — Attempt 1');
      const current2Idx = out.indexOf('## Task: current — Attempt 2');
      expect(noteIdx).toBeGreaterThan(current1Idx);
      expect(noteIdx).toBeLessThan(current2Idx);
    });

    it('identical task NAMES with different ids do not collide — only the current id rides in full', () => {
      // Two distinct tasks share the name "auth". The cap must keep the CURRENT id's sections by id,
      // not sweep in the same-named sibling. With a 1-token budget only the most-recent sibling rides.
      const body =
        HEADER +
        section('auth', 1, 'id-current') +
        section('auth', 1, 'id-sibling') +
        section('auth', 2, 'id-current') +
        section('zzz', 9, 'id-recent');
      const out = capProgressBody(body, { currentTaskId: 'id-current', recentBudgetTokens: 1 });
      // Both current-id sections kept by depth, regardless of the shared name.
      expect(countOccurrences(out, '· id:id-current')).toBe(2);
      // The same-NAMED sibling (different id) is dropped — it is not the current task.
      expect(out).not.toContain('· id:id-sibling');
      // The single most-recent sibling rides.
      expect(out).toContain('· id:id-recent');
    });

    it('a mid-sprint rename keeps every earlier section of the task — depth is keyed on id, not name', () => {
      // Same task id, renamed between attempts. A name match would orphan the earlier section; the
      // id match keeps both even under a 1-token sibling budget that elides everything else.
      const body =
        HEADER +
        section('old-name', 1, 'id-task') +
        section('sib', 1, 'id-sib1') +
        section('sib', 2, 'id-sib2') +
        section('new-name', 2, 'id-task');
      const out = capProgressBody(body, { currentTaskId: 'id-task', recentBudgetTokens: 1 });
      expect(out).toContain('## Task: old-name — Attempt 1 · id:id-task');
      expect(out).toContain('## Task: new-name — Attempt 2 · id:id-task');
    });

    it('a name embedding another id cannot forge the current-task match (suffix is harness-controlled)', () => {
      const body =
        HEADER +
        section('evil · id:id-victim', 1, 'id-attacker') +
        section('victim', 1, 'id-victim') +
        section('z', 9, 'id-recent');
      // Current task is the victim; the attacker's name embeds the victim id mid-line but the real
      // suffix is the attacker's, so the attacker section is NOT treated as the victim's.
      const out = capProgressBody(body, { currentTaskId: 'id-victim', recentBudgetTokens: 1 });
      expect(out).toContain('## Task: victim — Attempt 1 · id:id-victim');
      expect(out).not.toContain('· id:id-attacker');
    });
  });

  describe('lifecycle / recovery breadcrumb pinning', () => {
    it('pins a status separator from a dropped section into the always-kept header band', () => {
      // The oldest sibling carries a sprint-activation separator. Dropping the section must NOT drop
      // the lifecycle note — it is pinned into the header band.
      const dropped =
        section('old', 1, 'id-old') + '\n---\n\n_Sprint transitioned to review at 2026-06-09T00:00:00.000Z_\n\n';
      const body = HEADER + dropped + section('keep', 9, 'id-keep');
      const out = capProgressBody(body, { recentBudgetTokens: 1 });
      expect(out).not.toContain('## Task: old — Attempt 1');
      // The separator caption survives, pinned ahead of the kept section.
      expect(out).toContain('_Sprint transitioned to review at 2026-06-09T00:00:00.000Z_');
      const pinIdx = out.indexOf('_Sprint transitioned to review at');
      const keepIdx = out.indexOf('## Task: keep — Attempt 9');
      expect(pinIdx).toBeLessThan(keepIdx);
    });

    it('pins a quarantine-recovery pointer from a dropped section into the header band', () => {
      const dropped =
        section('blocked', 1, 'id-blk') +
        '\n_Task blocked: rejected diff quarantined to git stash — recover via `git stash list` (message: `ralphctl/s/t/blocked-diff`)._\n';
      const body = HEADER + dropped + section('keep', 9, 'id-keep');
      const out = capProgressBody(body, { recentBudgetTokens: 1 });
      expect(out).not.toContain('## Task: blocked — Attempt 1');
      expect(out).toContain('rejected diff quarantined to git stash');
    });
  });

  it('preserves prose that precedes the first attempt section as part of the header', () => {
    const headerWithSeparator = HEADER + '\n---\n\n_Sprint activated at 2026-06-09T00:00:00.000Z_\n\n';
    const body =
      headerWithSeparator +
      section('a', 1, 'id-a') +
      section('b', 2, 'id-b') +
      section('c', 3, 'id-c') +
      section('d', 4, 'id-d') +
      section('e', 5, 'id-e');
    const out = capProgressBody(body, { recentBudgetTokens: 1 });
    expect(out).toContain('Sprint activated at');
    expect(out).toContain('# Sprint: demo');
  });
});

describe('progressCapBudgetForModel', () => {
  it('scales the sibling budget with the resolved context window (1M > 200K)', () => {
    const small = progressCapBudgetForModel('claude-opus-4-8'); // 200K
    const large = progressCapBudgetForModel('claude-opus-4-8[1m]'); // 1M
    expect(large).toBeGreaterThan(small);
  });

  it('falls back to the 200K-tier default for an unknown / unset model', () => {
    expect(progressCapBudgetForModel(undefined)).toBe(DEFAULT_RECENT_BUDGET_TOKENS);
    expect(progressCapBudgetForModel('some-unlisted-model')).toBe(DEFAULT_RECENT_BUDGET_TOKENS);
  });
});
