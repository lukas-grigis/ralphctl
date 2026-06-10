import type { LearningEntry } from '@src/domain/signal.ts';

/**
 * Compose the same-round generator observations the evaluator receives as ENVIRONMENT HINTS
 * (T5). The block is deliberately unverified context — the `renderGeneratorHintsSection` renderer
 * frames it adversarially ("unverified claims — never evidence"), so this helper's only job is to
 * supply clean, compact content. The evaluator still runs every `auto` criterion itself.
 *
 * Sources (all from `ImplementCtx`, accumulated by the generator leaf this attempt):
 *  - `commitSubject`  — the generator's proposed commit subject (what it says it changed, in one line).
 *  - `changes`        — granular `change` signals ("added X", "renamed Y").
 *  - `learnings`      — `learning` signals (environment notes: ports, servers, tooling quirks).
 *  - `notes`          — free-form `note` signals.
 *
 * Pure — no I/O, deterministic. Prefer the most round-recent items (the accumulators are
 * append-order, so the TAIL is most recent) and cap the section so a multi-round attempt's
 * accumulators don't balloon the evaluator prompt. Empty across all sources → '' so the
 * `{{GENERATOR_HINTS_SECTION}}` placeholder disappears.
 */

/** Max number of bullet lines per hint subsection (changes / learnings / notes). */
export const HINTS_MAX_ITEMS_PER_KIND = 8;

/** Hard ceiling on total rendered lines so the section can't balloon a many-round attempt's prompt. */
export const HINTS_MAX_LINES = 30;

/** Per-item character clamp — one hint line should never carry a paragraph. */
const HINT_ITEM_MAX_CHARS = 200;

export interface GeneratorHintsInput {
  readonly commitSubject?: string;
  readonly changes?: readonly string[];
  readonly learnings?: readonly LearningEntry[];
  readonly notes?: readonly string[];
}

const clampLine = (raw: string): string => {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > HINT_ITEM_MAX_CHARS ? `${oneLine.slice(0, HINT_ITEM_MAX_CHARS - 1)}…` : oneLine;
};

/** Keep the most-recent (tail) N non-empty items, clamped to one line each. */
const recentBullets = (items: readonly string[] | undefined, max: number): string[] =>
  (items ?? [])
    .map(clampLine)
    .filter((s) => s.length > 0)
    .slice(-max)
    .map((s) => `- ${s}`);

/** A learning renders as its insight plus an inline "(applies to …)" when present. */
const learningLine = (entry: LearningEntry): string => {
  const insight = clampLine(entry.text);
  if (insight.length === 0) return '';
  const where =
    entry.appliesTo !== undefined && entry.appliesTo.trim().length > 0
      ? ` (applies to ${clampLine(entry.appliesTo)})`
      : '';
  return clampLine(`${insight}${where}`);
};

const recentLearningBullets = (entries: readonly LearningEntry[] | undefined, max: number): string[] =>
  (entries ?? [])
    .map(learningLine)
    .filter((s) => s.length > 0)
    .slice(-max)
    .map((s) => `- ${s}`);

export const composeGeneratorHints = (input: GeneratorHintsInput): string => {
  const blocks: string[] = [];

  const subject = input.commitSubject !== undefined ? clampLine(input.commitSubject) : '';
  if (subject.length > 0) blocks.push(`Proposed commit: ${subject}`);

  const changes = recentBullets(input.changes, HINTS_MAX_ITEMS_PER_KIND);
  if (changes.length > 0) blocks.push(['Changes the generator says it made:', ...changes].join('\n'));

  const learnings = recentLearningBullets(input.learnings, HINTS_MAX_ITEMS_PER_KIND);
  if (learnings.length > 0) blocks.push(['Environment notes / learnings:', ...learnings].join('\n'));

  const notes = recentBullets(input.notes, HINTS_MAX_ITEMS_PER_KIND);
  if (notes.length > 0) blocks.push(['Notes:', ...notes].join('\n'));

  if (blocks.length === 0) return '';

  // Hard line cap across the whole section — drop trailing lines (least-recent blocks ride last)
  // rather than emit an unbounded section on a deep multi-round attempt.
  const lines = blocks.join('\n\n').split('\n');
  if (lines.length <= HINTS_MAX_LINES) return lines.join('\n');
  return [...lines.slice(0, HINTS_MAX_LINES), '… (additional generator hints omitted)'].join('\n');
};
