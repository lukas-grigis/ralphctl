import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetDistAssetManifestCacheForTesting, verifyDistAssets } from './dist-asset-manifest.ts';

function uniqueRoot(): string {
  return join(
    tmpdir(),
    `ralphctl-dist-manifest-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
  );
}

describe('verifyDistAssets', () => {
  let distRoot: string;

  beforeEach(async () => {
    distRoot = uniqueRoot();
    await mkdir(distRoot, { recursive: true });
    resetDistAssetManifestCacheForTesting();
  });

  afterEach(async () => {
    await rm(distRoot, { recursive: true, force: true });
  });

  it('no-op (Result.ok) when no manifest.json is present — dev mode', async () => {
    const r = await verifyDistAssets(distRoot);
    expect(r.ok).toBe(true);
  });

  it('passes when every listed asset exists', async () => {
    await mkdir(join(distRoot, 'prompts'), { recursive: true });
    await writeFile(join(distRoot, 'prompts', 'a.md'), 'a body', 'utf8');
    await writeFile(join(distRoot, 'prompts', 'b.md'), 'b body', 'utf8');
    await writeFile(
      join(distRoot, 'manifest.json'),
      JSON.stringify({
        version: 1,
        generatedAt: '2026-05-04T00:00:00.000Z',
        assets: ['prompts/a.md', 'prompts/b.md'],
      }),
      'utf8'
    );
    const r = await verifyDistAssets(distRoot);
    expect(r.ok).toBe(true);
  });

  it('fails with a clear repair hint when a listed asset is missing', async () => {
    await mkdir(join(distRoot, 'prompts'), { recursive: true });
    await writeFile(join(distRoot, 'prompts', 'a.md'), 'a body', 'utf8');
    await writeFile(
      join(distRoot, 'manifest.json'),
      JSON.stringify({
        version: 1,
        generatedAt: '2026-05-04T00:00:00.000Z',
        assets: ['prompts/a.md', 'prompts/b.md'],
      }),
      'utf8'
    );
    const r = await verifyDistAssets(distRoot);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain('prompts/b.md');
    expect(r.error.message).toContain('pnpm build');
  });

  it('caches the pass result so a second call does not re-stat', async () => {
    await writeFile(join(distRoot, 'a.md'), 'a body', 'utf8');
    await writeFile(
      join(distRoot, 'manifest.json'),
      JSON.stringify({
        version: 1,
        generatedAt: '2026-05-04T00:00:00.000Z',
        assets: ['a.md'],
      }),
      'utf8'
    );

    const first = await verifyDistAssets(distRoot);
    expect(first.ok).toBe(true);

    // Delete the file post-verification — the cache should keep the
    // verification at `pass` so the second call still succeeds, proving
    // the result is cached rather than re-computed.
    await rm(join(distRoot, 'a.md'));
    const second = await verifyDistAssets(distRoot);
    expect(second.ok).toBe(true);
  });

  it('reports a parse error when manifest.json is not valid JSON', async () => {
    await writeFile(join(distRoot, 'manifest.json'), '{not json}', 'utf8');
    const r = await verifyDistAssets(distRoot);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.subCode).toBe('parse');
    expect(r.error.message).toContain('not valid JSON');
  });

  it('reports a schema-mismatch error when the version is wrong', async () => {
    await writeFile(join(distRoot, 'manifest.json'), JSON.stringify({ version: 2, assets: [] }), 'utf8');
    const r = await verifyDistAssets(distRoot);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.subCode).toBe('schema-mismatch');
  });

  it('reports a schema-mismatch error when assets is missing', async () => {
    await writeFile(join(distRoot, 'manifest.json'), JSON.stringify({ version: 1, generatedAt: 'now' }), 'utf8');
    const r = await verifyDistAssets(distRoot);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.subCode).toBe('schema-mismatch');
  });

  it('rejects a manifest with a non-string asset entry', async () => {
    await writeFile(join(distRoot, 'manifest.json'), JSON.stringify({ version: 1, assets: ['ok.md', 42] }), 'utf8');
    const r = await verifyDistAssets(distRoot);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.subCode).toBe('schema-mismatch');
    expect(r.error.message).toContain('non-string asset entry');
  });

  it('caches the failure too — a second call returns the same error without re-statting', async () => {
    await writeFile(join(distRoot, 'manifest.json'), JSON.stringify({ version: 1, assets: ['absent.md'] }), 'utf8');
    const first = await verifyDistAssets(distRoot);
    expect(first.ok).toBe(false);

    // Now create the file — but the cached failure should still surface.
    await writeFile(join(distRoot, 'absent.md'), 'now exists', 'utf8');
    const second = await verifyDistAssets(distRoot);
    expect(second.ok).toBe(false);
  });
});
