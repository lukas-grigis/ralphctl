/**
 * Unit tests for `renderJournalEntry` — the pure formatter that produces one task-attempt
 * section appended to `<sprintDir>/progress.md`.
 *
 * The renderer is intentionally dumb: it emits exactly what it's given. Dedupe and trim run
 * at the leaf-call site. These tests cover:
 *  - metadata block shape (heading, verdict, round, duration, commit)
 *  - signal subsections render in the documented order (Changes / Decisions / Learnings / Notes)
 *  - empty signal lists drop their heading entirely (no orphan `### Foo` lines)
 *  - all four lists empty → only the metadata block renders (regression for the confetti-task
 *    follow-up complaint)
 */

import { describe, expect, it } from 'vitest';
import { type JournalEntryInput, renderJournalEntry } from '@src/business/sprint/render-journal-entry.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';

const baseInput = (overrides: Partial<JournalEntryInput> = {}): JournalEntryInput => ({
  taskName: 'export-csv',
  attemptN: 1,
  verdict: 'pass',
  outcome: 'Task completed successfully.',
  roundN: 1,
  totalRounds: 5,
  durationMs: 1500,
  changes: [],
  decisions: [],
  learnings: [],
  notes: [],
  timestamp: isoTimestamp('2026-05-22T10:00:00.000Z'),
  ...overrides,
});

