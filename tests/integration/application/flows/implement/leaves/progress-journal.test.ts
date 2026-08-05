/**
 * Integration test for progress-journal-leaf (audit-[07]).
 *
 * The leaf writes one task-attempt section into `<sprintDir>/progress.md` after every settle-attempt
 * and regenerates the DERIVED state header band in place. Validates:
 *  - section shape (heading with stable id token + verdict / round / duration / commit metadata)
 *  - the derived header band (Status / Branch / per-task table; Blockers when a task is blocked)
 *  - regenerate-in-place preserves prior attempt sections verbatim (append-only sections)
 *  - per-attempt signal accumulators render as deduped subsections; empty lists drop their heading
 *  - the `created` timestamp is preserved across regenerations
 *  - all six per-attempt accumulators (four signal kinds + generator/evaluator nudge tallies)
 *    clear on the output ctx
 *  - the corrective-nudge cost-visibility clause renders when the ctx tally is non-zero and is
 *    omitted entirely on a well-formed attempt
 *  - FAIL-LOUD section write: retry-once self-heal, and a visible gap marker when writes keep failing
 *  - missing task on ctx throws an InvalidStateError (chain-shape contract)
 *
 * Writes hit a real tmp file via the atomic adapter so the leaf's read-regenerate-write path is
 * exercised end to end.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import {
  FIXED_LATER,
  FIXED_NOW,
  commitSha,
  makeActiveSprint,
  makeDoneTask,
  makeInProgressTaskWithRunningAttempt,
  makeTodoTask,
} from '@tests/fixtures/domain.ts';
import { makeTmpRoot } from '@tests/fixtures/tmp-root.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { createAtomicWriteFile } from '@src/integration/io/write-file-atomic.ts';
import { createFoldQueue } from '@src/application/flows/implement/wave-branch.ts';
import type { WriteFile } from '@src/business/io/write-file.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import { progressJournalLeaf } from '@src/application/flows/implement/leaves/progress-journal.ts';
import { markTaskBlocked } from '@src/domain/entity/task-lifecycle.ts';
import { applyCriteriaVerdicts } from '@src/domain/entity/task-criteria.ts';
import {
  appendAttemptVerifyRun,
  recordRunningAttemptCommit,
  recordRunningAttemptVerification,
  recordRunningAttemptWarning,
  setAttemptAttribution,
  startNextAttempt,
} from '@src/domain/entity/task-attempts.ts';
import { failCurrentAttempt, markTaskDone, recordTaskEscalation } from '@src/domain/entity/task-settle.ts';
import { setExecutionBranch, createSprintExecution } from '@src/domain/entity/sprint-execution.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';

const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};

let tmp: { root: AbsolutePath; cleanup: () => Promise<void> };
let progressFile: AbsolutePath;

beforeEach(async () => {
  tmp = await makeTmpRoot();
  progressFile = unwrap(AbsolutePath.parse(join(String(tmp.root), 'progress.md')));
});
afterEach(async () => {
  await tmp.cleanup();
});

const read = async (): Promise<string> => {
  try {
    return await fs.readFile(String(progressFile), 'utf8');
  } catch {
    return '';
  }
};

const sprint = makeActiveSprint();
const execution = setExecutionBranch(createSprintExecution({ sprintId: sprint.id }), 'ralphctl/test');

/** ctx with the canonical sprint + execution wired so the derived header renders. */
const ctxFor = (tasks: ImplementCtx['tasks'], extra: Partial<ImplementCtx> = {}): ImplementCtx => ({
  sprintId: sprint.id,
  sprint,
  execution,
  tasks,
  currentRoundNum: 1,
  ...extra,
});

const journalDeps = (writeFile: WriteFile, clock = () => FIXED_LATER) => ({
  writeFile,
  clock,
  logger: noopLogger,
  journalMutex: createFoldQueue(),
});

