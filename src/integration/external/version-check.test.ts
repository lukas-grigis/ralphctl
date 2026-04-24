import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// VITEST is set automatically by the runner, which would short-circuit every
// call. These tests exercise the real logic, so the env var is cleared before
// the module is imported. `NO_NETWORK` is also cleared to keep paths clean.
describe('checkLatestVersion', () => {
  let tempDir: string;
  let previousVitest: string | undefined;
  let previousNoNetwork: string | undefined;
  let previousRoot: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ralphctl-vc-'));
    previousVitest = process.env['VITEST'];
    previousNoNetwork = process.env['NO_NETWORK'];
    previousRoot = process.env['RALPHCTL_ROOT'];
    delete process.env['VITEST'];
    delete process.env['NO_NETWORK'];
    process.env['RALPHCTL_ROOT'] = tempDir;
    vi.resetModules();
  });

  afterEach(() => {
    if (previousVitest === undefined) delete process.env['VITEST'];
    else process.env['VITEST'] = previousVitest;
    if (previousNoNetwork === undefined) delete process.env['NO_NETWORK'];
    else process.env['NO_NETWORK'] = previousNoNetwork;
    if (previousRoot === undefined) delete process.env['RALPHCTL_ROOT'];
    else process.env['RALPHCTL_ROOT'] = previousRoot;
    rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  async function load(): Promise<typeof import('./version-check.ts')> {
    return import('./version-check.ts');
  }

  function getCurrent(): string {
    const pkgPath = join(process.cwd(), 'package.json');
    return (JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }).version;
  }

  it('returns cached result without fetching when cache is fresh', async () => {
    const { checkLatestVersion } = await load();
    const current = getCurrent();
    const cached = {
      current,
      latest: '999.0.0',
      updateAvailable: true,
      checkedAt: new Date().toISOString(),
    };
    writeFileSync(join(tempDir, 'version-check.json'), JSON.stringify(cached), 'utf-8');

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));
    const result = await checkLatestVersion();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual(cached);
  });

  it('fetches, writes cache, and returns result on cache miss', async () => {
    const { checkLatestVersion } = await load();
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ version: '999.0.0' }), { status: 200 }));

    const result = await checkLatestVersion();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result).not.toBeNull();
    expect(result?.latest).toBe('999.0.0');
    expect(result?.updateAvailable).toBe(true);

    const cached = JSON.parse(readFileSync(join(tempDir, 'version-check.json'), 'utf-8')) as {
      latest: string;
    };
    expect(cached.latest).toBe('999.0.0');
  });

  it('returns null on fetch error without throwing', async () => {
    const { checkLatestVersion } = await load();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    const result = await checkLatestVersion();

    expect(result).toBeNull();
    expect(existsSync(join(tempDir, 'version-check.json'))).toBe(false);
  });

  it('refetches when cache is stale (>1h)', async () => {
    const { checkLatestVersion } = await load();
    const current = getCurrent();
    const stale = {
      current,
      latest: '1.0.0',
      updateAvailable: false,
      checkedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    };
    writeFileSync(join(tempDir, 'version-check.json'), JSON.stringify(stale), 'utf-8');

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ version: '2.0.0' }), { status: 200 }));

    const result = await checkLatestVersion();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result?.latest).toBe('2.0.0');
  });

  it('returns null without fetching when NO_NETWORK is set', async () => {
    process.env['NO_NETWORK'] = '1';
    const { checkLatestVersion } = await load();
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const result = await checkLatestVersion();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });
});

describe('compareVersions', () => {
  it('orders semver correctly', async () => {
    const { compareVersions } = await import('./version-check.ts');
    expect(compareVersions('1.2.3', '1.2.3')).toBe(0);
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.0.0', '1.0.0-beta')).toBe(0);
  });
});
