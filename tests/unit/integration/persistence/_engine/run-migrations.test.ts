import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MigrationGapError } from '@src/domain/value/error/migration-gap-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { readSchemaVersion, runMigrations } from '@src/integration/persistence/_engine/run-migrations.ts';

const SAMPLE_PATH = '/tmp/sample.json';

const targetSchema = z.object({
  schemaVersion: z.literal(2),
  name: z.string(),
  flags: z.array(z.string()),
});

describe('readSchemaVersion', () => {
  it('returns 0 when the field is missing', () => {
    expect(readSchemaVersion({ name: 'x' })).toBe(0);
  });
  it('returns 0 for non-object inputs', () => {
    expect(readSchemaVersion(null)).toBe(0);
    expect(readSchemaVersion(undefined)).toBe(0);
    expect(readSchemaVersion('string')).toBe(0);
  });
  it('returns the field value when present and a non-negative integer', () => {
    expect(readSchemaVersion({ schemaVersion: 1 })).toBe(1);
    expect(readSchemaVersion({ schemaVersion: 5 })).toBe(5);
  });
  it('returns 0 for malformed values (negative, float, non-number)', () => {
    expect(readSchemaVersion({ schemaVersion: -1 })).toBe(0);
    expect(readSchemaVersion({ schemaVersion: 1.5 })).toBe(0);
    expect(readSchemaVersion({ schemaVersion: 'one' })).toBe(0);
  });
});

describe('runMigrations', () => {
  it('walks the chain v0 → v1 → v2 and parses against the schema', () => {
    const migrations = {
      0: (raw: unknown): unknown => ({ ...(raw as Record<string, unknown>), name: 'fromV0' }),
      1: (raw: unknown): unknown => ({ ...(raw as Record<string, unknown>), schemaVersion: 2, flags: [] }),
    };
    const result = runMigrations({ schemaVersion: 0 }, 2, migrations, targetSchema, SAMPLE_PATH);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ schemaVersion: 2, name: 'fromV0', flags: [] });
    }
  });

  it('treats absent schemaVersion as v0 and runs the full chain', () => {
    const migrations = {
      0: (raw: unknown): unknown => ({ ...(raw as Record<string, unknown>), name: 'fromBare' }),
      1: (raw: unknown): unknown => ({ ...(raw as Record<string, unknown>), schemaVersion: 2, flags: ['a'] }),
    };
    const result = runMigrations({}, 2, migrations, targetSchema, SAMPLE_PATH);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('fromBare');
      expect(result.value.flags).toEqual(['a']);
    }
  });

  it('skips migrations when the file version equals the current version', () => {
    let calls = 0;
    const migrations = {
      0: (raw: unknown): unknown => {
        calls += 1;
        return raw;
      },
    };
    const result = runMigrations({ schemaVersion: 2, name: 'x', flags: [] }, 2, migrations, targetSchema, SAMPLE_PATH);
    expect(result.ok).toBe(true);
    expect(calls).toBe(0);
  });

  it('returns MigrationGapError with a hint when a step is missing', () => {
    const migrations = {
      // missing the `0 → 1` step
      1: (raw: unknown): unknown => raw,
    };
    const result = runMigrations({ schemaVersion: 0 }, 2, migrations, targetSchema, SAMPLE_PATH);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MigrationGapError);
      const gap = result.error as MigrationGapError;
      expect(gap.from).toBe(0);
      expect(gap.to).toBe(2);
      expect(gap.file).toBe(SAMPLE_PATH);
    }
  });

  it('returns ParseError when the migrated shape fails Zod validation', () => {
    const migrations = {
      0: (raw: unknown): unknown => ({ ...(raw as Record<string, unknown>), schemaVersion: 2 }),
      1: (raw: unknown): unknown => raw,
    };
    // Missing the required `name` field — final parse fails.
    const result = runMigrations({ schemaVersion: 0 }, 2, migrations, targetSchema, SAMPLE_PATH);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ParseError);
    }
  });
});
