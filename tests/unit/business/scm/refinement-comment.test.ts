import { describe, expect, it } from 'vitest';
import { refinementCommentBody } from '@src/business/scm/refinement-comment.ts';

const MARKER = '<!-- ralphctl:refined-requirements -->';

describe('refinementCommentBody', () => {
  it('is the requirements, a blank line, and the marker', () => {
    expect(refinementCommentBody('## Acceptance\n- column foo exists')).toBe(
      `## Acceptance\n- column foo exists\n\n${MARKER}`
    );
  });

  it('empty requirements stay empty plus the marker', () => {
    expect(refinementCommentBody('')).toBe(`\n\n${MARKER}`);
  });

  it('does not add a sprint id or a timestamp', () => {
    const body = refinementCommentBody('keep me');
    expect(body).toBe(`keep me\n\n${MARKER}`);
    expect(body).not.toMatch(/sprint/i);
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
