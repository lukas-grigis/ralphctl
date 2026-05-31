/**
 * TOCTOU contract for `createBundledSkillSource.getByName` — single-read path.
 *
 * The production implementation uses ONE `readFile` attempt with no preceding `existsSync`
 * check. This is the TOCTOU contract:
 *
 *   ENOENT  → file absent at read time → unknown skill → `Result.ok(undefined)`
 *   Other   → genuine I/O failure (EACCES, EISDIR, …) → `Result.error(StorageError)`
 *
 * The EISDIR case is already tested in `source.test.ts` via a real filesystem artefact
 * (creating a directory where the file should be). The tests here complement that by
 * injecting the rejection directly via `vi.spyOn` on the `node:fs/promises` namespace
 * import — decoupled from filesystem races and covering the ENOENT path deterministically.
 *
 * Why `vi.spyOn` on the namespace, not `vi.mock`: `source.ts` imports `{ readFile }` from
 * `node:fs/promises`. ESM named imports bind at link time, so a spy on the namespace object
 * only intercepts calls that go through the namespace property (e.g. `fs.readFile()`), not
 * through the already-bound local `readFile` identifier. `vi.mock` hoisting replaces the
 * entire module factory before any import is evaluated, so the `readFile` binding in
 * `source.ts` is redirected to the mock. That is the only reliable seam here.
 *
 * The mock is scoped to this file only (vitest module isolation between test files).
 * The existing `source.test.ts` real-filesystem tests are unaffected.
 */

import { describe, expect, it, vi } from 'vitest';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { createBundledSkillSource } from '@src/integration/ai/skills/bundled/source.ts';

// Hoist the mock before any import is evaluated. The factory replaces the entire
// `node:fs/promises` module so the `readFile` named import in `source.ts` points at our
// vi.fn(). The real implementation is never invoked in this test file.
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  // Re-export other node:fs/promises symbols used elsewhere in vitest infra (not needed by
  // source.ts itself, but vitest infrastructure may import from this mock — add as no-ops).
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
  rm: vi.fn(),
  mkdtemp: vi.fn(),
  realpath: vi.fn(),
}));

// After the `vi.mock` hoisting, import `readFile` from the mocked module so we can control
// it per test. The import below resolves to the same mock the `source.ts` binding got.
import { readFile } from 'node:fs/promises';

/**
 * Forge a Node.js filesystem error with a given `code`. The real `fs` errors are plain
 * `Error` instances with a `code` string property, so this reproduces the exact shape
 * `readSkillOptional`'s `errorCode()` helper inspects.
 */
const fsError = (code: string, message = `ENOENT: no such file or directory`): Error => {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
};

describe('createBundledSkillSource.getByName — single-read TOCTOU contract', () => {
  it('resolves to ok(undefined) when readFile rejects with ENOENT (unknown skill → caller scaffolds)', async () => {
    // Simulate the "file absent at read time" case that the TOCTOU contract requires
    // to map to "unknown skill". If the implementation regresses to an existsSync pre-check,
    // the ENOENT injection here still reaches the readFile call, so this test remains valid.
    // If ENOENT stops mapping to ok(undefined) (e.g., it starts returning a StorageError),
    // this test fails.
    vi.mocked(readFile).mockRejectedValueOnce(fsError('ENOENT'));

    const source = createBundledSkillSource({ bundledRoot: '/some/root' });
    const result = await source.getByName('unknown-skill-name');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
  });

  it('resolves to StorageError when readFile rejects with EACCES (genuine I/O failure)', async () => {
    // Simulate a permission-denied failure. Only ENOENT collapses to ok(undefined);
    // every other rejection must propagate as a StorageError. If EACCES were accidentally
    // mapped to ok(undefined), this test fails.
    vi.mocked(readFile).mockRejectedValueOnce(fsError('EACCES', 'EACCES: permission denied'));

    const source = createBundledSkillSource({ bundledRoot: '/some/root' });
    const result = await source.getByName('restricted-skill');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(StorageError);
    expect(result.error.message).toMatch(/bundled skill not readable/u);
  });

  it('resolves to StorageError when readFile rejects with EPERM (permission error variant)', async () => {
    vi.mocked(readFile).mockRejectedValueOnce(fsError('EPERM', 'EPERM: operation not permitted'));

    const source = createBundledSkillSource({ bundledRoot: '/some/root' });
    const result = await source.getByName('locked-skill');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(StorageError);
  });

  it('resolves to StorageError when readFile rejects with a non-code Error (unexpected rejection)', async () => {
    // A rejection without a `code` property must not be misclassified as ENOENT.
    vi.mocked(readFile).mockRejectedValueOnce(new Error('unexpected disk error'));

    const source = createBundledSkillSource({ bundledRoot: '/some/root' });
    const result = await source.getByName('some-skill');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(StorageError);
  });
});
