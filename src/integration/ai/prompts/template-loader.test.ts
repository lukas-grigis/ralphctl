import { mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AbsolutePath } from '@src/domain/values/absolute-path.ts';
import { defaultTemplatesDir, FileTemplateLoader } from './template-loader.ts';

function uniqueRoot(): AbsolutePath {
  return AbsolutePath.trustString(
    join(
      tmpdir(),
      `ralphctl-template-loader-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`
    )
  );
}

describe('FileTemplateLoader', () => {
  let dir: AbsolutePath;

  beforeEach(async () => {
    dir = uniqueRoot();
    await mkdir(dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads a template from an explicit directory', async () => {
    await writeFile(join(dir, 'hello.md'), '# hello\n', 'utf-8');
    const loader = new FileTemplateLoader({ templatesDir: dir });
    const r = await loader.load('hello');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('# hello\n');
  });

  it('returns a StorageError with subCode "io" when the file is missing', async () => {
    const loader = new FileTemplateLoader({ templatesDir: dir });
    const r = await loader.load('does-not-exist');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.subCode).toBe('io');
      expect(r.error.message).toMatch(/not found/);
      expect(r.error.path).toContain('does-not-exist.md');
    }
  });

  it('caches loaded templates per-instance (second read does not hit the filesystem)', async () => {
    const file = join(dir, 'cached.md');
    await writeFile(file, 'first\n', 'utf-8');
    const loader = new FileTemplateLoader({ templatesDir: dir });

    const a = await loader.load('cached');
    expect(a.ok).toBe(true);
    if (a.ok) expect(a.value).toBe('first\n');

    // Mutate the file. If the cache works, we still see "first\n".
    await writeFile(file, 'second\n', 'utf-8');
    const b = await loader.load('cached');
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.value).toBe('first\n');
  });

  it('uses the bundled `templates/` directory by default in dev', async () => {
    // The default resolver should land on a directory containing the real
    // templates we copied into src. We assert one of the well-known
    // templates is loadable through the default seam.
    const loader = new FileTemplateLoader();
    const r = await loader.load('ticket-refine');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatch(/Requirements Refinement Protocol/);
  });

  it('exposes the resolved default directory for inspection', () => {
    const dirPath = defaultTemplatesDir();
    expect(typeof dirPath).toBe('string');
    expect(dirPath.length).toBeGreaterThan(0);
  });

  it('does not consult the filesystem on the second call (cache check)', async () => {
    const file = join(dir, 'spy.md');
    await writeFile(file, 'cached body', 'utf-8');
    const loader = new FileTemplateLoader({ templatesDir: dir });

    const a = await loader.load('spy');
    expect(a.ok).toBe(true);

    // Delete the file. If the cache works, the second load still succeeds
    // and returns the same body — proving readFile was not called again.
    await unlink(file);
    const b = await loader.load('spy');
    expect(b.ok).toBe(true);
    if (b.ok) expect(b.value).toBe('cached body');
  });
});
