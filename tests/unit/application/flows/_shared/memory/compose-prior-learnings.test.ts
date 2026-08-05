import { describe, expect, it } from 'vitest';
import type { LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import {
  composePriorLearnings,
  PRIOR_LEARNINGS_MAX,
} from '@src/application/flows/_shared/memory/compose-prior-learnings.ts';

const record = (overrides: Partial<LearningRecord> & { text: string }): LearningRecord => ({
  v: 1,
  id: overrides.text.slice(0, 16),
  repo: '/repo',
  repoName: 'repo',
  taskKind: 'feature',
  sprintId: 'sprint-1',
  taskId: 'task-1',
  timestamp: '2026-06-12T00:00:00.000Z',
  promotedAt: null,
  ...overrides,
});

describe('composePriorLearnings', () => {
  it('returns empty string for no records', () => {
    expect(composePriorLearnings([])).toBe('');
  });

  it('renders one bullet per learning insight', () => {
    const out = composePriorLearnings([
      record({ text: 'tests need a real DB' }),
      record({ text: 'module Y is coupled' }),
    ]);
    expect(out).toBe('- tests need a real DB\n- module Y is coupled');
  });

  it('appends the optional applies-to inline', () => {
    const out = composePriorLearnings([record({ text: 'flaky e2e', appliesTo: 'web app' })]);
    expect(out).toBe('- flaky e2e (applies to web app)');
  });

  it('drops empty-insight records', () => {
    const out = composePriorLearnings([record({ text: '   ' }), record({ text: 'real one' })]);
    expect(out).toBe('- real one');
  });

  it('keeps only the most recent N records (tail = newest by append order)', () => {
    const many = Array.from({ length: PRIOR_LEARNINGS_MAX + 5 }, (_, i) => record({ text: `learning ${String(i)}` }));
    const out = composePriorLearnings(many);
    const lines = out.split('\n');
    expect(lines).toHaveLength(PRIOR_LEARNINGS_MAX);
    // The oldest (learning 0..4) are dropped; the newest (last) survives.
    expect(out).toContain(`learning ${String(PRIOR_LEARNINGS_MAX + 4)}`);
    expect(out).not.toContain('learning 0\n');
  });

  it('collapses internal whitespace into a single line', () => {
    const out = composePriorLearnings([record({ text: 'a\n  multi\tline   insight' })]);
    expect(out).toBe('- a multi line insight');
  });

  it('renders decisions under a sub-heading within the same block', () => {
    const out = composePriorLearnings([
      record({ text: 'tests need a real DB', kind: 'learning' }),
      record({ text: 'adopt hexagonal layering', kind: 'decision' }),
      record({ text: 'use one event bus per wire', kind: 'decision' }),
    ]);
    expect(out).toBe(
      '- tests need a real DB\n\nDecisions from prior sprints:\n- adopt hexagonal layering\n- use one event bus per wire'
    );
  });

  it('renders ONLY a decisions block when there are no learnings', () => {
    const out = composePriorLearnings([record({ text: 'adopt hexagonal layering', kind: 'decision' })]);
    expect(out).toBe('Decisions from prior sprints:\n- adopt hexagonal layering');
  });

  it('treats a legacy row with no kind as a learning (not a decision)', () => {
    const out = composePriorLearnings([record({ text: 'legacy insight' })]);
    expect(out).toBe('- legacy insight');
    expect(out).not.toContain('Decisions from prior sprints');
  });
});

describe('composePriorLearnings — relevance weighting', () => {
  it('ranks same-repo records above cross-repo records, most-relevant block first', () => {
    const out = composePriorLearnings(
      [
        record({ text: 'cross A', repo: '/other' }),
        record({ text: 'same A', repo: '/repo' }),
        record({ text: 'cross B', repo: '/other' }),
        record({ text: 'same B', repo: '/repo' }),
      ],
      { repo: '/repo', taskKind: 'feature' }
    );
    // Same-repo (tier first, append order) then cross-repo (append order) — deterministic.
    expect(out).toBe('- same A\n- same B\n- cross A\n- cross B');
  });

  it('weights repo match above taskKind match', () => {
    const out = composePriorLearnings(
      [
        record({ text: 'kind only', repo: '/other', taskKind: 'feature' }),
        record({ text: 'repo other kind', repo: '/repo', taskKind: 'bugfix' }),
        record({ text: 'neither', repo: '/other', taskKind: 'docs' }),
      ],
      { repo: '/repo', taskKind: 'feature' }
    );
    // repo match (score 2) > taskKind match (score 1) > neither (score 0).
    expect(out).toBe('- repo other kind\n- kind only\n- neither');
  });

  it('keeps the cap: cross-repo records ranked below same-repo are dropped when the cap fills', () => {
    const sameRepo = Array.from({ length: PRIOR_LEARNINGS_MAX + 3 }, (_, i) =>
      record({ text: `same-${String(i)}`, repo: '/repo' })
    );
    const out = composePriorLearnings([record({ text: 'cross', repo: '/other' }), ...sameRepo], {
      repo: '/repo',
      taskKind: 'feature',
    });
    const lines = out.split('\n');
    expect(lines).toHaveLength(PRIOR_LEARNINGS_MAX);
    // Cross-repo record ranks below the same-repo tier, which alone overflows the cap → excluded.
    expect(out).not.toContain('cross');
    // Within the same-repo tier the newest survive; the oldest (same-0..2) are dropped.
    expect(out).toContain(`same-${String(PRIOR_LEARNINGS_MAX + 2)}`);
    expect(lines).not.toContain('- same-0');
  });

  it('without context, selection is recency-only regardless of repo/taskKind', () => {
    // No context → every record scores 0 → pure recency (newest N, append order). A cross-repo record
    // is NOT deprioritised here, proving the weighting only kicks in when a context is supplied.
    const out = composePriorLearnings([
      record({ text: 'first', repo: '/other' }),
      record({ text: 'second', repo: '/repo' }),
    ]);
    expect(out).toBe('- first\n- second');
  });
});

describe('composePriorLearnings — abstain gate (taskText supplied)', () => {
  it('drops a record whose ONLY claim is repo match once taskText is supplied', () => {
    const out = composePriorLearnings(
      [record({ text: 'totally unrelated prose about something else entirely', repo: '/repo', taskKind: 'docs' })],
      { repo: '/repo', taskKind: 'feature', taskText: 'wire the new payment gateway retry logic' }
    );
    expect(out).toBe('');
  });

  it('returns the empty string (abstains) when nothing qualifies for either kind', () => {
    const out = composePriorLearnings(
      [
        record({ text: 'unrelated learning', repo: '/repo', taskKind: 'docs' }),
        record({ text: 'unrelated decision', repo: '/repo', taskKind: 'docs', kind: 'decision' }),
      ],
      { repo: '/repo', taskKind: 'feature', taskText: 'wire the new payment gateway retry logic' }
    );
    expect(out).toBe('');
  });

  it('keeps a record that qualifies via taskKind match alone, even with no textual overlap', () => {
    const out = composePriorLearnings(
      [record({ text: 'totally unrelated prose', repo: '/other', taskKind: 'feature' })],
      { taskKind: 'feature', taskText: 'wire the new payment gateway retry logic' }
    );
    expect(out).toBe('- totally unrelated prose');
  });

  it('keeps a record that qualifies via appliesTo token overlap alone', () => {
    const out = composePriorLearnings(
      [record({ text: 'watch out for rate limits', appliesTo: 'payment gateway', taskKind: 'docs' })],
      { taskKind: 'feature', taskText: 'wire the new payment gateway retry logic' }
    );
    expect(out).toBe('- watch out for rate limits (applies to payment gateway)');
  });

  it('keeps a record that qualifies via text token overlap alone', () => {
    const out = composePriorLearnings(
      [record({ text: 'the payment gateway retry logic needs jitter', taskKind: 'docs' })],
      { taskKind: 'feature', taskText: 'wire the new payment gateway retry logic' }
    );
    expect(out).toBe('- the payment gateway retry logic needs jitter');
  });

  it('an empty taskText still activates the gate (repo-only match alone is dropped)', () => {
    const out = composePriorLearnings([record({ text: 'repo-only match', repo: '/repo', taskKind: 'docs' })], {
      repo: '/repo',
      taskKind: 'feature',
      taskText: '',
    });
    expect(out).toBe('');
  });

  it('ranks appliesTo overlap above a bare taskKind match', () => {
    const out = composePriorLearnings(
      [
        record({ text: 'kind match only', taskKind: 'feature' }),
        record({ text: 'gateway note', appliesTo: 'payment gateway', taskKind: 'docs' }),
      ],
      { taskKind: 'feature', taskText: 'wire the new payment gateway retry logic' }
    );
    expect(out).toBe('- gateway note (applies to payment gateway)\n- kind match only');
  });

  it('legacy no-context callers (plan / ideate) are byte-for-byte unaffected by the gate', () => {
    // No taskText at all → every record qualifies unconditionally, matching pre-gate behaviour.
    const out = composePriorLearnings([record({ text: 'repo-only match', repo: '/repo', taskKind: 'docs' })], {
      repo: '/repo',
      taskKind: 'feature',
    });
    expect(out).toBe('- repo-only match');
  });
});

describe('composePriorLearnings — age decay', () => {
  const NOW = '2026-08-04T00:00:00.000Z';

  it('orders a fresher record above an older same-tier record once nowIso is supplied', () => {
    const out = composePriorLearnings(
      [
        record({ text: 'older kind match', taskKind: 'feature', timestamp: '2026-01-01T00:00:00.000Z' }),
        record({ text: 'fresher kind match', taskKind: 'feature', timestamp: '2026-08-01T00:00:00.000Z' }),
      ],
      { taskKind: 'feature', nowIso: NOW }
    );
    expect(out).toBe('- fresher kind match\n- older kind match');
  });

  it('without nowIso, decay is zero and same-tier ordering falls back to append order (no behaviour change)', () => {
    const out = composePriorLearnings(
      [
        record({ text: 'older kind match', taskKind: 'feature', timestamp: '2026-01-01T00:00:00.000Z' }),
        record({ text: 'fresher kind match', taskKind: 'feature', timestamp: '2026-08-01T00:00:00.000Z' }),
      ],
      { taskKind: 'feature' }
    );
    expect(out).toBe('- older kind match\n- fresher kind match');
  });

  it('decay can never outweigh a genuine relevance signal (a decayed repo match still beats no match)', () => {
    const out = composePriorLearnings(
      [
        record({ text: 'no signal at all', repo: '/other', taskKind: 'docs' }),
        record({ text: 'ancient repo match', repo: '/repo', taskKind: 'docs', timestamp: '2020-01-01T00:00:00.000Z' }),
      ],
      { repo: '/repo', taskKind: 'feature', nowIso: NOW }
    );
    // Both records score 0 on kind/appliesTo/text overlap and neither has taskText here, so the gate
    // is inactive; the ancient repo match (2 − 1 decay = 1) still outranks the zero-signal record (0).
    expect(out).toBe('- ancient repo match\n- no signal at all');
  });

  // Every decay test above uses ages past AGE_DECAY_OLD_DAYS (180d) — the 90-180d STALE band (penalty
  // 0.5) is otherwise never hit, so a regression collapsing AGE_DECAY_STALE_PENALTY to 0, merging the
  // stale/old bands, or swapping the two band checks would pass every existing test.
  it('orders a fresh record above a STALE-band record (~120d, inside 90-180d) once nowIso is supplied', () => {
    const out = composePriorLearnings(
      [
        // Inserted first (older ⇒ lower index) so an index-ascending tie-break — which fires only if
        // the stale penalty regresses to 0 and this record wrongly ties the fresh one — renders it
        // FIRST, contradicting the assertion below and failing the test.
        record({ text: 'stale kind match', taskKind: 'feature', timestamp: '2026-04-06T00:00:00.000Z' }), // ~120d
        record({ text: 'fresh kind match', taskKind: 'feature', timestamp: '2026-07-25T00:00:00.000Z' }), // ~10d
      ],
      { taskKind: 'feature', nowIso: NOW }
    );
    // Fresh (score 1 − 0 = 1) outranks stale (score 1 − 0.5 = 0.5) purely via the stale-band penalty.
    expect(out).toBe('- fresh kind match\n- stale kind match');
  });

  it('ranks fresh, STALE-band (~120d), and OLD-band (~200d) records strictly by their decay band', () => {
    const out = composePriorLearnings(
      [
        // Deliberately inserted oldest→stale→fresh (ascending index = ascending age), the reverse of
        // the asserted render order — any single-band mutation (stale penalty zeroed, old/stale
        // penalties collapsed to the same value, or the two band checks swapped) creates a same-score
        // tie that the ascending-index tie-break then renders in the WRONG order, failing the test.
        record({ text: 'old kind match', taskKind: 'feature', timestamp: '2026-01-16T00:00:00.000Z' }), // ~200d
        record({ text: 'stale kind match', taskKind: 'feature', timestamp: '2026-04-06T00:00:00.000Z' }), // ~120d
        record({ text: 'fresh kind match', taskKind: 'feature', timestamp: '2026-07-25T00:00:00.000Z' }), // ~10d
      ],
      { taskKind: 'feature', nowIso: NOW }
    );
    // fresh (1 − 0 = 1) > stale (1 − 0.5 = 0.5) > old (1 − 1 = 0).
    expect(out).toBe('- fresh kind match\n- stale kind match\n- old kind match');
  });
});
