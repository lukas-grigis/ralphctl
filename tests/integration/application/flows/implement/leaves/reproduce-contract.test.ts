import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import { reproduceOutputContract } from '@src/application/flows/implement/leaves/reproduce.contract.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Signal schema validation tests for `reproduceOutputContract` — the `reproduce` one-shot
 * session's per-leaf contract.
 *
 * There is no leaf implementation yet (this wave owns the contract + prompt surface only), so
 * these tests exercise `validateSignalsFile` directly against the contract, mirroring
 * `review-round-contract.test.ts`.
 *
 * Contract rules:
 *  - Exactly one `reproduction` signal must be present.
 *  - `note` is optional and may appear alongside it.
 *  - No other signal kinds are permitted.
 *  - `migrations` is empty — this is a fresh contract with no legacy on-disk shape.
 */

const TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

const reproductionSignal = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  type: 'reproduction',
  testPath: 'tests/unit/business/foo/bar.test.ts',
  runCommand: '<test runner> run tests/unit/business/foo/bar.test.ts',
  observedFailure: 'expected 400, got 500',
  relevantTests: [],
  timestamp: TS,
  ...overrides,
});

describe('reproduceOutputContract — signal schema validation', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  const arrange = async (payload: unknown, subdir = 'round'): Promise<AbsolutePath> => {
    const dirStr = join(String(root.root), subdir);
    await fs.mkdir(dirStr, { recursive: true });
    await fs.writeFile(join(dirStr, 'signals.json'), JSON.stringify(payload), 'utf8');
    const dir = AbsolutePath.parse(dirStr);
    if (!dir.ok) throw new Error('path parse failed');
    return dir.value;
  };

  const arrangeRaw = async (body: string, subdir = 'round-raw'): Promise<AbsolutePath> => {
    const dirStr = join(String(root.root), subdir);
    await fs.mkdir(dirStr, { recursive: true });
    await fs.writeFile(join(dirStr, 'signals.json'), body, 'utf8');
    const dir = AbsolutePath.parse(dirStr);
    if (!dir.ok) throw new Error('path parse failed');
    return dir.value;
  };

  const emptyDir = async (subdir = 'empty'): Promise<AbsolutePath> => {
    const dirStr = join(String(root.root), subdir);
    await fs.mkdir(dirStr, { recursive: true });
    const dir = AbsolutePath.parse(dirStr);
    if (!dir.ok) throw new Error('path parse failed');
    return dir.value;
  };

  // ── 1. Happy paths ──────────────────────────────────────────────────────────

  it('ok: reproduction alone → validates and returns signal', async () => {
    const outputDir = await arrange({ schemaVersion: 1, signals: [reproductionSignal()] });
    const result = await validateSignalsFile(outputDir, reproduceOutputContract);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.type).toBe('reproduction');
  });

  it('ok: reproduction + note → both validate', async () => {
    const outputDir = await arrange({
      schemaVersion: 1,
      signals: [reproductionSignal(), { type: 'note', text: 'chose the existing file', timestamp: TS }],
    });
    const result = await validateSignalsFile(outputDir, reproduceOutputContract);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((s) => s.type)).toEqual(['reproduction', 'note']);
  });

  it('ok: relevantTests may be non-empty', async () => {
    const outputDir = await arrange({
      schemaVersion: 1,
      signals: [reproductionSignal({ relevantTests: ['tests/unit/foo/baz.test.ts'] })],
    });
    const result = await validateSignalsFile(outputDir, reproduceOutputContract);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // @ts-expect-error narrow to ReproductionSignal for the assertion
    expect(result.value[0]?.relevantTests).toEqual(['tests/unit/foo/baz.test.ts']);
  });

  // ── 2. Missing required reproduction → refine rejects ──────────────────────

  it('empty signals array → ParseError (zero reproduction signals)', async () => {
    const outputDir = await arrange({ schemaVersion: 1, signals: [] });
    const result = await validateSignalsFile(outputDir, reproduceOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('exactly one');
  });

  it('note only, no reproduction → ParseError', async () => {
    const outputDir = await arrange({
      schemaVersion: 1,
      signals: [{ type: 'note', text: 'could not reproduce', timestamp: TS }],
    });
    const result = await validateSignalsFile(outputDir, reproduceOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('exactly one');
  });

  // ── 3. Two reproduction signals → refine rejects ────────────────────────────

  it('two reproduction signals → ParseError (arity violated)', async () => {
    const outputDir = await arrange({ schemaVersion: 1, signals: [reproductionSignal(), reproductionSignal()] });
    const result = await validateSignalsFile(outputDir, reproduceOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('exactly one');
  });

  // ── 4. Invalid / unknown signal kind ────────────────────────────────────────

  it('unknown signal kind (commit-message) → ParseError(schema-mismatch)', async () => {
    const outputDir = await arrange({
      schemaVersion: 1,
      signals: [reproductionSignal(), { type: 'commit-message', subject: 'feat: irrelevant', timestamp: TS }],
    });
    const result = await validateSignalsFile(outputDir, reproduceOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('schema');
  });

  // ── 5. Missing required field on a valid type ───────────────────────────────

  it('reproduction missing required testPath → ParseError(schema-mismatch)', async () => {
    const malformed = reproductionSignal();
    delete malformed.testPath;
    const outputDir = await arrange({ schemaVersion: 1, signals: [malformed] });
    const result = await validateSignalsFile(outputDir, reproduceOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('schema');
  });

  // ── 6. Malformed JSON ────────────────────────────────────────────────────────

  it('malformed JSON → ParseError(invalid-json)', async () => {
    const outputDir = await arrangeRaw('{ this is not valid json at all');
    const result = await validateSignalsFile(outputDir, reproduceOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('malformed JSON');
  });

  // ── 7. Missing signals.json ───────────────────────────────────────────────────

  it('signals-missing: no file → InvalidStateError', async () => {
    const outputDir = await emptyDir();
    const result = await validateSignalsFile(outputDir, reproduceOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(InvalidStateError);
    expect(result.error.message).toContain('signals-missing');
  });

  // ── 8. Example signals from the contract round-trip ─────────────────────────

  it('example signals in the contract round-trip through the schema', async () => {
    const outputDir = await arrange({ schemaVersion: 1, signals: reproduceOutputContract.exampleSignals });
    const result = await validateSignalsFile(outputDir, reproduceOutputContract);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(reproduceOutputContract.exampleSignals.length);
  });
});
