import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatRelativeAge,
  groupByFlow,
  listRuns,
  parseDuration,
  parseRunTimestamp,
  type RunEntry,
} from '@src/integration/ai/runs/_engine/run-enumeration.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';

describe('parseDuration', () => {
  it('accepts hours / days / weeks', () => {
    const h = parseDuration('24h');
    const d = parseDuration('7d');
    const w = parseDuration('2w');
    expect(h.ok && h.value).toBe(24 * 60 * 60 * 1000);
    expect(d.ok && d.value).toBe(7 * 24 * 60 * 60 * 1000);
    expect(w.ok && w.value).toBe(2 * 7 * 24 * 60 * 60 * 1000);
  });

  it('rejects unsupported suffixes with a clear error message', () => {
    const minutes = parseDuration('5m');
    expect(minutes.ok).toBe(false);
    if (!minutes.ok) expect(minutes.error.message).toContain("unsupported duration suffix 'm'");
    const years = parseDuration('1y');
    expect(years.ok).toBe(false);
    if (!years.ok) expect(years.error.message).toContain("unsupported duration suffix 'y'");
  });

  it('rejects zero and negative values', () => {
    const zero = parseDuration('0d');
    expect(zero.ok).toBe(false);
    const neg = parseDuration('-3h');
    expect(neg.ok).toBe(false);
  });

  it('rejects unparsable input', () => {
    const garbage = parseDuration('abc');
    expect(garbage.ok).toBe(false);
    const empty = parseDuration('');
    expect(empty.ok).toBe(false);
    const noSuffix = parseDuration('7');
    expect(noSuffix.ok).toBe(false);
  });
});

describe('parseRunTimestamp', () => {
  it('returns a Date for a buildRunDirName-style name', () => {
    const parsed = parseRunTimestamp('2026-05-19T19-56-56-781Z-abc123');
    expect(parsed).not.toBeNull();
    expect(parsed?.toISOString()).toBe('2026-05-19T19:56:56.781Z');
  });

  it('returns null for a non-conforming name', () => {
    expect(parseRunTimestamp('legacy-folder')).toBeNull();
    expect(parseRunTimestamp('2026-05-19_run')).toBeNull();
  });
});

describe('formatBytes', () => {
  it('renders sub-KiB values in bytes', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
  });

  it('rolls over to KiB / MiB / GiB', () => {
    expect(formatBytes(2048)).toMatch(/KiB$/);
    expect(formatBytes(5 * 1024 * 1024)).toMatch(/MiB$/);
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toMatch(/GiB$/);
  });
});

describe('formatRelativeAge', () => {
  it('describes coarse buckets', () => {
    const now = new Date('2026-05-19T12:00:00.000Z');
    expect(formatRelativeAge(new Date('2026-05-19T11:59:30.000Z'), now)).toBe('30s ago');
    expect(formatRelativeAge(new Date('2026-05-19T11:30:00.000Z'), now)).toBe('30m ago');
    expect(formatRelativeAge(new Date('2026-05-19T06:00:00.000Z'), now)).toBe('6h ago');
    expect(formatRelativeAge(new Date('2026-05-15T12:00:00.000Z'), now)).toBe('4d ago');
    expect(formatRelativeAge(new Date('2026-05-01T12:00:00.000Z'), now)).toBe('2w ago');
  });

  it('reports unknown age for null timestamps', () => {
    expect(formatRelativeAge(null)).toBe('unknown age');
  });
});

