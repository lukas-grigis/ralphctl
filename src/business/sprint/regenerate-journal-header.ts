import { extractLifecycleBreadcrumbs, splitJournal } from '@src/business/sprint/journal-structure.ts';

/**
 * Pure compose for the regenerate-in-place journal write path (`progress-journal` leaf).
 *
 * `<sprintDir>/progress.md` is a regenerated DERIVED header band followed by append-only attempt
 * sections. On every per-attempt append the leaf rebuilds the header band from canonical data while
 * preserving the append-only sections verbatim:
 *
 *  1. split the existing file into header band + attempt sections;
 *  2. carry forward the lifecycle breadcrumbs (status separators + quarantine pointers) that lived
 *     in the OLD header band — the derived state subsumes the rest;
 *  3. drop the new derived `stateHeader` in front;
 *  4. re-emit every existing section verbatim, then the new one.
 *
 * Boundaries are normalized (each block separated by one blank line, trailing newline) so the result
 * is deterministic and idempotent — regenerating an already-regenerated file is a no-op on shape.
 * Section interiors are never touched, so the `## Task: ` delimiter and every prior warning/escalation
 * survive byte-for-byte inside their section.
 *
 * Pure — no I/O.
 */

interface RegenerateJournalInput {
  /** Existing file content. Empty string when the file is absent (first append of a sprint). */
  readonly existing: string;
  /** Freshly-rendered derived state header band (`renderSprintStateHeader`). */
  readonly stateHeader: string;
  /** Freshly-rendered attempt section to append (`renderJournalEntry`). */
  readonly newSection: string;
}

/** Parse the stable `- created: <iso>` line from a header band, if present. */
export const parseJournalCreatedAt = (headerBand: string): string | undefined => {
  const match = /^- created: (.+)$/m.exec(headerBand);
  return match?.[1]?.trim();
};

export const regenerateJournal = (input: RegenerateJournalInput): string => {
  const { headerBand, sections } = splitJournal(input.existing);
  const breadcrumbs = extractLifecycleBreadcrumbs(headerBand);
  const blocks = [
    input.stateHeader.replace(/\s+$/, ''),
    ...breadcrumbs,
    ...sections.map((s) => s.trim()),
    input.newSection.trim(),
  ].filter((b) => b.length > 0);
  return `${blocks.join('\n\n')}\n`;
};
