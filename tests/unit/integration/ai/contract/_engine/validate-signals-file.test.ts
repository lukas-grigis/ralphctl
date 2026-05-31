import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { MigrationGapError } from '@src/domain/value/error/migration-gap-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { changeSignalSchema } from '@src/integration/ai/contract/_engine/signals/change/schema.ts';
import { decisionSignalSchema } from '@src/integration/ai/contract/_engine/signals/decision/schema.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import type { ChangeSignal, DecisionSignal } from '@src/domain/signal.ts';

const unwrapPath = (s: string): AbsolutePath => {
  const r = AbsolutePath.parse(s);
  if (!r.ok) throw new Error(`bad path: ${s}`);
  return r.value;
};

const sampleContract: AiOutputContract<ChangeSignal | DecisionSignal> = {
  schemaVersion: 1,
  signalsSchema: z.array(z.union([changeSignalSchema, decisionSignalSchema])),
  sidecars: [],
  migrations: {},
  exampleSignals: [],
};

const v2Contract: AiOutputContract<ChangeSignal | DecisionSignal> = {
  schemaVersion: 2,
  signalsSchema: z.array(z.union([changeSignalSchema, decisionSignalSchema])),
  sidecars: [],
  migrations: {
    1: (raw) => {
      const w = raw as { schemaVersion: number; signals?: unknown[] };
      // No-op migration — payload shape was identical between v1 and v2.
      return { schemaVersion: 2, signals: w.signals ?? [] };
    },
  },
  exampleSignals: [],
};

describe('validateSignalsFile', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ralphctl-contract-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns the parsed signals when the file matches the contract', async () => {
    const path = join(tmp, 'signals.json');
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: 1,
        signals: [
          { type: 'change', text: 'added foo', timestamp: '2026-05-22T10:00:00.000Z' },
          { type: 'decision', text: 'we go with X', timestamp: '2026-05-22T10:00:01.000Z' },
        ],
      })
    );

    const result = await validateSignalsFile(unwrapPath(tmp), sampleContract);
    if (!result.ok) throw new Error(`expected ok: ${result.error.message}`);
    expect(result.value).toHaveLength(2);
    expect(result.value[0]?.type).toBe('change');
    expect(result.value[1]?.type).toBe('decision');
  });

  it('returns InvalidStateError when signals.json is missing', async () => {
    const result = await validateSignalsFile(unwrapPath(tmp), sampleContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(InvalidStateError);
    expect(result.error.message).toContain('signals-missing');
  });

  it('returns ParseError(invalid-json) on malformed JSON', async () => {
    writeFileSync(join(tmp, 'signals.json'), '{ not json');
    const result = await validateSignalsFile(unwrapPath(tmp), sampleContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect((result.error as ParseError).subCode).toBe('invalid-json');
  });

  it('returns ParseError(schema-mismatch) on a shape that fails Zod', async () => {
    writeFileSync(
      join(tmp, 'signals.json'),
      JSON.stringify({
        schemaVersion: 1,
        signals: [{ type: 'change', text: 42, timestamp: 'not-iso' }],
      })
    );
    const result = await validateSignalsFile(unwrapPath(tmp), sampleContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect((result.error as ParseError).subCode).toBe('schema-mismatch');
  });

  it('walks migrations forward from an older fileVersion', async () => {
    writeFileSync(
      join(tmp, 'signals.json'),
      JSON.stringify({
        schemaVersion: 1,
        signals: [{ type: 'change', text: 'old', timestamp: '2026-05-22T10:00:00.000Z' }],
      })
    );
    const result = await validateSignalsFile(unwrapPath(tmp), v2Contract);
    if (!result.ok) throw new Error(`expected ok: ${result.error.message}`);
    expect(result.value).toHaveLength(1);
  });

  it('returns MigrationGapError when a step is missing', async () => {
    const gapContract: AiOutputContract<ChangeSignal | DecisionSignal> = {
      schemaVersion: 3,
      signalsSchema: z.array(z.union([changeSignalSchema, decisionSignalSchema])),
      sidecars: [],
      migrations: {
        // 1→2 exists; 2→3 missing — should trip the gap.
        1: (raw) => ({ ...(raw as object), schemaVersion: 2 }),
      },
      exampleSignals: [],
    };
    writeFileSync(
      join(tmp, 'signals.json'),
      JSON.stringify({
        schemaVersion: 1,
        signals: [{ type: 'change', text: 'x', timestamp: '2026-05-22T10:00:00.000Z' }],
      })
    );
    const result = await validateSignalsFile(unwrapPath(tmp), gapContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(MigrationGapError);
    expect((result.error as MigrationGapError).from).toBe(2);
    expect((result.error as MigrationGapError).to).toBe(3);
  });

  it('defaults fileVersion to 0 when schemaVersion is absent', async () => {
    const fromZeroContract: AiOutputContract<ChangeSignal | DecisionSignal> = {
      schemaVersion: 1,
      signalsSchema: z.array(z.union([changeSignalSchema, decisionSignalSchema])),
      sidecars: [],
      migrations: {
        0: (raw) => {
          const r = raw as { signals?: unknown[] };
          return { schemaVersion: 1, signals: r.signals ?? [] };
        },
      },
      exampleSignals: [],
    };
    writeFileSync(
      join(tmp, 'signals.json'),
      JSON.stringify({
        signals: [{ type: 'change', text: 'no version field', timestamp: '2026-05-22T10:00:00.000Z' }],
      })
    );
    const result = await validateSignalsFile(unwrapPath(tmp), fromZeroContract);
    if (!result.ok) throw new Error(`expected ok: ${result.error.message}`);
    expect(result.value).toHaveLength(1);
  });
});
