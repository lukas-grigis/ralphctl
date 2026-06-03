/**
 * `createBundledSkillSource` — implementation of {@link SkillSource} backed by the bundled
 * skill folders that live next to this module (`<name>/SKILL.md`).
 *
 * The set of skills returned per flow comes from {@link FLOW_SKILLS}. For each name in that
 * list, the source reads `<bundledRoot>/<name>/SKILL.md`, parses YAML frontmatter (`name`,
 * `description` — frontmatter `name` must match the folder name per the Agent Skills spec)
 * and returns the canonical {@link Skill} record.
 *
 * Resolution of the bundled root: in dev (`tsx`) the SKILL.md folders sit next to this file;
 * in a production bundle the build step copies them alongside, so `import.meta.url` resolves
 * correctly in both modes. Tests can override the root via `bundledRoot`.
 *
 * Parsing failures (missing file, malformed frontmatter, missing required fields) return a
 * `StorageError` with `subCode: 'parse'`. Production callers route the error to the log and
 * proceed with an empty skill set. The frontmatter split + naive-YAML reader + body extraction
 * live in `_engine/parse-skill.ts` so the operator source shares one parse implementation.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { FlowId } from '@src/integration/ai/skills/_engine/registry.ts';
import { skillsForFlow } from '@src/integration/ai/skills/_engine/registry.ts';
import { errorCode, parseSkill } from '@src/integration/ai/skills/_engine/parse-skill.ts';

// Default bundled root.
//   Dev (tsx): this module lives at src/integration/ai/skills/bundled/source.ts — SKILL.md
//     folders sit next to it.
//   Bundled (tsup): every source module collapses into `dist/cli.mjs`; `scripts/build-assets.ts`
//     copies SKILL.md folders to `dist/skills/<name>/SKILL.md`.
const defaultBundledRoot = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const isBundled = import.meta.url.endsWith('/cli.mjs') || import.meta.url.endsWith('\\cli.mjs');
  return isBundled ? join(here, 'skills') : here;
})();

export interface BundledSkillSourceDeps {
  /** Override for tests. Production resolves the bundled root next to this module. */
  readonly bundledRoot?: string;
}

/**
 * Read + parse a SKILL.md when the file is REQUIRED — a missing file is a hard `io` error.
 * Used by `getForFlow` / `loadOne`, where every name in the flow's set must resolve.
 */
const readSkill = async (root: string, name: string): Promise<Result<Skill, StorageError>> => {
  const path = join(root, name, 'SKILL.md');
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (cause) {
    return Result.error(
      new StorageError({ subCode: 'io', message: `bundled skill not readable: ${path}`, path, cause })
    );
  }
  return parseSkill('bundled skill', path, name, raw);
};

/**
 * Read + parse a SKILL.md when the file is OPTIONAL — absence means the name is unknown.
 * A single async read attempt avoids the TOCTOU window an `existsSync` + read pair opens: a
 * missing file (`ENOENT`) resolves to `ok(undefined)` (caller scaffolds a stub); ANY other read
 * failure (`EISDIR` / `EACCES` / …) or a malformed body surfaces as a `StorageError`, exactly as
 * the file-required path would.
 */
const readSkillOptional = async (root: string, name: string): Promise<Result<Skill | undefined, StorageError>> => {
  const path = join(root, name, 'SKILL.md');
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (cause) {
    if (errorCode(cause) === 'ENOENT') return Result.ok(undefined);
    return Result.error(
      new StorageError({ subCode: 'io', message: `bundled skill not readable: ${path}`, path, cause })
    );
  }
  return parseSkill('bundled skill', path, name, raw);
};

export const createBundledSkillSource = (deps: BundledSkillSourceDeps = {}): SkillSource => {
  const root = deps.bundledRoot ?? defaultBundledRoot;
  const cache = new Map<string, Skill>();

  const loadOne = async (name: string): Promise<Result<Skill, StorageError>> => {
    const cached = cache.get(name);
    if (cached !== undefined) return Result.ok(cached);
    const r = await readSkill(root, name);
    if (r.ok) cache.set(name, r.value);
    return r;
  };

  return {
    async getForFlow(flowId: FlowId): Promise<Result<readonly Skill[], StorageError>> {
      const names = skillsForFlow(flowId);
      const skills: Skill[] = [];
      for (const name of names) {
        const r = await loadOne(name);
        if (!r.ok) return Result.error(r.error);
        skills.push(r.value);
      }
      return Result.ok(skills);
    },

    async getByName(name: string): Promise<Result<Skill | undefined, StorageError>> {
      // Unknown name → not an error. A missing `<root>/<name>/SKILL.md` means the suggestion
      // doesn't correspond to a bundled skill; the caller scaffolds a stub instead. A single
      // async read (no `existsSync` pre-check) closes the TOCTOU window: if the file vanishes
      // between a check and the read it would otherwise surface as a spurious `StorageError`.
      // A genuine read/parse failure (malformed frontmatter, EACCES, …) still surfaces as a
      // `StorageError` — only `ENOENT` collapses to the unknown-name case.
      const cached = cache.get(name);
      if (cached !== undefined) return Result.ok(cached);
      const r = await readSkillOptional(root, name);
      if (r.ok && r.value !== undefined) cache.set(name, r.value);
      return r;
    },
  };
};
