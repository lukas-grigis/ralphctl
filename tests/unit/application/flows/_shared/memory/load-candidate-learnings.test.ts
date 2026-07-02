import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { absolutePath } from '@tests/fixtures/domain.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { type LearningRecord, serializeLearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import { loadCandidateLearnings } from '@src/application/flows/_shared/memory/load-candidate-learnings.ts';

const PROJECT_ID = '019000aa-bbbb-7ccc-8ddd-eeeeffff0000';

const record = (over: Partial<LearningRecord> = {}): LearningRecord => ({
  v: 1,
  id: 'id-1',
  text: 'learning text',
  repo: '/repos/app',
  repoName: 'app',
  taskKind: 'feature',
  sprintId: 'sprint-1',
  taskId: 'task-1',
  timestamp: '2026-05-30T10:00:00.000Z',
  promotedAt: null,
  ...over,
});

describe('loadCandidateLearnings', () => {
  let root: Awaited<ReturnType<typeof makeTmpRoot>>;
  let memoryRoot: AbsolutePath;

  beforeEach(async () => {
    root = await makeTmpRoot();
    memoryRoot = absolutePath(join(String(root.root), 'memory'));
  });
  afterEach(async () => {
    await root.cleanup();
  });

  // Write the ledger at the path `resolveLearningsLedgerPath` resolves to for a project with no
  // pre-existing memory dir: `<memoryRoot>/<projectId>/learnings.ndjson`.
  const writeLedger = async (lines: readonly string[]): Promise<void> => {
    const dir = join(String(memoryRoot), PROJECT_ID);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'learnings.ndjson'), lines.join(''), 'utf8');
  };

  it('keeps not-yet-promoted, not-retired rows and drops promoted / retired ones', async () => {
    await writeLedger([
      serializeLearningRecord(record({ id: 'live' })),
      serializeLearningRecord(record({ id: 'promoted', promotedAt: '2026-05-30T12:00:00.000Z' })),
      serializeLearningRecord(record({ id: 'retired', retiredAt: '2026-05-30T13:00:00.000Z' })),
    ]);

    const candidates = await loadCandidateLearnings(memoryRoot, PROJECT_ID, noopLogger);
    expect(candidates.map((r) => r.id)).toEqual(['live']);
  });

  it('dedups by record id, keeping the first occurrence', async () => {
    await writeLedger([
      serializeLearningRecord(record({ id: 'dup', text: 'first' })),
      serializeLearningRecord(record({ id: 'dup', text: 'second' })),
    ]);

    const candidates = await loadCandidateLearnings(memoryRoot, PROJECT_ID, noopLogger);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.text).toBe('first');
  });

  it('surfaces both learning and decision kinds (the renderer partitions them)', async () => {
    await writeLedger([
      serializeLearningRecord(record({ id: 'learn', kind: 'learning' })),
      serializeLearningRecord(record({ id: 'decide', kind: 'decision', text: 'chose event sourcing' })),
    ]);

    const candidates = await loadCandidateLearnings(memoryRoot, PROJECT_ID, noopLogger);
    expect(candidates.map((r) => r.id).sort()).toEqual(['decide', 'learn']);
  });

  it('returns an empty list when the ledger is absent (never blocks planning)', async () => {
    // No ledger written for this project — a fresh project that never recorded a learning.
    const candidates = await loadCandidateLearnings(memoryRoot, PROJECT_ID, noopLogger);
    expect(candidates).toEqual([]);
  });
});
