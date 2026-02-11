import { describe, it, expect } from 'vitest';
import { extractJsonArray } from './json-extract.ts';

describe('extractJsonArray', () => {
  it('should extract a simple array', () => {
    const input = '[1, 2, 3]';
    const result = extractJsonArray(input);
    expect(result).toBe('[1, 2, 3]');
  });

  it('should extract array with surrounding text', () => {
    const input = 'Here is some text before [1, 2, 3] and some text after';
    const result = extractJsonArray(input);
    expect(result).toBe('[1, 2, 3]');
  });

  it('should extract nested arrays', () => {
    const input = '[[1, 2], [3, 4]]';
    const result = extractJsonArray(input);
    expect(result).toBe('[[1, 2], [3, 4]]');
  });

  it('should handle strings containing brackets', () => {
    const input = '[{"name": "test[1]"}, {"name": "test]2["}]';
    const result = extractJsonArray(input);
    expect(result).toBe('[{"name": "test[1]"}, {"name": "test]2["}]');
  });

  it('should handle escaped quotes in strings', () => {
    const input = '[{"text": "He said \\"hello\\""}]';
    const result = extractJsonArray(input);
    expect(result).toBe('[{"text": "He said \\"hello\\""}]');
  });

  it('should throw error when no array found', () => {
    const input = 'No array here';
    expect(() => extractJsonArray(input)).toThrow('No JSON array found in output');
  });

  it('should throw error when array is unclosed', () => {
    const input = '[1, 2, 3';
    expect(() => extractJsonArray(input)).toThrow('No complete JSON array found in output');
  });

  it('should extract complex nested structure', () => {
    const input = `
      Some preamble text
      [
        {
          "name": "Task 1",
          "steps": ["step1", "step2"],
          "description": "Contains [brackets] and \\"quotes\\""
        },
        {
          "name": "Task 2",
          "nested": [[1, 2], [3, 4]]
        }
      ]
      Some trailing text
    `;
    const result = extractJsonArray(input);
    const parsed = JSON.parse(result) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
  });
});
