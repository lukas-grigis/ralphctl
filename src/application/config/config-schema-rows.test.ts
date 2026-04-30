import { describe, it, expect } from 'vitest';
import { CONFIG_ROWS } from './config-schema-rows.ts';
import { CONFIG_DEFAULTS } from './config-defaults.ts';

describe('CONFIG_ROWS', () => {
  it('does not include currentSprint (runtime pointer, not user-configurable)', () => {
    const keys = CONFIG_ROWS.map((r) => r.key);
    expect(keys).not.toContain('currentSprint');
  });

  it('has a row for aiProvider with select kind and options', () => {
    const row = CONFIG_ROWS.find((r) => r.key === 'aiProvider');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('select');
    const values = row?.options?.map((o) => o.value) ?? [];
    expect(values).toContain('claude');
    expect(values).toContain('copilot');
  });

  it('has a row for evaluationIterations with input kind and parse', () => {
    const row = CONFIG_ROWS.find((r) => r.key === 'evaluationIterations');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('input');
    expect(row?.parse).toBeTypeOf('function');
  });

  it('evaluationIterations parse accepts 0 and positive integers', () => {
    const row = CONFIG_ROWS.find((r) => r.key === 'evaluationIterations');
    expect(row?.parse?.('0')).toBe(0);
    expect(row?.parse?.('1')).toBe(1);
    expect(row?.parse?.('5')).toBe(5);
  });

  it('evaluationIterations parse rejects non-integers and negatives', () => {
    const row = CONFIG_ROWS.find((r) => r.key === 'evaluationIterations');
    const bad = row?.parse?.('abc');
    const neg = row?.parse?.('-1');
    // Returns an error message string on failure
    expect(typeof bad).toBe('string');
    expect(typeof neg).toBe('string');
  });

  it('has a row for logLevel with select kind', () => {
    const row = CONFIG_ROWS.find((r) => r.key === 'logLevel');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('select');
    const values = row?.options?.map((o) => o.value) ?? [];
    expect(values).toContain('debug');
    expect(values).toContain('info');
    expect(values).toContain('warn');
    expect(values).toContain('error');
  });

  it('has a row for editor with input kind', () => {
    const row = CONFIG_ROWS.find((r) => r.key === 'editor');
    expect(row).toBeDefined();
    expect(row?.kind).toBe('input');
  });

  it('editor parse returns null for empty string', () => {
    const row = CONFIG_ROWS.find((r) => r.key === 'editor');
    expect(row?.parse?.('')).toBe(null);
    expect(row?.parse?.('  ')).toBe(null);
  });

  it('editor parse returns trimmed string for non-empty input', () => {
    const row = CONFIG_ROWS.find((r) => r.key === 'editor');
    expect(row?.parse?.('vim')).toBe('vim');
    expect(row?.parse?.('  code  ')).toBe('code');
  });

  it('every row key exists in CONFIG_DEFAULTS', () => {
    for (const row of CONFIG_ROWS) {
      expect(Object.prototype.hasOwnProperty.call(CONFIG_DEFAULTS, row.key)).toBe(true);
    }
  });
});
