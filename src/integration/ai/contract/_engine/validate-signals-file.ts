import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { MigrationGapError } from '@src/domain/value/error/migration-gap-error.ts';
import { ParseError } from '@src/domain/value/error/parse-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AiSignal } from '@src/domain/signal.ts';
import { isNodeErrnoCode } from '@src/integration/io/fs.ts';
import type { AiOutputContract } from '@src/integration/ai/contract/_engine/types.ts';

const SIGNALS_FILENAME = 'signals.json';

/**
 * Hard ceiling on the signals.json body before we read/parse it. The AI provider writes this file
 * with its own Write tool, so its size is model-controlled and otherwise unbounded — a runaway model
 * emitting a multi-gigabyte body would OOM the process inside `fs.readFile` / `JSON.parse` long before
 * Zod could reject it. A realistic signals file (a handful of short signal records) is well under 1 KB;
 * 4 MB is ~4000x that upper bound, comfortably above any plausible legitimate output while still small
 * enough to read safely. Over the cap we treat the file as malformed (ParseError → per-task block via
 * turn-error-policy) rather than reading it.
 *
 * @public
 */
export const SIGNALS_FILE_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Per-spawn contract loader. Reads `<outputDir>/signals.json`, walks the migration chain
 * forward to the contract's current `schemaVersion`, then Zod-parses the final shape.
 *
 * Failure shapes the leaf surfaces:
 *
 *   - `InvalidStateError` (`signals-missing`)  — file absent. Leaf escalates so the chain
 *     surfaces a clear "AI did not produce signals.json" message.
 *   - `ParseError`         (`invalid-json`)    — file exists but is malformed JSON.
 *   - `ParseError`         (`schema-mismatch`) — Zod rejected the migrated shape; the issue
 *     path lives in `cause` for callers to extract.
 *   - `MigrationGapError`                       — file declares a version older than the
 *     contract expects and the chain is missing a step for the gap.
 *   - `StorageError`                            — other I/O failures (EACCES, etc.).
 *
 * Returns the validated `AiSignal[]` on success — the precise sub-union per the contract's
 * generic argument.
 */
export const validateSignalsFile = async <TSig extends AiSignal>(
  outputDir: AbsolutePath,
  contract: AiOutputContract<TSig>
): Promise<Result<readonly TSig[], InvalidStateError | ParseError | MigrationGapError | StorageError>> => {
  const path = join(String(outputDir), SIGNALS_FILENAME);

  // Bound the body before reading it. The provider writes signals.json itself, so a runaway model
  // can emit an implausibly large file that would OOM inside readFile/JSON.parse before Zod runs.
  // Stat first and bail over the cap WITHOUT reading. A missing file (ENOENT) falls through to the
  // readFile branch below so the "signals-missing" InvalidStateError shape is preserved; other stat
  // errors (EACCES, etc.) likewise fall through and surface as the StorageError from readFile.
  try {
    const stats = await fs.stat(path);
    if (stats.size > SIGNALS_FILE_MAX_BYTES) {
      return Result.error(
        new ParseError({
          subCode: 'schema-mismatch',
          message: `signals-invalid (too large) at ${path}: signals.json is ${stats.size} bytes, over the ${SIGNALS_FILE_MAX_BYTES}-byte (4 MB) cap — the AI wrote an implausibly large signals file; treating as malformed`,
          hint: 'The AI wrote a signals.json far larger than any plausible signals body. Inspect the per-spawn directory; the file was not parsed.',
        })
      );
    }
  } catch {
    // ignore — let readFile below produce the canonical missing/IO error shapes
  }

  let bytes: string;
  try {
    bytes = await fs.readFile(path, 'utf8');
  } catch (cause) {
    if (isNodeErrnoCode(cause, 'ENOENT') || isNodeErrnoCode(cause, 'ENOTDIR')) {
      return Result.error(
        new InvalidStateError({
          entity: 'ai-session',
          currentState: 'post-spawn',
          attemptedAction: 'validate-signals',
          message: `signals-missing: ${path}`,
          hint: 'The AI exited without writing signals.json. Inspect the per-spawn directory for stdout / session-id.txt and re-run.',
        })
      );
    }
    return Result.error(new StorageError({ subCode: 'io', message: `read failed: ${path}`, path, cause }));
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bytes);
  } catch (cause) {
    return Result.error(
      new ParseError({
        subCode: 'invalid-json',
        message: `signals-invalid (malformed JSON) at ${path}: ${describeJsonError(cause)}`,
        cause,
        hint: 'The spawn wrote signals.json but the body was not valid JSON. Inspect the file directly.',
      })
    );
  }

  const fileVersion =
    typeof raw === 'object' && raw !== null && typeof (raw as { schemaVersion?: unknown }).schemaVersion === 'number'
      ? (raw as { schemaVersion: number }).schemaVersion
      : 0;

  let current: unknown = raw;
  for (let v = fileVersion; v < contract.schemaVersion; v++) {
    const step = contract.migrations[v];
    if (step === undefined) {
      return Result.error(new MigrationGapError({ from: v, to: contract.schemaVersion, file: path }));
    }
    current = step(current);
  }

  // Guard the root shape before the property access below. `JSON.parse('null')` succeeds and the
  // generator-contract v0 migration passes non-arrays through untouched, so a provider that writes
  // literal `null` (a real failure mode) reaches here — a bare `wrapper.signals` access on null
  // would throw a TypeError, which is NOT a DomainError and would escape the Result channel and
  // crash the whole run instead of blocking the single task (turn-error-policy routes ParseError
  // to a per-task block). Surface it as the same schema-mismatch ParseError as any other malformed
  // signals body.
  if (typeof current !== 'object' || current === null) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: `signals-invalid (schema) at ${path}: signals.json root is not an object`,
        hint: 'The AI wrote signals.json but its root was not a JSON object (e.g. literal `null` or a string).',
      })
    );
  }

  const wrapper = current as { signals?: unknown };
  const inner = wrapper.signals;
  // Be lenient on `timestamp`: AIs frequently omit it on signals they think of as
  // "terminal" (commit-message, task-complete, evaluation). A 4-minute round failing
  // schema validation on a missable field is bad ergonomics for what the timestamp
  // ultimately drives (display-only). Stamp any signal missing `timestamp` at
  // validation time — spawn-time is within seconds of when the AI wrote the field.
  const defaulted = defaultMissingTimestamps(inner);
  const parsed = contract.signalsSchema.safeParse(defaulted);
  if (!parsed.success) {
    return Result.error(
      new ParseError({
        subCode: 'schema-mismatch',
        message: `signals-invalid (schema) at ${path}: ${parsed.error.message}`,
        cause: parsed.error,
        hint: 'The AI wrote signals.json but the shape failed the leaf contract. Issue path is in cause.issues.',
      })
    );
  }
  return Result.ok(parsed.data);
};

const describeJsonError = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  return String(cause);
};

const defaultMissingTimestamps = (inner: unknown): unknown => {
  if (!Array.isArray(inner)) return inner;
  const now = new Date().toISOString();
  return inner.map((sig) => {
    if (typeof sig !== 'object' || sig === null) return sig;
    const s = sig as Record<string, unknown>;
    if (typeof s.timestamp === 'string' && s.timestamp.length > 0) return sig;
    return { ...s, timestamp: now };
  });
};
