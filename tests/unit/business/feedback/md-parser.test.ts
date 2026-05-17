import { describe, expect, it } from 'vitest';
import {
  isEmptyRound,
  isTerminationRound,
  MARKER_COMMENT,
  parseFeedbackMd,
  renderEmptyRound,
} from '@src/business/feedback/md-parser.ts';

describe('parseFeedbackMd', () => {
  it('returns empty list on a fully blank file', () => {
    expect(parseFeedbackMd('')).toEqual([]);
    expect(parseFeedbackMd('\n\n  \n')).toEqual([]);
  });

  it('parses a single empty round (just heading + marker)', () => {
    const text = `# Feedback

## Round 1

${MARKER_COMMENT}

---
`;
    const rounds = parseFeedbackMd(text);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.index).toBe(1);
    expect(rounds[0]?.body).toBe('');
  });

  it('parses round body verbatim', () => {
    const text = `## Round 1

${MARKER_COMMENT}
fix the foo bug in baz.ts
add an integration test for empty input
---
`;
    const rounds = parseFeedbackMd(text);
    expect(rounds[0]?.body).toBe('fix the foo bug in baz.ts\nadd an integration test for empty input');
  });

  it('parses multiple rounds in order', () => {
    const text = `## Round 1

${MARKER_COMMENT}
first feedback
---

## Round 2

${MARKER_COMMENT}
second feedback
---
`;
    const rounds = parseFeedbackMd(text);
    expect(rounds.map((r) => r.index)).toEqual([1, 2]);
    expect(rounds[0]?.body).toBe('first feedback');
    expect(rounds[1]?.body).toBe('second feedback');
  });

  it('drops blocks without a Round heading', () => {
    const text = `# Feedback

just narrative, no round heading
---
## Round 1

${MARKER_COMMENT}
real feedback
---
`;
    const rounds = parseFeedbackMd(text);
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.body).toBe('real feedback');
  });

  it('ignores text written above the marker comment when marker is present', () => {
    const text = `## Round 1

stray-line-above
${MARKER_COMMENT}
real body
---
`;
    const rounds = parseFeedbackMd(text);
    expect(rounds[0]?.body).toContain('real body');
  });
});

describe('isEmptyRound', () => {
  it('true on empty body', () => {
    expect(isEmptyRound({ index: 1, body: '', raw: '' })).toBe(true);
  });
  it('false on non-empty body', () => {
    expect(isEmptyRound({ index: 1, body: 'x', raw: '' })).toBe(false);
  });
});

describe('isTerminationRound', () => {
  it('terminates on empty current', () => {
    expect(isTerminationRound({ index: 2, body: '', raw: '' }, { index: 1, body: 'a', raw: '' })).toBe(true);
  });
  it('terminates on current==previous body (user re-saved unchanged)', () => {
    expect(isTerminationRound({ index: 2, body: 'a', raw: '' }, { index: 1, body: 'a', raw: '' })).toBe(true);
  });
  it('does not terminate on a different body', () => {
    expect(isTerminationRound({ index: 2, body: 'b', raw: '' }, { index: 1, body: 'a', raw: '' })).toBe(false);
  });
  it('does not terminate on first non-empty round', () => {
    expect(isTerminationRound({ index: 1, body: 'a', raw: '' }, undefined)).toBe(false);
  });
});

describe('renderEmptyRound', () => {
  it('renders a heading + marker block', () => {
    const out = renderEmptyRound(3);
    expect(out).toContain('## Round 3');
    expect(out).toContain(MARKER_COMMENT);
  });
});
