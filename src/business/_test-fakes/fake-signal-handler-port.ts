/**
 * `FakeSignalHandlerPort` — non-IO fake of {@link SignalHandlerPort} for
 * use-case unit tests.
 *
 * Captures every `handle(signal, meta)` call in `calls` for assertion
 * convenience. Always returns `Result.ok(undefined)`.
 */
import type { SignalHandlerPort, SignalHandlerMeta } from '@src/business/ports/signal-handler-port.ts';
import type { StorageError } from '@src/domain/errors/storage-error.ts';
import { Result } from '@src/domain/result.ts';
import type { HarnessSignal } from '@src/domain/signals/harness-signal.ts';

export interface FakeSignalHandlerCall {
  readonly signal: HarnessSignal;
  readonly meta: SignalHandlerMeta;
}

export class FakeSignalHandlerPort implements SignalHandlerPort {
  readonly calls: FakeSignalHandlerCall[] = [];

  handle(signal: HarnessSignal, meta: SignalHandlerMeta): Promise<Result<void, StorageError>> {
    this.calls.push({ signal, meta });
    return Promise.resolve(Result.ok(undefined));
  }
}
