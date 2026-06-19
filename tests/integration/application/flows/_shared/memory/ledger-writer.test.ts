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

  it('over the byte ceiling: still appends the ndjson line but does NOT rewrite (or empty) learnings.md', async () => {
    const deps = { appendFile: createAppendFile(), writeFile: createAtomicWriteFile(), log: noopLogger };

    // Plant a real mirror that must survive untouched — the OOM guard must SKIP the mirror write, not
    // overwrite a genuine learnings.md with an empty "no learnings" view.
    const mdFile = join(dir, 'learnings.md');
    await fs.writeFile(mdFile, '# Real learnings\n\n- a genuine prior insight\n', 'utf8');

    // One real ledger line, then balloon the file past the 50 MB hard ceiling with a sparse truncate
    // (cheap — no 50 MB of bytes actually written) so the stat sees an over-ceiling size.
    const ledgerFile = join(dir, 'learnings.ndjson');
    await appendLearningsAndMirror(ledgerPath(), [rec('seed')], deps);
    await fs.writeFile(mdFile, '# Real learnings\n\n- a genuine prior insight\n', 'utf8'); // restore after seed mirror
    await fs.truncate(ledgerFile, 50 * 1024 * 1024 + 1);

    const res = await appendLearningsAndMirror(ledgerPath(), [rec('over-ceiling insight')], deps);
    expect(res.ok).toBe(true);

    // The ndjson append (source of truth) DID land past the seed line.
    const ndjson = await fs.readFile(ledgerFile, 'utf8');
    expect(ndjson).toContain('over-ceiling insight');

    // The mirror was NOT rewritten — it still holds the genuine prior content and was not emptied.
    const md = await fs.readFile(mdFile, 'utf8');
    expect(md).toContain('a genuine prior insight');
    expect(md).not.toContain('over-ceiling insight');
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
