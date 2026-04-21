import { describe, expect, it } from 'vitest';
import { ConfigSchemaDefinition, getAllSchemaEntries, getDefaultValue, getSchemaEntry } from './config-schema.ts';

describe('ConfigSchemaDefinition', () => {
  it('has all expected keys', () => {
    const keys = Object.keys(ConfigSchemaDefinition);
    expect(keys).toContain('currentSprint');
    expect(keys).toContain('aiProvider');
    expect(keys).toContain('evaluationIterations');
    expect(keys).toContain('aiCheckScriptDiscovery');
    expect(keys).toHaveLength(4);
  });

  it('each entry has the required fields', () => {
    for (const entry of Object.values(ConfigSchemaDefinition)) {
      expect(entry).toHaveProperty('key');
      expect(entry).toHaveProperty('type');
      expect(entry).toHaveProperty('default');
      expect(entry).toHaveProperty('description');
      expect(entry).toHaveProperty('validation');
      expect(entry).toHaveProperty('scope');
      expect(typeof entry.key).toBe('string');
      expect(typeof entry.description).toBe('string');
      expect(typeof entry.validation).toBe('function');
    }
  });

  it('each entry key matches its object key', () => {
    for (const [objectKey, entry] of Object.entries(ConfigSchemaDefinition)) {
      expect(entry.key).toBe(objectKey);
    }
  });
});

describe('currentSprint entry', () => {
  const entry = ConfigSchemaDefinition.currentSprint;

  it('has type string', () => {
    expect(entry.type).toBe('string');
  });

  it('has default null', () => {
    expect(entry.default).toBeNull();
  });

  it('has scope global', () => {
    expect(entry.scope).toBe('global');
  });

  describe('validation', () => {
    it('accepts null', () => {
      expect(entry.validation(null)).toBe(true);
    });

    it('accepts a non-empty string', () => {
      expect(entry.validation('20240101-120000-my-sprint')).toBe(true);
    });

    it('rejects an empty string', () => {
      expect(entry.validation('')).toBe(false);
    });

    it('rejects a number', () => {
      expect(entry.validation(42)).toBe(false);
    });

    it('rejects undefined', () => {
      expect(entry.validation(undefined)).toBe(false);
    });
  });
});

describe('aiProvider entry', () => {
  const entry = ConfigSchemaDefinition.aiProvider;

  it('has type enum', () => {
    expect(entry.type).toBe('enum');
  });

  it('has enum values claude and copilot', () => {
    expect(entry.enum).toEqual(['claude', 'copilot']);
  });

  it('has default null', () => {
    expect(entry.default).toBeNull();
  });

  it('has scope global', () => {
    expect(entry.scope).toBe('global');
  });

  describe('validation', () => {
    it('accepts null', () => {
      expect(entry.validation(null)).toBe(true);
    });

    it('accepts claude', () => {
      expect(entry.validation('claude')).toBe(true);
    });

    it('accepts copilot', () => {
      expect(entry.validation('copilot')).toBe(true);
    });

    it('rejects unknown provider', () => {
      expect(entry.validation('other')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(entry.validation('')).toBe(false);
    });

    it('rejects a number', () => {
      expect(entry.validation(1)).toBe(false);
    });
  });
});

describe('evaluationIterations entry', () => {
  const entry = ConfigSchemaDefinition.evaluationIterations;

  it('has type integer', () => {
    expect(entry.type).toBe('integer');
  });

  it('has default 1', () => {
    expect(entry.default).toBe(1);
  });

  it('has min 0', () => {
    expect(entry.min).toBe(0);
  });

  it('has max 10', () => {
    expect(entry.max).toBe(10);
  });

  it('has scope sprint', () => {
    expect(entry.scope).toBe('sprint');
  });

  describe('validation', () => {
    it('accepts 0 (disabled)', () => {
      expect(entry.validation(0)).toBe(true);
    });

    it('accepts 1 (default)', () => {
      expect(entry.validation(1)).toBe(true);
    });

    it('accepts 10 (max)', () => {
      expect(entry.validation(10)).toBe(true);
    });

    it('rejects -1 (below min)', () => {
      expect(entry.validation(-1)).toBe(false);
    });

    it('rejects 11 (above max)', () => {
      expect(entry.validation(11)).toBe(false);
    });

    it('rejects a float', () => {
      expect(entry.validation(1.5)).toBe(false);
    });

    it('rejects null', () => {
      expect(entry.validation(null)).toBe(false);
    });

    it('rejects a string', () => {
      expect(entry.validation('5')).toBe(false);
    });
  });
});

describe('getSchemaEntry', () => {
  it('returns the correct entry for aiProvider', () => {
    const entry = getSchemaEntry('aiProvider');
    expect(entry.key).toBe('aiProvider');
    expect(entry.type).toBe('enum');
  });

  it('returns the correct entry for evaluationIterations', () => {
    const entry = getSchemaEntry('evaluationIterations');
    expect(entry.key).toBe('evaluationIterations');
    expect(entry.type).toBe('integer');
  });
});

describe('getAllSchemaEntries', () => {
  it('returns an array of 4 entries', () => {
    const entries = getAllSchemaEntries();
    expect(entries).toHaveLength(4);
  });

  it('returns entries with the expected keys', () => {
    const entries = getAllSchemaEntries();
    const keys = entries.map((e) => e.key);
    expect(keys).toContain('currentSprint');
    expect(keys).toContain('aiProvider');
    expect(keys).toContain('evaluationIterations');
  });

  it('returns ConfigSchemaEntry objects (each has required fields)', () => {
    for (const entry of getAllSchemaEntries()) {
      expect(entry).toHaveProperty('key');
      expect(entry).toHaveProperty('type');
      expect(entry).toHaveProperty('default');
      expect(entry).toHaveProperty('validation');
      expect(entry).toHaveProperty('scope');
    }
  });
});

describe('getDefaultValue', () => {
  it('returns null for currentSprint', () => {
    expect(getDefaultValue('currentSprint')).toBeNull();
  });

  it('returns null for aiProvider', () => {
    expect(getDefaultValue('aiProvider')).toBeNull();
  });

  it('returns 1 for evaluationIterations', () => {
    expect(getDefaultValue('evaluationIterations')).toBe(1);
  });
});