describe('progressJournalLeaf', () => {
  it('writes a task-attempt section with the stable id token + verdict=pass for a settled done task', async () => {
    const task = makeDoneTask({ name: 'export-csv' });
    const leaf = progressJournalLeaf(journalDeps(createAtomicWriteFile()), { progressFile, totalRounds: 5 }, task.id);
    const result = await leaf.execute(ctxFor([task]));
    expect(result.ok).toBe(true);
    const written = await read();
    expect(written).toContain(`## Task: export-csv — Attempt 1 · id:${String(task.id)}`);
    expect(written).toContain('- Verdict: pass');
    expect(written).toContain('- Round: round 1 of 5');
    expect(written).toContain('- Commit: —');
    expect(written).not.toContain('### Changes');
  });

  it('regenerates the derived state header band (Status / Branch / per-task table) from canonical ctx', async () => {
    // Fold a passed verdict for the task's lone criterion (C1) so the Passes column shows the
    // durable k-of-N count derived from criteriaVerdicts.
    const task = applyCriteriaVerdicts(makeDoneTask({ name: 'export-csv' }), [{ id: 'C1', passed: true }]);
    const leaf = progressJournalLeaf(journalDeps(createAtomicWriteFile()), { progressFile, totalRounds: 5 }, task.id);
    await leaf.execute(ctxFor([task]));
    const written = await read();
    expect(written).toContain('# Sprint:');
    expect(written).toContain('## Status');
    expect(written).toContain('- State: active');
    expect(written).toContain('- Branch: ralphctl/test');
    expect(written).toContain('## Tasks');
    expect(written).toContain('| Task | Status | Passes |');
    expect(written).toContain('| export-csv | done | 1/1 |');
  });

  it('renders verdict=blocked with the reason in the outcome paragraph and under ## Blockers', async () => {
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const blocked = unwrap(markTaskBlocked(inProgress, 'pre-existing test failure', 'own'));
    const leaf = progressJournalLeaf(
      journalDeps(createAtomicWriteFile()),
      { progressFile, totalRounds: 5 },
      blocked.id
    );
    const result = await leaf.execute(ctxFor([blocked], { currentRoundNum: 2 }));
    expect(result.ok).toBe(true);
    const written = await read();
    expect(written).toContain('- Verdict: blocked');
    expect(written).toContain('Blocked: pre-existing test failure');
    expect(written).toContain('- Round: round 2 of 5');
    // Derived blocker surfaces the same reason.
    expect(written).toContain('## Blockers');
    expect(written).toContain('pre-existing test failure');
  });

  it('derives verdict=pass-with-warning + Outcome detail for a done task whose final attempt warns', async () => {
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const warned = unwrap(recordRunningAttemptWarning(inProgress, { kind: 'plateau', dimensions: ['C1', 'C2'] }));
    const verified = unwrap(recordRunningAttemptVerification(warned));
    const done = unwrap(markTaskDone(verified, FIXED_LATER));
    const leaf = progressJournalLeaf(journalDeps(createAtomicWriteFile()), { progressFile, totalRounds: 5 }, done.id);
    const result = await leaf.execute(ctxFor([done], { currentRoundNum: 3 }));
    expect(result.ok).toBe(true);
    const written = await read();
    expect(written).toContain('- Verdict: pass-with-warning');
    expect(written).toContain('### Outcome detail');
    expect(written).toContain('plateaued');
    expect(written).toContain('C1, C2');
    expect(written).not.toContain('Task completed successfully.');
  });

  it('includes the plateau detector attribution in Outcome detail when the warning carries a source', async () => {
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const warned = unwrap(
      recordRunningAttemptWarning(inProgress, { kind: 'plateau', dimensions: ['C1'], source: 'diversity' })
    );
    const verified = unwrap(recordRunningAttemptVerification(warned));
    const done = unwrap(markTaskDone(verified, FIXED_LATER));
    const leaf = progressJournalLeaf(journalDeps(createAtomicWriteFile()), { progressFile, totalRounds: 5 }, done.id);
    const result = await leaf.execute(ctxFor([done], { currentRoundNum: 3 }));
    expect(result.ok).toBe(true);
    const written = await read();
    expect(written).toContain('(detector: diversity)');
  });

  it('omits the detector parenthetical when the warning carries no source (legacy record)', async () => {
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const warned = unwrap(recordRunningAttemptWarning(inProgress, { kind: 'plateau', dimensions: ['C1'] }));
    const verified = unwrap(recordRunningAttemptVerification(warned));
    const done = unwrap(markTaskDone(verified, FIXED_LATER));
    const leaf = progressJournalLeaf(journalDeps(createAtomicWriteFile()), { progressFile, totalRounds: 5 }, done.id);
    const result = await leaf.execute(ctxFor([done], { currentRoundNum: 3 }));
    expect(result.ok).toBe(true);
    const written = await read();
    expect(written).not.toContain('(detector:');
  });

  it('derives verdict=escalated for an in_progress task whose attempt failed and climbed a rung', async () => {
    const inProgress = makeInProgressTaskWithRunningAttempt({ maxAttempts: 5 });
    const warned = unwrap(recordRunningAttemptWarning(inProgress, { kind: 'plateau', dimensions: ['C1'] }));
    const failed = unwrap(failCurrentAttempt(warned, FIXED_LATER, 'failed'));
    const escalated = unwrap(recordTaskEscalation(failed as never, 'sonnet', 'opus'));
    const leaf = progressJournalLeaf(
      journalDeps(createAtomicWriteFile()),
      { progressFile, totalRounds: 5 },
      escalated.id
    );
    const result = await leaf.execute(ctxFor([escalated], { currentRoundNum: 2 }));
    expect(result.ok).toBe(true);
    const written = await read();
    expect(written).toContain('- Verdict: escalated');
    expect(written).toContain('### Outcome detail');
    expect(written).toContain('Remedy: escalated the generator model from sonnet to opus');
  });

  it('regenerate-in-place preserves prior attempt sections verbatim across successive appends', async () => {
    const t1 = makeDoneTask({ name: 'task-one' });
    const t2 = makeDoneTask({ name: 'task-two' });
    const opts = { progressFile, totalRounds: 3 };
    const writeFile = createAtomicWriteFile();

    await progressJournalLeaf(journalDeps(writeFile), opts, t1.id).execute(ctxFor([t1, t2]));
    await progressJournalLeaf(journalDeps(writeFile), opts, t2.id).execute(ctxFor([t1, t2]));
    const written = await read();
    const t1Idx = written.indexOf('## Task: task-one');
    const t2Idx = written.indexOf('## Task: task-two');
    expect(t1Idx).toBeGreaterThanOrEqual(0);
    expect(t2Idx).toBeGreaterThan(t1Idx);
    // Exactly two attempt sections — regeneration didn't duplicate the first one.
    expect((written.match(/^## Task: /gm) ?? []).length).toBe(2);
  });

  it('preserves the created timestamp across regenerations (carried from the existing header)', async () => {
    const opts = { progressFile, totalRounds: 3 };
    const writeFile = createAtomicWriteFile();
    // Seed a header with a known created stamp; the first regenerate must carry it forward.
    await fs.writeFile(
      String(progressFile),
      '# Sprint: seeded\n\n- id: seeded\n- created: 2024-01-02T03:04:05.000Z\n',
      'utf8'
    );
    const task = makeDoneTask({ name: 'carry' });
    await progressJournalLeaf(journalDeps(writeFile), opts, task.id).execute(ctxFor([task]));
    const written = await read();
    expect(written).toContain('- created: 2024-01-02T03:04:05.000Z');
    // Identity is regenerated from canonical data — the seeded name is replaced.
    expect(written).not.toContain('# Sprint: seeded');
  });

  it('dedupes + trims ctx-accumulated decision signals into one bullet per unique entry', async () => {
    const task = makeDoneTask({ name: 'with-decisions' });
    const leaf = progressJournalLeaf(
      journalDeps(createAtomicWriteFile(), () => FIXED_NOW),
      { progressFile, totalRounds: 5 },
      task.id
    );
    const result = await leaf.execute(
      ctxFor([task], {
        currentAttemptDecisions: [
          'use json for the on-disk format',
          '  use json for the on-disk format  ',
          'switch to streaming reads',
        ],
      })
    );
    expect(result.ok).toBe(true);
    const written = await read();
    expect(written).toContain('### Decisions');
    const decisionsBlock = written.slice(written.indexOf('### Decisions'));
    const bullets = decisionsBlock.split('\n').filter((line) => line.startsWith('- '));
    expect(bullets).toHaveLength(2);
  });

  it('renders all four signal subsections (changes / decisions / learnings / notes) when populated', async () => {
    const task = makeDoneTask({ name: 'rich-signals' });
    const leaf = progressJournalLeaf(
      journalDeps(createAtomicWriteFile(), () => FIXED_NOW),
      { progressFile, totalRounds: 5 },
      task.id
    );
    const result = await leaf.execute(
      ctxFor([task], {
        currentAttemptChanges: ['added src/foo.ts', 'renamed bar → baz'],
        currentAttemptDecisions: ['use json on-disk'],
        currentAttemptLearnings: [{ text: 'providers ship different flags' }],
        currentAttemptNotes: ['follow-up: trim retry log lines'],
      })
    );
    expect(result.ok).toBe(true);
    const written = await read();
    expect(written).toContain('### Changes');
    expect(written).toContain('- added src/foo.ts');
    expect(written).toContain('### Decisions');
    expect(written).toContain('### Learnings');
    expect(written).toContain('- **providers ship different flags**');
    expect(written).toContain('### Notes');
  });

  it('clears all six per-attempt accumulators on the output ctx so the next task starts fresh', async () => {
    const task = makeDoneTask({ name: 'clears' });
    const leaf = progressJournalLeaf(
      journalDeps(createAtomicWriteFile(), () => FIXED_NOW),
      { progressFile, totalRounds: 5 },
      task.id
    );
    const result = await leaf.execute(
      ctxFor([task], {
        currentAttemptDecisions: ['d'],
        currentAttemptChanges: ['c'],
        currentAttemptLearnings: [{ text: 'l' }],
        currentAttemptNotes: ['n'],
        currentAttemptGeneratorNudges: 2,
        currentAttemptEvaluatorNudges: 1,
      })
    );
    if (!result.ok) throw result.error;
    expect(result.value.ctx.currentAttemptDecisions).toBeUndefined();
    expect(result.value.ctx.currentAttemptChanges).toBeUndefined();
    expect(result.value.ctx.currentAttemptLearnings).toBeUndefined();
    expect(result.value.ctx.currentAttemptNotes).toBeUndefined();
    expect(result.value.ctx.currentAttemptGeneratorNudges).toBeUndefined();
    expect(result.value.ctx.currentAttemptEvaluatorNudges).toBeUndefined();
  });

  it('renders the corrective-nudge clause with a per-role breakdown when the ctx tally is non-zero', async () => {
    const task = makeDoneTask({ name: 'nudged' });
    const leaf = progressJournalLeaf(
      journalDeps(createAtomicWriteFile(), () => FIXED_NOW),
      { progressFile, totalRounds: 5 },
      task.id
    );
    const result = await leaf.execute(
      ctxFor([task], { currentAttemptGeneratorNudges: 2, currentAttemptEvaluatorNudges: 1 })
    );
    expect(result.ok).toBe(true);
    const written = await read();
    expect(written).toContain('### Outcome detail');
    expect(written).toContain('3 corrective signals.json nudges issued this attempt');
    expect(written).toContain('(generator: 2, evaluator: 1)');
  });

  it('omits the corrective-nudge clause when neither role needed a nudge (zero-noise)', async () => {
    const task = makeDoneTask({ name: 'well-formed' });
    const leaf = progressJournalLeaf(
      journalDeps(createAtomicWriteFile(), () => FIXED_NOW),
      { progressFile, totalRounds: 5 },
      task.id
    );
    const result = await leaf.execute(ctxFor([task]));
    expect(result.ok).toBe(true);
    const written = await read();
    expect(written).not.toContain('corrective signals.json');
    expect(written).not.toContain('### Outcome detail');
  });

  it('fail-loud: a first write failure self-heals on the retry (content lands, chain proceeds)', async () => {
    const task = makeDoneTask({ name: 'flaky' });
    let calls = 0;
    const realWrite = createAtomicWriteFile();
    const flaky: WriteFile = async (path, content) => {
      calls += 1;
      if (calls === 1) return Result.error(Object.assign(new Error('transient'), { message: 'transient' }) as never);
      return realWrite(path, content);
    };
    const leaf = progressJournalLeaf(journalDeps(flaky), { progressFile, totalRounds: 5 }, task.id);
    const result = await leaf.execute(ctxFor([task]));
    expect(result.ok).toBe(true);
    expect(calls).toBe(2); // failed once, retried once
    const written = await read();
    expect(written).toContain(`## Task: flaky — Attempt 1 · id:${String(task.id)}`);
  });

  it('fail-loud: when the section write keeps failing it writes a visible in-file gap marker', async () => {
    const task = makeDoneTask({ name: 'lost' });
    const realWrite = createAtomicWriteFile();
    let calls = 0;
    // Fail the full-content writes (1: first, 2: retry); succeed only on the smaller marker write (3).
    const failTwice: WriteFile = async (path, content) => {
      calls += 1;
      if (calls <= 2) return Result.error(Object.assign(new Error('disk full'), { message: 'disk full' }) as never);
      return realWrite(path, content);
    };
    const leaf = progressJournalLeaf(journalDeps(failTwice), { progressFile, totalRounds: 5 }, task.id);
    const result = await leaf.execute(ctxFor([task]));
    expect(result.ok).toBe(true); // chain still proceeds
    expect(calls).toBe(3); // first + retry + marker
    const written = await read();
    // The gap is detectable: the section header (forgery-safe id token) plus the marker body.
    expect(written).toContain(`## Task: lost — Attempt 1 · id:${String(task.id)}`);
    expect(written).toContain('_section for the latest attempt is missing — see signals.json / git log_');
  });

  it('throws InvalidStateError when the task is missing from ctx.tasks (chain-shape contract)', async () => {
    const task = makeDoneTask({ name: 'phantom' });
    const leaf = progressJournalLeaf(journalDeps(createAtomicWriteFile()), { progressFile, totalRounds: 5 }, task.id);
    const result = await leaf.execute(ctxFor([]));
    expect(result.ok).toBe(false);
  });
});

describe('progressJournalLeaf — Continuation state (deterministic, harness-derived fields)', () => {
  it('composes attempt status, pre/post verify runs, attribution, and commit subject from harness-held Attempt data', async () => {
    const inProgress = makeInProgressTaskWithRunningAttempt();
    const withPre = unwrap(
      appendAttemptVerifyRun(inProgress, {
        phase: 'pre',
        ranAt: FIXED_NOW,
        command: 'pnpm test',
        exitCode: 0,
        durationMs: 100,
        outcome: 'success',
      })
    );
    const withPost = unwrap(
      appendAttemptVerifyRun(withPre, {
        phase: 'post',
        ranAt: FIXED_LATER,
        command: 'pnpm test',
        exitCode: 0,
        durationMs: 120,
        outcome: 'success',
      })
    );
    const attributed = unwrap(setAttemptAttribution(withPost, 'clean'));
    const committed = unwrap(recordRunningAttemptCommit(attributed, commitSha('a'.repeat(40))));
    const verified = unwrap(recordRunningAttemptVerification(committed));
    const done = unwrap(markTaskDone(verified, FIXED_LATER));
    const leaf = progressJournalLeaf(journalDeps(createAtomicWriteFile()), { progressFile, totalRounds: 5 }, done.id);
    const result = await leaf.execute(
      ctxFor([done], { proposedCommitMessage: { subject: 'task(export-csv): add flag' } })
    );
    expect(result.ok).toBe(true);
    const written = await read();
    expect(written).toContain('### Continuation state');
    expect(written).toContain('- Attempt status: verified');
    expect(written).toContain('- Verify (pre): pnpm test — success');
    expect(written).toContain('- Verify (post): pnpm test — success');
    expect(written).toContain('- Attribution: clean');
    expect(written).toContain('- Commit subject: task(export-csv): add flag');
    // Existing sha bullet is untouched — the subject rides in the new block, not appended there.
    expect(written).toContain(`- Commit: ${'a'.repeat(7)}`);
  });

  it('omits the commit subject when the generator proposed one but the tree stayed clean (no commit landed)', async () => {
    const task = makeDoneTask({ name: 'clean-tree' }); // no commitSha on the fixture's verified attempt
    const leaf = progressJournalLeaf(journalDeps(createAtomicWriteFile()), { progressFile, totalRounds: 5 }, task.id);
    const result = await leaf.execute(ctxFor([task], { proposedCommitMessage: { subject: 'never landed' } }));
    expect(result.ok).toBe(true);
    const written = await read();
    expect(written).not.toContain('- Commit subject:');
  });

  it("omits the Continuation-state block's optional fields when the leaf resolves none of them", async () => {
    const task = makeDoneTask({ name: 'bare' });
    const leaf = progressJournalLeaf(journalDeps(createAtomicWriteFile()), { progressFile, totalRounds: 5 }, task.id);
    const result = await leaf.execute(ctxFor([task]));
    expect(result.ok).toBe(true);
    const written = await read();
    // Attempt status still renders (always available on a settled attempt) — only the truly
    // optional facts (verify runs, attribution, commit subject, resumed-after) are absent.
    expect(written).toContain('- Attempt status: verified');
    expect(written).not.toContain('- Verify (');
    expect(written).not.toContain('- Attribution:');
    expect(written).not.toContain('- Commit subject:');
    expect(written).not.toContain('- Resumed after:');
  });

  it('renders "Resumed after" when the settled attempt opened as a resume of a prior aborted attempt', async () => {
    const todo = makeTodoTask({ name: 'resumed' });
    const firstAttempt = unwrap(startNextAttempt(todo, FIXED_NOW, 'session-1'));
    const abortedAt = FIXED_LATER;
    const recovered = unwrap(failCurrentAttempt(firstAttempt, abortedAt, 'aborted', { abortCause: 'process-crash' }));
    const resumedAttempt = unwrap(
      startNextAttempt(recovered, FIXED_LATER, 'session-2', { fromAttemptN: 1, cause: 'process-crash', abortedAt })
    );
    const verified = unwrap(recordRunningAttemptVerification(resumedAttempt));
    const done = unwrap(markTaskDone(verified, FIXED_LATER));
    const leaf = progressJournalLeaf(journalDeps(createAtomicWriteFile()), { progressFile, totalRounds: 5 }, done.id);
    const result = await leaf.execute(ctxFor([done]));
    expect(result.ok).toBe(true);
    const written = await read();
    expect(written).toContain(`- Resumed after: process-crash (attempt 1 aborted at ${String(abortedAt)})`);
    // The section is for the SECOND (resumed) attempt, not the aborted first one.
    expect(written).toContain('— Attempt 2');
  });
});
