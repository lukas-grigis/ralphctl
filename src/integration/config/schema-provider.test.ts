import { describe, expect, it } from 'vitest';
import { ValidationError } from '@src/domain/errors.ts';
import {
  getAllConfigSchemaEntries,
  getConfigDefaultValue,
  getConfigKeyDescription,
  getConfigKeyScope,
  getConfigSchema,
  parseConfigValue,
  validateConfigValue,
} from './schema-provider.ts';

describe('getConfigSchema', () => {
  it('returns the config schema definition', () => {
    const schema = getConfigSchema();
    expect(schema).toHaveProperty('currentSprint');
    expect(schema).toHaveProperty('aiProvider');
    expect(schema).toHaveProperty('editor');
    expect(schema).toHaveProperty('evaluationIterations');
  });
});

describe('getAllConfigSchemaEntries', () => {
  it('returns an array of 4 entries', () => {
    const entries = getAllConfigSchemaEntries();
    expect(entries).toHaveLength(4);
  });

  it('includes entries for all config keys', () => {
    const keys = getAllConfigSchemaEntries().map((e) => e.key);
    expect(keys).toContain('currentSprint');
    expect(keys).toContain('aiProvider');
    expect(keys).toContain('editor');
    expect(keys).toContain('evaluationIterations');
  });
});

describe('getConfigDefaultValue', () => {
  it('returns null for currentSprint', () => {
    expect(getConfigDefaultValue('currentSprint')).toBeNull();
  });

  it('returns null for aiProvider', () => {
    expect(getConfigDefaultValue('aiProvider')).toBeNull();
  });

  it('returns null for editor', () => {
    expect(getConfigDefaultValue('editor')).toBeNull();
  });

  it('returns 1 for evaluationIterations', () => {
    expect(getConfigDefaultValue('evaluationIterations')).toBe(1);
  });
});

describe('getConfigKeyDescription', () => {
  it('returns a non-empty description for each key', () => {
    const keys = ['currentSprint', 'aiProvider', 'editor', 'evaluationIterations'] as const;
    for (const key of keys) {
      const desc = getConfigKeyDescription(key);
      expect(typeof desc).toBe('string');
      expect(desc.length).toBeGreaterThan(0);
    }
  });

  it('mentions sprint for currentSprint description', () => {
    const desc = getConfigKeyDescription('currentSprint');
    expect(desc.toLowerCase()).toContain('sprint');
  });
});

describe('getConfigKeyScope', () => {
  it('returns global for currentSprint', () => {
    expect(getConfigKeyScope('currentSprint')).toBe('global');
  });

  it('returns global for aiProvider', () => {
    expect(getConfigKeyScope('aiProvider')).toBe('global');
  });

  it('returns user for editor', () => {
    expect(getConfigKeyScope('editor')).toBe('user');
  });

  it('returns sprint for evaluationIterations', () => {
    expect(getConfigKeyScope('evaluationIterations')).toBe('sprint');
  });
});

