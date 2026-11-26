/**
 * Shared SKILL.md parsing helpers — the canonical frontmatter split + YAML reader + body
 * extraction that every {@link SkillSource} backed by on-disk `SKILL.md` folders consumes.
 *
 * The generic split/YAML primitives live in `./frontmatter.ts`, shared with
 * `agents/_engine/parse-agent-definition.ts` via the `_engine`-to-`_engine` import seam.
 *
 * `parseSkill` validates against {@link SkillFrontmatterSchema} and asserts frontmatter `name`
 * matches the on-disk folder name per the Agent Skills spec. The `label` parameter tailors the
 * error message prefix so a caller can say "bundled skill X" vs "operator skill X".
 */

import { Result } from '@src/domain/result.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import { parseYamlFrontmatter, splitFrontmatter } from '@src/integration/ai/skills/_engine/frontmatter.ts';
import type { Skill } from '@src/integration/ai/skills/_engine/skill.ts';
import { SkillFrontmatterSchema, TYPED_FRONTMATTER_KEYS } from '@src/integration/ai/skills/_engine/skill.ts';

/**
 * Parse an already-read SKILL.md body into the canonical {@link Skill} record. Split from the
 * read so a file-required path and an optional-file path can share the frontmatter-validation
 * tail. `label` prefixes the error message (`bundled skill` / `operator skill`).
 */
export const parseSkill = (label: string, path: string, name: string, raw: string): Result<Skill, StorageError> => {
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = parseYamlFrontmatter(frontmatter);
  if (!fm.ok) {
    return Result.error(
      new StorageError({
        subCode: 'parse',
        message: `${label} ${name}: frontmatter is not valid YAML (${fm.error})`,
        path,
      })
    );
  }
  const parsed = SkillFrontmatterSchema.safeParse(fm.value);
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
  const extra = Object.fromEntries(Object.entries(fm.value).filter(([key]) => !TYPED_FRONTMATTER_KEYS.has(key)));
  return Result.ok({
    name: parsed.data.name,
    description: parsed.data.description,
    ...(parsed.data.license !== undefined ? { license: parsed.data.license } : {}),
    ...(parsed.data.compatibility !== undefined ? { compatibility: parsed.data.compatibility } : {}),
    ...(parsed.data['allowed-tools'] !== undefined ? { allowedTools: parsed.data['allowed-tools'] } : {}),
    ...(Object.keys(extra).length > 0 ? { extraFrontmatter: extra } : {}),
    content: body,
  });
};
