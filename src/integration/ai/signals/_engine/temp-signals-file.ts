import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { DomainError } from '@src/domain/value/error/domain-error.ts';
import type { ValidationError } from '@src/domain/value/error/validation-error.ts';
import { removeFile } from '@src/integration/io/fs.ts';

/**
 * Allocate a per-process tempfile path for one-shot flows that want a `signalsFile` to thread
 * onto `AiSession` without owning a per-call audit tree. The path is unique per call (pid +
 * timestamp + monotonic counter) so concurrent flows in the same process don't collide.
 *
 * The caller owns the lifecycle: read the signals after the provider call returns, then
 * `removeFile`. Cleanup failures are best-effort (orphan tempfiles are bounded by os.tmpdir()
 * rotation). Most callers should prefer {@link withSignalsTempPath}, which wraps the alloc +
 * try/finally cleanup into one closure.
 */

let counter = 0;

export const allocSignalsTempPath = (label: string): Result<AbsolutePath, ValidationError> => {
  counter += 1;
  const filename = `ralphctl-signals-${label}-${String(process.pid)}-${String(Date.now())}-${String(counter)}.json`;
  return AbsolutePath.parse(join(tmpdir(), filename));
};

/**
 * Run `fn` against a freshly-allocated signals tempfile; unlink the file when `fn` resolves.
 *
 * One-shot flows (detect-skills, detect-scripts, readiness, review) previously inlined the
 * `allocSignalsTempPath` + `try { … } finally { removeFile(…) }` pattern. The next caller
 * could omit the `finally` and leak tempfiles for the process's lifetime; this combinator
 * makes the lifecycle impossible to forget.
 *
 * Cleanup is unconditional (best-effort `removeFile`) and runs even when `fn` throws.
 */
export const withSignalsTempPath = async <T>(
  label: string,
  fn: (signalsFile: AbsolutePath) => Promise<Result<T, DomainError>>
): Promise<Result<T, DomainError>> => {
  const path = allocSignalsTempPath(label);
  if (!path.ok) return Result.error(path.error);
  try {
    return await fn(path.value);
  } finally {
    await removeFile(String(path.value));
  }
};
