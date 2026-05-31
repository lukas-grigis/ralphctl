import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { absolutePath, isoTimestamp } from '@tests/fixtures/domain.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';
import { type DirtyTreeChoice, preflightTaskUseCase } from '@src/business/task/preflight-task.ts';
import { AbortError } from '@src/domain/value/error/abort-error.ts';
import { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { AbsolutePath } from '@src/domain/value/absolute-path.ts';

const CWD = absolutePath('/tmp/repo');
const NOW = isoTimestamp('2026-05-18T10:00:00.000Z');
const SPRINT_ID = 'sprint-abc';

const okCount = (n: number) => async (_cwd: AbsolutePath) => {
  void _cwd;
  return Result.ok(n);
};
const failCount = async (_cwd: AbsolutePath) => {
  void _cwd;
  return Result.error(new StorageError({ subCode: 'io', message: 'git status exploded' }));
};

interface AskChoiceCall {
  readonly cwd: AbsolutePath;
  readonly dirtyEntries: number;
}

type AskFn = NonNullable<Parameters<typeof preflightTaskUseCase>[0]['askDirtyTreeChoice']>;
type AskResult = Awaited<ReturnType<AskFn>>;

const recordingAsk = (
  result: AskResult
): {
  readonly fn: AskFn;
  readonly calls: AskChoiceCall[];
} => {
  const calls: AskChoiceCall[] = [];
  return {
    calls,
    fn: async ({ cwd, dirtyEntries }) => {
      calls.push({ cwd, dirtyEntries });
      return result;
    },
  };
};

const okChoice = (choice: DirtyTreeChoice): AskResult => Result.ok(choice);
const abortChoice = (reason: string): AskResult =>
  Result.error(new AbortError({ elementName: 'preflight-task', reason }));

interface StashCall {
  readonly cwd: AbsolutePath;
  readonly message: string;
}

const recordingStash = (
  result: Result<{ stashed: boolean }, StorageError>
): {
  readonly fn: (cwd: AbsolutePath, message: string) => Promise<Result<{ stashed: boolean }, StorageError>>;
  readonly calls: StashCall[];
} => {
  const calls: StashCall[] = [];
  return {
    calls,
    fn: async (cwd, message) => {
      calls.push({ cwd, message });
      return result;
    },
  };
};

const recordingReset = (
  result: Result<void, StorageError>
): {
  readonly fn: (cwd: AbsolutePath) => Promise<Result<void, StorageError>>;
  readonly calls: AbsolutePath[];
} => {
  const calls: AbsolutePath[] = [];
  return {
    calls,
    fn: async (cwd) => {
      calls.push(cwd);
      return result;
    },
  };
};

const clockNow = () => NOW;

describe('preflightTaskUseCase', () => {
  it('returns ok on a clean working tree', async () => {
    const result = await preflightTaskUseCase({
      cwd: CWD,
      gitStatusEntryCount: okCount(0),
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a dirty tree with InvalidStateError under the default policy ('cancel')", async () => {
    const result = await preflightTaskUseCase({
      cwd: CWD,
      gitStatusEntryCount: okCount(3),
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-state');
      expect(result.error.message).toContain('3 uncommitted change');
      expect(result.error.message).toContain(String(CWD));
    }
  });

  it("rejects a dirty tree when policy is explicitly 'cancel'", async () => {
    const result = await preflightTaskUseCase({
      cwd: CWD,
      gitStatusEntryCount: okCount(1),
      dirtyTreePolicy: 'cancel',
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
  });

  it("returns ok on a dirty tree when policy is 'continue' (operator override)", async () => {
    const result = await preflightTaskUseCase({
      cwd: CWD,
      gitStatusEntryCount: okCount(7),
      dirtyTreePolicy: 'continue',
      logger: noopLogger,
    });
    expect(result.ok).toBe(true);
  });

  it('propagates StorageError when git status itself fails', async () => {
    const result = await preflightTaskUseCase({
      cwd: CWD,
      gitStatusEntryCount: failCount,
      logger: noopLogger,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('storage-error');
  });

  describe("policy='prompt'", () => {
    it("returns ok when the user chooses 'keep' and runs the prompt with cwd/dirtyEntries", async () => {
      const ask = recordingAsk(okChoice('keep'));
      const stash = recordingStash(Result.ok({ stashed: true }));
      const reset = recordingReset(Result.ok(undefined));
      const result = await preflightTaskUseCase({
        cwd: CWD,
        gitStatusEntryCount: okCount(2),
        dirtyTreePolicy: 'prompt',
        askDirtyTreeChoice: ask.fn,
        gitStash: stash.fn,
        gitReset: reset.fn,
        clock: clockNow,
        sprintId: SPRINT_ID,
        logger: noopLogger,
      });
      expect(result.ok).toBe(true);
      expect(stash.calls).toHaveLength(0);
      expect(reset.calls).toHaveLength(0);
      expect(ask.calls).toEqual([{ cwd: CWD, dirtyEntries: 2 }]);
    });

    it("stashes when the user chooses 'stash' with a recoverable message including sprintId", async () => {
      const ask = recordingAsk(okChoice('stash'));
      const stash = recordingStash(Result.ok({ stashed: true }));
      const reset = recordingReset(Result.ok(undefined));
      const result = await preflightTaskUseCase({
        cwd: CWD,
        gitStatusEntryCount: okCount(1),
        dirtyTreePolicy: 'prompt',
        askDirtyTreeChoice: ask.fn,
        gitStash: stash.fn,
        gitReset: reset.fn,
        clock: clockNow,
        sprintId: SPRINT_ID,
        logger: noopLogger,
      });
      expect(result.ok).toBe(true);
      expect(stash.calls).toHaveLength(1);
      expect(stash.calls[0]?.cwd).toBe(CWD);
      expect(stash.calls[0]?.message).toContain('ralphctl preflight stash');
      expect(stash.calls[0]?.message).toContain(SPRINT_ID);
      expect(reset.calls).toHaveLength(0);
    });

    it("resets when the user chooses 'reset'", async () => {
      const ask = recordingAsk(okChoice('reset'));
      const stash = recordingStash(Result.ok({ stashed: true }));
      const reset = recordingReset(Result.ok(undefined));
      const result = await preflightTaskUseCase({
        cwd: CWD,
        gitStatusEntryCount: okCount(5),
        dirtyTreePolicy: 'prompt',
        askDirtyTreeChoice: ask.fn,
        gitStash: stash.fn,
        gitReset: reset.fn,
        clock: clockNow,
        sprintId: SPRINT_ID,
        logger: noopLogger,
      });
      expect(result.ok).toBe(true);
      expect(reset.calls).toEqual([CWD]);
      expect(stash.calls).toHaveLength(0);
    });

    it("returns AbortError when the user chooses 'cancel'", async () => {
      const ask = recordingAsk(okChoice('cancel'));
      const stash = recordingStash(Result.ok({ stashed: true }));
      const reset = recordingReset(Result.ok(undefined));
      const result = await preflightTaskUseCase({
        cwd: CWD,
        gitStatusEntryCount: okCount(1),
        dirtyTreePolicy: 'prompt',
        askDirtyTreeChoice: ask.fn,
        gitStash: stash.fn,
        gitReset: reset.fn,
        clock: clockNow,
        sprintId: SPRINT_ID,
        logger: noopLogger,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('aborted');
        if (result.error.code === 'aborted') {
          expect(result.error.elementName).toBe('preflight-task');
        }
      }
      expect(stash.calls).toHaveLength(0);
      expect(reset.calls).toHaveLength(0);
    });

    it('propagates StorageError from gitStash failure', async () => {
      const ask = recordingAsk(okChoice('stash'));
      const stash = recordingStash(Result.error(new StorageError({ subCode: 'io', message: 'stash exploded' })));
      const reset = recordingReset(Result.ok(undefined));
      const result = await preflightTaskUseCase({
        cwd: CWD,
        gitStatusEntryCount: okCount(1),
        dirtyTreePolicy: 'prompt',
        askDirtyTreeChoice: ask.fn,
        gitStash: stash.fn,
        gitReset: reset.fn,
        clock: clockNow,
        sprintId: SPRINT_ID,
        logger: noopLogger,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('storage-error');
    });

    it('propagates StorageError from gitReset failure', async () => {
      const ask = recordingAsk(okChoice('reset'));
      const stash = recordingStash(Result.ok({ stashed: true }));
      const reset = recordingReset(Result.error(new StorageError({ subCode: 'io', message: 'reset exploded' })));
      const result = await preflightTaskUseCase({
        cwd: CWD,
        gitStatusEntryCount: okCount(1),
        dirtyTreePolicy: 'prompt',
        askDirtyTreeChoice: ask.fn,
        gitStash: stash.fn,
        gitReset: reset.fn,
        clock: clockNow,
        sprintId: SPRINT_ID,
        logger: noopLogger,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('storage-error');
    });

    it('propagates AbortError from askDirtyTreeChoice (user cancelled the menu)', async () => {
      const ask = recordingAsk(abortChoice('Ctrl-C'));
      const stash = recordingStash(Result.ok({ stashed: true }));
      const reset = recordingReset(Result.ok(undefined));
      const result = await preflightTaskUseCase({
        cwd: CWD,
        gitStatusEntryCount: okCount(1),
        dirtyTreePolicy: 'prompt',
        askDirtyTreeChoice: ask.fn,
        gitStash: stash.fn,
        gitReset: reset.fn,
        clock: clockNow,
        sprintId: SPRINT_ID,
        logger: noopLogger,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('aborted');
        if (result.error.code === 'aborted') {
          expect(result.error.elementName).toBe('preflight-task');
        }
      }
    });

    it("throws InvalidStateError when policy='prompt' is set without the required deps (wiring bug)", async () => {
      // Programmer error: composition root forgot the askDirtyTreeChoice dep. Throw synchronously
      // so the harness surfaces a clear configuration error rather than silently degrading.
      await expect(
        preflightTaskUseCase({
          cwd: CWD,
          gitStatusEntryCount: okCount(1),
          dirtyTreePolicy: 'prompt',
          logger: noopLogger,
        })
      ).rejects.toThrow(/dirtyTreePolicy='prompt' requires/);
    });

    it('falls back to "unknown" in the stash message when sprintId is omitted', async () => {
      const ask = recordingAsk(okChoice('stash'));
      const stash = recordingStash(Result.ok({ stashed: true }));
      const reset = recordingReset(Result.ok(undefined));
      const result = await preflightTaskUseCase({
        cwd: CWD,
        gitStatusEntryCount: okCount(1),
        dirtyTreePolicy: 'prompt',
        askDirtyTreeChoice: ask.fn,
        gitStash: stash.fn,
        gitReset: reset.fn,
        clock: clockNow,
        // no sprintId
        logger: noopLogger,
      });
      expect(result.ok).toBe(true);
      expect(stash.calls[0]?.message).toContain('sprint unknown');
    });
  });
});
