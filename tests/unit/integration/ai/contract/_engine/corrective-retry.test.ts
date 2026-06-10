import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { RateLimitError } from '@src/domain/value/error/rate-limit-error.ts';
import { MigrationGapError } from '@src/domain/value/error/migration-gap-error.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { Prompt } from '@src/integration/ai/prompts/_engine/prompt-type.ts';
import { changeSignalSchema } from '@src/integration/ai/contract/_engine/signals/change/schema.ts';
import { decisionSignalSchema } from '@src/integration/ai/contract/_engine/signals/decision/schema.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';
import { validateSignalsFileWithCorrectiveRetry } from '@src/integration/ai/contract/_engine/corrective-retry.ts';
import type { ChangeSignal, DecisionSignal } from '@src/domain/signal.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const unwrapPath = (s: string): AbsolutePath => {
  const r = AbsolutePath.parse(s);
  if (!r.ok) throw new Error(`bad path: ${s}`);
  return r.value;
};

const contract: AiOutputContract<ChangeSignal | DecisionSignal> = {
  schemaVersion: 1,
  signalsSchema: z.array(z.union([changeSignalSchema, decisionSignalSchema])),
  sidecars: [],
  migrations: {},
  exampleSignals: [],
};

const VALID = JSON.stringify({
  schemaVersion: 1,
  signals: [{ type: 'change', text: 'added foo', timestamp: '2026-05-22T10:00:00.000Z' }],
});
const BAD_SHAPE = JSON.stringify({
  schemaVersion: 1,
  signals: [{ type: 'change', text: 42, timestamp: 'not-iso' }],
});

