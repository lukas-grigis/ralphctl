import { describe, expect, it } from 'vitest';
import { isoTimestamp } from '@tests/fixtures/domain.ts';
import { commitMessageParser } from '@tests/helpers/legacy-signal-parsers/commit-message/parser.ts';

const NOW = isoTimestamp('2026-05-12T11:00:00.000Z');

describe('commitMessageParser', () => {
  it('extracts subject-only commit message', () => {
    const matches = commitMessageParser.parse(
      '<commit-message><subject>add user-id index</subject></commit-message>',
      NOW
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.signal).toEqual({ type: 'commit-message', subject: 'add user-id index', timestamp: NOW });
  });

  it('extracts subject + body, trimmed independently', () => {
    const matches = commitMessageParser.parse(
      `<commit-message>
        <subject>  fix off-by-one  </subject>
        <body>
        The loop terminated one element short — guards the upper bound.

        Follow-up: backfill the regression test.
        </body>
      </commit-message>`,
      NOW
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.signal).toMatchObject({
      type: 'commit-message',
      subject: 'fix off-by-one',
    });
    if (matches[0]?.signal.type === 'commit-message') {
      expect(matches[0].signal.body).toContain('terminated one element short');
      expect(matches[0].signal.body).toContain('Follow-up: backfill the regression test.');
    }
  });

  it('drops the whole match when subject is empty or missing', () => {
    expect(commitMessageParser.parse('<commit-message><subject>   </subject></commit-message>', NOW)).toEqual([]);
    expect(commitMessageParser.parse('<commit-message><body>just a body</body></commit-message>', NOW)).toEqual([]);
  });

  it('omits the body field when only whitespace inside <body>', () => {
    const matches = commitMessageParser.parse(
      '<commit-message><subject>x</subject><body>  </body></commit-message>',
      NOW
    );
    expect(matches).toHaveLength(1);
    if (matches[0]?.signal.type === 'commit-message') {
      expect(matches[0].signal.subject).toBe('x');
      expect(matches[0].signal.body).toBeUndefined();
    }
  });

  it('finds multiple commit-message tags in document order', () => {
    const matches = commitMessageParser.parse(
      '<commit-message><subject>first</subject></commit-message> noise <commit-message><subject>second</subject></commit-message>',
      NOW
    );
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => (m.signal.type === 'commit-message' ? m.signal.subject : ''))).toEqual([
      'first',
      'second',
    ]);
  });
});
