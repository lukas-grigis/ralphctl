/**
 * decisionParser — runaway-match defence contract.
 *
 * The lazy `<decision>([\s\S]*?)</decision>` regex is correct for well-formed input but
 * vulnerable to runaway open tags: if the AI emits a stray `<decision>` inside a
 * `<thinking>` block (or quotes a prompt example that includes the open tag), the next
 * downstream `</decision>` — frequently from a prompt's own example block — closes the
 * match and swallows an arbitrary slab of intermediate prose. The parser drops any match
 * whose body shows runaway indicators (oversized, embedded section headers, multiple code
 * fences); legitimate decisions are accepted unchanged.
 */

import { describe, expect, it } from 'vitest';
import { decisionParser, MAX_DECISION_BODY_CHARS } from '@tests/helpers/legacy-signal-parsers/decision/parser.ts';
import { isoTimestamp } from '@tests/fixtures/domain.ts';

const NOW = isoTimestamp('2026-05-22T10:00:00.000Z');

describe('decisionParser', () => {
  it('accepts a short happy-path decision', () => {
    const text = '<decision>chose option B because it composes with the existing port</decision>';
    const matches = decisionParser.parse(text, NOW);
    expect(matches).toHaveLength(1);
    const match = matches[0];
    if (match === undefined) throw new Error('expected one match');
    expect(match.signal).toMatchObject({
      type: 'decision',
      text: 'chose option B because it composes with the existing port',
      timestamp: NOW,
    });
  });

  it('drops a match whose body exceeds the size cap', () => {
    const body = 'x'.repeat(MAX_DECISION_BODY_CHARS + 1);
    const text = `<decision>${body}</decision>`;
    expect(decisionParser.parse(text, NOW)).toEqual([]);
  });

  it('accepts a match whose body is exactly at the size cap', () => {
    const body = 'x'.repeat(MAX_DECISION_BODY_CHARS);
    const text = `<decision>${body}</decision>`;
    const matches = decisionParser.parse(text, NOW);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.signal.type).toBe('decision');
  });

  it('drops a match whose body contains a `\\n## ` section header (regex swallowed prompt structure)', () => {
    const text = '<decision>chose option B\n## Some prompt heading\nmore body</decision>';
    expect(decisionParser.parse(text, NOW)).toEqual([]);
  });

  it('drops a match whose body contains three or more code fences (>=6 triple backticks)', () => {
    const body = [
      'short rationale',
      '```ts',
      'const x = 1;',
      '```',
      '```ts',
      'const y = 2;',
      '```',
      '```ts',
      'const z = 3;',
      '```',
    ].join('\n');
    const text = `<decision>${body}</decision>`;
    expect(decisionParser.parse(text, NOW)).toEqual([]);
  });

  it('accepts a match with at most one code fence pair (≤5 triple backticks total)', () => {
    // Two triple-backticks (one fence pair) is fine.
    const body = ['rationale below', '```', 'code snippet', '```'].join('\n');
    const text = `<decision>${body}</decision>`;
    const matches = decisionParser.parse(text, NOW);
    expect(matches).toHaveLength(1);
  });

  it('drops the corrupt match but keeps the valid one in document order when both appear', () => {
    const oversized = 'x'.repeat(MAX_DECISION_BODY_CHARS + 1);
    const text = [
      `<decision>${oversized}</decision>`,
      'middle text',
      '<decision>kept this one — short rationale</decision>',
    ].join('\n');

    const matches = decisionParser.parse(text, NOW);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.signal).toMatchObject({
      type: 'decision',
      text: 'kept this one — short rationale',
    });
  });

  it('preserves document order across multiple valid decisions', () => {
    const text = '<decision>first</decision> middle <decision>second</decision>';
    const matches = decisionParser.parse(text, NOW);
    expect(matches).toHaveLength(2);
    const firstIdx = matches[0]?.index ?? -1;
    const secondIdx = matches[1]?.index ?? -1;
    expect(secondIdx).toBeGreaterThan(firstIdx);
  });

  it('skips empty bodies (preserving prior behaviour)', () => {
    const text = '<decision>   </decision>';
    expect(decisionParser.parse(text, NOW)).toEqual([]);
  });
});