describe('validateSignalsFileWithCorrectiveRetry', () => {
  let tmp: string;
  let signalsPath: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ralphctl-corrective-'));
    signalsPath = join(tmp, 'signals.json');
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns immediately on a valid first parse — never re-invokes', async () => {
    writeFileSync(signalsPath, VALID);
    let calls = 0;
    const result = await validateSignalsFileWithCorrectiveRetry(
      {
        outputDir: unwrapPath(tmp),
        logger: noopLogger,
        selfContainedContext: 'OUTPUT CONTRACT SECTION (self-contained)',
        reinvoke: async () => {
          calls += 1;
          return Result.ok(undefined);
        },
      },
      contract
    );
    expect(result.ok).toBe(true);
    expect(calls).toBe(0);
  });

  it('re-invokes once with a Zod-issue corrective prompt and recovers when the retry writes valid output', async () => {
    writeFileSync(signalsPath, BAD_SHAPE);
    let correctiveSeen: string | undefined;
    const result = await validateSignalsFileWithCorrectiveRetry(
      {
        outputDir: unwrapPath(tmp),
        logger: noopLogger,
        selfContainedContext: 'OUTPUT CONTRACT SECTION (self-contained)',
        reinvoke: async (corrective: Prompt) => {
          correctiveSeen = corrective;
          // The corrective turn fixes the file.
          writeFileSync(signalsPath, VALID);
          return Result.ok(undefined);
        },
      },
      contract
    );
    expect(result.ok).toBe(true);
    // The corrective body names the schema-mismatch error class and enumerates Zod issue paths
    // (the inner `signals` array is unwrapped before the schema parses, so the path is the array
    // index `0`, not `signals.0`).
    expect(correctiveSeen).toContain('schema validation');
    // Self-containment pin: EVERY corrective body carries the output-contract block + the
    // cold-session hedge, so a fresh spawn (no resumable id / codex stale-resume cold fallback)
    // re-reads its grounding instead of fabricating a verdict from the error text.
    expect(correctiveSeen).toContain('OUTPUT CONTRACT SECTION (self-contained)');
    expect(correctiveSeen).toContain('do NOT invent a verdict');
    expect(correctiveSeen).toMatch(/at `0`:/);
  });

  it('self-blocks (returns the second error) when the retry still fails — one retry max, no loop', async () => {
    writeFileSync(signalsPath, BAD_SHAPE);
    let calls = 0;
    const result = await validateSignalsFileWithCorrectiveRetry(
      {
        outputDir: unwrapPath(tmp),
        logger: noopLogger,
        selfContainedContext: 'OUTPUT CONTRACT SECTION (self-contained)',
        reinvoke: async () => {
          calls += 1;
          // Retry leaves the bad file in place → second validation fails too.
          return Result.ok(undefined);
        },
      },
      contract
    );
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  it('builds a signals-missing corrective when the file was never written', async () => {
    // No file on disk → signals-missing (InvalidStateError, correctable).
    let correctiveSeen: string | undefined;
    const result = await validateSignalsFileWithCorrectiveRetry(
      {
        outputDir: unwrapPath(tmp),
        logger: noopLogger,
        selfContainedContext: 'OUTPUT CONTRACT SECTION (self-contained)',
        reinvoke: async (corrective: Prompt) => {
          correctiveSeen = corrective;
          writeFileSync(signalsPath, VALID);
          return Result.ok(undefined);
        },
      },
      contract
    );
    expect(result.ok).toBe(true);
    expect(correctiveSeen).toContain('You did not write');
  });

  it('builds an invalid-json corrective when the body was not valid JSON', async () => {
    writeFileSync(signalsPath, '{ not json');
    let correctiveSeen: string | undefined;
    const result = await validateSignalsFileWithCorrectiveRetry(
      {
        outputDir: unwrapPath(tmp),
        logger: noopLogger,
        selfContainedContext: 'OUTPUT CONTRACT SECTION (self-contained)',
        reinvoke: async (corrective: Prompt) => {
          correctiveSeen = corrective;
          writeFileSync(signalsPath, VALID);
          return Result.ok(undefined);
        },
      },
      contract
    );
    expect(result.ok).toBe(true);
    expect(correctiveSeen).toContain('not valid JSON');
  });

  it('self-blocks on a non-correctable spawn error surfaced by the corrective re-invoke', async () => {
    writeFileSync(signalsPath, BAD_SHAPE);
    let calls = 0;
    const result = await validateSignalsFileWithCorrectiveRetry(
      {
        outputDir: unwrapPath(tmp),
        logger: noopLogger,
        selfContainedContext: 'OUTPUT CONTRACT SECTION (self-contained)',
        reinvoke: async () => {
          calls += 1;
          return Result.error(new RateLimitError({ subCode: 'spawn-stderr', message: 'rate-limited' }) as DomainError);
        },
      },
      contract
    );
    // First validate fails (correctable schema-mismatch) → retry fires once → the corrective spawn
    // itself rate-limits → helper self-blocks on that spawn error without a second validate.
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
    if (!result.ok) expect(result.error).toBeInstanceOf(RateLimitError);
  });

  it('propagates an AbortError from the corrective re-invoke transparently', async () => {
    writeFileSync(signalsPath, BAD_SHAPE);
    const result = await validateSignalsFileWithCorrectiveRetry(
      {
        outputDir: unwrapPath(tmp),
        logger: noopLogger,
        selfContainedContext: 'OUTPUT CONTRACT SECTION (self-contained)',
        reinvoke: async () => Result.error(new AbortError({ elementName: 'test', reason: 'cancelled' }) as DomainError),
      },
      contract
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AbortError);
  });

  it('skips the retry entirely on a non-correctable MigrationGap error', async () => {
    // A migration gap is a harness-side version mismatch the AI cannot fix by re-emitting.
    const gapContract: AiOutputContract<ChangeSignal | DecisionSignal> = {
      schemaVersion: 3,
      signalsSchema: z.array(z.union([changeSignalSchema, decisionSignalSchema])),
      sidecars: [],
      migrations: { 1: (raw) => ({ ...(raw as object), schemaVersion: 2 }) },
      exampleSignals: [],
    };
    writeFileSync(
      signalsPath,
      JSON.stringify({
        schemaVersion: 1,
        signals: [{ type: 'change', text: 'x', timestamp: '2026-05-22T10:00:00.000Z' }],
      })
    );
    let calls = 0;
    const result = await validateSignalsFileWithCorrectiveRetry(
      {
        outputDir: unwrapPath(tmp),
        logger: noopLogger,
        selfContainedContext: 'OUTPUT CONTRACT SECTION (self-contained)',
        reinvoke: async () => {
          calls += 1;
          return Result.ok(undefined);
        },
      },
      gapContract
    );
    expect(result.ok).toBe(false);
    expect(calls).toBe(0);
    if (!result.ok) expect(result.error).toBeInstanceOf(MigrationGapError);
  });
});
