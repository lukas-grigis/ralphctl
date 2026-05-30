/**
 * Integration test for append-learnings-leaf (procedural-memory WRITE side).
 *
 * The leaf persists the just-settled attempt's `<learning>` signals to the project's append-only
 * NDJSON ledger BEFORE `progress-journal` clears the `currentAttemptLearnings` accumulator. It is
 * append-only (no read-modify-write) and best-effort (a failed append never blocks the attempt).
 *
 * Validates:
 *  - populated learnings → N NDJSON lines, each `promotedAt: null`, with the spec record shape;
 *  - an append failure → `Result.ok` (the attempt proceeds);
 *  - empty / absent learnings → no append at all;
 *  - the leaf reads `currentAttemptLearnings` and does NOT clear it (the journal does that next),
 *    so an append-then-journal pipeline still renders the learnings subsection;
 *  - the write-side id matches the read-side dedup key — a re-emitted identical learning round-trips
 *    through `loadLearningsLeaf` to a single candidate.
 */

import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { absolutePath, FIXED_NOW, makeDoneTask } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { recordingAppendFile } from '@tests/fixtures/recording-append-file.ts';
import { appendLearningsLeaf } from '@src/application/flows/implement/leaves/append-learnings.ts';
import { progressJournalLeaf } from '@src/application/flows/implement/leaves/progress-journal.ts';
import { loadLearningsLeaf } from '@src/application/flows/_shared/memory/load-learnings.ts';
import { learningsLedgerPath, LEARNINGS_LEDGER_FILE } from '@src/application/flows/_shared/memory/ledger-path.ts';
import { parseLearningLine, type LearningRecord } from '@src/application/flows/_shared/memory/learning-record.ts';
import { createAppendFile } from '@src/integration/io/append-file-adapter.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

const MEMORY_ROOT = absolutePath('/tmp/ralph/memory');
const PROJECT_ID = 'proj-append-learnings';
const REPO_PATH = absolutePath('/tmp/ralph/repo');
const REPO_NAME = 'demo-repo';
const PROGRESS_FILE = absolutePath('/tmp/ralph/sprint/progress.md');
const SPRINT_ID = (() => {
  const parsed = SprintId.parse('019e50e1-f298-7773-ace2-f16d97c81281');
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
})();

const ledgerPath = (() => {
  const p = learningsLedgerPath(MEMORY_ROOT, PROJECT_ID);
  if (!p.ok) throw p.error;
  return p.value;
})();

/** Parse every non-blank NDJSON line the recording appender captured for the ledger. */
const parseLedger = (raw: string | undefined): LearningRecord[] => {
  const out: LearningRecord[] = [];
  for (const line of (raw ?? '').split('\n')) {
    const parsed = parseLearningLine(line);
    if (!parsed.ok) throw parsed.error;
    if (parsed.value !== undefined) out.push(parsed.value);
  }
  return out;
};

