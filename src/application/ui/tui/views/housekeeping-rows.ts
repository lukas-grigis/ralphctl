/**
 * Pure presentation model for Housekeeping: the scan flattened into one ordered candidate list (so the one
 * windowed-list primitive can drive it), and the hub's one-line summary.
 */

import { plural } from '@src/application/ui/shared/plural.ts';
import { formatBytes } from '@src/application/ui/shared/format-bytes.ts';
import { glyphs } from '@src/application/ui/tui/theme/tokens.ts';
import {
  housekeepingCandidateKey,
  type HousekeepingCandidate,
  type HousekeepingScan,
} from '@src/business/housekeeping/scan-housekeeping.ts';

export type HousekeepingGroup = HousekeepingCandidate['kind'];

export const GROUP_LABELS: Readonly<Record<HousekeepingGroup, string>> = {
  'orphan-sprint': 'Orphan sprints',
  'orphan-memory': 'Orphan memory',
  'stale-sprint': 'Old done sprints',
  'stale-run': 'Old runs',
};

export interface HousekeepingRow {
  readonly key: string;
  readonly candidate: HousekeepingCandidate;
  readonly name: string;
  readonly detail: string;
}

const day = (iso: string): string => iso.slice(0, 10);

/** `<id>--<slug>` dir name → the slug: UUIDv7 ids share their leading timestamp bits, so a truncated id tells rows nothing. */
const readableDirName = (name: string): string => (name.includes('--') ? name.slice(name.indexOf('--') + 2) : name);

const describe = (c: HousekeepingCandidate): { readonly name: string; readonly detail: string } => {
  switch (c.kind) {
    case 'orphan-sprint':
      return { name: c.name, detail: `${c.status} ${glyphs.bullet} ${plural(c.ticketCount, 'ticket')}` };
    case 'orphan-memory':
      return { name: readableDirName(c.name), detail: 'project removed' };
    case 'stale-sprint':
      return { name: c.name, detail: `done ${day(c.doneAt)}` };
    case 'stale-run':
      return { name: `${c.flow}/${c.runId}`, detail: `started ${day(c.startedAt)}` };
  }
};

/** Sort key for `<id>--<slug>` dir names: the slug, so `ghost-2` precedes `ghost-10` (numeric collation). */
const naturalCompare = (a: { readonly name: string }, b: { readonly name: string }): number => {
  return (
    readableDirName(a.name).localeCompare(readableDirName(b.name), undefined, { numeric: true }) ||
    a.name.localeCompare(b.name, undefined, { numeric: true })
  );
};

export const buildHousekeepingRows = (scan: HousekeepingScan): readonly HousekeepingRow[] =>
  [
    ...[...scan.orphanSprints].sort(naturalCompare),
    ...[...scan.orphanMemoryDirs].sort(naturalCompare),
    ...scan.staleDoneSprints,
    ...scan.staleRuns,
  ].map((candidate) => ({
    key: housekeepingCandidateKey(candidate),
    candidate,
    ...describe(candidate),
  }));

/** `1.2 MB across 3 items` for whatever is picked. */
export const selectionTotals = (
  rows: readonly HousekeepingRow[],
  picked: ReadonlySet<string>
): { readonly count: number; readonly bytes: number } => {
  let count = 0;
  let bytes = 0;
  for (const row of rows) {
    if (!picked.has(row.key)) continue;
    count += 1;
    bytes += row.candidate.bytes;
  }
  return { count, bytes };
};

/** Per-group `Label N` fragments for the confirm body, in display order, skipping empty groups. */
export const groupCounts = (candidates: readonly HousekeepingCandidate[]): readonly string[] => {
  const counts = new Map<HousekeepingGroup, number>();
  for (const c of candidates) counts.set(c.kind, (counts.get(c.kind) ?? 0) + 1);
  return (Object.keys(GROUP_LABELS) as HousekeepingGroup[])
    .filter((g) => counts.has(g))
    .map((g) => `${GROUP_LABELS[g]} ${String(counts.get(g))}`);
};

/** System-hub summary: `6.4 MB reclaimable · 5 orphan sprints · 3 memory dirs`. */
export const housekeepingSummary = (scan: HousekeepingScan | undefined): string => {
  if (scan === undefined) return 'unavailable';
  if (scan.reclaimableBytes === 0 && scan.orphanSprints.length + scan.orphanMemoryDirs.length === 0) {
    return 'nothing to reclaim';
  }
  return [
    `${formatBytes(scan.reclaimableBytes)} reclaimable`,
    plural(scan.orphanSprints.length, 'orphan sprint'),
    plural(scan.orphanMemoryDirs.length, 'memory dir'),
  ].join(` ${glyphs.bullet} `);
};
