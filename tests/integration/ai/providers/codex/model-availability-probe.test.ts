/**
 * Codex model-availability probe — reads `<baseDir>/.codex/models_cache.json` and narrows the
 * supplied catalog to entries whose `visibility === 'list'`. Every error path fails open: the
 * full catalog is returned unchanged. Tests inject a tmpdir as `baseDir` (the production seam
 * defaults to `os.homedir()`).
 */

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCodexModelAvailabilityProbe } from '@src/integration/ai/providers/codex/model-availability-probe.ts';
import { CODEX_MODELS } from '@src/domain/value/settings-models/codex.ts';

const writeCache = async (baseDir: string, contents: string): Promise<void> => {
  const codexDir = join(baseDir, '.codex');
  await mkdir(codexDir, { recursive: true });
  await writeFile(join(codexDir, 'models_cache.json'), contents, 'utf8');
};

describe('createCodexModelAvailabilityProbe', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await realpath(await mkdtemp(join(tmpdir(), 'ralphctl-codex-models-')));
  });

  afterEach(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  it('returns only catalog models whose cache entry has visibility "list"', async () => {
    const listed = [CODEX_MODELS[0]!, CODEX_MODELS[1]!];
    await writeCache(
      baseDir,
      JSON.stringify({
        models: listed.map((slug) => ({ slug, display_name: slug, visibility: 'list', supported_in_api: true })),
      })
    );
    const probe = createCodexModelAvailabilityProbe({ baseDir });
    const available = await probe.availableModels(CODEX_MODELS);
    expect(available).toEqual(listed);
  });

  it('excludes catalog models whose cache entry has visibility "hide"', async () => {
    const visible = CODEX_MODELS[0]!;
    const hidden = CODEX_MODELS[1]!;
    await writeCache(
      baseDir,
      JSON.stringify({
        models: [
          { slug: visible, display_name: visible, visibility: 'list', supported_in_api: true },
          { slug: hidden, display_name: hidden, visibility: 'hide', supported_in_api: true },
        ],
      })
    );
    const probe = createCodexModelAvailabilityProbe({ baseDir });
    const available = await probe.availableModels(CODEX_MODELS);
    expect(available).toContain(visible);
    expect(available).not.toContain(hidden);
  });

  it('fails open (returns the full catalog) when every relevant entry is hidden', async () => {
    // Cache lists only catalog slugs, all `visibility:"hide"` → filtered result is empty. An empty
    // result is a probe miss, so the probe must fail open to the full catalog (never zero models).
    await writeCache(
      baseDir,
      JSON.stringify({
        models: CODEX_MODELS.map((slug) => ({
          slug,
          display_name: slug,
          visibility: 'hide',
          supported_in_api: true,
        })),
      })
    );
    const probe = createCodexModelAvailabilityProbe({ baseDir });
    const available = await probe.availableModels(CODEX_MODELS);
    expect(available).toEqual(CODEX_MODELS);
  });

  it('fails open when no listed slug intersects the catalog', async () => {
    // Cache has a listed entry, but its slug is not in CODEX_MODELS → filtered result is empty.
    await writeCache(
      baseDir,
      JSON.stringify({
        models: [{ slug: 'codex-not-a-real-model', display_name: 'ghost', visibility: 'list', supported_in_api: true }],
      })
    );
    const probe = createCodexModelAvailabilityProbe({ baseDir });
    const available = await probe.availableModels(CODEX_MODELS);
    expect(available).toEqual(CODEX_MODELS);
  });

  it('fails open (returns the full catalog) when the cache file is missing', async () => {
    // No file written under baseDir/.codex → ENOENT.
    const probe = createCodexModelAvailabilityProbe({ baseDir });
    const available = await probe.availableModels(CODEX_MODELS);
    expect(available).toEqual(CODEX_MODELS);
  });

  it('fails open when the cache file is malformed JSON', async () => {
    await writeCache(baseDir, '{ this is not valid json');
    const probe = createCodexModelAvailabilityProbe({ baseDir });
    const available = await probe.availableModels(CODEX_MODELS);
    expect(available).toEqual(CODEX_MODELS);
  });

  it('fails open when `models` is missing or not an array (unexpected shape)', async () => {
    await writeCache(baseDir, JSON.stringify({ models: { not: 'an array' } }));
    const probe = createCodexModelAvailabilityProbe({ baseDir });
    const available = await probe.availableModels(CODEX_MODELS);
    expect(available).toEqual(CODEX_MODELS);
  });
});
