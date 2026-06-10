import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelAvailabilityProbe } from '@src/integration/ai/providers/_engine/model-availability-probe.ts';

/** Relative path of the Codex model cache under the user's home directory. */
const CODEX_MODELS_CACHE_REL = join('.codex', 'models_cache.json');

/**
 * One entry of the Codex `models_cache.json` `models` array. Only the fields the probe reads are
 * typed; the cache carries more that we ignore.
 */
interface CodexCacheEntry {
  readonly slug: string;
  readonly visibility: 'list' | 'hide';
}

const isListedEntry = (entry: unknown): entry is CodexCacheEntry =>
  typeof entry === 'object' &&
  entry !== null &&
  typeof (entry as { slug?: unknown }).slug === 'string' &&
  (entry as { visibility?: unknown }).visibility === 'list';

export interface CodexModelAvailabilityProbeOptions {
  /**
   * Base directory the `.codex/models_cache.json` path resolves under. Defaults to
   * `os.homedir()`; tests inject a tmpdir so the probe is exercisable without a real `$HOME`.
   */
  readonly baseDir?: string;
}

/**
 * Real Codex model-availability probe. Reads `<baseDir>/.codex/models_cache.json` and keeps only
 * catalog entries whose `visibility === 'list'`. Fails open on missing file (ENOENT), parse error,
 * unexpected shape, or AbortError — every error path returns the full `catalog` unchanged. Also
 * fails open when the filtered result is empty (no slug intersects, or every entry is hidden): an
 * empty list is a probe miss, so the full catalog is returned rather than zero models.
 *
 * @public
 */
export const createCodexModelAvailabilityProbe = (
  options: CodexModelAvailabilityProbeOptions = {}
): ModelAvailabilityProbe => ({
  async availableModels(catalog: readonly string[], signal?: AbortSignal): Promise<readonly string[]> {
    const cachePath = join(options.baseDir ?? homedir(), CODEX_MODELS_CACHE_REL);
    try {
      const raw = await readFile(cachePath, { encoding: 'utf8', ...(signal !== undefined ? { signal } : {}) });
      const parsed: unknown = JSON.parse(raw);
      const models = (parsed as { models?: unknown }).models;
      // Defensive: a missing or non-array `models` field is an unexpected shape — fail open.
      if (!Array.isArray(models)) return catalog;
      const listedSlugs = new Set<string>(models.filter(isListedEntry).map((entry) => entry.slug));
      const available = catalog.filter((model) => listedSlugs.has(model));
      // A cache that yields zero usable models (every relevant entry `visibility:"hide"`, or no
      // slug intersects the catalog) is a probe miss, not a real "nothing available" answer — fail
      // open to the full catalog so the picker never shows zero models. Single point of control.
      return available.length > 0 ? available : catalog;
    } catch {
      // Best-effort probe, NOT inside a chain — absorb every error (ENOENT, parse error,
      // unexpected shape, AbortError) and fall open to the full catalog rather than re-throwing.
      // The picker must never block; AbortError is intentionally swallowed here because this probe
      // runs outside the chain runtime where the propagate-AbortError rule applies.
      return catalog;
    }
  },
});

/** Production probe bound to the real home directory. @public */
export const codexModelAvailabilityProbe: ModelAvailabilityProbe = createCodexModelAvailabilityProbe();
