import type { LearningEntry } from '@src/domain/signal.ts';

/**
 * Dedupe structured learnings by insight text, preserving first-seen order and
 * trimming the insight. Entries whose insight is empty / whitespace-only are
 * dropped. The first occurrence of each insight is kept verbatim (its context /
 * applies-to ride along); later duplicates are discarded.
 *
 * Identity is the insight only — context and applies-to do NOT affect dedup,
 * matching the ledger's {@link import('@src/application/flows/_shared/memory/learning-record.ts').deriveLearningId}.
 *
 * Shared by the progress-journal and append-learnings leaves.
 */
export function dedupeLearnings(entries: readonly LearningEntry[]): LearningEntry[] {
  const seen = new Set<string>();
  const out: LearningEntry[] = [];
  for (const entry of entries) {
    const text = entry.text.trim();
    if (text.length === 0) continue;
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ ...entry, text });
  }
  return out;
}