describe('appendLearningsLeaf', () => {
  it('appends one NDJSON line per learning, each promotedAt:null with the spec record shape', async () => {
    const append = recordingAppendFile();
    const task = makeDoneTask({ name: 'add export feature' }); // → taskKind 'feature'
    const leaf = appendLearningsLeaf(
      { appendFile: append.fn, clock: () => FIXED_NOW, logger: noopLogger },
      { memoryRoot: MEMORY_ROOT, projectId: PROJECT_ID, repoPath: REPO_PATH, repoName: REPO_NAME },
      task.id
    );
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      tasks: [task],
      currentAttemptLearnings: ['providers ship different flags', 'codex caps effort at high'],
    };
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);

    const records = parseLedger(append.read(ledgerPath));
    expect(records).toHaveLength(2);
    for (const r of records) {
      expect(r.v).toBe(1);
      expect(r.promotedAt).toBeNull();
      expect(r.repo).toBe(String(REPO_PATH));
      expect(r.repoName).toBe(REPO_NAME);
      expect(r.taskKind).toBe('feature');
      expect(r.sprintId).toBe(String(SPRINT_ID));
      expect(r.taskId).toBe(String(task.id));
      expect(r.timestamp).toBe(String(FIXED_NOW));
      expect(r.id).toHaveLength(16);
    }
    expect(records.map((r) => r.text)).toEqual(['providers ship different flags', 'codex caps effort at high']);
  });

  it('dedupes identical learnings within one attempt before appending', async () => {
    const append = recordingAppendFile();
    const task = makeDoneTask({ name: 'refactor the loader' });
    const leaf = appendLearningsLeaf(
      { appendFile: append.fn, clock: () => FIXED_NOW, logger: noopLogger },
      { memoryRoot: MEMORY_ROOT, projectId: PROJECT_ID, repoPath: REPO_PATH, repoName: REPO_NAME },
      task.id
    );
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      tasks: [task],
      currentAttemptLearnings: ['same insight', '  same insight  ', 'distinct insight'],
    };
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);
    const records = parseLedger(append.read(ledgerPath));
    expect(records.map((r) => r.text)).toEqual(['same insight', 'distinct insight']);
  });

  it('best-effort: an append failure is swallowed and the attempt proceeds (Result.ok)', async () => {
    const failingAppend = async () =>
      Result.error(Object.assign(new Error('disk full'), { message: 'disk full' })) as never;
    const task = makeDoneTask({ name: 'fix the crash' }); // → 'bugfix'
    const leaf = appendLearningsLeaf(
      { appendFile: failingAppend, clock: () => FIXED_NOW, logger: noopLogger },
      { memoryRoot: MEMORY_ROOT, projectId: PROJECT_ID, repoPath: REPO_PATH, repoName: REPO_NAME },
      task.id
    );
    const result = await leaf.execute({
      sprintId: SPRINT_ID,
      tasks: [task],
      currentAttemptLearnings: ['a learning the disk refused'],
    });
    expect(result.ok).toBe(true);
  });

  it('empty learnings → no append at all', async () => {
    const append = recordingAppendFile();
    const task = makeDoneTask({ name: 'docs pass' });
    const leaf = appendLearningsLeaf(
      { appendFile: append.fn, clock: () => FIXED_NOW, logger: noopLogger },
      { memoryRoot: MEMORY_ROOT, projectId: PROJECT_ID, repoPath: REPO_PATH, repoName: REPO_NAME },
      task.id
    );
    const result = await leaf.execute({ sprintId: SPRINT_ID, tasks: [task] });
    expect(result.ok).toBe(true);
    // Nothing was written for the ledger — empty accumulator skips the I/O entirely.
    expect(append.read(ledgerPath)).toBeUndefined();
    expect(append.snapshot()).toHaveLength(0);
  });

  it('whitespace-only learnings collapse to empty → no append', async () => {
    const append = recordingAppendFile();
    const task = makeDoneTask({ name: 'chore bump' });
    const leaf = appendLearningsLeaf(
      { appendFile: append.fn, clock: () => FIXED_NOW, logger: noopLogger },
      { memoryRoot: MEMORY_ROOT, projectId: PROJECT_ID, repoPath: REPO_PATH, repoName: REPO_NAME },
      task.id
    );
    const result = await leaf.execute({
      sprintId: SPRINT_ID,
      tasks: [task],
      currentAttemptLearnings: ['   ', ''],
    });
    expect(result.ok).toBe(true);
    expect(append.read(ledgerPath)).toBeUndefined();
  });

  it('reads currentAttemptLearnings BEFORE the journal clears them, and does not clear them itself', async () => {
    // Ordering fence: append-learnings runs, leaving the accumulator intact, THEN progress-journal
    // reads the SAME accumulator to render its `### Learnings` subsection and clears it. If the
    // append leaf cleared the accumulator, the journal would lose the subsection.
    const append = recordingAppendFile();
    const journalAppend = recordingAppendFile();
    const task = makeDoneTask({ name: 'add caching' });

    const appendLeaf = appendLearningsLeaf(
      { appendFile: append.fn, clock: () => FIXED_NOW, logger: noopLogger },
      { memoryRoot: MEMORY_ROOT, projectId: PROJECT_ID, repoPath: REPO_PATH, repoName: REPO_NAME },
      task.id
    );
    const journalLeaf = progressJournalLeaf(
      { appendFile: journalAppend.fn, clock: () => FIXED_NOW, logger: noopLogger },
      { progressFile: PROGRESS_FILE, totalRounds: 5 },
      task.id
    );

    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      tasks: [task],
      currentRoundNum: 1,
      currentAttemptLearnings: ['ordering matters here'],
    };

    // append-learnings runs first.
    const afterAppend = await appendLeaf.execute(ctx);
    if (!afterAppend.ok) throw afterAppend.error;
    // It left the accumulator populated for the journal to read.
    expect(afterAppend.value.ctx.currentAttemptLearnings).toEqual(['ordering matters here']);
    // The ledger has the line.
    expect(parseLedger(append.read(ledgerPath)).map((r) => r.text)).toEqual(['ordering matters here']);

    // Journal runs next on the (still-populated) ctx and renders + clears the learnings.
    const afterJournal = await journalLeaf.execute(afterAppend.value.ctx);
    if (!afterJournal.ok) throw afterJournal.error;
    expect(journalAppend.read(PROGRESS_FILE) ?? '').toContain('- ordering matters here');
    expect(afterJournal.value.ctx.currentAttemptLearnings).toBeUndefined();
  });

  it('throws InvalidStateError when the task is missing from ctx.tasks (chain-shape contract)', async () => {
    const append = recordingAppendFile();
    const task = makeDoneTask({ name: 'phantom' });
    const leaf = appendLearningsLeaf(
      { appendFile: append.fn, clock: () => FIXED_NOW, logger: noopLogger },
      { memoryRoot: MEMORY_ROOT, projectId: PROJECT_ID, repoPath: REPO_PATH, repoName: REPO_NAME },
      task.id
    );
    const result = await leaf.execute({ sprintId: SPRINT_ID, tasks: [], currentAttemptLearnings: ['x'] });
    expect(result.ok).toBe(false);
  });

  describe('write-side id ↔ read-side dedup key round-trip', () => {
    let dir: string;
    let memoryRoot: AbsolutePath;

    beforeEach(async () => {
      dir = await fs.mkdtemp(join(tmpdir(), 'ralph-learnings-'));
      memoryRoot = absolutePath(dir);
    });
    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    it('a re-emitted identical learning collapses to ONE candidate through loadLearningsLeaf', async () => {
      const realAppend = createAppendFile();
      const task = makeDoneTask({ name: 'add the thing' });
      const realLedgerPath = learningsLedgerPath(memoryRoot, PROJECT_ID);
      if (!realLedgerPath.ok) throw realLedgerPath.error;

      const leaf = appendLearningsLeaf(
        { appendFile: realAppend, clock: () => FIXED_NOW, logger: noopLogger },
        { memoryRoot, projectId: PROJECT_ID, repoPath: REPO_PATH, repoName: REPO_NAME },
        task.id
      );

      // Attempt 1 emits the learning; attempt 2 re-emits the SAME text verbatim. Append-only, so
      // the ledger now has TWO physical lines for one logical learning.
      const attempt1 = await leaf.execute({
        sprintId: SPRINT_ID,
        tasks: [task],
        currentAttemptLearnings: ['the same exact learning'],
      });
      expect(attempt1.ok).toBe(true);
      const attempt2 = await leaf.execute({
        sprintId: SPRINT_ID,
        tasks: [task],
        currentAttemptLearnings: ['the same exact learning'],
      });
      expect(attempt2.ok).toBe(true);

      // Two lines physically on disk.
      const raw = await fs.readFile(join(dir, PROJECT_ID, LEARNINGS_LEDGER_FILE), 'utf8');
      expect(raw.split('\n').filter((l) => l.trim().length > 0)).toHaveLength(2);

      // The READ side dedups by the stable id and collapses them to ONE candidate.
      interface LoadCtx {
        readonly path: AbsolutePath;
        readonly candidates?: readonly LearningRecord[];
      }
      const load = loadLearningsLeaf<LoadCtx>(
        { logger: noopLogger },
        { path: (c) => c.path, output: (c, candidates) => ({ ...c, candidates }) }
      );
      const loaded = await load.execute({ path: realLedgerPath.value });
      if (!loaded.ok) throw loaded.error;
      const candidates = loaded.value.ctx.candidates ?? [];
      expect(candidates).toHaveLength(1);
      expect(candidates[0]?.text).toBe('the same exact learning');
    });
  });
});
