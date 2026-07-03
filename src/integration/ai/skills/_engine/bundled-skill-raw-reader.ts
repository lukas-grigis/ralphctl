/**
 * Port for reading the RAW (unparsed) bytes of a bundled skill's `SKILL.md`, keyed by skill name.
 *
 * Exists so the phase-scoped skill catalog (`phase/catalog.ts`) can hash + copy a bundled skill
 * VERBATIM without importing the `bundled/` sibling directly — `integration/ai/skills/<x>`
 * siblings may only reach into `_engine/` (see the SKILLS sibling-isolation fence in
 * `eslint.config.ts`, `siblingIsolationRule` over `integration/ai/skills`, keyed on `SKILLS`, allowing only `_engine`).
 * The concrete implementation ({@link createBundledSkillRawReader}) lives next to
 * `createBundledSkillSource` in `bundled/source.ts`, sharing its bundled-root resolution; the
 * composition root (`wire()`) is the only place that imports both this port and that concrete
 * together, which is exactly the shape the fence is designed to allow.
 *
 * Kept separate from the parsed {@link SkillSource} port: the catalog's provenance hashing MUST
 * be computed over the exact on-disk bytes (see `phase/provenance.ts`'s module doc), so a
 * parse → re-render round trip through `SkillSource` would silently change the hash the
 * operator's copy is compared against.
 */

import type { Result } from '@src/domain/result.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

/** @public */
export interface BundledSkillRawReader {
  /**
   * Read `<bundledRoot>/<name>/SKILL.md` verbatim (no frontmatter parsing, no re-render). `name`
   * is expected to be a registered `BUNDLED_SKILLS` entry — a missing file surfaces as a
   * `StorageError` (the bundled root is the single source of truth for the catalog's own
   * entries, so a missing file for a registered name is a build/packaging bug, not a soft
   * "not found").
   */
  readRaw(name: string): Promise<Result<string, StorageError>>;
}
