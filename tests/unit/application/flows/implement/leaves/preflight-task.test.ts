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
import type { GitRunner } from '@src/integration/io/git-runner.ts';
import type { ImplementCtx } from '@src/application/flows/implement/ctx.ts';
import { SprintId } from '@src/domain/value/id/sprint-id.ts';

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

describe('preflightTaskLeaf', () => {
  it('passes through a clean tree', async () => {
    const leaf = preflightTaskLeaf({ gitRunner: fakeRunner(''), logger: noopLogger }, CWD);
    const out = await leaf.execute(baseCtx());
    expect(out.ok).toBe(true);
  });

  it('rejects a dirty tree with InvalidStateError when policy=cancel (default)', async () => {
    const leaf = preflightTaskLeaf({ gitRunner: fakeRunner(' M file\n'), logger: noopLogger }, CWD);
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
    const leaf = preflightTaskLeaf({ gitRunner: fakeRunner(' M file\n'), logger, dirtyTreePolicy: 'continue' }, CWD);
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
    const leaf = preflightTaskLeaf({ gitRunner: runner, logger: noopLogger }, CWD);
    const out = await leaf.execute(baseCtx());
    expect(out.ok).toBe(false);
  });
});
