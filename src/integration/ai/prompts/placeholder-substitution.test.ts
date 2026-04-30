import { describe, expect, it } from 'vitest';

import { substitute } from './placeholder-substitution.ts';

describe('substitute', () => {
  it('replaces a single placeholder', () => {
    expect(substitute('Hello, {{NAME}}!', { NAME: 'world' })).toBe('Hello, world!');
  });

  it('replaces multiple distinct keys', () => {
    expect(substitute('{{A}} + {{B}} = {{C}}', { A: '1', B: '2', C: '3' })).toBe('1 + 2 = 3');
  });

  it('replaces every occurrence of the same key', () => {
    expect(substitute('{{X}} {{X}} {{X}}', { X: 'foo' })).toBe('foo foo foo');
  });

  it('leaves unknown placeholders intact (fail-soft)', () => {
    expect(substitute('Known: {{A}} | Unknown: {{B}}', { A: 'ok' })).toBe('Known: ok | Unknown: {{B}}');
  });

  it('replaces with the empty string when the value is empty', () => {
    expect(substitute('start{{GAP}}end', { GAP: '' })).toBe('startend');
  });

  it('does not interpret regex/replacement specials in values', () => {
    // `$&`, `$1`, etc. in a value must not trigger backreference replacement.
    expect(substitute('cost: {{PRICE}}', { PRICE: '$5.00' })).toBe('cost: $5.00');
    expect(substitute('cmd: {{CMD}}', { CMD: 'echo $&' })).toBe('cmd: echo $&');
    expect(substitute('grouped: {{V}}', { V: 'a$1b' })).toBe('grouped: a$1b');
  });

  it('does not match lowercase or hyphenated placeholder names', () => {
    // The contract restricts placeholders to SCREAMING_SNAKE. Anything else
    // is treated as literal text — protects accidental matches like
    // `{{a-b}}` (markdown inline code) from being substituted.
    expect(substitute('{{lowercase}} stays', { lowercase: 'no' })).toBe('{{lowercase}} stays');
    expect(substitute('{{has-dash}} stays', { 'has-dash': 'no' })).toBe('{{has-dash}} stays');
  });

  it('treats explicit undefined the same as absent (does not emit "undefined")', () => {
    // A Record<string, string> can still carry an `undefined` at runtime
    // when assembled from looser sources — guard against rendering the
    // literal string "undefined".
    const values = { A: undefined as unknown as string };
    expect(substitute('A={{A}}', values)).toBe('A={{A}}');
  });

  it('returns the input unchanged when there are no placeholders', () => {
    expect(substitute('plain text', {})).toBe('plain text');
  });

  it('handles values with multiline content', () => {
    expect(substitute('=== {{BODY}} ===', { BODY: 'line1\nline2' })).toBe('=== line1\nline2 ===');
  });
});
