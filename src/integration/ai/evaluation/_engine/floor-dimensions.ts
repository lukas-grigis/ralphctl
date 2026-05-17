/**
 * Floor evaluation dimensions — the four universal axes every task is graded on, regardless
 * of whether the planner emitted any per-task `extraDimensions`. The names are stable and
 * lowercased for parser/plateau-detection use; the descriptions are mirrored into the
 * evaluate prompt template so the AI sees one consistent rubric.
 *
 * Floor + extra are concatenated when rendering the evaluate prompt:
 *   - Floor first, in the order below.
 *   - Extra after, in the order the planner emitted.
 *   - The parser does not distinguish floor from extra at extraction time — both flow
 *     through the same `**Name** (score 1-5): N — finding` line shape.
 */

export interface FloorDimension {
  readonly name: string;
  readonly description: string;
}

export const FLOOR_DIMENSIONS: readonly FloorDimension[] = [
  {
    name: 'Correctness',
    description:
      'Does the implementation do what the specification says? Check for: logical errors, off-by-one, race conditions, type issues; behaviour matches each verification criterion (grade each one explicitly); edge cases handled where specified.',
  },
  {
    name: 'Completeness',
    description:
      'Is the full specification implemented? Check for: every verification criterion satisfied (not just most); no steps skipped or partially implemented; no TODO/FIXME/HACK markers left behind that indicate unfinished work; partially-implemented criteria or half-finished tests.',
  },
  {
    name: 'Safety',
    description:
      'Are there security or reliability issues? Check for: injection vulnerabilities (SQL, command, XSS); validation gaps on external input; exposed secrets, hardcoded credentials; unsafe error handling that leaks internals.',
  },
  {
    name: 'Consistency',
    description:
      'Does the implementation fit the codebase? Check for: follows existing patterns and conventions (naming, structure, error handling); uses existing utilities instead of reinventing them; no unnecessary changes outside the task scope (spec drift); test patterns match the project existing test style.',
  },
];

/** Lowercased name set used by the parser to recognise floor dimensions deterministically. */
export const FLOOR_DIMENSION_NAMES: ReadonlySet<string> = new Set(FLOOR_DIMENSIONS.map((d) => d.name.toLowerCase()));
