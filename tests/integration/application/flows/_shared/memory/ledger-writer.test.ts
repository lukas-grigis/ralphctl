/**
 * Integration tests for the ledger writer (Wave 2, Task 8). `appendLearningsAndMirror` appends NDJSON
 * line(s) then regenerates the human-readable `learnings.md` from the FULL ledger so the mirror stays
 * current on every write. Uses a real tmpdir so the mirror's reread-from-disk path is exercised.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absolutePath } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createAppendFile } from '@src/integration/io/append-file-adapter.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import type { LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import { appendLearningsAndMirror, learningsMdPath } from '@src/application/flows/_shared/memory/ledger-writer.ts';

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'ralph-ledger-writer-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const ledgerPath = () => absolutePath(join(dir, 'learnings.ndjson'));

const rec = (text: string, promotedAt: string | null = null): LearningRecord => ({
  v: 1,
  id: text,
  text,
  repo: '/repo',
  repoName: 'demo',
  taskKind: 'feature',
  sprintId: 's1',
  taskId: 't1',
  timestamp: '2026-06-19T10:00:00.000Z',
  promotedAt,
});

describe('appendLearningsAndMirror', () => {
  it('appends NDJSON line(s) AND regenerates learnings.md from the full ledger', async () => {
    const deps = { appendFile: createAppendFile(), writeFile: createAtomicWriteFile(), log: noopLogger };

    const r1 = await appendLearningsAndMirror(ledgerPath(), [rec('first insight')], deps);
    expect(r1.ok).toBe(true);

    const r2 = await appendLearningsAndMirror(ledgerPath(), [rec('second insight')], deps);
    expect(r2.ok).toBe(true);

    // The ledger has both lines.
    const ndjson = await fs.readFile(join(dir, 'learnings.ndjson'), 'utf8');
    expect(ndjson.trim().split('\n')).toHaveLength(2);

    // The mirror reflects the WHOLE ledger (not just the last append).
    const mdPath = learningsMdPath(ledgerPath());
    expect(mdPath).toBeTruthy();
    const md = await fs.readFile(join(dir, 'learnings.md'), 'utf8');
    expect(md).toContain('first insight');
    expect(md).toContain('second insight');
  });

  it('an append failure is returned as an error', async () => {
    const failing = async () => {
      const { Result } = await import('@src/domain/result.ts');
      const { StorageError } = await import('@src/domain/value/error/storage-error.ts');
      return Result.error(new StorageError({ subCode: 'io', message: 'disk full' }));
    };
    const deps = { appendFile: failing, writeFile: createAtomicWriteFile(), log: noopLogger };
    const res = await appendLearningsAndMirror(ledgerPath(), [rec('x')], deps);
    expect(res.ok).toBe(false);
  });
});
