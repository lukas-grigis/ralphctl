import type { LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';

const PENDING_MARKER = '○ pending';
const PROMOTED_MARKER = '● promoted';

/** Zero-pad a number to two digits. */
const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * Absolute date+time from an ISO timestamp string, rendered in the user's LOCAL timezone:
 * `2025-05-16T10:07:42.123Z` → `2025-05-16 12:07` (UTC+2). Falls back to the raw ISO slice on a
 * parse failure so a malformed timestamp never throws or renders "NaN".
 *
 * Mirrors the TUI's `fmtIsoAbsolute` deliberately — `application/flows/**` may not import from
 * `application/ui/**` (ESLint-fenced), and this is a trivial pure date format, so it is inlined here
 * rather than reaching across the layer. Tests pin `TZ` for a deterministic column.
 */
const fmtLocalAbsolute = (iso: string): string => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.slice(0, 16).replace('T', ' ');
  return `${String(d.getFullYear())}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/**
 * Render the full learnings ledger as a human-readable `learnings.md` mirror. Includes EVERY record
 * — both promoted (folded into a project context file) and pending (still a proposal) — each tagged
 * with a clear marker, so the file is a complete browsable view of what the project has learned.
 *
 * Grouping: by repository name, then by task-kind within each repo, so related learnings cluster.
 * Within a group, records keep their ledger order (chronological — the ledger is append-only and
 * UUIDv7-ordered). Each record shows its insight text, optional context + applies-to, a LOCAL-time
 * timestamp (via {@link fmtIsoAbsolute}, the shared TUI formatter — the file is read by a human in
 * their own timezone), and the promoted/pending marker.
 *
 * Pure — no I/O, deterministic for a given record set + local timezone. Pin `TZ` in tests for a
 * stable timestamp column.
 *
 * @public
 */
export const renderLearningsMd = (records: readonly LearningRecord[]): string => {
  const lines: string[] = ['# Learnings', ''];

  if (records.length === 0) {
    lines.push('_No learnings recorded yet._', '');
    return lines.join('\n');
  }

  const promoted = records.filter((r) => r.promotedAt !== null).length;
  lines.push(
    `${String(records.length)} learning${records.length === 1 ? '' : 's'} — ${String(promoted)} promoted, ${String(records.length - promoted)} pending.`,
    ''
  );

  for (const [repoName, repoRecords] of groupBy(records, (r) => r.repoName)) {
    lines.push(`## ${repoName}`, '');
    for (const [taskKind, kindRecords] of groupBy(repoRecords, (r) => r.taskKind)) {
      lines.push(`### ${taskKind}`, '');
      for (const record of kindRecords) {
        lines.push(...renderRecord(record));
      }
    }
  }

  return lines.join('\n');
};

/** Render one record as a markdown bullet block: marker + insight, then context / applies-to / when. */
const renderRecord = (record: LearningRecord): readonly string[] => {
  const marker = record.promotedAt === null ? PENDING_MARKER : PROMOTED_MARKER;
  const out: string[] = [`- **${marker}** ${oneLine(record.text)}`];
  if (record.context !== undefined && record.context.trim().length > 0) {
    out.push(`  - _Context:_ ${oneLine(record.context)}`);
  }
  if (record.appliesTo !== undefined && record.appliesTo.trim().length > 0) {
    out.push(`  - _Applies to:_ ${oneLine(record.appliesTo)}`);
  }
  const when = record.promotedAt === null ? record.timestamp : record.promotedAt;
  out.push(`  - _${record.promotedAt === null ? 'Recorded' : 'Promoted'}:_ ${fmtLocalAbsolute(when)}`);
  out.push('');
  return out;
};

/** Collapse internal newlines / runs of whitespace so a multi-line insight renders as one bullet. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/**
 * Stable group-by preserving first-seen key order and within-group record order. Returns an array of
 * `[key, records]` pairs (not a Map) so the caller iterates deterministically.
 */
const groupBy = <T>(items: readonly T[], keyOf: (item: T) => string): ReadonlyArray<readonly [string, T[]]> => {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [item]);
    else bucket.push(item);
  }
  return [...groups.entries()];
};
