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
 * proceed with an empty skill set.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import { SkillFrontmatterSchema } from '@src/integration/ai/skills/_engine/skill.ts';
import type { SkillSource } from '@src/integration/ai/skills/_engine/skill-source.ts';
import type { FlowId } from '@src/integration/ai/skills/_engine/registry.ts';
import { skillsForFlow } from '@src/integration/ai/skills/_engine/registry.ts';

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
 * Parse a SKILL.md body into frontmatter + content. The frontmatter block is the first
 * `---` … `---` pair starting at the file's first non-whitespace line; everything after the
 * closing fence is the body. Returns the body verbatim when no frontmatter is present —
 * callers then validate frontmatter separately.
 */
const splitFrontmatter = (raw: string): { readonly frontmatter: string; readonly body: string } => {
  const trimmed = raw.replace(/^\uFEFF/u, ''); // strip UTF-8 BOM
  if (!trimmed.startsWith('---')) return { frontmatter: '', body: trimmed };
  const closing = trimmed.indexOf('\n---', 3);
  if (closing === -1) return { frontmatter: '', body: trimmed };
  const frontmatter = trimmed.slice(3, closing).trim();
  const afterClose = trimmed.slice(closing + 4); // skip "\n---"
  // Strip the line-end after the closing fence so the body is clean.
  const body = afterClose.replace(/^\r?\n/, '');
  return { frontmatter, body };
};

/**
 * Naive YAML key:value parser — keys are simple identifiers, values are strings or single-quoted
 * strings without escapes. Frontmatter we control is always this shape, so a full YAML parser
 * is overkill (and adds a dep). Multiline / nested YAML is rejected via schema validation.
 */
const parseSimpleYaml = (input: string): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const line of input.split('\n')) {
    const stripped = line.trim();
    if (stripped.length === 0 || stripped.startsWith('#')) continue;
    const colon = stripped.indexOf(':');
    if (colon === -1) continue;
    const key = stripped.slice(0, colon).trim();
    let value = stripped.slice(colon + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    result[key] = value;
  }
  return result;
};

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
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = parseSimpleYaml(frontmatter);
  const parsed = SkillFrontmatterSchema.safeParse(fm);
  if (!parsed.success) {
    return Result.error(
      new StorageError({
        subCode: 'parse',
        message: `bundled skill ${name}: invalid frontmatter (${parsed.error.message})`,
        path,
      })
    );
  }
  if (parsed.data.name !== name) {
    return Result.error(
      new StorageError({
        subCode: 'parse',
        message: `bundled skill ${name}: frontmatter name '${parsed.data.name}' must match folder name`,
        path,
      })
    );
  }
  return Result.ok({
    name: parsed.data.name,
    description: parsed.data.description,
    ...(parsed.data.license !== undefined ? { license: parsed.data.license } : {}),
    ...(parsed.data.compatibility !== undefined ? { compatibility: parsed.data.compatibility } : {}),
    ...(parsed.data['allowed-tools'] !== undefined ? { allowedTools: parsed.data['allowed-tools'] } : {}),
    content: body,
  });
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
      // doesn't correspond to a bundled skill; the caller scaffolds a stub instead. We test
      // for the file up front so a genuine read/parse failure (malformed frontmatter) still
      // surfaces as a `StorageError` via `loadOne`.
      const cached = cache.get(name);
      if (cached !== undefined) return Result.ok(cached);
      if (!existsSync(join(root, name, 'SKILL.md'))) return Result.ok(undefined);
      return loadOne(name);
    },
  };
};
