/**
 * Shared SKILL.md parsing helpers — the canonical frontmatter split + naive-YAML reader + body
 * extraction that every {@link SkillSource} backed by on-disk `SKILL.md` folders consumes.
 *
 * The generic split/YAML/error-code primitives live in `./frontmatter.ts` — shared byte-for-byte
 * with `agents/_engine/parse-agent-definition.ts`, which reaches into this module's sibling via
 * the documented cross-concept `_engine`-to-`_engine` import seam (both formats use the same
 * flat `key: value` frontmatter shape). This module re-exports `errorCode` so existing skill-
 * source callers (`bundled/source.ts`, `operator/source.ts`, `phase/*.ts`) are unaffected.
 *
 * `parseSkill` validates against {@link SkillFrontmatterSchema} and asserts frontmatter `name`
 * matches the on-disk folder name per the Agent Skills spec. The `label` parameter tailors the
 * error message prefix so a caller can say "bundled skill X" vs "operator skill X".
 */

import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { errorCode, parseSimpleYaml, splitFrontmatter } from '@src/integration/ai/skills/_engine/frontmatter.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import { SkillFrontmatterSchema } from '@src/integration/ai/skills/_engine/skill.ts';

export { errorCode };

/**
 * Parse an already-read SKILL.md body into the canonical {@link Skill} record. Split from the
 * read so a file-required path and an optional-file path can share the frontmatter-validation
 * tail. `label` prefixes the error message (`bundled skill` / `operator skill`).
 *
 * @public
 */
export const parseSkill = (label: string, path: string, name: string, raw: string): Result<Skill, StorageError> => {
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = parseSimpleYaml(frontmatter);
  const parsed = SkillFrontmatterSchema.safeParse(fm);
  if (!parsed.success) {
    return Result.error(
      new StorageError({
        subCode: 'parse',
        message: `${label} ${name}: invalid frontmatter (${parsed.error.message})`,
        path,
      })
    );
  }
  if (parsed.data.name !== name) {
    return Result.error(
      new StorageError({
        subCode: 'parse',
        message: `${label} ${name}: frontmatter name '${parsed.data.name}' must match folder name`,
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
