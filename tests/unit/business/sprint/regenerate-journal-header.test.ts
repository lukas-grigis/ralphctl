import { describe, expect, it } from 'vitest';
import { parseJournalCreatedAt, regenerateJournal } from '@src/business/sprint/regenerate-journal-header.ts';

/**
 * `regenerateJournal` is the pure split / regenerate / append compose for the journal write path:
 * the derived header band is rebuilt while the append-only attempt sections ride through verbatim.
 */

const STATE = '# Sprint: demo\n\n- id: s-1\n- created: 2026-06-09T00:00:00.000Z\n\n## Status\n\n- State: active\n';
const sectionA = '\n## Task: a — Attempt 1 · id:id-a\n\n_ts_\n\n- Verdict: pass\n';
const sectionB = '\n## Task: b — Attempt 1 · id:id-b\n\n_ts_\n\n- Verdict: pass\n';

describe('parseJournalCreatedAt', () => {
  it('extracts the created timestamp from a header band', () => {
    expect(parseJournalCreatedAt('# Sprint: x\n\n- id: y\n- created: 2024-01-02T03:04:05.000Z\n')).toBe(
      '2024-01-02T03:04:05.000Z'
    );
  });
  it('returns undefined when no created line is present', () => {
    expect(parseJournalCreatedAt('# Sprint: x\n\n- id: y\n')).toBeUndefined();
  });
});

describe('regenerateJournal', () => {
  it('writes the state header then the new section for a brand-new (empty) file', () => {
    const out = regenerateJournal({ existing: '', stateHeader: STATE, newSection: sectionA });
    expect(out.startsWith('# Sprint: demo')).toBe(true);
    expect(out).toContain('## Task: a — Attempt 1 · id:id-a');
    expect(out.endsWith('\n')).toBe(true);
  });

  it('replaces the header band but preserves prior attempt sections verbatim', () => {
    const existing = regenerateJournal({ existing: '', stateHeader: STATE, newSection: sectionA });
    const next = regenerateJournal({
      existing,
      stateHeader: STATE.replace('active', 'review'),
      newSection: sectionB,
    });
    // Header regenerated.
    expect(next).toContain('- State: review');
    expect(next).not.toContain('- State: active');
    // Both attempt sections present, in order, not duplicated.
    expect((next.match(/^## Task: /gm) ?? []).length).toBe(2);
    const aIdx = next.indexOf('## Task: a');
    const bIdx = next.indexOf('## Task: b');
    expect(aIdx).toBeGreaterThan(-1);
    expect(bIdx).toBeGreaterThan(aIdx);
  });

  it('carries forward lifecycle breadcrumbs from the old header band (status separators)', () => {
    const existing = `${STATE}\n---\n\n_Sprint activated at 2026-06-09T00:00:00.000Z_\n${sectionA}`;
    const out = regenerateJournal({ existing, stateHeader: STATE, newSection: sectionB });
    expect(out).toContain('_Sprint activated at 2026-06-09T00:00:00.000Z_');
    // The separator is NOT duplicated on a second regenerate (idempotent breadcrumb carry).
    const again = regenerateJournal({ existing: out, stateHeader: STATE, newSection: sectionB });
    expect((again.match(/_Sprint activated at/g) ?? []).length).toBe(1);
  });

  it('is idempotent on shape — re-running over its own output keeps one section per attempt', () => {
    const once = regenerateJournal({ existing: '', stateHeader: STATE, newSection: sectionA });
    const twice = regenerateJournal({ existing: once, stateHeader: STATE, newSection: sectionB });
    const thrice = regenerateJournal({ existing: twice, stateHeader: STATE, newSection: sectionA });
    expect((thrice.match(/^## Task: /gm) ?? []).length).toBe(3);
  });
});
