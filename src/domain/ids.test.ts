import { describe, expect, it } from 'vitest';
import { generateSprintId, generateUuid8, slugify } from './ids.ts';

describe('generateUuid8', () => {
  it('generates 8-character hex string', () => {
    const id = generateUuid8();
    expect(id).toMatch(/^[a-f0-9]{8}$/);
  });

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateUuid8()));
    expect(ids.size).toBe(100);
  });
});

describe('slugify', () => {
  it('converts to lowercase', () => {
    expect(slugify('Hello World')).toBe('hello-world');
  });

  it('replaces non-alphanumeric with hyphens', () => {
    expect(slugify('API Refactor 2.0!')).toBe('api-refactor-2-0');
  });

  it('collapses multiple hyphens', () => {
    expect(slugify('foo---bar')).toBe('foo-bar');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugify('---hello---')).toBe('hello');
  });

  it('handles special characters', () => {
    expect(slugify('Q1 2026 / API Work')).toBe('q1-2026-api-work');
  });

  it('truncates long strings', () => {
    const long = 'this-is-a-very-long-sprint-name-that-exceeds-forty-characters';
    const result = slugify(long, 40);
    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).not.toMatch(/-$/); // Should not end with hyphen
  });

  it('returns empty for non-alphanumeric input', () => {
    expect(slugify('---')).toBe('');
    expect(slugify('!!!')).toBe('');
  });
});

describe('generateSprintId', () => {
  it('generates ID with timestamp format', () => {
    const id = generateSprintId('Test Sprint');
    expect(id).toMatch(/^\d{8}-\d{6}-test-sprint$/);
  });

  it('uses uuid8 when no name provided', () => {
    const id = generateSprintId();
    expect(id).toMatch(/^\d{8}-\d{6}-[a-f0-9]{8}$/);
  });

  it('uses uuid8 when name is empty', () => {
    const id = generateSprintId('');
    expect(id).toMatch(/^\d{8}-\d{6}-[a-f0-9]{8}$/);
  });

  it('slugifies the name', () => {
    const id = generateSprintId('API Refactor 2.0');
    expect(id).toMatch(/^\d{8}-\d{6}-api-refactor-2-0$/);
  });

  it('uses uuid8 when name becomes empty after sanitization', () => {
    const id = generateSprintId('---!!!---');
    expect(id).toMatch(/^\d{8}-\d{6}-[a-f0-9]{8}$/);
  });
});
