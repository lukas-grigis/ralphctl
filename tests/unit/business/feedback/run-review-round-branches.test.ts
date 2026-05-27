/**
 * Supplemental unit tests for run-review-round.ts — covers branches not reached
 * by the main run-review-round.test.ts file.
 *
 * Specific gaps (all branches from the 61.66% branch-coverage report):
 *   - buildPrompt returns Result.error → propagates as Result.error (line 126)
 *   - callApplyFeedback returns Result.error → propagates as Result.error (line 132)
 *   - commitRound returns Result.error → logs warn, continues (lines 143-144)
 *   - verifyRound defined + passes (lines 150-160, happy path)
 *   - verifyRound defined + verify.ok is false → logs warn, continues (lines 152-153)
 *   - verifyRound defined + verify fails (passed=false) → logs warn, continues (lines 154-158)
 *   - appendNextRound returns Result.error → propagates as Result.error (line 163)
 *   - renderSprintContext helpers: multi-ticket sprint, render feedback log with prior rounds
 */

import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { InvalidStateError } from '@src/domain/value/error/invalid-state-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { HarnessSignal } from '@src/domain/signal.ts';
import { FIXED_NOW, makeReviewSprint } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { runReviewRoundUseCase } from '@src/business/feedback/run-review-round.ts';

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

describe('runReviewRoundUseCase — buildPrompt failure', () => {
  it('propagates Result.error when buildPrompt returns an error (line 126)', async () => {
    const buildErr = new InvalidStateError({
      entity: 'prompt-builder',
      currentState: 'template-missing',
      attemptedAction: 'build prompt',
      message: 'prompt template not found',
    });

    const result = await runReviewRoundUseCase(
      baseDeps({
        buildPrompt: async () => Result.error(buildErr),
      })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(buildErr);
    }
  });
});

describe('runReviewRoundUseCase — callApplyFeedback failure', () => {
  it('propagates Result.error when the AI call fails (line 132)', async () => {
    const aiErr = new InvalidStateError({
      entity: 'apply-feedback-ai',
      currentState: 'spawn-failed',
      attemptedAction: 'run AI',
      message: 'AI provider unavailable',
    });

    const result = await runReviewRoundUseCase(
      baseDeps({
        callApplyFeedback: async () => Result.error(aiErr),
      })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(aiErr);
    }
  });
});

describe('runReviewRoundUseCase — commitRound failure', () => {
  it('logs warn but continues when commitRound returns an error (lines 143-144)', async () => {
    const commitErr = new InvalidStateError({
      entity: 'git',
      currentState: 'dirty-tree',
      attemptedAction: 'commit',
      message: 'nothing to commit',
    });

    const result = await runReviewRoundUseCase(
      baseDeps({
        commitRound: async () => Result.error(commitErr),
      })
    );

    // Should still succeed (the commit failure is non-fatal — logged as warn)
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit).toBe('continued');
      expect(result.value.applied).toBe(true);
    }
  });
});

describe('runReviewRoundUseCase — appendNextRound failure', () => {
  it('propagates Result.error when appendNextRound fails (line 163)', async () => {
    const appendErr = new StorageError({
      subCode: 'io',
      message: 'disk full',
      path: '/tmp/feedback.md',
    });

    const result = await runReviewRoundUseCase(
      baseDeps({
        appendNextRound: async () => Result.error(appendErr),
      })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(appendErr);
    }
  });
});

