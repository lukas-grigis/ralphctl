import { describe, expect, it } from 'vitest';
import { isoTimestamp } from '@tests/fixtures/domain.ts';
import { progressEntryParser } from '@tests/helpers/legacy-signal-parsers/progress-entry/parser.ts';

const NOW = isoTimestamp('2026-05-14T10:00:00.000Z');

describe('progressEntryParser', () => {
  it('extracts the full 4-section block', () => {
    const text = `
<progress-entry>
  <task>Add user-id index</task>
  <files-changed>
    - app/db.ts
    - migrations/0042_index.sql
  </files-changed>
  <learnings>
    sqlite expects explicit pragmas
  </learnings>
  <notes-for-next>
    still need to add the matching ORM mapping
  </notes-for-next>
</progress-entry>
    `;

    const matches = progressEntryParser.parse(text, NOW);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.signal).toEqual({
      type: 'progress-entry',
      task: 'Add user-id index',
      filesChanged: ['app/db.ts', 'migrations/0042_index.sql'],
      learnings: 'sqlite expects explicit pragmas',
      notesForNext: 'still need to add the matching ORM mapping',
      timestamp: NOW,
    });
  });

  it('collapses missing child tags to safe defaults', () => {
    const text = '<progress-entry><task>solo</task></progress-entry>';
    const matches = progressEntryParser.parse(text, NOW);
    expect(matches[0]?.signal).toEqual({
      type: 'progress-entry',
      task: 'solo',
      filesChanged: [],
      learnings: '',
      notesForNext: '',
      timestamp: NOW,
    });
  });

  it('accepts plain (un-bulleted) file lines', () => {
    const text = `<progress-entry><files-changed>
foo.ts
bar.ts
</files-changed></progress-entry>`;
    const matches = progressEntryParser.parse(text, NOW);
    const signal = matches[0]?.signal;
    if (signal?.type !== 'progress-entry') throw new Error('expected progress-entry');
    expect(signal.filesChanged).toEqual(['foo.ts', 'bar.ts']);
  });

  it('accepts asterisk bullets too', () => {
    const text = '<progress-entry><files-changed>* a.ts\n* b.ts</files-changed></progress-entry>';
    const matches = progressEntryParser.parse(text, NOW);
    const signal = matches[0]?.signal;
    if (signal?.type !== 'progress-entry') throw new Error('expected progress-entry');
    expect(signal.filesChanged).toEqual(['a.ts', 'b.ts']);
  });

  it('finds multiple entries in document order', () => {
    const text = '<progress-entry><task>a</task></progress-entry>' + '<progress-entry><task>b</task></progress-entry>';
    const matches = progressEntryParser.parse(text, NOW);
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => (m.signal.type === 'progress-entry' ? m.signal.task : ''))).toEqual(['a', 'b']);
  });

  it('emits an entry even when the body is empty (degenerate but valid)', () => {
    const matches = progressEntryParser.parse('<progress-entry></progress-entry>', NOW);
    expect(matches[0]?.signal).toEqual({
      type: 'progress-entry',
      task: '',
      filesChanged: [],
      learnings: '',
      notesForNext: '',
      timestamp: NOW,
    });
  });
});
