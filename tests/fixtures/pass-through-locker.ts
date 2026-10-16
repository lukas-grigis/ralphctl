import { tmpdir } from 'node:os';
import { Result } from '@src/domain/result.ts';
import { AbsolutePath } from '@src/domain/value/absolute-path.ts';
import type { StorageError } from '@src/domain/value/error/storage-error.ts';
import type { FileLocker } from '@src/integration/io/file-locker.ts';
import { createInMemoryEventBus } from '@src/integration/observability/in-memory-event-bus.ts';
import type { EventBus } from '@src/business/observability/event-bus.ts';

/** Runs `fn` with no lock — for tests whose deps have no disk to contend on. */
export const passThroughFileLocker: FileLocker = {
  withLock: async <T>(_path: unknown, fn: (signal: AbortSignal) => Promise<T>) =>
    Result.ok(await fn(new AbortController().signal)) as Result<T, StorageError>,
};

const anyAbsolutePath = (): AbsolutePath => {
  const parsed = AbsolutePath.parse(tmpdir());
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

/** The sprint-lock slice of a flow's deps, unlocked — for flow tests that are not about locking. */
export const unlockedSprintLockDeps = (): {
  readonly fileLocker: FileLocker;
  readonly locksRoot: AbsolutePath;
  readonly sprintDir: AbsolutePath;
  readonly eventBus: EventBus;
} => ({
  fileLocker: passThroughFileLocker,
  locksRoot: anyAbsolutePath(),
  sprintDir: anyAbsolutePath(),
  eventBus: createInMemoryEventBus(),
});