describe('runReviewRoundUseCase — verifyRound paths', () => {
  it('continues normally when verifyRound is defined and passes (lines 150-160, happy path)', async () => {
    const result = await runReviewRoundUseCase(
      baseDeps({
        verifyRound: async () => Result.ok({ passed: true, exitCode: 0 }),
      })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit).toBe('continued');
      expect(result.value.applied).toBe(true);
    }
  });

  it('logs warn but continues when verifyRound returns Result.error (lines 152-153)', async () => {
    const verifySpawnErr = new InvalidStateError({
      entity: 'verify-runner',
      currentState: 'spawn-failed',
      attemptedAction: 'run verify',
      message: 'binary not found',
    });

    const result = await runReviewRoundUseCase(
      baseDeps({
        verifyRound: async () => Result.error(verifySpawnErr),
      })
    );

    // Verify failure is non-fatal — loop continues
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit).toBe('continued');
      expect(result.value.applied).toBe(true);
    }
  });

  it('logs warn but continues when verifyRound passes=false (lines 154-158)', async () => {
    const result = await runReviewRoundUseCase(
      baseDeps({
        verifyRound: async () => Result.ok({ passed: false, exitCode: 1 }),
      })
    );

    // verify failed → non-fatal; loop continues with the round applied
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit).toBe('continued');
      expect(result.value.applied).toBe(true);
    }
  });

  it('logs warn with null exitCode when exitCode is null', async () => {
    const result = await runReviewRoundUseCase(
      baseDeps({
        verifyRound: async () => Result.ok({ passed: false, exitCode: null }),
      })
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit).toBe('continued');
    }
  });

  it('continues normally when verifyRound is not provided', async () => {
    // The `verifyRound` port is optional — baseDeps does not supply it, so the
    // `if (props.verifyRound !== undefined)` branch is false and we skip directly to
    // appendNextRound.
    const result = await runReviewRoundUseCase(baseDeps());

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.exit).toBe('continued');
  });
});

describe('runReviewRoundUseCase — prompt rendering helpers', () => {
  it('passes readProgressSnippet output into buildPrompt progress param', async () => {
    let capturedProgress: string | undefined;
    const result = await runReviewRoundUseCase(
      baseDeps({
        readProgressSnippet: async () => '## Progress\n- task-a: done',
        buildPrompt: async (params) => {
          capturedProgress = params.progress;
          return Result.ok({});
        },
      })
    );

    expect(result.ok).toBe(true);
    expect(capturedProgress).toBe('## Progress\n- task-a: done');
  });

  it('passes sprint context to buildPrompt containing the sprint name', async () => {
    let capturedContext: string | undefined;
    const result = await runReviewRoundUseCase(
      baseDeps({
        buildPrompt: async (params) => {
          capturedContext = params.sprintContext;
          return Result.ok({});
        },
      })
    );

    expect(result.ok).toBe(true);
    expect(capturedContext).toContain('Sprint');
  });

  it('renders prior rounds in the feedback log (not current round)', async () => {
    const multiRoundFeedback = `## Round 1

first round feedback
---

## Round 2

second round feedback
`;
    let capturedLog: string | undefined;
    const result = await runReviewRoundUseCase(
      baseDeps({
        readFeedbackFile: async () => multiRoundFeedback,
        buildPrompt: async (params) => {
          capturedLog = params.feedbackLog;
          return Result.ok({});
        },
      })
    );

    expect(result.ok).toBe(true);
    // The feedback log should include prior rounds (round 1), not the current (round 2)
    expect(capturedLog).toContain('Round 1');
    expect(capturedLog).not.toContain('Round 2');
  });

  it('passes empty prior-rounds log as placeholder text when no history', async () => {
    // Only one round (the current one) → history is empty → renderFeedbackLog returns placeholder
    let capturedLog: string | undefined;
    const result = await runReviewRoundUseCase(
      baseDeps({
        buildPrompt: async (params) => {
          capturedLog = params.feedbackLog;
          return Result.ok({});
        },
      })
    );

    expect(result.ok).toBe(true);
    expect(capturedLog).toBe('_no prior rounds_');
  });

  it('passes the latest round body as latestRound to buildPrompt', async () => {
    let capturedLatest: string | undefined;
    const result = await runReviewRoundUseCase(
      baseDeps({
        buildPrompt: async (params) => {
          capturedLatest = params.latestRound;
          return Result.ok({});
        },
      })
    );

    expect(result.ok).toBe(true);
    expect(capturedLatest).toContain('please change foo');
  });
});

describe('runReviewRoundUseCase — currentRound on aborted path', () => {
  it('includes currentRound in result when AI emits task-blocked', async () => {
    const signals: readonly HarnessSignal[] = [
      { type: 'task-blocked', reason: 'cannot proceed', timestamp: FIXED_NOW },
    ];

    const result = await runReviewRoundUseCase(baseDeps({ callApplyFeedback: async () => Result.ok(signals) }));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.exit).toBe('aborted');
      // currentRound should be populated even on aborted path
      expect(result.value.currentRound).toBeDefined();
      expect(result.value.currentRound?.body).toContain('please change foo');
      expect(result.value.applied).toBe(false);
    }
  });
});
