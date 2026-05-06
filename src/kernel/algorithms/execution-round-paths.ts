/**
 * Pure path helpers that compute the canonical sub-paths inside a per-task
 * execution unit folder (`<sprintDir>/execution/<unit-slug>/`).
 *
 * Single source of truth — every caller (chain leaves, the multi-round
 * evaluate-and-fix loop in `business/`, tests) routes through these helpers
 * so a future folder rename is a single edit and the business layer can
 * compute paths without importing from `integration/`.
 *
 * All helpers return plain `string`s; callers wrap with
 * `AbsolutePath.trustString` only at the boundary where the value is
 * surfaced as a domain value. Zero IO; zero deps beyond `node:path`.
 */
import { join } from 'node:path';

/**
 * Per-round root folder: `<unitRoot>/rounds/<round>/`.
 */
export function roundDir(unitRoot: string, round: number): string {
  return join(unitRoot, 'rounds', String(round));
}

/**
 * Generator audit folder for a round: `<unitRoot>/rounds/<round>/generator/`.
 * The per-task chain stamps `session.md` (and retry-suffixed siblings) here.
 */
export function generatorRoundDir(unitRoot: string, round: number): string {
  return join(roundDir(unitRoot, round), 'generator');
}

/**
 * Evaluator artefacts for a round: `<unitRoot>/rounds/<round>/evaluator/`.
 * The evaluate-and-fix loop writes `prompt.md`, `evaluation.md`, and
 * `session.md` under this folder.
 */
export function evaluatorRoundDir(unitRoot: string, round: number): string {
  return join(roundDir(unitRoot, round), 'evaluator');
}

/**
 * Per-invocation folder for the standalone `sprint evaluate` command:
 * `<unitRoot>/rounds/standalone-<iso>/`. Each invocation lays down a
 * fresh, distinct artefact pack alongside its prior siblings.
 */
export function standaloneRoundDir(unitRoot: string, iso: string): string {
  return join(unitRoot, 'rounds', `standalone-${iso}`);
}

/**
 * Sprint-relative path of a per-round verdict file:
 * `execution/<slug>/rounds/<round>/evaluator/evaluation.md`.
 *
 * Stamped on `Task.evaluationFile` so the recorded value remains
 * portable across moved data dirs / machines. Single source of truth
 * for the layout — call this instead of hand-rolling the relative
 * path so a future folder rename is one edit.
 */
export function evaluatorVerdictSprintRelative(slug: string, round: number): string {
  return join('execution', slug, 'rounds', String(round), 'evaluator', 'evaluation.md');
}

/**
 * Sprint-relative path of a standalone-round verdict file:
 * `execution/<slug>/rounds/standalone-<iso>/evaluator/evaluation.md`.
 *
 * Mirror of {@link evaluatorVerdictSprintRelative} for the
 * `sprint evaluate` re-run path; kept symmetric so neither call site
 * needs to encode the layout itself.
 */
export function standaloneEvaluatorVerdictSprintRelative(slug: string, iso: string): string {
  return join('execution', slug, 'rounds', `standalone-${iso}`, 'evaluator', 'evaluation.md');
}
