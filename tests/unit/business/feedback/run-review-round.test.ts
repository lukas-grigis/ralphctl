import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { FIXED_NOW, makeReviewSprint } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { renderReviewCommitMessage, runReviewRoundUseCase } from '@src/business/feedback/run-review-round.ts';
import type { FeedbackRound } from '@src/business/feedback/md-parser.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';

const FEEDBACK_WITH_ROUND_1 = `## Round 1

please change foo
`;

const baseDeps = (overrides?: Partial<Parameters<typeof runReviewRoundUseCase>[0]>) => ({
  sprint: makeReviewSprint(),
  openEditor: async () => Result.ok(undefined),
  readFeedbackFile: async () => FEEDBACK_WITH_ROUND_1,
  readProgressSnippet: async () => '_(no progress file)_',
  buildPrompt: async () => Result.ok({}),
  callApplyFeedback: async () => Result.ok([] as readonly HarnessSignal[]),
  commitRound: async () => Result.ok({ committed: true }),
  appendNextRound: async () => Result.ok(undefined),
  logger: noopLogger,
  ...overrides,
});

describe('runReviewRoundUseCase', () => {
  it('completes a round with commit when the user wrote a fresh round', async () => {
    const result = await runReviewRoundUseCase(baseDeps());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit).toBe('continued');
      expect(result.value.applied).toBe(true);
      expect(result.value.currentRound?.body).toContain('please change foo');
    }
  });

  it('exits "aborted" when the editor aborts', async () => {
    const result = await runReviewRoundUseCase(
      baseDeps({
        openEditor: async () => Result.error({ name: 'AbortError', code: 'abort', message: 'cancel' } as never),
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exit).toBe('aborted');
  });

  it('exits "terminated" when the feedback file is empty', async () => {
    const result = await runReviewRoundUseCase(baseDeps({ readFeedbackFile: async () => '' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exit).toBe('terminated');
  });

  it('exits "terminated" when the latest round equals the previous round', async () => {
    const same: FeedbackRound = {
      index: 1,
      body: 'please change foo',
      raw: '## Round 1\n\nplease change foo',
    };
    const result = await runReviewRoundUseCase(baseDeps({ previousRound: same }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exit).toBe('terminated');
  });

  it('exits "aborted" when AI emits <task-blocked>', async () => {
    const signals: readonly HarnessSignal[] = [{ type: 'task-blocked', reason: 'no API key', timestamp: FIXED_NOW }];
    const result = await runReviewRoundUseCase(baseDeps({ callApplyFeedback: async () => Result.ok(signals) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exit).toBe('aborted');
  });

  it('logs but does not fail when commit returns clean tree', async () => {
    const result = await runReviewRoundUseCase(baseDeps({ commitRound: async () => Result.ok({ committed: false }) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exit).toBe('continued');
  });

  it('reports applied=false when the round produced no diff (clean tree)', async () => {
    // `applied` drives the caller's roundsApplied counter — a round that committed nothing
    // must not inflate it, even though the loop continues.
    const result = await runReviewRoundUseCase(baseDeps({ commitRound: async () => Result.ok({ committed: false }) }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.applied).toBe(false);
      expect(result.value.exit).toBe('continued');
      expect(result.value.currentRound?.body).toContain('please change foo');
    }
  });

  it('stops before the editor and the spawn when the tree is dirty, listing the files and the last commit error', async () => {
    const calls: string[] = [];
    const result = await runReviewRoundUseCase(
      baseDeps({
        listUncommittedChanges: async () => Result.ok(['src/a.ts', 'README.md']),
        lastCommitError: 'git commit failed: pre-commit hook rejected',
        openEditor: async () => {
          calls.push('editor');
          return Result.ok(undefined);
        },
        callApplyFeedback: async () => {
          calls.push('spawn');
          return Result.ok([] as readonly HarnessSignal[]);
        },
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exit).toBe('aborted');
    expect(result.value.applied).toBe(false);
    expect(result.value.dirtyTreeReason).toContain('src/a.ts');
    expect(result.value.dirtyTreeReason).toContain('README.md');
    expect(result.value.dirtyTreeReason).toContain('git commit failed: pre-commit hook rejected');
    expect(calls).toEqual([]);
  });

  it('omits the commit-error clause when no prior commit failed and caps a long file list', async () => {
    const paths = Array.from({ length: 25 }, (_, i) => `f${String(i)}.ts`);
    const result = await runReviewRoundUseCase(baseDeps({ listUncommittedChanges: async () => Result.ok(paths) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.dirtyTreeReason).toContain('f19.ts');
    expect(result.value.dirtyTreeReason).not.toContain('f20.ts');
    expect(result.value.dirtyTreeReason).toContain('and 5 more');
    expect(result.value.dirtyTreeReason).not.toMatch(/commit error/i);
  });

  it('runs the round when the preflight sees a clean tree', async () => {
    const result = await runReviewRoundUseCase(baseDeps({ listUncommittedChanges: async () => Result.ok([]) }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exit).toBe('continued');
    expect(result.value.dirtyTreeReason).toBeUndefined();
  });

  it('proceeds with the round when the preflight git read itself fails', async () => {
    const result = await runReviewRoundUseCase(
      baseDeps({
        listUncommittedChanges: async () =>
          Result.error(new StorageError({ subCode: 'io', message: 'git status failed: not a git repository' })),
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exit).toBe('continued');
  });

  it('reports the commit error so the next round can quote it', async () => {
    const result = await runReviewRoundUseCase(
      baseDeps({
        commitRound: async () =>
          Result.error(new StorageError({ subCode: 'io', message: 'git commit failed: hook rejected' })),
      })
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.commitError).toBe('git commit failed: hook rejected');
  });

  it('renderReviewCommitMessage truncates long round bodies', () => {
    const round: FeedbackRound = { index: 3, body: 'x'.repeat(200), raw: '' };
    const msg = renderReviewCommitMessage(round);
    expect(msg).toMatch(/^feedback\(round-3\): /);
    expect(msg.length).toBeLessThanOrEqual(80);
  });
});
