import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { validateSignalsFile } from '@src/integration/ai/contract/_engine/validate-signals-file.ts';
import { reviewRoundOutputContract } from '@src/application/flows/review/leaves/review-round.contract.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import type { IsoTimestamp } from '@src/domain/value/iso-timestamp.ts';

/**
 * Signal schema validation tests for `reviewRoundOutputContract` — audit-[09].
 *
 * The review-round leaf uses `validateSignalsFile` internally after each AI spawn. These
 * tests exercise the contract rules directly (without going through the full leaf, which
 * requires interactive, git, shell, and append-file ports) so regressions in the Zod
 * schema surface quickly.
 *
 * Contract rules:
 *  - Exactly one of `task-complete` or `task-blocked` must be present.
 *  - No other signal kinds are permitted.
 *  - `task-blocked` requires a `reason` string.
 *  - `migrations[0]` lifts a legacy bare array into the `{ schemaVersion, signals }` wrapper.
 */

const TS = '2026-05-22T10:00:00.000Z' as IsoTimestamp;

describe('reviewRoundOutputContract — signal schema validation', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    root = await makeTmpRoot();
  });

  afterEach(async () => {
    await root.cleanup();
  });

  /**
   * Allocate a fresh subdir under the tmproot, write `signals.json` with the supplied payload,
   * and return the dir as an `AbsolutePath` for `validateSignalsFile`.
   */
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

  it('ok: task-complete → validates and returns signal', async () => {
    const outputDir = await arrange({
      schemaVersion: 1,
      signals: [{ type: 'task-complete', timestamp: TS }],
    });
    const result = await validateSignalsFile(outputDir, reviewRoundOutputContract);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.type).toBe('task-complete');
  });

  it('ok: task-blocked with reason → validates and returns signal', async () => {
    const outputDir = await arrange({
      schemaVersion: 1,
      signals: [{ type: 'task-blocked', reason: 'CI is red — dependency build failed', timestamp: TS }],
    });
    const result = await validateSignalsFile(outputDir, reviewRoundOutputContract);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.type).toBe('task-blocked');
    // @ts-expect-error narrow to TaskBlockedSignal for the assertion
    expect(result.value[0]?.reason).toBe('CI is red — dependency build failed');
  });

  // ── 2. Missing required terminal → refine rejects ──────────────────────────

  it('empty signals array → ParseError (zero terminals)', async () => {
    const outputDir = await arrange({
      schemaVersion: 1,
      signals: [],
    });
    const result = await validateSignalsFile(outputDir, reviewRoundOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('exactly one');
  });

  // ── 3. Both terminals → refine rejects ─────────────────────────────────────

  it('both task-complete and task-blocked → ParseError (two terminals)', async () => {
    const outputDir = await arrange({
      schemaVersion: 1,
      signals: [
        { type: 'task-complete', timestamp: TS },
        { type: 'task-blocked', reason: 'contradicts complete', timestamp: TS },
      ],
    });
    const result = await validateSignalsFile(outputDir, reviewRoundOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('exactly one');
  });

  // ── 4. Invalid / unknown signal kind ──────────────────────────────────────

  it('unknown signal kind (commit-message) → ParseError(schema-mismatch)', async () => {
    const outputDir = await arrange({
      schemaVersion: 1,
      signals: [{ type: 'commit-message', subject: 'feat: irrelevant', timestamp: TS }],
    });
    const result = await validateSignalsFile(outputDir, reviewRoundOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('schema');
  });

  // ── 5. Missing required field on a valid type ──────────────────────────────

  it('task-blocked missing required reason field → ParseError(schema-mismatch)', async () => {
    const outputDir = await arrange({
      schemaVersion: 1,
      // `reason` is required by taskBlockedSignalSchema but omitted here.
      signals: [{ type: 'task-blocked', timestamp: TS }],
    });
    const result = await validateSignalsFile(outputDir, reviewRoundOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('schema');
  });

  // ── 6. Malformed JSON ──────────────────────────────────────────────────────

  it('malformed JSON → ParseError(invalid-json)', async () => {
    const outputDir = await arrangeRaw('{ this is not valid json at all');
    const result = await validateSignalsFile(outputDir, reviewRoundOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(ParseError);
    expect(result.error.message).toContain('malformed JSON');
  });

  // ── 7. Missing signals.json ─────────────────────────────────────────────────

  it('signals-missing: no file → InvalidStateError', async () => {
    const outputDir = await emptyDir();
    const result = await validateSignalsFile(outputDir, reviewRoundOutputContract);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(InvalidStateError);
    expect(result.error.message).toContain('signals-missing');
  });

  // ── 8. Legacy bare-array migration ─────────────────────────────────────────

  it('migrations[0]: bare array → wraps into v1 envelope and validates', async () => {
    // The legacy shape written by the headless adapter's stdout parser (pre-Wave-6). The
    // contract's `migrations[0]` lifts it into `{ schemaVersion: 1, signals: [...] }`.
    const outputDir = await arrange([{ type: 'task-complete', timestamp: TS }], 'round-legacy');
    const result = await validateSignalsFile(outputDir, reviewRoundOutputContract);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.type).toBe('task-complete');
  });

  // ── 9. Example signals from the contract round-trip ───────────────────────

  it('example signals in the contract round-trip through the schema', async () => {
    const outputDir = await arrange({
      schemaVersion: 1,
      signals: reviewRoundOutputContract.exampleSignals,
    });
    const result = await validateSignalsFile(outputDir, reviewRoundOutputContract);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(reviewRoundOutputContract.exampleSignals.length);
  });
});
