import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '../../domain/values/absolute-path.ts';
import { detectLegacyLayout } from './legacy-detector.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(tmpdir(), `ralphctl-legacy-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  );
}

describe('detectLegacyLayout', () => {
  let root: AbsolutePath;

  beforeEach(() => {
    root = uniqueRoot();
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('flags a temp directory containing config.json at the root', async () => {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, 'config.json'), '{}', 'utf8');

    const result = await detectLegacyLayout({ root });

    expect(result.isLegacy).toBe(true);
    expect(result.legacyConfigPath).toBe(join(root, 'config.json'));
    expect(result.hint).toContain('Legacy 0.5.x layout detected');
    expect(result.hint).toContain(root);
    expect(result.hint).toContain('0.5-backup');
  });

  it('returns not-legacy when config lives under config/config.json (new layout)', async () => {
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'config.json'), '{}', 'utf8');

    const result = await detectLegacyLayout({ root });

    expect(result.isLegacy).toBe(false);
    expect(result.legacyConfigPath).toBeNull();
    expect(result.hint).toBe('');
  });

  it('returns not-legacy on an empty / missing root', async () => {
    // Root not created — fs.access fails.
    const result = await detectLegacyLayout({ root });
    expect(result.isLegacy).toBe(false);
  });

  it('returns not-legacy on an empty existing directory', async () => {
    await mkdir(root, { recursive: true });
    const result = await detectLegacyLayout({ root });
    expect(result.isLegacy).toBe(false);
  });
});