describe('listRuns', () => {
  let tmp: Awaited<ReturnType<typeof makeTmpRoot>>;

  beforeEach(async () => {
    tmp = await makeTmpRoot();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  const seed = async (flow: string, runId: string, bodyBytes = 32): Promise<void> => {
    const runDir = join(String(tmp.root), flow, runId);
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(join(runDir, 'prompt.md'), 'x'.repeat(bodyBytes), 'utf8');
  };

  it('returns [] when the runs root does not exist (ENOENT swallowed)', async () => {
    const missing = AbsolutePath.parse(join(String(tmp.root), 'no-such-dir'));
    expect(missing.ok).toBe(true);
    if (!missing.ok) throw new Error('test setup: bad path');
    const result = await listRuns(missing.value);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  it('enumerates every run dir grouped by flow and accumulates sizes', async () => {
    await seed('detect-scripts', '2026-05-19T10-00-00-000Z-aaaaaa', 100);
    await seed('detect-scripts', '2026-05-19T11-00-00-000Z-bbbbbb', 200);
    await seed('readiness', '2026-05-19T12-00-00-000Z-cccccc', 64);

    const result = await listRuns(tmp.root);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.value).toHaveLength(3);
    const ds = result.value.filter((r) => r.flow === 'detect-scripts');
    expect(ds).toHaveLength(2);
    expect(ds.reduce((acc, r) => acc + r.sizeBytes, 0)).toBe(300);
  });
});

describe('candidate-set selection (intersect of --older-than and --keep-last, per-flow scoping)', () => {
  // The CLI builds the candidate set inline; here we mirror that logic against `groupByFlow`
  // to lock in the contract: when both criteria are set, intersect; when only one, that one
  // gates; per-flow scoping cuts the entry list before grouping. This is the unit-level
  // safety net behind the e2e prune cases.
  const mkRun = (flow: string, isoOffsetMs: number, suffix: string): RunEntry => {
    const ts = new Date(Date.UTC(2026, 4, 19, 12, 0, 0) - isoOffsetMs);
    const runId = `${ts.toISOString().replace(/[:.]/g, '-')}-${suffix}`;
    return {
      flow,
      runId,
      timestamp: ts,
      sizeBytes: 100,
      path: `/tmp/${flow}/${runId}` as AbsolutePath,
    };
  };

  const candidates = (
    runs: readonly RunEntry[],
    nowMs: number,
    olderThanMs: number | undefined,
    keepLast: number | undefined
  ): readonly RunEntry[] => {
    const grouped = groupByFlow(runs);
    const out: RunEntry[] = [];
    for (const [, runsForFlow] of grouped) {
      const keep = new Set<string>();
      if (keepLast !== undefined) for (const r of runsForFlow.slice(0, keepLast)) keep.add(r.path);
      for (const run of runsForFlow) {
        const ageQualifies =
          olderThanMs === undefined ? true : run.timestamp !== null && nowMs - run.timestamp.getTime() >= olderThanMs;
        const keepQualifies = keepLast === undefined ? true : !keep.has(run.path);
        if (ageQualifies && keepQualifies) out.push(run);
      }
    }
    return out;
  };

  const nowMs = Date.UTC(2026, 4, 19, 12, 0, 0);
  const HOUR = 60 * 60 * 1000;

  it('--older-than alone selects every run past the threshold', () => {
    const [r0, r2h, r5h] = [mkRun('a', 0, '0'), mkRun('a', 2 * HOUR, '2h'), mkRun('a', 5 * HOUR, '5h')] as const;
    const out = candidates([r0, r2h, r5h], nowMs, 3 * HOUR, undefined);
    expect(out.map((r) => r.runId)).toEqual([r5h.runId]);
  });

  it('--keep-last alone retains the N most-recent per flow', () => {
    const r0 = mkRun('a', 0, '0');
    const r1h = mkRun('a', HOUR, '1h');
    const r2h = mkRun('a', 2 * HOUR, '2h');
    const rB = mkRun('b', HOUR, '1h-b');
    const out = candidates([r0, r1h, r2h, rB], nowMs, undefined, 1);
    // Flow a keeps the newest (offset 0); the 1h + 2h candidates remain. Flow b keeps its only run.
    const ids = out.map((r) => r.runId).sort();
    expect(ids).toEqual([r1h.runId, r2h.runId].sort());
  });

  it('intersection: --older-than AND not-in-keep-last', () => {
    const r0 = mkRun('a', 0, '0');
    const r2h = mkRun('a', 2 * HOUR, '2h');
    const r5h = mkRun('a', 5 * HOUR, '5h');
    // older-than 3h ⇒ only the 5h-old run qualifies; keep-last 2 keeps {0, 2h};
    // the 5h-old run is not kept, so intersection ⇒ [5h].
    const out = candidates([r0, r2h, r5h], nowMs, 3 * HOUR, 2);
    expect(out.map((r) => r.runId)).toEqual([r5h.runId]);

    // older-than 3h ⇒ 5h qualifies; keep-last 1 keeps {0}; intersection ⇒ [5h]. The 2h-old run is
    // NOT old enough so it stays even though it's outside keep-last.
    const out2 = candidates([r0, r2h, r5h], nowMs, 3 * HOUR, 1);
    expect(out2.map((r) => r.runId)).toEqual([r5h.runId]);
  });

  it('per-flow scoping limits the candidate set to the requested flow', () => {
    const runs = [mkRun('a', 5 * HOUR, '5h-a'), mkRun('b', 5 * HOUR, '5h-b')];
    const scoped = runs.filter((r) => r.flow === 'a');
    const out = candidates(scoped, nowMs, 3 * HOUR, undefined);
    expect(out).toHaveLength(1);
    expect(out[0]?.flow).toBe('a');
  });
});
