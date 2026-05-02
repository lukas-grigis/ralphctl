import { describe, expect, it } from 'vitest';

import { Slug } from './slug.ts';

describe('Slug', () => {
  it('accepts simple slugs', () => {
    const r = Slug.parse('hello');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('hello');
  });

  it('accepts slugs with hyphens and digits', () => {
    const r = Slug.parse('build-pipeline-v2');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('build-pipeline-v2');
  });

  it('accepts a single character', () => {
    const r = Slug.parse('x');
    expect(r.ok).toBe(true);
  });

  it('accepts the maximum length (64 chars)', () => {
    const s = 'a'.repeat(64);
    const r = Slug.parse(s);
    expect(r.ok).toBe(true);
  });

  it('rejects empty string', () => {
    const r = Slug.parse('');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe('slug');
      expect(r.error.value).toBe('');
    }
  });

  it('rejects strings longer than 64 chars', () => {
    const s = 'a'.repeat(65);
    const r = Slug.parse(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.field).toBe('slug');
  });

  it('rejects uppercase letters', () => {
    const r = Slug.parse('Hello');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.value).toBe('Hello');
  });

  it('rejects leading hyphen', () => {
    const r = Slug.parse('-foo');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.value).toBe('-foo');
  });

  it('rejects trailing hyphen', () => {
    const r = Slug.parse('foo-');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.value).toBe('foo-');
  });

  it('rejects underscores', () => {
    const r = Slug.parse('foo_bar');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.value).toBe('foo_bar');
  });

  it('rejects spaces', () => {
    const r = Slug.parse('foo bar');
    expect(r.ok).toBe(false);
  });

  it('rejects non-string input', () => {
    const r = Slug.parse(42);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.field).toBe('slug');
      expect(r.error.value).toBe(42);
    }
  });

  it('fromString is an alias of parse for strings', () => {
    const r = Slug.fromString('valid');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('valid');
  });

  it('trustString returns the input as a branded Slug at compile time', () => {
    const s: Slug = Slug.trustString('already-validated');
    expect(s).toBe('already-validated');
  });
});
