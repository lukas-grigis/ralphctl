/**
 * Contract for `application/bootstrap/run-bundle-integrity-check.ts` — the seam both
 * composition roots (`ui/cli/bootstrap.ts`, `ui/tui/launch.ts`) actually call. The core
 * `checkBundleIntegrity` probe is mocked (its own dual-mode / manifest-shape behaviour is
 * covered by `tests/integration/system/bundle-integrity.test.ts`) so this suite asserts only the
 * three branches `runBundleIntegrityCheck` adds on top: throw-on-error, warn-on-malformed, and
 * silence otherwise.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@src/business/observability/logger.ts';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { BundleIntegrityStatus } from '@src/integration/system/bundle-integrity.ts';
import { runBundleIntegrityCheck } from '@src/application/bootstrap/run-bundle-integrity-check.ts';

const checkBundleIntegrityMock = vi.hoisted(() => vi.fn());

vi.mock('@src/integration/system/bundle-integrity.ts', () => ({
  checkBundleIntegrity: checkBundleIntegrityMock,
}));

const fakeLogger = (): { readonly logger: Logger; readonly warn: ReturnType<typeof vi.fn> } => {
  const warn = vi.fn();
  const noop = vi.fn();
  const logger: Logger = {
    debug: noop,
    info: noop,
    warn,
    error: noop,
    named: () => logger,
  };
  return { logger, warn };
};

describe('runBundleIntegrityCheck', () => {
  it('throws with the actionable message when the core check reports Result.error (missing assets / version mismatch)', async () => {
    checkBundleIntegrityMock.mockResolvedValueOnce(
      Result.error(
        new StorageError({
          subCode: 'io',
          message: 'ralphctl install is missing 2 bundled asset(s) declared in dist/manifest.json. reinstall ralphctl.',
        })
      )
    );
    const { logger, warn } = fakeLogger();

    await expect(runBundleIntegrityCheck(logger)).rejects.toThrow(
      /bundle-integrity: ralphctl install is missing 2 bundled asset\(s\)/
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs a warning (does not throw) when the core check reports kind 'malformed'", async () => {
    const status: BundleIntegrityStatus = { kind: 'malformed', reason: 'dist/manifest.json: invalid JSON' };
    checkBundleIntegrityMock.mockResolvedValueOnce(Result.ok(status));
    const { logger, warn } = fakeLogger();

    await expect(runBundleIntegrityCheck(logger)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toBe('bundle-integrity: dist/manifest.json: invalid JSON');
  });

  it("is silent — no throw, no warn — when the core check reports kind 'ok'", async () => {
    const status: BundleIntegrityStatus = { kind: 'ok' };
    checkBundleIntegrityMock.mockResolvedValueOnce(Result.ok(status));
    const { logger, warn } = fakeLogger();

    await expect(runBundleIntegrityCheck(logger)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("is silent — no throw, no warn — when the core check reports kind 'skipped' (dev mode)", async () => {
    const status: BundleIntegrityStatus = { kind: 'skipped' };
    checkBundleIntegrityMock.mockResolvedValueOnce(Result.ok(status));
    const { logger, warn } = fakeLogger();

    await expect(runBundleIntegrityCheck(logger)).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
