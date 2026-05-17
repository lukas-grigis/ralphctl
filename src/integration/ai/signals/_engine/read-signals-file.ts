import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { NotFoundError } from '@src/domain/value/error/not-found-error.ts';
import { readJson } from '@src/integration/io/fs.ts';

/**
 * Load the JSON array a `HeadlessAiProvider` wrote to its caller-supplied `signalsFile`.
 *
 * The provider serializes `parseHarnessSignals(...)`' output verbatim, so the file is a flat
 * `HarnessSignal[]` (each entry already type-tagged). The reader trusts the producer — no
 * per-element schema validation here; if a future provider misbehaves the consumer will
 * surface it at signal-handling time via the exhaustive `switch`.
 *
 * Errors:
 *  - `NotFoundError` — provider didn't write the file (succeeded but disk full / EPERM had
 *    been masked, or test seam misuse). Treat as "no signals."
 *  - `StorageError` — read or JSON.parse failure (subCode `'io'` / `'parse'`).
 */
export const readSignalsFile = async (
  path: AbsolutePath
): Promise<Result<readonly HarnessSignal[], NotFoundError | StorageError>> => {
  const json = await readJson(String(path));
  if (!json.ok) return Result.error(json.error);
  if (!Array.isArray(json.value)) return Result.ok([]);
  return Result.ok(json.value as readonly HarnessSignal[]);
};
