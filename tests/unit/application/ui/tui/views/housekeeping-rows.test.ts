import { describe, expect, it } from 'vitest';
import { buildHousekeepingRows } from '@src/application/ui/tui/views/housekeeping-rows.ts';
import type { HousekeepingScan } from '@src/business/housekeeping/scan-housekeeping.ts';

const memory = (name: string): HousekeepingScan['orphanMemoryDirs'][number] => ({
  kind: 'orphan-memory',
  projectId: name.slice(0, 8),
  name,
  bytes: 1,
});

const scanWith = (names: readonly string[]): HousekeepingScan =>
  ({
    staleAfterDays: 30,
    orphanSprints: [],
    orphanMemoryDirs: names.map(memory),
    staleDoneSprints: [],
    staleRuns: [],
    runTotals: { count: 0, bytes: 0 },
    reclaimableBytes: 0,
  }) as unknown as HousekeepingScan;

describe('buildHousekeepingRows', () => {
  it('shows the slug of an orphan memory dir and orders naturally — ghost-2 before ghost-10', () => {
    const rows = buildHousekeepingRows(
      scanWith(['0190aaaa-0000--ghost-10', '0190bbbb-0000--ghost-2', '0190cccc-0000--ghost-1'])
    );
    expect(rows.map((r) => r.name)).toEqual(['ghost-1', 'ghost-2', 'ghost-10']);
  });
});
