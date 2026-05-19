import { describe, expect, it } from 'vitest';
import { Result } from '@src/domain/result.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import { createEventBusLogger } from '@src/business/observability/event-bus-logger.ts';
import { noopLogger } from '@tests/fixtures/noop-logger.ts';

const captureLogEvents = (
  bus: ReturnType<typeof createInMemoryEventBus>
): Array<{ level: string; message: string }> => {
  const captured: Array<{ level: string; message: string }> = [];
  bus.subscribe((e) => {
    if (e.type === 'log') captured.push({ level: e.level, message: e.message });
  });
  return captured;
};
import { absolutePath, isoTimestamp } from '@tests/fixtures/domain.ts';
import { preflightTaskLeaf } from '@src/application/flows/implement/leaves/preflight-task.ts';
import type { GitRunner, GitRunResult } from '@src/integration/io/git-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';
import type { Choice, InteractivePrompt } from '@src/business/interactive/prompt.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';

const NOW = isoTimestamp('2026-05-09T10:00:00.000Z');
const CWD = absolutePath('/tmp/repo');

const baseCtx = (): ImplementCtx => {
  const sid = SprintId.parse('0193ed2b-1234-7abc-8def-0123456789ab');
  if (!sid.ok) throw new Error('test setup');
  return { sprintId: sid.value };
};

const fakeRunner = (status: string, exitCode = 0): GitRunner => ({
  async run() {
    return Result.ok({ stdout: status, stderr: '', exitCode });
  },
});

interface RoutingRunner {
  readonly runner: GitRunner;
  readonly calls: ReadonlyArray<readonly string[]>;
}

/**
 * Routes by argv[0] so a single fakeRunner can serve all the git ops the prompt-driven flow
 * issues: `status` (dirty), `stash` (ok), `reset` / `clean` (ok). Captures every argv list for
 * assertion.
 */
const routingRunner = (statusOut: string): RoutingRunner => {
  const calls: Array<readonly string[]> = [];
  const runner: GitRunner = {
    async run(_cwd, args) {
      void _cwd;
      calls.push(args);
      const verb = args[0];
      const ok = (stdout: string): Result<GitRunResult, StorageError> => Result.ok({ stdout, stderr: '', exitCode: 0 });
      switch (verb) {
        case 'status':
          return ok(statusOut);
        case 'stash':
        case 'reset':
        case 'clean':
          return ok('');
        default:
          return ok('');
      }
    },
  };
  return { runner, calls };
};

const scriptedInteractive = <T>(answer: Result<T, StorageError>): InteractivePrompt => ({
  async askText() {
    throw new Error('not used');
  },
  async askTextArea() {
    throw new Error('not used');
  },
  async askChoice<U>(_prompt: string, _options: ReadonlyArray<Choice<U>>) {
    void _prompt;
    void _options;
    return answer as unknown as Result<U, StorageError>;
  },
  async askMultiChoice() {
    throw new Error('not used');
  },
  async askConfirm() {
    throw new Error('not used');
  },
});

const stubInteractive: InteractivePrompt = {
  async askText() {
    throw new Error('not used');
  },
  async askTextArea() {
    throw new Error('not used');
  },
  async askChoice() {
    throw new Error('not used');
  },
  async askMultiChoice() {
    throw new Error('not used');
  },
  async askConfirm() {
    throw new Error('not used');
  },
};

const clockNow = () => NOW;

