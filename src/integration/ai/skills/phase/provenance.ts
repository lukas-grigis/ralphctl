/**
 * Provenance stamping + status derivation for copy-on-enable skills.
 *
 * When the catalog enables a bundled skill for a flow it copies the bundled folder into
 * `<appRoot>/skills/<flow>/<name>/` VERBATIM and drops a `.provenance.json` sidecar next to the
 * copied `SKILL.md`. The sidecar records where the copy came from and a content hash of the
 * `SKILL.md` bytes at copy time. That stamp is what later lets the catalog answer three questions
 * for each installed folder without diffing whole files:
 *
 *   - did the operator edit their copy?            hash(folder SKILL.md) ≠ stamp.contentHash
 *   - did the bundled skill change upstream?       stamp.contentHash ≠ hash(current bundled SKILL.md)
 *   - otherwise                                    in-sync
 *
 * All three hashes MUST be taken over the same representation — the raw `SKILL.md` bytes — so the
 * catalog's enable/update path copies the bundled file verbatim (no parse → re-render round-trip)
 * and stamps `hashSkillContent(rawBundledBytes)`. The {@link SkillSource} pipeline that feeds the
 * provider adapters is a separate concern and never reads or writes this sidecar (per the design:
 * a `Skill` is `{ name, description, content }` from `SKILL.md` only).
 *
 * Writes go through the injected atomic {@link WriteFile} seam (`business/io/write-file.ts`) so a
 * concurrent reader never sees a half-written stamp. Reads use a raw `node:fs` read — consistent
 * with the sibling `SkillSource` implementations, and a missing / malformed sidecar is a soft
 * signal (`ok(undefined)`), not a failure: an unstamped folder is simply a manually-dropped skill.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { errorCode } from '@src/integration/ai/skills/_engine/parse-skill.ts';
import type { SkillInstallStatus } from '@src/integration/ai/skills/_engine/skill-catalog-port.ts';

/** Sidecar filename written inside every catalog-managed skill folder. @public */
export const PROVENANCE_FILENAME = '.provenance.json';

/**
 * On-disk shape of `.provenance.json`. Only bundled copies are stamped today, so `source` is the
 * literal `'bundled'`; `skill` is the `ralphctl-*` id, `contentHash` the sha256 hex of the copied
 * `SKILL.md` raw bytes, and `copiedAt` an ISO-8601 timestamp of the copy.
 *
 * @public
 */
export interface ProvenanceStamp {
  readonly source: 'bundled';
  readonly skill: string;
  readonly contentHash: string;
  readonly ralphctlVersion: string;
  readonly copiedAt: string;
}

/** sha256 hex of a `SKILL.md`'s raw content. Pure — the canonical hash for every comparison. @public */
export const hashSkillContent = (raw: string): string => createHash('sha256').update(raw, 'utf-8').digest('hex');

/**
 * Derive a folder's sync status relative to its bundled origin. Pure — the caller supplies the raw
 * bytes of the on-disk `SKILL.md`, the parsed stamp (or `undefined` for an unstamped folder), and
 * the raw bytes of the current bundled `SKILL.md`.
 *
 * Precedence is deliberate: `locally-modified` is checked before `update-available` so that when
 * BOTH divergences hold (the operator edited their copy AND the bundle moved on) we report the
 * edit. `update`/`updateAll` overwrite, so surfacing `locally-modified` is what keeps a local edit
 * from being silently discarded.
 *
 * @public
 */
export const deriveStatus = (input: {
  readonly folderSkillMdRaw: string;
  readonly stamp: ProvenanceStamp | undefined;
  readonly currentBundledRaw: string;
}): SkillInstallStatus => {
  const { folderSkillMdRaw, stamp, currentBundledRaw } = input;
  if (stamp === undefined) return 'manual';
  if (hashSkillContent(folderSkillMdRaw) !== stamp.contentHash) return 'locally-modified';
  if (stamp.contentHash !== hashSkillContent(currentBundledRaw)) return 'update-available';
  return 'in-sync';
};

/**
 * Hand-parse a `.provenance.json` body into a {@link ProvenanceStamp}. Returns `undefined` for any
 * malformation (not JSON, wrong `source`, or a missing/blank required field) — callers treat a
 * malformed sidecar the same as a missing one (the folder is a manually-dropped skill), so this
 * never throws or errors.
 */
const parseProvenance = (raw: string): ProvenanceStamp | undefined => {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof data !== 'object' || data === null) return undefined;
  const rec = data as Record<string, unknown>;
  const nonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (rec.source !== 'bundled') return undefined;
  if (!nonEmptyString(rec.skill)) return undefined;
  if (!nonEmptyString(rec.contentHash)) return undefined;
  if (!nonEmptyString(rec.ralphctlVersion)) return undefined;
  if (!nonEmptyString(rec.copiedAt)) return undefined;
  return {
    source: 'bundled',
    skill: rec.skill,
    contentHash: rec.contentHash,
    ralphctlVersion: rec.ralphctlVersion,
    copiedAt: rec.copiedAt,
  };
};

const serializeStamp = (stamp: ProvenanceStamp): string => `${JSON.stringify(stamp, null, 2)}\n`;

const sidecarPathIn = (skillDir: AbsolutePath): string => join(String(skillDir), PROVENANCE_FILENAME);

/** Dependencies for {@link createProvenanceStore}. @public */
export interface ProvenanceStoreDeps {
  /** Atomic write seam — `createAtomicWriteFile()` in production, a fake in tests. */
  readonly writeFile: WriteFile;
}

/** Read/write access to skill-folder `.provenance.json` sidecars. @public */
export interface ProvenanceStore {
  /** Atomically write `<skillDir>/.provenance.json` from `stamp`. Overwrites any existing sidecar. */
  writeProvenance(skillDir: AbsolutePath, stamp: ProvenanceStamp): Promise<Result<void, StorageError>>;
  /**
   * Read + parse `<skillDir>/.provenance.json`. A missing file OR a malformed body resolves to
   * `ok(undefined)` — both mean "not a catalog-stamped folder", which is a normal state (a
   * manually-dropped skill), not an error. Only a hard read failure (permissions, EISDIR, …)
   * surfaces as `StorageError`.
   */
  readProvenance(skillDir: AbsolutePath): Promise<Result<ProvenanceStamp | undefined, StorageError>>;
}

/**
 * Build a {@link ProvenanceStore} over the injected atomic {@link WriteFile} seam.
 *
 * @public
 */
export const createProvenanceStore = (deps: ProvenanceStoreDeps): ProvenanceStore => ({
  async writeProvenance(skillDir, stamp) {
    const path = sidecarPathIn(skillDir);
    // `skillDir` is already absolute, so joining a constant filename keeps it absolute — this
    // parse only fails on a programmer error, which we surface as a StorageError rather than throw.
    const abs = AbsolutePath.parse(path);
    if (!abs.ok) {
      return Result.error(
        new StorageError({ subCode: 'io', message: `provenance sidecar path is not absolute: ${path}`, path })
      );
    }
    return deps.writeFile(abs.value, serializeStamp(stamp));
  },

  async readProvenance(skillDir) {
    const path = sidecarPathIn(skillDir);
    let raw: string;
    try {
      raw = await readFile(path, 'utf-8');
    } catch (cause) {
      if (errorCode(cause) === 'ENOENT') return Result.ok(undefined);
      return Result.error(
        new StorageError({ subCode: 'io', message: `provenance sidecar not readable: ${path}`, path, cause })
      );
    }
    return Result.ok(parseProvenance(raw));
  },
});
