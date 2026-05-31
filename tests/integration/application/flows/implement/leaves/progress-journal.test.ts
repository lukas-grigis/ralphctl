/**
 * Integration test for progress-journal-leaf (audit-[07]).
 *
 * The leaf is the sole writer of `<sprintDir>/progress.md` post-wave-7 — it appends one
 * task-attempt section after every settle-attempt completes. Validates:
 *  - section shape (heading + verdict / round / duration / commit metadata bullets)
 *  - appends preserve prior journal content verbatim (no rewrites)
 *  - per-attempt signal accumulators (changes / decisions / learnings / notes) render as
 *    dedicated subsections with deduped + trimmed bullets
 *  - empty signal lists drop their subsection entirely
 *  - all four accumulators clear on the output ctx
 *  - missing task on ctx throws an InvalidStateError (chain-shape contract)
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import {
  absolutePath,
  FIXED_LATER,
  FIXED_NOW,
  makeDoneTask,
  makeInProgressTaskWithRunningAttempt,
} from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { recordingAppendFile } from '@tests/fixtures/recording-append-file.ts';
import { progressJournalLeaf } from '@src/application/flows/implement/leaves/progress-journal.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

const PROGRESS_FILE = absolutePath('/tmp/ralph/sprint/progress.md');
const SPRINT_ID = (() => {
  const parsed = SprintId.parse('019e50e1-f298-7773-ace2-f16d97c81281');
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
})();

describe('progressJournalLeaf', () => {
  it('appends a task-attempt section with verdict=pass for a settled done task', async () => {
    const append = recordingAppendFile();
    const task = makeDoneTask({ name: 'export-csv' });
    const leaf = progressJournalLeaf(
      { appendFile: append.fn, clock: () => FIXED_LATER, logger: noopLogger },
      { progressFile: PROGRESS_FILE, totalRounds: 5 },
      task.id
    );
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      tasks: [task],
      currentRoundNum: 1,
    };
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);
    const written = append.read(PROGRESS_FILE) ?? '';
    expect(written).toContain('## Task: export-csv — Attempt 1');
    expect(written).toContain('- Verdict: pass');
    expect(written).toContain('- Round: round 1 of 5');
    // The done-task fixture does not stamp a commit sha; the journal renders em-dash for the
    // missing value.
    expect(written).toContain('- Commit: —');
    // Empty signal lists drop their subsections entirely — no orphaned headings.
    expect(written).not.toContain('### Changes');
    expect(written).not.toContain('### Decisions');
    expect(written).not.toContain('### Learnings');
    expect(written).not.toContain('### Notes');
  });

  it('renders verdict=blocked with the blocked reason as the outcome paragraph', async () => {
    const append = recordingAppendFile();
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const blocked = markTaskBlocked(inProgress, 'pre-existing test failure');
    if (!blocked.ok) throw blocked.error;
    const leaf = progressJournalLeaf(
      { appendFile: append.fn, clock: () => FIXED_LATER, logger: noopLogger },
      { progressFile: PROGRESS_FILE, totalRounds: 5 },
      blocked.value.id
    );
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      tasks: [blocked.value],
      currentRoundNum: 2,
    };
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);
    const written = append.read(PROGRESS_FILE) ?? '';
    expect(written).toContain('- Verdict: blocked');
    expect(written).toContain('Blocked: pre-existing test failure');
    expect(written).toContain('- Round: round 2 of 5');
  });

  it('appends successive sections without rewriting prior content', async () => {
    const append = recordingAppendFile();
    const t1 = makeDoneTask({ name: 'task-one' });
    const t2 = makeDoneTask({ name: 'task-two' });
    const opts = { progressFile: PROGRESS_FILE, totalRounds: 3 };
    const deps = { appendFile: append.fn, clock: () => FIXED_LATER, logger: noopLogger };

    await progressJournalLeaf(deps, opts, t1.id).execute({
      sprintId: SPRINT_ID,
      tasks: [t1],
      currentRoundNum: 1,
    });
    await progressJournalLeaf(deps, opts, t2.id).execute({
      sprintId: SPRINT_ID,
      tasks: [t2],
      currentRoundNum: 1,
    });
    const written = append.read(PROGRESS_FILE) ?? '';
    // Both sections present in order, neither erased the other.
    const t1Idx = written.indexOf('## Task: task-one');
    const t2Idx = written.indexOf('## Task: task-two');
    expect(t1Idx).toBeGreaterThanOrEqual(0);
    expect(t2Idx).toBeGreaterThan(t1Idx);
  });

  it('dedupes + trims ctx-accumulated decision signals and renders one bullet per unique entry', async () => {
    const append = recordingAppendFile();
    const task = makeDoneTask({ name: 'with-decisions' });
    const leaf = progressJournalLeaf(
      { appendFile: append.fn, clock: () => FIXED_NOW, logger: noopLogger },
      { progressFile: PROGRESS_FILE, totalRounds: 5 },
      task.id
    );
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      tasks: [task],
      currentRoundNum: 1,
      currentAttemptDecisions: [
        'use json for the on-disk format',
        '  use json for the on-disk format  ',
        'switch to streaming reads',
      ],
    };
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);
    const written = append.read(PROGRESS_FILE) ?? '';
    // The subsection renders, and the two unique decisions appear as separate bullets.
    expect(written).toContain('### Decisions');
    expect(written).toContain('- use json for the on-disk format');
    expect(written).toContain('- switch to streaming reads');
    // Dedupe: only TWO `- ` bullets in the Decisions subsection block.
    const decisionsBlock = written.slice(written.indexOf('### Decisions'));
    const bullets = decisionsBlock.split('\n').filter((line) => line.startsWith('- '));
    expect(bullets).toHaveLength(2);
  });

  it('renders all four signal subsections (changes / decisions / learnings / notes) when populated', async () => {
    const append = recordingAppendFile();
    const task = makeDoneTask({ name: 'rich-signals' });
    const leaf = progressJournalLeaf(
      { appendFile: append.fn, clock: () => FIXED_NOW, logger: noopLogger },
      { progressFile: PROGRESS_FILE, totalRounds: 5 },
      task.id
    );
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      tasks: [task],
      currentRoundNum: 1,
      currentAttemptChanges: ['added src/foo.ts', 'renamed bar → baz'],
      currentAttemptDecisions: ['use json on-disk'],
      currentAttemptLearnings: [{ text: 'providers ship different flags' }],
      currentAttemptNotes: ['follow-up: trim retry log lines'],
    };
    const result = await leaf.execute(ctx);
    expect(result.ok).toBe(true);
    const written = append.read(PROGRESS_FILE) ?? '';
    expect(written).toContain('### Changes');
    expect(written).toContain('- added src/foo.ts');
    expect(written).toContain('- renamed bar → baz');
    expect(written).toContain('### Decisions');
    expect(written).toContain('- use json on-disk');
    expect(written).toContain('### Learnings');
    expect(written).toContain('- **providers ship different flags**');
    expect(written).toContain('### Notes');
    expect(written).toContain('- follow-up: trim retry log lines');
  });

  it('all four signal lists empty → only the metadata block renders (no signal subsections)', async () => {
    // Regression for the confetti-task case: a settled attempt that emitted no
    // change/decision/learning/note signals must still produce a clean section with no
    // empty `### Foo` headings. This is the original wave-7 follow-up complaint distilled
    // into a single test.
    const append = recordingAppendFile();
    const task = makeDoneTask({ name: 'confetti' });
    const leaf = progressJournalLeaf(
      { appendFile: append.fn, clock: () => FIXED_NOW, logger: noopLogger },
      { progressFile: PROGRESS_FILE, totalRounds: 5 },
      task.id
    );
    const result = await leaf.execute({ sprintId: SPRINT_ID, tasks: [task], currentRoundNum: 1 });
    expect(result.ok).toBe(true);
    const written = append.read(PROGRESS_FILE) ?? '';
    expect(written).toContain('## Task: confetti — Attempt 1');
    expect(written).toContain('- Verdict: pass');
    expect(written).not.toContain('### Changes');
    expect(written).not.toContain('### Decisions');
    expect(written).not.toContain('### Learnings');
    expect(written).not.toContain('### Notes');
  });

  it('clears all four signal accumulators on the output ctx so the next task starts fresh', async () => {
    const append = recordingAppendFile();
    const task = makeDoneTask({ name: 'clears' });
    const leaf = progressJournalLeaf(
      { appendFile: append.fn, clock: () => FIXED_NOW, logger: noopLogger },
      { progressFile: PROGRESS_FILE, totalRounds: 5 },
      task.id
    );
    const ctx: ImplementCtx = {
      sprintId: SPRINT_ID,
      tasks: [task],
      currentRoundNum: 1,
      currentAttemptDecisions: ['d'],
      currentAttemptChanges: ['c'],
      currentAttemptLearnings: [{ text: 'l' }],
      currentAttemptNotes: ['n'],
    };
    const result = await leaf.execute(ctx);
    if (!result.ok) throw result.error;
    expect(result.value.ctx.currentAttemptDecisions).toBeUndefined();
    expect(result.value.ctx.currentAttemptChanges).toBeUndefined();
    expect(result.value.ctx.currentAttemptLearnings).toBeUndefined();
    expect(result.value.ctx.currentAttemptNotes).toBeUndefined();
  });

  it('best-effort: a write failure is swallowed and the chain continues', async () => {
    const failingAppend = async () =>
      Result.error(
        // Reuse StorageError via the fixture helper; the leaf only inspects `.message`.
        Object.assign(new Error('disk full'), { message: 'disk full' })
      ) as never;
    const task = makeDoneTask({ name: 'soft-fail' });
    const leaf = progressJournalLeaf(
      // Cast keeps the test focused on the leaf's swallow-failure behaviour without rebuilding
      // a full StorageError just to throw it away.
      { appendFile: failingAppend, clock: () => FIXED_LATER, logger: noopLogger },
      { progressFile: PROGRESS_FILE, totalRounds: 5 },
      task.id
    );
    const result = await leaf.execute({
      sprintId: SPRINT_ID,
      tasks: [task],
      currentRoundNum: 1,
    });
    expect(result.ok).toBe(true);
  });

  it('throws InvalidStateError when the task is missing from ctx.tasks (chain-shape contract)', async () => {
    const append = recordingAppendFile();
    const task = makeDoneTask({ name: 'phantom' });
    const leaf = progressJournalLeaf(
      { appendFile: append.fn, clock: () => FIXED_LATER, logger: noopLogger },
      { progressFile: PROGRESS_FILE, totalRounds: 5 },
      task.id
    );
    const result = await leaf.execute({ sprintId: SPRINT_ID, tasks: [], currentRoundNum: 1 });
    expect(result.ok).toBe(false);
  });
});
