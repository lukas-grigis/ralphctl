import { describe, expect, it } from 'vitest';
import { extractJsonArray, extractJsonObject } from './json-extract.ts';

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

describe('extractJsonObject', () => {
  it('should extract a simple object', () => {
    const input = '{"key": "value"}';
    const result = extractJsonObject(input);
    expect(result).toBe('{"key": "value"}');
  });

  it('should extract object with surrounding text', () => {
    const input = 'Here is some text before {"key": "value"} and some text after';
    const result = extractJsonObject(input);
    expect(result).toBe('{"key": "value"}');
  });

  it('should extract nested objects', () => {
    const input = '{"a": {"b": {"c": 1}}}';
    const result = extractJsonObject(input);
    expect(result).toBe('{"a": {"b": {"c": 1}}}');
  });

  it('should handle strings containing braces', () => {
    const input = '{"name": "test{1}", "other": "test}2{"}';
    const result = extractJsonObject(input);
    expect(result).toBe('{"name": "test{1}", "other": "test}2{"}');
  });

  it('should handle escaped quotes in strings', () => {
    const input = '{"text": "He said \\"hello\\""}';
    const result = extractJsonObject(input);
    expect(result).toBe('{"text": "He said \\"hello\\""}');
  });

  it('should throw error when no object found', () => {
    const input = 'No object here';
    expect(() => extractJsonObject(input)).toThrow('No JSON object found in output');
  });

  it('should throw error when object is unclosed', () => {
    const input = '{"key": "value"';
    expect(() => extractJsonObject(input)).toThrow('No complete JSON object found in output');
  });

  it('should extract complex nested structure', () => {
    const input = `
      Some preamble text
      {
        "name": "Task 1",
        "steps": ["step1", "step2"],
        "nested": {"a": {"b": 1}},
        "description": "Contains {braces} and \\"quotes\\""
      }
      Some trailing text
    `;
    const result = extractJsonObject(input);
    const parsed = JSON.parse(result) as Record<string, unknown>;
    expect(parsed).toHaveProperty('name', 'Task 1');
    expect(parsed).toHaveProperty('nested');
  });

  it('should extract first object when multiple exist', () => {
    const input = '{"first": true} {"second": true}';
    const result = extractJsonObject(input);
    expect(result).toBe('{"first": true}');
  });
});
