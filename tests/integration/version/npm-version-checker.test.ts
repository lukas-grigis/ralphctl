import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { createNpmVersionChecker } from '@src/integration/version/npm-version-checker.ts';

const makeStateRoot = async (): Promise<AbsolutePath> => {
  const dir = await mkdtemp(join(tmpdir(), 'ralphctl-version-check-'));
  const parsed = AbsolutePath.parse(dir);
  if (!parsed.ok) throw new Error(`could not parse tmp path: ${parsed.error.message}`);
  return parsed.value;
};

const fakeFetchOk = (version: string): typeof fetch =>
  (async () => new Response(JSON.stringify({ version }), { status: 200 })) as typeof fetch;

const fakeFetchFail = (): typeof fetch =>
  (async () => {
    throw new Error('network down');
  }) as typeof fetch;

describe('createNpmVersionChecker', () => {
  // The adapter short-circuits to null when VITEST is set so the test process never tries to
  // hit the real registry. Strip the env var inside the test's env override so we exercise the
  // real fetch path; production reads `process.env` directly so the global env is untouched.
  const env: NodeJS.ProcessEnv = {};

  let stateRoot: AbsolutePath;
  beforeEach(async () => {
    stateRoot = await makeStateRoot();
  });
  afterEach(() => {
    // tmpdir cleanup is best-effort across the suite; leave it to the OS.
  });

  it('reports an update when registry latest > current', async () => {
    const checker = createNpmVersionChecker({
      stateRoot,
      currentVersion: '0.1.0',
      packageName: 'ralphctl',
      env,
      fetchImpl: fakeFetchOk('0.2.0'),
      clock: () => Date.parse('2026-01-15T12:00:00Z'),
    });
    const result = await checker();
    expect(result?.updateAvailable).toBe(true);
    expect(result?.current).toBe('0.1.0');
    expect(result?.latest).toBe('0.2.0');
  });

  it('reports no update when current matches latest', async () => {
    const checker = createNpmVersionChecker({
      stateRoot,
      currentVersion: '0.2.0',
      packageName: 'ralphctl',
      env,
      fetchImpl: fakeFetchOk('0.2.0'),
      clock: () => Date.parse('2026-01-15T12:00:00Z'),
    });
    const result = await checker();
    expect(result?.updateAvailable).toBe(false);
  });

  it('returns null on fetch failure', async () => {
    const checker = createNpmVersionChecker({
      stateRoot,
      currentVersion: '0.1.0',
      packageName: 'ralphctl',
      env,
      fetchImpl: fakeFetchFail(),
      clock: () => Date.parse('2026-01-15T12:00:00Z'),
    });
    expect(await checker()).toBeNull();
  });

  it('returns null when NO_NETWORK is set', async () => {
    const checker = createNpmVersionChecker({
      stateRoot,
      currentVersion: '0.1.0',
      packageName: 'ralphctl',
      env: { NO_NETWORK: '1' },
      // intentionally throw if fetch is called — we should never reach it
      fetchImpl: (async () => {
        throw new Error('should not fetch when NO_NETWORK set');
      }) as typeof fetch,
      clock: () => Date.parse('2026-01-15T12:00:00Z'),
    });
    expect(await checker()).toBeNull();
  });

  it('returns null when VITEST is set (production safeguard)', async () => {
    const checker = createNpmVersionChecker({
      stateRoot,
      currentVersion: '0.1.0',
      packageName: 'ralphctl',
      env: { VITEST: 'true' },
      fetchImpl: (async () => {
        throw new Error('should not fetch when VITEST set');
      }) as typeof fetch,
      clock: () => Date.parse('2026-01-15T12:00:00Z'),
    });
    expect(await checker()).toBeNull();
  });

  it('writes a cache file readers can decode', async () => {
    const checker = createNpmVersionChecker({
      stateRoot,
      currentVersion: '0.1.0',
      packageName: 'ralphctl',
      env,
      fetchImpl: fakeFetchOk('0.2.0'),
      clock: () => Date.parse('2026-01-15T12:00:00Z'),
    });
    const fresh = await checker();
    expect(fresh).not.toBeNull();
    const cached = await readFile(join(String(stateRoot), 'version-check.json'), 'utf-8');
    const parsed = JSON.parse(cached) as Record<string, unknown>;
    expect(parsed['current']).toBe('0.1.0');
    expect(parsed['latest']).toBe('0.2.0');
    expect(parsed['updateAvailable']).toBe(true);
  });

  it('returns the cached value on a second call within TTL without refetching', async () => {
    let fetchCount = 0;
    const counting: typeof fetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 });
    }) as typeof fetch;

    const checker = createNpmVersionChecker({
      stateRoot,
      currentVersion: '0.1.0',
      packageName: 'ralphctl',
      env,
      fetchImpl: counting,
      clock: () => Date.parse('2026-01-15T12:00:00Z'),
      cacheTtlMs: 60 * 60 * 1000,
    });

    await checker();
    await checker();
    expect(fetchCount).toBe(1);
  });

  it('refetches when the cache is older than the TTL', async () => {
    let fetchCount = 0;
    const counting: typeof fetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 });
    }) as typeof fetch;

    let now = Date.parse('2026-01-15T12:00:00Z');
    const checker = createNpmVersionChecker({
      stateRoot,
      currentVersion: '0.1.0',
      packageName: 'ralphctl',
      env,
      fetchImpl: counting,
      clock: () => now,
      cacheTtlMs: 60 * 60 * 1000, // 1h
    });

    await checker();
    now += 2 * 60 * 60 * 1000; // jump 2h forward
    await checker();
    expect(fetchCount).toBe(2);
  });

  it('refetches when current version changed since the cache was written', async () => {
    // Pre-populate a stale cache under an older `current` version.
    await mkdir(String(stateRoot), { recursive: true });
    await writeFile(
      join(String(stateRoot), 'version-check.json'),
      JSON.stringify({
        current: '0.0.9',
        latest: '0.2.0',
        updateAvailable: true,
        checkedAt: '2026-01-15T11:00:00Z',
      }),
      'utf-8'
    );

    let fetchCount = 0;
    const counting: typeof fetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 });
    }) as typeof fetch;

    const checker = createNpmVersionChecker({
      stateRoot,
      currentVersion: '0.1.0', // user upgraded from 0.0.9 → 0.1.0
      packageName: 'ralphctl',
      env,
      fetchImpl: counting,
      clock: () => Date.parse('2026-01-15T12:00:00Z'),
    });

    const result = await checker();
    expect(fetchCount).toBe(1);
    expect(result?.current).toBe('0.1.0');
  });

  it('returns null on a malformed registry payload', async () => {
    const malformed: typeof fetch = (async () =>
      new Response(JSON.stringify({ wrongShape: true }), { status: 200 })) as typeof fetch;
    const checker = createNpmVersionChecker({
      stateRoot,
      currentVersion: '0.1.0',
      packageName: 'ralphctl',
      env,
      fetchImpl: malformed,
      clock: () => Date.parse('2026-01-15T12:00:00Z'),
    });
    expect(await checker()).toBeNull();
  });

  it('returns null on a non-2xx registry response', async () => {
    const notFound: typeof fetch = (async () => new Response('Not Found', { status: 404 })) as typeof fetch;
    const checker = createNpmVersionChecker({
      stateRoot,
      currentVersion: '0.1.0',
      packageName: 'ralphctl',
      env,
      fetchImpl: notFound,
      clock: () => Date.parse('2026-01-15T12:00:00Z'),
    });
    expect(await checker()).toBeNull();
  });

  it('returns null when the cache file is corrupted', async () => {
    await mkdir(String(stateRoot), { recursive: true });
    await writeFile(join(String(stateRoot), 'version-check.json'), '{not-json', 'utf-8');

    let fetchCount = 0;
    const counting: typeof fetch = (async () => {
      fetchCount++;
      return new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 });
    }) as typeof fetch;

    const checker = createNpmVersionChecker({
      stateRoot,
      currentVersion: '0.1.0',
      packageName: 'ralphctl',
      env,
      fetchImpl: counting,
      clock: () => Date.parse('2026-01-15T12:00:00Z'),
    });

    // Corrupt cache → adapter falls through to fetch → returns the fresh result.
    const result = await checker();
    expect(fetchCount).toBe(1);
    expect(result?.latest).toBe('0.2.0');
  });
});
