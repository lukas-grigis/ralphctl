import { describe, expect, it, vi } from 'vitest';
import type { ExecutionOptions } from '@src/domain/context.ts';
import { StorageError } from '@src/domain/errors.ts';
import type { ExternalPort } from '@src/business/ports/external.ts';
import type { LoggerPort } from '@src/business/ports/logger.ts';
import type { PromptPort } from '@src/business/ports/prompt.ts';
import { resolveDirtyTree } from './execute/resolve-dirty-tree.ts';
import { parseSprintStartArgs } from '@src/integration/cli/commands/sprint/start.ts';

// In-memory prompt stub: queues up a scripted sequence of confirm answers.
// `.confirm()` pulls the next answer; fails loudly if the queue is empty to
// surface tests that exercise the wrong flow. Other methods throw — this
// helper only cares about the two confirm calls in the dirty-tree flow.
function makePrompt(answers: boolean[]): PromptPort & { consumed: boolean[] } {
  let cursor = 0;
  const consumed: boolean[] = [];
  return {
    select: () => Promise.reject(new Error('select not expected in dirty-tree flow')),
    confirm: () => {
      if (cursor >= answers.length) {
        return Promise.reject(new Error('unexpected confirm — no scripted answer remaining'));
      }
      const next = answers[cursor];
      cursor += 1;
      if (typeof next !== 'boolean') {
        return Promise.reject(new Error('scripted answer missing'));
      }
      consumed.push(next);
      return Promise.resolve(next);
    },
    input: () => Promise.reject(new Error('input not expected')),
    checkbox: () => Promise.reject(new Error('checkbox not expected')),
    editor: () => Promise.resolve(null),
    fileBrowser: () => Promise.resolve(null),
    consumed,
  };
}

function makeLogger(): LoggerPort {
  const logger: LoggerPort = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    success: () => undefined,
    warning: () => undefined,
    tip: () => undefined,
    header: () => undefined,
    separator: () => undefined,
    field: () => undefined,
    card: () => undefined,
    newline: () => undefined,
    dim: () => undefined,
    item: () => undefined,
    spinner: () => ({ succeed: () => undefined, fail: () => undefined, stop: () => undefined }),
    child: () => logger,
    time: () => () => undefined,
  };
  return logger;
}

function makeExternal(opts: { hasUncommitted: boolean; hardResetThrows?: boolean }): {
  external: ExternalPort;
  hardResetWorkingTree: ReturnType<typeof vi.fn>;
  hasUncommittedChanges: ReturnType<typeof vi.fn>;
} {
  const hardResetWorkingTree = vi.fn(() => {
    if (opts.hardResetThrows) throw new StorageError('reset failed: permission denied');
  });
  const hasUncommittedChanges = vi.fn(() => opts.hasUncommitted);
  const external = {
    hasUncommittedChanges,
    hardResetWorkingTree,
  } as unknown as ExternalPort;
  return { external, hardResetWorkingTree, hasUncommittedChanges };
}