describe('preflightTaskLeaf', () => {
  it('passes through a clean tree', async () => {
    const leaf = preflightTaskLeaf(
      { gitRunner: fakeRunner(''), logger: noopLogger, interactive: stubInteractive, clock: clockNow },
      CWD
    );
    const out = await leaf.execute(baseCtx());
    expect(out.ok).toBe(true);
  });

  it('rejects a dirty tree with InvalidStateError when policy=cancel', async () => {
    const leaf = preflightTaskLeaf(
      {
        gitRunner: fakeRunner(' M file\n'),
        logger: noopLogger,
        interactive: stubInteractive,
        clock: clockNow,
        dirtyTreePolicy: 'cancel',
      },
      CWD
    );
    const out = await leaf.execute(baseCtx());
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.error.code).toBe('invalid-state');
    }
  });

  it('proceeds (with warn log) when policy=continue', async () => {
    const eventBus = createInMemoryEventBus();
    const eventLog = captureLogEvents(eventBus);
    const logger = createEventBusLogger({ eventBus, clock: () => NOW });
    const leaf = preflightTaskLeaf(
      {
        gitRunner: fakeRunner(' M file\n'),
        logger,
        interactive: stubInteractive,
        clock: clockNow,
        dirtyTreePolicy: 'continue',
      },
      CWD
    );
    const out = await leaf.execute(baseCtx());
    expect(out.ok).toBe(true);
    expect(eventLog.some((e) => e.level === 'warn' && e.message.includes('working tree dirty'))).toBe(true);
  });

  it('propagates StorageError from git-runner failures', async () => {
    const runner: GitRunner = {
      async run() {
        return Result.ok({ stdout: '', stderr: 'fatal: not a git repo', exitCode: 128 });
      },
    };
    const leaf = preflightTaskLeaf(
      { gitRunner: runner, logger: noopLogger, interactive: stubInteractive, clock: clockNow },
      CWD
    );
    const out = await leaf.execute(baseCtx());
    expect(out.ok).toBe(false);
  });

  describe("policy='prompt'", () => {
    it("'keep' choice proceeds without touching the tree", async () => {
      const routing = routingRunner(' M file\n');
      const leaf = preflightTaskLeaf(
        {
          gitRunner: routing.runner,
          logger: noopLogger,
          interactive: scriptedInteractive(Result.ok('keep' as const)),
          clock: clockNow,
          dirtyTreePolicy: 'prompt',
        },
        CWD
      );
      const out = await leaf.execute(baseCtx());
      expect(out.ok).toBe(true);
      const verbs = routing.calls.map((args) => args[0]);
      expect(verbs).toEqual(['status']);
    });

    it("'stash' choice runs `git stash push -u -m <message>`", async () => {
      const routing = routingRunner(' M file\n');
      const leaf = preflightTaskLeaf(
        {
          gitRunner: routing.runner,
          logger: noopLogger,
          interactive: scriptedInteractive(Result.ok('stash' as const)),
          clock: clockNow,
          dirtyTreePolicy: 'prompt',
        },
        CWD
      );
      const out = await leaf.execute(baseCtx());
      expect(out.ok).toBe(true);
      // gitStashPush first checks dirtiness (another `status` call), then `stash push -u -m <msg>`.
      const verbs = routing.calls.map((args) => args[0]);
      expect(verbs).toContain('stash');
      const stashCall = routing.calls.find((args) => args[0] === 'stash');
      expect(stashCall?.[1]).toBe('push');
      expect(stashCall?.[2]).toBe('-u');
      expect(stashCall?.[3]).toBe('-m');
      expect(stashCall?.[4]).toContain('ralphctl preflight stash');
    });

    it("'reset' choice runs `git reset --hard HEAD` then `git clean -fd`", async () => {
      const routing = routingRunner(' M file\n');
      const leaf = preflightTaskLeaf(
        {
          gitRunner: routing.runner,
          logger: noopLogger,
          interactive: scriptedInteractive(Result.ok('reset' as const)),
          clock: clockNow,
          dirtyTreePolicy: 'prompt',
        },
        CWD
      );
      const out = await leaf.execute(baseCtx());
      expect(out.ok).toBe(true);
      const verbs = routing.calls.map((args) => args[0]);
      expect(verbs).toEqual(['status', 'reset', 'clean']);
    });

    it("'cancel' choice returns AbortError", async () => {
      const routing = routingRunner(' M file\n');
      const leaf = preflightTaskLeaf(
        {
          gitRunner: routing.runner,
          logger: noopLogger,
          interactive: scriptedInteractive(Result.ok('cancel' as const)),
          clock: clockNow,
          dirtyTreePolicy: 'prompt',
        },
        CWD
      );
      const out = await leaf.execute(baseCtx());
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.error.code).toBe('aborted');
      }
      const verbs = routing.calls.map((args) => args[0]);
      // Only the porcelain status check ran — nothing was mutated.
      expect(verbs).toEqual(['status']);
    });
  });
});
