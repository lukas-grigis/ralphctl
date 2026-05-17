import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { FIXED_NOW, makeReviewSprint } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { runReviewRoundUseCase, renderReviewCommitMessage } from '@src/business/feedback/run-review-round.ts';
import type { FeedbackRound } from '@src/business/feedback/md-parser.ts';

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

  it('renderReviewCommitMessage truncates long round bodies', () => {
    const round: FeedbackRound = { index: 3, body: 'x'.repeat(200), raw: '' };
    const msg = renderReviewCommitMessage(round);
    expect(msg).toMatch(/^feedback\(round-3\): /);
    expect(msg.length).toBeLessThanOrEqual(80);
  });
});
