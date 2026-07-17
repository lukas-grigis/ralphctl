import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkBundleIntegrity, resolveManifestPath } from '@src/integration/system/bundle-integrity.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

describe('resolveManifestPath', () => {
  it('resolves manifest.json beside a hashed code-split chunk in bundle mode', () => {
    // What decides it is manifest.json sitting beside the module — NOT the artifact filename.
    // A hashed `cli-<hash>.mjs` code-split chunk (which a filename check would miss) resolves
    // identically to the `cli.mjs` entry stub.
    const beside = (p: string): boolean => p === '/pkg/dist/manifest.json';
    expect(resolveManifestPath('file:///pkg/dist/cli-CKPJ5SY4.mjs', beside)).toBe('/pkg/dist/manifest.json');
    expect(resolveManifestPath('file:///pkg/dist/cli.mjs', beside)).toBe('/pkg/dist/manifest.json');
  });

  it('returns undefined in dev, where nothing sits beside the module', () => {
    const never = (): boolean => false;
    expect(resolveManifestPath('file:///pkg/src/integration/system/bundle-integrity.ts', never)).toBeUndefined();
  });
});

describe('checkBundleIntegrity', () => {
  let root: string;
  let cleanup: () => Promise<void>;
  let moduleUrl: string;

  const writeManifest = async (manifest: unknown): Promise<void> => {
    await fs.writeFile(join(root, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  };

  const writeAsset = async (relPath: string): Promise<void> => {
    const abs = join(root, relPath);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, 'asset body', 'utf8');
  };

  beforeEach(async () => {
    const tmp = await makeTmpRoot();
    root = String(tmp.root);
    cleanup = tmp.cleanup;
    // Mirrors a published bundle: the probe module is compiled into a file that lives directly
    // beside `manifest.json` (`dist/cli.mjs` or one of tsup's hashed chunks) — the exact filename
    // doesn't matter, only that it sits in the same directory as `manifest.json`.
    moduleUrl = pathToFileURL(join(root, 'cli.mjs')).toString();
  });

  afterEach(async () => {
    await cleanup();
  });

  it('(d) skips silently in dev mode — no manifest.json beside the module', async () => {
    const result = await checkBundleIntegrity({ moduleUrl, currentVersion: '1.2.3' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ kind: 'skipped' });
  });

  it('(a) passes silently in bundle mode when every asset is present and the version matches', async () => {
    await writeAsset('prompts/refine/template.md');
    await writeAsset('skills/ralphctl-alignment/SKILL.md');
    await writeManifest({
      schemaVersion: 1,
      packageVersion: '1.2.3',
      generatedAt: new Date().toISOString(),
      assets: ['prompts/refine/template.md', 'skills/ralphctl-alignment/SKILL.md'],
    });

    const result = await checkBundleIntegrity({ moduleUrl, currentVersion: '1.2.3' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ kind: 'ok' });
  });

  it('(b) errors with a reinstall hint naming the missing count when asset(s) are absent', async () => {
    await writeAsset('prompts/refine/template.md');
    await writeManifest({
      schemaVersion: 1,
      packageVersion: '1.2.3',
      generatedAt: new Date().toISOString(),
      assets: ['prompts/refine/template.md', 'skills/ralphctl-alignment/SKILL.md', 'prompts/plan/template.md'],
    });

    const result = await checkBundleIntegrity({ moduleUrl, currentVersion: '1.2.3' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('missing 2');
    expect(result.error.message).toMatch(/reinstall ralphctl/);
    expect(result.error.hint).toMatch(/reinstall ralphctl/);
  });

  it('(c) errors with a reinstall hint when the manifest version does not match the running package', async () => {
    await writeManifest({
      schemaVersion: 1,
      packageVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      assets: [],
    });

    const result = await checkBundleIntegrity({ moduleUrl, currentVersion: '2.0.0' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('1.0.0');
    expect(result.error.message).toContain('2.0.0');
    expect(result.error.message).toMatch(/reinstall ralphctl/);
  });

  it('a version mismatch is reported even when assets are also missing (cheap check runs first)', async () => {
    await writeManifest({
      schemaVersion: 1,
      packageVersion: '1.0.0',
      generatedAt: new Date().toISOString(),
      assets: ['prompts/refine/template.md'],
    });

    const result = await checkBundleIntegrity({ moduleUrl, currentVersion: '2.0.0' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.subCode).toBe('schema-mismatch');
  });

  it('(e) degrades to a warning-level skip on an unparseable manifest, never a hard failure', async () => {
    await fs.writeFile(join(root, 'manifest.json'), 'not valid json {{{', 'utf8');

    const result = await checkBundleIntegrity({ moduleUrl, currentVersion: '1.2.3' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('malformed');
  });

  it('(e) degrades to a warning-level skip when the manifest does not match the expected shape', async () => {
    await writeManifest({ unexpected: 'shape' });

    const result = await checkBundleIntegrity({ moduleUrl, currentVersion: '1.2.3' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kind).toBe('malformed');
  });
});
