/**
 * `parseEvaluationMarkdown` — the tolerant `evaluation.md` → panel-model parser.
 *
 * The file is AI-adjacent output rendered by `renderEvaluationMarkdown` and then left on disk
 * for an arbitrary length of time, so the parser must never throw and never fabricate a verdict:
 * an unreadable heading degrades to `unknown`, not to `failed`.
 */

import { describe, expect, it } from 'vitest';
import { parseEvaluationMarkdown } from '@src/business/task/parse-evaluation-md.ts';

const CANONICAL = [
  '# Evaluation — failed',
  '',
  '_2026-08-17T09:15:00.000Z_',
  '',
  '## Critique',
  '',
  'The migration path is not covered by a test.',
  '',
  '## Dimensions',
  '',
  '### correctness — passed',
  '',
  'Logic matches the acceptance criteria.',
  '',
  '### tests — failed',
  '',
  'No regression test for the legacy row.',
  '',
  '```',
  'FAIL tests/unit/foo.test.ts',
  '  1 failed',
  '```',
  '',
  '### docs — n/a',
  '',
  'No documentation surface in scope.',
  '',
].join('\n');

describe('parseEvaluationMarkdown — canonical document', () => {
  it('reads status, timestamp, critique and every dimension', () => {
    const parsed = parseEvaluationMarkdown(CANONICAL);
    expect(parsed.status).toBe('failed');
    expect(parsed.timestamp).toBe('2026-08-17T09:15:00.000Z');
    expect(parsed.critique).toBe('The migration path is not covered by a test.');
    expect(parsed.dimensions.map((d) => d.dimension)).toEqual(['correctness', 'tests', 'docs']);
    expect(parsed.dimensions.map((d) => d.verdict)).toEqual(['passed', 'failed', 'n/a']);
  });

  it('keeps the finding prose separate from the fenced execution evidence', () => {
    const parsed = parseEvaluationMarkdown(CANONICAL);
    const tests = parsed.dimensions.find((d) => d.dimension === 'tests');
    expect(tests?.finding).toBe('No regression test for the legacy row.');
    expect(tests?.evidence).toBe('FAIL tests/unit/foo.test.ts\n  1 failed');
  });

  it('omits evidence for a dimension that has none', () => {
    const parsed = parseEvaluationMarkdown(CANONICAL);
    expect(parsed.dimensions.find((d) => d.dimension === 'correctness')?.evidence).toBeUndefined();
  });
});

describe('parseEvaluationMarkdown — missing sections', () => {
  it('handles a document with no critique section', () => {
    const parsed = parseEvaluationMarkdown(
      ['# Evaluation — passed', '', '_ts_', '', '## Dimensions', '', '### correctness — passed', ''].join('\n')
    );
    expect(parsed.status).toBe('passed');
    expect(parsed.critique).toBeUndefined();
    expect(parsed.dimensions).toHaveLength(1);
  });

  it('handles a document with no dimensions section', () => {
    const parsed = parseEvaluationMarkdown(
      ['# Evaluation — malformed', '', '_ts_', '', '## Critique', '', 'Could not parse the output.', ''].join('\n')
    );
    expect(parsed.status).toBe('malformed');
    expect(parsed.critique).toBe('Could not parse the output.');
    expect(parsed.dimensions).toEqual([]);
  });

  it('leaves the finding empty when a dimension carries only a heading', () => {
    const parsed = parseEvaluationMarkdown(
      ['# Evaluation — failed', '', '## Dimensions', '', '### style — failed', ''].join('\n')
    );
    expect(parsed.dimensions[0]).toEqual({ dimension: 'style', verdict: 'failed', finding: '' });
  });

  it('ignores unknown `##` sections', () => {
    const parsed = parseEvaluationMarkdown(
      ['# Evaluation — passed', '', '## Notes', '', 'irrelevant', '', '## Dimensions', '', '### a — passed', ''].join(
        '\n'
      )
    );
    expect(parsed.dimensions.map((d) => d.dimension)).toEqual(['a']);
    expect(parsed.critique).toBeUndefined();
  });
});

describe('parseEvaluationMarkdown — malformed input never fabricates a verdict', () => {
  it('reports `unknown` status when the heading is absent', () => {
    const parsed = parseEvaluationMarkdown(['## Dimensions', '', '### a — failed', '', 'nope', ''].join('\n'));
    expect(parsed.status).toBe('unknown');
    expect(parsed.dimensions).toHaveLength(1);
  });

  it('reports `unknown` status when the heading verdict word is garbage', () => {
    expect(parseEvaluationMarkdown('# Evaluation — ¯\\_(ツ)_/¯').status).toBe('unknown');
  });

  it('marks a dimension verdict `unknown` rather than guessing when the heading has no verdict', () => {
    const parsed = parseEvaluationMarkdown(
      ['# Evaluation — failed', '', '## Dimensions', '', '### tests', ''].join('\n')
    );
    expect(parsed.dimensions[0]?.dimension).toBe('tests');
    expect(parsed.dimensions[0]?.verdict).toBe('unknown');
  });

  it('treats an unterminated fence as evidence running to the end of the section', () => {
    const parsed = parseEvaluationMarkdown(
      ['# Evaluation — failed', '', '## Dimensions', '', '### tests — failed', '', '```', 'boom', ''].join('\n')
    );
    expect(parsed.dimensions[0]?.evidence).toBe('boom');
  });

  it('does not split a dimension on a `###` line inside its fenced evidence', () => {
    const parsed = parseEvaluationMarkdown(
      [
        '# Evaluation — failed',
        '',
        '## Dimensions',
        '',
        '### tests — failed',
        '',
        '```',
        '### not a heading',
        '```',
        '',
      ].join('\n')
    );
    expect(parsed.dimensions).toHaveLength(1);
    expect(parsed.dimensions[0]?.evidence).toBe('### not a heading');
  });

  it('keeps `---` rules and `###` lines inside a critique body', () => {
    const parsed = parseEvaluationMarkdown(
      ['# Evaluation — failed', '', '## Critique', '', 'before', '---', '### inline', 'after', ''].join('\n')
    );
    expect(parsed.critique).toBe('before\n---\n### inline\nafter');
  });

  /**
   * `.` never matches `\r`, so every `$`-anchored heading regex misses on a CRLF document. Left
   * unhandled that collapsed a perfectly well-formed file to `status: 'unknown'` with zero
   * sections — the overlay's raw-file fallback, for a file it should have parsed exactly.
   */
  it('parses a CRLF document identically to its LF twin', () => {
    const lf = [
      '# Evaluation — failed',
      '',
      '_2026-08-17T09:15:00.000Z_',
      '',
      '## Critique',
      '',
      'the legacy row is untested',
      '',
      '## Dimensions',
      '',
      '### correctness — passed',
      '',
      'matches the criteria',
      '',
    ].join('\n');
    expect(parseEvaluationMarkdown(lf.replace(/\n/g, '\r\n'))).toEqual(parseEvaluationMarkdown(lf));
    expect(parseEvaluationMarkdown(lf.replace(/\n/g, '\r\n')).status).toBe('failed');
  });

  it('returns an empty model for empty / non-markdown input without throwing', () => {
    for (const text of ['', '   \n\n  ', '<html><body>nope</body></html>', 'null']) {
      const parsed = parseEvaluationMarkdown(text);
      expect(parsed.status).toBe('unknown');
      expect(parsed.dimensions).toEqual([]);
      expect(parsed.critique).toBeUndefined();
    }
  });
});
