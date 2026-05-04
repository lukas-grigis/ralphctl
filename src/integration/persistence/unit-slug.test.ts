import { describe, expect, it } from 'vitest';

import { unitSlug } from './unit-slug.ts';

describe('unitSlug', () => {
  it('lowercases ASCII names and joins to id', () => {
    expect(unitSlug('abc12345', 'Hello World')).toBe('abc12345-hello-world');
  });

  it('strips diacritics', () => {
    expect(unitSlug('id', 'Café — Naïve')).toBe('id-cafe-naive');
  });

  it('collapses repeated dashes', () => {
    expect(unitSlug('id', 'a   b   c')).toBe('id-a-b-c');
  });

  it('trims leading and trailing dashes', () => {
    expect(unitSlug('id', '  hello  ')).toBe('id-hello');
  });

  it('caps slug length at 40 chars', () => {
    const longName = 'a'.repeat(80);
    const slug = unitSlug('id', longName);
    // Format: <id>-<slug>; the slug body is capped, the prefix is preserved.
    expect(slug).toBe(`id-${'a'.repeat(40)}`);
  });

  it('cleans a trailing dash left by truncation', () => {
    // 39 a's then one dash falls right at the cap → trim the dash.
    const name = `${'a'.repeat(39)}-extra`;
    const slug = unitSlug('id', name);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('returns just the id when the name is all symbols', () => {
    expect(unitSlug('id', '!!!')).toBe('id');
  });

  it('returns just the id when the name is empty', () => {
    expect(unitSlug('id', '')).toBe('id');
  });

  it('passes through hyphens and digits unchanged', () => {
    expect(unitSlug('full-id-123', 'task-42-go')).toBe('full-id-123-task-42-go');
  });

  it('preserves the full id even when slug is short', () => {
    // Important: id is the collision-safety primitive — never truncate.
    expect(unitSlug('20260504-101010-very-long-sprint-id', 'x')).toBe('20260504-101010-very-long-sprint-id-x');
  });
});
