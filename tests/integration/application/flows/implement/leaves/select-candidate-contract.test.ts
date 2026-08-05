import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import { selectCandidateOutputContract } from '@src/application/flows/implement/leaves/select-candidate.contract.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Signal schema validation tests for `selectCandidateOutputContract` — the `select-candidate`
 * one-shot judge session's per-leaf contract.
 *
 * There is no leaf implementation yet (this wave owns the contract + prompt surface only), so
 * these tests exercise `validateSignalsFile` directly against the contract, mirroring
 * `review-round-contract.test.ts`.
 *
 * Contract rules:
 *  - Exactly one `candidate-selection` signal must be present.
 *  - No other signal kinds are permitted — including narrative fan-out (`note` / `learning` /
 *    `decision`), unlike most contracts: this is a pure pairwise verdict.
 *  - `migrations` is empty — this is a fresh contract with no legacy on-disk shape.
 */

const TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

const candidateSelectionSignal = (overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> => ({
  type: 'candidate-selection',
  winner: 1,
  rationale: 'Candidate 1 ran the repro command and cited the passing output; Candidate 2 did not verify.',
  timestamp: TS,
  ...overrides,
});

describe('selectCandidateOutputContract — signal schema validation', () => {
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

  it('ok: candidate-selection naming winner 1 → validates and returns signal', async () => {
    const outputDir = await arrange({ schemaVersion: 1, signals: [candidateSelectionSignal({ winner: 1 })] });
    const result = await validateSignalsFile(outputDir, selectCandidateOutputContract);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.type).toBe('candidate-selection');
  });

  it('ok: candidate-selection naming winner 2 → validates and returns signal', async () => {
    const outputDir = await arrange({ schemaVersion: 1, signals: [candidateSelectionSignal({ winner: 2 })] });
    const result = await validateSignalsFile(outputDir, selectCandidateOutputContract);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // No narrowing needed — the contract's signal type is a single kind, not a union.
    expect(result.value[0]?.winner).toBe(2);
  });

  // ── 2. Missing required verdict → refine rejects ────────────────────────────

  it('empty signals array → ParseError (zero candidate-selection signals)', async () => {
    const outputDir = await arrange({ schemaVersion: 1, signals: [] });
    const result = await validateSignalsFile(outputDir, selectCandidateOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('exactly one');
  });

  // ── 3. Two candidate-selection signals → refine rejects ─────────────────────

  it('two candidate-selection signals → ParseError (arity violated)', async () => {
    const outputDir = await arrange({
      schemaVersion: 1,
      signals: [candidateSelectionSignal({ winner: 1 }), candidateSelectionSignal({ winner: 2 })],
    });
    const result = await validateSignalsFile(outputDir, selectCandidateOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('exactly one');
  });

  // ── 4. No narrative fan-out accepted ────────────────────────────────────────

  it('a stray note alongside a valid verdict → ParseError (narrative kinds not accepted)', async () => {
    const outputDir = await arrange({
      schemaVersion: 1,
      signals: [candidateSelectionSignal(), { type: 'note', text: 'a stray observation', timestamp: TS }],
    });
    const result = await validateSignalsFile(outputDir, selectCandidateOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('schema');
  });

  // ── 5. Invalid winner values ─────────────────────────────────────────────────

  it('winner: 0 → ParseError(schema-mismatch)', async () => {
    const outputDir = await arrange({ schemaVersion: 1, signals: [candidateSelectionSignal({ winner: 0 })] });
    const result = await validateSignalsFile(outputDir, selectCandidateOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('schema');
  });

  it('missing rationale → ParseError(schema-mismatch)', async () => {
    const malformed = candidateSelectionSignal();
    delete malformed.rationale;
    const outputDir = await arrange({ schemaVersion: 1, signals: [malformed] });
    const result = await validateSignalsFile(outputDir, selectCandidateOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('schema');
  });

  // ── 6. Malformed JSON ────────────────────────────────────────────────────────

  it('malformed JSON → ParseError(invalid-json)', async () => {
    const outputDir = await arrangeRaw('{ this is not valid json at all');
    const result = await validateSignalsFile(outputDir, selectCandidateOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('malformed JSON');
  });

  // ── 7. Missing signals.json ───────────────────────────────────────────────────

  it('signals-missing: no file → InvalidStateError', async () => {
    const outputDir = await emptyDir();
    const result = await validateSignalsFile(outputDir, selectCandidateOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(InvalidStateError);
    expect(result.error.message).toContain('signals-missing');
  });

  // ── 8. Example signals from the contract round-trip ─────────────────────────

  it('example signals in the contract round-trip through the schema', async () => {
    const outputDir = await arrange({ schemaVersion: 1, signals: selectCandidateOutputContract.exampleSignals });
    const result = await validateSignalsFile(outputDir, selectCandidateOutputContract);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(selectCandidateOutputContract.exampleSignals.length);
  });
});