describe('renderJournalEntry', () => {
  it('renders the metadata block (heading + verdict / round / duration / commit)', () => {
    const out = renderJournalEntry(baseInput({ commitSha: 'abcdef1234567890' }));
    expect(out).toContain('## Task: export-csv — Attempt 1');
    expect(out).toContain('_2026-05-22T10:00:00.000Z_');
    expect(out).toContain('Task completed successfully.');
    expect(out).toContain('- Verdict: pass');
    expect(out).toContain('- Round: round 1 of 5');
    expect(out).toContain('- Duration: 1s');
    // SHA truncated to 7 chars.
    expect(out).toContain('- Commit: abcdef1');
  });

  it('renders em-dash for a missing commit sha', () => {
    const out = renderJournalEntry(baseInput());
    expect(out).toContain('- Commit: —');
  });

  it('renders all four signal subsections in the documented order when populated', () => {
    const out = renderJournalEntry(
      baseInput({
        changes: ['added foo.ts'],
        decisions: ['use json on-disk'],
        learnings: [{ text: 'providers differ on flags' }],
        notes: ['follow-up: tighten retry log'],
      })
    );
    expect(out).toContain('### Changes');
    expect(out).toContain('- added foo.ts');
    expect(out).toContain('### Decisions');
    expect(out).toContain('- use json on-disk');
    expect(out).toContain('### Learnings');
    expect(out).toContain('- **providers differ on flags**');
    expect(out).toContain('### Notes');
    expect(out).toContain('- follow-up: tighten retry log');
    // Order: Changes < Decisions < Learnings < Notes.
    const idxChanges = out.indexOf('### Changes');
    const idxDecisions = out.indexOf('### Decisions');
    const idxLearnings = out.indexOf('### Learnings');
    const idxNotes = out.indexOf('### Notes');
    expect(idxChanges).toBeLessThan(idxDecisions);
    expect(idxDecisions).toBeLessThan(idxLearnings);
    expect(idxLearnings).toBeLessThan(idxNotes);
  });

  it('renders a learning with Context and Applies-to as indented sub-bullets', () => {
    const out = renderJournalEntry(
      baseInput({
        learnings: [
          { text: 'prefer the injected port', context: 'adding a CLI prompt', appliesTo: 'src/application/ui' },
        ],
      })
    );
    expect(out).toContain('- **prefer the injected port**');
    expect(out).toContain('  - Context: adding a CLI prompt');
    expect(out).toContain('  - Applies to: src/application/ui');
  });

  it('renders an insight-only learning (no Context / Applies-to sub-bullets)', () => {
    const out = renderJournalEntry(baseInput({ learnings: [{ text: 'run the verify gate before committing' }] }));
    expect(out).toContain('- **run the verify gate before committing**');
    expect(out).not.toContain('  - Context:');
    expect(out).not.toContain('  - Applies to:');
  });

  it('omits a subsection entirely when its list is empty (no orphan heading-with-no-bullets)', () => {
    const out = renderJournalEntry(
      baseInput({
        changes: ['added foo.ts'],
        decisions: [],
        learnings: [],
        notes: ['follow-up'],
      })
    );
    expect(out).toContain('### Changes');
    expect(out).toContain('### Notes');
    expect(out).not.toContain('### Decisions');
    expect(out).not.toContain('### Learnings');
  });

  it('all four lists empty → only the metadata block renders (confetti-task regression)', () => {
    // Wave-7 follow-up: the original "slim cut" rendered `- Decisions: <count>` for an
    // empty attempt, which surfaced a spurious zero. Subsection-based output drops every
    // empty list — the operator sees the metadata bullets and nothing else.
    const out = renderJournalEntry(baseInput());
    expect(out).toContain('## Task: export-csv — Attempt 1');
    expect(out).toContain('- Verdict: pass');
    expect(out).not.toContain('### Changes');
    expect(out).not.toContain('### Decisions');
    expect(out).not.toContain('### Learnings');
    expect(out).not.toContain('### Notes');
  });

  it('emits multiple bullets verbatim under a single subsection', () => {
    const out = renderJournalEntry(
      baseInput({
        changes: ['first', 'second', 'third'],
      })
    );
    const block = out.slice(out.indexOf('### Changes'));
    const bullets = block.split('\n').filter((line) => line.startsWith('- '));
    expect(bullets).toEqual(['- first', '- second', '- third']);
  });

  it('renders the blocked verdict and the blocked-reason outcome paragraph', () => {
    const out = renderJournalEntry(
      baseInput({
        verdict: 'blocked',
        outcome: 'Blocked: pre-existing test failure',
      })
    );
    expect(out).toContain('- Verdict: blocked');
    expect(out).toContain('Blocked: pre-existing test failure');
  });

  it('a clean pass entry omits the Outcome detail subsection entirely (no regression)', () => {
    const out = renderJournalEntry(baseInput());
    expect(out).toContain('- Verdict: pass');
    expect(out).not.toContain('### Outcome detail');
    expect(out).not.toContain('Remedy:');
  });

  it('renders pass-with-warning + plateau dimensions in the Outcome detail prose', () => {
    const out = renderJournalEntry(
      baseInput({
        verdict: 'pass-with-warning',
        warning: { kind: 'plateau', dimensions: ['C1', 'C3'] },
      })
    );
    expect(out).toContain('- Verdict: pass-with-warning');
    expect(out).toContain('### Outcome detail');
    expect(out).toContain('plateaued');
    expect(out).toContain('C1, C3');
    // No escalation supplied → the remedy is the "kept with warning" sentence.
    expect(out).toContain('Remedy: kept the attempt with the warning attached');
  });

  it('renders budget-exhausted turn counts in the Outcome detail prose', () => {
    const out = renderJournalEntry(
      baseInput({
        verdict: 'pass-with-warning',
        warning: { kind: 'budget-exhausted', turnsUsed: 5, turnBudget: 5 },
      })
    );
    expect(out).toContain('### Outcome detail');
    expect(out).toContain('did not pass');
    expect(out).toContain('5 of 5 turns used');
  });

  it('renders the escalated verdict and a model-rung climb as the remedy', () => {
    const out = renderJournalEntry(
      baseInput({
        verdict: 'escalated',
        warning: { kind: 'plateau', dimensions: ['C2'] },
        escalation: { from: 'sonnet', to: 'opus' },
      })
    );
    expect(out).toContain('- Verdict: escalated');
    expect(out).toContain('### Outcome detail');
    expect(out).toContain('Remedy: escalated the generator model from sonnet to opus');
  });

  it('states a top-of-ladder same-model retry explicitly when from === to', () => {
    const out = renderJournalEntry(
      baseInput({
        verdict: 'escalated',
        warning: { kind: 'malformed', detail: 'no verdict signal' },
        escalation: { from: 'opus', to: 'opus' },
      })
    );
    expect(out).toContain('### Outcome detail');
    expect(out).toContain('could not be parsed');
    expect(out).toContain('no verdict signal');
    expect(out).toContain('Remedy: retried the same model (opus) — already at the top');
  });

  it('renders verify-failed detail in the Outcome detail prose', () => {
    const out = renderJournalEntry(
      baseInput({
        verdict: 'pass-with-warning',
        warning: { kind: 'verify-failed', detail: 'exit 1 — 2 tests failed' },
      })
    );
    expect(out).toContain('### Outcome detail');
    expect(out).toContain('verify script ran red');
    expect(out).toContain('exit 1 — 2 tests failed');
  });
});