describe('resolveDirtyTree helper', () => {
  describe('clean working tree', () => {
    it('no prompts, no reset, no throw', async () => {
      const prompt = makePrompt([]);
      const { external, hardResetWorkingTree, hasUncommittedChanges } = makeExternal({ hasUncommitted: false });

      await resolveDirtyTree({
        repoPath: '/repo',
        options: {},
        prompt,
        isTTY: true,
        logger: makeLogger(),
        external,
      });

      expect(hasUncommittedChanges).toHaveBeenCalledWith('/repo');
      expect(hardResetWorkingTree).not.toHaveBeenCalled();
      expect(prompt.consumed).toEqual([]);
    });
  });

  describe('dirty tree, resume with changes', () => {
    it("first prompt 'Y' → resumes with tree intact (no reset, no second prompt)", async () => {
      const prompt = makePrompt([true]);
      const { external, hardResetWorkingTree } = makeExternal({ hasUncommitted: true });

      await resolveDirtyTree({
        repoPath: '/repo',
        options: {},
        prompt,
        isTTY: true,
        logger: makeLogger(),
        external,
      });

      expect(prompt.consumed).toEqual([true]);
      expect(hardResetWorkingTree).not.toHaveBeenCalled();
    });
  });

  describe('dirty tree, reset then resume', () => {
    it("first 'n' + second 'Y' → calls hardResetWorkingTree, does not throw", async () => {
      const prompt = makePrompt([false, true]);
      const { external, hardResetWorkingTree } = makeExternal({ hasUncommitted: true });

      await resolveDirtyTree({
        repoPath: '/repo',
        options: {},
        prompt,
        isTTY: true,
        logger: makeLogger(),
        external,
      });

      expect(prompt.consumed).toEqual([false, true]);
      expect(hardResetWorkingTree).toHaveBeenCalledWith('/repo');
    });

    it('reset step fails → surfaces StorageError, task not started', async () => {
      const prompt = makePrompt([false, true]);
      const { external, hardResetWorkingTree } = makeExternal({
        hasUncommitted: true,
        hardResetThrows: true,
      });

      await expect(
        resolveDirtyTree({
          repoPath: '/repo',
          options: {},
          prompt,
          isTTY: true,
          logger: makeLogger(),
          external,
        })
      ).rejects.toBeInstanceOf(StorageError);
      expect(hardResetWorkingTree).toHaveBeenCalledWith('/repo');
    });
  });

  describe('dirty tree, user declines both', () => {
    it("'n' + 'n' → throws abort StorageError with guidance, no reset", async () => {
      const prompt = makePrompt([false, false]);
      const { external, hardResetWorkingTree } = makeExternal({ hasUncommitted: true });

      await expect(
        resolveDirtyTree({
          repoPath: '/repo',
          options: {},
          prompt,
          isTTY: true,
          logger: makeLogger(),
          external,
        })
      ).rejects.toThrow(/commit, stash, or discard/i);

      expect(hardResetWorkingTree).not.toHaveBeenCalled();
    });
  });

  describe('non-interactive with dirty tree', () => {
    it('no flag → throws blocking StorageError with hint mentioning both flags', async () => {
      const prompt = makePrompt([]);
      const { external, hardResetWorkingTree } = makeExternal({ hasUncommitted: true });

      let caught: unknown;
      try {
        await resolveDirtyTree({
          repoPath: '/repo',
          options: {},
          prompt,
          isTTY: false,
          logger: makeLogger(),
          external,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(StorageError);
      const msg = (caught as StorageError).message;
      expect(msg).toContain('--resume-dirty');
      expect(msg).toContain('--reset-on-resume');
      expect(msg).toContain('/repo');
      expect(hardResetWorkingTree).not.toHaveBeenCalled();
      expect(prompt.consumed).toEqual([]);
    });

    it('--resume-dirty → no prompt, no reset, tree stays dirty', async () => {
      const prompt = makePrompt([]);
      const { external, hardResetWorkingTree } = makeExternal({ hasUncommitted: true });
      const options: ExecutionOptions = { resumeDirty: true };

      await resolveDirtyTree({
        repoPath: '/repo',
        options,
        prompt,
        isTTY: false,
        logger: makeLogger(),
        external,
      });

      expect(hardResetWorkingTree).not.toHaveBeenCalled();
      expect(prompt.consumed).toEqual([]);
    });

    it('--reset-on-resume → no prompt, calls hardResetWorkingTree', async () => {
      const prompt = makePrompt([]);
      const { external, hardResetWorkingTree } = makeExternal({ hasUncommitted: true });
      const options: ExecutionOptions = { resetOnResume: true };

      await resolveDirtyTree({
        repoPath: '/repo',
        options,
        prompt,
        isTTY: false,
        logger: makeLogger(),
        external,
      });

      expect(hardResetWorkingTree).toHaveBeenCalledWith('/repo');
      expect(prompt.consumed).toEqual([]);
    });

    it('both flags passed → parseArgs rejects with mutually-exclusive error', () => {
      const result = parseSprintStartArgs(['--resume-dirty', '--reset-on-resume']);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toContain('mutually exclusive');
      expect(result.error).toContain('--resume-dirty');
      expect(result.error).toContain('--reset-on-resume');
    });
  });

  describe('flag precedence in interactive sessions', () => {
    it('TTY + --resume-dirty → skips prompts, leaves tree dirty', async () => {
      const prompt = makePrompt([]);
      const { external, hardResetWorkingTree } = makeExternal({ hasUncommitted: true });
      const options: ExecutionOptions = { resumeDirty: true };

      await resolveDirtyTree({
        repoPath: '/repo',
        options,
        prompt,
        isTTY: true,
        logger: makeLogger(),
        external,
      });

      expect(prompt.consumed).toEqual([]);
      expect(hardResetWorkingTree).not.toHaveBeenCalled();
    });

    it('TTY + --reset-on-resume → skips prompts, resets', async () => {
      const prompt = makePrompt([]);
      const { external, hardResetWorkingTree } = makeExternal({ hasUncommitted: true });
      const options: ExecutionOptions = { resetOnResume: true };

      await resolveDirtyTree({
        repoPath: '/repo',
        options,
        prompt,
        isTTY: true,
        logger: makeLogger(),
        external,
      });

      expect(prompt.consumed).toEqual([]);
      expect(hardResetWorkingTree).toHaveBeenCalledWith('/repo');
    });
  });
});
