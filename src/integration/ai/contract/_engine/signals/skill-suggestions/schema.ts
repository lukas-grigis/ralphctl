import { z } from 'zod';
import type { SkillSuggestionsSignal } from '@src/domain/signal.ts';
import { IsoTimestampSchema } from '@src/integration/persistence/shared/value-schemas.ts';
import type { Compatible } from '@src/integration/persistence/shared/codec-internal.ts';
import { SkillNameSchema } from '@src/integration/ai/skills/_engine/skill.ts';

/**
 * Upper bound on suggestions the harness carries forward. Each surviving name costs the operator
 * one blocking confirm prompt in the readiness offer leaf, so an unbounded list is a way for a
 * runaway (or hostile) model to wall the operator in with prompts. A realistic round suggests a
 * handful; 20 is far above that and still bounded.
 *
 * @public
 */
export const MAX_SKILL_SUGGESTIONS = 20;

/**
 * Zod schema for the `skill-suggestions` AI signal — kebab-case skill names the AI
 * recommends linking into the agentic working directory. Empty `names` is the canonical
 * "no suggestions" state.
 *
 * `names` is the one AI-controlled string in this contract that becomes a filesystem path: the
 * readiness offer leaf turns each accepted name into `<repo>/<parentDir>/skills/<name>/SKILL.md`.
 * So the wire schema is the first containment boundary — every element must be a bare kebab-case
 * identifier ({@link SkillNameSchema}), which rules out separators, `..`, absolute paths, and the
 * embedded newline that would otherwise inject extra keys into the rendered YAML frontmatter.
 *
 * Out-of-shape names are DROPPED rather than failing the parse: the signal is advisory and the
 * array parse is all-or-nothing, so one mis-cased suggestion would otherwise discard the whole
 * readiness round (the context-file proposal included). Same leniency stance as the `timestamp`
 * defaulting and the `body`/`text` alias in `validateSignalsFile`. The skills adapter re-validates
 * the name at the mkdir/writeFile seam, so dropping here never becomes the only line of defence.
 */
export const skillSuggestionsSignalSchema = z.object({
  type: z.literal('skill-suggestions'),
  names: z
    .array(z.string())
    .transform((names) =>
      names.filter((name) => SkillNameSchema.safeParse(name).success).slice(0, MAX_SKILL_SUGGESTIONS)
    )
    .readonly(),
  timestamp: IsoTimestampSchema,
});

const _typeCheck: Compatible<z.infer<typeof skillSuggestionsSignalSchema>, SkillSuggestionsSignal> = true;
void _typeCheck;