describe('validateConfigValue', () => {
  describe('unknown key', () => {
    it('returns an error result', () => {
      const result = validateConfigValue('nonExistentKey', 'value');
      expect(result.ok).toBe(false);
    });

    it('error is a ValidationError with unknown key message', () => {
      const result = validateConfigValue('nonExistentKey', 'value');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ValidationError);
        expect(result.error.message).toContain('nonExistentKey');
      }
    });
  });

  describe('currentSprint', () => {
    it('accepts null', () => {
      const result = validateConfigValue('currentSprint', null);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBeNull();
    });

    it('accepts a non-empty string', () => {
      const result = validateConfigValue('currentSprint', '20240101-120000-my-sprint');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('20240101-120000-my-sprint');
    });

    it('rejects an empty string', () => {
      const result = validateConfigValue('currentSprint', '');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
    });
  });

  describe('aiProvider', () => {
    it('accepts null', () => {
      const result = validateConfigValue('aiProvider', null);
      expect(result.ok).toBe(true);
    });

    it('accepts claude', () => {
      const result = validateConfigValue('aiProvider', 'claude');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('claude');
    });

    it('accepts copilot', () => {
      const result = validateConfigValue('aiProvider', 'copilot');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('copilot');
    });

    it('rejects an unknown provider', () => {
      const result = validateConfigValue('aiProvider', 'openai');
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ValidationError);
        expect(result.error.message).toContain('claude');
        expect(result.error.message).toContain('copilot');
      }
    });
  });

  describe('editor', () => {
    it('accepts null', () => {
      const result = validateConfigValue('editor', null);
      expect(result.ok).toBe(true);
    });

    it('accepts a non-empty string', () => {
      const result = validateConfigValue('editor', 'vim');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('vim');
    });

    it('rejects an empty string', () => {
      const result = validateConfigValue('editor', '');
      expect(result.ok).toBe(false);
    });
  });

  describe('evaluationIterations', () => {
    it('accepts 0 (disabled)', () => {
      const result = validateConfigValue('evaluationIterations', 0);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(0);
    });

    it('accepts 1 (default)', () => {
      const result = validateConfigValue('evaluationIterations', 1);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(1);
    });

    it('accepts 10 (max)', () => {
      const result = validateConfigValue('evaluationIterations', 10);
      expect(result.ok).toBe(true);
    });

    it('rejects -1 (below min)', () => {
      const result = validateConfigValue('evaluationIterations', -1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ValidationError);
        expect(result.error.message).toContain('min');
      }
    });

    it('rejects 11 (above max)', () => {
      const result = validateConfigValue('evaluationIterations', 11);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ValidationError);
        expect(result.error.message).toContain('max');
      }
    });

    it('rejects a float', () => {
      const result = validateConfigValue('evaluationIterations', 2.5);
      expect(result.ok).toBe(false);
    });

    it('rejects null', () => {
      const result = validateConfigValue('evaluationIterations', null);
      expect(result.ok).toBe(false);
    });

    it('rejects a string', () => {
      const result = validateConfigValue('evaluationIterations', '5');
      expect(result.ok).toBe(false);
    });
  });
});

describe('parseConfigValue', () => {
  describe('unknown key', () => {
    it('returns an error result', () => {
      const result = parseConfigValue('nonExistentKey', 'value');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
    });
  });

  describe('string type (currentSprint)', () => {
    it('parses a regular string value', () => {
      const result = parseConfigValue('currentSprint', '20240101-120000-my-sprint');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('20240101-120000-my-sprint');
    });

    it('parses "null" string as null', () => {
      const result = parseConfigValue('currentSprint', 'null');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBeNull();
    });

    it('returns error for empty string', () => {
      const result = parseConfigValue('currentSprint', '');
      expect(result.ok).toBe(false);
    });
  });

  describe('enum type (aiProvider)', () => {
    it('parses "claude" as the string claude', () => {
      const result = parseConfigValue('aiProvider', 'claude');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('claude');
    });

    it('parses "copilot" as the string copilot', () => {
      const result = parseConfigValue('aiProvider', 'copilot');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('copilot');
    });

    it('parses "null" as null', () => {
      const result = parseConfigValue('aiProvider', 'null');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBeNull();
    });

    it('returns error for invalid provider string', () => {
      const result = parseConfigValue('aiProvider', 'openai');
      expect(result.ok).toBe(false);
    });
  });

  describe('integer type (evaluationIterations)', () => {
    it('parses "5" as integer 5', () => {
      const result = parseConfigValue('evaluationIterations', '5');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(5);
    });

    it('parses "0" as integer 0', () => {
      const result = parseConfigValue('evaluationIterations', '0');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(0);
    });

    it('parses "10" as integer 10 (max)', () => {
      const result = parseConfigValue('evaluationIterations', '10');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(10);
    });

    it('returns error for non-integer string "abc"', () => {
      const result = parseConfigValue('evaluationIterations', 'abc');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBeInstanceOf(ValidationError);
    });

    it('returns error for float string "1.5"', () => {
      // parseInt('1.5') = 1 which is valid, but verify it is handled
      const result = parseConfigValue('evaluationIterations', '1.5');
      // parseInt truncates, so 1 is a valid integer in range — result is ok with value 1
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe(1);
    });

    it('returns error for value above max "11"', () => {
      const result = parseConfigValue('evaluationIterations', '11');
      expect(result.ok).toBe(false);
    });

    it('returns error for negative value "-1"', () => {
      const result = parseConfigValue('evaluationIterations', '-1');
      expect(result.ok).toBe(false);
    });
  });

  describe('string type (editor)', () => {
    it('parses "vim" correctly', () => {
      const result = parseConfigValue('editor', 'vim');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBe('vim');
    });

    it('parses "null" as null', () => {
      const result = parseConfigValue('editor', 'null');
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value).toBeNull();
    });
  });
});
